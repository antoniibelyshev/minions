# Minions-owned Telegram channel: design

Status: **proposed** (task-67, design only, nothing built). The owner has to agree before any build task starts.
It replaces the shipping plan of [telegram-decisions.md](telegram-decisions.md) (task-35, patched fork) and keeps
that design's UX choice (tap buttons, numbered text as fallback). Facts about the official plugin come from
[telegram.md](telegram.md) and telegram-decisions.md (both read from `telegram@claude-plugins-official` 0.0.7).
Facts marked **unknown** are listed in [Unknowns](#unknowns). For this design only `claude --version` and
`claude --help` were run (2.1.292). No Claude session was started and no Bot API call was made.

## Why

The official plugin forwards messages only. The coordinator cannot see:

- which bot message the owner replied to, or the quoted text (`reply_to_message` and `quote` are dropped);
- button taps (`callback_query` other than its own permission buttons is dropped) or poll votes;
- anything that would let it send buttons, show typing, or edit anything other than text.

So threading relies on a typed `ref: #<id>` convention (tasks 58 and 66) and on guessing. Decisions are typed
numbers. The owner asked for a channel that shows replies and quotes, and that can send tap-button decisions,
edits, files and typing.

## Decision: own MCP channel server, not the patched fork

| | Task-35 plan: patched fork (S2) | Own server (chosen) |
| - | - | - |
| Runtime | Bun, plus `bun install` from npm at **every start** (fails with `network: none` or a registry outage) | Node, inside the existing `minions` bundle (`dependencies: {}`), no install at start |
| Bot API client | grammy | `src/host/manager-telegram.ts` client, extracted and shared (already has long poll, inline keyboards, callback answers, `editMessageText`, 409/401/429 mapping, token redaction, persisted offset) |
| Features in scope | `ask`/`close_decision` is a small patch. Reply metadata, quotes, typing, a message map and the ref footer would make the patch large, which removes the "small patch, easy rebase" advantage. | All of them, in our code, with our tests |
| Channel allowlist | Not allowlisted: needs `--dangerously-load-development-channels` | Same cost, no difference |
| Single poller | Upstream "newest wins": SIGTERMs whatever `bot.pid` names. This is the task-51 hijack mechanism. | "Coordinator wins": only the coordinator launch may poll, strays never take over (below) |
| Token | Env by default; file only with a patch | File only, read by the server; never in the coordinator `claude` env |
| Access/pairing | Unchanged code and `/telegram:access` skill | Same `access.json` semantics, re-implemented; pairing is a terminal CLI instead of a skill |
| Tool prefix | Unchanged (`mcp__plugin_telegram_telegram__`) | New prefix: one constant, the hook matcher and the allow list change |
| Upkeep | Rebase on every upstream bump, two languages | One codebase, one test suite, ships with `minions upgrade` |

**Choice: own server.** The fork's two real advantages (unchanged gate code and unchanged tool prefix) are small
next to its costs: Bun and npm at start, newest-wins polling, and a patch that has to grow to cover the requested
features. Re-implementing the gate is small, because minions supports one owner in a DM only. The manager bot
(task-53.5) already has a reviewed owner-only gate and pairing that we can follow. The official plugin stays
installed as the **fallback** (see [Launch swap and fallback](#launch-swap-and-fallback)). Upstreaming (task-35.7)
is dropped. Our server does not depend on it.

Rejected as well: a sidecar next to the official plugin (it cannot receive, since only one poller is allowed); the
coordinator calling the Bot API through Bash (it would hold the token).

## How a channel server works (what we rely on)

From the channels reference ([telegram.md](telegram.md) verified facts). The preview flags are hidden from
`claude --help` on 2.1.292, as before.

- A channel is an MCP server over stdio that declares the capability `experimental: { "claude/channel": {} }`.
  Optionally it also declares `claude/channel/permission` for permission relay.
- Inbound: the server sends `notifications/claude/channel` with `{ content, meta }`. Claude Code shows it to the
  session as `<channel source="<server>" key="value" ...>content</channel>`. Meta values are strings that the server
  sets. The sender cannot forge them.
- Notifications are delivered only for servers named in `--channels` (allowlisted plugins) or in
  `--dangerously-load-development-channels <spec>`. The development flag is ignored with `-p`. That is fine,
  because the coordinator is interactive in tmux. Servers that are not named still load and their tools still work.
- Outbound: ordinary MCP tools, named `mcp__<server>__<tool>`.

**Unknown, and a spike settles it (phase 0):** whether the development flag accepts a `--mcp-config` server
(`server:<name>`), and whether it shows a confirmation at startup. A confirmation would block detached starts and
context-reset restarts.

## Server shape

- **Entry point:** `minions telegram channel serve`, a subcommand of the existing CLI in the container. It speaks
  newline-delimited JSON-RPC 2.0 on stdin/stdout, written without the MCP SDK (the project has no runtime
  dependencies; the manager client is also hand-written). It handles `initialize`, `tools/list`, `tools/call`,
  `notifications/initialized`, and the permission-relay notifications. Logs go to
  `/state/logs/telegram-channel.log` (redacted), never to stdout.
- **Loaded only by the coordinator launch**, through a `--mcp-config` file that the wrapper generates on each launch
  (`/state/coordinator-mcp.json`, server name `minions-telegram`, no secrets in it). The server is not a plugin and
  is not enabled at user scope, so a nested `claude` never loads it (the root cause of task-51, removed by design).
  Tool prefix: `mcp__minions-telegram__` (constant `TELEGRAM_TOOL_PREFIX` becomes a function of the selected server).
- **Layers:**
  1. `src/telegram/bot-api.ts`: the Bot API client, moved out of `manager-telegram.ts` (`call`, `callRetry`, error
     mapping, redaction, offset file, `isForwarded`, the owner check). The manager transport keeps its behavior and
     its tests and imports the client. New methods: `sendDocument`/`sendPhoto` (multipart), `sendChatAction`,
     `setMessageReaction`, `getFile` plus download, `editMessageReplyMarkup`.
  2. `src/telegram/channel/core.ts`: pure update to notification mapping, gate, decisions, message map. No I/O, so it
     is unit-tested.
  3. `src/telegram/channel/server.ts`: stdio JSON-RPC, poll loop, lock, wiring.
- **State:** the existing state dir (`TELEGRAM_STATE_DIR`, default `$CLAUDE_CONFIG_DIR/channels/telegram`) for
  `access.json`, `inbox/` (downloads) and the offset file. The runtime DB (`/state`) gets a `tg_messages` table for the
  message map and a `tg_decisions` table for decisions (inline migration in `src/runtime/db.ts`, as the outbox did).
  The task-57 router design reads the same `tg_messages` table.

### Token isolation

- The wrapper (`minions coordinator run`) **no longer puts `TELEGRAM_BOT_TOKEN` in the coordinator `claude` env**. It
  only passes `MINIONS_TELEGRAM_TOKEN_FILE=/opt/minions/secrets/telegram-bot-token` (a path, not the secret) in the
  generated MCP config's `env`.
- The server reads the file once at start, checks the format (`checkTelegramTokenFormat`), and keeps the token in
  memory. The token travels only in the Bot API URL path. Errors, logs, tool results and notifications never
  contain it (`redact`, as in the manager client).
- The coordinator model never reads the token. Tool results carry only ids. Residual risk, unchanged and stated as
  in telegram.md: the read-only mount is still readable from the coordinator's Bash. This is an improvement over
  today, where the token is in the env of every Bash command and every worker command.

### One poller per bot (task-17/51/52)

- **Coordinator wins, strays lose** (the opposite of the official newest-wins rule). The server polls only when all
  of these hold:
  1. `MINIONS_COORDINATOR_LAUNCH=<launch id>` in its env matches `/state/coordinator-launch.json`;
  2. its nearest `claude` ancestor is the wrapper's direct child (same rule as `checkTelegramPoller`);
  3. it holds `<state>/channel.lock` (`{pid, start}`, the reuse-safe rule of the coordinator lock).
  Otherwise it does not poll. Its tools then return `channel not active in this session`, and it logs why.
- It never writes `bot.pid`, so a stray official plugin cannot SIGTERM it. On a persistent `409 Conflict` it reads
  `bot.pid`. If that names a live official `server.ts` that is not under the coordinator claude (the task-51
  class), it stops that process once and logs it. Otherwise it reports "another process polls this bot". The
  host-side `bot-guard.ts` (one bot per project, the manager bot distinct) is unchanged.
- `isolation.ts`, `minions status` and doctor `telegram.poller` learn the new lock (`server: minions | official`).
  The recovery hint changes from "/mcp reconnect plugin:telegram:telegram" to "/mcp reconnect minions-telegram"
  when our server is active.

## Inbound format

Every gated update becomes one `notifications/claude/channel`. Meta keys are flat strings. Quoted text is collapsed
to one line and cut to 300 characters.

| Update | `content` | Meta (beyond `chat_id`, `message_id`, `user`, `user_id`, `ts`) |
| - | - | - |
| Text message | the text | `reply_to_message_id`, `reply_to_from` (`bot` \| `owner`), `reply_to_text` (Telegram's `quote.text` when the owner selected part of the message, else the start of the replied message), `reply_to_ref` (the ref the bot sent with that message, from `tg_messages`), `quote` (`partial` \| `full`) |
| Media (photo, document, voice, ...) | caption or `(photo)` | as in 0.0.7: `image_path` (downloaded photo) or `attachment_file_id`, `attachment_kind`, `attachment_name`; plus the reply keys |
| Button tap on a decision | `answer: 2. Keep the current order` (or `answer: other`) | `message_id` = the question, `decision_id`, `decision_option`, `reply_to_ref` = the decision's ref |
| Tap on a closed/unknown decision | not forwarded; toast "This question is closed. Reply with the number instead." | |
| `poll_answer` | not used: native polls are not built (task-35 chose buttons). Format reserved: `answer: <labels>`, meta `poll_id`, `option_ids` | |
| Edited owner message | `(edited) <text>` | `edited: "true"` |
| Forwarded message | dropped, like the manager bot: only what the owner types counts | |

The trusted parts are the meta keys. The content stays untrusted owner text. `answer: <n>` from a tap and a typed
`<n>` replying to the question mean the same thing. The tap form is unambiguous.

## Outbound tools

All tools check the chat against `access.json` first (same rule as `assertAllowedChat`). `chat_id` is optional and
defaults to the single allowlisted owner DM. Text is plain (no `parse_mode`), cut at 4000 characters with a note.

| Tool | Arguments | Notes |
| - | - | - |
| `reply` | `text`, `reply_to?`, `ref?`, `files?` (absolute paths) | Appends `ref: #<ref>` when `ref` is given, records `tg_messages(message_id, ref, outbox key?, text head, sent_at)`, returns `sent (id: N)`. Files go out as documents (photos when the extension is an image), max 50 MB, and only paths under the worktree, `/state` or the scratch dir. |
| `ask` | `text`, `options[{label, button?}]` (2 to 10), `recommended?`, `allow_other?` (default true), `reply_to?`, `ref?`, `decision_id?` | The task-35 design unchanged: numbered text in the body, inline buttons `dec:<id>:<n>`, persisted in `tg_decisions`, keyboard removed and "Chosen: …" appended on the first tap. |
| `close_decision` | `decision_id`, `note?` | For a question answered by typing, or one that is obsolete. |
| `edit_message` | `message_id`, `text`, `keep_buttons?` | Only messages this bot sent (`tg_messages`). Edits do not notify, so finished work gets a new `reply`. |
| `react` | `message_id`, `emoji` | Telegram's fixed reaction set; an unsupported emoji is an error, not a silent drop. |
| `typing` | `on?` (default true) | `sendChatAction typing`, repeated every 4 s until the next send from the server or 2 min; `on: false` stops it. |
| `download_attachment` | `file_id` | Saves to `<state>/inbox/`, returns the path (20 MB Bot API limit). |

**Permission relay:** kept at parity with 0.0.7: `perm:allow|deny:<id>` buttons, owner only, answered once, the
message edited with the outcome. **Bot commands** `/start`, `/help` and `/status` are answered by the server, as
before. Plain-language controls are unchanged.

## Access and pairing

- Same `access.json` file, path and schema (`dmPolicy`, `allowFrom`, `groups`, `pending`), re-read on every update
  and every tool call. An existing pairing keeps working after the swap, with nothing to migrate. minions supports
  only `allowlist` with one sender and no groups (doctor `telegram.access`, unchanged). Groups are always ignored.
- Under `pairing`, an unknown DM sender gets a 6-character code from the server (the 0.0.7 behavior), and nothing
  else is forwarded.
- Approving a code becomes a **terminal CLI**, because the `/telegram:access` skill belongs to the official plugin:
  `minions telegram access pair <code> | policy allowlist | list | remove <id>` (host-delegated into the container).
  It refuses without an interactive TTY and asks for a typed confirmation. The coordinator's Bash has no TTY, so a
  channel message cannot get the model to pair anyone. This reverses telegram.md decision 1 ("minions never
  writes `access.json`"): minions now owns that file. The atomic 0600 write is the same as the plugin's.

## Launch swap and fallback

- Config `communication.telegram.server: minions | official` (default `official` until phase 3 flips it).
  Restart-required, like every Telegram setting.
- `minions` selected: the wrapper writes the MCP config and adds
  `--mcp-config /state/coordinator-mcp.json --dangerously-load-development-channels <spec>`. It drops
  `--channels plugin:telegram@claude-plugins-official`, sets `enabledPlugins["telegram@claude-plugins-official"] = false`
  in `--settings` as well, allows the new tools, and moves the PreToolUse subagent gate to the new prefix.
  `/state/coordinator-launch.json` records `server: minions`.
- **Fallback to the official plugin** (with the reason printed and recorded, as the terminal fallback does today):
  `minions telegram channel serve --check` fails before launch (bad token file, unreadable `access.json`, DB
  migration error); the spike-verified development flag is unavailable on this Claude Code version (version not in
  the verified list); or the org policy (managed `allowedChannelPlugins`) blocks development channels. If the
  official plugin is also unavailable, the launch falls back to terminal, as today.
- If the server dies at runtime, the coordinator guidance says to `/mcp` reconnect `minions-telegram` or restart.
  There is no silent switch mid-session, because a switch needs a relaunch.

## Packaging, install and upgrade (task-3.14)

- The server ships inside the minions CLI bundle and image. There is no marketplace, no Bun and no `bun install`.
  `minions upgrade` updates it with the CLI and then does its normal coordinator restart. That restart picks up
  the new server.
- task-3.14 shrinks to the fallback: when `server: official` (or as the fallback install), upgrade still runs
  `minions telegram install` for the official plugin. With `server: minions` the plugin is optional, and doctor
  says when the fallback is not installed.
- The probe (`minions telegram probe`) gets a `server` item. For `minions` it checks the CLI version, that the
  token mount exists, and the Claude Code version against the verified list. It never calls the Bot API.

## Threading and the ref rule (tasks 58 and 66)

With reply metadata visible, threads become deterministic:

1. **Owner reply to a bot message:** the thread is `reply_to_ref` (or the decision's ref). No guessing.
2. **No reply, but a typed `#ref`:** that thread (unchanged).
3. **Neither:** a new request or thread (task-66, unchanged).
4. **Bare number:** answers the replied-to question. Without a reply, it answers the only open decision, otherwise
   the coordinator asks which one (task-66, unchanged). Taps make this case rare.

The coordinator still answers with `reply_to` = the owner's message (task 58). The `ref: #<id>` footer stays as a
visible label, but the server appends it from the `ref` argument, so the model no longer types it. The prompt's
Threads bullet changes in phase 3. [coordinator-sessions.md](coordinator-sessions.md) routing rule 3 ("no ref =
latest message") is replaced by rules 1 and 3 above. See that doc.

## Migration of the task-35 plan

| Task-35 build task | Fate |
| - | - |
| 35.1 spike: development channel in a detached coordinator | **Kept, retargeted** as phase 0 (a `--mcp-config` server instead of a fork) |
| 35.2 fork packaging (`telegram@minions`) | **Superseded**, dropped |
| 35.3 plugin patch (`ask`, `close_decision`, `decisions.json`, `dec:` callbacks, edit) | **Superseded** by phase 2 (same semantics, `tg_decisions` in the runtime DB instead of `decisions.json`) |
| 35.4 launch and isolation for the fork | **Superseded** by phase 1 |
| 35.5 coordinator prompt and outbox | **Superseded** by phase 3 |
| 35.6 opt-in live check | **Superseded** by phase 4 |
| 35.7 upstream PR (S1) | **Dropped** (optional later, needs owner approval for `external.create`) |

## Tests (fake Bot API, no network, no token)

- **Fake Bot API:** an injected `fetch` (as the manager transport tests do) backed by an in-memory bot. It queues
  updates for `getUpdates`, records every call, returns `message_id`s, and can return 409, 429 (`retry_after`) and 401.
- **Fake MCP client:** paired streams that drive `initialize`, `tools/list` and `tools/call`, and collect
  notifications.
- **Cases:** reply with `reply_to` and the ref footer; inbound reply with the full quote, a partial `quote` and a
  reply to an unknown message; `ask` then tap, double tap, closed decision, Other, and a restart between ask and tap;
  `close_decision`; edit of a message the bot did not send (refused); files (path policy, multipart); typing start
  and stop; react; gate (stranger, group, forwarded, bot sender; pairing code for an unknown DM); permission relay;
  offset persisted before handling; the stray-poller rules (no launch id, a foreign ancestor, lock held, 409 with a
  stray official `bot.pid`); the token never in output, logs, notifications or argv; the access CLI refusing without
  a TTY; the launch argv and fallback reasons.
- **Manager regression:** the existing `manager-telegram` tests must pass unchanged after the client extraction.
- **Live (opt-in, coordinator only, never a worker):** `MINIONS_LIVE_TELEGRAM=1` with a disposable bot. Covers a
  reply round trip with a quote, a tap, an edit, a file, typing, a context-reset restart, and the official fallback.

## Phased child tasks (proposed, not created; after owner approval)

0. **Spike: development channel with a `--mcp-config` server in a detached coordinator.** Criteria: a trivial stdio
   channel server loaded with `--mcp-config` and `--dangerously-load-development-channels` in a throwaway
   `CLAUDE_CONFIG_DIR`, started detached in tmux; record the exact spec syntax, whether a startup confirmation
   appears, and whether notifications arrive, in this doc. Live claude run, so the coordinator runs it. Depends: none.
1. **Bot API client extraction and server core.** Criteria: `src/telegram/bot-api.ts` shared by the manager (its
   tests unchanged and passing); `minions telegram channel serve` with the JSON-RPC handshake, `reply` (with
   `reply_to`, `ref`), inbound text and media with the reply meta, gate and pairing code, `/start` `/help` `/status`,
   lock and the coordinator-wins rules, token from file only; fake Bot API and fake MCP tests; typecheck and tests
   pass. Depends: 0.
2. **Interactive tools.** Criteria: `ask`, `close_decision`, `edit_message`, `react`, `typing`, files,
   `download_attachment`, permission relay; `tg_messages` and `tg_decisions` migrations; the test cases above.
   Depends: 1.
3. **Launch swap, access CLI, prompt.** Criteria: `communication.telegram.server` config; wrapper argv, MCP config,
   no token in the claude env, tool allow list and subagent gate on the new prefix; fallback to the official plugin
   and then to terminal, with reasons; `minions telegram access` (TTY-only); probe, doctor and status aware of the
   server; coordinator prompt (`ask` when present, reply meta, ref from the `ref` argument, the new thread rules);
   upgrade path (task-3.14 narrowed); default flipped to `minions` only after phase 4 passes. Depends: 2.
4. **Opt-in live check and default flip.** Criteria: the live script above passes on a disposable bot; the
   compatibility doc lists the verified Claude Code version; the default becomes `minions`; 35.2 to 35.6 are closed
   as superseded. Coordinator-run. Depends: 3.

## Unknowns

| Unknown | Why it matters | How to settle |
| - | - | - |
| Development-flag spec for a `--mcp-config` server, and whether it asks for confirmation at start | Detached starts and resets | Phase 0. If it asks every start: try a `--plugin-dir` plugin spec. If it still asks, stop and keep the official plugin (task-35 had the same gate) |
| Whether managed settings in Team/Enterprise orgs block development channels | The org case | Startup notice, then fallback to official |
| Meta key and value limits (length, newlines) in channel notifications | `reply_to_text` | One line, 300 characters is the conservative choice; confirm in phase 4 |
| Bot API details: `quote` field coverage, reaction set, `sendChatAction` duration | Rendering | Bot API docs at build time; the design does not depend on exact values |
