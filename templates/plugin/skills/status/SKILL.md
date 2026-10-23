---
name: status
description: Concise minions project status - queue, active workers, blockers, delivered branches.
---

# Minions status

1. `minions status --json` (controls, counts, config revision, pending notifications).
2. `minions work list --json` (active leases: task, role, attempt, started).
3. If needed, `minions backlog list --json` for tasks in `blocked`, `awaiting-human` or `changes-requested`.

Answer in a few lines:

- Paused or running; active tasks/limits ({{maxActiveTasks}} tasks, {{maxEngineers}} engineers).
- In progress: task, stage, attempt.
- Waiting on the user: each item with the question and your recommended answer.
- Blocked: task and reason.
- Delivered since last report: task and `agent/<slug>` branch, grouped by feature (parent task or goal) when several belong together. Remind the user that `minions export` on the host fetches them.
- Spend so far (this session and its workers, from reported usage): USD cost with API-key billing, tokens only on a subscription plan; against the budget when there is one, and whether quota mode is on.

This is the answer to a status request, so task-level detail is expected here even though unprompted reports follow the reporting level. Do not dump raw JSON or logs. Read only; this skill changes nothing.
