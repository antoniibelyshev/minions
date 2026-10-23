// init: inspect → propose (plan) → apply (journal, atomic writes, manifest, rollback) → verify.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { can } from '../config/capabilities.js';
import { DEFERRED_FEATURES, listUnavailable, validateConfig, type Unavailable } from '../config/resolve.js';
import { CAPABILITIES, type Effect, type MinionsConfig, type Profile } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, ensureDir, exists, readJsonIfExists, sha256, writeJson } from '../core/fsutil.js';
import { GITHUB_TOKEN_CONTAINER_PATH, TELEGRAM_TOKEN_CONTAINER_PATH, imageTag, projectPaths, registryPath, repoPaths, volumeNames } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { generatePlugin } from '../plugin/generate.js';
import { ciSetupPlan } from '../runtime/ci.js';
import { discover, dockerProbe, type Discovery, type DockerProbe, type DockerStatus } from './discovery.js';
import { authOf, isKeyAuth, loadDefaults, resolveOnPath, summarize, type AuthSummary, type ClaudeAuth } from './auth.js';
import {
  backendLabel, githubRepoFromRemote, githubTokenGuidance, loadCredentialRefs, provisionTelegramToken,
  type CredentialsJson, type Fetch, type ProvisionResult, type TelegramProvisionResult,
} from './credentials.js';
import { composeYaml, type Runner } from './docker.js';
import { composeHint, daemonHint } from './linux-host.js';
import { ProjectJsonSchema, projectConfigPath, resolveEffective, runtimeProjectInfo, sharedConfigView, type ProjectJson } from './project.js';
import { bindProject, gitCommonDir, loadRegistry, repoRoot, resolveIdentity, saveRegistry, sharedProjectId, type Identity, type Registry } from './registry.js';
import { runWizard, type WizardIO } from './wizard.js';
import { runGithubSetup, type GithubSetupResult } from './github-setup.js';
import { HOST_CONFIRM_WORD, HOST_RUNTIME_SHORT, HOST_RUNTIME_WARNING, RUNTIMES, type RuntimeKind } from './runtime.js';
import { hostRuntimePaths } from '../core/paths.js';

// ---------------------------------------------------------------- manifest + journal

export const ManifestSchema = z.object({
  version: z.literal(1),
  packageVersion: z.string(),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), owner: z.literal('minions') }).strict()),
}).strict();
export type Manifest = z.infer<typeof ManifestSchema>;

const JournalSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  startedAt: z.string(),
  steps: z.array(z.object({
    kind: z.enum(['create', 'update', 'remove', 'registry']),
    path: z.string(),
    sha256: z.string().optional(),
    backup: z.string().optional(), // base64 of previous content (update/remove/registry)
  }).strict()),
}).strict();
type Journal = z.infer<typeof JournalSchema>;

export const loadManifest = async (projectId: string): Promise<Manifest | undefined> =>
  readJsonIfExists(projectPaths(projectId).manifestJson, ManifestSchema);

async function fileHash(path: string): Promise<string | undefined> {
  try { return sha256(await readFile(path)); } catch { return undefined; }
}

/** Undo journal steps in reverse; only touches files whose content is still what we wrote. */
async function rollback(journal: Journal): Promise<string[]> {
  const undone: string[] = [];
  for (const step of [...journal.steps].reverse()) {
    try {
      if (step.kind === 'create') {
        if ((await fileHash(step.path)) === step.sha256) { await rm(step.path, { force: true }); undone.push(step.path); }
      } else if (step.backup !== undefined) {
        const cur = await fileHash(step.path);
        if (step.kind === 'registry' || cur === step.sha256 || cur === undefined) {
          await atomicWrite(step.path, Buffer.from(step.backup, 'base64'));
          undone.push(step.path);
        }
      } else if (step.kind === 'registry') {
        await rm(step.path, { force: true });
      }
    } catch { /* best effort; journal stays for inspection only if we can't remove it */ }
  }
  return undone;
}

/** Rolls back an interrupted install recorded in journal.json. Returns restored paths. */
export async function recoverJournal(projectId: string): Promise<string[] | undefined> {
  const path = projectPaths(projectId).journalJson;
  const j = await readJsonIfExists(path, JournalSchema).catch(() => undefined);
  if (!j) return undefined;
  const undone = await rollback(j);
  await rm(path, { force: true });
  return undone;
}

// ---------------------------------------------------------------- plan

export type WriteAction = 'create' | 'update' | 'unchanged' | 'adopt' | 'drift' | 'conflict' | 'remove' | 'keep';
export interface PlannedWrite {
  path: string;
  action: WriteAction;
  inRepo: boolean;
  sha256?: string;
  note?: string;
}

export interface InstallPlan {
  projectId: string;
  identitySource: Identity['source'];
  repoPath: string;
  gitCommonDir: string;
  visibility: 'shared' | 'private';
  profile: Profile;
  writes: PlannedWrite[];
  permissions: Record<Effect, string[]>;
  verificationCommands: string[];
  communication: MinionsConfig['communication'];
  unavailable: { settings: Unavailable[]; features: string[] };
  externalSetup: string[];
  notes: string[];
  warnings: string[];
  container: ProjectJson['container'] & { image: string; volumes: string[] };
  gitIdentity: { name: string; email: string };
  claudeAuth: AuthSummary;
  /** Agent runtime (host-only setting): docker (default) or host (less safe). */
  runtime: RuntimeKind;
  discovery: Discovery;
}

interface Desired { path: string; content: Buffer; inRepo: boolean; note?: string }

