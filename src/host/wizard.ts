// Init wizard (spec §7). The config comes from the mode, an existing config, discovery and the host defaults
// (defaults.json); the wizard asks only what none of them answers. The wizard questions never ask for secrets:
// the Claude authorization question only asks where the host should read a key from, never the key
// itself; the only secret prompt (the Telegram bot token, after the plan is applied) goes
// through `secret()`, which reads from the host terminal without echo.
import { createInterface, type Interface } from 'node:readline/promises';
import { modeDefaults } from '../config/modes.js';
import { validateConfig } from '../config/resolve.js';
import { MODES, type MinionsConfig, type Mode } from '../config/schema.js';
import { stripTerminalEscapes } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { parseWith, readJson } from '../core/fsutil.js';
import { VERSION } from '../core/version.js';
import { ClaudeAuthSchema, PRESETS, checkUrl, parseEnvPairs, type ClaudeAuth } from './auth.js';
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
      const s = stripTerminalEscapes(String(chunk));
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
  /** Chosen before the wizard (`--mode` or askMode). */
  mode: Mode;
  visibility?: 'shared' | 'private';
  /** Config from a previous install (rerun): its values become the defaults. */
  existing?: MinionsConfig;
  /** --config <file>: validated config, no questions. */
  configFile?: string;
  /** --yes: accept defaults. */
  yes: boolean;
  /** Git identity from defaults.json (wins over the repository's git config). */
  gitIdentity?: { name?: string; email?: string };
  io?: WizardIO;
  /** Claude authorization: default (previous project / defaults.json) and preset detection. */
  auth?: { default?: ClaudeAuth; centralOnPath?: boolean; home?: string };
  /** Agent runtime chosen before the wizard (host-only setting). Default docker. */
  runtime?: 'docker' | 'host';
}

export interface WizardResult { config: MinionsConfig; notes: string[]; asked: string[]; claudeAuth?: ClaudeAuth }

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
const nonEmpty = (s: string) => { if (!s.trim()) throw new Error('required'); return s.trim(); };

/** The mode question (the first one; no default for a new project). */
export async function askMode(io: WizardIO, def?: Mode): Promise<Mode> {
  io.info('Mode:');
  io.info('  1) independent  the agents plan, decide, merge into the local base and report milestones (Docker, Telegram, daily digest)');
  io.info('  2) supervised   you review and merge all code; the agents experiment freely and ask about risky changes (host, terminal)');
  return askValid(io, 'Mode (independent/supervised)', def ?? '', choice(MODES));
}

/** A mode is never assumed: a non-interactive init needs `--mode`. */
export const modeRequired = () => new MinionsError('PRECONDITION', 'Choose a mode: independent or supervised.',
  'Pass `--mode independent` (the agents run the project) or `--mode supervised` (you review and merge all code).');

function baseConfig(input: WizardInput): MinionsConfig {
  const d = input.discovery;
  if (input.existing && input.existing.mode === input.mode) {
    return { ...structuredClone(input.existing), projectId: input.projectId, packageVersion: VERSION };
  }
  const config = modeDefaults(input.mode, {
    baseBranch: input.existing?.git.baseBranch ?? d.git.baseBranch,
    identity: input.existing?.git.identity ?? { name: input.gitIdentity?.name ?? d.git.userName ?? '', email: input.gitIdentity?.email ?? d.git.userEmail ?? '' },
    projectId: input.projectId, packageVersion: VERSION,
  });
  config.verification.commands = [...(input.existing?.verification.commands ?? d.verificationCommands)];
  const setup = input.existing ? input.existing.verification.setupCommands ?? [] : d.setupCommands;
  if (setup.length) config.verification.setupCommands = [...setup];
  return config;
}

/**
 * Builds the project config from the mode, discovery and the host defaults. It asks only what nothing else answers:
 * Claude authorization without a default, and the git identity when neither defaults.json nor git config has one.
 */
export async function runWizard(input: WizardInput): Promise<WizardResult> {
  const d = input.discovery;
  const asked: string[] = [];
  if (input.configFile) {
    const raw = await readJson<Record<string, unknown>>(input.configFile);
    const cfg = validateConfig({ ...raw, projectId: input.projectId, packageVersion: VERSION }, input.configFile);
    if (input.visibility) cfg.visibility = input.visibility;
    const notes = [`configuration from ${input.configFile}`];
    return { config: validateConfig(cfg, input.configFile), notes, asked };
  }

  const interactive = !input.yes;
  if (interactive && !input.io) throw new MinionsError('INTERNAL', 'wizard needs an IO implementation');
  const io = input.io!;
  const ask = async <T>(id: string, q: string, def: string, parse: (s: string) => T): Promise<T> => {
    asked.push(id);
    return askValid(io, q, def, parse);
  };

  const cfg = baseConfig(input);
  const notes: string[] = [];
  if (input.visibility) cfg.visibility = input.visibility;
  let claudeAuth = input.auth?.default;
  if (interactive && !claudeAuth) claudeAuth = parseWith(ClaudeAuthSchema, await askClaudeAuth(input, ask, io), 'wizard answers (Claude authorization)');
  if (!cfg.git.identity.name || !cfg.git.identity.email) {
    if (!interactive) {
      throw new MinionsError('PRECONDITION', 'Git identity for agent commits is not configured.',
        'Run `minions defaults set git.name <name>` and `minions defaults set git.email <email>` (or set git user.name/user.email), or run init interactively.');
    }
    cfg.git.identity.name = await ask('git.identity.name', 'Commit author name for agent commits', cfg.git.identity.name, nonEmpty);
    cfg.git.identity.email = await ask('git.identity.email', 'Commit author email for agent commits', cfg.git.identity.email, nonEmpty);
  }
  if (input.runtime !== 'host' && cfg.container.cpus > d.host.cpus) notes.push(`container.cpus ${cfg.container.cpus} exceeds host CPUs (${d.host.cpus}).`);
  if (input.runtime !== 'host' && cfg.container.memoryMiB > d.host.memoryMiB) notes.push(`container.memoryMiB ${cfg.container.memoryMiB} exceeds host memory (${d.host.memoryMiB} MiB).`);
  return { config: validateConfig(cfg, 'wizard answers'), notes, asked, ...(claudeAuth ? { claudeAuth } : {}) };
}

