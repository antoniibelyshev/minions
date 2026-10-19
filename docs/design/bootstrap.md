# Bootstrap build (v0.1) — design contract

This is the working contract for the first installable version. It narrows
[docs/spec.md](../spec.md) to the smallest complete terminal workflow (spec §25)
so minions can then develop itself. Anything listed under "Deferred" must be
reported as unavailable by `doctor` and the wizard, never faked.

## Scope

In:
- Host CLI: `init [path]`, `doctor`, `start`, `down`, `status`, `pause`, `resume`,
  `import`, `export`, `config show`, `auth show|set|refresh`, `auth github`, `auth telegram`, `runtime show|set`, `uninstall`. All support `--json`; mutating ones `--dry-run`.
- Runtime CLI (inside container): `backlog ready|list|show|create|update|note`,
  `work claim|record|release|list`, `hook stop|pre-agent`, `coordinator`, `status`, `pause`, `resume`.
- Profiles `project-owner`, `personal-work`, `supervised`; shared + private visibility.
- Backlog.md backend only. Delivery modes `local` (default; commits on `agent/<slug>` branches in the container clone, fetched to host with `minions export`), and, for the github provider, `branch` and `pull-request` (see "Branch and pull-request delivery"). minions never merges.
- Terminal communication, plus optional Telegram through the official channel plugin (see [telegram.md](telegram.md)).
- One Docker container per project, security baseline from spec §3A. Opt-in, less safe host runtime
  without Docker (see "Host runtime").
- Claude auth inside the container (interactive `/login`, persisted in the claude volume) by default, or
  host-provisioned keys: host-only `claudeAuth` in project.json (`api-key` from file/Keychain/env, or a
  `helper` argv such as the `jbcentral` preset), written to `projects/<id>/secrets/anthropic-api-key`
  (0600), the `secrets` directory bind-mounted ro at `/opt/minions/secrets`, and the coordinator
  `--settings` gaining `apiKeyHelper: "cat /opt/minions/secrets/anthropic-api-key"` when
  `MINIONS_AUTH_METHOD` (compose env) is a key method. Commands: `auth show|set|refresh`.
  Global default in `<MINIONS_HOME>/defaults.json`.

Deferred (report as unavailable): GitHub Issues backend, auto-merge and merge requests,
review publication, config plan/apply transactions, backlog migration, upgrade,
budgets, companion containers.

## Recorded low-impact decisions

- Node >= 22.13 (built-in `node:sqlite`, unflagged). ESM, TypeScript, bundled with esbuild into `dist/cli.js` so the package has **no runtime dependencies** and the image needs only Node.
- Runtime deps bundled: `commander` (parser), `zod` (validation). Dev: `typescript`, `esbuild`, `vitest`, `@types/node`.
- Interactive prompts use `node:readline/promises`; no prompt library.
- Plugin name `minions`; agents `engineer`, `tester`, `reviewer` resolve as `minions:engineer` etc. Skills `orchestrate`, `status`, `intake`, `recover`, `maintain-context` resolve as `/minions:<name>`.
- Backlog.md project lives in `/state/backlog` for **both** visibilities in v0.1 (single writer, never on implementation branches). Versioning a shared backlog in Git is deferred.
- Container reads effective config from a read-only mount; it cannot change config in v0.1.
- Workspace is seeded from a Git bundle of the host repo's committed HEAD branch (`minions import`), so no GitHub credentials are needed. The real `origin` URL is recorded; it is fetched (over https, via the credential helper) only when a GitHub token is mounted.
- Commits inside the container use the host's `git config user.name/email` (copied as plain values at init, shown in the plan).
- Coordinator permission mode defaults to `acceptEdits` with an allowlist for `minions`, `git`, and `backlog` commands. Never `bypassPermissions`.
- Pinned in image: base `node:22-bookworm-slim` (digest pinned in Dockerfile), `@anthropic-ai/claude-code@2.1.292`, `backlog.md@1.54.0`. Tested range documented in `docs/compatibility.md`.
- No `--append-system-prompt-file` exists in Claude Code 2.1.292; the launcher reads the coordinator prompt file and passes it with `--append-system-prompt` as an argv element (no shell).

## GitHub credential

