# Interactive Telegram decisions: design

Status: **shipping plan superseded** by [telegram-channel.md](telegram-channel.md) (task-67): a minions-owned channel
server replaces the patched fork (S2). The UX choice below (option A, tap buttons with numbered text in the body) and
the `ask`/`close_decision` semantics carry over unchanged. Original status: **proposed** (task-35, design only, nothing built). The owner has to agree with the recommendation before
any build task starts. Everything marked **verified** was read from the installed official plugin
(`telegram@claude-plugins-official` 0.0.7, install commit `ea10b213686c90bb1984b2016937310e05336cf3`,
`~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts`, read only) on 2026-10-23, or comes from
[telegram.md](telegram.md). Everything marked **unknown** is listed in [Unknowns](#unknowns) and is not assumed. No
Claude session was started, and no Bot API call was made, for this design.

## Goal

Today the coordinator asks owner decisions as numbered text polls: "1. ... (recommended), 2. ..., 3. Other", and the
owner answers by typing the number. The owner asked for interactive decisions instead ("1/2, see what's better"):

- **A: tap buttons.** An inline keyboard under the question; the tap arrives as a `callback_query` update.
- **B: native polls.** `sendPoll` (non-anonymous); the vote arrives as a `poll_answer` update.

Constraints from the task:

- The coordinator never reads the bot token and never calls the Bot API itself. The token stays inside the plugin
  process.
- Pairing and `access.json` keep working as they do now (owner-only allowlist, terminal-only access changes).
- Numbered text stays as the fallback.

## What the official plugin does today (verified)

| Topic | Fact | Where in `server.ts` |
| - | - | - |
| Tools | `reply`, `react`, `download_attachment`, `edit_message`. None accepts `reply_markup`. `edit_message` edits text only. | `ListToolsRequestSchema` handler (~455-530) |
| Inbound | `message:text`, `photo`, `document`, `voice`, `audio`, `video`, `video_note`, `sticker` are forwarded as `notifications/claude/channel` with `content` and `meta` (`chat_id`, `message_id`, `user`, `user_id`, `ts`, attachment keys). The task text said "text only"; it is wider, but still messages only. | `handleInbound` (~907-990) |
| Callback queries | The plugin **already uses inline keyboards** for permission relay: `perm:allow|deny|more:<id>`. Its `callback_query:data` handler checks `allowFrom`, emits `notifications/claude/channel/permission`, answers the query, and edits the message to append the outcome ("so the same request can't be answered twice"). Any other `callback_data` is answered silently and **dropped**. | ~735-792 |
| Polls | No `sendPoll`, no `poll_answer` handler. grammy drops unhandled updates. | none |
| `allowed_updates` | `bot.start()` passes none, so Telegram's default applies: every update type except `chat_member`, `message_reaction`, `message_reaction_count`. `callback_query` and `poll_answer` are already delivered to the poller; the plugin just ignores them. | ~1009 |
| Single poller | Telegram allows one `getUpdates` consumer per token. At start the plugin SIGTERMs the `server.ts` named in `<state>/bot.pid` and writes its own PID. A poller on another machine shows up as `409 Conflict`; after 8 attempts the plugin stops polling. | ~56-78, ~1001-1040 |
| Token | `TELEGRAM_BOT_TOKEN` from the env, else `<state>/.env`. minions passes it in the env of the coordinator's `claude` only ([telegram.md](telegram.md) decision 4). | ~27-53 |
| Access | `access.json` is re-read on every inbound update and every outbound tool call (`assertAllowedChat`). | `loadAccess`, `gate` |
| License | Apache-2.0, so a fork is allowed with the license and a change notice. | `LICENSE` |

Consequence: with the official plugin unchanged, neither a tap nor a poll vote can reach the coordinator. The
coordinator also cannot attach a keyboard to a message. Something inside the polling process has to change.

## Option A vs option B (the UX choice)

| | A: inline buttons + `callback_query` | B: native poll + `poll_answer` |
| - | - | - |
| Single-owner UX | One tap, no extra screen. The question is a normal message with buttons under it. The owner gets a toast ("Chosen: 2") at once. | A poll widget. Built for groups: after voting the owner sees "100% / 0%" bars, which carry no information with one voter. |
| Question size | Message text up to 4096 characters, so the context and the options fit in one message. | Question up to 300 characters, options up to 100 characters each, 2 to 10 options (**unknown**: later Bot API versions may allow more). Context longer than that needs a separate message before the poll. |
| Labels | Button text is short (one line on a phone, roughly 30-40 characters before it is cut). The full option text goes in the message body, buttons show "1", "2 (rec.)", ... or a short label. | Option text up to 100 characters, shown in full. |
| Showing the choice | `editMessageText` on the question: append "Chosen: 2. Keep the current order" and drop the keyboard. Same pattern the plugin uses for permission prompts. Chat history shows the decision. | A poll cannot be edited. `stopPoll` closes it and shows the result bars. The chosen text is only visible as a bar. |
| Answer twice / change mind | The keyboard is removed after the first tap, so a second tap is impossible. Changing a decision means a new message ("actually 3"), which the coordinator already handles. | The owner can retract and re-vote until the poll is closed; each change is a new `poll_answer` (a retract has empty `option_ids`). The coordinator would see several answers and would have to take the last one. |
| Mapping the answer | `callback_query` carries `message.chat.id`, `message.message_id`, `from.id` and our own `callback_data` (up to 64 bytes): `dec:<id>:<n>`. Everything needed is in the update. | `poll_answer` carries only `poll_id`, `user` and `option_ids`, no chat or message id. The plugin must keep a `poll_id -> {chat, message, decision}` map, persisted across restarts. |
| Access check | `from.id` against `allowFrom`, the same check as the permission buttons. | `user.id` against `allowFrom`. Same. |
| "Other" | A button "Other" that edits the message to "Other: reply with text" and tells the coordinator; the owner then types. | A poll option cannot take free text. "Other" is a vote, then the owner types. Same outcome, one more step. |
| Multiple choice | Possible (toggle buttons + "Done"), more code. Not needed for current decisions. | Built in (`allows_multiple_answers`). The only real advantage of polls. |
| Restart behavior | A tap on a question sent before a coordinator restart still arrives (Telegram queues it for 24 h); the plugin needs the persisted decision to label it. | Same, plus the `poll_id` map must survive. |

**Choice: A, tap buttons.** For one owner deciding one question at a time, buttons are one tap, keep the full context
in one message, show the choice in place, and cannot be answered twice. Polls only win on multiple choice, which
minions does not use. B is not built; if multiple choice is ever needed, add toggle buttons to A instead.

## How a decision works (option A)

### Asking

A new plugin tool, working name `ask`:

```
ask(chat_id, text, options: [{label, button?}], recommended?: n, allow_other?: true, decision_id?)
-> "asked (id: <message_id>, decision: <decision_id>)"
```

- The plugin renders the **numbered text** itself, so the message reads the same as today's text polls:
  `text`, a blank line, then `1. <label> (recommended)`, `2. <label>`, ..., `N. Other`. Buttons show
  `button` or the number. The recommended option comes first (the owner's poll convention).
- `callback_data` is `dec:<decision_id>:<n>` (`n` = 1-based option, `o` = Other). `decision_id` is 6 random
  `[a-z0-9]` characters made by the plugin unless the caller passes one (the coordinator can pass its outbox key's
  short hash so retries reuse it). The total stays well under 64 bytes.
- `assertAllowedChat(chat_id)` first, like every outbound tool. Options: 2 to 10, label up to 200 characters.
- The decision is saved to `<state>/decisions.json` (0600, atomic write like `saveAccess`): `{id, chat_id,
  message_id, options, status: open|answered|closed, created_at}`. Entries older than 7 days are pruned. This file
  is plugin state next to `access.json`; minions never writes it.

### Answer reaches the coordinator as a channel message

The `callback_query:data` handler gets a second branch next to `perm:`:

1. Parse `^dec:([a-z0-9]{6}):([0-9]{1,2}|o)$`. Anything else keeps today's behavior (answer and drop).
2. Access: `String(ctx.from.id)` must be in `allowFrom`, else `answerCallbackQuery("Not authorized.")`. Groups are
   not supported (minions requires DM only).
3. Look up the decision. Missing, or not `open` -> `answerCallbackQuery("This question is closed. Reply with the
   number instead.")` and do nothing else.
4. Mark it `answered` (persist first, so a duplicate update cannot emit twice).
5. Emit the same notification as a typed message:

   ```
   notifications/claude/channel
     content: "answer: 2. Keep the current order"
     meta: { chat_id, message_id: <question message id>, user, user_id, ts,
             decision_id: "k3x9qa", decision_option: "2" }
   ```

   The coordinator sees `<channel source="telegram" ... decision_id="k3x9qa" decision_option="2">answer: 2. Keep the
   current order</channel>`. The content is plain text, so the coordinator needs no new parser: an `answer: <n>`
   message means the same as the owner typing `<n>`. The meta keys are the trusted part (the plugin sets them; text
   typed by the owner never produces meta), which the coordinator can use to match the answer to the open question.
6. `answerCallbackQuery({text: "Chosen: 2"})`, then edit the question (below). Edit failures are logged and ignored,
   like the permission path.

"Other" (`o`): mark the decision `answered`, edit the message to `... \n\nOther: reply with your answer`, and emit
`answer: other`. The owner's next typed message is the answer.

### Editing the message to show the choice

`editMessageText(chat_id, message_id, original_text + "\n\nChosen: 2. Keep the current order")` with no
`reply_markup`, which removes the keyboard. The full text is stored in `decisions.json`, so the edit does not depend
on `callbackQuery.message.text` (which is missing for messages older than 48 hours).

A second tool, `close_decision(decision_id, note?)`, lets the coordinator close a question that was answered some
other way (typed number, a terminal answer, or the question is obsolete): mark it `closed`, edit the message to
append `note` (default "Answered") and drop the keyboard.

### Fallback to numbered text

The numbered text is always in the message body, so typing still works everywhere:

| Situation | What happens |
| - | - |
| Owner types `2` instead of tapping | Today's path: a normal channel message. The coordinator answers it and calls `close_decision` so stale buttons go away. |
| The `ask` tool is missing (official plugin active, interactive mode off, fork not installed) | The coordinator sends today's numbered text with `reply`. The prompt says: use `ask` only when it is in the tool list. |
| `ask` fails (send error, chat not allowlisted, too many options) | The coordinator sends the same question with `reply` as numbered text; the outbox records the failure as today. |
| Tap on a question from before a plugin upgrade or after pruning | Toast "This question is closed. Reply with the number instead." The owner types. |
| Terminal mode | No Telegram at all; questions are asked in the terminal as today. |

The coordinator prompt (`templates/plugin/coordinator.md`, Telegram section) gets one rule: decisions go through
`ask` when present, else numbered text; `answer: <n>` and a typed `<n>` mean the same; close an `ask` question that was
answered by text.

## How to ship it

Every option must keep: one poller per token, `access.json` and pairing semantics, the token only in the plugin
process, and the subagent gate on `mcp__plugin_telegram_telegram__*`.

### The allowlist problem (applies to every non-official build)

During the research preview `--channels` registers only plugins on Anthropic's allowlist (the
`claude-plugins-official` channel plugins) or the org's managed `allowedChannelPlugins`
([telegram.md](telegram.md), verified facts). Any plugin minions ships, fork or new, is not on that list. It loads
and its tools work, but its **inbound notifications are not delivered** unless the session also gets
`--dangerously-load-development-channels <spec>`. That flag is ignored with `-p` (not an issue: the coordinator is
interactive in tmux), and whether it needs a confirmation at startup, which would block a detached start, is
**unknown**. Org users can instead add the plugin to managed `allowedChannelPlugins`, but minions cannot set managed
settings for them. This is the main cost of every option except upstreaming.

### Options

| | S1: upstream the change | S2: patched fork of the official plugin | S3: minions-owned plugin from scratch | S4: sidecar next to the official plugin |
| - | - | - | - | - |
| What | PR to `anthropics/claude-plugins-official` adding `ask`/`close_decision` and the `dec:` branch. | Pinned upstream commit + a small minions patch, shipped by minions as plugin **named `telegram`** from a minions marketplace (or `--plugin-dir`). | New Bun/Node MCP server, own name, own code for gate, pairing, tools. | A second MCP server that only adds `ask`, while the official plugin keeps polling. |
| Channel allowlist | Stays allowlisted. | Needs the development flag or `allowedChannelPlugins`. | Same as S2. | The sidecar sends but cannot receive: the official plugin owns the poll and drops `dec:` taps. A second poller would kill the channel. **Does not work.** |
| Token | Unchanged (in the plugin process). | Same env path as today. The fork can also read `TELEGRAM_BOT_TOKEN_FILE` (the read-only mount) so the token leaves the coordinator `claude` env; see below. | Same as S2. | Needs the token in a second process to send. |
| `access.json` / pairing | Unchanged. | Unchanged code: same state dir, same schema, same gate, same `/telegram:access` skill (the plugin name `telegram` keeps the skill namespace). | Must re-implement the gate and pairing and the access skill, and track upstream changes by hand. Two implementations of the security gate. | Unchanged. |
| Tool names | Unchanged. | `mcp__plugin_telegram_telegram__*` stays the same (plugin `telegram`, server `telegram`), so `TELEGRAM_TOOL_PREFIX`, the allow list and the subagent gate hook keep matching. | New prefix: hook, allow list, isolation checks and docs all change. | New prefix for the sidecar. |
| Single poller | Unchanged. | Same `bot.pid`, same `server.ts` file name, so the takeover works in both directions between fork and official. Only one of them may be enabled in the coordinator. | Must share `bot.pid` and match `server.ts`, or the two plugins would fight with 409s. | Broken (see above). |
| Upkeep | None after merge; timing is not ours. Needs owner approval (`external.create`). | Rebase the patch when we take a new upstream commit (explicit, never automatic, same as today's "never update"). | Highest. | n/a |

Rejected: the coordinator calling the Bot API (forbidden: it would read the token, and it duplicates transport); any
second poller (Telegram allows one `getUpdates` consumer; the plugin's PID takeover or 409 would kill the
coordinator's channel, the failure task-51 fixed); abusing the permission-relay buttons for decisions (binary only,
and it would train the owner to tap "Allow" on prompts that are not tool permissions).

### Single-poller rules for S2

- The fork and the official plugin are never both enabled in the coordinator. `minions coordinator run` already sets
  `enabledPlugins` per launch (task-51); with interactive mode on it enables `telegram@minions` and disables
  `telegram@claude-plugins-official` (and the reverse when off), at user scope and in `--settings`.
- The fork keeps the file name `server.ts` and the `bot.pid` protocol, so `src/telegram/isolation.ts` (poller check)
  and doctor `telegram.poller` work unchanged, and a stray official poller is replaced (and replaces the fork) the same
  way as today.
- `--channels` and `--dangerously-load-development-channels` name the fork only. `TELEGRAM_CHANNEL_SPEC` becomes a
  function of the selected plugin.
- No other process polls. The fork adds no background sender and no second bot instance.

### Token boundary for S2

Today the token is in the coordinator `claude` env, so the coordinator's Bash tool and its children inherit it
([telegram.md](telegram.md) decision 4, residual risk). The fork can do better because we own its start: the wrapper
passes `TELEGRAM_BOT_TOKEN_FILE=/opt/minions/secrets/telegram-bot-token` instead of the token, and the fork reads the
file into memory at start. Then the token is in the plugin process only; the coordinator still never reads it. (The
read-only mount stays readable from the coordinator's Bash; removing that is out of scope.) The fork never prints the
token, and `ask`/`close_decision` results contain only ids.

## Recommendation

1. **UX: option A, tap buttons**, with the numbered text always in the message body as the fallback.
2. **Shipping: S2, a small patched fork of the official plugin, opt-in** (`communication.telegram.interactive`,
   default off), plugin name `telegram`, same state dir, `bot.pid` and tool prefix. The patch only adds `ask`,
   `close_decision`, `decisions.json` and the `dec:` callback branch (and optionally `TELEGRAM_BOT_TOKEN_FILE`); it
   does not touch the gate, pairing, or permission relay.
3. **Gate the build on a spike** that confirms the development-channels flag delivers a fork's inbound notifications
   in a detached tmux start on Claude Code 2.1.292. If it needs an interactive confirmation every start, or does not
   deliver, stop and keep numbered text.
4. **In parallel, offer the same patch upstream (S1)** once the owner approves an external PR. If it is merged, minions
   switches back to the official plugin and drops the fork and the development flag.

Low priority, as the owner said. Until it ships, numbered text polls stay as they are.

## Build tasks (proposed, after owner approval)

1. **Spike: development channel in a detached coordinator.** Load a trivial channel plugin with
   `--dangerously-load-development-channels` in a throwaway container session started detached from tmux; record
   whether a confirmation appears and whether channel notifications arrive. Needs a live Claude run, so the
   coordinator runs it, not a worker. Depends: none.
2. **Fork packaging.** Vendor the official plugin at a pinned commit under a minions-owned path with `LICENSE`, a
   change notice and the patch as a separate file; build a local marketplace entry `telegram@minions`; `minions
   telegram install` installs it when interactive mode is on. Depends: 1.
3. **Plugin patch: `ask`, `close_decision`, `decisions.json`, `dec:` callback branch, message edit.** Unit tests run
   the handlers with a fake grammy `api` and a fake MCP transport (no network, no token): access check, unknown or
   closed decision, double tap, Other, restart (decision loaded from file), notification content and meta, edit text.
   Depends: 2.
4. **Launch and isolation.** `communication.telegram.interactive` config; `enabledPlugins` swap between official and
   fork; `--channels` plus development flag for the fork; `TELEGRAM_BOT_TOKEN_FILE` instead of the env token; probe,
   doctor and `isolation.ts` aware of both plugin ids; tests with fakes that only one plugin is ever enabled and the
   token is absent from the coordinator env, argv and launch record. Depends: 2.
5. **Coordinator prompt and outbox.** `ask` when present, numbered text otherwise; `answer: <n>` equals typed `<n>`;
   `close_decision` after a text answer; open questions in the handoff carry `decision_id`. Depends: 3, 4.
6. **Opt-in live check** (`MINIONS_LIVE_TELEGRAM=1`, disposable bot): ask, tap, edit, typed fallback, restart between
   ask and tap. Depends: 5.
7. **Upstream PR (S1)**, needs owner approval for `external.create`. Depends: 3.

## Unknowns

| Unknown | Why it matters | How to settle |
| - | - | - |
| Whether `--dangerously-load-development-channels` asks for confirmation at start, and whether it delivers a non-allowlisted plugin's notifications. | S2 and S3 depend on it; a prompt would block detached starts and restarts after context resets. | Build task 1. |
| The current Bot API limits (poll option count, button label width on phones). | Rendering and validation in `ask`. | Check the Bot API docs at build time; the design does not depend on exact values. |
| Whether `editMessageText` without `reply_markup` always removes the inline keyboard. | Showing the choice and preventing a second tap. | Build task 6; if not, pass an empty `inline_keyboard`. |
| Meta key rules for channel notifications (characters allowed). | `decision_id`, `decision_option` must be valid keys. | Same pattern as the plugin's existing `attachment_*` keys, so expected to work; confirm in task 6. |
| Whether upstream accepts the change and when. | S1 timing. | Out of our control. |
