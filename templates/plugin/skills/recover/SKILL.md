---
name: recover
description: Reconstruct interrupted minions work - reconcile status, leases and worktrees, release stale leases, re-dispatch.
---

# Recover

Use after a restart, crash, or when state looks inconsistent. Reconcile; never delete unknown work.

1. `minions status --json` and `minions work list --json`. List active leases with task, role, attempt, worktree and start time.
2. For each active lease, decide whether its worker is still running in this session (a background Agent you launched and that has not returned). Leases from a previous session have no live worker.
3. For each lease without a live worker:
   - First try `minions work record <leaseId> --submitted --json`: a worker that finished before the interruption may have submitted its result. If that records it, follow the next step as usual; on `NOT_FOUND` continue below. On `PRECONDITION` about a pending correction (an earlier invalid result awaits correction), retry with `minions work record <leaseId> --submitted --correction --json`.
   - Inspect its worktree read-only: `git -C <worktree> status --short`, `git -C <worktree> log --oneline -5`, `git -C <worktree> rev-parse HEAD`.
   - Release it: `minions work release <leaseId> --reason "recovered: worker not running" --json`. Worktrees and commits are kept.
   - Uncommitted changes in an engineer/tester worktree: do not discard them. Mention them in the next brief for that task so the new worker can commit or redo them, and note it with `minions backlog note <taskId> --json`.
4. Check tasks in `implementing`, `testing` or `reviewing` without a lease: they need the corresponding stage again (`implementing` → engineer).
   - Drained tasks (their last note says `partial (drain)`, from an upgrade): re-dispatch the same role through `/minions:orchestrate` (engineer partials are back in `ready`/`changes-requested`, reviewer and tester partials stay in `reviewing`/`testing`). The new brief has `resume` with the remaining work; add `Continue from the wip: commit.` to the prompt. This is not a failed attempt.
5. Never remove worktrees or branches you cannot attribute to a minions lease. Do not run `git worktree prune`, `git clean`, or `git reset --hard` on task worktrees.
6. Summarize for the user in a few lines (what was interrupted, what was released, anything needing them), then continue with `/minions:orchestrate`.