A per-project fine-grained personal access token, provisioned only by the host CLI
(`src/host/credentials.ts`). Inside the container git and gh use it (see "GitHub in the
container"), and branch/pull-request delivery publishes with it; CI observation is a later task.

- **Entry.** `minions auth github` (and, for repositories with a GitHub remote, an optional offer at
  the end of an interactive `minions init`) reads the token from the host terminal in raw mode with
  no echo, or from a pipe with `--stdin`. There is no `--token` flag; the token is never in argv,
  config, the plan, logs, or `--json` output. The wizard questions themselves never ask for secrets.
- **Guidance.** Setup prints the creation link (`https://github.com/settings/personal-access-tokens/new`)
  and the repository permissions: Contents read/write, Pull requests read/write, Checks read,
  Actions read, Commit statuses read, Metadata read. Nothing else.
- **Verification.** Before storing, `GET /repos/<owner>/<repo>` (or `/user` without a GitHub
  remote) with the token in the `Authorization` header only. 401/403/404 → not stored. A network
  failure stores it with a warning. `doctor` repeats the call and reports
  `github.credential: ok | missing | invalid | unverified`.
- **Storage.** macOS Keychain (generic password, service `minions.github`, account = project id)
  when `security` works; otherwise `<host data root>/credentials/<projectId>/github-token`
  (0600 file, 0700 dirs). `MINIONS_CREDENTIAL_STORE=file|keychain` overrides. Storage is refused
  if the host data root is inside the repository. `security add-generic-password -w <secret>`
  would expose the token in argv, so the Keychain write goes through `security -i` with the
  command on stdin and is verified by reading it back.
- **Reference.** `projects/<id>/credentials.json` (0600, host only, not in the manifest) holds
  `{backend, ref, kind, updatedAt}`, never the token. `config show`, the shared config, and
  `project.json` contain no credential data.
- **Mount.** The token is materialized into `projects/<id>/secrets/github-token` (0600, atomic
  rename) on `minions start` and on `auth github` while the container runs, and removed on
  `minions down` and `uninstall`. Compose bind-mounts the **directory** read-only at
  `/opt/minions/secrets` (`GITHUB_TOKEN_CONTAINER_PATH` = `/opt/minions/secrets/github-token` in
  `src/core/paths.ts`). Mounting the directory rather than the file keeps replaced tokens (new inode)
  visible without recreating the container. The Keychain and the credentials directory are never mounted.
- **Uninstall** keeps the stored token, as it keeps other credentials. `minions auth github --remove`
  deletes it.

## GitHub in the container

Decision record for git/gh authentication inside the runtime (`src/runtime/github.ts`,
`docker/gh-wrapper.sh`). The token is read from `GITHUB_TOKEN_CONTAINER_PATH` **at use time**
(absent, replaced, or removed at any moment); it is never copied into git config, remote URLs,
argv, environment files, tmux, or Claude Code settings.

- **git.** `minions workspace import` with a readable token and a github.com remote sets `origin` to
  the normalized `https://github.com/<owner>/<repo>.git` (scp/ssh forms and any URL userinfo are
  dropped), configures the repository-level `credential.https://github.com.helper` as an empty
  entry (resets inherited helpers) followed by `/usr/local/bin/minions git-credential`, and fetches
  the base branch into `refs/remotes/origin/<base>` (a failed fetch only warns). Worktrees share the
  repository config, so push/fetch from any worktree authenticates the same way.
- **Helper.** `minions git-credential <op>` (hidden) answers only `get` for `protocol=https`,
  `host=github.com`, emitting `username=x-access-token` and `password=<token>` on stdout to git.
  `store`/`erase`/other hosts produce nothing. Absent or malformed token: no output plus a stderr
  diagnostic; git then fails non-interactively (`GIT_TERMINAL_PROMPT=0`).
- **gh.** `/usr/local/bin/gh` is a POSIX sh wrapper; the pinned real binary lives at
  `/opt/gh/bin/gh` (off `PATH`). The wrapper reads the token file and sets `GH_TOKEN` only in the
  environment of the `exec`'d gh process. Chosen over `gh auth login` (which would persist the
  token in `~/.config/gh/hosts.yml`) and over a global `GH_TOKEN` (which would leak into tmux and
  every child process). No token file: gh runs unauthenticated.
- **Unreadable token** (e.g. a Linux Docker Engine host whose user is not uid 1000, so the 0600
  file is not readable by container uid 1000): import does not fail; origin is recorded verbatim as
  without a credential and the result carries `origin.authenticated: false` with a precise warning
  (path, container uid, file owner and mode). The helper and the gh wrapper print the same diagnosis.
- **No token file**: identical to the previous behaviour — the recorded URL is stored verbatim,
  never fetched, no helper is configured, and the import result has no `origin` field.

## Branch and pull-request delivery

Decision record for `delivery.mode` `branch` / `pull-request` (`src/runtime/publish.ts`,
`Scheduler.publish` / `approvePublication` in `src/runtime/scheduler.ts`).

