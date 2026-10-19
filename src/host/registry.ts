import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { readJsonIfExists, writeJson } from '../core/fsutil.js';
import { registryPath, repoPaths } from '../core/paths.js';

export const RegistryEntrySchema = z.object({
  gitCommonDir: z.string().min(1),
  repoPath: z.string().min(1),
  visibility: z.enum(['shared', 'private']),
}).strict();
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistrySchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), RegistryEntrySchema),
}).strict();
export type Registry = z.infer<typeof RegistrySchema>;

export async function loadRegistry(): Promise<Registry> {
  return (await readJsonIfExists(registryPath(), RegistrySchema)) ?? { version: 1, projects: {} };
}

export async function saveRegistry(reg: Registry): Promise<void> {
  await writeJson(registryPath(), reg, { mode: 0o600 });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run('git', args, { cwd, allowFailure: true, timeoutMs: 15_000 });
  if (r.code !== 0) {
    throw new MinionsError('PRECONDITION', `${cwd} is not inside a Git repository (git ${args.join(' ')} failed).`,
      'Run minions in a Git working tree, or `git init` first.', { stderr: r.stderr.trim() });
  }
  return r.stdout.trim();
}

/** Canonical (realpath) Git common directory: identical for every worktree of one repository. */
export async function gitCommonDir(path: string): Promise<string> {
  const dir = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return realpath(dir);
}

/** Top level of the working tree containing `path` (realpath). */
export async function repoRoot(path: string): Promise<string> {
  return realpath(await git(path, ['rev-parse', '--show-toplevel']));
}

export function findByCommonDir(reg: Registry, commonDir: string): [string, RegistryEntry] | undefined {
  return Object.entries(reg.projects).find(([, e]) => e.gitCommonDir === commonDir);
}

/** projectId stored in a shared `<repo>/.minions/config.json`, if any (read as raw data). */
export async function sharedProjectId(repoPath: string): Promise<string | undefined> {
  const raw = await readJsonIfExists<{ projectId?: unknown }>(repoPaths(repoPath).configJson).catch(() => undefined);
  return raw && typeof raw.projectId === 'string' ? raw.projectId : undefined;
}

export interface IdentityInput { commonDir: string; sharedId?: string; attach?: boolean; newIdentity?: boolean }
export interface Identity {
  projectId: string;
  source: 'registry' | 'shared' | 'attached' | 'new';
  /** Registry entry previously bound to the id that this repo now takes over (attach). */
  rebound?: RegistryEntry;
  /** The shared config carries a different id that must be rewritten (new identity). */
  replacesSharedId?: string;
}

const copied = (id: string, other: string, here: string) => new MinionsError('CONFLICT',
  `copied project identity: .minions/config.json has projectId ${id}, which is registered for another repository (${other}), not ${here}.`,
  'If this repository is the same project (moved or re-cloned), run `minions init --attach`; if it is a separate project, run `minions init --new-identity`.',
  { projectId: id, registeredCommonDir: other, commonDir: here });

/**
 * Maps a repository (canonical git common dir) to its projectId. Never attaches silently to an id
 * that the registry binds to a different repository.
 */
export function resolveIdentity(reg: Registry, input: IdentityInput): Identity {
  const { commonDir, sharedId, attach, newIdentity } = input;
  if (attach && newIdentity) throw new MinionsError('INVALID_CONFIG', '--attach and --new-identity are mutually exclusive.');
  // Explicit request for a separate project: always a fresh id (the old binding of this repo is replaced).
  if (newIdentity) return { projectId: randomUUID(), source: 'new', replacesSharedId: sharedId };
  const byDir = findByCommonDir(reg, commonDir);
  if (sharedId) {
    const bound = reg.projects[sharedId];
    if (bound && bound.gitCommonDir !== commonDir) {
      if (!attach) throw copied(sharedId, bound.gitCommonDir, commonDir);
      return { projectId: sharedId, source: 'attached', rebound: bound };
    }
    if (byDir && byDir[0] !== sharedId) {
      if (!attach) {
        throw new MinionsError('CONFLICT',
          `copied project identity: this repository is registered as ${byDir[0]} but .minions/config.json declares ${sharedId}.`,
          'Run `minions init --attach` to adopt the shared id, or `minions init --new-identity` to start a separate project.',
          { registered: byDir[0], shared: sharedId });
      }
      return { projectId: sharedId, source: 'attached' };
    }
    return { projectId: sharedId, source: bound ? 'registry' : 'shared' };
  }
  if (byDir) return { projectId: byDir[0], source: 'registry' };
  return { projectId: randomUUID(), source: 'new' };
}

/** Returns a registry with `projectId` bound to the repo (removing other bindings of the same common dir). */
export function bindProject(reg: Registry, projectId: string, entry: RegistryEntry): Registry {
  const projects: Registry['projects'] = {};
  for (const [id, e] of Object.entries(reg.projects)) if (id !== projectId && e.gitCommonDir !== entry.gitCommonDir) projects[id] = e;
  projects[projectId] = entry;
  return { version: 1, projects };
}

export interface ProjectRef { projectId: string; entry: RegistryEntry; repoPath: string }

/** Finds the registered project for the Git repository containing `cwd`. */
export async function projectForPath(cwd: string): Promise<ProjectRef> {
  const commonDir = await gitCommonDir(cwd);
  const found = findByCommonDir(await loadRegistry(), commonDir);
  if (!found) {
    throw new MinionsError('NOT_FOUND', `No minions project is registered for ${commonDir}.`, 'Run `minions init` in this repository first.');
  }
  return { projectId: found[0], entry: found[1], repoPath: await repoRoot(cwd).catch(() => found[1].repoPath) };
}
