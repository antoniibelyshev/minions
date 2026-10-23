// CLI wiring of the role registry (task-33.2): `work claim|brief|submit --role` accept registered worker
// roles only; project roles are claimable through the stage machine (task-33.4).
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
  const roles = { researcher: { description: 'Researches.', promptText: 'Research.', contract: 'producer' } };
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...defaults('project-owner'), roles }));
  process.env.MINIONS_RUNTIME = 'container';
  process.env.MINIONS_STATE_DIR = join(root, 'state');
  process.env.MINIONS_CONFIG = join(root, 'config.json');
  process.env.MINIONS_WORKSPACE = join(root, 'workspace');
});
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

async function run(...args: string[]): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
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

describe('work claim|brief|submit --role (runtime)', () => {
  it('refuses roles the registry does not know, including the coordinator and prototype keys', async () => {
    for (const role of ['writer', 'coordinator', 'constructor', '__proto__', 'engineer-deep']) {
      for (const args of [['work', 'claim', 'task-1', '--role', role], ['work', 'brief', 'lease-abc', '--role', role], ['work', 'submit', 'lease-abc', '--role', role, '--result-file', join(root, 'none.json')]]) {
        const r = await run(...args);
        expect(r.ok, `${args.join(' ')}`).toBe(false);
        expect(r.error, `${args.join(' ')}`).toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/is not a registered worker role \(known: engineer, tester, reviewer, researcher\)/) });
      }
    }
  });

  it('recognizes a configured project role: claim passes the role check (task-33.4: project-role stages are claimable), brief reaches the lease check', async () => {
    const claim = await run('work', 'claim', 'task-1', '--role', 'researcher');
    // The role is accepted; the claim gets as far as the backlog (not initialized in this fixture).
    expect(claim.error).toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/Backlog\.md project not initialized/) });
    expect(claim.error!.message).not.toMatch(/registered worker role|project role/);
    const brief = await run('work', 'brief', 'lease-abc', '--role', 'researcher');
    expect(brief.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/Lease lease-abc does not exist/) });
  });
});
