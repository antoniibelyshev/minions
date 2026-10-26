// Edge cases for `minions setup`: idempotent --yes reruns (shared and private), --dry-run on an existing
// installation, declined integrations leaving nothing behind, secret-free error paths, and CLI wiring
// (non-TTY refusal, stdin-only tokens, install.sh passthrough flags).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (cfg: { delivery: { mode: string }; communication: { channel: string } }, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), `delivery ${cfg.delivery.mode} channel ${cfg.communication.channel}\n`);
      return [];
    },
  };
});

const { runSetup, formatSetup } = await import('../../src/host/setup.js');
const { runInit } = await import('../../src/host/install.js');
const { loadCredentialRefs } = await import('../../src/host/credentials.js');
const { loadRegistry } = await import('../../src/host/registry.js');
const { projectPaths, repoPaths } = await import('../../src/core/paths.js');
const { register } = await import('../../src/host/commands.js');
const { profileDefaults } = await import('../../src/config/profiles.js');
const { dockerUp, git, makeRepo, withHome } = await import('./fixtures.js');
type SetupRuntime = import('../../src/host/setup.js').SetupRuntime;
type SetupResult = import('../../src/host/setup.js').SetupResult;

const GH_TOKEN = 'github_pat_11ZYXWVUT9876543210_zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQ9876543210';
const TG_TOKEN = '987654321:AAHsecretsecretsecretsecretsecre_-9876';
const REMOTE = 'https://github.com/acme/edge.git';

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
  vi.restoreAllMocks();
});

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

function fakeRuntime(state = { running: false, imported: false, coordinator: false }) {
  const calls: string[] = [];
  const runtime: SetupRuntime = {
    containerRunning: async () => { calls.push('running?'); return state.running; },
    start: async () => { calls.push('start'); state.running = true; },
    repoPresent: async () => { calls.push('repo?'); return state.imported; },
    importRepo: async () => {
      calls.push('import'); state.imported = true;
      return { bundle: '/tmp/b', commit: 'b'.repeat(40), baseBranch: 'main', warnings: [], container: { origin: { url: REMOTE, authenticated: false, fetched: false, warnings: [] } } };
    },
    launchCoordinator: async () => {
      calls.push('coordinator');
      const was = state.coordinator; state.coordinator = true;
      return was ? { action: 'none', reason: 'already running' } : { action: 'started' };
    },
    attachCommand: () => 'docker compose exec app minions coordinator',
  };
  return { runtime, calls, state };
}

function githubRepo(name = 'repo'): string {
  const repo = makeRepo(env.root, name);
  git(repo, 'remote', 'add', 'origin', REMOTE);
  return repo;
}

const step = (r: SetupResult, id: string) => r.steps.find((s) => s.id === id)!;

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
}

/** Path -> content + mtime of every file under the roots (excluding the repo's .git internals). */
function snapshot(...roots: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const root of roots) {
    for (const p of allFiles(root)) {
      if (p.includes(`${join(root, '.git')}/`)) continue;
      out[p] = `${statSync(p).mtimeMs}:${readFileSync(p, 'utf8')}`;
    }
  }
  return out;
}

/** Everything a user or the model could see from a run (result, rendering, prompts, notes). */
const visible = (r: SetupResult, a?: ReturnType<typeof scripted>) =>
  JSON.stringify(r) + formatSetup(r) + (a ? a.asked.join('\n') + a.info.join('\n') : '');

