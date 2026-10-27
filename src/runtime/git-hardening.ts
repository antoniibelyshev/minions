// Host runtime only (MINIONS_RUNTIME=host): hardening for git commands that minions runs in the agents'
// workspace clone. Some of them run OUTSIDE the Claude Code sandbox (`minions start` import/refresh,
// `minions export`, delegated `minions work publish|approve`, and the unsandboxed hooks), while the
// workspace (.git/config, .git/info, .gitattributes, gitfiles) is agent-writable. Command-line `-c`
// values are read after the repository config, so they neutralize the repository settings that make
// git run programs or talk to other hosts:
//
// - hooks (core.hooksPath=/dev/null), fsmonitor, pager, askpass and ssh commands;
// - credential helpers: the inherited list is reset (`credential.helper=` empties it) and only the
//   minions helper is added for https://github.com;
// - transports: everything but https (and local files/bundles where minions needs them) is denied;
//   network operations deny `file` too, so an insteadOf rewrite cannot reach a local repository with
//   an agent-chosen upload-pack/receive-pack;
// - clean/smudge/process filters: every driver defined outside the user's global config is emptied
//   (an empty command means "no filter"); attributes from the system and core.attributesFile are off;
// - core.worktree: GIT_WORK_TREE pins the work tree to the directory minions runs in;
// - no submodule recursion, no auto gc/maintenance; system config and inherited GIT_* variables are
//   dropped (GIT_CONFIG_NOSYSTEM, GIT_ATTR_NOSYSTEM).
//
// Residual: the filter list is read just before the command runs, so a concurrently running agent
// could race a new driver in between (the sandbox already denies sandboxed writes to <repo>/.git/config
// and minions denies Edit/Write there). In the container, only the process runner (runnerGit below) and the
// allowlisted git of the base update (allowlistedGit, at the end) use it.
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';

export const isHostRuntime = (env: NodeJS.ProcessEnv = process.env) => env.MINIONS_RUNTIME === 'host';

/** Transports that are always denied (an agent-set `protocol.<name>.allow` must not re-enable them). */
const DENIED_PROTOCOLS = ['ssh', 'git', 'http', 'ext', 'fd', 'ftp', 'ftps', 'rsync', 'testgit'];

/** Subcommands that read or write the work tree (filters, core.worktree). */
const WORKTREE_CMDS = new Set(['merge', 'checkout', 'switch', 'restore', 'reset', 'status', 'worktree', 'diff', 'stash', 'add', 'commit', 'read-tree', 'apply', 'am', 'cherry-pick', 'rebase', 'pull', 'clean', 'mv', 'rm']);

/** First non-option argument (the subcommand). */
const subcommand = (args: string[]) => args.find((a) => !a.startsWith('-')) ?? '';

/** push / ls-remote, and fetch from an https URL: no local-file transport. */
export function isNetworkOp(args: string[]): boolean {
  const sub = subcommand(args);
  if (sub === 'push' || sub === 'ls-remote') return true;
  return sub === 'fetch' && args.some((a) => /^https?:\/\//i.test(a));
}

export interface HardeningOptions { network?: boolean; credentialHelper?: string }

/** Leading `-c` options for host-runtime git. */
export function hardenedGitArgs(opts: HardeningOptions = {}): string[] {
  const c: string[] = [
    'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.sshCommand=/usr/bin/false', 'core.askPass=/usr/bin/false',
    'core.pager=cat', 'core.attributesFile=/dev/null',
    'credential.helper=',
    ...(opts.credentialHelper ? [`credential.https://github.com.helper=${opts.credentialHelper}`] : []),
    'gc.auto=0', 'maintenance.auto=false',
    'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'push.recurseSubmodules=no',
    'protocol.allow=never', 'protocol.https.allow=always', `protocol.file.allow=${opts.network ? 'never' : 'always'}`,
    ...DENIED_PROTOCOLS.map((p) => `protocol.${p}.allow=never`),
  ];
  return [...c.flatMap((v) => ['-c', v]), '--no-pager'];
}

/** Environment for host-runtime git: no inherited GIT_* / askpass variables, no system config or attributes. */
export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env, workTree?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('GIT_') && k !== 'SSH_ASKPASS') env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PROTOCOL_FROM_USER: '0',
    GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false',
  });
  if (workTree) env.GIT_WORK_TREE = workTree;
  return env;
}

