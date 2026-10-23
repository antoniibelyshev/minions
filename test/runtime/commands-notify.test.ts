// CLI wiring of the notification outbox and `work cancel` (task-2.3) in the project runtime: the
// coordinator's flow `notify enqueue` -> `notify pending` -> `notify fail` / `notify ack`, with the text
// from a file (never an argument), dedup, masked errors, and cancel argument validation.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

const { register } = await import('../../src/runtime/commands.js');

let root = '';
beforeAll(() => {
  root = tmp();
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify(defaults('project-owner')));
  process.env.MINIONS_RUNTIME = 'container';
  process.env.MINIONS_STATE_DIR = join(root, 'state');
  process.env.MINIONS_CONFIG = join(root, 'config.json');
  process.env.MINIONS_WORKSPACE = join(root, 'workspace');
});
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

async function run(...args: string[]): Promise<{ ok: boolean; data?: any; error?: { code: string; message: string } }> {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  register(program);
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c }); }) as typeof process.exit);
  try {
    await program.parseAsync(['node', 'minions', ...args, '--json']);
  } catch (e) {
    if ((e as { exitCode?: number }).exitCode === undefined) throw e;
  } finally {
    vi.restoreAllMocks();
  }
  return JSON.parse(out.join('').trim().split('\n').pop()!);
}

describe('minions notify (runtime)', () => {
  it('enqueue -> pending -> fail (masked) -> ack, with dedup on re-enqueue', async () => {
    const text = join(root, 'msg.txt');
    writeFileSync(text, 'Delivered task-7: https://github.com/o/r/pull/9\n');

    const first = await run('notify', 'enqueue', '--key', 'delivered:task-7:abc', '--kind', 'delivered', '--task', 'task-7', '--text-file', text);
    expect(first).toMatchObject({ ok: true, data: { created: true, item: { key: 'delivered:task-7:abc', text: 'Delivered task-7: https://github.com/o/r/pull/9' } } });
    const again = await run('notify', 'enqueue', '--key', 'delivered:task-7:abc', '--kind', 'delivered', '--text-file', text);
    expect(again).toMatchObject({ ok: true, data: { created: false } });

    expect((await run('notify', 'pending')).data.items.map((i: { key: string }) => i.key)).toEqual(['delivered:task-7:abc']);

    const failed = await run('notify', 'fail', 'delivered:task-7:abc', '--error', 'POST failed: Authorization: Bearer abcdefghijklmnop');
    expect(failed).toMatchObject({ ok: true, data: { attempts: 1 } });
    expect(failed.data.lastError).not.toContain('abcdefghijklmnop');
    // Inside the backoff it is not due, but --all still lists it and the counts show it waiting.
    const waiting = await run('notify', 'pending');
    expect(waiting.data.items).toEqual([]);
    expect(waiting.data.counts).toMatchObject({ pending: 1, waiting: 1 });
    expect((await run('notify', 'pending', '--all')).data.items).toHaveLength(1);

    expect(await run('notify', 'ack', 'delivered:task-7:abc', '--via', 'telegram')).toMatchObject({ ok: true, data: { acked: [{ key: 'delivered:task-7:abc', alreadyDelivered: false }] } });
    expect(await run('notify', 'ack', 'delivered:task-7:abc')).toMatchObject({ ok: true, data: { acked: [{ alreadyDelivered: true }] } });
    expect((await run('notify', 'pending', '--all')).data).toMatchObject({ items: [], counts: { pending: 0, delivered: 1 } });
  });

  it('rejects unknown keys, kinds and empty text', async () => {
    const empty = join(root, 'empty.txt');
    writeFileSync(empty, '  \n');
    expect(await run('notify', 'ack', 'nope')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await run('notify', 'enqueue', '--key', 'k1', '--kind', 'shout', '--text-file', empty)).toMatchObject({ ok: false, error: { code: 'PRECONDITION' } });
    expect(await run('notify', 'enqueue', '--key', 'k1', '--kind', 'status', '--text-file', empty)).toMatchObject({ ok: false, error: { code: 'PRECONDITION' } });
  });
});

describe('minions work cancel argument validation', () => {
  it('needs task ids or --all, not both, and never neither', async () => {
    expect(await run('work', 'cancel')).toMatchObject({ ok: false, error: { code: 'PRECONDITION' } });
    expect(await run('work', 'cancel', 'task-1', '--all')).toMatchObject({ ok: false, error: { code: 'PRECONDITION' } });
  });
});
