// Credential-free capability probe for the official Claude Code Telegram channel plugin
// (docs/design/telegram.md, "Capability probe"). Runs where Claude Code runs: inside the project
// container (`minions telegram probe`); the host `doctor` reaches it through `docker compose exec`.
// It never reads a bot token, the plugin's .env, or access.json, and never starts a Claude session.
import { readFile } from 'node:fs/promises';
import { run, type RunOptions, type RunResult } from '../core/exec.js';
import { redact } from '../core/output.js';

export const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
export const OFFICIAL_MARKETPLACE_REPO = 'anthropics/claude-plugins-official';
export const TELEGRAM_PLUGIN_ID = `telegram@${OFFICIAL_MARKETPLACE}`;
/** Value passed to `claude --channels` (research preview; hidden from `claude --help`). */
export const TELEGRAM_CHANNEL_SPEC = `plugin:${TELEGRAM_PLUGIN_ID}`;
/** Claude Code versions on which the channel interface was verified against the docs (docs/compatibility.md). */
export const VERIFIED_CLAUDE_VERSIONS: readonly string[] = ['2.1.292'];
/** File-based managed settings on Linux (the container OS). */
export const MANAGED_SETTINGS_PATH = '/etc/claude-code/managed-settings.json';

export type ProbeItemStatus = 'ok' | 'missing' | 'blocked' | 'unknown';
export interface ProbeItem { name: string; status: ProbeItemStatus; detail: string; hint?: string }
/** available: every credential-free precondition holds. Anything else names the first blocking reason. */
export type TelegramAvailability = 'available' | 'blocked' | 'unavailable' | 'not-installed';
export interface TelegramProbeReport {
  availability: TelegramAvailability;
  available: boolean;
  summary: string;
  channelSpec: string;
  claudeVersion: string | null;
  items: ProbeItem[];
  /** Preconditions this probe cannot verify without credentials or a live session. */
  unverified: string[];
}

export type ManagedSettings = { present: false } | { present: true; json: unknown } | { present: true; error: string };
export interface TelegramFacts {
  claude: RunResult;
  bun: RunResult;
  marketplaces: RunResult;
  plugins: RunResult;
  managed: ManagedSettings;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

const short = (s: string) => redact(s.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '').slice(0, 300);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const UNVERIFIED: readonly string[] = [
  'Anthropic authentication (claude.ai or Console API key) and plan/organization defaults: claude.ai Team/Enterprise block channels until an Owner enables them; verified only when the coordinator starts with --channels',
  'server-managed settings (claude.ai admin console) for channelsEnabled / allowedChannelPlugins',
  'bot token presence and validity (never read by this probe)',
  'pairing and allowlist state',
  'exclusive polling: another process polling the same bot token causes 409 Conflict at launch',
];

/** Collects facts with read-only, non-session commands. No credentials, no network beyond what the CLI itself does. */
export async function gatherTelegramFacts(opts: { runner?: Runner; readText?: (p: string) => Promise<string>; managedPath?: string } = {}): Promise<TelegramFacts> {
  const runner = opts.runner ?? run;
  const readText = opts.readText ?? ((p: string) => readFile(p, 'utf8'));
  const o = { allowFailure: true, timeoutMs: 30_000 } as const;
  const [claude, bun, marketplaces, plugins] = await Promise.all([
    runner('claude', ['--version'], o),
    runner('bun', ['--version'], o),
    runner('claude', ['plugin', 'marketplace', 'list', '--json'], o),
    runner('claude', ['plugin', 'list', '--json'], o),
  ]);
  let managed: ManagedSettings;
  try {
    const text = await readText(opts.managedPath ?? MANAGED_SETTINGS_PATH);
    try { managed = { present: true, json: JSON.parse(text) as unknown }; } catch (e) { managed = { present: true, error: `invalid JSON: ${(e as Error).message}` }; }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    managed = code === 'ENOENT' ? { present: false } : { present: true, error: `unreadable (${code ?? (e as Error).message})` };
  }
  return { claude, bun, marketplaces, plugins, managed };
}

function parseJsonArray(r: RunResult): unknown[] | string {
  if (r.code !== 0) return `exit ${r.code}: ${short(r.stderr || r.stdout) || 'no output'}`;
  try {
    const v = JSON.parse(r.stdout) as unknown;
    return Array.isArray(v) ? v : 'unexpected JSON shape (expected an array)';
  } catch { return `unparseable output: ${short(r.stdout)}`; }
}

export function parseClaudeVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
}

