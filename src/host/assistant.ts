// AI setup assistant: after the deterministic `minions init` (and standalone as `minions setup assist`)
// the user's own host `claude` CLI is launched interactively in the repository root with a small,
// generated host plugin (<project>/assistant-plugin, skill `minions-setup:setup`) and appended
// instructions (templates/assistant). It closes the remaining gaps through documented commands only.
//
// Safety: permission mode `default` (every non-allowlisted tool prompts; never bypass/acceptEdits/auto,
// and bypass is disabled through --settings). Only read-only commands and reads inside the repository
// root (`Read(//<repo>/**)`; Claude Code applies Read rules to Glob/Grep too) are pre-allowed. Credential,
// runtime-switch and publishing commands are denied: the user runs them (`! minions auth ...`) so
// secrets are typed only at minions' hidden prompts, never into the chat. Host-side minions files
// (project.json, defaults.json, secrets, credentials) are denied for Edit; the secret stores (this and every
// other project's secrets/credentials, the credential store, the host secret dirs) for Read.
// Never launched with --yes, --json, --config, --dry-run or without a terminal.
import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import type { MinionsConfig } from '../config/schema.js';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, sha256 } from '../core/fsutil.js';
import { emit } from '../core/output.js';
import { credentialStoreDir, defaultsPath, hostRoot, projectPaths, registryPath } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { HOST_SECRET_DIRS } from '../runtime/coordinator.js';
import { renderTemplate, templatesDir } from '../plugin/generate.js';
import { resolveOnPath } from './auth.js';
import { loadEffectiveConfig, loadProjectJson, projectConfigPath, type ProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { runtimeOf } from './runtime.js';
import type { WizardIO } from './wizard.js';

export const ASSISTANT_PLUGIN = 'minions-setup';
export const ASSISTANT_SKILL = `${ASSISTANT_PLUGIN}:setup`;
/** Claude Code permission mode of the assistant session. Never bypassPermissions, acceptEdits or auto. */
export const ASSISTANT_PERMISSION_MODE = 'default';
export const ASSISTANT_PROMPT = `Use the ${ASSISTANT_SKILL} skill to help me finish setting up minions in this repository. Start by gathering context (read-only), then show me the gaps you found.`;

/** Read-only commands the assistant may run without a prompt. */
export const ASSISTANT_ALLOWED_COMMANDS = [
  'Bash(minions doctor*)', 'Bash(minions status*)', 'Bash(minions auth show*)', 'Bash(minions config show*)', 'Bash(minions runtime show*)',
  'Bash(git remote -v)', 'Bash(git status*)', 'Bash(git log*)',
] as const;

/**
 * Everything the assistant may use without a prompt: the read-only commands plus file reads scoped to
 * the repository root. Never a bare `Read`/`Glob`/`Grep` (that would read any file on the host); reads
 * elsewhere prompt. Everything else asks.
 */
export function assistantAllowedTools(repoRoot: string): string[] {
  return [...ASSISTANT_ALLOWED_COMMANDS, `Read(${abs(repoRoot.replace(/\/+$/, ''))}/**)`];
}

/** Claude Code permission path for an absolute host path (`//abs/path`). */
const abs = (p: string) => `/${p.startsWith('/') ? p : `/${p}`}`;

/** Commands the assistant must never run itself (the user runs them with `! ...`). */
export const ASSISTANT_DENIED_COMMANDS = [
  'Bash(minions runtime set*)', 'Bash(minions auth set*)', 'Bash(minions auth github*)', 'Bash(minions auth telegram*)', 'Bash(minions auth refresh*)',
  'Bash(minions setup github*)', 'Bash(minions channel set*)', 'Bash(minions start*)', 'Bash(minions uninstall*)',
  'Bash(security *)', 'Bash(gh auth token*)', 'Bash(cat *secrets*)', 'Bash(cat *credentials*)',
  'Bash(git push*)', 'Bash(open *)',
] as const;


/** Read/Edit deny rules for host-side minions data and common secret stores. */
export function assistantDeniedPaths(projectId: string): string[] {
  const pp = projectPaths(projectId);
  const projects = join(hostRoot(), 'projects');
  const read = [credentialStoreDir() + '/**', pp.secretsDir + '/**', pp.credentialsJson,
    // Every other project's secret copies and credential references too.
    join(projects, '*', 'secrets') + '/**', join(projects, '*', 'credentials.json')].map((p) => `Read(${abs(p)})`)
    .concat(HOST_SECRET_DIRS.flatMap((d) => [`Read(~/${d})`, `Read(~/${d}/**)`]), ['Read(**/.env)', 'Read(**/.env.*)']);
  const edit = [defaultsPath(), registryPath(), credentialStoreDir() + '/**', pp.projectJson, pp.credentialsJson, pp.secretsDir + '/**',
    pp.manifestJson, pp.journalJson, pp.composeYaml, pp.pluginDir + '/**', pp.runtimeDir + '/**', pp.hostDir + '/**', assistantPluginDir(projectId) + '/**']
    .map((p) => `Edit(${abs(p)})`);
  return [...read, ...edit];
}

export const assistantPluginDir = (projectId: string) => projectPaths(projectId).assistantPluginDir;

/** templates/assistant (sibling of templates/plugin; MINIONS_TEMPLATES overrides the root). */
export const assistantTemplatesDir = () => join(dirname(templatesDir()), 'assistant');

export interface AssistantContext {
  project: ProjectJson;
  repoPath: string;
  config: MinionsConfig | null;
}

export interface AssistantPlan {
  cwd: string;
  pluginDir: string;
  /** Files of the generated host plugin (absolute path -> content). */
  files: { path: string; content: string }[];
  systemPrompt: string;
  command: 'claude';
  args: string[];
}

export function assistantVars(ctx: AssistantContext): Record<string, string> {
  const p = ctx.project;
  const shared = p.visibility === 'shared';
  const startReady = ctx.config?.intake.startReady;
  return {
    projectId: p.projectId,
    repoPath: ctx.repoPath,
    visibility: p.visibility,
    runtime: runtimeOf(p),
    packageVersion: VERSION,
    configPath: projectConfigPath({ ...p, repoPath: ctx.repoPath }),
    configNote: shared ? 'shared install: `.minions/config.json` in the repository; the user may commit it' : 'private install: the host-side project configuration; nothing is written into the repository',
    commitNote: shared ? ', and that the user should commit `.minions/config.json` to share it' : '',
    minionsHome: hostRoot(),
    projectDir: projectPaths(p.projectId).dir,
    intakeNote: startReady === false
      ? 'This profile starts only tasks the user authorized (label `minions:authorized`): tell the user the coordinator creates them as ideas and they authorize the ones to start.'
      : 'With this profile the coordinator may start `ready` tasks directly.',
  };
}

/** argv of the assistant's claude process. Never contains a secret; never a bypass/accept-edits mode. */
export function assistantArgs(o: { repoRoot: string; pluginDir: string; systemPrompt: string; deniedPaths: string[]; prompt?: string }): string[] {
  // Variadic tool lists come first and end at the next option, so the trailing positional prompt is
  // never swallowed by them.
  return [
    '--allowedTools', ...assistantAllowedTools(o.repoRoot),
    '--disallowedTools', ...ASSISTANT_DENIED_COMMANDS, ...o.deniedPaths,
    '--plugin-dir', o.pluginDir,
    '--append-system-prompt', o.systemPrompt,
    '--settings', JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }),
    '--name', 'minions setup',
    '--permission-mode', ASSISTANT_PERMISSION_MODE,
    o.prompt ?? ASSISTANT_PROMPT,
  ];
}

