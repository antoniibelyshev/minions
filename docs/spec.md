> **Naming note (19 October 2026):** The product, npm package, and CLI executable are named **minions** (originally drafted as "Agent Squad" / `agent-squad`). Read `agent-squad`, `AgentSquad`, and `.agent-squad/` below as `minions`, `Minions`, and `.minions/`. Namespaced prefixes such as `squad-*` skills/workers and `squad:*` labels are to be renamed consistently at implementation time.
>
> The GitHub label list in section 8 was garbled in the source text (it lost the label suffixes); the lifecycle label set must be defined during implementation, e.g. one `squad:<state>` label per active lifecycle state plus `squad:ready`.

# Agent Squad — Version 1 implementation specification

Date: 19 October 2026

Agent Squad is a macOS package that installs a configurable Claude Code development team into a Git project. A coordinator receives requests through Telegram or a terminal, maintains an execution backlog, and delegates bounded work to engineer, tester, and reviewer agents.

The package supports both an owner-controlled project and a personal team working inside an existing organization repository. The latter can maintain private subtasks while following the repository's existing architecture, tracker, CI, and contribution process.

This specification is intended as the implementation brief for a coding agent. Implement the package and its tests from the requirements below. Names and configuration examples describe the new package's interfaces; they are not claims about existing Claude Code commands.

# 1 Product scope

## Goals

- Install a reusable collection of skills, worker configurations, policies, and small operational helpers.
- Ask a short set of meaningful installation questions and derive routine settings from profiles and repository inspection.
- Support GitHub Issues and Backlog.md as execution backlog backends.
- Allow ongoing configuration changes through Claude without reinstalling.
- Run a small autonomous team on the user's laptop over many sessions.
- Preserve decisions, task progress, and recovery information outside conversation history.
- Respect existing workplace policies and keep personal automation artifacts private when configured.
- Control context growth, duplicate work, and unproductive repair loops.
- Make permissions, publication, task intake, and proactive execution independently configurable.

## Version 1 boundaries

Support macOS on Apple Silicon and Intel with a user-installed Docker Desktop and Docker Compose v2, containerized Linux development environments, Git repositories, Claude Code as the agent runtime, GitHub PR delivery, and terminal or Telegram communication.

External work tickets may be linked by URL and manually imported as execution tasks. GitHub-filtered intake is supported. Native Jira, Linear, and other enterprise tracker connectors are extension points, not version 1 requirements.

Deployment automation is disabled by default and outside version 1. Existing deployment instructions may be recorded, but no deploy adapter is required.

All model-controlled execution runs inside a per-project Docker container while the laptop is awake. A thin trusted macOS CLI manages installation, container lifecycle, narrowly scoped credential provisioning, and explicit import/export. Automatic reboot recovery, cloud hosting, a dashboard, separate containers per worker, and experimental Claude Code agent teams are outside version 1. Container isolation protects the host boundary; workers within one project container share its filesystem and permissions.

A private/local delivery mode must work without GitHub write credentials. Automatic merging is a conditional capability, not a prerequisite for using the package.

# 2 Implementation foundation

Use TypeScript, Node.js 22 or later, npm-compatible distribution, Docker Compose v2, and a CLI executable named agent-squad. The initial package name is agent-squad; registry-name availability does not block implementation. A local npm tarball is a supported install artifact.

Use a small command parser, a schema-validation library, standard subprocess APIs, and minimal dependencies. Package and lock dependencies normally. Do not install project dependencies globally or change shell startup files during initialization.

Distribute:

- A multi-architecture runtime Dockerfile, Compose template, and a documented project-image extension mechanism.
- Claude Code plugin templates with namespaced skills and worker definitions.
- A CLI for installation, configuration, backlog operations, policy checks, GitHub operations, and recovery.
- JSON Schema for configuration.
- Integration adapters.
- Tests and operator documentation.

All external commands must use argument arrays with shell execution disabled unless a user-configured verification command explicitly requires a shell. Do not interpolate issue text, branch names, PR comments, or file content into executable shell strings.

Runtime integrations must be capability-tested against the installed tools. Pin and document a tested compatibility range in the implementation; do not invent CLI flags, hook payloads, or agent frontmatter fields.

# 3 Runtime architecture

The main Claude Code session runs inside the project container and is the coordinator. It loads a project-specific Agent Squad plugin and appended coordinator instructions, while retaining normal Claude Code behavior and existing project instructions.

The coordinator uses native custom subagents for engineer, tester, and reviewer work. All workers report to the coordinator. Workers do not contact the user or delegate additional workers.

The CLI provides deterministic operations: listing ready tasks, validating transitions, claiming work, recording results, checking policy, locating worktrees, posting reviews, and requesting merges. The model decides priorities, task splits, implementation strategy, and when to escalate.

Use normal Claude Code session/plugin mechanisms inside Docker. The host launcher attaches a terminal to the containerized coordinator and uses a container-internal tmux session for persistent attachment. It must not automate terminal keystrokes or scrape a terminal UI as a protocol.

Generated skills instruct the coordinator to use the CLI's machine-readable interface for durable operations. A skill is not a scheduler: ready work continues through coordinator turns and worker-completion events. The coordinator may idle when the queue is exhausted, paused, blocked, or awaiting input.

Add a lightweight Stop-hook guard that queries local state and allows stopping when there is no immediately runnable work. When runnable authorized work exists and capacity is available, it supplies a bounded continuation instruction. It must not repeatedly wake a model for network errors, blocked dependencies, unavailable capacity, failed permission checks, or retry exhaustion. Record a continuation guard counter and stop with a clear recovery reason if it loops without state changes.

