# Agent runtime adapters (Codex CLI, JetBrains Junie)

Status: design (task-14.1). No harness integration code exists yet; implementation is split into the child tasks at
the end. Parent: task-14 (non-Claude harnesses). Builds on task-9 (`minions work brief|submit`) and task-33 (role
registry, contract variants, workflows; [roles-and-workflows.md](roles-and-workflows.md)).

Ground truth this design starts from (main @ ca8cf9c):

- Workers are Claude Code subagents. The coordinator (one `claude` process in tmux, `src/runtime/coordinator.ts`)
  spawns `minions:<role>` through its Agent tool. The plugin (`src/plugin/generate.ts`, `templates/plugin/agents/*`)
  defines each role's tools, model, effort and `maxTurns`.
- The lease gate is a Claude Code hook: `preAgentHook` (`src/runtime/hooks.ts`) allows `minions:<role>` only with an
  active lease of that role named in the prompt (`minions-lease: <id>`). The drain hook limits tools during an
  upgrade. `preTelegramHook` denies Telegram tools to any subagent. The coordinator's `--settings` deny `git push` and
  `gh pr merge` and turn on the OS sandbox in the host runtime.
- The worker fetches its brief with `minions work brief <lease> --role <r>` and stores its result with
  `minions work submit`, both from inside the lease worktree (`src/runtime/handoff.ts`). The coordinator records it
  with `minions work record <lease> --submitted`.
- Record-time checks do not depend on the harness. `validateResult` checks by contract variant. The branch head
  must match. A gate's head is pinned, a verifier only adds commits on top, and `edits.paths` is checked against the
  claim-to-result diff. Publication requires host-signed approvals (`src/core/approval.ts`).
- Credentials are entered on the host, kept in the host credential store (`src/host/credentials.ts`) and written
  into `projects/<id>/secrets/`. That directory is bind-mounted read-only at `/opt/minions/secrets`
  (`src/host/docker.ts`). The container runs as uid 1000, read-only rootfs, `cap_drop: ALL`,
  `no-new-privileges`, Docker's default seccomp profile, no Docker socket.
- Task-51: the Telegram channel plugin is enabled only for the coordinator's own launch. Workers must never start
  another `claude` session, because it would load the plugin and take the bot's update stream.

Capability probe run inside the minions container while writing this (Docker Desktop, linuxkit kernel 7.0.14,
aarch64, 2026-10-23):

- `unshare --user --map-root-user true` fails with `Operation not permitted`, so unprivileged user namespaces are
  unavailable.
- `NoNewPrivs: 1`, `Seccomp: 2`, `CapEff: 0`.
- `syscall(landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` returns **8**, so Landlock is
  available to an unprivileged process (ABI 8).
- `setpriv` is util-linux 2.38.1 and has no Landlock support. There is no C compiler in the image.

This is one host type. Linux Docker Engine hosts may differ (kernel config, seccomp profile), so the runtime has to
probe at start (D7).

## Decisions

### D1. Two launch kinds behind one interface

A harness is either **in-session** (the coordinator's own tool spawns it: Claude Code's Agent tool) or **process**
(a separate OS process that minions starts, supervises and isolates). Codex CLI and Junie are process harnesses.
Every process harness goes through one harness-independent runner, so the lease, permission and isolation logic
exists once. Adapters only translate.

```ts
// Design sketch (not code yet). src/runtime/harness/types.ts
export type HarnessId = 'claude' | 'codex' | 'junie' | 'fake';

export interface HarnessCapabilities {
  launch: 'in-session' | 'process';
  nativeSandbox: 'none' | 'bwrap' | 'srt' | 'seatbelt';        // what the harness would use on its own
  structuredFinalOutput: boolean;                              // e.g. codex --output-schema
  usageEvents: 'jsonl' | 'session-file' | 'notification' | 'none';
  maxSteps: boolean;                                           // a documented per-run step/turn limit
  effort: boolean;
}

export interface LaunchInput {
  lease: { id: string; taskId: string; role: string; attempt: number };
  role: { name: string; contract: 'producer' | 'verifier' | 'gate'; worktree: 'branch' | 'review'; edits: 'none' | 'any' | { paths: string[] }; commits: boolean };
  worktree: string;              // absolute; the process cwd
  gitCommonDir: string;          // absolute; resolved by the runner, never by the worker
  scratchDir: string;            // per-lease, removed when the lease ends
  harnessHome: string;           // per-lease harness state dir under scratchDir (CODEX_HOME / JUNIE_HOME)
  instructions: string;          // role prompt + worker-common + result contract (rendered by the generator)
  briefFile: string;             // the brief JSON the runner fetched (D3)
  resultFile: string;            // where the worker writes its WorkerResult (D3)
  model: string | null;          // harness-native model id or alias, validated against harnesses.<id>.models
  effort: string | null;
  maxSteps: number;              // execution.attemptMaxTurns or roles.<r>.maxTurns
  credential: { kind: string; file: string } | null;   // path in /opt/minions/secrets; the value is read by the runner
}

export interface LaunchPlan {
  argv: string[];                          // never contains a secret (tested)
  env: Record<string, string>;             // built from an allowlist; secrets only as named entries the runner fills in
  secretEnv: Record<string, string>;       // env name -> credential kind (filled from the mounted file at spawn)
  files: { path: string; content: string; mode: number }[];   // e.g. per-lease harness config under harnessHome
  stdin: string | null;                    // prompt via stdin where supported (keeps argv short and out of `ps`)
}

export interface AgentRuntime {
  readonly id: HarnessId;
  capabilities(): HarnessCapabilities;
  /** No credentials, no network: binary present, version, pinned version matches. Used by status --check. */
  probe(run: Runner): Promise<{ ok: boolean; version: string | null; detail: string }>;
  /** Pure: lease + role + config -> how to start the process. Unit-tested without the harness installed. */
  plan(input: LaunchInput): LaunchPlan;
  /** Optional: one stdout/stderr line or session-file record -> event (usage, progress). */
  parseEvent?(line: string): { usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } } | null;
  /** Final usage after exit (from collected events or the harness session file). */
  finalUsage(collected: unknown[], harnessHome: string): Promise<{ tokens: number; detail: Record<string, number> } | null>;
}
```

