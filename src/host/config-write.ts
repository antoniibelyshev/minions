// Safe edits of the project configuration file (shared .minions/config.json or the private
// <MINIONS_HOME>/projects/<id>/config.json, whichever the install uses):
// - the file is parsed first; a file that is missing or fails to parse is never overwritten
//   (INVALID_CONFIG / NOT_FOUND are thrown before anything is written);
// - with expectRevision, the edit is refused (CONFLICT, nothing written) when the file's configRevision is no
//   longer the expected one: a change planned (and confirmed) against an older config is never applied on top
//   of a newer one (`settings set --expect-revision`, the change requests of docs/design/host-manager.md);
// - configRevision is bumped and the result is validated like any config (with config.local.json);
// - the write is atomic; the manifest hash is updated only when the file was unchanged since
//   minions generated it (a hand-edited file stays "edited" for uninstall);
// - derived files (runtime config, compose) are refreshed.
import { readFile } from 'node:fs/promises';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, readJson, readJsonIfExists, sha256 } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import { loadManifest, refreshDerived, writeGenerated } from './install.js';
import { projectConfigPath, resolveEffective, type ProjectJson } from './project.js';

type Raw = Record<string, unknown>;

export interface ConfigEdit {
  path: string;
  /** Raw project-layer config before / after the edit (after = before when unchanged). */
  before: Raw;
  after: Raw;
  /** The effective config after the edit (validated). */
  effective: MinionsConfig;
  /** The file differs from what minions last generated (hand-edited). */
  edited: boolean;
  changed: boolean;
  written: boolean;
  revision: number;
  warnings: string[];
}

export interface ConfigEditOptions {
  /** Validate and report only; nothing is written. */
  dryRun?: boolean;
  /** Refuse (changed: false, no write) when the file was edited since minions generated it. */
  requireUnedited?: boolean;
  /** Refuse (CONFLICT, nothing written) unless the file is at this configRevision (compare-and-swap). */
  expectRevision?: number;
}

/** CONFLICT for a config that moved on since a change was planned against `expected`. */
export function revisionConflict(path: string, expected: number, actual: number): MinionsError {
  return new MinionsError('CONFLICT', `${path} is at configRevision ${actual}, not ${expected}: the configuration changed since this change was planned; nothing written.`,
    'Review the current settings (`minions settings --list`) and plan the change again.', { path, expectedRevision: expected, revision: actual });
}

/** Reads the project config file strictly: NOT_FOUND when absent, INVALID_CONFIG when it is not a JSON object. */
export async function readProjectConfigRaw(project: ProjectJson): Promise<{ path: string; raw: Raw }> {
  const path = projectConfigPath(project);
  const raw = await readJson<unknown>(path).catch((e: unknown) => {
    if (e instanceof MinionsError && e.code === 'NOT_FOUND') {
      throw new MinionsError('NOT_FOUND', `Project configuration missing: ${path}`, 'Run `minions init` again to regenerate it.');
    }
    throw e; // INVALID_CONFIG: not valid JSON
  });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MinionsError('INVALID_CONFIG', `${path}: must be a JSON object; not changed.`, 'Fix the file by hand, then rerun.');
  }
  return { path, raw: raw as Raw };
}

/**
 * Applies `mutate` (returns the new raw config, or null for "no change") to the project config file
 * with a configRevision bump. Throws before writing when the file does not parse or the result is invalid.
 */
export async function editProjectConfig(project: ProjectJson, mutate: (raw: Raw) => Raw | null, opts: ConfigEditOptions = {}): Promise<ConfigEdit> {
  const { path, raw } = await readProjectConfigRaw(project);
  const text = await readFile(path);
  const entry = (await loadManifest(project.projectId))?.files.find((f) => f.path === path);
  const edited = !entry || entry.sha256 !== sha256(text);
  const local = await readJsonIfExists(projectPaths(project.projectId).configLocalJson);
  const sources = { project: path, local: projectPaths(project.projectId).configLocalJson };
  const mutated = mutate(structuredClone(raw));
  const revision = Number(raw.configRevision ?? 1);
  if (opts.expectRevision !== undefined && revision !== opts.expectRevision) throw revisionConflict(path, opts.expectRevision, revision);
  if (mutated === null) {
    const effective = resolveEffective(project, raw, local, sources).config;
    return { path, before: raw, after: raw, effective, edited, changed: false, written: false, revision, warnings: [] };
  }
  const after = { ...mutated, configRevision: revision + 1 };
  const effective = resolveEffective(project, after, local, sources).config; // throws INVALID_CONFIG; nothing written
  const base = { path, before: raw, after, effective, edited, changed: true, revision: revision + 1, warnings: [] as string[] };
  if (opts.dryRun || (opts.requireUnedited && edited)) return { ...base, written: false };
  const data = Buffer.from(JSON.stringify(after, null, 2) + '\n');
  if (edited) await atomicWrite(path, data); // keep the manifest's "edited" view of a hand-edited file
  else await writeGenerated(project.projectId, path, data);
  base.warnings.push(...await refreshDerived(project, effective));
  return { ...base, written: true };
}
