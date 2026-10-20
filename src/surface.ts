import { Help, type Command, type Option } from 'commander';
import { action } from './core/cli-helpers.js';
import { MinionsError } from './core/errors.js';
import { emit } from './core/output.js';

/**
 * The user-facing CLI surface (docs/design/cli-surface.md).
 *
 * Every top-level command belongs to exactly one tier. Only the primary tier is listed by the
 * default `minions --help`; `minions help --all` lists every tier. Hiding a command from the
 * default help never disables it: agents, hooks, install.sh and docs keep calling it as before.
 * Adding a top-level command requires classifying it here (test/cli-surface.test.ts pins this).
 */
export const PRIMARY_COMMANDS = ['setup', 'start', 'status', 'upgrade', 'down', 'uninstall'] as const;
/** User commands for single steps and fine-grained control (shown by `minions help --all`). */
export const ADVANCED_COMMANDS = ['init', 'doctor', 'auth', 'config', 'channel', 'runtime', 'import', 'export', 'pause', 'resume'] as const;
/** Used by the coordinator, workers, hooks and the container (shown by `minions help --all`). */
export const INTERNAL_COMMANDS = ['work', 'backlog', 'hook', 'coordinator', 'telegram', 'workspace', 'sync', 'ci'] as const;
/** Never listed, not even by `help --all` (a git credential helper protocol entry point). */
export const UNLISTED_COMMANDS = ['git-credential'] as const;

export type Tier = 'primary' | 'advanced' | 'internal' | 'unlisted';

const HEADINGS: Record<Exclude<Tier, 'unlisted'>, string> = {
  primary: 'Commands:',
  advanced: 'Advanced commands:',
  internal: 'Internal commands (used by the coordinator, agents and the container):',
};
const LISTING_ORDER: readonly string[] = [...PRIMARY_COMMANDS, 'help', ...ADVANCED_COMMANDS, ...INTERNAL_COMMANDS];
const HEADING_ORDER = [HEADINGS.primary, HEADINGS.advanced, HEADINGS.internal];

export function tierOf(name: string): Tier | undefined {
  const has = (list: readonly string[]) => list.includes(name);
  if (has(PRIMARY_COMMANDS) || name === 'help') return 'primary';
  if (has(ADVANCED_COMMANDS)) return 'advanced';
  if (has(INTERNAL_COMMANDS)) return 'internal';
  if (has(UNLISTED_COMMANDS)) return 'unlisted';
  return undefined;
}

const FOOTER = '\nRun `minions help --all` for advanced and internal commands, `minions help <command>` for details.\n'
  + 'Full reference: docs/cli.md\n';

/**
 * Applies the surface to the root program: groups the top-level commands, filters the default
 * help down to the primary tier, and replaces the implicit help command with `help [command...] [--all]`.
 * Call after every top-level command is registered.
 */
export function applySurface(program: Command): void {
  let showAll = false;
  for (const c of program.commands) {
    const tier = tierOf(c.name());
    if (tier && tier !== 'unlisted') c.helpGroup(HEADINGS[tier]);
  }
  program.helpCommand(false);
  program.command('help [command...]')
    .description('Show help; --all also lists advanced and internal commands')
    .option('--all', 'list every command, grouped')
    .helpGroup(HEADINGS.primary)
    .action(action((path: string[], o: { all?: boolean }, cmd: Command) => {
      if (path.length === 0) {
        if ((cmd.optsWithGlobals() as { json?: boolean }).json) {
          emit(surfaceListing(program, !!o.all), { json: true, human: () => '' });
          return;
        }
        showAll = !!o.all;
        try { program.outputHelp(); } finally { showAll = false; }
        return;
      }
      let target: Command = program;
      for (const name of path) {
        const next = target.commands.find((c) => c.name() === name || c.aliases().includes(name));
        if (!next) throw new MinionsError('NOT_FOUND', `Unknown command: minions ${path.join(' ')}`, 'Run `minions help --all` to list every command.');
        target = next;
      }
      target.outputHelp();
    }));
  program.configureHelp({
    visibleCommands(cmd: Command): Command[] {
      const all = Help.prototype.visibleCommands.call(this, cmd);
      if (cmd !== program) return all;
      const rank = (c: Command) => LISTING_ORDER.indexOf(c.name());
      return all
        .filter((c) => (showAll ? tierOf(c.name()) !== undefined && tierOf(c.name()) !== 'unlisted' : tierOf(c.name()) === 'primary'))
        .sort((a, b) => rank(a) - rank(b));
    },
    groupItems<T extends Command | Option>(unsorted: T[], visible: T[], getGroup: (item: T) => string): Map<string, T[]> {
      const groups = Help.prototype.groupItems.call(this, unsorted, visible, getGroup as (item: Command | Option) => string) as Map<string, T[]>;
      // Fixed order of the command tiers (commander orders groups by registration order).
      const ordered = new Map<string, T[]>();
      for (const h of HEADING_ORDER) if (groups.has(h)) ordered.set(h, groups.get(h)!);
      for (const [h, items] of groups) if (!ordered.has(h)) ordered.set(h, items);
      return ordered;
    },
  });
  program.addHelpText('after', ({ command }) => (command === program && !showAll ? FOOTER : ''));
}

export interface SurfaceListing { primary: string[]; advanced?: string[]; internal?: string[] }

/** Machine-readable listing for `minions help [--all] --json`. */
export function surfaceListing(program: Command, all: boolean): SurfaceListing {
  const names = (tier: Tier) => LISTING_ORDER.filter((n) => n !== 'help' && tierOf(n) === tier && program.commands.some((c) => c.name() === n));
  return all ? { primary: names('primary'), advanced: names('advanced'), internal: names('internal') } : { primary: names('primary') };
}