The Claude adapter implements only `capabilities` and `probe` (`launch: 'in-session'`). Its plan is the generated
agent definition plus the Agent-tool call the coordinator already makes. No runner is involved (D2).

### D2. Claude Code mapping (current behaviour, unchanged)

| Concern | Claude Code today |
| - | - |
| Launch | Coordinator: `minions work next` → `work claim` → Agent tool `subagent_type: minions:<role>[-deep]`, prompt with `minions-lease: <id>` and `worktree:` lines. |
| Lease gate | `preAgentHook`: registered role, active lease of that role named in the prompt, model is an Agent alias; fails closed. |
| Brief / result | Worker runs `minions work brief` / `minions work submit` from its worktree; `handoff.ts` checks lease, role and cwd. Coordinator runs `work record --submitted`. |
| Role permissions | Agent frontmatter `tools` / `disallowedTools` (`Agent`, `SendMessage`, MCP tools always removed; edit tools removed for `edits: none` and review worktrees); coordinator `--settings` allow/deny inherited (no `git push`, no `gh pr merge`); host runtime adds the OS sandbox. Authoritative: the record-time checks. |
| Model / effort | `models.default`, `roles.<r>.model`, stage hint → `agentModel` (alias) in the Agent call; effort in frontmatter. |
| Timeouts / cancel | `maxTurns` in frontmatter; the coordinator stops an agent, `work release` ends the lease. No wall-clock limit. |
| Usage | Task notification `subagent_tokens` → `work record|release --usage` (task-32 tally). |
| Drain | Drain hook: grace calls, then commit `wip:` and submit `partial`. |
| Telegram | `preTelegramHook` denies subagents; plugin enabled only in the coordinator's launch (task-51). |

The adapter interface keeps all of this. `harnesses.default: "claude"` (the default) makes zero behaviour change.

### D3. The process runner: `minions work run <leaseId>`

A new **internal** subcommand under the existing `work` command. There is no new top-level command, it is not
listed in the primary help, and it is covered by `test/cli-surface.test.ts` like every `work` subcommand. The
coordinator calls it where it would call the Agent tool:

```
minions work claim <taskId> --json            # unchanged; brief now carries `harness`
minions work run <leaseId> --json             # coordinator Bash, run_in_background; exits when the worker ends
minions work record <leaseId> --submitted     # unchanged
```

The runner is harness-independent and does this, in order:

1. **Launch gate (replaces `preAgentHook`).** The lease must be active. Its role must resolve to a process harness
   in the runtime config, and that harness must be allowed for the role's contract in the current phase (D9).
   Refused (`POLICY_DENIED`) in these cases:
   - when `MINIONS_WORKER_LEASE` is set (a worker cannot start workers);
   - when the cwd is inside any lease worktree (a Claude subagent's Bash runs there);
   - when another runner holds the lease's lock (`/state/run/leases/<id>.lock`, pid plus start time; one process
     per lease);
   - while a drain is pending, or when the budget, pause or role capacity rules would refuse a claim (same checks
     as `claim`).

   Fails closed when the config or DB cannot be read.
2. **Brief by proxy.** The runner calls `fetchBrief` itself (same `handoff.ts` code path; the runner's cwd is the
   worktree, so the ownership check is the one workers get today) and writes it to `<scratch>/brief.json`.
   The worker process **cannot read `/state`** (D4), so the worker does not run `minions work brief`. Its
   instructions say: the brief is in `$MINIONS_BRIEF_FILE` (also inlined in the prompt); write your WorkerResult
   JSON to `$MINIONS_RESULT_FILE`.
3. **Snapshot** of the git state the worker must not change: `git for-each-ref` of the shared repository (all refs,
   with object ids), hashes of `.git/config`, `.git/hooks/**`, `.git/info/**`, `packed-refs` and the worktree's
   `config.worktree`, and the lease head.
