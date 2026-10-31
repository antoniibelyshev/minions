// Extra interactive coordinator sessions (`minions session new|list`, docs/design/autonomy.md Decision 13). The owner of a
// supervised project works with one coordinator in the terminal; occasionally a second one. Each extra session is its own
// tmux session (`session-<name>`) on the runtime's tmux server, running `minions coordinator interactive session:<name>`:
// claude with the coordinator's prompt, plugin and settings, without Telegram and outside the wrapper (no coordinator lock,
// launch record or helpers: those stay the primary coordinator's). MINIONS_SESSION=session:<name> scopes its handoff, usage
// and context-reset state (session-scope.ts).
import { spawn as nodeSpawn } from 'node:child_process';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { buildClaudeCommand, claudePermissionModes, permissionModesNeeded, TELEGRAM_TOKEN_ENV, tmuxBase, type CoordinatorCommand } from './coordinator.js';
import { runtimePaths, type RuntimePaths } from './paths.js';
import { INTERACTIVE_NAME, INTERACTIVE_PREFIX, SESSION_ENV } from './session-scope.js';

export const TMUX_PREFIX = 'session-';
/** Default names are numbers from 2 (the primary coordinator is the first). */
const FIRST_NUMBER = 2;

export function checkSessionName(name: string): string {
  if (!INTERACTIVE_NAME.test(name)) throw new MinionsError('PRECONDITION', `Invalid session name "${name.slice(0, 40)}".`, 'Use letters, digits, - and _ (at most 32), starting with a letter or digit.');
  return name;
}

export interface InteractiveSession { name: string; key: string; tmux: string; created: string | null; attached: boolean }

/** The extra sessions among `tmux list-sessions -F '#{session_name} #{session_created} #{session_attached}'` lines. */
export function parseTmuxSessions(stdout: string): InteractiveSession[] {
  return stdout.split('\n').flatMap((l) => {
    const [tmux, created, attached] = l.trim().split(/\s+/);
    if (!tmux?.startsWith(TMUX_PREFIX)) return [];
    const name = tmux.slice(TMUX_PREFIX.length);
    if (!INTERACTIVE_NAME.test(name)) return [];
    const secs = Number(created);
    return [{ name, key: `${INTERACTIVE_PREFIX}${name}`, tmux, created: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null, attached: !!attached && attached !== '0' }];
  });
}

/** The lowest free number from 2. */
export function nextSessionName(existing: readonly string[]): string {
  let n = FIRST_NUMBER;
  while (existing.includes(String(n))) n++;
  return String(n);
}

export const LIST_FORMAT = '#{session_name} #{session_created} #{session_attached}';
export const listSessionsArgs = (paths: Pick<RuntimePaths, 'tmuxSocket'>) => [...tmuxBase(paths), 'list-sessions', '-F', LIST_FORMAT];

/** Starts the session detached (attach separately, so `--no-attach` and a non-TTY caller work the same). */
export function newSessionCommand(paths: Pick<RuntimePaths, 'tmuxSocket' | 'repo'>, name: string): CoordinatorCommand {
  const key = `${INTERACTIVE_PREFIX}${checkSessionName(name)}`;
  return { cmd: 'tmux', cwd: paths.repo, args: [...tmuxBase(paths), '-u', 'new-session', '-d', '-s', `${TMUX_PREFIX}${name}`, '-c', paths.repo, '--', 'minions', 'coordinator', 'interactive', key] };
}

export const attachArgs = (paths: Pick<RuntimePaths, 'tmuxSocket'>, name: string) => [...tmuxBase(paths), 'attach-session', '-t', `=${TMUX_PREFIX}${checkSessionName(name)}`];

/** Told to the extra session (appended to the coordinator prompt). */
export const interactivePromptNote = (key: string) => `

## Extra interactive session (${key})

The owner opened this as an additional coordinator session in the terminal; the primary coordinator may be running at the same time on the same backlog and runtime. Work on what the owner asks here. Never restart, stop or reconfigure the coordinator for it, and leave the queue, Telegram and routine duties to the primary coordinator.
`;

/** `minions coordinator interactive <key>`: claude in the foreground (the tmux pane), with MINIONS_SESSION=<key>. */
export async function runInteractive(cfg: MinionsConfig, key: string, deps: { paths?: RuntimePaths; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  if (!key.startsWith(INTERACTIVE_PREFIX)) throw new MinionsError('PRECONDITION', `Not an interactive session key: ${JSON.stringify(key.slice(0, 60))}.`, 'Use session:<name>.');
  checkSessionName(key.slice(INTERACTIVE_PREFIX.length));
  const paths = deps.paths ?? runtimePaths();
  const permissionModes = permissionModesNeeded(cfg) ? await claudePermissionModes().catch(() => null) : undefined;
  const c = await buildClaudeCommand(cfg, paths, { telegram: false, permissionModes, extraPrompt: interactivePromptNote(key) });
  const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env), [SESSION_ENV]: key };
  delete env[TELEGRAM_TOKEN_ENV];
  // Ctrl-C and Ctrl-\ are claude's: the parent stays until claude exits.
  for (const s of ['SIGINT', 'SIGQUIT'] as const) process.on(s, () => undefined);
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(c.cmd, c.args, { cwd: c.cwd, env, stdio: 'inherit', shell: false });
    child.on('error', (e) => reject(new MinionsError('INCOMPATIBLE_RUNTIME', `Failed to start claude: ${e.message}`)));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
