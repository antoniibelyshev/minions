// `minions auth publisher` and the publishing step of `minions setup` (docs/design/autonomy.md Decision 17): store the
// host-wide publisher bot token and install (or restart) the publisher service; doctor's publishing checks.
import type { Command } from 'commander';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { loadDefaults } from './auth.js';
import { BOTFATHER_URL, backendLabel, loadPublisherCredentialRef, provisionPublisherToken, removePublisherToken, type Fetch, type PublisherProvisionResult } from './credentials.js';
import type { Runner } from './docker.js';
import type { ProjectJson } from './project.js';
import { pushAuthFacts, remoteUrlOf } from './publish.js';
import { publishSettings } from './publisher.js';
import {
  installPublisherService, readHeartbeat, removePublisherService, serviceHost, serviceState, type ServiceHost, type ServiceResult,
} from './publisher-service.js';

/** Publisher bot creation steps. Contains no secret. */
export function publisherBotGuidance(): string[] {
  return [
    'Publishing: the team proposes, you approve each push with one tap in Telegram, and a host process does the push',
    '  with your git credentials. It uses a bot of its own, separate from every coordinator bot.',
    `Create a new bot: open ${BOTFATHER_URL}, send /newbot, and copy the token. Then /setjoingroups -> Disable.`,
    'Never reuse a coordinator bot: a coordinator token is readable by its agents, the publisher token never is.',
    'The token stays on this host (Keychain, Secret Service or a 0600 file); only the publisher process reads it.',
    'Afterwards send /start to the new bot from your own Telegram account, so it can message you.',
  ];
}

export interface EnablePublishingDeps {
  runner?: Runner;
  fetch?: Fetch;
  /** The service host (tests inject fakes). */
  host?: ServiceHost;
}

export interface EnablePublishingResult { token: PublisherProvisionResult; service: ServiceResult; owner: string | null; warnings: string[] }

/** Stores the token (refusing a coordinator bot) and installs or restarts the publisher service. */
export async function enablePublishing(token: string, o: { verify?: boolean } & EnablePublishingDeps = {}): Promise<EnablePublishingResult> {
  const r = await provisionPublisherToken({ token, verify: o.verify, runner: o.runner, fetch: o.fetch });
  const service = await installPublisherService(o.host ?? serviceHost(), { restart: true });
  const owner = (await loadDefaults().catch(() => ({} as Awaited<ReturnType<typeof loadDefaults>>))).telegram?.owner ?? null;
  const warnings = [...r.warnings, ...service.warnings];
  if (!owner) warnings.push('no Telegram owner id is set, so the publisher accepts no one yet: `minions defaults set telegram.owner <your numeric Telegram user id>` (ask @userinfobot)');
  return { token: r, service, owner, warnings };
}

export function formatEnable(r: EnablePublishingResult): string {
  return [
    `Stored the publisher bot token for bot ${r.token.botId} in ${backendLabel(r.token.backend)}.`,
    r.token.verification ? `Verification: ${r.token.verification.status} - ${r.token.verification.detail}` : 'Not checked with Telegram (pass --verify to call getMe).',
    `Publisher service: ${r.service.action}${r.service.path ? ` (${r.service.path})` : ''}.`,
    ...r.warnings.map((w) => `warning: ${w}`),
    'Next: send /start to the publisher bot from your Telegram account. Publish requests then arrive there by themselves; /publish <project> asks at any time.',
  ].join('\n');
}

export interface AuthPublisherIO {
  readSecret: (prompt: string) => Promise<string>;
  readStdin: () => Promise<string>;
  say: (json: boolean, line: string) => void;
}

