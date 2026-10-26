// task-14.7 (agent-runtimes D8, D9): the Agents step of `minions setup`. One question authorizes one harness for the
// whole squad (`harnesses.default`), limited to the roles the phase allows; in phase 1 (b) choosing Codex also wires
// the read-only codex-reviewer pilot after the Claude reviewer in one owner-chosen workflow. Temp MINIONS_HOME,
// file credential store, fake container runtime; no Docker, no network.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      return [];
    },
  };
});

const { runSetup, formatSetup } = await import('../../src/host/setup.js');
const H = await import('../../src/host/harness-setup.js');
const { loadCredentialRefs, readCodexKey } = await import('../../src/host/credentials.js');
const { loadEffectiveConfig, loadProjectJson, projectConfigPath } = await import('../../src/host/project.js');
const { workerRole } = await import('../../src/config/roles.js');
const { resolveWorkflow } = await import('../../src/config/workflows.js');
const { projectPaths } = await import('../../src/core/paths.js');
const { dockerUp, makeRepo, withHome } = await import('./fixtures.js');
const { defaults } = await import('../helpers.js');
type SetupRuntime = import('../../src/host/setup.js').SetupRuntime;
type SetupResult = import('../../src/host/setup.js').SetupResult;

const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD';

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

/** Scripted prompts: answers by question prefix; unmatched questions take the default. */
function scripted(answers: Record<string, string> = {}, secrets: string[] = []) {
  const asked: string[] = [];
  const info: string[] = [];
  return {
    asked, info,
    io: {
      ask: async (q: string, def: string) => {
        asked.push(q);
        const key = Object.keys(answers).find((k) => q.startsWith(k));
        return key ? answers[key]! : def;
      },
      info: (l: string) => { info.push(l); },
      secret: async (prompt: string) => { asked.push(`secret:${prompt}`); return secrets.shift() ?? ''; },
    },
  };
}

function fakeRuntime(kind: 'docker' | 'host' = 'docker') {
  const state = { running: false, imported: false };
  const runtime: SetupRuntime = {
    kind: async () => kind,
    containerRunning: async () => state.running,
    start: async () => { state.running = true; },
    repoPresent: async () => state.imported,
    importRepo: async () => { state.imported = true; return { bundle: '/tmp/b', commit: 'a'.repeat(40), baseBranch: 'main', warnings: [], container: { origin: null } } as never; },
    launchCoordinator: async () => ({ action: 'started' }),
    attachCommand: () => 'attach',
  };
  return runtime;
}

const step = (r: SetupResult, id: string) => r.steps.find((s) => s.id === id)!;
const effective = async (r: SetupResult) => (await loadEffectiveConfig(await loadProjectJson(r.projectId))).config;
const localOf = (r: SetupResult) => JSON.parse(readFileSync(projectPaths(r.projectId).configLocalJson, 'utf8')) as Record<string, any>;
const AGENT_Q = 'Which agent should do the work?';
const base = { 'Installation visibility': 'private', 'Build and start the container': 'n' };