Version 1 synchronizes external intake on startup and explicit sync requests. Background polling for newly assigned external tickets is not required.

Terminal mode must remain usable if Telegram setup or its preview feature is unavailable.

# 3A Docker execution boundary

Docker execution is mandatory. The installer must not offer a host-execution fallback when Docker is unavailable.

## Topology

Use one runtime container per project. It contains the coordinator, native subagents, Git worktrees, backlog adapter operations, project dependency installation, development servers, and test/browser processes. A native subagent is a process/context inside this container, not a separate Docker container.

A trusted host CLI owns Docker lifecycle and configuration. Agents never receive access to the Docker daemon, its socket, a remote Docker endpoint, an SSH agent, the host home directory, host Claude configuration, or general host command execution.

Do not implement Docker-in-Docker. Projects requiring additional services can use explicitly configured companion containers on a project network, provisioned by the host CLI. Agents cannot create arbitrary containers or replace the Compose configuration at runtime.

## Container baseline

- Run the coordinator and workers as an unprivileged non-root user.
- No privileged mode, host networking, host PID namespace, host devices, or Docker socket mounts.
- Drop Linux capabilities; enable no-new-privileges and retain the runtime's default seccomp protection.
- Read-only root filesystem with explicit writable project/state/cache volumes and a temporary /tmp.
- Default limits: 4 CPUs, 6144 MiB RAM, and 512 processes per project. Report host capacity and let the user adjust these through host configuration.
- No automatically exposed ports. Approved application previews bind only to 127.0.0.1 on macOS.
- Mount generated plugin/policy artifacts read-only when possible. User-approved container/image changes take effect on controlled recreation.
- Pin base image and tool versions in the package release. Provide both arm64 and amd64 builds.
- Do not install arbitrary dependencies as root at runtime. Add system packages through a reviewed image build; install application dependencies into writable project/cache paths as the runtime user.

Do not auto-build an existing repository Dockerfile during read-only discovery. Image builds execute code. Show an image-extension plan first, and never pass runtime secrets into the build context or image layers.

## Repository access

The default workspace is a project-scoped named Docker volume populated by a fresh Git clone. No live host repository bind mount is used. Dirty or unpushed host changes are not imported implicitly.

For a repository without a usable remote, the host CLI can explicitly stage a selected tracked snapshot or Git bundle into a disposable import directory, validate its contents and sensitive-file policy, then copy it into the container workspace. Preserve provenance and report which commit and files were imported.

A snapshot is not a filter for already-committed secrets. Warn on detected tracked secret files, never copy ignored/untracked .env files by default, and do not promise complete secret detection.

Shared Agent Squad files edited in the container are committed to the container clone and delivered through Git. Private state stays in the project's named volumes. Exporting a patch or configuration onto the host is a separate explicit host command that previews paths and refuses destructive overwrites.

Do not expose the host's .git directory or Git common-directory pointer to worktrees inside Docker. Clone first and create all worker worktrees inside the container clone. Fresh clones must use authenticated remotes through the injected project credentials; do not copy host credential helpers into the runtime.

## Credentials and authentication

Authenticate Claude inside the container, persisting only that project's Claude state in a dedicated named volume. The installer must test supported interactive login or API-key provisioning; host login state is not assumed to transfer.

Provision only explicitly selected GitHub, model-provider, and Telegram credentials. Mount exact secret files read-only; secret mounting limits distribution but does not make the bytes inaccessible to a shell-capable agent that can read the mount.

Keep long-lived App signing keys on the host and inject short-lived GitHub tokens. Use a small trusted host credential-refresh process with fixed configured operations, no arbitrary command interface, and no Docker access from inside.

Do not imply strong credential separation between engineer and reviewer in this single-container version. Distinct GitHub identities provide correct review attribution; they do not make a compromised worker unable to reach every in-container credential. Strong per-worker isolation is a future extension.

## Networking

Default outbound internet is permitted so Claude, Telegram, GitHub, and dependency downloads work. Do not claim a normal Docker network enforces a domain allowlist or blocks the host/LAN.

The default threat boundary is reduced host filesystem and process access, not protection against network exfiltration or remote actions authorized by injected tokens. A restricted-egress mode may be added later only with actual enforceable proxy/firewall controls and tests.

Companion database services use a project-local network and no host port by default. Access to company VPN/internal services must be verified inside Docker and explicitly documented; never bypass organization restrictions to make it work.

## Persistence, recovery, and host controls

Persist repository, runtime SQLite state, private backlog, notes, and Claude sessions in named volumes. Container recreation must preserve these; uninstall must retain volumes unless the user explicitly requests data deletion.

Host control configuration is not writable by the runtime container. Claude can change ordinary workflow configuration in its project state, but changes to mounts, image, resources, published ports, or credential grants produce a host-side change plan for the user's launcher to apply. No reinstall is needed.

A Docker Compose restart does not recreate a lost interactive Claude context automatically. On start/recover, reconcile sessions, branches, task leases, and external actions, then attach or launch the appropriate coordinator.

No silent restart into host execution is allowed. Native macOS/iOS app builds requiring Xcode are unsupported inside the Linux runtime and must be reported as an environment limitation.

# 4 Starting profiles

Profiles provide initialization defaults. Their values are copied into explicit configuration; changing a profile later produces a configuration patch and does not silently reset customized settings.