4. **Spawn** `adapter.plan(...)` under the isolation wrapper (D4) with these properties:
   - its own process group;
   - an environment built from an allowlist (`PATH`, `HOME=<harnessHome>`, `TMPDIR=<scratch>`, `LANG`, `TERM=dumb`,
     `MINIONS_*` lease variables, the harness's own variables). No inherited `CLAUDE_*`, `ANTHROPIC_*`, `GH_TOKEN`
     or Telegram variables;
   - secrets read from the mounted file by the runner and passed only in the env entries the plan names. A secret is
     never put in argv: Junie documents `--auth=<key>` for CI, and the adapter must use `JUNIE_API_KEY` instead.
5. **Supervise.**
   - Wall-clock limit: `harnesses.<id>.timeoutMinutes`, default 60.
   - Step limit: passed to the harness when it has one (Junie `--max-steps`).
   - Cancel: the runner polls the lease every 5 s. A lease that is no longer active (`work release`, recovery)
     means SIGTERM to the process group, then SIGKILL after 15 s.
   - Drain: when the drain marker appears, the runner allows a fixed grace of 120 s (a new optional
     `harnesses.<id>.drainGraceSeconds` if owners need it) and then stops the process.
   - Usage: events are collected from stdout (D6).
6. **Verify** (authoritative, harness-independent, before anything is submitted):
   - every ref outside the lease branch is unchanged, and the lease branch was only fast-forwarded from the claim
     head (for a gate it is unchanged);
   - the hashed git control files are unchanged;
   - for `edits: none` / review worktrees, `git status --porcelain` is empty and the head is unchanged.

   A violation restores the refs and control files from the snapshot (the runner wrote them, so it can) and logs a
   `harness-violation` event. The result becomes an invalid submission whose `findings` name the violation. The
   existing single-correction rule does not apply: a violation is terminal for the attempt, and the coordinator
   sees it in `work record`.
7. **Submit by proxy.** The runner reads `$MINIONS_RESULT_FILE` or, when it is missing, the harness's final message
   when that parses as a WorkerResult (Codex `--output-schema` makes this reliable).
   - Drain or timeout with commits allowed: the runner makes a `wip:` commit of the worktree (author
     `minions-runner`, only paths inside `edits`) and synthesizes a `partial` result.
   - No result at all: it synthesizes `blocked` with the exit status and the last 2 KB of stderr (redacted).

   It then calls `submitResult` (the `minions work submit` code path) with cwd = worktree and records usage with the
   task-32 `usage` event (harness-tagged). Then it exits. It prints one JSON line for the coordinator:
   `{leaseId, exit, submitted, status, violations[], usage}`.

The worker-facing contract is otherwise identical to Claude workers (same role prompt, same WorkerResult schema, same
`resultContract` text per variant). The difference is that the runner, not the worker, talks to `minions work
brief|submit`. Both commands keep their existing checks.

### D4. Lease and permission gates without Claude hooks

Hooks inside a non-Claude harness can't be the gate. Both harnesses now have hooks, but:

- Codex documents that a `PreToolUse` hook error, timeout or malformed response continues the tool call. It also says
  to "treat tool hooks as a useful guardrail, not a complete enforcement boundary" [C-hooks].
- Junie's hooks are EAP-only. A non-zero exit other than 2 lets the tool proceed [J-hooks].

So enforcement is layered and **every layer that matters sits outside the harness process**:

| Layer | Mechanism | Enforces | Bypassable by the worker? |
| - | - | - | - |
| L0 Launch | `work run` gate (D3.1) | only claimed leases run; one process per lease; no worker spawns workers; drain / budget / pause | No (runs before the worker exists) |
| L1 Isolation | `minions-sandbox` exec wrapper: Landlock filesystem rules + ABI 6 scoping + a seccomp filter (below) | no read/write of `/state`, `/opt/minions/secrets`, `~/.claude`, other worktrees, the tmux socket dir; writes only where the role may write; no signals/ptrace to processes outside the sandbox; no unix-socket connects | No (kernel-enforced, irreversible after `landlock_restrict_self`, inherited by every child) |
| L2 Harness config | sandbox / approval flags, MCP off, repo-provided config off, no Telegram or Agent-like tools | least surprise; fewer prompts and hangs | Yes, partly (advisory) |
| L3 Git UX | a minions `pre-commit` hook passed via `GIT_CONFIG_*` env (edit-scope and sensitive-path warnings) | early feedback only | Yes (`--no-verify`, env) |
| L4 Record | D3.6 verification + existing record checks (contract, head rules, `edits.paths`, CI evidence by contract, host-signed publication) | the actual gates | No (runs outside, after exit) |

**L1, the isolation wrapper.** Inside the hardened container the harnesses' own sandboxes are expected not to work.
Both build on bubblewrap with user namespaces: Codex on Linux, and Junie's `srt` [C-sandbox], [J-cli]. The probe
above shows that user namespaces are denied. Codex's docs give the remedy for this case: let the container be the
boundary and run `--sandbox danger-full-access` inside it [C-security]. Our container is shared with the
coordinator, the state DB and the secrets mount, so "the container is the boundary" is not enough on its own. The
wrapper adds an unprivileged, per-process boundary that the probe shows is available:

- **Landlock** (ABI ≥ 1, using newer rights when present). It is an allowlist:
  - read and execute: `/usr`, `/lib*`, `/bin`, `/etc`, `/opt/<harness>`, the Node toolchain;
  - read: the lease worktree, the shared git dir;
  - read and write:
    - `<scratch>`, `<harnessHome>` and a per-lease npm cache;
    - for producers and verifiers, also the worktree and `.git/{objects,refs,logs}`, `.git/worktrees/<name>`.

  Reads of everything not listed are denied: `/state`, `/opt/minions/secrets`, `/home/node/.claude`,
  `/workspace/repo` (the main checkout), other worktrees, `/tmp` outside scratch. Writes outside the read-write list
  are denied, including `.git/config`, `.git/hooks`, `.git/info` and `packed-refs` (git still reads them). A reviewer gets the worktree and
  git dir read-only. This is the per-process form of the "read-only mount for reviewers" constraint, which
  container mounts cannot provide per lease (mounts are fixed at container creation). Landlock also blocks ptrace
  and `PTRACE_MODE_READ` access to processes outside the domain, which covers `/proc/<coordinator>/environ`, where
  the bot token is.
- **Scoping** (ABI ≥ 6): `LANDLOCK_SCOPE_SIGNAL` (the worker cannot signal the coordinator or the runner) and
  `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET`.
- **seccomp** (unprivileged under `no_new_privs`): `socket(AF_UNIX, …)` fails with `EACCES`. Landlock's filesystem
  rights do not cover `connect()` to a pathname socket, and the tmux socket (`/tmp/tmux-1000/…`) would let a
  worker type into the coordinator's TUI. `socketpair` stays allowed, because Node and libuv need it for child
  stdio.
- Network stays as the container's (`outbound-internet` / `none`). Landlock ABI ≥ 4 could restrict TCP ports
  (443 only), and the design leaves room for that as an option.

The wrapper is a small C helper (`/usr/local/bin/minions-sandbox`), built in a builder stage of
`docker/Dockerfile` and pinned like the other binaries. It takes the rules as a JSON file and execs the harness.
Alternatives considered:

- `setpriv` has no Landlock support in 2.38.
- A Perl `syscall()` wrapper works (Perl is in the image) but is fragile.
- Third-party `landrun` would be an extra supply-chain dependency.
- A custom seccomp profile that re-enables user namespaces for bwrap would be an infrastructure change that widens
  the kernel attack surface for every process.
- Sibling worker containers launched by the host would give true read-only mounts, but they need a host-side
  launcher daemon. The container has no Docker socket, by design.

The last two are recorded as later options, not phase 1.

**Fail closed.** `work run` runs the wrapper's self-test once per container start and caches the result in
`/state/run/sandbox-probe.json`. The self-test runs a canary under the generated rules, and every check must fail
from inside:

- write outside the allowed dirs;
- read `/state/minions.db`, `/opt/minions/secrets/*` and `~/.claude`;
- read `/proc/<runner pid>/environ`;
- `kill(runner pid, 0)`;
- connect to a unix socket the runner opened;
- for reviewers, write in the worktree.

If any canary succeeds, or Landlock is unavailable, every process-harness launch is refused with
`PRECONDITION: process isolation unavailable` and `status --check` reports why. There is no opt-out flag in
phase 1.

**What the worker can still do** (accepted, documented risk):

- reach the network (exfiltrate the repository, as a Claude worker can today);
- read its own harness credential (it is in its environment; mitigated by a scoped key and, for Codex, by
  `shell_environment_policy` keeping it out of spawned commands; D5);
- write anything inside its own worktree and branch, which L4 checks.

### D5. Credentials

- New credential kinds next to `github` and `telegram` in `CREDENTIAL_KINDS`:
  - `codex`: an OpenAI API key, file `codex-api-key`;
  - `junie`: a Junie API key, file `junie-api-key`.

  They use the same entry (host prompt or stdin, never argv), the same stores (Keychain, Secret Service, 0600 file),
  the same reference in `credentials.json`, the same copy into `secrets/` and the same removal on `minions down`.
  Commands: `minions auth codex` and `minions auth junie` are subcommands of the existing advanced `auth` command,
  and `minions setup` asks for them (D8).
- In the container, only the runner reads the file (it runs outside L1). It passes the key to the harness via env:
  `CODEX_API_KEY` for `codex exec`, which Codex documents for exactly this use [C-noninteractive], [C-env];
  `JUNIE_API_KEY` for Junie [J-env]. The worker sandbox cannot read the secrets dir.
- For Codex the adapter sets `shell_environment_policy.inherit = "core"` and
  `shell_environment_policy.ignore_default_excludes = false`, so commands Codex spawns do not inherit `*KEY*`,
  `*SECRET*`, `*TOKEN*` variables [C-config].
- **Not in phase 1:** login-based auth.
  - Codex "Sign in with ChatGPT" keeps refreshable tokens in `$CODEX_HOME/auth.json` and has to refresh them in
    place [C-auth], [C-noninteractive]. That needs a writable, persistent, per-project volume the worker can't read.
  - Junie's JetBrains Account login is an interactive browser flow [J-cli].
  - Both would follow the Claude `login` method pattern (state in a dedicated volume, readable only by the runner),
    after a separate review.
- Harness home per lease (`<scratch>/harness-home`): `CODEX_HOME` (must exist [C-env]) and `JUNIE_HOME` [J-env].
  So no state, trust markers, allowlists, sessions or credentials are shared between workers or survive the lease.
  This is also what makes repo-independent, minions-generated config the only config the harness loads.

### D6. Adapter details

**Codex CLI** (`codex exec`). Planned invocation:

```
codex exec --json --ephemeral --ignore-user-config --ignore-rules
  --cd <worktree> --sandbox danger-full-access        # D4: L1 is the boundary; bwrap is unavailable in the container
  --ask-for-approval never                            # no human in the loop; approvals would hang or fail
  --model <id> -c model_reasoning_effort=<effort>
  -c shell_environment_policy.inherit=core -c shell_environment_policy.ignore_default_excludes=false
  -c 'projects."<worktree>".trust_level="untrusted"'  # no repo-provided .codex/ config, hooks or rules
  --output-schema <scratch>/worker-result.schema.json -o <scratch>/last-message.json
  -                                                   # prompt (instructions + brief) on stdin
```

- Reviewers get the same flags. Read-only comes from L1, because Codex's own `read-only` sandbox also needs
  bwrap (unknown U-C2).
- Usage: sum the `usage` object of every `turn.completed` JSONL event [C-noninteractive].
- `--output-schema` gets the WorkerResult JSON schema (generated from `WorkerResultSchema`, like `schema/`).
- Tool restriction: Codex has no per-run tool allowlist comparable to Claude frontmatter. MCP servers come only
  from config, and with `--ignore-user-config` and an empty per-lease `CODEX_HOME` there are none. Web search is
  hosted and not hookable; the adapter leaves `--search` off.

**Junie CLI** (headless). Planned invocation:

```
junie --project <worktree>                          # task via JUNIE_TASK (U-J3: stdin form unverified)
  --output-format json-stream --json-output-file <scratch>/junie.json
  --model <alias|id> --effort <low|medium|high> --max-steps <n> --skip-update-check
  --config-default-locations false --mcp-default-locations false
  --agent-default-location false --command-default-location false
  --system-prompt <role instructions>                 # or JUNIE_SYSTEM_PROMPT (not a secret; env keeps argv short)
  --share-anonymous-statistics false
env: JUNIE_API_KEY, JUNIE_HOME=<harnessHome>, JUNIE_TASK=<brief prompt>
```

- Headless runs are "trusted by design": they load the project's Junie configuration (MCP servers, agents, skills,
  guidelines) without asking [J-headless]. Project hooks are ignored by default [J-config]. The `*-default-locations
  false` flags turn off repo-provided MCP servers, config, agents and commands. Guidelines (`AGENTS.md`) stay on,
  like `CLAUDE.md` for Claude workers.