describe('setup: which agent does the work', () => {
  it('Codex: stores the key without echo, writes harnesses.default and the codex-reviewer pilot after the Claude reviewer', async () => {
    const repo = makeRepo(env.root);
    const a = scripted({ ...base, [AGENT_Q]: 'codex', 'Codex model': 'gpt-pilot' }, [OPENAI_KEY]);
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime(), dockerProbe: dockerUp });

    // Asked after Telegram and before the container, the key through the hidden prompt.
    const at = (q: string) => a.asked.findIndex((x) => x.startsWith(q));
    expect(at('Set up Telegram')).toBeLessThan(at(AGENT_Q));
    expect(at(AGENT_Q)).toBeLessThan(at('secret:OpenAI API key'));
    expect(at('Which workflow gets the codex-reviewer stage')).toBeLessThan(at('Build and start the container'));
    // Setup says plainly what the choice covers in this phase.
    expect(a.info.join('\n')).toMatch(/only as a read-only extra reviewer/);
    expect(a.info.join('\n')).toMatch(/stay on Claude Code until a later version, so Claude credentials are still needed/);

    const s = step(r, 'harness');
    expect(s).toMatchObject({ status: 'done', detail: expect.stringMatching(/^harnesses\.default codex \(model gpt-pilot\); codex-reviewer runs after the reviewer in workflow default; OpenAI API key stored in/) });
    expect(s.lines!.join('\n')).toMatch(/runtime image ships the pinned Codex CLI/);
    expect(s.lines!.join('\n')).not.toMatch(/must be installed|does not include/);
    expect(s.lines!.join('\n')).toMatch(/workflows\.default is now written out/);
    expect(await readCodexKey(r.projectId)).toBe(OPENAI_KEY);
    expect(JSON.stringify(r) + formatSetup(r) + a.info.join('\n')).not.toContain(OPENAI_KEY);

    // Recorded in the host-only layer, never in the project config.
    const local = localOf(r);
    expect(local.harnesses).toEqual({ default: 'codex', codex: { models: { default: 'gpt-pilot', allowed: ['gpt-pilot'] } } });
    expect(local.roles['codex-reviewer']).toMatchObject({ contract: 'gate', harness: 'codex' });
    expect(local.workflows).toEqual({ default: ['engineer', { role: 'tester', when: 'qa' }, 'reviewer', 'codex-reviewer'] });
    expect(r.localConfig.changed).toEqual(expect.arrayContaining(['harnesses.default', 'harnesses.codex', 'roles.codex-reviewer', 'workflows']));
    expect(readFileSync(projectConfigPath(await loadProjectJson(r.projectId)), 'utf8')).not.toContain('codex');

    const cfg = await effective(r);
    expect(workerRole(cfg, 'codex-reviewer')).toMatchObject({ harness: 'codex', contract: 'gate', worktree: 'review', edits: 'none', commits: false });
    for (const builtin of ['engineer', 'tester', 'reviewer']) expect(workerRole(cfg, builtin)!.harness).toBe('claude');

    // A rerun with the same answers keeps everything (the stored key is offered to keep).
    const again = scripted({ ...base, 'Project configuration': 'keep', [AGENT_Q]: 'codex', 'Codex model': 'gpt-pilot' });
    const r2 = await runSetup({ path: repo, yes: false, io: again.io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(again.asked.some((q) => q.startsWith('An OpenAI API key for Codex is stored. Keep it or change it?'))).toBe(true);
    expect(again.asked.some((q) => q.startsWith('secret:'))).toBe(false);
    expect(step(r2, 'harness')).toMatchObject({ status: 'kept', detail: expect.stringContaining('OpenAI API key already stored') });
    expect(r2.localConfig.changed).toEqual([]);
    // The question now defaults to the current harness.
    const def = scripted({ ...base, 'Project configuration': 'keep' });
    const r3 = await runSetup({ path: repo, yes: false, io: def.io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(step(r3, 'harness').status).toBe('kept');
    expect((await effective(r3)).harnesses?.default).toBe('codex');
  });

  it('puts the pilot stage into the workflow the owner picks (stage hints kept)', async () => {
    const repo = makeRepo(env.root);
    const first = await runSetup({ path: repo, yes: true, visibility: 'private', runtime: fakeRuntime(), dockerProbe: dockerUp });
    const file = projectConfigPath(await loadProjectJson(first.projectId));
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...raw, workflows: { careful: ['engineer', 'tester', { role: 'reviewer', model: 'opus' }] } }, null, 2));
    const a = scripted({ ...base, 'Project configuration': 'keep', [AGENT_Q]: 'codex', 'Which workflow': 'careful' }, [OPENAI_KEY]);
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(a.asked.find((q) => q.startsWith('Which workflow'))).toContain('(default/careful)');
    expect(step(r, 'harness').detail).toContain('in workflow careful');
    expect(step(r, 'harness').lines!.join('\n')).not.toContain('workflows.default is now written out');
    const cfg = await effective(r);
    expect(resolveWorkflow(cfg, 'careful')!.stages.map((s) => s.role)).toEqual(['engineer', 'tester', 'reviewer', 'codex-reviewer']);
    expect(cfg.workflows!.careful).toEqual(['engineer', 'tester', { role: 'reviewer', model: 'opus' }, 'codex-reviewer']);
    expect(Object.hasOwn(cfg.workflows!, 'default')).toBe(false);
    expect(cfg.harnesses?.codex?.models.default).toBe(H.SETUP_CODEX_MODEL);
  });

  it('Claude (the default), Junie and "later" change nothing; switching back to Claude records harnesses.default claude', async () => {
    const repo = makeRepo(env.root);
    for (const answer of [undefined, 'claude', 'junie', 'later']) {
      const a = scripted({ ...base, 'Project configuration': 'keep', ...(answer ? { [AGENT_Q]: answer } : {}) });
      const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime(), dockerProbe: dockerUp });
      expect(a.asked.find((q) => q.startsWith(AGENT_Q))).toBe(`${AGENT_Q} (claude/codex/junie/later)`);
      expect(step(r, 'harness').status, String(answer)).toBe('skipped');
      if (answer === 'junie') expect(step(r, 'harness').detail).toMatch(/Junie is not supported yet/);
      expect(a.asked.some((q) => q.startsWith('secret:'))).toBe(false);
      expect(existsSync(projectPaths(r.projectId).configLocalJson)).toBe(false);
    }
    const on = await runSetup({ path: repo, yes: false, io: scripted({ ...base, 'Project configuration': 'keep', [AGENT_Q]: 'codex' }, [OPENAI_KEY]).io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(step(on, 'harness').status).toBe('done');
    const off = await runSetup({ path: repo, yes: false, io: scripted({ ...base, 'Project configuration': 'keep', [AGENT_Q]: 'claude' }).io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(step(off, 'harness')).toMatchObject({ status: 'changed', detail: 'harnesses.default codex -> claude' });
    // The pilot role names its own harness, so it stays on Codex; the step says how to move it back.
    expect(step(off, 'harness').lines!.join('\n')).toContain('minions settings set roles.codex-reviewer.harness claude');
    expect(localOf(off).harnesses.default).toBe('claude');
  });

  it('is not asked with --yes or in the host runtime', async () => {
    const a = scripted({ 'Installation visibility': 'private' });
    const host = await runSetup({ path: makeRepo(env.root), yes: false, io: a.io, runtime: fakeRuntime('host'), dockerProbe: dockerUp });
    expect(a.asked.some((q) => q.startsWith(AGENT_Q))).toBe(false);
    expect(step(host, 'harness')).toMatchObject({ status: 'skipped', detail: expect.stringContaining('host runtime') });
    const yes = await runSetup({ path: makeRepo(env.root, 'other'), yes: true, visibility: 'private', runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(step(yes, 'harness')).toMatchObject({ status: 'skipped', detail: 'every worker runs on Claude Code' });
    const dry = await runSetup({ path: makeRepo(env.root, 'dry'), yes: false, dryRun: true, io: scripted().io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(step(dry, 'harness')).toMatchObject({ status: 'planned', detail: expect.stringContaining('Which agent should do the work?') });
  });

  it('records nothing when the planned config does not validate, or the key is refused', async () => {
    const repo = makeRepo(env.root);
    const first = await runSetup({ path: repo, yes: true, visibility: 'private', runtime: fakeRuntime(), dockerProbe: dockerUp });
    const file = projectConfigPath(await loadProjectJson(first.projectId));
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    // A project gate that edits: harnesses.default would move it onto Codex, which a read-only process gate forbids.
    writeFileSync(file, JSON.stringify({ ...raw, roles: { auditor: { description: 'Audit.', promptText: 'Audit.', contract: 'gate', worktree: 'branch', edits: 'any' } } }, null, 2));
    const r = await runSetup({ path: repo, yes: false, io: scripted({ ...base, 'Project configuration': 'keep', [AGENT_Q]: 'codex' }, [OPENAI_KEY]).io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(step(r, 'harness')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/do not validate: [\s\S]*roles\.auditor\.edits[\s\S]*nothing was recorded \(OpenAI API key stored in/) });
    expect(existsSync(projectPaths(r.projectId).configLocalJson)).toBe(false);
    expect(step(r, 'container').status).toBe('skipped'); // the rest of setup continues

    // A non-gate role named codex-reviewer is refused.
    writeFileSync(file, JSON.stringify({ ...raw, roles: { 'codex-reviewer': { description: 'X.', promptText: 'X.', contract: 'producer' } } }, null, 2));
    const r2 = await runSetup({ path: repo, yes: false, io: scripted({ ...base, 'Project configuration': 'keep', [AGENT_Q]: 'codex', 'An OpenAI API key': 'keep' }).io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(step(r2, 'harness')).toMatchObject({ status: 'failed', detail: expect.stringContaining('a producer role named codex-reviewer exists') });

    // A malformed key: nothing stored, nothing recorded, the key never echoed.
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const repo3 = makeRepo(env.root, 'third');
    const r3 = await runSetup({ path: repo3, yes: false, io: scripted({ ...base, [AGENT_Q]: 'codex' }, ['not a key']).io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(step(r3, 'harness')).toMatchObject({ status: 'failed', detail: expect.stringContaining('nothing was stored') });
    expect((await loadCredentialRefs(r3.projectId)).codex).toBeUndefined();
    expect(JSON.stringify(r3)).not.toContain('not a key');
    expect(existsSync(projectPaths(r3.projectId).configLocalJson)).toBe(false);
  });
});

describe('withPilotStage', () => {
  const cfg = (v: Partial<{ testerRequired: boolean; reviewerRequired: boolean }>) => {
    const c = defaults();
    Object.assign(c.verification, v);
    c.roles = { 'codex-reviewer': H.pilotRole() } as never;
    return c;
  };
  it('goes after the last reviewer stage of the derived default, or at the end without one; null when present', () => {
    expect(H.withPilotStage(cfg({ testerRequired: true }), 'default')).toEqual(['engineer', 'tester', 'reviewer', 'codex-reviewer']);
    expect(H.withPilotStage(cfg({ reviewerRequired: false }), 'default')).toEqual(['engineer', { role: 'tester', when: 'qa' }, 'codex-reviewer']);
    const c = cfg({});
    c.workflows = { x: ['engineer', { role: 'reviewer', model: 'sonnet' }, 'codex-reviewer'] };
    expect(H.withPilotStage(c, 'x')).toBeNull();
    c.workflows = { y: ['engineer', 'reviewer', 'tester'] }; // not a valid workflow; only the insert position is checked here
    expect(H.withPilotStage(c, 'y')).toEqual(['engineer', 'reviewer', 'codex-reviewer', 'tester']);
    expect(H.withPilotStage(c, 'missing')).toBeNull();
  });
  it('the pilot role validates as a read-only process gate in this phase', () => {
    expect(H.pilotRole()).toMatchObject({ contract: 'gate', harness: 'codex' });
    expect(H.pilotRole()).not.toHaveProperty('edits');
    expect(H.phaseScopeLines('OpenAI Codex CLI').join(' ')).toMatch(/read-only extra reviewer/);
  });
});