| Setting | project-owner | personal-work | supervised |
| - | - | - | - |
| Architecture authority | Make ordinary architecture decisions | Follow existing architecture; propose significant changes | Propose significant changes |
| Execution backlog | GitHub Issues, or Backlog.md if GitHub is absent | Private Backlog.md | Private Backlog.md |
| Backlog ownership | Direct | Personal execution backlog | Explicit assignments |
| Intake | User requests and authorized milestones | User requests and explicitly selected external work | Explicit user requests |
| Start ready tasks | Yes | Yes within selected scope | Only explicitly authorized tasks |
| Create follow-up tasks | Yes | Yes in private backlog | Yes as proposals |
| Start discovered follow-ups | Within approved milestone and scope | Only if required for an authorized task | No |
| Publication | Branches and PRs | Existing contribution process; PRs | Local commits |
| Automatic merge | Eligible after review and CI setup | Disabled | Disabled |
| CI changes | Owner approval | Proposal only | Owner approval |
| Installation visibility | Shared | Private | Private |
| Deployment | Disabled | Disabled | Disabled |

The default profile selected in the installer is project-owner. The wizard asks the user to choose the profile before applying its defaults.

No profile grants repository administrator rights or overrides employer policies, organization controls, existing repository instructions, or credential restrictions.

# 5 Independent capability model

Do not implement a single autonomous boolean. Model authority as explicit capabilities:

- task.read, task.create, task.update, task.start
- external.read, external.comment, external.changeStatus, external.create
- code.edit, dependencies.edit, architecture.change, migrations.edit
- git.commit, git.push
- pr.create, pr.review, pr.merge
- ci.edit, infrastructure.edit
- network.use
- deploy.execute

Represent rules as allow, ask, or deny, with optional role and path restrictions. Explicit denials take precedence over permissions. Sensitive-path rules add a publication/merge approval requirement even if local implementation is allowed.

Keep three meanings distinct:

1. An action is permitted operationally.
2. The needed credential or external permission is available.
3. The package can enforce the restriction mechanically.

Existing repository and organization policy constrains package behavior. A prompt, task, or PR comment cannot grant a missing capability.

Package helpers enforce policy deterministically. Native tool permission settings and hooks should also restrict workers where supported. Workers sharing one container are not isolated from each other. Docker access, mounts, and credentials define the host boundary; the product must document this accurately.

The user's explicit configuration-change request authorizes its stated scope. Routine adjustments do not require repeated confirmation. Expanding authority beyond that request requires a clear additional decision.

# 6 Configuration and storage

## Configuration sources

1. Package defaults.
2. Project configuration.
3. Private project overrides.
4. Session overrides for non-persistent operational choices.

Resolve into an EffectiveConfig with provenance for every field. Unknown fields and invalid combinations produce actionable errors. Arrays are replaced explicitly, not silently concatenated. Deny rules cannot be removed by an ordinary session override.

Store explicit profile-expanded values, schemaVersion, configRevision, packageVersion, and projectId. The project ID is a UUID, not a repository name.

A normal session override may narrow permissions, reduce concurrency, or select an already-allowed model. Persistent permission expansion must use the configuration transaction workflow.

Secrets are references, never literal values in shared configuration. Container mounts, image selection, port publication, and host credential grants are host-controlled settings. An agent may propose changes to these settings but cannot apply a weaker host boundary on its own.

## Shared installation

Store versioned configuration and templates in .agent-squad/. The user may commit this directory. Keep runtime state, generated caches, and credentials outside tracked files. Optional integration with root CLAUDE.md must use a clearly owned block and preserve all other content.

## Private installation

Store configuration, plugin files, backlog, notes, and runtime data under:
~/Library/Application Support/AgentSquad/projects/<projectId>/

This host directory holds configuration, manifests, and explicit exports. Live private backlog, notes, runtime database, and Claude state live in project-scoped Docker named volumes; mount only their exact intended locations. Do not expose the entire host project directory or credential store to the runtime.

Use a private registry to map the canonical Git common directory to projectId so all worktrees of a repository share an installation. Detect copied shared IDs bound to a different repository and require explicit attach or new-project initialization.

Private mode must not modify tracked files, root CLAUDE.md, .gitignore, shared issue trackers, or CI during installation. Load a generated plugin through the supported session-local plugin mechanism. Append coordinator instructions at launch and include applicable policy in worker prompts.

Private task data must not leak into source commits, shared PR descriptions, or external tickets. Sending it to the user's configured Telegram bot is an explicit communication choice.

The generated plugin is an implementation artifact, not the authoritative configuration. The plugin is loaded inside the container; host package management does not execute project scripts.

## Configuration example

The following illustrates the required shape. Final field spelling may be refined consistently before implementation.