export interface InitOptions {
  path: string;
  profile?: Profile;
  visibility?: 'shared' | 'private';
  yes?: boolean;
  configFile?: string;
  dryRun?: boolean;
  attach?: boolean;
  newIdentity?: boolean;
  io?: WizardIO;
  /**
   * `minions setup`: the wizard skips the delivery/channel questions and init does not offer the
   * GitHub/Telegram token prompts; setup asks for them itself after the plan is applied.
   */
  skipIntegrations?: boolean;
  /**
   * Rerun with an existing configuration: run the wizard again with the existing values as defaults
   * (visibility stays as installed) instead of reusing the configuration unchanged.
   */
  reconfigure?: boolean;
  dockerProbe?: DockerProbe;
  runner?: Runner;
  /** Wizard: whether `central` is on PATH (default: PATH lookup, never executed). */
  centralOnPath?: boolean;
  /** GitHub API client for token verification (tests). */
  fetch?: Fetch;
  /** --runtime docker|host (host-only setting; repository config can never select it). */
  runtime?: RuntimeKind;
  /** Opens the token page after an explicit yes (tests; default `open` on macOS). */
  openUrl?: (url: string) => Promise<void>;
}

interface Prepared { plan: InstallPlan; desired: Desired[]; manifest: Manifest | undefined; registry: Registry; cleanup: () => Promise<void> }

/**
 * Wizard step 0: agent runtime. Docker is the default; choosing host shows the warning and needs the
 * typed confirmation word, otherwise Docker is kept.
 */
async function askRuntime(io: WizardIO, def: RuntimeKind, docker: DockerStatus | undefined, notes: string[]): Promise<RuntimeKind> {
  const dockerOk = !docker || (docker.daemon && docker.compose);
  io.info(`Agent runtime: docker (hardened container, recommended${dockerOk ? '' : '; Docker is not reachable right now'}) or host (no Docker; less safe).`);
  let pick: RuntimeKind = def;
  for (let i = 0; ; i++) {
    const a = (await io.ask('Agent runtime (docker/host)', def)).trim();
    if ((RUNTIMES as readonly string[]).includes(a)) { pick = a as RuntimeKind; break; }
    if (i >= 2) throw new MinionsError('INVALID_CONFIG', 'Agent runtime: choose docker or host.');
    io.info('  choose one of: docker, host');
  }
  if (pick !== 'host') return pick;
  return confirmHostRuntime(io, notes);
}

/** Shows the warning and asks for the typed confirmation word; anything else keeps Docker. */
async function confirmHostRuntime(io: WizardIO, notes: string[]): Promise<RuntimeKind> {
  for (const l of HOST_RUNTIME_WARNING) io.info(l);
  const typed = (await io.ask(`Type "${HOST_CONFIRM_WORD}" to run agents without Docker (anything else keeps Docker)`, '')).trim();
  if (typed === HOST_CONFIRM_WORD) return 'host';
  notes.push('Host runtime not confirmed; using the Docker runtime.');
  return 'docker';
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + '\n');

function sharedReadme(): string {
  return `# .minions

This directory holds the shared [minions](https://github.com/) configuration for this repository.

- \`config.json\` — project configuration (profile, policy, limits). Commit it to share the setup.
- Runtime state, backlog, credentials, and Claude login live in per-project Docker volumes on
  each developer's machine, never in this directory.

Run \`minions init\` after cloning to attach to this configuration, then \`minions start\`.
Personal values (git identity) are kept on the host, not here.
`;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

function permissionSummary(cfg: MinionsConfig): Record<Effect, string[]> {
  const out: Record<Effect, string[]> = { allow: [], ask: [], deny: [] };
  for (const cap of CAPABILITIES) {
    const r = cfg.capabilities[cap];
    const base = can(cfg, cap);
    const extra = typeof r !== 'string' && r.rules?.length
      ? ` (${r.rules.map((x) => `${x.effect} for ${[...(x.roles ?? []), ...(x.paths ?? [])].join(',')}`).join('; ')})` : '';
    out[base].push(cap + extra);
  }
  return out;
}

const isInside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return !!r && r !== '..' && !r.startsWith('..' + sep) && !r.startsWith(sep);
};

