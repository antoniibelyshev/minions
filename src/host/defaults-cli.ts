// `minions defaults show|set|unset` (host only): <MINIONS_HOME>/defaults.json, the answers `minions init` takes instead
// of asking. Claude authorization reuses `minions auth set --global` (buildAuth); the runtime default stays with
// `minions runtime set --global`.
import { Argument, type Command } from 'commander';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { defaultsPath } from '../core/paths.js';
import { AUTH_SET_METHODS, buildAuth } from './auth-cli.js';
import { DefaultsSchema, loadDefaults, saveDefaults, summarize, type Defaults } from './auth.js';

export const DEFAULT_KEYS = ['auth', 'git.name', 'git.email', 'telegram.owner'] as const;
export type DefaultKey = (typeof DEFAULT_KEYS)[number];

export interface DefaultsView { path: string; auth: string | null; runtime: string | null; git: { name: string | null; email: string | null }; telegram: { owner: string | null } }

const view = (d: Defaults): DefaultsView => ({
  path: defaultsPath(),
  auth: d.claudeAuth ? `${d.claudeAuth.method}${d.claudeAuth.preset ? ` (preset ${d.claudeAuth.preset})` : ''}: ${summarize(d.claudeAuth).source}` : null,
  runtime: d.runtime ?? null,
  git: { name: d.git?.name ?? null, email: d.git?.email ?? null },
  telegram: { owner: d.telegram?.owner ?? null },
});

/** Sets (value) or removes (undefined) one default; validated before anything is written. */
export async function runDefaultsSet(key: string, value: string | undefined, deps: { home?: string } = {}): Promise<DefaultsView> {
  if (!(DEFAULT_KEYS as readonly string[]).includes(key)) throw new MinionsError('INVALID_CONFIG', `Unknown default "${key}".`, `Use one of: ${DEFAULT_KEYS.join(', ')}.`);
  const d = structuredClone(await loadDefaults());
  const k = key as DefaultKey;
  if (k === 'auth') {
    if (value === undefined) delete d.claudeAuth;
    else {
      try { d.claudeAuth = await buildAuth(value, [], {}, { home: deps.home }); } catch (e) {
        throw new MinionsError('INVALID_CONFIG', `auth ${value}: ${(e as Error).message}`, `Methods with a source or a command need their flags: \`minions auth set <method> --global ...\` (${AUTH_SET_METHODS.join(', ')}).`);
      }
    }
  } else {
    const [section, field] = k.split('.') as ['git' | 'telegram', string];
    const sec: Record<string, string> = { ...(d[section] ?? {}) };
    if (value === undefined) delete sec[field]; else sec[field] = value.trim();
    if (Object.keys(sec).length) (d as Record<string, unknown>)[section] = sec; else delete d[section];
  }
  const parsed = DefaultsSchema.safeParse(d);
  if (!parsed.success) throw new MinionsError('INVALID_CONFIG', `${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}.`);
  await saveDefaults(parsed.data);
  return view(parsed.data);
}

export function formatDefaults(v: DefaultsView): string {
  const show = (x: string | null) => x ?? '(unset)';
  return [
    `Defaults for new projects (${v.path}):`,
    `  auth            ${show(v.auth)}`,
    `  runtime         ${show(v.runtime)}  (\`minions runtime set --global\`)`,
    `  git.name        ${show(v.git.name)}`,
    `  git.email       ${show(v.git.email)}`,
    `  telegram.owner  ${show(v.telegram.owner)}`,
  ].join('\n');
}

export function registerDefaults(program: Command): Command {
  const df = program.command('defaults').description('Host-wide answers for `minions init`: Claude auth, git identity of agent commits, Telegram owner');
  df.command('show').description('Show the defaults new projects take')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      emit(view(await loadDefaults()), { json: globalOpts(cmd).json, human: formatDefaults });
    }));
  df.command('set').description('Set a default: auth <method>, git.name <name>, git.email <email>, telegram.owner <Telegram user id>')
    .addArgument(new Argument('<key>', DEFAULT_KEYS.join(' | ')).choices([...DEFAULT_KEYS]))
    .argument('<value>')
    .action(action(async (key: string, value: string, _o: unknown, cmd: Command) => {
      requireMode('host');
      emit(await runDefaultsSet(key, value), { json: globalOpts(cmd).json, human: formatDefaults });
    }));
  df.command('unset').description('Remove a default')
    .addArgument(new Argument('<key>', DEFAULT_KEYS.join(' | ')).choices([...DEFAULT_KEYS]))
    .action(action(async (key: string, _o: unknown, cmd: Command) => {
      requireMode('host');
      emit(await runDefaultsSet(key, undefined), { json: globalOpts(cmd).json, human: formatDefaults });
    }));
  return df;
}
