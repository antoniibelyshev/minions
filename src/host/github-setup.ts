// Guided GitHub setup: remote, base branch on the remote, fine-grained token, delivery mode.
// Used proactively by an interactive `minions init` and standalone by `minions setup github`.
//
// - Never runs without the user: --yes / non-interactive only returns next-step hints (no prompt, no
//   push, no browser, no network).
// - Adding a remote and pushing the base branch each need an explicit answer and show the exact git
//   command first. The browser is opened (`open <url>` on macOS) only after a yes.
// - The token goes through the existing non-echoing prompt and `provisionGithubToken` (verified
//   against the GitHub API before it is stored); it is never printed, logged or put in argv.
// - The token creation link is a GitHub "template URL" (docs.github.com, "Pre-filling fine-grained
//   personal access token details using URL parameters"): name, description, target_name,
//   expires_in and <permission>=<level>. Repository selection cannot be pre-filled.
import type { Command } from 'commander';
import { can } from '../config/capabilities.js';
import type { MinionsConfig } from '../config/schema.js';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { readJsonIfExists } from '../core/fsutil.js';
import { editProjectConfig } from './config-write.js';
import { emit } from '../core/output.js';
import { projectPaths } from '../core/paths.js';
import { normalizeGithubRemote } from '../runtime/github.js';
import {
  GITHUB_TOKEN_CREATE_URL, GITHUB_TOKEN_PERMISSIONS, githubCredentialStatus, githubRepoFromRemote, loadCredentialRefs,
  provisionGithubToken, type CredentialsJson, type Fetch, type ProvisionResult,
} from './credentials.js';
import { HOST_GIT, sanitizeRemoteUrl } from './discovery.js';
import type { Runner } from './docker.js';
import { projectJsonBytes, writeGenerated } from './install.js';
import { loadEffectiveConfig, loadProjectJson, projectConfigPath, type ProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { readlineIO, type WizardIO } from './wizard.js';

// ---------------------------------------------------------------- token link + guidance

/**
 * Permissions the template URL can pre-fill (names/levels from the GitHub docs). Metadata: read is
 * added by GitHub automatically. Checks is selected by hand (not listed among template parameters).
 */
export const TEMPLATE_PERMISSIONS: Record<string, 'read' | 'write'> = { contents: 'write', pull_requests: 'write', actions: 'read', statuses: 'read' };
export const TOKEN_EXPIRES_DAYS = 90;

/** Pre-filled fine-grained PAT creation link for this repository (falls back to the plain page). */
export function githubTokenUrl(remoteUrl: string | null | undefined): string {
  const r = githubRepoFromRemote(remoteUrl);
  if (!r) return GITHUB_TOKEN_CREATE_URL;
  const q = new URLSearchParams({
    name: `minions ${r.repo}`.slice(0, 40),
    description: `minions agents: push agent/* branches and open pull requests for ${r.owner}/${r.repo} only`.slice(0, 1024),
    target_name: r.owner,
    expires_in: String(TOKEN_EXPIRES_DAYS),
    ...TEMPLATE_PERMISSIONS,
  });
  return `${GITHUB_TOKEN_CREATE_URL}?${q.toString()}`;
}

export function githubTokenSteps(remoteUrl: string | null | undefined): string[] {
  const r = githubRepoFromRemote(remoteUrl);
  const repo = r ? `${r.owner}/${r.repo}` : "this project's repository";
  return [
    `1. Open ${githubTokenUrl(remoteUrl)}`,
    r ? '   (name, description, owner, a 90-day expiry and the permissions below are pre-filled; check them)' : '',
    `2. Repository access: "Only select repositories" -> ${repo} (GitHub cannot pre-fill this; pick exactly this one).`,
    '3. Repository permissions (nothing else; no account permissions):',
    ...GITHUB_TOKEN_PERMISSIONS.map((p) => `     - ${p.permission}: ${p.access}${p.permission === 'Checks' ? ' (select by hand if listed)' : ''}`),
    '4. Generate the token, copy it, and paste it at the hidden prompt (or later: `minions auth github`).',
  ].filter(Boolean);
}

// ---------------------------------------------------------------- inspection (no network)

export interface GithubState {
  remoteUrl: string | null;
  repository: string | null;
  /** origin exists but is not a github.com repository. */
  nonGithubOrigin: boolean;
  baseBranch: string;
  /** refs/remotes/origin/<base> exists locally (null when there is no GitHub remote). Never fetched. */
  baseOnRemote: boolean | null;
  token: 'missing' | 'stored';
  deliveryMode: MinionsConfig['delivery']['mode'] | null;
  pushDenied: boolean;
}

const gitOut = async (runner: Runner, repo: string, args: string[]) => {
  const r = await runner('git', [...HOST_GIT, ...args], { cwd: repo, allowFailure: true, timeoutMs: 15_000 });
  return r.code === 0 ? r.stdout.trim() : null;
};

export async function inspectGithub(project: ProjectJson, repoPath: string, opts: { runner?: Runner } = {}): Promise<GithubState> {
  const runner = opts.runner ?? run;
  const remoteUrl = sanitizeRemoteUrl(await gitOut(runner, repoPath, ['config', '--get', 'remote.origin.url']));
  const gh = githubRepoFromRemote(remoteUrl);
  const baseOnRemote = gh ? (await gitOut(runner, repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${project.baseBranch}`])) !== null : null;
  const refs = await loadCredentialRefs(project.projectId).catch((): CredentialsJson => ({ version: 1 }));
  const cfg = await loadEffectiveConfig(project).then((e) => e.config, () => null);
  return {
    remoteUrl, repository: gh ? `${gh.owner}/${gh.repo}` : null, nonGithubOrigin: !!remoteUrl && !gh,
    baseBranch: project.baseBranch, baseOnRemote, token: refs.github ? 'stored' : 'missing',
    deliveryMode: cfg?.delivery.mode ?? null, pushDenied: cfg ? can(cfg, 'git.push') === 'deny' : false,
  };
}

/** Next steps for a non-interactive run (--yes, no terminal) and for doctor. Nothing is executed. */
export function githubHints(s: GithubState): string[] {
  const out: string[] = [];
  if (!s.repository) {
    out.push(s.nonGithubOrigin
      ? `origin (${s.remoteUrl}) is not on github.com; branch/pull-request delivery needs origin on GitHub (\`git remote set-url origin https://github.com/<owner>/<repo>.git\`), then run \`minions setup github\`.`
      : 'No GitHub remote: add one for branch/pull-request delivery and CI (`git remote add origin https://github.com/<owner>/<repo>.git`), then run `minions setup github`.');
    return out;
  }
  if (s.baseOnRemote === false) out.push(`origin has no known ${s.baseBranch} branch (no refs/remotes/origin/${s.baseBranch}): push it with \`git push -u origin ${s.baseBranch}\` (or \`git fetch origin\` if it exists).`);
  if (s.token === 'missing') out.push(`No GitHub token for this project: run \`minions setup github\` (guided) or \`minions auth github\`; create it at ${githubTokenUrl(s.remoteUrl)}`);
  else if (s.deliveryMode === 'local' && !s.pushDenied) out.push('A GitHub token is stored; pull-request delivery is available: run `minions setup github` to switch delivery.mode.');
  return out;
}

/** One line for `minions start` when a GitHub remote exists but no token is stored (no network). */
export async function githubStartHint(project: ProjectJson, _config?: MinionsConfig): Promise<string | null> {
  if (!githubRepoFromRemote(project.remoteUrl)) return null;
  const refs = await loadCredentialRefs(project.projectId).catch((): CredentialsJson => ({ version: 1 }));
  return refs.github ? null : 'hint: GitHub is not set up for this project (no token); branch/PR delivery is off. Run `minions setup github`.';
}

// ---------------------------------------------------------------- config change (delivery mode)

/**
 * Sets delivery.mode (and provider github) in the project configuration with a configRevision bump,
 * validated like any config. A file edited since minions generated it is not touched (instructions instead).
 */
export async function setDeliveryMode(project: ProjectJson, mode: MinionsConfig['delivery']['mode']): Promise<{ changed: boolean; path: string; note: string }> {
  const file = projectConfigPath(project);
  const manual = `set "delivery": { "mode": "${mode}"${mode === 'local' ? '' : ', "provider": "github"'} } in ${file}`;
  if (!(await readJsonIfExists(file))) return { changed: false, path: file, note: `configuration not found; ${manual}` };
  const r = await editProjectConfig(project, (raw) => {
    const delivery = (raw.delivery ?? {}) as Record<string, unknown>;
    if (delivery.mode === mode) return null;
    return { ...raw, delivery: { ...delivery, mode, ...(mode === 'local' ? {} : { provider: 'github' }) } };
  }, { requireUnedited: true });
  if (r.edited && r.changed) return { changed: false, path: file, note: `${file} was edited since minions generated it; ${manual}` };
  if (!r.changed) return { changed: false, path: file, note: `delivery.mode is already ${mode}` };
  return { changed: true, path: file, note: `delivery.mode = ${mode} (configRevision ${r.revision})${project.visibility === 'shared' ? '; commit .minions/config.json to share it' : ''}; applies on the next \`minions start\`` };
}

// ---------------------------------------------------------------- guided flow

export interface GithubSetupOptions {
  projectId: string;
  repoPath: string;
  io?: WizardIO;
  /** --yes / non-interactive: hints only. */
  yes?: boolean;
  runner?: Runner;
  fetch?: Fetch;
  /** Opens a URL (default: `open <url>` on macOS). Called only after an explicit yes. */
  openUrl?: (url: string) => Promise<void>;
  platform?: NodeJS.Platform;
  /** init already asked "Set up GitHub now?" style questions elsewhere: skip the opening question. */
  skipIntro?: boolean;
}

export type TokenStepStatus = 'present' | 'stored' | 'skipped' | 'failed';
export interface GithubSetupResult {
  interactive: boolean;
  state: GithubState;
  remote: { status: 'present' | 'added' | 'missing' | 'not-github'; url: string | null };
  base: { branch: string; onRemote: boolean | null; pushed: boolean; command: string | null };
  token: { status: TokenStepStatus; detail: string; provisioned?: Omit<ProvisionResult, 'projectId'> };
  delivery: { mode: MinionsConfig['delivery']['mode'] | null; changed: boolean; note: string | null };
  tokenUrl: string;
  nextSteps: string[];
}

const yes = (s: string) => /^y(es)?$/i.test(s.trim());

/** Accepts owner/repo, https://github.com/owner/repo(.git), or git@github.com:owner/repo.git. */
export function parseGithubRepoInput(s: string): string {
  const t = s.trim();
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(t);
  const url = short && !t.includes(':') ? `https://github.com/${short[1]}/${short[2]}.git` : normalizeGithubRemote(t);
  if (!url) throw new MinionsError('INVALID_CONFIG', `"${t.slice(0, 80)}" is not a GitHub repository (use owner/repo or https://github.com/owner/repo).`);
  return url;
}

export async function runGithubSetup(opts: GithubSetupOptions): Promise<GithubSetupResult> {
  const runner = opts.runner ?? run;
  let project = await loadProjectJson(opts.projectId);
  let state = await inspectGithub(project, opts.repoPath, { runner });
  const io = opts.io;
  const interactive = !!io && !opts.yes;
  const result: GithubSetupResult = {
    interactive, state,
    remote: { status: state.repository ? 'present' : state.nonGithubOrigin ? 'not-github' : 'missing', url: state.remoteUrl },
    base: { branch: state.baseBranch, onRemote: state.baseOnRemote, pushed: false, command: null },
    token: state.token === 'stored' ? { status: 'present', detail: 'a GitHub token is already stored for this project' } : { status: 'skipped', detail: 'not set up' },
    delivery: { mode: state.deliveryMode, changed: false, note: null },
    tokenUrl: githubTokenUrl(state.remoteUrl),
    nextSteps: [],
  };
  if (!interactive) { result.nextSteps = githubHints(state); return result; }

  if (!opts.skipIntro) {
    io.info(['', 'GitHub setup (recommended): with a GitHub remote and a fine-grained token limited to this repository,',
      'minions can push agent/<slug> branches and open pull requests (never merged), and later observe CI.'].join('\n'));
    if (!yes(await io.ask('Set up GitHub for this project now? (y/n)', 'y'))) {
      result.nextSteps = ['GitHub setup skipped; run `minions setup github` any time.', ...githubHints(state)];
      return result;
    }
  }

  // 1. Remote.
  if (!state.repository) {
    if (state.nonGithubOrigin) {
      io.info(`origin is ${state.remoteUrl}, which is not on github.com; minions does not change an existing origin.`);
      io.info('  To use GitHub, point origin at it yourself: git remote set-url origin https://github.com/<owner>/<repo>.git');
      result.nextSteps = githubHints(state);
      return result;
    }
    io.info('No GitHub remote. Without one, delivery stays local (commits fetched with `minions export`).');
    if (yes(await io.ask('Add a GitHub remote as origin now? (y/n)', 'y'))) {
      let url: string | null = null;
      for (let i = 0; i < 3 && !url; i++) {
        const a = (await io.ask('GitHub repository (owner/repo or https://github.com/owner/repo; empty to skip)', '')).trim();
        if (!a) break;
        try { url = parseGithubRepoInput(a); } catch (e) { io.info(`  ${(e as Error).message}`); }
      }
      if (url) {
        io.info(`  Running: git remote add origin ${url}`);
        const r = await runner('git', [...HOST_GIT, 'remote', 'add', 'origin', url], { cwd: opts.repoPath, allowFailure: true, timeoutMs: 15_000 });
        if (r.code !== 0) {
          io.info(`  git remote add failed: ${(r.stderr || r.stdout).trim().split('\n').pop() ?? ''}`);
        } else {
          project = { ...project, remoteUrl: url };
          await writeGenerated(project.projectId, projectPaths(project.projectId).projectJson, projectJsonBytes(project));
          result.remote = { status: 'added', url };
          io.info('  The repository must exist on GitHub (create it at https://github.com/new if needed).');
        }
      }
    }
    state = await inspectGithub(project, opts.repoPath, { runner });
    result.state = state;
    result.base.onRemote = state.baseOnRemote;
    if (!state.repository) { result.nextSteps = githubHints(state); return result; }
  } else if (project.remoteUrl !== state.remoteUrl) {
    project = { ...project, remoteUrl: state.remoteUrl };
    await writeGenerated(project.projectId, projectPaths(project.projectId).projectJson, projectJsonBytes(project));
  }
  result.tokenUrl = githubTokenUrl(state.remoteUrl);

  // 2. Base branch on the remote (local knowledge only; nothing is fetched).
  if (state.baseOnRemote === false) {
    const command = `git push -u origin ${state.baseBranch}`;
    result.base.command = command;
    io.info(`origin has no known ${state.baseBranch} branch. Pull requests target it, so it must exist on GitHub.`);
    io.info(`  Command: ${command}   (uses your own git credentials; nothing else is pushed)`);
    // Show where the push really goes (pushurl / insteadOf can differ from the fetch URL).
    const pushUrl = await runner('git', [...HOST_GIT, 'remote', 'get-url', '--push', 'origin'], { cwd: opts.repoPath, allowFailure: true, timeoutMs: 15_000 });
    if (pushUrl.code === 0 && pushUrl.stdout.trim()) io.info(`  Push URL: ${sanitizeRemoteUrl(pushUrl.stdout.trim().split('\n')[0]!)}`);
    if (yes(await io.ask(`Push ${state.baseBranch} to origin now? (y/n)`, 'n'))) {
      const r = await runner('git', [...HOST_GIT, 'push', '-u', 'origin', `refs/heads/${state.baseBranch}:refs/heads/${state.baseBranch}`], { cwd: opts.repoPath, allowFailure: true, timeoutMs: 300_000 });
      result.base.pushed = r.code === 0;
      io.info(r.code === 0 ? `  Pushed ${state.baseBranch}.` : `  Push failed: ${(r.stderr || r.stdout).trim().split('\n').pop() ?? `exit ${r.code}`}. Run it yourself: ${command}`);
    }
  }

  // 3. Token.
  let tokenOk = false;
  if (state.token === 'stored') {
    const st = await githubCredentialStatus(project, { runner, fetch: opts.fetch }).catch(() => null);
    if (st?.state === 'ok' || st?.state === 'unverified') {
      tokenOk = true;
      result.token = { status: 'present', detail: `GitHub token already stored (${st.state}: ${st.detail})` };
      io.info(`GitHub token: ${result.token.detail}; replace it with \`minions auth github\`.`);
    } else {
      io.info(`GitHub token: stored but ${st?.state ?? 'not checkable'}${st ? ` (${st.detail})` : ''}; create a new one.`);
    }
  }
  if (!tokenOk) {
    io.info(['', 'Create a fine-grained personal access token for this repository only:', ...githubTokenSteps(state.remoteUrl).map((l) => `  ${l}`)].join('\n'));
    const platform = opts.platform ?? process.platform;
    if (platform === 'darwin' || opts.openUrl) {
      if (yes(await io.ask('Open the token page in your browser? (y/n)', 'n'))) {
        const open = opts.openUrl ?? (async (u: string) => { await runner('open', [u], { allowFailure: true, timeoutMs: 15_000 }); });
        await open(result.tokenUrl);
      }
    }
    if (!io.secret) {
      result.token = { status: 'skipped', detail: 'no terminal for a non-echoing prompt; run `minions auth github` later.' };
    } else if (!yes(await io.ask('Store a GitHub token for this project now? (y/n)', 'y'))) {
      result.token = { status: 'skipped', detail: 'skipped; run `minions setup github` or `minions auth github` later.' };
    } else {
      for (let attempt = 1; attempt <= 2 && !tokenOk; attempt++) {
        try {
          const token = await io.secret('GitHub token (input hidden): ');
          const { projectId: _id, ...provisioned } = await provisionGithubToken({
            projectId: project.projectId, token, repoPath: opts.repoPath, remoteUrl: state.remoteUrl, runner: opts.runner, fetch: opts.fetch,
          });
          result.token = { status: 'stored', detail: `stored in ${provisioned.backend === 'keychain' ? 'the macOS Keychain' : 'a 0600 host file'}${provisioned.verification ? `; ${provisioned.verification.status}: ${provisioned.verification.detail}` : ''}`, provisioned };
          tokenOk = true;
        } catch (e) {
          result.token = { status: 'failed', detail: `${e instanceof MinionsError ? e.message : 'could not store the token'}; run \`minions auth github\` to retry.` };
          io.info(`  ${result.token.detail}`);
          if (attempt < 2 && !yes(await io.ask('Try again? (y/n)', 'y'))) break;
        }
      }
    }
  }

  // 4. Delivery mode (needs a working token; never offered when the profile denies git.push).
  if (tokenOk && !state.pushDenied && state.deliveryMode) {
    io.info('Delivery: pull-request (recommended: push agent/<slug> and open one PR, never merged), branch (push only), or local.');
    const def = state.deliveryMode === 'local' ? 'pull-request' : state.deliveryMode;
    let mode: MinionsConfig['delivery']['mode'] | null = null;
    for (let i = 0; i < 3 && !mode; i++) {
      const a = (await io.ask('Delivery mode (local/branch/pull-request)', def)).trim();
      if (a === 'local' || a === 'branch' || a === 'pull-request') mode = a; else io.info('  choose one of: local, branch, pull-request');
    }
    if (mode) {
      const r = await setDeliveryMode(project, mode);
      result.delivery = { mode: r.changed ? mode : state.deliveryMode, changed: r.changed, note: r.note };
      io.info(`  ${r.note}`);
    }
  } else if (tokenOk && state.pushDenied) {
    result.delivery.note = 'the profile denies git.push; delivery stays local';
  }
  result.state = await inspectGithub(project, opts.repoPath, { runner });
  result.nextSteps = githubHints(result.state);
  return result;
}

export function formatGithubSetup(r: GithubSetupResult): string {
  const L = [`GitHub remote: ${r.remote.status}${r.remote.url ? ` (${r.remote.url})` : ''}`];
  if (r.state.repository) L.push(`Base branch ${r.base.branch} on origin: ${r.base.pushed ? 'pushed' : r.base.onRemote === true ? 'yes' : r.base.onRemote === false ? 'not known' : 'n/a'}`);
  L.push(`GitHub token: ${r.token.status} — ${r.token.detail}`);
  for (const w of r.token.provisioned?.warnings ?? []) L.push(`  ! ${w}`);
  if (r.delivery.mode) L.push(`Delivery: ${r.delivery.mode}${r.delivery.note ? ` — ${r.delivery.note}` : ''}`);
  if (!r.interactive && r.state.repository && r.state.token === 'missing') L.push('', 'Token steps:', ...githubTokenSteps(r.state.remoteUrl).map((l) => `  ${l}`));
  if (r.nextSteps.length) L.push('', 'Next steps:', ...r.nextSteps.map((s) => `  - ${s}`));
  return L.join('\n');
}

/** `minions setup github`: the same guided flow, standalone. */
export function registerGithubSetup(program: Command): Command {
  const setup = program.command('setup').description('Guided setup steps for an initialized project');
  setup.command('github')
    .description('Guided GitHub setup: remote, base branch on the remote, fine-grained token, delivery mode')
    .option('-y, --yes', 'never prompt, push or open a browser; print the next steps only')
    .option('--dry-run', 'inspect and print the next steps without changing anything')
    .action(action(async (o: { yes?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const ref = await projectForPath(process.cwd());
      const interactive = !o.yes && !dryRun && !json && !!process.stdin.isTTY;
      const io = interactive ? readlineIO() : undefined;
      try {
        const r = await runGithubSetup({ projectId: ref.projectId, repoPath: ref.repoPath, io, yes: !interactive, skipIntro: true });
        emit(r, { json, human: formatGithubSetup });
      } finally { io?.close?.(); }
    }));
  return setup;
}