- **Config.** Both modes need `delivery.provider: "github"` (cross-field validation). `merge` stays
  `disabled`; `manual` / `auto-when-eligible` validate but are reported unavailable (deferred).
  `project-owner` defaults to `pull-request` only when the repository has a github.com remote **and** a
  token is already stored for the project; otherwise `local` with a note. The init wizard offers
  `local/branch/pull-request` under the same condition and otherwise shows the reason and keeps
  `local` (also for `--config` files that ask for branch/PR delivery). `doctor` `merge.readiness`
  reports whether PR delivery is available and that auto-merge is deferred.
- **Where publication runs.** Synchronously inside `minions work record` when a reviewer approval is
  accepted (tester evidence for the same head and config revision as before), plus
  `minions work publish <taskId>` to retry. One `publications` row per task (DB schema 2) is
  written in the same transaction that ends the reviewer lease (`pending`, bound to the approved
  head and config revision), so a crash between approval and publication is resumable. The response
  carries `publication` (`state`, `status`, `prUrl`, `merged: false`).
- **Outcomes.** `published` → backlog `delivered` with `prUrl` (pull-request mode) and `branch` in the
  task meta; an open PR is reported as delivered, never merged. `awaiting-approval` → `awaiting-human`.
  `failed` (network, auth, permission, diverged remote, moved branch, stale evidence) → `blocked`
  with a note; the local branch and worktree are never touched. Nothing is reported delivered until
  publication succeeded.
- **Gates (deterministic).** `git.push` (and `pr.create` in pull-request mode) are evaluated with
  `can()` against the paths changed by `git diff --name-only --no-renames <base>...<head>` (renames split
  so moving a file out of a sensitive path counts). `deny` fails. `ask` — including the
  sensitive-path upgrade allow→ask — requires a human approval recorded with
  `minions work approve <taskId> --head <sha>` (`approvals` table, scope `publish`, bound to the head;
  a new commit needs a new approval). The coordinator's Claude Code settings put that command under
  `ask` (Claude Code prompts the user every time; ask beats the `minions *` allow) and deny
  `git push` / `gh pr merge`; the user can also run it on the host (delegated into the container).
  Within one container this is policy plus the permission prompt, not a cryptographic separation.
- **Idempotency.** `git ls-remote` first: a remote branch already at the approved head is not pushed
  again; a remote branch that is not an ancestor of the head is a `CONFLICT` (never force-pushed);
  otherwise `git push origin <head>:refs/heads/agent/<slug>` (exactly the approved commit, authenticated
  by the repository credential helper). Then `gh pr list --repo <owner/repo> --head agent/<slug> --state
  all`: an open same-repository PR is reused (as is a merged one for the same head); otherwise exactly
  one `gh pr create --base <base> --head agent/<slug> --title … --body-file -` (body on stdin). If create
  fails (e.g. a concurrent run opened it) the list is re-read once before failing.
- **PR text.** Title, objective (description, minions meta stripped) and acceptance criteria only.
  Shared installations append the task id and head SHA; private installations add nothing else. Notes,
  handoffs, worker results and decision records are never read for PR text.

## Host runtime

Decision record for running agents without Docker (`src/host/runtime.ts`, `src/host/runtime-cli.ts`,
`hostSettings` in `src/runtime/coordinator.ts`).

- **Selection is host-controlled.** `runtime: "docker" | "host"` in `project.json` (absent = docker) and
  optionally in `<MINIONS_HOME>/defaults.json` for new projects. Set by `minions init --runtime`, the
  wizard's first question (default docker; host needs the typed word `host`), or `minions runtime set`
  (host: warning plus typed confirmation, or `--yes`; refused while the old runtime runs). The strict
  MinionsConfig schema has no such field, so repository config cannot downgrade isolation. The
  warning is printed by the wizard, `runtime set host`, every host `minions start` (stderr, also with
  `--json`), init plans, and doctor (`runtime: warn`).
- **Modes.** `MINIONS_RUNTIME` unset = host CLI, `container` = container runtime, `host` = host runtime
  (`runtimeMode()` → `host-runtime`). Runtime commands accept both runtimes (`requireMode('runtime')`);
  host-control commands (`init`, `auth`, `runtime`, `uninstall`, …) refuse to run inside either.
- **Paths from the environment.** `runtimePaths()` defaults to the container paths and reads
  `MINIONS_STATE_DIR`, `MINIONS_WORKSPACE`, `MINIONS_CONFIG`, `MINIONS_SECRETS_DIR`, `MINIONS_PLUGIN_DIR`,
  `MINIONS_TMUX_SOCKET`; DB, backlog root, worktrees, hooks log, plugin dir, coordinator prompt, GitHub
  token file and Claude key file derive from them. The host runtime sets them to
  `projects/<id>/host/{workspace,state}`, `projects/<id>/{runtime/config.json,secrets,plugin}` and
  `minions-<id8>`.
