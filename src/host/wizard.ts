// Init wizard (spec §7). Questions are prefilled from the profile, an existing config, and discovery.
// Questions whose answer cannot change v0.1 behaviour are shown as information only, with the
// deferred options marked "(not available in v0.1)". The wizard questions never ask for secrets;
// the only secret prompts (GitHub token, Telegram bot token, after the plan is applied) go through
// `secret()`, which reads from the host terminal without echo.
import { createInterface, type Interface } from 'node:readline/promises';
import { can } from '../config/capabilities.js';
import { githubDeliveryUnavailableReason, profileDefaults } from '../config/profiles.js';
import { validateConfig } from '../config/resolve.js';
import { PROFILES, type MinionsConfig, type Profile } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { readJson } from '../core/fsutil.js';
import { VERSION } from '../core/version.js';
import { telegramBotGuidance } from './credentials.js';
import type { Discovery } from './discovery.js';

export interface WizardIO {
  ask(question: string, defaultValue: string): Promise<string>;
  info(line: string): void;
  /** Non-echoing secret prompt on the host terminal. Absent when no TTY is available. */
  secret?(prompt: string): Promise<string>;
  close?(): void;
}

/** Interactive prompts on stderr (stdout stays clean for --json). */
export function readlineIO(): WizardIO {
  let rl: Interface | null = createInterface({ input: process.stdin, output: process.stderr });
  const get = () => (rl ??= createInterface({ input: process.stdin, output: process.stderr }));
  return {
    async ask(question, def) {
      const a = (await get().question(`${question}${def ? ` [${def}]` : ''}: `)).trim();
      return a || def;
    },
    info: (line) => process.stderr.write(line + '\n'),
    ...(process.stdin.isTTY ? {
      async secret(prompt: string) {
        // readline would echo; close it while reading raw keystrokes, reopen lazily afterwards.
        rl?.close(); rl = null;
        return readSecret(prompt);
      },
    } : {}),
    close: () => { rl?.close(); rl = null; },
  };
}

type SecretInput = Pick<NodeJS.ReadStream, 'isTTY' | 'isRaw' | 'setRawMode' | 'on' | 'removeListener' | 'resume' | 'pause' | 'setEncoding'>;

/**
 * Reads one line from a TTY in raw mode without echoing it (nothing, not even '*', is written).
 * Enter finishes, Backspace edits, Ctrl-C / Ctrl-D-on-empty cancel. Escape sequences (arrows,
 * bracketed paste markers) are dropped.
 */
export function readSecret(prompt: string, input: SecretInput = process.stdin, output: Pick<NodeJS.WritableStream, 'write'> = process.stderr): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new MinionsError('PRECONDITION', 'A terminal is required to enter a secret without echo.', 'Run in a terminal, or pipe the token with --stdin.'));
  }
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let buf = '';
    const wasRaw = !!input.isRaw;
    const finish = (err?: Error) => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (err) reject(err); else resolve(buf);
    };
    const onData = (chunk: Buffer | string) => {
      const s = String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '').replace(/\x1b./g, '');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || (ch === '\u0004' && !buf)) return finish(new MinionsError('PRECONDITION', 'Secret entry cancelled; nothing was stored.'));
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch >= ' ') buf += ch;
      }
    };
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  });
}

export interface WizardInput {
  discovery: Discovery;
  projectId: string;
  profile?: Profile;
  visibility?: 'shared' | 'private';
  /** Config from a previous install (rerun): its values become the defaults. */
  existing?: MinionsConfig;
  /** --config <file>: validated config, no questions. */
  configFile?: string;
  /** A GitHub token is already stored for this project (branch/PR delivery needs it). */
  githubCredential?: boolean;
  /** --yes: accept defaults. */
  yes: boolean;
  io?: WizardIO;
}

export interface WizardResult { config: MinionsConfig; notes: string[]; asked: string[] }

const NA = '(not available in v0.1)';

export function parsePorts(s: string): { host: number; container: number }[] {
  const t = s.trim();
  if (!t || t === 'none') return [];
  return t.split(',').map((part) => {
    const m = /^\s*(\d{1,5})(?::(\d{1,5}))?\s*$/.exec(part);
    const host = Number(m?.[1]), container = Number(m?.[2] ?? m?.[1]);
    if (!m || !(host >= 1 && host <= 65535) || !(container >= 1 && container <= 65535)) {
      throw new Error(`invalid port mapping "${part.trim()}" (use host:container, e.g. 3000:3000)`);
    }
    return { host, container };
  });
}
const fmtPorts = (p: { host: number; container: number }[]) => (p.length ? p.map((x) => `${x.host}:${x.container}`).join(',') : 'none');