/** `filter.<name>.<var>` keys -> `-c` options that empty every driver not defined only in the global config. */
export function filterOverrides(configList: string): string[] {
  const names = new Set<string>();
  for (const line of configList.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const scope = line.slice(0, tab), key = line.slice(tab + 1).trim();
    const m = /^filter\.(.+)\.([^.]+)$/i.exec(key);
    if (!m || scope === 'global' || scope === 'system') continue;
    const name = m[1]!;
    if (/[=\n\r]/.test(name)) throw new MinionsError('POLICY_DENIED', 'The workspace git config defines a filter driver with an unsafe name; refusing to run git.', 'Inspect the workspace .git/config.');
    names.add(name);
  }
  return [...names].flatMap((n) => ['clean=', 'smudge=', 'process=', 'required=false'].flatMap((v) => ['-c', `filter.${n}.${v}`]));
}

export type RawRun = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; allowFailure: boolean; timeoutMs: number; signal?: AbortSignal }) => Promise<RunResult>;

/**
 * Runs `git args` in `cwd` with the host-runtime hardening. Work-tree commands also get the filter
 * overrides (read from the repository right before) and GIT_WORK_TREE=cwd when cwd is a work tree.
 */
export async function hardenedGit(cwd: string, args: string[], allowFailure: boolean, opts: { env?: NodeJS.ProcessEnv; run?: RawRun; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
  const runner = opts.run ?? ((c, a, o) => run(c, a, o));
  const base = opts.env ?? process.env;
  const helper = base.MINIONS_GIT_CREDENTIAL_HELPER || undefined;
  const lead = hardenedGitArgs({ network: isNetworkOp(args), credentialHelper: helper });
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const signal = opts.signal ? { signal: opts.signal } : {};
  const sub = subcommand(args);
  let extra: string[] = [];
  let workTree: string | undefined;
  if (WORKTREE_CMDS.has(sub)) {
    const isWorkTree = await lstat(join(cwd, '.git')).then(() => true, () => false);
    if (isWorkTree) {
      workTree = cwd;
      const list = await runner('git', [...lead, 'config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'], { cwd, env: hardenedGitEnv(base), allowFailure: true, timeoutMs: 30_000, ...signal });
      // exit 1 = no filter keys; anything else means the config could not be read: fail closed.
      if (list.code !== 0 && list.code !== 1) {
        if (allowFailure) return list;
        throw new MinionsError('INTERNAL', `git config could not be read in ${cwd}: ${list.stderr.trim().slice(0, 300)}`);
      }
      extra = filterOverrides(list.stdout);
    }
  }
  return runner('git', [...lead, ...extra, ...args], { cwd, env: hardenedGitEnv(base, workTree), allowFailure, timeoutMs, ...signal });
}

// ---------------------------------------------------------------------------------------------------------
// Runner git (docs/design/agent-runtimes.md D3a). The process runner (`minions work run`) and its recovery run
// every git command through `runnerGit`, in the container and on the host alike: on the shared repository and
// on the per-lease clone a process worker wrote. On top of the host hardening above:
//
// - explicit `--git-dir` (and `--work-tree` where one is used): git never discovers a repository through a
//   `.git` file, and every inherited GIT_* variable is dropped (GIT_DIR, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY,
//   GIT_ALTERNATE_OBJECT_DIRECTORIES, ...);
// - GIT_CONFIG_GLOBAL is a runner-owned file, so no user or worker config is read besides the repository's own
//   (the clone's is rewritten by the runner before any call, the shared one is not worker-writable);
// - no untracked cache, commit graph or replace refs (all worker-writable lies about the history), no signing;
// - transfer/fetch/receive fsck on, and the `file` transport only for the runner's local clone and fetch-back,
//   with an explicit `--upload-pack=git-upload-pack`;
// - `--no-verify` and `--no-gpg-sign` on every commit and merge.

/** Leading `-c` options of every runner git call (after `--git-dir` / `--work-tree`). */
export function runnerGitArgs(opts: { localTransport?: boolean } = {}): string[] {
  const host = hardenedGitArgs({ network: !opts.localTransport });
  const extra = [
    'core.untrackedCache=false', 'core.commitGraph=false', 'core.useReplaceRefs=false', 'core.logAllRefUpdates=false',
    'core.symlinks=true', 'commit.gpgSign=false', 'tag.gpgSign=false', 'merge.verifySignatures=false',
    'transfer.fsckObjects=true', 'fetch.fsckObjects=true', 'receive.fsckObjects=true',
    'uploadpack.allowAnySHA1InWant=false', 'credential.interactive=false',
  ];
  // hardenedGitArgs ends with --no-pager; keep it last.
  return [...host.slice(0, -1), ...extra.flatMap((v) => ['-c', v]), '--no-pager'];
}

/** Environment of a runner git call: no inherited GIT_*, the runner-owned global config, no replace objects. */
export function runnerGitEnv(base: NodeJS.ProcessEnv, globalConfig: string): NodeJS.ProcessEnv {
  const env = hardenedGitEnv(base);
  Object.assign(env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: '/usr/bin/false', GIT_SEQUENCE_EDITOR: '/usr/bin/false' });
  return env;
}

