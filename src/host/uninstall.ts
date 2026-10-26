// `minions uninstall`: removes only manifest files unchanged since generation; keeps Docker volumes
// (repository clone, backlog, runtime DB, Claude login) unless --delete-data is confirmed.
import { readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { sha256 } from '../core/fsutil.js';
import { projectPaths, volumeNames } from '../core/paths.js';
import { clearSecrets, loadCredentialRefs } from './credentials.js';
import { removeApprovalKeys } from './approvals.js';
import { Compose, type Runner } from './docker.js';
import { loadManifest } from './install.js';
import { loadRegistry, projectForPath, saveRegistry } from './registry.js';
import { readJsonIfExists } from '../core/fsutil.js';
import { ProjectJsonSchema } from './project.js';
import { HostRuntime, runtimeOf } from './runtime.js';
import { managerPaths } from '../core/paths.js';
import { loadManagerCredentialRef } from './credentials.js';
import { loadServiceRecord, removeManagerService, serviceHost, type ServiceHost } from './manager-service.js';

export interface UninstallOptions {
  cwd: string;
  deleteData?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  runner?: Runner;
  /** The host manager service host (tests); its runner defaults to `runner`. */
  managerService?: Partial<ServiceHost>;
}
export interface UninstallResult {
  projectId: string;
  dryRun: boolean;
  removed: string[];
  kept: { path: string; reason: string }[];
  container: 'stopped' | 'stopped-and-volumes-deleted' | 'not-running-or-unavailable' | 'skipped';
  volumesKept: string[];
  runtime: 'docker' | 'host';
  /** Host runtime workspace/state (<project>/host): kept unless --delete-data. */
  hostData: { path: string; deleted: boolean } | null;
  /**
   * The host manager service (host-wide): removed with the last registered project (`removed`), kept while other
   * projects are registered (`kept`), none installed (`absent`), or the removal failed (`failed`, listed in kept).
   */
  managerService: 'removed' | 'kept' | 'absent' | 'failed';
}

async function pruneEmptyDirs(start: string, stop: string): Promise<void> {
  let dir = start;
  while (dir.startsWith(stop) && dir !== stop) {
    try { if ((await readdir(dir)).length) return; await rmdir(dir); } catch { return; }
    dir = dirname(dir);
  }
}

export async function runUninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const { projectId, entry } = await projectForPath(opts.cwd);
  const paths = projectPaths(projectId);
  const manifest = await loadManifest(projectId);
  const removed: string[] = [];
  const kept: UninstallResult['kept'] = [];
  const vols = Object.values(volumeNames(projectId));
  const project = await readJsonIfExists(paths.projectJson, ProjectJsonSchema).catch(() => undefined);
  const runtime = project ? runtimeOf(project) : 'docker';
  const hostDir = paths.hostDir;
  const hasHostData = await stat(hostDir).then(() => true, () => false);

  if (opts.deleteData && !opts.yes && !opts.dryRun) {
    const what = runtime === 'host'
      ? `Delete ALL host runtime data (${hostDir}: workspace clone with agent branches, backlog, runtime DB) and any Docker volumes of this project? (y/n)`
      : `Delete ALL data volumes (${vols.join(', ')}): repository clone, backlog, runtime DB, Claude login? (y/n)`;
    const ok = opts.confirm ? await opts.confirm(what) : false;
    if (!ok) throw new MinionsError('PRECONDITION', 'Data deletion not confirmed; nothing was changed.', 'Pass --yes to confirm non-interactively.');
  }

  const files = manifest?.files ?? [];
  const toRemove: string[] = [];
  for (const f of files) {
    let cur: string | undefined;
    try { cur = sha256(await readFile(f.path)); } catch { continue; }
    if (cur === f.sha256) toRemove.push(f.path);
    else kept.push({ path: f.path, reason: 'modified since generation' });
  }

  // Credentials are preserved by default (spec: uninstall keeps credentials).
  const refs = await loadCredentialRefs(projectId).catch(() => undefined);
  if (refs?.github) kept.push({ path: refs.github.ref, reason: 'GitHub token kept; run `minions auth github --remove` before uninstalling to delete it' });
  if (refs?.telegram) kept.push({ path: refs.telegram.ref, reason: 'Telegram bot token kept; run `minions auth telegram --remove` before uninstalling to delete it (or revoke it in BotFather)' });

  let container: UninstallResult['container'] = 'skipped';
  let managerService: UninstallResult['managerService'] = 'absent';
  let hostDeleted = false;
  if (!opts.dryRun) {
    if (project && runtime === 'host') await new HostRuntime(project, opts.runner).down().catch(() => false);
    // Stop the container before its compose file goes away.
    const compose = new Compose(projectId, opts.runner);
    try {
      await compose.down({ volumes: !!opts.deleteData });
      container = opts.deleteData ? 'stopped-and-volumes-deleted' : 'stopped';
    } catch (e) {
      // A host-runtime project may never have had a container (or Docker): that is not an error.
      if (opts.deleteData && runtime !== 'host') throw new MinionsError('DOCKER_UNAVAILABLE', `Could not delete data volumes: ${(e as Error).message}`, 'Start Docker and rerun `minions uninstall --delete-data`.');
      container = 'not-running-or-unavailable';
    }
    if (opts.deleteData && hasHostData) { await rm(hostDir, { recursive: true, force: true }); hostDeleted = true; }
    else if (hasHostData) await rm(join(hostDir, 'bin'), { recursive: true, force: true }); // shims are generated; data stays
    for (const p of toRemove) { await rm(p, { force: true }); removed.push(p); await pruneEmptyDirs(dirname(p), p.startsWith(paths.dir) ? paths.dir : entry.repoPath); }
    await rm(paths.manifestJson, { force: true });
    await rm(paths.journalJson, { force: true });
    // The container is gone: drop the materialized GitHub/Telegram token copies, the host-provisioned
    // Claude key copy (its original source is untouched), the mount dir, and the non-secret refresh state.
    await clearSecrets(projectId);
    await removeApprovalKeys(projectId); // host-held approval signing key and its public half
    await rm(paths.secretsDir, { recursive: true, force: true });
    await rm(paths.authStateJson, { force: true });
    await rm(paths.logsDir, { recursive: true, force: true });
    await rm(paths.assistantPluginDir, { recursive: true, force: true }); // regenerated by `minions setup assist`
    await pruneEmptyDirs(paths.dir, dirname(paths.dir));
    const reg = await loadRegistry();
    if (reg.projects[projectId]) { delete reg.projects[projectId]; await saveRegistry(reg); }
    managerService = await uninstallManagerService(opts, Object.keys(reg.projects).length, removed, kept);
  } else {
    removed.push(...toRemove);
    const rec = await loadServiceRecord(serviceHost(opts.managerService)).catch(() => null);
    if (rec) {
      const others = Object.keys((await loadRegistry()).projects).filter((id) => id !== projectId).length;
      if (others) { kept.push({ path: rec.path, reason: `host manager service kept: ${others} other project(s) are registered` }); managerService = 'kept'; }
      else { removed.push(rec.path); managerService = 'removed'; }
    }
  }
  if (hasHostData && !opts.deleteData) kept.push({ path: hostDir, reason: 'host runtime workspace and state kept; `minions uninstall --delete-data` deletes them' });
  return {
    projectId, dryRun: !!opts.dryRun, removed, kept, container,
    volumesKept: opts.deleteData || (runtime === 'host' && container !== 'stopped') ? [] : vols,
    runtime, hostData: hasHostData ? { path: hostDir, deleted: hostDeleted } : null, managerService,
  };
}

