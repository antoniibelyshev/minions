# Telegram channel integration: design

Status: design plus a capability probe (`minions telegram probe`, doctor check `telegram.plugin`).
Telegram stays **deferred in v0.1**. The wizard, launch flag, outbox, and controls described here are
the plan for implementation step 7 of the spec ("Telegram configuration and startup integration").
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
  writes 0600 file, ro bind-mount               │ reads /run/minions-secrets/telegram-bot-token
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
   token) in the project registry. `doctor` warns when two registered projects share a bot ID. At runtime, a `409 Conflict`
   in the plugin's stderr maps to the precise message "another process is polling this bot".
7. **Terminal stays the baseline** (spec §76, §813). Every Telegram failure degrades to a terminal-only launch with a
   precise reason. Doctor never reports Telegram as `fail`.

### Where the probe runs (decision)

The probe runs **inside the container**, where Claude Code, the plugin cache, Bun, and managed settings live. Host
`doctor` calls it with `docker compose exec app minions telegram probe --json`. A host `minions telegram probe` uses
the existing delegate mechanism. The probe needs no credentials and no login. It never reads the token, `.env`, or
`access.json`, and it never starts a Claude session. Implementation: `src/telegram/probe.ts`.

## Bot token provisioning

Reuse the shared host credential mechanism (task-1.1) for a new credential kind `telegram-bot-token`:

- Storage: macOS Keychain item (preferred) or a 0600 file under the minions data root. The token never goes in config,
  `project.json`, the plan output, logs, or Git. `redact()` already masks bot-token-shaped strings.
- Delivery: `minions start` materializes the secret as a 0600 file in the project's private runtime directory and bind-mounts
  it read-only at `/run/minions-secrets/telegram-bot-token`. The exact host path and mount mechanics follow task-1.1. If
  task-1.1 picks Compose secrets, the in-container path changes, but the exec-wrapper contract stays the same.
- Residual risk (spec §120): the coordinator's tools, and their child processes, can read the token from the mount or the
  environment. The design doc and wizard say so plainly.
- Rotation: re-run the wizard step, then do a controlled coordinator restart (spec §653: Telegram changes are restart-required).
  Revoking in BotFather (`/revoke`) invalidates the old token.

## Wizard flow (host, `minions init` / config step "Communication")

1. Explain the research-preview status, that Anthropic auth (not Bedrock/Vertex/Foundry) is required, and that Team/Enterprise
   orgs need an Owner to enable channels. Offer terminal-only as the recommended default.
2. Bot creation: open https://t.me/BotFather, send `/newbot`, choose a display name and a unique username ending in `bot`,
   and copy the token. Recommend one bot per project, and optionally `/setjoingroups` → Disable (DM-only use).
3. Token entry: hidden input. Validate the format `^\d{6,12}:[A-Za-z0-9_-]{30,}$` locally. Optionally, with explicit consent,
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

## Launch integration

- `buildCoordinatorCommand` adds `--channels plugin:telegram@claude-plugins-official` only when `communication.channel`
  is `telegram`, the probe reports `available`, and the token mount exists. Otherwise it launches terminal-only and prints
  the reason. Example: `Telegram disabled for this session: Bun is not installed …`.
- tmux runs `minions coordinator run` (the exec wrapper) instead of `claude` directly, so the token stays out of tmux's environment.
- Telegram mode must work with nobody attached: `minions start --no-attach` starts the tmux session detached. tmux gives the
  session a pty, so it is an interactive Claude session (not `-p`), and channel delivery and the plugin's pairing flow work.
  First-run interactive prompts (login, workspace trust) must be cleared once while attached. The wizard says so.
- `bypassPermissions` stays forbidden. Permission prompts either relay to the paired owner (plugin capability) or wait
  for the terminal.
- Telegram config changes trigger a controlled coordinator restart: drain or record in-flight state, kill the tmux session, relaunch.

## Notification outbox

Goal (spec §611): Telegram outages never discard notifications, retries use dedup keys, and no LLM is woken only to resend.