async function prepare(opts: InitOptions, docker?: DockerStatus): Promise<Prepared> {
  if (!(await exists(opts.path))) throw new MinionsError('NOT_FOUND', `Path not found: ${opts.path}`);
  const repoPath = await repoRoot(opts.path);
  const commonDir = await gitCommonDir(repoPath);
  const discovery = await discover(repoPath, opts.runner);
  const registry = await loadRegistry();
  const notes: string[] = [];
  const warnings: string[] = [];

  const registered = Object.entries(registry.projects).find(([, e]) => e.gitCommonDir === commonDir);
  const sharedPath = repoPaths(repoPath).configJson;
  const sharedExists = await exists(sharedPath);
  const visibility = opts.visibility ?? registered?.[1].visibility ?? (sharedExists ? 'shared' : undefined);
  const sharedId = visibility !== 'private' ? await sharedProjectId(repoPath) : undefined;
  if (sharedExists && visibility !== 'private' && !sharedId) {
    throw new MinionsError('INVALID_CONFIG', `${sharedPath} has no valid projectId.`, 'Fix or remove the file, then rerun init.');
  }
  const identity = resolveIdentity(registry, { commonDir, sharedId, attach: opts.attach, newIdentity: opts.newIdentity });
  const projectId = identity.projectId;
  const paths = projectPaths(projectId);

  const recovered = opts.dryRun ? undefined : await recoverJournal(projectId);
  if (recovered) notes.push(`Rolled back an interrupted install (${recovered.length} file(s) restored/removed).`);
  if (identity.source === 'attached') notes.push(`Attaching this repository to existing project ${projectId}.`);
  if (identity.replacesSharedId) notes.push(`New project identity ${projectId} replaces ${identity.replacesSharedId} in .minions/config.json.`);

  const prevProject = await readJsonIfExists(paths.projectJson, ProjectJsonSchema).catch(() => undefined);
  if (prevProject && visibility && prevProject.visibility !== visibility) {
    throw new MinionsError('PRECONDITION', `Project is installed as ${prevProject.visibility}; switching to ${visibility} is not supported in v0.1.`,
      'Run `minions uninstall` first, then init with the new visibility.');
  }

  // Existing project configuration is reused (rerun = regenerate derived files); --config replaces it.
  let existingRaw: Record<string, unknown> | undefined;
  let existingFile: string | undefined;
  if (visibility === 'shared' && sharedExists) { existingRaw = await readJsonIfExists(sharedPath); existingFile = sharedPath; }
  else if (visibility !== 'shared' && await exists(paths.configJson)) { existingRaw = await readJsonIfExists(paths.configJson); existingFile = paths.configJson; }

  // Claude authorization and the runtime are host-only: previous project.json, else
  // <MINIONS_HOME>/defaults.json, else login / docker.
  const defaults = await loadDefaults();
  const interactive = !!opts.io && !opts.yes && !opts.configFile;
  // The host runtime is never inherited silently: a non-interactive init uses it only for an existing
  // host project or an explicit `--runtime host --yes`; a host-wide default of host applies interactively
  // (the wizard asks, with the typed confirmation).
  const inheritedHost = !opts.runtime && !prevProject?.runtime && defaults.runtime === 'host';
  let runtime: RuntimeKind = opts.runtime ?? prevProject?.runtime ?? (inheritedHost && !interactive ? 'docker' : defaults.runtime) ?? 'docker';
  if (inheritedHost && !interactive) notes.push('defaults.json selects the host runtime, but a non-interactive init never inherits it; using Docker. Pass `--runtime host --yes` to choose it explicitly.');
  if (!opts.runtime && interactive) runtime = await askRuntime(opts.io!, runtime, docker, notes);
  else if (opts.runtime === 'host' && prevProject?.runtime !== 'host') {
    if (interactive) runtime = await confirmHostRuntime(opts.io!, notes);
    else if (!opts.yes && !opts.dryRun) {
      throw new MinionsError('PRECONDITION', '--runtime host needs confirmation: agents would run as your macOS user without Docker.',
        'Rerun interactively and type the confirmation word, or pass `--runtime host --yes`.');
    }
  }
  if (runtime === 'docker' && docker && !opts.dryRun && (!docker.daemon || !docker.compose)) throw dockerUnavailable(docker);
  if (runtime === 'host') warnings.push(`${HOST_RUNTIME_SHORT}`);
  let claudeAuth: ClaudeAuth | undefined = prevProject?.claudeAuth ?? defaults.claudeAuth;
  let config!: MinionsConfig;
  const reconfigure = !!opts.reconfigure && !!existingRaw && !opts.configFile && !opts.yes;
  if (existingRaw && !opts.configFile) {
    const profile = (existingRaw.profile as Profile | undefined) ?? 'project-owner';
    const ctx = {
      projectId, profile,
      baseBranch: prevProject?.baseBranch ?? discovery.git.baseBranch,
      gitIdentity: prevProject?.gitIdentity ?? { name: discovery.git.userName ?? '', email: discovery.git.userEmail ?? '' },
    };
    if (!ctx.gitIdentity.name || !ctx.gitIdentity.email) {
      throw new MinionsError('PRECONDITION', 'Git identity (user.name / user.email) is not configured for this repository.',
        'Run `git config user.name "…"` and `git config user.email "…"`, then rerun init.');
    }
    config = resolveEffective(ctx, { ...existingRaw, projectId }, undefined, { project: existingFile! }).config;
    if (opts.profile && opts.profile !== config.profile && !reconfigure) {
      warnings.push(`--profile ${opts.profile} ignored: existing configuration uses ${config.profile}; edit ${existingFile} to change it.`);
    }
    notes.push(`Reusing existing configuration ${existingFile}.`);
  }
  if (!existingRaw || opts.configFile || reconfigure) {
    // Branch/PR delivery is selectable only when a GitHub token is already stored for this project.
    const githubCredential = discovery.git.hasGitHub &&
      !!(await loadCredentialRefs(projectId).catch((): CredentialsJson => ({ version: 1 }))).github;
    const r = await runWizard({
      discovery, projectId, profile: opts.profile, visibility: reconfigure ? visibility ?? config.visibility : visibility, configFile: opts.configFile,
      yes: !!opts.yes, io: opts.io, githubCredential, runtime, skipIntegrations: opts.skipIntegrations,
      auth: { default: claudeAuth, centralOnPath: opts.centralOnPath ?? !!(await resolveOnPath('central')) },
      ...(reconfigure ? { existing: config } : {}),
    });
    if (reconfigure) notes.splice(notes.indexOf(`Reusing existing configuration ${existingFile}.`), 1, `Reconfigured ${existingFile} (previous values were the defaults).`);
    config = r.config;
    claudeAuth = r.claudeAuth ?? claudeAuth;
    notes.push(...r.notes);
  }
  config = validateConfig({ ...config, projectId }, 'install');
  const vis = config.visibility;

  const project: ProjectJson = {
    version: 1, projectId,
    repoPath: prevProject && await exists(prevProject.repoPath) && identity.source !== 'attached' ? prevProject.repoPath : repoPath,
    gitCommonDir: commonDir, visibility: vis, profile: config.profile, imageTag: imageTag(VERSION),
    baseBranch: config.git.baseBranch, remoteUrl: discovery.git.remoteUrl, gitIdentity: config.git.identity,
    container: {
      cpus: config.container.cpus, memoryMiB: config.container.memoryMiB, pidsLimit: config.container.pidsLimit,
      ...(config.container.tmpSizeMiB !== undefined ? { tmpSizeMiB: config.container.tmpSizeMiB } : {}),
      publishPorts: config.container.publishPorts, network: config.container.network,
    },
    ...(claudeAuth ? { claudeAuth } : {}),
    ...(runtime === 'host' || prevProject?.runtime || opts.runtime ? { runtime } : {}),
  };

  // Project config layer as written to disk, and the effective config for the runtime.
  const projectLayer = vis === 'shared' ? sharedConfigView(config as unknown as Record<string, unknown>) : config as unknown as Record<string, unknown>;
  const local = await readJsonIfExists(paths.configLocalJson);
  const effective = resolveEffective(project, projectLayer, local, { project: 'project configuration', local: paths.configLocalJson }).config;

  const desired: Desired[] = [];
  const add = (path: string, content: Buffer | string, note?: string) =>
    desired.push({ path, content: Buffer.isBuffer(content) ? content : Buffer.from(content), inRepo: isInside(path, repoPath), note });
  add(paths.projectJson, json(project));
  if (vis === 'private') add(paths.configJson, json(config));
  add(paths.composeYaml, composeYaml(project));
  add(join(paths.runtimeDir, 'config.json'), json(effective));
  add(join(paths.runtimeDir, 'project.json'), json(runtimeProjectInfo(project)));

  const staging = await mkdtemp(join(tmpdir(), 'minions-plugin-'));
  const cleanup = () => rm(staging, { recursive: true, force: true });
  try {
    await generatePlugin(effective, staging, { configDir: roleConfigDir(project) });
    for (const f of await walkFiles(staging)) add(join(paths.pluginDir, relative(staging, f)), await readFile(f));
  } catch (e) { await cleanup(); throw e; }

  let sharedConfigDesired = false;
  if (vis === 'shared') {
    const rp = repoPaths(repoPath);
    if (!sharedExists || identity.replacesSharedId || opts.configFile || reconfigure) { add(rp.configJson, json(projectLayer)); sharedConfigDesired = true; }
    add(rp.readme, sharedReadme());
  }

  const manifest = await loadManifest(projectId);
  const inManifest = new Map((manifest?.files ?? []).map((f) => [f.path, f.sha256]));
  const writes: PlannedWrite[] = [];
  for (const d of desired) {
    const want = sha256(d.content);
    const cur = await fileHash(d.path);
    const recorded = inManifest.get(d.path);
    let action: WriteAction;
    let note = d.note;
    if (cur === undefined) action = 'create';
    else if (cur === want) action = recorded === want ? 'unchanged' : 'adopt';
    else if (recorded === undefined) {
      const explicit = d.path === repoPaths(repoPath).configJson && sharedConfigDesired && (identity.replacesSharedId || opts.configFile || reconfigure);
      action = explicit ? 'update' : 'conflict';
      note = explicit ? 'explicitly requested (--new-identity/--config/reconfigure)' : 'exists and is not owned by minions; not overwritten';
    } else if (recorded === cur) action = 'update';
    else { action = 'drift'; note = 'edited since generation; left unchanged — reconcile manually (or delete it and rerun init)'; }
    writes.push({ path: d.path, action, inRepo: d.inRepo, sha256: want, ...(note ? { note } : {}) });
  }
  if (vis === 'shared' && sharedExists && !sharedConfigDesired) {
    writes.push({ path: sharedPath, action: 'keep', inRepo: true, note: 'existing shared configuration is the source of truth' });
  }
  const wanted = new Set(desired.map((d) => d.path));
  for (const [p, h] of inManifest) {
    if (wanted.has(p) || p === sharedPath) continue;
    const cur = await fileHash(p);
    if (cur === undefined) continue;
    writes.push(cur === h ? { path: p, action: 'remove', inRepo: isInside(p, repoPath) }
      : { path: p, action: 'drift', inRepo: isInside(p, repoPath), note: 'no longer generated but edited; left in place' });
  }

  if (vis === 'private' && writes.some((w) => w.inRepo && w.action !== 'unchanged' && w.action !== 'keep')) {
    throw new MinionsError('INTERNAL', 'Private install planned a write inside the repository; refusing.', 'Check MINIONS_HOME is outside the repository.');
  }
  if (vis === 'private' && isInside(paths.dir, repoPath)) {
    throw new MinionsError('PRECONDITION', `MINIONS_HOME (${paths.dir}) is inside the repository; private installs must not write into the repo.`);
  }

  if (discovery.git.dirty) notes.push('Working tree has uncommitted changes: they are left untouched and are not imported into the container.');
  if (discovery.dockerfile) notes.push('A repository Dockerfile exists; it is not built. The minions runtime image is used.');
  if (vis === 'shared') notes.push('Shared install never modifies CLAUDE.md, AGENTS.md, or .claude/.');

  const unavailable = { settings: listUnavailable(config), features: [...DEFERRED_FEATURES] };
  const ghRepo = githubRepoFromRemote(discovery.git.remoteUrl);
  const plan: InstallPlan = {
    projectId, identitySource: identity.source, repoPath, gitCommonDir: commonDir, visibility: vis, profile: config.profile,
    writes, permissions: permissionSummary(effective), verificationCommands: effective.verification.commands,
    communication: effective.communication,
    unavailable,
    externalSetup: [
      ...(runtime === 'host' ? [
        'Host runtime (no Docker): tmux, claude (Claude Code) and backlog (backlog.md) on PATH; `minions doctor` checks them.',
        `Agents work in a separate clone at ${hostRuntimePaths(projectId).repo}, seeded from committed history on first start; your checkout is never used.`,
        isKeyAuth(authOf(project))
          ? `Claude key from ${summarize(authOf(project)).source} is provisioned by the host on every \`minions start\` (0600 file read by apiKeyHelper).`
          : 'Claude Code uses your existing host login (run `claude` once and /login if you are not logged in).',
        'The coordinator gets the Claude Code sandbox (Bash writes limited to the workspace/state, credential directories unreadable) and never bypassPermissions.',
      ] : [
        process.platform === 'linux' ? 'Docker Engine running and reachable by your user (compose v2+ plugin).' : 'Docker Desktop running (compose v2+).',
        `Runtime image ${project.imageTag} is built from the installed package on first \`minions start\`.`,
        isKeyAuth(authOf(project))
          ? `Claude key from ${summarize(authOf(project)).source} is provisioned by the host on every \`minions start\` (mounted read-only; no /login needed).`
          : 'Claude login inside the container on first start: run /login in the coordinator session (host login is not reused).',
        'Repository is imported into the container from a Git bundle of committed history on first start.',
      ]),
      ...(discovery.git.hasGitHub ? [
        `Optional GitHub token (mounted read-only at ${GITHUB_TOKEN_CONTAINER_PATH}; needed for branch/pull-request delivery):`,
        ...githubTokenGuidance(discovery.git.remoteUrl).map((l) => `  ${l}`),
      ] : []),
      // Printed only: the installer never writes workflow files or changes branch protection.
      ...(discovery.git.hasGitHub ? ciSetupPlan({
        hasWorkflows: discovery.ciWorkflows.some((f) => f.startsWith('.github/workflows/')),
        requiredChecks: effective.delivery.requiredChecksConfigured ? 'configured' : 'unknown',
        verificationCommands: effective.verification.commands, baseBranch: effective.git.baseBranch,
        repository: ghRepo ? `${ghRepo.owner}/${ghRepo.repo}` : null,
      }) : []),
      ...(effective.communication.channel === 'telegram' ? [
        `Telegram bot token from BotFather, stored on the host (Keychain or 0600 file) and mounted read-only at ${TELEGRAM_TOKEN_CONTAINER_PATH}; only the coordinator process receives it.`,
        'The runtime image includes a pinned Bun (the Telegram plugin runs on it); an existing image is rebuilt on the next `minions start`.',
        'On `minions start` the container installs telegram@claude-plugins-official at user scope (needs network; no login).',
        'Pairing happens in the coordinator terminal (/telegram:access pair <code>, then /telegram:access policy allowlist); pair only yourself.',
        'Telegram changes are restart-required: `minions start` restarts the coordinator in a controlled way.',
      ] : effective.communication.channel === 'auto' && runtime !== 'host' && effective.container.network !== 'none' ? [
        'Optional Telegram (communication.channel auto): create a bot with BotFather, store its token with `minions auth telegram`, then `minions down && minions start`; pair in the coordinator terminal (/telegram:access pair <code>, then /telegram:access policy allowlist). Without a token the coordinator uses the terminal.',
      ] : []),
    ],
    notes, warnings,
    container: { ...project.container, image: project.imageTag, volumes: Object.values(volumeNames(projectId)) },
    gitIdentity: config.git.identity,
    claudeAuth: summarize(authOf(project), paths.secretsDir),
    runtime,
    discovery,
  };
  return { plan, desired, manifest, registry, cleanup };
}

