# Coordinator self-update from main (dev installs): design

Status: **approved (owner, 2026-10-29, TG 465)** (task-99 design against main @ c64b721, 2026-10-29). Phases 1 to 3
are built (`scripts/dev/self-update.mjs`; phase 3 in task-99.3), and phase 4 is the coordinator instruction in the repo's `CLAUDE.md` (task-99.4); the live check of phase 3 is open. The
build phases are in [Phases](#phases), and the former open questions are now [Decisions](#decisions).

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
  `minions --json settings requests` (a host verb that reaches the runtime through docker exec, `runtimeJson`,
  `src/host/change-requests.ts` ~462). `settings requests mark <id> --status <s>` is hidden and a **runtime verb**
  (`requireMode('runtime')`, ~833), and `notify enqueue` is also a runtime verb (`src/runtime/commands.ts` ~705). The
  host CLI cannot call either directly. It reaches them only by exec into the container (`recordApplyResult` does
  this). So a standalone script must run `docker exec` itself, and must handle the runtime not running (a
  PRECONDITION) as "wait and retry", never as a failure of the request.
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
- **Dev detection has two different checks.** `upgrade --rebuild-cli` tests the **project repo**
  (`isMinionsCheckout(repoPath)`), and the install kind decides the action in `checkCli`
  (`src/host/upgrade-source.ts` ~322): kind `packed` gives `reinstall`, a linked checkout gives `rebuild`. The
  manager's `/rebuild_cli` gate uses `devRebuildAvailable`, which tests `packageRoot()` of the *running* CLI, so it is
  false for a packed global install (it runs from `node_modules`). The script must not reuse it.
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

The script reaches the two runtime verbs (`settings requests mark`, `notify enqueue`) with its own `docker exec` into
the container, the same way the host CLI does. That exec is the host's own existing access. It gives the container no
new capability: the container still cannot call anything on the host, and the script takes no input from it other
than the request list it already reads.

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

**Refusals at start.** The script refuses to start unless all of these hold: the project repo is a minions checkout
(`isMinionsCheckout(repoPath)`) **and** the installed CLI kind is `packed` (the `reinstall` action in `checkCli`; not
`devRebuildAvailable`, which is false for a packed install and is what `/rebuild_cli` uses), delivery is `local`, the runtime is Docker, the install is
**packed** (so a backup is possible, see Decision 1), and the host checkout is on the base branch with a clean tree. Only one
instance runs at a time, held by the lock `<MINIONS_HOME>/dev-self-update/lock`.

### Trigger

Every 30 s the script reads `minions --json settings requests` and takes the oldest open `upgrade` request whose
`fromContainer` is `true` or the base branch. It ignores every other kind and leaves it to the manager or the
terminal. Taking a request means marking it `confirmed` with `settings requests mark`, run through the script's own docker exec.
If the runtime is not running, the script waits and polls again. The manager only offers
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
   fails, the request is marked `failed` and nothing is built. Only a typecheck or test failure (the step's own exit code) records the SHA as bad; a failed `git worktree add` or `npm ci`, a timeout, or a step that ends without an exit code of its own (a SIGKILL from outside, output over the script's 64 MB buffer, a spawn error) can be transient, so a new request tries that SHA again. Host main stays advanced to that SHA (the sync already moved it, and host branches only
   move forward), so the next request syncs and gates from that HEAD. A fix on main is therefore picked up normally.
4. **Keep the previous build.** Tag the current image as `<imageTag>-prev` (`docker tag`). The CLI backup is made by
   `applyCli` itself. A retry never replaces a known-good `-prev` with a bad image: `state.json` keeps the image the
   last `-prev` tag protects (`prevPin`) until a health check passes. While it is set, an apply whose current image is
   another one (a rollback that failed, a stop during the upgrade) leaves `-prev` as it is.
5. **Upgrade:** `minions upgrade --rebuild-cli` (a second run, so building the synced commits is allowed). This step
   drains, rebuilds the image, recreates the container and restarts the coordinator with `--recover`.
6. **Health check**, polled for up to 5 minutes (`--health-window`; a probe every 10 s). "Healthy" means all of the
   following, on two probes in a row with the same coordinator lock holder:
   - `checkCliHealth`'s checks pass, as the script's own fresh child processes: `minions --version` prints a version
     line and `minions --json status` an ok envelope;
   - the container (`docker compose ps -q app`, `docker inspect --format {{.Image}}`) runs the image ID that
     `<imageTag>` names after the upgrade (the new image, or the same one when the build fingerprint did not change);
   - in that host `status` envelope (verified in phase 3: `src/runtime/commands.ts`, the host branch of `status`),
     `data.restartRequired.state` is `current` (`src/host/restart-required.ts`: image label vs the installed build
     fingerprint, CLI version, credential mounts, coordinator launch fingerprint) and `data.coordinatorLaunch.state` is
     `current` (the tmux session runs, with the current launch fingerprint). `restartRequired` alone is not enough: a
     stopped coordinator gives no reason. This replaces a separate "build stamp" check;
   - when the coordinator has Telegram (`data.channel.effective` is `telegram`): `data.telegramPoller.state` is not
     `missing`, `dead` or `foreign`, and `minions --json doctor` has no `fail` for `telegram.plugin` or
     `telegram.poller`. Verified in phase 3: `status --check` and `doctor` are the same report (`runDoctor`); doctor
     only ever reports `telegram.poller` as `ok` or `warn`, so "not `fail`" alone would never catch a dead poller,
     which is why the script reads the poller state from `status` directly. Doctor runs only once the rest passes;
   - the coordinator does not restart more than once in the window: a third holder of the coordinator lock
     (`data.coordinatorLock`, pid and `acquiredAt`) is unhealthy at once, and a restart resets the two-probe count.
7. **Outcome.**
   - Healthy: mark the request `applied` with detail `self-update <old>..<new>`, and enqueue the owner notice
     (`minions notify enqueue --key self-update:<requestId> --kind status`; the new coordinator sends it). Both verbs run by the script's own docker exec. The kind is `status` because the outbox accepts only its fixed kinds and `status` is not held for the digest. The key is per request because a refused sync has no SHA and one SHA can get several requests. The text stays under the outbox limit (4000 characters): a long commit list is cut with "N more, see the log". If the runtime refuses the mark (an error other than "not running"), the outcome stays pending and later polls retry it, three times in all; after that it is logged as not marked (the request stays `confirmed`; mark it by hand), and the owner notice still goes out.
   - Not healthy, or `upgrade --rebuild-cli` failed: **roll back**. Reinstall the newest CLI backup the upgrade made
     (one that was not in `<MINIONS_HOME>/manager/cli-backup/` before it), as `installCliBackup` does
     (`npm install -g --no-audit --no-fund <backup>` from the backup directory, a regular file only, its sha256
     logged). No new backup means the upgrade did not replace the CLI, so there is nothing to reinstall. If the
     reinstall fails, the rollback stops there: a `start` on the new CLI would rebuild the image from the new code.
     The health check after such a stopped rollback runs only its two probes, not the whole window (nothing was
     restarted, so waiting cannot help), and the owner hears it sooner. A failed upgrade that made no new backup and
     left `<imageTag>` on the image it had replaced nothing: when two probes find the coordinator healthy on that
     image, nothing is rolled back or restarted (no `down` and `start`); otherwise the rollback runs as below.
     Then re-tag `<imageTag>-prev` as `<imageTag>` (after checking it still holds the kept image ID), run
     `minions down` and `minions start --no-attach` on the old CLI, and restart the coordinator with
     `coordinator restart --recover` through the script's own docker exec, as the upgrade itself ends:
     `start --no-attach` starts the coordinator only when it has Telegram. Then the health check runs again, on the
     kept image ID. Mark the request `failed` and send the notice through the restored coordinator. Only "not
     healthy" after a complete upgrade records the SHA as bad; a failed upgrade step (docker build, registry, drain)
     can be transient, so a new request tries that SHA again. Host main is not moved back, because host branches only
     move forward, so a failed gate or rollback leaves host main on the new HEAD, and the next request builds from it.
   - **No coordinator even after the rollback** (the second health check fails, Decision 3): the request is marked
     `failed` as above, and the owner is also told through the host manager bot: the script runs
     `minions --json manager notify` (hidden, host only) with the notice text on stdin, and the CLI reads the manager
     token itself (the script never sees it). An unpaired manager bot, or an old CLI without the verb, is logged
     (`manager-notice` in the log) and printed; nothing else happens.
   - **Verified in phase 3: the old image needs no rebuild.** `minions start` runs `ensureImage`, which rebuilds only
     when the image's `minions.build` label differs from `buildFingerprint(packageRoot())` of the running CLI: the
     sha256 of `dist/cli.js`, `docker/Dockerfile`, `docker/gh-wrapper.sh`,
     `docker/minions-sandbox/minions-sandbox.c` and `package.json` (`src/host/docker.ts`). The backup is a
     gzipped tar of the old install directory as it is (every entry under `package/`; `backupInstalledCli`), so it
     holds those five files byte for byte, and `npm install -g <backup>` writes them back unchanged (npm 10.9.9,
     tested in `test/host/cli-backup.test.ts`), so the reinstalled CLI has the fingerprint the old image was
     labelled with. If a future npm changed one of them, `start` would rebuild the image from the old CLI: slower,
     but still the old code. **Corrected in phase 3:** the backup was first `npm pack <install dir> --ignore-scripts`,
     which never worked on npm 10.9: npm runs the `prepare` script of a directory it packs even with
     `--ignore-scripts` (pacote's directory fetcher), and the installed package does not ship
     `scripts/prepare.mjs`, so every backup, and with it every reinstall, failed. `start` also regenerates the
     derived files (`compose.yaml`) on the old CLI (`refreshDerived` in `openProject`).
   - A bad SHA is not tried again. A later request whose `HEAD` is a different, newer commit is tried normally (a
     fix on main).

**Log and state.** `<MINIONS_HOME>/dev-self-update/log.jsonl` (mode 0600) gets one line per apply: request, from and
to SHAs, the `git log --oneline` range, the **sensitive paths touched** (`git diff --name-only` matched against the
project's `sensitivePaths`), each step with its duration, the health result and any rollback. `state.json` holds the
last applied SHA, the bad SHAs and the pinned `-prev` image. The owner notice gives the range, the sensitive paths, the outcome and the log
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

## Decisions

Answered by the owner in TG 465 (2026-10-29):

1. **Packed installs only.** The script refuses a linked (`npm link`) install, because a rebuild in place leaves
   nothing to roll back to.
2. **Trigger: the coordinator's request only.** The coordinator is also **proactive**: after a merge to main that
   brings a *meaningful* change, it requests an update itself, without waiting to be asked. "Meaningful" means a change
   to runtime, CLI or plugin behaviour. Docs-only and tests-only changes are not meaningful. This goes into the
   phase 4 instruction.
3. **No coordinator even after rollback:** the log, and **also the manager bot** when it is paired, notifies the owner.
   This needs a small hook from the script into the manager transport (phase 3).

## Phases

1. **Script skeleton and refusals.** Add `scripts/dev/self-update.mjs` with the start refusals, the lock, the log
   and state files, polling and taking requests (`mark confirmed`), idle detection, and `--dry-run` (print the plan
   only). The script runs `docker exec` itself for the runtime verbs and treats a stopped runtime as "retry". Test with a fake
   `minions` binary and a fake `docker` on `PATH` (including the runtime-not-running case). Add a test that `npm pack --dry-run` contains no
   `scripts/dev/`.
2. **Apply and gate.** Add the sync run, the host gate in a throwaway worktree, the previous-image tag,
   `upgrade --rebuild-cli`, outcome marking and the notice. Tests cover a gate failure (nothing built), a refused
   sync, and a bad SHA that is skipped.
3. **Health check and rollback.** Add the health definition above, the CLI backup reinstall, the image re-tag, and
   `down && start` on the old CLI. When no coordinator comes up even after the rollback, notify the owner through the
   manager bot too (Decision 3). Test it with fakes, then do one live check by the coordinator, with an
   intentionally broken commit on a scratch branch. Built in task-99.3 (all but the live check), with the hidden
   `minions manager notify` as the hook into the manager transport.
4. **Wire the trigger.** Add the coordinator instruction for the minions repo: request an update proactively after a
   merge to main with meaningful changes (runtime, CLI or plugin behaviour; not docs-only or tests-only), without
   waiting to be asked (Decision 2) (it touches `CLAUDE.md` or
   `.minions/**`, which are sensitive paths and need owner approval; built in task-99.4 as a section of the root `CLAUDE.md`). Add a short note in host-manager.md and
   bootstrap.md that says the Q3 and no-self-continuation rules for installed minions are unchanged.