- Junie's sandbox mode (`--sandbox`, EAP) needs bubblewrap, `socat` and the srt runtime, and it does not isolate
  hooks or MCP [J-cli]. It is not used, because L1 is the boundary.
- An `allowlist.json` in `JUNIE_HOME` with `defaultBehavior: "allow"` keeps approval prompts from blocking a
  headless run (U-J2).
- Usage: from `--output-format json` / the session's `events.jsonl` ("LLM usage data" is stored per session
  [J-cli]). The field layout is unknown (U-J4).

**Fake** (`fake`): a test-only adapter (D10). It is registered only when `MINIONS_TEST_HARNESSES=1`, and config
validation refuses `fake` otherwise.

### D7. Capability probe (no credentials)

`minions status --check` (and `doctor`) gets a `harness.<id>` check for each configured process harness:

- binary on PATH, `--version` matches the pinned version (`codex --version`, `junie --version` [J-params]);
- the L1 self-test (D4) result: `ok` / `fail: <canary that escaped>` / `unavailable: landlock ABI 0`.

It sends no model request and needs no key. An optional, separate `--live` mode later could send one tiny prompt
with the key. Implementing the probe is child task 2, not part of this design task.

### D8. Config shape, schema impact, CLI surface

```jsonc
"harnesses": {
  "default": "claude",                    // harness for every worker role without its own; "claude" | "codex" | "junie"
  "codex": {
    "models": { "default": "gpt-6.1-sol", "allowed": ["gpt-6.1-sol"] },   // harness-native ids; owner-chosen
    "effort": "high",                     // optional
    "timeoutMinutes": 60                  // wall clock per attempt (D3.5)
  },
  "junie": {
    "models": { "default": "sonnet", "allowed": ["sonnet", "opus", "gpt"] },   // Junie aliases [J-models]
    "timeoutMinutes": 60
  }
},
"roles": {
  "engineer": { "harness": "codex", "model": "gpt-6.1-sol" }   // optional per-role override (roles-and-workflows D9 override fields gain `harness`)
}
```

