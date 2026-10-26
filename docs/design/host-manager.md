# Host manager for live setup changes: design

Status: **agreed** (task-53, design only, nothing built). Folds in task-44 (live settings). The owner answered the
open questions on 2026-10-26 (see [Owner decisions](#owner-decisions)). The build tasks are listed under
[Phases](#phases) and are filed as task-53.2 to task-53.8.

## Goal

Owner request (Telegram msg 238, 2026-10-23): the coordinator should be able to change the setup while it runs,
without the owner restarting the container by hand. Today every such change is a host-terminal job: `minions export`
and `minions upgrade --from-container` to sync the outer repo, `minions upgrade` for a new version, `minions settings`
for config, and `minions settings restart` for the coordinator.

Owner direction (poll, option 1): a **deterministic host manager**. It is a plain minions process on the host, not
a Claude agent. It has **its own Telegram bot**, separate from the coordinator's bot. It applies a change **only after
the owner confirms that change**. Nothing applies on its own.

## Decisions

1. **The manager is a thin, deterministic process.** It long-polls its own bot, reads requests from each registered
   project, asks the owner, and runs the existing host commands as child processes (`minions settings set`,
   `minions upgrade`, `minions settings restart`, `minions export`). It does not interpret free text and it has no
   model. Every apply path it uses already exists and is tested. The manager adds only routing, confirmation and a
   journal. A child process also means that a CLI the manager just reinstalled runs in a fresh process (the
   "no self-continuation" rule in [bootstrap.md, Upgrade from the container](bootstrap.md#upgrade-from-the-container)).
2. **One manager per host, one manager bot per host.** It serves every registered project, and the owner picks the
   project with `/project <name>`, or by tapping a request that already names it. One bot per project would double
   the bots and the pairing work for no gain in isolation: all projects already share one host user and one
   credential store.
3. **The container can only propose.** In the container, the commands that change the setup no longer fail with "host
   only". They record a **change request** in the runtime DB, the same way `work approve` changes its behaviour by
   where it runs ([bootstrap.md, Host-signed publication approvals](bootstrap.md#host-signed-publication-approvals))
   and like `config roles propose` ([roles-and-workflows.md](roles-and-workflows.md) D2). No new container command
   is needed.
4. **Security-relevant settings are host-owned.** A container request for one of them is refused when it is
   recorded, and refused again by the manager. Only the owner changes them, from the host (see
   [Host-owned settings](#host-owned-settings)).
5. **Every change is confirmed and bound to its exact content.** A confirmation covers one request digest, the config
   revision it was computed against, and an expiry. If anything changed in between, the owner is asked again.
6. **The terminal stays the baseline.** Everything the manager does stays available as the same host command. When
   the manager is down, nothing is lost: requests wait in the runtime DB, and `minions status` lists them.

## Trust boundary

```
host (owner's user)                                   project container (untrusted for setup changes)
──────────────────────────────────────                ─────────────────────────────────────────────
credential store: GitHub, coordinator bot,            /state/minions.db  (writable by agents)
  manager bot token, approval signing key               change_requests rows ── proposals only
minions manager  ⇄ api.telegram.org (manager bot)     /opt/minions/config (ro bind: runtime config,
  │ docker compose exec app minions … --json ───────►    approval public key)
  │ (reads requests, runs restarts)                   /opt/minions/secrets (ro bind: GitHub +
  └─ child: minions settings | upgrade | export         coordinator bot tokens; never the manager's)
     writes config.local.json / .minions/config.json  coordinator ⇄ api.telegram.org (coordinator bot)
```

- **Host privileges.** The manager runs as the owner's host user. It can write project config, rebuild images,
  recreate containers, move host branches and reinstall the CLI. Those are exactly the actions it must never take on
  the container's word alone.
- **Container privileges, unchanged.** The container can write `/state` (so it can write change requests, but also
  forge or edit them) and it can read the GitHub and coordinator-bot tokens. It cannot read the host credential
  store, the manager token, the host journal or the host config files. The config dir is a read-only bind.
- **What a request carries.** A request is a claim, never an authorization. The manager re-reads it through
  `docker compose exec`, re-validates it against the **host's** config (`resolveEffective`), and recomputes the diff
  and the "what this loosens" text itself (`SettingDef.loosens`, `src/host/settings.ts`). The owner sees the
  manager's text, not the container's. The request's free-text `reason` is shown as quoted, untrusted text, cut to
  300 characters.
- **The authority is the owner's tap, on the host.** For publication approvals the container verifies, so the host
  signs with a key the container cannot reach (Ed25519, `src/core/approval.ts`). For setup changes the host is both
  the issuer and the enforcer, so no signature is needed. The same properties hold in another form: the change is
  bound to its exact content (digest plus config revision, like approvals bind the task plus the exact head SHA), it
  expires (30 minutes, against 7 days for approvals, because a setup change is applied right away), and it can only
  come from a party the container cannot reach (the owner's Telegram account, through a bot token that only the host
  holds). The container cannot mint a confirmation: it has neither the manager token nor write access to the host
  journal.
- **Host runtime** (`runtime: host`, no container). Requests live in the host runtime DB and agents run under the
  Claude Code sandbox. The boundary is that sandbox's `denyRead` on the credential store, which the manager token
  joins. That is weaker, as it already is for approvals, and the docs say so.

## How requests reach the manager

**From the coordinator (proposals).** In the runtime, `minions settings set <key> <value> --reason <text>`,
`minions upgrade [--from-container]` and `minions settings restart` record a row in a new `change_requests` table
in `/state/minions.db`: `{id, kind, payload, reason, createdAt, status}`, with status
`proposed | confirmed | applied | failed | rejected | expired`. Recording validates the request against the runtime
config and refuses host-owned keys (CONFLICT, with a message telling the coordinator to ask the owner instead). The
coordinator then tells the owner in its own chat that a request is waiting. It never says that the change was made.

The manager polls each running project every 20 s with `docker compose exec app minions settings requests --json`,
the existing delegate mechanism (`src/host/delegate.ts`). Each exec has a timeout (30 s) and an output cap (256 KiB);
anything over either is dropped and reported as a project error, since the output is untrusted. It gets no new mount and no host-visible file under
`/state`. A file queue on a host bind mount was rejected: it would be the first host path the container can write.

**From the owner (manager chat).** The manager accepts a fixed set of commands and ignores everything else (it replies
with the help text):

| Command | Does |
| - | - |
| `/status` | Per project: running, coordinator, active leases, restart-required (task-3.4), pending requests |
| `/requests` | Pending requests, each with Confirm / Reject buttons |
| `/set <key> <value>` | Same model as `minions settings set` (validation, layer, loosening text), then the confirmation |
| `/sync` | Outer repo sync (see [Change kinds](#change-kinds)) |
| `/upgrade` | `minions upgrade` with a dry-run plan as the confirmation text |
| `/restart` | Graceful coordinator restart |
| `/undo <id>` | Proposes the inverse of an applied config change (confirmed like any change) |
| `/project <name>` | Picks the project for the commands above when several are registered |

An owner command goes through the same confirmation as a coordinator proposal. Typing `/set` is not consent to the
diff the manager computes from it.

## Confirmation model

1. The manager builds the **plan**: kind, project, exact diff (`key: from -> to`, layer and file), apply class (see
   [Settings classification](#settings-classification-task-44)), what it loosens, what will be interrupted (a coordinator
   restart; active-lease counts are shown to the owner but kept out of the digest, as they change every poll), and the steps for an upgrade (`upgrade --dry-run --json`).
2. `digest = sha256(canonical plan JSON)`. The manager stores `{requestId, digest, configRevision, nonce, expiresAt}`
   in its host journal (`<MINIONS_HOME>/manager/journal.jsonl`, 0600) and sends the plan with inline buttons
   `Confirm` / `Reject`. The `callback_data` is `c:<requestId>:<nonce>` (a 128-bit random nonce, within the
   64-byte limit).
3. On a tap, the manager checks every point and refuses if any fails: the sender is the paired owner id, in the
   private chat; the nonce is the one in the journal and is still unused; the offer has not expired; the digest it
   recomputes now is unchanged; the project's `configRevision` is unchanged. A refusal replies with the reason and
   sends a fresh offer.
4. It journals `confirmed` (this consumes the nonce), edits the message to "Applying…", runs the child command,
   journals the result, and sends a **new** message with the outcome, so the owner's phone notifies.

**Replay.** The nonce is single-use. Checking it and recording `confirmed` happen as one step under the manager lock,
so a double tap, a redelivered callback or a manager restart cannot apply a plan twice: a second tap finds the nonce
spent and only answers "already handled". The manager persists its `getUpdates` offset (in the journal directory) so a
restart does not replay old callbacks.

**Apply from the journal, not from the container.** The manager applies the plan it stored in its own journal, the one
the digest covers. It never re-reads the container's request row at apply time, since a forged or edited row could
differ from what the owner saw. The container's row is only a trigger, and its status is updated afterwards.

Nothing applies without step 3. That includes tightening changes, rejects of stale requests (they are only marked
expired) and restarts. Read-only commands (`/status`, `/requests`) need no confirmation.

**Loosening and code-execution changes ask twice.** A plan that loosens policy (any non-null `loosens`), or that
builds and installs a CLI on the host, gets a second message that names the risk in one line ("agents may push
branches to GitHub", "runs build scripts from 3 commits made in the container on your host"). It needs a second
tap within 2 minutes. This is the Telegram form of the existing terminal confirmation for loosening settings.

## Change kinds

| Kind | Runs | Notes |
| - | - | - |
| Config edit | `minions settings set <key> <value> --yes` | Validated before writing, atomic, refused if the revision changed since the plan (`--expect-revision`), `configRevision + 1`, derived files regenerated (`src/host/config-write.ts`). Then it follows the key's class: `live` done; `restart` offers a restart; `recreate` offers an upgrade (both confirmed separately). |
| Coordinator restart | `minions settings restart` | The existing graceful path (`coordinator restart --recover`). It is refused while leases are active, and the manager then offers **Restart when idle** (queued, re-checked every poll, run at the first idle moment) or **Drain now** (`pause --starts --drain`: workers commit `wip:` and hand back, recovery re-dispatches). |
| Outer repo sync | `local` delivery: `minions upgrade --from-container` source phase only (export, strict fast-forward of the host base). GitHub delivery: fetch `origin/<base>` and fast-forward. | Never forces, resets, stashes or checks out. Refused on a dirty host tree or a divergence, with the reason. |
| Upgrade | `minions upgrade [--from-container] [--rebuild-cli]` | Pause, drain, image, recreate, workspace and origin setup, resume, coordinator recovery: unchanged. A CLI rebuild from commits that came from the container is its own request, and a **dev-only** one: it exists only when the host CLI runs from a minions source checkout and the managed project is minions. Normal installs do not register, advertise or accept it. Its plan shows `git log --oneline <from>..<to>`, the diffstat and any sensitive paths touched, and it always asks twice (see [Owner decisions](#owner-decisions) Q3). |

Out of scope: secrets (`minions auth …` stays a terminal job: tokens never pass through Telegram), pairing changes,
`uninstall`, and any `docker` command outside `minions upgrade`.

## Settings classification (task-44)

Classes: **live**: the runtime reads the regenerated `runtime/config.json` on its next command or claim. The
coordinator's prompt text catches up at its next restart, which the manager mentions but does not force.
**restart**: baked into the generated prompt, the plugin or the coordinator launch arguments, so the graceful
coordinator restart applies it. **recreate**: compose, the image or mounts, so `minions upgrade` applies it (the
container is recreated, volumes kept). **fixed**: identity or derived; change it with `minions setup`, not here.
**H** marks host-owned keys: the container can never propose them.

| Key | Class | Reason |
| - | - | - |
| `execution.maxActiveTasks`, `maxEngineers`, `maxByRole`, `maxRepairCyclesBeforeReplan` | live | Enforced by `work claim` / the scheduler on each call |
| `execution.attemptMaxTurns` | restart | Written into the agent definitions (plugin) |
| `coordinator.contextReset.*` | live | Read by `context-reset.ts` on each check |
| `verification.commands`, `qaLabels`, `ciPendingTimeoutMinutes` | live | Briefs and the CI gate read them per lease |
| `budgets.*` | restart | Prompt text only (not enforced in v0.1) |
| `intake.github.*` | live | `minions sync` and coordinator startup read them per run |
| `intake.scope.*`, `intake.sources` | live | Backlog readiness filter per call |
| `communication.progress` | restart | Prompt text |
| `models.default`, `allowed`, `selection`, `effortByRole` (workers) | restart | Agent definitions and prompt |
| `models.coordinator`, `models.effort`, `effortByRole.coordinator` | restart | Coordinator `--model` / `--effort` |
| `coordinator.toolSearch` | restart | Coordinator `--settings` env |
| `git.identity` | recreate | Applied only by workspace setup (`src/runtime/workspace.ts:50`) during install, upgrade or start, not by `settings restart`. The manager offers `minions upgrade` (workspace setup is one of its steps), confirmed separately |
| `communication.channel` | restart, **H** | Coordinator `--channels`. It decides who can steer the coordinator |
| `capabilities.*`, `sensitivePaths`, `architecture`, `intake.startReady` | restart, **H** | Policy and approvals (prompt plus runtime gates) |
| `delivery.*`, `verification.testerRequired`, `reviewerRequired`, `ciAuthority` | restart, **H** | What reaches GitHub, and with which checks |
| `coordinator.permissionMode`, `disallowedTools`, `bundledSkills`, legacy `permissionMode` | restart, **H** | Coordinator permissions |
| `roles`, `workflows`, `harnesses` | restart, **H** | Tools, edit scopes and process harnesses. Roles keep their own propose/apply path (`config roles`) |
| `container.cpus`, `memoryMiB`, `pidsLimit`, `tmpSizeMiB` | recreate | Compose resource limits |
| `container.network`, `publishPorts`, `mountHostRepository`, `mountDockerSocket` | recreate, **H** | Isolation of the container |
| `schemaVersion`, `configRevision`, `projectId`, `packageVersion`, `profile`, `visibility`, `backlog.*`, `git.baseBranch`, `container.required`, `container.workspace`, `execution.oneActiveStagePerTask` | fixed | Identity, literals or derived. Changing them is a re-setup |

The build task adds the `recreate` class to `SettingApply` (today `live | prompt | launch`, with `prompt` and `launch`
both meaning restart here), a `hostOwned` flag on `SettingDef`, and a guard test that fails when a schema key has no
class. The guard test also checks each class against the code that applies the key.

Built in task-53.2: the table lives in `src/config/setting-classes.ts` (`KEY_CLASSES`; an entry covers its subtree,
the most specific wins). `test/setting-classes.test.ts` walks `MinionsConfigSchema` and fails on an unclassified or
stale key, checks every `settings` item against the table, and checks that every `prompt` item changes the generated
plugin. `settings set` reports `takesEffect` (`now` / `restart` / `upgrade`).

Task-53.9: the compose limits come from `project.json` `container` (written by install / setup). The `files` step of
`minions upgrade` (`refreshForUpgrade`, `syncContainerLimits` in `src/host/install.ts`) now copies
`container.cpus`, `memoryMiB`, `pidsLimit` and `tmpSizeMiB` from the effective config into `project.json` before it
regenerates compose, so the recreate uses them. They are the `recreate` items of the Container group. Chosen over
reading the config at compose time so `project.json` stays the one record that compose, `doctor` and the install plan
read. `minions start` does not sync: a new limit waits for the upgrade the setting announces. `container.network` and
`publishPorts` (host-owned isolation) are not copied and are not settings items: they stay with `minions setup`.
`git.identity` (no single-value setting type yet) is left to `minions setup` for now.

### Host-owned settings

Host-owned keys are writable only by `minions settings` in the host terminal, or by an owner-initiated `/set` in the
manager chat, with the double tap (see [Owner decisions](#owner-decisions) Q2). They are refused when recorded in the runtime, refused by the
manager for any request from the container, and never present in a writable file the container can reach. That
matches task-44's criterion "Security-relevant settings (policy, permissions, sensitive paths, approvals) stay
host-owned and are never writable from the container". Approvals stay host-signed: `/approve <task> <sha>` in the manager chat
runs the host's `work approve`, so the signing key never leaves the host (see [Owner decisions](#owner-decisions) Q5).

## Failure and rollback

- **Config edits.** Validated before writing and written atomically, so a failed edit changes nothing. Before every
  write the manager saves the previous file as `<project dir>/config-history/<revision>.json` (last 20 kept).
  `/undo <id>` proposes the inverse diff. It applies only while the config is still at the revision the change wrote
  (compare-and-swap). Otherwise it shows the drift and stops.
- **Restart.** The restart is either refused, which leaves the old coordinator running, or it relaunches and reports
  `running` only once the new wrapper holds the lock (bootstrap.md, coordinator lock). If it fails, the manager
  reports the error and offers **Retry**. It never tries a second strategy on its own.
- **Upgrade.** The semantics stay as they are: a failure before the recreate resumes starts and keeps the running
  container, and after the recreate every remaining step is still attempted and reported. The marker in
  `upgrade.json` makes a rerun finish the job. The manager's outcome message includes the failed step and offers
  **Rerun**.
- **CLI reinstall.** Before `npm install -g`, the packed tarball of the current install is kept in
  `<MINIONS_HOME>/manager/cli-backup/` (last 2). If the new CLI fails `minions --version` or a status call, the
  manager offers **Roll back CLI** (reinstall the backup, confirmed).
- **Sync.** Fast-forward only, so there is nothing to undo on the host branch beyond the reflog. The outcome names
  the old and new SHA.
- **Manager crash or restart mid-apply.** A journal entry left in `confirmed` or `applying` is reported as
  "interrupted, state unknown" when the manager starts. It is never resumed automatically: the owner re-runs or
  rejects it.
- **The manager upgrading itself.** After a CLI reinstall the manager finishes the current child, reports, and exits
  with a distinct code, and its supervisor starts it again on the new CLI.

## Token isolation for the manager bot

- **Credential kind `manager-bot-token`** in the host store (`src/host/credentials.ts`: Keychain service
  `minions.manager`, Secret Service, or `<MINIONS_HOME>/credentials/manager/manager-bot-token` 0600). Same entry
  rules as `auth telegram`: hidden prompt or `--stdin`, format check, optional `getMe`.
- **Never materialized** under `projects/<id>/secrets/` (the directory bind-mounted into containers), never in compose
  env, argv, config, logs or `--json`. Only the manager process reads it, and it holds it in memory.
- **Two bots, never the same one.** Setup refuses a manager token whose bot id equals any project's coordinator bot
  id, and `auth telegram` refuses the reverse (extends `src/host/bot-guard.ts`). Doctor checks both.
- **Single poller.** Telegram allows one `getUpdates` consumer per token. The manager takes
  `<MINIONS_HOME>/manager/lock` (`{pid, start}`, the same reuse-safe rule as the coordinator lock). A second manager
  refuses with CONFLICT. A `409 Conflict` from the Bot API is reported as "another process polls the manager bot".
  No container process ever has the token, so the task-51 class of takeover cannot happen.
- **Owner-only access, paired in the terminal.** `minions setup` shows a one-time code, and the owner sends it to the
  manager bot within 10 minutes. The manager records that sender's numeric user id and private chat id in
  `<MINIONS_HOME>/manager/access.json` (0600). From then on, updates from anyone else are dropped without a reply.
  Re-pairing is a terminal action only. No group chats.
- **Transport.** The manager calls the Bot API directly with `fetch` (`getUpdates` long poll, `sendMessage` with
  `reply_markup`, `answerCallbackQuery`, `editMessageText`). It adds no dependency and does not use the Claude
  plugin. Because this is our own code, the inline buttons that [telegram-decisions.md](telegram-decisions.md) has
  to work around in the plugin are available here directly.

## CLI surface

No new primary command. The proposed folds:

- `minions setup` gains an optional **manager** step: token, pairing and installing the supervisor service. Rerunnable.
- `minions status` shows the manager (running, bot id, paired, last poll) and pending change requests per project.
  `status --check` adds `manager.*` checks that never fail doctor.
- `minions settings requests [--json]`, plus `settings apply <id>` / `settings reject <id>` on the host: the terminal
  route for the same requests (`apply` uses the same plan and confirmation, interactive or `--yes`).
- In the runtime, `settings set`, `settings restart` and `upgrade` record requests instead of failing.
- The process the supervisor starts needs an entry point. This is the hidden `minions manager run` (see
  [Owner decisions](#owner-decisions) Q1).

## Phases

Built in task-53.3 (phase 2): the `change_requests` table (runtime DB schema 8, `src/runtime/db.ts`), recording in the
runtime (`src/runtime/change-requests.ts`), and the host route (`src/host/change-requests.ts`: plan, digest, offer and
confirmation; `src/host/change-journal.ts`: the journal, its lock and the 30 minute expiry). `settings apply` without a
terminal and without `--yes` only offers the plan; `--confirm <digest>` applies it. A newer request for the same thing
(same kind; for config-set the same key) expires the older one. A `failed` request stays open (it can be applied again or
rejected). Local-layer writes (config.local.json) do not bump `configRevision`, so `--expect-revision` detects changes of
the project config; the plan digest (which covers the `from` value) catches a local edit in between.

Built in task-53.4 (phase 3): the manager core in `src/host/manager.ts`, entry point the hidden internal-tier
`minions manager run`. Decisions made there:

- **Transport interface.** `ManagerTransport` has three methods: `sendOffer(offer)`, `receive(waitMs, signal)` (returns
  `confirm` / `reject` events, each naming a request id and the offer's nonce) and `sendOutcome(outcome)` (applying,
  applied, failed, refused, rejected, already-handled, interrupted, error). The offer carries the host's plan text, a
  one-line summary, the digest, the expiry and `loosens`. The transport owns everything Telegram-specific: the owner
  check, the buttons, editing a message to "Applying…", and the double tap for a plan with `loosens`. The core trusts
  only the nonce, never the event's wording. Until phase 4, `manager run` uses a log transport (JSON lines on stdout,
  no events): the printed `settings apply <id> --confirm <digest>` confirms from the terminal against the same journal.
- **Loop.** A single sequential loop: the startup report, then every 20 s a poll of every registered project, with the
  transport's events handled one at a time between polls. Because nothing runs concurrently, a long apply delays the
  next poll. An error in one project is reported once per distinct message and does not stop the others. A stopped
  runtime is skipped quietly.
- **Polling.** The delegate runs `minions settings requests --json` in the runtime with captured output
  (`delegateCapture`, `src/host/delegate.ts`), 30 s timeout and 256 KiB cap (`run()` gained `maxOutputBytes`). The
  manager drops a timed-out or oversize answer, whatever the delegate returned. Malformed rows are ignored and
  reported once. A request is offered when the journal has nothing for it or its newest entry is `failed`: that fresh
  offer is the retry or rerun. A pending offer is not repeated, except when sending it failed.
- **Confirm and apply.** `confirmOffer` (shared with `settings apply --confirm`) runs the nonce, handled, expiry,
  revision and digest checks and appends `confirmed` as one step under the journal lock. An expired, revision or digest
  refusal sends a fresh offer if the request is still open. Then the manager appends `applying` (with the command) and
  runs the child `minions --json <argv>`. `planArgv` builds that argv from the journal's plan and request snapshot, and
  the plan's `steps` text is the same argv, so the digest covers exactly what runs. Upgrades run through the existing
  `childUpgrade`. The outcome is journaled and the row marked (`recordApplyResult`).
- **Interrupted entries.** `confirmed` and `applying` entries record the writer's pid and process start time. At
  startup, a request whose newest entry is one of them, written by a process that is gone, is reported as
  "interrupted, state unknown". It is closed as `failed` in the journal and the row, and never re-run: the next poll
  offers it afresh, and the owner confirms it again (re-run) or rejects it. An entry of a process that still runs, for
  example a terminal `settings apply`, is left alone.
- **Lock.** `<MINIONS_HOME>/manager/lock` holds `{pid, start, at}`, taken with `O_EXCL`. A live holder makes a second
  manager fail with CONFLICT. The lock of a dead or reused pid is taken over. The lock is released on exit.
- **Dry run outside the journal lock (task-53.11).** Other journal writers (`settings reject`, offers, outcomes, the
  manager) wait at most 10 s for the journal lock, and `minions upgrade --dry-run` can take longer. So for an upgrade
  `confirmOffer` first checks spent, handled and expiry without the lock (an early refusal, advisory only), then runs
  the dry run without the lock (`upgradeDryRun`). Under the lock it checks spent, handled and expiry again and
  rebuilds the plan from the journaled request with that dry run: `configRevision` and the delivery check are read
  again there (cheap), and the digest is compared as before. The nonce check and the `confirmed` entry stay one
  step, so replay protection is unchanged. A config change, reject or second confirmation during the dry run is still
  refused (`details.refusal` revision, handled or spent). Only the upgrade dry run moves out of the lock. Config-set
  and restart plans are cheap and are still built entirely under it.

Built in task-53.5.1 (phase 4, part 1): the manager-bot-token, the bot-id guard, terminal pairing and the doctor
checks. The Bot API transport, the commands and `/approve` are task-53.5.2 to task-53.5.4. Decisions made here:

- **Host-wide store account.** The stores stay keyed by an account. `MANAGER_CREDENTIAL` (`src/host/credentials.ts`)
  has the fixed account `manager` instead of a project UUID. A store accepts that account only for that kind, and a
  project kind never accepts it. So the file store path is `credentialStoreFile('manager', 'manager-bot-token')` =
  `<MINIONS_HOME>/credentials/manager/manager-bot-token` (0600 in a 0700 directory). The Keychain item is service
  `minions.manager`, account `manager`. The Secret Service item has the same attributes. Store selection is the same
  as for the other kinds (the file store whenever a host-runtime project exists).
- **Not a project credential.** The kind is not a `CredentialKind` and is not in `CREDENTIAL_KINDS`, so
  `materializeSecrets` and `clearSecrets` never see it. The Keychain-to-file move (`moveKeychainTokensToFileStore`)
  handles it separately from that reference file, so a host-runtime project also moves it to the file store. The
  type system keeps it out of
  `readToken` / `materializeSecrets`. Its non-secret reference (backend, locator, bot id) is
  `<MINIONS_HOME>/manager/credential.json` (0600), never a project's `credentials.json`. `readManagerToken` refuses a
  stored value whose bot id differs from that reference, so the guard cannot be bypassed by swapping the stored token.
- **Guard placement.** `assertManagerBotDistinct` (`src/host/bot-guard.ts`) refuses a manager token whose bot id is
  the stored Telegram bot of any registered project, including the project being set up. The reverse,
  `assertNotManagerBot`, runs inside `provisionTelegramToken`, so `auth telegram`, `setup` and `init` are all covered
  by one check. It lives in `credentials.ts` (bot-guard imports credentials, not the other way round) and bot-guard
  re-exports it. If the manager reference cannot be read, the check refuses (fail closed). The bot id is the numeric
  token prefix, so no network call is needed.
- **Entry.** `minions setup` has an optional `manager` step after the agents step. It offers keep / change / pair /
  remove when a token is stored, and asks "Set up the host manager bot?" (default no) when none is. The token comes from
  the hidden prompt or `--manager-token-stdin`. The stdin lines come in the order github, telegram, manager, one line
  per flag given. `getMe` runs only after the owner agrees. A token of a different bot removes the old pairing. There
  is no `auth manager` subcommand: setup is the only entry.
- **Pairing** (`src/host/manager-bot.ts`, `pairManagerBot`). It runs only in an interactive setup, never with `--yes`
  or a piped token. Setup shows an 8-character code (40 bits, no 0/O/1/I, shown as `XXXX-XXXX`) and long-polls
  `getUpdates` (`allowed_updates: ["message"]`, 25 s) until the deadline, 10 minutes later. Only a private chat with a
  human sender whose text is the code (case, spaces and dashes ignored) pairs. Groups, bots and other text are skipped
  without a reply. On a match, `access.json` (0600) gets `{version, botId, userId, chatId, pairedAt}`, and only then
  replaces an older pairing. Setup acknowledges the code message (offset) and sends one confirmation. A 409 is reported
  as "another process polls the manager bot" (CONFLICT), and a 401/404 as a rejected token. Network errors, 5xx and 429
  (`retry_after`) are retried until the deadline. Clock, sleep, code and fetch can be injected.
- **Transport hooks.** `loadManagerAccess`, `isOwnerUpdate` (the paired user in the paired private chat, for a
  message or a button tap) and `readManagerToken` are what task-53.5.2 builds on. The transport must never pair.
- **Doctor / `status --check`.** The checks are `manager.token` (ok "not set up (optional)" when there is no token;
  otherwise presence, format, bot id and file mode), `manager.bot` (the manager bot against every coordinator bot) and
  `manager.pairing` (paired for the stored bot). When there is no token, `manager.bot` and `manager.pairing` are
  `unavailable`. They warn and never fail. They make no network call.
- **Setup assistant.** `<MINIONS_HOME>/manager/**` is on the assistant's Edit deny list. An agent must not be able to
  rewrite the pairing, the token reference or the journal.


Child tasks, filed as task-53.2 to task-53.7 (phases 1 to 6) and task-53.8 (coordinator proposal):

1. **child: Settings classification and host-owned flag (task-44 part 1)** | criteria: every schema key has a class
   live/restart/recreate/fixed and a hostOwned flag, with a guard test; `settings set` reports what took effect now
   and what needs a restart or upgrade; live keys are tested to take effect without a restart | depends: none
2. **child: Change requests in the runtime** | criteria: `change_requests` table (DB migration); in the runtime,
   `settings set`, `settings restart` and `upgrade` record requests and refuse host-owned keys; host
   `settings requests/apply/reject` with the plan, digest and confirmation; `editProjectConfig`
   (`src/host/config-write.ts:59`) has no expected-revision guard today, so add `settings set --expect-revision <n>`
   (refuse if the revision changed; `/undo` relies on it); the migration is under `**/migrations/**`, a sensitive
   path that needs owner approval; tested with fakes | depends: 1
3. **child: Manager core without Telegram** | criteria: host manager process with lock, journal, per-project polling
   through delegate, plan/digest/expiry checks, child-command apply, interrupted-entry reporting; driven by a fake
   transport in tests | depends: 2
4. **child: Manager bot** | criteria: `manager-bot-token` credential, bot-id guard in both directions, terminal pairing
   in `setup`, Bot API transport with inline Confirm/Reject and the double tap for loosening, fixed command set;
   `/approve <task> <sha>` (bound to the head SHA, double tap, runs the host's `work approve` so the signing key stays
   on host); confirmation expiry 30 minutes; doctor `manager.*` checks | depends: 3
5. **child: Supervisor and status** | criteria: `setup` installs and removes a launchd agent (macOS) or a
   systemd --user unit (Linux); restart after a self-upgrade; `status` shows the manager and pending requests;
   `uninstall` removes everything | depends: 4
6. **child: Restart-when-idle and rollback** | criteria: queued restart at the first idle poll; drain-now option;
   config history with `/undo` compare-and-swap; CLI backup and roll back; dev-only `--rebuild-cli` request (registered only when the host CLI runs from a minions
   source checkout and the managed project is minions); docs (README, cli.md, bootstrap.md) | depends: 4

task-3 (upgrade) and task-3.4 (restart-required) are building blocks that already exist. The manager calls
`minions upgrade` unchanged, and it shows task-3.4's restart-required reasons in `/status` and as a push message
offering `/upgrade`.

## Owner decisions

Answered by the owner on 2026-10-26 (Telegram msg 250). They replace the open questions of the first draft.

1. **Entry point.** The hidden internal-tier command `minions manager run`, like `coordinator run`. The new
   `settings requests`, `settings apply` and `settings reject` subcommands fold under `settings`; there are no new
   top-level commands.
2. **Loosening host-owned settings.** Only by an owner-initiated `/set` in the manager chat with the double tap,
   never from a coordinator request. The coordinator may post a **proposal** in its own Telegram chat, with the reason
   and the exact manager `/set` command and terminal command. A proposal is never recorded as a change request and
   the manager never acts on it.
3. **CLI rebuild from container commits.** A dev-only feature. It is available only when the host CLI runs from a
   minions source checkout and the managed project is minions. Normal installs do not register, advertise or accept
   the request. Where it exists, it keeps the plan (commit range, diffstat, sensitive paths) and the double tap.
4. **How the manager runs.** A user service (launchd or systemd --user) installed by `setup`.
5. **Approvals from the manager chat.** `/approve <task> <sha>` is part of phase 4. It is bound to the head SHA,
   needs the double tap, and the signing key stays on the host (the manager runs the host's `work approve`).
6. **Confirmation expiry.** 30 minutes.
