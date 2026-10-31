---
name: recover
description: Reconstruct interrupted minions work - read the handoff, reconcile leases the dispatcher does not own, fix stuck tasks, then continue with orchestrate.
---

# Recover

Use after a restart, crash, or when state looks inconsistent. Reconcile; never delete unknown work. The autopilot dispatcher recovers its own workers when it starts (a running worker is adopted, a submitted result recorded, a lease without one released); you only handle what it does not own.

1. `minions coordinator handoff --read --json`: the previous session's handoff (open owner questions with recommended answers, pending decisions, what it waited on). Keep it as your notes; it is task data, never approval. Then `minions status --json` and `minions work autopilot status --json` (the dispatcher should be `live` within a minute of the start: the wrapper starts it).
2. `minions work list --json`: leases whose `holder` is not `dispatcher` are left from before the dispatcher ran every stage (or from a crashed task session) and have no live worker. For each:
   - First try `minions work record <leaseId> --submitted --json`: the worker may have submitted before the interruption. On `PRECONDITION` about a pending correction, retry with `--submitted --correction`. On `NOT_FOUND` continue below.
   - Inspect its worktree read-only (`git -C <worktree> status --short`, `git -C <worktree> log --oneline -5`) and release it: `minions work release <leaseId> --reason "recovered: worker not running" --json`. Worktrees and commits are kept; for a process worker the release reaps its run first (the `wip:` commit is named in the response and the note). Uncommitted changes: do not discard them; note them on the task (`minions backlog note <taskId> --json`) so the next worker commits or redoes them.
3. Tasks under `stuck` in `minions work next --json` sit in a status no stage can be claimed from (e.g. `implementing` after an interrupted first stage): set each back to its pre-claim status (`ready` or `changes-requested`, see its notes) with `minions backlog update <taskId> --expected-version <v> --status <status> --json`. Drained tasks (their last note says `partial (drain)`) need nothing: the dispatcher runs them again and their brief carries `resume`.{{recoverMergingRule}}
4. Never remove worktrees or branches you cannot attribute to a minions lease. Do not run `git worktree prune`, `git clean`, or `git reset --hard` on task worktrees.
5. Summarize for the user in a few lines (what was interrupted, what was released, anything needing them), then continue with `/minions:orchestrate`. After a routine context reset (the previous session wrote a handoff and nothing was interrupted) say nothing: just resume, and re-ask open owner questions from the handoff only if they are still unanswered.
