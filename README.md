# minions

minions installs a small Claude Code development team into a Git project on your Mac. A **coordinator** takes requests from a terminal or Telegram, keeps an execution backlog, and hands bounded pieces of work to **engineer**, **tester**, and **reviewer** workers. It delivers the results as local commits, branches, or GitHub pull requests.

Everything the model controls runs inside one Docker container per project. Your Mac runs only a small, trusted `minions` CLI. (You can explicitly opt into a less safe **host runtime** without Docker; see [Running without Docker](#running-without-docker).) That CLI installs the team, starts and stops the container, provisions the credentials you grant, and handles explicit import and export.

> **Status:** version 0.1 (bootstrap) is installable from source. It implements the terminal workflow: `init`, `doctor`, `start`, `down`, `status`, `pause`, `resume`, `import`, `export`, `config show [--explain]`, `auth show|set|refresh` (Claude authorization), `auth github`, `auth telegram`, `runtime show|set`, `setup github`, and `uninstall` on the host; an opt-in host runtime without Docker ([Running without Docker](#running-without-docker)); optional Telegram communication through the official Claude Code channel plugin (see [docs/design/telegram.md](docs/design/telegram.md); the notification outbox is not implemented yet); the Backlog.md backend; `local` delivery (commits on `agent/<slug>` branches, fetched to the host with `minions export`); and `branch` / `pull-request` delivery to GitHub (push `agent/<slug>`, open one PR; never merged). The rest of this README describes the intended version 1 behavior. Sections marked **(deferred in v0.1)** are not implemented yet, and `minions doctor` reports them as unavailable: GitHub Issues backend, auto-merge and merge requests, review publication, config plan/apply, backlog migration, upgrade, budgets, and companion containers. `minions auth github` stores a per-project fine-grained GitHub token on the host (see [docs/design/bootstrap.md](docs/design/bootstrap.md#github-credential)); the container uses it for branch/pull-request delivery. The v0.1 contract is [docs/design/bootstrap.md](docs/design/bootstrap.md); the full requirements are in [docs/spec.md](docs/spec.md).

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quickstart](#quickstart)
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
│  - install / config  │  short-lived   │   ├─ minions:engineer  (subagent)        │
│  - Docker lifecycle  │  tokens,       │   ├─ minions:tester    (subagent)        │
│  - credential refresh│  explicit      │   └─ minions:reviewer  (subagent)        │
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

## Quickstart

```sh
# Install the CLI from a source checkout (builds, packs, installs globally with npm, runs init)
./install.sh path/to/repo
# or manually: npm ci && npm run build && npm pack && npm install -g ./minions-<version>.tgz

# Initialize a project: inspect, propose, apply, verify
minions init path/to/repo
minions init path/to/repo --dry-run --json   # preview without writing

# Check tools, credentials, runtime features, policy, backend, and merge readiness
minions doctor

# Launch the coordinator in the project container and attach your terminal
minions start                   # first run: log in with /login inside the coordinator session
                                # (or set up host-provisioned keys first: minions auth set …)
minions start --no-attach       # only start the container and import the repository
```

### What `init` does

1. **Read-only discovery.** Reads Git metadata, Docker availability, instructions, contribution docs, build files, CI workflows, and issue references. Files are treated as data: discovery runs no repository scripts and never builds your Dockerfile.
2. **Wizard.** Asks only questions whose answers change behavior, with answers prefilled from the profile and from discovery:
   1. Starting profile
   2. Private or shared installation
   3. Backlog backend and ownership
   4. Task intake and authorized scope
   5. Publication and merge authority
   6. Terminal or Telegram
   7. Credential references and authentication readiness
   8. Container image, toolchain, and any application preview ports
3. **Plan review.** Shows the planned writes, effective permissions, inferred verification commands, unavailable capabilities, and any external setup you still need to do. Approving the plan authorizes exactly those changes and nothing else.
4. **Apply and verify.** Writes files atomically and records their hashes in a manifest. A failed install rolls back. Incomplete external setup, such as GitHub Apps or branch protection, is recorded as pending, never reported as ready.

`init` is idempotent. It never overwrites files you own, preserves uncommitted changes, never enables `bypassPermissions`, and never creates GitHub Apps or changes branch protection by itself. For non-interactive setup, pass a validated config file.

### Shared and private installations

| | Shared | Private |
| - | - | - |
| Config location | `.minions/` in the repo (you may commit it) | `~/Library/Application Support/Minions/projects/<projectId>/` on the host, plus named volumes |
| Repository changes | Managed files, optionally an owned block in `CLAUDE.md` | None: `git status` stays unchanged |
| Backlog | Can be versioned in Git | Kept outside the repository |
| Typical use | Your own project | Your personal team inside an employer's repo |

All worktrees of a repository map to the same project ID, and only one coordinator can run per installation. If a copied project ID turns up bound to a different repository, minions detects it and asks you to attach explicitly or initialize a new project.

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
2. **Engineer.** Implements the task on `agent/<task-slug>` in its own worktree, branched from the configured base branch (not necessarily `main`).
3. **Tester.** Runs after the engineer, never at the same time on the same branch. It runs the project's verification commands and may add tests within scope.
4. **Reviewer.** Inspects the exact head commit in a separate checkout and returns a structured verdict. The reviewer never fixes production code and never publishes merges.
5. **Deliver.** Commit, push, open a PR, or request a merge, depending on configuration.

Each worker receives a compact task brief: objective, acceptance criteria, non-goals, relevant decisions and files, branch, worktree, expected head, authorized commands, model, and attempt limit. Each worker returns a validated result with one of these statuses: `complete`, `needs_changes`, `blocked`, `needs_split`, or `partial`. A malformed result gets one correction attempt. After that it is stored as unvalidated and is never promoted to an approval.

If a task turns out to be too large, the worker reports `needs_split`. The coordinator then creates child tasks idempotently, links their dependencies, and keeps the parent as a tracking task. The parent closes only when its required children and its own acceptance criteria are done.

After three repair cycles on a task (configurable), the coordinator replans instead of retrying again.

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

To switch backends mid-project, use `minions migrate backlog` **(deferred in v0.1)**. The migration preserves task identity, links, dependencies, and PR references, can resume after a partial failure, and leaves the source records in place.

## Task lifecycle

```
idea → ready → implementing → testing → reviewing → awaiting-ci → merging → done
                     ↑                       │
                     └── changes-requested ←─┘
Also: blocked · awaiting-human · cancelled
```

Local and PR-only workflows can end a task at **delivered**. Reports keep that distinct from **merged**, because an open PR is not a merged task.

Under the default settings, at most **2 tasks** are active and at most **2 engineers** run at once. A blocked task or one waiting on a human frees its capacity unless a worker is still running on it.

## Delivery, review, and merging

v0.1 supports `local`, `branch`, and `pull-request` delivery. `auto-when-eligible`, review publication, and merging are **deferred in v0.1**: minions never merges, and an open PR is reported as **delivered**, not merged.

| Mode | Behavior | Needs GitHub write access |
| - | - | - |
| `local` | Commits locally and writes a handoff | No |
| `branch` | Pushes the branch | Yes |
| `pull-request` | Opens a PR and waits for your established process | Yes |
| `auto-when-eligible` | Requests a merge once every gate passes **(deferred in v0.1)** | Yes, plus a separate review identity |

**Branch and pull-request delivery (v0.1).** Set `delivery.provider` to `"github"` and `delivery.mode` to `"branch"` or `"pull-request"`. The init wizard offers these only when the repository has a GitHub remote and a token is stored (`minions auth github`); otherwise it keeps `local` and says why, and the guided [GitHub setup](#github-setup) that follows offers to switch once a token works. When the reviewer approves, `minions work record` pushes exactly the approved commit to `agent/<slug>` on origin and, in `pull-request` mode, opens one PR against the base branch. The task becomes `delivered` with the PR URL recorded. If publication fails (network, credential, permission), the task is `blocked`, the local branch is kept, and `minions work publish <taskId>` retries; reruns reuse an existing remote branch or PR instead of duplicating it. If the change touches a sensitive path (or `git.push` / `pr.create` is `ask`), nothing is pushed until you approve that exact commit with `minions work approve <taskId> --head <sha>`. PR text comes only from the task title, objective, and acceptance criteria; private installations add nothing else.

**Evidence is tied to commits.** Test results, the review verdict, local checks, and CI observations are recorded against a head SHA and a config revision. A new commit invalidates stale evidence.

**Approvals need a real second identity.** A native approving GitHub review requires an author and a reviewer with different identities. Two Claude sessions or two tokens for the same user don't count. The `project-owner` profile supports two GitHub Apps, one for development and one for review, and you remain a third identity for sensitive approvals. The `personal-work` profile adopts your existing approved credentials and review process.

**The merge helper refuses to merge unless all of these hold:**

- the project, repository, base branch, and PR are correct
- publication and merge capabilities are allowed
- the head SHA is the expected one
- a current, valid, independent review exists
- the tester and local verification evidence required by config exist
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

## Sensitive changes

Changes to these paths need human approval before publication or merge. Local planning and proposed edits can still be allowed.

```
.github/workflows/**   .github/CODEOWNERS   .minions/**   .claude/**
CLAUDE.md   AGENTS.md   automation/**
infra/**   infrastructure/**   deploy/**   terraform/**   **/migrations/**
```

You can change the list through the configuration workflow. A worker PR that tries to change its own control policy is handled separately from a reconfiguration you authorized. The development identity can never self-approve changes to credentials, workflow trust, or merge gates.

In shared installs, path rules can map to CODEOWNERS and required code-owner review. In private installs, minions enforces them locally and says plainly that the repository has no hard gate for them. CODEOWNERS can't express semantic rules such as "all dependency changes", and minions does not claim that it can.

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
| restart-required | Updated prompts or tool permissions, Telegram changes |
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
  "verification": { "commands": [], "testerRequired": true, "reviewerRequired": true },
  "communication": { "channel": "terminal", "progress": "milestones" },
  "budgets": { "taskUsd": null, "dailyUsd": null }
}
```

The full shape is defined by the JSON Schema shipped with the package. Unknown fields and contradictory settings fail with an actionable error. Secrets appear only as references, never as literal values.

## Models and budgets

- Workers default to `sonnet`. `opus` and `haiku` are also allowed, limited to whatever your account can actually use.
- The coordinator picks the model and effort for each attempt: smaller models for narrow inspection, stronger reasoning for hard debugging, architecture work, or repeated failures.
- `models.effort` (`low` | `medium` | `high` | `xhigh` | `max`, unset = Claude Code's default) sets the workers' reasoning effort (agent frontmatter `effort`) and the coordinator's (`--effort`). `models.coordinator` picks the coordinator session's model (`--model`; must be in `models.allowed`). Example: `"models": { "default": "claude-opus-5-5", "allowed": ["claude-opus-5-5", "sonnet", "opus", "haiku"], "selection": "coordinator", "effort": "medium" }`.
- Each attempt is capped at 80 turns, and a task replans after 3 repair cycles. These are attempt limits; they don't cancel the task.
- Per-task and per-day USD caps are optional and off by default. When set, minions checks known usage before starting each attempt and stops new starts once a cap is reached. Usage figures may be estimates, and minions records how reliable they are. It doesn't promise hard billing enforcement.
- minions tracks completion time, attempts, repairs, human interventions, and available usage per task.

## Communication

**Terminal** is the only channel in v0.1 and the baseline for setup and recovery, and it always works.

**Telegram** uses the official Claude Code channel plugin (a research preview) with your own bot. The wizard walks you through creating the bot, pairing it, and allowlisting senders; `minions auth telegram` stores the bot token on the host without echo. Only paired senders can control the coordinator; unpaired senders are dropped. Pair only yourself, because allowlisted senders can also approve tool-permission prompts. If Telegram is unavailable, the coordinator starts in terminal mode and says why. Each bot can be polled by only one coordinator at a time, so use a separate bot for each project you run at the same time.

What you receive:

- acknowledgements of new goals
- summaries of completed tasks and milestones, with links
- significant blockers and changed plans
- approval requests
- status, when you ask for it

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
- GitHub App private keys never enter the container. The host refreshes short-lived installation tokens into read-only secret files, and if a refresh fails, external writes pause.
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
- **Commands run directly.** `start`, `status`, `pause`, `resume`, `work publish|approve` and the coordinator run on the host through a generated `minions` shim (`host/bin/minions`) that pins `MINIONS_RUNTIME=host` and the paths. The coordinator runs in a dedicated tmux server (`tmux -L minions-<id>`), never your default one; `minions down` kills that server. `tmux attach` hint: `tmux -L minions-<id> attach -t coordinator`.
- **Hardening that still applies.** The coordinator settings enable Claude Code's sandbox (`sandbox.enabled`, `autoAllowBashIfSandboxed: false`, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`): Bash commands of the coordinator and workers may write only to the agents' workspace, the runtime state and npm/tool caches, can't read `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.docker`, `~/.kube`, `~/Library/Keychains`, `~/.netrc` or the minions credential store, and reach only GitHub and the npm registry without a prompt. The same paths, the project's host-control files, and `security` / `gh auth` are permission denies for the Read/Edit/Bash tools. `bypassPermissions` stays disabled. This narrows what agents can do, but it is not a container boundary: your user-level Claude Code settings, hooks and plugins also apply, and anything you approve at a prompt runs as you.
- **Claude authorization.** `login` uses your existing Claude Code login on this Mac (no key handoff). `api-key` / `helper` / `jbcentral` write the key to `projects/<id>/secrets/anthropic-api-key` (0600) and the coordinator gets `apiKeyHelper: "cat '<that file>'"`; no loopback rewrite is needed.
- **GitHub.** The stored per-project token (`minions auth github`) is copied to `projects/<id>/secrets/github-token` (0600) on `minions start` and removed on `minions down`. The workspace clone's own git config points its github.com credential helper at the shim; a generated `gh` wrapper (`host/bin/gh`, only when `gh` is installed) passes the token to gh's process only. Your global git and gh configuration and your own gh login are never changed or used. `GH_TOKEN` / `GITHUB_TOKEN` from your shell are removed from agent processes.
- **Tools.** You install `tmux` (`brew install tmux`), Claude Code (`npm install -g @anthropic-ai/claude-code` or `brew install --cask claude-code`), Backlog.md (`npm install -g backlog.md@1.54.0`), `git`, and, for pull-request delivery, `gh` (`brew install gh`). `minions doctor` checks their versions and shows a warn-level `runtime` check.
- **Not in host mode.** Container resources and preview ports don't apply. The Telegram plugin is not installed automatically (it would change your own Claude Code setup); install it yourself or stay terminal-only.
- **Uninstall.** `minions uninstall` stops the tmux server and keeps `host/` (workspace and state); `--delete-data` deletes it.

## CLI reference

| Command | Purpose |
| - | - |
| `minions init [path]` | Inspect and initialize a project (`--private` / `--shared`, `--runtime docker\|host`, `--yes`, `--dry-run`) |
| `minions doctor` | Check tools, Docker (or the host runtime's tmux/claude/backlog/git), image, container, Claude auth, backlog CLI, and deferred features |
| `minions start` | Build the image if needed, start the container, import the repo, attach the coordinator (`--no-attach`) |
| `minions down` | Stop and remove the project container (volumes kept), or stop the host runtime's tmux server |
| `minions status` | Queue, workers, pause state, config revision, delivery mode |
| `minions pause` / `resume` | Persist scheduling controls |
| `minions import` | Refresh the container workspace from the committed base branch (Git bundle) |
| `minions export` | Fetch `agent/*` branches into `refs/remotes/minions/*` in your repository; local branches are untouched |
| `minions config show [--explain]` | Effective values and their provenance |
| `minions auth show` / `set <login\|api-key\|helper\|jbcentral>` / `refresh` | Host-side Claude authorization (see [Claude authorization](#claude-authorization)) |
| `minions setup github` | Guided GitHub setup: remote, base branch on the remote, pre-filled fine-grained token, delivery mode (`--yes` prints the next steps only; see [GitHub setup](#github-setup)) |
| `minions auth github` / `telegram` | Store (or `--remove`) the project's GitHub token / Telegram bot token on the host; prompted without echo or `--stdin` |
| `minions backlog ready` / `list` / `show` / `create` / `update` / `note` / `export` | Backend-neutral task operations (inside the container) |
| `minions work claim` / `record` / `release` / `list` | Leases and worker results (used by the coordinator, inside the container) |
| `minions work publish <taskId>` | Publish (or retry publishing) an approved task in branch / pull-request delivery; idempotent |
| `minions work approve <taskId> --head <sha>` | Record your approval to publish that exact commit (sensitive paths, or `ask` publication) |
| `minions runtime show` / `set <docker\|host>` | Host-side agent runtime: Docker (default) or the less safe host runtime (`--global`, `--yes`, `--dry-run`; see [Running without Docker](#running-without-docker)) |
| `minions uninstall` | Remove owned files while keeping task data (`--delete-data` also deletes volumes) |

Planned, **deferred in v0.1**: `minions stop`, `minions sync`, `minions config plan` / `apply`, `minions review publish`, `minions merge request`, `minions migrate backlog`, `minions upgrade`.

Every command supports `--json`, and mutating commands support `--dry-run`. Exit code 0 means the requested operation completed; it does not mean a whole task passed. Errors use stable codes for auth required, conflict, policy denied, invalid configuration, incompatible runtime, and retryable network failure. Secrets and large task text go through stdin or restricted temporary files, never through process arguments.

## Recovery, upgrades, and uninstall

- **Restart and recovery.** `minions start` reconciles sessions, branches, leases, and completed external actions before it retries anything, then attaches to or relaunches the coordinator. If a worker fails, its worktree and a recovery record are kept. minions never cleans up worktrees it doesn't own.
- **Upgrades (deferred in v0.1).** `minions upgrade` produces a plan, backs up the config, migrates schemas deterministically, preserves your overrides, detects edits to managed files, marks running workers stale when behavior changes, and never turns on new authority.
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

To be decided.