- **Shim.** `projects/<id>/host/bin/minions` (regenerated on every start; 0755 in 0700 dirs) exports
  those variables, `MINIONS_GIT_CREDENTIAL_HELPER` (`!'<shim>' git-credential`), `GIT_TERMINAL_PROMPT=0`,
  the auth env, drops `GH_TOKEN`/`GITHUB_TOKEN`/`TMUX`/`TELEGRAM_BOT_TOKEN`, puts `host/bin` first on
  `PATH`, and execs the installed CLI with the current Node. tmux, the plugin hooks
  (`minions hook …`), the coordinator's `Bash(minions …)` calls and git's credential helper all go
  through it. `host/bin/gh` is `docker/gh-wrapper.sh` with the host's real gh and token path.
- **Delegation.** `status`, `pause`, `resume`, `work publish|approve`, `telegram probe|install|status`
  run the shim with inherited stdio instead of `docker compose exec`. `start` = warning → host tools
  (`tmux`, `claude`, `backlog`, `git` required; `gh` optional) → Claude key refresh (key methods) →
  token copies → shims → `workspace setup` → bundle import if the clone is missing → `coordinator sync`
  → `minions coordinator` (tmux `-L minions-<id8>` `new-session -A`). `down` = `tmux -L … kill-server`
  plus token-copy removal. `import`/`export` use the same bundle flow through
  `host/state/{import,exports}` (`TransferTarget`). `uninstall` kills the tmux server; `--delete-data`
  deletes `host/`.
- **Claude auth.** `login` reuses the user's own Claude Code login (no `CLAUDE_CONFIG_DIR` override).
  Key methods use `apiKeyHelper: "cat '<secrets>/anthropic-api-key'"` (shell-quoted); env values are
  not loopback-rewritten.
- **Hardening (coordinator `--settings`).** Verified against the Claude Code 2.1.292 binary and docs
  (code.claude.com/docs/en/sandboxing, /settings, /permissions): `sandbox.enabled: true`,
  `autoAllowBashIfSandboxed: false` (the allowlist still governs prompts), `allowUnsandboxedCommands: false`,
  `failIfUnavailable: true`, `filesystem.allowWrite` = workspace, state, `~/.npm`, `~/.cache`,
  `filesystem.denyRead` = `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.docker`, `~/.kube`,
  `~/.azure`, `~/.config/gcloud`, `~/Library/Keychains`, `~/.netrc`, `~/.npmrc`, `~/.pypirc` and the
  credential store; `network.allowedDomains` = GitHub and the npm registry. Permission denies add
  `Read`/`Edit` of the same paths, the secrets dir and credential store (`//abs` form), `Edit` of the
  project's host-control files, and `Bash(security …)`, `Bash(gh auth …)`. The secrets dir is not in
  `denyRead` because the git credential helper and gh wrapper run inside sandboxed `minions work`
  commands. Not exercised against a real Claude session in tests (fakes only); the coordinator prompt
  gets a host-runtime note with the real paths.