async function askValid<T>(io: WizardIO, q: string, def: string, parse: (s: string) => T): Promise<T> {
  for (let i = 0; ; i++) {
    const a = await io.ask(q, def);
    try { return parse(a); } catch (e) {
      if (i >= 2) throw new MinionsError('INVALID_CONFIG', `${q}: ${(e as Error).message}`);
      io.info(`  ${(e as Error).message}`);
    }
  }
}

const choice = <T extends string>(opts: readonly T[]) => (s: string): T => {
  const v = s.trim();
  const byNum = /^\d+$/.test(v) ? opts[Number(v) - 1] : undefined;
  const hit = byNum ?? opts.find((o) => o === v);
  if (!hit) throw new Error(`choose one of: ${opts.join(', ')}`);
  return hit;
};
const yesNo = (s: string) => { if (/^y(es)?$/i.test(s)) return true; if (/^no?$/i.test(s)) return false; throw new Error('answer y or n'); };
const posNum = (int: boolean, min: number) => (s: string) => {
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new Error(`enter a ${int ? 'whole ' : ''}number >= ${min}`);
  return n;
};
const nonEmpty = (s: string) => { if (!s.trim()) throw new Error('required'); return s.trim(); };

function baseConfig(input: WizardInput, profile: Profile): { config: MinionsConfig; notes: string[] } {
  const d = input.discovery;
  if (input.existing && input.existing.profile === profile) {
    return { config: { ...structuredClone(input.existing), projectId: input.projectId, packageVersion: VERSION }, notes: [] };
  }
  const r = profileDefaults(profile, {
    hasGitHub: d.git.hasGitHub, hasGitHubCredential: !!input.githubCredential, baseBranch: d.git.baseBranch,
    identity: { name: d.git.userName ?? '', email: d.git.userEmail ?? '' },
    projectId: input.projectId, packageVersion: VERSION,
  });
  r.config.verification.commands = [...d.verificationCommands];
  return r;
}

const DELIVERY_MODES = ['local', 'branch', 'pull-request'] as const;

/** Branch/PR delivery without a GitHub remote and stored token falls back to local, with the reason. */
const PUSH_DENIED = 'the profile denies git.push (e.g. supervised), so nothing could be published';

/** Why branch/pull-request delivery cannot be selected, or null: GitHub remote + token, and git.push not denied. */
function deliveryBlockedReason(cfg: MinionsConfig, input: WizardInput): string | null {
  return githubDeliveryUnavailableReason({ hasGitHub: input.discovery.git.hasGitHub, hasGitHubCredential: !!input.githubCredential })
    ?? (can(cfg, 'git.push') === 'deny' ? PUSH_DENIED : null);
}

/** Branch/PR delivery without a GitHub remote and stored token (or with git.push denied) falls back to local, with the reason. */
function deliveryFallback(cfg: MinionsConfig, input: WizardInput, notes: string[]): void {
  const why = deliveryBlockedReason(cfg, input);
  if (cfg.delivery.mode !== 'local' && why) {
    notes.push(`delivery.mode "${cfg.delivery.mode}" is not selectable: ${why}; using local delivery.`);
    cfg.delivery.mode = 'local';
    cfg.delivery.provider = 'none';
  }
}

