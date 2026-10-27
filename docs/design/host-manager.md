# Host manager for live setup changes: design

Status: **agreed** (task-53; phases 1 to 5 built, see [Phases](#phases)). Folds in task-44 (live settings). The owner answered the
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

Host-owned keys are refused at recording. For those the coordinator only posts a proposal in its own chat: the reason, `/set <key> <value>` for the manager and the equivalent `minions settings set <key> <value>` for the host terminal. It is a suggestion, never recorded or treated as a request; the owner's `/set` and the confirmation flow stay the only path.

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
| `/set <key> <value>` | Same model as `minions settings set` (validation, layer, loosening text); applied at once unless it loosens, then the confirmation |
| `/sync` | Outer repo sync (see [Change kinds](#change-kinds)) |
| `/upgrade` | `minions upgrade` after its dry run (never with `--rebuild-cli`, so it builds no CLI on the host): applied at once |
| `/restart` | Graceful coordinator restart (refused while workers are active: then **Restart when idle** and **Drain now** are offered) |
| `/undo <id>` | The inverse of an applied config change: applied at once unless it loosens, then the confirmation |
| `/rebuild_cli` | Dev only (owner decision Q3): `minions upgrade --rebuild-cli` with the commit range, diffstat and sensitive paths in the plan; not registered on normal installs |
| `/project <name>` | Picks the project for the commands above when several are registered |

An owner command the owner types builds the same plan as a coordinator proposal. Since task-78, a typed command whose
plan loosens nothing and builds or installs no CLI on the host applies at once (see
[Owner-typed commands](#owner-typed-commands-task-78)); every other one goes through the same confirmation as a
coordinator proposal, because typing `/set` is not consent to a loosening the manager computes from it.

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

Nothing from the container applies without step 3. That includes tightening changes, rejects of stale requests (they
are only marked expired) and restarts. Read-only commands (`/status`, `/requests`) need no confirmation. The one
exception is a safe command the owner types (next section).

### Owner-typed commands (task-78)

The owner asked not to confirm what they just typed ("I see no point in approving the restart when I just called
/restart"). The rule: when the paired owner types a change command in the private chat, and its plan

- loosens nothing (`loosens` is null),
- is of a kind on the allow list (`DIRECT_KINDS` in `src/host/change-requests.ts`: `config-set`, `restart`, `sync`,
  `undo`, `upgrade`), and is not a queued restart mode,
- and builds or installs no CLI on the host (an upgrade only without `--from-container` and `--rebuild-cli`; without
  that flag `minions upgrade` never builds the CLI),

the manager applies it at once (`appliesWithoutConfirm`). That covers `/restart`, `/sync`, `/upgrade` and a
tightening or neutral `/set` or `/undo`. `/approve` (it always loosens), a loosening `/set` or `/undo` and
`/rebuild_cli` keep the offer and the double tap. Container requests always need Confirm, and so do the plans the
manager offers on the owner's behalf (Restart when idle, Drain now, Roll back CLI): they were not typed.

What stays the same:

- Only a message that passes `isOwnerUpdate` (paired user, paired private chat, not a bot) and is not forwarded
  counts. Taps and the container's rows never reach this path.
- The plan is built, digested and journaled like any other. The offer carries `typed` (the key
  `telegram:<botId>:<chatId>:<messageId>`) and `direct: true`, and its `confirmed` entry is written in the same
  append, under the journal lock, in the one manager process. Its nonce is spent before anything could show it.
  Then the usual `applying` and outcome entries follow, and the owner gets the usual "Applying…" and outcome
  messages. A refused `/restart` still offers Restart when idle and Drain now.
- **Replay.** The persisted `getUpdates` offset keeps a restart from replaying old messages. On top of that, the
  journal holds at most one offer per message key: a redelivered update (same bot, chat and message id) is answered
  "already handled" and nothing is planned or applied again. A crash after the `confirmed` entry is reported as
  interrupted at the next start, like any confirmed apply, and never resumed.
- Plain text only: no message uses markup.

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
host-owned and are never writable from the container". Approvals stay host-signed: `/approve <task> <sha> [merge]` in the manager chat
runs the host's `work approve` (`approveOnHost`), so the signing key never leaves the host (see [Owner decisions](#owner-decisions) Q5;
built in task-53.5.4).

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

Built in task-53.5.2 (phase 4, part 2): the Bot API transport (`src/host/manager-telegram.ts`) and the read-only
commands. Decisions made here:

- **Transport choice.** `manager run` uses the Telegram transport when `access.json` exists and a manager token of
  the same bot is stored (`chooseTransport`); otherwise the log transport, with one log line saying why. An unreadable
  pairing or store is an error, not a silent fallback.
- **Owner only.** Updates that `isOwnerUpdate` rejects are dropped without any reply, not even
  `answerCallbackQuery`. A forwarded message (any of `forward_origin`, `forward_from`, `forward_from_chat` or
  `forward_date`) is ignored the same way, even when the owner forwards it: only what the owner types is a command.
  Messages are plain text (no `parse_mode`), and all text goes through `displayText`.
- **Buttons.** `c:<requestId>:<nonce>` (Confirm), `r:<requestId>:<nonce>` (Reject) and `d:<requestId>:<nonce>` (the
  second confirmation). They are 46 bytes, and `callbackData` refuses anything over 64. Every owner tap is answered.
- **Double tap.** The first Confirm on a plan with `loosens` sends no event. It sends a second message with the
  risk on one line and a "Confirm again" (`d:`) button. Only a `d:` tap within 2 minutes of that first tap, for the
  same request and nonce, sends the confirm event. The armed state is in memory: after a restart the owner taps
  Confirm again. For an offer this process did not send, `loosens` is read from the journal's plan.
- **Applying and outcomes.** The `applying` outcome edits the tapped offer message (the text replaces it, the buttons
  go). Without a known message, or when the edit fails, it is sent as a new message. A `rejected` outcome also edits
  the offer. Every other outcome is a new message.
- **Offset.** `<MINIONS_HOME>/manager/telegram-offset.json` (`{version, botId, offset}`, 0600, directory 0700) is
  written when a batch arrives, before it is handled (at most once). An offset of another bot is ignored. 409 is
  CONFLICT "another process polls the manager bot" and 401/404 is AUTH_REQUIRED. The core logs both and retries after
  5 s. A 429 waits `retry_after`. A send is retried once after a 429 of at most 30 s.
- **Commands.** Fixed set `/status`, `/requests`, `/project [name|all]`, `/help` (`/start`). Anything else gets the
  help text. `/set`, `/sync`, `/upgrade`, `/restart` and `/undo` came in task-53.5.3 (below); `/approve` came in task-53.5.4 (below).
  The core gives the transport read-only views (`ManagerCommands`, through `ManagerTransport.attach`). `/requests`
  resends every request whose newest journal entry is an offer, with buttons. An expired one is included: Confirm
  then brings a fresh offer. `/status` shows, per project: runtime running, coordinator (from the runtime's
  `minions status --json` through the bounded delegate, typed fields only: launch state, active leases, paused),
  pending requests, and the last poll problem. The restart-required check of `minions status` on the host (image and
  build fingerprint) is not repeated there. Only a stale coordinator launch is shown as "restart required". The
  `/project` choice is kept in memory.

Built in task-53.5.3 (phase 4, part 3): the owner change commands `/set <key> <value> [shared]`, `/sync`, `/upgrade`,
`/restart` and `/undo <id>`. Decisions made here:

- **Same path as a proposal.** The transport parses the command (`parseOwnerCommand`) and calls
  `ManagerCommands.propose`. The core builds the plan with the same `buildPlan`, journals an offer and returns it; the
  transport shows it with Confirm / Reject. Typing the command is never consent: only the tap applies it, through the
  same `confirmOffer` (nonce, expiry, revision, digest) and apply code. A plan that loosens asks twice (`d:` tap). A
  plan that cannot be built (an invalid value, an unchanged one, a refused sync dry run, an undo with drift) is
  answered with `/<cmd> failed: <reason>` and nothing is journaled.
- **Owner requests.** Their id is host-minted, `ow_` + 8 hex (the container's are `cr_`), so the callback data stays
  46 bytes. The journaled snapshot carries `origin: 'owner'`, and the plan `origin: 'owner'` (absent for container
  plans, so their digests are unchanged). `buildPlan` treats a request as the owner's only when both the `ow_` id and
  the origin are present; a `cr_` snapshot claiming the owner origin, an `ow_` id without it, or a container
  `sync` / `undo` is refused. Owner requests have no runtime row: `mark` is skipped for them (no warning), Reject only
  journals `rejected`, startup closes an interrupted one in the journal only, and a refused confirmation is re-offered
  from the journaled snapshot.
- **Host-owned keys.** `/set` may target them (owner decision Q2), with the usual loosening text and double tap. A
  container request for one is still refused when recorded and by `buildPlan`. `/set` writes the local layer
  (`config.local.json`) unless the last word is `shared` (a shared install only). A value starting with `-` is refused
  by the parser, since it is passed to `minions settings set` as one argv element.
- **Project.** A command targets the project picked with `/project`; with no pick it needs exactly one registered
  project, otherwise it asks for `/project <name>` first.
- **`/upgrade`** is plain `minions upgrade` (no `--from-container`, never `--rebuild-cli`); the plan shows its dry-run
  steps. `/restart` is `minions settings restart` (graceful).
- **`/sync`** is a new host flag, `minions upgrade --sync-only` (no new command): `runSyncOnly`
  (`src/host/upgrade-source.ts`) runs only the source sync, `syncFromContainer` for local delivery (export, then the
  strict fast-forward) or `syncFromOrigin` for GitHub delivery. Nothing is forced, reset, stashed or checked out; a dirty
  tree or a divergence refuses. The plan comes from `--sync-only --dry-run` (it compares with the last export, as the
  upgrade dry run does). Like the upgrade dry run it runs before the journal lock is taken. The digest covers the step
  ids, not their details. The container cannot request `--sync-only`.
- **Config history** (`src/host/config-history.ts`). Before the manager runs a confirmed config-set (container or
  owner) or an undo, it saves `<project dir>/config-history/<requestId>.json` (0600, directory 0700) with the key,
  layer, file, the effective from/to and the file text before; after a successful write it adds the text after and
  `completed: true`. The last 20 are kept. The terminal `settings apply` path saves it as well. Entries are named by
  the request id, not the configRevision, because a local-layer write does not bump the revision.
- **`/undo <id>`** proposes restoring the whole layer file to its text before `<id>`, shown as the inverse diff of that
  key, with the loosening check run on the inverse (undoing a tightening can loosen). Compare-and-swap: the file must
  still be exactly the text `<id>` wrote (its sha256 is in the plan and the digest); otherwise the plan is refused with
  the drift (the key as `<id>` wrote it and as it is now) and nothing is written. The check runs again when the
  plan is rebuilt under the journal lock at confirm time, and once more right before the write. A shared-layer restore
  keeps configRevision moving forward (the restored file gets the current revision + 1); a local-layer restore removes
  `config.local.json` when it did not exist before. The undo runs in the manager process: there is no CLI command for it.
  An undo has its own history entry, so it can be undone in turn. Known gap: a terminal edit of the same file between
  the history snapshot and the child's write would be reverted too by a later undo (the window is one child process).
- **The history entry is not trusted.** It is a file on the host, and a tampered one must not write anywhere else or
  change more than the plan shows. The file to restore comes from the project and the entry's layer
  (`config.local.json` or the project config). An entry that names another file, project or request id is refused,
  and so is one that names the shared layer of a private install. The plan lists every setting the restore changes in
  that file (the file now compared with the saved text). Each one shows its effective value now and after. The
  loosening check runs over all of them, and any loosening asks twice. The entry's own key comes first. The restore
  is refused when it does not change that key, when it changes no setting, or when it changes anything in the file
  that is not a setting. `configRevision` of the shared layer is the exception, since it moves forward anyway. The
  plan also carries the sha256 of the saved text, and the write is refused if the entry changed after the plan was
  made. The host-runtime agent may not edit `<project dir>/config-history/`: there is an
  `Edit(<project dir>/config-history/**)` deny next to the other project subdirectories.
- **Follow-ups.** After an applied config change that needs a restart or an upgrade, the outcome says to send
  `/restart` or `/upgrade` (each its own plan to confirm). The manager does not offer them by itself yet.

Built in task-53.5.4 (phase 4, part 4): `/approve <task> <sha> [merge]`. Decisions made here:

- **Same path again.** `parseOwnerCommand` turns it into `{ kind: 'approve', taskId, head, merge }`; `propose` journals
  an owner request (`ow_` id) of plan kind `approve` with `approval: { taskId, head, scope }`. Only the confirmed
  plan signs anything, through the same `confirmOffer` and apply code.
- **Exact head.** The parser accepts only `task-<n>[.<n>...]` and a full 40-character lowercase hex SHA; a short,
  uppercase or non-hex SHA gets the usage line, and `buildPlan` validates the payload again. The manager does not
  read the task's head itself (there is no bounded runtime read of the publication head today): the runtime's
  `work approve` already refuses (CONFLICT) a head that is not the one awaiting publication, or for `merge` the
  delivered head, before it records anything. That refusal is the failed outcome the owner sees.
- **Always two taps.** The plan's `loosens` is always set ("signs a publication approval for <task> at <sha>", or a
  merge approval), so the transport asks twice, also for an offer read back from the journal.
- **Scope.** Without `merge` it is a publish approval; with `merge` a merge-scoped one (`approveOnHost` with
  `merge: true`). The offer says which, in the summary and on its own `scope:` line.
- **Signing.** The manager calls `approveOnHost` (`src/host/approvals.ts`, injectable as `ManagerDeps.approveOnHost`)
  in its own process with the project id and a delegate that runs `minions work approve ... --signature <token> --json`
  through the bounded runtime. The token is in that argv only: it is never logged, journaled or sent to the chat (the
  outcome shows only the runtime's envelope message). The runtime has the token and may echo it, so its message, and an
  error thrown while approving, go through `redactApprovalText`: the whole token is replaced in the raw text; then, after
  `displayText` and whitespace collapsing, the token, each long segment of it and anything shaped `mnap1.<a>.<b>` are
  replaced on a copy without the invisible noise (`<U+XXXX>` markers, combining marks; for the real token also
  whitespace), so controls, escape sequences or zero-width characters injected into the token do not hide it; the text
  is cut to 500 characters last and checked once more. A runtime that re-encodes the token on purpose is out of reach. The terminal `settings apply --confirm` refuses an approve plan
  (it is confirmed only in the chat; `minions work approve` stays the terminal route).
- **Not undoable.** `/undo` of an approval request is refused ("approvals cannot be undone"); an unused approval
  expires and a new commit needs a new one anyway.

Built in task-53.6 (phase 5): the supervisor service and the manager in `minions status`
(`src/host/manager-service.ts`, `src/host/manager-status.ts`). Decisions made here:

- **Service files.** macOS: a launchd agent `~/Library/LaunchAgents/dev.minions.manager.plist` in `gui/<uid>`
  (RunAtLoad, KeepAlive, ThrottleInterval 10 s, output to `<MINIONS_HOME>/manager/manager.log`). Linux: a systemd
  --user unit `$XDG_CONFIG_HOME/systemd/user/minions-manager.service` (default `~/.config`), `WantedBy=default.target`,
  `Restart=always`, `RestartSec=10`, `SuccessExitStatus=75`. A non-default `MINIONS_HOME` adds a suffix of 8 hex
  characters (from the root path) to the label and unit, so two minions homes never share a unit. The unit file is written
  atomically and only when its content changed. It holds no token; the manager reads the token from the store.
- **Program.** `/usr/bin/env node <cli> manager run`, with `PATH` from the installing shell (with the node directory
  first) plus `MINIONS_HOME`, `XDG_DATA_HOME`, `MINIONS_CREDENTIAL_STORE`, `DOCKER_HOST` and `DOCKER_CONTEXT` when set.
  A node upgrade that moves the binary does not break the unit, and a CLI reinstall at the same path is picked up on
  the next start. Values with control characters are refused, and values are quoted for systemd (backslash and double quote escaped, `%` doubled, and `$` doubled in the program line).
- **Install is a setup step.** `minions setup` asks whether to install the service; the default is no, and `--yes`
  never installs it. Installing writes `<MINIONS_HOME>/manager/service.json`, a record bound to this home's exact unit
  name or label (and the unit path), so setup, status and uninstall only touch a unit that this home created.
- **Not the current path.** A unit is accepted as ours when its record names it and the file is missing or a regular
  file owned by the current uid whose sha256 matches the record. A corrupt or unreadable record makes setup warn and
  leave its unit alone; it never overwrites or removes a unit it cannot attribute to this home.
- **Restart after a CLI change.** When the manager notices that the CLI on disk changed (after `/upgrade`), it exits
  with 75. The supervisor treats 75 as success (`SuccessExitStatus=75`) and starts it again on the new CLI.
- **Status and doctor.** `minions status` and `minions doctor` show a manager block: service installed or not, running
  or not, the bot, and pending change requests. The `manager.*` doctor checks report state but never fail, because
  the manager is optional.
- **Uninstall.** Removing the last registered project also stops and removes the manager service and its record;
  uninstalling one of several projects leaves the service in place.

Built in task-53.7 (phase 6): Restart when idle / Drain now, the CLI backup and **Roll back CLI**, and the dev-only
`/rebuild_cli`. Config history with `/undo` compare-and-swap and the last-20 retention were already built in
task-53.5.3 and are reused unchanged. Decisions made here:

- **Follow-ups are offers.** A plain restart whose child answers `refused` (active worker leases) is reported as
  failed, and the manager then journals and sends two owner requests (`ow_` ids, minted by the manager on the
  owner's behalf): kind `restart` with payload `mode: when-idle` and `mode: drain`. Each is its own plan with its
  own nonce, confirmed like any other; nothing is queued or drained without that tap. Only an owner request may
  carry a mode (`buildPlan` refuses one from the container), and a plan without a mode has no `restart` field, so
  the digests of plain restarts are unchanged. The container's request stays `failed` and is re-offered as before.
- **The queue lives in the manager.** A confirmed when-idle or drain plan is kept in memory (one per project; a
  second one is refused as "already queued"). Its journal entry stays `applying` with the detail
  `queued: …`, so a manager restart reports it as interrupted (the startup message repeats that detail, including
  how to resume starts) and never resumes it. Persisting the queue was rejected: a queued restart that survives a
  manager restart would run long after the owner looked at it.
- **Each poll** runs the queue first: `minions status --json` through the bounded delegate, and at zero active
  leases `minions settings restart` as a child (the same graceful path). A runtime that is not running gets the
  child too, which reports `not-running` and closes the request. A status that cannot be read is reported once and
  the entry stays queued. A restart refused at that moment (a lease started in between) stays queued for the next
  idle poll: the same plan, never another strategy.
- **Drain now** first reads the pause state, then runs `minions pause --starts --drain --reason restart` in the
  runtime; a failure there queues nothing. It undoes only what it paused. When starts were running before, the
  idle poll (a fresh status read with no active lease) runs `minions resume --starts` first and then the restart:
  the restarted coordinator's recovery prompt dispatches only when starts are not paused, and a later resume does
  not wake a coordinator that already reported "starts paused" and went idle (the same order as `minions
  upgrade`). A failed resume runs no restart and keeps the entry queued (reported once). If the restart is then
  refused because a lease started in between, the manager pauses again with `minions pause --starts --drain
  --reason restart` and keeps the entry queued for the next idle poll; no other strategy is tried (if that pause
  fails, the problem is reported and the entry waits as a plain restart when idle). When the owner had paused
  starts already, the owner's pause stays: only the drain is cleared, with `minions resume --drain` right after
  the restart ran (whatever it answered). A runtime that is stopped at the idle poll cannot be resumed: the
  request closes as failed and the outcome names the pause left in place and the command that clears it.
- **CLI backup** (`src/host/cli-backup.ts`). `applyCli` packs the packed global install with
  `npm pack <install dir> --ignore-scripts` (none of its scripts run) right before `npm install -g`, into
  `<MINIONS_HOME>/manager/cli-backup/minions-<version>-<UTC stamp>.tgz` (0600, directory 0700, last 2). A backup
  that fails stops the reinstall, nothing installed. A linked checkout is rebuilt in place and has no backup. The
  backup is made by `minions upgrade` itself, so a terminal upgrade keeps one too.
- **CLI check.** After an `upgrade` or `rebuild-cli` apply whose `cli` step ran npm (done, or a reinstall/rebuild
  that failed or finished wrong), the manager runs `minions --version` (exit 0 and a version line) and
  `minions --json status` (an ok envelope) in fresh processes of the host CLI (`ManagerDeps.cliHealth`). The
  result is a line of the outcome. When it fails and a backup exists, a `cli-rollback` owner offer follows; with no
  backup the outcome says so.
- **Roll back CLI** (kind `cli-rollback`, owner only, one Confirm: it reinstalls what was installed before). The
  payload names the backup; the plan takes the file only from the backup directory (a regular file whose name
  matches the backup pattern, never a symlink) and digests its sha256. At apply time the sha256 is checked again,
  then `npm install -g --no-audit --no-fund <file>` runs through the injectable `ManagerDeps.npm`, then the check
  once more. A check that still fails is reported as failed and nothing else is tried.
- **Dev-only `/rebuild_cli`** (`src/host/cli-rebuild.ts`, kind `rebuild-cli`, owner only). Available when the
  running CLI's package root is a minions source checkout (`package.json` name plus `src/cli.ts`; a packed install
  has no `src/`) and the project's repository is one too. `ManagerCommands.devRebuild` tells the transport: without
  it the command is not in the help text and is answered like any unknown command; `propose` and `buildPlan`
  refuse it as well (`details.refusal: unavailable`). Local delivery only (GitHub delivery builds only from
  `origin/<base>` through `/upgrade`), and a dirty checkout is refused (the build would include what the plan does
  not show). The range starts at the commit the running CLI was built from: `esbuild.config.mjs` now stamps
  `commit` and `dirty` into `dist/build.json`; a CLI built before that is refused with the terminal command.
  The plan carries `from`, `to` (HEAD), the commit count, `git log --oneline` (50 lines), `git diff --stat` (40
  lines) and the files matching the project's `sensitivePaths`, all digested, plus the step ids of
  `minions upgrade --rebuild-cli --dry-run` (the dry run must plan a `cli` step). `loosens` is always set, so the
  chat asks twice. Right before the child runs, the range is read again and a moved HEAD or build commit refuses.
  The apply is `minions upgrade --rebuild-cli`, followed by the CLI check above. All git commands go through the
  injectable runner (`ManagerDeps.cli.runner`).
- **Terminal route.** `settings apply --confirm` refuses `rebuild-cli`, `cli-rollback` and a restart with a mode:
  they run only in the manager (the terminal has `minions upgrade --rebuild-cli` and `minions settings restart`).
- **Command name.** Telegram commands allow only letters, digits and underscores, so the request is
  `/rebuild_cli`; the command parser now accepts `_` in command names.


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
6. **child: Restart-when-idle and rollback** (built in task-53.7) | criteria: queued restart at the first idle poll; drain-now option;
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
   needs the double tap, and the signing key stays on the host (the manager runs the host's `work approve`). Landed in
   task-53.5.4.
6. **Confirmation expiry.** 30 minutes.
