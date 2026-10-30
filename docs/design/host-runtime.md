# First-class host runtime (Telegram, auto mode, self-update): design

Status: **proposed** (task-103, design only, against main @ 072a1b4, 2026-10-29). Nothing here is built. The owner
approves before any build task starts.

Owner context: TG 506/508, option 3. Design a first-class host runtime first, then move the dev minions project to
it. The owner found today's host setup confusing. The host path must be simple and must fold into `setup`, `upgrade`
and `status`. A new top-level command needs the owner's approval first.

Related: [bootstrap.md, Host runtime](bootstrap.md#host-runtime) (today's decision record),
[coordinator-self-update.md](coordinator-self-update.md), [telegram-channel.md](telegram-channel.md) (task-67),
[host-manager.md](host-manager.md), [coordinator-sessions.md](coordinator-sessions.md),
[cli-surface.md](cli-surface.md), [local-auto-integration.md](local-auto-integration.md) (task-82),
README [Running without Docker](../../README.md#running-without-docker).

**Supersedes.** This design supersedes one sentence in
[coordinator-self-update.md, Relation to the dropped host-runtime "dev mode"](coordinator-self-update.md#relation-to-the-dropped-host-runtime-dev-mode):
"dev installs stay on Docker, so the dev loop tests the same path users run". The owner chose to move the dev project
to the host runtime (TG 506/508, option 3). The rest of that section still holds: running the dev coordinator
straight from the checkout stays rejected, and the host dev loop runs the same packed install users run on the host
(D6, D9). Phase 7 rewords that section.

## Summary (for Telegram)

- **Same commands, no Docker.** `minions runtime set host` stays the switch. `setup`, `start`, `status` and
  `upgrade` then work on the host. There is no new top-level command.
- **Telegram on the host** uses the minions-owned channel server from task-67, loaded with `--mcp-config`. It never
  uses the official plugin. The bot token stays in the server process: the coordinator's `claude` env never has it,
  and the sandbox hides the file from every Bash command. This is stricter than Docker.
- **Auto mode on the host** is allowed. Only a host-side setting can loosen the mode (a repository can only make it
  stricter). Deterministic hooks fence file and shell access, and the OS sandbox stays on.
- **Upgrade without a container.** The coordinator runs a versioned copy of the CLI. An upgrade drains the workers,
  switches the copy and restarts only the coordinator, inside its own tmux server. Rollback switches back.
- **Self-update** stays a dev-only script (TG 461). It gets a host mode, with the same gate, health check and
  rollback, but with no image steps.
- **Local auto-integration** (task-82) works on the host too. Commands run from the coordinator's sandbox only queue
  integrations. Only host-side processes outside the sandbox start the integrator: the coordinator wrapper, the
  upgrade, and the watchdog's crash start (`--recover`). The gate's `npm test` runs under a minions-generated macOS
  sandbox profile. Upgrades and self-update wait while an integration holds its lock.
- **Self-restart on the host.** The sandbox cannot reach tmux, and must not. A context reset or self-restart from the
  coordinator only writes a restart request. The coordinator wrapper, outside the sandbox, carries it out.
- **Migration** is a drain, then a state export, the switch, and a state import. The Docker volumes are kept, so
  rollback is the same steps in reverse.

## Today (main @ 072a1b4)

What exists:

| Area | Where | What it does |
| - | - | - |
| Selection | `src/host/runtime-kind.ts`, `src/host/runtime-cli.ts` | `runtime` lives in `project.json` / `defaults.json` only, so a repository cannot pick it. `runtime set host` prints a warning, asks for a typed confirmation, and refuses while the old runtime runs. |
| Environment | `src/host/runtime.ts` (`hostRuntimeEnv`, `minionsShim`, `PASS_ENV`, `DROP_ENV`) | Builds an allowlisted env. The `host/bin/minions` shim pins `MINIONS_RUNTIME=host` and the paths, and execs the **globally installed** CLI. |
| Layout | `src/core/paths.ts` (`hostRuntimePaths`) | `<MINIONS_HOME>/projects/<id>/host/{workspace,state,bin,logs,transfer}`, all 0700. The clone is seeded from a bundle. |
| Lifecycle | `src/host/commands.ts` (`ensureHost`, `startHost`), `HostRuntime` | The coordinator runs in `tmux -L minions-<id8>`. `down` kills that server. |
| Hardening | `src/runtime/coordinator.ts` (`hostSettings`, `HOST_CLAUDE_FLAGS`, `hostPromptNote`) | Claude sandbox (Seatbelt) for Bash, `allowUnsandboxedCommands: false`, `denyRead` on the data root and secret dirs, Edit/Read denies, a git subcommand allowlist, `--setting-sources= --strict-mcp-config`. |
| Git outside the sandbox | `src/runtime/git-hardening.ts` | Neutralizes the clone's config for git calls minions itself makes. |
| Credentials | `src/host/credentials.ts` (`selectStore`, `moveKeychainTokensToFileStore`) | Uses the 0600 file store while any project runs on the host. Keychain items are moved there. |
| Permission mode | `decidePermissionMode` in `src/runtime/coordinator.ts` | Built (owner decision 2026-10-29, see [Auto permission mode on the host](#auto-permission-mode-on-the-host)): the configured mode, as in the container. |
| Telegram | `src/telegram/channel/launch.ts`, `decideTelegram`/`runCoordinator` in `src/runtime/coordinator.ts`, `HOST_CHANNEL_NOTE` in `src/host/channel-cli.ts` | Built (task-6, phase 1: text DMs and `reply`): the minions channel server via an inline `--mcp-config` plus `--dangerously-load-development-channels server:minions-telegram`; terminal with a precise reason when Claude Code is older than 2.1.292, the shim or the token is missing. Pairing: `minions telegram access` (TTY only). `telegram install` refuses. |
| Change requests | `src/host/settings-cli.ts` (the `SettingsRuntime` host branch) | `settings requests`/`apply` already reach the host runtime through the shim. |
| Sync | `upgradeSyncOnly` in `src/host/commands.ts` | `upgrade --sync-only` already exports from the host workspace. |
| State move | `src/runtime/state-backup.ts`, `export --state` / `import --state` | Copies the DB snapshot, backlog, notes, briefs and results. Works for both runtimes. |
| Local integration | `src/runtime/integrator.ts`, `Scheduler.record` (`startIntegratorDetached`), the wrapper's `integrationWatch` backstop (`src/runtime/integration-status.ts`) | Task-82: an approved head is merged, verified (`npm test` etc.) in the persistent worktree `<workspace>/integration` and landed on `main`, under the `integration_lock` meta row. The layout derives the path from the workspace (`src/runtime/paths.ts`), so on the host it is `<project>/host/workspace/integration`. |

What is missing (the gaps this design closes):

1. **No Telegram.** The host launch loads no MCP server, and the bot guard ignores host coordinators:
   `dockerCoordinatorPollsBot` and `ownCoordinatorRunning` in `src/host/bot-guard.ts` handle Docker only.
2. **Process checks need `/proc`.** `procCmdline`/`procStartTime` (`src/runtime/coordinator.ts`) and
   `claudeOwner` (`src/telegram/isolation.ts`) read `/proc`. On macOS they return null, so `checkTelegramPoller`
   reports `unknown`, and the task-67 server deactivates itself ("cannot tell which claude session started this
   server", `src/telegram/channel/server.ts`). The same holds for the lock liveness rule shared by the supervisor
   lock and the task-82 `integration_lock` (`systemLockView` in `src/runtime/supervisor.ts`, used by
   `integratorAlive`): start time from `/proc/<pid>/stat`, the `work integrate` command line from
   `/proc/<pid>/cmdline`, and the boot id from `/proc/sys/kernel/random/boot_id`. On macOS all three are null, so any
   live pid counts as the holder: after a reboot or PID reuse a stale `integration_lock` looks live, and the queue
   stalls until someone clears it. The integrator's recovery (stop the recorded verify group only while its leader
   matches pid, start time and boot) cannot confirm a match either. `HostIdentity` in `src/runtime/runner/record.ts`
   also reads the boot id from `/proc`.
3. **Mode is fixed to `default`.** There is no host-side way to choose `auto`.
4. **No `upgrade` path.** `minions upgrade` refuses on the host runtime (`commands.ts`, "supports the Docker runtime
   only"). `restart-required.ts` returns `not-applicable`. The shim runs the global CLI in place, so `npm install -g`
   swaps the code under a running coordinator and its hooks.
5. **Self-update refuses the host.** `scripts/dev/self-update.mjs` requires runtime `docker` and uses `docker exec`.
6. **Shared Claude config.** The `login` method uses the owner's own `~/.claude`. Its plugins load in nested
   sessions, and the Edit deny on `~/.claude/**` blocks the coordinator's auto-memory writes.
7. **Unpinned tools.** Claude Code, Backlog.md and gh are the owner's global installs and may auto-update.
8. **Never run live.** `e2e-host.sh` uses a fake `claude` and a fake `tmux`
   ([compatibility.md](../compatibility.md#host-runtime-no-docker)). Linux hosts were never reviewed.
9. **The integration gate's sandbox depends on who starts it.** Every path that spawns `minions work integrate`
   (`startIntegratorDetached` in `src/runtime/integrator.ts`) today:
   - `Scheduler.kickIntegrator` (`src/runtime/scheduler.ts`), called from `Scheduler.record` (`work record`, also
     with `--submitted`, and `work advance`, which records through `recordSubmitted`) and from
     `Scheduler.requeueIntegration` (`work publish` in local mode, and `Scheduler.publish` called inside `record`);
   - `kickIntegratorIfNeeded` (`src/runtime/integration-status.ts`) in `coordinator restart --recover`
     (`src/runtime/commands.ts`). That command runs directly, through the detached self-restart
     (`coordinator restart --recover --detach`, `RESET_RESTART_COMMAND`, `scheduleDetachedRestart`), through the
     routine pass's crash start (`scheduleCrashStart`, reached from the host manager's watchdog), and as D7 step 5
     of the host upgrade;
   - the wrapper's `integrationWatch` backstop (`startIntegrationWatch`, `wrapperIntegrationWatch`);
   - a direct `minions work integrate` (hidden; the pre-bash hook already refuses it for subagents,
     `COORDINATOR_ONLY_WORK_VERBS`, and the coordinator prompt says never to run it).

   The coordinator and the headless task sessions call `work record`, `work advance`, `work publish` and the
   self-restart from Bash. On the host that Bash runs under Seatbelt, and a detached child stays in the profile, so
   the integrator, and the `npm test` it runs, inherit the coordinator's profile. Seatbelt cannot nest, so the D11
   per-command profile then fails to apply, and that failure would look like a transient or red outcome, not a
   clear refusal. The wrapper's watch, the host upgrade and the watchdog run outside the sandbox, so an integrator
   they start runs the gate unsandboxed, as the owner. The same queue gets different safety levels depending on the
   starter. In Docker every starter runs in the container.
10. **A sandboxed self-restart cannot reach tmux, and must not.** `hostSettings` puts the tmux socket dir
    (`/private/tmp/tmux-<uid>`, from `hostHardeningFromEnv`) in both `denyWrite` and `denyRead`. It also blocks every
    Unix socket (`allowUnixSockets: []`, `allowAllUnixSockets: false`, `src/runtime/coordinator.ts`). The
    coordinator restarts itself from Bash: the context reset (`RESET_RESTART_COMMAND`, the route skill), the idle
    self-restart, and any `coordinator restart --detach`. `scheduleDetachedRestart` spawns `minions coordinator
    restart` as a detached child, and that child stays in the coordinator's Seatbelt profile. Its tmux calls cannot
    reach the `-L minions-<id8>` server. `has-session` and `kill-session` run with `allowFailure`, so they fail
    silently. A relaunch could at most try to start a second tmux server inside the sandbox, and the denied socket
    dir blocks that too. The old session keeps running with no reset, and the only trace is
    `logs/context-reset.log`. Context reset and self-restart are therefore already broken on the host. The same
    applies to the routine pass's wake and crash start when `sync --routine` runs from a sandboxed Bash. The wrapper
    clock and the watchdog run that pass outside the sandbox. Opening the socket to the sandbox is not a fix. Any
    process that can talk to the tmux server can run any command outside Seatbelt (`send-keys`, `new-window`,
    `run-shell`), so the deny stays (D12).

## Decisions

- **D1. No new top-level command.** The selection stays `runtime set` (an advanced command). Host parity works
  through `setup`, `start`, `status`, `upgrade` and `settings`. Moving state between runtimes becomes part of
  `runtime set` (D8).
- **D2. Telegram on the host uses the task-67 server only.** The launch adds `--mcp-config <generated>` to
  `--strict-mcp-config`, plus the development-channel flag that the task-67 spike settles. The official plugin is
  never used on the host: it needs plugin settings, Bun and `bun install`, and it replaces any running poller
  (task-51). `telegram install` keeps refusing on the host.
- **D3. Each host project gets its own Claude config dir**, `<project>/host/claude` (`CLAUDE_CONFIG_DIR`, set by the
  shim, no longer taken from `PASS_ENV`). It holds the login (one `/login` in the coordinator, as in the container),
  the auto memory, and the channel state (`access.json`, offset, lock). Nested `claude` sessions inherit it, so they
  never load the owner's plugins.
- **D4. A repository can only tighten the mode on the host.** The effective mode is the stricter of the host layer
  (`config.local.json`, `project.json`) and the shared `.minions/config.json`. The host default becomes `auto`, the
  same as Docker, only after phase 0 confirms the guards in D5 (Q3).
- **D5. Auto mode on the host needs deterministic guards.** They are hooks and deny rules, not the classifier. See
  [Auto permission mode](#auto-permission-mode-on-the-host).
- **D6. Versioned runtime CLI.** `start` and `upgrade` copy the installed CLI (`dist/`, `templates/`,
  `docker/gh-wrapper.sh`, `package.json`; the bundle has no runtime dependencies) to
  `<project>/host/cli/<build fingerprint>/`. The shim execs that copy. A global reinstall then never changes the
  running coordinator. The last 2 copies are kept, for rollback.
- **D7. The host has its own `upgrade` path:** cli → pause → drain → snapshot → files → workspace → resume →
  `coordinator restart --recover`. There is no image and no container. The tmux server stays, and only the
  coordinator process restarts. Like the Docker upgrade (local-auto-integration.md, "Drain, pause and upgrade"), the
  drain step also waits while the `integration_lock` is held: a running verification is stopped and re-queued by the
  drain, and only the landing (two git calls) may finish first.
- **D8. `runtime set <kind>` moves the state.** It refuses while leases are active or the `integration_lock` is held.
  Today it refuses while the old runtime runs, but the export needs the old runtime running, so the move does the
  steps in this order itself: (1) export the state and the branches from the **running** old runtime (plus the memory
  and `access.json`, D3); (2) stop the old runtime (`down`); (3) switch `runtime` in `project.json`; (4) start the new
  runtime detached; (5) import the state. Any failure before step 3 leaves the old runtime selected (restart it with
  `start`); a failure after step 3 prints the export path and the manual steps. It keeps the old runtime's data and
  supports `--dry-run`.
- **D9. Self-update stays dev-only** (TG 461), with a host mode in the same script. There is no product
  auto-update.
- **D10. macOS first.** The host runtime's sandbox profile targets Seatbelt. A Linux host runtime (bubblewrap) is a
  separate task (Q1).
- **D11. Local integration on the host: unsandboxed starters only, a sandboxed gate.** The integration worktree
  stays where the layout puts it, `<project>/host/workspace/integration` (under the space-containing macOS data
  root, like the workspace). On the host, every entry point that can run from a sandboxed Bash only queues: it
  writes the queue row and touches a wake file, and never spawns `minions work integrate`. These are all the
  callers in gap 9: `work record` (with or without `--submitted`), `work advance` (also in a task session),
  `work publish`, and `coordinator restart --recover` when it runs from the coordinator's Bash (directly or through
  `--detach`; under D12 it only writes a restart request). Only unsandboxed host-side starters start the integrator:
  - the wrapper's `integrationWatch`. It already checks every minute; on the host it also wakes on the wake file,
    so the delay stays a few seconds. The wrapper runs under the project's tmux server, outside the sandbox. This
    also holds after a self-restart: under D12 a sandboxed restart only writes a request, and the wrapper hands it
    to a detached restart outside the sandbox. That restart starts the new wrapper through tmux, and its own
    `--recover` passes the probe;
  - the host upgrade's `coordinator restart --recover` (D7 step 5), which runs outside the sandbox;
  - the same `--recover` spawned by the routine crash start when the host manager's watchdog runs it host-side.
    It is redundant with the new wrapper's watch, but harmless: a second integrator exits at once on the held lock.

  `--recover` does not decide from its caller. It starts the integrator only when the sandbox probe below passes,
  and otherwise only touches the wake file. **Fail closed:** on the host, `minions work integrate` first runs that
  probe: it applies a trivial `sandbox-exec` profile, which fails inside an existing Seatbelt profile. If the probe
  fails, it refuses before it takes the `integration_lock` and before it touches any row. It records an
  `integrator-sandboxed` event, prints a clear error, touches the wake file and exits non-zero. The rows stay
  `queued` and no attempt is counted, so the wrapper's watch picks them up. An unsandboxed starter (the wrapper's
  watch, the host upgrade, the watchdog's crash start) runs the same probe before it spawns. A failure there cannot
  be nesting. It means the mechanism is gone: `sandbox-exec` is missing, or a newer macOS changed it. The starter
  then records `integration-sandbox-unavailable`, and `status` and `doctor` show it as red until a probe passes. That
  way the queue does not stall silently. When the probe passes, the integrator runs its own steps (git merge and
  landing with hardened git, DB writes) as the owner, and runs each verification command
  (`verification.setupCommands`, `npm test`, …) under `sandbox-exec` with a minions-generated Seatbelt profile:
  writes only to the integration worktree, `<state>/run/integration` and the integration logs, the same `denyRead`
  list as `hostSettings`, network GitHub and npm only. Running the gate inside the coordinator's inherited profile
  was rejected: Seatbelt cannot nest, so the integrator could not tighten it, and its scope would then depend on
  which starter won. Running the gate unsandboxed was rejected: the gate executes agent-written code (tests,
  install scripts) as the owner.
- **D12. Self-restart on the host: a sandboxed restart only writes a request, and the wrapper carries it out.** This
  mirrors D11. On the host, the following never call tmux when the D11 sandbox probe fails:
  - `coordinator restart`, with or without `--detach`. This covers `RESET_RESTART_COMMAND` and the idle
    self-restart;
  - the routine pass's wake, when `sync --routine` runs from a sandboxed Bash.

  Each of them first runs today's in-band checks: active leases and the drain, unless `--force`, as
  `scheduleDetachedRestart` does. It then writes one `restart_request` meta row in the runtime DB
  (`{mode: recover | wake | none, force, requestedAt, reason}`; a newer request replaces an older one), touches the
  D11 wake file, and returns `restart-requested`. A sandboxed crash start has no wrapper to carry a request out, so
  it refuses with a clear error, and the watchdog's host-side pass starts the coordinator.

  The coordinator wrapper carries out the request. On the wake file, or on its minute tick, it reads and clears the
  row in one transaction. It builds the argv from the enumerated fields only, never from free text, and spawns
  `minions coordinator restart [--recover | --wake] [--force]` detached in its own session. That is the spawn
  `scheduleDetachedRestart` uses today. The child runs outside the sandbox and outside the tmux session, so it
  survives the `kill-session`. It checks leases and the drain again, and starts the new wrapper through
  `tmux -L minions-<id8>`. A starting wrapper drops any request older than its own lock, since that request was
  written for the session it replaces. If a request is still pending after 2 minutes, `status` and `doctor` show it
  as red (`restart-request-stuck`). The tmux socket stays denied to the sandbox.

  Why the wrapper:
  - It is the one host-side process that always runs while a coordinator does, so a request never waits on
    anything else.
  - It already has the minute tick and the D11 wake file, and it is not sandboxed.
  - It cannot kill its own session and survive. So it does not restart itself: it hands the restart to a detached
    child, as the self-restart does today.

  The alternatives were rejected:
  - The watchdog runs only with `routine.enabled` and the host manager, every few minutes, so a context reset would
    wait minutes or never happen.
  - The host manager is optional and serves every project.
  - A new small supervisor would be one more long-lived process to start, upgrade and watch, and the wrapper already
    plays that role.

## Docker vs host: what the host loses, and the mitigations

| Property | Docker (today) | Host today | Host after this design | Residual |
| - | - | - | - | - |
| **Worker sandbox** | Whole container: uid 1000, read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, CPU/memory/pids limits (`src/host/docker.ts`). Only volumes and read-only binds are visible. | Seatbelt for Bash (coordinator and workers alike). File tools are limited by deny rules and `blockReadsOutsideWorkingDirectories`. No limits. | Adds a pre-file **path fence** (Read/Edit/Write only inside the workspace, the state and the memory dir, realpath-checked) and a host **pre-bash fence** on every Bash call (D5). `WebFetch`/`WebSearch` are denied. | No CPU, memory or process limits on macOS: `execution.maxActiveTasks` is the only cap (Q7). Process harnesses (Codex) stay Docker-only (`minions-sandbox` is Landlock). |
| **Bot ownership** | `bot-guard.ts` (one poller per bot across Docker projects), the plugin off at user scope (task-51), the `/proc` poller check. | No Telegram. | The task-67 server: coordinator wins, it never writes `bot.pid`, it keeps `channel.lock`, and it allows at most one kill per launch. The bot guard sees host coordinators (tmux `has-session` + `telegram status` through the shim). A `ps`-based process view works on macOS. | The owner's own Claude Code sessions on the same Mac, polling the **same** bot, are not detectable before they start. The server reports a persistent 409 in `status`. Use a separate bot. |
| **Credentials** | Only this project's GitHub token, the bot token (read-only mount, also in the coordinator env) and the Claude login/key. | The owner's user. The sandbox `denyRead` covers the data root and secret dirs. File store, env allowlist. | Same, and the bot token is read only by the server process, which runs outside the sandbox. It is not in the `claude` env, and `denyRead` hides the file from Bash. The channel state sits outside `allowWrite`. | The Keychain is still reachable over `mach-lookup` from sandboxed commands. `security` is denied by pattern only, so the pre-bash fence covers wrappers (`sh -c`, `env`, `xargs`). The GitHub token is readable by agents, as in Docker. |
| **Nested claude** | It loads the container's config dir, where the plugin is off. | A worker's `claude` uses the owner's `~/.claude` (their plugins, MCP servers, login). It is held back only by the sandbox network list (no `api.anthropic.com`). | The per-project config dir (D3) has no plugin at user scope, and the channel server is never at user scope. `Bash(claude*)` is denied, and the pre-bash fence refuses `claude` in any position. | None beyond Docker's. |
| **Worktree / state** | Volumes at `/workspace/{repo,worktrees}`, `/state`. | `<MINIONS_HOME>/projects/<id>/host/{workspace,state}`. On macOS the path contains a space (`Application Support`). | Same, plus `host/claude` and `host/cli/<fp>` (host-owned, not agent-writable, Edit-denied). The prompt note already maps `/workspace` and `/state` (`hostPromptNote`). | The dev suite must pass with a space in cwd and without loopback binding or Unix sockets (`allowLocalBinding: false`). Phase 0 checks this. |
| **Integration gate** (task-82) | The integrator and its `npm test` run in the container, in `/workspace/integration`, with an allowlisted env and a fresh `HOME`. | Inherits Seatbelt when a call from the coordinator's Bash spawns it (`work record`, `work advance`, `work publish`, `coordinator restart --recover`), unsandboxed when the wrapper backstop, the host upgrade or the watchdog does (gap 9). | Started only by unsandboxed host-side starters (the wrapper's watch, the host upgrade's `--recover`, the watchdog crash start's `--recover`, and a D12 restart the wrapper carries out); sandboxed entry points only queue, and `work integrate` refuses when it is already sandboxed. Each verification command runs under a minions-generated Seatbelt profile (D11). The allowlisted env and fresh `HOME` stay. | The integrator's own git and DB steps run unsandboxed as the owner (as minions' own git calls do today, with `git-hardening.ts`). `sandbox-exec` is deprecated by Apple but is the mechanism Claude Code's sandbox itself uses. The suite must pass under that profile (phase 0). If `sandbox-exec` is missing, or the probe keeps refusing from an unsandboxed starter, `status` and `doctor` show it as red (D11). |
| **Network** | `outbound-internet`, no filter. | Bash: GitHub and npm only. | Unchanged. Telegram traffic comes from the server, outside the sandbox. | Stricter than Docker for Bash, which is fine for this project. |
| **Tool versions** | The image pins Claude Code, Backlog.md and the plugin. | The owner's global installs. | The shim sets `DISABLE_AUTOUPDATER=1`. `doctor` warns on untested versions (exists), and `status` shows them. | The owner updates Claude Code deliberately and reruns `doctor`. |

## Telegram on the host

- **Built (task-6).** The MCP config is passed inline in argv (paths and the launch id only), not as a file: the state
  dir is agent-writable on the host, so a file there could be swapped for another command. Claude Code asks to confirm
  the development channel at every start, so a detached start needs the owner to attach once.
- **Launch.** In host mode, `buildClaudeCommand` adds `--mcp-config <inline JSON>` (server
  `minions-telegram`, command = the shim, `telegram channel serve`) next to `HOST_CLAUDE_FLAGS`, plus the channel
  flag. Task-67.3 builds this launch swap for Docker. The host phase only reuses it.
- **Token.** `MINIONS_TELEGRAM_TOKEN_FILE=<project>/secrets/telegram-bot-token` goes into the MCP config `env`. That
  is a path, not the secret. `TELEGRAM_BOT_TOKEN` is never set in the tmux or claude env on the host. The token file
  stays in the sandbox `denyRead` (it is already there in `hostSettings`).
- **Channel state.** `TELEGRAM_STATE_DIR=<project>/host/claude/channels/telegram`. It gets Read/Edit denies for
  `access.json` and the lock, and it is outside `allowWrite`, so agents cannot pair a chat or forge the lock from
  Bash. In Docker they can.
- **Process facts on macOS.** One `ProcessControl` built on `ps -o pid=,ppid=,lstart=,command= -p <pid>` (no `/proc`)
  is used by the coordinator lock, `checkTelegramPoller`, `signalDescendants` and the channel server's ancestor rule.
- **Detached start.** It already exists (`coordinator sync --start-detached` when Telegram is wanted).
  `resolveChannel` drops the `host-runtime` cause once the server is available. The `setup` wizard stops skipping the
  Telegram step on the host (`src/host/wizard.ts`).
- **Bot guard.** `findBotConflict` counts host coordinators. `startBotCheck`'s own-coordinator check works for both
  runtimes.

## Auto permission mode on the host

> **Built, simplified (owner decision 2026-10-29: "cleanup unnecessary guardrails", "fully autonomous on the host").**
> The host runtime uses `coordinator.permissionMode` like the container (default `auto`), and the owner may choose
> `bypassPermissions` and `coordinator.sandbox false` for fully unattended work. Those two are accepted only from
> `config.local.json` (`src/config/resolve.ts` refuses them in the project layer). Sandboxed commands run without a
> prompt (`autoAllowBashIfSandboxed: true`), and recording a publication approval is denied instead of asked. The
> extra fences below (points 3 to 5) are not built; the list stays as the hardening backlog.

Auto mode lets a classifier approve actions outside the allow list. On the host those actions run as the owner, so
the safety must not depend on the classifier:

1. **Who may loosen.** The mode comes from `coordinator.permissionMode` in the host layer only (`settings set`
   already writes `config.local.json` by default). A shared-layer value counts only when it is stricter. `status`
   and `doctor` show the mode and its source.
2. **Unchanged hard limits.** Sandbox on, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`,
   `disableBypassPermissionsMode`, the existing deny and ask rules (push, merge, approve).
3. **New deny rules (host).** `WebFetch`, `WebSearch`, `Bash(claude*)`, `Bash(osascript*)`, `Bash(launchctl*)`,
   `Bash(defaults*)`, and Edit of `host/claude/**` other than the memory dir.
4. **Pre-bash fence (host, every Bash call, not just subagents).** It extends `minions hook pre-bash` with
   `shell-scan.ts`. It refuses a command word in any position (substitutions, pipes into shells, heredocs) that is a
   credential or system CLI (`security`, `secret-tool`, `osascript`, `launchctl`, `defaults`, `claude`, `ssh`,
   `scp`). A parse error fails closed.
5. **Pre-file path fence (host).** Read/Edit/Write/NotebookEdit are allowed only when the realpath lies inside the
   workspace, the state or the coordinator's memory dir. It closes the one gap the classifier would otherwise judge:
   file tools writing outside the working dirs, which the sandbox does not cover.
6. **Phase 0 must confirm**, on the tested Claude Code version: auto mode still applies deny and ask rules and
   PreToolUse hook denials. It cannot approve a sandbox network or filesystem widening (a "retry unsandboxed" or a
   new-domain prompt). If any of these fails, the host stays on `default` and the owner hears why.

## Upgrade and self-update without a container

**`minions upgrade` on the host (D7).** The source phase is the same (`--from-container` export, the `--rebuild-cli`
packed reinstall with its CLI backup, `src/host/upgrade-source.ts`). Then:

1. pause starts, request a drain, and wait (or `--now`), exactly as in Docker, including the wait for a held
   `integration_lock` (the drain stops and re-queues a running verification; a landing finishes);
2. snapshot the newly installed CLI into `host/cli/<fp>` (D6);
3. regenerate the derived files (plugin, runtime config, shims pointing at the new snapshot);
4. `workspace setup` (DB migrations) through the new shim;
5. resume starts, then `coordinator restart --recover` on the dedicated tmux server.

Nothing else restarts. The tmux server, the workspace and the state stay. `restart-required.ts` gets a host branch:
the installed CLI fingerprint differs from the snapshot the shim runs (`upgrade` required), or the launch fingerprint
differs (`coordinatorLaunch`, exists). `--sync-only` already works.

**Self-update (dev project).** The same script and trigger (`minions upgrade --from-container --reason …` in the
runtime; the root `CLAUDE.md` section needs no change). In host mode:

- **Refusals:** it also accepts runtime `host`. It still requires a packed install, `local` delivery, a minions
  checkout and a clean base branch.
- **Runtime verbs** (`settings requests mark`, `notify enqueue`) go through `<project>/host/bin/minions` instead of
  `docker exec`.
- **Idle check:** as in the container flow after task-82.5, a held `integration_lock` counts as busy, so the script
  does not apply while an integration runs. In host mode it reads the lock through the shim (`status --json`), not
  `docker exec`.
- **Apply:** sync → host gate (unchanged) → `upgrade --rebuild-cli` (the host path above).
- **Health:** the same fresh-process CLI checks, `restartRequired` and `coordinatorLaunch` `current`, the shim on the
  expected snapshot, and the Telegram poller and doctor checks. The image and container checks are dropped.
- **Rollback:** reinstall the CLI backup, point the shim back at the previous snapshot, run
  `coordinator restart --recover`, check health again, then send the manager-bot notice as today.

## Commands (fold-in)

| Command | Host change |
| - | - |
| `minions setup` | Its runtime question stays. On the host it now offers Telegram and the permission mode (recommended `auto`, written to `config.local.json`), and tells the owner to run `/login` once. |
| `minions start` | Snapshots the CLI, writes the MCP config, starts detached when Telegram is wanted, and checks the bot guard. |
| `minions status` | Shows the runtime, the effective channel, the mode and its source, the snapshot vs the installed CLI (`restartRequired`), and the tool versions. |
| `minions upgrade` | The host path above. It no longer refuses. |
| `minions runtime set` | Moves the state (D8). It stays an advanced command. |
| `minions doctor` | Adds host Telegram checks (server, token file, macOS poller) and the mode source. |

No new top-level command is needed. The only candidate was a "move runtime" command, and it folds into
`runtime set` (Q5).

## Migration of this dev project (Docker to host)

The coordinator prepares each step and the owner runs the host-side ones. The whole migration happens only after
phases 0 to 6 are delivered.

1. **Gate.** Phase 0 passed on the owner's Mac. `doctor` is green for `host.*`. A separate disposable host project
   with a test bot has had one full lease cycle, one local integration round (an approved head merged, verified
   under the D11 profile and landed on its `main`), and one self-update round.
2. **Quiesce.** `minions pause --starts`, wait until `status` shows no active lease, no drain, an empty integration
   queue and a free `integration_lock`, then stop the self-update script. The container keeps running: the export
   in step 3 needs it.
3. **Switch.** Run `minions runtime set host` (D8), which does, in this order:
   1. **export from the running container:** the branches and the state (`export --state`), plus
      `~/.claude/projects/-workspace-repo/memory/` and `channels/telegram/access.json` out of the claude volume;
   2. **stop** the container (`down`; the volumes stay);
   3. **switch** `runtime` to `host` in `project.json`;
   4. **start** the host runtime detached;
   5. **import** the state, place the memory under the host repo path's project key, and place `access.json` in
      `host/claude/channels/telegram/`.

   Docker volumes are not touched. If phase 6 is not delivered, the same steps by hand are: `minions export
   --state`, `minions down`, `minions runtime set host` (it now passes the "old runtime runs" check),
   `minions start`, `minions import --state <file>`, then copy the memory and `access.json`.
4. **Log in and check.** Attach once (`minions start`), run `/login`, then `minions status` and `doctor`. Send a
   Telegram round trip. `resume --starts`.
5. **Self-update.** Restart `scripts/dev/self-update.mjs`, which detects host mode. Watch the first real request.

**Rollback** (any time, including mid-migration):

1. `minions pause --starts`, then wait for idle, including a free `integration_lock` (or accept `wip:`
   re-dispatch).
2. `minions runtime set docker`. This is the same move in reverse and in the same order: export from the running
   host runtime, stop it, switch, start the container, import into the container volumes, which were kept from
   step 3. Host data stays in `host/` until `uninstall --delete-data`.
3. `minions start`, then restart the self-update script, which detects Docker mode.
4. If `runtime set` itself fails: first **export the host branches and state** while the host runtime is still
   readable (`minions export --state` and `minions export` for the branches; the host workspace and state under
   `host/` also stay on disk). Then `minions down`, set `"runtime": "docker"` back in `project.json` by hand,
   `minions start`, and `minions import --state <file>`. Without that export the container comes back with the state
   from before the migration, and any work done on the host since then is only in `host/`.

The Docker volumes are deleted only after the owner says so (Q6).

## Phases (build tasks, after owner approval)

0. **Live host spike (coordinator-run, macOS, throwaway project and bot, separate `CLAUDE_CONFIG_DIR`).** Criteria:
   a real coordinator plus one engineer lease on a scratch repo under today's host runtime. This doc records the
   following: sandbox start (`failIfUnavailable`); the Read/Edit/Bash denies hold; `npm ci && npm run typecheck &&
   npm test` of this repo inside the sandbox (space in path, no loopback, no Unix sockets); the auto-mode questions
   in step 6 above; a `--strict-mcp-config --mcp-config` channel server receiving notifications (shared with the
   task-67.1 spike). Today that server deactivates itself on macOS (gap 2: `claudeOwner` returns unknown without
   `/proc`), so the spike runs it with a local, spike-only bypass of the ancestor check (or checks the ancestry by
   hand with `ps -o pid=,ppid=,command=`); otherwise this item fails by default and says nothing about the channel.
   Also: one local integration round (local delivery, `delivery.merge: auto-when-eligible`, one approved head merged,
   verified and landed in `<project>/host/workspace/integration`), with the gate's `npm test` run once under a
   hand-written `sandbox-exec` profile as in D11. Also the D11 and D12 checks:
   - the trivial-profile probe fails from the coordinator's sandboxed Bash and passes outside it;
   - the sandboxed Bash cannot reach the tmux socket. `tmux -L minions-<id8> has-session` fails, and today's
     `coordinator restart --recover --detach` leaves the old session running (gap 10);
   - a live run of the D12 request path, with a spike stand-in for the wrapper. The sandboxed Bash writes the request
     and touches the wake file. A host-side stand-in outside the sandbox spawns the detached
     `coordinator restart --recover`. The doc records whether the old session is gone, whether the new wrapper holds
     the lock (and whether the macOS handover needs phase 1: without `/proc` a stuck old wrapper is never
     signalled), and whether the probe passes in a child of the new wrapper.

   Also the per-project `CLAUDE_CONFIG_DIR` login and the auto-memory location. Go/no-go per item. Depends: none.
1. **macOS process facts and a runtime-aware bot guard.** Criteria: a `ps`-based `ProcessControl` on darwin
   (cmdline, parent, start time) used by the coordinator lock, `checkTelegramPoller`, `signalDescendants` and the
   channel server; the same view backs `systemLockView` (`src/runtime/supervisor.ts`), so the supervisor lock and the
   `integration_lock` (`integratorAlive`, and the integrator's recovery match of the verify group leader) check pid,
   start time and the `work integrate` command line on macOS; a macOS boot id (`sysctl -n kern.boottime`, or
   `kern.bootsessionuuid`) for those locks and for `HostIdentity` (`src/runtime/runner/record.ts`), so a lock from
   before a reboot is stale; `findBotConflict`/`startBotCheck` count host coordinators; unit tests with a fake `ps`
   and a fake `sysctl`, including PID reuse and a reboot; existing `/proc` tests unchanged. Depends: none.
2. **Per-project Claude config dir and versioned runtime CLI.** Criteria: the shim sets
   `CLAUDE_CONFIG_DIR=<project>/host/claude` and `DISABLE_AUTOUPDATER=1`; `start` snapshots the CLI into
   `host/cli/<fp>` (keeps 2) and the shim execs it; the sandbox `allowRead`/Edit denies cover both dirs; `setup` and
   `doctor` texts for `/login`; e2e-host updated. Depends: 0.
3. **Telegram on the host.** Criteria: the MCP config and channel flag in the host launch; the token only in the
   server env path; the channel state in `host/claude`, sandbox- and Edit-denied; `resolveChannel` without the
   host-runtime cause; the wizard offers Telegram on the host; doctor and status checks; tests for argv, env (no
   token) and settings. Depends: 1, 2, task-67.3.
4. **Auto mode, the integration gate and the self-restart on the host.** Criteria: the host-layer-only loosening
   rule (a repository value can only tighten), with tests; the new deny rules; the host pre-bash fence and pre-file path fence, which
   fail closed, with tests for wrappers, substitutions, symlinks and `..`; `status` and `doctor` show the mode and
   source; the default becomes `auto` only if phase 0 passed. D11: on the host, `Scheduler.kickIntegrator` never
   spawns and only touches the wake file, so `work record` (also with `--submitted`), `work advance` and
   `work publish` only queue. `coordinator restart --recover` starts the integrator only when the sandbox probe
   passes, and otherwise touches the wake file. The wrapper's `integrationWatch` wakes on that file. `work
   integrate` runs the probe first: when it is already sandboxed, it refuses before it takes the lock (the
   `integrator-sandboxed` event, an exit code other than 0, the rows stay `queued`, no attempt counted). Each
   verification command runs under the generated Seatbelt profile (writes limited to the integration worktree,
   `<state>/run/integration` and its logs; the `hostSettings` `denyRead` list; GitHub and npm only). Tests use a fake
   `sandbox-exec` and a fake spawner and cover: the argv and the profile; that `work record`, `work record
   --submitted`, `work advance`, `work publish` and a sandboxed `coordinator restart --recover` (also with
   `--detach`) spawn nothing on the host; that the wrapper's watch and an unsandboxed `--recover` do spawn; and
   the refusal leaves the queue and attempt count unchanged. An unsandboxed starter whose probe fails records
   `integration-sandbox-unavailable`, and `status` and `doctor` show it as red (tested).

   D12 criteria:
   - On the host, a sandboxed `coordinator restart` (also with `--detach`, `--recover`, `--wake` or `--force`) and a
     sandboxed routine wake never run tmux. They keep the in-band lease and drain refusals, write the
     `restart_request` row, touch the wake file and return `restart-requested`. A sandboxed crash start refuses.
   - The wrapper consumes each request once and spawns the detached restart from the enumerated fields. A new
     wrapper drops an older request. A request pending for more than 2 minutes is red in `status` and `doctor`.
   - Tests use a fake probe, a fake tmux runner and a fake spawner. They cover: no tmux call and no spawn from any
     sandboxed path; the in-band refusals; exactly one spawn per request, with the right argv (`--force` only when
     asked); a crafted row with unknown fields or extra text, which never reaches the argv; a dropped stale request;
     and the red status.

   Docker behaviour stays unchanged. Phase 0 confirms that the probe fails inside the coordinator's sandbox and that
   the tmux socket is unreachable from it. Depends: 0, 1, 2.
5. **`minions upgrade` on the host.** Criteria: the D7 steps with `--dry-run`, `--now` and `--rebuild-cli`; the
   drain waits while the `integration_lock` is held (a verification is re-queued, a landing finishes); the
   `restart-required` host branch; an interrupted upgrade resumes (`upgrade.json`); tests with a fake tmux and
   claude, including a held lock. Depends: 2.
6. **Runtime move and self-update host mode.** Criteria: `runtime set` moves the state, branches, memory and
   `access.json` in the D8 order (export from the running old runtime, stop it, switch, start the new one detached,
   import), refuses with active leases or a held `integration_lock`, and supports `--dry-run`; `self-update.mjs`
   host mode (refusals, verbs through the shim, the task-82.5 idle check that treats a held `integration_lock` as
   busy, read through the shim, health without image checks, rollback = backup reinstall + snapshot flip +
   restart), tested with fakes. Depends: 3, 5, task-82.5.
7. **Migrate the dev project (coordinator + owner).** Criteria: the migration steps above run; one local integration
   round and one self-update round pass on the host; the rollback rehearsed once on the disposable project; README,
   bootstrap.md, compatibility.md and coordinator-self-update.md updated (its "Relation to the dropped host-runtime
   dev mode" section no longer says dev installs stay on Docker, and its host-mode notes point here). Depends: 4, 6.

Sensitive paths: none expected. Phase 7 may touch the root `CLAUDE.md` only if the owner wants the coordinator
section reworded. It works unchanged.

## Open questions (recommended answer first)

1. **Which OS is the dev host?** Recommended: **macOS** (the only platform the host runtime's sandbox profile
   targets). Linux needs its own bubblewrap task first.
2. **Host Telegram only through the task-67 server (wait for 67.3)?** Recommended: **yes**. The official plugin on
   the host would put the token in every Bash env and bring back newest-wins polling.
3. **Host default mode `auto` (as in Docker) once phase 0 passes?** Recommended: **yes**. A repository can still
   only make it stricter.
4. **A separate Claude login per host project (one `/login`) instead of reusing your own?** Recommended: **yes**. It
   isolates plugins, nested sessions and memory.
5. **Fold the runtime move into `runtime set` (no new top-level command)?** Recommended: **yes**.
6. **When to delete the Docker volumes after migrating?** Recommended: **after 2 weeks** of stable host runs, on your
   word.
7. **Accept no CPU or memory limits on the host?** Recommended: **yes**. `maxActiveTasks` (2) is the cap, and macOS
   has no per-process cgroups.
8. **Self-update stays dev-only on the host too?** Recommended: **yes** (TG 461). `minions upgrade` on the host is
   the product part.

## Rejected alternatives

- **Official Telegram plugin on the host** (per-project config dir plus `enabledPlugins` in `--settings`). It needs
  Bun and `bun install` at start, puts the token in the `claude` env (so every sandboxed Bash command has it), and
  its `bot.pid` replaces running pollers.
- **Running the dev coordinator straight from the checkout** (the TG 457/458 "dev mode"). It skips the packed path
  users run, and a bad commit breaks the running coordinator with nothing to roll back to.
- **Auto mode trusted to the classifier alone.** On the host, a wrong approval runs as the owner. The hooks are
  deterministic and fail closed.
- **Updating the global CLI in place.** Hooks and Bash calls would run new code during the drain, while the
  coordinator wrapper runs old code. The snapshot makes the switch atomic and reversible.