/** Which repository a runner git call targets. Both paths absolute; `workTree` only where the command needs one. */
export interface RunnerGitTarget {
  gitDir: string;
  workTree?: string;
  /**
   * Runs before every call and throws when the target's pointer/control files are not the ones the runner
   * recorded or just rewrote (D3a: "before the call, the pointer and control files of that git dir must match").
   */
  verify?: () => Promise<void>;
}

/** Subcommands that the runner may run with the local `file` transport (clone and fetch-back only). */
const LOCAL_TRANSPORT_CMDS = new Set(['clone', 'fetch']);

/**
 * Builds the argv of one runner git call. Pure (tested): explicit git dir and work tree, the hardened `-c` set,
 * the filter overrides, `--no-verify --no-gpg-sign` for commit/merge and `--upload-pack` for fetch/clone.
 */
export function runnerGitArgv(target: Pick<RunnerGitTarget, 'gitDir' | 'workTree'> | null, args: string[], filters: string[] = []): string[] {
  const sub = subcommand(args);
  for (const p of [target?.gitDir, target?.workTree]) {
    if (p !== undefined && (!p.startsWith('/') || p.includes('\n'))) throw new MinionsError('INTERNAL', `runner git: not an absolute path: ${JSON.stringify(p)}`);
  }
  if (sub === 'clone' && target) throw new MinionsError('INTERNAL', 'runner git: clone takes no --git-dir');
  if (sub !== 'clone' && !target) throw new MinionsError('INTERNAL', 'runner git: every command but clone needs an explicit --git-dir');
  const lead = [
    ...(target ? [`--git-dir=${target.gitDir}`] : []),
    ...(target?.workTree ? [`--work-tree=${target.workTree}`] : []),
  ];
  const tail = [...args];
  const i = tail.indexOf(sub);
  if (sub === 'commit' || sub === 'merge') tail.splice(i + 1, 0, '--no-verify', '--no-gpg-sign');
  if (LOCAL_TRANSPORT_CMDS.has(sub)) tail.splice(i + 1, 0, '--upload-pack=git-upload-pack');
  return [...lead, ...runnerGitArgs({ localTransport: LOCAL_TRANSPORT_CMDS.has(sub) }), ...filters, ...tail];
}

export interface RunnerGitOptions {
  globalConfig: string; env?: NodeJS.ProcessEnv; run?: RawRun; timeoutMs?: number; cwd?: string;
  /** Author and committer of a runner commit (the only GIT_* variables a runner call sets besides the hardening). */
  identity?: { name: string; email: string };
}

/**
 * Runs one runner git command. `target` null only for `clone`. Work-tree commands first read the filter
 * drivers the target's config defines (with the same hardening) and empty them.
 */
export async function runnerGit(target: RunnerGitTarget | null, args: string[], allowFailure: boolean, opts: RunnerGitOptions): Promise<RunResult> {
  const runner = opts.run ?? ((c, a, o) => run(c, a, o));
  const env = runnerGitEnv(opts.env ?? process.env, opts.globalConfig);
  if (opts.identity) Object.assign(env, { GIT_AUTHOR_NAME: opts.identity.name, GIT_AUTHOR_EMAIL: opts.identity.email, GIT_COMMITTER_NAME: opts.identity.name, GIT_COMMITTER_EMAIL: opts.identity.email });
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const cwd = opts.cwd ?? '/';
  await target?.verify?.();
  let filters: string[] = [];
  if (target && WORKTREE_CMDS.has(subcommand(args))) {
    const list = await runner('git', runnerGitArgv(target, ['config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.']), { cwd, env, allowFailure: true, timeoutMs: 30_000 });
    if (list.code !== 0 && list.code !== 1) {
      if (allowFailure) return list;
      throw new MinionsError('INTERNAL', `git config could not be read in ${target.gitDir}: ${list.stderr.trim().slice(0, 300)}`);
    }
    filters = filterOverrides(list.stdout);
  }
  return runner('git', runnerGitArgv(target, args, filters), { cwd, env, allowFailure, timeoutMs });
}

