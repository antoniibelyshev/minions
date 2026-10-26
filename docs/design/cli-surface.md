# User-facing CLI surface

Status: implemented (task-12). Code: `src/surface.ts`, applied in `src/program.ts`. Guard test:
`test/cli-surface.test.ts`. Full reference: [../cli.md](../cli.md).

## Problem

`minions --help` listed 23 top-level commands that mixed user commands, single setup steps, and
helpers that only the coordinator, workers, hooks or the container call. The owner wants a user to
install and use minions knowing only a handful of commands.

## Decision

Every top-level command belongs to exactly one tier:

| Tier | Commands | Listed by |
| - | - | - |
| Primary | `setup`, `start`, `status`, `settings`, `upgrade`, `down` (alias `stop`), `uninstall` (+ `help`) | `minions --help`, `minions help`, README quick start and everyday use |
| Advanced | `init`, `doctor`, `auth`, `config`, `channel`, `runtime`, `import`, `export`, `pause`, `resume` | `minions help --all`, docs/cli.md |
| Internal | `work`, `backlog`, `hook`, `coordinator`, `telegram`, `workspace`, `sync`, `ci`, `notify`, `manager` | `minions help --all`, docs/cli.md |
| Unlisted | `git-credential` (git credential-helper protocol entry point) | nowhere (already hidden before this change) |

Rationale for the primary set (seven commands, the lifecycle of an installation):

- `setup` installs, configures and reconfigures. It already runs `init`, `auth github`,
  `auth telegram`, CI guidance, `start` and `import` in order and is safe to rerun, so those become
  advanced single steps.
- `start` resumes work after a reboot or a `down` and attaches to the coordinator.
- `status` is the one "how is it going" command. `status --check` runs the host health checks
  (the same report as `doctor`), so users don't need `doctor` as a separate name.
- `settings` (task-23) is the everyday settings menu (`--list` / `set <key> <value>` for scripts); `setup`
  stays the first-time and integration wizard. `config` is an advanced alias (`config show`, `list`, `set`).
- `upgrade` (task-3.2) moves a running team onto the installed version.
- `down` stops the team; `stop` is an alias because that is the word users look for (the README
  previously listed `minions stop` as planned).
- `uninstall` removes the installation.

`pause` / `resume` are advanced rather than primary: the coordinator handles "pause new tasks" in
conversation, and the commands remain available. `sync` and `ci` are internal: the coordinator runs
them as part of PR delivery.

## Mechanics

- Hiding is help-text only. Tiers are applied after all commands are registered: each command gets a
  commander help group, and the root help's `visibleCommands` keeps only the primary tier unless
  `minions help --all` is running. Nothing is removed or renamed, no flags change, and subcommand
  help (`minions work --help`) is unchanged, so agents, hooks, install.sh and docs keep working.
- The implicit commander help command is replaced by `help [command...] [--all]`:
  `minions help work claim` shows nested help, `minions help --all --json` returns the tiers.
- The default help ends with a pointer to `minions help --all` and docs/cli.md.

## Guard

`test/cli-surface.test.ts`:

- pins the set of commands in the default help (adding or promoting a command is an explicit change
  to that test, `src/surface.ts`, this document and the README);
- fails when a registered top-level command has no tier;
- checks that hidden commands still dispatch (subcommand help, and runtime-only actions failing
  closed on the host rather than commander reporting an unknown command);
- resolves every `minions <command> [<subcommand>]` invocation in the generated plugin (all
  profiles), install.sh, the setup assistant templates and the container scripts against the real
  program.

## Not done here

- No command was removed, renamed or merged; `init` and `doctor` stay as advanced commands with their
  current behaviour (back-compat).
- `setup` was not changed; it already covers the non-interactive path of `init` (`--yes`, `--config`).
