// `minions uninstall`: removes only manifest files unchanged since generation; keeps Docker volumes
// (repository clone, backlog, runtime DB, Claude login) unless --delete-data is confirmed.
import { readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { sha256 } from '../core/fsutil.js';
import { projectPaths, volumeNames } from '../core/paths.js';
import { clearSecrets, loadCredentialRefs } from './credentials.js';
import { Compose, type Runner } from './docker.js';
import { loadManifest } from './install.js';
import { loadRegistry, projectForPath, saveRegistry } from './registry.js';

export interface UninstallOptions {
  cwd: string;
  deleteData?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  runner?: Runner;
}
export interface UninstallResult {
  projectId: string;
  dryRun: boolean;
  removed: string[];
  kept: { path: string; reason: string }[];
  container: 'stopped' | 'stopped-and-volumes-deleted' | 'not-running-or-unavailable' | 'skipped';
  volumesKept: string[];
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

  if (opts.deleteData && !opts.yes && !opts.dryRun) {
    const ok = opts.confirm ? await opts.confirm(`Delete ALL data volumes (${vols.join(', ')}): repository clone, backlog, runtime DB, Claude login? (y/n)`) : false;
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
  const gh = (await loadCredentialRefs(projectId).catch(() => undefined))?.github;
  if (gh) kept.push({ path: gh.ref, reason: 'GitHub token kept; run `minions auth github --remove` before uninstalling to delete it' });

  let container: UninstallResult['container'] = 'skipped';
  if (!opts.dryRun) {
    // Stop the container before its compose file goes away.
    const compose = new Compose(projectId, opts.runner);
    try {
      await compose.down({ volumes: !!opts.deleteData });
      container = opts.deleteData ? 'stopped-and-volumes-deleted' : 'stopped';
    } catch (e) {
      if (opts.deleteData) throw new MinionsError('DOCKER_UNAVAILABLE', `Could not delete data volumes: ${(e as Error).message}`, 'Start Docker and rerun `minions uninstall --delete-data`.');
      container = 'not-running-or-unavailable';
    }
    for (const p of toRemove) { await rm(p, { force: true }); removed.push(p); await pruneEmptyDirs(dirname(p), p.startsWith(paths.dir) ? paths.dir : entry.repoPath); }
    await rm(paths.manifestJson, { force: true });
    await rm(paths.journalJson, { force: true });
    // The container is gone: drop the materialized token copy and the (then empty) mount dir.
    await clearSecrets(projectId);
    await rmdir(paths.secretsDir).catch(() => {});
    await pruneEmptyDirs(paths.dir, dirname(paths.dir));
    const reg = await loadRegistry();
    if (reg.projects[projectId]) { delete reg.projects[projectId]; await saveRegistry(reg); }
  } else {
    removed.push(...toRemove);
  }
  return { projectId, dryRun: !!opts.dryRun, removed, kept, container, volumesKept: opts.deleteData ? [] : vols };
}

export function formatUninstall(r: UninstallResult): string {
  const L = [`${r.dryRun ? 'Would remove' : 'Removed'} ${r.removed.length} generated file(s) for project ${r.projectId}.`];
  for (const k of r.kept) L.push(`  kept ${k.path} (${k.reason})`);
  L.push(`Container: ${r.container}.`);
  if (r.volumesKept.length) L.push(`Data volumes kept: ${r.volumesKept.join(', ')}.`, `  To delete them later: docker volume rm ${r.volumesKept.join(' ')}`);
  return L.join('\n');
}
