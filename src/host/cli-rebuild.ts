// The dev-only rebuild-cli request of the host manager (docs/design/host-manager.md, Change kinds "Upgrade" and owner
// decision Q3; task-53.7).
//
// - It exists only when the host CLI runs from a minions source checkout (the running package root has
//   src/cli.ts) and the managed project is minions (its repository is a minions source checkout). Everywhere else it
//   is not registered, not advertised in the help text and refused when it arrives anyway.
// - It is owner-only (`/rebuild_cli` in the manager chat; never a container request) and local delivery only: with
//   GitHub delivery the CLI is built only from the reviewed origin/<base> (`/upgrade`).
// - The plan shows what would be built: `git log --oneline <from>..<to>`, where <from> is the commit the running CLI
//   was built from (dist/build.json, written by esbuild.config.mjs) and <to> the checkout's HEAD, the diffstat, and
//   the sensitive paths (the project's sensitivePaths) the range touches. The digest covers all of it, so a moved
//   HEAD refuses the confirmation. A dirty checkout is refused (the build would include changes the plan does not
//   show). The plan always loosens, so the chat asks twice.
// - Applying it runs `minions upgrade --rebuild-cli` as a child process (the existing path: the build, the backup
//   before a reinstall, then the container steps on the new CLI).
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isGithubDelivery } from '../config/delivery.js';
import { matchesAny } from '../config/capabilities.js';
import { displayText } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { HOST_GIT } from './discovery.js';
import { packageRoot, type Runner } from './docker.js';
import { loadEffectiveConfig, type ProjectJson } from './project.js';
import { isMinionsCheckout } from './upgrade-source.js';