```json
{
  "schemaVersion": 1,
  "configRevision": 1,
  "projectId": "generated-at-initialization",
  "profile": "project-owner",
  "visibility": "shared",
  "backlog": {
    "backend": "github",
    "ownership": "direct",
    "repository": "owner/repository"
  },
  "intake": {
    "sources": ["user", "milestone"],
    "startReady": true,
    "scope": {
      "milestone": null,
      "externalAssignee": null,
      "requiredLabels": ["squad:ready"],
      "allowedPaths": ["**"]
    }
  },
  "container": {
    "required": true,
    "workspace": "named-volume",
    "cpus": 4,
    "memoryMiB": 6144,
    "pidsLimit": 512,
    "publishPorts": [],
    "network": "outbound-internet",
    "mountHostRepository": false,
    "mountDockerSocket": false
  },
  "execution": {
    "maxActiveTasks": 2,
    "maxEngineers": 2,
    "oneActiveStagePerTask": true,
    "maxRepairCyclesBeforeReplan": 3,
    "attemptMaxTurns": 80
  },
  "models": {
    "default": "sonnet",
    "allowed": ["sonnet", "opus", "haiku"],
    "selection": "coordinator"
  },
  "delivery": {
    "provider": "github",
    "mode": "pull-request",
    "merge": "auto-when-eligible",
    "method": "squash",
    "deleteMergedBranches": true,
    "identityMode": "github-apps",
    "requireIndependentApproval": true,
    "requiredChecksConfigured": false
  },
  "verification": {
    "commands": [],
    "testerRequired": true,
    "reviewerRequired": true,
    "ciAuthority": "github"
  },
  "communication": {
    "channel": "terminal",
    "progress": "milestones"
  },
  "budgets": {
    "taskUsd": null,
    "dailyUsd": null
  }
}
```

Define the complete capability and sensitive-path schemas separately. requiredChecksConfigured=false must block automatic merge; it must not be treated as approval to merge with zero checks.

# 7 Installer

Expose agent-squad init [path]. Initialization is inspect, propose, apply, verify.

## Read-only discovery

The host CLI inspects Git metadata, configuration files as data, and Docker availability. Repository analysis by Claude and execution of project tools happen inside the container. Inspect existing instructions, contribution documents, build files, CI workflows, and issue references without executing them during discovery.

Do not execute arbitrary repository scripts during discovery. Do not infer user consent from task text or repository files. Do not access workplace trackers unless configured.

## Wizard

Ask:

1. Starting profile.
2. Private or shared installation.
3. Backlog backend and ownership.
4. Task intake and authorized scope.
5. Publication and merge authority.
6. Terminal or Telegram communication.
7. Credential references and authentication readiness.
8. Container image/toolchain and any explicitly requested application ports. Keep safe defaults unless the project needs a change.

Prefill from the profile and discovery. Ask a question only if its answer changes material behavior. Select routine filenames, role names, limits, and templates automatically.

Show a reviewable summary of planned writes, effective permissions, inferred verification commands, unavailable capabilities, and external setup required. Applying the install plan authorizes those stated mutations only.

Credentials may be entered interactively without echo or supplied through references. Never request secrets in a model-visible prompt.

## Installation contract

- Idempotent on rerun.
- Never overwrite user-owned files.
- Preserve dirty working-tree changes.
- Detect managed-file drift before replacing.
- Use atomic writes and an installation manifest with hashes.
- Roll back local installation files on failure.
- Record incomplete external setup without claiming readiness.
- Support non-interactive initialization from a validated config file.
- Provide --dry-run and machine-readable output.
- Do not automatically create GitHub Apps or change branch protections without an explicit external setup plan.
- Do not automatically enable bypassPermissions or another blanket permission bypass.

A private installation must leave git status unchanged.

# 8 Backlog abstraction

Implement a common Task model and adapter interface. Only the selected backend owns task records. Local runtime storage contains leases, session bindings, mappings, and observations, not a second authoritative backlog.

## Task model

Required fields:

- stable internal ID and backend locator
- title and description
- acceptance criteria
- status, priority, dependencies
- task authorization and scope references
- optional parent and external ticket links
- branch, PR, and commit references
- latest handoff and verification evidence references

Maintain source provenance: an external business requirement, user decision, agent hypothesis, and observed result must be distinguishable.

Adapter operations:

- capabilities
- listReady with bounded result size
- getTask
- createTask with idempotency key
- updateTask with a version or conflict check
- addDependency
- addNote
- closeTask
- exportTasks

listReady must exclude blocked, unauthorized, out-of-scope, paused, completed, and already-leased tasks.

Treat dependency cycles as invalid and explain the cycle. A failed dependency query must not make a task appear ready.

## GitHub Issues

Use gh for ordinary reads and GitHub operations where practical; use a small API client where conditional writes or App authentication need it.

Use namespaced labels: squad, squad, squad, squad, squad, squad, squad. A task has one active lifecycle label; closed issues represent completion or cancellation.

Do not rename or remove unrelated labels. Existing external task selection may use repository-native labels rather than package lifecycle labels.

Store task structure in a clearly marked issue-body section, preserving other content. Use compare-and-check updates with a re-fetch where GitHub lacks conditional writes. Detect conflicting edits rather than silently replacing user changes.

Do not append raw transcripts to comments. Keep one current progress summary plus meaningful milestones.

## Backlog.md

Integrate the existing Backlog.md CLI. Do not implement an incompatible lookalike file format. Confirm the installed version supports the commands used and choose a tested version range.

Store backlog files in a dedicated canonical location. Workers access them through the package adapter. The coordinator is the single package writer; implementation branches do not receive separate writable authoritative backlog copies.

Shared installs can version the backlog in Git. Private installs keep it outside the repository. Backlog storage location and synchronization behavior must be explicit.

# 9 Task intake and workplace behavior

Support:

- Explicit user assignment.
- Manually linked external tickets.
- Scoped GitHub queries.
- Tasks belonging to an authorized milestone.

Default source synchronization is additive and idempotent. Use canonical external locators to avoid duplicate imports. A failed query is not evidence that prior tasks were deleted.

