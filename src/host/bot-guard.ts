// One Telegram bot, one coordinator (host side). Telegram allows one getUpdates poller per bot token, so
// a second coordinator on the same bot breaks both (409 Conflict). Before a Telegram coordinator is
// launched, the host looks for other registered projects whose stored token has the same bot id (the
// non-secret token prefix recorded in credentials.json) and whose coordinator is running with Telegram,
// and refuses the launch. The token itself is never read or printed here.
//
// Manager bot (docs/design/host-manager.md, "Token isolation for the manager bot"): the host manager's bot and the
// coordinator bots are never the same bot, in both directions. A manager token whose bot id is any registered
// project's coordinator bot is refused (assertManagerBotDistinct), and a coordinator token whose bot id is the
// manager's is refused (assertNotManagerBot, enforced inside provisionTelegramToken). Bot id = numeric token prefix.
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { assertNotManagerBot, loadCredentialRefs, loadManagerCredentialRef, projectsUsingBot, type CredentialsJson } from './credentials.js';

export { assertNotManagerBot };
import { Compose, type Runner } from './docker.js';
import { loadProjectJson, type ProjectJson } from './project.js';
import { runtimeOf } from './runtime.js';
import { hostChannel } from './channel-cli.js';

export interface BotGuardDeps {
  /** Non-secret bot id of the project's stored Telegram token (null when none is stored). */
  botIdOf?: (projectId: string) => Promise<string | null>;
  /** Other registered projects with a stored token for this bot. */
  projectsUsingBot?: (botId: string, exceptProjectId: string) => Promise<string[]>;
  /** Whether that project's coordinator is running and polling Telegram. */
  coordinatorPollsBot?: (projectId: string) => Promise<boolean>;
  /** Channel resolution (wantsTelegram) of the project being started. */
  wantsTelegram?: (project: ProjectJson, config: Pick<MinionsConfig, 'communication' | 'container'>) => Promise<boolean>;
  runner?: Runner;
}

export interface BotConflict { botId: string; projects: string[] }

const botIdFromRefs = async (projectId: string) =>
  (await loadCredentialRefs(projectId).catch((): CredentialsJson => ({ version: 1 }))).telegram?.botId ?? null;

/**
 * Whether a registered project's coordinator is running with Telegram: Docker runtime (the host runtime
 * has no Telegram), container running, tmux session `coordinator` present, and its launch record says
 * Telegram is enabled. A running session whose launch record is unreadable counts as polling (fail safe).
 */
export async function dockerCoordinatorPollsBot(projectId: string, runner?: Runner): Promise<boolean> {
  let project: ProjectJson;
  try { project = await loadProjectJson(projectId); } catch { return false; }
  if (runtimeOf(project) === 'host') return false;
  const compose = new Compose(projectId, runner);
  if (!(await compose.isRunning().catch(() => false))) return false;
  const has = await compose.exec(['tmux', 'has-session', '-t', 'coordinator'], { allowFailure: true, timeoutMs: 15_000 }).catch(() => null);
  if (!has || has.code !== 0) return false;
  const st = await compose.exec(['minions', 'telegram', 'status', '--json'], { allowFailure: true, timeoutMs: 30_000 }).catch(() => null);
  try {
    const env = JSON.parse(st?.stdout ?? '') as { ok?: boolean; data?: { coordinator?: { telegram?: { enabled?: boolean } } | null } };
    const enabled = env.ok ? env.data?.coordinator?.telegram?.enabled : undefined;
    return typeof enabled === 'boolean' ? enabled : true;
  } catch { return true; }
}

/** Other projects whose running coordinator polls the same bot as `projectId`'s stored token; null when none. */
export async function findBotConflict(projectId: string, deps: BotGuardDeps = {}): Promise<BotConflict | null> {
  const botId = await (deps.botIdOf ?? botIdFromRefs)(projectId);
  if (!botId) return null;
  const others = await (deps.projectsUsingBot ?? projectsUsingBot)(botId, projectId);
  const polls = deps.coordinatorPollsBot ?? ((id: string) => dockerCoordinatorPollsBot(id, deps.runner));
  const projects: string[] = [];
  for (const id of others) if (await polls(id).catch(() => false)) projects.push(id);
  return projects.length ? { botId, projects } : null;
}

