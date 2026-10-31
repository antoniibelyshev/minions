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

## Reversed decisions

- telegram-decisions.md D2 (tap buttons instead of native polls): native polls are built at the owner's request.
- roles-and-workflows.md D2 (roles only via owner-applied proposals) and host-manager.md Decision 4 (container
  requests need owner confirmation): the control layer applies coordinator changes directly.
- coordinator-sessions.md (thread sessions deferred, TG 264): built as phase 5.
- coordinator-sessions.md phase 10 / unattended-delivery.md item 7 (dispatcher waits for a spike): built as phase 1.
- bootstrap.md (GitHub delivery, "origin/<base> as the single source of truth", CI-gated auto-merge, GitHub in the
  container) and unattended-delivery.md (PR and CI sync, GitHub intake in the routine pass): removed by Decision 8.
- coordinator-sessions.md phase 7 (task sessions dispatch their stages) and the reset barrier, and unattended-delivery.md
  item 6 (`work advance`) and the routine's runnable wakes: removed by Decision 10.
- spec.md and bootstrap.md (three init profiles, the full init wizard, setup's opt-in local integration question):
  replaced by Decision 11.

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
