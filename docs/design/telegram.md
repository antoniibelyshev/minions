# Telegram channel integration: design

Status: **implemented**: bot token provisioning, the wizard step, plugin install, the coordinator exec
wrapper with `--channels`, controlled restarts, doctor readiness (see [Implementation](#implementation-step-7)),
the notification outbox and the terminal-equivalent controls (task-2.3).
Everything marked **verified** was observed on Claude Code 2.1.292 in a Linux container on
2026-10-19 or read from the sources below. Everything marked **unknown** is listed in
[Unknowns and fallbacks](#unknowns-and-fallbacks) and is not assumed.

## Sources consulted (2026-10-19)

Official documentation:

- Channels: https://code.claude.com/docs/en/channels (Telegram setup, security, enterprise controls, research preview)
- Channels reference: https://code.claude.com/docs/en/channels-reference (`claude/channel` capability, permission relay, development flag)
- CLI reference: https://code.claude.com/docs/en/cli-reference (`--channels`, `--dangerously-load-development-channels`)
- Plugins: https://code.claude.com/docs/en/plugins and https://code.claude.com/docs/en/discover-plugins (scopes, `enabledPlugins`, `--plugin-dir`)
- Settings and managed settings: https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/managed-settings (`/etc/claude-code/managed-settings.json` on Linux)

Plugin source and metadata:

- Official marketplace repo `anthropics/claude-plugins-official`, directory `external_plugins/telegram`, last commit touching it
  `1e96c6b0a0f06cad576086243f3d06397c4ddf44` (2026-08-13). Files read: `.claude-plugin/plugin.json` (name `telegram`,
  version `0.0.7`), `.mcp.json`, `package.json` (`claude-channel-telegram`, deps `@modelcontextprotocol/sdk`, `grammy`),
  `server.ts`, `README.md`, `ACCESS.md`, `skills/configure/SKILL.md`, `skills/access/SKILL.md`.
- The plugin is distributed through the plugin marketplace (a git repo), not through npm. There is no npm package to pin.

Installed CLI (verified in this container, `/usr/local/bin/claude`, `2.1.292 (Claude Code)`):

- `claude plugin --help`, `claude plugin install --help`, `claude plugin list --help`, `claude plugin marketplace --help`.
- In a throwaway `HOME`/`CLAUDE_CONFIG_DIR`, with no login: `claude plugin marketplace add anthropics/claude-plugins-official --json`
  succeeded (HTTPS git clone), and `claude plugin install telegram@claude-plugins-official --json` succeeded at user scope.
  `claude plugin list --json` then reported `telegram@claude-plugins-official` version `0.0.7`, `enabled: true`, its
  `mcpServers.telegram.command: "bun"`, and the note `dependencies-refused` ("needs bun, which is not installed").
  No bot token, pairing, or login was used.

## Verified facts

| Topic | Fact | Source |
| - | - | - |
| Preview status | Channels are a **research preview**. `--channels` and `--dangerously-load-development-channels` are **not listed in `claude --help`** but work. Flag syntax and protocol may change. | channels#research-preview |
| Auth | Channels need Anthropic authentication (claude.ai or a Console API key). Not available on Bedrock, Vertex/Agent Platform, or Foundry. | channels, cli-reference |
| Install | `/plugin install telegram@claude-plugins-official` or the CLI `claude plugin install telegram@claude-plugins-official --scope user`. The marketplace may need `claude plugin marketplace add anthropics/claude-plugins-official` first. Both CLI commands work non-interactively without login. | channels; observed |
| Runtime | The plugin's MCP server is a Bun script: `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --shell=bun --silent start`, and `start` runs `bun install` and then `bun server.ts`. So it needs Bun **and** npm registry access when it starts. | `.mcp.json`, `package.json` |
| Enable per session | A channel only delivers messages when it is named in `--channels plugin:telegram@claude-plugins-official`. Being installed or in `.mcp.json` is not enough. Without `--channels`, the MCP server still starts and its tools work. | channels#security, #enable-channels |
| Allowlist | During the preview, `--channels` accepts only plugins on the Anthropic-maintained allowlist (default: the `claude-plugins-official` channel plugins) or the org's `allowedChannelPlugins`. Anything else starts normally, but the channel does not register, and a startup notice explains why. | channels#research-preview |
| Org policy | Managed `channelsEnabled` is the master switch. claude.ai Team/Enterprise: blocked until an Owner enables it. Console API key: allowed unless the org deploys managed settings, then blocked until it is set. Pro/Max without an org: no checks. `allowedChannelPlugins` replaces the default allowlist. Users cannot override managed settings. | channels#enterprise-controls |
| Managed file | Linux file-based managed settings: `/etc/claude-code/managed-settings.json` (plus `managed-settings.d/`). Server-managed settings come from the claude.ai admin console. | managed-settings |
| `-p` mode | With `-p`, tools that need terminal input are disabled. `--dangerously-load-development-channels` is ignored with `-p` or the Agent SDK. | channels, channels-reference |
| Token | Read from `TELEGRAM_BOT_TOKEN` in the process environment first, then from `<state>/.env`. `/telegram:configure <token>` writes `<state>/.env`. The server `chmod 0600`s `.env` **before** it reads it, inside one `try`. If the chmod fails (for example, a read-only bind mount), the file is silently ignored. | `server.ts` lines 27-53, README |
| State dir | `TELEGRAM_STATE_DIR` or else `${CLAUDE_CONFIG_DIR:-~/.claude}/channels/telegram`. It holds `.env`, `access.json`, `approved/`, `inbox/`, and `bot.pid`. | `server.ts`, skills |
| Access | `access.json`: `dmPolicy` (`pairing` default, `allowlist`, `disabled`), `allowFrom` (numeric user IDs), `groups`, delivery keys, and `pending` codes. The server re-reads it on every inbound message. `TELEGRAM_ACCESS_MODE=static` freezes it at boot and downgrades `pairing` to `allowlist`. | ACCESS.md, `server.ts` |
| Pairing | An unknown sender DMs the bot and gets a 6-character code. In the **terminal** session the user runs `/telegram:access pair <code>`, then `/telegram:access policy allowlist`. The skill refuses requests that arrive through a channel message (anti prompt-injection). | README, `skills/access/SKILL.md` |
| Exclusive polling | Telegram allows one `getUpdates` consumer per token. At start the server **SIGTERMs any live `server.ts` whose PID is in `bot.pid`** and takes over. Across machines or containers, the conflict shows up as `409 Conflict` with backoff retries. | `server.ts` lines 58-78, 1001-1040 |
| Bot commands | The server itself handles `/start`, `/help`, `/status` (pairing status) in DMs. Other messages are gated and forwarded to Claude as `<channel source="telegram" chat_id=… message_id=… user=…>`. | `server.ts` |
| Tools | `reply` (chat_id, text, reply_to, files), `react`, `edit_message`. Outbound is gated to allowlisted chats. Telegram has no history or search API. | README, `server.ts` |
| Permission relay | The plugin declares `claude/channel/permission`. **Any allowlisted sender can approve or deny tool-permission prompts** (`yes <id>` / `no <id>`). | `server.ts`, channels-reference#relay-permission-prompts |

## Architecture (chosen)

```
host (macOS)                                  project container
───────────────                               ────────────────────────────────────────────────
minions CLI                                   tmux "coordinator"
  credential store (task-1.1 mechanism)  ──►    minions coordinator run   (exec wrapper)
  writes 0600 file, ro bind-mount               │ reads /opt/minions/secrets/telegram-bot-token
  doctor ── compose exec ──────────────────►    │ env TELEGRAM_BOT_TOKEN=… (this process tree only)
            minions telegram probe --json       └─ claude --plugin-dir /opt/minions/plugin
                                                         --channels plugin:telegram@claude-plugins-official …
                                                     └─ bun server.ts  (official plugin, state in claude volume)
                                                            ⇄ api.telegram.org (long polling)
```

Decisions:

1. **Use the official plugin unchanged** (spec §593). minions does not reimplement Telegram transport. It does
   not read the plugin's `.env` or pending pairing codes, and it never writes `access.json`.
2. **Install inside the container, at user scope, in the per-project `claude` volume** (`CLAUDE_CONFIG_DIR=/home/node/.claude`).
   A `minions telegram install` step (container mode) runs `claude plugin marketplace add anthropics/claude-plugins-official`
   if the marketplace is missing, then `claude plugin install telegram@claude-plugins-official --scope user --json`, and
   records the installed `version` from `claude plugin list --json`. The plugin is **not** loaded with `--plugin-dir`:
   a session-local copy would not be `plugin:telegram@claude-plugins-official`, so it would not be on the channel allowlist
   and would need the development flag. The generated minions plugin keeps loading with `--plugin-dir /opt/minions/plugin`,
   and both plugins coexist in the coordinator session.
   **Task-51 amendment: enabled only by the coordinator launch.** `claude plugin install --scope user` enables the plugin
   for every claude session in the container, and the token is in every session started from the coordinator's Bash tool
   (workers included), so a nested `claude -p` started its own poller, SIGTERMed the coordinator's (`bot.pid`), and exited.
   `minions coordinator run` now sets `enabledPlugins["telegram@claude-plugins-official"] = false` in
   `$CLAUDE_CONFIG_DIR/settings.json` before every launch (other keys kept; an unparseable file is left alone with a warning),
   and the coordinator's `--settings` carries `enabledPlugins: {…: true}` next to `--channels`. Verified against the
   Claude Code 2.1.292 bundle: enabled plugins resolve managed → user → project → local → flag settings, later true/false
   winning, and `--channels` only gates notifications of servers already loaded. Rejected: a separate state dir or token
   for other sessions, because the plugin takes both from the environment, which the coordinator's Bash tool inherits.
   Detection: `minions status` / `minions telegram status` (`poller`) and doctor `telegram.poller` check that `bot.pid`
   is a live `server.ts` whose nearest `claude` ancestor (by argv0) is the coordinator claude, the wrapper's direct child (`src/telegram/isolation.ts`). Descent from the wrapper alone is not enough: worker Bash commands and any nested `claude -p` run under the coordinator claude too. If `/mcp` does not list the plugin at all, it never loaded in the coordinator; restart instead of reconnecting.
3. **Bun in the image.** Add a pinned Bun release with checksum verification to `docker/Dockerfile` at build time, and set
   `BUN_INSTALL_CACHE_DIR=/home/node/.cache/bun` (the `cache` volume, because `/home/node` is tmpfs). The plugin still runs
   `bun install` when it starts, so it needs registry access. With `container.network: none`, Telegram is reported unavailable.
4. **Token reaches only the coordinator process tree, through the environment.** The plugin ignores a read-only `.env`
   (see Verified facts), and `/telegram:configure` would copy the token into the persistent volume. So the token file
   is bind-mounted read-only, and a small exec wrapper (`minions coordinator run`, started by tmux) reads it and spawns
   `claude` with `TELEGRAM_BOT_TOKEN` in its environment. The token never goes in argv (visible in `ps`). It is never
   set with `tmux -e` or in the tmux server environment, which would leak it to every pane. It is never written to the
   volume.
5. **One Claude session per container loads the plugin.** The coordinator is the only Claude Code *session*. Workers are
   subagents whose frontmatter `tools:` lists exclude MCP tools, so they never receive Telegram tools (spec §469). The
   probe and doctor use only non-session subcommands (`claude --version`, `claude plugin list`), which do not start MCP
   servers. The recovery guide warns that starting an extra interactive `claude` in the container takes over the bot
   (PID-file takeover).
6. **One bot per project** (spec §597). At provisioning the host records the non-secret bot ID (the numeric prefix of the
   token) in the project registry. `doctor` warns when two registered projects share a bot ID. Before a Telegram
   coordinator launch (`minions start`, the setup coordinator step, and the restart after `minions auth telegram`), the
   host refuses (CONFLICT) when another registered Docker project with the same bot ID has a running coordinator session
   whose launch record says Telegram is enabled (`src/host/bot-guard.ts`; a running session with an unreadable record
   counts as polling). The message names the bot ID and the other project only, never the token, and offers terminal
   mode (`minions channel set terminal`), stopping the other coordinator, or a separate bot. Terminal launches are never
   checked. When this project's own coordinator session is already running, `minions start` warns and attaches to it
   (plain `tmux attach-session`, no sync or relaunch), since attaching adds no second poller. At runtime, a `409 Conflict` in the plugin's stderr maps to the precise message "another process is polling
   this bot".
7. **Terminal stays the baseline** (spec §76, §813). Every Telegram failure degrades to a terminal-only launch with a
   precise reason. Doctor never reports Telegram as `fail`.

### Where the probe runs (decision)

The probe runs **inside the container**, where Claude Code, the plugin cache, Bun, and managed settings live. Host
`doctor` calls it with `docker compose exec app minions telegram probe --json`. A host `minions telegram probe` uses
the existing delegate mechanism. The probe needs no credentials and no login. It never reads the token, `.env`, or
`access.json`, and it never starts a Claude session. Implementation: `src/telegram/probe.ts`.

## Access boundary (who can control the coordinator)

**Only paired, allowlisted senders can control the coordinator. Messages from unpaired senders are
dropped by the plugin before they reach the session** (spec §811). Under the default `pairing` DM
policy an unknown sender only receives a pairing code from the plugin itself; the code grants nothing
until the owner approves it **in the coordinator terminal** (`/telegram:access pair <code>`), and the
plugin's access skill refuses pairing or policy requests that arrive over the channel. Allowlisted
senders can also approve tool-permission prompts (permission relay), so minions requires exactly one
allowlisted sender: the owner.

What minions enforces (tested with fakes): the token and `--channels` reach only the coordinator's
`claude` process; worker agent definitions have explicit `tools:` allowlists without MCP tools, so
workers never receive Telegram tools; minions never writes `access.json`; doctor (`telegram.access`)
reports `ok` only for DM policy `allowlist` with exactly one allowlisted sender and no groups, and warns
otherwise. What the plugin enforces (not re-implemented): the inbound gate, pairing codes, and
outbound gating to allowlisted chats. `src/telegram/access.ts` (`senderCanControl`) mirrors the
documented gate for tests and status only.

## Bot token provisioning

Reuse the shared host credential mechanism (task-1.1) for a new credential kind `telegram-bot-token`:

- Storage: macOS Keychain item (preferred) or a 0600 file under the minions data root. The token never goes in config,
  `project.json`, the plan output, logs, or Git. `redact()` already masks bot-token-shaped strings.
- Delivery: `minions start` materializes the secret as a 0600 file in `projects/<id>/secrets/`, whose directory is
  bind-mounted read-only at `/opt/minions/secrets` (task-1.1 mechanism), so the token is at
  `/opt/minions/secrets/telegram-bot-token`.
- Residual risk (spec §120): the coordinator's tools, and their child processes, can read the token from the mount or the
  environment. The design doc and wizard say so plainly.
- Rotation: re-run the wizard step, then do a controlled coordinator restart (spec §653: Telegram changes are restart-required).
  Revoking in BotFather (`/revoke`) invalidates the old token.

## Wizard flow (host, `minions init` / config step "Communication")

1. Explain the research-preview status, that Anthropic auth (not Bedrock/Vertex/Foundry) is required, and that Team/Enterprise
   orgs need an Owner to enable channels. Offer terminal-only as the recommended default.
2. Bot creation: open https://t.me/BotFather, send `/newbot`, choose a display name and a unique username ending in `bot`,
   and copy the token. Recommend one bot per project, and optionally `/setjoingroups` → Disable (DM-only use).
3. Token entry: hidden input. Validate the format `^\d{6,12}:[A-Za-z0-9_-]{30,64}$` locally. Optionally, with explicit consent,
   check it with the read-only Bot API `getMe` from the host to show the bot username. Store it with the shared credential
   mechanism. Warn if the bot ID is already registered to another project.
4. Plan output (reviewable, no secrets): config change `communication.channel: telegram`, the secret mount, the image rebuild
   (Bun), and the plugin install inside the container. Apply on confirmation. Restart-required.
5. `minions start`: the container runs `minions telegram install` if needed, then `minions telegram probe`. If the probe
   is not `available`, the wizard prints the probe's precise reason and keeps terminal mode.
6. Pairing (must happen in the attached terminal): DM the bot any message. The bot replies with a 6-character code. In the
   coordinator terminal, type `/telegram:access pair <code>`.
7. Lock down: `/telegram:access policy allowlist`. Pair only the owner. Allowlisted senders can also approve tool-permission
   prompts through permission relay.
8. Verify: `minions doctor` reports `telegram.plugin` ok, plus a planned `telegram.access` status (policy is `allowlist`,
   `allowFrom` non-empty) read from the documented `access.json` schema. The status read never includes pending codes,
   and minions never writes the file.

## Channel selection: `terminal` | `telegram` | `auto`

`communication.channel` is resolved in one place, `resolveChannel` in `src/telegram/channel.ts`, used by the
launch (`decideTelegram`), `minions status`, `minions channel show|set`, `minions start`, doctor and `auth telegram`:

| Configured | Token stored | Runtime | Effective | Notes |
| - | - | - | - | - |
| `terminal` | any | any | terminal | a stored token is unused (doctor and `auth telegram` say so) |
| `auto` (profile default) | no | any | terminal | quiet: plain terminal mode, no warning, no plugin install |
| `auto` | yes | docker | telegram | same fallbacks as `telegram`: network `none`, invalid token, probe not run or not `available` → terminal with the reason |
| `auto` | yes | host | terminal | warned: the host runtime has no Telegram |
| `telegram` | no | docker | terminal | warned: "Telegram bot token is not provisioned; run `minions auth telegram`" |
| `telegram` | yes | docker | telegram | unless the network/probe fallbacks apply |
| `telegram` | any | host | terminal | warned (`HOST_TELEGRAM_REASON`) |

"Token stored" is the host credential reference on the host (no secret store read, no network) and the
read-only token mount inside the runtime. The plugin probe runs only at launch, so host-side views
(`channel show`, doctor without a running container) report Telegram as *predicted* (`cause: unchecked`).
Telegram is *intended* (`wantsTelegram`) for `telegram`, and for `auto` with a stored token: only then does
`minions start` install the plugin and start the coordinator detached, and does doctor check `telegram.access`.

- `minions channel show`: configured value and its layer (project file / `config.local.json` / default), the
  effective channel and reason, token stored, runtime.
- `minions channel set <value> [--dry-run] [--yes]`: edits `communication.channel` in the config file the install
  uses (shared `.minions/config.json` or private config) through `editProjectConfig` (`src/host/config-write.ts`,
  also used by `setDeliveryMode`): strict parse first (a file that does not parse is never overwritten),
  `configRevision` bump, full validation with `config.local.json`, atomic write, derived files refreshed. A
  hand-edited file is written but stays "edited" in the manifest. Never commits. Next steps: `minions auth telegram`
  when no token is stored, commit reminder for shared configs, `minions down && minions start` when the runtime is
  running (restart-required); host runtime: a warning that Telegram is unavailable there.
- `minions auth telegram`: after storing the token, an explicit `terminal` channel gets an offer (interactive,
  default yes) to switch to `auto` through the same `setChannel` path; with `--stdin`, `--json` or no terminal it
  only prints the hint `minions channel set auto`.
- `minions status` (runtime): `channel: { configured, effective, reason, source: launch|predicted, restartRequired? }`,
  from the running coordinator's launch record when there is one.

## Launch integration

- `buildClaudeCommand` (called by the exec wrapper) adds `--channels plugin:telegram@claude-plugins-official` only when `communication.channel`
  resolves to Telegram (`telegram`, or `auto` with a token), the probe reports `available`, and the token mount exists. Otherwise it launches terminal-only and prints
  the reason. Example: `Telegram disabled for this session: Bun is not installed …`.
- tmux runs `minions coordinator run` (the exec wrapper) instead of `claude` directly, so the token stays out of tmux's environment.
- Telegram mode must work with nobody attached: `minions start --no-attach` starts the tmux session detached. tmux gives the
  session a pty, so it is an interactive Claude session (not `-p`), and channel delivery and the plugin's pairing flow work.
  First-run interactive prompts (login, workspace trust) must be cleared once while attached. The wizard says so.
- `bypassPermissions` stays forbidden. Permission prompts either relay to the paired owner (plugin capability) or wait
  for the terminal.
- Telegram config changes trigger a controlled coordinator restart: drain or record in-flight state, kill the tmux session, relaunch.

## Implementation (step 7)

| Piece | Where | Behavior |
| - | - | - |
| Credential kind | `src/host/credentials.ts` (`TELEGRAM_CREDENTIAL`) | Same stores, reference file and secrets dir as the GitHub token. Keychain service `minions.telegram`; file `credentials/<id>/telegram-bot-token`. `credentials.json` keeps `botId` (not secret) for the one-bot-per-project warning; it lives there rather than in the registry so the registry schema is unchanged. |
| Standalone command | `minions auth telegram [--stdin] [--verify] [--remove] [--dry-run]` | Prints the bot/pairing guidance, reads the token without echo, stores it, and on a running container re-materializes it and runs `minions coordinator sync` (controlled restart). `--verify` (getMe) is opt-in. |
| Wizard | `src/host/wizard.ts`, `src/host/install.ts` | "Communication channel (auto/terminal/telegram)", default `auto` (Telegram when a bot token is stored, otherwise terminal; a next step names `minions auth telegram`). Explicit `telegram` prints the guidance (preview status, BotFather, one coordinator per bot, pairing, owner-only allowlist, residual risk). `container.network: none` falls back to terminal with the reason. After the plan is applied: the token offer (hidden prompt, optional consented getMe). Declined or failed: init says the coordinator stays terminal-only until `minions auth telegram`. |
| Image | `docker/Dockerfile` | Bun 1.4.3 from a throwaway stage, SHA-256 pinned per architecture; `BUN_INSTALL_CACHE_DIR=/home/node/.cache/bun` (cache volume). |
| Plugin install | `minions telegram install` (`src/telegram/install.ts`) | Adds the official marketplace if missing, installs `telegram@claude-plugins-official` at user scope, never re-enables it there (task-51: off at user scope is intended), never updates. Refuses a marketplace named `claude-plugins-official` that points at another repo. Run by `minions start` when Telegram is selected; failure only warns. |
| Exec wrapper | `minions coordinator run` (`runCoordinator`) | tmux runs it instead of `claude`. It reads and validates the mounted token, runs the probe, and decides (`decideTelegram`). Enabled: `--channels plugin:telegram@claude-plugins-official`, `TELEGRAM_BOT_TOKEN` in the child env only, and the plugin's `reply`/`react`/`edit_message` tools allowed in `--settings`. Otherwise an inherited `TELEGRAM_BOT_TOKEN` is removed and it prints `Telegram disabled for this session: <reason>. Terminal mode is active.` (`auto` without a token: `terminal mode (<reason>)`). It writes `/state/coordinator-launch.json` (channel, decision, fingerprint; no token). While claude runs it ignores SIGINT/SIGQUIT (claude gets Ctrl-C from the pane itself, so a stray Ctrl-C cannot end the tmux session) and forwards SIGTERM/SIGHUP to claude; a signal exit returns 128+n. On exit it writes `/state/coordinator-exit.json` (exit code or redacted error message). |
| Controlled restart | `minions coordinator sync [--force] [--start-detached]` | Compares the running launch's fingerprint (channel, network, truncated token hash) with the current state. On a difference it kills the tmux session, records `coordinator_restart` in the runtime DB, and relaunches detached if asked. A detached start waits 2s and re-checks `tmux has-session`; if the wrapper already died it fails with the error from `/state/coordinator-exit.json` instead of reporting `started`. While worker leases are active it defers (`restart-pending`) unless `--force`; leases stay in the DB for `recover`. `minions start` runs it (detached start when Telegram is wanted (`telegram`, or `auto` with a stored token) and nobody attaches). |
| Requested restart | `minions coordinator restart [--recover] [--force]` (`restartCoordinator`) | Container-side entry point for the host upgrade. Same path as `sync`, but unconditional: kills the session if it runs and relaunches it detached (same 2s settle check). `--recover` makes tmux run `minions coordinator run --recover`, which passes `RECOVERY_PROMPT` to claude as its first user message (after `--`): `/minions:recover` (reconcile leases, re-dispatch), then `/minions:orchestrate` (pause state still applies). Refuses with `PRECONDITION` while worker leases are active in a running session unless `--force`; without a running session the leases are stale and left for recover. Every restart is stored in meta `coordinator_restart` and as a `coordinator-restart` event. |
| Doctor | `src/host/doctor.ts` | `telegram` (ok / missing / unavailable; never fail), `telegram.credential`, `telegram.bot` (shared bot), `telegram.plugin` (probe), `telegram.access` (`minions telegram status`: policy and counts only, never codes or ids). |
| Coordinator prompt | `templates/plugin/coordinator.md` (`telegramGuidance`) | Replies with `reply`; Telegram tools are coordinator-only; access changes are terminal-only; plain-language controls. |

| Subagent gate | `coordinatorSettings` hook, `minions hook pre-telegram` (`preTelegramHook`) | Permission rules cannot be scoped per agent, so the Telegram allow would extend to every subagent. With Telegram enabled, `--settings` adds a PreToolUse hook matching `mcp__plugin_telegram_telegram__.*`. It denies any call whose hook input carries `agent_id` or `agent_type` (the built-in `general-purpose`, `Explore` and `Plan` agents, plugin and user agents, and minions workers, whose `tools:` lists already exclude MCP tools). Only the coordinator's main thread may use Telegram tools. The hook fails closed: unparseable or non-object input, a missing or non-Telegram `tool_name`, and any `agent_id`/`agent_type` that is set at all (non-string or empty included) are denied, and the command is `minions hook pre-telegram || exit 2` so a missing binary or a crash blocks the call (exit 2) instead of being a non-blocking hook error. |

MCP tool names: plugin MCP tools follow Claude Code's `mcp__plugin_<plugin>_<server>__<tool>` scheme. A live
coordinator run with `telegram@claude-plugins-official` 0.0.7 confirmed `mcp__plugin_telegram_telegram__reply`,
`__react`, `__edit_message` and `__download_attachment`. `reply`, `react` and `edit_message` are allowed;
`download_attachment` still prompts. **Confirm the names in the first live run after any plugin or Claude Code
upgrade** (`/mcp` in the coordinator session, or the tool names in a permission prompt). If they change, replies fall
back to normal permission prompts and the subagent gate stops matching, so update `TELEGRAM_TOOL_PREFIX` in
`src/runtime/coordinator.ts`. The gate also depends on Claude Code putting `agent_id`/`agent_type` in subagent hook
input. Check that in the same run: a `general-purpose` subagent asked to call `reply` must be denied, and
`/state/logs/hooks.log` must show `pre-telegram deny`.

## Notification outbox

Goal (spec §611): Telegram outages never discard notifications, retries use dedup keys, and no LLM is woken only to resend.
Implemented in `src/runtime/outbox.ts` (transport-agnostic) with the `minions notify` helpers.

- Store: runtime DB table `outbox(dedup_key PRIMARY KEY, kind, task_id, text, created_at, attempts, last_error,
  next_attempt_at, delivered_at, delivered_via)`, added by schema migration 4 inline in `src/runtime/db.ts` (the runtime
  DB migrations are not files under a `migrations/` directory). Delivered rows are kept, so a key is never sent twice.
- Kinds: `goal-ack`, `delivered`, `feature`, `blocker`, `approval`, `question`, `status`, `other`. Text at most 4000
  characters (Telegram's limit is 4096), always passed on stdin, never as an argument.
- Keys name the event: `goal-ack:<message_id>`, `delivered:<taskId>:<headSha>`, `feature:<parentId>:<headSha>`,
  `blocker:<taskId>:<attempt>`, `approval:<taskId>:<headSha>`, `status:<message_id>`. Enqueueing an existing key
  (pending or delivered) is a no-op that returns the stored row.
- Producer: the coordinator, following `communication.progress` (per-stage transitions are never sent; approvals always).
  It records first (`minions notify enqueue --key … --kind … [--task …] --json` with the text on stdin), sends with
  `reply`, then `minions notify ack <key> --json`. A `reply` error goes to `minions notify fail <key> --error <msg>`: the
  attempt is counted, the error is stored masked and truncated, and the next try waits 30 s doubling per attempt (cap 30 min).
- Delivery: only the coordinator model can call the plugin's `reply` tool, because minions does not duplicate the
  transport. Whenever it is awake anyway (an inbound Telegram message, a worker result, `minions sync`, a terminal turn),
  the orchestrate skill first sends what `minions notify pending --json` lists (oldest first, due items only) and acks
  each, stopping at the first failure (`flush` in `outbox.ts` is the reference loop; tests drive it with a fake transport).
- No wake-ups: the Stop hook never continues the session because the outbox is non-empty, and the coordinator never
  loops or schedules wake-ups to resend.
- Visibility: `minions status` and `minions sync` show the pending count (and `minions notify pending --all` lists every
  undelivered item from the terminal), so nothing is lost if Telegram is never restored.
- Semantics: at least once per key. A crash between `reply` and `ack` can repeat that one message; nothing else repeats.

## Restart survival (context resets)

Routine context resets (task-45, [bootstrap.md](bootstrap.md#coordinator-context-resets)) restart the coordinator
often, so the pairing, inbound messages and queued notifications must survive a restart. Evidence:

- Pairing and access: `access.json`, `approved/` and `inbox/` live in the Telegram state dir under `/state`, which
  the restart never touches: it kills and relaunches only the tmux session, and the new wrapper's startup sweep only
  clears lease scratch dirs and the TMPDIR root. Test: `test/runtime/context-reset.test.ts` ("Telegram survives a
  restart"): the files are byte-identical after `restartCoordinator --recover` plus the startup sweep, and no
  restart command references the Telegram state dir.
- Outbox: pending notifications are rows in the runtime DB (see [Notification outbox](#notification-outbox)); the same
  test reads them back through a fresh DB connection after the restart, and the new session sends them on its
  first wake (orchestrate step 1).
- Inbound queue: Telegram keeps unconfirmed `getUpdates` updates for 24 hours, and an update is confirmed only by
  the next poll's offset. The plugin (`telegram@claude-plugins-official` 0.0.7, `server.ts`) starts polling with
  `bot.start({ onStart })` and never passes `drop_pending_updates`, so messages sent while no session polls are
  delivered to the next session. The same test file checks this against the installed plugin source. When the
  plugin is not installed on the host, that test is reported as skipped, not passed.
- The handoff carries open owner questions, so a question asked before the reset is re-asked only if it is still
  unanswered (recover skill).

Known gap (narrow, accepted): an inbound message that the plugin has already handed to the old session, after the
coordinator ran `restart --detach` and before the detached restart kills the tmux session (about a second), is
confirmed to Telegram but never handled. The model's context for it dies with the session. The coordinator keeps
this window small by finishing the current owner exchange before writing the handoff and restarting at once. If
the owner gets no answer, resending the message is enough.

## Terminal-equivalent controls

Over Telegram, controls are plain-language messages to the coordinator. They are not slash commands, because the plugin
owns `/start`, `/help`, and `/status`. `src/runtime/controls.ts` holds the mapping (`CONTROLS`, rendered into the
coordinator prompt); each control runs the same deterministic CLI, which also works from the host terminal without
Claude (the host CLI delegates it to the project runtime):

| Control | Telegram (to coordinator) | Terminal / host CLI |
| - | - | - |
| pause intake | "pause intake" | `minions pause --intake` |
| pause new starts | "pause starts" | `minions pause --starts` |
| pause both | "pause" | `minions pause` |
| resume | "resume" (or "resume intake" / "resume starts") | `minions resume [--intake\|--starts]` |
| status | "status" | `minions status` (includes pending notifications) |
| sync | "sync" | `minions sync` (intake, PR/CI refresh, pending notification count) |
| cancel workers | "cancel <task>" / "cancel all" | `minions work cancel <taskId…> \| --all [--reason …]` |

Cancel is best effort: it releases the task's active leases without a result (worktrees and branches are kept, a backlog
note is written, a late worker submit is refused) and continues past a failing release. Every task with a released lease
(engineer, tester or reviewer stage alike; also with `--all`) is then marked `blocked` with an "owner cancelled" note, so
the next orchestrate pass does not re-dispatch it; the owner sets it back to `ready` to resume. Done, delivered and
cancelled tasks keep their status; a backlog error while blocking is reported (`blockFailed`, exit code 1). It cannot kill a running worker
subagent itself; the coordinator stops the released workers' subagents. Only exact short phrases count as controls;
anything longer is an ordinary request for the coordinator.

Access changes (pair, allow, remove) are terminal-only by design, because the plugin's skill refuses channel-originated requests.

## Capability probe and failure messages

`minions telegram probe [--json]` (container; delegated from the host) checks the following:

| Item | How | Failure → availability, message |
| - | - | - |
| `claude` | `claude --version` | exit ≠ 0 → `unavailable`: "`claude --version` failed (exit N): …". Version not in the verified list → `unknown` (not blocking): "--channels is hidden from --help during the research preview, so support cannot be confirmed offline". |
| `bun` | `bun --version` | missing → `unavailable`: "Bun is not installed: the official Telegram channel plugin runs its MCP server with `bun` …" |
| `marketplace` | `claude plugin marketplace list --json` | missing → `not-installed`, hint `claude plugin marketplace add anthropics/claude-plugins-official`. Name points at another repo → `blocked`. |
| `plugin` | `claude plugin list --json` | missing → `not-installed`, hint `claude plugin install telegram@claude-plugins-official --scope user`. Disabled → `ok` (task-51: the coordinator launch turns it off at user scope and enables it for itself only). Notes `dependencies-refused`. |
| `org.policy` | read `/etc/claude-code/managed-settings.json` | `channelsEnabled` not `true` → `blocked`. `allowedChannelPlugins` without telegram → `blocked`. File absent → `unknown`, checked at launch. |

Precedence: `blocked` > `unavailable` > `not-installed` > `available`. Doctor maps `available` to `ok`, any other
availability to `unavailable` (never `fail`), and a missing or garbled probe (an outdated image) to `warn`. The report
always lists what it could not verify: auth and plan defaults, server-managed policy, the token, pairing, and `409` conflicts.

Planned launch-time messages (step 7): token mount missing → "Telegram bot token is not provisioned; run the wizard step".
Plugin stderr `TELEGRAM_BOT_TOKEN required` → the same message. `409 Conflict` → "another process is polling this bot;
use a separate bot per project". Startup notice "not on the approved allowlist" or "have an admin enable" → org-policy message.

## Unknowns and fallbacks

| Unknown or unsupported | Why it matters | Narrow fallback |
| - | - | - |
| No machine-readable signal that a channel **registered** (preview flags are hidden, and the result appears only in the TUI startup notice). | The probe cannot prove that `--channels` works on this account. | Report `available` only for credential-free preconditions, and list the rest as `unverified`. After launch, doctor checks that the plugin process is running (`bot.pid` + `ps`). Registration is confirmed by a real paired DM round trip in the opt-in live test. |
| Server-managed policy and plan defaults (Team/Enterprise) cannot be read without credentials. | Telegram may be silently blocked. | Show the precise startup-notice guidance in docs and the wizard, and keep terminal mode. |
| Whether a per-session `--settings '{"enabledPlugins":…}'` can keep the plugin disabled globally but enabled for the coordinator only. | It would stop extra `claude` sessions from taking over the bot. | Not relied on. Keep the "only the coordinator is a Claude session" rule, and document the takeover risk in recovery docs. |
| Plugin version pinning: marketplace installs take the catalog's current version. There is no npm package. | Plugin behavior can change between installs. | Record the installed version (probe reports it). Never auto-update (`claude plugin update` is explicit). Add the verified plugin version to docs/compatibility.md and warn on a different version once step 7 lands. |
| The plugin runs `bun install` on every start (network to npm). | It fails with `network: none` or a registry outage. | Report unavailable with that reason. A pre-warmed Bun cache in the `cache` volume reduces the dependency. Vendoring the plugin's `node_modules` is rejected because it changes the official plugin. |
| Delivery of outbox items needs the model to call `reply`. | Notifications wait until the coordinator is next awake. | Accepted by spec §611 (no LLM wake to resend). Terminal `status` shows pending items. Direct Bot API `sendMessage` from minions is a possible future fallback behind the channel adapter, but it would duplicate transport, so it is **not** in scope without a spec change. |
| `--channels` flag syntax may change during the preview. | A future Claude Code version could break the launch. | The flag string lives in one constant (`TELEGRAM_CHANNEL_SPEC`). Versions outside the verified list are reported as `unknown`, not supported. |
| Telegram slash text other than `/start`, `/help`, `/status` (for example `/pause`). | Behavior is not documented. | Use plain-language controls instead of slash commands. |

## Test strategy

- Unit (default `npm test`, deterministic, no network): `test/telegram/probe.test.ts` covers probe evaluation, fact
  gathering with a fake runner and file reader (it asserts that only the documented commands run and only the managed-settings
  file is read), and the doctor mapping, including redaction.
- Step 7, with fakes: `test/telegram/launch.test.ts` (launch argv with and without `--channels`, no token in argv/logs/launch
  record, env scoping with a fake spawn, terminal fallback reasons, controlled restart and deferral), `test/telegram/access.test.ts`
  (owner-only policy, unpaired senders cannot control, no codes or ids in status), `test/telegram/install.test.ts` (fake
  `claude plugin` CLI), `test/host/telegram.test.ts` (format, stores, Keychain stdin-only, getMe, bot-ID collisions, wizard
  and init with fake IO, doctor ok/missing/unavailable), and `test/plugin/generate.test.ts` (workers get no Telegram tools).
- Task-2.3: `test/runtime/outbox.test.ts` (enqueue/dedup/ack/fail/backoff on a temp SQLite DB; a fake transport through an outage, a runtime restart and recovery delivers each key exactly once) and `test/runtime/controls.test.ts` (control mapping, every control resolves to a registered command that the host CLI delegates, best-effort `work cancel`).
- Container boundary (`MINIONS_DOCKER_TESTS=1`): the image has Bun at the pinned version, the token mount is read-only and absent
  from `docker inspect` env, and `minions telegram probe --json` reports `available` after `minions telegram install` (needs network, no token).
- Live (opt-in only, never in CI): `MINIONS_LIVE_TELEGRAM=1` plus a disposable bot token and a logged-in container. A manual
  pairing step, then a DM round trip, a check that an unpaired sender is dropped (spec §811), outbox delivery after a
  simulated outage, and a 409 detection with a second poller. These runs live in a separate script and are documented in
  docs/compatibility.md.
