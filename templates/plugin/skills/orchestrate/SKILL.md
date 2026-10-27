---
name: orchestrate
description: Dispatch loop for the minions coordinator - pick runnable stages (work next), claim, spawn workers, record results and claim the next stage in one call (work advance), follow next steps.
---

# Orchestrate minions work

Run this loop until nothing is runnable. Every durable step uses a `minions ... --json` helper; never edit backlog or state files.

## 1. Check state

{{outboxCheck}}

1. `minions status --json`. If starts are paused, report that and stop. If `draining` is set (an upgrade is winding workers down), start nothing: only record the workers that return (step 5), report briefly and stop.
2. `minions work next --json` for the runnable stages: `runnable` (dispatch order: tasks under way first, then priority; capacity, per-role limits ({{roleLimits}}), pauses, drain and the budget already applied), `waiting` (with `waitingOn`: `starts`, `capacity`, `role-capacity`, `harness-capacity`, `requires`) and `stuck` (a stage status without a lease that no stage can be claimed from: recover it with `/minions:recover`). `minions work list --json` shows the active leases, `minions backlog list --compact --json` the whole queue.

If `runnable` is empty, report briefly why (the `message`) and stop (a terminal end-of-turn note, not a channel message). Do not loop waiting for work. Start nothing new while the budget is used up (`spend.budget.exhausted` in the status) or quota mode is on (see Owner defaults): record returning workers, report, and ask.

## 2. Choose

Prefer, in order: tasks waiting for their next stage (finish what is started), then higher priority, then tasks that unblock others. Skip tasks whose requirements are unclear: ask the user instead (with a recommended answer).

Take stages from `runnable` in its order unless one of these reasons says otherwise. Each entry names the stage: `role`, `agentType`, `position` in its `workflow`, `suggestedModel`/`agentModel` and the `reason`. The CLI tracks the workflow position (repairs, inserted QA testers, multi-stage workflows), so never pick a role from the task status. A `ready` task labelled `qa-sweep` → tester (QA sweep against `{{baseBranch}}`, `kind: "qa-sweep"`, no workflow; see Testing in your coordinator instructions).

## 3. Claim