describe('minions setup: idempotent reruns', () => {
  it.each(['shared', 'private'] as const)('--yes rerun (%s) writes nothing, keeps one registry entry, and does not re-import', async (visibility) => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    const first = await runSetup({ path: repo, yes: true, visibility, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(step(first, 'init').status).toBe('done');
    if (visibility === 'shared') expect(existsSync(repoPaths(repo).configJson)).toBe(true);
    else expect(existsSync(repoPaths(repo).dir)).toBe(false);
    const before = snapshot(env.home, repo);

    rt.calls.length = 0;
    const again = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(again.projectId).toBe(first.projectId);
    expect(again.rerun).toBe(true);
    expect(step(again, 'init').status).toBe('kept');
    expect(again.init.applied!.written).toEqual([]);
    expect(again.init.applied!.removed).toEqual([]);
    expect(again.localConfig.changed).toEqual([]);
    expect(snapshot(env.home, repo)).toEqual(before);
    expect(Object.keys((await loadRegistry()).projects)).toEqual([first.projectId]);
    expect(rt.calls).toEqual(['running?', 'start', 'repo?', 'coordinator']);
    expect(step(again, 'container').status).toBe('kept');
    expect(step(again, 'import').status).toBe('kept');
    expect(step(again, 'coordinator').status).toBe('kept');
  });

  it('a --yes rerun after an interactive install with tokens keeps them and changes nothing', async () => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    await runSetup({ path: repo, yes: true, visibility: 'private', delivery: 'branch', tokens: { github: GH_TOKEN, telegram: TG_TOKEN }, runtime: rt.runtime, dockerProbe: dockerUp,
      fetch: (async () => new Response(JSON.stringify({ full_name: 'acme/edge', permissions: { push: true } }), { status: 200 })) as typeof fetch });
    const before = snapshot(env.home, repo);
    const again = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(step(again, 'github').status).toBe('kept');
    expect(step(again, 'telegram').status).toBe('kept');
    expect(step(again, 'delivery')).toMatchObject({ status: 'kept', detail: 'delivery.mode branch' });
    expect(snapshot(env.home, repo)).toEqual(before);
  });
});

describe('minions setup: --dry-run', () => {
  it('on an existing installation writes nothing, stores no piped token, and makes no container calls', async () => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    const first = await runSetup({ path: repo, yes: true, visibility: 'shared', runtime: rt.runtime, dockerProbe: dockerUp });
    const before = snapshot(env.home, repo);
    rt.calls.length = 0;
    const a = scripted();
    const r = await runSetup({ path: repo, yes: false, dryRun: true, io: a.io, tokens: { github: GH_TOKEN }, delivery: 'pull-request', runtime: rt.runtime, dockerProbe: dockerUp });
    expect(r.dryRun).toBe(true);
    expect(r.rerun).toBe(true);
    expect(r.projectId).toBe(first.projectId);
    expect(a.asked).toEqual([]);
    expect(rt.calls).toEqual([]);
    expect(snapshot(env.home, repo)).toEqual(before);
    expect((await loadCredentialRefs(first.projectId)).github).toBeUndefined();
    expect(visible(r)).not.toContain(GH_TOKEN);
  });
});

describe('minions setup: declined integrations leave nothing behind', () => {
  it('declining GitHub, CI, auto-merge and Telegram writes no credential, secret, local layer, or repo file', async () => {
    const repo = githubRepo();
    const a = scripted({ 'Installation visibility': 'private', 'Set up GitHub integration': 'n', 'Use CI?': 'n', 'Enable auto-merge?': 'n', 'Set up Telegram': 'n' });
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    const paths = projectPaths(r.projectId);
    expect(a.asked.some((q) => q.startsWith('secret:'))).toBe(false);
    expect(existsSync(join(paths.dir, 'credentials.json'))).toBe(false);
    expect(allFiles(paths.secretsDir)).toEqual([]);
    expect(existsSync(paths.configLocalJson)).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const eff = JSON.parse(readFileSync(paths.runtimeConfigJson, 'utf8'));
    expect(eff.communication.channel).toBe('auto'); // the default; terminal while no bot token is stored
    expect(eff.delivery.mode).toBe('local');
  });
});