- **Not supported in host mode:** container resources/ports, automatic Telegram plugin install (it
  would modify the user's Claude Code setup).

## Telegram bot token

A second credential kind on the same mechanism (`CredentialKind` in `src/host/credentials.ts`;
stores, reference file, and secrets mount are shared, not duplicated). Full design: [telegram.md](telegram.md).

- **Entry.** `minions auth telegram` (and, when `communication.channel` is `telegram`, an offer at the
  end of an interactive `minions init`), hidden prompt or `--stdin`. Format `^\d{6,12}:[A-Za-z0-9_-]{30,64}$`
  is checked before the value reaches any store, environment, or `security -i` line.
  `--verify` (wizard: explicit consent) calls the Bot API `getMe`.
- **Storage.** Keychain service `minions.telegram`, or `<host data root>/credentials/<projectId>/telegram-bot-token`.
  `credentials.json` records `{backend, ref, botId, updatedAt}`; the numeric bot id is not secret and
  detects one bot provisioned for two projects (warning at provisioning and in doctor).
- **Mount.** `projects/<id>/secrets/telegram-bot-token` → `/opt/minions/secrets/telegram-bot-token` (ro).
  Only `minions coordinator run` reads it, and passes it to the coordinator's `claude` process as
  `TELEGRAM_BOT_TOKEN`. A token change applied to a running container triggers a controlled restart.

## Repository layout

```
package.json  tsconfig.json  esbuild.config.mjs  vitest.config.ts  install.sh
src/
  cli.ts                     commander root; imports register() from each area
  core/errors.ts             MinionsError + codes + exit codes
  core/exec.ts               run() — spawn with shell:false, timeout, stdin input
  core/fsutil.ts             atomicWrite, sha256, readJson, ensureDir
  core/paths.ts              host + container path helpers
  core/output.ts             emit(result, {json}) and redact()
  config/schema.ts           zod schema for MinionsConfig + JSON Schema export
  config/profiles.ts         profile -> explicit config values
  config/capabilities.ts     capability names, rule eval (allow/ask/deny, roles, paths)
  config/resolve.ts          layering + provenance -> EffectiveConfig
  backlog/types.ts           Task model + BacklogAdapter interface
  backlog/backlogmd.ts       Backlog.md CLI adapter
  backlog/ready.ts           readiness filter + dependency cycle detection
  backlog/commands.ts        register(program) for `backlog ...`
  runtime/db.ts              node:sqlite schema + migrations
  runtime/scheduler.ts       claim / record / release, capacity, leases
  runtime/results.ts         zod WorkerResult + validation
  runtime/worktree.ts        branch/worktree creation, head lookup
  runtime/hooks.ts           stop guard + pre-agent guard
  runtime/coordinator.ts     tmux + claude launch inside container
  runtime/commands.ts        register(program) for runtime commands
  plugin/generate.ts         render templates/plugin -> plugin dir, returns file hashes
  host/registry.ts           gitCommonDir -> projectId registry, copied-id detection
  host/discovery.ts          read-only repo inspection
  host/wizard.ts             questions with prefilled defaults
  host/install.ts            plan / apply / manifest / rollback / journal
  host/docker.ts             compose file generation + lifecycle (docker compose ...)
  host/transfer.ts           import (bundle in) / export (bundle out)
  host/doctor.ts             checks
  host/uninstall.ts
  host/commands.ts           register(program) for host commands
templates/plugin/            plugin sources (see "Plugin")
docker/Dockerfile  docker/entrypoint.sh
test/                        vitest unit tests; test/docker/ opt-in (MINIONS_DOCKER_TESTS=1)
```

`minions` decides its mode by `MINIONS_RUNTIME`: unset = host CLI, `container` (set in the image),
`host` (host runtime, set by the shim; see "Host runtime"). Host-only commands error with
`INCOMPATIBLE_RUNTIME` inside a runtime and vice versa, except `status`/`pause`/`resume`, which on the
host delegate to the project's runtime: `docker compose exec -T app minions <cmd> --json`, or the
host runtime shim.

## Core contracts

```ts
// core/errors.ts
export type ErrorCode =
  | 'AUTH_REQUIRED' | 'CONFLICT' | 'POLICY_DENIED' | 'INVALID_CONFIG'
  | 'INCOMPATIBLE_RUNTIME' | 'NETWORK_RETRYABLE' | 'NOT_FOUND'
  | 'DOCKER_UNAVAILABLE' | 'CAPACITY' | 'PRECONDITION' | 'INTERNAL';
export const EXIT_CODES: Record<ErrorCode, number> = {
  INVALID_CONFIG: 2, POLICY_DENIED: 3, CONFLICT: 4, AUTH_REQUIRED: 5,
  INCOMPATIBLE_RUNTIME: 6, NETWORK_RETRYABLE: 7, NOT_FOUND: 8,
  DOCKER_UNAVAILABLE: 9, CAPACITY: 10, PRECONDITION: 11, INTERNAL: 1 };
export class MinionsError extends Error { constructor(public code: ErrorCode, message: string, public hint?: string, public details?: unknown) }

// core/exec.ts
export interface RunOptions { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; allowFailure?: boolean }
export interface RunResult { code: number; stdout: string; stderr: string }
export function run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>
// throws MinionsError('INTERNAL') on non-zero unless allowFailure; never uses a shell.

// core/output.ts
export function emit(data: unknown, opts: { json: boolean; human?: (d: any) => string }): void
// JSON mode: {"ok":true,"data":...} on stdout. Errors: {"ok":false,"error":{code,message,hint}} and exit EXIT_CODES[code].
export function redact(text: string): string // masks sk-ant-*, ghp_*, github_pat_*, gh[ousr]_*, Bearer tokens, bot tokens
```

### Paths

Host (`MINIONS_HOME` overrides the root, used by tests):
```
~/Library/Application Support/Minions/
  registry.json                      { version:1, projects: { [projectId]: { gitCommonDir, repoPath, visibility } } }
  projects/<projectId>/
    project.json                     host-control: container resources, ports, image tag, git identity, remote URL, base branch
    config.json                      private config (private installs) — full explicit config
    config.local.json                private overrides (optional, both visibilities)
    manifest.json                    { version, packageVersion, files: [{path, sha256, owner:'minions'}] }  (paths absolute)
    journal.json                     in-progress install steps for recovery
    compose.yaml                     generated
    runtime/config.json              effective config written at start, mounted ro
    runtime/coordinator.md           (inside plugin dir actually — see Plugin)
    plugin/                          generated plugin, mounted ro
    exports/                         bundles exported from the container
```
Shared installs additionally write `<repo>/.minions/config.json` (+ `<repo>/.minions/README.md`)
and the host copies the resolved effective config to `runtime/config.json`.

Container:
```
/opt/minions/plugin   ro   generated plugin (contains coordinator.md)
/opt/minions/config   ro   runtime/config.json (+ project.json)
/workspace            vol  repo/ (main clone), worktrees/<slug>/, review/<slug>/
/state                vol  minions.db, backlog/ (Backlog.md project root), notes/, import/, exports/
/home/node/.claude    vol  Claude state (CLAUDE_CONFIG_DIR)
/home/node/.cache     vol  npm and tool caches
/home/node, /tmp      tmpfs
```
Volume names: `minions-<first 8 chars of projectId>-{workspace,state,claude,cache}`.
Compose project name: `minions-<first 8 chars of projectId>`. Service name: `app`.

## Configuration

`MinionsConfig` follows spec §6 example fields exactly (schemaVersion, configRevision, projectId,
packageVersion, profile, visibility, backlog, intake, container, execution, models, delivery,
verification, communication, budgets) plus:

```ts
capabilities: Record<Capability, CapabilityRule>
// Capability = the 21 names from spec §5
// CapabilityRule = Effect | { effect: Effect; rules?: { effect: Effect; roles?: Role[]; paths?: string[] }[] }
// Effect = 'allow' | 'ask' | 'deny'; Role = 'coordinator'|'engineer'|'tester'|'reviewer'
sensitivePaths: string[]   // spec §14 defaults
architecture: 'decide' | 'propose'
git: { baseBranch: string; identity: { name: string; email: string } }
permissionMode: 'default' | 'acceptEdits' | 'auto'   // coordinator session; never bypass
```
Schema is `.strict()` everywhere (unknown fields fail). Cross-field checks: `delivery.mode` must be
supported by this build; `delivery.merge==='auto-when-eligible'` requires `requiredChecksConfigured`
to be true **or** reports merge as unavailable (never treats false as zero checks);
`maxEngineers <= maxActiveTasks`; `models.default ∈ models.allowed`; `container.mountDockerSocket`
and `mountHostRepository` must be `false`.

Layering: package defaults < project config (`.minions/config.json` or private `config.json`) <
`config.local.json` < session overrides (in-memory only, may only narrow). Deny can't be removed
by a later layer below project config. Arrays replace. `resolve()` returns
`{ config, provenance: Record<dottedPath, 'default'|'project'|'local'|'session'> }`.

Evaluation: `can(config, capability, {role, paths})` → `'allow'|'ask'|'deny'`; deny wins; any path
matching `sensitivePaths` upgrades allow→ask for `git.push`, `pr.create`, `pr.merge`.

## Backlog

```ts
// backlog/types.ts
export type TaskStatus = 'idea'|'ready'|'implementing'|'testing'|'reviewing'|'changes-requested'
  |'awaiting-human'|'awaiting-ci'|'merging'|'done'|'delivered'|'blocked'|'cancelled';
export type Provenance = 'external-requirement'|'user-decision'|'agent-hypothesis'|'observed-result';
export interface Task {
  id: string;               // stable internal id, e.g. "task-12" (Backlog.md id normalized lowercase)
  locator: string;          // backend locator, e.g. "backlogmd:task-12"
  title: string; description: string;
  acceptanceCriteria: { text: string; done: boolean }[];
  status: TaskStatus; priority: 'high'|'medium'|'low'|null;
  dependencies: string[]; parent: string | null; externalLinks: string[];
  labels: string[]; authorized: boolean;   // label 'minions:authorized' or profile allows startReady
  branch: string | null; commits: string[]; prUrl: string | null;
  provenance: Provenance; version: string; // content hash for conflict checks
}
export interface CreateTaskInput { title: string; description?: string; acceptanceCriteria?: string[]; priority?: Task['priority'];
  dependencies?: string[]; parent?: string; labels?: string[]; status?: TaskStatus; provenance?: Provenance; idempotencyKey: string }
export interface BacklogAdapter {
  capabilities(): Promise<{ backend: string; version: string; supports: string[] }>;
  listTasks(): Promise<Task[]>;
  listReady(limit: number, leasedIds: Set<string>, scope: ScopeFilter): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(input: CreateTaskInput): Promise<{ task: Task; created: boolean }>; // idempotent by key
  updateTask(id: string, expectedVersion: string, patch: Partial<Pick<Task,'status'|'title'|'description'|'priority'|'labels'|'branch'>>): Promise<Task>; // CONFLICT on version mismatch
  addDependency(id: string, dependsOn: string): Promise<Task>;  // rejects cycles with explanation
  addNote(id: string, text: string): Promise<void>;
  closeTask(id: string, status: 'done'|'delivered'|'cancelled'): Promise<Task>;
  exportTasks(): Promise<Task[]>;
}
```
Idempotency keys are stored in the runtime DB table `idempotency(key, task_id)`, not in the
backlog. Minions-specific fields Backlog.md lacks (branch, provenance, external links, idempotency)
go in a marked block inside the task description:
`<!-- minions:meta {json} -->` — preserved verbatim around other content.
Backlog.md statuses are configured by writing `/state/backlog/backlog/config.yml` directly (no
`backlog init`), with `done` as the **last** entry (Backlog.md hard-codes the last status as
"complete") and `filesystem_only: true`. The adapter computes readiness itself and never relies on
Backlog.md `--ready`. See [backlogmd-cli.md](backlogmd-cli.md) for the verified CLI surface.
`listReady` excludes non-`ready`, unauthorized, out-of-scope, paused, leased, and tasks whose
dependencies are not `done`/`delivered`; a dependency lookup failure excludes the task.

## Runtime state (SQLite, `/state/minions.db`)

Tables: `meta(key,value)`, `controls(key,value)` (paused_intake, paused_starts),
`leases(id, task_id, role, attempt, holder, worktree, branch, base_sha, head_sha, config_revision,
started_at, ended_at, status, result_json, result_valid)`, `evidence(task_id, head_sha, kind,
config_revision, outcome, details_json, recorded_at)`, `idempotency(key, task_id)`,
`guard(id=1, fingerprint, count, last_reason, updated_at)`, `events(id, at, kind, task_id, data_json)`,
`repairs(task_id, cycles)`.

Scheduler rules:
- `work claim <taskId> --role engineer|tester|reviewer --json`: transaction; fails `CONFLICT` if any
  active lease exists for the task (one active stage per task), `CAPACITY` if active task count ≥
  `maxActiveTasks` (new task) or active engineers ≥ `maxEngineers`, `POLICY_DENIED` if
  `task.start` is deny or paused_starts, `PRECONDITION` if status doesn't fit role
  (engineer: ready|changes-requested; tester: testing; reviewer: reviewing).
  Engineer: creates/reuses branch `agent/<slug>` + worktree `/workspace/worktrees/<slug>` from base.
  Reviewer: detached worktree `/workspace/review/<slug>` at the branch head.
  Returns the task brief (JSON) incl. `briefMarker: "minions-lease: <leaseId>"`.
  Moves backlog status: engineer→implementing.
- `work record <leaseId> --result-file <path>|stdin`: validates WorkerResult (zod). Invalid →
  store `result_valid=0`, one correction allowed (`--correction`), never advances to approval.
  Valid: checks `headSha` equals actual branch head (else invalid "stale head").
  Transitions: engineer complete→testing; tester complete→reviewing, needs_changes→changes-requested;
  reviewer complete(approve)→delivered (local mode) — requires tester evidence for the same head
  when `testerRequired`; in branch/pull-request mode the approval starts publication instead and the
  final status comes from it (see "Branch and pull-request delivery"); needs_changes→changes-requested (repairs++); blocked→blocked;
  needs_split→awaiting-human with `needsSplit` flag for the coordinator; partial→ unchanged with note.
  When repairs ≥ `maxRepairCyclesBeforeReplan`, response includes `replan: true` and status →
  awaiting-human. Records evidence keyed by head SHA + config revision. Releases the lease.
- `work release <leaseId> --reason` releases without a result (worktree kept).
- New commits invalidate evidence: evidence lookups always filter by current head SHA.

WorkerResult schema (spec §11): `{ status, summary, branch, headSha, modifiedPaths[], checks[{command,
outcome:'pass'|'fail'|'skipped', details?}], acceptanceEvidence[{criterion, evidence}], findings[],
nextAction, verdict?: 'approve'|'request-changes' (reviewer only), usage?: {...} }`.

Hooks:
- `hook stop` (Stop event, reads stdin JSON): allow stop (exit 0, no output) if paused, if DB or
  backlog query fails, if any `background_tasks` subagent is running, if no ready tasks, or if no
  capacity. Otherwise compute fingerprint = hash(ready ids, active leases, last event id). If the
  fingerprint equals the stored one and count ≥ 2 → allow stop and record
  `last_reason='no-progress'`. Else increment/reset count and print
  `{"decision":"block","reason":"<bounded instruction: N ready tasks, capacity M; run /minions:orchestrate to dispatch the next one>"}`.
- `hook pre-agent` (PreToolUse, matcher `Agent`): if `tool_input.subagent_type` is
  `minions:engineer|tester|reviewer`, require `minions-lease: <id>` in `tool_input.prompt` naming an
  active lease for that role; otherwise deny via `hookSpecificOutput.permissionDecision: "deny"`.
  Other agent types pass through.

## Plugin (`templates/plugin` → `projects/<id>/plugin`)

```
.claude-plugin/plugin.json   { "name": "minions", "version": <pkg>, "description": ... }
agents/engineer.md  agents/tester.md  agents/reviewer.md
skills/{orchestrate,status,intake,recover,maintain-context}/SKILL.md
hooks/hooks.json             Stop -> minions hook stop ; PreToolUse(Agent) -> minions hook pre-agent (exec form)
coordinator.md               appended to the coordinator system prompt
```
Templates use `{{var}}` placeholders rendered from EffectiveConfig (profile, policy summary, limits,
models, delivery mode, capability table, sensitive paths). Agent frontmatter uses only documented
fields: `name, description, tools, disallowedTools, model, maxTurns, effort`. Workers get no
`Agent` tool. Reviewer tools: Read, Grep, Glob, Bash. `generatePlugin(cfg, outDir)` returns
`{ path, sha256 }[]`.

## Container

- Image `minions-runtime:<pkgVersion>` built from the installed package root with `docker/Dockerfile`
  (context contains `dist/`, `templates/`, `docker/`, `package.json`). Built natively per arch.
- Compose service `app`: `user: "1000:1000"`, `read_only: true`, `cap_drop: [ALL]`,
  `security_opt: [no-new-privileges:true]`, `cpus`, `mem_limit`, `pids_limit` from config, tmpfs for
  `/tmp` and `/home/node`, named volumes above, ro bind mounts for plugin and config only, no `ports`
  unless configured (always `127.0.0.1:<host>:<container>`), `init: true`,
  command `sleep infinity` (the coordinator is launched via `docker compose exec`).
- `minions start`: compose up -d (build if image missing) → ensure workspace imported → `docker compose
  exec -it app minions coordinator` which runs `tmux new-session -A -s coordinator claude
  --plugin-dir /opt/minions/plugin --append-system-prompt <coordinator.md> --permission-mode <mode>
  --settings <allowlist json>` with cwd `/workspace/repo`.

## Cross-module seams (phase 2)

Stub files pin these signatures; the owning worker implements them, others import them:
- `src/backlog/factory.ts` (backlog worker): `openBacklog(cfg, { idempotency: IdempotencyStore, root? }): BacklogAdapter`.
- `src/plugin/generate.ts` (plugin worker): `generatePlugin(cfg, outDir): Promise<{path, sha256}[]>`.
- `src/host/delegate.ts` (host worker): `delegateToContainer(args, {json, cwd?}): Promise<number>`.

Runtime-side workspace commands (runtime worker owns; host transfer calls them through `docker compose exec`):
- `minions workspace setup --json`: idempotent; creates `/state/{backlog,notes,import,exports}`, the DB,
  and `/state/backlog/backlog/config.yml` (statuses, `done` last, `filesystem_only: true`).
- `minions workspace import <bundlePath> --base <branch> [--remote-url <url>] --json`: clones
  `/workspace/repo` from the bundle if absent, else fetches into `refs/remotes/host/*` (never
  rewrites local branches; the base branch is fast-forwarded only when it has not diverged); sets `user.name`/`user.email` from `config.git.identity`; records origin URL
  as remote `origin` without fetching. Returns `{ head, base, imported: boolean }`.
- `minions workspace export <outPath> --json`: writes a bundle with `agent/*` branches and the base
  branch; returns `{ path, refs: string[] }`. Host fetches it into `refs/remotes/minions/*` only.

Command ownership: `status`, `pause`, `resume` are registered once in `runtime/commands.ts`; in host mode
they call `delegateToContainer`. Host-only commands live in `host/commands.ts`, `backlog ...` in
`backlog/commands.ts`, everything else runtime-side in `runtime/commands.ts`.
Workers must not edit `package.json`, `src/core/**`, `src/config/**`, or each other's files; report
needed changes instead. Tests go in `test/<area>/`.
