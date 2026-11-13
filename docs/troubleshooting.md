# Troubleshooting and recovery

Common failures and the exact commands that fix them. Run every command on the host, in your
project checkout, unless a step says otherwise. Two commands are always the first step:

```sh
minions status            # queue, workers (leases), pause/drain state, channel, restart-required
minions status --check    # host health checks (same as `minions doctor`); --json for details
```

Everything below works from the terminal without Claude. See [cli.md](cli.md) for every command.

## Before risky steps: back up the runtime state

The backlog, notes, worker briefs and results, and the runtime database (leases, events, approvals,
publications, outbox, pause controls) live in the project's `state` volume (host runtime:
`<project>/host/state`). Back them up before an upgrade or any manual repair:

```sh
minions export --state                       # writes <project>/exports/state-<time>.tar.gz
minions export --state ~/backups/proj.tar.gz # or an explicit file (never overwritten)
minions export --state --dry-run             # what is included and excluded
```

The archive is a tarball with a `manifest.json` (format version, creation time, minions version, DB
schema version, every file's size and sha256) and a consistent snapshot of the runtime database
(`VACUUM INTO`, safe while the runtime is running). It never contains secrets: tokens, the Claude key
and the Claude login are not in the state volume, and as a safeguard symlinks, hard-linked files,
secret-like names (`.env`, `*.pem`, ...) and files that contain a mounted token are skipped and
listed in the manifest. `import/`, `exports/`, `logs/`, caches and the workspace (clone and
worktrees; use `minions export` for branches) are not included.

Restore into a running runtime (for example a fresh project volume after `minions start --no-attach`):

```sh
minions import --state ~/backups/proj.tar.gz --dry-run   # validate the archive only
minions import --state ~/backups/proj.tar.gz
```

The archive is validated on the host and again in the runtime (manifest, checksums, allowed paths,
regular files only, DB integrity and schema) before anything changes. The restore is refused
(`CONFLICT`) while a worker lease is active, a live coordinator holds the project lock, or the session
supervisor (`minions coordinator supervise`) or autopilot dispatcher (`minions work dispatch`) runs: let the
workers finish or cancel them (`minions work cancel --all`), then rerun; or pass `--force`. A forced
restore stops a running supervisor and dispatcher (SIGTERM, only the process its lock names, checked by pid
and start time) right before it swaps the database in; the coordinator starts them again on the restored
state. One that does not exit in time keeps its lock row in the restored DB and exits by itself once it
notices the database file was replaced. Before a forced restore run `minions pause --starts`: a still-running
coordinator could otherwise claim new leases before the restart.

Leases the backup has marked active are released by the restore (no worker holds them in this
runtime), and their tasks go back to the queue; worktrees and branches are kept. After `--force`,
workers that were still running lose their lease (their submit is refused), and the running
coordinator keeps the project lock (its lock row is carried into the restored DB, so no second
coordinator can start). Then run `minions settings restart`: it restarts the coordinator with the
recovery prompt (`/minions:recover`), which re-dispatches the released tasks. The replaced state is
moved to `<state>/pre-restore/<time>/` inside the runtime; the newest three copies are kept, older ones
are removed. The archive copies in the runtime import and export dirs are removed after use.
Open upgrade requests in the backup were made for the runtime that wrote it (for example a container
recreate for new apt packages): restored into the other runtime (Docker to host, or back) they are
marked `rejected` as obsolete; from an older backup that does not record its runtime they are marked
`expired`. Check with `minions settings requests --all`.

## Docker is not running

Symptoms: `minions start` fails with `DOCKER_UNAVAILABLE` or "Cannot connect to the Docker daemon";
`minions status --check` fails its Docker check.

```sh
open -a Docker            # macOS Docker Desktop (or: colima start / sudo systemctl start docker)
minions status --check    # the Docker check must pass
minions start             # recreates the container if needed (volumes are kept) and attaches
```

Your work is not lost: the clone, worktrees, backlog, runtime database and Claude login are in named
volumes that survive container and Docker restarts. Never run `docker compose down -v` or
`minions uninstall --delete-data` to "fix" a start: they delete those volumes.

## Claude authorization expired

Symptoms: the coordinator or workers report authentication errors, `minions start` exits with
`AUTH_REQUIRED`, `minions status --check` fails its Claude auth check.

- `login` method (default): attach and log in again inside the coordinator session.

  ```sh
  minions start             # attaches to the coordinator
  # then type /login in the coordinator session
  ```

- `api-key` / `helper` / `jbcentral`: re-read the key source on the host.

  ```sh
  minions auth show         # method, source, key file status and the last refresh (never the key)
  minions auth refresh      # re-run the helper / re-read the source now
  ```

  For `jbcentral`, make sure the Central proxy works on the host (`central proxy start --ensure-updated`)
  and rerun `minions auth refresh`. To switch methods: `minions auth set <login|api-key|helper|jbcentral>`,
  then `minions down && minions start`.

## The coordinator died or is unresponsive

Symptoms: `minions status` shows no coordinator, Telegram stops answering, the tmux session is gone.

```sh
minions status                  # are workers still active? is a drain or pause set?
minions start                   # relaunches (or attaches to) the coordinator; recovery runs first
minions settings restart        # graceful restart of a running but stuck coordinator (refused while workers are active)
```

On start the coordinator reconciles leases, branches and completed external actions before it retries
anything, and reads its handoff (`minions coordinator handoff --read` inside the runtime). The last exit
reason is recorded in `<state>/coordinator-exit.json`; restarts done for context resets log to
`<state>/logs/context-reset.log`. If `minions start` says another coordinator holds the project lock,
attach to it with `minions start` instead of launching a second one.

## Orphaned supervisor or dispatcher after a state restore

Symptoms (host runtime): `minions doctor` warns `helpers.orphans: N orphaned helper process(es)`; `ps`
shows more than one `minions coordinator supervise` or `minions work dispatch` for the project, some of
them days old; sessions or autopilot workers act on state that no longer matches `minions status`.

A state restore (`minions import --state`) moves the live database to `<state>/pre-restore/<time>/` and
swaps the backup in. A supervisor or dispatcher that was running keeps the old database file open and
still sees itself as the lock holder there. Current versions refuse the restore while either runs (or stop
them with `--force`), and both exit by themselves once they notice the database file was replaced. Older
versions, or a helper started between the stop and the swap, can leave such a pair running. Doctor lists
each process whose working directory is this project's state dir but which does not hold its lock in the
current database, with the command to stop it; it never stops anything itself:

```sh
minions doctor                               # helpers.orphans: the pids and the exact kill command
ps -o pid,lstart,command -p <pid>,<pid>      # confirm they are the old `coordinator supervise` / `work dispatch`
kill <pid> <pid>                             # SIGTERM: they stop their sessions and workers first
```

The lock holders keep running; the coordinator starts a helper again by itself when its lock is missing or stale.

## A lease is stuck

Symptoms: `minions status` shows a worker on a task for far longer than its turn limit, the task never
moves, or a restart is refused because "worker leases are active".

```sh
minions status                        # the active leases and their tasks
minions work cancel <taskId>          # release that task's active worker leases (no result)
minions work cancel --all --reason "stuck after Docker restart"
minions resume --starts               # if starts were left paused (status shows paused or draining)
```

Cancelling keeps worktrees and branches; a late submit from the cancelled worker is refused, and the
task is marked `blocked` ("owner cancelled" note) so the coordinator does not re-dispatch it. Set it
back to `ready` (`minions backlog update` or Backlog.md) to have it picked up again. If an upgrade drain is waiting on the lease,
`minions upgrade --now` releases the remaining workers instead (reported as interrupted).

## Telegram: pairing, no replies, or "another process is polling this bot"

```sh
minions channel show          # configured vs effective channel, and why Telegram is off
minions telegram status       # pairing policy, whether the running coordinator has Telegram, the poller check
minions status --check        # telegram, telegram.credential, telegram.bot, telegram.plugin, telegram.poller checks (manager.* for the host manager bot)
```

- **Pairing.** DM your bot; it answers with a code. In the coordinator terminal (`minions start`), type
  `/telegram:access pair <code>`, then `/telegram:access policy allowlist`. Pair only yourself.
- **Telegram is off ("terminal only").** Store the bot token with `minions auth telegram` and make sure
  the channel is `auto` or `telegram` (`minions channel set auto`), then `minions down && minions start`.
  The host runtime has no Telegram.
- **"another process is polling this bot" (409 Conflict) or the poller check fails.** Each bot can be
  polled by one coordinator only. Use one bot per project, stop the other project's coordinator, or run
  this project in terminal mode (`minions channel set terminal`). If the poller is not the coordinator's
  own (for example after someone started an extra `claude` inside the container), restart it:
  `minions settings restart` (or `minions down && minions start`). Never start an interactive `claude`
  in the container: it takes over the bot.

## Token problems (Telegram)

Symptoms: `minions status` lists "credential mounts changed or missing" under restart-required, the bot
does not start.

```sh
minions auth telegram                   # store a new bot token (BotFather /token or /revoke)
minions upgrade                         # mount the new token copies and restart the coordinator
                                        # (host runtime: minions down && minions start)
```

Tokens are stored only on
the host (Keychain or a 0600 file) and copied into the runtime's read-only secrets mount at start and
on `minions upgrade`; they never enter the state volume or a state backup.

## A failed or interrupted upgrade

```sh
minions upgrade --dry-run       # the steps it would take
minions upgrade                 # a rerun finishes an interrupted upgrade (it remembers the pause it made)
minions upgrade --now           # do not wait for workers: release them (re-dispatched afterwards)
minions resume --starts         # if starts stayed paused after an aborted upgrade
minions resume --drain          # clear a drain request left behind
```

The upgrade never removes volumes or re-clones the workspace. A failure before the container is
recreated leaves the old container running and resumes starts. If the CLI itself must be rebuilt, the
upgrade prints the exact command (or rerun with `--rebuild-cli` in a minions checkout you reviewed).
Host runtime: upgrades are `minions down && minions start` after installing the new CLI. If the state
is damaged after an upgrade, restore the backup you took before it (`minions import --state <file>`),
then `minions settings restart`.

## The verification gate fails under load

The coordinator verifies each merge on the merged tree (`git merge --no-ff
--no-commit`, then the verification commands) while engineers and testers run their own suites in the
same container. Two kinds of failure come from that load, not from the change:

- **Timeouts.** A test that passes alone fails on its time limit. Raise the test runner's default
  timeout moderately and make tests that assert wall-clock bounds deterministic (inject the clock or
  the budget, wait on events instead of fixed sleeps). Do not add blanket retries: they hide real
  failures.
- **The process limit.** The container's `pids_limit` (`container.pidsLimit`, default 512) counts
  threads, not just processes. When it is reached the suite crashes rather than fails: `failed to
  create new OS thread ... errno=11`, `spawn ... EAGAIN`, `cannot fork()`, a test runner `EPIPE`.
  Check with `cat /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max` inside the container. Bound the
  suite's own concurrency so that the gate and two worker suites fit together, or raise the limit on
  the host with `minions settings set container.pidsLimit <n>` (applied when the container is
  recreated).

This repository's own `vitest.config.ts` does both: a 20 s default test timeout, at most 4 test
workers (`MINIONS_TEST_MAX_WORKERS` overrides it), and fewer threads per spawned process
(`--v8-pool-size=1` in `NODE_OPTIONS`, `UV_THREADPOOL_SIZE=2`, and `BUN_JSC_useConcurrentJIT=0` for the
Bun-built `backlog` CLI). One full `npm test` peaks near 120 threads that way, down from about 190 with
vitest's per-core default, so three suites fit next to the coordinator and its workers.
`npm test` runs two vitest projects: `npm run test:unit` (no subprocesses; any spawn fails the run) and
`npm run test:integration` (the files listed in `test/tiers.ts`, which run git, the CLI, `backlog`, and
other children). Workers follow one testing rule: engineers run the typecheck and the unit tier (targeted
files while iterating), reviewers run no tests, task testers run targeted checks, and only the local
integration gate (and QA sweeps) run the integration tier or the full suite. Nobody reruns tests on the
base branch for a baseline. `minions work record` refuses a `complete` engineer result that reports a
failing check, a skipped verification command, or no passing test run.

## Still stuck

- `minions status --check --json` and `minions status --json` give the full picture for a bug report
  (they never print tokens).
- Inside the runtime, the hook log is `<state>/logs/hooks.log` (Docker: `/state/logs/hooks.log`; host
  runtime: `<project>/host/logs/hooks.log`).
- The Docker attach command is printed by `minions start --no-attach` (`docker compose -p <name> -f <file> exec app minions coordinator`).