type Ask = <T>(id: string, q: string, def: string, parse: (s: string) => T) => Promise<T>;

/** Splits a command line into argv (whitespace, with '…' / "…" quoting). Never passed to a shell. */
export function splitArgv(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(s));) out.push(m[1] ?? m[2] ?? m[3]!);
  if (!out.length) throw new Error('enter a command');
  return out;
}

async function askClaudeAuth(input: WizardInput, ask: Ask, io: WizardIO): Promise<ClaudeAuth> {
  const def = input.auth?.default;
  const opts: { id: 'login' | 'api-key' | 'jbcentral' | 'helper'; label: string }[] = [
    { id: 'login', label: input.runtime === 'host' ? 'Your existing host Claude Code login (default)' : 'Claude login inside container (default)' },
    { id: 'api-key', label: 'API key from file/Keychain/env' },
    ...(input.auth?.centralOnPath ? [{ id: 'jbcentral' as const, label: 'JetBrains Central (detected)' }] : []),
    { id: 'helper', label: 'Custom host helper command' },
  ];
  const ids = opts.map((o) => o.id);
  const defId = def?.preset === 'jbcentral' && ids.includes('jbcentral') ? 'jbcentral' : def?.method === 'api-key' ? 'api-key' : def?.method === 'helper' ? 'helper' : 'login';
  io.info('Claude authorization (host-side setting; never stored in the repository):');
  io.info('  ' + opts.map((o, i) => `${i + 1}) ${o.label}`).join('  '));
  const pick = await ask('claudeAuth.method', 'Claude authorization', defId, choice(ids));
  if (pick === defId && def && (pick !== 'login' || def.method === 'login')) {
    const keep = await ask('claudeAuth.keep', 'Keep the current/default settings for it? (y/n)', 'y', yesNo);
    if (keep) return def;
  }
  if (pick === 'login') {
    io.info(input.runtime === 'host'
      ? '  The host runtime uses your existing Claude Code login on this Mac (no key is handed over).'
      : '  Log in with /login in the coordinator session on first `minions start`; host login is not reused.');
    return { method: 'login' };
  }
  if (pick === 'jbcentral') {
    try { return await PRESETS.jbcentral!.expand({ home: input.auth?.home }); } catch (e) {
      io.info(`  ${(e as Error).message} (${(e as MinionsError).hint ?? ''})`);
      const baseUrl = await ask('claudeAuth.baseUrl', 'Central proxy base URL (ANTHROPIC_BASE_URL)', '', (s) => checkUrl(nonEmpty(s), 'base URL'));
      return PRESETS.jbcentral!.expand({ baseUrl });
    }
  }
  const env = await ask('claudeAuth.env', 'Extra container env for Claude (NAME=VALUE separated by spaces, or none)', 'none',
    (s) => (s.trim() === 'none' ? {} : parseEnvPairs(s.trim().split(/\s+/))));
  const withEnv = Object.keys(env).length ? { env } : {};
  if (pick === 'helper') {
    io.info('  The command runs on the host (argv, no shell) on start and every 30 minutes while attached; it must print the key.');
    const command = await ask('claudeAuth.command', 'Host helper command', def?.method === 'helper' ? def.command.join(' ') : '', splitArgv);
    return { method: 'helper', command, ...withEnv };
  }
  const type = await ask('claudeAuth.source', 'Where does the host read the key? (file/keychain/env)', 'keychain', choice(['file', 'keychain', 'env'] as const));
  if (type === 'file') return { method: 'api-key', source: { type, path: await ask('claudeAuth.file', 'Path of the key file on the host (0600, outside the repo)', '', nonEmpty) }, ...withEnv };
  if (type === 'env') return { method: 'api-key', source: { type, name: await ask('claudeAuth.envVar', 'Host environment variable name', 'ANTHROPIC_API_KEY', nonEmpty) }, ...withEnv };
  const service = await ask('claudeAuth.keychainService', 'Keychain item service', 'minions-anthropic', nonEmpty);
  const account = await ask('claudeAuth.keychainAccount', 'Keychain item account', process.env.USER ?? 'minions', nonEmpty);
  return { method: 'api-key', source: { type, service, account }, ...withEnv };
}