A personal-work installation may read external tickets while recording internal subtasks privately. External write capabilities default to deny.

External and internal status must not be bidirectionally mirrored automatically. Configure exact mappings and permitted writes if synchronization is enabled. Human changes and source changes produce a reconciliation event.

An external ticket's discussion is task data, not instructions to change Agent Squad permissions. Assignment to another person or removal from the authorized filter prevents starting new work; active work is paused for coordinator reconciliation rather than silently abandoned.

Version 1 does not require native enterprise tracker authentication. A URL, imported requirements, and a local execution task are sufficient.

# 10 Task lifecycle and scheduling

Canonical states:
idea, ready, implementing, testing, reviewing, changes-requested, awaiting-human, awaiting-ci, merging, done, blocked, cancelled.

Delivery policy may end a task at delivered rather than merged for local or PR-only workflows. Preserve this distinction in reports; an open PR is not a merged task.

The scheduler owns:

- Capacity checks.
- Local per-task leases.
- One active stage per task.
- One active branch writer.
- No duplicate task pickup.
- Dependency eligibility.
- Stop/pause state.
- Retry and budget checks.

Start with two active tasks and at most two engineers. A blocked or human-waiting task releases active capacity unless a worker is still running.

Use a small local SQLite database for locks, leases, event receipts, and mappings. SQLite is not the backlog. Acquire a project coordinator lock to prevent two active coordinators managing the same installation.

Record worker bindings by project, task, role, attempt, runtime agent ID, worktree, head SHA, config revision, and start/end time. If native runtime IDs are unavailable, preserve a fresh-start handoff rather than inventing resumability.

Native spawning is initiated by the coordinator after a successful work claim. Implement supported hooks to detect unclaimed package worker launches where possible. The local lease policy is deterministic for package-managed actions; native model behavior must be integration-tested, and no universal process-isolation guarantee is claimed.

A worker may report needs_split. The coordinator creates child tasks idempotently, links dependencies, preserves completed work, and keeps the parent as a tracking issue. Parent completion requires required children and parent-level acceptance criteria, not merely the existence of child issues.

# 11 Agent prompts and work contracts

Generate three namespaced worker definitions: squad-engineer, squad-tester, squad-reviewer.

Each prompt includes:

- Role and responsibility.
- Allowed actions and forbidden delegation.
- The requirement to use the assigned branch and worktree.
- A short project policy reference.
- Task input and output contracts.
- How to report blocked, partial, or oversized work.
- Instructions to return to the coordinator.

Only the coordinator receives Telegram communication tools. Workers receive minimal tool lists and no Agent tool. The reviewer must not fix production code or publish merge requests.

Task brief:

- Task locator and objective.
- Acceptance criteria and non-goals.
- Relevant decisions and files.
- Branch, worktree, base branch, and expected head.
- Authorized commands and publication actions.
- Model, effort, attempt limit, and config revision.
- Prior findings relevant to the current attempt.

Worker result:

- status: complete, needs_changes, blocked, needs_split, or partial
- summary
- branch and head SHA
- modified paths
- checks performed with results
- acceptance criteria evidence
- findings and proposed next action
- usage metadata when actually available

Validate results. If malformed, allow one bounded correction; otherwise store the raw result as unvalidated and ask the coordinator to interpret it. Never silently promote an invalid result to approved.

# 12 Git and verification

Use agent/<task-slug> branches and isolated Git worktrees. Resolve the actual configured base branch; do not assume main.

Engineers and testers modifying a task branch run sequentially. Reviewers inspect the exact PR head in a separate read-only-by-role checkout or worktree. Never assume a native temporary worktree automatically contains the PR changes.

The tester runs after implementation and before final review. It may add tests within scope. Test changes invalidate earlier evidence as appropriate.

Record evidence against head SHA and config revision:

- Local verification commands and outcomes.
- Tester result.
- Reviewer result.
- CI observations.

A new commit invalidates stale final review and test evidence according to affected checks. New base-branch changes require refreshed integration verification; use GitHub's branch rules for final merge eligibility.

Existing project checks are adopted. The installer proposes commands but does not invent CI or change it. A project with no CI remains usable for local work and PR delivery. Automatic merging stays unavailable until required checks are configured and verified.

Failures must preserve worktrees and explain recovery. Automatic cleanup is allowed only for owned worktrees whose changes are committed and published or explicitly archived. Never run destructive cleanup of unknown worktrees.

# 13 Reviews and merging

Publication modes:

- local: commit locally and produce a handoff
- branch: push a branch
- pull-request: open a PR and wait for the established process
- auto-when-eligible: request a merge after policy and external requirements pass

For native approving GitHub reviews, the author and reviewer use distinct GitHub identities. Two Claude contexts or two tokens for the same user do not create independent identities.

For project-owner automatic delivery, support two GitHub Apps: development and review. The human owner remains a separate identity for sensitive approvals. For personal-work, adopt existing approved credentials and review processes; do not require new Apps if automatic agent approval is unavailable or unnecessary.

The coordinator invokes review publication with the reviewer's structured verdict. Bind the posted review to the evaluated commit. The package must verify that the configured repository treats that review as satisfying its requirement.

No approval is posted merely because a reviewer process exited successfully.

Merge helper requirements:

- Correct project/repository/base branch and PR.
- Allowed publication and merge capabilities.
- Expected head SHA.
- Current valid independent review.
- Tester and local verification evidence required by config.
- Required CI checks configured and GitHub requirements satisfied.
- Sensitive-change approval satisfied.
- No bypass/admin merge flag.
- Idempotent response when already merged or queued.

