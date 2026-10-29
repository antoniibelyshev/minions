# Coordinator self-update from main (dev installs): design

Status: **proposed** (task-99 design against main @ c64b721, 2026-10-29). Nothing is built. The build phases are in
[Phases](#phases), and [Open questions](#open-questions-for-the-owner) has three questions.

Owner decisions so far:

- TG 459 (2026-10-29): "I want you to be able to update yourself with the new version of main."
- TG 461 (2026-10-29): **fully automatic**, sensitive-path ranges included, but **only for the minions project
  developing itself**. It is not a feature of installable minions.

Related: [host-manager.md](host-manager.md) (change requests, journal, Q3 `/rebuild_cli`),
[bootstrap.md, Upgrade from the container](bootstrap.md#upgrade-from-the-container) ("no self-continuation", trust of
`--rebuild-cli`), [cli-surface.md](cli-surface.md) (small CLI surface).

## Summary (for Telegram)

- A **host-side dev script**, `scripts/dev/self-update.mjs`, lives in the minions repo and is never shipped. The owner
  starts it once on the host. Stopping it is the kill switch.
- **Trigger:** the coordinator's existing `minions upgrade --from-container --reason …` request. There is no new
  command.
- **Apply:** the script waits until no worker is active, then syncs host main from the container and runs the gate
  (`npm run typecheck`, `npm test`) on the host for that exact commit. Then it runs `minions upgrade --rebuild-cli`,
  which rebuilds the CLI and image and restarts the coordinator with `--recover`. All of these steps already exist.
- **Safety:** the previous CLI and image are kept. If the new coordinator is not healthy within 5 minutes, both are
  rolled back. Each apply is logged, and the owner gets a message afterwards.
- **For normal installs nothing changes.** The container still cannot confirm anything on the host. The script is
  the owner's opt-in, and it is present only in a minions checkout.

## Facts from the code (main @ c64b721)

- **The request exists.** In the container, `minions upgrade --from-container [branch] --reason <text>` records an
  `upgrade` change request (`src/runtime/change-requests.ts`, payload `{ fromContainer }`). The host reads it with
  `minions --json settings requests`. The hidden runtime verb `settings requests mark <id> --status <s>` is what the
  host uses to report an outcome (`recordApplyResult`, `src/host/change-requests.ts`).
- **The apply steps exist.** `minions upgrade --sync-only` exports the container branches and fast-forwards host
  main to `minions/main` (strict fast-forward, clean trees, local delivery only). `minions upgrade --rebuild-cli`
  runs `cli` → pause → drain → files → image (rebuilt only when the build fingerprint changed) → recreate →
  workspace → origin → resume → `coordinator restart --recover`. After a reinstall it hands off to the new CLI in a
  fresh process (`MINIONS_UPGRADE_HANDOFF`). Commits that `--from-container` takes are never built in the same run,
  so syncing and building need **two runs**.
- **Rollback pieces exist, for packed installs only.** `applyCli` backs up a packed install before `npm install -g`
  (`<MINIONS_HOME>/manager/cli-backup/`, keeps the last 2). `installCliBackup` reinstalls a backup after checking its
  sha256, and `checkCliHealth` runs `minions --version` and `minions --json status` in fresh processes. A **linked**
  install is rebuilt in place, with no backup. `ensureImage` rebuilds the same tag, so the old image becomes
  dangling and nothing keeps it.
- **Dev detection exists.** `devRebuildAvailable` is true only when the host CLI runs from a minions source checkout
  and the project repo is minions. `/rebuild_cli` additionally needs local delivery and a clean checkout.
- **Packaging.** `package.json` `files` lists `dist templates docker schema install.sh README.md docs LICENSE`.
  `scripts/` is not in the list, so the npm package does not contain `scripts/dev/`. The image copies only
  `package.json`, `dist/` and `templates/` (`docker/Dockerfile`, `Dockerfile.dockerignore`). `scripts/` is part of
  the source fingerprint (`FINGERPRINT_DIRS`), so a change to the script counts as "the CLI differs". That only
  triggers a rebuild, which is harmless.

## Design

### Opt-in and trust boundary

The script **is** the opt-in. It is a plain Node script in the minions repo. The owner runs it on the host from a
terminal or as a user service (`node scripts/dev/self-update.mjs --project minions`), and nothing installs or starts
it. The container cannot start it either: it cannot run host processes, and it cannot write `<MINIONS_HOME>`.

Rules that stay the same, and must be stated as such in host-manager.md and bootstrap.md:

- For every install, the container can only *propose*. It cannot mint a host confirmation, and it never sees the
  manager token, the journal or the approval key. The script does not change this. It confirms nothing through the
  journal and accepts no token or nonce from the container. Its consent is the owner's standing decision, made by
  starting it on the host.
- `/rebuild_cli` keeps asking twice, `--rebuild-cli` stays an explicit flag, and "no self-continuation" still holds.
  The script runs every step as a child `minions` process, so a freshly built CLI always runs in a new process.
- **The script never re-runs itself.** It loads its own code once, at start. If a range changes
  `scripts/dev/**`, the new code lands on main, but the running loop keeps the old code. The notice then says
  "self-update script changed; restart it to use the new version". This keeps the kill switch and the loop's rules
  in the owner's hands.

**Refusals at start.** The script refuses to start unless all of these hold: the CLI is a minions checkout and the
project is minions (same rule as `devRebuildAvailable`), delivery is `local`, the runtime is Docker, the install is
**packed** (so a backup is possible, see Q1), and the host checkout is on the base branch with a clean tree. Only one
instance runs at a time, held by the lock `<MINIONS_HOME>/dev-self-update/lock`.

### Trigger

Every 30 s the script reads `minions --json settings requests` and takes the oldest open `upgrade` request whose
`fromContainer` is `true` or the base branch. It ignores every other kind and leaves it to the manager or the
terminal. Taking a request means marking it `confirmed` with `settings requests mark`. The manager only offers
`proposed` and `failed` requests, so it stops offering this one. The coordinator itself decides when to ask, for
example after a merge to main. For this project only, it does that through a line in the minions repo's own
instructions (see phase 4), not in the shipped coordinator template.

### Apply path

1. **Wait for idle.** Apply only when `minions --json status` shows no active lease, no drain and no open process
   run. Otherwise wait and check again on every poll. The upgrade's own pause and drain still cover a lease that
   starts in between: that worker commits `wip:`, and recovery dispatches it again.
2. **Sync:** `minions upgrade --sync-only`. The target is the new `HEAD`. If the sync is refused (divergence, dirty
   tree), the request is marked `failed` with the reason, and the script notifies the owner.
3. **Gate on the host, for this exact SHA.** Create a throwaway `git worktree add --detach` under the script's
   scratch dir, outside the checkout. Run `npm ci`, `npm run typecheck` and `npm test` there
   (`MINIONS_TEST_MAX_WORKERS=2`), then remove the worktree. Container evidence is not trusted for this. If the gate
   fails, the request is marked `failed`, nothing is built, and the SHA is recorded as bad.
4. **Keep the previous build.** Tag the current image as `<imageTag>-prev` (`docker tag`). The CLI backup is made by
   `applyCli` itself.
5. **Upgrade:** `minions upgrade --rebuild-cli` (a second run, so building the synced commits is allowed). This step
   drains, rebuilds the image, recreates the container and restarts the coordinator with `--recover`.
6. **Health check**, polled for up to 5 minutes. "Healthy" means all of the following:
   - `checkCliHealth` passes (fresh processes for `--version` and `status`);
   - the container runs the new image ID;
   - `minions --json status` reports the coordinator running, with the new build stamp in the runtime;
   - when Telegram is configured, the `telegram.*` checks of `minions --json status --check` are not `fail`, and
     the coordinator holds the bot poller;
   - the coordinator does not restart more than once in the window.
7. **Outcome.**
   - Healthy: mark the request `applied` with detail `self-update <old>..<new>`, and enqueue the owner notice
     (`minions notify enqueue --key self-update:<sha> --kind self-update`; the new coordinator sends it).
   - Not healthy: **roll back**. Reinstall the newest CLI backup with `installCliBackup`, re-tag `<imageTag>-prev`
     as `<imageTag>`, then run `minions down && minions start --no-attach` on the old CLI. The image label matches
     the old CLI, so nothing is rebuilt. Then mark the request `failed`, record the SHA as bad, and send the notice
     through the restored coordinator. Host main is not moved back, because host branches only move forward.
   - A bad SHA is not tried again. A later request whose `HEAD` is a different, newer commit is tried normally (a
     fix on main).

**Log and state.** `<MINIONS_HOME>/dev-self-update/log.jsonl` (mode 0600) gets one line per apply: request, from and
to SHAs, the `git log --oneline` range, the **sensitive paths touched** (`git diff --name-only` matched against the
project's `sensitivePaths`), each step with its duration, the health result and any rollback. `state.json` holds the
last applied SHA and the bad SHAs. The owner notice gives the range, the sensitive paths, the outcome and the log
path. Sensitive paths are reported, not gated (TG 461).

**Stopping.** Stopping between applies is clean. When stopped during an apply, the script forwards SIGINT/SIGTERM to
the child `minions upgrade`, which has its own handling (it resumes its pause, and the `upgrade.json` marker lets a
rerun finish). The script then exits. It does not start a rollback after a stop, and the request stays `confirmed`.
On its next start the script reports that request as interrupted and marks it `failed`, without running it again.

### Relation to the dropped host-runtime "dev mode"

TG 457/458 considered running the dev coordinator directly from the checkout in the host runtime, to make the loop
faster. That idea is dropped: dev installs stay on Docker, so the dev loop tests the same path users run. What makes
the loop fast:

- one sync run and one upgrade run, with no second container recreate;
- the image rebuilds only when the fingerprint changed, and the `dist/` layers are copied last, so the cache keeps
  the toolchain layers;
- the gate is the only slow step.

Target: under 10 minutes from request to healthy coordinator, most of it `npm test`.

## Open questions for the owner

1. **Packed install only** (recommended): the script refuses a linked (`npm link`) install, because a rebuild in
   place leaves nothing to roll back to. The alternative is to teach the script to pack a linked install before
   building. That is more code, and it depends on running `npm pack` on a checkout that has already moved forward.
2. **Trigger:** request only (recommended: the coordinator chooses the moment, and you can see it in
   `settings requests`). The alternative is to also self-update whenever `minions/main` moves after a sync.
3. **Owner notice if no coordinator comes up at all**, even after a rollback: the log only (recommended for the
   first version), or also the manager bot when it is paired (needs a small hook into the manager transport).

## Phases

1. **Script skeleton and refusals.** Add `scripts/dev/self-update.mjs` with the start refusals, the lock, the log
   and state files, polling and taking requests (`mark confirmed`), idle detection, and `--dry-run` (print the plan
   only). Test with a fake `minions` binary on `PATH`. Add a test that `npm pack --dry-run` contains no
   `scripts/dev/`.
2. **Apply and gate.** Add the sync run, the host gate in a throwaway worktree, the previous-image tag,
   `upgrade --rebuild-cli`, outcome marking and the notice. Tests cover a gate failure (nothing built), a refused
   sync, and a bad SHA that is skipped.
3. **Health check and rollback.** Add the health definition above, the CLI backup reinstall, the image re-tag, and
   `down && start` on the old CLI. Test it with fakes, then do one live check by the coordinator, with an
   intentionally broken commit on a scratch branch.
4. **Wire the trigger.** Add the coordinator instruction for the minions repo (it touches `CLAUDE.md` or
   `.minions/**`, which are sensitive paths and need owner approval). Add a short note in host-manager.md and
   bootstrap.md that says the Q3 and no-self-continuation rules for installed minions are unchanged.
