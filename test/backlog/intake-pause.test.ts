import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertIntakeOpen, isIntakeCreation } from '../../src/backlog/intake.js';
import type { MinionsError } from '../../src/core/errors.js';
import { generatePlugin } from '../../src/plugin/generate.js';
import { collectStatus } from '../../src/runtime/commands.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';
import { MemoryBacklog, runCli } from './harness.js';

// The CLI runs in-process against an in-memory backlog (no Backlog.md subprocess); see harness.ts.
vi.mock('../../src/backlog/factory.js', async (orig) => (await import('./harness.js')).mockFactory(await orig()));

describe('intake pause: which creation counts as intake', () => {
  it('treats owner requests, tickets and agent ideas as intake', () => {
    expect(isIntakeCreation({ idempotencyKey: 'intake:add-login', provenance: 'user-decision' })).toBe(true);
    expect(isIntakeCreation({ idempotencyKey: 'intake:https://example.com/1', provenance: 'external-requirement' })).toBe(true);
    expect(isIntakeCreation({ idempotencyKey: 'some-request', provenance: 'agent-hypothesis' })).toBe(true);
    expect(isIntakeCreation({ idempotencyKey: 'qa-sweep:m1' })).toBe(true);
    expect(isIntakeCreation({ idempotencyKey: 'no-provenance' })).toBe(true);
  });

  it('exempts creation from existing work: parent, split:/followup:/qa: keys, observed-result', () => {
    expect(isIntakeCreation({ idempotencyKey: 'split:task-3:1', parent: 'task-3' })).toBe(false);
    expect(isIntakeCreation({ idempotencyKey: 'split:task-3:2' })).toBe(false);
    expect(isIntakeCreation({ idempotencyKey: 'child-x', parent: 'task-3', provenance: 'user-decision' })).toBe(false);
    expect(isIntakeCreation({ idempotencyKey: 'followup:task-3:docs' })).toBe(false);
    expect(isIntakeCreation({ idempotencyKey: 'qa:task-9:1' })).toBe(false);
    expect(isIntakeCreation({ idempotencyKey: 'flaky-test', provenance: 'observed-result' })).toBe(false);
  });

  it('`intake:` keys are always intake, even with a parent or observed-result provenance', () => {
    expect(isIntakeCreation({ idempotencyKey: 'intake:big-request:1', parent: 'task-5' })).toBe(true);
    expect(isIntakeCreation({ idempotencyKey: 'intake:x', provenance: 'observed-result' })).toBe(true);
  });

  it('assertIntakeOpen refuses intake only while paused, with a resume hint', () => {
    const o = { idempotencyKey: 'intake:add-login', provenance: 'user-decision' as const };
    expect(() => assertIntakeOpen(o, false)).not.toThrow();
    expect(() => assertIntakeOpen({ idempotencyKey: 'split:task-1:1', parent: 'task-1' }, true)).not.toThrow();
    let err: MinionsError | undefined;
    try { assertIntakeOpen(o, true); } catch (e) { err = e as MinionsError; }
    expect(err?.code).toBe('POLICY_DENIED');
    expect(err?.message).toMatch(/Intake is paused/);
    expect(err?.hint).toContain('minions resume --intake');
  });
});

// ---------------------------------------------------------------- CLI in runtime mode (temp state, in-memory backlog)

let state: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG'] as const;

beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), 'minions-intake-'));
  for (const k of ENV) saved[k] = process.env[k];
  const config = join(state, 'config.json');
  writeFileSync(config, JSON.stringify(defaults()));
  Object.assign(process.env, { MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: config });
});
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(state, { recursive: true, force: true });
});

const cli = runCli;

const errorCode = (out: string): string | undefined => {
  try { return (JSON.parse(out) as { error?: { code: string } }).error?.code; } catch { return undefined; }
};

