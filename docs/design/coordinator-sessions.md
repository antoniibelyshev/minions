# Router plus per-task coordinator sessions: design

Status: **agreed direction, build phases proposed** (task-57.4 design check against main @ 18486ec, 2026-10-28).
Step 1 (token tracking, task-57.1) is built. The owner decided to build the router and per-task sessions (TG 427,
2026-10-28) after this design check. Phases 3 (spike), 4 (schema and launch builder), 5 (supervisor), 6 (session-scoped
hooks) and 7 (task sessions) are built; the router and the general session (phase 8) are next. The build phases are in [Phases](#phases). Three
[open questions](#open-questions-for-the-owner) remain.

Owner decisions so far:

- TG 264 (2026-10-26): build step 1 first. Router model **haiku**. **Task sessions only at first**: non-task chat
  stays in **one general session** (thread sessions are deferred).
- TG 427 (2026-10-28): build the router and per-task sessions after a design check, after the flaky-test work and
  before the Telegram epic (task-67).
- TG 430 (2026-10-28): headless runs get their own credentials and a fresh config (task-96, in progress). The sessions
  are built on top of it.
- Main concern: good context handling.

Related: [unattended-delivery.md](unattended-delivery.md) (task-68: routine pass, wakes, digest, `work advance`,
dispatcher spike), [telegram-channel.md](telegram-channel.md) (task-67: minions-owned channel server, reply
metadata), [agent-runtimes.md](agent-runtimes.md) (runner, D11 Telegram rule). See
[Fit with unattended delivery](#fit-with-unattended-delivery) for how the two designs fit and which comes first.

## Summary (for Telegram)

- Measured: the coordinator uses **94% of all tokens** (155M since 27 Oct, about $121 of $256 at API prices, 72%
  of USD). That is **8.6M tokens and about $6.70 per delivered task**. The mean context is 127k per turn and the
  max is 512k. **Two thirds of it is one session** that could not reset for 4 hours because workers were always
  running (397 turns at a mean of 257k).
- Plan: a **router** on haiku holds the Telegram bot and only routes. Each task gets its own **task session**, which
  runs that task's workers and ends at delivery. All other chat goes to one **general session**. A deterministic
  **supervisor** starts the sessions headless, with a fresh config and the task-96 credentials. Sessions never
  have Telegram.
- Expected: about **80% fewer coordinator tokens** and about **40% less USD** per delivered task (the range is
  20% to 60%, see the cost model). USD falls less than tokens because each task session pays a cache write when it
  wakes after a worker. The deterministic dispatcher (task-68.8) comes on top later and removes most of those wakes.
- Two quick fixes come first. The token baseline does not count owner messages or recoveries today (a bug that also
  breaks the "owner active" checks). And a **reset barrier** for today's single coordinator would cut about a third
  of its spend within days.
- Order: baseline fix → reset barrier → task-96 → coordinator-run spike → supervisor → task sessions → router and
  general session → live check → (later) dispatcher.

## Facts from the code (main @ 18486ec)

Re-checked for this revision. Changes against the first version (main @ a062a51) are marked *new*.

- **One session, one context.** `minions coordinator run` (`coordinatorWrapper`, `src/runtime/coordinator.ts`) takes
  the project coordinator lock and runs one interactive `claude` in tmux. `buildClaudeCommand` passes
  `--plugin-dir`, `--append-system-prompt` (coordinator prompt), `--permission-mode`, `--model`/`--effort`,
  `--disallowedTools`, `--settings` (`coordinatorSettings`) and, with Telegram, `--channels`. The host runtime adds
  `--setting-sources=` and `--strict-mcp-config`. `coordinatorSettings` holds the allow list (minions, git, backlog,
  verification commands), denies `git push` and `gh pr merge`, sets `ask` for approvals, adds `apiKeyHelper` for key
  auth, `ENABLE_TOOL_SEARCH`, `disableBundledSkills`, and only with Telegram `enabledPlugins[telegram]: true` plus the
  `pre-telegram` hook. *New:* the wrapper also runs the startup step (`onStart`: intake sync, open usage sessions
  completed) and the routine clock (task-68.2) in the same node process.
- **Resets are blocked by any worker.** `contextResetCheck` (`src/runtime/context-reset.ts`) triggers after a
  delivery, at `contextTokens` (default 60k, from the transcript tail that the Stop hook names in meta
  `coordinator_transcript`) or after 10 hand-offs. It is blocked while any lease is active, *new:* while any process
  run is open (`withOpenRuns`), and during a drain. `scheduleDetachedRestart` refuses with active leases. The
  `contextReset` notice comes on `work record|release` responses, and `work advance` returns the decision
  `context-reset`. **Measured effect:** under a busy queue the reset never happens (see
  [Cost model](#cost-model)).
- **Workers are subagents of the coordinator.** `preAgentHook` admits `minions:<role>` only with an active lease of
  that role. *New:* workers hand back asynchronously. Their result arrives in the coordinator as a new message
  ("Another Claude session sent a message: … [Subagent hand-back]"), not as the Agent tool's return value. That
  matters for headless sessions (U3). Worker guards (`pre-bash`, `pre-file`, drain) fire only for hook inputs that
  carry `agent_id`. `COORDINATOR_ONLY_WORK_VERBS` (`run`, `claim`, `advance`, `release`) are refused to subagents only.
- **The Stop guard is global.** `stopHook` blocks the stop while any authorized ready task or continuing stage
  exists anywhere. It also runs `noteTranscript` (one meta slot, `coordinator_transcript`) and
  `trackCoordinatorUsage`. A per-task session would be told to dispatch other tasks, and its transcript would replace
  the router's in that one slot.
- **Token tracking is built (task-57.1), with two detection bugs** (*new*, found in this check; both fixed in
  phase 0, task-57.5):
  - `OWNER_TAG` (`src/runtime/coordinator-usage.ts`) expected only `<channel source="telegram"`. Plugin 0.0.7 writes
    `<channel source="plugin:telegram:telegram" …>`; the tag now matches both. Before the fix the baseline showed
    `ownerMessages: 0`, and meta `coordinator_last_owner_message` was never written. Every user of
    `lastOwnerMessageAt` acted as if the owner never wrote: the routine's 30-minute "owner active" window (a wake can cut a live conversation), the digest's
    30-minute hold exception, `routine.autoPromote.ownerSilentDays` (fails closed, so it always refuses) and the
    `--owner-approved` window (always refused on Telegram).
  - `RECOVER_PREFIX` and `WAKE_PREFIX` expected only the raw `/minions:recover` and `/minions:orchestrate wake`. The
    transcript stores the expanded form
    (`<command-message>minions:recover</command-message>\n<command-name>/minions:recover</command-name>…`), which
    detection now also matches. Before the fix the baseline showed `resetOverhead.recoveredSessions: 0`, and routine
    wakes were not counted as wakes.
  - *Also:* when a Stop first sees a new session id, all other open sessions are completed. That assumes one main
    session at a time.
- **Restarts and wakes** (*new*, task-68.2). The routine pass wakes the coordinator as a **fresh session**
  (`coordinator restart --wake` through `scheduleDetachedRestart`, prompt `/minions:orchestrate wake`). It does this
  only with the lock held, no active lease, 10 minutes idle and no owner message for 30 minutes. A crash start
  (`scheduleCrashStart`, recover prompt, at most 2 a day) is refused during a drain or an upgrade.
- **One bot holder.** The plugin is off at user scope and enabled only by the coordinator launch (task-51,
  `src/telegram/isolation.ts`). `telegramPollerStatus` checks that the `bot.pid` process's nearest claude ancestor is
  the wrapper's direct child. A process that is not under the coordinator claude and polls the bot shows up as
  `foreign`.
- **Live runs** (*new*, task-52, `LIVE_CLAUDE_RUN_GUIDANCE`): only the coordinator starts claude, with no lease active
  and a fresh `CLAUDE_CONFIG_DIR`. Workers never do. **Task-96** (in progress; nothing on main yet) adds the
  credential path for fresh-config headless runs: login via `claude setup-token` stored by `minions auth set` and
  passed as `CLAUDE_CODE_OAUTH_TOKEN`, api-key and helper reuse the container key. Never in argv, logs or the
  coordinator config. It also adds a coordinator-only live-run entry point that refuses while a lease is active.
- **Outbox** (`src/runtime/outbox.ts`): kinds `goal-ack … digest, other`, holds via `next_attempt_at` (task-68.5),
  no `session` column, and no sent-message map. `reply` returns `sent (id: N)`. The `tg_messages` table is planned in
  task-67.3 and is not built. Plugin 0.0.7 does not forward `reply_to_message`.
- **Runner** (`src/runtime/runner/`): run records are lease-keyed (`<state>/run/leases/<leaseId>/run.json`, O_EXCL)
  and hold process identities with start times. `supervise.ts` handles process groups, timeout, drain grace and
  SIGINT/TERM/KILL escalation. Both are reusable for sessions. Node cannot set `PR_SET_PDEATHSIG`, so the first
  version's "sessions die with the supervisor" was wrong: orphans are reaped from the records instead.
- **DB**: schema 9 with inline migrations (`src/runtime/db.ts`). Leases have a `holder` column, and `claimWithBrief`
  accepts `holder`.
- **Delivered task-68 phases**: routine pass and clock (68.2), digest and held questions (68.5), autonomous intake
  limits (68.6), `work advance` (68.7, on main as 616c54d). **68.8 (dispatcher spike) is still `blocked`** on its
  dependency 68.7, which is now on main.

## Decisions

1. **Fix the baseline before building on it** (phase 0). Owner-message and recovery detection must match the real
   transcript shapes. The per-role numbers of later phases depend on it, and so do the routine, digest and
   auto-promotion checks that read `lastOwnerMessageAt`.
2. **Reset barrier for the single coordinator** (phase 1, recommended, small). A context ceiling
   (`coordinator.contextReset.barrierTokens`, default 120k) above the reset threshold. Once it is passed and only
   active leases block the reset, `work claim` and `work advance` stop starting new stages
   (decision `context-reset-pending`). The Stop guard lets the session stop, and the reset happens when the last
   worker is recorded. It costs some throughput (a free slot waits until the running workers return) and bounds the
   context. It stays as the behaviour with sessions off.
3. **The router is the existing coordinator launch, made small.** It keeps the same wrapper, lock, tmux session,
   `--channels`, poller check and outbox transport. What changes: a routing skill (about 2k tokens) instead of
   orchestrate, `models.router` (default `haiku`), no Agent tool, and the Stop guard off for it. It never claims,
   dispatches or records. It owns no leases, so it resets freely (at 25k tokens or when idle).
4. **Two kinds of headless sessions** (owner decision: task sessions first, no thread sessions):
   - **task** (`task:<id>`): drives that task's stages (claim, spawn worker, `work advance`, next stage) with a
     task-scoped skill (`/minions:task <id>`). It is opened when the task has a runnable stage and capacity allows. It
     closes at `delivered`, `done`, `cancelled` or `blocked`, and after writing a session handoff at
     `awaiting-human`. It is reopened when the task becomes runnable again (a repair, an owner answer, an integration
     failure).
   - **general** (`general`): one session for non-task owner chat (new goals, intake, design questions, status
     questions the router cannot answer from `minions status`). It never claims. It files tasks through the backlog,
     and the supervisor then opens their task sessions. It owns no leases, so it resets at `contextTokens` at any time.
5. **Launch: one builder on top of task-96.** `buildSessionCommand(cfg, key)` reuses task-96's credential and env
   builder. Each session gets:
   - a **persistent** fresh `CLAUDE_CONFIG_DIR` (`<state>/run/sessions/<key>/config`, 0700), so `--resume` finds
     the transcript across wakes and no Telegram plugin is even installed;
   - `--plugin-dir`, `--append-system-prompt` (session prompt), `--settings` (`coordinatorSettings` without
     Telegram, plus `enabledPlugins[telegram]: false`), `--strict-mcp-config`, `--model models.coordinator`,
     `--permission-mode`, `--output-format stream-json`;
   - no `--channels`;
   - an env allowlist (no `TELEGRAM_*`) plus `MINIONS_SESSION=<key>`, which the hooks use to scope themselves.

   The task-96 live-run rule "refuse while a lease is active" applies to ad-hoc live runs only, not to the
   supervisor. Both share the builder, and the policy check stays in the entry point.
6. **Process model: one resident process per open session** (decided by the phase 3 spike). The session runs
   `-p --input-format stream-json --output-format stream-json`. The supervisor writes inbox messages to its stdin,
   hand-backs arrive as new turns, and the process exits at close. A crash is resumed with `-p --resume <id>`.
   Rejected: one `-p --resume <id>` process per wake. A per-wake process cannot take inbox messages while one of its
   workers runs, so owner and supervisor messages would wait for the hand-back. Memory: about 250 MB per idle
   session, at most `coordinator.sessions.max` processes (default `maxActiveTasks + 1`). The prompt cache TTL is
   5 minutes, so a wake after a longer idle gap pays a cold cache write either way (see the cost model).
7. **A deterministic supervisor starts sessions, never a model.** The hidden `minions coordinator supervise` is a
   node process with a reuse-safe lock (meta row, `{pid, start}`, like `routine_lock`). The wrapper starts it
   detached (its own session), so router resets and restarts do not touch it. It keeps a run record per session
   (`<state>/run/sessions/<key>/run.json`, O_EXCL: one process per session) and uses `supervise.ts` for process
   groups, timeouts and the drain. At its start it reaps orphans from the records (process identity with start time).
   It does not use the worker Landlock sandbox: a session needs the coordinator's rights. This amends agent-runtimes
   D11.3 only for this launch kind. Leases and workers never start claude.
8. **Workers stay subagents, now of their task session.** `preAgentHook`, briefs, `work submit`, record-time checks
   and the worker guards are unchanged (they key on `agent_id`, which subagents of a headless session still carry,
   with `agent_type`: confirmed by the spike, U5). A lease's `holder` is the session key. A task never has two
   workers at once, so a task session resets only between stages, and never waits long for it.
9. **Hooks and state scoped by `MINIONS_SESSION`.** With the variable set:
   - the Stop guard looks only at the session's task (task) or is off (general);
   - `noteTranscript` uses `coordinator_transcript:<key>`;
   - usage states carry the role (`router`, `task`, `general`) and only complete open sessions of the same key;
   - `contextResetCheck` counts only the session's own leases and events;
   - handoffs go to `coordinator-handoff.<key>.json`;
   - `work advance --task <id>` claims only that task's next stage.

   Without the variable, everything behaves as today.

   Built in phase 6 (task-57.10; `src/runtime/session-scope.ts`, `session-stop.ts`): the keys are `router`, `general`
   and `task:<id>` (parsed with `parseSessionKey`; an empty value is unset). A malformed value records nothing in the
   hooks (the stop is allowed) and is refused by commands. A session's Stop guard keeps its no-progress fingerprint in
   meta `stop_guard:<key>`. Its reset check starts at the first Stop of its current transcript, counts only leases
   it holds and their records and releases, and its handoff events are `session-handoff`. In a task session,
   `work claim` and `work advance` refuse other tasks, and the router and general sessions never claim. The baseline
   gets `perRole` once a session state exists.
10. **Durable state is the only channel between sessions.** No session reads another's transcript. A session note (at
    most 4 KB, redacted like `writeHandoff`) can travel from the general session to a new task session.
11. **Sessions before the dispatcher.** See [Fit with unattended delivery](#fit-with-unattended-delivery).

## Fit with unattended delivery

The two designs share one supervisor and one launch path. They do not conflict once these rules hold:

| Unattended-delivery piece | With sessions on |
| - | - |
| Routine pass (68.2), deterministic | Unchanged. It runs in the wrapper clock (the router's wrapper) and the manager watchdog. |
| Wake for runnable stages (fresh coordinator session) | Replaced by **supervisor open**: a runnable stage of a task without an open session opens `task:<id>`. The router is never restarted for dispatch. `minWakeGapMinutes` and `maxWakesPerDay` cap opens of new task sessions per day the same way. |
| Wake for `unvalidated`, `needs-split`, `awaiting-human` | Goes to the owning task session (inbox message). |
| Digest wake | The digest is an outbox item. A due item ends the router's background `coordinator wait`, and the router sends `notify digest` with one `reply` and acks it. No restart. |
| Crash start | Unchanged for the router. The supervisor restarts sessions itself (2 resumes, then `failed` and a blocker). |
| Held questions, digest polls | Question items get a `session` column. An answer `Q1 2` goes to the session that asked. |
| `work advance` (68.7) | Used by task sessions, scoped with `--task`. |
| Dispatcher (68.8 decision 9.3) | A later launch kind `stage` on the same supervisor (phase 10). Happy-path stages run without a task-session turn, and the task session is woken only for exceptions. |
| Local integration on approval (task-82, design) | The task session closes at `delivered`. An integration failure (`changes-requested`) is a runnable stage again, so the supervisor reopens the session. |

**Which comes first: sessions, then the dispatcher.**

- It follows the owner decision, and it gives the context focus the owner cares about.
- The dispatcher needs a place for exceptions that has the task's context. The task session is that place.
- Running workers as headless main-thread `claude -p --agent` processes drops `agent_id` from their hook input. The
  worker guards (`pre-bash`, `pre-file`, drain) would no longer fire, so the dispatcher needs a guard rework
  (`MINIONS_ROLE`-style marking, as for process workers). That is the larger security change, and it is better made
  on a working supervisor.
- Both need the same spike. Task-68.8's spike part is folded into phase 3. Its build part is phase 10, which waits
  for the phase 9 numbers and an owner yes. Task-68.8 can be unblocked now (68.7 is on main) and retargeted.

## Routing model

Inbound owner message (router turn):

1. The router runs `minions coordinator route --json` with the channel meta and the text on stdin. The deterministic
   resolver takes the first rule that matches:
   1. a reply to a bot message: the session of `reply_to_message_id` in `tg_messages` (only with the task-67
      channel server; plugin 0.0.7 has no reply metadata);
   2. a session named explicitly: a task id (`task-57`), `/s <key>`, or a ref `#<message id>` (task-58 footer) found
      in `tg_messages`;
   3. a bare number or `Q<n> <answer>` while exactly one matching open question waits (outbox `question` items carry
      their session);
   4. otherwise `general` (task-66: no ref means a new topic, and with no thread sessions every new topic goes to the
      general session). A bare number while several questions are open is `ambiguous`, with the candidates.
2. With a target: `minions coordinator send <key>` stores a `session_inbox` row, and the supervisor delivers it
   (stdin of the resident process, or a resume). If the session is closed, the supervisor reopens it. The router
   reacts with an emoji as the ack and does not answer the content.
3. `ambiguous`: the router asks one numbered poll ("1. task-57 (recommended) 2. general 3. Other"). This is the only
   judgement the cheap model makes.
4. The router answers a few things itself: `status` (from `minions status --json`), the list of sessions, pause and
   resume.

Other events never pass through the router. Worker results arrive in the task session that spawned the worker. The
supervisor opens task sessions for runnable stages. CI, drain and integration events reach the affected task session
as inbox messages from the supervisor.

Outbound: every session records notifications with `minions notify enqueue --session <key>` (keys unchanged). The
router keeps one `minions coordinator wait --json` in the background (Bash `run_in_background`). It exits when an
item is due, and its completion wakes the router. The router sends with `reply` and records
`notify ack <key> --message-id <N>`, which fills `tg_messages(message_id, ref, key, session, sent_at)`. Phase 8
creates that table with task-67.3's columns, and task-67.3 reuses it. After task-67, the channel server keeps the map
itself and rule 1 works. Whether the server could then send due items without a router wake is a task-67 follow-up.

## Session lifecycle

| | Router | Task session | General session |
| - | - | - | - |
| Opened by | `coordinator run` (as today) | supervisor: a runnable stage of the task, within `sessions.max`, budget and pauses | supervisor, on the first routed message |
| Process | interactive claude in tmux | resident `-p` stream-json, or `-p --resume` per wake (spike) | same as task |
| Config dir | today's (`~/.claude`, Telegram on) | fresh, persistent per key, no plugins but minions | same |
| Context reset | at 25k or idle; allowed with active leases (owns none) | between stages above `contextTokens`: session handoff, then a fresh session id with the same key | at `contextTokens`, any time |
| Closed | `minions down`, upgrade | `delivered`, `done`, `cancelled`, `blocked`; `awaiting-human` after a handoff | never (resets only) |
| Model | `models.router` (default `haiku`) | `models.coordinator` | `models.coordinator` |

Limits: `coordinator.sessions.max` (default `maxActiveTasks + 1`), at most one process per session, and the
existing budget gate in `work claim`. A session is not woken while starts are paused, except to answer the owner.
Rollback: `coordinator.sessions.enabled: false` (default until phase 9) keeps today's single coordinator, with the
reset barrier.

## Telegram ownership

- One bot holder, unchanged: only the router's launch enables the plugin and has the token in its env.
  `telegramPollerStatus` is unchanged, because the router is the coordinator claude.
- Sessions cannot poll, in four independent ways:
  - their fresh config dir has no Telegram plugin installed;
  - their flag settings disable it anyway and `--strict-mcp-config` loads no MCP server;
  - `TELEGRAM_*` is not in their env (the supervisor is a child of the wrapper, not of the router claude, and its
    env is an allowlist);
  - `preTelegramHook` denies the tools.

  A test asserts the argv, env and settings of a session launch. A session that polled anyway would show as
  `foreign`, because it is not under the router claude.
- Sessions do not start claude themselves. Only the supervisor does, through one code path. The task-51 and task-52
  rules for workers stay.
- The host manager bot (task-53) stays separate. It is host-only, has no model and holds its own token. Sessions
  propose setup changes through `change_requests`.

## Failure and recovery

- **The router dies or resets.** Same path as today (`coordinator restart --recover`). Sessions, inbox and outbox are
  in the DB, so the new router flushes pending items and starts `wait` again. A message handed to a dying router can
  still be lost (the known gap from telegram.md), but the window is short because router turns are short.
- **A session process dies mid-turn.** The supervisor sees the exit (or reaps it from the record). Workers of that
  session die with it, so their leases are released and the task's stage is re-dispatched (the existing recover
  logic, scoped to the task). The session resumes with `--resume <id>` and a recover prompt scoped to the task. After
  2 failed resumes it is marked `failed`, and the owner gets an outbox `blocker`.
- **The supervisor dies.** Its sessions keep running as orphans (no `PDEATHSIG` in Node). The wrapper sees the stale
  lock and starts it again, and `status` reports it. The new supervisor adopts live sessions whose identity matches
  their record, or stops them and resumes. The router alone keeps Telegram working meanwhile.
- **Drain or upgrade.** The supervisor opens nothing new and delivers no inbox messages except drain notices. Running
  sessions follow the drain hook (their workers write `wip:` and submit `partial`). Then the sessions end, and the
  router goes last.
- **Budget hit.** Claims are refused (unchanged). Open sessions finish their running stage, and the supervisor opens
  no new task sessions. The general session still answers the owner.

## Cost model

### Measured baseline

Source: `minions work spend --json` → `coordinator.baseline`, read 2026-10-28 about 20:00 UTC, since 2026-10-27 07:07
UTC. Billing `api-key`, model `claude-opus-5-5` ($5 per MTok input, with cache read ×0.1, cache write ×1.25 and output
×5). The rows marked *transcripts* come from a one-off read of the coordinator transcripts for this check.

| | Value |
| - | - |
| Sessions | 18 (1 open); ended by 13 context resets (triggers: context 9, delivered 8, handoffs 2) and 4 restarts |
| Coordinator tokens | 154.9M: cache read 149.0M (96%), cache write 5.36M, output 0.51M |
| Share | 94.3% of all tokens; ~$120.6 of ~$255.7 estimated (72% of USD) |
| USD split | cache read $74.5, cache write $33.5, output $12.6 |
| Turns | 1,220 (67.8 per session); mean context 126.5k per turn, max 512k |
| Per delivered task (18) | **8.6M tokens, ~68 turns, ~$6.70** |
| Fixed prefix `F` (*transcripts*) | 24.3k on the first turn of every session (stable) |
| The blocked session (*transcripts*) | one session on 27 Oct, 07:32 to 11:25: 397 turns, mean 257k, max 512k, 102M tokens (66%), ~$74 (61%), 62 worker spawns; its reset was blocked by active leases the whole time |
| All other sessions (*transcripts*) | ~52.8M tokens over ~823 turns: mean ~64k |
| Reset overhead (*transcripts*) | ~236k tokens (~6.7 turns) per recovery until the first claim, advance or reply: ~4.5M in total (~3%) |
| Worker spawns, owner messages (*transcripts*) | ~164 spawns (~7.4 coordinator turns each); ~44 owner Telegram messages (the baseline shows 0: bug, decision 1) |

What this says: the waste is turns on contexts that cannot shrink. The prefix and the reset overhead are small. Most
of the spend sits in cache reads of big contexts, and in USD a second large part is cache writes after idle gaps
(cache TTL about 5 minutes; U4).

### Scenarios per delivered task (coordinator side only)

Assumptions:

- a task needs `S` worker stages (engineer, tester, reviewer, plus repairs and corrections): central value 5, range 3
  to 9;
- with `work advance`, a task session needs about 4 turns per stage plus 4 to open and close;
- its context starts at `F` and grows about 2k per turn (the measured growth in short sessions);
- each stage ends with a cold wake (a worker runs longer than the cache TTL), which re-writes the session context;
- about 2.4 owner messages per task, of which 1.5 go to the general session;
- about 4 outbound batches per task;
- router turns about 20k each on haiku.

| Scenario | Tokens | USD | Notes |
| - | - | - | - |
| A. Today | 8.6M | ~$6.70 | measured |
| B. Reset barrier only (phase 1) | ~5.4M (−35% to −45%) | ~$4.3 (−30% to −40%) | 68 turns at a mean of ~80k instead of 127k; a free slot waits while a reset drains |
| C. Router + task sessions + general session (phases 4 to 9) | ~1.7M (**−80%**; range −64% to −86%) | ~$3.9 (**−43%**; range −18% to −63%) | task session ~24 turns at a mean of ~48k = 1.15M, with S cold writes ≈ 250k (~$1.6 of its ~$2.4); general ~0.2M (~$0.55); owner turns in task sessions ~0.1M (~$0.65); router ~0.24M haiku (~$0.25) |
| D. C + dispatcher (phase 10) | ~0.8M (−90%) | ~$1.8 (−73%) | the task session wakes only to open, close and handle exceptions (~8 turns, 2 cold writes) |

Reading the table:

- **USD falls less than tokens** in C. A cold wake writes the whole session context at 12.5 times the price of
  reading it. Today a busy coordinator often keeps its cache warm. A task session waiting for a 20-minute worker does
  not. Small task contexts and the dispatcher (D) are what make the wakes cheap. If the spike finds a longer cache TTL
  for headless runs, C's USD saving grows towards its token saving.
- **B is most of C's USD saving for a fraction of the work**, because the main waste today is the one session that
  could not reset. B is still worth building first. C additionally gives per-task focus (the owner's concern), no
  throughput dip from resets, cheap acks on haiku, and the base for D.
- With a subscription (login billing) the token column is what matters (rate-limit windows), and C saves about 80%.
- The first version's go/no-go rule (a saving of at least 25% of coordinator spend) is met by B, C and D. Phase 9
  checks the prediction with the per-role baseline after 3 deliveries.

## Risks

- **R1: async hand-back under `-p`** (U3). If a single-shot `-p` exits before the worker returns, the per-wake model
  fails. The resident stream-json model (decision 6) avoids it, at the cost of memory (measured about 250 MB per
  idle session; the container has 7 GB). Decided by the spike: resident.
- **R2: cold-cache wakes** reduce the USD saving (see the cost model). Mitigation: keep task-session prompts and
  context small (task-scoped skill, compact briefs, `work advance`), reset between stages above `contextTokens`,
  then the dispatcher.
- **R3: credential visibility.** A task session runs workers. Whatever credential its process has (the task-96
  `CLAUDE_CODE_OAUTH_TOKEN` in its env, or the key file behind `apiKeyHelper`), its workers' Bash can reach it,
  exactly as with today's coordinator credentials. Task-96's "workers cannot read it" holds for its live runs (no
  workers), not for sessions. The design does not widen today's exposure, but it does not close it either (open
  question 3). The spike (U5) found no credential or `TELEGRAM_*` var in the env of a session or its subagent with
  the `apiKeyHelper` method; the readable key file, guarded only by the secrets patterns, is the residual.
- **R4: Telegram takeover.** Covered by four independent layers plus a launch test and the `foreign` detection.
  Residual: a Claude Code change that loads plugins from `--plugin-dir` differently. The spike checks the poller after
  every run.
- **R5: global state written by the wrong session.** The single meta slots (`coordinator_transcript`, usage
  completion, the global Stop guard) would let one session disturb another. Phase 6 scopes them by `MINIONS_SESSION`,
  with tests that run two sessions' hook inputs against one DB.
- **R6: misrouting on haiku.** Deterministic rules come first, and the default target is `general`, which can
  forward to a task session through the inbox. The router asks a poll only for `ambiguous`. If misroutes show up in
  phase 9, `models.router: sonnet` is a setting change.
- **R7: complexity and two modes.** Sessions stay behind `coordinator.sessions.enabled` until phase 9, and every
  phase tests that nothing changes with it off.

## Unknowns (answered by the phase 3 spike, a coordinator-run live check; U8 stays open)

Spike setup: coordinator live runs on 2026-10-29, claude 2.1.292, haiku, the `apiKeyHelper` credential, a probe
plugin whose hooks log their input (not the real minions hooks).

- U1: under `claude -p` with the fresh config, `--plugin-dir` and `--settings`, the plugin hooks (Stop, PreToolUse
  Agent/Bash/file, drain) and the plugin agents load, also after `--resume <id>`. Answer: yes. With `--plugin-dir`
  and a fresh `CLAUDE_CONFIG_DIR`, the plugin agent (`minions:probe`) and hooks (Stop, SubagentStop, PreToolUse
  Agent and Bash) load under `-p`, and again after `-p --resume <id>` (transcript copied into the new config dir; the
  session id is kept). Caveat: `/tmp` is mounted `noexec`, so a hook command exec'd from it fails; run it via
  `sh <script>` or from outside `/tmp` (phase 4).
- U2: the Stop hook input in `-p` mode carries `transcript_path` and `session_id`, and the path is under the session's
  config dir. Answer: yes. `transcript_path` is
  `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<session_id>.jsonl`.
- U3: when a `-p` turn spawns a worker, does the process wait for the asynchronous hand-back, and does the hand-back
  start a new turn? Checked for single-shot `-p` and for resident `--input-format stream-json`. Answer: a per-wake
  `-p` process cannot take inbox messages while its worker runs; the resident stream-json process takes them and
  the hand-back as new turns. Detail: single-shot `-p` does wait: its first turn ends (a `result` event), the
  process stays alive, and the hand-back starts a second turn before exit. Resident stream-json: each stdin user
  message is a turn, hand-backs arrive as new turns, and the process exits after stdin EOF once background tasks
  finish. It emits `system` events `task_started`, `task_notification` and `background_tasks_changed`, which the
  supervisor can use. Decision 6: resident.
- U4: the cache TTL seen by headless runs (5 minutes or 1 hour), and whether two sessions with an identical prefix
  share the cache (compare `cache_creation_input_tokens` on the second session's first turn). Answer: TTL
  5 minutes (`usage.cache_creation.ephemeral_5m_input_tokens`; the 1-hour count is 0). Sessions share the cache: a
  brand-new session's first turn read about 21k cached tokens (the identical system and tools prefix) and created
  about 21k. So the fixed prefix `F` is warm for a new session while any session with the same prefix ran in the
  last 5 minutes.
- U5: subagents of a headless session carry `agent_id` in hook input (the worker guards depend on it), and whether the
  session's credential env reaches their Bash (R3). Answer: yes. Subagent PreToolUse and SubagentStop inputs carry
  `agent_id` and `agent_type`, so decision 8 holds. Neither the main session nor its subagent has
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or any `TELEGRAM_*` var in its env (`apiKeyHelper` method).
  R3 residual: the helper's key file (`/opt/minions/secrets/anthropic-api-key`) is readable, guarded only by the
  `pre-bash`/`pre-file` secrets patterns, as today.
- U6: memory of a resident idle session, and the start-up time of a `--resume` wake. Answer: about 230 to 270 MB
  RSS per idle session (haiku, small context). A `-p --resume` wake takes about 1.1 s from launch to its result for a
  trivial turn (init in about 0.3 s), so crash resumes are cheap in time.
- U7 (for task-68.8): `claude -p --agent minions:<role>` gets the role's agent definition, model and tool limits.
  Answer: yes. It uses the agent definition's model and tool limits (`tools: [Bash]` only, even with `Write` in
  `--allowedTools`). Its hook inputs carry no `agent_id` or `agent_type`, so the worker guards do not fire; phase
  10's guard rework is required.
- U8: subscription rate limits with several sessions at once (observed over phase 9; `sessions.max` caps it).

## Phases

Ordered. Each phase is one task. "Worker" means a normal engineer, tester and reviewer pipeline. Phases marked
**live run** need the coordinator to run Claude Code itself (workers never start claude). Phases marked **owner**
need an owner decision first.

0. **child: Coordinator baseline detection fixes** | criteria: `OWNER_TAG` matches `<channel source="plugin:telegram:telegram"` (and plain `telegram` for the task-67 server), so `ownerMessages` counts and `coordinator_last_owner_message` is written; recovery and wake detection match the expanded slash-command form (`<command-name>/minions:recover</command-name>`, `/minions:orchestrate` with args `wake`) as well as the raw form; fixtures copied from real transcript shapes; the task-57.3 review items folded in; tests show that the routine owner-active window, digest holds and auto-promotion caps see a recent owner message; `npm run typecheck` and `npm test` pass | depends: none (worker; urgent, independent)
1. **child: Reset barrier for the single coordinator** | criteria: `coordinator.contextReset.barrierTokens` (default 120k, null = off, registered with a setting class); when the context is at or above it and only leases or open runs block the reset, `work claim` and `work advance` start nothing new (decision `context-reset-pending`, with a clear hint), `work next` shows `waitingOn: context-reset`, the Stop guard allows the stop, and the reset becomes due when the last lease is recorded; `status` shows it; nothing changes below the barrier; tests | depends: none (worker; owner question 1)
2. **child: task-96 (headless credentials and live-run entry point)** | criteria: as filed; additionally its credential and env builder is a function the supervisor can call, without the live-run lease check, and it is tested on its own | depends: none (worker, in progress; add this note to its review)
3. **(done, task-57.7) child: Spike: headless coordinator sessions** | criteria: through the task-96 entry point, with no lease active, the coordinator answers U1 to U7 with a throwaway task in a scratch repository; it checks `minions status` for the poller after each run; it records the answers and the chosen process model (resident or per-wake) in this doc; it absorbs the spike part of task-68.8 (unblock and retarget 68.8) | depends: 2 (**live run** by the coordinator)

   Result: U1 to U7 answered in
   [Unknowns](#unknowns-answered-by-the-phase-3-spike-a-coordinator-run-live-check-u8-stays-open); process model
   resident (decision 6). `minions status` showed the Telegram poller `ok` after each run. Task-68.8's
   spike part is answered here; its build part is retargeted to phase 10 (task-57.14).
4. **child: Session schema, settings and launch builder** | criteria: `sessions` (key, kind, claude session id, status, model, config dir, opened, last wake, closed, resumes, failure) and `session_inbox` tables (inline migration, schema 10); `coordinator.sessions.enabled` (default off), `coordinator.sessions.max`, `models.router` registered with setting classes; `buildSessionCommand` on the task-96 builder: persistent fresh config dir 0700, flags per decision 5, env allowlist with `MINIONS_SESSION`; hook commands in the session settings are never exec'd from a `noexec` `/tmp` (run via `sh` or from the plugin dir, U1), with a test; a test asserts that the argv, env and settings carry no Telegram token, plugin, channel or tools and no secret in argv; no process is started yet | depends: 3 (worker)
5. **child: Supervisor** | criteria: hidden `minions coordinator supervise` with a reuse-safe lock; run record per session (O_EXCL); spawn and stop through `supervise.ts` (process group, timeout, drain); the process model from phase 3; orphans adopted or reaped at start from identities in the records; inbox delivery; 2 resumes, then `failed` and an outbox `blocker`; the wrapper starts it detached when sessions are on and restarts it when its lock is stale; tests with a fake `claude` binary (spawn, crash, resume, drain, orphan) | depends: 4 (worker)

   Result (task-57.9, src/runtime/supervisor.ts): the lock is the meta row `supervisor_lock` {pid, start, bootId, at},
   taken in one transaction; a holder is live only with its pid, start time, boot and a `coordinator supervise`
   command line. A process runs for an `open` session with undelivered inbox messages (the `general` session is
   opened on its first one) and stays resident until the session is closed, a drain (drain notice, then stdin closed,
   the drain grace as the hard limit), the supervisor stops, or a crash. A resident process cannot be adopted in
   place (its stdin and stdout were the dead supervisor's pipes), so "adopt" means: the orphan is stopped by its
   recorded identity (process group, then processes with `MINIONS_SESSION=<key>` started after it) and the session
   is resumed with `--resume`, which does not count as a failed resume. A completed turn resets the resume count;
   the third crash in a row marks the session `failed` with an outbox `blocker`. The wrapper starts the supervisor
   detached and restarts it when its lock is stale (checked every minute); with sessions off it starts nothing.
6. **child: Session-scoped hooks and state** | criteria: with `MINIONS_SESSION` set, the Stop guard is scoped to the session's task (task) or off (general and router); `noteTranscript` uses `coordinator_transcript:<key>`; usage states carry the role and only complete sessions of the same key; the baseline shows tokens per role; `contextResetCheck` and handoffs are per session; lease `holder` = session key; `work advance --task <id>`; tests with two sessions' hook inputs on one DB; with the variable unset nothing changes | depends: 4 (worker; can run in parallel with 5)
7. **child: Task sessions** | criteria: the supervisor opens `task:<id>` for a runnable stage within `sessions.max`, budget, pauses and the routine's caps; the `/minions:task <id>` skill (claim, spawn, `work advance --task`, inbox check between stages, final summary to the outbox, a handoff at `awaiting-human`); close and reopen rules per decision 4; per-task recover after a session crash; with sessions on, the routine pass opens task sessions instead of waking the coordinator, and the coordinator prompt no longer dispatches; tests with the fake binary | depends: 5, 6 (worker)
   Result (task-57.11, src/runtime/task-sessions.ts, the `/minions:task` skill): one deterministic pass, run by the
   supervisor every `timing.openMs` (30 s) and by the routine pass instead of a coordinator wake (sessions on: the
   routine wakes the coordinator only for the digest), opens `task:<id>` for each `work next` runnable stage (so
   capacity, pauses, drain and budget apply) within `sessions.max`; a session is a row plus a `/minions:task <id>`
   kickoff in its inbox. The routine's gap and daily cap apply to opens only with `routine.enabled`; each open is a
   `routine-wake` event with `data.session`, so opens and coordinator wakes share the caps. Close at `delivered`,
   `done`, `cancelled` or `blocked` (never while a worker of the task runs), and at `awaiting-human` only after a
   `session-handoff` event of the key after the task's last record. A closed session is reopened (same claude
   session id) when the task is runnable again; a `failed` one is never reopened automatically (the owner does). An
   idle open session of a runnable task gets a supervisor nudge at most once per `timing.nudgeMs` (5 min). Before a
   task session's process is resumed, its leases are recovered: unsubmitted ones are released (the stage is runnable
   again), submitted ones are left for the session to record with `work advance`, and the outcome goes to its inbox.
   With sessions on, unvalidated, needs-split and awaiting-human results are handled by the task session itself (no
   inbox forward; the table's "inbox message" variant is not built), the coordinator prompt and its Stop guard no
   longer dispatch, and the single coordinator's reset barrier does not hold `work next`. Left for phase 8: digest
   wakes still wait while task sessions hold leases, and task-session outbox items wait for the interactive
   coordinator's next turn. A context reset inside a task session is interim (handoff, keep the key). Live check for
   phase 9: a stream-json user message `/minions:task <id>` expands the plugin skill in a headless session.
8. **child: Router, general session and outbound** | criteria: `coordinator route --json` resolver (rules 2 to 4 of the routing model, `ambiguous`), table tests; `coordinator send <key>` and `coordinator wait --json`; `notify enqueue --session`, `notify ack --message-id` and a `tg_messages` table with task-67.3's columns plus `session`; question items keep their session, and `Q1 2` answers route back; router prompt and skill on `models.router`, no Agent tool, resets allowed with active leases; the `general` session; the digest is sent by the router; poller and isolation checks unchanged and tested | depends: 7 (worker; may split into resolver/outbound and router/general if large)
   Result (task-57.12, src/runtime/router.ts, src/runtime/router-prompt.ts, the `/minions:route` skill): with sessions
   on, the interactive coordinator is the router: `models.router` (haiku), no Agent tool, `MINIONS_SESSION=router`,
   and its system prompt is `ROUTER_PROMPT`, not coordinator.md (about 24k tokens). It always starts with
   `/minions:route start`, also on recover and wake; `SESSIONS_COORDINATOR_NOTE` is gone, replaced by this launch.
   `tg_messages` (schema 11) has one row per outbox key; the key column is `outbox_key` (not `key`), plus `session`.
   An open question is a delivered `question` item without `answered_at` from the last 7 days; a null session means
   `general`. `coordinator send` reopens a closed or failed session for an owner message; `general` itself is opened
   by the supervisor on its first inbox message. A send to a task that never had a session opens it with the
   `/minions:task` kickoff before the owner text. The task-session pass never closes a session while an owner message
   waits in its inbox (it closes on a later pass, after that turn). `Q<n>` falls back to the only open question when
   no digest numbered it. Leases held by `task:` or `general` no longer block a router restart or `sync`
   (`leaseBlockers` in commands.ts); `live-run` still counts every lease. With the router running, the routine pass
   does not restart it for the digest (its background `coordinator wait` returns `digest`); a crash start stays. The
   router resets at min(`contextTokens`, 25k), checked with `coordinator handoff --check` as the last step of every
   turn; that Reset step is the only time it restarts itself. Live checks for phase 9: the router keeps `coordinator wait` in the background
   and wakes on its completion; an owner message reaches the general session; the poller stays `ok`.
9. **child: Sessions live check, docs and rollout** | criteria: sessions in `minions status` and `doctor`; README, cli.md, bootstrap.md and telegram.md updated; the coordinator enables sessions on this project for at least 3 deliveries and reports tokens and USD per delivered task per role against this cost model, misroutes and the poller state; owner poll on keeping them on and on making them the default | depends: 8 (**live run** by the coordinator; **owner**)
10. **child: Deterministic dispatcher on the supervisor (task-68.8 build part)** | criteria: launch kind `stage` (`claude -p --agent minions:<role>`, worker settings, no Telegram); a worker-guard rework so headless workers are guarded without `agent_id` (required: the spike found no `agent_id` in `--agent` hook inputs, U7; `MINIONS_ROLE`-style marking, tests for pre-bash, pre-file and drain); hook commands not exec'd from a `noexec` `/tmp` (U1); record with usage from stream-json; one correction resume; exceptions wake the task session; launch argv, env and settings test | depends: 9 (**owner** yes after the phase 9 numbers)

New commands fold under the internal `coordinator` command (`supervise`, `route`, `send`, `wait`) and existing ones
(`notify`, `work advance`). There is no new top-level command (cli-surface.md).

## Open questions for the owner

1. **Reset barrier first** (phase 1): build it now as a quick win and as the fallback with sessions off (recommended;
   about a third less coordinator spend within days, at the cost of a short dispatch pause before each reset), or skip
   it and wait for sessions?
2. **Order:** sessions first, then the dispatcher (recommended: focus first, and the dispatcher's guard rework is
   safer on a working supervisor), or the dispatcher first (the larger saving per task, but it keeps one big
   coordinator context for exceptions and chat)?
3. **Credentials in task sessions** (R3): accept that a task session's workers can reach its model credential, as
   they can today with the coordinator's (recommended: no new exposure), or require a credential path that workers
   cannot read before phase 7 (needs a new mechanism, and may not exist for login tokens)?

## Alternatives rejected

- **The router starts `claude -p` from its own Bash.** That is a nested claude that inherits the router's env,
  including `TELEGRAM_BOT_TOKEN` (the task-51 takeover). Forbidden.
- **Long-lived interactive sessions, one tmux window each.** Owner messages would have to be typed into a TUI with
  `tmux send-keys` (fragile, and an injection surface). Resident headless stream-json gives the same liveness with a
  clean stdin protocol.
- **Targeted sessions as subagents of the router.** Subagents cannot receive later owner messages and have no Agent
  tool, so they cannot run workers.
- **A purely deterministic router (no model).** The plugin delivers inbound messages only to a Claude session with
  `--channels`, and ambiguous free text needs judgement. The deterministic resolver does most of the work.
- **Router and general session in one (today's coordinator minus dispatch, on the coordinator model).** It is
  simpler, with one hop less, but the Telegram holder would grow a context again, and the owner chose a haiku
  router. It stays possible as a fallback through `models.router`.
- **Thread sessions now** (one per owner conversation). Deferred by the owner. The general session covers non-task
  chat, and the routing rules leave room to add `thread:<id>` later.
- **A minions sender that calls `sendMessage` directly** (no router wake for outbound). It would put the token into a
  second process. To reconsider with task-67, where the channel server already holds the token.
- **The host manager bot as router.** It has no model by design and sits on the host side of the trust boundary.
- **Resets alone, by lowering `contextTokens`.** It does not help: resets are blocked by leases, not by the threshold.
  Hence the barrier (phase 1).

## Step 1: coordinator token tracking (built, task-57.1)

Specified in the first version and built in `src/runtime/coordinator-usage.ts`. Phase 0 fixes the two detection
bugs found in this check.

- **Source:** the Stop hook reads the main-session transcript incrementally from a byte offset kept in meta
  `coordinator_usage:<session_id>`, and sums `message.usage` of main-session assistant lines, with the components
  kept separately. Sidechain lines are skipped (workers are counted through `--usage`), each message id is counted
  once, and a truncated last line waits for the next read. It is best-effort and never changes the stop decision.
- **Which Stop counts:** no `agent_id`/`agent_type`, no `MINIONS_ROLE`, the coordinator lock held, and a plain
  session id (`[A-Za-z0-9_.-]`).
- **Storage without a schema change:** per-session state (offset, components, turns, context sum and max, owner
  messages, recovered flag and overhead, the last 500 message ids, end trigger) lives in the meta row. Each turn that
  adds tokens writes one cumulative `usage` event (source `transcript`). The Stop guard's progress fingerprint
  ignores `usage` events.
- **Bounded:** one read of at most 4 MB per Stop. A line without its newline is left for later, and a file shorter
  than the offset is not re-read.
- **End trigger:** `context-reset` (with the reset triggers that held, recorded by `coordinator restart --detach` in
  meta `coordinator_reset_request`), `restart` (meta `coordinator_restart`), or `exit`. Open sessions are completed
  at coordinator start and when a Stop first sees a new session id (phase 6 scopes this per key).
- **Reset overhead:** in a session whose first user message is the recovery prompt, the tokens until the first
  assistant message with a `minions work claim` call or a Telegram `reply`. Phase 0: match the expanded prompt form,
  and count `work advance` too.
- **Manual override:** `work spend --session --tokens` defaults to the current Claude session id. Once a key has a
  manual figure, its measured figures no longer count.
- **Report:** `work spend --json` → `coordinator.baseline` (sessions, resets by trigger, turns, mean and max context,
  tokens per delivered task and per owner message, reset overhead, wakes, share, weighted USD), and a short form in
  `work spend`.
- **Weights:** input 1, cache read 0.1, cache write 1.25, output 5 times the spend.ts input rate.