Use native auto-merge where available. Do not build an LLM polling loop to wait for CI. Reconcile the merge result on explicit sync, startup, or a configured supported event. Requesting auto-merge is not completion.

If a platform feature or repository plan does not support the requested gate, report it and downgrade only with explicit configuration authorization. Never silently remove the gate.

# 14 Sensitive changes

Default protected patterns:

- .github/workflows/**
- .github/CODEOWNERS
- .agent-squad/**
- .claude/**
- CLAUDE.md and AGENTS.md
- automation/**
- infra/\*\*, infrastructure/\*\*, deploy/\*\*, terraform/\*\*
- \*\*/migrations/\*\*

These patterns require human approval for publication/integration according to profile. Local planning and proposed edits may still be allowed. Users can change the patterns through the configuration-management workflow.

Distinguish a user-authorized package reconfiguration from a worker PR attempting to change its own control policy.

Where available, map shared path rules to CODEOWNERS and required code-owner review. For private policy not committed to a work repository, enforce package publication checks locally and accurately label the absence of a repository-level hard gate.

Never claim that CODEOWNERS enforces semantic restrictions such as all dependency or architecture changes. Classify such changes through policy and review; add explicit mechanical checks only when implemented.

Credentials, workflow trust, and merge-gate changes must not be self-approved by the development identity.

# 15 Models and resource policy

Default worker model is sonnet. Allowed aliases are sonnet, opus, and haiku, restricted to those actually available to the user.

The coordinator selects model and effort per attempt:

- Routine implementation/testing/review: capable general model.
- Narrow inspection or mechanical analysis: smaller model when appropriate.
- Difficult debugging, architecture, or repeated failures: stronger reasoning.
- Preserve a useful worker for focused fixes.
- Prefer a fresh task-specific context for independent work.

Default attemptMaxTurns is 80 and maxRepairCyclesBeforeReplan is 3. These are attempt limits, not automatic task cancellation or an infinite retry allowance.

Optional task/day monetary caps default to null. If configured, check known usage before starting attempts and stop new starts on cap exhaustion. Runtime usage can be estimated or unavailable; record its quality and never promise hard billing enforcement without provider support.

Do not charge an entire resumed session's cumulative usage again for each retry. Track provider-reported attempt deltas or record the metric as cumulative/unknown.

Track task completion time, attempts, repairs, interventions, and available usage. Useful work per accepted task is the main efficiency measure.

# 16 Communication

Terminal mode is the setup and recovery baseline. Telegram uses the official Claude Code channel plugin and the user's bot. Reuse supported plugin configuration; do not duplicate its transport or scrape its files for secrets.

The wizard guides bot creation, pairing, allowlisting, and launch configuration. Verify preview availability and organization policy before enabling it.

Exactly one active Telegram consumer may poll a bot token. Version 1 supports one project coordinator per bot; recommend a separate bot for each simultaneously running project.

Send:

- Acknowledgement of meaningful new goals.
- Completed task/milestone summaries with links.
- Significant blockers or changed plans.
- Required human approvals.
- On-demand status.

Do not send every tool call or test log. Questions include a recommended answer and what remains blocked.

Plain-language controls map to pause intake, pause new task starts, cancel active owned workers best-effort, resume, status, and sync. Provide terminal equivalents independent of Claude.

Telegram outages must not discard work. Persist pending notifications with deduplication keys; retry on later supported interaction or sync, without waking an LLM solely to resend text.

# 17 Skills and generated content

Ship skills with these responsibilities:

- squad-orchestrate: intake, prioritization, task dispatch, continuation, integration
- squad-configure: inspect and change effective settings
- squad-status: concise project and task status
- squad-intake: import a request or linked external ticket
- squad-recover: reconstruct interrupted work
- squad-maintain-context: record decisions and prune stale operational summaries

Skills invoke CLI helpers rather than editing authoritative config or backend task syntax ad hoc.

Keep role descriptions short. Load detailed procedures only when invoked. Do not preload the complete backlog, every decision, all skills, or full transcripts into every worker.

Shared docs default to .agent-squad/docs/product.md, status.md, and decisions/. Existing project documentation remains authoritative; use pointers and update existing files only within authorized scope. Private mode stores equivalent notes externally.

Templates and generated files are separate. Put user customization in explicit override files. Record generated file hashes. Regeneration detects direct edits and asks for reconciliation rather than overwriting them.

# 18 Mid-project configuration changes

Expose configuration through the CLI and squad-configure skill. Reinstallation is never required for normal setting changes.

Transaction:

1. Read effective config and field provenance.
2. Parse the requested change into a typed patch.
3. Classify impact: immediate, next-dispatch, restart-required, or migration.
4. Validate against project policy, installed capabilities, and active tasks.
5. Produce a diff and apply within the user's authorized request.
6. Increment configRevision, regenerate managed artifacts, and record the change.
7. Verify the new configuration and report when it becomes effective.

Examples:

- Concurrency reduction: stop new starts immediately; do not kill useful work.
- Model default: next dispatch; resumed workers change only through supported runtime controls.
- Stricter permissions: suspend affected external actions immediately; restart/recreate workers when needed.
- Broader permissions: require an explicit user-directed change, not agent self-authorization.
- Private/shared visibility: migration with a data-visibility inventory.
- Telegram changes: controlled coordinator restart.
- Backlog backend: migration with ID mapping.
- Updated prompt or tool permissions: do not assume hot reload; report and restart affected sessions safely.