// ---------------------------------------------------------------------------------------------------------
// Allowlisted git (task-68.3, docs/design/bootstrap.md "Base update and derived approval"). The git calls a
// base update or a derived approval depends on (base-update.ts) run in both runtimes with an environment
// built from an ALLOWLIST, never from the minions process environment: an agent invoking a minions command
// chooses that environment (GIT_COMMON_DIR, GIT_GRAFT_FILE, GIT_CONFIG_PARAMETERS, HOME/.gitconfig,
// XDG_CONFIG_HOME, ...). Only the locale, PATH, TZ and TMPDIR are kept (network calls also keep the proxy
// variables and minions' own MINIONS_* variables, which the credential helper reads); HOME is an empty
// directory the caller owns, no global or system config or attributes are read, and the only GIT_*
// variables are the ones set here (hardenedGitEnv plus GIT_CONFIG_GLOBAL, GIT_NO_REPLACE_OBJECTS,
// GIT_OPTIONAL_LOCKS). The host runtime adds the hardened `-c` options as for every host git call.

/** Variables an allowlisted git call keeps from the caller's environment; everything else is dropped. */
const ALLOWED_ENV = new Set(['PATH', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR']);
const ALLOWED_ENV_PREFIXES = ['LC_'];
/** Additionally kept for network calls (ls-remote, fetch): proxies and minions' own variables (credential helper). */
const NETWORK_ENV = new Set(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']);
const NETWORK_ENV_PREFIXES = ['MINIONS_'];

export interface AllowlistedGitEnvOptions {
  /** An empty directory owned by the caller: git's HOME (no ~/.gitconfig, ~/.config/git/*). */
  home: string;
  /** ls-remote / fetch: keep the proxy and MINIONS_* variables. */
  network?: boolean;
}

/** Environment of an allowlisted git call (see above). `base` is only read for the allowlisted names. */
export function allowlistedGitEnv(base: NodeJS.ProcessEnv, opts: AllowlistedGitEnvOptions): NodeJS.ProcessEnv {
  if (!isAbsolute(opts.home)) throw new MinionsError('INTERNAL', `allowlisted git: HOME must be an absolute path: ${JSON.stringify(opts.home)}`);
  const kept: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const allowed = ALLOWED_ENV.has(k) || ALLOWED_ENV_PREFIXES.some((p) => k.startsWith(p))
      || (!!opts.network && (NETWORK_ENV.has(k) || NETWORK_ENV_PREFIXES.some((p) => k.startsWith(p))));
    if (allowed) kept[k] = v;
  }
  kept.HOME = opts.home;
  // hardenedGitEnv drops every GIT_* (none is kept above anyway) and adds GIT_CONFIG_NOSYSTEM, GIT_ATTR_NOSYSTEM,
  // no prompts and no askpass.
  const env = hardenedGitEnv(kept);
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' });
  // The container keeps git's default protocol policy (a local origin stays usable, as for every container
  // git call); the host pins every protocol.*.allow on the command line instead.
  if (!isHostRuntime(base)) delete env.GIT_PROTOCOL_FROM_USER;
  return env;
}

export interface AllowlistedGitOptions extends AllowlistedGitEnvOptions {
  /** Where the allowlisted names are read from (default process.env). */
  env?: NodeJS.ProcessEnv;
  run?: RawRun; timeoutMs?: number; signal?: AbortSignal;
}

/** Runs `git args` in `cwd` with the allowlisted environment (and, on the host, the hardened `-c` options). */
export function allowlistedGit(cwd: string, args: string[], allowFailure: boolean, opts: AllowlistedGitOptions): Promise<RunResult> {
  const runner = opts.run ?? ((c, a, o) => run(c, a, o));
  const base = opts.env ?? process.env;
  const env = allowlistedGitEnv(base, opts);
  // `network` is explicit: behind an isolated call's leading --git-dir / -c options isNetworkOp cannot see the subcommand.
  const lead = isHostRuntime(base) ? hardenedGitArgs({ network: !!opts.network || isNetworkOp(args), credentialHelper: base.MINIONS_GIT_CREDENTIAL_HELPER || undefined }) : [];
  return runner('git', [...lead, ...args], { cwd, env, allowFailure, timeoutMs: opts.timeoutMs ?? 120_000, ...(opts.signal ? { signal: opts.signal } : {}) });
}
