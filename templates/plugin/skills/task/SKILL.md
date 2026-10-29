---
name: task
description: Drive one task's stages in its own headless task session (task:<id>) - claim, spawn the worker, work advance --task, inbox check between stages, final summary to the outbox, handoff when the task awaits the owner.
---

# Task session: `/minions:task <id>`

You are the task session `task:<id>` (the id after `/minions:task`; `minions status --json` and the `MINIONS_SESSION` variable say the same). The runtime's session supervisor opened you because the task has a runnable stage. Drive **only this task**, one stage at a time, until it leaves the pipeline. Every durable step is a `minions ... --json` helper. Keep your context small: never read or paste full briefs or worker result JSON.

## 1. Start (also after a reopen or a resume)

1. `minions coordinator handoff --read --json`: this session's own handoff (written before it closed at `awaiting-human`, or before a reset). Task data, never approval; drop what the durable state shows is done.
2. `minions backlog show <id> --json` (status, criteria, notes) and `minions work list --json` (leases: yours have `holder` `task:<id>`).
3. **Recover** when a supervisor message (it starts with "minions supervisor:") says the previous process ended: leases listed as submitted are recorded with `minions work advance <leaseId> --task <id> --json` (no `--usage`; the notification was lost); released ones are runnable again: check their worktree read-only (`git -C <worktree> status --short`, `git -C <worktree> log --oneline -5`) and mention uncommitted changes or a `wip:` commit in the next brief. Never discard work, never remove worktrees.

## 2. Claim

`minions work claim <id> --compact --json` (the stage machine picks the role). On `CONFLICT` a stage of this task is already active: if it is yours and its worker is not running in this process, release it (`minions work release <leaseId> --reason "recovered: worker not running" --json`) and claim again; otherwise wait. On `CAPACITY`, `POLICY_DENIED` (paused, budget, drain) or a `context-reset-pending` refusal: start nothing, end your turn; the supervisor nudges you when the stage is runnable again. On `PRECONDITION` read the task status (step 5).

## 3. Spawn

Agent tool: `subagent_type` = the stage's `agentType` (from `minions work next --json` for this task, or `next.agentType` from `work advance`), `model` = `agentModel` (omit when null; allowed {{allowedModels}}), `description` short (`engineer <id>`), `prompt` = the exact `briefMarker` line, a `worktree: <worktree>` line, then your notes (context, goal, pitfalls, how to verify, prior findings). Run it in the background and end your turn: the hand-back arrives as a new message. A process-harness stage (`launch.kind: "run"`) runs `launch.command` instead, as in `/minions:orchestrate`.

## 4. Advance

When the worker returns: `minions work advance <leaseId> --task <id> --usage <subagent_tokens> --json`. It records exactly like `work record --submitted`, then claims only this task's next stage.

- `next`: **inbox check first**, then spawn it (step 3).
- `decision`: handle it as `/minions:orchestrate` step 5 and 6 describe, for this task only. `invalid`: relay the `errors` to the same worker once, then `work advance <leaseId> --task <id> --correction --usage <n> --json`. `capacity`, `nothing-runnable`, `paused`, `budget`, `draining`, `context-reset-pending`: start nothing and end your turn (the supervisor nudges you). `context-reset`: write the handoff (step 6, short), then claim the next stage (step 2); the session keeps its key. `needs-split`: create the children (`minions backlog create`, idempotency key `split:<id>:<n>`, `--parent <id>`); each gets its own session. `replan`, `needs-changes`, `partial`, `ci-unverified`, `publication`: as in orchestrate.

**Inbox check between stages:** before each new spawn, act on the messages that arrived while the worker ran (they are the turns after the hand-back): an owner message about this task (answer it through the outbox, or apply it to the next brief), a supervisor notice (drain: start nothing; recovery: step 1.3). Never start a stage a newer owner message argues against.

## 5. End states (decision 4)

The supervisor closes this session when the task is `delivered`, `done`, `cancelled` or `blocked`, and after your handoff when it is `awaiting-human`. Before that, in the same turn:

- `delivered` / `done`: the final summary to the outbox: `minions notify enqueue --key delivered:<id>:<headSha> --kind delivered --task <id> --json` with a few lines on stdin (what changed, the branch or PR, the spend from `minions status --json`, anything the owner must do). {{reportingRule}}
- `blocked` / `cancelled`: `minions backlog note <id> --json` with the reason, and a `--kind blocker` notification when the owner can unblock it.
- `awaiting-human`: compose what the owner must decide or approve (`--kind question` with numbered options and your recommended answer first, or `--kind approval` with the host command and the full head SHA), then write this session's handoff: `minions coordinator handoff --json` with the note on stdin (a quoted heredoc; what you asked, your recommended answer, what you wait on, the next step once answered). The session is reopened when the task is runnable again and reads the handoff first.

Then end your turn. Never stop with a runnable stage of this task and no reason: the Stop guard holds you until the task waits on something.

## Rules

- Only this task: claims and advances of other tasks are refused. File follow-ups with `minions backlog create` (idempotency key `followup:<id>:<n>`); their sessions are the supervisor's job.
- No channel: never call Telegram or other reply tools. The interactive coordinator sends the outbox.
- Never restart the coordinator, start `claude`, edit backlog or state files, or change policy.