A resume can retain old runtime instructions. Record loaded configRevision and block sensitive external operations from stale revisions. Fresh launches and helper checks must use current config.

# 19 Backlog migration

Support GitHub Issues to Backlog.md and the reverse without losing task identity.

Procedure:

- Pause new dispatch and reconcile active task leases.
- Export source records and create a private backup.
- Prepare a migration manifest with source/destination locators and idempotency keys.
- Import tasks, links, dependencies, handoffs, status, and PR references.
- Verify record counts and dependency mappings.
- Switch the authoritative backend only after successful verification.
- Leave source records intact by default with an optional redirect/archive operation.
- Resume dispatch after configuration and mappings commit locally.

External migrations are not fully transactional. Persist completed steps and allow resumable retries. Never promise rollback can erase posted comments or notifications.

Do not delete source issues automatically. Unsupported metadata or destination limits must be reported before committing the switch. Active role/session bindings follow the stable internal task ID.

# 20 CLI contract

Required command families:

| Command | Responsibility |
| - | - |
| init | Inspect and initialize a project |
| doctor | Check tools, credentials, runtime features, policy, backend, and merge readiness |
| start | Launch the coordinator with the correct plugin/configuration |
| status | Show queue, workers, blockers, config revision, and delivery readiness |
| pause / resume | Persist scheduling controls |
| stop | Request best-effort cancellation of owned work |
| sync | Refresh backend, intake, PR, CI, and merge observations |
| config show / explain | Show effective values and provenance |
| config plan / apply | Validate and apply typed changes |
| backlog ready / show / create / update / note / export | Backend-neutral task operations |
| work claim / record / release | Leases and worker result recording |
| review publish | Publish a validated review under the configured identity |
| merge request | Request an eligible merge |
| migrate backlog | Prepare/apply/resume a backend migration |
| upgrade | Upgrade package-managed artifacts with drift checks |
| uninstall | Remove owned installation hooks/files while preserving task data |

Support --json for automation, --dry-run for mutations, and stable documented error codes. Exit 0 means the requested operation completed, not that an entire task passed. Use explicit errors for auth required, conflict, policy denied, invalid configuration, incompatible runtime, and retryable network failure.

Never put secrets or large task text in process arguments when stdin or a restricted temporary file is suitable.

# 21 Upgrades and uninstall

Keep package version, schema version, template version, and config revision distinct.

An upgrade must:

- Produce a plan.
- Back up changed configuration.
- Migrate schemas deterministically.
- Preserve user overrides and unrelated files.
- Detect drift.
- Mark running workers stale if behavior changes.
- Never enable new authority automatically.

Uninstall removes only files or owned blocks recorded in the manifest and unchanged since generation. Preserve backlogs, decision records, worktrees with work, and credentials by default. Offer separate explicit data removal.

A private uninstall should leave the repository unchanged. An interrupted install/upgrade must be recoverable from its journal.

# 22 Security and operational boundaries

- Store long-lived secrets in macOS Keychain by preference, or user-owned 0600 files outside the repository. Only the trusted host launcher reads them; never mount Keychain access or the host credential directory into the container.
- Configuration contains credential references only.
- GitHub App private keys stay on the host. The launcher provisions short-lived installation tokens into exact per-project secret files using a read-only container mount, and refreshes those files before expiry. Verify refreshed token bytes actually become visible through the mount; replacing a host file inode must not leave a stale single-file bind mount. If refresh fails, external writes pause. Never expose a general host command or signing endpoint to the container.
- Use existing approved work credentials when configured.
- Never silently reuse broad personal credentials.
- Never print tokens, environment dumps, secret-bearing command lines, or complete private task payloads in diagnostic output.
- Treat issue/PR content and repository data as untrusted input for shell and configuration operations.
- Run project code only under the configured execution policy.
- Git worktrees isolate changes inside the project container; Docker supplies the host filesystem/process boundary. The project repository, mounted files, allowed network services, and injected credentials remain accessible according to their actual permissions.
- A read-only reviewer with shell access is read-only by workflow unless additional restrictions enforce it.
- Private data must not be copied into shared records by context-maintenance or migration code.
- Keep local logs bounded and redact predictable secret values.
- There is no default production credential injection or deployment authority.

# 23 Acceptance scenarios

Implement unit and integration tests for behavior, not just prompt snapshots.

## Initialization and storage

- Re-running init is idempotent.
- Private init leaves git status unchanged.
- Shared init preserves existing CLAUDE.md, agent config, and dirty files.
- User-edited generated files are detected on regeneration.
- Two worktrees map to one project and cannot start duplicate coordinators.
- A copied project identity is detected rather than attached silently.

## Configuration

- A profile yields documented explicit defaults.
- Invalid fields/conflicting settings fail clearly.
- Field provenance is visible.
- Claude-directed model/concurrency changes work without reinstall.
- Permission tightening blocks a stale worker's subsequent external operation.
- Prompt changes are reported as restart-required where appropriate.
- Updates never silently grant new capabilities.

## Backlog

- Both backends implement the common contract.
- Private work subtasks never create organizational tickets by default.
- GitHub-filtered intake does not import unrelated work.
- Duplicate intake and split retries do not create duplicate tasks.
- Dependency cycles and source-edit conflicts are detected.
- Migration preserves links and can resume after partial failure.

