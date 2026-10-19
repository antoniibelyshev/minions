# Bootstrap build (v0.1) — design contract

This is the working contract for the first installable version. It narrows
[docs/spec.md](../spec.md) to the smallest complete terminal workflow (spec §25)
so minions can then develop itself. Anything listed under "Deferred" must be
reported as unavailable by `doctor` and the wizard, never faked.

## Scope

In:
- Host CLI: `init [path]`, `doctor`, `start`, `down`, `status`, `pause`, `resume`,
  `import`, `export`, `config show`, `uninstall`. All support `--json`; mutating ones `--dry-run`.
- Runtime CLI (inside container): `backlog ready|list|show|create|update|note`,
  `work claim|record|release|list`, `hook stop|pre-agent`, `coordinator`, `status`, `pause`, `resume`.
- Profiles `project-owner`, `personal-work`, `supervised`; shared + private visibility.
- Backlog.md backend only. Delivery mode `local` only (commits on `agent/<slug>` branches in the container clone, fetched to host with `minions export`).
- Terminal communication only.
- One Docker container per project, security baseline from spec §3A.
- Claude auth inside the container (interactive `/login`, persisted in the claude volume).

Deferred (report as unavailable): GitHub Issues backend, branch/PR/auto-merge delivery,
review publication, Telegram, config plan/apply transactions, backlog migration, upgrade,
budgets, companion containers, GitHub credential provisioning.

## Recorded low-impact decisions

- Node >= 22.13 (built-in `node:sqlite`, unflagged). ESM, TypeScript, bundled with esbuild into `dist/cli.js` so the package has **no runtime dependencies** and the image needs only Node.
- Runtime deps bundled: `commander` (parser), `zod` (validation). Dev: `typescript`, `esbuild`, `vitest`, `@types/node`.
- Interactive prompts use `node:readline/promises`; no prompt library.
- Plugin name `minions`; agents `engineer`, `tester`, `reviewer` resolve as `minions:engineer` etc. Skills `orchestrate`, `status`, `intake`, `recover`, `maintain-context` resolve as `/minions:<name>`.
- Backlog.md project lives in `/state/backlog` for **both** visibilities in v0.1 (single writer, never on implementation branches). Versioning a shared backlog in Git is deferred.
- Container reads effective config from a read-only mount; it cannot change config in v0.1.
- Workspace is seeded from a Git bundle of the host repo's committed HEAD branch (`minions import`), so no GitHub credentials are needed. The real `origin` URL is recorded but unused until PR delivery exists.
- Commits inside the container use the host's `git config user.name/email` (copied as plain values at init, shown in the plan).
- Coordinator permission mode defaults to `acceptEdits` with an allowlist for `minions`, `git`, and `backlog` commands. Never `bypassPermissions`.
- Pinned in image: base `node:22-bookworm-slim` (digest pinned in Dockerfile), `@anthropic-ai/claude-code@2.1.292`, `backlog.md@1.54.0`. Tested range documented in `docs/compatibility.md`.
- No `--append-system-prompt-file` exists in Claude Code 2.1.292; the launcher reads the coordinator prompt file and passes it with `--append-system-prompt` as an argv element (no shell).

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

`minions` decides host vs container mode by `MINIONS_RUNTIME=container` (set in the image).
Host-only commands error with `INCOMPATIBLE_RUNTIME` inside the container and vice versa,
except `status`/`pause`/`resume`, which on the host delegate to the container with
`docker compose exec -T app minions <cmd> --json`.

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
  when `testerRequired`; needs_changes→changes-requested (repairs++); blocked→blocked;
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
  rewrites local branches); sets `user.name`/`user.email` from `config.git.identity`; records origin URL
  as remote `origin` without fetching. Returns `{ head, base, imported: boolean }`.
- `minions workspace export <outPath> --json`: writes a bundle with `agent/*` branches and the base
  branch; returns `{ path, refs: string[] }`. Host fetches it into `refs/remotes/minions/*` only.

Command ownership: `status`, `pause`, `resume` are registered once in `runtime/commands.ts`; in host mode
they call `delegateToContainer`. Host-only commands live in `host/commands.ts`, `backlog ...` in
`backlog/commands.ts`, everything else runtime-side in `runtime/commands.ts`.
Workers must not edit `package.json`, `src/core/**`, `src/config/**`, or each other's files; report
needed changes instead. Tests go in `test/<area>/`.
