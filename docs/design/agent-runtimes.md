# Agent runtime adapters (Codex CLI, JetBrains Junie)

Status: design (task-14.1). No harness integration code exists yet; implementation is split into the child tasks at
the end. Parent: task-14 (non-Claude harnesses). Builds on task-9 (`minions work brief|submit`) and task-33 (role
registry, contract variants, workflows; [roles-and-workflows.md](roles-and-workflows.md)).

Revision 2 closes three review findings: post-exit git outside the sandbox (D3.7, D3a), shared-repo writes and ref
rollback (D3.4, D4), and workers that outlive their runner (D3b, D4 "Process lifetime"). It also adds the phase 1
options for the owner (D9).

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
  checkout: string;              // absolute; the per-lease checkout <scratch>/work (D3.4), the process cwd
  leaseWorktree: string;         // absolute; the shared lease worktree; the worker gets no access to it
  gitObjectsDir: string;         // absolute; <common>/objects, read-only via alternates; resolved by the runner
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

The runner is harness-independent. It does the steps below in order. Every git command it runs goes through one
hardened helper (D3a), and everything it needs to clean up after a crash is persisted first (D3b).

1. **Launch gate (replaces `preAgentHook`).** The lease must be active. Its role must resolve to a process harness
   in the runtime config, and that harness must be allowed for the role's contract in the current phase (D9).
   Refused (`POLICY_DENIED`) in these cases:
   - the lease already has a run record (`/state/run/leases/<id>/run.json`, created with `O_EXCL`). A lease runs at
     most once, and the record doubles as the one-process-per-lease lock;
   - another lease of the same task has a run record that is not `done`. The old run's post-exit checks must
     finish before a new writer starts (D3b);
   - a drain is pending, or the budget or pause rules would refuse a claim (same checks as `claim`);
   - role capacity (`execution.maxByRole`) would be exceeded **counting the active leases other than this one**.
     This lease was already counted when it was claimed, so a squad at full capacity must not refuse its own run.
     The phase 1 process-producer cap (D9, option a) is counted the same way;
   - `MINIONS_WORKER_LEASE` is set, or the cwd is inside a lease worktree. These two refusals are hints for honest
     callers, not the gate (next paragraph).

   Fails closed when the config or DB cannot be read.

   **What actually stops a worker from starting workers.** A worker can unset the variable and `cd /`, so the env
   and cwd checks are weak on their own. For a process worker the guard is L1 (D4): it cannot read or write
   `/state`, so `minions work run|claim|release` fails closed for it whatever its env or cwd. For a Claude subagent
   (in-session, not confined in the container today), child task 8 adds a `PreToolUse` Bash hook that denies
   `minions work run|claim|release` when the hook input carries `agent_id`. This is the same signal
   `preTelegramHook` uses. The residual (a subagent hiding the call in a script) is the trust level Claude workers
   already have today: they can write `/state` directly.