function claudeItem(f: TelegramFacts): { item: ProbeItem; version: string | null } {
  if (f.claude.code !== 0) {
    return { version: null, item: { name: 'claude', status: 'missing', detail: `\`claude --version\` failed (exit ${f.claude.code}): ${short(f.claude.stderr || f.claude.stdout)}`, hint: 'Claude Code must be installed in the image (@anthropic-ai/claude-code).' } };
  }
  const version = parseClaudeVersion(f.claude.stdout);
  if (version && VERIFIED_CLAUDE_VERSIONS.includes(version)) {
    return { version, item: { name: 'claude', status: 'ok', detail: `Claude Code ${version} (channel interface verified for this version)` } };
  }
  return { version, item: { name: 'claude', status: 'unknown', detail: `Claude Code ${version ?? short(f.claude.stdout)} is not a version the channel interface was verified on (${VERIFIED_CLAUDE_VERSIONS.join(', ')}); --channels is hidden from --help during the research preview, so support cannot be confirmed offline`, hint: 'Use the Claude Code version pinned by the minions image (docs/compatibility.md).' } };
}

function bunItem(f: TelegramFacts): ProbeItem {
  if (f.bun.code === 0) return { name: 'bun', status: 'ok', detail: `Bun ${short(f.bun.stdout)}` };
  return { name: 'bun', status: 'missing', detail: 'Bun is not installed: the official Telegram channel plugin runs its MCP server with `bun` (and installs its npm dependencies with `bun install` at start)',
    hint: 'The minions image does not ship Bun yet; it is added with Telegram startup integration (docs/design/telegram.md).' };
}

function marketplaceItem(f: TelegramFacts): ProbeItem {
  const list = parseJsonArray(f.marketplaces);
  if (typeof list === 'string') return { name: 'marketplace', status: 'unknown', detail: `\`claude plugin marketplace list --json\` failed: ${list}` };
  const m = list.find((x) => isObj(x) && x.name === OFFICIAL_MARKETPLACE);
  if (!isObj(m)) {
    return { name: 'marketplace', status: 'missing', detail: `marketplace "${OFFICIAL_MARKETPLACE}" is not configured`, hint: `claude plugin marketplace add ${OFFICIAL_MARKETPLACE_REPO}` };
  }
  if (m.source === 'github' && typeof m.repo === 'string' && m.repo.toLowerCase() !== OFFICIAL_MARKETPLACE_REPO) {
    return { name: 'marketplace', status: 'blocked', detail: `marketplace "${OFFICIAL_MARKETPLACE}" points at ${m.repo}, not ${OFFICIAL_MARKETPLACE_REPO}`,
      hint: `claude plugin marketplace remove ${OFFICIAL_MARKETPLACE} && claude plugin marketplace add ${OFFICIAL_MARKETPLACE_REPO}` };
  }
  return { name: 'marketplace', status: 'ok', detail: `${OFFICIAL_MARKETPLACE} (${typeof m.repo === 'string' ? m.repo : String(m.source ?? 'unknown source')})` };
}

function pluginItem(f: TelegramFacts): ProbeItem {
  const list = parseJsonArray(f.plugins);
  if (typeof list === 'string') return { name: 'plugin', status: 'unknown', detail: `\`claude plugin list --json\` failed: ${list}` };
  const p = list.find((x) => isObj(x) && x.id === TELEGRAM_PLUGIN_ID);
  if (!isObj(p)) {
    return { name: 'plugin', status: 'missing', detail: `${TELEGRAM_PLUGIN_ID} is not installed`, hint: `claude plugin install ${TELEGRAM_PLUGIN_ID} --scope user` };
  }
  const where = `${TELEGRAM_PLUGIN_ID} ${typeof p.version === 'string' ? p.version : '(unknown version)'} (scope ${String(p.scope ?? '?')})`;
  if (p.enabled === false) return { name: 'plugin', status: 'missing', detail: `${where} is installed but disabled`, hint: `claude plugin enable ${TELEGRAM_PLUGIN_ID}` };
  const refused = Array.isArray(p.noteDetails) && p.noteDetails.some((n) => isObj(n) && n.type === 'dependencies-refused');
  return { name: 'plugin', status: 'ok', detail: `${where} installed and enabled${refused ? '; Claude Code reported its dependencies were not installed (Bun missing at install time)' : ''}` };
}