// ---------------------------------------------------------------- apply

export interface ApplyResult { written: string[]; removed: string[]; unchanged: number; skipped: PlannedWrite[] }

async function apply(prep: Prepared): Promise<ApplyResult> {
  const { plan, desired } = prep;
  const conflicts = plan.writes.filter((w) => w.action === 'conflict');
  if (conflicts.length) {
    throw new MinionsError('CONFLICT', `Refusing to overwrite files not owned by minions:\n${conflicts.map((c) => `  - ${c.path}`).join('\n')}`,
      'Move or delete these files (minions never overwrites user files), then rerun init.', { paths: conflicts.map((c) => c.path) });
  }
  const paths = projectPaths(plan.projectId);
  const content = new Map(desired.map((d) => [d.path, d.content]));
  const journal: Journal = { version: 1, projectId: plan.projectId, startedAt: new Date().toISOString(), steps: [] };
  const saveJournal = () => writeJson(paths.journalJson, journal);
  const result: ApplyResult = { written: [], removed: [], unchanged: 0, skipped: [] };
  const oldManifest = new Map((prep.manifest?.files ?? []).map((f) => [f.path, f.sha256]));
  const newManifest = new Map<string, string>();

  try {
    await saveJournal();
    for (const w of plan.writes) {
      if (w.action === 'create' || w.action === 'update') {
        const data = content.get(w.path)!;
        const backup = w.action === 'update' ? (await readFile(w.path)).toString('base64') : undefined;
        journal.steps.push({ kind: w.action, path: w.path, sha256: w.sha256, ...(backup !== undefined ? { backup } : {}) });
        await saveJournal();
        await atomicWrite(w.path, data);
        result.written.push(w.path);
        newManifest.set(w.path, w.sha256!);
      } else if (w.action === 'remove') {
        const prev = await readFile(w.path);
        journal.steps.push({ kind: 'remove', path: w.path, sha256: sha256(prev), backup: prev.toString('base64') });
        await saveJournal();
        await rm(w.path, { force: true });
        result.removed.push(w.path);
      } else if (w.action === 'unchanged' || w.action === 'adopt') {
        result.unchanged++;
        newManifest.set(w.path, w.sha256!);
      } else if (w.action === 'drift') {
        result.skipped.push(w);
        const h = oldManifest.get(w.path);
        if (h) newManifest.set(w.path, h); // keep the generated hash so drift stays visible
      } else if (w.action === 'keep') {
        const h = oldManifest.get(w.path);
        if (h) newManifest.set(w.path, h);
      }
    }
    const reg = bindProject(prep.registry, plan.projectId, { gitCommonDir: plan.gitCommonDir, repoPath: plan.repoPath, visibility: plan.visibility });
    if (JSON.stringify(reg) !== JSON.stringify(prep.registry)) {
      const regPath = registryPath();
      const prev = await readFile(regPath).catch(() => undefined);
      journal.steps.push({ kind: 'registry', path: regPath, ...(prev ? { backup: prev.toString('base64') } : {}) });
      await saveJournal();
      await saveRegistry(reg);
    }
    const manifest: Manifest = {
      version: 1, packageVersion: VERSION,
      files: [...newManifest].sort(([a], [b]) => a.localeCompare(b)).map(([path, h]) => ({ path, sha256: h, owner: 'minions' as const })),
    };
    const prevText = JSON.stringify(prep.manifest ?? null);
    if (JSON.stringify(manifest) !== prevText) await writeJson(paths.manifestJson, manifest);
    await rm(paths.journalJson, { force: true });
    return result;
  } catch (e) {
    await rollback(journal);
    await rm(paths.journalJson, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------- derived files at start

/** Directory role prompt files (`roles.<r>.prompt`) are relative to: next to the project config, read on the host (D1). */
const roleConfigDir = (project: Pick<ProjectJson, 'visibility' | 'repoPath' | 'projectId'>) => dirname(projectConfigPath(project));

/** Renders the plugin from the installed package's templates: [absolute path under pluginDir, content]. */
async function renderPlugin(pluginDir: string, effective: MinionsConfig, project: ProjectJson): Promise<[string, Buffer][]> {
  const staging = await mkdtemp(join(tmpdir(), 'minions-plugin-'));
  try {
    await generatePlugin(effective, staging, { configDir: roleConfigDir(project) });
    const out: [string, Buffer][] = [];
    for (const f of await walkFiles(staging)) out.push([join(pluginDir, relative(staging, f)), await readFile(f)]);
    return out;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/**
 * Regenerates compose.yaml, runtime/{config,project}.json and the plugin (agents, coordinator prompt,
 * hooks, skills, rendered from the installed package's templates) from project.json + config. Used by
 * `minions start`, the `files` step of `minions upgrade` and the config/auth/runtime setters, so the
 * plugin directory the container mounts follows the installed package (task-46: before, only
 * `minions init` wrote the plugin, and an upgrade left it stale). Files are replaced one by one
 * (atomic rename inside the directory), never the directory itself, so the bind mount sees them.
 * Files edited by the user (hash ≠ manifest) are not replaced; a warning is returned. Plugin files
 * the package no longer generates are removed when unchanged since generation.
 */
export async function refreshDerived(project: ProjectJson, effective: MinionsConfig): Promise<string[]> {
  const paths = projectPaths(project.projectId);
  const manifest = (await loadManifest(project.projectId)) ?? { version: 1 as const, packageVersion: VERSION, files: [] };
  const warnings: string[] = [];
  const plugin = await renderPlugin(paths.pluginDir, effective, project);
  const files: [string, Buffer][] = [
    [paths.composeYaml, Buffer.from(composeYaml(project))],
    [join(paths.runtimeDir, 'config.json'), json(effective)],
    [join(paths.runtimeDir, 'project.json'), json(runtimeProjectInfo(project))],
    ...plugin,
  ];
  let changed = false;
  for (const [path, data] of files) {
    const want = sha256(data);
    const cur = await fileHash(path);
    const entry = manifest.files.find((f) => f.path === path);
    if (cur === want) continue;
    if (cur !== undefined && entry?.sha256 !== cur) { warnings.push(`${path} was edited since generation; using it as is.`); continue; }
    await atomicWrite(path, data);
    if (entry) entry.sha256 = want; else manifest.files.push({ path, sha256: want, owner: 'minions' });
    changed = true;
  }
  // Plugin files the installed package no longer generates.
  const wanted = new Set(plugin.map(([p]) => p));
  for (const entry of [...manifest.files]) {
    if (!isInside(entry.path, paths.pluginDir) || wanted.has(entry.path)) continue;
    const cur = await fileHash(entry.path);
    if (cur !== undefined && cur !== entry.sha256) { warnings.push(`${entry.path} is no longer generated but was edited; left in place.`); continue; }
    if (cur !== undefined) await rm(entry.path, { force: true });
    manifest.files.splice(manifest.files.indexOf(entry), 1);
    changed = true;
  }
  if (changed) await writeJson(paths.manifestJson, manifest);
  return warnings;
}

/** How the plugin on disk (the directory the container mounts) compares with the installed package. */
export interface PluginCheck {
  dir: string;
  /** Number of files the installed package generates. */
  files: number;
  /** Generated files whose content on disk differs (stale, or edited by the user). Relative to dir. */
  differs: string[];
  /** Generated files missing on disk. */
  missing: string[];
  /** Files on disk the installed package does not generate. */
  extra: string[];
  matches: boolean;
}

/** Renders the plugin from the installed package and compares it with <project dir>/plugin (read-only). */
export async function checkPlugin(project: ProjectJson, effective: MinionsConfig): Promise<PluginCheck> {
  const dir = projectPaths(project.projectId).pluginDir;
  const plugin = await renderPlugin(dir, effective, project);
  const differs: string[] = [], missing: string[] = [];
  for (const [path, data] of plugin) {
    const cur = await fileHash(path);
    if (cur === undefined) missing.push(relative(dir, path));
    else if (cur !== sha256(data)) differs.push(relative(dir, path));
  }
  const wanted = new Set(plugin.map(([p]) => p));
  const extra = (await exists(dir) ? await walkFiles(dir) : []).filter((p) => !wanted.has(p)).map((p) => relative(dir, p));
  return { dir, files: plugin.length, differs, missing, extra, matches: !differs.length && !missing.length && !extra.length };
}

/** One line on how the plugin differs from what the installed package generates; null when it matches. */
export function pluginMismatch(c: PluginCheck): string | null {
  if (c.matches) return null;
  const list = (xs: string[]) => xs.slice(0, 5).join(', ') + (xs.length > 5 ? ', ...' : '');
  return [
    ...(c.differs.length ? [`${c.differs.length} file(s) differ from the installed package (${list(c.differs)})`] : []),
    ...(c.missing.length ? [`${c.missing.length} file(s) missing (${list(c.missing)})`] : []),
    ...(c.extra.length ? [`${c.extra.length} file(s) not generated by it (${list(c.extra)})`] : []),
  ].join('; ');
}

/** Writes a manifest-tracked generated file (e.g. project.json after `minions auth set`) and records its hash. */
export async function writeGenerated(projectId: string, path: string, data: Buffer): Promise<void> {
  const paths = projectPaths(projectId);
  const manifest = await loadManifest(projectId);
  await atomicWrite(path, data);
  if (!manifest) return;
  const entry = manifest.files.find((f) => f.path === path);
  const h = sha256(data);
  if (entry) entry.sha256 = h; else manifest.files.push({ path, sha256: h, owner: 'minions' });
  await writeJson(paths.manifestJson, manifest);
}

export const projectJsonBytes = (p: ProjectJson) => json(p);

// ---------------------------------------------------------------- init

export interface InitResult {
  dryRun: boolean;
  plan: Omit<InstallPlan, 'discovery'> & { discovery: Pick<Discovery, 'git' | 'instructions' | 'ciWorkflows' | 'dockerfile' | 'host'> };
  applied?: ApplyResult;
  docker: DockerStatus;
  nextSteps: string[];
  /** GitHub token step of an interactive init (repo has a GitHub remote). Never contains the token. */
  github?: { status: 'present' | 'stored' | 'skipped' | 'failed'; detail: string; provisioned?: Omit<ProvisionResult, 'projectId'> };
  /** Guided GitHub setup (interactive) or its next-step hints (--yes). Never contains the token. */
  githubSetup?: GithubSetupResult;
  /** Telegram bot token step (communication.channel is telegram). Never contains the token. */
  telegram?: { status: 'present' | 'stored' | 'skipped' | 'failed'; detail: string; provisioned?: Omit<TelegramProvisionResult, 'projectId'> };
}

const TERMINAL_UNTIL_TOKEN = 'the coordinator runs terminal-only until a bot token is stored with `minions auth telegram`';

/**
 * communication.channel telegram only: offers to store the bot token through the host terminal's
 * non-echoing prompt, with an optional, consented getMe check. Failures never fail init; Telegram
 * then stays off at launch with the stated reason (terminal fallback).
 */
async function offerTelegramToken(opts: InitOptions, plan: InitResult['plan']): Promise<InitResult['telegram']> {
  if (plan.communication.channel !== 'telegram') return undefined;
  const existing = (await loadCredentialRefs(plan.projectId).catch((): CredentialsJson => ({ version: 1 }))).telegram;
  if (existing) return { status: 'present', detail: `Telegram bot token already provisioned (bot ${existing.botId}, ${existing.backend}); replace it with \`minions auth telegram\`.` };
  const io = opts.io;
  if (!io || opts.yes || opts.configFile) return { status: 'skipped', detail: `non-interactive init; ${TERMINAL_UNTIL_TOKEN}.` };
  if (!io.secret) return { status: 'skipped', detail: `no terminal for a non-echoing prompt; ${TERMINAL_UNTIL_TOKEN}.` };
  const want = await io.ask('Store the Telegram bot token for this project now? (y/n)', 'y');
  if (!/^y(es)?$/i.test(want)) return { status: 'skipped', detail: `skipped; ${TERMINAL_UNTIL_TOKEN}.` };
  try {
    const token = await io.secret('Telegram bot token (input hidden): ');
    const verify = /^y(es)?$/i.test(await io.ask('Check the token with Telegram now (Bot API getMe; sends it to api.telegram.org)? (y/n)', 'n'));
    const { projectId: _id, ...provisioned } = await provisionTelegramToken({
      projectId: plan.projectId, token, repoPath: plan.repoPath, verify, runner: opts.runner, fetch: opts.fetch,
    });
    return { status: 'stored', detail: `bot ${provisioned.botId} stored in ${backendLabel(provisioned.backend)}`, provisioned };
  } catch (e) {
    return { status: 'failed', detail: `${e instanceof MinionsError ? e.message : 'could not store the token'}; ${TERMINAL_UNTIL_TOKEN}.` };
  }
}

/**
 * GitHub step of init (after the plan is applied, so failures never fail init). Interactive: the
 * guided flow (remote, base branch on the remote, token, delivery mode; src/host/github-setup.ts).
 * --yes / --config / no terminal: next-step hints only (no prompt, push, browser or network).
 */
async function githubStep(opts: InitOptions, plan: InitResult['plan']): Promise<GithubSetupResult> {
  const interactive = !!opts.io && !opts.yes && !opts.configFile;
  return runGithubSetup({
    projectId: plan.projectId, repoPath: plan.repoPath, io: interactive ? opts.io : undefined, yes: !interactive,
    runner: opts.runner, fetch: opts.fetch, openUrl: opts.openUrl,
  });
}

export function dockerUnavailable(s: DockerStatus, platform: NodeJS.Platform = process.platform): MinionsError {
  const what = !s.daemon ? `Docker daemon is not reachable${s.error ? ` (${s.error})` : ''}` : `Docker Compose v2+ is required (found: ${s.composeVersion ?? 'none'})`;
  const fix = platform === 'linux'
    ? `${!s.daemon ? daemonHint(platform, s) : composeHint(platform, s)} Then rerun; \`minions doctor\` names the exact fix.`
    : 'Start Docker Desktop (or install Compose v2), then rerun.';
  return new MinionsError('DOCKER_UNAVAILABLE', `${what}. The docker runtime needs Docker; minions never falls back to the host on its own.`,
    `${fix} Running without Docker is an explicit, less safe choice: \`minions runtime set host\` (see README "Running without Docker").`, s);
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const probe = opts.dockerProbe ?? dockerProbe(opts.runner);
  // The Docker runtime needs Docker: prepare() fails before writing anything (no silent host fallback;
  // the host runtime is only ever an explicit, host-side choice).
  const docker = await probe();
  const prep = await prepare(opts, docker);
  const hostRuntime = prep.plan.runtime === 'host';
  try {
    const { discovery, ...rest } = prep.plan;
    const plan = { ...rest, discovery: { git: discovery.git, instructions: discovery.instructions, ciWorkflows: discovery.ciWorkflows, dockerfile: discovery.dockerfile, host: discovery.host } };
    if (opts.dryRun) {
      if (!hostRuntime && (!docker.daemon || !docker.compose)) plan.warnings.push(dockerUnavailable(docker).message);
      return { dryRun: true, plan, docker, nextSteps: ['Rerun without --dry-run to apply this plan.'] };
    }
    if (!opts.yes && !opts.configFile && opts.io && plan.writes.some((w) => ['create', 'update', 'remove'].includes(w.action))) {
      opts.io.info(formatPlan(plan));
      const ok = await opts.io.ask('Apply this plan? (y/n)', 'y');
      if (!/^y(es)?$/i.test(ok)) throw new MinionsError('PRECONDITION', 'Installation cancelled; nothing was written.');
    }
    const applied = await apply(prep);
    // Verify: Docker still reachable after applying (never claim readiness otherwise).
    const after = hostRuntime ? docker : await probe();
    if (!hostRuntime && (!after.daemon || !after.compose)) throw dockerUnavailable(after);
    // The secrets directory must exist: compose bind-mounts it with create_host_path: false.
    await ensureDir(projectPaths(plan.projectId).secretsDir, 0o700);
    // `minions setup` runs the GitHub and Telegram steps itself after the plan is applied.
    const setup = opts.skipIntegrations ? undefined : await githubStep(opts, plan);
    const github = setup?.interactive && setup.state.repository ? setup.token : undefined;
    const telegram = opts.skipIntegrations ? undefined : await offerTelegramToken(opts, plan);
    const tgReady = telegram?.status === 'stored' || telegram?.status === 'present';
    return {
      dryRun: false, plan, applied, docker: after, ...(github ? { github } : {}), ...(setup ? { githubSetup: setup } : {}), ...(telegram ? { telegram } : {}),
      nextSteps: [
        'Run `minions start` in this repository.',
        ...(hostRuntime ? [
          'Host runtime: agents run as your macOS user without Docker (see the warning above); switch back any time with `minions runtime set docker`.',
          prep.plan.claudeAuth.method === 'login'
            ? 'The first start clones committed history into the host runtime workspace and opens the coordinator with your existing Claude Code login.'
            : 'The first start provisions the Claude key, clones committed history into the host runtime workspace, and opens the coordinator.',
        ] : [prep.plan.claudeAuth.method === 'login'
          ? 'The first start builds the runtime image, imports committed history, and opens the coordinator; log in to Claude inside the container with /login.'
          : 'The first start builds the runtime image, provisions the Claude key, imports committed history, and opens the coordinator.']),
        ...(setup?.nextSteps ?? []),
        ...(plan.communication.channel === 'telegram' ? [
          ...(tgReady ? [] : ['Run `minions auth telegram` to store the Telegram bot token (entered without echo); until then the coordinator is terminal-only.']),
          'After the first start, pair in the coordinator terminal: DM your bot, type /telegram:access pair <code>, then /telegram:access policy allowlist.',
        ] : plan.communication.channel === 'auto' && !hostRuntime ? [
          'Optional Telegram (channel auto): `minions auth telegram` stores a bot token; the coordinator then uses Telegram after `minions down && minions start`.',
        ] : []),
        'Run `minions doctor` to check readiness at any time.',
      ],
    };
  } finally {
    await prep.cleanup();
  }
}

export function formatPlan(plan: InitResult['plan']): string {
  const L: string[] = [];
  L.push(`Project ${plan.projectId} (${plan.visibility}, profile ${plan.profile}) — ${plan.repoPath}`);
  L.push('', 'Planned writes:');
  for (const w of plan.writes) L.push(`  ${w.action.padEnd(9)} ${w.path}${w.note ? `  — ${w.note}` : ''}`);
  L.push('', 'Effective permissions:');
  for (const e of ['allow', 'ask', 'deny'] as const) L.push(`  ${e.padEnd(5)}: ${plan.permissions[e].join(', ') || '—'}`);
  L.push('', `Git identity for agent commits: ${plan.gitIdentity.name} <${plan.gitIdentity.email}>`);
  L.push(`Agent runtime: ${plan.runtime === 'host' ? 'host (no Docker; LESS SAFE, see warning)' : 'docker (hardened container)'}`);
  if (plan.runtime === 'host') L.push(...HOST_RUNTIME_WARNING.map((l) => `  ${l}`));
  if (plan.runtime === 'docker') L.push(`Container: ${plan.container.image}, ${plan.container.cpus} CPUs, ${plan.container.memoryMiB} MiB, ${plan.container.pidsLimit} pids, ports: ${plan.container.publishPorts.map((p) => `127.0.0.1:${p.host}->${p.container}`).join(', ') || 'none'}`);
  L.push(`Verification commands (run by the agents in the ${plan.runtime === 'host' ? 'host runtime workspace' : 'container'}): ${plan.verificationCommands.join('; ') || 'none inferred'}`);
  L.push(`Claude authorization: ${plan.claudeAuth.method}${plan.claudeAuth.preset ? ` (${plan.claudeAuth.preset})` : ''}: ${plan.claudeAuth.source}`);
  L.push(`Communication: ${plan.communication.channel}${plan.communication.channel === 'telegram' ? ' (terminal stays available; restart-required changes)'
    : plan.communication.channel === 'auto' ? (plan.runtime === 'host' ? ' (terminal: the host runtime has no Telegram)' : ' (Telegram when a bot token is stored with `minions auth telegram`, otherwise terminal)') : ''}`);
  L.push('', 'Unavailable in v0.1:');
  for (const u of plan.unavailable.settings) L.push(`  - ${u.path}: ${u.reason}`);
  L.push(`  - ${plan.unavailable.features.join(', ')}`);
  L.push('', 'External setup required:');
  for (const s of plan.externalSetup) L.push(`  - ${s}`);
  if (plan.notes.length) { L.push('', 'Notes:'); for (const n of plan.notes) L.push(`  - ${n}`); }
  if (plan.warnings.length) { L.push('', 'Warnings:'); for (const n of plan.warnings) L.push(`  ! ${n}`); }
  return L.join('\n');
}

export function formatInit(r: InitResult): string {
  const L = [formatPlan(r.plan)];
  if (r.applied) {
    L.push('', `Applied: ${r.applied.written.length} written, ${r.applied.removed.length} removed, ${r.applied.unchanged} unchanged.`);
    for (const s of r.applied.skipped) L.push(`  ! drift: ${s.path} — ${s.note}`);
  }
  if (r.github) {
    L.push(`GitHub token: ${r.github.status} — ${r.github.detail}`);
    for (const w of r.github.provisioned?.warnings ?? []) L.push(`  ! ${w}`);
  }
  if (r.githubSetup?.interactive && r.githubSetup.remote.status === 'added') L.push(`GitHub remote added: ${r.githubSetup.remote.url}`);
  if (r.githubSetup?.delivery.changed) L.push(`Delivery: ${r.githubSetup.delivery.note}`);
  if (r.telegram) {
    L.push(`Telegram bot token: ${r.telegram.status} — ${r.telegram.detail}`);
    for (const w of r.telegram.provisioned?.warnings ?? []) L.push(`  ! ${w}`);
  }
  L.push('', 'Next steps:', ...r.nextSteps.map((s) => `  ${s}`));
  return L.join('\n');
}

