// CLI wiring of held notifications and the digest (task-68.5) in the project runtime: `notify enqueue --hold`,
// the per-kind default hold while routine.enabled, `notify pending` without held items, `notify digest --json`
// (text, keys, numbered polls) and `notify ack` of the returned keys marking the digest time done.
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
  const cfg = defaults('project-owner');
  cfg.routine = { enabled: true, digestAt: ['08:00'], timezone: 'Europe/Berlin' };
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
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

const file = (name: string, text: string) => { const p = join(root, name); writeFileSync(p, text); return p; };

describe('minions notify: holds and the digest (runtime)', () => {
  it('enqueue holds by kind and flag; pending lists only what is due; digest covers the held items; ack marks it sent', async () => {
    const q = await run('notify', 'enqueue', '--key', 'question:task-6:1', '--kind', 'question', '--task', 'task-6', '--text-file', file('q.txt', 'Which database?\n1. Postgres (recommended)\n2. SQLite\n'));
    expect(q).toMatchObject({ ok: true, data: { created: true } });
    expect(q.data.heldUntil).toMatch(/T0[67]:00:00\.000Z$/); // the next 08:00 Berlin
    const s = await run('notify', 'enqueue', '--key', 'status:42', '--kind', 'status', '--text-file', file('s.txt', 'Status: all green'));
    expect(s.data.heldUntil).toBeNull(); // owner-requested status replies are never held by default
    const forced = await run('notify', 'enqueue', '--key', 'delivered:task-4:abc', '--kind', 'delivered', '--hold', 'none', '--text-file', file('d.txt', 'Delivered task-4'));
    expect(forced.data.heldUntil).toBeNull();
    const held = await run('notify', 'enqueue', '--key', 'other:note', '--kind', 'other', '--hold', 'digest', '--text-file', file('o.txt', 'FYI: docs updated'));
    expect(held.data.heldUntil).not.toBeNull();
    const bad = await run('notify', 'enqueue', '--key', 'x:1', '--kind', 'other', '--hold', 'tomorrow', '--text-file', file('x.txt', 'x'));
    expect(bad.ok).toBe(false);

    expect((await run('notify', 'pending')).data.items.map((i: { key: string }) => i.key)).toEqual(['status:42', 'delivered:task-4:abc']);
    for (const k of ['status:42', 'delivered:task-4:abc']) await run('notify', 'ack', k);

    const st = await run('notify', 'digest', '--status');
    expect(st).toMatchObject({ ok: true, data: { timezone: 'Europe/Berlin', times: ['08:00'], held: 2 } });

    const d = await run('notify', 'digest');
    expect(d.ok).toBe(true);
    expect(d.data.key).toMatch(/^digest:\d{4}-\d{2}-\d{2}T08:00$/);
    expect(d.data.text).toContain('Q1 (task-6) Which database?\n  1. Postgres (recommended)\n  2. SQLite\n  3. Other');
    expect(d.data.text).toContain('- FYI: docs updated');
    expect([...d.data.keys].sort()).toEqual([d.data.key, 'other:note', 'question:task-6:1'].sort());

    const acked = await run('notify', 'ack', ...d.data.keys);
    expect(acked.data.acked.every((a: { alreadyDelivered: boolean }) => !a.alreadyDelivered)).toBe(true);
    const after = await run('notify', 'digest', '--status');
    expect(after.data).toMatchObject({ held: 0, due: null });
    expect(after.data.deliveredAt).not.toBeNull();
    expect((await run('notify', 'pending', '--all')).data.items).toEqual([]);
  });
});