/** Renders the plugin and prompt in memory (nothing is written). */
export async function planAssistant(ctx: AssistantContext): Promise<AssistantPlan> {
  const dir = assistantTemplatesDir();
  const vars = assistantVars(ctx);
  const render = async (f: string) => renderTemplate(await readFile(join(dir, f), 'utf8'), vars, {}, { name: `assistant/${f}` });
  const systemPrompt = await render('system-prompt.md');
  const skill = await render('setup-skill.md');
  const pluginDir = assistantPluginDir(ctx.project.projectId);
  const manifest = JSON.stringify({
    name: ASSISTANT_PLUGIN, version: VERSION, author: { name: 'minions' },
    description: 'minions setup assistant: finish setting up minions for this repository after `minions init` (host-side, generated).',
  }, null, 2) + '\n';
  return {
    cwd: ctx.repoPath, pluginDir, systemPrompt, command: 'claude',
    files: [
      { path: join(pluginDir, '.claude-plugin', 'plugin.json'), content: manifest },
      { path: join(pluginDir, 'skills', 'setup', 'SKILL.md'), content: skill },
    ],
    args: assistantArgs({ repoRoot: ctx.repoPath, pluginDir, systemPrompt, deniedPaths: assistantDeniedPaths(ctx.project.projectId) }),
  };
}

export async function writeAssistantPlugin(plan: AssistantPlan): Promise<{ path: string; sha256: string }[]> {
  const out = [];
  for (const f of plan.files) { await atomicWrite(f.path, f.content); out.push({ path: f.path, sha256: sha256(f.content) }); }
  return out;
}

export async function loadAssistantContext(cwd: string): Promise<AssistantContext> {
  const ref = await projectForPath(cwd);
  const project = await loadProjectJson(ref.projectId);
  const config = await loadEffectiveConfig(project).then((e) => e.config, () => null);
  return { project, repoPath: ref.repoPath, config };
}