- **Schema.** New optional top-level `harnesses` (strict). `roles.<r>.harness` is optional on built-ins and project
  roles. `roles.<r>.model` and workflow stage `model` hints are validated against the **role's harness**:
  `models.allowed` for `claude` (unchanged), `harnesses.<id>.models.allowed` otherwise. Cross-field checks go in
  `validateConfig`:
  - a referenced harness must have a `harnesses.<id>` block;
  - phase rules (D9) restrict which contracts may use a process harness;
  - `coordinator` can't be assigned a harness;
  - `models.selection: "fixed"` means `harnesses.<id>.models.default` for that harness.

  Existing configs validate unchanged, and without `harnesses` everything is `claude`. The JSON schema in `schema/`
  is regenerated. The harness version pin is **not** project config. It is a build argument of the image (like
  `CLAUDE_CODE_VERSION`), so it lives in `docker/Dockerfile` and the image fingerprint.
- **Brief and `work next`.** The brief gets `harness`. `work next` entries get `harness` and `launch`:
  `{"kind": "agent", "agentType", "agentModel"}` or `{"kind": "run", "command": "minions work run <leaseId> --json"}`
  after claim. The orchestrate skill and `coordinator.md` say: process harness → claim, then run the command with
  Bash `run_in_background`, then record when it exits. `suggestedModel` uses the role harness's tiers. There is no
  tier ranking for non-Claude models, so the role or harness default is used.
- **Policy.** A harness change is a config change on the host, the same as a role change. `.minions/**` is
  sensitive, and the runtime only sees the host-resolved config. The coordinator can propose it through the
  existing `config roles propose` flow (a proposal may set `harness` on a project role; changes to built-ins stay a
  host edit or a setup answer).
- **CLI surface** ([cli-surface.md](cli-surface.md)): no new top-level command.
  - `minions setup` gets one question: "Which agent should do the work?" The answers are Claude Code
    (recommended), OpenAI Codex CLI and JetBrains Junie, plus an "Other / later" choice. A non-Claude answer
    asks for that harness's key (`auth codex|junie`) and writes `harnesses.default`.
  - `minions settings` gets the `harnesses.default` and `roles.<r>.harness` items.
  - The new subcommands are `auth codex|junie` (advanced) and `work run` (internal).
  - The image is rebuilt with the harness installed only when a harness is configured, which `minions start`
    detects through the fingerprint.