function policyItem(f: TelegramFacts): ProbeItem {
  const m = f.managed;
  if (!m.present) {
    return { name: 'org.policy', status: 'unknown', detail: `no file-based managed settings at ${MANAGED_SETTINGS_PATH}; server-managed and plan-default policy is checked only at launch` };
  }
  if ('error' in m) return { name: 'org.policy', status: 'unknown', detail: `managed settings at ${MANAGED_SETTINGS_PATH} ${m.error}` };
  const s = isObj(m.json) ? m.json : {};
  if (s.channelsEnabled !== true) {
    return { name: 'org.policy', status: 'blocked', detail: `managed settings at ${MANAGED_SETTINGS_PATH} do not set channelsEnabled: true, so no channel can deliver messages`,
      hint: 'Ask an organization admin to enable channels (managed setting channelsEnabled). Terminal mode keeps working.' };
  }
  if (Array.isArray(s.allowedChannelPlugins)) {
    const allowed = s.allowedChannelPlugins.some((e) => isObj(e) && e.plugin === 'telegram' && e.marketplace === OFFICIAL_MARKETPLACE);
    if (!allowed) {
      return { name: 'org.policy', status: 'blocked', detail: `managed settings allowedChannelPlugins does not include telegram from ${OFFICIAL_MARKETPLACE}`,
        hint: `Ask an organization admin to add { "marketplace": "${OFFICIAL_MARKETPLACE}", "plugin": "telegram" } to allowedChannelPlugins.` };
    }
    return { name: 'org.policy', status: 'ok', detail: 'managed settings enable channels and allow the Telegram plugin' };
  }
  return { name: 'org.policy', status: 'ok', detail: 'managed settings enable channels (Anthropic default plugin allowlist applies)' };
}

/** Pure evaluation of gathered facts. Order of precedence: blocked > unavailable > not-installed > available. */
export function evaluateTelegram(f: TelegramFacts): TelegramProbeReport {
  const { item: claude, version } = claudeItem(f);
  const items = [claude, bunItem(f), marketplaceItem(f), pluginItem(f), policyItem(f)];
  const by = (n: string) => items.find((i) => i.name === n)!;
  const firstBad = (names: string[], status: ProbeItemStatus) => names.map(by).find((i) => i.status === status);
  let availability: TelegramAvailability;
  let reason: ProbeItem | undefined;
  if ((reason = items.find((i) => i.status === 'blocked'))) availability = 'blocked';
  else if ((reason = firstBad(['claude', 'bun'], 'missing'))) availability = 'unavailable';
  else if ((reason = firstBad(['marketplace', 'plugin'], 'missing') ?? firstBad(['marketplace', 'plugin'], 'unknown'))) availability = 'not-installed';
  else availability = 'available';
  const summary = availability === 'available'
    ? `Telegram channel plugin ${TELEGRAM_PLUGIN_ID} is installed and launchable with --channels ${TELEGRAM_CHANNEL_SPEC} (credentials and pairing not checked)`
    : `Telegram channel ${availability}: ${reason!.detail}`;
  return { availability, available: availability === 'available', summary, channelSpec: TELEGRAM_CHANNEL_SPEC, claudeVersion: version, items, unverified: [...UNVERIFIED] };
}

export async function probeTelegram(opts: Parameters<typeof gatherTelegramFacts>[0] = {}): Promise<TelegramProbeReport> {
  return evaluateTelegram(await gatherTelegramFacts(opts));
}

export function formatTelegramProbe(r: TelegramProbeReport): string {
  const L = [r.summary, ...r.items.map((i) => `  [${i.status.padEnd(7)}] ${i.name}: ${i.detail}${i.hint ? `\n             hint: ${i.hint}` : ''}`)];
  L.push('  not verified without credentials:', ...r.unverified.map((u) => `    - ${u}`));
  return L.join('\n');
}

/** Host doctor: maps the in-container `minions telegram probe --json` result to a doctor check. Never 'fail': terminal mode must stay usable. */
export function telegramDoctorCheck(r: RunResult): { status: 'ok' | 'warn' | 'unavailable'; detail: string; hint?: string } {
  if (r.code !== 0) {
    return { status: 'warn', detail: `telegram probe failed (exit ${r.code}): ${short(r.stderr || r.stdout) || 'no output'}`, hint: '`minions start` rebuilds an outdated image.' };
  }
  let report: TelegramProbeReport | undefined;
  try {
    const env = JSON.parse(r.stdout) as unknown;
    const data = isObj(env) && env.ok === true ? env.data : undefined;
    if (isObj(data) && typeof data.availability === 'string' && typeof data.summary === 'string' && Array.isArray(data.items)) report = data as unknown as TelegramProbeReport;
  } catch { /* handled below */ }
  if (!report) return { status: 'warn', detail: `telegram probe returned unexpected output: ${short(r.stdout) || 'no output'}` };
  if (report.available) return { status: 'ok', detail: redact(report.summary) };
  const reason = report.items.find((i) => i.status === 'blocked') ?? report.items.find((i) => i.status === 'missing') ?? report.items.find((i) => i.status === 'unknown');
  return { status: 'unavailable', detail: redact(report.summary), ...(reason?.hint ? { hint: redact(reason.hint) } : {}) };
}
