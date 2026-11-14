# Autonomy: automatic flow, coordinator-owned control, Telegram threads and polls

Status: **owner direction (2026-10-31); phases 1 to 5 built on branch `autonomy`, not yet run live.** This document supersedes the parts of
earlier designs it names under [Reversed decisions](#reversed-decisions).

Owner direction (2026-10-31, after a minions-on-minions run was too slow and too expensive):

1. **Automatic flow.** Tasks move between dev, review and merge without the coordinator on a normal day. The
   coordinator is needed only for exceptions.
2. **The coordinator has full control.** It sets up projects, uses the owner's secrets, defines worker profiles (roles) and
   flows (workflows), assigns a flow per task with a default for the rest, and changes any of it live: "remove the
   tester from the flow" takes effect on the next stage, without a restart and without the owner.
3. **Telegram: threads and polls.** Replies carry their context to the coordinator, the coordinator answers in the
   thread, and it can ask a multiple-choice question as a native poll and get the answer back.
4. **Context management by thread.** Each Telegram thread gets its own coordinator session; a new thread gets a new
   session.

The owner trusts the coordinator with this ("I believe in it, and think it should turn out to be safe"). Safety
therefore comes from an audit trail, undo and notices, not from owner confirmation of each change.

## Phases

| Phase | What | State |
| - | - | - |
| 1 | Autopilot dispatcher: deterministic stage loop with headless workers | built, verified live; the only dispatch path (Decision 10) |
| 2 | Control layer, flows with `ci` / `merge` ends, live workflow edits mid-flight | built |
| 3 | Owner secrets granted per role, and the coordinator's plain `env` | built (`verification.secrets` for the integrator: not yet) |
| 4 | Telegram: reply context end to end, threaded replies, native polls | built |
| 5 | Thread sessions: one coordinator session per Telegram thread | built |
| 6 | New projects: `minions setup` in an empty directory creates the repository; the coordinator does the rest | built |
| 7 | Telegram-approved publishing: the coordinator proposes, a host publisher with its own bot pushes after the owner's tap (Decision 17) | built, not yet run live |

## Decision 1. The autopilot dispatcher

A deterministic node process, `minions work dispatch` (hidden; `minions work autopilot status` shows it), runs the
stage loop the coordinator runs by hand today:

```
loop:
  report = scheduler.next()                     # same checks as `work next`
  for each runnable stage within limits:
    claim it (claimWithBrief)                   # same checks as `work claim`
    spawn a headless worker for the lease
  on worker exit:
    record (recordSubmitted)                    # same checks as `work record --submitted`
    decision = recordDecision(...)              # src/runtime/advance.ts
    decision != null -> hand it to the coordinator (inbox / outbox `decision` item), do not retry blindly
```

- **Everything goes through the existing functions.** Claim, brief, record, the stage machine, QA insertion, repair
  cycles, CI gates, publication and local integration stay in `Scheduler`; the dispatcher only replaces the
  coordinator's turns between them. `recordDecision` (src/runtime/advance.ts) says exactly when a human-level judgement
  is needed; those are the coordinator's exceptions.
- **One correction.** An `invalid` result with `correctionAllowed` gets one automatic correction run (the same lease,
  a resumed worker with the errors) before it becomes an exception, as the coordinator does today.
- **Headless workers.** A stage runs as `claude -p --plugin-dir <fresh plugin> --agent minions:<role>` in the lease
  worktree, in a fresh `CLAUDE_CONFIG_DIR` with the task-96 headless credential (src/runtime/headless.ts), no
  channel (`--strict-mcp-config`), stream-json output for usage, and `--max-turns` from the role. The prompt is the
  lease marker plus `worktree:` line, exactly what the coordinator sends today.
- **Live roles.** The plugin is generated from the *current* effective config for each spawn (into the run dir), so
  a role, prompt, model or tool change takes effect on the next stage. No coordinator restart.
- **Guards without `agent_id`.** A headless worker is its own main thread, so hook inputs have no `agent_id`. The
  dispatcher sets `MINIONS_WORKER_LEASE=<leaseId>` and `MINIONS_WORKER_ROLE=<role>` in the worker env; hooks treat
  either `agent_id` or `MINIONS_WORKER_LEASE` as "a worker" (pre-bash, pre-file, drain, Telegram). The pre-filter
  shell snippets test the variable as well, so a headless worker never takes the fast "coordinator" path.
- **Process model.** Each worker is supervised by the same code as process harnesses and sessions
  (runner/supervise.ts: own process group, wall-clock timeout, SIGINT/TERM/KILL). A run record per lease
  (`<state>/run/dispatch/<leaseId>.json`) lets a restarted dispatcher reap orphans and recover leases.
- **Lock and start.** Meta row `dispatcher_lock` (same liveness rules as the supervisor lock). The coordinator
  wrapper always starts it (and restarts it when the lock is stale; Decision 10).
- **Capacity.** `execution.maxActiveTasks`, `execution.maxByRole`, the budget, pause and drain are honoured because
  they are checked by `next` and `claim`.
- **Exceptions.** A decision is stored as an outbox `decision` item (session = the task's session when sessions are
  on, else the coordinator) and as a `dispatch-decision` event, so the coordinator's next turn sees it in
  `minions status`. The dispatcher never starts work on a task that has an unhandled decision; the coordinator
  clears it by acting (`backlog update`, ...) or with `minions work autopilot resume <taskId>`.

## Decision 2. Flows (workflows) as coordinator-owned config

Workflows exist (roles-and-workflows.md D5): named stage lists, per-task `--workflow`, a `default`. What changes:

- **The coordinator edits them itself, live** (Decision 3): `minions control set workflows.docs '["engineer","reviewer"]'`
  or `minions control set workflows.default '["engineer","reviewer"]'`. The scheduler already re-reads workflows per
  command; with the dispatcher's fresh plugin per spawn nothing else needs a restart.
- **Explicit end stages.** A flow may end with `ci` and/or `merge`:
  - `ci`: the stage before it may complete only with green required checks (today `verification.ciAuthority`), and
    the delivery waits for CI.
  - `merge`: the flow lands the work (local integration or PR auto-merge per `delivery.*`). A flow without `merge`
    stops at `delivered` (the owner or the coordinator merges).
  These are pseudo-stages: they run no worker, they select the existing delivery behaviour per task. A flow without
  either keeps today's behaviour (delivery from `delivery.*`).
- **Invariants stay, but are config.** The "gate after the last committing stage" and "QA tester inserted for risky
  changes" rules are on by default and can be turned off by the coordinator (`verification.reviewerRequired`,
  `verification.qaInsertion`), because the owner asked for full control.