export const botConflictError = (c: BotConflict) => new MinionsError('CONFLICT',
  `Telegram bot ${c.botId} is already polled by the running coordinator of project(s) ${c.projects.join(', ')}. `
  + 'A bot can serve only one coordinator at a time, so this Telegram coordinator was not started.',
  [
    'Choose one:',
    '- start this project terminal-only: `minions channel set terminal`, then `minions start`;',
    '- stop the other coordinator first (`minions down` in that project);',
    '- or give this project its own bot (BotFather /newbot, then `minions auth telegram`).',
  ].join('\n'),
  { botId: c.botId, projects: c.projects });

/**
 * Refuses (CONFLICT) to launch a Telegram coordinator for `project` while another registered project's
 * coordinator polls the same bot. Terminal mode (channel terminal, or auto without a token) is never
 * checked and always starts.
 */
export async function assertBotFree(project: ProjectJson, config: Pick<MinionsConfig, 'communication' | 'container'>, deps: BotGuardDeps = {}): Promise<void> {
  const wants = await (deps.wantsTelegram ?? (async (p, c) => (await hostChannel(p, c)).wantsTelegram))(project, config);
  if (!wants) return;
  const conflict = await findBotConflict(project.projectId, deps);
  if (conflict) throw botConflictError(conflict);
}

/** Whether `projectId`'s own coordinator session is running (Docker runtime: container up, tmux session present). */
export async function ownCoordinatorRunning(projectId: string, runner?: Runner): Promise<boolean> {
  const compose = new Compose(projectId, runner);
  if (!(await compose.isRunning().catch(() => false))) return false;
  const has = await compose.exec(['tmux', 'has-session', '-t', 'coordinator'], { allowFailure: true, timeoutMs: 15_000 }).catch(() => null);
  return !!has && has.code === 0;
}

export type StartBotCheck = { action: 'launch' } | { action: 'attach-existing'; warning: string };

/**
 * `minions start`'s bot check. No conflict: launch as usual. Conflict while this project's own
 * coordinator is already running: attaching to it adds no second poller, so start only warns and
 * attaches (it must not relaunch or sync that coordinator). Conflict otherwise: refused (CONFLICT).
 */
export async function startBotCheck(project: ProjectJson, config: Pick<MinionsConfig, 'communication' | 'container'>,
  deps: BotGuardDeps & { ownRunning?: (projectId: string) => Promise<boolean> } = {}): Promise<StartBotCheck> {
  try {
    await assertBotFree(project, config, deps);
    return { action: 'launch' };
  } catch (e) {
    if (!(e instanceof MinionsError && e.code === 'CONFLICT')) throw e;
    const own = await (deps.ownRunning ?? ((id: string) => ownCoordinatorRunning(id, deps.runner)))(project.projectId).catch(() => false);
    if (!own) throw e;
    const c = e.details as BotConflict;
    return { action: 'attach-existing', warning: `warning: Telegram bot ${c.botId} is also polled by the running coordinator of project(s) ${c.projects.join(', ')}. `
      + "This project's coordinator is already running, so start attaches to it without relaunching or changing it. "
      + 'Stop one of them (`minions down` in that project) or give one its own bot to avoid Telegram conflicts.' };
  }
}

// ---------------------------------------------------------------- manager bot vs coordinator bots

export const managerBotClashError = (botId: string, projects: string[]) => new MinionsError('CONFLICT',
  `Telegram bot ${botId} is the coordinator bot of project(s) ${projects.join(', ')}; the host manager needs its own bot, so the token was not stored.`,
  'The coordinator token is mounted into the container and the manager token never is. Create a new bot for the manager '
  + '(BotFather /newbot) and enter that token.',
  { botId, projects });

/** Refuses (CONFLICT) a manager bot id that is any registered project's coordinator bot (its stored Telegram token). */
export async function assertManagerBotDistinct(botId: string, deps: Pick<BotGuardDeps, 'projectsUsingBot'> = {}): Promise<void> {
  const projects = await (deps.projectsUsingBot ?? projectsUsingBot)(botId, '');
  if (projects.length) throw managerBotClashError(botId, projects);
}

/** Doctor: the stored manager bot against every coordinator bot. Null when no manager token is stored. */
export async function managerBotClash(deps: Pick<BotGuardDeps, 'projectsUsingBot'> = {}): Promise<BotConflict | null> {
  const ref = await loadManagerCredentialRef();
  if (!ref) return null;
  return { botId: ref.botId, projects: await (deps.projectsUsingBot ?? projectsUsingBot)(ref.botId, '') };
}
