# Router plus targeted coordinator sessions: design

Status: **proposed** (task-57, design only, nothing built). The owner must agree before any build task starts. Step 1
(token tracking) can be built first on its own: it fixes the empty coordinator spend and gives the baseline that
decides whether steps 3 to 7 are worth building. Scheduled after the current agent-runtimes (task-14.x) and host
manager (task-53.x) work.

## Summary (for Telegram)

- Today one coordinator session handles everything: every owner message, every worker result and every task share one
  growing context, and routine resets (task-45) clear it at 60k tokens or after a delivery.
- Proposal: a **router** session on a cheap model holds the Telegram bot and knows only which sessions exist. It
  forwards each owner message to a **targeted session**: one per task, or one per owner conversation thread. Other
  events (worker results, ready tasks) go to the right session without the router.
- Targeted sessions are headless `claude -p --resume` runs. A deterministic minions **supervisor** starts them, never
  a Claude session's Bash. They have no Telegram access. Their messages for the owner go through the outbox, and the
  router sends them.
- All state that matters stays durable and shared: backlog, leases, outbox, spend, and a new sessions table.
- **Step 1 measures first.** The Stop hook records the coordinator's own token use per session. We build the rest only
  if the measured numbers predict a clear saving (see [Cost model](#cost-model)).

## Problem

The owner asked (Telegram msg 252, poll answer 1 in msg 254, 2026-10-26) to cut irrelevant coordinator context. Facts
from the code (main @ a062a51):

- **One session, one context.** `minions coordinator run` (`coordinatorWrapper`, `src/runtime/coordinator.ts`) takes
  the project coordinator lock and runs one interactive `claude` in tmux with the minions plugin, `--channels` for
  Telegram, and the orchestrate skill. Owner chat, intake, dispatch and recording for every task all land in it.
- **Resets are the only remedy today.** `contextResetCheck` (`src/runtime/context-reset.ts`) marks a reset as due
  after a delivery, at `contextTokens` (default 60k, read from the transcript tail the Stop hook names), or after 10
  hand-offs. It is **blocked while any lease is active**, because workers are subagents of that one session. A busy
  queue therefore never resets. Each reset also pays for a fresh prompt prefix and a recover pass.
- **Coordinator spend is 0.** Worker tokens reach the tally through `work record|release --usage`
  (`src/runtime/spend.ts`). The coordinator's own tokens are recorded only by a manual
  `minions work spend --session --tokens <n>`, which nothing calls. When it is called, the key defaults to the lock
  session name (`coordinator` / `direct`, `commands.ts` `spendCommand`), so the next session's lower cumulative figure
  would *replace* the previous session's figure. We cannot compare anything until this is fixed.
- **One bot holder.** Telegram allows one `getUpdates` consumer per token. The plugin is enabled only in the
  coordinator's launch (task-51, `src/telegram/isolation.ts`). `status` checks that `bot.pid` belongs to the
  coordinator claude (`telegramPollerStatus`). A second `claude` that loads the plugin takes the bot away. Workers
  must never start `claude`.
- **No reply metadata.** The official plugin (0.0.7, `server.ts` ~974, read-only check) forwards `chat_id`,
  `message_id`, `user`, `user_id`, `ts` and attachment keys. It does **not** forward `reply_to_message`. A router cannot
  see which bot message the owner replied to. `reply` returns the sent id (`sent (id: N)`).

## Decisions

1. **Step 1 is measurement, built and run before anything else.** See [Step 1](#step-1-coordinator-token-tracking).
2. **The router is the existing coordinator launch, made small.** It is the same wrapper, lock, tmux session,
   `--channels` and poller. What changes is its prompt (a routing skill of about 2k tokens instead of orchestrate), its
   model (`models.router`, default `haiku`), and its tools (Bash for `minions` and the Telegram tools; no Agent tool).
   It never claims, dispatches or records. The poller check, the subagent Telegram hook and the outbox transport stay
   exactly as they are.
3. **Targeted sessions are headless and resumed per wake.** Each one is a Claude Code session id. A wake is one
   `claude -p --resume <id> --output-format stream-json` process. It gets the coordinator's `--plugin-dir`,
   `--settings` (same allow/deny list, no `git push`, no merge) and `--permission-mode`, and it runs until the turn
   ends. Nothing stays resident between wakes, so an idle session costs nothing. Kinds:
   - **task**: key `task:<id>`. It drives that task's stages (claim, worker, record, next stage) with a task-scoped
     orchestrate skill (`/minions:task <id>`). It is opened when the task becomes ready and has capacity, and closed at
     delivered, done or cancelled.
   - **thread**: key `thread:<first owner message id>`. A non-task owner conversation (a new goal, a design question,
     intake). When it files tasks, it hands them over through the backlog. It closes after 24 h without activity.
4. **A deterministic supervisor starts sessions, never a model.** The hidden `minions coordinator supervise` is a node
   process with its own DB lock (`{pid, start}`, the same reuse-safe rule as the coordinator lock). The wrapper starts
   it detached, outside the router's process tree, so router resets and restarts do not touch running sessions. It
   reuses the runner's building blocks (task-14.x): the run record with O_EXCL as a one-process-per-session lock
   (`src/runtime/runner/record.ts`, under `/state/run/sessions/<id>/`), process-group supervision, wall-clock timeout
   and drain (`supervise.ts`), and reaping from the record after a crash. It does not use the worker Landlock sandbox:
   a session needs the same rights as today's coordinator. The env comes from an allowlist (no `TELEGRAM_*`). The
   flag settings set `enabledPlugins["telegram@claude-plugins-official"]: false`, and there is no `--channels`. This
   amends agent-runtimes D11.3 ("the runner refuses `harness: claude`") only for this launch kind. Leases still never
   start Claude processes.
5. **Workers stay subagents, now of the task session.** `preAgentHook`, briefs, `work submit` and record-time checks
   are unchanged. A lease's `holder` is the session id. Process-harness workers use `work run` as before. Because
   leases belong to task sessions, the router can reset even while leases are active.
6. **Durable state is the only channel between sessions.** No session reads another's transcript.

## Routing model

Inbound owner message (router turn):

1. The router runs `minions coordinator route --json` with the channel meta and the text on stdin. The deterministic
   resolver returns the target, using the first rule that matches:
   1. the owner replied to a bot message: the session of `reply_to_message_id` in the message map (only with the
      minions channel server, [telegram-channel.md](telegram-channel.md); a decision tap carries its message id too);
   2. a session named explicitly: `task-57`, `/s <session>`, or a ref `#<message id>` (the task-58 `ref: #<id>`
      convention) found in the message map;
   3. a bare number while exactly one open question waits for the owner (outbox `question` items carry their
      session);
   4. otherwise a new topic (task-66: an owner message without a reply or a ref starts a new thread), or
      `ambiguous` with the candidate sessions when it is a bare number and several questions are open. The old
      task-58 rule "no ref = latest message" is dropped.
2. When the target is known, the router runs `minions coordinator send <session>`: the message goes into a
   `session_inbox` row, and the supervisor wakes the session. The router reacts with an emoji as the ack. It does
   not answer the content. If the session is busy, the message waits for its next turn. The task orchestrate loop
   also checks the inbox between stages.
3. When the target is `ambiguous`, the router itself asks a numbered poll ("1. task-57 (recommended) 2. new topic 3.
   Other"), or it opens a thread session for a new topic. This is the only judgment the cheap model makes.
4. A few fixed commands are answered by the router without a session: `status` (from `minions status --json`), which
   sessions exist, pause and resume.

Other events never pass through the router. A worker result arrives in the task session that spawned the worker. A
ready task is opened by the supervisor (`work next` plus capacity). CI and drain events go from the supervisor to the
affected sessions. Change requests (task-53) are recorded by whichever session needs them.

Outbound: every session records its notifications with `minions notify enqueue` (keys unchanged, plus a `session`
column). The router sends due items with `reply` and records `notify ack <key> --message-id <N>`, which fills a
`tg_messages(message_id, session, key)` map that routing rules 1 and 2 read. To wake the router for outbound
items, it keeps one `minions coordinator wait --json` in the background (Bash `run_in_background`). The command
exits when an item is due, and the task notification wakes the router. This is the one place where an LLM is woken
on purpose: only the cheap router, and only when there is something to send.

Reply-thread metadata: with plugin 0.0.7, routing relies on refs and rules 2 to 4. The minions channel server
(task-67, [telegram-channel.md](telegram-channel.md), which replaces the task-35 fork plan) adds
`reply_to_message_id`, `reply_to_text` and `reply_to_ref` to the meta and keeps the `tg_messages` map itself, so
rule 1 needs no extra bookkeeping by the router.

## Session lifecycle

| | Router | Task session | Thread session |
| - | - | - | - |
| Opened by | `coordinator run` (as today) | supervisor: ready task within capacity, or a thread session filing a ready task | router, for an unroutable new topic |
| Process | interactive claude in tmux | one `claude -p --resume` per wake | same |
| Context reset | at 25k tokens or on idle; allowed with active leases; the handoff is nearly empty (sessions are in the DB) | not needed: the session ends at delivery. If one task's context passes 60k, the session writes a session handoff and continues as a fresh session id with the same key | same rule as task sessions |
| Closed | `minions down`, upgrade | task delivered, done or cancelled; the final summary goes to the outbox | 24 h without activity, or `/close` |
| Model | `models.router` (default `haiku`) | `models.coordinator` | `models.coordinator` |

Hand-off between sessions: a thread session files a task, and it can attach a session note (at most 4 KB, redacted
like `writeHandoff`) that the task session reads at start. Per-session handoffs go to
`coordinator-handoff.<session>.json`. `contextResetCheck` and the Stop guard are scoped to the calling session (its
own leases, its own task), so a task session's Stop hook does not keep it running because other tasks are ready.

Limits: `coordinator.sessions.max` (default `maxActiveTasks + 2`), at most one process per session, and the
existing budget gate in `work claim`. A session is never woken while starts are paused, except to answer the owner.

## Telegram ownership

- One bot holder, unchanged: only the router's launch enables the plugin and has the token in its env.
  `telegramPollerStatus` is unchanged: the router *is* the coordinator claude.
- Targeted sessions cannot poll. The plugin is disabled in their flag settings and `--strict-mcp-config` loads no MCP
  server. `TELEGRAM_*` is not in their env (the supervisor is not a child of the router claude, so nothing is
  inherited from it). `preTelegramHook` also denies the tools. A test asserts the argv, env and settings of a session
  launch.
- Sessions do not start `claude` themselves. Only the supervisor does, through one code path. The task-51 rule for
  workers stays.
- **Host manager bot (task-53) is separate and stays separate.** It is host-only, deterministic and holds its own
  token, and the router never sees its updates. Targeted sessions propose setup changes through `change_requests` as
  designed there. The router only relays the outbox line "a request is waiting". The manager's `/status` can list
  sessions (a later addition, not needed here). Making the manager bot the router was rejected: it has no model by
  design and it sits on the host side of the trust boundary.

## Failure and recovery

- **Router dies or resets.** Same path as today (`coordinator restart --recover`). Sessions, inbox and outbox are in
  the DB, so the new router flushes pending items and resumes `wait`. The known gap from telegram.md (a message
  handed to a dying session) is unchanged but shorter, because router turns are short.
- **A session process dies mid-turn.** The supervisor reaps it from the run record. Its in-session workers died with
  it, so their leases are released and the task re-dispatched (the existing recover logic, scoped to the task).
  Process-harness workers are reaped by `reapRun`. The session is resumed with `/minions:recover --task <id>`. After 2
  failed resumes it is marked `failed`, and the owner gets an outbox `blocker`.
- **Supervisor dies.** Its sessions die with it (`PR_SET_PDEATHSIG`). The wrapper watches its lock and starts it again,
  and `status` reports it. The new supervisor reaps leases from the records and resumes the sessions. The router alone
  keeps Telegram working in the meantime.
- **Drain or upgrade.** The supervisor stops starting wakes. Running sessions follow the drain hook (`wip:`,
  `partial`). The router goes last.
- **Rollback.** `coordinator.sessions.enabled: false` (the default until phase 7) keeps today's single coordinator
  unchanged. Sessions are an opt-in, live setting.

## Cost model

Notation: `F` is the fixed prompt prefix (Claude Code system prompt, tools and minions prompt), `C` the mean context
per turn, `T` the turns per delivered task, `R` the router turns per owner message or notification. Tokens per turn
are about `C`, mostly cache reads (prompt caching has a 5-minute TTL, so after idle a turn pays a cache write).

| | Today (single coordinator) | Router plus sessions |
| - | - | - |
| Per task | `T × C_today` + reset overhead (fresh `F` plus recover turns) | `T × C_task` (the task's own history only), first turn writes `F` |
| Owner chat | turns on the big context, coordinator model | `R × F_router` on the cheap model, plus the target session's turn |
| Outbound | inside turns already happening | one cheap router wake per batch of due items |

Illustration with **assumed** numbers (step 1 replaces them): `F` 25k, resets at 60k so `C_today` about 42k, `C_task`
about 32k, `T` 15, 3 owner messages and 4 notifications per task, `F_router` 15k, 2 router turns per message.
Today: about 630k tokens plus about 90k reset overhead = **720k per task**. Sessions: 480k task-session tokens + about
150k router tokens = 630k tokens (**about 12% fewer tokens**). At input prices (spend.ts table: haiku 1, opus 5 per
MTok), the router's 150k cost as much as about 30k coordinator tokens, so the total is about **30% cheaper in USD**.
The token saving is small. The real gains are the cheap router, resets without waiting for idle, and focused task
contexts. Whether this holds depends on `C_today`, `T` and the reset overhead, which is exactly what step 1 measures.

**Go/no-go rule (proposed):** after step 1 has run for at least 10 delivered tasks or 7 days, the coordinator feeds
the measured numbers into this model and reports to the owner. We build phases 3 to 7 only if the predicted saving is
at least 25% of coordinator spend (USD with API billing, tokens with a subscription), or the owner wants it for focus
alone.

## Step 1: coordinator token tracking

- **Source:** the Stop hook already receives `transcript_path` and `session_id` and stores them (`noteTranscript`).
  After each main turn it now also reads the transcript **incrementally**, from a byte offset kept in meta
  `coordinator_usage:<session_id>`. It sums `message.usage` of the main-session assistant lines (`input_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`, kept separately). It skips sidechain lines
  (workers are already counted through `--usage`, so this must not count them twice). It counts a message id once
  (Claude Code writes one line per content block with the same usage) and ignores a truncated last line until the next
  read. The time budget stays well under the hook timeout, and failures are best-effort and never change the stop
  decision.
- **Record:** `recordSessionUsage` keyed by `session:<claude session_id>`, not the lock session name, so a reset
  never overwrites the previous session. The data includes the components, `model` (`models.coordinator`), `role:
  coordinator` (later `router` / `task` / `thread`), turns, the max context per turn, owner messages (main-session
  user turns that start with a `<channel source="telegram"` tag), and the trigger that ended the session (the reset
  reason, from the restart event). A session killed before its last Stop is completed at the next coordinator start
  from the transcript path in meta. `work spend --session --tokens` stays as a manual override.
- **Report:** `work spend` / `status` show coordinator tokens next to worker tokens (no longer 0). A baseline section
  (`work spend --json` → `coordinator.baseline`; human text in `status` only when asked) shows: sessions and resets by
  trigger, turns per session, mean and max context per turn, coordinator tokens per delivered task and per owner
  message, reset overhead (tokens a recovered session spends before its first claim or reply), the coordinator's share
  of total spend, and USD with the components weighted (cache read 0.1×, cache write 1.25×, output at the output
  rate) when billing is API key.
- **Tests:** fixture transcripts (duplicate message ids, sidechain lines, a truncated tail, two sessions across a
  reset, a missing file), no live Claude run.

Built decisions (task-57.1, `src/runtime/coordinator-usage.ts`):

- **Storage without a schema change.** Per-session state (offset, components, turns, context sum and max, owner
  messages, recovered flag and overhead, the last 500 message ids, end trigger) is the meta row
  `coordinator_usage:<session_id>`; each turn that adds tokens writes one cumulative `usage` event (source
  `transcript`, with the components), so `today` and budget windows work as for workers. The stop guard's progress
  fingerprint now ignores `usage` events, otherwise a turn would always look like progress.
- **Which Stop counts:** no `agent_id`/`agent_type` in the input, no `MINIONS_ROLE` (process workers), and a
  coordinator lock held. Session ids must be plain (`[A-Za-z0-9_.-]`).
- **Bounded:** one read of at most 4 MB per Stop (a long transcript catches up over turns); a line without its
  newline is left for later; a file shorter than the offset is not re-read.
- **Duplicates:** lines with the same message id in one read are merged (largest of each component); an id
  counted in an earlier read is skipped. A turn is one counted assistant message (one API call); context per turn
  is input + cache read + cache write.
- **End trigger:** `context-reset` (with the reset triggers that held, recorded by `coordinator restart
  --detach` in meta `coordinator_reset_request`), `restart` (meta `coordinator_restart`: upgrade, settings,
  sync) or `exit` (nothing recorded: crash, container stop). Open sessions are completed at coordinator start
  (`coordinator run` onStart) and when a Stop first sees a new session id.
- **Reset overhead:** a session whose first user message is the recovery prompt; tokens until the first
  assistant message with a `minions work claim` Bash call or a Telegram `reply` tool use.
- **Manual override:** `work spend --session --tokens` defaults to the current Claude session id; once a session
  key has a manual figure, its measured figures no longer count (never added up). The coordinator prompt no longer
  asks to record its own tokens by hand.
- **Model:** the transcript's `message.model`, else `models.coordinator`. USD weights: input 1, cache read 0.1,
  cache write 1.25, output 5 times the spend.ts input rate.

## Alternatives rejected

- **The router starts `claude -p` from its own Bash.** That is a nested claude: it inherits the router's env,
  including `TELEGRAM_BOT_TOKEN`, which is the task-51 class of takeover. Forbidden.
- **Long-lived interactive sessions, one tmux window each.** Owner messages would have to be typed into a TUI with
  `tmux send-keys` (fragile, and an injection surface), and idle sessions would hold memory. Headless resume is
  simpler and costs nothing when idle.
- **Targeted sessions as subagents of the router.** Subagents end with their task, cannot receive later owner
  messages, and have no Agent tool, so they cannot run workers.
- **A purely deterministic router (no model).** The plugin delivers inbound messages only to a Claude session with
  `--channels`, and ambiguous free text needs judgment. The hybrid keeps the model's part small: deterministic rules
  first, the cheap model only for `ambiguous`.
- **A minions sender calling `sendMessage` directly** (no router wake for outbound). It would put the token into a
  second process and duplicate the transport, which telegram-decisions rejected. We reconsider it only if router
  wakes for outbound items turn out to be costly.
- **The host manager bot as router.** See [Telegram ownership](#telegram-ownership).

## Unknowns

- U1: whether `claude -p --resume` keeps hooks, plugin agents and `--settings` per wake when the same flags are passed
  again (expected; checked by a coordinator-run spike, because workers must not start claude).
- U2: whether the Stop hook input in `-p` mode carries `transcript_path` (expected).
- U3: whether `-p` waits for background subagents before it exits. The design spawns workers in the foreground.
- U4: whether sessions with an identical prefix share prompt cache. This changes `F` costs, not the design.
- U5: subscription rate limits with several sessions at once. `coordinator.sessions.max` caps it.

## Phases

1. **child: Coordinator token tracking (baseline)** | criteria: the Stop hook records the main-session usage
   incrementally per Claude `session_id` (components, model, turns, max context, owner messages), skipping sidechain
   lines and counting each message id once; keyed so resets never overwrite; an interrupted session is completed at
   the next start; `work spend` and `status` show non-zero coordinator spend and the `coordinator.baseline` section;
   fixture tests | depends: none
2. **child: Baseline report and owner decision** | criteria: after at least 10 deliveries or 7 days, the measured
   numbers are put into the cost model and sent as a poll (build / do not build / tune resets instead); no build task
   below starts without a yes | depends: 1
3. **child: Sessions table and supervisor** | criteria: `sessions` and `session_inbox` tables (inline migration in
   `db.ts`); hidden `coordinator supervise` with lock, run records, one process per session, timeout, drain,
   reaping, 2 resume retries; launch argv, env and settings test (no Telegram, plugin disabled, no `--channels`); a
   fake `claude` binary in tests; `coordinator.sessions.enabled` (default off) | depends: 2
4. **child: Task sessions** | criteria: the supervisor opens a task session per ready task within capacity;
   `/minions:task <id>` skill; lease `holder` is the session id; Stop guard, `contextResetCheck` and handoffs scoped
   per session; recover per task; with sessions off nothing changes | depends: 3
5. **child: Router** | criteria: router prompt and skill, `models.router`; `coordinator route` resolver (refs, open
   questions, latest message, ambiguous) with table tests; `coordinator send`, `coordinator wait`; `tg_messages` map
   from `notify ack --message-id`; router resets allowed with active leases; poller and isolation checks unchanged
   and tested | depends: 4
6. **child: Thread sessions** | criteria: thread sessions opened by the router for new topics, 24 h idle close,
   session notes handed to task sessions; optional `reply_to_message_id` meta when the task-35 fork exists |
   depends: 5
7. **child: Status, docs and rollout** | criteria: sessions in `minions status` (and later in the host manager's
   `/status`); README, cli.md, bootstrap.md; a coordinator-run live check (needs a live Claude run, so not a worker);
   enable by default only after the owner agrees | depends: 5

New commands fold under the internal `coordinator` command (`supervise`, `route`, `send`, `wait`). No new top-level
command (cli-surface.md).

## Open questions for the owner

1. Build step 1 now, and decide the rest on its numbers (recommended)? Or build it all together?
2. Router model: `haiku` (recommended, cheapest) or `sonnet` (better at ambiguous routing)?
3. Thread sessions in the first build (phase 6), or task sessions only at first, with non-task chat staying with a
   single general session?
