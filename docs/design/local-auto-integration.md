# Automatic local integration on approval: design

Status: **proposed** (task-82 design against main @ 35dd23b, 2026-10-29). Nothing is built. The owner must agree
before the build starts. The build phases are in [Phases](#phases), and the open points are
[Decisions for the owner](#decisions-for-the-owner).

Build: phases 1-4 are implemented (task-82.1 to 82.4); the surface decisions are recorded in
[bootstrap.md](bootstrap.md#automatic-local-integration-surface).

Owner request (TG 392/395, 2026-10-27): use `delivery.mode: local` instead of GitHub PRs, but merging an approved
branch must be **deterministic and done by the runtime**, with no coordinator steps.

Related: [coordinator-self-update.md](coordinator-self-update.md) (task-99: host gate, self-update trigger),
[bootstrap.md](bootstrap.md) ("CI-gated auto-merge", "Base update and derived approval"),
[agent-runtimes.md](agent-runtimes.md) (D3b process runs, reap rules), [cli-surface.md](cli-surface.md).

## Summary (for Telegram)

- When `minions work record` accepts the final approval in local mode, the task goes to **`merging`** and joins an
  **integration queue**. A runtime **integrator** process (hidden `minions work integrate`, started detached) takes
  one task at a time under a crash-safe lock.
- The integrator builds the merge **as a commit object only** (`git merge-tree` + `git commit-tree`, the hardened
  path that base-update.ts already uses). No checkout is ever in a half-merged state, so a crash or drain can never
  leave a `--no-commit` merge behind.
- It checks out that candidate in **`/workspace/integration`** (its own worktree, never `/workspace/repo`), runs the
  verification commands with a fixed configuration (2 test workers, 30 min per command, no secrets in env), and on
  green moves `main` with a **compare-and-swap**, then fast-forwards the coordinator's checkout. Task → `done`.
- On conflict or red: `main` is unchanged, the task goes to **`changes-requested`** with the failure as a repair
  finding, and the normal repair flow runs. Sensitive paths still need the owner's **signed approval** (task →
  `awaiting-human`, approve with `--merge` on the host or in the manager bot).
- No new top-level command. Status shows in `minions status`, the digest and outbox notices. In local mode,
  `minions work publish <task>` becomes "retry the integration".

## Facts from the code (main @ 35dd23b)

- **Today's local path.** On the last gate approval, `Scheduler.record` (src/runtime/scheduler.ts ~1424) sets
  `to = 'delivered'`, calls `backlog.closeTask(id, 'delivered')` and returns "delivered locally (export with minions
  export)". `publish()` (~1516) throws `PRECONDITION` in local mode. The merge itself is a prompt: `deliveryGuidance`
  (src/plugin/generate.ts ~161) tells the coordinator to check the head, `git merge --no-ff --no-commit`, run the
  verification, then commit or abort and send the task back. Profiles are keyed in the prompt only: project-owner
  merges, personal-work asks before each merge, supervised never merges. **Nothing in the runtime enforces the
  sensitive-path rule in local mode.**
- **The hazard is real.** While this design was written, `/workspace/repo` had a staged `--no-commit` merge of
  task-99.2 in progress. A coordinator crash, drain or context reset at that moment leaves the shared checkout
  half-merged, and every new lease worktree branches from that repository.
- **Statuses exist.** `merging` is already a `TaskStatus` (src/backlog/types.ts) and counts as in-flight
  (`IN_FLIGHT`, scheduler.ts ~46). `COMPLETED_STATUSES` (src/backlog/ready.ts) is `done` + `delivered`, so today a
  dependent task can start before its dependency is on `main`.
- **A hardened merge exists.** src/runtime/base-update.ts computes `git merge-tree --write-tree` and `commit-tree` in
  an isolated git dir (`withIsolatedRepo`, `MERGE_TREE_CONFIG`, `allowlistedGit`), and it refuses custom merge
  drivers and `merge=union`. None of it reads the checkout's config, index or attributes.
- **Approvals exist.** `signApproval`/`verifyAnyApproval` (src/core/approval.ts) bind (scope, task, exact head).
  Scopes: `publish`, `merge`. `minions work approve <task> --head <sha> --merge` is host-signed, and the manager bot
  offers the same (src/host/approvals.ts, change-requests.ts ~364). `PUBLICATION_CAPABILITIES`
  (src/config/capabilities.ts) are upgraded allow→ask on a sensitive path. There is no capability for a local merge.
- **Patterns for lock, records and reaping exist.** The supervisor lock is the meta row `supervisor_lock` {pid,
  start, bootId, at} (src/runtime/supervisor.ts). Process runs keep an O_EXCL record and are reaped by recorded
  identity, and a group is swept only while its leader still matches the record (task-100,
  src/runtime/runner/record.ts, supervise.ts). Drain is a DB row plus flag file (src/runtime/drain.ts).
  `scheduleDetachedRestart` (coordinator.ts ~1335) shows how to start a detached runtime process.
- **No shared deps.** Each lease worktree has its own `node_modules` (the worker runs `npm ci` in it), and
  `/workspace/node_modules` is empty. `verification.commands` here are `npm run typecheck` and `npm test`, which
  assume installed dependencies. There is no setup command in the config.
- **Host side.** `minions export` / `upgrade --sync-only` fetch container branches into `refs/remotes/minions/*`
  and fast-forward host `main` strictly (src/host/transfer.ts, upgrade-source.ts). Nothing pushes to GitHub in local
  mode.
- **The task-99.2 host gate** (branch `agent/task-99-2-…`, scripts/dev/self-update.mjs `runGate`): a throwaway
  `git worktree add --detach <sha>`, then `npm ci`, `typecheck` and `test` with `MINIONS_TEST_MAX_WORKERS=2` and a
  scratch `MINIONS_HOME`. A step that **fails** marks the SHA bad, while a timeout or setup failure counts as
  transient. The worktree is always removed.

## Design

### Switch and policy

- **On switch:** `delivery.merge: auto-when-eligible` now also applies to local mode (Decision 1). With `disabled`,
  local mode keeps today's behaviour during rollout: `delivered`, and the coordinator merges by hand.
- **Today that value is GitHub-only**, so reuse is not free. `autoMergeConfigReasons` (src/config/delivery.ts:17-29)
  always reports local mode unusable (needs pull-request + github, `requiredChecksConfigured`, `ciAuthority: github`,
  `pr.merge` not deny). Its result feeds `listUnavailable` (src/config/resolve.ts:34, "automatic merge is
  unavailable"), doctor `merge.readiness` (src/host/doctor.ts:189) and setup's autoMerge step (src/host/setup.ts:831-835,
  "delivery is local: not usable"). The descriptions in src/host/settings.ts:142-147 and src/config/setting-classes.ts:50
  say "pull requests" and "GitHub". All of these become **mode-aware**: in local mode the reasons are integration
  readiness (`base.merge` not deny, `verification.commands` non-empty); in PR mode they stay unchanged.
- **Policy:** a new capability **`base.merge`**: project-owner `allow`, personal-work `ask`, supervised `deny`. It is
  added to `PUBLICATION_CAPABILITIES`, so a sensitive path upgrades `allow` to `ask`. `deny` ends the task as
  `delivered` (the user integrates, as supervised does today).

### Trigger and queue

1. `work record` accepts the final gate approval in local mode with the switch on. The task goes to **`merging`**,
   and a `publications` row is written with `mode: local`, `head_sha: H`, `state: queued`. The response carries
   `publication: { mode: 'local', state: 'queued' }`. The integration becomes local mode's "publication", so the
   existing response, digest and approval code apply.
2. `record` then starts `minions work integrate` **detached** (setsid; the coordinator's tool call does not own it).
   Backstops: the coordinator wrapper's routine tick (every minute: queue non-empty and lock free → start it), and
   `coordinator restart --recover`. `minions work publish <task>` in local mode re-queues a task (used after an
   approval or a transient failure).
3. **Order:** oldest approval first, but a task waits while any of its dependencies is not `done`. `merging` and
   `delivered` no longer satisfy a dependency in local mode with the switch on, so dependents branch from a `main`
   that contains their dependency. A `merging` task does not count against `maxActiveTasks` (no worker runs for it).
   With `base.merge: deny` (supervised) the integrator never runs and tasks end `delivered`, so there the rule stays
   today's (`done` or `delivered` satisfies a dependency); otherwise dependents would never start. The user owns
   the integration order in that profile, as today.
4. The integrator handles the queue until it is empty, then exits. There is no resident daemon.

### Serialization and crash safety

- **Lock:** the meta row `integration_lock` {pid, start, bootId, at}, taken in one IMMEDIATE transaction. The holder
  counts as live only if its pid, start time and boot match and its command line is `work integrate`, the same rule
  as `supervisor_lock`.
- **Record:** a table `integrations` (task, head H, base B, candidate C, phase, attempt, verify process identity,
  started, ended, outcome, detail, log path). Phases: `queued → merging → verifying → landing → landed`, or one of
  `conflict | red | refused | awaiting-approval | transient | stopped`.
- **Recovery** (at integrator start, when the lock is stale): stop the recorded verify process group only while its
  leader still matches the record (task-100 rule), reset `/workspace/integration`, then:
  - `main` contains C (`merge-base --is-ancestor C main`): the crash came after the swap, and the coordinator or
    owner may have committed on top since. Finish as `landed` with `integration_base = C`; later commits are adopted
    as in "Where the merge runs" step 1.
  - otherwise: re-queue without counting an attempt. `main` was never touched.

### Where the merge runs

1. **Base:** B = `refs/heads/main`, which must equal the DB's `integration_base` (the last SHA the integrator landed
   or adopted). If `main` moved by a fast-forward outside the integrator (for example the owner merged by hand),
   adopt it with an `integration-base-adopted` event. If it is not a descendant (a reset or rewrite), **halt the
   queue** with a blocker notice. Fail closed.
2. **Candidate:** in the isolated git dir from base-update.ts: `merge-tree --write-tree B H`. A conflict ends the
   integration as `conflict` (with the conflicted paths). On a clean merge, `commit-tree <tree> -p B -p H` with the
   runtime identity, the subject `Merge branch 'agent/<slug>'` (as today) and the trailers `Minions-Task`,
   `Minions-Approved-Head`. C exists only as an object, so no ref and no checkout ever holds a half merge.
3. **Sensitive gate:** `git diff --name-only B C` (isolated) against `sensitivePaths`. A match, or `base.merge: ask`,
   needs a valid signed `merge` approval for (task, H). Without one, the phase is `awaiting-approval`, the task goes
   to `awaiting-human`, and the owner gets a notice with the full head SHA. Approval as in PR mode (host
   `work approve --merge`, or the manager bot), then `work publish <task>`. The approval binds H, not B, so a moving
   base does not invalidate it.
4. **Revert-of-revert check:** if `main` contains a revert of an earlier landed integration of this task (`This
   reverts commit <C_prev>`, with C_prev from `integrations`) and H does not contain a revert of that revert, the
   phase is `refused` and the task goes to changes-requested with "revert <revert-sha> on the branch first". The
   runtime never reverts `main` by itself: a revert is a normal task that goes through this same pipeline.

### Verification gate

- **One persistent integration worktree**, `/workspace/integration` (detached). It is outside `/workspace/repo` and
  outside the lease worktrees. Each run starts with `git checkout --detach --force C`, then
  `git clean -ffdx -e node_modules`, so the tree is exactly C. Dependencies are kept between runs and reinstalled
  only when the lockfile hash changes. The install step is the new `verification.setupCommands` (default `[]`; this
  project sets `npm ci`). If the worktree is missing or broken, it is recreated.
- Runs `verification.commands` in order after the setup, each `sh -c` in its own process group (supervise.ts semantics: SIGTERM,
  then SIGKILL after the kill grace).
- **Fixed configuration** (this absorbs task-81): an allowlisted env (PATH, LANG, TZ, `CI=1`,
  `MINIONS_TEST_MAX_WORKERS=2`, a scratch HOME, `MINIONS_HOME` and TMPDIR under `<state>/run/integration/`). It
  contains no coordinator or Telegram secrets. The timeout is `delivery.integrationTimeoutMinutes` per command
  (default 30). Workers keep running (Decision 3).
- A **failed** command means `red`, and the log tail goes into the note. A timeout or setup failure means
  `transient`: one automatic retry, then the task is `blocked` with a notice. This is the same split as the
  self-update gate. Flaky tests: Decision 2.
- The gate always runs, even when tree(C) equals tree(H). Worker evidence is self-reported, and the owner asked for
  a deterministic gate.

### Landing on `main` (checked out in `/workspace/repo`)

1. Re-check that `main == B`. If it differs, the phase is `transient` and the task is re-queued with no attempt
   counted (a new candidate against the new base).
2. If `/workspace/repo` has `main` checked out: `git merge --ff-only C` there (hardened env). Git refuses this when
   local changes or untracked files would be overwritten, so the coordinator's own edits are never lost. When the
   fast-forward is refused, the base is unchanged, the queue pauses with a notice ("checkout not clean"), and the
   tick retries. If `main` is not checked out anywhere: `git update-ref refs/heads/main C B` (compare-and-swap).
   A crash **during** `--ff-only` can leave the working tree partly updated while `main` still points at B.
   Recovery does not touch `/workspace/repo`; the doctor reports it (see below).
3. Record `integration_base = C`, phase `landed`. The task becomes `done` with the note "merged into main at C".

### Failure and the repair brief

On `conflict`, `red` or `refused`: `main` is unchanged, the task goes to
**`changes-requested`**, a repair cycle is counted (`maxRepairCyclesBeforeReplan` applies), and an `integration`
evidence row is written. The next engineer brief gets a `priorFindings` entry with `role: integrator` (the conflicted
paths or the failing command with its log tail, B and H) and `nextAction` "merge main into the branch, fix,
re-test". Re-review then runs as for any new head.

### Drain, pause and upgrade

- While starts are paused or a drain is active, the integrator starts no new integration.
- A drain **stops a running verification at once**: the group is killed, the phase is `stopped`, and the task is
  re-queued without an attempt. This is safe because nothing has touched `main`. Only `landing` (two git calls,
  under a second) is allowed to finish. `minions upgrade` waits for the lock to be free, as it waits for process
  runs.
- A running integration does **not** block a coordinator context reset, because it holds no lease.

### Self-update (task-99)

- **Trigger:** a landing writes an `integrated` event and one `integrated:<task>:<merge sha>` notice (kind `other`)
  with the changed paths (the first 20, then a count); a flaky landing also gets its flaky follow-up notice. For the minions project
  only, the coordinator instruction from task-99 phase 4 changes from "after you merge" to "after an `integrated`
  notice that touches runtime, CLI or plugin code, request `upgrade --from-container`, unless one is already open"
  (Decision 4).
- **Relation to the host gate:** the two gates are separate and both stay.
  - The integration gate runs in the container on the merged candidate **before** `main` moves. It keeps a bad
    merge off `main`.
  - The host gate runs on the host, on the synced SHA, **before** a rebuild. Container evidence is not trusted
    across that boundary.

  They share rules (2 test workers, fail vs transient, a detached worktree outside the checkout), but no code:
  the script imports nothing from `src/`. The script's idle check also treats a held `integration_lock` as busy.

### Status and notifications

- `minions status`: an `integration` block with the lock holder, the current task, phase and elapsed time, the
  queue (with waiting reasons: dependency, approval, pause), the last result and `integration_base`.
- `doctor`: a stale lock, a halted queue, and `/workspace/repo` not clean. The not-clean check names the case of a
  crash during `git merge --ff-only` (the `integrations` row is still in `landing` and the tree differs from `main`)
  and the fix: save any own edits, then `git checkout --force main` there.
- Digest: `merging` tasks and the last failures.
- Outbox notices: `awaiting-approval`, `halted`, `blocked`, and `red`/`conflict` (one line each, with the task).
  Landings appear in the digest and the coordinator's normal milestone report, not as their own messages.
- The coordinator prompt (deliveryGuidance) loses the manual steps. It says "delivered" until `done`, then "merged
  into main". It never merges, commits on or resets `main`, and it handles `awaiting-human` approvals as in PR mode.

### How `main` reaches GitHub

Unchanged: the host's `minions export` / `upgrade --sync-only` fast-forward host `main`. The owner pushes from the
host. Pushing from the container is out of scope (Decision 5).

## Risks

- **Kept `node_modules`:** `npm ci` deletes and reinstalls them, so the only risk is a stale install, and the
  lockfile-hash check covers that. A setup failure is `transient`, not red.
- **Verification runs reviewed but untrusted code.** It has the same trust as the tester stage. The integrator
  commits the tree it computed (C), never the worktree state after the tests, and the swap guards `main`.
- **Queue latency:** one `npm test` per task, about 5 to 10 min. Ten approvals in a burst take about an hour. That
  is accepted; batching is a later option.

## Decisions for the owner

1. **Switch:** reuse `delivery.merge: auto-when-eligible` for local mode, plus the new capability `base.merge`
   (owner allow / personal ask / supervised deny) (**recommended**: one merge switch for both modes, the smallest
   user-facing surface, and the profile rules become enforced policy). Cost: `autoMergeConfigReasons`,
   `listUnavailable`, doctor `merge.readiness`, setup's autoMerge step and two setting descriptions become
   mode-aware (see [Switch and policy](#switch-and-policy)); tests pin PR-mode behaviour as unchanged. Alternative: a
   separate `delivery.localIntegration` setting. It leaves the PR code untouched, but adds a setting, and two
   overlapping switches (`delivery.merge` would still say "not usable" in local mode).
2. **Flaky tests:** rerun a failed command once. A pass on the rerun lands, sends a `flaky` notice, and the
   coordinator files a follow-up (**recommended**: a flake does not cost a full repair cycle). Alternative: any red
   goes to changes-requested.
3. **Load:** bounded concurrency (2 test workers) and a 30 min per-command timeout, with workers continuing
   (**recommended**). Alternative: pause worker starts during each integration (more stable timing, slower
   throughput).
4. **Self-update trigger:** the coordinator instruction on `integrated` notices (**recommended**: keeps task-99's
   rule that this is dev-only and not shipped). Alternative: a runtime opt-in setting that records the request
   itself.
5. **GitHub:** no push from the container (**recommended**: the host's `export` stays the only way out).
   Alternative: an optional `git push origin main` after each landing (needs `git.push` and a credential in local
   mode).

## Phases

Ordered. Each phase is one task with a normal engineer, tester and reviewer pipeline. **owner** means the phase needs
an owner decision or approval first.

1. **child: Integration engine (library)** | criteria: `integrationCandidate(B, H)` in the isolated git dir (`MERGE_TREE_CONFIG`, driver refusal from base-update.ts) returns C or the conflicted paths; the sensitive diff `B..C`; the revert-of-revert check; `land(C, B)`: `--ff-only` in a checkout on `main`, else `update-ref` compare-and-swap, a dirty checkout refused with base unchanged; the merge subject and trailers; tests on temp repos (clean, conflict, custom driver, revert-of-revert, dirty checkout, moved base); nothing wired | depends: none (worker)
2. **child: Queue, lock, verify runner and recovery** | criteria: the `integrations` table (inline schema migration) and the `integration_lock` meta row with the supervisor's liveness rule; hidden `minions work integrate` (drains the queue, exits when empty); `verification.setupCommands` and `delivery.integrationTimeoutMinutes` registered with setting classes; the verify runner in the persistent `/workspace/integration` (reset and cleaned to exactly C, `verification.setupCommands` when the lockfile hash changes, process group, per-command timeout, allowlisted env, `MINIONS_TEST_MAX_WORKERS=2`, log tail); fail vs transient (one retry); pause and drain stop and re-queue; crash recovery (`main` contains C → landed, else re-queue; group swept only while its leader matches); tests with fake verification commands for crash, drain, timeout and red | depends: 1 (worker)
3. **child: Wire approval, policy and repair** | criteria: local approval with `delivery.merge: auto-when-eligible` → `merging` plus a `publications` row with `mode: local`, then a detached integrator start; the `base.merge` capability with profile defaults and the sensitive upgrade; `awaiting-approval` → `awaiting-human`; `work approve --merge` accepted for local; `work publish` in local mode re-queues; landed → `done`; failure → `changes-requested`, a repair cycle and a `priorFindings` entry with `role: integrator`; in local mode with the switch on and `base.merge` not deny, dependencies need `done` in both places that check them (`COMPLETED_STATUSES` in src/backlog/ready.ts and the `Scheduler` claim check at src/runtime/scheduler.ts:876), and `merging` does not count against `maxActiveTasks`; with `base.merge: deny` or the switch off nothing changes; `autoMergeConfigReasons` mode-aware (local: integration readiness reasons; PR: unchanged, pinned by tests), so `listUnavailable` no longer reports local auto-merge as unavailable; the `delivery.merge` descriptions in settings.ts and setting-classes.ts cover local mode; tests | depends: 2 (worker; **owner**: Decision 1)
4. **child: Surface, prompt and docs** | criteria: the `status` integration block, `doctor` checks (`merge.readiness` mode-aware, the crash-during-`--ff-only` case), setup's autoMerge step offered in local mode, digest lines and outbox notices as above; the routine-tick and `--recover` backstops; deliveryGuidance and integrationRule without manual merge steps (the coordinator never merges into, commits on or resets the base); the Decision 2 flaky rule; README, cli.md and bootstrap.md updated; prompt snapshot tests | depends: 3 (worker; **owner**: Decisions 2 and 3)
5. **child: Self-update link** | criteria: the self-update script's idle check treats a held `integration_lock` as busy (test with a fake `minions`); the task-99 phase 4 instruction reworded to the `integrated` notice (Decision 4; `CLAUDE.md`/`.minions/**` are sensitive and need owner approval) | depends: 4 (worker; **owner**)
6. **child: Live rollout on this project** | criteria: the switch is turned on here (a `.minions/**` change, owner approval); at least 3 landings, including one forced conflict and one forced red on scratch tasks, each with `main` unchanged and a repair brief; one drain during a verification re-queues the task; report the timings to the owner; then a poll on making it the default for project-owner local | depends: 5 (live run by the coordinator; **owner**)

No new top-level command: `work integrate` is hidden, and `work publish` / `work approve --merge` are reused
(cli-surface.md).

## Alternatives rejected

- **`git merge --no-ff --no-commit` in a checkout** (today's prompt). It leaves merge state on disk that a crash or
  drain can strand, and it reads the checkout's config and attributes. merge-tree plus commit-tree gives the same
  result with built-in drivers and no state.
- **Merging in `/workspace/repo`.** That checkout belongs to the coordinator and seeds every lease worktree. It only
  ever receives a fast-forward.
- **Running the integration inside `work record`.** It would block the coordinator's tool call for minutes and die
  with it.
- **Trusting the reviewer's checks instead of a gate.** That is not deterministic, and the tree differs from the
  reviewed tree whenever `main` moved.
