# minions

minions installs a small Claude Code development team into a Git project on your Mac. A **coordinator** takes requests from a terminal or Telegram, keeps an execution backlog, and hands bounded pieces of work to **engineer**, **reviewer**, and (for QA) **tester** workers. It delivers the results as local commits, branches, or GitHub pull requests.

Everything the model controls runs inside one Docker container per project. Your Mac runs only a small, trusted `minions` CLI. (You can explicitly opt into a less safe **host runtime** without Docker; see [Running without Docker](#running-without-docker).) That CLI installs the team, starts and stops the container, provisions the credentials you grant, and handles explicit import and export.

> **Status:** version 0.1 (bootstrap) is installable from GitHub or from source (see [Install in another project](#install-in-another-project)). It implements the terminal workflow on the host through six everyday commands (`setup`, `start`, `status`, `upgrade`, `down`, `uninstall`; see [Everyday use](#everyday-use)) plus advanced commands for single steps (see [docs/cli.md](docs/cli.md)); an opt-in host runtime without Docker ([Running without Docker](#running-without-docker)); optional Telegram communication through the official Claude Code channel plugin (see [docs/design/telegram.md](docs/design/telegram.md); the notification outbox is not implemented yet); the Backlog.md backend; `local` delivery (commits on `agent/<slug>` branches, fetched to the host with `minions export`); and `branch` / `pull-request` delivery to GitHub (push `agent/<slug>`, open one PR; never merged). The rest of this README describes the intended version 1 behavior. Sections marked **(deferred in v0.1)** are not implemented yet, and `minions status --check` reports them as unavailable: GitHub Issues backend, auto-merge and merge requests, review publication, config plan/apply, backlog migration, the plan/migration parts of upgrade, budgets, companion containers, GitHub App short-lived tokens (a fine-grained PAT is used instead), CODEOWNERS mapping of sensitive paths, and versioning a shared backlog in Git. `minions auth github` stores a per-project fine-grained GitHub token on the host (see [docs/design/bootstrap.md](docs/design/bootstrap.md#github-credential)); the container uses it for branch/pull-request delivery. The v0.1 contract is [docs/design/bootstrap.md](docs/design/bootstrap.md); the full requirements are in [docs/spec.md](docs/spec.md).

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install in another project](#install-in-another-project)
- [Quickstart](#quickstart)
- [Everyday use](#everyday-use)
- [Profiles](#profiles)
- [Working with the team](#working-with-the-team)
- [Backlogs and task intake](#backlogs-and-task-intake)
- [Task lifecycle](#task-lifecycle)
- [Delivery, review, and merging](#delivery-review-and-merging)
- [Permissions and capabilities](#permissions-and-capabilities)
- [Sensitive changes](#sensitive-changes)
- [Configuration](#configuration)
- [Models and budgets](#models-and-budgets)
- [Communication](#communication)
- [GitHub setup](#github-setup)
- [Setup assistant](#setup-assistant)
- [Claude authorization](#claude-authorization)
- [Security model](#security-model)
- [Running without Docker](#running-without-docker)
- [CLI reference](#cli-reference)
- [Recovery, upgrades, and uninstall](#recovery-upgrades-and-uninstall)
- [Out of scope for version 1](#out-of-scope-for-version-1)

## What it does

- **Runs an autonomous team on your laptop over many sessions.** The coordinator picks ready work, splits it, dispatches workers, and continues until the queue is empty, paused, blocked, or waiting on you.
- **Keeps durable state outside the conversation.** Decisions, task progress, handoffs, and recovery information survive a lost Claude session or a container restart.
- **Works in projects you own and in repositories you don't.** It follows an organization repository's existing architecture, CI, and contribution process, and it can keep your private subtasks out of shared trackers.
- **Gives you separate controls for task intake, proactive execution, publication, and merging.** There is no single "autonomous" switch.
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
- **Helpers.** Deterministic `minions` subcommands that the coordinator calls through a machine-readable interface. They list ready tasks, validate state transitions, claim work, record results, check policy, post reviews, and request merges. The model chooses what to do; the helpers enforce the rules.
- **Persistence.** The repository clone, runtime database, private backlog, notes, and Claude sessions live in project-scoped Docker named volumes. They survive container recreation.
- **Continuation guard.** A lightweight Stop hook checks local state. If authorized work is ready and capacity is free, the coordinator keeps working. Otherwise it is allowed to stop. Blocked dependencies, network errors, permission failures, and exhausted retries do not trigger a wake-up. If the guard loops without any state change, it stops and records a recovery reason.

## Requirements

- macOS on Apple Silicon or Intel
- Docker Desktop with Docker Compose v2, installed by you, for the default `docker` runtime. minions never falls back to running agents on the host by itself; the host runtime is an explicit, less safe opt-in ([Running without Docker](#running-without-docker)).
- Node.js 22.13 or later, for the host CLI
- A Git repository. A remote is recommended; repositories without a usable remote are supported through explicit snapshot import.
- A Claude account or API key. By default you log in to Claude inside the container; your host login is not reused. You can instead let the host provision an API key (see [Claude authorization](#claude-authorization)).
- Optional: the GitHub CLI and credentials for PR delivery, and a Telegram bot for remote control

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

1. **Project.** The project wizard covers the profile, shared or private installation, intake, verification commands, container resources, the agent runtime (Docker by default; the host runtime only after a typed confirmation, see [Running without Docker](#running-without-docker)) and the Claude authorization method. It shows the plan and applies it after you confirm.
2. **GitHub (optional).** *Set up GitHub integration?* If you say yes, it runs the guided flow of `minions setup github`: it offers to add a github.com `origin` when there is none and to push the base branch (each shown as the exact git command first), prints a pre-filled fine-grained token link (optionally opened in the browser), reads the token without echo, and then asks for the delivery mode: `pull-request` is the default answer once a GitHub remote and token are available (`branch` and `local` stay selectable).
3. **CI (optional).** *Use CI?* It detects workflows and the base branch's required status checks with read-only calls, then prints the external CI setup plan. It never writes workflow files or changes branch protection.
4. **Auto-merge.** The question is shown but marked *not available yet*, and the default is no. Nothing is written.
5. **Telegram (optional).** *Set up Telegram?* It gives BotFather guidance, reads the bot token without echo, and prints the pairing instructions. With the default `communication.channel` `auto`, a stored token is enough; the host runtime has no Telegram, so this step is skipped there.
6. **Runtime.** It builds the image if needed, starts the container (or prepares the host runtime), imports the committed history of the base branch, configures `origin`, and launches the coordinator. Then it prints exactly how to attach (`minions start`), how to log in to Claude (`/login`, login method in the container), and how to pair Telegram (`/telegram:access pair <code>` in the coordinator terminal).
7. **Setup assistant.** Finally it offers the AI setup assistant (`minions setup assist`, Claude Code on the host with a minions setup skill) to finish whatever is left, then offers to attach the coordinator.

If you decline a step, setup skips it and prints how to enable it later. Rerunning `minions setup` is safe. It detects the existing configuration, stored tokens, container, and imported repository, and offers to keep or change each one without duplicating anything. Integration choices that differ from the project configuration (`delivery.mode`, `communication.channel`) are recorded in the host-only `config.local.json`.

```sh
minions setup --dry-run                        # show what would happen; writes nothing, asks for no secrets
minions setup --yes                            # non-interactive defaults: optional integrations off
minions setup --yes --github-token-stdin --delivery pull-request < token-file   # tokens only via stdin, never argv
minions status --check                         # check readiness at any time
```

To change a choice later, rerun `minions setup`. Each step is also available as a separate advanced command; see [docs/cli.md](docs/cli.md).

### What the project step does

1. **Read-only discovery.** Reads Git metadata, Docker availability, instructions, contribution docs, build files, CI workflows, and issue references. Files are treated as data: discovery runs no repository scripts and never builds your Dockerfile.
2. **Wizard.** Asks only questions whose answers change behavior, with answers prefilled from the profile and from discovery:
   1. Starting profile
   2. Private or shared installation
   3. Backlog backend and ownership
   4. Task intake and authorized scope
   5. Publication and merge authority
   6. Communication channel: `auto` (default: Telegram once a bot token is stored, otherwise terminal), `terminal`, or `telegram`
   7. Credential references and authentication readiness
   8. Container image, toolchain, and any application preview ports
3. **Plan review.** Shows the planned writes, effective permissions, inferred verification commands, unavailable capabilities, and any external setup you still need to do. Approving the plan authorizes exactly those changes and nothing else.
4. **Apply and verify.** Writes files atomically and records their hashes in a manifest. A failed install rolls back. Incomplete external setup, such as the GitHub token or branch protection, is recorded as pending, never reported as ready.

The project step is idempotent. It never overwrites files you own, preserves uncommitted changes, never enables `bypassPermissions`, and never creates GitHub tokens or Apps or changes branch protection by itself. For non-interactive setup, pass a validated config file.

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
| `minions upgrade` | Move the running team onto the installed minions version without losing work. Running workers commit their progress and hand back; they continue after the upgrade. |
| `minions down` (or `minions stop`) | Stop the team. Data and progress are kept; `minions start` resumes. |
| `minions uninstall` | Remove minions from the project, keeping task data unless you ask otherwise. |

Everything else (pausing intake, credentials, channels, the agent runtime, and the commands the coordinator and workers use internally) is listed by `minions help --all` and in [docs/cli.md](docs/cli.md). Most of it you can also do by asking the coordinator.

## Profiles

A profile supplies starting values. Those values are copied into explicit configuration, so changing the profile later produces a reviewable patch instead of silently resetting your customizations.

| Setting | `project-owner` (default) | `personal-work` | `supervised` |
| - | - | - | - |
| Architecture | Makes ordinary architecture decisions | Follows existing architecture; proposes significant changes | Proposes significant changes |
| Execution backlog | GitHub Issues (Backlog.md if no GitHub) | Private Backlog.md | Private Backlog.md |
| Intake | Your requests and authorized milestones | Your requests and external work you select | Explicit requests only |
| Starts ready tasks | Yes | Yes, within the selected scope | Only explicitly authorized tasks |
| Follow-up tasks | Creates them; starts them within the approved milestone and scope | Creates them privately; starts them only if an authorized task needs them | Proposals only |
| Publication | Branches and PRs | Existing contribution process; PRs | Local commits |
| Automatic merge | Eligible after review and CI are set up | Disabled | Disabled |
| CI changes | Owner approval | Proposal only | Owner approval |
| Visibility | Shared | Private | Private |
| Deployment | Disabled | Disabled | Disabled |

No profile grants repository admin rights or overrides employer policy, organization controls, existing repository instructions, or credential restrictions.

## Working with the team

Talk to the coordinator in plain language in the attached terminal, or over Telegram:

- "Add rate limiting to the public API and open a PR."
- "Import https://tracker.example.com/TICKET-123 and break it into tasks."
- "What's the status?"
- "Pause new tasks." / "Resume." / "Sync."
- "Use opus for the migration task." / "Drop to one engineer."

The coordinator turns each goal into backlog tasks with acceptance criteria and dispatches them:

1. **Claim.** A helper takes a lease on the task. A task can't be claimed twice, and each task has only one active stage at a time.
2. **Engineer.** Implements the task on `agent/<task-slug>` in its own worktree, branched from the configured base branch (not necessarily `main`). It adds or updates tests for the acceptance criteria and runs the verification commands.
3. **Tester (only when the task needs QA).** See [Testing](#testing). Runs after the engineer, never at the same time on the same branch.
4. **Reviewer.** Inspects the exact head commit in a separate checkout and returns a structured verdict. It owns test adequacy: missing or weak tests are a reason to request changes. The reviewer never fixes production code and never publishes merges.
5. **Deliver.** Commit, push, open a PR, or request a merge, depending on configuration.

Each worker receives a compact task brief: objective, acceptance criteria, non-goals, relevant decisions and files, branch, worktree, expected head, authorized commands, model, and attempt limit. Each worker returns a validated result with one of these statuses: `complete`, `needs_changes`, `blocked`, `needs_split`, or `partial`. A malformed result gets one correction attempt. After that it is stored as unvalidated and is never promoted to an approval.

If a task turns out to be too large, the worker reports `needs_split`. The coordinator then creates child tasks idempotently, links their dependencies, and keeps the parent as a tracking task. The parent closes only when its required children and its own acceptance criteria are done.

After three repair cycles on a task (configurable), the coordinator replans instead of retrying again.

### Testing

Testing is risk-based. Per-ticket testers mostly re-ran the suite; the problems worth a tester were integration and system-level ones. So by default a task goes **engineer → reviewer → delivered**:

- The **engineer** writes and updates tests for the acceptance criteria and runs the verification commands.
- The **reviewer** judges whether those tests are meaningful and cover the criteria and edge cases, and requests changes if not.

A task gets a **tester stage** (status `testing`, before delivery) only when it needs QA:

- it has a QA label: `qa` by default, or the labels in `verification.qaLabels`. The coordinator adds one for risky tasks;
- its branch touches a [sensitive path](#sensitive-changes) (checked against the diff and the engineer's `modifiedPaths`);
- the reviewer sets `"needsQa": true` in its result. An approval with `needsQa` moves the task to `testing` instead of delivered, and it comes back to review afterwards.

The last two are recorded on the task as its first QA label (plus a `qa-required` event), so later stages and publication apply the same requirement. A reviewer approval, and publication, need passing tester evidence for the exact head whenever the task needs QA.

**QA sweeps.** Testers mainly run QA sweeps against the base branch, not a ticket branch. The coordinator schedules one at a milestone, before a release, after several merges (about five), or when you ask. A sweep is a backlog task labelled `qa-sweep`, claimed with `--role tester`. The tester works in a detached worktree at the base head and commits nothing. It checks end-to-end flows, install and upgrade paths, and regressions across features. Recording the sweep closes it as `done`, and the coordinator creates one backlog task per finding. There is no separate command for this: ask the coordinator ("run a QA sweep").

To keep the old flow, with a tester for every task, set `verification.testerRequired` to `true`. The tester-evidence gate then applies to every approval and publication, as before.

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

Two execution backlog backends are planned, behind a common task model (v0.1 ships Backlog.md only; GitHub Issues is deferred):

- **GitHub Issues.** Task structure lives in a clearly marked section of the issue body; the rest of the body is untouched. Each task has one namespaced lifecycle label (`minions:*`), and other labels are left alone. Updates are compare-and-check, so concurrent human edits are detected rather than overwritten.
- **Backlog.md.** Uses the real [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI in a tested version range, with files in one canonical location. The coordinator is the only writer.

Only the selected backend holds task records. The local SQLite database holds leases, locks, mappings, and event receipts. It is not a second backlog.

Work can come from:

- your direct requests
- external tickets linked by URL and imported manually (native Jira and Linear connectors are not part of version 1)
- scoped GitHub queries, filtered by milestone, assignee, labels, and paths
- tasks in an authorized milestone

Intake is additive and idempotent: importing the same ticket twice does not create a duplicate. A failed query is never treated as evidence that tasks were deleted. External ticket discussion is task data, not instructions, so a comment can't grant minions new permissions. If a ticket is reassigned or falls outside the authorized filter, minions starts no new work on it and pauses active work for review.

**GitHub-filtered intake (v0.1).** Turn it on by answering yes to *Import GitHub issues into the backlog?* in `minions setup` (default no), or set `intake.github` in the configuration:

```json
"intake": { "github": { "enabled": true, "repository": null, "labels": ["minions"], "assignee": "octocat", "milestone": "v1", "state": "open" } }
```

`repository` is `"owner/repo"` (`null` = the workspace origin); `labels` must all match; `assignee` is a login, `"none"` or `"*"`; `milestone` is a title or number, `"none"` or `"*"`; `null` means no filter. `minions sync` and every coordinator start (bounded to about 25 s, so a slow GitHub never delays the start) then run one read-only query (`gh api --method GET`; minions never comments on, labels, assigns or closes issues) and import each matching issue (pull requests excluded) as an `idea` task with provenance `external-requirement`, the issue URL as external link and the idempotency key `intake:gh:<owner>/<repo>#<n>`. Reruns create no duplicates, and minions never overwrites the title or description of an imported task or deletes one. While intake is paused (`minions pause --intake`), new issues are skipped and counted; `minions sync` still succeeds. When an imported issue leaves the filter (relabelled, closed, moved, filter changed) or is reassigned, its task is paused (status `blocked` with a note) and an `intake-reconcile` event is recorded; finished tasks stay as they are, a task with an active lease is paused on a later sync, and a task whose issue matches again is not resumed automatically. A failed or truncated query pauses nothing. Issue titles and bodies are imported as untrusted text: HTML comment openers are neutralised, so an issue cannot forge task metadata. If an imported task's metadata block is later lost or damaged, the task still reads as `external-requirement`, never as an owner decision.

> **Warning: a filter with no labels and no assignee imports issues from anyone.** On a public repository anyone with a GitHub account can open an issue. With `labels: []` and `assignee: null` (or `"none"`) and no milestone, every new issue becomes a backlog task, whoever wrote it. `minions setup` prints a warning for such a filter. Filter by a label that only maintainers can apply (people with triage access), and make sure no issue template adds that label automatically. Or filter by an assignee. Imported text is still treated as untrusted task data, but the coordinator will triage it.

To switch backends mid-project, use `minions migrate backlog` **(deferred in v0.1)**. The migration preserves task identity, links, dependencies, and PR references, can resume after a partial failure, and leaves the source records in place.

## Task lifecycle

```
idea → ready → implementing → testing → reviewing → awaiting-ci → merging → done
                     ↑                       │
                     └── changes-requested ←─┘
Also: blocked · awaiting-human · cancelled
```

`testing` happens only for tasks that need QA (see [Testing](#testing)); otherwise `implementing` goes straight to `reviewing`.

Local and PR-only workflows can end a task at **delivered**. Reports keep that distinct from **merged**, because an open PR is not a merged task.

Under the default settings, at most **2 tasks** are active and at most **2 engineers** run at once. A blocked task or one waiting on a human frees its capacity unless a worker is still running on it.

### Worker hand-offs (briefs and results through files)

Briefs and worker results go through files under `/state`, not through the coordinator's context:

1. `minions work claim <taskId> --role <role> --compact --json` claims the lease, stores the full brief in `/state/briefs/<leaseId>.json`, and prints a short summary: `leaseId`, `briefMarker`, `branch`, `worktree`, `expectedHead`, and the task id, title, role and attempt.
2. The worker prompt holds only the `minions-lease: <leaseId>` line, a `worktree:` line and the coordinator's notes. The worker runs `minions work brief <leaseId> --role <role> --json` itself. The command works only while the lease is active, only for the lease's role, and only from inside the lease's worktree, so a worker cannot read another lease's brief. The PreToolUse hook still refuses a worker launch whose prompt has no active lease marker for that role.
3. The worker writes its WorkerResult with `minions work submit <leaseId> --role <role> --json`, with the JSON on stdin, to `/state/results/<leaseId>.json`, then ends with a one-line summary. Reviewers can submit too, because the file goes under `/state` and not into their read-only worktree.
4. The coordinator runs `minions work record <leaseId> --submitted --json`. Validation and the single correction work as before. An invalid result returns its `errors`, and the rejected file is set aside so the correction has to be a new submission (`--submitted --correction`). A missing submission fails with `NOT_FOUND` and a hint. Piping the JSON to `minions work record` on stdin still works.

`minions backlog list|ready --compact --json` (or `--fields id,title,status,...`) leaves out descriptions and other bulky fields.

**Idle context reset (opt-in).** If you ask for it, the coordinator can restart itself once the queue is idle (nothing runnable, no active leases) after many hand-offs. It runs `minions coordinator restart --recover` detached and starts again with a fresh context. All state is durable, so nothing is lost. This is guidance in the coordinator prompt, and nothing restarts on its own.

## Delivery, review, and merging

v0.1 supports `local`, `branch`, and `pull-request` delivery. `auto-when-eligible`, review publication, and merging are **deferred in v0.1**: minions never merges, and an open PR is reported as **delivered**, not merged.

| Mode | Behavior | Needs GitHub write access |
| - | - | - |
| `local` | Commits locally and writes a handoff | No |
| `branch` | Pushes the branch | Yes |
| `pull-request` | Opens a PR and waits for your established process | Yes |
| `auto-when-eligible` | Requests a merge once every gate passes **(deferred in v0.1)** | Yes, plus a separate review identity |

**Branch and pull-request delivery (v0.1).** Set `delivery.provider` to `"github"` and `delivery.mode` to `"branch"` or `"pull-request"`. The init wizard offers these only when the repository has a GitHub remote and a token is stored (`minions auth github`); otherwise it keeps `local` and says why, and the guided [GitHub setup](#github-setup) that follows offers to switch once a token works. When the reviewer approves, `minions work record` pushes exactly the approved commit to `agent/<slug>` on origin and, in `pull-request` mode, opens one PR against the base branch. The task becomes `delivered` with the PR URL recorded. If publication fails (network, credential, permission), the task is `blocked`, the local branch is kept, and `minions work publish <taskId>` retries; reruns reuse an existing remote branch or PR instead of duplicating it. If the change touches a sensitive path (or `git.push` / `pr.create` is `ask`), nothing is pushed until you approve that exact commit with `minions work approve <taskId> --head <sha>` **on the host** (in the repository, not inside the container). The host signs the approval with a per-project key the container cannot read, and the runtime checks the signature right before pushing. An approval recorded inside the container (by the coordinator, a worker, or a script) is rejected by minions' publication flow. This protects the normal flow, not against code already running in the container: such code can still read the push token and use it directly, so also give the token the minimum scope (one repository; Contents and Pull requests read/write; no Workflows permission) and protect the base branch on GitHub (required reviews, Code Owners for sensitive paths, no force pushes, no bypass for the token's user). See [Host-signed publication approvals](docs/design/bootstrap.md#host-signed-publication-approvals). PR text comes only from the task title, objective, and acceptance criteria; private installations add nothing else.

**GitHub delivery: `origin/<base>` is the single source of truth (default workflow).** With `branch` or `pull-request` delivery, every change reaches the base branch through a pull request merged on GitHub, and only when policy allows it (`pr.merge` stays `ask` unless you change it on the host; minions itself never merges in v0.1). The workflow is:

1. **Nothing merges into a local base.** The coordinator never merges, rebases, cherry-picks or commits into the local base branch, not even approved task branches. Local auto-merge of approved branches is a `local` delivery practice only.
2. **Every claim starts from origin.** Before each `minions work claim` (engineer, tester and reviewer) the workspace fetches the base from origin into `refs/remotes/origin/<base>` and fast-forwards the local base to it (`merge --ff-only` where it is checked out, else a compare-and-swap `update-ref`). If it cannot (the local base has commits origin does not have, it has diverged, or the fetch fails), the claim is blocked with a clear error (`CONFLICT`, or the classified fetch error), no lease starts, and a `base-sync-blocked` event is recorded. The coordinator reports the blocker; minions never repairs it by merging or resetting. `minions import` still refreshes the host refs but no longer moves the workspace base to the host's base.
3. **Upgrades build the CLI from origin.** In a minions checkout, `minions upgrade` fetches origin, strictly fast-forwards the host base to `origin/<base>`, and builds the CLI (with `--rebuild-cli`) only when the checkout is exactly that reviewed commit with a clean tree; otherwise it stops and prints the command to get there. `--from-container` is refused: container work reaches the base only through pull requests.
4. **Merged PRs come back through origin.** `minions sync` marks merged PRs `done`, and the next claim picks up the merged commits from `origin/<base>`.

`local` delivery is unchanged: no fetch before claims, `minions export` hands branches to the host, and `minions upgrade --from-container` stays available.

**CI awareness (v0.1, read-only).** `minions sync` refreshes the state and check results of every task's PR in one pass (no polling loop): it records the CI observation (`awaiting-ci`, `passing`, `failing`, or `no-checks`) against the PR head, adds a task note when it changes, marks merged PRs `done`, and marks PRs closed without merging `blocked`. `minions doctor` reports whether the base branch requires status checks (branch protection or rulesets) as `ci.requiredChecks`, compared with `delivery.requiredChecksConfigured`. A project without CI can still use local work and pull-request delivery, but not automatic merge. When CI or required checks are missing, `minions setup` (when you answer yes to *Use CI?*), `minions init`, `minions doctor`, and `minions ci status` print the manual setup steps. minions never creates workflows or changes branch protection.

**PR-first delivery and CI as verification authority.** When the repository has a GitHub remote and a token is stored, `minions setup` offers `pull-request` delivery as the default answer (`local` and `branch` stay selectable; without GitHub, delivery stays `local`). To let tester and reviewer stages trust CI instead of re-running the full verification, set `verification.ciAuthority` to `"github"` (optional `verification.ciPendingTimeoutMinutes`, default 60). What you do once, on the host and on GitHub: (1) run `minions setup github` (remote, token, pull-request delivery); (2) make sure a CI workflow runs the verification commands on pull requests (this repository's own is [.github/workflows/ci.yml](.github/workflows/ci.yml), job `test`: `npm ci`, `npm run typecheck`, `npm test`); (3) protect the base branch and mark that check required (Settings -> Branches or Rules -> Rulesets, "Require status checks to pass"); (4) run `minions doctor` and confirm `ci.authority` says `ready`. A stage is satisfied by CI only when every required check passed for exactly the head under review, as observed by `minions sync`; missing, failing, unreadable, or pending-too-long CI never approves, and the stage falls back to local verification. See [CI as verification authority](docs/design/bootstrap.md#ci-as-verification-authority).

**Evidence is tied to commits.** Test results, the review verdict, local checks, and CI observations are recorded against a head SHA and a config revision. A new commit invalidates stale evidence.

**Approvals need a real second identity.** A native approving GitHub review requires an author and a reviewer with different identities. Two Claude sessions or two tokens for the same user don't count. In v0.1 minions publishes with one fine-grained personal access token and posts no reviews, so approvals come from you or your normal review process. Planned (deferred): the `project-owner` profile uses two GitHub Apps, one for development and one for review, with you as a third identity for sensitive approvals. The `personal-work` profile adopts your existing approved credentials and review process.

**The merge helper refuses to merge unless all of these hold:**

- the project, repository, base branch, and PR are correct
- publication and merge capabilities are allowed
- the head SHA is the expected one
- a current, valid, independent review exists
- the tester evidence (when the task needs QA, see [Testing](#testing)) and local verification evidence exist
- required CI checks are configured and GitHub's requirements are satisfied
- any sensitive-change approval has been given
- no admin or bypass merge flag is used

If no required CI checks are configured, automatic merge is unavailable. It is never treated as approval to merge with zero checks. minions uses native GitHub auto-merge, never an LLM loop that polls CI, and it reports "auto-merge requested" separately from "merged". When a repository plan doesn't support a gate, minions reports it and downgrades only if you authorize that in configuration.

minions adopts existing project checks and does not invent CI. A project without CI still works for local and PR delivery.

## Permissions and capabilities

Authority is a set of independent capabilities. Each rule is `allow`, `ask`, or `deny`, optionally limited by role and path:

| Area | Capabilities |
| - | - |
| Tasks | `task.read`, `task.create`, `task.update`, `task.start` |
| External trackers | `external.read`, `external.comment`, `external.changeStatus`, `external.create` |
| Code | `code.edit`, `dependencies.edit`, `architecture.change`, `migrations.edit` |
| Git | `git.commit`, `git.push` |
| Pull requests | `pr.create`, `pr.review`, `pr.merge` |
| Infrastructure | `ci.edit`, `infrastructure.edit` |
| Other | `network.use`, `deploy.execute` |

- Explicit `deny` always wins.
- External write capabilities default to `deny` in `personal-work`.
- A prompt, task, ticket, or PR comment can't grant a capability.
- minions keeps three questions separate, and `doctor` reports each one: Is the action **permitted**? Is the needed **credential** available? Can minions **enforce** the restriction mechanically?

### Coordinator permission mode

In the container, the coordinator Claude Code session runs in permission mode **`auto`** by default. The fixed rules stay the same in every mode: `git push` and `gh pr merge` are always denied, `minions work approve` / `minions approve` always ask you, and bypass mode is disabled for the session (`disableBypassPermissionsMode`). minions never launches with `bypassPermissions`, `dontAsk` or `--dangerously-skip-permissions`.

**Trade-off.** With `auto`, a Claude Code classifier decides on actions outside the allow list (for example a Bash command that isn't `minions`, `git` or `backlog`) instead of asking you. You get far fewer prompts, but you are trusting the classifier with calls you would otherwise have reviewed yourself. The deny and ask rules above still match first, so the classifier can't approve a literal `git push`, `gh pr merge` or `minions work approve` (and since publication approvals must be signed on the host, an approval recorded in the container is rejected anyway). Those rules are command patterns, though. Other commands with the same effect that the patterns don't match (for example `sh -c 'git push ...'`, `gh api` calls that merge a PR, or `curl` with the push token, which is readable in the container) are now judged by the classifier instead of by you; under `acceptEdits` they would ask. The real boundary is server-side: a minimal-scope token and branch protection on GitHub (see the remaining trust boundary under [Host-signed publication approvals](docs/design/bootstrap.md#host-signed-publication-approvals)). If you'd rather review every such call, opt back into `acceptEdits`:

```json
{ "coordinator": { "permissionMode": "acceptEdits" } }
```

`minions coordinator --probe` (and `doctor`) report which mode the launch will use. If the installed Claude Code doesn't offer `--permission-mode auto`, the coordinator falls back to `acceptEdits`, prints why when it starts, and `doctor` shows a warning. A mode change takes effect when the coordinator restarts. The legacy top-level `permissionMode` key now matters only when it is `"default"` (stricter, still honoured). Its old default value `"acceptEdits"` doesn't opt out; use `coordinator.permissionMode` for that. Worker agents are unaffected. The host runtime always uses `default` (see [Running without Docker](#running-without-docker)).

## Sensitive changes

Changes to these paths need human approval before publication or merge. Local planning and proposed edits can still be allowed.

```
.github/workflows/**   .github/CODEOWNERS   .minions/**   .claude/**
CLAUDE.md   AGENTS.md   automation/**
infra/**   infrastructure/**   deploy/**   terraform/**   **/migrations/**
```

You can change the list through the configuration workflow. A worker PR that tries to change its own control policy is handled separately from a reconfiguration you authorized. The development identity can never self-approve changes to credentials, workflow trust, or merge gates.

In v0.1 minions enforces path rules locally and says plainly that the repository has no hard gate for them. Mapping them to CODEOWNERS and required code-owner review in shared installs is planned (deferred); you can add a `CODEOWNERS` entry yourself (see the branch-protection guidance in [docs/design/bootstrap.md](docs/design/bootstrap.md)). CODEOWNERS can't express semantic rules such as "all dependency changes", and minions does not claim that it can.

## Configuration

Settings resolve in this order, with later sources overriding earlier ones:

1. Package defaults
2. Project configuration
3. Private project overrides
4. Session overrides, for non-persistent choices such as narrowing permissions, lowering concurrency, or picking an already-allowed model

Each effective value records where it came from:

```sh
minions config show
minions config show --explain     # every value with its source (default/project/local/session)
```

### Changing settings mid-project (deferred in v0.1)

In v0.1, edit the project config on the host and run `minions start` again; the container reads it read-only.

Ask the coordinator, which uses `minions-configure`, or use the CLI:

```sh
minions config plan  ...   # typed patch, impact classification, diff
minions config apply ...   # apply, bump configRevision, regenerate artifacts
```

Each change is classified by when it takes effect:

| Impact | Example |
| - | - |
| immediate | Lowering concurrency stops new starts; running work continues |
| next-dispatch | Changing the default model |
| restart-required | Updated prompts or tool permissions, Telegram changes (`minions channel set`, `minions auth telegram`) |
| migration | Switching backlog backend, switching private and shared visibility |

Tightening permissions suspends the affected external actions immediately. A worker still running on an older config revision is blocked from sensitive external operations. Broadening permissions always needs an explicit request from you; the agent can't grant itself authority. Container mounts, image, resources, published ports, and credential grants are host-controlled. Claude can only propose a change plan for them, which you apply through the host CLI.

### Example (abridged)

```json
{
  "schemaVersion": 1,
  "configRevision": 1,
  "projectId": "3f1c…",
  "profile": "project-owner",
  "visibility": "shared",
  "backlog": { "backend": "github", "ownership": "direct", "repository": "owner/repo" },
  "intake": {
    "sources": ["user", "milestone"],
    "startReady": true,
    "scope": { "requiredLabels": ["minions:ready"], "allowedPaths": ["**"] }
  },
  "container": { "cpus": 4, "memoryMiB": 6144, "pidsLimit": 512, "publishPorts": [] },
  "execution": { "maxActiveTasks": 2, "maxEngineers": 2, "maxRepairCyclesBeforeReplan": 3, "attemptMaxTurns": 80 },
  "models": { "default": "sonnet", "allowed": ["sonnet", "opus", "haiku"], "selection": "coordinator" },
  "delivery": { "mode": "pull-request", "merge": "auto-when-eligible", "method": "squash", "requiredChecksConfigured": false },
  "verification": { "commands": [], "testerRequired": false, "reviewerRequired": true, "qaLabels": ["qa"] },
  "communication": { "channel": "auto", "progress": "milestones" },
  "budgets": { "taskUsd": null, "dailyUsd": null }
}
```

The full shape is defined by the JSON Schema shipped with the package. Unknown fields and contradictory settings fail with an actionable error. Secrets appear only as references, never as literal values.

## Models and budgets

- Workers default to `sonnet`. `opus` and `haiku` are also allowed, limited to whatever your account can actually use.
- The coordinator picks the model and worker definition for each attempt: smaller models for narrow inspection, the higher-effort engineer (and then a stronger model) for hard debugging, architecture work, or repeated failures.
- `models.default` is written into every worker definition (agent frontmatter `model`), so it may be a full model ID. The Agent tool only accepts the aliases `sonnet`, `opus`, `haiku` and `fable` as a per-call `model`, so the coordinator omits `model` for the default and passes only an allowed alias to override it; the launch hook denies a full ID. Other full IDs in `models.allowed` can't be chosen per call (they still count for `models.coordinator`).
- `models.effort` (`low` | `medium` | `high` | `xhigh` | `max`, unset = Claude Code's default) sets the workers' reasoning effort (agent frontmatter `effort`) and the coordinator's (`--effort`). An Agent call can't change effort, so it comes from the definitions. `models.effortByRole` (`engineer`, `engineerDeep`, `tester`, `reviewer`, `coordinator`; each optional) overrides it per role, falling back to `models.effort`. `models.coordinator` picks the coordinator session's model (`--model`; must be in `models.allowed`).
- Two engineer definitions are generated from the same template: `minions:engineer` for routine work and `minions:engineer-deep` at `effortByRole.engineerDeep` (default: one level above the engineer's effort, `high` when that is unset). The coordinator uses engineer-deep for hard debugging, architecture work, or a retry after an engineer attempt failed. Both run under the same engineer lease.
- Example, routine engineers at low effort with medium testers, reviewers and coordinator, and a medium-effort deep engineer: `"models": { "default": "claude-opus-5-5", "allowed": ["claude-opus-5-5", "sonnet", "opus", "haiku"], "selection": "coordinator", "effort": "medium", "effortByRole": { "engineer": "low" } }`. Edit these in the project config (`.minions/config.json`), then run `minions upgrade` to regenerate the definitions.
- Each attempt is capped at 80 turns, and a task replans after 3 repair cycles. These are attempt limits; they don't cancel the task.
- Per-task and per-day USD caps are optional and off by default. When set, minions checks known usage before starting each attempt and stops new starts once a cap is reached. Usage figures may be estimates, and minions records how reliable they are. It doesn't promise hard billing enforcement.
- minions tracks completion time, attempts, repairs, human interventions, and available usage per task.

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

The Telegram controls (pause intake, pause new starts, cancel workers, resume, status, sync) also exist as terminal commands that work without Claude.

## GitHub setup

After inspecting the repository, an interactive `minions init` offers a guided GitHub setup (default yes). You can rerun it any time:

```sh
minions setup github          # guided; asks before every change
minions setup github --yes    # never prompts, pushes or opens a browser: prints the next steps only
```

1. **Remote.** Without a GitHub remote, delivery stays local. The setup explains what a remote enables (branch and pull-request delivery, later CI) and offers to add one: you enter `owner/repo` or a github.com URL, it is validated and added with `git remote add origin https://github.com/<owner>/<repo>.git` (shown first). An existing non-GitHub `origin` is never changed.
2. **Base branch on the remote.** Pull requests target the base branch, so it must exist on GitHub. If `refs/remotes/origin/<base>` is missing, the setup shows the exact command (`git push -u origin <base>`) and runs it only after you answer yes (default no). Nothing is fetched to check.
3. **Token.** A fine-grained personal access token for this repository only. The link pre-fills the token page with GitHub's template URL parameters (name, description, owner, 90-day expiry, Contents and Pull requests read/write, Actions and Commit statuses read; Metadata read is added by GitHub), for example `https://github.com/settings/personal-access-tokens/new?name=minions+demo&…&target_name=acme&expires_in=90&contents=write&pull_requests=write&actions=read&statuses=read`. GitHub can't pre-select the repository, so you pick "Only select repositories" → `owner/repo` yourself, and Checks read if offered. On macOS the setup offers to open the page with `open` (default no). The token is then entered at a hidden prompt and verified against the GitHub API before it is stored (same as `minions auth github`).
4. **Delivery.** Once a token works, it offers `pull-request` (recommended), `branch`, or `local`, and writes `delivery.mode` to the project configuration with a `configRevision` bump. A configuration file you edited yourself is not rewritten; you get the exact change to make instead. Profiles that deny `git.push` (for example `supervised`) are not offered branch or pull-request delivery.

`minions doctor` shows a `github.setup` check with the next step when something is missing, and `minions start` prints a one-line hint when the repository has a GitHub remote but no token is stored. Using your existing `gh` CLI login instead of a per-project token is not offered: the per-project fine-grained token keeps the agents' scope to one repository.

## Setup assistant

`minions init` is deterministic and complete on its own. At the end of an interactive init it asks:

```
Open the setup assistant to finish remaining setup? [Y/n]
```

Yes opens **your own** Claude Code (`claude` on the host, in the repository root, in the foreground) with a small generated skill, `minions-setup:setup`, that helps you close what is left. You can open it any time:

```sh
minions setup assist             # interactive; needs a terminal and `claude` on PATH
minions setup assist --dry-run   # print the claude command; writes and launches nothing
```

It is never offered with `--yes`, `--config`, `--json`, `--dry-run`, or without a terminal. The assistant:

1. Gathers context first, read-only: `minions doctor --json`, `minions status --json`, `minions auth show --json`, `minions config show --explain`, `git remote -v`, and your build and CI files.
2. Works only on the gaps: GitHub (you run `! minions setup github`), the Claude authorization choice (you run `! minions auth set ...`), Telegram if you want it (`! minions auth telegram`), verification commands taken from your real scripts and CI, models and effort, and doctor warnings.
3. Turns your goals into a few first tasks. The backlog lives in the agent runtime, so it gives you a message to paste into the coordinator after `minions start`.
4. Ends with `minions doctor` and a summary of what was done and what remains.

Guard rails:

- Claude Code runs in permission mode `default`, with bypass mode disabled for the session. Only read-only commands run without asking: `minions doctor|status|auth show|config show|runtime show`, `git remote -v`, `git status`, `git log`, and file reads inside the repository (`Read(//<repo>/**)`, which also covers Glob/Grep there). Reads anywhere else prompt.
- It never asks for a token or key. Credential, runtime and publishing commands (`minions auth ...`, `minions setup github`, `minions runtime set`, `minions start`, `git push`, `open`, `security`, `gh auth token`) are denied to the assistant. You run them yourself with `!` (or in another terminal), so secrets are typed only at minions' hidden prompts.
- It can't read the minions secret and credential stores (of any project), `~/.ssh`, `~/.aws`, `~/.config/gh`, the Keychains and other host secret dirs, or `.env` files, and can't edit host-side minions files (`project.json`, `defaults.json`, secrets). Changes to the project configuration are shown as a diff first, need your yes, bump `configRevision`, and are validated with `minions config show --explain`.

`minions doctor` shows a `setup` check that suggests `minions setup assist` when there are obvious gaps, such as no verification commands.

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
minions auth show [--json]      # method, source, masked env, key file status and last refresh; never the key
```

**Global default:** `minions auth set <method> … --global` writes `<MINIONS_HOME>/defaults.json`
(`{ "claudeAuth": … }`), which `minions init` uses for new projects. A project's own setting always
wins. The `init` wizard asks the same question (JetBrains Central is offered only when `central` is
on your `PATH`; it is looked up, not run).

`minions doctor` checks the method: for `login`, `claude auth status` inside the container; for keys,
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

- **Outbound internet is open by default**, so Claude, GitHub, Telegram, and package downloads work. A normal Docker network doesn't block exfiltration or LAN access, and minions doesn't claim that it does.
- **Workers share one container.** The engineer, tester, and reviewer can read the same files and every credential mounted into the container. Separate GitHub identities give correct review attribution, not isolation. A reviewer with shell access is read-only only by workflow.
- Credentials you inject can be used for whatever they allow.

**Credential handling:**

- Long-lived secrets stay on the host, in macOS Keychain or in 0600 files outside the repository.
- The Keychain items are created without a `-T` access list, so any process running as your user can read them (normal macOS behaviour; the Keychain protects against other users and offline access, not against your own processes). The plaintext GitHub/Telegram token copies mounted into the container (`secrets/` in the project directory) are removed by `minions down`/uninstall, when `minions start` fails, or when `minions doctor` finds them with no running container. The host-provisioned Claude key copy in the same directory stays until you switch back to `login` or uninstall (each `minions start` re-provisions it).
- Configuration holds references only.
- GitHub access in v0.1 is a per-project fine-grained personal access token that you create and store with `minions auth github`. The host materializes it into a read-only secret file for the container. It is long-lived and not refreshed, so keep its scope minimal and its expiry short (see [GitHub credential](docs/design/bootstrap.md#github-credential)). Host-refreshed GitHub App installation tokens are planned (deferred).
- Tokens, environment dumps, and private task payloads are never logged, and logs are kept bounded with predictable secret values redacted.
- Issue, PR, and repository content is treated as untrusted. External commands use argument arrays, never shell strings built from that content.

There is no default production credential injection and no deployment authority.

## Running without Docker

> **Warning: the host runtime is less safe.** Agents run as your macOS user. They can use your files, Keychain, SSH keys, network and credentials, and there are no container limits (CPU, memory, processes, read-only filesystem). Prompt injection in repository, issue or web content could act on your machine. Use the default Docker runtime for repositories and tasks you don't fully trust.

The runtime is a **host-side** setting (`runtime` in the project's `project.json`, or the default for new projects in `<MINIONS_HOME>/defaults.json`). A repository can't select it: `.minions/config.json` has no such field, and the strict schema rejects it.

```sh
minions init path/to/repo --runtime host     # or answer "host" to the wizard's first question (typed confirmation)
minions runtime show                          # docker | host, with the warning when host
minions runtime set host                      # prints the warning; type "host" to confirm (or --yes)
minions runtime set docker                    # back to the container (no confirmation needed)
minions runtime set host --global --yes       # default for new projects; each init/start still warns
```

Switching needs the old runtime stopped (`minions down`). Agent branches, backlog and runtime state are not copied between runtimes; run `minions export` first to keep agent branches.

**What changes in host mode**

- **Separate clone.** Agents never touch your checkout. Their clone, worktrees, backlog and runtime DB live under `<MINIONS_HOME>/projects/<id>/host/{workspace,state}` (0700), seeded from a Git bundle of the committed base branch, exactly like the container workspace. `minions import` and `minions export` work as with Docker (export fetches `agent/*` into `refs/remotes/minions/*`).
- **Commands run directly.** `start`, `status`, `pause`, `resume`, `work publish|approve` and the coordinator run on the host through a generated `minions` shim (`host/bin/minions`) that pins `MINIONS_RUNTIME=host` and the paths. They get an allowlisted environment (locale, terminal, proxy/CA variables and `CLAUDE_CONFIG_DIR` from your shell; cloud tokens, `ANTHROPIC_API_KEY`, `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`, `NODE_OPTIONS` and the like are dropped). The coordinator runs in a dedicated tmux server (`tmux -L minions-<id>`), never your default one; `minions down` kills that server. `tmux attach` hint: `tmux -L minions-<id> attach -t coordinator`.
- **Claude Code is started without your settings.** The coordinator runs `claude --setting-sources= --strict-mcp-config`: no user (`~/.claude`), project or local settings (so no hooks, MCP servers, plugins, permission rules or sandbox exclusions from your setup or from the repository's `.claude/` / `.mcp.json`) and no MCP servers. Only minions' own `--settings`, its plugin, and any managed (admin) settings apply. Your login still works (credentials are not settings). The repository's `CLAUDE.md` is not auto-loaded; the coordinator is told to read it. The permission mode is always `default` (a repository can't select `acceptEdits`/`auto`).
- **Sandbox.** Claude Code's sandbox is on (`autoAllowBashIfSandboxed: false`, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`). Bash commands of the coordinator and workers may write only to the agents' workspace and state (tool caches such as npm, corepack, pip, Go and `XDG_CACHE_HOME` are redirected into the state dir). `permissions.blockReadsOutsideWorkingDirectories` hides your home directory from them and from the Read tool, except the agents' own dirs, your global git config, toolchain dirs (PATH entries, nvm/volta/rustup/…) and the parts of `~/.claude` Claude Code needs. On top of that, credential, browser, mail and shell-history locations (`~/.ssh`, `~/.aws`, `~/.git-credentials`, `~/.claude.json`, `~/Library/Cookies`, browser profiles, …), the whole minions data root (except this project's workspace, state, shim, config, plugin and GitHub token), other projects, and tmux's socket directory are denied, and no Unix sockets are reachable. Network: only GitHub and the npm registry without a prompt. Shell startup files, `~/.gitconfig`, `~/Library/LaunchAgents`, `~/.claude`, the workspace's `.git/config`/hooks and `.claude`/`.mcp.json` files are not editable. Git is allowed only as specific subcommands (no `git config`, `git -c`, remotes or push); repository verification commands get an allow rule only when they are plain commands (no globs, operators, quotes or shells).
- **Git outside the sandbox.** minions itself runs git in the agents' clone outside the sandbox (import refresh on `start`, `export`, `work publish`). Those calls neutralize the clone's config: hooks, fsmonitor, pager, askpass and ssh commands off, credential helpers reset to the minions helper, only https (and local bundles) as transports, every clean/smudge filter emptied, `core.worktree` pinned, no submodules, no system config. Publishing names the normalized `https://github.com/...` URL instead of the clone's `origin`. Bundles are copied through host-owned dirs (`host/transfer`) without following symlinks; the hooks' log lives in `host/logs`.
- **Keychain.** Sandboxed commands can still reach the Keychain service, and items created by `security` trust `/usr/bin/security`. So while any project uses the host runtime, minions stores tokens in its 0600 file store (sandbox-denied), and `minions start` moves existing minions Keychain items of every project there.
- **Claude authorization.** `login` uses your existing Claude Code login on this Mac (no key handoff). `api-key` / `helper` / `jbcentral` write the key to `projects/<id>/secrets/anthropic-api-key` (0600) and the coordinator gets `apiKeyHelper: "cat '<that file>'"`; no loopback rewrite is needed.
- **GitHub.** The stored per-project token (`minions auth github`) is copied to `projects/<id>/secrets/github-token` (0600) on `minions start` and removed on `minions down`. The workspace clone's own git config points its github.com credential helper at the shim; a generated `gh` wrapper (`host/bin/gh`, only when `gh` is installed) passes the token to gh's process only. Your global git and gh configuration and your own gh login are never changed or used. `GH_TOKEN` / `GITHUB_TOKEN` from your shell are removed from agent processes.
- **Tools.** You install `tmux` (`brew install tmux`), Claude Code (`npm install -g @anthropic-ai/claude-code` or `brew install --cask claude-code`), Backlog.md (`npm install -g backlog.md@1.54.0`), `git`, and, for pull-request delivery, `gh` (`brew install gh`). `minions doctor` checks their versions and shows a warn-level `runtime` check.
- **Not in host mode.** Container resources and preview ports don't apply. Telegram is unavailable: the plugin would live in your own Claude Code setup, which the host runtime doesn't load (`minions telegram install` refuses); the coordinator stays terminal-only (`communication.channel` `auto` simply means terminal there; explicit `telegram` warns). `init --runtime host` asks for the typed confirmation (non-interactive: `--runtime host --yes`); a host-wide default of `host` is never inherited by a non-interactive init.

**Residual risks (read before choosing host mode)**

- Hooks of the minions plugin, `apiKeyHelper`, and the Read/Edit/Write tools run outside the sandbox; they follow the permission rules above, and anything you approve at a prompt runs as you, with your full access.
- Agents can read the project's GitHub token (the git credential helper runs inside the sandbox), as in the container. Use a fine-grained token limited to this repository.
- With the `login` method, Claude Code's own OAuth credentials are in your Keychain, and sandboxed commands can reach the Keychain service: an agent able to run `/usr/bin/security` may be able to read items that trust it. minions denies `security` at the permission layer (best effort, not a boundary).
- The sandbox's network filter works on host names: allowed domains such as `github.com` can be abused for exfiltration (for example domain fronting), and nothing limits what is pushed to repositories the token can write.
- The filter neutralization for git runs just before each git call; an agent racing a new filter driver into the clone's config in between is not fully excluded (the sandbox and permission rules deny writes to that file).
- Everything the sandbox allows (workspace, state, network to GitHub/npm, running your toolchains) happens as your user with no CPU, memory or process limits. Managed (admin) Claude Code settings still apply and could loosen the policy.
- Verified against Claude Code 2.1.292 documentation and binary; the sandbox behaviour itself is not exercised by minions' tests (they use a fake `claude`).
- **Uninstall.** `minions uninstall` stops the tmux server and keeps `host/` (workspace and state); `--delete-data` deletes it.

## CLI reference

The full command reference is in [docs/cli.md](docs/cli.md). `minions help --all` prints the same grouping: the primary commands from [Everyday use](#everyday-use), advanced commands for single steps and fine-grained control, and internal commands used by the coordinator, workers, hooks and the container. Every command supports `--json`, and mutating commands support `--dry-run`.

## Recovery, upgrades, and uninstall

- **Restart and recovery.** `minions start` reconciles sessions, branches, leases, and completed external actions before it retries anything, then attaches to or relaunches the coordinator. If a worker fails, its worktree and a recovery record are kept. minions never cleans up worktrees it doesn't own.
- **Upgrades.** In v0.1 `minions upgrade` moves the container onto the installed package without losing progress (see the command table; in a minions checkout it also brings the installed CLI up to date, or prints the command to do so).
- **Upgrade note: host-signed approvals (runtime DB schema 3).** Publication approvals recorded before this upgrade were unsigned and no longer count. Tasks that were waiting for approval stay `awaiting-human` after the upgrade: approve each again **on the host** with `minions work approve <taskId> --head <sha>`, then run `minions work publish <taskId>`. See [Host-signed publication approvals](docs/design/bootstrap.md#host-signed-publication-approvals). Deferred in v0.1: it produces a plan, backs up the config, migrates schemas deterministically, preserves your overrides, detects edits to managed files, marks running workers stale when behavior changes, and never turns on new authority.
- **Uninstall.** Removes only the files and owned blocks recorded in the manifest that are unchanged since minions generated them. Backlogs, decision records, worktrees with work, credentials, and Docker volumes are kept. Deleting data is a separate, explicit step. A private uninstall leaves the repository unchanged.
- **Interrupted operations.** An interrupted install or upgrade can be recovered from its journal.

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
