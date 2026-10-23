---
name: orchestrate
description: Dispatch loop for the minions coordinator - pick ready tasks, claim, spawn workers, record results, follow next steps.
---

# Orchestrate minions work

Run this loop until nothing is runnable. Every durable step uses a `minions ... --json` helper; never edit backlog or state files.

## 1. Check state

{{outboxCheck}}

1. `minions status --json`. If starts are paused, report that and stop. If `draining` is set (an upgrade is winding workers down), start nothing: only record the workers that return (step 5), report briefly and stop.
2. `minions work list --json` to see active leases. Count active tasks (limit {{maxActiveTasks}}) and engineers (limit {{maxEngineers}}).
3. `minions backlog ready --compact --json` for runnable tasks (`minions backlog list --compact --json` for the whole queue). Also note tasks in `testing`, `reviewing` or `changes-requested` without an active lease: they need the next stage.

If there is no ready or next-stage work, or capacity is full, report briefly and stop. Do not loop waiting for work. Start nothing new while the budget is used up or quota mode is on (see Owner defaults): record returning workers, report, and ask.

## 2. Choose

Prefer, in order: tasks waiting for their next stage (finish what is started), then higher priority, then tasks that unblock others. Skip tasks whose requirements are unclear: ask the user instead (with a recommended answer).

Role by status: `ready` or `changes-requested` → engineer; `testing` → tester; `reviewing` → reviewer. A `ready` task labelled `qa-sweep` → tester (QA sweep against `{{baseBranch}}`; see Testing in your coordinator instructions).

## 3. Claim

`minions work claim <taskId> --role <role> --compact --json`

- `CONFLICT`: another stage is active for that task; pick another task.
- `CAPACITY`: stop dispatching new work until a worker finishes.
- `POLICY_DENIED`: the task may not start (paused or not authorized). Report it; do not retry.
- `PRECONDITION`: the task status does not fit the role; re-read it with `minions backlog show <taskId> --json`.

The compact response has `leaseId`, `briefMarker`, `taskId`, `role`, `attempt`, `branch`, `worktree` and `expectedHead`. The full brief (description, criteria, prior findings, policy) is stored for the worker; do not fetch or paste it.

## 4. Spawn

Call the Agent tool:

- `subagent_type`: `minions:<role>`; for an engineer lease, `minions:engineer-deep` instead of `minions:engineer` for hard debugging, architecture work, or a retry after an engineer attempt failed (see below)
- `description`: short, e.g. `engineer task-12`
- `model` (optional): allowed {{allowedModels}}. {{modelGuidance}}
- `prompt`, nothing more than:

  ```
  minions-lease: <leaseId>
  worktree: <worktree>

  <coordinator notes: context, the goal, where to look, pitfalls, what to preserve, how to verify (with exact environment workarounds), prior findings to focus on, parallel work to avoid>
  ```

  Copy `briefMarker` exactly as the first line. The worker runs `minions work brief <leaseId> --role <role> --json` from its worktree (only the lease's own worker can). Keep notes focused: no full backlog, transcripts, or unrelated notes. Brief and staff as under Owner defaults.

Older CLI fallback: if `--compact`, `work brief` or `--submitted` is rejected as an unknown option or command, claim without `--compact` and paste the brief in a ```json fence after the marker and worktree lines; in step 5, record by piping the worker's final JSON to `minions work record <leaseId> --json` on stdin.

Independent tasks may run in parallel up to the limits. A task never has two workers at once.

## 5. Record

When a worker returns, it has submitted its result with `minions work submit` and ends with one line. Do not ask for or copy its JSON. Record:

`minions work record <leaseId> --submitted --json`

- No submission (`NOT_FOUND`, hint names `minions work submit`): if the worker's final message contains the JSON instead, pipe that to `minions work record <leaseId> --json` on stdin; otherwise ask the worker to submit (once), or release the lease.
- Invalid result (`valid: false`, `correctionAllowed: true`): send the worker only the listed `errors`, ask it to fix them and submit again, then `minions work record <leaseId> --submitted --correction --json`. If it is still invalid, it is stored unvalidated; decide yourself (usually re-dispatch or ask the user). Never treat it as approval. A `complete` tester or reviewer result with failing checks is rejected this way; for an engineer `complete` with failing checks, ask the same correction yourself. Either way, give one bounded correction: a concrete way to rerun the checks (exact command and environment, e.g. an exec-allowed `TMPDIR`), or a status that matches the failure.
- Worker ended with `brief unavailable: <error>` (no result): do not record it. Release the lease (`minions work release <leaseId> --reason "brief unavailable" --json`), claim again without `--compact`, and re-dispatch with the brief pasted in a ```json fence.
- Stale head: the worker reported a SHA that is not the branch head; re-dispatch the same role.
- If a worker died or will not finish, `minions work release <leaseId> --reason "<why>" --json`.

## 6. Follow the next step

The record response says what happened. Typical transitions:

- engineer `complete` → reviewer (`reviewing`), or tester (`testing`) when the task needs QA (QA label, sensitive paths, or `testerRequired`). A reviewer `approve` with `needsQa` → tester (`testing`), then review again.
- QA sweep `complete` → `done`: create one backlog task per finding (`minions backlog create`, idempotency key `qa:<sweepId>:<n>`). Scheduling a new sweep (`qa-sweep:` key) is intake: not while intake is paused.
- tester `complete` → reviewer (`reviewing`); tester `needs_changes` → engineer repair (`changes-requested`), passing the tester's findings as prior findings.
- reviewer `approve` → `delivered` (local delivery). In branch / pull-request delivery the record response has `publication`: `published` → `delivered`, keep the branch and `prUrl` (open, not merged) for the next report; `awaiting-approval` → `awaiting-human`, ask the user (reasons + full head SHA) to run `minions work approve <taskId> --head <sha>` on the host (only the host can sign approvals; an in-runtime approve is rejected), then run `minions work publish <taskId>`; `failed` → `blocked`, report the error and retry `minions work publish <taskId>` after the cause is fixed. With `delivery.merge` `auto-when-eligible`, `minions sync` arms GitHub auto-merge only when every gate passes: merge `awaiting-approval` → ask the user to run `minions work approve <taskId> --head <sha> --merge` on the host; `armed`/`waiting`/`disarmed` leave the task `delivered`; `merged` closes it as `done`; `failed` → report it (never run `gh pr merge` yourself). {{integrationRule}}
- {{ciCoordinatorGuidance}}
- reviewer `request-changes` → engineer repair with the reviewer's findings. Prefer a fresh engineer; when the previous engineer attempt failed to address the findings, use `minions:engineer-deep`, and a stronger allowed model after repeated failure. File separate follow-up work a review turns up with an idempotency key `followup:<taskId>:<n>` (or `--parent <taskId>`), so it stays allowed while intake is paused.
- `replan: true` → stop repairing. Rethink: rewrite the task, split it, or ask the user. Do not dispatch another repair of the same approach.
- `blocked` → record the reason (`minions backlog note`), tell the user what would unblock it if it needs them, move on.
- `partial` → re-dispatch the same role with the remaining work in the prompt, or split. A `drain: true` partial (wound down for an upgrade) is not a failed attempt: while draining do nothing; afterwards re-dispatch the same role (no `engineer-deep` escalation). Its brief carries `resume` (remaining work and the `wip:` checkpoint), so the prompt only needs `Continue from the wip: commit.`
- `needs_split` → decide the split yourself (no need to ask the user); create each proposed child with `minions backlog create --json` using an idempotency key `split:<parentId>:<n>`, the parent id, acceptance criteria and dependencies between children; note the split on the parent. The parent stays as the tracking task.

Then go back to step 1. Stop when nothing is runnable. (When idle after many hand-offs, see the opt-in idle context reset in your coordinator instructions.)

## 7. Report

{{reportingRule}} Include the spend so far (see Owner defaults) with delivery reports. Stage transitions and repairs are recorded in the backlog (notes), not messaged to the user. Approvals for `ask` capabilities and sensitive paths are always requested explicitly, whatever the reporting level.