/** What the rebuild-cli request needs from the host (faked in tests). */
export interface CliDevDeps {
  /** Package root of the running host CLI (default: packageRoot()). */
  runningRoot?: string;
  /** git runner (default: run). */
  runner?: Runner;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const SHA = /^[0-9a-f]{40}$/;
export const REBUILD_LOG_MAX = 50;
export const REBUILD_STAT_MAX = 40;

/** The running CLI's package root, or null when it cannot be found. */
function runningRootOf(deps: CliDevDeps): string | null {
  if (deps.runningRoot) return deps.runningRoot;
  try { return packageRoot(); } catch { return null; }
}

/** True only when the host CLI runs from a minions source checkout and the project's repository is minions. */
export function devRebuildAvailable(project: Pick<ProjectJson, 'repoPath'>, deps: CliDevDeps = {}): boolean {
  const root = runningRootOf(deps);
  return !!root && isMinionsCheckout(root) && isMinionsCheckout(project.repoPath);
}

export interface RebuildRange {
  /** The checkout the build uses (the project's repository). */
  checkout: string;
  /** The commit the running CLI was built from. */
  from: string;
  /** The checkout's HEAD: what the rebuild builds. */
  to: string;
  /** `git log --oneline <from>..<to>` (newest first, at most REBUILD_LOG_MAX lines). */
  commits: string[];
  /** How many commits the range has (may exceed commits.length). */
  count: number;
  /** `git diff --stat <from> <to>` (at most REBUILD_STAT_MAX lines; the summary line last). */
  diffstat: string[];
  /** Files in the range that match the project's sensitivePaths. */
  sensitive: string[];
  /** The running CLI was built from a tree with uncommitted changes. */
  builtDirty: boolean;
}

export const notAvailable = () => new MinionsError('PRECONDITION',
  'rebuild-cli is a dev-only request: it exists only when the host CLI runs from a minions source checkout and the project is minions. Nothing to apply.',
  'On a normal install use /upgrade.', { refusal: 'unavailable' });

/**
 * The range a rebuild would build, read from the host now. Refuses (PRECONDITION) when the request is not available
 * here, with GitHub delivery, on a dirty checkout, or when the build commit is unknown or not an ancestor of HEAD.
 */
export async function rebuildRange(project: ProjectJson, deps: CliDevDeps = {}): Promise<RebuildRange> {
  if (!devRebuildAvailable(project, deps)) throw notAvailable();
  if (isGithubDelivery((await loadEffectiveConfig(project)).config)) {
    throw new MinionsError('PRECONDITION', 'rebuild-cli is for local delivery: with GitHub delivery the CLI is built only from the reviewed origin/<base>. Nothing to apply.', 'Merge the pull requests on GitHub, then send /upgrade.');
  }
  const runner = deps.runner ?? run;
  const checkout = real(project.repoPath);
  const git = async (args: string[]) => runner('git', [...HOST_GIT, ...args], { cwd: checkout, allowFailure: true, timeoutMs: 120_000 });
  const fail = (what: string, r: { stderr: string; stdout: string; code: number }) =>
    new MinionsError('PRECONDITION', `rebuild-cli: git ${what} failed in ${checkout}: ${displayText((r.stderr || r.stdout).trim()).slice(0, 300) || `exit ${r.code}`}`);

  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const to = head.stdout.trim();
  if (head.code !== 0 || !SHA.test(to)) throw fail('rev-parse HEAD', head);
  const st = await git(['status', '--porcelain']);
  if (st.code !== 0) throw fail('status', st);
  const dirty = st.stdout.split('\n').filter(Boolean);
  if (dirty.length) {
    throw new MinionsError('PRECONDITION', `rebuild-cli: the checkout at ${checkout} has uncommitted or untracked changes (${dirty.length}: ${displayText(dirty.slice(0, 5).map((l) => l.trim()).join(', '))}${dirty.length > 5 ? ', ...' : ''}); the build would include changes the plan cannot show. Nothing to apply.`,
      'Commit or stash them yourself, then send /rebuild_cli again.');
  }
  const stamp = ((): { commit?: unknown; dirty?: unknown } | null => {
    try { return JSON.parse(readFileSync(join(runningRootOf(deps)!, 'dist', 'build.json'), 'utf8')) as { commit?: unknown; dirty?: unknown }; } catch { return null; }
  })();
  const from = typeof stamp?.commit === 'string' && SHA.test(stamp.commit) ? stamp.commit : null;
  if (!from) {
    throw new MinionsError('PRECONDITION', 'rebuild-cli: the running CLI records no build commit (dist/build.json from before task-53.7), so the commits to build cannot be shown. Nothing to apply.',
      'Rebuild it once in the terminal after reviewing the checkout: `minions upgrade --rebuild-cli`.');
  }
  const anc = await git(['merge-base', '--is-ancestor', from, to]);
  if (anc.code !== 0) {
    throw new MinionsError('PRECONDITION', `rebuild-cli: the CLI was built from ${from.slice(0, 12)}, which is not an ancestor of HEAD ${to.slice(0, 12)} in ${checkout}; the range cannot be shown. Nothing to apply.`,
      'Review the checkout and rebuild in the terminal: `minions upgrade --rebuild-cli`.');
  }
  const count = await git(['rev-list', '--count', `${from}..${to}`]);
  const log = await git(['log', '--oneline', '--no-decorate', '--no-color', '-n', String(REBUILD_LOG_MAX), `${from}..${to}`]);
  const stat = await git(['diff', '--stat=100', '--no-color', from, to]);
  const names = await git(['diff', '--name-only', '-z', from, to]);
  for (const [what, r] of [['rev-list', count], ['log', log], ['diff --stat', stat], ['diff --name-only', names]] as const) if (r.code !== 0) throw fail(what, r);
  const statLines = stat.stdout.split('\n').filter((l) => l.trim());
  const diffstat = statLines.length > REBUILD_STAT_MAX ? [...statLines.slice(0, REBUILD_STAT_MAX - 2), ` ... (${statLines.length - REBUILD_STAT_MAX + 1} more files)`, statLines.at(-1)!] : statLines;
  const files = names.stdout.split('\0').filter(Boolean);
  const globs = (await loadEffectiveConfig(project)).config.sensitivePaths ?? [];
  return {
    checkout, from, to,
    commits: log.stdout.split('\n').filter(Boolean).map((l) => displayText(l).slice(0, 200)),
    count: Number.parseInt(count.stdout.trim(), 10) || 0,
    diffstat: diffstat.map((l) => displayText(l).slice(0, 200)),
    sensitive: files.filter((f) => matchesAny(f, globs)).map((f) => displayText(f)),
    builtDirty: stamp?.dirty === true,
  };
}
