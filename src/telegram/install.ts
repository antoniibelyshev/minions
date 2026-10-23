// `minions telegram install` (container): installs the official Telegram channel plugin at user
// scope into the project's claude volume (CLAUDE_CONFIG_DIR). It is never loaded with --plugin-dir,
// so the channel keeps its allowlisted id plugin:telegram@claude-plugins-official. Never re-enables it
// at user scope (only the coordinator launch enables it, task-51). Never updates an
// installed plugin (`claude plugin update` stays an explicit user action). Needs network, no login.
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { redact } from '../core/output.js';
import { OFFICIAL_MARKETPLACE, OFFICIAL_MARKETPLACE_REPO, TELEGRAM_PLUGIN_ID, type Runner } from './probe.js';

/** Plugin versions whose interface was verified (docs/compatibility.md). */
export const VERIFIED_PLUGIN_VERSIONS: readonly string[] = ['0.0.7'];

export interface TelegramInstallResult {
  marketplace: 'present' | 'added';
  plugin: 'present' | 'installed';
  version: string | null;
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const tail = (s: string) => redact(s.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '').slice(0, 300);

async function list(runner: Runner, args: string[]): Promise<unknown[]> {
  const r = await runner('claude', args, { allowFailure: true, timeoutMs: 60_000 });
  if (r.code !== 0) throw new MinionsError('INCOMPATIBLE_RUNTIME', `\`claude ${args.join(' ')}\` failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`);
  try {
    const v = JSON.parse(r.stdout) as unknown;
    if (Array.isArray(v)) return v;
  } catch { /* below */ }
  throw new MinionsError('INCOMPATIBLE_RUNTIME', `\`claude ${args.join(' ')}\` returned unexpected output.`, 'Use the Claude Code version pinned by the minions image.');
}

async function step(runner: Runner, args: string[], what: string): Promise<void> {
  const r = await runner('claude', args, { allowFailure: true, timeoutMs: 300_000 });
  if (r.code !== 0) {
    throw new MinionsError('PRECONDITION', `${what} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`,
      'Check outbound network access from the container (github.com for the marketplace). Terminal mode keeps working.');
  }
}

export async function installTelegramPlugin(opts: { runner?: Runner } = {}): Promise<TelegramInstallResult> {
  const runner = opts.runner ?? run;
  const warnings: string[] = [];
  let marketplace: TelegramInstallResult['marketplace'] = 'present';
  const m = (await list(runner, ['plugin', 'marketplace', 'list', '--json'])).find((x) => isObj(x) && x.name === OFFICIAL_MARKETPLACE);
  if (!isObj(m)) {
    await step(runner, ['plugin', 'marketplace', 'add', OFFICIAL_MARKETPLACE_REPO], `Adding the ${OFFICIAL_MARKETPLACE} marketplace`);
    marketplace = 'added';
  } else if (m.source === 'github' && typeof m.repo === 'string' && m.repo.toLowerCase() !== OFFICIAL_MARKETPLACE_REPO) {
    throw new MinionsError('POLICY_DENIED', `Marketplace "${OFFICIAL_MARKETPLACE}" points at ${m.repo}, not ${OFFICIAL_MARKETPLACE_REPO}; refusing to install from it.`,
      `claude plugin marketplace remove ${OFFICIAL_MARKETPLACE} && claude plugin marketplace add ${OFFICIAL_MARKETPLACE_REPO}`);
  }
  const find = async () => (await list(runner, ['plugin', 'list', '--json'])).find((x) => isObj(x) && x.id === TELEGRAM_PLUGIN_ID) as Record<string, unknown> | undefined;
  let p = await find();
  let plugin: TelegramInstallResult['plugin'] = 'present';
  if (!p) {
    await step(runner, ['plugin', 'install', TELEGRAM_PLUGIN_ID, '--scope', 'user'], `Installing ${TELEGRAM_PLUGIN_ID}`);
    plugin = 'installed';
    p = await find();
    if (!p) throw new MinionsError('INCOMPATIBLE_RUNTIME', `${TELEGRAM_PLUGIN_ID} is not listed after installation.`);
  }
  // Off at user scope is intended (task-51, src/telegram/isolation.ts): never re-enabled here. The
  // coordinator launch turns it off at user scope and enables it for itself only.
  const version = typeof p.version === 'string' ? p.version : null;
  if (!version || !VERIFIED_PLUGIN_VERSIONS.includes(version)) {
    warnings.push(`${TELEGRAM_PLUGIN_ID} ${version ?? '(unknown version)'} is not a verified version (${VERIFIED_PLUGIN_VERSIONS.join(', ')}); behavior may differ (docs/compatibility.md).`);
  }
  return { marketplace, plugin, version, warnings };
}