## Docker boundary

- Initialization fails clearly when Docker is unavailable; no agent/project command runs on the host as fallback.
- All coordinator, worker, dependency installation, build, test, and browser commands execute inside the container.
- Inspect the created container: non-root user, no privileged mode, no daemon socket, no host networking/PID namespace, expected caps and limits.
- Host home, SSH agent, host Claude credentials, and unrelated project paths are inaccessible.
- Repository clone and private data survive container recreation.
- A test secret in a host ignored .env file is absent from the runtime by default.
- Explicit imports preserve the selected commit and exclude unrequested host files.
- Runtime cannot modify host launch configuration or obtain Docker control.
- Only requested preview ports are published, bound to loopback.
- Short-lived token expiry pauses affected actions rather than triggering a host credential dump.
- Both Apple Silicon and Intel startup paths are tested.
- Report that outbound internet and shared in-container credentials remain permitted; do not test or claim a nonexistent network or inter-worker isolation boundary.

## Execution

- At most two package-managed task pipelines run under the default configuration.
- The same task cannot be claimed twice.
- Engineer and tester never concurrently write a task branch.
- Tester/reviewer inspect the intended commit.
- Worker failure preserves code and a recovery record.
- Repeated repair cycles trigger replanning.
- Stop-hook continuation ends on blocked/no-progress states and does not spin.
- Restart reconciles completed PR actions before retrying them.

## Delivery

- Local mode works without GitHub write access.
- PR-only mode never merges.
- No configured CI means no automatic merge.
- Reviewer process success without a validated verdict cannot approve.
- GitHub author/reviewer identity mismatch requirements are checked.
- Changed head invalidates stale evidence.
- Failing CI, missing review, or required human approval blocks merging.
- Auto-merge requested is distinguished from merged.
- Sensitive policy changes cannot bypass their own required approval.

## Communication and credentials

- Unpaired Telegram senders cannot control the coordinator.
- One bot cannot be launched by two package coordinators concurrently.
- Terminal recovery works without Telegram.
- Credentials do not appear in logs, generated tracked files, or config exports.

Live tests requiring Claude, Telegram, or GitHub credentials must be opt-in and clearly separated from normal CI. Use temporary repositories and fake adapters for deterministic coverage.

# 24 Implementation sequence and deliverables

Implement in small, working increments:

1. CLI skeleton, typed configuration, profile defaults, project registry, private/shared installation manifest, container image, Compose lifecycle, and host-boundary validation.
2. Backlog abstraction, Backlog.md and GitHub adapters, task contracts, conflict handling.
3. Generated plugin, role prompts, skills, and containerized terminal coordinator launch.
4. Leases, worktree workflow, handoffs, continuation guard, restart recovery.
5. Policy enforcement in helpers, verification evidence, GitHub PR/review integration.
6. Conditional automatic merge, sensitive-change rules, identity readiness checks.
7. Telegram configuration and startup integration.
8. Configuration skill, migrations, upgrades, uninstall, and documentation.

Required deliverables:

- Installable npm package and local tarball.
- Source, lockfile, configuration schema, and templates.
- Tests and a macOS compatibility check.
- Quickstart for project-owner and personal-work profiles.
- Credential and GitHub App setup instructions.
- Commands and configuration reference.
- A sample shared project and a sample private work-project setup, each running entirely in its project container.
- Dockerfile, Compose templates, volume backup/export commands, and a container boundary test suite.
- A troubleshooting and recovery guide.
- A documented Claude Code compatibility matrix.
- A scripted end-to-end demo using disposable repositories.

Do not hardcode an application stack, invent its CI, or create a generic deployment system. Adopt existing repository commands and expose missing verification as an explicit setup requirement.

# 25 Instructions for the implementing coding agent

Build the package described here, beginning with the smallest complete terminal workflow and extending it in the implementation order. Keep each increment installable and testable.

Before coding runtime integrations, verify the installed Claude Code CLI, plugin, subagent, hook, session, and Telegram interfaces against current official documentation. Implement a capability probe and precise failure messages. If an essential runtime operation is unsupported, document the gap and implement a narrowly scoped fallback behind the runtime adapter; do not silently replace the architecture or claim full support.

For unspecified low-impact details, make a reasonable choice and record it briefly. Ask the user only about missing credentials/access, organization restrictions, or consequential behavior that cannot be derived from this specification.

Do not treat this document as authorization to modify unrelated repositories, create external accounts, publish a package publicly, spend money, or change workplace policies. Develop and validate the package locally. All generated agent sessions and project build/test commands must run in Docker; only the trusted installer/lifecycle CLI and package-development tooling run directly on macOS. Produce reviewable plans for external setup actions.

# 26 Reference material

These references explain the external integration surfaces. The package behavior specified above is a new design.

- Claude Code custom subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code plugins: https://code.claude.com/docs/en/plugins
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code channels: https://code.claude.com/docs/en/channels
- Claude Code skills: https://code.claude.com/docs/en/skills
- Docker security: https://docs.docker.com/engine/security/
- Docker runtime options: https://docs.docker.com/engine/containers/run/
- Docker Compose secrets: https://docs.docker.com/compose/how-tos/use-secrets/
- Backlog.md: https://github.com/MrLesk/Backlog.md
- GitHub CLI PR review: https://cli.github.com/manual/gh_pr_review
- GitHub CLI PR merge: https://cli.github.com/manual/gh_pr_merge
- GitHub branch protection: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- GitHub code owners: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