describe('minions setup: secrets on error paths', () => {
  it('a GitHub token rejected by the API is not stored, not shown, and setup continues', async () => {
    const repo = githubRepo();
    const f = (async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as typeof fetch;
    const r = await runSetup({ path: repo, yes: true, visibility: 'private', tokens: { github: GH_TOKEN }, delivery: 'pull-request', runtime: fakeRuntime().runtime, dockerProbe: dockerUp, fetch: f });
    expect(step(r, 'github')).toMatchObject({ status: 'failed', detail: expect.stringContaining('nothing was stored') });
    expect(step(r, 'delivery').status).toBe('failed');
    expect(step(r, 'coordinator').status).toBe('done');
    expect((await loadCredentialRefs(r.projectId)).github).toBeUndefined();
    expect(visible(r)).not.toContain(GH_TOKEN);
    for (const p of allFiles(env.home)) expect(readFileSync(p, 'utf8'), p).not.toContain(GH_TOKEN);
  });

  it('a transport error that echoes the token is redacted from the output', async () => {
    const repo = githubRepo();
    const f = (async () => { throw new Error(`connect ECONNREFUSED (Authorization: Bearer ${GH_TOKEN})`); }) as typeof fetch;
    const r = await runSetup({ path: repo, yes: true, visibility: 'private', tokens: { github: GH_TOKEN }, runtime: fakeRuntime().runtime, dockerProbe: dockerUp, fetch: f });
    expect(visible(r)).not.toContain(GH_TOKEN);
  });

  it('a malformed piped GitHub token or Telegram token fails without echoing the value', async () => {
    const repo = githubRepo();
    const badGh = 'ghx_definitely-secret-value-1234567890';
    const badTg = 'not:a-telegram-secret-value';
    const r = await runSetup({ path: repo, yes: true, visibility: 'private', tokens: { github: badGh, telegram: badTg }, runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    expect(step(r, 'github').status).toBe('failed');
    expect(step(r, 'telegram').status).toBe('failed');
    expect(visible(r)).not.toContain(badGh);
    expect(visible(r)).not.toContain(badTg);
    expect(existsSync(join(projectPaths(r.projectId).dir, 'credentials.json'))).toBe(false);
  });

  it('interactive prompts never carry a token and the token is read only through io.secret', async () => {
    const repo = githubRepo();
    const a = scripted({ 'Installation visibility': 'private', 'Set up GitHub integration': 'y', 'Set up Telegram': 'y' }, [GH_TOKEN, TG_TOKEN]);
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime().runtime, dockerProbe: dockerUp,
      fetch: (async () => new Response(JSON.stringify({ full_name: 'acme/edge', permissions: { push: true } }), { status: 200 })) as typeof fetch });
    expect(a.asked.filter((q) => q.startsWith('secret:'))).toEqual(['secret:GitHub token (input hidden): ', 'secret:Telegram bot token (input hidden): ']);
    expect(visible(r, a)).not.toContain(GH_TOKEN);
    expect(visible(r, a)).not.toContain(TG_TOKEN);
  });
});

describe('plain `minions init` is unaffected by the setup options', () => {
  it('still asks the delivery/channel questions and offers the token prompts', async () => {
    const repo = githubRepo();
    const a = scripted({ 'Installation visibility': 'private' });
    await runInit({ path: repo, yes: false, io: a.io, dockerProbe: dockerUp });
    expect(a.asked.some((q) => q.startsWith('Communication channel'))).toBe(true);
    expect(a.info.some((l) => l.includes('asked by `minions setup`'))).toBe(false);
  });
});

describe('CLI wiring', () => {
  const setupCmd = () => {
    const program = new Command();
    register(program);
    return program.commands.find((c) => c.name() === 'setup')!;
  };

  it('registers setup with stdin-only token flags (no option takes a token value)', () => {
    const cmd = setupCmd();
    const longs = cmd.options.map((o) => o.long).sort();
    expect(longs).toEqual(['--attach', '--config', '--delivery', '--dry-run', '--github-token-stdin', '--manager-token-stdin', '--new-identity', '--no-assistant', '--no-attach-coordinator', '--private', '--profile', '--runtime', '--shared', '--telegram-token-stdin', '--yes'].sort());
    for (const o of cmd.options.filter((x) => /token/.test(x.long ?? ''))) expect(o.required || o.optional).toBe(false);
  });

  it('one setup command: `setup github` and `setup assist` are subcommands, and flags after them belong to the subcommand', async () => {
    const program = new Command();
    register(program);
    const setup = program.commands.find((c) => c.name() === 'setup')!;
    expect(setup.commands.map((c) => c.name()).sort()).toEqual(['assist', 'github']);
    expect(program.commands.filter((c) => c.name() === 'setup')).toHaveLength(1);
    const seen: { sub: string; opts: Record<string, unknown> }[] = [];
    setup.action(() => { seen.push({ sub: 'setup', opts: setup.opts() }); });
    // The parent defines the same --yes/--dry-run flags and parses them first; the subcommands read them with optsWithGlobals.
    for (const sub of setup.commands) sub.action((_o: unknown, c: Command) => { seen.push({ sub: sub.name(), opts: c.optsWithGlobals() }); });
    await program.parseAsync(['setup', 'github', '--yes'], { from: 'user' });
    expect(seen.pop()).toMatchObject({ sub: 'github', opts: { yes: true } });
    const p2 = new Command();
    register(p2);
    const s2 = p2.commands.find((c) => c.name() === 'setup')!;
    for (const sub of s2.commands) sub.action((_o: unknown, c: Command) => { seen.push({ sub: sub.name(), opts: c.optsWithGlobals() }); });
    await p2.parseAsync(['setup', 'assist', '--dry-run'], { from: 'user' });
    expect(seen).toEqual([{ sub: 'assist', opts: expect.objectContaining({ dryRun: true }) }]);
  });

  it('accepts the install.sh passthrough `path --private --yes`', () => {
    const cmd = setupCmd();
    cmd.exitOverride();
    cmd.action(() => {});
    cmd.parse(['/tmp/x', '--private', '--yes'], { from: 'user' });
    expect(cmd.opts()).toMatchObject({ private: true, yes: true });
    expect(cmd.args).toEqual(['/tmp/x']);
  });

  it('refuses without a terminal unless --yes/--dry-run, and piped tokens require --yes; nothing is written', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const repo = makeRepo(env.root);
    const isTTY = process.stdin.isTTY;
    vi.stubEnv('MINIONS_RUNTIME', ''); // the host CLI (MINIONS_RUNTIME=host is the host agent runtime)
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      for (const args of [['setup', repo], ['setup', repo, '--github-token-stdin']]) {
        const program = new Command();
        register(program);
        await expect(program.parseAsync(args, { from: 'user' })).rejects.toThrow(/^exit [1-9]/);
      }
      const out = err.mock.calls.map((c) => String(c[0])).join('');
      expect(out).toContain('setup needs a terminal');
      expect(out).toContain('--yes');
      expect(exit).toHaveBeenCalledTimes(2);
      expect(allFiles(env.home)).toEqual([]);
      expect(existsSync(repoPaths(repo).dir)).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
      vi.unstubAllEnvs();
    }
  });
});