## Decision 3. The control layer

A new config layer, **control**, owned by the coordinator:

```
mode defaults < project < local (host) < control (coordinator) < session
```

- **Storage:** `<state>/control/overlay.json` (a partial config, deep-merged; `unset` removes a key from it) plus a journal
  `<state>/control/journal.jsonl` (one line per change: revision, time, actor, reason, key, before, after).
- **Commands (runtime and host):**
  - `minions control show [--json]`: the overlay, its revision, and the effective value of every changed key.
  - `minions control set <key> <json-value> --reason <text>`: any config key (dot path; arrays and objects as JSON).
  - `minions control unset <key> --reason <text>`.
  - `minions control apply --file <f> --reason <text>`: a partial config, merged at once (roles plus workflows in one
    change).
  - `minions control log [--limit n]` and `minions control undo [<revision>]`.
- **Validation:** the merged config is validated by the same schema (`validateConfig`) before the write; an invalid
  change is refused with the field named. Writes are atomic and serialized by a lock file.
- **Effect:** the runtime merges the overlay on every config load (each CLI command is its own process), so `live`
  settings apply on the next command. The dispatcher re-reads it each pass and builds a scheduler on that config.
  The host does not bake the overlay into `runtime/config.json` (an `unset` or `undo` would then not revert), so
  coordinator-launch settings set here apply only where the runtime renders them.
  Restart-class settings (coordinator prompt, launch args, container mounts) are applied by the host the next time it
  resolves the config; `control set` says so in its response (`appliesOn: "next-command" | "next-stage" |
  "coordinator-restart" | "container-recreate"`) from setting-classes.ts.
- **No owner confirmation.** Every change is applied at once and journaled; a change to a `host-owned` key (policy,
  capabilities, delivery, sandbox, permissions) queues an outbox `notice` so the owner sees it in the digest. Undo is
  one command.
- **Roles (worker profiles)** are config like any other key: `minions control set roles.researcher '{...}'` with an
  inline `promptText`. The `config roles propose/apply` flow stays for the host but is no longer needed.

## Decision 4. Owner secrets and the coordinator's env (revised 2026-10-31, owner)

The first build let the coordinator store secrets itself. The owner wants secrets to be theirs only, with plain
variables the agents may change kept apart:

- **Secrets are set only on the host** (`minions secrets set <NAME> [--role <r>]...`, value from a hidden prompt or
  `--stdin`; `grant` / `revoke` / `remove`). The value goes into `<project>/secrets/env/<NAME>` (the host-provisioned
  secrets dir, mounted read-only into the container); a value-free manifest `<project>/runtime/secrets.json` holds the
  grants. The coordinator lists names and grants (`minions secrets list`) and asks the owner for what it needs.
- **A grant names worker roles**, not tasks: the dispatcher puts a secret into the env of each worker of a granted role
  and of no one else. A granted secret without a value refuses the launch.
- **Who can read a value.** Host runtime: the sandbox denies the secrets dir to every agent's Bash and the permission
  rules deny it to the file tools; only the unsandboxed dispatcher reads it. Docker: the file tools are denied, but the
  coordinator and workers share one uid, so a Bash read is not blocked (as for the other mounted tokens). In both, the
  worker that receives a secret can read it: that is what it is for. A broker (a git credential helper, an auth proxy)
  would keep a credential out of the worker's env; not built.
- **A grant trusts the role.** The coordinator owns role prompts (Decision 3), so it can change what a granted role does
  with the secret. Grant to roles whose use of it you accept.
- **`env`** (config, live, coordinator-owned through `control`): plain variables of the dispatcher's claude workers,
  visible in config and the journal. Names that minions sets or that change what programs run (`NODE_OPTIONS`,
  `GIT_*`, `LD_*`, `PATH`, proxies, ...) are refused, because the workers' unsandboxed hooks inherit the env. Owner
  secrets win over `env`; minions' own variables win over both. Process-harness workers get neither yet.