/** `minions auth publisher [--stdin] [--verify] [--remove]` (host-wide; any directory). */
export function registerAuthPublisher(auth: Command, io: AuthPublisherIO): Command {
  return auth.command('publisher')
    .description('Store the host-wide publisher bot token (Telegram-approved publishing; prompted without echo) and install the publisher service')
    .option('--stdin', 'read the token from piped stdin instead of the terminal prompt')
    .option('--verify', 'check the token with the Telegram Bot API (getMe) before storing it')
    .option('--remove', 'delete the stored token and remove the publisher service')
    .option('--dry-run', 'show the guidance and what would be installed')
    .action(action(async (o: { stdin?: boolean; verify?: boolean; remove?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      if (o.remove) {
        if (dryRun) { emit({ dryRun: true }, { json, human: () => 'Would remove the publisher bot token and the publisher service.' }); return; }
        const service = await removePublisherService(serviceHost());
        const token = await removePublisherToken();
        emit({ token, service }, { json, human: () => `${token.removed ? `Removed the publisher bot token (${token.backend}).` : 'No publisher bot token was stored.'} Publisher service: ${service.action}.` });
        return;
      }
      const guidance = publisherBotGuidance();
      if (dryRun) { emit({ dryRun: true, guidance }, { json, human: () => guidance.join('\n') }); return; }
      io.say(json, guidance.join('\n'));
      const token = o.stdin ? await io.readStdin()
        : process.stdin.isTTY ? await io.readSecret('Publisher bot token (input hidden): ')
          : (() => { throw new MinionsError('PRECONDITION', 'No terminal to prompt for the token.', 'Run in a terminal, or pipe it: `minions auth publisher --stdin < token-file`.'); })();
      const r = await enablePublishing(token, { verify: !!o.verify });
      emit(r, { json, human: formatEnable });
    }));
}

// ---------------------------------------------------------------- doctor

export interface PublishCheck { name: string; status: 'ok' | 'warn' | 'unavailable'; detail: string; hint?: string }

/**
 * Doctor's publishing checks for one project: the remote, the bot token, the owner id, the service, and whether the
 * running publisher can authenticate a push (from its heartbeat: what the service process itself sees). Never 'fail':
 * publishing is optional and local work goes on without it.
 */
export async function publishingChecks(project: ProjectJson, deps: { host?: ServiceHost; runner?: Runner } = {}): Promise<PublishCheck[]> {
  const out: PublishCheck[] = [];
  const remote = await remoteUrlOf(project.repoPath, deps.runner).catch(() => null);
  if (!remote) {
    out.push({ name: 'publish', status: 'unavailable', detail: 'no git remote "origin" in your checkout: publishing is unavailable; work stays local (`minions pull`)', hint: 'Add one with `git remote add origin <url>`, then rerun `minions setup`.' });
    return out;
  }
  const settings = await publishSettings(project).catch(() => ({ mode: 'direct' as const, deployKey: null }));
  const ref = await loadPublisherCredentialRef().catch(() => null);
  const owner = (await loadDefaults().catch(() => ({} as Awaited<ReturnType<typeof loadDefaults>>))).telegram?.owner ?? null;
  if (!ref) {
    out.push({ name: 'publish', status: 'warn', detail: `not set up: approved work is not pushed to ${remote} (publish.mode ${settings.mode})`, hint: 'Run `minions auth publisher` (a separate bot from BotFather), or keep publishing by hand: `minions pull && git push`.' });
    return out;
  }
  out.push({ name: 'publish', status: owner ? 'ok' : 'warn', detail: `publisher bot ${ref.botId} (${backendLabel(ref.backend)}); owner ${owner ?? '(unset)'}; publish.mode ${settings.mode}; remote ${remote}`,
    ...(owner ? {} : { hint: 'Set your numeric Telegram user id: `minions defaults set telegram.owner <id>`; until then the publisher accepts no one.' }) });
  const host = deps.host ?? serviceHost({ runner: deps.runner });
  const svc = await serviceState(host);
  out.push({ name: 'publish.service', status: svc.active === 'running' ? 'ok' : 'warn', detail: svc.detail, ...(svc.active === 'running' ? {} : { hint: 'Run `minions auth publisher` again to (re)install and start it.' }) });
  const hb = await readHeartbeat();
  if (!hb) {
    out.push({ name: 'publish.auth', status: 'warn', detail: 'the publisher has not reported yet (no heartbeat)', hint: 'Check the service log: <MINIONS_HOME>/publisher/publisher.log (macOS) or `journalctl --user -u minions-publisher` (Linux).' });
    return out;
  }
  if (hb.state !== 'running') out.push({ name: 'publish.process', status: 'warn', detail: `publisher ${hb.state}: ${hb.detail} (at ${hb.at})` });
  const facts = hb.projects[project.projectId]?.auth ?? pushAuthFacts(remote, { SSH_AUTH_SOCK: hb.sshAuthSock ? 'set' : undefined }, settings.deployKey);
  out.push({ name: 'publish.auth', status: facts.ok ? 'ok' : 'warn', detail: `as the publisher service sees it: ${facts.detail}`,
    ...(facts.ok ? {} : { hint: 'Under launchd/systemd the service may not see your ssh-agent: load your key into the session agent, rerun `minions auth publisher` from a shell whose SSH_AUTH_SOCK is a stable socket, or set a repo-scoped deploy key: `minions settings set publish.deployKey <absolute path>`.' }) });
  const last = hb.projects[project.projectId]?.lastError;
  if (last) out.push({ name: 'publish.last', status: 'warn', detail: `last problem: ${last}` });
  return out;
}
