// `minions upgrade` for the host runtime (task-7): what runUpgrade (src/host/upgrade.ts) drives instead of the
// container. Decision record: docs/design/bootstrap.md, "Upgrade" (host runtime).
//
// - The CLI the shims run executes outside the Claude Code sandbox, so it must never be a file an agent can write:
//   the upgrade refuses when the installed CLI (or the CLI the shim would point at) resolves into the agent-writable
//   host runtime dirs (<project>/host/workspace and <project>/host/state), and also when the global install is a
//   link (`npm link`) into them. With --from-container the check runs before the export, so a refused upgrade
//   leaves the shim as it was; prepareHostRuntime itself also refuses any shim target inside those dirs.
//   A new CLI only ever arrives as a packed tarball (`npm pack` + `npm install -g`, src/host/upgrade-source.ts
//   applyCli, with the CLI backup first), built from the owner's checkout after the strict fast-forward of
//   `--from-container`; never from the agent workspace itself.
// - The shim step regenerates the minions shim (prepareHostRuntime) for the CLI that runs the step: after a
//   reinstall that is the newly installed CLI (the upgrade is handed off to it), so agents run the new CLI next.
import { dirname, join } from 'node:path';
import { hostRuntimePaths } from '../core/paths.js';
import type { ProjectJson } from './project.js';
import { agentWritableDirs, agentWritableHit, defaultShimTarget, prepareHostRuntime, type HostRuntime, type ShimTarget } from './runtime.js';
import { detectInstalled, type InstalledCli } from './upgrade-source.js';
import type { HostUpgradeTarget } from './upgrade.js';

export { agentWritableDirs };

/**
 * Why running these CLI paths outside the sandbox is unsafe: one of them (after resolving symlinks) is inside an
 * agent-writable dir, or the global install is a link into one. Null when every path is outside.
 */
export function unsafeCliReason(o: { cliPaths: string[]; installed?: Pick<InstalledCli, 'kind' | 'path' | 'realPath'> | null; agentWritable: string[] }): string | null {
  const cli = agentWritableHit(o.cliPaths, o.agentWritable);
  if (cli) return `the CLI the shims would run (${cli.path}) is inside the agent-writable ${cli.dir}; reinstall minions as a packed tarball outside it (npm pack in your checkout, then npm install -g <tarball>)`;
  const i = o.installed;
  if (i?.realPath) {
    const d = agentWritableHit([i.realPath], o.agentWritable)?.dir;
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
  prepare?: (project: ProjectJson, o: { target: ShimTarget }) => Promise<unknown>;
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
    shimPlan: `regenerate ${hp.minionsShim} for the installed CLI (${target.node} ${target.cli}); agents run it from their next command`,
    regenerate: async () => {
      await (o.prepare ?? ((p, x) => prepareHostRuntime(p, x)))(project, { target });
      return `${join(hp.bin, 'minions')} -> ${target.cli}`;
    },
  };
}