`minions work claim <taskId> --compact --json` (the CLI picks the stage's role; `--role <role>` is optional and must match it)

- `CONFLICT`: another stage is active for that task; pick another task.
- `CAPACITY`: stop dispatching new work until a worker finishes.
- `POLICY_DENIED`: the task may not start (paused, not authorized, or `Budget reached`: the owner's budget is used up). Report it with the reason; do not retry. At the budget, running workers continue: record them as usual.
- `PRECONDITION`: the task status does not fit the stage (it moved since `work next`); run `minions work next --json` again.

The compact response has `leaseId`, `briefMarker`, `taskId`, `role`, `attempt`, `branch`, `worktree` and `expectedHead`. The full brief (description, criteria, prior findings, policy) is stored for the worker; do not fetch or paste it.

## 4. Spawn

Call the Agent tool:

- `subagent_type`: the stage's `agentType` from `work next` (`minions:<role>`, or `minions:<role>-deep` when it escalates: `risk:high` or a repair after a failed attempt); for an engineer lease you may still choose `minions:engineer-deep` instead of `minions:engineer` for hard debugging, architecture work, or a retry after an engineer attempt failed that `work next` did not flag (see below)
- `description`: short, e.g. `engineer task-12`
- `model`: the stage's `agentModel`; omit it when null. Allowed {{allowedModels}}. {{modelGuidance}}
- `prompt`, nothing more than:

  ```
  minions-lease: <leaseId>
  worktree: <worktree>

  <coordinator notes: context, the goal, where to look, pitfalls, what to preserve, how to verify (with exact environment workarounds), prior findings to focus on, parallel work to avoid>
  ```

  Copy `briefMarker` exactly as the first line. The worker runs `minions work brief <leaseId> --role <role> --json` from its worktree (only the lease's own worker can). Keep notes focused: no full backlog, transcripts, or unrelated notes. Brief and staff as under Owner defaults.

Older CLI fallback: if `--compact`, `work brief` or `--submitted` is rejected as an unknown option or command, claim without `--compact` and paste the brief in a ```json fence after the marker and worktree lines; in step 5, record by piping the worker's final JSON to `minions work record <leaseId> --json` on stdin.

{{processRunGuidance}}Independent tasks may run in parallel up to the limits. A task never has two workers at once.

## 5. Record and advance

When a worker returns, it has submitted its result with `minions work submit` and ends with one line. Do not ask for or copy its JSON. Record it and claim the next stage in one call, with the worker's token total from its task notification (`subagent_tokens`):

`minions work advance <leaseId> --usage <subagent_tokens> --json`

It records exactly like `minions work record <leaseId> --submitted` (same validation, correction, spend, budget, publication and `contextReset`), then, only when nothing needs your judgement, claims the next stage exactly like `work claim --compact`: the same task's next stage first (finish what is started), else the first `runnable` stage in `work next` order. It never claims while paused, draining or over the budget, after an invalid result, or when a context reset is due. The response has `record` (the record response described below) and one of:

- `next`: the claimed stage (`leaseId`, `briefMarker`, `taskId`, `title`, `role`, `attempt`, `branch`, `worktree`, `expectedHead`, `agentType`, `agentModel`, `reason`). Spawn it right away as in step 4 (`subagent_type` = `agentType`, `model` = `agentModel`, omitted when null; `next.launch` present = a process-harness stage, run its command instead). No `work next`, `work claim` or `work spend` call is needed. To dispatch a different stage instead (step 2 reasons), release this lease first.
- `decision`: nothing was claimed; `kind` says why. `invalid`: correct it (below), then `minions work advance <leaseId> --correction --usage <subagent_tokens> --json`. `replan`, `needs-split`, `needs-changes`, `blocked`, `partial`, `awaiting-human`, `publication`, `ci-unverified`, `qa-findings`: handle that transition (step 6), then go back to step 1. `context-reset`: do the reset now. `paused`, `draining`, `budget`: start nothing; report it. `capacity`, `nothing-runnable`: stop dispatching until the next worker returns (`waiting` says what waits). `claim-failed`: the claim was refused (`code`, as in step 3); run `minions work next --json` again.

Fallback (an older CLI rejects `work advance`, or you need a step on its own): record with `minions work record <leaseId> --submitted --usage <subagent_tokens> --json`, then steps 1 to 3.

Always pass `--usage` for Agent workers (also on `--correction` records and `work release`): it is the durable spend tally. A process-harness run (`launch.kind: "run"`) records its own usage: advance or record it without `--usage`. The figure is cumulative per agent, so after a correction pass the resumed agent's new total; the latest figure per lease counts and nothing is double-counted. If the notification came after you recorded, add it with `minions work spend --lease <leaseId> --tokens <n> --json`.

{{contextResetRule}}

Then check the response's `budget` (present when the owner set one): `crossed` 50 or 80 → tell the owner the spend against the budget; `crossed` 100 or `exhausted` → new claims are refused: tell the owner why starts stopped and ask before spending more. Running workers are never stopped for the budget.

- No submission (`NOT_FOUND`, hint names `minions work submit`): if the worker's final message contains the JSON instead, pipe that to `minions work record <leaseId> --json` on stdin; otherwise ask the worker to submit (once), or release the lease.
- Invalid result (`valid: false`, `correctionAllowed: true`): send the worker only the listed `errors`, ask it to fix them and submit again, then `minions work advance <leaseId> --correction --usage <subagent_tokens> --json` (or `minions work record <leaseId> --submitted --correction --json`). If it is still invalid, it is stored unvalidated; decide yourself (usually re-dispatch or ask the user). Never treat it as approval. A `complete` tester or reviewer result with failing checks is rejected this way; for an engineer `complete` with failing checks, ask the same correction yourself. Either way, give one bounded correction: a concrete way to rerun the checks (exact command and environment, e.g. an exec-allowed `TMPDIR`), or a status that matches the failure.
- Worker ended with `brief unavailable: <error>` (no result): do not record it. Release the lease (`minions work release <leaseId> --reason "brief unavailable" --json`), claim again without `--compact`, and re-dispatch with the brief pasted in a ```json fence.
- Stale head: the worker reported a SHA that is not the branch head; re-dispatch the same role.
- If a worker died or will not finish, `minions work release <leaseId> --reason "<why>" --usage <subagent_tokens> --json`.
- A worker that failed on a plan usage or rate limit (subscription session or weekly window): pause starts (`minions pause --starts --json`), report it to the owner, and release or keep the lease for re-dispatch after the limit resets.

## 6. Follow the next step

The record response (`record` in the advance response) says what happened. When `work advance` already claimed the next stage, only the owner-facing parts below remain (reports, approvals to request). Typical transitions:

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

Then go back to step 1 (after a `work advance` that returned `next`, spawn that stage instead), unless a record or release response carried `contextReset`: then do the context reset (handoff, then restart; Limits in your coordinator instructions) and stop. Stop when nothing is runnable.

## Workflows, roles and models

- **Assigning a workflow** when you create a task: the default unless the task fits a configured workflow ({{workflowNames}}), e.g. docs-only work → a docs workflow, research → a research workflow. Pass it in the create call (`minions backlog create ... --workflow <name>`); do not report the choice. Change it later only between stages (`minions backlog update <taskId> --expected-version <v> --workflow <name>`); the next claim resets the position by evidence at the head.
- **Proposing a role**: only when recurring project work does not fit engineer, tester and reviewer (a different output than code, different tools, or a different gate), never for a one-off task. Draft the smallest role: no edits unless needed, `edits.paths` scoped to what it writes, no extra capabilities, and the workflow that uses it. Write the proposal JSON `{name, role: {...}, promptText, reason, workflows?}` to a temporary file and store it with `minions config roles propose --file <f> --json`: it is validated like config (on `INVALID_CONFIG` fix the named field and propose again; a newer proposal for the same name supersedes the pending one) and returns `proposalId`, a `summary` (fields, tools, edit scope, the policy row) and `applyCommand`. Nothing becomes effective. Ask the owner once, with the summary and the host command `minions config roles apply <proposalId>` (it shows the diff and the prompt and asks; a coordinator restart follows); never edit `.minions/**` yourself. `minions config roles list|show --json` show the configured roles and the proposals.
- **Cheap stages**: follow `suggestedModel` (stage hint, then role model, then the risk rule: `risk:low` → the cheapest allowed model for gates and verifiers, `risk:high` or a repair after a failed attempt → the strongest and the deep variant). Label a task `risk:low` or `risk:high` when you create it if the risk is clear. Downgrade further only for mechanical stages (a small rename, a doc fix); effort is per role and set on the host.

## 7. Report

{{reportingRule}} Include the spend so far (see Owner defaults; `spend` in `minions status --json`: total, today, per task, against the budget) with delivery reports. Stage transitions and repairs are recorded in the backlog (notes), not messaged to the user. Approvals for `ask` capabilities and sensitive paths are always requested explicitly, whatever the reporting level.