/**
 * The host manager serves every project: its service and files (unit file, record, heartbeat, log) go with the last
 * registered project. The manager bot token, pairing and journal stay like every credential (`minions setup`, manager
 * step "remove", deletes the token, which also removes the service).
 */
async function uninstallManagerService(opts: UninstallOptions, remaining: number, removed: string[], kept: UninstallResult['kept']): Promise<UninstallResult['managerService']> {
  const mp = managerPaths();
  const rec = await loadServiceRecord(serviceHost(opts.managerService)).catch(() => null);
  if (remaining) {
    if (rec) kept.push({ path: rec.path, reason: `host manager service kept: ${remaining} other project(s) are registered` });
    return rec ? 'kept' : 'absent';
  }
  let out: UninstallResult['managerService'];
  try {
    const r = await removeManagerService(serviceHost({ ...(opts.runner ? { runner: opts.runner } : {}), ...opts.managerService }));
    if (r.action === 'removed' && r.path) removed.push(r.path);
    out = r.action === 'removed' ? 'removed' : 'absent';
  } catch (e) {
    kept.push({ path: rec?.path ?? mp.serviceJson, reason: `host manager service could not be removed: ${(e as Error).message}` });
    out = 'failed';
  }
  if (await loadManagerCredentialRef().catch(() => null)) {
    kept.push({ path: mp.credentialJson, reason: 'host manager bot token kept; run `minions setup` (manager step: remove) to delete it' });
  }
  return out;
}

export function formatUninstall(r: UninstallResult): string {
  const L = [`${r.dryRun ? 'Would remove' : 'Removed'} ${r.removed.length} generated file(s) for project ${r.projectId}.`];
  for (const k of r.kept) L.push(`  kept ${k.path} (${k.reason})`);
  L.push(`Container: ${r.container}.`);
  if (r.hostData) L.push(r.hostData.deleted ? `Deleted host runtime data ${r.hostData.path}.` : `Host runtime data kept: ${r.hostData.path}.`);
  if (r.managerService === 'removed') L.push(`${r.dryRun ? 'Would remove' : 'Removed'} the host manager service (it served the last registered project).`);
  if (r.volumesKept.length) L.push(`Data volumes kept: ${r.volumesKept.join(', ')}.`, `  To delete them later: docker volume rm ${r.volumesKept.join(' ')}`);
  return L.join('\n');
}
