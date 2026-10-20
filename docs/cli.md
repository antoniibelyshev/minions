# minions CLI reference

The README lists only the everyday commands. This page lists every command, grouped the same way
as `minions help --all`. The grouping is a help-text decision only: every command below works the
same whether or not the default `minions --help` lists it. The rationale is in
[design/cli-surface.md](design/cli-surface.md).

- `minions --help` (or `minions help`) lists the primary commands.
- `minions help --all` also lists the advanced and internal commands (`--json` returns the groups).
- `minions help <command> [<subcommand>]` (or `minions <command> --help`) shows the details of one command.

## Primary commands

These are the only commands most users need.

| Command | Purpose |
| - | - |
| `minions setup [path]` | Guided end-to-end setup: init wizard (including the runtime and Claude authorization), the guided GitHub flow (remote, base branch, token) and delivery mode, CI guidance, auto-merge (not available yet), Telegram, runtime start, import, coordinator launch, attach and pairing instructions, then an offer to open the setup assistant (`--yes`, `--dry-run`, `--delivery`, `--github-token-stdin`, `--telegram-token-stdin`, `--no-attach-coordinator`, `--no-assistant`; `--config`, `--attach`, `--new-identity`, `--runtime` as for `init`) |
| `minions setup github` | Guided GitHub setup: remote, base branch on the remote, pre-filled fine-grained token, delivery mode (`--yes` prints the next steps only; see [GitHub setup](../README.md#github-setup)) |
| `minions setup assist` | AI setup assistant: opens your host Claude Code with a minions setup skill to finish the remaining setup (interactive; `--dry-run` prints the command; see [Setup assistant](../README.md#setup-assistant)) |
| `minions start` | Build the image if needed, start the container, import the repo, attach the coordinator (`--no-attach`) |
| `minions status [--check]` | Queue, workers, pause state, config revision, delivery mode, channel (configured vs effective). `--check` runs the host health checks instead (same as `minions doctor`) |
| `minions upgrade [--timeout <s>] [--now] [--from-container [branch]] [--rebuild-cli] [--dry-run]` | Move the running container onto the installed minions: pause starts, wait for active workers (or release them with `--now`, reported as interrupted), rebuild the image only if the package changed, recreate the container with volumes kept, restart the coordinator with recovery, resume starts. With `--from-container` (`local` delivery only), first export the container branches and fast-forward `branch` (default: the base branch) to `minions/<base>`; this happens only on a strict fast-forward with clean working trees, and the command never merges, resets or force-updates. When the project is a minions checkout and the installed CLI differs from it, the upgrade stops and prints the rebuild command; with `--rebuild-cli` (you reviewed the checkout: this runs its npm scripts and build on the host) the CLI is rebuilt (linked install) or reinstalled (`install.sh` install) and the rest runs on the new CLI. Commits just taken with `--from-container` are never built in the same run. With `branch` / `pull-request` delivery the CLI comes only from the reviewed `origin/<base>` commit: the upgrade fetches origin, fast-forwards the base, and refuses `--from-container` (see [Delivery, review, and merging](../README.md#delivery-review-and-merging)). For other installs, such as git-URL ones, it prints the exact command and stops before touching the container. Docker runtime only: in the host runtime it refuses and points to `minions down && minions start` |
| `minions down` (alias `stop`) | Stop and remove the project container (volumes kept), or stop the host runtime's tmux server |
| `minions uninstall` | Remove owned files while keeping task data (`--delete-data` also deletes volumes) |

## Advanced commands

Single setup steps and fine-grained control. `minions setup` runs `init`, `auth github`,
`auth telegram`, `start` and `import` for you, and rerunning `minions setup` changes any of
those choices. `minions doctor` is the same check as `minions status --check`.

| Command | Purpose |
| - | - |
| `minions init [path]` | Inspect and initialize a project (`--private` / `--shared`, `--runtime docker\|host`, `--yes`, `--dry-run`) |
| `minions doctor` | Check tools, Docker (or the host runtime's tmux/claude/backlog/git), image, container, Claude auth, backlog CLI, and deferred features |
| `minions auth show` / `set <login\|api-key\|helper\|jbcentral>` / `refresh` | Host-side Claude authorization (see [Claude authorization](../README.md#claude-authorization)) |
| `minions auth github` / `telegram` | Store (or `--remove`) the project's GitHub token / Telegram bot token on the host; prompted without echo or `--stdin` (`telegram` offers to switch a `terminal` channel to `auto`) |
| `minions config show [--explain]` | Effective values and their provenance |
| `minions channel show` / `set <auto\|terminal\|telegram>` | Configured vs effective communication channel; set it in the project config (`configRevision` bump, `--yes`, `--dry-run`; restart-required; see [Communication](../README.md#communication)) |
| `minions runtime show` / `set <docker\|host>` | Host-side agent runtime: Docker (default) or the less safe host runtime (`--global`, `--yes`, `--dry-run`; see [Running without Docker](../README.md#running-without-docker)) |
| `minions import` | Refresh the container workspace from the committed base branch (Git bundle) |
| `minions export` | Fetch `agent/*` branches into `refs/remotes/minions/*` in your repository; local branches are untouched |
| `minions pause` / `resume` | Persist scheduling controls. `--intake` / `--starts` select one (default: both). Paused starts stop new task starts; paused intake makes `minions backlog create` refuse new work from requests or tickets (`POLICY_DENIED`), while creation from existing work stays allowed: a `--parent`, a `split:` / `followup:` / `qa:` idempotency key, or provenance `observed-result` (keys starting with `intake:` are always refused) |

## Internal commands

Used by the coordinator, the workers, the Claude Code hooks and the container. You normally don't
run these yourself. They are not listed by the default help.

| Command | Purpose |
| - | - |
| `minions work claim` / `record` / `release` / `list` | Leases and worker results (used by the coordinator, inside the container) |
| `minions work publish <taskId>` | Publish (or retry publishing) an approved task in branch / pull-request delivery; idempotent |
| `minions work approve <taskId> --head <sha>` | Record your approval to publish that exact commit (sensitive paths, or `ask` publication) |
| `minions backlog ready` / `list` / `show` / `create` / `update` / `note` / `export` | Backend-neutral task operations (inside the container) |
| `minions sync [taskIds...]` | Refresh PR state and CI check results for tasks with a PR; reconcile merged/closed PRs (read-only on GitHub) |
| `minions ci status` | Required status checks on the base branch and the external CI setup plan (read-only) |
| `minions hook stop` / `pre-agent` / `pre-telegram` | Claude Code hook handlers (container only) |
| `minions coordinator` / `coordinator run` / `sync` / `restart` | Attach or launch the coordinator session; restart it (`minions start` attaches for you) |
| `minions telegram probe` / `install` / `status` | Telegram channel plugin support (see [design/telegram.md](design/telegram.md)) |
| `minions workspace setup` / `import` / `export` | Container workspace and state setup (container only) |

## Conventions

Planned, **deferred in v0.1**: `minions config plan` / `apply`, `minions review publish`, `minions merge request`, `minions migrate backlog`, and the plan/migration parts of `minions upgrade`.

Every command supports `--json`, and mutating commands support `--dry-run`. Exit code 0 means the requested operation completed; it does not mean a whole task passed. Errors use stable codes for auth required, conflict, policy denied, invalid configuration, incompatible runtime, and retryable network failure. Secrets and large task text go through stdin or restricted temporary files, never through process arguments.
