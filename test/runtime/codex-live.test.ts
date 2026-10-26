// task-14.6: opt-in live test of the Codex adapter (gate pilot) against the real `codex` CLI and the OpenAI API.
// Skipped unless MINIONS_LIVE_HARNESS=codex; never inside a worker (MINIONS_WORKER_LEASE): the coordinator runs it at
// a controlled moment. Needs `codex` (the pinned version) on PATH and CODEX_API_KEY; costs real API tokens.
// Model: MINIONS_LIVE_CODEX_MODEL (default gpt-5-codex). Isolation is `none` here; the sandbox self-test covers L1.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_RULES } from '../../src/config/harnesses.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { claimWithBrief, recordSubmitted } from '../../src/runtime/handoff.js';
import { codexAdapter } from '../../src/runtime/runner/codex.js';
import { runLease } from '../../src/runtime/runner/run.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeDefaultEnv, result } from './fixtures.js';

const live = process.env.MINIONS_LIVE_HARNESS === 'codex' && !process.env.MINIONS_WORKER_LEASE;
const MODEL = process.env.MINIONS_LIVE_CODEX_MODEL ?? 'gpt-5-codex';

describe.skipIf(!live)('live: Codex gate pilot', () => {
  it('a real codex exec reviews a one-line change and submits a valid gate result with usage', async () => {
    const key = process.env.CODEX_API_KEY;
    if (!key) throw new Error('MINIONS_LIVE_HARNESS=codex needs CODEX_API_KEY');
    const phase = PHASE_RULES['1b'];
    const e = makeDefaultEnv((c) => Object.assign(c as unknown as Record<string, unknown>, {
      harnesses: { codex: { models: { default: MODEL, allowed: [MODEL] }, timeoutMinutes: 10 } },
      roles: { 'codex-reviewer': { description: 'Codex review.', promptText: 'Review the change on the branch against the brief. Be brief.', contract: 'gate', harness: 'codex' } },
      workflows: { pilot: ['engineer', 'codex-reviewer'] },
    } satisfies Partial<Record<keyof MinionsConfig, unknown>>));
    const state = join(e.root, 'state');
    const paths = { state, briefs: join(state, 'briefs'), results: join(state, 'results'), scratch: join(e.root, 'scratch'), secretsDir: join(e.root, 'secrets'), drainFlag: join(state, 'run', 'drain') };
    mkdirSync(paths.secretsDir, { recursive: true });
    writeFileSync(join(paths.secretsDir, 'codex-api-key'), key + '\n', { mode: 0o600 });
    e.sched = new Scheduler({ db: e.db, backlog: e.backlog, config: e.config, layout: e.layout, handoff: paths, phase });
    e.backlog.add({ id: 'task-1', workflow: 'pilot' });
    const eng = await e.sched.claim('task-1', 'engineer');
    const head = commitFile(eng.worktree, 'a.txt', 'hello\n');
    await e.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head }));
    const b = await claimWithBrief(e.sched, paths, 'task-1', undefined);
    const out = await runLease(b.leaseId, {
      db: e.db, config: e.config, paths, commonDir: join(e.layout.repo, '.git'), adapters: { codex: codexAdapter() },
      isolation: { kind: 'none' }, phase, callerEnv: {}, callerCwd: e.root, env: process.env,
    });
    expect(out.error).toBeUndefined();
    expect(out.submitted).toBe(true);
    expect(out.violations).toEqual([]);
    expect(['complete', 'needs_changes']).toContain(out.status);
    expect(out.usage?.tokens).toBeGreaterThan(0);
    expect(gitSync(e.layout.repo, 'rev-parse', `refs/heads/${b.branch}`)).toBe(b.expectedHead);
    expect(await recordSubmitted(e.sched, paths, b.leaseId)).toMatchObject({ valid: true });
  }, 15 * 60_000);
});
