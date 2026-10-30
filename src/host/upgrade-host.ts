// `minions upgrade` for the host runtime (task-7): what runUpgrade (src/host/upgrade.ts) drives instead of the
// container. Decision record: docs/design/bootstrap.md, "Upgrade" (host runtime).
//
// - The CLI the shims run executes outside the Claude Code sandbox, so it must never be a file an agent can write:
//   the upgrade refuses when the installed CLI (or the CLI the shim would point at) resolves into the agent-writable
//   host runtime dirs (<project>/host/workspace and <project>/host/state), and also when the global install is a
//   link (`npm link`) into them. A new CLI only ever arrives as a packed tarball (`npm pack` + `npm install -g`,
//   src/host/upgrade-source.ts applyCli, with the CLI backup first), built from the owner's checkout after the strict
//   fast-forward of `--from-container`; never from the agent workspace itself.
// - The shim step regenerates the minions and gh shims (prepareHostRuntime) for the CLI that runs the step: after a
//   reinstall that is the newly installed CLI (the upgrade is handed off to it), so agents run the new CLI next.
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { hostRuntimePaths } from '../core/paths.js';
import type { ProjectJson } from './project.js';
import { defaultShimTarget, prepareHostRuntime, type HostRuntime, type ShimTarget } from './runtime.js';
import { detectInstalled, type InstalledCli } from './upgrade-source.js';
import type { HostUpgradeTarget } from './upgrade.js';

/** realpath of the deepest existing ancestor, with the rest appended (a missing file still resolves its links). */
function real(p: string): string {
  try { return realpathSync(p); } catch {
    const up = dirname(p);
    return up === p ? p : join(real(up), basename(p));
  }
}
const inside = (p: string, dir: string) => { const r = relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r)); };

/** The dirs of the host runtime agents may write (the sandbox allows the workspace and the state dir only). */
export function agentWritableDirs(projectId: string): string[] {
  const hp = hostRuntimePaths(projectId);
  return [hp.workspace, hp.state];
}

/**
 * Why running these CLI paths outside the sandbox is unsafe: one of them (after resolving symlinks) is inside an
 * agent-writable dir, or the global install is a link into one. Null when every path is outside.
 */
export function unsafeCliReason(o: { cliPaths: string[]; installed?: Pick<InstalledCli, 'kind' | 'path' | 'realPath'> | null; agentWritable: string[] }): string | null {
  const dirs = o.agentWritable.map((d) => ({ d, r: real(d) }));
  const hit = (p: string) => dirs.find(({ d, r }) => inside(p, d) || inside(real(p), r))?.d ?? null;
  for (const p of o.cliPaths) {
    const d = hit(p);
    if (d) return `the CLI the shims would run (${real(p)}) is inside the agent-writable ${d}; reinstall minions as a packed tarball outside it (npm pack in your checkout, then npm install -g <tarball>)`;
  }
  const i = o.installed;
  if (i?.realPath) {
    const d = hit(i.realPath);
    if (d) return `the global minions install ${i.path ?? ''} ${i.kind === 'link' ? 'is a link' : 'resolves'} into the agent-writable ${d}; replace it with a packed install (npm uninstall -g minions, then npm install -g <tarball from npm pack>)`;
  }
  return null;
}

export interface HostTargetOptions {
  /** The CLI the shims point at (default: the running CLI). */
  target?: ShimTarget;
  /** The global install (default: detectInstalled). */
  installed?: () => Promise<InstalledCli | null>;
  /** Regenerates the shims (default: prepareHostRuntime). */
  prepare?: (project: ProjectJson, o: { target: ShimTarget }) => Promise<{ gh: string | null }>;
}

export function hostUpgradeTarget(project: ProjectJson, host: HostRuntime, o: HostTargetOptions = {}): HostUpgradeTarget {
  const target = o.target ?? defaultShimTarget();
  const hp = hostRuntimePaths(project.projectId);
  const pkgRoot = dirname(dirname(target.cli));
  return {
    exec: (args, opts) => host.exec(args, opts),
    prepared: () => host.prepared(),
    cliProblem: async () => {
      const installed = await (o.installed ?? (() => detectInstalled({ runningRoot: pkgRoot })))().catch(() => null);
      return unsafeCliReason({ cliPaths: [target.cli, pkgRoot], installed, agentWritable: agentWritableDirs(project.projectId) });
    },
    shimPlan: `regenerate ${hp.minionsShim} (and the gh shim) for the installed CLI (${target.node} ${target.cli}); agents run it from their next command`,
    regenerate: async () => {
      const r = await (o.prepare ?? ((p, x) => prepareHostRuntime(p, x)))(project, { target });
      return `${join(hp.bin, 'minions')} -> ${target.cli}; ${r.gh ? 'gh shim refreshed' : 'no gh on the host (no gh shim)'}`;
    },
  };
}