describe('`minions backlog create` with intake paused', () => {
  const ownerRequest = (key = 'intake:add-login') => ['backlog', 'create', '--title', 'Add login', '--provenance', 'user-decision', '--key', key];

  it('refuses intake with POLICY_DENIED and a resume hint; pause --starts alone does not', async () => {
    expect((await cli(['pause', '--starts'])).code).toBe(0);
    const startsOnly = await cli(ownerRequest('intake:while-starts-paused'));
    expect(errorCode(startsOnly.out)).not.toBe('POLICY_DENIED');

    expect((await cli(['pause', '--intake'])).code).toBe(0);
    const r = await cli(ownerRequest());
    expect(r.code).toBe(3);
    const body = JSON.parse(r.out) as { ok: boolean; error: { code: string; message: string; hint: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('POLICY_DENIED');
    expect(body.error.message).toMatch(/Intake is paused/);
    expect(body.error.hint).toContain('minions resume --intake');

    // Agent ideas and tickets are intake too.
    const idea = await cli(['backlog', 'create', '--title', 'Maybe cache', '--provenance', 'agent-hypothesis', '--key', 'cache-idea']);
    expect(errorCode(idea.out)).toBe('POLICY_DENIED');
  });

  it('still allows documented exemptions (split children, follow-ups, QA findings) while paused', async () => {
    for (const extra of [
      ['--parent', 'task-1', '--key', 'split:task-1:1'],
      ['--key', 'followup:task-1:docs'],
      ['--key', 'qa:task-2:1'],
      ['--provenance', 'observed-result', '--key', 'flaky-ci'],
    ]) {
      const r = await cli(['backlog', 'create', '--title', `Exempt ${extra.at(-1)}`, ...extra]);
      expect(errorCode(r.out), extra.join(' ')).not.toBe('POLICY_DENIED');
      expect(r.code, r.out).toBe(0);
    }
  });

  it('resume --intake re-enables intake creation', async () => {
    const resumed = await cli(['resume', '--intake']);
    expect(resumed.code).toBe(0);
    expect((JSON.parse(resumed.out) as { data: { paused: { intake: boolean } } }).data.paused.intake).toBe(false);
    const r = await cli(ownerRequest());
    expect(errorCode(r.out)).not.toBe('POLICY_DENIED');
    expect(r.code, r.out).toBe(0);
    expect((JSON.parse(r.out) as { data: { created: boolean } }).data.created).toBe(true);
  });
});

describe('intake pause: isolation, re-runs, pause/resume combinations and status', () => {
  const ownerRequest = (key: string) => ['backlog', 'create', '--title', 'Add login', '--provenance', 'user-decision', '--key', key];

  it('uses only the temp state dir: runtime DB, backlog and config resolve under it', () => {
    const p = runtimePaths();
    expect(p.state).toBe(state);
    expect(p.db.startsWith(state + sep)).toBe(true);
    expect(p.backlog.startsWith(state + sep)).toBe(true);
    expect(existsSync(join(state, 'minions.db'))).toBe(true);
    expect(process.env.MINIONS_CONFIG?.startsWith(state + sep)).toBe(true);
  });

  it('the task created on resume landed in the temp backlog', async () => {
    const tasks = await MemoryBacklog.byRoot.get(join(state, 'backlog'))!.listTasks();
    expect(tasks.some((t) => t.title === 'Add login'), tasks.map((t) => t.title).join(', ')).toBe(true);
  });

  it('re-running an existing intake key is refused while paused; after resume it returns the existing task', async () => {
    expect((await cli(['pause', '--intake'])).code).toBe(0);
    expect(errorCode((await cli(ownerRequest('intake:add-login'))).out)).toBe('POLICY_DENIED');
    expect((await cli(['resume', '--intake'])).code).toBe(0);
    const after = await cli(ownerRequest('intake:add-login'));
    expect(errorCode(after.out)).not.toBe('POLICY_DENIED');
    expect((JSON.parse(after.out) as { data: { created: boolean } }).data.created).toBe(false);
  });

  it('plain `pause` pauses intake; `resume --starts` keeps it paused; plain `resume` re-opens it', async () => {
    expect((await cli(['pause'])).code).toBe(0);
    expect(errorCode((await cli(ownerRequest('intake:both-paused'))).out)).toBe('POLICY_DENIED');
    const startsOnly = await cli(['resume', '--starts']);
    expect((JSON.parse(startsOnly.out) as { data: { paused: { intake: boolean; starts: boolean } } }).data.paused)
      .toEqual({ intake: true, starts: false });
    expect(errorCode((await cli(ownerRequest('intake:starts-resumed'))).out)).toBe('POLICY_DENIED');
    expect((await cli(['resume'])).code).toBe(0);
    expect(errorCode((await cli(ownerRequest('intake:all-resumed'))).out)).not.toBe('POLICY_DENIED');
  });

  // `minions status --json` puts collectStatus's report under data (the CLI adds the tmux/launch probes, which spawn).
  it('the status report carries paused.intake, which the intake skill checks via `status --json`', async () => {
    const report = async () => {
      const db = new RuntimeDb(runtimePaths().db);
      try { return await collectStatus({ db, config: defaults(), backlog: async () => MemoryBacklog.byRoot.get(join(state, 'backlog'))! }); }
      finally { db.close(); }
    };
    expect((await cli(['pause', '--intake'])).code).toBe(0);
    expect((await report()).paused.intake).toBe(true);
    expect((await cli(['resume', '--intake'])).code).toBe(0);
    expect((await report()).paused.intake).toBe(false);
  });

  it('`--parent` exempts any non-`intake:` key while paused (documented); `intake:` keys stay refused', async () => {
    expect((await cli(['pause', '--intake'])).code).toBe(0);
    const child = await cli(['backlog', 'create', '--title', 'Child', '--parent', 'task-1', '--provenance', 'external-requirement', '--key', 'ticket-42']);
    expect(errorCode(child.out)).not.toBe('POLICY_DENIED');
    const tagged = await cli(['backlog', 'create', '--title', 'Child', '--parent', 'task-1', '--key', 'intake:ticket-42:1']);
    expect(errorCode(tagged.out)).toBe('POLICY_DENIED');
    expect((await cli(['resume', '--intake'])).code).toBe(0);
  });
});

describe('intake skill text', () => {
  it('checks paused intake before creating and lists the exemptions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minions-intake-plugin-'));
    try {
      await generatePlugin(defaults(), dir);
      const { readFile } = await import('node:fs/promises');
      const md = await readFile(join(dir, 'skills', 'intake', 'SKILL.md'), 'utf8');
      expect(md).toContain('minions status --json');
      expect(md).toContain('data.paused.intake');
      expect(md).toContain('minions resume --intake');
      expect(md).toContain('POLICY_DENIED');
      for (const exempt of ['`split:`', '`followup:`', '`qa:`', '`--parent`', '`observed-result`']) expect(md).toContain(exempt);
      // The pause check comes before any creation step.
      expect(md.indexOf('data.paused.intake')).toBeLessThan(md.indexOf('**Create idempotently.**'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