export async function runWizard(input: WizardInput): Promise<WizardResult> {
  const d = input.discovery;
  const asked: string[] = [];
  if (input.configFile) {
    const raw = await readJson<Record<string, unknown>>(input.configFile);
    const cfg = validateConfig({ ...raw, projectId: input.projectId, packageVersion: VERSION }, input.configFile);
    if (input.visibility) cfg.visibility = input.visibility;
    const notes = [`configuration from ${input.configFile}`];
    deliveryFallback(cfg, input, notes);
    return { config: validateConfig(cfg, input.configFile), notes, asked };
  }

  const interactive = !input.yes;
  if (interactive && !input.io) throw new MinionsError('INTERNAL', 'wizard needs an IO implementation');
  const io = input.io!;
  const ask = async <T>(id: string, q: string, def: string, parse: (s: string) => T): Promise<T> => {
    asked.push(id);
    return askValid(io, q, def, parse);
  };

  // 1. Starting profile.
  let profile: Profile = input.profile ?? input.existing?.profile ?? 'project-owner';
  if (interactive && !input.profile) {
    io.info('Profiles: 1) project-owner  2) personal-work  3) supervised');
    profile = await ask('profile', 'Starting profile', profile, choice(PROFILES));
  }
  const { config: cfg, notes } = baseConfig(input, profile);
  deliveryFallback(cfg, input, notes);

  // 2. Visibility.
  if (input.visibility) cfg.visibility = input.visibility;
  else if (interactive) {
    io.info('Installation: shared writes .minions/config.json + README into the repo; private writes nothing into the repo.');
    cfg.visibility = await ask('visibility', 'Installation visibility (shared/private)', cfg.visibility, choice(['shared', 'private'] as const));
  }

  if (interactive) {
    // 3. Backlog backend and ownership — single supported option in v0.1.
    io.info(`Backlog: Backlog.md inside the container (ownership: ${cfg.backlog.ownership}). GitHub Issues ${NA}.`);
    // 4. Intake and authorized scope.
    cfg.intake.startReady = await ask('intake.startReady',
      'Start ready tasks automatically? (n = only tasks labelled minions:authorized)', cfg.intake.startReady ? 'y' : 'n', yesNo);
    // 5. Publication and merge authority.
    const blocked = deliveryBlockedReason(cfg, input);
    if (blocked) {
      io.info(`Delivery: local commits on agent/<slug> branches, fetched with \`minions export\`. Branch push and pull requests are not selectable: ${blocked}. Auto-merge ${NA}.`);
    } else {
      io.info(`Delivery: local (commits stay in the container; \`minions export\`), branch (push agent/<slug> to origin), or pull-request (push and open a PR against ${cfg.git.baseBranch}). minions never merges; auto-merge ${NA}.`);
      cfg.delivery.mode = await ask('delivery.mode', 'Delivery mode (local/branch/pull-request)', cfg.delivery.mode, choice(DELIVERY_MODES));
      cfg.delivery.provider = cfg.delivery.mode === 'local' ? cfg.delivery.provider : 'github';
    }
    // 6. Communication. Terminal is always available; Telegram is optional and degrades to terminal.
    io.info('Communication: terminal (always available), or Telegram through the official Claude Code channel plugin (research preview).');
    let channel = await ask('communication.channel', 'Communication channel (terminal/telegram)', cfg.communication.channel, choice(['terminal', 'telegram'] as const));
    if (channel === 'telegram') {
      for (const l of telegramBotGuidance()) io.info(`  ${l}`);
      if (cfg.container.network === 'none') {
        const why = 'Telegram is unavailable: container.network is none, and the plugin needs api.telegram.org and the npm registry. Using terminal.';
        io.info(`  ${why}`);
        notes.push(why);
        channel = 'terminal';
      } else {
        io.info('  After the plan is applied you can store the bot token (input hidden). Until a token is stored and the plugin');
        io.info('  is available in the container, the coordinator starts terminal-only and says why.');
      }
    }
    cfg.communication.channel = channel;
    // 7. Credentials — no secret is requested by these questions.
    io.info('Credentials: log in to Claude inside the container (/login) on first `minions start`; host login is not reused.');
    io.info(d.git.hasGitHub
      ? 'GitHub token: after the plan is applied you can store a fine-grained token (entered without echo, kept in the Keychain or a 0600 host file), or later with `minions auth github`.'
      : 'GitHub token: not needed (no GitHub remote); `minions auth github` can store one later.');
  }
  if (!cfg.git.identity.name || !cfg.git.identity.email) {
    if (!interactive) {
      throw new MinionsError('PRECONDITION', 'Git identity (user.name / user.email) is not configured for this repository.',
        'Run `git config user.name "…"` and `git config user.email "…"`, or run init interactively.');
    }
    cfg.git.identity.name = await ask('git.identity.name', 'Commit author name for agent commits', cfg.git.identity.name, nonEmpty);
    cfg.git.identity.email = await ask('git.identity.email', 'Commit author email for agent commits', cfg.git.identity.email, nonEmpty);
  }

  if (interactive) {
    // Verification commands (inferred from package.json scripts, never executed on the host).
    const v = await ask('verification.commands', "Verification commands run inside the container (separate with ';', 'none' for none)",
      cfg.verification.commands.join('; ') || 'none', (s) => (s.trim() === 'none' ? [] : s.split(';').map((x) => x.trim()).filter(Boolean)));
    cfg.verification.commands = v;
    // 8. Container resources and preview ports.
    io.info(`Container: image minions-runtime:${VERSION}${d.dockerfile ? ' (the repository Dockerfile is not built)' : ''}; host has ${d.host.cpus} CPUs, ${d.host.memoryMiB} MiB RAM.`);
    cfg.container.cpus = await ask('container.cpus', 'Container CPUs', String(cfg.container.cpus), posNum(false, 0.5));
    cfg.container.memoryMiB = await ask('container.memoryMiB', 'Container memory (MiB)', String(cfg.container.memoryMiB), posNum(true, 512));
    cfg.container.publishPorts = await ask('container.publishPorts', 'Preview ports to publish on 127.0.0.1 (host:container, comma separated)',
      fmtPorts(cfg.container.publishPorts), parsePorts);
  }
  if (cfg.container.cpus > d.host.cpus) notes.push(`container.cpus ${cfg.container.cpus} exceeds host CPUs (${d.host.cpus}).`);
  if (cfg.container.memoryMiB > d.host.memoryMiB) notes.push(`container.memoryMiB ${cfg.container.memoryMiB} exceeds host memory (${d.host.memoryMiB} MiB).`);
  return { config: validateConfig(cfg, 'wizard answers'), notes, asked };
}
