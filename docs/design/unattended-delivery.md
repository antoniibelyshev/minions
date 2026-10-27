# Unattended delivery: daily routine, PR scan, autonomous intake: design

Status: **agreed** (task-68.1; the owner approved every recommended answer, Telegram msgs 320/321, and set the
timezone, msg 322: see [Owner answers](#owner-answers)). Phase 1 (routine pass and clock) is built in task-68.2, phase 4 (digest and held questions) in task-68.5. Epic: task-68. Related: [coordinator-sessions.md](coordinator-sessions.md)
(task-57: supervisor, token baseline), [host-manager.md](host-manager.md) (task-53: manager loop and its supervisor),
[bootstrap.md, CI-gated auto-merge](bootstrap.md#ci-gated-auto-merge), [roles-and-workflows.md](roles-and-workflows.md)
(stage machine).

## Summary (for Telegram)

- Goal: you write once or twice a day. The rest of the time a ready task goes engineer → tester → reviewer → PR →
  CI-gated auto-merge without you or a coordinator judgement. It still stops for you on sensitive paths, `ask`
  capabilities and a replan after 3 repair cycles.
- **A deterministic clock** runs a routine pass every 15 minutes: sync PRs, CI and issues, merge what passes, scan
  open PRs. It costs no model tokens. It wakes the coordinator only when there is work only a model can do (a stage
  to dispatch, a decision), and for the daily digest.
- **PRs that fall behind main are updated by code, not by an agent**, when the merge is clean: the runtime builds the
  merge commit, checks it, pushes it, and CI must pass again. No re-review is needed. Only a real conflict gets the
  `needs-rebase` label, and then an engineer merges main, followed by re-test and re-review as policy says.
- **One digest per morning** (optionally evening too) with what was merged, what waits for you, and all questions as
  numbered polls.
- **Autonomous intake** within limits: your requests and labelled GitHub issues become ready tasks. The
  coordinator's own ideas are promoted only up to a daily cap and within budget, and each one is listed in the digest.
- **Token overhead:** today the coordinator uses about 79% of all tokens. Recommendation: first collapse the
  mechanical turns (`work advance`). The target is a deterministic dispatcher that launches worker stages itself, so
  the coordinator is woken only for exceptions.

## Problem

Owner decisions (Telegram msgs 308 and 310, 2026-10-27, in the task-68 notes): real time isn't needed, a morning
routine is enough. Conflicts must be automated: when a slot frees up, scan open PRs, and give a PR that is behind or
conflicting a special high-priority status so it doesn't hang. The owner checks in once or twice a day, and minions
plans, promotes and batches questions in between. Principle (msg 310): **no tokens on repeated or mechanical work**.
Sync, PR scan, status checks, rebase detection and routine dispatch must be deterministic CLI or runtime code. The
coordinator spends tokens only on real decisions.

Facts from the code (main @ 4999cb3):

- **Nothing runs on its own.** `minions sync` (`src/runtime/commands.ts`, `syncTasks` in `src/runtime/ci.ts`)
  imports issues (`intake-sync.ts`), records PR and CI observations, closes merged PRs as `done`, blocks closed ones
  and runs the auto-merge pass (`merge.ts`). It runs only when the coordinator calls it ("at startup, or when the user
  asks", `src/plugin/generate.ts`). bootstrap.md records the residual: "between passes nothing is armed". The outbox
  says: "Nothing here wakes an LLM" (`outbox.ts`).
- **The idle coordinator sleeps until Telegram.** The Stop hook (`stopHook`, `hooks.ts`) keeps it running only while
  ready stages and capacity exist. After that, the interactive `claude` in tmux waits for the next owner message.
  Work that becomes runnable while it waits (a dependency merged, CI failed on a delivered PR, an issue imported)
  waits for the owner.
- **Merge gates are bound to the approved head.** `evaluateMergeGate` needs PR head == `publications.head_sha`,
  reviewer evidence `complete` for that head at the current config revision, CI gate `pass` for that head
  (`ci-gate.ts`), the sensitive-path gate (`gateChangedPaths`, a union of diffs against the recorded claim bases and
  origin's base) and `can(pr.merge)`. With `ask` (the default), a host-signed merge approval for that head is needed
  as well. Any change to the PR head disarms auto-merge, so a PR updated with main can never merge without new
  evidence for the new head.
- **No PR state beyond open, merged or closed.** `syncOne` reads `mergeStateStatus` but uses it only for the
  direct-merge fallback (`CLEAN`). `BEHIND`, `DIRTY` and `mergeable: CONFLICTING` are not acted on. Publication never
  force-pushes (`publish.ts`), so a rebased branch would be rejected.
- **Statuses are fixed in the backlog config.** `BACKLOG_STATUSES` (`src/backlog/factory.ts`) is written into each
  project's Backlog.md config at init, and the order matters. A new status needs a backlog config change in every
  existing project. `awaiting-ci` and `merging` exist but no transition uses them.
- **Repair cycles.** `repair()` in `Scheduler.record` counts gate results (`incrementRepairs`). At
  `execution.maxRepairCyclesBeforeReplan` the task moves to `awaiting-human`.
- **Intake.** Imported issues are created with the backlog default `idea`, with provenance `external-requirement`.
  `authorized` comes from the label `minions:authorized` or `intake.startReady`. The `budgets.dailyUsd` config is
  not enforced (v0.1). The enforced budget is the controls row in `spend.ts`: claims are refused at 100%.
- **Measured coordinator overhead** (`minions status --json`, task-57.1 baseline, 2026-10-27 since 07:07): 2
  sessions, 129 turns, a mean context of 70k tokens per turn (max 131k), 9.07M tokens, 97% of them cache reads. That
  is about $7.2 estimated. Over the whole day: 11.5M tokens and 11 worker attempts. The coordinator is about 79% of
  the tokens, about 0.8M per worker attempt.
- **Host manager.** `runManager` (`src/host/manager.ts`) polls each running project every 20 s
  (`POLL_INTERVAL_MS`) through the bounded delegate (30 s timeout, 256 KiB). It runs under launchd or systemd --user
  (task-53.6) and has its own bot. It is optional (a `minions setup` step).

## Decisions

1. **One deterministic routine pass, no new top-level command.** `minions sync --routine` (hidden flag on the internal
   `sync`) runs, under a DB lock (`{pid, start}`, the reuse-safe rule of the coordinator lock) and at most once per
   half interval unless `--force`:
   1. the full `minions sync`: intake import, PR and CI observations, merged → `done`, closed → `blocked`,
      arm/disarm auto-merge;
   2. the PR scan (decision 4);
   3. the outbox hold-back for the digest (decision 7);
   4. the wake decision (decision 3);
   5. a `routine` event with counts. `minions status` shows the last pass and the next one.

   Every step reuses the existing idempotent code. Two callers at once are harmless, because the lock and the
   interval refuse the second one.
2. **The clock lives in the coordinator wrapper. The host manager is the watchdog.** `coordinatorWrapper` (a node
   process that lives as long as the coordinator) runs the routine pass every `routine.tickMinutes` (default 15) in
   the same process, without blocking claude. When the manager is installed, it checks the last `routine` event of
   each running project on its poll. If it is older than 2 intervals (the coordinator is not running, or the wrapper
   hangs), it calls `minions sync --routine` itself through the delegate, with its own 5-minute timeout and in its
   own lane, so offers are never delayed. Merges, syncs and base updates therefore continue while the coordinator is
   down. The manager bot reports "coordinator not running since <t>" once. Without a manager, the wrapper clock alone
   covers the normal case.
3. **The coordinator is woken only when a model is needed.** A wake reason is one of these:
   - a stage that `work next` lists as runnable, with capacity, budget left and starts not paused (this includes
     `needs-rebase` and CI repairs that the scan created);
   - an unvalidated or `needs_split` result, or a task that has just reached `awaiting-human` and needs a question
     composed;
   - the digest is due (decision 7).

   Nothing else wakes it. PR, CI and merge events do not, because they become digest lines. **The wake is a fresh
   session.** After more than 5 minutes idle the prompt cache has expired, so resuming a 70k to 130k context costs a
   full cache write. A fresh session costs its prefix (about 25k) plus the wake turn. The pass therefore runs the
   detached restart path (`scheduleDetachedRestart`, as in `coordinator restart --detach`) with a constant wake
   prompt `/minions:orchestrate wake`. The prompt never contains task or owner text, and the coordinator reads the
   reasons from `minions sync --routine --last --json`. Conditions: the coordinator lock is held and no lease is
   active; the main transcript has been idle for at least 10 minutes (mtime of the path that the Stop hook stores);
   no owner message in the last 30 minutes (the task-58 "latest message" window), so a live conversation is never
   cut. Limits: `routine.minWakeGapMinutes` (default 30) and `routine.maxWakesPerDay` (default 8; the digest wake
   always counts and is always allowed). If the coordinator is not running and its exit record shows a crash, the
   pass starts it with the recover prompt, at most 2 times a day; after that the manager bot reports it. The end
   trigger `wake` is recorded for the task-57.1 baseline. This changes a README statement ("the runtime never
   restarts the coordinator on its own"), so it is owner question 3.
4. **PR scan: one read, then the cheapest correct action per PR.** The scan reads all open minions PRs with one
   `gh pr list --state open --json number,url,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,isDraft`
   call and matches them to `delivered` tasks by URL. It runs in the routine pass, in `minions sync`, and **when a
   slot frees up**: after `work record` and `work release`, once the lease has ended, with a 60 s budget. Its outcome
   is a `scan` field and never changes the record result. `work next` stays read-only. Only tasks without an active
   lease, at the approved head, are acted on:

   | GitHub says | Action | Model? |
   | - | - | - |
   | `CLEAN`, `BLOCKED`, `UNSTABLE`, `HAS_HOOKS` | nothing new (the merge pass decides) | no |
   | `UNKNOWN` (GitHub is still computing) | retry on the next pass | no |
   | `BEHIND` (protection requires up to date) | **base update** (decision 5) | no |
   | `DIRTY` / `CONFLICTING`, confirmed locally by `git merge-tree` | **needs-rebase** (decision 6) | engineer |
   | required checks `fail` at the approved head | `changes-requested` with the failing checks as findings; counts as a repair cycle (the same rule as `ciBlock === 'fail'` in record) | engineer |
   | required checks `timeout` | a digest line with the PR link; the task stays `delivered` | no |

   `BEHIND` appears only when branch protection requires branches to be up to date. Without that setting, GitHub
   merges a behind PR as it is, and nothing needs to happen.
5. **Base update without a model, by a verified merge commit.** For `BEHIND` (and for `DIRTY` that `merge-tree`
   finds clean after a fresh fetch):
   1. fetch origin's base `B` (`syncBaseFromOrigin`; `B` = the server's `ls-remote` SHA);
   2. `git merge-tree --write-tree H B` (git ≥ 2.38; the runtime has 2.39). If it reports a conflict, go to decision 6;
   3. `git commit-tree <tree> -p H -p B` with the runtime's git identity gives `H'`;
   4. disarm auto-merge if minions armed it;
   5. move the local branch to `H'` and push it as a **fast-forward** (never force; a non-fast-forward rejection
      means someone else pushed, so skip and record it);
   6. record `base-update` evidence `{from: H, base: B, tree}` on `H'`, and set `publications.head_sha` to `H'`.

   **Derived approval rule** (the merge gate, `evaluateMergeGate`): reviewer and verifier evidence for `H` counts for
   `H'` when a `base-update` record proves all of these:
   - `H'` has exactly the parents `(H, B)`;
   - `B` is an ancestor of, or equal to, the server's base;
   - `tree(H')` equals `merge-tree(H, B)` with no conflicts;
   - the config revision is unchanged.

   Chains (`H → H' → H''`) are followed. The CI gate is **never** derived: required checks must pass at `H'`. They
   catch the semantic conflicts a clean textual merge can hide, the same guarantee as GitHub's own "Update branch"
   plus auto-merge. Sensitive paths of `H'` are `changedPaths(H)` (as approved) ∪ `diff(B, H')`. The union only adds
   paths, which keeps the task-40 rule "no base removes a path". With `pr.merge: ask`, the host-signed merge approval
   stays per head, so `H'` needs a new one. That is why unattended delivery needs `pr.merge: allow` (see
   [Prerequisites](#owner-host-prerequisites-checklist)). A local `merge-tree` was chosen over
   `gh pr update-branch` because the tree is checked **before** anything is pushed, and the result does not depend on
   GitHub's merge commit or on the repository's "allow update branch" setting.
6. **Conflicts: a label, not a new status.** A confirmed conflict does the following:
   - disarm auto-merge;
   - move the task `delivered` → `changes-requested` with the label `minions:needs-rebase`;
   - set the stage position to the first producer (`repairTarget` semantics);
   - set `priorFindings` to "conflicts with <base> at B in <files>; merge origin/<base> into the branch, resolve,
     never rebase or force-push".

   A new status was rejected: it would need a backlog config change in every project and new stage-machine rules,
   while `changes-requested` already routes to the engineer and counts as in-flight capacity. **Priority:** `work
   next` sorts labelled tasks before every other candidate. They are nearly done, and each hour behind main makes
   the conflict bigger. The engineer brief carries `conflictFiles` and `previousHead`. Then the normal workflow runs:
   the tester when `qaRequirement` says so, then the reviewer. The reviewer brief also carries a **resolution diff**:
   `git diff <merge-tree with conflict markers> <new head>`, which shows exactly the hand-resolved lines. A reviewer
   approval publishes the new head as a fast-forward to the same PR (`findPr` reuses the open PR). It does not count
   as a repair cycle. It counts toward `execution.maxRebaseCycles` (new, default 2 per task). Beyond that limit the
   task goes to `awaiting-human` with a digest question ("main keeps changing the same files: merge <other task>
   first, split, or let me try again?"). The label is removed when the task is delivered again.
7. **One digest, with held questions.** Outbox items get a hold. `notify enqueue --hold digest` sets
   `next_attempt_at` to the next digest time, so `pending()` does not return them earlier (no schema change).
   The kinds `delivered`, `feature` and `question` are held by default (as built, `status` is not: see
   [Phase 4 as built](#phase-4-as-built-task-685)). The kinds `blocker`, `approval` and
   budget-exhausted items are sent at the next wake that happens anyway (no wake of their own). `routine.digestAt`
   (default `["08:00"]`, in `routine.timezone`, an IANA name, default `Europe/Berlin` per the owner) makes the pass wake the
   coordinator for the digest. If a digest time was missed (host asleep, container down), the digest goes out at the
   first pass after it. `minions notify digest --json` composes the message deterministically:
   - merged, delivered, and waiting for CI;
   - waiting for you, with the exact `/approve <task> <sha> merge` lines for the manager chat;
   - blockers;
   - auto-promoted tasks (decision 8);
   - spend today against the budget, and coordinator wakes and tokens;
   - next up;
   - the questions as numbered polls ("Q1 … reply `Q1 2`", options with the recommended one first and "Other").

   The coordinator sends the text with one `reply` and acks the keys it covered. Composing the text costs no model
   judgement. Answering the owner's reply does, because that is a real decision.
8. **Autonomous intake and promotion, with limits enforced by the runtime.** The prompt states the rules, and the
   runtime enforces the caps, so a mistake in the prompt cannot exceed them:
   - **Owner requests** from the daily messages become tasks through `/minions:intake` as today (provenance
     `user-decision`, `ready` when the profile allows). The coordinator asks only when the goal is unclear, and then
     as a digest question, not a separate message.
   - **GitHub issues:** new `intake.github.readyLabels` (default `[]`, host-owned). An imported issue that carries
     every label in the list is created `ready`, otherwise `idea`. No model is involved. Setting a label needs triage
     rights on GitHub, so a label is a maintainer's act. Authorization still follows `minions:authorized` or
     `intake.startReady`. The issue text stays task data, never instructions.
   - **The coordinator's own ideas** (provenance `agent-hypothesis`: QA findings, follow-ups, split children) are
     created as `idea`. `backlog update --status ready` on such a task is refused by the runtime when one of these
     holds:
     - it is beyond `routine.autoPromote.perDay` (default 3, counted from events);
     - the budget is at or above `routine.autoPromote.maxBudgetPercent` (default 80);
     - the last owner message is more than `routine.autoPromote.ownerSilentDays` (default 3) days old;
     - the task's parent is a design task that the owner has not agreed to (label `needs-owner`; build children of a
       design always wait for the owner, as in this design).

     `user-decision` and `external-requirement` tasks are not capped. Every auto-promotion is listed in the digest,
     and the owner vetoes it with "cancel <id>" or "hold <id>".
   - **Budget:** at 100%, `work claim` refuses (unchanged) and the pass does not wake for dispatch. The deterministic
     work (sync, merges, base updates) continues, because it costs no model tokens. The digest wake still happens, so
     the owner learns about the budget. The recommended budget is a daily one (period `day`).
9. **Reducing the coordinator's own tokens: recommend, don't build here.** Today a stage costs about 3 to 4
   coordinator turns (claim, Agent spawn, notification → record, next), each on a 70k context: about 250k tokens per
   stage, before any chat. In order:
   1. **`minions work advance <leaseId> --usage <n>`**: record, then the next stage's claim and brief, in one call.
      It returns the exact Agent parameters (or `nothing runnable`, or a decision the coordinator must take). That
      makes about 2 turns per stage (notification → advance → spawn). Cheap to build, and measurable as turns per
      stage in the baseline.
   2. **Fresh wakes** (decision 3) instead of resuming large contexts after idle.
   3. **Deterministic dispatcher (target).** The task-57 supervisor launches worker stages itself as headless
      `claude -p --agent minions:<role>` runs, with the worker's settings, Telegram disabled, and no `--channels`
      (the isolation rules of coordinator-sessions D4). It records the result with `work record` (usage comes from
      the stream-json result, which is more exact than the notification totals). It handles the one allowed
      correction by resuming the worker with the validation errors. It wakes the coordinator only for exceptions:
      `blocked`, `needs_split`, a producer's `needs_changes`, a replan, an unvalidated result, intake, owner messages.
      On the happy path no LLM coordinator turn happens at all. This revises task-57: the supervisor drives stages
      directly, and the planned task sessions are only for exceptions. It amends agent-runtimes D11.3 and the
      no-nested-claude rule (task-51) **only** for this one deterministic launcher. It needs the coordinator-run spike
      for task-57 U1 to U3 first; workers cannot test it. Go or no-go uses the task-57 rule: the saving must be at
      least 25% of coordinator spend, measured by tokens per delivered task.

## Daily routine

| When | What runs | Model tokens |
| - | - | - |
| every 15 min (wrapper clock; manager when that is stale) | `sync --routine`: intake, PR/CI sync, merge pass, PR scan, base updates, hold-back, wake decision | none |
| a slot frees up (`work record` / `work release`) | PR scan (60 s budget) | none |
| the scan or sync made a stage runnable, the coordinator is idle, within limits | fresh coordinator wake: `work next`, claim, spawn (later: dispatcher, no wake) | one fresh session |
| `routine.digestAt` (default 08:00) | digest wake: `notify digest`, one `reply`, then dispatch as above | one fresh session |
| owner message | as today (the coordinator holds the bot) | as today |
| night or owner silent | deterministic work continues; at most `maxWakesPerDay`; no auto-promotion after `ownerSilentDays` | capped |

The epic's criterion is met when phases 1 to 3 and the prerequisites are in place: a ready task runs its stages
while the coordinator is awake, the routine wakes it for newly runnable work, and merges, base updates and `done`
happen without it.

## Failure modes

- **CI never finishes.** The CI gate goes `timeout` after `ciPendingTimeoutMinutes` (60). The merge pass does not
  arm, the task stays `delivered`, and a digest line names the PR and the pending checks. There is no automatic
  re-run (see the next item). A later base update re-triggers CI as a side effect.
- **Flaky check.** It fails at the approved head and the scan sends the task to repair. An engineer who finds
  nothing to fix wastes a cycle, and the head stays the same. Proposal (owner question 5): a new capability
  `ci.rerun`, default `ask`. When it is `allow`, the scan re-runs the failed jobs once per head
  (`gh run rerun <id> --failed`, which needs Actions read/write on the token) before it sends the task to repair. A
  second failure goes to repair. Without it, the repair cycle cap (3) bounds the loop, and the owner gets the replan
  question.
- **Rebase loop.** Base updates: at most 1 in flight across all PRs (the highest priority, oldest approval first, a
  light merge train). This avoids N PRs rebuilding CI on every merge (O(N²)). The cap is
  `routine.maxBaseUpdatesPerTask` (default 4 per day). Conflict rounds: `execution.maxRebaseCycles` (default 2), then
  `awaiting-human`. Two PRs that conflict with each other: the first one merges, then only the second becomes
  `DIRTY`.
- **Budget hit.** Claims are refused and dispatch wakes stop. Deterministic work and the digest continue. A
  subscription rate limit (the wake's claude fails) gives a backoff: the next try comes at the next interval, and
  after 3 failed wakes in a row a blocker line goes to the manager bot.
- **Owner silent for days.** Questions stay held and are repeated in each digest, never more often. Tasks needing
  the owner stay `awaiting-human`. Owner tasks and imported `ready` tasks keep flowing. Auto-promotion stops after
  `ownerSilentDays`, so the work does not drift. Merge approvals that expire (sensitive paths) are re-listed.
- **Coordinator crashed or not running.** The manager watchdog keeps the routine pass going and reports it once.
  The pass restarts the coordinator with recover at most twice a day.
- **Host asleep or container down.** No pass runs. The first pass after resume catches up (everything is
  idempotent), and a missed digest is sent then.
- **GitHub API down or rate-limited.** Each task records its own error, nothing changes state on a failed read (fail
  closed, as today), and the next pass retries. The scan is one list call per pass.
- **A base update races a push.** The push is a fast-forward from `H`, so a concurrent push makes it fail. The
  update is skipped and retried after the next sync. A task with an active lease is never touched.
- **Wake during a live conversation.** Prevented by the 30-minute owner-message rule and the transcript-idle check.

## Owner host prerequisites (checklist)

- [ ] `minions setup github`: a fine-grained token for one repository with Contents and Pull requests read/write
  (Actions read/write only if `ci.rerun` is allowed), `delivery.mode: pull-request`.
- [ ] `verification.ciAuthority: "github"` and `delivery.requiredChecksConfigured: true`; a CI workflow on pull
  requests that runs the verification commands (`.github/workflows/**` is a sensitive path, so the owner adds it).
- [ ] GitHub branch protection or a ruleset on the base branch: required status checks (pinned to the GitHub Actions
  app), "Require branches to be up to date" **on** (recommended for unattended merges; it is what makes `BEHIND`
  appear), no force pushes, no bypass for the token's user. If human-approving reviews are required, every PR stops
  at GitHub (the minions identity cannot approve its own PR); use Code Owners for sensitive paths instead.
- [ ] Repository setting "Allow auto-merge" on.
- [ ] `delivery.merge: "auto-when-eligible"` (method `squash` recommended) and **`capabilities.pr.merge: "allow"`** on
  the host (host-owned). Sensitive paths still need `/approve <task> <sha> merge`.
- [ ] `minions doctor`: `ci.authority` and `merge.readiness` say ready.
- [ ] The host manager installed and paired (`minions setup`, manager step): watchdog, `/approve`, alerts.
- [ ] A daily owner budget, and `routine.timezone` and `routine.digestAt` set.
- [ ] First real run: PR #1 (task-65) goes through merge with this setup before `routine.enabled` is turned on.

## Alternatives rejected

- **The coordinator polls with `sleep` or background waits.** Every wake is a model turn on a large, uncached
  context. That is exactly the mechanical spend the owner ruled out.
- **The host manager as the only clock.** It is optional, it lives on the host side, and its delegate is bounded to
  30 s. It stays as the watchdog.
- **Waking by `tmux send-keys` into the idle TUI.** It is fragile (dialogs, input mode), and it keeps the large
  context. A fresh session is cheaper after the cache TTL.
- **A new `needs-rebase` status.** It would need a backlog config change in every project and stage-machine rules.
  The label on `changes-requested` uses the existing repair route (decision 6).
- **Rebasing the branch.** It needs a force-push, which publication forbids. Merging main keeps every push a
  fast-forward.
- **Re-review after every base update.** A reviewer would spend tokens on a diff that contains only main. The tree
  identity check plus CI at the new head gives the same guarantee as a human team's "Update branch".
- **`gh pr update-branch`.** It works, but the result is checked only after it lands on GitHub, and it depends on a
  repository setting. Kept as a fallback if a local merge-tree is unavailable.
- **GitHub merge queue.** It needs organization or plan features many owners lack. Reconsider if it becomes
  generally available for personal repositories.
- **Sending the digest from the manager bot (no wake).** Answers would land in a chat with no model. Telegram
  ownership stays as in telegram-decisions and coordinator-sessions.

## Unknowns

- U1: whether a Telegram channel message raises a hook in the coordinator. If so, the "owner active" check could use
  it instead of transcript mtime. The mtime check is sufficient.
- U2: the exact behaviour of GitHub auto-merge when the head moves while it is armed. The design disarms before
  every push, so it does not depend on it.
- U3: `merge-tree` performance on large repositories (expected fine; bounded by the 60 s scan budget).
- U4: for the dispatcher (decision 9.3): task-57 U1 to U3 (hooks, settings and agents under `claude -p`), checked by
  a coordinator-run spike, never by a worker.

## Phases

Ordered by value. Each phase is one task. Nothing is built before the owner agrees.

1. **child: Routine pass and clock** | criteria: hidden `minions sync --routine` with a DB lock and interval;
   sync + intake + merge pass + `routine` event; the clock in `coordinatorWrapper` (`routine.tickMinutes`); the
   manager watchdog runs the pass through the delegate when the last event is older than 2 intervals; wake reasons
   from `work next`, budget and pauses; fresh wake through the detached restart with the constant prompt
   `/minions:orchestrate wake`, idle and owner-active checks, `minWakeGapMinutes`, `maxWakesPerDay`, crash restart at
   most 2 per day; end trigger `wake` in the baseline; `routine.*` settings with classes (`routine.enabled` default
   off); `status` shows the last and next pass; tests with a fake gh, a fake clock and a fake restart | depends: none
2. **child: PR scan and verified base update** | criteria: one `gh pr list` read per scan; the scan runs in sync,
   in the routine pass and after `work record`/`release` (60 s budget, a `scan` field, never changes the record
   outcome); the table in decision 4; `BEHIND` → merge-tree, commit-tree, disarm, fast-forward push, `base-update`
   evidence, publication head moved; derived approval in `evaluateMergeGate` (parents, ancestry, tree identity,
   revision; CI never derived; sensitive paths as a union); one update in flight; `maxBaseUpdatesPerTask`; CI fail at
   the approved head → `changes-requested` as a repair cycle; tests with git fixture repos (clean, conflict, non-ff,
   chain, forged parent, tree mismatch) | depends: none (more useful with 1)
3. **child: needs-rebase stage** | criteria: a confirmed conflict → disarm, label `minions:needs-rebase`,
   `changes-requested`, position at the repair target; `work next` sorts it first; engineer brief with
   `conflictFiles`, `previousHead` and merge-not-rebase findings; reviewer brief with the resolution diff;
   `execution.maxRebaseCycles` (default 2) → `awaiting-human` with a held question; label cleared at delivery; not a
   repair cycle; publication reuses the PR; tests | depends: 2
4. **child: Digest and held questions** | criteria: `notify enqueue --hold digest` (via `next_attempt_at`);
   default holds per kind; `routine.digestAt` and `routine.timezone`; a digest wake in the routine pass (catch-up
   after a miss); `notify digest --json` composes the sections of decision 7 deterministically with numbered polls;
   the coordinator acks the covered keys; orchestrate prompt changes; tests with a fake clock | depends: 1
5. **child: Autonomous intake limits** | criteria: `intake.github.readyLabels` (host-owned) → imported `ready`;
   runtime-enforced caps on idea → ready for `agent-hypothesis` (`perDay`, `maxBudgetPercent`, `ownerSilentDays`,
   the `needs-owner` parent rule) with a clear refusal; auto-promotions in the digest; prompt rules; tests | depends: 4
6. **child: work advance** | criteria: `minions work advance <leaseId> --usage <n> --json` = record + the next claim
   + Agent parameters, or a decision payload; the orchestrate prompt uses it; baseline turns per stage before and
   after reported to the owner | depends: none
7. **child: Deterministic dispatcher (spike, then decision)** | criteria: a coordinator-run spike answers task-57
   U1 to U3 for `claude -p --agent`; a cost estimate from the baseline; an owner poll; only after a yes, a build task
   on the task-57 supervisor (launch argv, env and settings test, no Telegram, the correction resume, exception
   wakes) | depends: 6, task-57.1

Owner action, not a task: the [prerequisites](#owner-host-prerequisites-checklist), and turning on
`routine.enabled` after PR #1.

## Owner answers

Agreed 2026-10-27 (Telegram poll msg 320, answer msg 321 "1": every recommended default, a to g; msg 322: timezone):

1. Wake for newly runnable work during the day, within the caps.
2. Digest at 08:00 only; `routine.timezone` **Europe/Berlin**.
3. Wake = a fresh coordinator session started by the runtime (the README statement "the runtime never restarts the
   coordinator on its own" now holds only while `routine.enabled` is off).
4. Base updates without re-review when the merge is clean and CI passes again.
5. Flaky CI goes straight to repair (no `ci.rerun` for now).
6. Up to 3 auto-promoted ideas a day, listed in the digest.
7. Run the dispatcher spike (phase 7) after phase 6 (the one deterministic launcher is the agreed exception to the
   no-nested-claude rule).

Review findings for phase 1 (task-68.1 review, built in task-68.2): a wake never passes force; the crash start is a
separate path that refuses during a drain or an upgrade and starts only after a crash, never after an owner stop; the
runtime records the last owner message time (the Stop hook) for the 30-minute window; at 100% budget only the digest
wake is allowed (crash starts included); wake sessions are counted in the coordinator baseline (`wakes`, end
trigger `wake`).

Phase 1 as built (task-68.2): the pass runs as `minions sync --routine [--trigger clock|watchdog|manual] [--force]`
and `--last`; the wrapper clock runs it as a bounded child process (5 minutes) so a pass never blocks claude and
always reads the current config; the manager watchdog asks each running project every 5 minutes and the runtime runs
the pass only when the last one is older than 2 intervals; the routine lock is the meta row `routine_lock`; events
`routine`, `routine-wake` and `routine-crash-start` (schema 9 adds an `events(kind, at)` index); days are UTC
days until phase 4 adds `routine.timezone`.

### Phase 4 as built (task-68.5)

- **Holds** (`src/runtime/digest.ts`): `notify enqueue --hold digest|none|default` sets `next_attempt_at` to the next
  digest time (`digest`) or leaves it unset (`none`). A held row is one with `attempts = 0` and a `next_attempt_at`
  (a failed send always has `attempts > 0`), so no schema change. Without the flag the per-kind table applies:

  | Kind | Default | Why |
  | - | - | - |
  | `delivered`, `feature` | held | read, not acted on, today; the digest lists them with their links |
  | `question` | held | batched into numbered polls, one reply for all of them |
  | `goal-ack`, `status` | sent | the answer to an owner message: the owner is in the chat (a status the owner asked for is never held) |
  | `approval` | sent | a held approval would delay a publish or merge by a day |
  | `blocker`, `other` | sent | at the next wake that happens anyway, never a wake of its own |

  Default holds apply only while `routine.enabled` is on (without it there is no digest wake, so a hold would only
  delay) and not within 30 minutes of an owner message (the owner is in the conversation). An explicit
  `--hold digest` always holds until the next digest time.
- **Hold-back:** each routine pass and each `notify pending` move a held item whose time came on to the next digest
  time while the routine is on, so only the digest delivers it (a session awake at 08:05 does not send it alone).
- **Due and catch-up:** the latest digest time at or before now (`routine.digestAt` in `routine.timezone`, computed
  with `Intl` and no dependency, DST-safe) whose key `digest:<local YYYY-MM-DDTHH:MM>` is not delivered. A missed
  time is caught up at the first pass after it; only the latest time counts, so a host asleep for two days sends
  one digest. A digest wake counts: the next one for the same time comes after 60 minutes at the earliest (the
  woken session did not send it), at most 2 per time. The first pass after turning the routine on sends the latest
  time's digest. The routine's days (`maxWakesPerDay`, crash starts) are local days in `routine.timezone`; a daily
  budget (`spend.ts`) still counts UTC days.
- **Composition:** `minions notify digest --json` reads the outbox (every undelivered item), the backlog, the
  events (merged since the last digest, `awaiting-approval` merges, `auto-promote` events of phase 5), publications
  waiting for approval, the spend tally and `work next`. The text has fixed sections (merged; delivered, waiting
  for CI or merge; updates; waiting for you, with the exact `/approve` lines; blockers; auto-promoted; spend today
  with coordinator wakes and their tokens; next up; questions), sorted lines, and questions as polls: a question
  item's option lines (`1. …`, `- …`) become numbered options with "Other" last, answered as `Q1 2`. Lines that
  would exceed the Telegram limit are left out whole (`left`) and stay pending. The text is stored under the digest
  key (an undelivered row is replaced, a delivered one never touched); the coordinator sends it with one `reply`
  and acks `keys` (the digest key and every covered item), which marks the time done. `--status` shows the times,
  the last one and the held count; `minions status` shows the same line when the routine is on.
- **Budget:** at 100% only the digest wakes the coordinator (crash starts are refused too); wake sessions are
  measured coordinator sessions, so their tokens count in the spend tally and the budget.

## Open questions for the owner (answered above)

1. Wake policy: wake for newly runnable work during the day, within the caps (recommended), or the digest only
   (work found by the routine pass waits for the next digest)?
2. Digest times: 08:00 only (recommended), or 08:00 and 18:00? Which timezone?
3. Wake = a fresh coordinator session started by the runtime (recommended, cheaper after idle), or no automatic
   restarts (the routine pass only syncs and merges, and waits for you)?
4. Base updates without re-review when the merge is clean and CI passes again (recommended), or a reviewer after
   every update?
5. Flaky CI: allow one automatic re-run of failed jobs per head (`ci.rerun`; the token needs Actions write), or go
   straight to repair (recommended until a flake actually happens)?
6. Auto-promotion of my own ideas: up to 3 a day, listed in the digest (recommended), a different number, or never?
7. Run the dispatcher spike (phase 7) after phase 6 (recommended), or keep the coordinator in the stage loop?
