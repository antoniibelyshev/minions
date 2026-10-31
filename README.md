# minions

minions installs a small Claude Code development team into a Git project on your Mac. A **coordinator** takes requests from a terminal or Telegram, keeps an execution backlog, and hands bounded pieces of work to **engineer**, **reviewer**, and (for QA) **tester** workers. It delivers the results as local commits on branches, which you fetch with `minions export`. minions works only locally: it never pushes or talks to GitHub; you push the base branch yourself.

Everything the model controls runs inside one Docker container per project. Your Mac runs only a small, trusted `minions` CLI. (You can explicitly opt into a less safe **host runtime** without Docker; see [Running without Docker](#running-without-docker).) That CLI installs the team, starts and stops the container, provisions the credentials you grant, and handles explicit import and export.

> **Status:** version 0.1 (bootstrap) is installable from GitHub or from source (see [Install in another project](#install-in-another-project)). It implements the terminal workflow on the host through seven everyday commands (`setup`, `start`, `status`, `settings`, `upgrade`, `down`, `uninstall`; see [Everyday use](#everyday-use)) plus advanced commands for single steps (see [docs/cli.md](docs/cli.md)); an opt-in host runtime without Docker ([Running without Docker](#running-without-docker)); optional Telegram communication through the official Claude Code channel plugin (see [docs/design/telegram.md](docs/design/telegram.md), including a durable notification outbox and plain-language controls with terminal equivalents); the Backlog.md backend; and local delivery (commits on `agent/<slug>` branches, fetched to the host with `minions export`), with optional automatic local integration (see [Delivery, review, and merging](#delivery-review-and-merging)). The rest of this README describes the intended version 1 behavior. Sections marked **(deferred in v0.1)** are not implemented yet, and `minions status --check` reports them as unavailable: config plan/apply, backlog migration, the plan/migration parts of upgrade, budgets, companion containers, and versioning a shared backlog in Git. The v0.1 contract is [docs/design/bootstrap.md](docs/design/bootstrap.md); the full requirements are in [docs/spec.md](docs/spec.md).

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install in another project](#install-in-another-project)
- [Quickstart](#quickstart)
- [Everyday use](#everyday-use)
- [Modes](#modes)
- [Working with the team](#working-with-the-team)
- [Backlogs and task intake](#backlogs-and-task-intake)
- [Task lifecycle](#task-lifecycle)
- [Custom roles](#custom-roles)
- [Delivery, review, and merging](#delivery-review-and-merging)
- [Permissions and capabilities](#permissions-and-capabilities)
- [Sensitive changes](#sensitive-changes)
- [Configuration](#configuration)
- [Models and budgets](#models-and-budgets)
- [Other agents (OpenAI Codex)](#other-agents-openai-codex)
- [Communication](#communication)
- [Claude authorization](#claude-authorization)
- [Security model](#security-model)
- [Running without Docker](#running-without-docker)
- [CLI reference](#cli-reference)
- [Recovery, upgrades, and uninstall](#recovery-upgrades-and-uninstall) (and the [troubleshooting guide](docs/troubleshooting.md))
- [Out of scope for version 1](#out-of-scope-for-version-1)

## What it does

- **Runs an autonomous team on your laptop over many sessions.** The coordinator picks ready work, splits it, dispatches workers, and continues until the queue is empty, paused, blocked, or waiting on you.
- **Keeps durable state outside the conversation.** Decisions, task progress, handoffs, and recovery information survive a lost Claude session or a container restart.
- **Works in projects you own and in repositories you don't.** It follows an organization repository's existing architecture, CI, and contribution process, and it can keep your private subtasks out of shared trackers.
- **Gives you separate controls for task intake, proactive execution, and merging.** There is no single "autonomous" switch.
- **Lets you change configuration by asking Claude.** Changes go through a validated transaction and never require reinstalling.
- **Limits waste.** It caps concurrency and repair cycles, prevents duplicate pickups, keeps context small, and stops the coordinator from waking itself up with nothing to do.

## How it works

```
 macOS host                              Project container (Linux, non-root)
┌──────────────────────┐                ┌──────────────────────────────────────────┐
│ minions CLI          │  lifecycle,    │ Coordinator (main Claude Code session)    │
│  - install / config  │  read-only     │   ├─ minions:engineer  (subagent)        │
│  - Docker lifecycle  │  token files,  │   ├─ minions:tester    (subagent)        │
│  - credentials       │  explicit      │   └─ minions:reviewer  (subagent)        │
│  - import / export   │  import/export │ minions helpers (backlog, leases, policy) │
│                      │ ─────────────▶ │ Git clone + per-task worktrees            │
│ Keychain / 0600 files│                │ SQLite runtime state, private backlog     │
└──────────────────────┘                └──────────────────────────────────────────┘
                                            named volumes: repo, state, Claude, cache
```

- **Coordinator.** The main Claude Code session inside the container. It loads a generated, project-specific minions plugin and your existing project instructions. It sets priorities, splits tasks, chooses the implementation strategy, and decides when to escalate to you.
- **Workers.** Native Claude Code subagents from the generated `minions` plugin: `minions:engineer`, `minions:tester`, and `minions:reviewer`. They report only to the coordinator. Workers never message you and never spawn other workers.
- **Helpers.** Deterministic `minions` subcommands that the coordinator calls through a machine-readable interface. They list ready tasks, validate state transitions, claim work, record results, check policy, and queue approved work for integration. The model chooses what to do; the helpers enforce the rules.
- **Persistence.** The repository clone, runtime database, private backlog, notes, and Claude sessions live in project-scoped Docker named volumes. They survive container recreation.
- **Continuation guard.** A lightweight Stop hook checks local state. If authorized work is ready and capacity is free, the coordinator keeps working. Otherwise it is allowed to stop. Blocked dependencies, network errors, permission failures, and exhausted retries do not trigger a wake-up. If the guard loops without any state change, it stops and records a recovery reason.

## Requirements

- macOS on Apple Silicon or Intel, or Linux (preview: Docker Engine; implemented and unit-tested with fakes, not yet validated on a live distro, see [Linux hosts](docs/compatibility.md#linux-hosts-preview))
- Docker Desktop (macOS) or Docker Engine (Linux) with Docker Compose v2, installed by you, for the default `docker` runtime. On Linux, `minions doctor` names the exact fix for socket permissions (docker group or rootless Docker), a missing Compose plugin, and SELinux labeling. minions never falls back to running agents on the host by itself; the host runtime is an explicit, less safe opt-in ([Running without Docker](#running-without-docker)).
- Node.js 22.13 or later, for the host CLI
- A Git repository. No remote is needed: minions imports the committed history of the base branch (a Git bundle).
- A Claude account or API key. By default you log in to Claude inside the container; your host login is not reused. You can instead let the host provision an API key (see [Claude authorization](#claude-authorization)).
- Optional: a Telegram bot for remote control

Native macOS or iOS builds that need Xcode can't run in the Linux container. minions reports them as an environment limitation.

## Install in another project

Install the CLI from GitHub, then point it at the repository you want the team to work in:

```sh
npm install -g github:antoniibelyshev/minions
minions setup path/to/your/repo
```

npm clones the repository, installs the build tools, and builds `dist/` during the install (the `prepare` script). The installed package includes the templates, the Docker build files, and the config schema that the CLI needs at run time. To run setup once without a global install:

```sh
npx github:antoniibelyshev/minions setup .
```

To upgrade, uninstall first and then install again. npm cannot replace an existing global install from a git URL in place, and it removes the old copy when it tries:

```sh
npm uninstall -g minions && npm install -g github:antoniibelyshev/minions
```

From a clone of this repository, `./install.sh path/to/your/repo` does the same thing: it builds and packs the CLI, installs it globally with npm, and runs `minions setup`. To check the git-URL install path locally without touching your global npm, run `npm run verify:git-install`. It installs a temporary clone into a temporary prefix.

minions is not published to the npm registry. Installing with `npm install -g minions` may be offered later. Until then, use the GitHub URL.

## Quickstart

```sh
minions setup path/to/repo
```

That one command asks everything it needs and runs the whole setup. You don't need to know the individual commands. (From a source checkout, `./install.sh path/to/repo` builds and installs the CLI globally with npm, then runs `minions setup`.)

`minions setup` walks through these steps in order. Optional integrations default to **no**, and core steps default to **yes**:

1. **Project.** The first question is the [mode](#modes): `independent` or `supervised` (no default). The mode decides everything else: visibility, runtime, channel, merging, limits and policy. The project step then asks only what [`minions defaults`](#host-defaults) does not answer (Claude authorization, the git identity of agent commits), shows the plan and applies it after you confirm.
2. **Telegram (optional).** *Set up Telegram?* It gives BotFather guidance, reads the bot token without echo, and prints the pairing instructions. With the default `communication.channel` `auto`, a stored token is enough; the host runtime has no Telegram, so this step is skipped there.
3. **Runtime.** It builds the image if needed, starts the container (or prepares the host runtime), imports the committed history of the base branch, and launches the coordinator. Then it prints exactly how to attach (`minions start`), how to log in to Claude (`/login`, login method in the container), and how to pair Telegram (`/telegram:access pair <code>` in the coordinator terminal).
4. **Attach.** Finally it offers to attach the coordinator.

If you decline a step, setup skips it and prints how to enable it later. Rerunning `minions setup` is safe. It detects the existing configuration, stored tokens, container, and imported repository, and offers to keep or change each one without duplicating anything. Integration choices that differ from the project configuration (`communication.channel`) are recorded in the host-only `config.local.json`.

```sh
minions setup --dry-run                        # show what would happen; writes nothing, asks for no secrets
minions setup --mode independent --yes        # non-interactive: the mode is required, optional integrations off
minions setup --yes --telegram-token-stdin < token-file   # tokens only via stdin, never argv
minions status --check                         # check readiness at any time
```

To change a choice later, rerun `minions setup`. Each step is also available as a separate advanced command; see [docs/cli.md](docs/cli.md).

### What the project step does

1. **Read-only discovery.** Reads Git metadata, Docker availability, instructions, contribution docs, build files, CI workflows, and issue references. Files are treated as data: discovery runs no repository scripts and never builds your Dockerfile.
2. **Wizard.** Asks the mode, then only what neither the mode, discovery nor `minions defaults` answers: the Claude authorization method and the git identity of agent commits. Change anything else afterwards with `minions settings set`.
3. **Plan review.** Shows the planned writes, effective permissions, inferred verification commands, unavailable capabilities, and any external setup you still need to do. Approving the plan authorizes exactly those changes and nothing else.
4. **Apply and verify.** Writes files atomically and records their hashes in a manifest. A failed install rolls back. Incomplete external setup is recorded as pending, never reported as ready.

The project step is idempotent. It never overwrites files you own, preserves uncommitted changes, and never enables `bypassPermissions`. For non-interactive setup, pass a validated config file.

### Shared and private installations

| | Shared | Private |
| - | - | - |
| Config location | `.minions/` in the repo (you may commit it) | `~/Library/Application Support/Minions/projects/<projectId>/` on the host, plus named volumes |
| Repository changes | Managed files, optionally an owned block in `CLAUDE.md` | None: `git status` stays unchanged |
| Backlog | Planned: versioned in Git (deferred in v0.1; kept in the state volume) | Kept outside the repository |
| Typical use | Your own project | Your personal team inside an employer's repo |

All worktrees of a repository map to the same project ID, and only one coordinator can run per installation. If a copied project ID turns up bound to a different repository, minions detects it and asks you to attach explicitly or initialize a new project.

## Everyday use

These are the only commands you need day to day. `minions --help` lists exactly these.

| Command | What it does |
| - | - |
| `minions setup [path]` | Install, configure or reconfigure minions for a repository. Safe to rerun. |
| `minions start` | Start the team (if needed) and attach to the coordinator. Use it after a reboot or to resume work. |
| `minions status` | Queue, workers, pause state and channel. `minions status --check` checks the host, Docker, the container and Claude authorization. |
| `minions settings` | List every setting with its value, source and how a change takes effect: merge mode, testing, reporting, models, concurrency, permissions, tokens (shown only as provisioned/missing), pause/resume. `minions settings set <key> <value>` changes one. See [Changing settings](#changing-settings). |
| `minions upgrade` | Move the running team onto the installed minions version without losing work. Running workers commit their progress and hand back; they continue after the upgrade. |
| `minions down` (or `minions stop`) | Stop the team. Data and progress are kept; `minions start` resumes. |
| `minions uninstall` | Remove minions from the project, keeping task data unless you ask otherwise. |

Everything else (pausing intake, credentials, channels, the agent runtime, and the commands the coordinator and workers use internally) is listed by `minions help --all` and in [docs/cli.md](docs/cli.md). Most of it you can also do by asking the coordinator.

## Modes

The mode is the one choice `minions init` asks for. Its values are written into explicit configuration; `minions mode set <mode>` rewrites them (`--dry-run` shows the change), and your `config.local.json` overrides stay.

| Setting | `independent` | `supervised` |
| - | - | - |
| Who merges | The runtime lands approved, verified work on the local base | You review and merge everything |
| Runtime | Docker | Host (or the `minions defaults` runtime) |
| Communication | Telegram when a bot token is stored, threads and per-task sessions, daily digest at 09:00 | Terminal, one coordinator |
| Architecture | Decides and records decisions | Proposes; asks about risky changes (dependencies, migrations, CI, broad refactors) |
| Limits | 3 tasks, 2 engineers, $20 a day, $5 a task | 2 tasks, 1 engineer, no budget |
| Policy | Everything allowed except deploying; sensitive paths (agent and git hook configuration, CI workflows) need your approval before landing | Everything allowed except deploying and landing on the base |
| Visibility | Shared | Private |

No mode grants repository admin rights or overrides employer policy, organization controls, existing repository instructions, or credential restrictions.

### Host defaults

`minions defaults set <key> <value>` stores answers for every new project in `<MINIONS_HOME>/defaults.json`: `auth` (a Claude authorization method; methods with a source use `minions auth set <method> --global`), `git.name` and `git.email` (the author of agent commits), and `telegram.owner` (your numeric Telegram user id: a new project's bot starts allowlisted to you, no pairing). `minions defaults show` lists them.

## Working with the team

Talk to the coordinator in plain language in the attached terminal, or over Telegram:

- "Add rate limiting to the public API."
- "Import https://tracker.example.com/TICKET-123 and break it into tasks."
- "What's the status?"
- "Pause new tasks." / "Resume."
- "Use opus for the migration task." / "Drop to one engineer."

The coordinator turns each goal into backlog tasks with acceptance criteria and dispatches them:

1. **Claim.** A helper takes a lease on the task. A task can't be claimed twice, and each task has only one active stage at a time.
2. **Engineer.** Implements the task on `agent/<task-slug>` in its own worktree, branched from the configured base branch (not necessarily `main`). It writes or updates unit tests for the new behaviour and runs the fast checks.
3. **Verify.** The dispatcher runs `verification.commands` on the engineer's head (no worker). A failure goes back to the engineer as a repair; see [Testing](#testing).
4. **Reviewer.** Inspects the exact head commit in a separate checkout and returns a structured verdict. It reruns no tests: it judges the code, the test quality and the coverage of new behaviour. The reviewer never fixes production code and never publishes merges.
5. **Deliver.** The approved commit stays on its branch; the coordinator or the local integration merges it into the local base, depending on configuration.

Each worker receives a compact task brief: objective, acceptance criteria, non-goals, relevant decisions and files, branch, worktree, expected head, authorized commands, model, and attempt limit. Each worker returns a validated result with one of these statuses: `complete`, `needs_changes`, `blocked`, `needs_split`, or `partial`. A malformed result gets one correction attempt. After that it is stored as unvalidated and is never promoted to an approval.

If a task turns out to be too large, the worker reports `needs_split`. The coordinator then creates child tasks idempotently, links their dependencies, and keeps the parent as a tracking task. The parent closes only when its required children and its own acceptance criteria are done.

After three repair cycles on a task (configurable), the coordinator replans instead of retrying again.

### Coordinator defaults

Every project's coordinator follows these defaults unless you tell it otherwise. The generated coordinator prompt is the single source for them (its *Owner defaults* section, built in `src/plugin/generate.ts`); this is a summary.

- **Intake:** turns your requests into backlog tasks without asking first. `ask` capabilities and sensitive paths still need your approval.
- **Reporting:** reports high-level feature progress only, asks only high-level decisions, and records low-level decisions as notes (`communication.progress`).
- **Polls:** asks decisions as numbered options, with the recommended one first and "Other" last. Replying with just a number answers the poll.
- **Spend:** tallies coordinator and worker usage per session and reports it with deliveries and on request: USD with API-key billing, tokens on a subscription. With a budget you give in chat (USD, or tokens on a subscription), it warns at about 50% and 80% and pauses starts at 100%. `budgets.*` is USD-only and not enforced in v0.1.
- **Quota mode:** on "major things only, then stop", it finishes or parks in-flight work, pauses starts, and asks before spending more.
- **Briefs and staffing:** investigates first, then briefs engineers with context, goal, pitfalls and how to verify. Reasoning effort is set per role on the host (`models.effortByRole`; unset means the Claude Code default), not per call. For hard work or after a failure it uses the deep engineer, then a stronger model; a small model for mechanical checks.
- **Testing:** no tester per task; the runtime verifies each head before review, and the reviewer owns test adequacy (see [Testing](#testing)).
- **Merging:** in `independent` mode approved work lands on the container's local base; in `supervised` mode nothing is merged, you integrate. Without automatic local integration the `independent` coordinator merges approved branches itself. The merge is verified before it is committed (`git merge --no-commit`, run the verification commands, then commit or abort); on a conflict or failure the task goes back for a repair. `minions export` brings the integrated base to the host as `minions/<base>`. With **automatic local integration** (`delivery.merge: "auto-when-eligible"`, on in `independent` mode once verification commands are configured; `base.merge` deny in `supervised`) the coordinator merges nothing: the runtime merges each approved head as a commit object, runs the verification commands on the merged tree in its own worktree (a failed command is rerun once; a pass on the rerun lands with a `flaky` notice), and fast-forwards the base only when they pass. The task is `merging` meanwhile and `done` once it lands; a conflict or failure sends it back for a repair, and sensitive paths need `minions work approve <task> --head <sha>` on the host. Workers keep running during an integration. `minions status` shows the integration block, `minions doctor` reports a stale lock, a halted queue or a checkout that is not clean ([design](docs/design/local-auto-integration.md)).
- **Design first** for big features, shown to you before the build.
- **Graceful operations:** pauses or drains before restarts and upgrades, and keeps uncommitted work.
- **Channel:** answers on the channel you used. After an outage, it says so and asks you to resend anything important.
- **Small tasks:** labels small, low-risk tasks `small` and dispatches them readily. With 2 or more engineer slots, `minions work next` keeps the last engineer slot for a ready `small` task while bigger tasks hold the others (`waitingOn: "small-task-slot"`); with no small task ready, nothing changes.
- **Small CLI surface:** folds new features into existing commands rather than adding new ones.
- **Permission mode:** `auto` by default; `bypassPermissions` for fully unattended work, from your local config only (see [Coordinator permission mode](#coordinator-permission-mode)).

### Testing

Two tiers ([design](docs/design/autonomy.md), Decision 12). A task goes **engineer → verify → reviewer → delivered**:

- **Fast tier: `verification.commands`** (unit tests, typecheck, lint). The **engineer** writes the tests for new behaviour and runs these before recording. The dispatcher then runs them on the engineer's head in its own worktree: a failure sends the task back to the engineer as a repair cycle with the failing command and its output; a setup problem (timeout, a missing tool) blocks it. The **reviewer** starts only on a verified head and reruns nothing. The local integration runs them again on the merged tree, unless that tree is the one already verified.
- **Slow tier: `verification.periodic`** (`{ "commands": [...], "everyHours": 24 }`, integration tests). The dispatcher runs it on the base head when it is due and the base moved since the last run. A failure files one backlog task labelled `verify:periodic` and notifies you. A task labelled `verify:full` (heavy changes) also runs these in its verify step.

With automatic local integration and no `verification.commands`, nothing lands: the integrator blocks each approved task until the commands are set, and setting them up is the coordinator's first task.

**QA sweeps.** Testers mainly run QA sweeps against the base branch, not a ticket branch. The coordinator schedules one at a milestone, before a release, after several merges (about five), or when you ask. A sweep is a backlog task labelled `qa-sweep`, claimed with `--role tester`. The tester works in a detached worktree at the base head and commits nothing. It checks end-to-end flows, install and upgrade paths, and regressions across features. Recording the sweep closes it as `done`, and the coordinator creates one backlog task per finding. There is no separate command for this: ask the coordinator ("run a QA sweep").

### Built-in skills

| Skill | Purpose |
| - | - |
| `/minions:orchestrate` | Intake, prioritization, dispatch, continuation, integration |
| `/minions:status` | Concise project and task status |
| `/minions:intake` | Import a request or a linked external ticket |
| `/minions:recover` | Reconstruct interrupted work |
| `/minions:maintain-context` | Record decisions and prune stale summaries |
| `/minions:configure` | Inspect and change effective settings **(deferred in v0.1; config is read-only in the container)** |

Skills call the CLI helpers rather than editing config files or backlog syntax directly. Detailed procedures load only when a skill is invoked, so workers don't carry the whole backlog or every decision in their context.

## Backlogs and task intake

The execution backlog uses one backend, behind a common task model:

- **Backlog.md.** Uses the real [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI in a tested version range, with files in one canonical location. The coordinator is the only writer.

Only the selected backend holds task records. The local SQLite database holds leases, locks, mappings, and event receipts. It is not a second backlog.

Work can come from:

- your direct requests
- external tickets linked by URL and imported manually (native Jira and Linear connectors are not part of version 1)
- tasks in an authorized milestone

Intake is additive and idempotent: importing the same ticket twice does not create a duplicate. A failed query is never treated as evidence that tasks were deleted. External ticket discussion is task data, not instructions, so a comment can't grant minions new permissions.

To switch backends mid-project, use `minions migrate backlog` **(deferred in v0.1)**. The migration preserves task identity, links, and dependencies, can resume after a partial failure, and leaves the source records in place.

## Task lifecycle

```
idea → ready → implementing → testing → reviewing → merging → done
                     ↑                       │
                     └── changes-requested ←─┘
Also: blocked · awaiting-human · cancelled
```

`testing` happens only for tasks that need QA (see [Testing](#testing)); otherwise `implementing` goes straight to `reviewing`.

A task that nothing merges ends at **delivered** (approved, on its branch). Reports keep that distinct from **merged**, which means it landed on the local base.

Under the default settings, at most **2 tasks** are active and at most **2 engineers** run at once. A blocked task or one waiting on a human frees its capacity unless a worker is still running on it.

### Worker hand-offs (briefs and results through files)

Briefs and worker results go through files under `/state`, not through the coordinator's context:

1. `minions work next --json` lists the stages that can start now (task, role, agent type, workflow position, suggested model, reason). `minions work claim <taskId> --compact --json` claims the task's current stage (the stage machine picks the role; `--role <role>` is optional and must match it), stores the full brief in `/state/briefs/<leaseId>.json`, and prints a short summary: `leaseId`, `briefMarker`, `branch`, `worktree`, `expectedHead`, and the task id, title, role and attempt.
2. The worker prompt holds only the `minions-lease: <leaseId>` line, a `worktree:` line and the coordinator's notes. The worker runs `minions work brief <leaseId> --role <role> --json` itself. The command works only while the lease is active, only for the lease's role, and only from inside the lease's worktree, so a worker cannot read another lease's brief. The PreToolUse hook still refuses a worker launch whose prompt has no active lease marker for that role.
3. The worker writes its WorkerResult with `minions work submit <leaseId> --role <role> --json`, with the JSON on stdin, to `/state/results/<leaseId>.json`, then ends with a one-line summary. Reviewers can submit too, because the file goes under `/state` and not into their read-only worktree.
4. The coordinator runs `minions work record <leaseId> --submitted --json`. Validation and the single correction work as before. An invalid result returns its `errors`, and the rejected file is set aside so the correction has to be a new submission (`--submitted --correction`). A missing submission fails with `NOT_FOUND` and a hint. Piping the JSON to `minions work record` on stdin still works.

`minions backlog list|ready --compact --json` (or `--fields id,title,status,...`) leaves out descriptions and other bulky fields.

**Routine context resets (on by default).** To keep its context small, the coordinator restarts itself with a fresh context when no worker is running and a trigger holds: a task was delivered, its context reached about 60k tokens, or 10 worker hand-offs happened. It first writes a short handoff (`minions coordinator handoff`: open questions, pending decisions, what it waits on; at most 4 KB, secrets redacted), which the new session reads at startup. All other state is durable. Tune or turn it off with `coordinator.contextReset` (`{ "enabled": false }`); see [design/bootstrap.md](docs/design/bootstrap.md#coordinator-context-resets).

**Unattended routine (off by default).** With `routine.enabled` on, a deterministic routine pass (`minions sync --routine`) runs every `routine.tickMinutes` (default 15) and makes a wake decision. It costs no model tokens. The coordinator wrapper runs the clock. Only then does the runtime restart the coordinator on its own: it wakes an idle coordinator with a fresh session (constant prompt `/minions:orchestrate wake`) when a model is needed (a runnable stage, an unvalidated or `needs_split` result, a task that reached `awaiting-human`). A wake needs no active worker lease, no drain, starts not paused, budget left, 10 minutes of transcript idle and no owner message in the last 30 minutes, and it is capped by `routine.minWakeGapMinutes` (30) and `routine.maxWakesPerDay` (8). A coordinator that crashed is started again with the recovery prompt at most twice a day. Without `routine.enabled`, the runtime never restarts the coordinator on its own. `minions status` shows the last and the next pass; see [design/unattended-delivery.md](docs/design/unattended-delivery.md).

## Custom roles

The engineer, tester and reviewer are the built-in roles. A project can add its own worker roles (a researcher, a writer, a deploy engineer, ...) and plug them into a task's **workflow**. No custom role ships with minions. The design is [docs/design/roles-and-workflows.md](docs/design/roles-and-workflows.md).

**Where a role lives.** A role is project configuration: `roles.<name>` in the project config (`.minions/config.json` for shared installs, the private `config.json` otherwise) plus a Markdown prompt next to it (`agents/<name>.md`: `.minions/agents/` shared, the project directory private). The host resolves both into the runtime config and the generated plugin, so the container only ever sees the approved version; editing `.minions/agents/x.md` on a worker branch changes nothing. The main fields:

- `contract`: `producer` (does the stage's work, like the engineer), `verifier` (verifies the head, like the tester) or `gate` (approves the exact head, like the reviewer; read-only).
- `edits`: `none` (default), `any`, or `{ "paths": [globs] }`; `commits` (default: true when it may edit). Enforced: a stage that changes a file outside `edits.paths` is an invalid result.
- `tools`, `model`, `effort`, `maxTurns`, `requires` (capabilities the stage needs; a `deny` or `ask` refuses the claim) and `capabilities` (the role's column in the policy table; `base.merge`, `external.*`, `ci.edit`, `infrastructure.edit` and `deploy.execute` default to `deny`).

**Workflows.** `workflows.<name>` is an ordered list of stages, each a role name or `{ "role", "model" }`. The coordinator assigns one when it creates a task (`minions backlog create ... --workflow <name>`); tasks without one run the default (engineer, reviewer). With `verification.reviewerRequired`, a gate must come after the last stage that commits. Every gate stage starts only on a verified head (see [Testing](#testing)).

**How a role is added.** The coordinator owns the configuration: it writes a partial config (the role under `roles.<name>` with an inline `promptText`, and the workflow that uses it) and applies it with `minions control apply --file <f> --reason <why> --json`. The change is validated like any config (an invalid one is refused with the field named, nothing is written), journaled and undoable (`minions control undo`), and takes effect for the next stage. `minions control show --json` shows what it set. You can also edit `roles` and `workflows` by hand on the host; validation is the same.

**Worked example: a researcher.** Research questions keep coming up, and their output is a notes file, not code. The coordinator adds a researcher that may write only under `docs/research/`, plus a `research` workflow that sends its notes to the reviewer:

```json
{
  "roles": {
    "researcher": {
      "description": "Researches a question and writes findings to a notes file. No code edits.",
      "contract": "producer",
      "edits": { "paths": ["docs/research/**"] },
      "tools": ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
      "model": "sonnet",
      "requires": ["network.use"],
      "promptText": "You research the question in the task. Read the code and the sources you need, then write your findings to docs/research/<task-id>.md: the question, the answer, the evidence (links, file references), open points. Never edit code, tests or configuration. Commit the notes file on the task branch."
    }
  },
  "workflows": { "research": ["researcher", "reviewer"] }
}
```

```sh
# inside the runtime (the coordinator does this)
minions control apply --file /tmp/researcher.json --reason "recurring research tasks need web access and a notes file" --json
```

The coordinator then creates research tasks with `--workflow research`. `minions work next` offers a `researcher` stage first (agent `minions:researcher`, model `sonnet`) and a `reviewer` stage after it. The researcher's commit may touch only `docs/research/**`, so a code edit makes its result invalid. `requires: ["network.use"]` makes the claim fail with a clear reason under a policy that does not allow the network. WebSearch and WebFetch also need a container network that allows outbound traffic.

## Delivery, review, and merging

minions works only locally: it never pushes or talks to GitHub; you push the base branch yourself. Workers commit on `agent/<slug>` branches in the runtime's own clone. An approved task that is not merged yet is reported as **delivered**; once it lands on the container's local base branch it is **done**. Who merges depends on `delivery.merge` and the mode (see [Coordinator defaults](#coordinator-defaults)).

| `delivery.merge` | Behavior |
| - | - |
| `disabled` | Commits locally, writes a handoff; the coordinator integrates approved branches into the local base (independent) or leaves them to you (supervised) |
| `auto-when-eligible` | The runtime's local integrator merges each approved head, verifies the merged tree, and fast-forwards the local base (automatic local integration); the coordinator merges nothing |

**Approvals are signed on the host.** If a change touches a sensitive path (or `base.merge` is `ask`), nothing lands until you approve that exact commit with `minions work approve <taskId> --head <sha>` **on the host** (in the repository, not inside the container). The host signs the approval with a per-project key the container cannot read, and the runtime checks the signature before it lands the commit. An approval recorded inside the container (by the coordinator, a worker, or a script) is rejected. `minions work publish <taskId>` queues the integration again after an approval or a transient failure.

**How the base reaches your remote.** In `independent` mode without automatic local integration the coordinator integrates each approved branch into the container's base branch itself (`supervised` never merges) through a gate: `git merge --no-ff --no-commit` of the approved branch, then every configured verification command on the merged tree (for example `npm run typecheck` and `npm test`); it commits the merge only when all of them pass, and otherwise aborts it (the base has not moved) and sends the task back for a repair. With automatic local integration on, the runtime runs this gate itself (see [Merging](#coordinator-defaults)); the coordinator never merges. The integrated base stays in the container's clone until you take it, on the host, in your repository:

1. `minions export` fetches the container's branches into `refs/remotes/minions/*` (`agent/*`, and the integrated base as `minions/<base>`); your local branches are untouched. Review with `git log <base>..minions/<base>`.
2. Fast-forward your base to it: `git merge --ff-only minions/<base>` with the base checked out, or `minions upgrade --sync-only`, which exports and fast-forwards in one step and refuses a dirty tree or a divergence (it never merges, resets or force-updates). In a minions checkout, `minions upgrade --from-container` does the same before it upgrades the container.
3. Push it yourself: `git push origin <base>`. If your remote requires pull requests, push a branch instead (`git push origin minions/<base>:refs/heads/<name>`) and open the pull request from it.

The gate runs the full suite while workers run theirs, and the container's process limit counts threads; see [The verification gate fails under load](docs/troubleshooting.md#the-verification-gate-fails-under-load) if it fails with timeouts or `EAGAIN`.

**Evidence is tied to commits.** Test results, the review verdict, and local checks are recorded against a head SHA and a config revision. A new commit invalidates stale evidence.

## Permissions and capabilities

Authority is a set of independent capabilities. Each rule is `allow`, `ask`, or `deny`, optionally limited by role and path:

| Area | Capabilities |
| - | - |
| Tasks | `task.read`, `task.create`, `task.update`, `task.start` |
| Code | `code.edit`, `dependencies.edit`, `architecture.change`, `migrations.edit` |
| Git | `git.commit`, `base.merge` |
| Infrastructure | `ci.edit`, `infrastructure.edit` |
| Other | `network.use`, `deploy.execute` |

- Explicit `deny` always wins.
- A prompt, task, or ticket comment can't grant a capability.
- minions keeps three questions separate, and `doctor` reports each one: Is the action **permitted**? Is the needed **credential** available? Can minions **enforce** the restriction mechanically?

### Coordinator permission mode

The coordinator Claude Code session (and the workers it spawns) runs in permission mode **`auto`** by default, in both runtimes. The fixed rules are the same in every mode: `git push` and recording an approval (`minions work approve` / `minions approve`) are denied, so the coordinator never blocks on a prompt for them. Approvals are signed by you in the host terminal.

| `coordinator.permissionMode` | What prompts |
| - | - |
| `auto` (default) | Nothing for allowlisted commands; a Claude Code classifier decides the rest instead of asking you. |
| `acceptEdits` | Every Bash call outside the allow list asks. |
| `bypassPermissions` | Nothing. The team runs fully unattended; only the deny rules (and, in the host runtime, the sandbox unless you turn it off) remain. |

`bypassPermissions` (and `coordinator.sandbox false`, see [Running without Docker](#running-without-docker)) can only come from your host-only `config.local.json`: a committed `.minions/config.json` that sets either is refused. Set it with `minions settings set coordinator.permissionMode bypassPermissions`, or let the coordinator request it and confirm the request.

**Trade-off.** With `auto`, the classifier judges calls you would otherwise have reviewed yourself; with `bypassPermissions` nothing judges them. The deny rules are command patterns, so other commands with the same effect (for example `sh -c 'git push ...'`) are not caught by them.

`minions coordinator --probe` (and `doctor`) report which mode the launch will use. If the installed Claude Code doesn't offer `--permission-mode auto`, the coordinator falls back to `acceptEdits`, prints why when it starts, and `doctor` shows a warning. A mode change takes effect when the coordinator restarts. The legacy top-level `permissionMode` key now matters only when it is `"default"` (stricter, still honoured; passed as `manual` where Claude Code lists only that name).

### Coordinator startup context

Every coordinator turn re-sends the session's tool definitions and skill listing, so their size is paid on each turn. The coordinator launch removes Claude Code built-in tools it never uses (`--disallowedTools`: Artifact*, DesignSync, Workflow, Cron*, Monitor, ScheduleWakeup, RemoteTrigger, NotebookEdit, worktree and plan-mode tools, WebSearch/WebFetch, SendFeedback, ReportFindings), turns tool search on (`ENABLE_TOOL_SEARCH` in its settings, so rarely used tools such as the Telegram ones are loaded on demand) and hides Claude Code's bundled skills. The minions and Telegram plugin skills, Agent, SendMessage, Bash, Read/Edit/Write, Skill and the hooks stay. Worker agents are unaffected. To change it (takes effect at the next coordinator restart):

```json
{ "coordinator": { "disallowedTools": ["Artifact", "Monitor"], "toolSearch": false, "bundledSkills": true } }
```

A `disallowedTools` list replaces the default (`[]` keeps every tool); tools the coordinator needs are rejected. `minions settings` (Policy) edits all three: `settings set coordinator.disallowedTools none` keeps every tool (a loosening change that needs a yes), `default` restores the built-in trim.

## Sensitive changes

Changes to these paths need human approval before they are merged into the base. Local planning and proposed edits can still be allowed.

```
.github/workflows/**   .github/CODEOWNERS   .minions/**   .claude/**
CLAUDE.md   AGENTS.md   automation/**
infra/**   infrastructure/**   deploy/**   terraform/**   **/migrations/**
```

You can change the list through the configuration workflow. A worker change that tries to change its own control policy is handled separately from a reconfiguration you authorized. The development identity can never self-approve changes to credentials, workflow trust, or merge gates.

In v0.1 minions enforces path rules locally and says plainly that the repository has no hard gate for them.

## Configuration

Settings resolve in this order, with later sources overriding earlier ones:

1. Package defaults
2. Project configuration
3. Private project overrides
4. Session overrides, for non-persistent choices such as narrowing permissions, lowering concurrency, or picking an already-allowed model

Each effective value records where it came from:

```sh
minions settings --list           # every setting with its value and source (mode default / project or shared config / local override)
minions config show --explain     # advanced: the raw effective config, every value with its source
```

### Changing settings

`minions settings` (or `minions settings --list`) lists every setting in grouped sections (Delivery, Verification, Reporting, Models, Concurrency, Policy, Permissions, Integrations, Pause, Agents, Container) with its current value, where it comes from and how a change takes effect. `settings set` changes one:

```sh
minions settings --list [--json]                      # every setting, value, source, restart/loosening flags
minions settings set execution.maxActiveTasks 3 --yes # one change; --json for an envelope
minions settings set execution.maxEngineers 3 --yes   # (maxEngineers must stay <= maxActiveTasks: raise that first)
minions settings set models.effort default            # "default" removes an optional setting
minions settings restart                              # graceful coordinator restart for pending changes
```

- **Validation first.** Every edit is checked with the full config schema against all layers before anything is written; an invalid value (say `maxEngineers` above `maxActiveTasks`) is rejected with the reason.
- **Where it is saved.** Changes go to the host-only `config.local.json` of the project. On a shared install, `--shared` writes the committed `.minions/config.json` instead (with a `configRevision` bump; commit it yourself). A local override can't lift a `deny` set in the project config.
- **No silent loosening.** A change that widens what the team may do (more concurrency or turns, skipping the reviewer or tester, automatic local integration, starting tasks without asking, a looser capability or permission mode) shows what it allows and needs a yes; `set` needs `--yes` without a terminal.
- **Taking effect.** Each save regenerates the runtime config and the mounted plugin. Concurrency (max active tasks and engineers), repair cycles, context resets and pause/resume take effect on the runtime's next command. Settings the coordinator and worker definitions read at session start (delivery, verification, reporting, models including the default model, the per-attempt turn limit, permissions) and launch settings (channel, coordinator model, effort, permission mode, the coordinator tool trim, tool search and bundled skills) need a coordinator restart: `settings set` offers it (`set --restart` / `--no-restart` decide up front). The restart is graceful: it is refused while workers are active, and `minions settings restart` retries it later. Container resource limits (CPUs, memory, process limit, /tmp size) take effect with `minions upgrade`, which recreates the container with them (volumes kept).
- **Tokens.** The Telegram and OpenAI (Codex) key items show only provisioned/missing; store or remove them with `minions auth telegram` / `minions auth codex`.

`minions config` stays as an advanced alias: `config show [--explain]` (raw effective config), `config list` (= `settings --list`), `config set` (= `settings set`).

Each change is classified by when it takes effect (`minions settings --list --json` reports it per setting as `apply` and `class`, plus `hostOwned`; `settings set` prints the matching line, and its `--json` envelope has `class`, `hostOwned`, `takesEffect` (`now` / `restart` / `upgrade`, null when nothing changed), `needsRestart` and `needsUpgrade`). Every key of the config schema has a class (`live`, `restart`, `recreate` or `fixed`) and a host-owned flag (`src/config/setting-classes.ts`, docs/design/host-manager.md):

| Impact | Example |
| - | - |
| immediate (`live`) | Lowering concurrency stops new starts; running work continues. Pause/resume, repair cycles, context resets |
| restart-required (`prompt`, `launch`) | Changing the default model or the per-attempt turn limit: workers run the `model` and `maxTurns` of their definitions, which the coordinator session loads at start (a brief's `model` / `maxTurns` fields already show the new value at the next claim, but they are informational). Updated prompts or tool permissions, coordinator launch settings, Telegram changes (`minions channel set`, `minions auth telegram`) |
| upgrade (`recreate`) | Container resources, network, published ports and mounts, the git identity: `minions upgrade` recreates the container (volumes kept) |
| migration (`fixed`) | Switching backlog backend, switching private and shared visibility |

Tightening permissions suspends the affected external actions immediately. A worker still running on an older config revision is blocked from sensitive external operations. The coordinator changes configuration itself with `minions control set <key> <json> --reason <text>` (validated, journaled, undoable with `minions control undo`; a change to a host-owned key also notifies you), and adds worker roles the same way (see [Custom roles](#custom-roles)). For a newer minions or a container setting it records an upgrade request (`minions upgrade --reason <text>` in the runtime) that you apply with `minions upgrade` on the host. Only tokens and other secrets stay with you (`minions auth ...`).

### Example (abridged)

```json
{
  "schemaVersion": 1,
  "configRevision": 1,
  "projectId": "3f1c…",
  "mode": "independent",
  "visibility": "shared",
  "backlog": { "backend": "backlogmd", "ownership": "direct" },
  "intake": {
    "sources": ["user", "milestone"],
    "startReady": true,
    "scope": { "requiredLabels": ["minions:ready"], "allowedPaths": ["**"] }
  },
  "container": { "cpus": 4, "memoryMiB": 6144, "pidsLimit": 512, "publishPorts": [] },
  "execution": { "maxActiveTasks": 3, "maxEngineers": 2, "maxRepairCyclesBeforeReplan": 3, "attemptMaxTurns": 80 },
  "models": { "default": "sonnet", "allowed": ["sonnet", "opus", "haiku"], "selection": "coordinator" },
  "delivery": { "merge": "auto-when-eligible" },
  "verification": { "commands": [], "reviewerRequired": true },
  "communication": { "channel": "auto", "progress": "milestones" },
  "budgets": { "taskUsd": 5, "dailyUsd": 20 }
}
```

The full shape is defined by the JSON Schema shipped with the package. Unknown fields and contradictory settings fail with an actionable error. Secrets appear only as references, never as literal values.

## Models and budgets

- Workers default to `sonnet`. `opus` and `haiku` are also allowed, limited to whatever your account can actually use.
- The coordinator picks the model and worker definition for each attempt: smaller models for narrow inspection, the higher-effort engineer (and then a stronger model) for hard debugging, architecture work, or repeated failures.
- `models.default` is written into every worker definition (agent frontmatter `model`), so it may be a full model ID. The Agent tool only accepts the aliases `sonnet`, `opus`, `haiku` and `fable` as a per-call `model`, so the coordinator omits `model` for the default and passes only an allowed alias to override it; the launch hook denies a full ID. Other full IDs in `models.allowed` can't be chosen per call (they still count for `models.coordinator`).
- `models.effort` (`low` | `medium` | `high` | `xhigh` | `max`, unset = Claude Code's default) sets the workers' reasoning effort (agent frontmatter `effort`) and the coordinator's (`--effort`). An Agent call can't change effort, so it comes from the definitions. `models.effortByRole` (`engineer`, `engineerDeep`, `tester`, `reviewer`, `coordinator`; each optional) overrides it per role, falling back to `models.effort`. `models.coordinator` picks the coordinator session's model (`--model`; must be in `models.allowed`).
- Two engineer definitions are generated from the same template: `minions:engineer` for routine work and `minions:engineer-deep` at `effortByRole.engineerDeep` (default: one level above the engineer's effort, `high` when that is unset). The coordinator uses engineer-deep for hard debugging, architecture work, or a retry after an engineer attempt failed. Both run under the same engineer lease.
- Example, routine engineers at low effort with medium testers, reviewers and coordinator, and a medium-effort deep engineer: `"models": { "default": "claude-opus-5-5", "allowed": ["claude-opus-5-5", "sonnet", "opus", "haiku"], "selection": "coordinator", "effort": "medium", "effortByRole": { "engineer": "low" } }`. Change them with `minions settings` (Models), which regenerates the definitions and offers the coordinator restart.
- Each attempt is capped at 80 turns, and a task replans after 3 repair cycles. These are attempt limits; they don't cancel the task.
- Per-task and per-day USD caps are optional and off by default. When set, minions checks known usage before starting each attempt and stops new starts once a cap is reached. Usage figures may be estimates, and minions records how reliable they are. It doesn't promise hard billing enforcement.
- minions tracks completion time, attempts, repairs, human interventions, and available usage per task.

## Other agents (OpenAI Codex)

By default every worker is a Claude Code subagent. minions can also run workers on another agent harness as a separate, sandboxed process: OpenAI Codex CLI today, JetBrains Junie later (its adapter is not built yet). The design is in [docs/design/agent-runtimes.md](docs/design/agent-runtimes.md).

**What this version allows (phase 1, option b).** Codex runs only as a read-only extra reviewer: a project role `codex-reviewer` (contract `gate`, harness `codex`) is added as a stage after the Claude reviewer in one workflow you pick, and both must approve. Engineering, testing, the built-in review and coordination stay on Claude Code, so Claude credentials are still needed. Nothing a Codex worker writes reaches a branch: a gate on a process harness has a review worktree, no edits and no commits.

**Turning it on.** `minions setup` asks "Which agent should do the work?" (Claude Code, OpenAI Codex CLI, JetBrains Junie, or later). Choosing Codex:

1. stores an OpenAI API key (prompted without echo; the same as `minions auth codex`). Use a key of a dedicated OpenAI project with a usage limit: it is billed at API prices;
2. asks for the Codex model (an OpenAI model id your key can use) and writes `harnesses.codex.models`;
3. sets `harnesses.default: "codex"`. It applies only to the roles this version allows on a process harness (project gate roles); every other role stays on Claude Code;
4. adds the `codex-reviewer` role and its stage after the reviewer in the workflow you choose (`default` writes the derived default stages out explicitly, so `verification.reviewerRequired` no longer reshapes it).

Everything goes to the host-only `config.local.json` and is validated before it is written. The host runtime refuses process harnesses, so setup does not ask there.

**The harness ships in the image.** The runtime image includes the Codex CLI, pinned (`@openai/codex@0.164.0`, see [compatibility](docs/compatibility.md)). If the `codex` binary is missing or does not match the pin (for example a container still on an older image; `minions upgrade` rebuilds it), a Codex stage ends without a result (the runner reports it as `blocked` with the exit status), and the coordinator tells you. `minions doctor` (`harness.codex`, `harness.network`) and `minions work probe` in the runtime show the binary, its version and the sandbox self-test.

**Changing it later.** `minions settings` (Agents) has `harnesses.default`, the OpenAI key, and one `roles.<role>.harness` item per worker role. A process harness is refused where this version does not allow it (for example `roles.engineer.harness codex`), with the reason. `minions settings set roles.codex-reviewer.harness claude` keeps the second review but runs it on Claude Code; `harnesses.default claude` (or rerunning setup and choosing Claude) turns the squad-wide choice off. Harness changes need a coordinator restart, which `settings` offers.

**How the coordinator runs it.** For a Codex stage `minions work next` returns `launch: {kind: "run", command: "minions work run <leaseId> --json", ...}` instead of an Agent to spawn. The coordinator claims the stage, runs that command in the background and records the result when it exits (the runner submits the result and records the token usage itself). The runner gives the worker a private clone of the branch, runs it under `minions-sandbox` (Landlock and seccomp: no access to `/state`, the secrets mount or the Telegram bot), enforces a wall clock (`harnesses.codex.timeoutMinutes`, default 60) and checks the result before it is submitted.

## Communication

**Terminal** is the baseline for setup and recovery, and it always works.

**Telegram** uses the official Claude Code channel plugin (a research preview) with your own bot. Only paired senders can control the coordinator; unpaired senders are dropped. Pair only yourself, because allowlisted senders can also approve tool-permission prompts. If Telegram is unavailable, the coordinator starts in terminal mode and says why. Each bot can be polled by only one coordinator at a time, so use a separate bot for each project you run at the same time.

`communication.channel` takes three values:

| Value | Effective channel |
| - | - |
| `auto` (default for new installs) | Telegram when a bot token is stored for the project (`minions auth telegram`) and the runtime is Docker; otherwise terminal. Like `telegram`, it falls back to terminal with a reason when the plugin probe fails or the network is `none`. |
| `telegram` | Telegram; when it can't start (no token, host runtime, plugin unavailable) the coordinator warns and runs terminal-only |
| `terminal` | Terminal only; a stored token is ignored |

```sh
minions channel show                      # configured vs effective channel, and why
minions channel set auto|terminal|telegram [--dry-run] [--yes]
```

`channel set` edits the project configuration the install uses (shared `.minions/config.json` or the private config), bumps `configRevision`, validates the result, and never overwrites a file that fails to parse. It doesn't commit: for a shared install, commit `.minions/config.json` yourself. The change is restart-required (`minions down && minions start`). `minions status` also shows the configured and the effective channel. The host runtime has no Telegram, so `auto` means terminal there.

Turning Telegram on:

1. Create a bot with [BotFather](https://t.me/BotFather) (`/newbot`) and copy its token. Use one bot per project.
2. Store the token: `minions auth telegram` (prompted without echo, or `--stdin`). If the channel is `terminal`, it offers to switch to `auto`.
3. Restart: `minions down && minions start` (installs the plugin and starts the coordinator with Telegram).
4. Pair in the coordinator terminal: DM your bot, then type `/telegram:access pair <code>`, then `/telegram:access policy allowlist`.

What you receive (the same on every channel). By default the coordinator reports at the feature level:

- acknowledgements of new goals
- a short summary when a user-visible feature or epic is delivered or materially changes, with branch names or links; features that land close together come in one message
- significant blockers and changed plans
- approval requests and high-level questions
- status, when you ask for it (with task-level detail if you want it)

You don't get per-stage updates: engineer, tester, and reviewer hand-offs, repair cycles, task splits, follow-up tasks, and individual merges stay in the backlog, and `/minions:status` (or `minions status`) shows them on request.

The coordinator asks you only about high-level decisions: product scope and goals, architecture direction, security and privacy trade-offs, anything outward-facing, and every capability whose policy effect is `ask` (those still need your explicit approval, as do sensitive-path changes). It makes lower-level decisions on its own, within the task's scope and policy, and records them as backlog notes or decision files. That covers task splits, follow-up tasks, model choice, test fixes, implementation approach, and review nits.

`communication.progress` sets how much it reports unprompted. The value is validated by the config schema.

| Value | Unprompted reports |
| --- | --- |
| `milestones` (default) | Feature-level progress, as described above. |
| `tasks` | Each delivered task with its branch, plus blockers and approvals. |
| `quiet` | Only blockers that need you, approval requests, and high-level questions. Deliveries show up when you ask for status. |

The reporting level never changes what needs approval. The coordinator prompt and skills are generated from the config, so a change takes effect once the plugin is regenerated on the host (`minions init`) and the coordinator restarts.

You won't get tool-call or test-log spam. Every question includes a recommended answer and says what is blocked until you reply. Notifications that fail during a Telegram outage are queued with deduplication keys and resent later; the model is not woken up just to resend them.

The Telegram controls (pause intake, pause new starts, cancel workers, resume, status) also exist as terminal commands that work without Claude.

## Claude authorization

How Claude Code inside the container gets credentials is a **host-side** setting (`claudeAuth` in
the project's `project.json`, outside the repository). It is never read from `.minions/config.json`
or any repository file, so a cloned repository can't make your Mac run a command.

| Method | What happens |
| - | - |
| `login` (default) | Run `/login` in the coordinator session; the login is kept in the project's `claude` volume. |
| `api-key` | The host reads a key from a file (`--file`), the macOS Keychain (`--keychain-service`/`--keychain-account`, via `security find-generic-password … -w`), or a host env var (`--env-var`). |
| `helper` | The host runs a fixed argv command (no shell) that prints the key on its last output line. It runs on every `minions start`, on `minions auth refresh`, and every `--refresh-minutes` (default 30) while `minions start` stays attached. If a periodic refresh fails, the old key is kept and a one-line warning is shown. |

For `api-key` and `helper`, the host writes the key to
`projects/<id>/secrets/anthropic-api-key` (directory 0700, file 0600, replaced atomically) and
mounts the `secrets` **directory** read-only at `/opt/minions/secrets`, so refreshed keys show up
without a restart. Claude Code in the container gets `apiKeyHelper: "cat /opt/minions/secrets/anthropic-api-key"`
and re-reads the file every 5 minutes. The key is never put in environment variables, process
arguments, `compose.yaml`, logs, or command output. If the key can't be obtained on `minions start`,
nothing is launched and the command exits with `AUTH_REQUIRED`.

`--env NAME=VALUE` (repeatable) adds non-secret container environment such as `ANTHROPIC_BASE_URL`.
Hosts `127.0.0.1`, `localhost`, and `[::1]` in those values are rewritten to `host.docker.internal`
so the container reaches services on your Mac (`--no-rewrite-loopback` turns that off). `minions auth show`
masks values after the scheme and host.

**JetBrains Central:**

```sh
minions auth set jbcentral      # shows the plan; asks before applying (--yes to skip, --dry-run to preview)
minions start
```

The `jbcentral` preset runs `central proxy start --ensure-updated --caller agent --return-key` on the
host, and takes `ANTHROPIC_BASE_URL` from `env.ANTHROPIC_BASE_URL` in your host `~/.claude/settings.json`
(only that key is read, only when you pick the preset). If it's missing, run `central add claude`
first or pass `--base-url <url>`. The container reaches the local Central proxy through
`host.docker.internal`.

**Custom helper:**

```sh
minions auth set helper --refresh-minutes 15 -- /usr/local/bin/print-anthropic-key --profile work
minions auth set api-key --keychain-service anthropic --keychain-account "$USER"
minions auth refresh            # re-run the helper / re-read the source now
minions auth show [--json]      # method, source, masked env, key file status, last refresh and the Codex key status; never a key
```

**Headless runs (live checks in a fresh config dir):** when a task needs a live Claude Code run, the
coordinator starts it with `minions coordinator live-run -- <claude args>` (prompt on stdin). The run
gets a fresh, empty `CLAUDE_CONFIG_DIR`, so it loads none of the coordinator's plugins (above all not the
Telegram channel) and cannot take the bot. It is refused while any worker lease is active, and the
worker hooks refuse it to every subagent. `--dry-run` shows the credential path, argv and settings
without a secret.

- `api-key`, `helper`, `jbcentral`: nothing to do. The run's settings get the same apiKeyHelper
  (`cat /opt/minions/secrets/anthropic-api-key`); the key is never copied.
- `login`: a fresh config dir has no `/login`, so store a long-lived token once, on the host:

  ```sh
  claude setup-token                          # prints a token (sk-ant-oat01-…); it is valid for about a year
  minions auth set login --headless-token     # paste it at the hidden prompt (or: --headless-token --stdin --yes < file)
  minions auth show                           # "headless token …: ok — oauth-token stored in …"
  ```

  The token is kept in the Keychain (Secret Service on Linux, or a 0600 host file) and copied to the
  mounted `secrets` directory (0600); a running container sees it at once. Only `live-run` reads it and
  passes it to its `claude` as `CLAUDE_CODE_OAUTH_TOKEN` (an Anthropic API key stored this way goes in as
  `ANTHROPIC_API_KEY`), never in argv, the coordinator's config, logs or `status`. The worker hooks refuse
  tool calls that name the secrets dir. `minions auth set login --remove-headless-token` deletes it.

**Global default:** `minions auth set <method> … --global` writes `<MINIONS_HOME>/defaults.json`
(`{ "claudeAuth": … }`), which `minions init` uses for new projects. A project's own setting always
wins. The `init` wizard asks the same question (JetBrains Central is offered only when `central` is
on your `PATH`; it is looked up, not run).

`minions doctor` checks the method (Docker runtime; the host runtime has no container to check): for `login`, `claude auth status` inside the container; for keys,
that the key file is present and fresh, the helper resolves on `PATH`, the key is readable inside the
container, and that `ANTHROPIC_BASE_URL` (when set) answers HTTP from inside the container. Doctor
makes no API calls that use tokens.

**Security notes:** a provisioned key is readable by any process in the container, including every
worker. Helper commands run on your Mac with your user rights; they live only in host-side
configuration (`project.json`, `defaults.json`), which the container can't modify. The container never
gets the host `central` binary, your `~/.claude`, the Keychain, or a way to run host commands.

## Security model

**What Docker protects:**

- Agents run as a non-root user with no privileged mode, no host networking or PID namespace, no host devices, dropped capabilities, `no-new-privileges`, and the default seccomp profile.
- The root filesystem is read-only, with explicit writable volumes and a temporary `/tmp`.
- Defaults are 4 CPUs, 6 GiB RAM, and 512 processes.
- Agents never get the Docker socket, your home directory, your SSH agent, your host Claude config, or a general way to run commands on the host.
- The workspace is a fresh Git clone in a named volume, not a bind mount of your checkout. Uncommitted host changes and ignored `.env` files are never copied implicitly.
- No ports are exposed unless you approve them, and approved preview ports bind only to `127.0.0.1`.

**What Docker does not protect:**

- **Outbound internet is open by default**, so Claude, Telegram, and package downloads work. A normal Docker network doesn't block exfiltration or LAN access, and minions doesn't claim that it does.
- **Workers share one container.** The engineer, tester, and reviewer can read the same files and every credential mounted into the container. A reviewer with shell access is read-only only by workflow.
- Credentials you inject can be used for whatever they allow.

**Credential handling:**

- Long-lived secrets stay on the host, in macOS Keychain, the Linux Secret Service keyring (`secret-tool`, when a desktop session provides one), or in 0600 files outside the repository.
- The Keychain items are created without a `-T` access list, so any process running as your user can read them (normal macOS behaviour; the Keychain protects against other users and offline access, not against your own processes). The plaintext Telegram token copies mounted into the container (`secrets/` in the project directory) are removed by `minions down`/uninstall, when `minions start` fails, or when `minions doctor` finds them with no running container. The host-provisioned Claude key copy in the same directory stays until you switch back to `login` or uninstall (each `minions start` re-provisions it).
- Configuration holds references only.
- Tokens, environment dumps, and private task payloads are never logged, and logs are kept bounded with predictable secret values redacted.
- Ticket and repository content is treated as untrusted. External commands use argument arrays, never shell strings built from that content.

There is no default production credential injection and no deployment authority.

## Running without Docker

> **Warning: the host runtime is less safe.** Agents run as your macOS user. They can use your files, Keychain, SSH keys, network and credentials, and there are no container limits (CPU, memory, processes, read-only filesystem). Prompt injection in repository, issue or web content could act on your machine. Use the default Docker runtime for repositories and tasks you don't fully trust.

The runtime is a **host-side** setting (`runtime` in the project's `project.json`, or the default for new projects in `<MINIONS_HOME>/defaults.json`). A repository can't select it: `.minions/config.json` has no such field, and the strict schema rejects it.

```sh
minions init path/to/repo --runtime host     # or choose supervised mode, which runs on the host
minions runtime show                          # docker | host, with the warning when host
minions runtime set host                      # prints the warning; type "host" to confirm (or --yes)
minions runtime set docker                    # back to the container (no confirmation needed)
minions runtime set host --global --yes       # default for new projects; each init/start still warns
```

Switching needs the old runtime stopped (`minions down`). Agent branches, backlog and runtime state are not copied between runtimes; run `minions export` first to keep agent branches.

**What changes in host mode**

- **Separate clone.** Agents never touch your checkout. Their clone, worktrees, backlog and runtime DB live under `<MINIONS_HOME>/projects/<id>/host/{workspace,state}` (0700), seeded from a Git bundle of the committed base branch, exactly like the container workspace. `minions import` and `minions export` work as with Docker (export fetches `agent/*` into `refs/remotes/minions/*`).
- **Commands run directly.** `start`, `status`, `pause`, `resume`, `work publish|approve` and the coordinator run on the host through a generated `minions` shim (`host/bin/minions`) that pins `MINIONS_RUNTIME=host` and the paths. They get an allowlisted environment (locale, terminal, proxy/CA variables and `CLAUDE_CONFIG_DIR` from your shell; cloud tokens, `ANTHROPIC_API_KEY`, `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`, `NODE_OPTIONS` and the like are dropped). The coordinator runs in a dedicated tmux server (`tmux -L minions-<id>`), never your default one; `minions down` kills that server. `tmux attach` hint: `tmux -L minions-<id> attach -t coordinator`.
- **Claude Code is started without your settings.** The coordinator runs `claude --setting-sources= --strict-mcp-config`: no user (`~/.claude`), project or local settings (so no hooks, MCP servers, plugins, permission rules or sandbox exclusions from your setup or from the repository's `.claude/` / `.mcp.json`) and no MCP servers. Only minions' own `--settings`, its plugin, and any managed (admin) settings apply. Your login still works (credentials are not settings). The repository's `CLAUDE.md` is not auto-loaded; the coordinator is told to read it. The permission mode is `coordinator.permissionMode`, as in the container (default `auto`; `bypassPermissions` only from your local config).
- **Sandbox.** Claude Code's sandbox is on by default (`autoAllowBashIfSandboxed: true`: a command that stays inside the sandbox runs without a prompt; `allowUnsandboxedCommands: false`, `failIfUnavailable: true`). `minions settings set coordinator.sandbox false` (local config only, a loosening change) turns it off for fully unattended work that needs more than the workspace, such as developing minions itself on the host; commands then run as your user with your full access, and only the permission deny rules below still apply. Bash commands of the coordinator and workers may write only to the agents' workspace and state (tool caches such as npm, corepack, pip, Go and `XDG_CACHE_HOME` are redirected into the state dir). `permissions.blockReadsOutsideWorkingDirectories` hides your home directory from them and from the Read tool, except the agents' own dirs, your global git config, toolchain dirs (PATH entries, nvm/volta/rustup/…) and the parts of `~/.claude` Claude Code needs. On top of that, credential, browser, mail and shell-history locations (`~/.ssh`, `~/.aws`, `~/.claude.json`, `~/Library/Cookies`, browser profiles, …), the whole minions data root (except this project's workspace, state, shim, config and plugin), other projects, and tmux's socket directory are denied, and no Unix sockets are reachable. Network: the npm registry; other hosts prompt (unless the sandbox is off). Shell startup files, `~/.gitconfig`, `~/Library/LaunchAgents`, `~/.claude`, the workspace's `.git/config`/hooks and `.claude`/`.mcp.json` files are not editable. Git is allowed only as specific subcommands (no `git config`, `git -c`, remotes or push); repository verification commands get an allow rule only when they are plain commands (no globs, operators, quotes or shells).
- **Git outside the sandbox.** minions itself runs git in the agents' clone outside the sandbox (import refresh on `start`, `export`, `work publish`). Those calls neutralize the clone's config: hooks, fsmonitor, pager, askpass and ssh commands off, credential helpers reset, only https (and local bundles) as transports, every clean/smudge filter emptied, `core.worktree` pinned, no submodules, no system config. Bundles are copied through host-owned dirs (`host/transfer`) without following symlinks; the hooks' log lives in `host/logs`.
- **Keychain.** Sandboxed commands can still reach the Keychain service, and items created by `security` trust `/usr/bin/security`. So while any project uses the host runtime, minions stores tokens in its 0600 file store (sandbox-denied), and `minions start` moves existing minions Keychain items of every project there.
- **Claude authorization.** `login` uses your existing Claude Code login on this Mac (no key handoff). `api-key` / `helper` / `jbcentral` write the key to `projects/<id>/secrets/anthropic-api-key` (0600) and the coordinator gets `apiKeyHelper: "cat '<that file>'"`; no loopback rewrite is needed.
- **Tools.** You install `tmux` (`brew install tmux`), Claude Code (`npm install -g @anthropic-ai/claude-code` or `brew install --cask claude-code`), Backlog.md (`npm install -g backlog.md@1.54.0`) and `git`. `minions doctor` checks their versions and shows a warn-level `runtime` check.
- **Not in host mode.** Container resources and preview ports don't apply. Telegram is unavailable: the plugin would live in your own Claude Code setup, which the host runtime doesn't load (`minions telegram install` refuses); the coordinator stays terminal-only (`communication.channel` `auto` simply means terminal there; explicit `telegram` warns). A new `supervised` project runs on the host unless `--runtime` or the `minions defaults` runtime says otherwise; a new `independent` project runs in Docker unless `--runtime host` is given.

**Residual risks (read before choosing host mode)**

- Hooks of the minions plugin, `apiKeyHelper`, and the Read/Edit/Write tools run outside the sandbox; they follow the permission rules above, and anything you approve at a prompt runs as you, with your full access.
- With the `login` method, Claude Code's own OAuth credentials are in your Keychain, and sandboxed commands can reach the Keychain service: an agent able to run `/usr/bin/security` may be able to read items that trust it. minions denies `security` at the permission layer (best effort, not a boundary).
- The sandbox's network filter works on host names: allowed domains such as `registry.npmjs.org` can be abused for exfiltration (for example domain fronting).
- The filter neutralization for git runs just before each git call; an agent racing a new filter driver into the clone's config in between is not fully excluded (the sandbox and permission rules deny writes to that file).
- Everything the sandbox allows (workspace, state, network to npm, running your toolchains) happens as your user with no CPU, memory or process limits. Managed (admin) Claude Code settings still apply and could loosen the policy.
- Verified against Claude Code 2.1.292 documentation and binary; the sandbox behaviour itself is not exercised by minions' tests (they use a fake `claude`).
- **Uninstall.** `minions uninstall` stops the tmux server and keeps `host/` (workspace and state); `--delete-data` deletes it.

## CLI reference

The full command reference is in [docs/cli.md](docs/cli.md). `minions help --all` prints the same grouping: the primary commands from [Everyday use](#everyday-use), advanced commands for single steps and fine-grained control, and internal commands used by the coordinator, workers, hooks and the container. Every command supports `--json`, and mutating commands support `--dry-run`.

## Recovery, upgrades, and uninstall

When something breaks (Docker down, Claude auth expired, the coordinator died, a stuck lease, Telegram pairing or polling, token problems, a failed upgrade), see the [troubleshooting and recovery guide](docs/troubleshooting.md) for the exact command for each case.

- **State backup and restore.** `minions export --state [file]` writes a backup of the runtime state (backlog, notes, worker briefs and results, and a consistent snapshot of the runtime database) as a tarball with a checksummed manifest; it never contains tokens, the Claude key or the Claude login. `minions import --state <file>` validates it and restores it into the running runtime (for example a fresh project volume); it is refused while workers or the coordinator are active unless `--force`, and the replaced state is kept under `pre-restore/`. See [docs/troubleshooting.md](docs/troubleshooting.md#before-risky-steps-back-up-the-runtime-state).
- **Restart and recovery.** `minions start` reconciles sessions, branches, leases, and completed external actions before it retries anything, then attaches to or relaunches the coordinator. If a worker fails, its worktree and a recovery record are kept. minions never cleans up worktrees it doesn't own.
- **Upgrades.** `minions upgrade` moves the container onto the installed minions package without losing progress. By default it drains: it pauses new starts, asks running workers to commit their work in progress and hand back, waits up to `--timeout` seconds (default 1800), and aborts with starts resumed if workers are still running. `--now` releases the workers still active instead (they are reported as interrupted and re-dispatched). It then regenerates the derived files (including the mounted plugin), rebuilds the image only when its fingerprint changed, recreates the container, refreshes the workspace and the repository import, resumes starts and restarts the coordinator with recovery. Volumes are never removed and the repository is never re-cloned; a failure before the container is recreated leaves it running and resumes starts. `--dry-run` lists the steps and `--json` prints the result. The restarted coordinator starts with a fresh context (see routine context resets above) and the trimmed tool set. `minions status` and `minions doctor` report when a running container needs an upgrade (restart-required), and `minions doctor` warns about a stale plugin. In a minions checkout it also brings the installed CLI up to date (`--rebuild-cli` allows the rebuild) or prints the command to do so; `--from-container` fast-forwards a host branch from the container first. Details: [docs/compatibility.md](docs/compatibility.md#upgrading-minions-upgrade).
- **Upgrade note: host-signed approvals (runtime DB schema 3).** Approvals recorded before this upgrade were unsigned and no longer count. Tasks that were waiting for approval stay `awaiting-human` after the upgrade: approve each again **on the host** with `minions work approve <taskId> --head <sha>`, then run `minions work publish <taskId>`. See [Host-signed publication approvals](docs/design/bootstrap.md#host-signed-publication-approvals). Deferred in v0.1 (not implemented; `minions doctor` lists it as unavailable): the upgrade plan and schema/config migration, which would produce a plan, back up the config, migrate schemas deterministically, preserve your overrides, detect edits to managed files, mark running workers stale when behavior changes, and never turn on new authority.
- **Uninstall.** Removes only the files and owned blocks recorded in the manifest that are unchanged since minions generated them. Backlogs, decision records, worktrees with work, credentials, and Docker volumes are kept. Deleting data is a separate, explicit step. A private uninstall leaves the repository unchanged.
- **Interrupted operations.** Rerunning `minions upgrade` finishes an interrupted upgrade (it remembers a pause it made). Recovery from an install/upgrade journal is deferred in v0.1.

## Out of scope for version 1

- Deployment automation, which is disabled
- Cloud hosting, a dashboard, and automatic recovery after a reboot
- Separate containers per worker, and strong isolation between workers
- Native Jira, Linear, and other enterprise tracker connectors (these are extension points)
- A restricted-egress network mode
- Docker-in-Docker, and native macOS or iOS builds
- Experimental Claude Code agent teams

## License

MIT — see LICENSE. Note that Claude Code, which the Docker image installs at build time, is distributed under Anthropic's own terms and is not covered by this license.
