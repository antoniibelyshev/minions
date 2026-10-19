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
// and minions denies Edit/Write there). The container runtime is unchanged (no hardening applied).
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
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

export type RawRun = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; allowFailure: boolean; timeoutMs: number }) => Promise<RunResult>;

/**
 * Runs `git args` in `cwd` with the host-runtime hardening. Work-tree commands also get the filter
 * overrides (read from the repository right before) and GIT_WORK_TREE=cwd when cwd is a work tree.
 */
export async function hardenedGit(cwd: string, args: string[], allowFailure: boolean, opts: { env?: NodeJS.ProcessEnv; run?: RawRun; timeoutMs?: number } = {}): Promise<RunResult> {
  const runner = opts.run ?? ((c, a, o) => run(c, a, o));
  const base = opts.env ?? process.env;
  const helper = base.MINIONS_GIT_CREDENTIAL_HELPER || undefined;
  const lead = hardenedGitArgs({ network: isNetworkOp(args), credentialHelper: helper });
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sub = subcommand(args);
  let extra: string[] = [];
  let workTree: string | undefined;
  if (WORKTREE_CMDS.has(sub)) {
    const isWorkTree = await lstat(join(cwd, '.git')).then(() => true, () => false);
    if (isWorkTree) {
      workTree = cwd;
      const list = await runner('git', [...lead, 'config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'], { cwd, env: hardenedGitEnv(base), allowFailure: true, timeoutMs: 30_000 });
      // exit 1 = no filter keys; anything else means the config could not be read: fail closed.
      if (list.code !== 0 && list.code !== 1) {
        if (allowFailure) return list;
        throw new MinionsError('INTERNAL', `git config could not be read in ${cwd}: ${list.stderr.trim().slice(0, 300)}`);
      }
      extra = filterOverrides(list.stdout);
    }
  }
  return runner('git', [...lead, ...extra, ...args], { cwd, env: hardenedGitEnv(base, workTree), allowFailure, timeoutMs });
}