- Store: a new runtime DB table `outbox(dedup_key TEXT PRIMARY KEY, kind, task_id, payload_json, created_at, attempts,
  last_error, delivered_at)`. It is added in a migration with the runtime DB, which is a sensitive path, so it needs human
  approval when it is implemented.
- Producers: deterministic CLI events enqueue with stable keys, for example `question:<taskId>:<questionId>`,
  `delivered:<taskId>:<headSha>`, `blocked:<taskId>:<attempt>`, `milestone:<taskId>:<status>`. Enqueueing an existing key is
  a no-op.
- Delivery: only the coordinator model can call the plugin's `reply` tool, because minions does not duplicate the transport.
  When the coordinator is already awake (an inbound Telegram message, a worker result, a sync, or a user turn), the
  orchestrate skill runs `minions notify pending --json`, sends each item with `reply`, and then calls
  `minions notify ack <key>`. A `reply` error goes to `minions notify fail <key> --error <msg>`, which increments the
  attempt count with backoff.
- No wake-ups: the Stop hook never continues the session only because the outbox is non-empty.
- Semantics: at least once. A crash between `reply` and `ack` can duplicate one message, which is documented. The terminal
  `minions status` shows the outbox count, so nothing is lost if Telegram is never restored.

## Terminal-equivalent controls

Over Telegram, controls are plain-language messages to the coordinator. They are not slash commands, because the plugin
owns `/start`, `/help`, and `/status`. The coordinator maps each control to the same deterministic CLI, which also works
from the host without Claude:

| Control | Telegram (to coordinator) | Terminal / host CLI |
| - | - | - |
| pause intake | "pause intake" | `minions pause --intake` (exists) |
| pause new starts | "pause starts" | `minions pause --starts` (exists) |
| resume | "resume" | `minions resume` (exists) |
| status | "status" | `minions status` (exists) |
| cancel workers | "cancel <task or all>" | `minions work release <lease> --reason` (exists, per lease); a bulk `cancel` is planned |
| sync | "sync" | planned `minions sync` (backlog/outbox sync) |

Access changes (pair, allow, remove) are terminal-only by design, because the plugin's skill refuses channel-originated requests.

## Capability probe and failure messages

`minions telegram probe [--json]` (container; delegated from the host) checks the following:

| Item | How | Failure → availability, message |
| - | - | - |
| `claude` | `claude --version` | exit ≠ 0 → `unavailable`: "`claude --version` failed (exit N): …". Version not in the verified list → `unknown` (not blocking): "--channels is hidden from --help during the research preview, so support cannot be confirmed offline". |
| `bun` | `bun --version` | missing → `unavailable`: "Bun is not installed: the official Telegram channel plugin runs its MCP server with `bun` …" |
| `marketplace` | `claude plugin marketplace list --json` | missing → `not-installed`, hint `claude plugin marketplace add anthropics/claude-plugins-official`. Name points at another repo → `blocked`. |
| `plugin` | `claude plugin list --json` | missing → `not-installed`, hint `claude plugin install telegram@claude-plugins-official --scope user`. Disabled → `not-installed`, hint `claude plugin enable …`. Notes `dependencies-refused`. |
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
- Planned with step 7, using fake adapters: launch argv with and without `--channels` (no token in argv), the exec wrapper's env
  scoping (a fake spawn records env), outbox enqueue/dedup/ack/fail/backoff on a temp SQLite DB, control mapping, the wizard
  with fake IO and a fake credential store, and bot-ID collision detection in the registry.
- Container boundary (`MINIONS_DOCKER_TESTS=1`): the image has Bun at the pinned version, the token mount is read-only and absent
  from `docker inspect` env, and `minions telegram probe --json` reports `available` after `minions telegram install` (needs network, no token).
- Live (opt-in only, never in CI): `MINIONS_LIVE_TELEGRAM=1` plus a disposable bot token and a logged-in container. A manual
  pairing step, then a DM round trip, a check that an unpaired sender is dropped (spec §811), outbox delivery after a
  simulated outage, and a 409 detection with a second poller. These runs live in a separate script and are documented in
  docs/compatibility.md.
