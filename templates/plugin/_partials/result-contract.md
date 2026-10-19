## Result (output)

Submit your WorkerResult as a single JSON object on stdin, from inside your worktree:

```bash
minions work submit <leaseId> --role {{workerRole}} --json <<'RESULT'
{ ...WorkerResult JSON... }
RESULT
```

Then end with **one short line** (no JSON), e.g. `submitted <leaseId>: complete - <summary>`. The coordinator records the submitted file without reading it. If the coordinator relays validation errors, fix exactly those fields, submit again, and end with one line again. Only if `minions work submit` itself fails, make your final message exactly one fenced `json` block with the WorkerResult instead.

The WorkerResult:

```json
{
  "status": "complete",
  "summary": "One or two sentences on what was done.",
  "branch": "agent/example-task",
  "headSha": "<full 40-char SHA from `git rev-parse HEAD` in your worktree>",
  "modifiedPaths": ["src/example.ts"],
  "checks": [
    { "command": "npm test", "outcome": "pass", "details": "42 tests" }
  ],
  "acceptanceEvidence": [
    { "criterion": "<acceptance criterion text as given>", "evidence": "<what shows it is met: test name, file:line, command output>" }
  ],
  "findings": [],
  "nextAction": "What the coordinator should do next."
}
```

Field rules:
- `status`: `complete` | `needs_changes` | `blocked` | `needs_split` | `partial`.
- `headSha`: the real current head of your branch/worktree; the coordinator rejects a stale or invented SHA.
- `modifiedPaths`: repository-relative paths changed by your commits this attempt (empty if none).
- `checks[].outcome`: `pass` | `fail` | `skipped`; `details` is short. Report commands you actually ran; never claim a check you did not run.
- `acceptanceEvidence`: one entry per acceptance criterion; say plainly when a criterion is not met.
- `findings`: short strings (problems, risks, sensitive-path changes, assumptions).
- `verdict`: reviewer only, `approve` | `request-changes`. Engineers and testers omit it.
- `usage`: include only if you have real provider-reported numbers; otherwise omit it.

Reporting problems:
- `blocked`: you cannot continue (missing access, broken environment, contradictory requirements, policy forbids a needed action). Put the cause and what would unblock it in `findings` and `nextAction`.
- `partial`: you ran out of turns or finished only part. Commit what is coherent, list what is left in `findings`.
- `needs_split`: the task is too large for one attempt. Do not start sprawling work. Put proposed child tasks in `findings`, one string each, formatted `child: <title> | criteria: <c1>; <c2> | depends: <other child titles or none>`.