## Decision 5. Telegram threads and polls

Built on the minions channel server (src/telegram/channel, task-67), which the host runtime already uses.

- **Reply context.** Inbound notifications carry `reply_to_message_id`, `reply_to_text` and `quote` (built). The
  router forwards them to the session (`coordinator send --reply-to-text`), and sessions see them in the inbox
  message header.
- **Threaded replies.** The coordinator's `reply` defaults `reply_to` to the message it is answering (the last
  inbound message of the thread) when none is given.
- **Native polls** (reverses telegram-decisions.md D2 "buttons over polls" at the owner's request): a `poll` tool
  `{question, options[2..10], multiple?, reply_to?}` sends a non-anonymous `sendPoll` and returns `poll_id` and
  `message_id`. The server polls `poll_answer` updates; an answer from the owner becomes a channel notification
  `"[poll answer] <question>: <option text(s)>"` with meta `poll_id`, `option_ids`, `reply_to_message_id` = the
  poll message. `close_poll {poll_id}` stops it. Polls are stored in the channel message map so the answer reaches
  the session that asked (Decision 6).

## Decision 6. Thread sessions

- A **thread** is a reply chain: its id is the message id of its root. A message that replies to a message of a
  known thread joins that thread; a top-level message (no reply) starts a **new thread**.
- With `coordinator.sessions.enabled`, each thread gets its own session `thread:<rootId>`; a new thread gets a new
  session. Task sessions stay (`task:<id>`); a thread that creates or discusses a task keeps talking to the owner,
  and the task's decisions are posted as replies into the thread that created the task.
- Thread sessions close after `coordinator.sessions.threadIdleMinutes` (default 240) without traffic; a later reply
  into the thread reopens it with its handoff note.
- **On by default with Telegram** (owner, 2026-10-31): storing a bot token (`minions auth telegram`, the init and
  setup steps) sets `coordinator.sessions.enabled: true` in the project config unless the owner set it. Terminal-only
  projects keep the single coordinator.

## Decision 7. The gateway: no router model (owner, 2026-10-31)

A resident router model collects every message and gets messy. With coordinator sessions on and Telegram, the wrapper
runs `minions telegram gateway` instead of a router claude (the router claude, its prompt and skill are gone):

- **Inbound, deterministic first:** a reply goes to the session of the message it replies to (tg_messages), a poll
  vote to the asking session (and answers its question), a named task to its task session.
- **A new top-level message gets a fresh thread session.** Its first step is the sessions index: when the message
  continues an open session, `minions coordinator handover <key>` moves the message, the thread's Telegram messages and
  its pending items there and closes the new session; otherwise it sets its topic (`coordinator topic`) and answers.
  An ambiguous message (a reply to a message of several sessions, several tasks named) is handled the same way, with
  the candidates named.
- **The sessions index** `<state>/sessions/index.md` (and `minions coordinator sessions`, `/sessions` in the chat):
  every open session and those closed in the last day, with topic, last activity and first owner message.
- **Outbound without a model:** the gateway sends each due outbox item as a reply in its session's thread, a question
  with options as a poll, and the due digest; it acks and records each in tg_messages. A failed send stops the round
  (the item's retry backoff applies).
- The tmux window shows the gateway's log; the owner talks through Telegram. Sessions on without Telegram run the
  single coordinator.
- **One Telegram setup for both runtimes** (owner, 2026-10-31): Docker uses the minions channel server too (`minions`
  on PATH in the container, the token from the mounted file); the official plugin, its install, probe and user-scope
  handling are gone. Pairing is `minions telegram access pair <code>` on the host in both runtimes.

## Decision 8. Local only (owner, 2026-10-31)

minions supports only local development: talking to a remote and to GitHub is a separate concern it does not handle.
Approved work lands on the local base branch through the local integrator (`delivery.merge: auto-when-eligible`) or
the coordinator's own merge; the owner exports branches with `minions export` and pushes them. Removed: branch and
pull-request delivery, PR auto-merge, CI awareness and the CI gate, GitHub intake, the pre-claim base sync from origin,
the GitHub token, credential helper and gh wrapper, the guided GitHub setup, the capabilities `git.push`, `pr.create`,
`pr.review` and `pr.merge`, and the upgrade's origin mode. Host-signed approvals stay for the local integration (scope
`merge` only). Configs that still carry the removed keys load: the keys are dropped, and an `auto-when-eligible` that
came with branch or pull-request delivery becomes `disabled`.

## Decision 9. Removed the host manager, change requests and the setup assistant (owner, 2026-10-31)

The coordinator talks to the owner through the minions Telegram channel and owns the configuration through the control
layer, so the host manager bot (with its assistant, service and tokens), config change requests, the config history,
role proposals (`minions config roles`), the setup assistant (`minions setup assist`) and the interactive settings menu
are gone. Merge approvals are signed in the host terminal (`minions work approve`). One request kind stays: `upgrade`
(`minions upgrade --reason` in the runtime, `settings requests` and the hidden `settings requests mark`), which the
self-update script reads and marks. `settings set` and `settings restart` are host-only; a `coordinator-restart` key
applies at the coordinator's next context reset. Old databases keep their `change_requests` and `role_proposals`
tables; rows of the removed kinds are never listed. A manager service installed earlier (launchd agent or systemd
user unit running `minions manager run`) and the stored manager tokens are left in place: remove them by hand.

## Decision 10. The autopilot is the only dispatch path (owner, 2026-10-31)

After the live check of phase 1, the dispatcher runs every stage, always; the wrapper always starts it. The coordinator
plans, files and updates tasks, tunes the config (`minions control`) and handles held decisions
(`minions work autopilot status|resume`); it never claims, spawns, records or releases a worker, and the pre-agent
hook denies every `minions:*` Agent call. Removed: `dispatch.mode` (an old config's value is dropped), `work advance`,
the coordinator's dispatch flow in its prompt and skills, the Stop guard's push to dispatch runnable work (only holds
keep the coordinator or a task session going), the context-reset barrier (`coordinator.contextReset.barrierTokens`,
dropped as well), task sessions opened or nudged for runnable stages (a task session is opened for a hold or an owner
message about its task), and the routine's runnable, unvalidated, split and awaiting-human wake reasons (each of those
is a hold now). `work claim|record|release` stay as primitives; the recover skill uses the last two for leases left
from before this decision. Process-harness roles run through the dispatcher's `minions work run`, as before.

## Decision 11. Two modes (owner, 2026-10-31)

The owner runs `minions init`, picks a mode and works; nothing else is set up per project. The three init profiles
differed in details nobody tuned, and the only real question was who merges: the agents or the owner. So there are two
modes, `independent` and `supervised`, and the mode is a required choice (no default, never from `defaults.json`):
`--mode` or the first wizard question, and a non-interactive init without it fails.

- **independent**: the team runs the project. Docker, Telegram with thread sessions, the routine with a 09:00 digest,
  local integration, `architecture: decide`, budgets ($20 a day, $5 a task). Policy allows everything except deploying;
  a short list of truly dangerous paths (agent and minions configuration, `CLAUDE.md`/`AGENTS.md`, git hooks, CI
  workflows) still needs the owner's signed approval before landing.
- **supervised**: the owner reviews and merges all code, so `base.merge` is the only extra deny and the agents may
  experiment; the prompt asks them to raise hard-to-review changes (dependencies, migrations, CI, broad refactors) and
  anything unclear with the owner. Host runtime, terminal, one coordinator, `architecture: propose`, no budget.

`minions mode set` rewrites the keys a mode decides in the project config; `config.local.json` stays, being the owner's
own layer. Answers that are the same for every project (Claude auth, the git identity of agent commits, the owner's
Telegram id, which pre-allowlists a new bot) live in `minions defaults`, so init asks none of them. The mode only
chooses the runtime of a new project; an installed project keeps its runtime. `external.*` capabilities existed only
for the removed GitHub intake (Decision 8) and are dropped from old configs, like `profile`, which becomes `mode`
(project-owner: independent; personal-work and supervised: supervised). Setup no longer asks about local integration
and init no longer asks about visibility, intake, the channel, verification or container resources: the mode and
discovery decide, and `minions settings set` changes them.

## Decision 12. Verify before review; two test tiers (owner, 2026-10-31)

Owner: unit tests are cheap and fast, catch edge cases and general functionality, and run before merges; integration
tests run on the base once in a while (and rarely on a branch with heavy changes) and should fail rarely and
meaningfully. Tasks need no tester: the engineer writes the tests, the code is verified, and the reviewer does not rerun
them.

- **Default flow: engineer → reviewer.** Risk-based testing is gone (`verification.testerRequired`, `qaLabels`, the
  reviewer's `needsQa`, the QA insertion and `{ "when": "qa" }` stages; old configs load with them dropped). The tester
  role stays for QA sweeps and explicit flows: removing it would cost more (statuses, sweeps, legacy `testing` tasks)
  than it saves.
- **Verify step.** A gate stage starts only on a head whose `verification.commands` (the fast tier) passed. The
  dispatcher runs them deterministically in its own worktree with the integrator's runner (setup caching, allowlisted
  env, per-command timeout, logs), one run at a time, before it claims the gate. Red: a counted repair cycle with the
  failing command and output tail as the engineer's finding. Timeout, exit 127 or a setup failure: blocked with a setup
  hint, as in the integrator. Green: `verify` evidence with the head's tree. Checked at the gate rather than at the
  producer's record, so a restart, a legacy task or a re-review can never skip it.
- **The integrator does not repeat it** when the merged tree is the verified tree (the base did not move); otherwise it
  verifies the merged tree as before.
- **Slow tier: `verification.periodic`** (`commands`, `everyHours`, default 24), run by the dispatcher (it has the
  clock and the verify slot) on the base head when due and the base moved since the last run. A failure files one
  `verify:periodic` task and a notice; none while one is still open. A task labelled `verify:full` runs the periodic
  commands in its verify step too, for heavy changes; the coordinator uses it sparingly.
- **No unverified landings.** With `delivery.merge` "auto-when-eligible" and no `verification.commands`, integration
  stays on and the integrator refuses every landing (the task is blocked with the hint), instead of approvals quietly
  ending `delivered`. The coordinator's first task in such a project is to set up the fast checks, and the slow ones
  as `verification.periodic`.

## Decision 13. Budget from Telegram, extra terminal sessions, `minions pull` (owner, 2026-10-31)

- **`/budget` is the gateway's, never a coordinator's.** A coordinator that reads the command could raise its own cap,
  so the gateway answers it without a model and only the paired owner (access.json) may change a cap. The change goes
  to the control overlay as the owner's: journaled with undo, and live because the dispatcher re-reads the config every
  pass, which a write to the host-owned project config would not be without a host round trip. The control layer
  refuses `budgets.*` from the coordinator (set, apply, or an undo that would touch them), so the overlay being
  coordinator-writable does not reopen the hole. `budgets.*` stop being prompt text: they refuse claims against the
  USD estimate, with API-key billing only (a subscription has no USD figure; they are shown, not enforced; Decision 15
  adds token caps enforced on any billing). The per-task cap counts the task's workers; the daily cap counts everything
  since the UTC day start (local midnight in routine.timezone since Decision 15). A cap that stops
  work queues one owner notice per cap value (per UTC day for the daily cap), since a silent wait looks like a hang.
  The verify step still runs for stages a cap holds back: it spends no tokens, and the stage is ready when the owner
  raises the cap. A claim-time check cannot stop a stage already running, so one stage can overshoot the cap.
- **`minions session new` runs outside the wrapper.** The wrapper owns the coordinator lock, the launch record,
  Telegram and the helpers; a second interactive coordinator needs none of them and must not take them over. It is its
  own tmux session on the runtime's server, not a window of `coordinator`: windows of one tmux session share the
  current window across attached clients, so two terminals would switch each other. `session:<name>` is a scope with
  no DB row, so it claims nothing and leaves notifications and topics to the primary coordinator.
- **`minions pull` replaces `minions export`** (kept as `pull --no-ff-main`). Task refs come from the runtime (latest
  lease branch, backlog status delivered or done) because a branch slug does not encode the task id reliably. The base
  only moves by `merge --ff-only` in a checkout that has it checked out and no tracked changes; everything else is
  reported, since moving a branch the user is not on, or a dirty tree, is the user's call. Untracked files (a shared
  install's own `.minions/`) do not block, as they do not block git, unless the incoming range adds a path one of them
  occupies: then nothing moves and the path is named.

## Decision 14. Tools in the container (owner, 2026-10-31)

Agents add the toolchains a project needs (Rust, Go, Python via uv) without the owner. Docker runtime only: the host
runtime already uses the owner's machine.

- **The container is the boundary, so an agent-installed tool adds no power.** It runs as the same unprivileged user,
  under the same caps, network and mounts as everything the agents already run. Installing it needs no root and no
  new escape hatch.
- **A persistent tools volume at `/opt/tools`**, per project like the other volumes, kept across restarts and upgrades
  so a toolchain is installed once. The image presets the toolchain homes under it and puts its bin dirs on PATH
  **after** the system dirs, so a tool there never shadows `git` or `minions`. Workers inherit these variables, the
  `env` map cannot override them, and the verify step and the integrator pass them on (their HOME stays fresh), so a
  check that needs the tool finds it.
- **Persistence is the risk** (a broken or tampered toolchain outlives the task that installed it): the owner wipes it
  with `minions tools reset`, and the next start mounts the image's empty layout.
- **System packages go through `container.aptPackages`**, coordinator-editable through `control`: a derived image (one
  apt layer as root on the base) whose tag hashes the list, so a change rebuilds and recreates. `minions upgrade`
  applies it after draining the workers, and so does `minions start` of a stopped container; `minions start` never
  recreates a running container for it (that would cut off its workers) and says the rebuild is pending, as
  `minions status` does. The overlay lives in the state volume, so the host reads that one key from it and validates it
  as package names before it reaches a build. Apt maintainer scripts run as root only at build time, never in the
  running container.
- **No Dockerfile escape hatch for now.** Package names cover what toolchains need without letting config run
  arbitrary build steps as root.

## Decision 15. Token caps, enforced on any billing (owner, 2026-11-13)

On a Claude subscription the USD caps of Decision 13 are shown, not enforced, so an unattended team had no real stop.

- **`budgets.dailyTokens` and `budgets.taskTokens`**, optional whole token counts next to the USD caps, off when
  unset or null. No mode sets them (`minions mode set` rewrites only the USD caps), so a mode change keeps the owner's.
  The owner sets them with `minions settings set budgets.<key> <n|off>` or `/budget day|task <n>M|<n>k|<n> tokens`
  (`/budget ... off` clears both caps of that kind); the coordinator never can (Decision 13's owner-only keys).
- **Token caps are enforced whatever the billing**: tokens are what minions records for every agent, and the plan
  quota they stand for is not visible. USD caps stay enforced with API-key billing only. With API-key billing both
  apply and the first reached stops work.
- **What counts.** The daily caps count everything recorded (coordinator sessions and workers): the coordinator's own
  turns spend the same quota. The per-task caps count the task's workers over all its attempts, as before: the
  coordinator's share is not attributable to one task.
- **The day starts at local midnight in `routine.timezone`** (the digest's zone, default Europe/Berlin), for the USD
  daily cap too: one cap day, matching the owner's day. This replaces Decision 13's UTC day.
- **Same enforcement points as the USD caps**: the claim (and `work run`) refuses a stage, `work next` lists a capped
  task's stages as `waitingOn: budget` and reports a reached daily cap as `startsBlocked`, and the routine's
  `budgetExhausted` gate counts a reached daily cap (only the digest wakes the coordinator then). Running workers are
  never stopped, so one stage can overshoot.
- **A task at its per-task cap is held for the coordinator** (dispatcher hold `budget-cap`, once per cap value, with
  the owner notice): it decides whether to block, split or narrow the task, or to ask the owner for a higher cap,
  rather than the task sitting silently. Resuming the hold does not lift the cap; the hold clears itself once no cap
  stops the task. Verification still runs for it.
- **Warnings**: besides the notice at the cap, the dispatcher queues one owner `status` notice at 50% and at 80% of an
  enforced daily cap (per threshold, cap value and day). No per-task warnings: the hold at the cap is the decision point.
- `minions status` shows the token caps next to the USD display and says `enforced`.

## Decision 16. Standing goals, planning wakes, experiments and retrospectives (owner request, 2026-11-13)

The team was reactive: with the backlog empty the routine found "nothing needs a model" and the project sat idle until
the owner wrote. The owner wants it to pursue standing, measurable objectives on its own, measure what it changes, and
learn from how the work went.

- **Goals file.** `goals.md` next to the project config, where role prompt files live: `.minions/goals.md` in a shared
  install, `<project dir>/goals.md` in a private one. One `## <title>` heading per goal (its id is the title's slug),
  free text, and optional `Status: open|done|paused` and `Measure: <how it is measured>` (or `Metric:`, `Target:`)
  lines; text before the first heading is an introduction. Parsing is tolerant: synonyms (`on hold`, `met`, ...) are
  understood, an unknown status reads as open, nothing is an error; at most 50 goals and 64 KB are read.
- **The runtime sees only the owner's copy.** The host copies the file into the runtime config dir (`runtime/goals.md`,
  `/opt/minions/config/goals.md`, read-only) whenever it regenerates the derived files: `minions start`, `upgrade`,
  `settings set`. A worker branch that edits `.minions/goals.md` changes nothing (the same rule as role prompts); a
  removed file removes the copy.
- **The coordinator's marks** live in `<state>/goals.json`, written by `minions backlog goals set <id> <status>` and
  `minions backlog goals record idle|retro` (folded into `backlog`; workers are refused). A mark applies while the goal's
  own status line is what it was when the mark was made, so an owner edit of that line wins. The coordinator tells the
  owner when it marks a goal done, so the file catches up.
- **The plan reason.** The routine pass adds a `plan` wake reason when the routine is on, `routine.planWhenIdle`
  holds, the coordinator runs, no decision is held (holds come first), no task is `ready` or in flight (`ready`, a
  stage status, `awaiting-ci`, `merging`; `idea`, `blocked` and `awaiting-human` do not count), intake is open, a goal
  is open, and planning has not recorded that nothing worthwhile is left for the goals as they are (the record holds a
  hash of the file and the effective statuses, so a goal edit or mark lifts it). Every wake gate still applies (budget,
  paused starts, drain, leases, owner active, idle, wake gap, daily cap, so a plan wake counts as a wake), plus its own
  `routine.maxPlanWakesPerDay` (default 4) and `routine.minPlanGapMinutes` (default 120). A due digest takes the plan
  along only within those limits.
- **How it wakes.** Sessions off: the usual restart with the constant `/minions:orchestrate wake` prompt; the woken
  session reads `plan` among `sync --routine --last` reasons, so the restart path, its refusals and the wake turn
  accounting stay as they are. Sessions on (the router runs the gateway, which a restart would not help): the runtime
  opens the `general` session and queues `/minions:orchestrate plan` (`PLAN_PROMPT`) to it, unless it already has
  messages waiting. Both are recorded as `routine-wake` and `routine-plan-wake` events.
- **Defaults by mode.** `planWhenIdle` is derived from the mode when unset (independent on, supervised off), so an
  installed independent project with the routine on plans after the upgrade with no config change; it is host-owned
  (model spend without the owner), the caps are not. `minions settings` lists the three keys.
- **The plan procedure** (orchestrate skill, step 4): read the goals and recent outcomes (done task notes, experiment
  records, decisions); mark goals whose measure is met; run a due retrospective; file the next 1-3 tasks toward open
  goals, promoting fitting `idea` tasks before inventing new ones (label `goal:<id>`, key `plan:<goal>:<slug>`,
  provenance `agent-hypothesis`): `ready` in independent mode with direct starts, otherwise `idea` plus one question for
  the digest; or record `idle` with the reason and say so in the digest. One pass, never filler work.
- **Experiments** (prompt level, no new role): a task labelled `experiment` states a hypothesis, the measurement
  (command, environment, base against branch, runs), the acceptance threshold and a numbered record file in a records
  directory the coordinator chooses once per project and records as a decision (the chess bot already keeps
  `docs/efficiency/NNN-*.md`). The engineer implements behind a toggle or on the branch, measures (a baseline on the
  base is part of such a task), writes the record and, when the threshold is missed, reverts the change so only the
  record lands; the reviewer checks that the verdict follows from the numbers. Goals with a `Measure:` are pursued this
  way.
- **Retrospective.** Due after 10 tasks reached `done` since the last one, or a goal marked done since
  (`retro.due` in `backlog goals`): a cheap count the coordinator reads in its plan pass. It looks at repair cycles,
  per-task budget overruns, flaky or slow checks and cancelled work, files project improvements as `idea` tasks, puts
  minions' own problems in the digest for the owner, schedules a QA sweep when none ran, and sets
  `verification.periodic` through `control` when a slow tier exists without it.
- **Left out:** a per-goal progress metric the runtime parses (measures stay text the coordinator reads), the
  coordinator editing the goals file, a separate planner role or session key, and a time-based retrospective.

## Decision 17. Telegram-approved publishing (owner, 2026-11-14)

Decision 8 made minions local only: approved work lands on the local base and the owner pushes it by hand
(`minions pull && git push`). The owner pushed every batch the same way, so the team now **proposes** a publish and
the owner approves it with one tap in Telegram. The agents still never push and never hold a push credential: a
trusted host process does the push, out of every agent's reach.

- **The coordinator proposes, never pushes.** `minions settings requests publish --summary <text> [--task <id>]...
  [--sha <sha>]` in the runtime records a `publish` change request, a second kind next to `upgrade` (Decision 9): the
  base branch, one exact full SHA (default: the base head; a given SHA must be on the base), the summary (stored as
  the request's reason) and the task ids. A newer request expires the open one, as for upgrades. It is refused without
  a git remote (`remoteUrl` in the runtime's project.json): "Publishing is unavailable: this project has no git
  remote". The coordinator prompt (Delivery) says when: after a meaningful batch (a goal met, about five tasks `done`
  since the last request, or a fix the owner waits for), one open request at a time, never while draining, and not
  again right after "Not now"; supervised mode never proposes (the owner integrates and publishes). The batch size is
  prompt text, not a setting.
- **A trusted host process publishes.** The publisher: one process per machine (per minions home) serving every
  registered project (src/host/registry.ts), as a launchd user agent on macOS or a systemd user unit on Linux running
  the hidden `minions settings requests serve` (src/host/publisher-service.ts, adapted from the removed host manager's
  service: restarted on exit, exit 75 after a CLI reinstall, a per-home lock, a 0600 heartbeat). It reads each
  project's open requests the way the host reads upgrade requests (`settings requests --json` through the host
  runtime's shim or `docker exec`) every minute between long polls, and reports with `settings requests mark`:
  `confirmed` at the press, then `applied` (the detail says where it went) or `failed`; `rejected` for a refusal or
  "Not now".
- **Its own bot; the approval cannot be forged.** The publisher bot is separate from every coordinator bot: its token
  is host-wide (`PUBLISHER_CREDENTIAL`: Keychain, Secret Service, or `<MINIONS_HOME>/credentials/publisher/` 0600;
  the file store whenever a project uses the host runtime, and moved there when one starts to), referenced from
  `<MINIONS_HOME>/publisher/credential.json`, never from a project's credentials, secrets directory, env or mounts.
  `minions auth publisher` refuses a coordinator's bot and `minions auth telegram` refuses the publisher's. The
  message is "Publish N commits (tasks …) to <base> at <short sha>?" with [Publish] [Not now], then the project,
  remote, mode, full SHA, the newest subjects and the coordinator's summary quoted as its words. Commit count, base
  and SHA come from git on the host, never from the request. A press counts only from `telegram.owner` (`minions
  defaults`) in the owner's private chat; anything else gets no reply at all. The buttons carry only a random nonce
  that maps to the publisher's own record (`<MINIONS_HOME>/publisher/state.json`, 0600): project, request, base, the
  exact SHA, the mode shown. The push uses that record, never the request row again, and checks everything once more
  at the press. `/publish <project>` asks about the agents' current base without a request; `/publish` lists the
  projects. A prompt expires after seven days; a superseded request retires its prompt.
- **The push.** The agents' refs are exported into the owner's checkout exactly as `minions pull` does (exportRepo:
  refs/remotes/minions/*, never a local branch). The SHA must be on the agents' base and a fast-forward of
  `origin/<base>` fetched just before (a remote without the branch: the push creates it). The outgoing range is
  scanned: tracked-file names that usually hold secrets (the state backup's list), added lines shaped like private
  keys and API tokens, and files of 5 MiB or more. A finding refuses the publish and is reported to the owner and in
  the request by path and kind, never by value. Then `git push origin <sha>:refs/heads/<base>`: never forced, so a
  push that raced someone else's is refused by the remote. git runs with the host hardening (hooks and fsmonitor
  off: the commits are agent-authored) and no prompts. The owner's working tree is untouched except that a checkout
  on the base with no tracked changes is fast-forwarded (src/host/pull.ts rules; untracked files never block).
- **Pull-request mode.** `publish.mode: direct | pull-request` (default direct). pull-request pushes
  `minions/publish-<sha12>` and runs `gh pr create --base <base>` in the owner's checkout with the owner's `gh`
  login; the base and the checkout are left alone. `publish.*` (with `publish.deployKey`) is owner-only: `control`
  refuses it (Decision 13's list), and the host reads it from the project and local config, never from the overlay.
  The mode shown in the question is the mode used, even if the setting changes before the press.
- **Credentials.** The owner's own by default: the credential helper for HTTPS, the ssh-agent for SSH. A launchd agent
  gets the session's ssh-agent; a systemd user unit gets none unless the session provides one, so the install passes
  the installing shell's `SSH_AUTH_SOCK` when it is a stable socket (not a per-boot launchd or /tmp one). The service
  records whether it has an agent in its heartbeat, and doctor's `publish.auth` reports what the service sees, with
  the fix. Optional repo-scoped deploy key: `publish.deployKey <absolute path>` (`GIT_SSH_COMMAND` with `-i` and
  `IdentitiesOnly`); creating it and adding it to the repository is the owner's.
- **Setup and surface.** `minions setup` gains a `publish` step (with a remote: keep an installed publisher's service
  current, or offer it: the owner's Telegram id when defaults lack it, the token, the service; without a remote:
  skipped as unavailable). No new top-level command: requests already live under `settings requests` (the same
  lifecycle and the same host-to-runtime path as upgrade requests), so `settings requests publish` records one in
  the runtime and, on the host, publishes `<id>` after a terminal confirmation (the same checks; no flag skips the
  question); the token is `auth publisher`, next to the other host-held tokens; the service process is the hidden
  `settings requests serve`. Doctor adds `publish`, `publish.service`, `publish.auth` and `publish.last`, never a
  failure.
- **Why an agent can neither approve nor push.** (1) The token is readable only on the host: never mounted, never in a
  project's secrets or env, under the host runtime's sandbox read deny (the whole data root), and kept out of the
  Keychain while the host runtime is in use. Only the publisher polls the bot, so only it sees presses; a second
  poller gets 409 and is reported. (2) Telegram stamps the sender's account on every update; only the owner's id in
  the owner's private chat counts, and that id lives in `defaults.json` under the denied data root. (3) What is pushed
  is the publisher's own record behind the nonce, computed from git when it asked, re-checked at the press, and bound
  to the SHA and mode shown; the agent-writable request row can only ask, and changing it changes nothing already
  shown. (4) The push credential is the owner's, used only by the unsandboxed publisher with hooks off; the agents'
  sandbox has no Unix sockets (no ssh-agent), no read of `~/.ssh`, and no write outside its workspace and state. (5)
  The publisher's state is under the data root and its unit file in the user's LaunchAgents or systemd directory, both
  outside anything an agent can write, so an agent can neither plant a prompt nor change what the service runs.
- **Left out / limits.** The scan is pattern-based, not a full secret scanner; a false positive is published by hand.
  The publisher neither merges remote changes nor rebases: a diverged remote is the owner's to integrate. A request is
  read only while its runtime runs. Uninstalling the last project leaves the service (`minions auth publisher
  --remove`). One bot per machine: a second machine needs its own bot. A publish of agent changes to `.minions/`
  config or other sensitive paths is approved like any other range (those paths still need the signed merge approval
  before they land on the base, Decision 11), and the checkout fast-forward then brings them into the owner's tree.

## Reversed decisions

- telegram-decisions.md D2 (tap buttons instead of native polls): native polls are built at the owner's request.
- roles-and-workflows.md D2 (roles only via owner-applied proposals) and host-manager.md Decision 4 (container
  requests need owner confirmation): the control layer applies coordinator changes directly.
- coordinator-sessions.md (thread sessions deferred, TG 264): built as phase 5.
- coordinator-sessions.md phase 10 / unattended-delivery.md item 7 (dispatcher waits for a spike): built as phase 1.
- bootstrap.md (GitHub delivery, "origin/<base> as the single source of truth", CI-gated auto-merge, GitHub in the
  container) and unattended-delivery.md (PR and CI sync, GitHub intake in the routine pass): removed by Decision 8.
- Risk-based testing (per-task tester on QA labels, sensitive paths or a reviewer's `needsQa`; README Testing):
  replaced by Decision 12.
- coordinator-sessions.md phase 7 (task sessions dispatch their stages) and the reset barrier, and unattended-delivery.md
  item 6 (`work advance`) and the routine's runnable wakes: removed by Decision 10.
- spec.md and bootstrap.md (three init profiles, the full init wizard, setup's opt-in local integration question):
  replaced by Decision 11.
- Decision 8 (local only: the owner exports and pushes every batch by hand): partly reversed by Decision 17. A host
  process pushes the base (or opens a pull request) after the owner's one-tap Telegram approval. The agents still never
  push or hold a push credential, and the rest of Decision 8 stands (no CI awareness or CI gate, no GitHub intake, no
  `git.push` / `pr.*` capabilities, no pre-claim sync from origin).

## Known limits (review of the build, 2026-10-31)

- **Secrets in Docker.** Workers run as the same user as the coordinator: a worker's env is readable through
  `/proc/<pid>/environ`, and the secrets dir through a Bash path the guard cannot see. On the host runtime the
  sandbox is the boundary for the files; whether sandboxed Bash can read a running worker's env (`ps eww <pid>`, same
  uid) is not verified. A per-worker uid or a secret broker would close both.
- **Secret values are not masked** in worker results or in the coordinator's view of them (the process runner masks
  its own). The worker log and config dir are removed when the lease ends.
- **Process-harness roles** do not receive owner secrets or `env` yet; a launch of a role with a grant is refused.
- **`control undo`** restores the overlay snapshot from before a revision: later changes are reverted too, and the
  response lists every key it changes.
- **`ci` marker**: landing already waits for CI where minions knows CI (PR required checks; the local integration
  gate's verification commands), so the marker documents the flow and selects nothing extra yet.