2. **Run record.** Before anything else, the runner writes `/state/run/leases/<id>/run.json` atomically and updates
   it at each phase:
   `{leaseId, taskId, branch, claimHead, leaseWorktree, checkout, bootId, containerStart, runner: {pid, startTime},
   wrapper: {pid, startTime}, pgid, phase, leaseGit: {...snapshot (step 4)}, deadline}`, with `phase` one of
   `prepared | running | post-exit | done`. A process is identified by pid plus start time (`/proc/<pid>/stat`
   field 22) plus boot id (`/proc/sys/kernel/random/boot_id`) and container start (PID 1's start time). A record from
   another boot or container instance has no live processes. The record is removed when the lease ends after
   `done`.
3. **Brief by proxy.** The runner calls `fetchBrief` itself (same `handoff.ts` code path; the runner's cwd is the
   lease worktree, so the ownership check is the one workers get today) and writes it to `<scratch>/brief.json`.
   In the worker-facing copy, `worktree` is the per-lease checkout (step 4); `leaseWorktree` keeps the real path for
   reference. The worker process **cannot read `/state`** (D4), so the worker does not run `minions work brief`. Its
   instructions say: the brief is in `$MINIONS_BRIEF_FILE` (also inlined in the prompt); write your WorkerResult
   JSON to `$MINIONS_RESULT_FILE`.
4. **Per-lease repository.** The worker never gets write access to the shared repository: no refs, no objects, no
   config, no worktree admin dirs, not even the lease worktree. It works in a private clone under the lease scratch
   dir that borrows the shared objects read-only:
   - `git clone --shared --single-branch --branch <lease branch> --no-tags --no-checkout <common> <scratch>/work`,
     then `remote remove origin`, `gc.auto=0`, then checkout of the lease branch (all through D3a). `--shared` writes
     `objects/info/alternates` = `<common>/objects`. Under L1 the worker can read `<common>/objects` and nothing
     else of `<common>`, so it can read borrowed objects but cannot add, delete or prune them, and it cannot see or
     move any shared ref.
   - The worker commits in `<scratch>/work` as usual. New objects go into the clone's own object dir.
   - Borrowed objects are safe from the shared repo's gc: they are reachable from the lease branch at its claim head,
     and nothing else moves the lease branch while the lease is active (one lease per task).
   - **Snapshot of the lease's own git files**, kept in the run record (content, since they are small). Under L1 the
     worker cannot write any of this, so the snapshot is a check against an L1 gap:
     - `<leaseWorktree>/.git` (`gitdir: <common>/worktrees/<name>`);
     - `<common>/worktrees/<name>/gitdir` and `commondir`;
     - `<common>/worktrees/<name>/config.worktree`, or its absence;
     - the claim head of the lease branch.

     Only files that belong to this lease alone are recorded. No other ref is recorded or checked, and neither are
     `<common>/config`, `hooks/` and `info/`. Other leases' runners, Claude workers and the coordinator's merges
     into `main` legitimately change refs and shared files during the run, and the runner never restores or rolls
     back anything it did not write. The shared files are outside every process worker's L1 rights, and D3a
     neutralizes what they could run.
   - Cost: one checkout per running process worker (objects shared). See U-G4.
5. **Spawn** `adapter.plan(...)` under the isolation wrapper (D4) with these properties:
   - the wrapper starts its own session (and so its own process group), sets `PR_SET_PDEATHSIG` and becomes a
     child subreaper (D4, "Process lifetime"). The runner spawns from its main thread, because the parent-death
     signal is tied to the thread that forked (Node's `child_process` spawns from the main thread). Node's plain
     spawn and `detached` both work; only a process-group leader inside another session is refused (D4);
   - stdin, stdout and stderr are the only descriptors passed. The wrapper's child calls
     `close_range(3, ~0U, 0)` before exec, so no inherited unix socket, DB handle or pipe leaks into the worker;
   - an environment built from an allowlist (`PATH`, `HOME=<harnessHome>`, `TMPDIR=<scratch>/tmp`, `LANG`,
     `TERM=dumb`, `MINIONS_*` lease variables, the harness's own variables). No inherited `CLAUDE_*`,
     `ANTHROPIC_*`, `GH_TOKEN`, `GIT_*` or Telegram variables;
   - secrets read from the mounted file by the runner and passed only in the env entries the plan names. A secret is
     never put in argv: Junie documents `--auth=<key>` for CI, and the adapter must use `JUNIE_API_KEY` instead.

   The run record gets the wrapper pid, the pgid and `phase: running`.
6. **Supervise.**
   - Wall-clock limit: `harnesses.<id>.timeoutMinutes`, default 60.
   - Step limit: passed to the harness when it has one (Junie `--max-steps`).
   - Cancel: the runner polls the lease every 5 s. A lease that is no longer active, or a cancel mark in the run
     record (D3b), means SIGTERM to the wrapper, which stops the whole tree (SIGTERM, SIGKILL after 15 s).
   - Drain: when the drain marker appears, the runner allows a fixed grace of 120 s (a new optional
     `harnesses.<id>.drainGraceSeconds` if owners need it) and then stops the process.
   - Usage: events are collected from stdout (D6).
7. **Post-exit** (authoritative, harness-independent, before anything is submitted). It starts only after the
   wrapper has reported that no descendant is left, so the worker cannot race the checks. `phase: post-exit`.
   1. **Lease git files.** Compare them with the snapshot from step 4. A difference is a violation. The runner
      restores the recorded content (`O_NOFOLLOW`; a symlink in their place is removed first) before any further
      git call.
   2. **Sanitize the clone.** The clone is worker-written, so the runner rewrites its control files instead of
      trusting them. `lstat` first: `<scratch>/work/.git` must be a real directory, and no control path below may
      be a symlink (a symlink would turn the runner's write into a write anywhere, `/state` included). Any symlink or
      wrong file type is a violation, and nothing is fetched. Otherwise, with `O_NOFOLLOW` writes:
      - `config` is replaced by a runner template: no `include` or `includeIf`, no remotes, `core.bare=false`,
        `gc.auto=0`;
      - `objects/info/alternates` is set to exactly `<common>/objects`, and `objects/info/http-alternates` is
        removed;
      - `hooks/`, `info/attributes`, `commondir`, `gitdir`, `config.worktree` and `worktrees/` are removed.
   3. **wip commit.** On drain or timeout, when the role may commit, the runner makes a `wip:` commit in the clone
      (D3a, author `minions-runner`, only paths inside `edits`).
   4. **Branch rule.** Read the lease branch head of the clone. For a gate, or a role with `commits: false`, it must
      equal the claim head; nothing is fetched. For a producer or verifier, the claim head must be an ancestor of it
      (fast-forward only).
   5. **Fetch back.** In the shared repo (D3a):
      - `fetch --no-tags --no-write-fetch-head <scratch>/work refs/heads/<branch>:refs/minions/incoming/<lease>`,
        with `transfer.fsckObjects=true` (rejects malformed objects and tree entries such as `.git/…`);
      - check that `refs/heads/<branch>` is still the claim head;
      - `merge --ff-only refs/minions/incoming/<lease>` in the lease worktree (explicit
        `--git-dir=<common>/worktrees/<name>`, `--work-tree=<leaseWorktree>`). This moves the branch and the
        checkout together;
      - delete the incoming ref.

   A violation means nothing is fetched. The lease branch stays at the claim head, so there is nothing to restore
   in the shared repo, and no other actor's ref or commit is ever touched. The runner logs a `harness-violation`
   event. The result becomes an invalid submission whose `findings` name the violation. The existing
   single-correction rule does not apply: a violation is terminal for the attempt, and the coordinator sees it in
   `work record`.
8. **Submit by proxy.** The runner reads `$MINIONS_RESULT_FILE` or, when it is missing, the harness's final message
   when that parses as a WorkerResult (Codex `--output-schema` makes this reliable).
   - Drain or timeout: a synthesized `partial` result names the `wip:` commit from step 7.3.
   - No result at all: it synthesizes `blocked` with the exit status and the last 2 KB of stderr (redacted).

   It then calls `submitResult` (the `minions work submit` code path) with cwd = lease worktree. The head check
   there now sees the fetched head. The runner records usage with the task-32 `usage` event (harness-tagged), sets
   `phase: done`, and exits. It prints one JSON line for the coordinator:
   `{leaseId, exit, submitted, status, violations[], usage}`.

The worker-facing contract is otherwise identical to Claude workers (same role prompt, same WorkerResult schema, same
`resultContract` text per variant). The difference is that the runner, not the worker, talks to `minions work
brief|submit`. Both commands keep their existing checks.

#### D3a. Runner git

One helper runs every git command of the runner and of recovery (D3b), on the clone and on the shared repo alike:

- explicit `--git-dir=<abs>` and `--work-tree=<abs>`. Git never discovers the repo through a `.git` file. `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` and every other
  inherited `GIT_*` variable are dropped;
- before the call, the pointer and control files of that git dir must match the run record (lease git files,
  step 7.1) or have just been rewritten (clone, step 7.2). A linked worktree's git dir is used only after its
  `commondir` and `gitdir` contents match;
- `hardenedGitArgs()` and `hardenedGitEnv()` from `src/runtime/git-hardening.ts`, today host-runtime only, are reused
  for the container runner. They already set `core.hooksPath=/dev/null`, `core.fsmonitor=false`, the pager, askpass
  and ssh commands off, the protocol allowlist, `gc.auto=0`, no submodule recursion and `GIT_CONFIG_NOSYSTEM=1`. The
  runner adds:
  - `GIT_CONFIG_GLOBAL=<runner-owned file>`;
  - `core.untrackedCache=false` and `commit.gpgSign=false`;
  - `transfer.fsckObjects=true`;
  - `protocol.file.allow=always` for the local fetch only, with an explicit `--upload-pack=git-upload-pack`;
  - `filterOverrides()`;
- `--no-verify` on `commit` and `merge`, and `--no-gpg-sign`;
- `include` and `includeIf` cannot be switched off with `-c`. They are covered because the runner never reads a
  config a process worker wrote: the clone's config is rewritten (step 7.2), and no process worker has write
  access to the shared config, whose trust is unchanged from today. For the same reason, filter drivers named in a
  committed `.gitattributes` resolve to nothing in the clone: drivers come only from config.

After the run, the coordinator's own git in the lease worktree (record checks, merges) sees only files a process
worker could never write. The lease's own pointer files were also checked in step 7.1.

#### D3b. Orphans and recovery

A worker must never outlive its supervision. The runner can die from a coordinator restart, a context reset that ends
the coordinator's background Bash, OOM or SIGKILL. In each case:

- **The tree dies with the runner.** The wrapper's parent-death signal fires. It stops its process group and, as
  subreaper, kills every reparented descendant (D4, "Process lifetime").
- **Cleanup is driven by the run record**, never by runner memory. One function, `reapRun(leaseId)`, runs before a
  lease ends or a task is re-dispatched. It is called by `work release` (any reason, including the recover skill's
  "worker not running" release), by the stale-lease path, and by coordinator start, which includes
  `coordinator restart --recover` and so the `/minions:recover` flow:
  1. `phase: done` or no record: nothing to do. A lease that was claimed but never run (the coordinator crashed
     between `claim` and `run`) has no record, and the existing release flow applies.
  2. The runner is alive (pid, start time and boot id match): mark cancel in the record, then wait up to 60 s for
     `done`.
  3. Otherwise, or on timeout: SIGKILL the recorded wrapper and pgid (each pid checked against its recorded start
     time). Then sweep for escapees: every process whose `Seccomp_filters` count in `/proc/<pid>/status` is above
     the container baseline is a sandboxed worker, because only the wrapper adds a filter. Each one whose ancestry
     does not reach a live wrapper is killed. A record from another boot or container start skips this step, since
     its processes are already gone.
  4. Run post-exit steps 7.1 to 7.5 with a drain-style `wip:` commit. The work is preserved on the lease branch, as
     with drains, and the release note names the `wip:` commit ("recovered: runner lost"). Then `phase: done`, and
     only then does the lease end.
- **Re-claim gate.** `work claim` refuses a task while any of its leases has a run record that is not `done`, and
  `work run` refuses it too (step 1). A re-dispatched task can never get a second writer, even if releases happen
  out of order.
- **Restarts.** Idle self-restart and `coordinator restart` count records that are not `done` as running workers.
  They already refuse while leases are active; a record that is not `done` and has no active lease is reaped first.
- **Container restart.** Every process is gone. On the next coordinator start, records with an old boot id or
  container start go straight to `reapRun` step 4.

### D4. Lease and permission gates without Claude hooks

Hooks inside a non-Claude harness can't be the gate. Both harnesses now have hooks, but:

- Codex documents that a `PreToolUse` hook error, timeout or malformed response continues the tool call. It also says
  to "treat tool hooks as a useful guardrail, not a complete enforcement boundary" [C-hooks].
- Junie's hooks are EAP-only. A non-zero exit other than 2 lets the tool proceed [J-hooks].

So enforcement is layered and **every layer that matters sits outside the harness process**:

| Layer | Mechanism | Enforces | Bypassable by the worker? |
| - | - | - | - |
| L0 Launch | `work run` gate (D3.1) and the run record (D3.2) | only claimed leases run; one run per lease; no second writer while an old run is unreaped; drain / budget / pause / capacity | No (runs before the worker exists; the worker cannot reach `/state` under L1) |
| L1 Isolation | `minions-sandbox` exec wrapper: Landlock filesystem and TCP rules, ABI 6 scoping, a seccomp filter, fd closing, parent-death kill (below) | no read or write of `/state`, `/opt/minions/secrets`, `~/.claude`, the shared repo (except read-only objects), any shared worktree, the tmux socket dir; writes only in its scratch dir; no signals or ptrace to processes outside the sandbox; no unix-socket connects; TCP connects only to allowed ports; no life after the runner | No (kernel-enforced, irreversible after `landlock_restrict_self`, inherited by every child) |
| L2 Harness config | sandbox / approval flags, MCP off, repo-provided config off, no Telegram or Agent-like tools | least surprise; fewer prompts and hangs | Yes, partly (advisory) |
| L3 Git UX | a minions `pre-commit` hook in the clone's config (edit-scope and sensitive-path warnings) | early feedback only | Yes (`--no-verify`, editing its own clone) |
| L4 Post-exit and record | D3.7 (shared-side check, clone sanitizing, fast-forward-only fetch of the lease branch with fsck) + existing record checks (contract, head rules, `edits.paths`, CI evidence by contract, host-signed publication) | the actual gates | No (runs outside, after the whole tree has exited) |

**L1, the isolation wrapper.** Inside the hardened container the harnesses' own sandboxes are expected not to work.
Both build on bubblewrap with user namespaces: Codex on Linux, and Junie's `srt` [C-sandbox], [J-cli]. The probe
above shows that user namespaces are denied. Codex's docs give the remedy for this case: let the container be the
boundary and run `--sandbox danger-full-access` inside it [C-security]. Our container is shared with the
coordinator, the state DB and the secrets mount, so "the container is the boundary" is not enough on its own. The
wrapper adds an unprivileged, per-process boundary that the probe shows is available. **Minimum: Landlock ABI 6**
(Linux 6.12). ABI 6 is the first with signal and abstract-socket scoping, and the canaries below need it. Newer rights
are used when present.

- **Landlock filesystem** (an allowlist; handled rights include `REFER`, `TRUNCATE` and `IOCTL_DEV`):
  - read and execute: `/usr`, `/lib*`, `/bin`, `/etc`, `/opt/<harness>`, the Node toolchain;
  - read:
    - `/proc`. Access to other processes' entries, `/proc/<pid>/environ` included, is still denied by Landlock's
      ptrace restriction for processes outside the domain (self-tested);
    - `/sys/fs/cgroup` and `/sys/devices/system/cpu`, because Node and the JVM size their heaps and thread pools
      from them;
    - `/dev/zero`, `/dev/random` and `/dev/urandom`; `/dev/null` is read and write;
    - `<common>/objects`, for the clone's alternates (D3.4);
  - read and write: `<scratch>`, which holds the clone `work/` with its own `.git`, `harness-home`, `tmp/`, a
    per-lease npm cache, and the brief and result files.

  Everything else is denied, reads included:
  - `/state`, `/opt/minions/secrets`, `/home/node/.claude`;
  - `/workspace/repo` (the main checkout) and `<common>` apart from `objects`: refs, `packed-refs`, config, hooks,
    `info` and `worktrees/`;
  - the lease worktree and every other worktree;
  - `/tmp` and `/dev/shm`.

  A worker can therefore neither move a shared ref nor delete or prune a shared object, and it can't rewrite any
  pointer file the runner or coordinator later uses. A reviewer's clone is writable too, so its builds and tests
  run, but nothing is ever fetched back from a gate (D3.7.4). That is the per-process form of the "read-only for
  reviewers" constraint, which container mounts cannot provide per lease (mounts are fixed at container creation).
- **Landlock scoping** (ABI 6): `LANDLOCK_SCOPE_SIGNAL` (the worker cannot signal the coordinator, the runner or
  its own wrapper) and `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET`.
- **Landlock network** (ABI 4, always present at ABI 6): `LANDLOCK_ACCESS_NET_CONNECT_TCP` is handled. Only ports
  in `harnesses.network.tcpConnectPorts` (default `[443]`) may be connected to, on any address. This closes the
  container-local TCP path. The worker shares the container's network namespace, and a separate namespace needs
  user namespaces, which are unavailable. Measured: the only TCP listener in the container is Docker's embedded
  DNS resolver on `127.0.0.11`, and minions opens none. `status --check` warns when `/proc/net/tcp{,6}` shows a
  loopback listener on an allowed port. TCP binds stay allowed. Accepted cost: project tests that connect to a
  local server on another port fail until the project lists that port (D8). Listing a port allows it to every
  host.
- **seccomp** (unprivileged under `no_new_privs`, stacked on Docker's profile):
  - architecture check first: a syscall from any non-native ABI ends the process (`SECCOMP_RET_KILL_PROCESS`). On
    x86_64 that covers the i386 compat table, including `socketcall`, and every number with `__X32_SYSCALL_BIT`
    set. On arm64 it covers AArch32;
  - `socket()` is allowed only for `AF_INET`, `AF_INET6` and `AF_NETLINK`. `AF_UNIX` fails with `EACCES`, because
    Landlock's filesystem rights do not cover `connect()` to a pathname socket, and the tmux socket
    (`/tmp/tmux-1000/…`) would let a worker type into the coordinator's TUI. `socketpair` stays allowed, because
    Node and libuv need it for child stdio. The filter tests the family argument by value, so no pointer race is
    possible;
  - `io_uring_setup`, `io_uring_enter` and `io_uring_register` fail with `ENOSYS`: `IORING_OP_SOCKET` and
    `IORING_OP_CONNECT` would bypass the `socket()` filter. Docker's default profile blocks them in recent
    versions, but the design does not rely on it.
- **Descriptors.** The wrapper's child closes every descriptor above 2 (`close_range`) before Landlock and exec, so
  nothing the runner or coordinator holds open (DB, sockets, pipes) is inherited.
- **Process lifetime.** The wrapper is a tiny supervisor. It stays outside the domain and is the only process that
  does:
  1. `setsid()`, which also makes it the leader of a new process group (pgid = its pid), then
     `prctl(PR_SET_CHILD_SUBREAPER, 1)` and `prctl(PR_SET_PDEATHSIG, SIGTERM)`. If `getppid()` is no longer the
     runner (the runner died before the prctl), it exits at once. A wrapper that already leads its own session
     (started with `setsid`) keeps it. A process-group leader in another session cannot call `setsid` and is
     refused, rather than run in a shared session (see the task-14.3 round-4 addendum).
  2. Fork. The child closes descriptors, installs seccomp, calls `landlock_restrict_self` and execs the harness.
  3. On SIGTERM (cancel, timeout, drain or runner death): `kill(-pgid, SIGTERM)`, then SIGKILL after 15 s. Then it
     SIGKILLs and reaps every child until `waitpid` returns `ECHILD`. As subreaper it inherits every orphaned
     descendant, including ones that left the process group with `setsid`, so the loop ends only when the whole tree
     is gone. Then it exits with the harness's status.

  The worker cannot kill its wrapper, because signal scoping applies. If the wrapper itself is SIGKILLed (OOM),
  the runner, or `reapRun` when the runner is gone too, kills the pgid and sweeps for escapees (D3b, step 3).

The wrapper is a small C helper (`/usr/local/bin/minions-sandbox`), built in a builder stage of
`docker/Dockerfile` and pinned like the other binaries. It takes the rules as a JSON file and execs the harness.
Alternatives considered:

- `setpriv` has no Landlock support in 2.38.
- A Perl `syscall()` wrapper works (Perl is in the image) but is fragile, and it cannot do the subreaper loop
  cleanly.
- Third-party `landrun` would be an extra supply-chain dependency.
- A custom seccomp profile that re-enables user namespaces for bwrap would be an infrastructure change that widens
  the kernel attack surface for every process. It would also allow a private network namespace.
- Sibling worker containers launched by the host would give true read-only mounts and a separate network
  namespace, but they need a host-side launcher daemon. The container has no Docker socket, by design.

The last two are recorded as later options, not phase 1.

**Fail closed.** `work run` runs the wrapper's self-test once per container start and caches the result in
`/state/run/sandbox-probe.json`. The self-test runs a canary under the generated rules, and every check must fail
from inside:

- write outside `<scratch>`, in particular into the lease worktree, `<common>/refs` and `<common>/objects`;
- read `/state/minions.db`, `/opt/minions/secrets/*`, `~/.claude` and `<common>/config`;
- read `/proc/<runner pid>/environ`;
- `kill(runner pid, 0)` and `kill(wrapper pid, 0)`;
- connect to a unix socket the runner opened, by path and abstract;
- `io_uring_setup`, and an x32 or compat syscall where the architecture has one;
- use a descriptor number the runner had open before the spawn;
- TCP connect to a loopback listener on a port that is not allowed;
- survive the runner: the runner process is SIGKILLed and the canary tree, including a `setsid` grandchild, must
  be gone within 20 s.

The self-test also checks that `/proc/self/status` has `Seccomp_filters` (used by the escapee sweep); a failed open
or read is reported with its errno, apart from a status file without the line. If any canary
succeeds, or Landlock ABI is below 6, every process-harness launch is refused with
`PRECONDITION: process isolation unavailable`, and `status --check` reports why. There is no opt-out flag in
phase 1.

**What the worker can still do** (accepted, documented risk):

- reach the network on allowed TCP ports (exfiltrate the repository, as a Claude worker can today). Landlock governs
  only TCP connects, so UDP (not only DNS), SCTP and ICMP-ping sockets reach any address and port. MPTCP connects
  are not covered by Landlock either, so seccomp refuses `IPPROTO_MPTCP` sockets;
- read any object in the shared object store by id, other branches included (Claude workers can read the whole
  repository today);
- read its own harness credential (it is in its environment; mitigated by a scoped key and, for Codex, by
  `shell_environment_policy` keeping it out of spawned commands; D5);
- write anything in its own clone, which L4 sanitizes and checks before a fast-forward of its own branch.

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
  --cd <checkout> --sandbox danger-full-access        # D4: L1 is the boundary; bwrap is unavailable in the container
  --ask-for-approval never                            # no human in the loop; approvals would hang or fail
  --model <id> -c model_reasoning_effort=<effort>
  -c shell_environment_policy.inherit=core -c shell_environment_policy.ignore_default_excludes=false
  -c 'projects."<checkout>".trust_level="untrusted"'  # no repo-provided .codex/ config, hooks or rules
  --output-schema <scratch>/worker-result.schema.json -o <scratch>/last-message.json
  -                                                   # prompt (instructions + brief) on stdin
```

- Reviewers get the same flags. Read-only towards the squad comes from L1 and the no-fetch-back rule for gates
  (D3.7.4), because Codex's own `read-only` sandbox also needs bwrap (unknown U-C2).
- Usage: sum the `usage` object of every `turn.completed` JSONL event [C-noninteractive].
- `--output-schema` gets the WorkerResult JSON schema (generated from `WorkerResultSchema`, like `schema/`).
- Tool restriction: Codex has no per-run tool allowlist comparable to Claude frontmatter. MCP servers come only
  from config, and with `--ignore-user-config` and an empty per-lease `CODEX_HOME` there are none. Web search is
  hosted and not hookable; the adapter leaves `--search` off.

**Junie CLI** (headless). Planned invocation:

```
junie --project <checkout>                          # task via JUNIE_TASK (U-J3: stdin form unverified)
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
- the L1 self-test (D4) result: `ok` / `fail: <canary that escaped>` / `unavailable: landlock ABI <n> (need 6)`;
- a warning for each loopback TCP listener on an allowed connect port (D4, "Landlock network").

It sends no model request and needs no key. An optional, separate `--live` mode later could send one tiny prompt
with the key. Implementing the probe is child task 2, not part of this design task.

Implemented in task-14.3:

- The helper is `docker/minions-sandbox/minions-sandbox.c`, built statically in the `sandbox` stage of
  `docker/Dockerfile`.
- The rules JSON contract and per-role generation are in `src/runtime/sandbox/rules.ts`. Generation refuses any
  rule that would open or contain a protected path. The helper refuses unknown keys.
- The self-test is `minions-sandbox --self-test <rules>`. It prints one tab-separated `check` line per canary and a
  `result` line. `src/runtime/sandbox/selftest.ts` parses this strictly: a missing canary, an error or a skip
  outside x32/compat on non-x86_64 is a failure, whatever the helper says.
- The probe runs in the container as `minions work probe --json` (internal). `status --check` / `doctor` show
  `harness.<id>` (and `harness.network` warnings) only when a process harness is configured.
- The helper's supervisor kills what the harness leaves behind as soon as the harness exits, not only on SIGTERM.

Addendum (task-14.3 QA fixes). Landlock does not govern TCP Fast Open, metadata writes or scheduling, so
seccomp now covers them too:

- **TCP Fast Open.** `sendto`/`sendmsg`/`sendmmsg` with `MSG_FASTOPEN` and `setsockopt(TCP_FASTOPEN_CONNECT)` fail
  with `EOPNOTSUPP`, because they connect without `connect()` and so bypass the TCP allowlist. `TCP_FASTOPEN` on a
  listener stays allowed, since it only affects inbound connections. x32 and i386 `socketcall` are already killed.
- **chmod via seccomp notify.** Git needs path chmod on its own files (`git init` fails without it), and seccomp
  cannot see a path. So `chmod`/`fchmodat`/`fchmodat2` return `SECCOMP_RET_USER_NOTIF`. The supervisor sits outside
  Landlock and receives the listener fd over a socketpair. It reads the path from `/proc/<pid>/mem` and resolves it
  with `openat(O_PATH)` against the worker's root, cwd or dirfd. It accepts the result only if `/proc/self/fd/N` is
  inside the realpath of a writable rule. It then chmods that pinned inode itself and never answers CONTINUE, so
  rewriting the path after the check gains nothing. Anything else gets `EPERM`. `fchmod(fd)` stays allowed. The
  handler re-checks `SECCOMP_IOCTL_NOTIF_ID_VALID` after opening `/proc/<pid>/mem` and the base, so a recycled pid
  cannot redirect it. It follows the kernel on flags: an empty path is `ENOENT` unless `AT_EMPTY_PATH` (then the
  dirfd itself), `AT_SYMLINK_NOFOLLOW` on a symlink is `EOPNOTSUPP`, and a bad pointer is `EFAULT`.
- **Denied outright (`EPERM`):** the chown family, set/remove xattr (`l`/`f` variants and the 6.13 `setxattrat`/
  `removexattrat` included), `file_setattr`, and `utime`/`utimes`/`futimesat`/`utimensat`. The `*at` xattr forms
  matter: a `system.posix_acl_access` ACL rewrites the mode bits (chmod 000 under another name), and `setxattrat`
  works on an O_PATH fd, which Landlock lets a worker open on a protected file. These numbers come from the unified
  table (463, 466, 469 on both architectures). Seccomp does not rely on Docker's profile here.
- **Terminal injection.** `ioctl(TIOCSTI)` and `ioctl(TIOCLINUX)` fail with `EPERM`: the harness keeps fds 0-2,
  which may be a terminal the runner shares with the coordinator, and `legacy_tiocsti` may be on, so it could
  otherwise type into that terminal. The wrapper's `setsid` (round 4) drops the controlling tty, which the
  kernel's TIOCSTI check wants, but the filter does not rely on that. Other ioctls are untouched.
- **Self-only scheduling.** `setpriority`, `ioprio_set`, `sched_setaffinity`/`setscheduler`/`setattr`/`setparam`
  and `prlimit64` are allowed only when the target argument is 0 (the caller). Any explicit pid, pgrp or -1 is
  denied, because otherwise a worker could slow down or limit the coordinator. `setpriority` must also name
  `PRIO_PROCESS` and `ioprio_set` `IOPRIO_WHO_PROCESS`, so 0 is always the calling process. The group forms
  (`PRIO_PGRP`, `IOPRIO_WHO_PGRP`) are denied even with 0: 0 means "my current group", and `setpgid` can make
  that any group of the caller's session (round 4). `PRIO_USER` with 0 means every process of the uid.
  `getpriority` only reads, so it may name `PRIO_PROCESS` or `PRIO_PGRP` with 0, but not `PRIO_USER` or an
  explicit target.
- Self-test canaries: `tcp.fastopen`, `socket.mptcp`, `meta.{chmod,chown,setxattr,setxattrat,removexattrat,
  file_setattr,utimensat}`, `sched.{setpriority,setaffinity,ioprio,prlimit,getpriority-user,setpriority-which,
  setpriority-pgrp,ioprio-pgrp}`, `proc.setpgid-outside`, `ioctl.{tiocsti,tioclinux}` and
  `control.chmod-scratch`. `io_uring.setup` requires the helper's own `ENOSYS`, and
  the newer canaries require its own `EPERM` (`EACCES` for MPTCP), so a dropped rule fails even where the kernel or
  Docker's profile would also refuse the call. Each probe is harmless if the rule is missing (a non-tty, an
  out-of-range `which`, a user xattr, a NULL `file_setattr` buffer).

Accepted residual risks:

1. **`fchmod` on a read-only fd.** A worker can still fchmod a same-uid file it may read but not write, such as a
   git object. A chmod 000 there would break the shared repo for others. Accepted because objects are
   content-addressed and secrets and state cannot be opened at all. Recovery is `chmod -R u+r <common>/objects`:
   `git fsck` or a refetch does not repair it, because the object exists and is merely unreadable.
   To close it, route `fchmod` through the notify handler too (checking `/proc/<pid>/fd/<n>` against the writable
   set).
2. **No timestamp or xattr changes, even in the worktree.** `touch -d`, `cp -p` and tar mtime restore fail inside
   the sandbox. Accepted because git and the harnesses do not need them. To close it, handle `utimensat` in the
   notify handler like chmod.
3. **Scheduling calls must name 0, not the caller's own pid or tid.** For example, `pthread_setaffinity_np` with a
   tid gets `EPERM`. Accepted because the harnesses do not pin threads and the failure is a harmless error. To
   close it, have the notify handler allow ids that belong to the sandbox's own tree.

Addendum (task-14.3 round 4: process groups). The filter used to allow `setpriority(PRIO_PGRP, 0, …)` and
`ioprio_set(IOPRIO_WHO_PGRP, 0, …)` on the premise that group 0 is the sandbox's own. It is not a fixed group:
`setpgid(0, X)` accepts any group X of the caller's session, and the wrapper used `setpgid(0, 0)`, so the harness
stayed in the runner's session. A worker could join the runner's group and then renice or IO-idle every same-uid
member of it (shown live against the previous build: nice 0 → 7, IO class idle). Two layers now close it:

1. **The filter** allows the set calls only in the process form with target 0 (see "Self-only scheduling").
   `getpriority` keeps `PRIO_PGRP`, because reading changes nothing.
2. **Own session.** The wrapper calls `setsid()` instead of `setpgid(0, 0)`. A new session contains only the
   wrapper and its descendants, so `setpgid` into the runner's or coordinator's group fails with `EPERM`. Options
   considered:
   - Filtering `setpgid` (allow only `pgid` 0 or the caller's own pid) was rejected. Seccomp cannot tell whether a
     pgid belongs to the sandbox, so the filter would also break job control inside the sandbox (a shell
     moving a child into an existing job's group). The session boundary is enforced by the kernel and needs no
     list.
   - Making only the harness child call `setsid` was rejected. Its group would then differ from the wrapper's,
     and `kill(-pgid)` by the runner or `reapRun` after a wrapper SIGKILL would no longer reach the tree.

   With `setsid` in the wrapper, the wrapper's pid is still the session's pgid, so `signal_tree`, the
   subreaper loop, both parent-death signals and `kill(-pgid)` work as before. The harness loses the controlling
   tty. Process harnesses run with pipes and `TERM=dumb`, so nothing needs it, and it also takes away the
   ctty condition the kernel's TIOCSTI check wants. Terminal signals (Ctrl-C, hangup) no longer reach the
   sandbox directly. They reach the runner, and when it exits the wrapper's death signal stops the tree.

   `setsid` fails for a process-group leader. A wrapper that already leads its own session (Node `detached`,
   `setsid -w`) keeps it. A group leader in another session (an interactive shell job) is refused with a hint
   to use `setsid -w`, because running in a shared session would reopen the join. One gap is accepted: a
   session leader that started other jobs before it exec'd the wrapper (a login shell running
   `exec minions-sandbox`) shares its session with them. There the filter is the only layer. The runner never
   starts the wrapper that way.
3. **Canaries and escape test.** `sched.setpriority-pgrp` and `sched.ioprio-pgrp` (own group, current values, so a
   dropped rule changes nothing) require the helper's own `EPERM`. `proc.setpgid-outside` tries to join the
   runner's group from a throwaway child and must get `EPERM`. `test/runtime/sandbox-escape.test.ts` (round 4)
   spawns a lone outside process that leads its own group in the test's session. The worker calls `setpgid`
   into that group, then `setpriority(PRIO_PGRP, 0, 7)` and `ioprio_set(IOPRIO_WHO_PGRP, 0, idle)`. All three
   must be `EPERM`, and the outside process's own reading of its nice value and IO priority must not change. The
   test also checks that the harness's session and group are the wrapper's.

### D8. Config shape, schema impact, CLI surface

```jsonc
"harnesses": {
  "default": "claude",                    // harness for every worker role without its own; "claude" | "codex" | "junie"
  "codex": {
    "models": { "default": "gpt-6.1-sol", "allowed": ["gpt-6.1-sol"] },   // harness-native ids; owner-chosen
    "effort": "high",                     // optional
    "timeoutMinutes": 60                  // wall clock per attempt (D3.6)
  },
  "junie": {
    "models": { "default": "sonnet", "allowed": ["sonnet", "opus", "gpt"] },   // Junie aliases [J-models]
    "timeoutMinutes": 60
  },
  "network": { "tcpConnectPorts": [443] }   // optional; Landlock TCP connect allowlist for every process worker (D4)
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
  - `models.selection: "fixed"` means `harnesses.<id>.models.default` for that harness;
  - `harnesses.network.tcpConnectPorts` holds ports 1 to 65535 and is never empty (443 is needed by the harness
    itself).

  Two mapping rules (they fit roles-and-workflows D3, D8 and D9; `harness` is a new D9 override field, and built-ins
  change only by a host edit or a setup answer):
  - **`engineer-deep` on a process harness** uses the same harness and the same model as `engineer`. It differs
    only in effort, as it does for Claude: `engineerDeepEffort()` (`roles.engineer.deepEffort` >
    `effortByRole.engineerDeep` > one level above the engineer's) is mapped onto the harness's effort scale. For
    Codex that is `model_reasoning_effort`; for Junie it is `--effort low|medium|high`, clamped to `high`. When a
    harness has no effort control (`capabilities().effort === false`), `-deep` runs like the base role, and
    `work next` says so in its `launch` entry. The same applies to project roles with `deepVariant`.
    `execution.maxByRole.engineer` counts both variants, whatever the harness.
  - **Workflow stage `model` hints cannot name a harness.** The harness is per role. A hint is a model id validated
    against the stage role's harness, so a Codex model hint on a Claude-harness role is a config error. A stage
    that should run on another harness uses a project role with its own `harness`, for example `codex-reviewer`
    (D9).

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
`harnesses.default: <id>`. In phase 1 it applies only to the roles the chosen phase 1 option allows (D9). Setup says
so plainly (option a: "engineers will use Codex, one at a time; testing, review and coordination stay on Claude
Code until a later version") and still needs Claude credentials for the rest. Per-role mixing is a settings or
config edit, not a setup question.

### D9. Phase plan

| Phase | Process harness allowed for | Coordinator | Notes |
| - | - | - | - |
| 1 | The roles of the chosen phase 1 option (below), container runtime only | Claude Code | `work run`, per-lease clone and fetch-back, run record and recovery, L1 wrapper + self-test, L4 checks, Codex adapter (Junie when U-J1 is resolved), `auth codex|junie`, setup question, probe. The host runtime refuses process harnesses: the coordinator's Bash there runs inside the Claude sandbox, and Landlock-in-sandbox is unverified. |
| 2 | `producer`, `verifier` and `gate` roles (engineer, tester, reviewer, project roles); the phase 1 cap is lifted | Claude Code | Gates are read-only towards the squad through L1 and no fetch-back (D3.7.4). Mixed squads (Codex engineer, Claude reviewer) are the expected default for cross-model review. CI evidence for verifiers and gates comes only from the runtime `ci` gate, never from harness output. |
| 3 | coordinator | any | Needs a coordinator loop for a process harness (tmux session, restart, idle restart, context reset) and a replacement for every coordinator hook: pre-agent → `work run`, pre-telegram → D11, publication `ask` rules → host-signed approvals (already the real gate). Telegram for a non-Claude coordinator needs a minions-owned bot poller instead of the Claude channel plugin. Design it as its own task after phase 2 has run. |

The phase rules are code, not config: `validateConfig` refuses a role-to-harness assignment that the current phase
does not allow, and `claim` and `work run` enforce the cap.

#### Phase 1 options

The owner chooses one. Both need child tasks 1, 2, 3, 4 and 8. Option (b) can ship before the fetch-back part of
child task 3 is finished.

**(a) Engineers first, capped at one.** Process harnesses are allowed for `producer` roles. At most **one**
process-harness producer lease may be active squad-wide (a fixed phase 1 rule, counted like D3.1 capacity). Every
commit is still reviewed by the Claude reviewer.
- For: this is the brief's order and the owner's main value: engineering work and spend move to a second model.
  It exercises the riskiest path, a worker-written clone with sanitize and fetch-back plus recovery with `wip:`,
  under real use early. The cap bounds the blast radius, disk use and concurrent-runner bugs while that path is
  new. The Claude review gate catches quality problems.
- Against: the largest attack surface comes first (B1/B2 class issues live in exactly this path), and all of the
  write path must be done before the first real run. Throughput is one process engineer at a time. A weak engineer
  costs extra attempts.

**(b) Read-only reviewer pilot first.** Process harnesses are allowed only for **project gate roles**. The pilot is
one project role, `codex-reviewer` (`contract: gate`, `harness: codex`), added as an extra stage after the Claude
reviewer in one owner-chosen workflow. The built-in reviewer stays Claude, both must approve, and nothing is ever
fetched back. After the pilot, (a) follows with its cap, then phase 2.
- For: the smallest attack surface. It proves L1, the wrapper lifetime, the run record and recovery, credentials,
  usage and the Codex adapter in production, without any worker output landing on a branch. Its failure mode is
  an extra `request-changes`, not a bad commit. Cross-model review is useful from day one.
- Against: it departs from the brief's phase order. It adds tokens per task (an extra stage) instead of moving
  work off Claude. It gives no evidence about the write path, which is the part that most needs proving. A noisy
  gate slows delivery in the workflow that carries it.

**Recommendation: (b) for a short pilot (about ten tasks), then (a) with the cap.** The defects the review found
(B1 to B3) sit in the write and recovery paths. (b) runs the isolation and recovery machinery for real before any
process worker can write to a branch, and costs little extra build work, since every child task it needs is
needed by (a) too. If moving engineering spend off Claude soon matters more, (a) is acceptable: the design closes
B1 to B3, and the cap limits the damage of a remaining gap.

### D10. Test strategy

- **Fake harness** (`test/fixtures/fake-harness.mjs`, adapter id `fake`). A Node script driven by a scenario file:
  - commit in scope and write a result;
  - write out of scope;
  - no result, or a final message only;
  - sleep past the timeout, or ignore SIGTERM;
  - emit usage JSONL;
  - exit non-zero;
  - git-metadata attacks on its clone. Each must end with nothing fetched, or with the file rewritten before any
    runner git call, and a marker command must never run:
    - rewrite `<checkout>/.git` into a `gitdir:` pointer file, or replace it with a symlink;
    - add `commondir`, `gitdir` or `config.worktree`;
    - set `core.fsmonitor`, `core.hooksPath`, `include.path` or `includeIf` in the clone's config;
    - add hooks or `info/attributes` with a filter driver;
    - point `objects/info/alternates` elsewhere;
    - replace a control file with a symlink into a fixture "state" dir;
  - branch attacks: a non-fast-forward lease branch, a commit for a gate, a tree with a `.git/…` entry (fsck);
  - out-of-L1 attempts (expected to fail; with L1 off in unit tests the post-exit checks must still catch them):
    write the lease worktree or `<common>/refs`, delete a pack in `<common>/objects`, read `/state` or the secrets
    fixture, connect to a unix socket, `setsid` and double-fork.

  The runner tests use it against real git repositories in `TMPDIR`. They cover:
  - the launch gate refusals, including capacity excluding the lease itself, a second run of one lease, and a
    re-claim while a record is not `done`;
  - cancel by release, timeout and drain (wip commit plus `partial`);
  - the clone, sanitize and fast-forward-only fetch-back;
  - **concurrent writers**: during a run, another branch gets commits and `main` gets a merge. There must be no
    false violation and no rollback;
  - the violation event, submit by proxy through the real `handoff.ts`, and usage recording;
  - **orphans**: SIGKILL the runner mid-run. The tree must be gone (parent-death signal), and `work release` /
    coordinator start must run `reapRun`: the sweep, post-exit and the `wip:` commit on the branch, before the
    lease ends. A record from another boot id must go straight to post-exit.
- **Runner git helper**: every call carries explicit `--git-dir`/`--work-tree` and the hardened `-c` set. A
  planted `core.fsmonitor`/`core.hooksPath` marker never runs. `commit` and `merge` carry `--no-verify`.
- **Adapter unit tests** (pure `plan()`): exact argv/env per role and contract. No secret in argv; secrets appear
  only in `secretEnv`. Env allowlist (no `CLAUDE_*`, `GH_TOKEN`, `GIT_*`, Telegram). cwd is the checkout, never
  the lease worktree. Repo-config-off flags are present. `-deep` maps to the next effort level. Snapshot tests of
  the generated per-lease config files.
- **Config tests**: `harnesses` schema, role-harness model validation, stage hints validated against the role's
  harness, phase restrictions and the cap, back-compat (configs without `harnesses` produce byte-identical plugin
  output and briefs without `harness`).
- **Isolation self-test tests**: run the wrapper's canaries when Landlock ABI ≥ 6 is available
  (`describe.skipIf(!landlock6)`). On other machines, assert that `work run` refuses with `PRECONDITION`.
- **CLI surface guard**: `work run` and `auth codex|junie` are resolved and tiered. The coordinator guidance only
  names existing commands. The Claude-subagent hook denies `minions work run|claim|release` when `agent_id` is set
  (child task 8).
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
   cannot reach the coordinator's tmux pane: the socket is unreadable, `socket(AF_UNIX)` is blocked, and no inherited
   descriptor survives the wrapper's `close_range` (D4).
5. Anything for the owner goes into the WorkerResult `findings`, which the coordinator reads and relays. This is the
   same rule as for Claude workers.

### Addendum: child task 1 implementation decisions (task-14.2)

The owner chose phase 1 option (b). The config, registry and plumbing are in `src/config/harnesses.ts` (registry,
phase rules, effort scales), `src/config/roles.ts` (`RoleDef.harness`, `harnessConfigIssues`, `harnessRoleEffort`)
and `src/config/launch.ts` (the `launch` entry). Decisions made while building it:

- **Phase rules are data selected by `CURRENT_PHASE`** (`1b` now; `1a` and `2` are defined). `1a` allows producer
  roles (built-in and project) and keeps the project-gate allowance of `1b`, so a `codex-reviewer` pilot config stays
  valid after the switch. Both phase 1 rules carry `processProducerCap: 1`; claim (inside the lease transaction) and
  `work next` (`waitingOn: "harness-capacity"`) enforce it. Claim also refuses a role whose process harness the
  phase does not allow, for a config that skipped `validateConfig`.
- **`harnesses.default` applies only where the phase allows it.** Other roles stay on `claude` without an error, as
  D8 describes for "authorize one harness for the whole squad". An explicit `roles.<r>.harness` that the phase does
  not allow is a config error.
- **Effort stays on the minions scale in config** (`roles.<r>.effort`, `harnesses.<id>.effort`) and is mapped at
  launch. For a process role the precedence is `roles.<r>.effort` > `models.effortByRole.<r>` >
  `harnesses.<id>.effort` > `models.effort`. `-deep` follows `engineerDeepEffort` / `deepVariantEffort` on that precedence. Codex `max`
  clamps to `xhigh` and Junie clamps to `high`.
- **The brief** gets `harness` for every role. For a process role, `model` is the stage hint, then the role model,
  then `harnesses.<id>.models.default` (always the default with `selection: "fixed"`). `allowedModels` is that
  harness's list and `effort` is the mapped base effort. Claude briefs are unchanged.
- **`work next`** keeps `agentType` / `agentModel` and adds `harness` and `launch`. `launch.kind: "run"` carries
  `command: "minions work run <leaseId> --json"` (a template: the coordinator substitutes the claimed lease),
  `harness`, `model`, the mapped `effort` and `deep`. How `deep` reaches the runner is left to the runner task.
- **Claude-side guards:** the plugin generator emits no agent file for a project role on a process harness. The
  pre-agent hook denies `minions:<role>[-deep]` for any role on a process harness, so a Claude subagent cannot stand
  in for it.
- **Hardening (task-14.11, review follow-ups):**
  - A gate role on a process harness must be read-only. Whether its own `harness` or `harnesses.default` put it
    there, `validateConfig` refuses `worktree: "branch"`, `edits` other than `none` and `commits: true`
    (`roles.<r>.worktree|edits|commits`). Config validation has no warning channel, so `work next` carries a
    `warnings` list (absent when empty) naming every gate that `harnesses.default` moved onto a process harness.
  - Each lease records the harness it was claimed on (`leases.harness`, schema 7). The phase 1 producer cap counts
    active leases by that value, not by the current config. Leases from before schema 7 (NULL) count as `claude`.
    A lease whose role is no longer configured counts as a producer, so the cap errs on the safe side.
  - In `work next`, a process role without its `harnesses.<id>` block (a config that skipped validation) makes only
    its own entry `stuck`, with the reason. The other entries are listed as usual.
- **Not here:** the `fake` harness (registered with the runner, child task 3), the host-runtime refusal (the runner
  enforces it), setup and settings items, and `harness` in role proposals (child task 6).

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
- U-C6: Whether `AGENTS.md` discovery walks above the checkout (its parent is the lease scratch dir, which has
  none, and Landlock denies reading `AGENTS.md` files outside the allowlist).
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

- U-G1: Landlock ABI ≥ 6 on Linux Docker Engine hosts and other Docker Desktop versions. That needs Linux ≥ 6.12
  with Landlock in the LSM list, and a seccomp profile that allows the three Landlock syscalls. Debian 13 and recent
  Ubuntu HWE kernels qualify; the Ubuntu 24.04 GA kernel (6.8) and older LTS kernels do not, and process harnesses
  are then unavailable there. Measured only on Docker Desktop linuxkit 7.0.14 (ABI 8). Mitigation: self-test and
  fail closed. A lower-ABI fallback (no signal scoping) is not in phase 1.
- U-G2: Whether Landlock's ptrace restriction covers every `/proc/<pid>` read that could leak the coordinator's
  environment on all supported kernels. Mitigation: the self-test canary reads it.
- U-G3: Whether blocking `socket(AF_UNIX)` and limiting TCP connects to listed ports breaks common project tooling
  (Docker CLI, database clients, tests that start a local server). Expected acceptable for workers; ports are
  configurable (`harnesses.network.tcpConnectPorts`), and unix sockets are a later, explicit option.
- U-G4: Disk and time per lease. The clone shares objects, but each running process worker has its own checkout,
  `node_modules` and npm cache. A per-lease npm cache avoids cross-worker poisoning. The design starts per-lease,
  with a read-only shared cache as an option. The phase 1 cap of option (a) keeps this to one engineer.
- U-G5: Usage units. Non-Claude token counts are tallied as tokens in the task-32 budget. USD estimates exist only
  for Claude API-key billing, and per-harness pricing is not configured. The budget wording says "approximate
  across harnesses".
- U-G6: The escapee sweep (D3b) relies on `Seccomp_filters` in `/proc/<pid>/status` (Linux ≥ 5.9) and on the
  wrapper being the only source of an extra filter. The self-test checks the field. A process that is both
  outside the wrapper's tree and sandboxed some other way would be killed by mistake; no such process exists in
  the container today.
- U-G7: Absolute paths. Tools that bake the checkout path into caches or lockfiles will see
  `<scratch>/work` instead of the lease worktree. Expected harmless, since nothing outside git is fetched back.

## Child tasks

The order of 3, 4 and 7 depends on the phase 1 option (D9). Under option (b), child task 4 starts with the gate
plan and child task 3 can ship without fetch-back.

1. **Harness config, registry and brief/next fields.** `harnesses` schema (including `network.tcpConnectPorts`)
   and JSON schema, `roles.<r>.harness` (roles-and-workflows D9 override fields), model and stage-hint validation
   per role harness, `-deep` effort mapping, phase rules and the phase 1 cap, `harness` in the brief, `launch` in
   `work next`, back-compat tests. Depends: none.
2. **Isolation wrapper and probe.** The `minions-sandbox` helper built in the Dockerfile:
   - Landlock ABI ≥ 6 filesystem, scoping and TCP connect rules, including the `/proc`, `/sys` and `/dev` read rules;
   - the seccomp filter: architecture check (x32, compat `socketcall`), socket families, `io_uring_*`;
   - `close_range`;
   - the process-lifetime supervisor: process group, `PR_SET_PDEATHSIG`, subreaper kill loop;
   - rules generation per role, the self-test canaries, and the `harness.*` checks in `status --check` / `doctor`.

   Sensitive-path review: Dockerfile build stage. Depends: none.
3. **Process runner and fake harness.** `minions work run`:
   - the gate, with capacity excluding the lease itself;
   - the run record under `/state/run/leases/<id>/`;
   - brief and submit by proxy;
   - the per-lease clone, the shared-side snapshot, post-exit sanitizing and fast-forward-only fetch-back with fsck;
   - the hardened runner git helper (D3a; `git-hardening.ts` extended to the container runner);
   - supervise, cancel, timeout, drain `wip:` / `partial`, usage.

   Also the fake adapter, the runner tests (including the git-metadata, concurrent-writer and orphan scenarios),
   and the CLI surface guard. Depends: 1, 2.
4. **Codex adapter.** `plan()`, JSONL usage parser, WorkerResult output schema, pinned install in the image
   behind the fingerprint, `auth codex` credential kind, opt-in live test; resolve U-C1–U-C8. Depends: 3.
5. **Junie adapter.** Same for Junie; resolve U-J1–U-J6 first (blocking: U-J1). Depends: 3.
6. **Setup, settings and coordinator guidance.** Setup question ("authorize one harness for the whole squad",
   limited to the phase's roles), settings items, orchestrate skill and `coordinator.md` (`launch.kind: run`),
   README section, docs/cli.md. Depends: 1, 4.
7. **Phase 2: all verifier and gate roles on process harnesses.** Lift the phase rule and the phase 1 cap, reviewer
   and tester plans, tests. Depends: 3, 4, 8, and a phase 1 run.
8. **Orphan recovery and launch guards.**
   - `reapRun` in `work release`, the stale-lease path and coordinator start (`coordinator restart --recover`);
   - the escapee sweep;
   - the re-claim gate in `work claim`;
   - idle-restart and restart counting of records that are not `done`;
   - the recover skill text for process workers;
   - the Claude-subagent `PreToolUse` hook that denies `minions work run|claim|release` when `agent_id` is set.

   Template and hook changes only; no sensitive paths. Depends: 3.

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