describe('install.sh', () => {
  it('runs `minions setup` with the target and passes the remaining arguments through unchanged', () => {
    const sh = readFileSync(join(import.meta.dirname, '..', '..', 'install.sh'), 'utf8');
    expect(sh).toMatch(/^exec minions setup "\$target" "\$@"$/m);
    expect(sh).not.toMatch(/exec minions init/);
  });
});

describe('minions setup: init options (--config, --attach, --new-identity)', () => {
  const writeCfg = async (name: string, mutate: (c: Record<string, any>) => void = () => {}) => {
    const { writeFileSync } = await import('node:fs');
    const cfg = profileDefaults('supervised', { hasGitHub: true, baseBranch: 'main', identity: { name: 'A', email: 'a@b' }, projectId: '00000000-0000-4000-8000-000000000000', packageVersion: '0.1.0' }).config as unknown as Record<string, any>;
    mutate(cfg);
    const file = join(env.root, name);
    writeFileSync(file, JSON.stringify(cfg));
    return file;
  };

  it('--config skips the init wizard and the questions the file covers; token questions are still asked', async () => {
    const repo = githubRepo();
    const cfg = await writeCfg('cfg.json');
    const a = scripted({ 'Set up GitHub integration': 'n', 'Use CI?': 'n' });
    const r = await runSetup({ path: repo, yes: false, io: a.io, visibility: 'private', configFile: cfg, runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    expect(r.init.plan.profile).toBe('supervised');
    expect(step(r, 'init').status).toBe('done');
    for (const q of ['Installation visibility', 'Starting profile', 'Project configuration', 'Delivery mode', 'Set up Telegram', 'Communication channel']) {
      expect(a.asked.some((x) => x.startsWith(q)), q).toBe(false);
    }
    expect(a.asked.some((x) => x.startsWith('Set up GitHub integration'))).toBe(true);
    expect(step(r, 'telegram').status).toBe('skipped');

    // Rerun with a changed file: applied without the keep/change question.
    const cfg2 = await writeCfg('cfg2.json', (c) => { c.execution.maxEngineers = 1; });
    const b = scripted({ 'Set up GitHub integration': 'n' });
    const again = await runSetup({ path: repo, yes: false, io: b.io, configFile: cfg2, runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    expect(again.rerun).toBe(true);
    expect(again.projectId).toBe(r.projectId);
    expect(step(again, 'init').status).toBe('changed');
    expect(b.asked.some((x) => x.startsWith('Project configuration'))).toBe(false);
    expect(JSON.parse(readFileSync(projectPaths(r.projectId).configJson, 'utf8')).execution.maxEngineers).toBe(1);
  });

  it('--yes --config applies the file non-interactively', async () => {
    const repo = githubRepo();
    const r = await runSetup({ path: repo, yes: true, visibility: 'private', configFile: await writeCfg('cfg.json'), runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    expect(r.init.plan.profile).toBe('supervised');
  });

  it('--new-identity and --attach are forwarded to init for a copied shared identity', async () => {
    const { cpSync } = await import('node:fs');
    const a = githubRepo('a');
    const ra = await runSetup({ path: a, yes: true, visibility: 'shared', runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    git(a, 'add', '.minions'); git(a, 'commit', '-q', '-m', 'minions');
    const b = join(env.root, 'b');
    cpSync(a, b, { recursive: true });
    await expect(runSetup({ path: b, yes: true, runtime: fakeRuntime().runtime, dockerProbe: dockerUp })).rejects.toMatchObject({ code: 'CONFLICT' });
    const rb = await runSetup({ path: b, yes: true, newIdentity: true, runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    expect(rb.projectId).not.toBe(ra.projectId);
    const c = join(env.root, 'c');
    cpSync(a, c, { recursive: true });
    const rc = await runSetup({ path: c, yes: true, attach: true, runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    expect(rc.projectId).toBe(ra.projectId);
    expect((await loadRegistry()).projects[ra.projectId]!.repoPath).toBe(c);
  });

  it('the CLI accepts the install.sh passthrough `path --config cfg.json --attach --new-identity`', () => {
    const program = new Command();
    register(program);
    const cmd = program.commands.find((x) => x.name() === 'setup')!;
    cmd.exitOverride();
    cmd.action(() => {});
    cmd.parse(['/tmp/x', '--config', 'cfg.json', '--attach', '--new-identity', '--no-attach-coordinator'], { from: 'user' });
    expect(cmd.opts()).toMatchObject({ config: 'cfg.json', attach: true, newIdentity: true, attachCoordinator: false });
  });
});

describe('minions setup: empty piped tokens', () => {
  it.each([
    [{ github: '' }, /--github-token-stdin: no GitHub token .*empty/, /first line/],
    [{ github: '   ' }, /--github-token-stdin/, /first line/],
    [{ telegram: '' }, /--telegram-token-stdin: no Telegram token .*empty/, /first line/],
    [{ github: GH_TOKEN, telegram: '' }, /--telegram-token-stdin/, /second line/],
  ])('%j fails before anything is written and does not echo the input', async (tokens, message, hint) => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    const e = await runSetup({ path: repo, yes: true, visibility: 'private', tokens, runtime: rt.runtime, dockerProbe: dockerUp }).then(() => null, (x: unknown) => x as { code: string; message: string; hint?: string });
    expect(e).toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(message), hint: expect.stringMatching(hint) });
    expect(JSON.stringify(e)).not.toContain(GH_TOKEN);
    expect(rt.calls).toEqual([]);
    expect(allFiles(env.home)).toEqual([]);
  });

  it('the CLI exits non-zero on empty stdin with --yes --github-token-stdin', async () => {
    const { Readable } = await import('node:stream');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const repo = githubRepo();
    vi.stubEnv('MINIONS_RUNTIME', ''); // the host CLI (MINIONS_RUNTIME=host is the host agent runtime)
    const stdin = Object.assign(Readable.from(['']), { isTTY: false });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    try {
      const program = new Command();
      register(program);
      await expect(program.parseAsync(['setup', repo, '--yes', '--private', '--github-token-stdin'], { from: 'user' })).rejects.toThrow(/^exit [1-9]/);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('no GitHub token was read from stdin');
      expect(allFiles(env.home)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
