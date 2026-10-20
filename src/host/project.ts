// Host-control project record (project.json) and effective-config loading for a registered project.
import { z } from 'zod';
import { profileDefaults } from '../config/profiles.js';
import { resolve, type EffectiveConfig } from '../config/resolve.js';
import { PROFILES } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { readJson, readJsonIfExists } from '../core/fsutil.js';
import { projectPaths, repoPaths } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { ClaudeAuthSchema } from './auth.js';
import { RuntimeKindSchema } from './runtime-kind.js';

const port = z.number().int().min(1).max(65535);

export const ProjectJsonSchema = z.object({
  version: z.literal(1),
  projectId: z.uuid(),
  repoPath: z.string().min(1),
  gitCommonDir: z.string().min(1),
  visibility: z.enum(['shared', 'private']),
  profile: z.enum(PROFILES),
  imageTag: z.string().min(1),
  baseBranch: z.string().min(1),
  remoteUrl: z.string().nullable(),
  gitIdentity: z.object({ name: z.string().min(1), email: z.string().min(1) }).strict(),
  container: z.object({
    cpus: z.number().positive(),
    memoryMiB: z.number().int().min(512),
    pidsLimit: z.number().int().min(64),
    /** Size cap of the /tmp tmpfs (RAM, counted against memoryMiB); absent = DEFAULT_TMP_SIZE_MIB (src/host/docker.ts). */
    tmpSizeMiB: z.number().int().min(64).optional(),
    publishPorts: z.array(z.object({ host: port, container: port }).strict()),
    network: z.enum(['outbound-internet', 'none']),
  }).strict(),
  /**
   * Claude authorization (host-only; never in shared/repository config, which the strict
   * MinionsConfig schema rejects). Absent = interactive login inside the container.
   */
  claudeAuth: ClaudeAuthSchema.optional(),
  /**
   * Agent runtime (host-only, like claudeAuth): absent/"docker" = hardened container; "host" = agents run
   * directly on the Mac (less safe; `minions runtime set host`). Never read from repository config.
   */
  runtime: RuntimeKindSchema.optional(),
}).strict();
export type ProjectJson = z.infer<typeof ProjectJsonSchema>;

export const loadProjectJson = (projectId: string) => readJson(projectPaths(projectId).projectJson, ProjectJsonSchema);

/** Subset of project.json the container may read (mounted ro at /opt/minions/config/project.json). */
export const runtimeProjectInfo = (p: ProjectJson) => ({
  projectId: p.projectId, visibility: p.visibility, profile: p.profile, imageTag: p.imageTag,
  baseBranch: p.baseBranch, remoteUrl: p.remoteUrl, gitIdentity: p.gitIdentity,
});

/** Removes fields that are personal and must not be committed to shared configuration. */
export function sharedConfigView(cfg: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(cfg);
  const git = out.git as { identity?: unknown } | undefined;
  if (git) delete git.identity;
  return out;
}

/**
 * Resolves the effective configuration of a registered project:
 * profile defaults (host identity from project.json) < project config < config.local.json.
 */
export async function loadEffectiveConfig(project: ProjectJson): Promise<EffectiveConfig & { sources: Record<string, string> }> {
  const paths = projectPaths(project.projectId);
  const projectFile = projectConfigPath(project);
  const projectRaw = await readJsonIfExists<Record<string, unknown>>(projectFile);
  if (!projectRaw) throw new MinionsError('NOT_FOUND', `Project configuration missing: ${projectFile}`, 'Run `minions init` again to regenerate it.');
  const local = await readJsonIfExists(paths.configLocalJson);
  const sources = { project: projectFile, local: paths.configLocalJson };
  return { ...resolveEffective(project, projectRaw, local, sources), sources };
}

export const projectConfigPath = (p: Pick<ProjectJson, 'visibility' | 'repoPath' | 'projectId'>) =>
  p.visibility === 'shared' ? repoPaths(p.repoPath).configJson : projectPaths(p.projectId).configJson;

type Ctx = Pick<ProjectJson, 'projectId' | 'profile' | 'baseBranch' | 'gitIdentity'>;

/** Effective config from raw layers; defaults carry the host-side identity and base branch. */
export function resolveEffective(project: Ctx, projectRaw: Record<string, unknown>, local: unknown, sources?: Record<string, string>): EffectiveConfig {
  const profile = (PROFILES as readonly string[]).includes(String(projectRaw.profile)) ? projectRaw.profile as ProjectJson['profile'] : project.profile;
  const defaults = profileDefaults(profile, {
    hasGitHub: false, baseBranch: project.baseBranch, identity: project.gitIdentity,
    projectId: project.projectId, packageVersion: VERSION,
  }).config;
  return resolve({ defaults, project: projectRaw, local, sources });
}