export type Spawn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<number>;

const inheritSpawn: Spawn = (cmd, args, opts) => new Promise((resolve, reject) => {
  const child = nodeSpawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit', shell: false });
  child.on('error', (e) => reject(new MinionsError('INCOMPATIBLE_RUNTIME', `Failed to start claude: ${e.message}`)));
  child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
});

export const claudeOnPath = async () => (await resolveOnPath('claude')) !== null;

export const CLAUDE_MISSING = new MinionsError('PRECONDITION', 'The setup assistant needs Claude Code (`claude`) on PATH.',
  'Install Claude Code on the host (`npm install -g @anthropic-ai/claude-code` or `brew install --cask claude-code`), then run `minions setup assist`.');

/** Writes the host plugin and runs `claude` in the foreground with the inherited terminal. Resolves with its exit code. */
export async function launchAssistant(ctx: AssistantContext, opts: { spawn?: Spawn; onInfo?: (line: string) => void } = {}): Promise<number> {
  if (!(await claudeOnPath())) throw CLAUDE_MISSING;
  if (!(await resolveOnPath('minions'))) opts.onInfo?.('warning: `minions` is not on PATH; the assistant runs `minions doctor` and friends and needs it there.');
  const plan = await planAssistant(ctx);
  await writeAssistantPlugin(plan);
  opts.onInfo?.(`Starting the setup assistant (Claude Code in ${plan.cwd}; permission prompts stay on). Type /exit to leave.`);
  return (opts.spawn ?? inheritSpawn)(plan.command, plan.args, { cwd: plan.cwd });
}

/** When init may offer the assistant: a real interactive run only (never --yes/--config/--json/--dry-run or without a terminal). */
export function initMayOfferAssistant(o: { yes?: boolean; config?: string; json: boolean; dryRun?: boolean; stdinTTY: boolean; stdoutTTY: boolean }): boolean {
  return !o.yes && !o.config && !o.json && !o.dryRun && o.stdinTTY && o.stdoutTTY;
}

export type OfferOutcome = 'launched' | 'declined' | 'skipped' | 'unavailable';

/** End of an interactive init: "Open the setup assistant ...? [Y/n]". Failures never fail init. */
export async function offerSetupAssistant(o: {
  interactive: boolean; io?: Pick<WizardIO, 'ask' | 'info'>; launch: () => Promise<number>; claudeAvailable?: () => Promise<boolean>;
}): Promise<OfferOutcome> {
  if (!o.interactive || !o.io) return 'skipped';
  if (!(await (o.claudeAvailable ?? claudeOnPath)())) {
    o.io.info('Setup assistant: install Claude Code (`claude`) to finish the remaining setup with `minions setup assist`.');
    return 'unavailable';
  }
  const a = (await o.io.ask('Open the setup assistant to finish remaining setup? [Y/n]', '')).trim();
  if (a && !/^y(es)?$/i.test(a)) {
    o.io.info('Skipped. Run `minions setup assist` any time.');
    return 'declined';
  }
  try { await o.launch(); } catch (e) {
    o.io.info(`Setup assistant not started: ${e instanceof MinionsError ? e.message : String(e)} Run \`minions setup assist\` later.`);
    return 'unavailable';
  }
  return 'launched';
}

const shortArgs = (args: string[]) => args.map((a) => (a.length > 120 ? `<${a.length} chars>` : /\s|[()*]/.test(a) ? `'${a}'` : a)).join(' ');

/** `minions setup assist`. */
export function registerAssistant(setup: Command): void {
  setup.command('assist')
    .description('AI setup assistant: open Claude Code in the repository with a minions setup skill to finish the remaining setup (interactive)')
    .option('--dry-run', 'print the claude command and the generated files without writing or launching anything')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const ctx = await loadAssistantContext(process.cwd());
      if (dryRun) {
        const plan = await planAssistant(ctx);
        emit({ dryRun: true, cwd: plan.cwd, command: plan.command, args: plan.args, pluginDir: plan.pluginDir, files: plan.files.map((f) => f.path), claudeOnPath: await claudeOnPath() },
          { json, human: () => [`Would write the setup assistant plugin to ${plan.pluginDir}`, `Would run in ${plan.cwd}:`, `  claude ${shortArgs(plan.args)}`].join('\n') });
        return;
      }
      if (json || !process.stdin.isTTY || !process.stdout.isTTY) {
        throw new MinionsError('PRECONDITION', 'The setup assistant is an interactive Claude Code session and needs a terminal.', 'Run `minions setup assist` in a terminal (or `--dry-run` to see the command).');
      }
      process.exitCode = await launchAssistant(ctx, { onInfo: (l) => process.stderr.write(l + '\n') });
    }));
}