**"Authorize one harness for the whole squad"** is the default setup flow: one question, one credential,
`harnesses.default: <id>`. In phase 1 it applies to producer roles only. Setup says so plainly ("engineers will use
Codex; testing, review and coordination stay on Claude Code until a later version") and still needs Claude
credentials for the rest. Per-role mixing is a settings or config edit, not a setup question.

### D9. Phase plan

| Phase | Process harness allowed for | Coordinator | Notes |
| - | - | - | - |
| 1 | `producer` roles (engineer, project producers), container runtime only | Claude Code | `work run`, L1 wrapper + self-test, L4 verification, Codex and Junie adapters, `auth codex|junie`, setup question, probe. The host runtime refuses process harnesses: the coordinator's Bash there runs inside the Claude sandbox, and Landlock-in-sandbox is unverified. |
| 2 | + `verifier` and `gate` (tester, reviewer) | Claude Code | Reviewer read-only via L1 (already designed). Mixed squads (Codex engineer, Claude reviewer) are the expected default for cross-model review. CI evidence for verifiers/gates comes only from the runtime `ci` gate, never from harness output. |
| 3 | coordinator | any | Needs a coordinator loop for a process harness (tmux session, restart, idle restart, context reset) and a replacement for every coordinator hook: pre-agent → `work run`, pre-telegram → D11, publication `ask` rules → host-signed approvals (already the real gate). Telegram for a non-Claude coordinator needs a minions-owned bot poller instead of the Claude channel plugin. Design it as its own task after phase 2 has run. |

### D10. Test strategy

- **Fake harness** (`test/fixtures/fake-harness.mjs`, adapter id `fake`). A Node script driven by a scenario file:
  - commit in scope and write a result;
  - write out of scope;
  - move `main` with `git update-ref`, write `.git/hooks/post-checkout` or edit `.git/config`;
  - no result, or a final message only;
  - sleep past the timeout, or ignore SIGTERM;
  - emit usage JSONL;
  - try reading `/state` or the secrets fixture, or connect to a unix socket;
  - exit non-zero.

  The runner tests use it against real git repositories in `TMPDIR`. They cover the launch gate refusals, the lock,
  cancel by release, timeout and drain (wip commit plus `partial`), snapshot and restore of refs and control files,
  the violation event, submit by proxy through the real `handoff.ts`, and usage recording.
- **Adapter unit tests** (pure `plan()`): exact argv/env per role and contract. No secret in argv; secrets appear
  only in `secretEnv`. Env allowlist (no `CLAUDE_*`, `GH_TOKEN`, Telegram). Reviewer plans have no write roots.
  Repo-config-off flags are present. Snapshot tests of the generated per-lease config files.
- **Config tests**: `harnesses` schema, role-harness model validation, phase restrictions, back-compat (configs
  without `harnesses` produce byte-identical plugin output and briefs without `harness`).
- **Isolation self-test tests**: run the wrapper's canaries when Landlock is available (`describe.skipIf(!landlock)`).
  On machines without Landlock, assert that `work run` refuses with `PRECONDITION`.
- **CLI surface guard**: `work run` and `auth codex|junie` are resolved and tiered. The coordinator guidance only
  names existing commands.
- **Live tests, opt-in only**: `MINIONS_LIVE_HARNESS=codex|junie` plus a key in the environment of the test runner
  on a developer machine. They are never in CI by default and never inside a minions worker. One tiny task in a
  throwaway repo: brief → commit → result → record; usage > 0. A live run of the **Claude** path stays a
  coordinator-run check (workers must not launch `claude`).

### D11. The coordinator stays the only Telegram holder

Explicitly, for every phase before 3:

1. Only the coordinator's `claude` launch enables the Telegram plugin and holds the bot token in its environment
   (task-51, unchanged). A process-harness worker is not a Claude session and loads no Claude plugins.
2. The worker cannot obtain the token. The secrets dir, `~/.claude` (plugin state, channel config) and
   `/proc/<coordinator>/environ` are all outside its Landlock domain (D4, self-tested). The runner's env allowlist
   never passes Telegram variables.
3. The worker cannot start a competing poller through `claude`. `claude` is not reachable on its PATH, and even if
   it is invoked by path it cannot read its config dir or credentials under L1. The runner refuses `harness:
   "claude"` as a process harness, so Claude workers only ever run as in-session subagents.
4. The worker has no messaging tool. MCP is off for both harnesses (D6) and no Telegram MCP server is configured. It
   cannot reach the coordinator's tmux pane: the socket is unreadable and `socket(AF_UNIX)` is blocked.
5. Anything for the owner goes into the WorkerResult `findings`, which the coordinator reads and relays. This is the
   same rule as for Claude workers.

## Evaluation: OpenAI Codex CLI

Sources accessed 2026-10-23. `developers.openai.com/codex/*` now redirects to `learn.chatgpt.com/docs/*`; the
Markdown pages (`.md` suffix) were used.

| Topic | Finding | Source |
| - | - | - |
| CLI / headless | `codex exec` is the non-interactive mode for scripts and CI. It streams progress to stderr and prints the final message to stdout. `--json` gives JSONL events (`thread.started`, `turn.started`, `turn.completed` with `usage`, `item.*`, `error`). `-o/--output-last-message`, `--output-schema` for a schema-conformant final answer, `--ephemeral`, and the prompt from stdin with `-`. Requires a git repository unless `--skip-git-repo-check`. | [C-noninteractive] |
| Sandbox / approval | Sandbox modes `read-only` (the `exec` default), `workspace-write` and `danger-full-access`. Approval policies `on-request` and `never` (`untrusted` retired). `workspace-write` keeps `<root>/.git` (and the resolved gitdir of a pointer file) **read-only**, which by itself would block commits from a worktree. Network is off in `workspace-write` unless `sandbox_workspace_write.network_access = true`. | [C-sandbox], [C-security] |
| Sandbox in Docker | Linux uses bubblewrap (or a bundled helper that needs unprivileged user namespaces). In Docker the sandbox "may not work"; the documented remedy is to make the container the boundary and run `--sandbox danger-full-access`. | [C-sandbox], [C-security] |
| Tool restriction | No per-run tool allowlist. Execpolicy rules (`--ignore-rules` to skip user and project rules) control commands outside the sandbox. MCP servers come from config. Hooks (`PreToolUse` etc.) exist but are documented as a guardrail, not an enforcement boundary; errors continue the tool call. | [C-cli], [C-hooks], [C-rules] |
| Config isolation | `--ignore-user-config` skips `$CODEX_HOME/config.toml` (auth still uses `CODEX_HOME`). `projects.<path>.trust_level = "untrusted"` skips project `.codex/` layers (config, hooks, rules). `--strict-config`. `shell_environment_policy.*` controls env inheritance into spawned commands. | [C-cli], [C-config] |
| Model / effort | `--model/-m`; `model_reasoning_effort` via `-c`. | [C-cli], [C-config] |
| Auth | API key (`CODEX_API_KEY` for `codex exec`, set only for that process; standard API pricing). ChatGPT sign-in caches refreshable tokens in `~/.codex/auth.json` or the OS keyring (`cli_auth_credentials_store`). Device-code login for headless machines. Enterprise access tokens (`CODEX_ACCESS_TOKEN`). | [C-auth], [C-env], [C-noninteractive] |
| Install / pin | `npm install -g @openai/codex`, the standalone installer (`CODEX_NON_INTERACTIVE=1`), Homebrew. Pin with `@openai/codex@<version>` in the Dockerfile, the same way `@anthropic-ai/claude-code` is pinned. `CODEX_HOME` must exist if set. | [C-cli], [C-env] |
| Licensing / terms | The CLI is open source (`openai/codex`, Apache-2.0 LICENSE). Use is under the OpenAI terms for the auth method (API platform terms for keys, ChatGPT plan terms for sign-in). The docs warn: "Don't expose Codex execution in untrusted or public environments", and do not use ChatGPT-managed auth in CI for public or open-source repositories. | [C-oss], [C-license], [C-auth], [C-noninteractive] |

**Codex unknowns** (to settle in child task 3 with a live, opt-in run):

- U-C1: Whether `codex exec` has a documented per-run turn/step limit. None was found, so the runner relies on the
  wall clock.
- U-C2: Whether `--sandbox read-only` works without bwrap (it presumably uses the same Linux sandbox). Not relied on.
- U-C3: Exit codes of `codex exec` for success, model error, schema failure and interruption. They are not
  documented on the pages read.
- U-C4: SIGTERM behaviour (does it flush the last JSONL events and the `-o` file?).
- U-C5: Whether `--ask-for-approval never` with `danger-full-access` ever blocks on a prompt in `exec` (expected:
  no).
- U-C6: Whether `AGENTS.md` discovery walks above the worktree (the worktree's parent is `/workspace/worktrees`,
  which has none).
- U-C7: Whether usage covers all model calls (sub-agents, compaction) or only main turns.
- U-C8: Behaviour under Landlock: does Codex itself need paths outside the allowlist (e.g. `/proc`, its package
  cache)?
- U-C9: Terms for unattended, multi-agent use under a ChatGPT plan. Not needed in phase 1 (API key only); not
  reviewed by counsel.

## Evaluation: JetBrains Junie CLI

Sources accessed 2026-10-23 (pages dated 22 October 2026). `www.jetbrains.com/help/junie/*` canonical URLs serve
from `junie.jetbrains.com/docs/*`.

| Topic | Finding | Source |
| - | - | - |
| CLI / headless | `junie` binary for Linux, macOS and Windows. Headless mode: `junie [--auth …] "<task>"`, also `--task` / `JUNIE_TASK`, piped input with `--input-format text|json`, output `--output-format text|json|json-stream`, `--json-output-file`. The headless page labels the CLI as EAP. | [J-cli], [J-headless], [J-params] |
| Project trust | Interactive runs ask for trust. Non-interactive runs are **always trusted** and load the project's Junie config (MCP servers, agents, skills, guidelines) without asking. Hooks from the project `config.json` are ignored by default. `--config-default-locations false`, `--mcp-default-locations false`, etc. disable default sources. | [J-headless], [J-config], [J-params] |
| Approval / tools | Approvals for terminal commands, edits outside the project and MCP tools; Action Allowlist `~/.junie/allowlist.json` (`fileEditing`, `executables`, `mcpTools`, `readOutsideProject`, `readSecretFile`; `allow` / `ask`); brave mode Off/Auto/On (`--brave` is interactive only); plan mode is read-only analysis. | [J-cli], [J-allowlist], [J-params] |
| Sandbox | EAP sandbox mode (`--sandbox`): srt, bubblewrap, `socat`, ripgrep. It writes only to the project, its git dir, temp and tool caches; reads are unrestricted except `~/.ssh`; the network is unrestricted by default. Not hardened isolation, and hooks/MCP are not isolated. "Containers … may still require an administrator's help." | [J-cli], [J-eap] |
| Hooks | EAP: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (allow/ask/block/deny, exit 2 blocks), `Stop`, `StopFailure`, `SessionEnd`, `PermissionRequest`. Other non-zero exits let the tool proceed. | [J-hooks] |
| Model / effort / limits | `--model` / `JUNIE_MODEL` (aliases such as `sonnet`, `opus`, `gpt`, `gemini-pro`; mapping set by JetBrains and may change), `--effort` (requires a model), `--provider` for BYOK, `--max-steps` per task. Junie also calls a helper model from the same provider for internal tasks. | [J-models], [J-params] |
| Auth | JetBrains Account (browser login), Junie API key (`JUNIE_API_KEY`, usage-based, from junie.jetbrains.com/cli), BYOK provider keys (`JUNIE_OPENAI_API_KEY`, `JUNIE_ANTHROPIC_API_KEY`, …; `byok` in `config.json`), custom endpoints (LiteLLM etc.). Plaintext fallback `secure_credentials.json`. `JUNIE_HOME` overrides `~/.junie`. | [J-cli], [J-env], [J-byok], [J-config] |
| Install / pin | `curl -fsSL https://junie.jetbrains.com/install.sh \| bash` (managed launcher in `~/.local/bin`, channels release/eap/nightly/experimental). `--use-version=<build>`, `--skip-update-check`, `auto-update: false`; "direct binary or JAR runs" exist. | [J-cli], [J-params], [J-config], [J-eap] |
| Licensing / terms | Proprietary. The EAP is under the Junie EAP Terms of Service; GA is under the JetBrains AI Terms of Use. Inputs and selected project data are sent to JetBrains and its AI providers. | [J-eap], [J-terms] |

**Junie unknowns:**

- U-J1: A pinned, checksummed, non-interactive install artifact for a read-only image. The install script installs
  a self-updating launcher into `~/.local/bin`, which is tmpfs in our container. Whether JetBrains publishes
  versioned download URLs with checksums for the binary or JAR is not documented on the pages read. Phase 1 for
  Junie depends on this.
- U-J2: What headless mode does with an action that needs approval (`ask`): auto-deny, hang or proceed. It is not
  documented. The planned mitigations are a per-lease allowlist with `defaultBehavior: "allow"` (L1 is the
  boundary) and the runner timeout.
- U-J3: Whether the task can come from stdin without `--input-format json` and a documented JSON shape. Otherwise
  it goes through `JUNIE_TASK` env, which keeps it out of `ps`.
- U-J4: The layout of `--output-format json` / `json-stream` and of `events.jsonl`, in particular token usage and
  the final message.
- U-J5: Exit codes, SIGTERM behaviour, and whether `--max-steps` ends with a distinguishable status.
- U-J6: Whether headless needs a writable path outside `JUNIE_HOME` (e.g. the launcher's restart handoff in
  `$TMPDIR` is fine; anything in `~/.local`?).
- U-J7: Whether Junie headless (non-EAP) is GA. The headless page says EAP while the quickstart does not, and the
  terms differ by channel. Unattended multi-agent use under a JetBrains subscription vs. a Junie API key is not
  reviewed by counsel.
- U-J8: Whether a Junie API key is scoped (per project, revocable) and how it is rotated.
- U-J9: Behaviour under Landlock (JVM or native runtime paths, `/proc`, `strace` use). Sandbox monitoring is not
  used.
- U-J10: Whether the existing JetBrains Central preset (`src/host/auth.ts`, `jbcentral`) can serve Junie too. It is
  not assumed.

Because of U-J1 and U-J2, **Codex is the first adapter**. Junie follows in phase 1 once U-J1 is resolved; if it is
not, Junie is deferred with a clear `status --check` message.

## General unknowns and risks

- U-G1: Landlock availability on Linux Docker Engine hosts and other Docker Desktop versions (kernel ≥ 5.13 with
  Landlock in the LSM list, and a seccomp profile that allows the three syscalls). Measured only on Docker Desktop
  linuxkit 7.0.14 (ABI 8). Mitigation: self-test and fail closed.
- U-G2: Whether Landlock's ptrace restriction covers every `/proc/<pid>` read that could leak the coordinator's
  environment on all supported kernels. Mitigation: the self-test canary reads it.
- U-G3: Whether blocking `socket(AF_UNIX)` breaks common project tooling (e.g. Docker CLI, database clients in
  tests). Expected acceptable for workers. Projects that need it are a later, explicit option.
- U-G4: Shared caches. A per-lease npm cache avoids cross-worker poisoning but costs disk and time. The design
  starts per-lease, with a read-only shared cache as an option.
- U-G5: Usage units. Non-Claude token counts are tallied as tokens in the task-32 budget. USD estimates exist only
  for Claude API-key billing, and per-harness pricing is not configured. The budget wording says "approximate
  across harnesses".

## Child tasks

1. **Harness config, registry and brief/next fields.** `harnesses` schema and JSON schema, `roles.<r>.harness`
   (roles-and-workflows D9 override fields), model validation per role harness, phase rules, `harness` in the brief, `launch` in
   `work next`, back-compat tests. Depends: none.
2. **Isolation wrapper and probe.** The `minions-sandbox` helper (Landlock, scoping, seccomp `AF_UNIX`) built in
   the Dockerfile, rules generation per role, the self-test canaries, the `harness.*` checks in
   `status --check` / `doctor`. Sensitive-path review: Dockerfile build stage. Depends: none.
3. **Process runner and fake harness.** `minions work run` (gate, lock, brief/submit by proxy, snapshot/verify/
   restore, supervise, cancel, timeout, drain wip/partial, usage), fake adapter and runner tests, CLI surface
   guard. Depends: 1, 2.
4. **Codex adapter.** `plan()`, JSONL usage parser, WorkerResult output schema, pinned install in the image
   behind the fingerprint, `auth codex` credential kind, opt-in live test; resolve U-C1–U-C8. Depends: 3.
5. **Junie adapter.** Same for Junie; resolve U-J1–U-J6 first (blocking: U-J1). Depends: 3.
6. **Setup, settings and coordinator guidance.** Setup question ("authorize one harness for the whole squad"),
   settings items, orchestrate skill and `coordinator.md` (`launch.kind: run`), README section, docs/cli.md.
   Depends: 1, 4.
7. **Phase 2: verifier and gate roles on process harnesses.** Lift the phase rule, reviewer read-only rules, tests.
   Depends: 3, 4.

## Sources

- [C-cli] OpenAI, *Codex CLI* and *Developer commands (CLI reference)*: https://learn.chatgpt.com/docs/codex/cli.md,
  https://learn.chatgpt.com/docs/developer-commands.md?surface=cli
- [C-noninteractive] OpenAI, *Non-interactive mode*: https://learn.chatgpt.com/docs/non-interactive-mode.md
  (formerly https://developers.openai.com/codex/noninteractive)
- [C-sandbox] OpenAI, *Sandbox*: https://learn.chatgpt.com/docs/sandboxing.md
- [C-security] OpenAI, *Agent approvals & security*: https://learn.chatgpt.com/docs/agent-approvals-security.md
- [C-auth] OpenAI, *Authentication*: https://learn.chatgpt.com/docs/auth.md
- [C-env] OpenAI, *Environment variables*: https://learn.chatgpt.com/docs/config-file/environment-variables.md
- [C-config] OpenAI, *Configuration Reference*: https://learn.chatgpt.com/docs/config-file/config-reference.md
- [C-hooks] OpenAI, *Hooks*: https://learn.chatgpt.com/docs/hooks.md
- [C-rules] OpenAI, *Rules*: https://learn.chatgpt.com/docs/agent-configuration/rules.md
- [C-oss] OpenAI, *Open Source*: https://learn.chatgpt.com/docs/open-source.md
- [C-license] openai/codex LICENSE (Apache License 2.0): https://github.com/openai/codex/blob/main/LICENSE
- [J-cli] JetBrains, *Junie CLI (Quickstart)*: https://www.jetbrains.com/help/junie/junie-cli.html
- [J-headless] JetBrains, *Headless mode*: https://www.jetbrains.com/help/junie/junie-headless.html
- [J-params] JetBrains, *CLI reference*: https://www.jetbrains.com/help/junie/parameters.html
- [J-env] JetBrains, *Environment variables*: https://www.jetbrains.com/help/junie/environment-variables.html
- [J-config] JetBrains, *config.json*: https://www.jetbrains.com/help/junie/junie-cli-configuration.html
- [J-allowlist] JetBrains, *Add commands to Action Allowlist*: https://www.jetbrains.com/help/junie/action-allowlist-junie-cli.html
- [J-hooks] JetBrains, *Hooks*: https://www.jetbrains.com/help/junie/junie-cli-hooks.html
- [J-models] JetBrains, *Model selection*: https://www.jetbrains.com/help/junie/junie-cli-model-selection.html
- [J-byok] JetBrains, *Bring Your Own Key (BYOK)*: https://www.jetbrains.com/help/junie/byok.html
- [J-eap] JetBrains, *Early Access Program (EAP)*: https://www.jetbrains.com/help/junie/junie-cli-eap.html
- [J-terms] JetBrains, *Junie EAP Terms of Service*: https://www.jetbrains.com/legal/docs/terms/jetbrains-junie/
