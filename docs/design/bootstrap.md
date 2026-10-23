# Bootstrap build (v0.1) — design contract

This is the working contract for the first installable version. It narrows
[docs/spec.md](../spec.md) to the smallest complete terminal workflow (spec §25)
so minions can then develop itself. Anything listed under "Deferred" must be
reported as unavailable by `doctor` and the wizard, never faked.

## Scope

In:
- Host CLI: `init [path]`, `doctor`, `start`, `down`, `status`, `pause`, `resume`,
  `import`, `export`, `config show`, `auth show|set|refresh`, `auth github`, `auth telegram`, `channel show|set`, `runtime show|set`, `setup [path]` (guided; subcommands `setup github`, `setup assist`), `upgrade`, `uninstall`. All support `--json`; mutating ones `--dry-run`.
- Runtime CLI (inside container): `backlog ready|list|show|create|update|note`,
  `work claim|record|release|list`, `hook stop|pre-agent`, `coordinator`, `status`, `pause`, `resume`.
- Profiles `project-owner`, `personal-work`, `supervised`; shared + private visibility.
- Backlog.md backend only. Delivery modes `local` (default; commits on `agent/<slug>` branches in the container clone, fetched to host with `minions export`), and, for the github provider, `branch` and `pull-request` (see "Branch and pull-request delivery"). minions never merges pull requests; with `local` delivery the coordinator integrates approved branches into the container's local base (project-owner automatically, personal-work after asking, supervised never).
- Terminal communication, plus optional Telegram through the official channel plugin (see [telegram.md](telegram.md)).
  `communication.channel` is `terminal`, `telegram`, or `auto` (profile default: Telegram when a bot token is stored
  and the runtime is docker, else terminal); resolved by `resolveChannel` (`src/telegram/channel.ts`), switched with
  `minions channel set` (see "Communication channel").
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
review publication, config plan/apply transactions, backlog migration, upgrade plan and schema migration,
budgets, companion containers, GitHub App short-lived tokens (the fine-grained PAT in "GitHub credential"
is used instead), CODEOWNERS mapping of sensitive paths, shared backlog versioned in Git.

## Recorded low-impact decisions

- Node >= 22.13 (built-in `node:sqlite`, unflagged). ESM, TypeScript, bundled with esbuild into `dist/cli.js` so the package has **no runtime dependencies** and the image needs only Node.
- Runtime deps bundled: `commander` (parser), `zod` (validation). Dev: `typescript`, `esbuild`, `vitest`, `@types/node`.
- Interactive prompts use `node:readline/promises`; no prompt library.
- Plugin name `minions`; agents `engineer`, `tester`, `reviewer` resolve as `minions:engineer` etc. Skills `orchestrate`, `status`, `intake`, `recover`, `maintain-context` resolve as `/minions:<name>`.
- Backlog.md project lives in `/state/backlog` for **both** visibilities in v0.1 (single writer, never on implementation branches). Versioning a shared backlog in Git is deferred.
- Container reads effective config from a read-only mount; it cannot change config in v0.1.
- Workspace is seeded from a Git bundle of the host repo's committed HEAD branch (`minions import`), so no GitHub credentials are needed. The real `origin` URL is recorded; it is fetched (over https, via the credential helper) only when a GitHub token is mounted.
- Commits inside the container use the host's `git config user.name/email` (copied as plain values at init, shown in the plan).
- Coordinator permission mode defaults to `auto` (task-36; previously `acceptEdits`) with an allowlist for `minions`, `git`, and `backlog` commands; the deny (push/merge) and ask (approve) rules and `disableBypassPermissionsMode` are emitted unchanged in every mode. `coordinator.permissionMode: "acceptEdits"` opts out. The launch reads the `--permission-mode` choices from `claude --help` and falls back to `acceptEdits` (logged; reported by `coordinator --probe` and doctor) when `auto` is not listed. Never `bypassPermissions`. The deny/ask rules are command patterns that match first, so the classifier cannot approve a literal `git push`, `gh pr merge` or `minions work approve`; equivalent commands they miss (`sh -c 'git push …'`, `gh api` merges, `curl` with the readable token) are judged by the classifier instead of prompting. The boundary for those is the token scope and branch protection (see the remaining trust boundary under [Host-signed publication approvals](#host-signed-publication-approvals)).
- Coordinator startup trim (task-48): the launch passes `--disallowedTools` with COORDINATOR_DISALLOWED_TOOLS (src/config/coordinator-tools.ts, overridable by `coordinator.disallowedTools`, validated against the required tools) and adds `env.ENABLE_TOOL_SEARCH="true"` and `disableBundledSkills: true` to its `--settings` (`coordinator.toolSearch: false` / `coordinator.bundledSkills: true` opt out). Cause, from the session transcripts (Claude Code 2.1.292 both times): the 27.9k-token session ran with tool search on (14 tools inline, 31 deferred, ~96k chars of tool definitions) while the 55.2k session had it off (all 35 tools inline, ~224k chars). Claude Code decides tool search per session from account and feature-flag state (the earlier session carried an org credential and claude.ai connectors), which minions does not control, so the launch now sets it explicitly. Measured with the launch argv on haiku in `-p` mode: first-turn input 38.7k tokens before, 21.8k after. Worker agents keep their own `tools:` allowlists, which name none of the removed tools.
- Pinned in image: base `node:22-bookworm-slim` (digest pinned in Dockerfile), `@anthropic-ai/claude-code@2.1.292`, `backlog.md@1.54.0`. Tested range documented in `docs/compatibility.md`.
- No `--append-system-prompt-file` exists in Claude Code 2.1.292; the launcher reads the coordinator prompt file and passes it with `--append-system-prompt` as an argv element (no shell).
- One coordinator per project (spec §447, task-17): the runtime DB lock (`meta.coordinator_lock`, `{pid, session, acquiredAt}`) is enforced by `minions coordinator run`, on top of `tmux new-session -A` (which only dedupes one session name on one tmux server). The holder is the wrapper, which spawns claude as a child (no exec) and releases the lock when claude exits; it is taken before the launch record is written, so a refused duplicate changes nothing. Takeover rule: a holder whose pid is gone (SIGKILL, container restart) is replaced; on Linux a live pid whose `/proc/<pid>/cmdline` is not a coordinator wrapper counts as gone (pid reuse). Restarts (`coordinator restart`/`sync`, upgrades, idle self-restart) cannot deadlock or leave the project without a coordinator: the wrapper escalates a forwarded SIGHUP/SIGTERM to SIGTERM (4 s) and SIGKILL (8 s) on its own claude child; after `kill-session` the sync waits up to 15 s for the old wrapper to release, then SIGTERMs the lock holder and, 5 s later, SIGKILLs its claude children and the holder. Each signal goes only to a pid re-checked right before it (still the pid the project lock names or its direct child, alive, `/proc` cmdline `coordinator run` or `claude`); without `/proc` nothing is signalled and the restart fails with CONFLICT instead of relaunching. A (re)launch reports `running` only once the new wrapper holds the lock (or its session outlived the wrapper's 10 s lock wait); a session that ends first is an error. A starting wrapper waits up to 10 s for a live holder before refusing with CONFLICT ("attach with `minions start`").
- Lock hardening (task-38): the lock also records the holder's process start time (`start`, `/proc/<pid>/stat` field 22). A live pid whose start time differs from the recorded one is not the holder, so a reused pid (a tmux client whose argv carries `minions coordinator run`, or `minions coordinator sync/status`) is never waited for or signalled; the cmdline check now requires `coordinator run` and rejects a `tmux` argv[0] (older locks without `start`). Without `/proc` a live pid still counts as the holder and is never signalled. The probe window between taking the lock and spawning claude (Telegram probe, `claude --help`, any start-up work) is guarded: the wrapper installs SIGTERM/SIGHUP/SIGINT/SIGQUIT handlers before it awaits the lock (task-40; installing them right after the lock left a few microtask hops in which a signal took Node's default action with the lock held); a signal there cancels the launch (no claude, no launch record), releases the lock if it was taken, writes the exit record and exits 128+n at once. A signal during the wait for a previous holder ends the wait without taking the lock. runCoordinator hands the guard over to its own handlers in the same tick it spawns claude. A re-entrant acquire (same pid and session) whose recorded start time differs from the caller's (both known) is a reused pid, i.e. a new holder: it gets a fresh `acquiredAt` and a `coordinator-lock` event (task-40), so a relaunch watching `(pid, acquiredAt)` and the context-reset session scope both see the handover. Before the wrapper's SIGKILL escalation (and the sync's SIGKILL of a stuck holder's claude) claude's descendants, the MCP servers such as the Telegram poller, are SIGKILLed deepest first, each re-verified through its `/proc` parent; the pane's process group is never signalled. Without `/proc` they rely on the stdin EOF they get when claude dies.

## GitHub credential

A per-project fine-grained personal access token, provisioned only by the host CLI
(`src/host/credentials.ts`). Inside the container git and gh use it (see "GitHub in the
container"), and branch/pull-request delivery publishes with it; `minions sync` and doctor read PR and CI state with it (read-only, see "CI awareness").

- **Entry.** `minions auth github`, or the guided GitHub setup (see "GitHub setup"), reads the token from the host terminal in raw mode with
  no echo, or from a pipe with `--stdin`. There is no `--token` flag; the token is never in argv,
  config, the plan, logs, or `--json` output. The wizard questions themselves never ask for secrets.
- **Guidance.** Setup prints the creation link (`https://github.com/settings/personal-access-tokens/new`,
  pre-filled as a GitHub template URL by the guided setup) and the repository permissions: Contents
  read/write, Pull requests read/write, Checks read, Actions read, Commit statuses read, Metadata read.
  Nothing else.
- **Verification.** Before storing, `GET /repos/<owner>/<repo>` (or `/user` without a GitHub
  remote) with the token in the `Authorization` header only. 401/403/404 → not stored. A network
  failure stores it with a warning. `doctor` repeats the call and reports
  `github.credential: ok | missing | invalid | unverified`.
- **Storage.** macOS Keychain (generic password, service `minions.github`, account = project id)
  when `security` works; on Linux the Secret Service keyring through libsecret's `secret-tool`
  (attributes `service=minions.github`, `account=<project id>`; the token goes on stdin) when a
  session bus and a Secret Service provider answer; otherwise `<host data root>/credentials/<projectId>/github-token`
  (0600 file, 0700 dirs). `MINIONS_CREDENTIAL_STORE=file|keychain|secret-service` overrides. Storage is refused
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

## GitHub setup

Decision record for the guided flow (`src/host/github-setup.ts`): run after the plan is applied by an
interactive `minions init` (intro question, default yes; failures never fail init) and standalone by
`minions setup github`.

- **Non-interactive** (`--yes`, `--config`, `--json`, no TTY, `--dry-run`): inspection plus next-step
  hints only. No prompt, no push, no browser, no network.
- **Inspection** uses local data only: `remote.origin.url`, `refs/remotes/origin/<base>`, the stored
  credential reference, the effective config. Nothing is fetched or `ls-remote`d.
- **Remote.** Missing: offer `git remote add origin <https url>` for a validated `owner/repo` / github.com
  URL (command shown; `project.json` `remoteUrl` updated). A non-GitHub `origin` is never changed.
- **Base branch.** Missing tracking ref: show `git push -u origin <base>`; run it (exactly
  `refs/heads/<base>:refs/heads/<base>`) only after an explicit yes (default no), with the user's own git
  credentials.
- **Token link.** GitHub template URL (docs.github.com "Managing your personal access tokens" →
  "Pre-filling fine-grained personal access token details using URL parameters"; changelog 2025-08-26):
  `name` (≤ 40 chars), `description`, `target_name` (= remote owner), `expires_in=90`, `contents=write`,
  `pull_requests=write`, `actions=read`, `statuses=read`. Repository selection and Checks are picked by hand.
  `open <url>` (macOS) only after a yes (default no).
- **Token entry** reuses the non-echoing prompt and `provisionGithubToken` (verification first; up to two
  attempts). A stored token is re-checked with `githubCredentialStatus`.
- **Delivery.** With a working token and `git.push` not denied: `local/branch/pull-request` (default
  pull-request). Written to the project config file (private `config.json` or shared
  `.minions/config.json`) with `configRevision + 1`, validated by `resolveEffective`, only if the file
  still has the manifest hash; otherwise the exact edit is printed.
- **Doctor/start.** `doctor` adds `github.setup` (remote, base on origin, token, delivery, next step).
  `start` prints one hint line when a GitHub remote exists and no token is stored.
- **Not offered:** reusing the user's `gh` CLI login (broader than one repository).

## Setup assistant

Decision record for `src/host/assistant.ts` (templates in `templates/assistant/`): an AI pass after the
deterministic init. `minions init` stays complete without it.

- **When.** End of an interactive `minions init` (after the plan is applied and verified and the GitHub
  and Telegram steps ran): `Open the setup assistant to finish remaining setup? [Y/n]`. Never with
  `--yes`, `--config`, `--json`, `--dry-run`, or without a TTY on stdin and stdout. No question (one hint
  line instead) when `claude` is not on PATH; a failed launch never fails init. Standalone:
  `minions setup assist` (needs a terminal; `--dry-run [--json]` prints the argv and writes nothing).
- **Launch.** The user's own host `claude` (foreground, inherited stdio, `shell: false`) in the repository
  root. A host plugin is regenerated on every launch at `projects/<id>/assistant-plugin`
  (`.claude-plugin/plugin.json` name `minions-setup`, skill `skills/setup/SKILL.md` -> `minions-setup:setup`;
  passes `claude plugin validate --strict`). argv (flags checked against `claude --help` 2.1.292):
  `--allowedTools <read-only...> --disallowedTools <denied...> --plugin-dir <dir> --append-system-prompt
  <system-prompt.md> --settings '{"permissions":{"disableBypassPermissionsMode":"disable"}}' --name
  "minions setup" --permission-mode default "<kick-off prompt>"`. The variadic tool lists come first so
  they never swallow the positional prompt. `default` is accepted by 2.1.292 (its help lists the same mode
  as `manual`); never `bypassPermissions`, `acceptEdits`, `auto` or `dontAsk`.
- **Allowed without a prompt:** `Bash(minions doctor*)`, `Bash(minions status*)`, `Bash(minions auth show*)`,
  `Bash(minions config show*)`, `Bash(minions runtime show*)`, `Bash(git remote -v)`, `Bash(git status*)`,
  `Bash(git log*)`, and `Read(//<repo root>/**)` (Claude Code applies Read rules to Glob/Grep as well). Never a
  bare `Read`/`Glob`/`Grep`, which would read any file on the host. Everything else (reads outside the repository,
  every `Edit`) prompts. Read denies also cover every project's `secrets/` and `credentials.json`, the credential
  store and the host secret dirs shared with the host-runtime hardening (`HOST_SECRET_DIRS`).
- **Denied** (the user runs them as `! <command>`, so secrets are typed only at minions' hidden prompts):
  `minions runtime set`, `minions auth set|github|telegram|refresh`, `minions setup github`, `minions start`,
  `minions uninstall`, `security *`, `gh auth token*`, `cat *secrets*`, `cat *credentials*`, `git push*`,
  `open *`. `Read` of the credential store, the project `secrets/`, `~/.ssh`, `~/.aws`, `~/.config/gh`,
  `~/.netrc`, `.env*`. `Edit` of `defaults.json`, `registry.json`, the credential store, and the project's
  `project.json`, `credentials.json`, `secrets/`, `manifest.json`, `journal.json`, `compose.yaml`,
  `plugin/`, `runtime/`, `host/`, `assistant-plugin/` (absolute `//path` rules). The project configuration
  (`.minions/config.json`, or the private `config.json`) stays editable with a prompt.
- **Instructions.** Context first (`minions doctor --json`, `minions status --json`, `minions auth show
  --json`, `minions config show --explain`, `git remote -v`, build and CI files), then only the gaps:
  GitHub (`! minions setup github`), Claude authorization options (`! minions auth set ...`), Telegram
  (optional; `! minions auth telegram`), verification commands from the repository's real scripts/CI
  (diff first, `configRevision + 1`, validated with `minions config show --explain`), models/effort
  (budgets are not enforced in v0.1), doctor warnings, and first tasks. `minions backlog ...` is
  runtime-only (no host delegation), so first tasks are handed to the user as a message for the
  coordinator. Hard rules: no secrets in chat, no host-side file edits, no runtime switch, no push, no
  URLs opened; ends with `minions doctor` and a done/remaining summary.
- **Doctor.** A `setup` check warns on obvious gaps (empty `verification.commands`, GitHub remote without a
  token, Telegram selected without a valid bot token) and hints `minions setup assist`.
- **Uninstall** removes `assistant-plugin/`.

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

- **Config.** Both modes need `delivery.provider: "github"` (cross-field validation). `merge` defaults
  to `disabled`; `auto-when-eligible` is the opt-in CI-gated auto-merge (see "CI-gated auto-merge"),
  reported unavailable until its configuration prerequisites hold; `manual` validates but stays deferred.
  `project-owner` defaults to `pull-request` only when the repository has a github.com remote **and** a
  token is already stored for the project; otherwise `local` with a note. The init wizard offers
  `local/branch/pull-request` under the same condition and otherwise shows the reason and keeps
  `local` (also for `--config` files that ask for branch/PR delivery). `doctor` `merge.readiness`
  reports whether PR delivery is available and whether auto-merge is off, ready, or not usable (with reasons).
- **Where publication runs.** Synchronously inside `minions work record` when a reviewer approval is
  accepted (tester evidence for the same head and config revision as before), plus
  `minions work publish <taskId>` to retry. One `publications` row per task (DB schema 2; schema 3 adds `approvals.signature`) is
  written in the same transaction that ends the reviewer lease (`pending`, bound to the approved
  head and config revision), so a crash between approval and publication is resumable. The response
  carries `publication` (`state`, `status`, `prUrl`, `merged`, and `merge` when auto-merge is on).
- **Outcomes.** `published` → backlog `delivered` with `prUrl` (pull-request mode) and `branch` in the
  task meta; an open PR is reported as delivered, never merged. `awaiting-approval` → `awaiting-human`.
  `failed` (network, auth, permission, diverged remote, moved branch, stale evidence) → `blocked`
  with a note; the local branch and worktree are never touched. Nothing is reported delivered until
  publication succeeded.
- **Gates (deterministic).** `git.push` (and `pr.create` in pull-request mode) are evaluated with
  `can()` against the paths changed by `git diff --name-only --no-renames <base>...<head>` (renames split
  so moving a file out of a sensitive path counts). The changed paths are the union over every base the
  gate knows of: the base SHAs recorded in the runtime DB when the task's leases were claimed
  (`leases.base_sha`), origin's current base as read from the server with `git ls-remote` (when that
  commit is present locally), and the workspace's `refs/heads/<base>` / `refs/remotes/{origin,host}/<base>`.
  The local refs are movable by in-runtime code (`git update-ref`), so they can only add paths; at least
  one of the first two must resolve, otherwise publication fails closed (`PRECONDITION`, nothing
  pushed). Moving the local base ref to the branch head therefore no longer empties the diff
  (task-1.12). A base with no merge base against the head (unrelated history) fails the gate with
  `PRECONDITION` (not retryable): it is a state problem, and the base is never skipped, so no path can
  drop out of the union (task-40). Local delivery never runs this gate.
- **Where the gate's bases come from (trust boundary, task-40).** `leases.base_sha` is written by the
  scheduler at every claim (each stage of each attempt) from the workspace's *local* base ref at that
  moment (`resolveBaseBranch`: `refs/heads/<base>`, else `refs/remotes/host/<base>`, else
  `refs/remotes/origin/<base>`). The runtime records it, but its value is only as trustworthy as that
  ref was at claim time, and the ref is agent-writable (worktrees share the repository's refs). It
  is a good anchor because the *earliest* claim of a task predates the task's own commits; later
  claims add bases, never remove one. Origin's base is read with `git ls-remote` against the remote;
  in the container that is the `origin` remote, which resolves through the workspace git config
  (`remote.origin.url`, `url.<x>.insteadOf`, `remote.origin.uploadpack`), and that config is
  agent-writable, so an agent can point the "server" read at a repository it controls. The host
  runtime passes the normalized https URL instead and hardens git (`src/runtime/git-hardening.ts`:
  only https for network operations), but repository-level `url.<x>.insteadOf` rewrites from one
  https URL to another still apply. Neither source is trusted to *remove* a path: each base can only
  add paths to the union, which is why the union stays safe when one of them is forged.
- **Decision (task-40): main merged into a branch after the claim is still over-reported.** When main
  moves on after a task's first claim and the branch merges it, the diff against the earliest recorded
  base also lists main's own changes, so sensitive paths main changed ask for approval again. Fixing
  that means *excluding* paths explained by a later base (dropping an older recorded base when a later
  one supersedes it, or subtracting paths that a later base already has). Every such scheme trusts the
  later base to be genuine main: a later `leases.base_sha` comes from the agent-writable local ref at
  that claim, and origin's base comes through agent-writable git config (above). An agent that sets
  `refs/heads/<base>` to its own commit before the next claim (or redirects `ls-remote`) would then
  hide its own sensitive change, while today the earliest base still reports it. Over-reporting costs
  an approval; hiding costs the gate, so the union stays. A safe fix needs a base the agents cannot
  influence, for example origin's base read with `ls-remote` from a neutral directory with no
  repository or global config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, only the
  credential helper via `-c`), diffed with `--no-replace-objects`, and then only used to drop
  *recorded* bases that are its ancestors, never the remote base itself. That is a separate design task. `deny` fails. `ask` — including the
  sensitive-path upgrade allow→ask — requires a **host-signed** human approval for exactly that head
  (see "Host-signed publication approvals" below; a new commit needs a new approval). The coordinator's
  Claude Code settings still put `minions work approve` under `ask` and deny `git push` /
  `gh pr merge`, but those are now defence in depth: an approval recorded inside the runtime without
  a valid host signature never authorizes publication.
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

## Host-signed publication approvals

Decision record (task-1.8; `src/core/approval.ts`, `src/host/approvals.ts`, the gate in
`publishTask`, `Scheduler.approvePublication`).

**Problem.** In task-1.4 an approval was only a row in the runtime's SQLite `approvals` table, written
by `minions work approve`, which only the coordinator's Claude Code `ask` rule guarded. Any
code-execution path inside the runtime (a worker editing a test or npm script that `npm test` runs,
or writing `/state/minions.db` directly) could insert that row and get sensitive changes published by
the normal flow.

**Decision: asymmetric signatures, private key on the host only.**

- **Key pair.** Ed25519 (`node:crypto`, no new dependency), one per project, created by the host CLI
  on the first approval. Private key: `<MINIONS_HOME>/credentials/<projectId>/approval-signing-key`
  (dir 0700, file 0600) — the host credential store, never mounted into the container and under the
  host-runtime sandbox's `denyRead`. Public key: `<project>/runtime/approval-public-key.pem`, i.e.
  `/opt/minions/config/approval-public-key.pem` in the container (the existing read-only directory
  bind, so a key created later is visible without recreating the container). The host rewrites the
  public key from the private key on every approval, so a deleted or swapped copy is repaired.
  HMAC was rejected: the verifier would need the secret, and the verifier runs in the container.
- **Issuing.** On the host, `minions work approve <taskId> --head <sha> [--by] [--note]` signs
  `{v:1, scope:"publish", taskId, head, by, issuedAt, expiresAt, kid}` and delegates
  `work approve … --signature <token>` into the runtime. Token: `mnap1.<b64url payload>.<b64url sig>`,
  the signature covering `mnap1.<payload>`. `--head` must be a full 40/64-hex SHA (no abbreviation or
  ref). Approvals expire after 7 days; a later retry needs a new one. No new top-level command: the
  existing `work approve` changes behaviour by where it runs (minimal CLI surface).
- **Recording.** Inside the runtime, `work approve` without `--signature` is refused; with one, it is
  verified (fail fast) and stored in `approvals.signature` (DB schema 3, `ALTER TABLE ADD COLUMN`).
- **Verification before push.** `publishTask` re-verifies, right after the capability gates and
  before `ls-remote`/`push`/`gh`, every token stored for that task and head against the public key.
  The DB row is only a carrier and is not trusted. It fails closed (publication stays
  `awaiting-approval`, with `approvalError` naming the cause) when there is no public key, no token,
  a malformed or tampered token, a signature from another key, another task or head, or an expired
  approval. A missing key's reason names the path that was tried; in the host runtime with
  `MINIONS_CONFIG` unset (a launch that bypassed the shim) it says so instead of suggesting a first
  approval, because the verifier then looks at the container path, which never exists on the host.
  Where the key is read from is decided without trusting the environment: whenever
  `/opt/minions/config` exists (the container's read-only bind) or `MINIONS_RUNTIME=container`, the
  verifier reads the literal `/opt/minions/config/approval-public-key.pem`; `MINIONS_CONTAINER_ROOT`,
  `MINIONS_CONFIG` and `MINIONS_RUNTIME` cannot redirect it (an agent can set or unset all three).
  Only the host runtime, which has no such directory, uses its runtime config dir (`MINIONS_CONFIG`,
  pinned by the shim). The same filesystem check refuses the host-side `work approve` (signing)
  inside the container, even with `MINIONS_RUNTIME` unset.
- **Upgrade to DB schema 3.** Approval rows recorded before schema 3 have no signature and no longer
  authorize anything. A task that was waiting for publication approval when the runtime was upgraded
  stays `awaiting-human` (`approvalError`: no host-signed approval is recorded, or no public key exists yet) until the user
  approves it again **on the host** with `minions work approve <taskId> --head <sha>`, then runs
  `minions work publish <taskId>`. The first such approval also creates the project's signing key and
  writes the public key the runtime verifies against.
- **Scope.** Every human publication approval is signed: sensitive-path changes and "ask" capabilities
  alike. Publication that needs no approval (allow, no sensitive paths) is unchanged and needs no key.

**Remaining trust boundary (what this does not protect).** The signature protects the normal
coordinator flow: in-runtime code cannot *launder* a change through minions' own publication by
writing an approval row, a state file or a CLI argument. It is not a sandbox against code that
already runs in the container. Such code can start its own `minions` or `node` process with its own
environment and code, or edit the Claude Code settings the coordinator reads (the Claude volume is
writable), and so skip the check entirely; that gains it nothing beyond direct use of the GitHub
token, which is the real exposure. It does not stop in-runtime code from using the GitHub token
directly: the token is readable inside the container (the git credential helper
and the gh wrapper need it), so a compromised worker can push any branch, or open a PR, with whatever
the token allows. In the host runtime the agents run as the user under the Claude Code sandbox, so
the separation is only as strong as that sandbox (its `denyRead` on the credential store). Two more
cases in the same class, named explicitly:

- **Host runtime: `MINIONS_CONFIG` override.** In the host runtime the verifier's key path is derived
  from `MINIONS_CONFIG` (the shim pins it to `<project>/runtime/config.json`). Code that can start
  `minions` with its own environment can point `MINIONS_CONFIG` at a directory it controls, put its
  own public key there and sign its own approvals, so that process's publication gate accepts them.
  This is the "own process, own environment" case above, not a new hole: such code could equally run
  its own `node` without the check, and either way it gains nothing beyond the GitHub token it can
  already read. The container is not affected (the key path there is the literal read-only bind,
  whatever the environment says).
- **Runtime DB rows.** The sensitive-path gate trusts the base SHAs recorded in `/state/minions.db`
  at claim time. Code that can rewrite the DB (and move the local base refs) can make those bases
  point at the head, leaving origin's base, read live from the server, as the remaining check; code
  that also moves origin's base needs push rights on the base branch, i.e. the token. Rewriting the
  DB is therefore the same trust class as using the token directly. The recorded bases are written by
  the runtime but sourced from the agent-writable local base ref at each claim, and in the container
  origin's base is read through agent-writable git config (see "Where the gate's bases come from"
  above); that is why every base can only add paths and none is trusted to hide one.

The final protection must therefore be server-side:

- **Minimal token scope.** Use a fine-grained personal access token limited to the one repository with
  `Contents: read and write`, `Pull requests: read and write` and `Metadata: read`. Do not grant
  `Workflows` (GitHub then rejects any push that adds or changes `.github/workflows/**`, whatever the
  runtime does), `Administration`, `Secrets`, `Actions`, `Environments` or any organization permission.
  Prefer a short expiry and rotate with `minions auth github`.
- **Branch protection / rulesets** on the base branch (and release branches): require a pull request,
  at least one approving review from someone other than the token owner, review from Code Owners
  (with a `CODEOWNERS` entry covering the sensitive paths), dismiss stale approvals on new commits,
  require status checks, block force pushes and deletions, and do not let the token's user bypass the
  rules. Optionally restrict the token's user to pushing `agent/*` branches with a ruleset.
- With that, a compromised worker can at worst push an `agent/*` branch or open a PR; nothing reaches
  the base branch without a human review on GitHub.

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
  the auth env (first, so runtime values win; the schema rejects `MINIONS_*`, `PATH`, `GIT_*`, `DYLD_*`,
  `SSH_*` names), tool cache variables pointing into `host/state/cache`, `MINIONS_LOG_DIR`
  (`host/logs`), unsets token, ssh-agent, git-injection and cloud-credential variables, puts `host/bin`
  first on `PATH`, and execs the installed CLI with the current Node. Processes the host CLI starts
  (`HostRuntime.exec`, delegation, tmux) get `hostRuntimeEnv`: an allowlist (`PASS_ENV`: HOME, USER,
  LOGNAME, LANG, LC_*, TERM*, TMPDIR, SHELL, COLORTERM, proxy and CA variables, CLAUDE_CONFIG_DIR) plus
  those variables, with only absolute PATH entries. tmux, the plugin hooks
  (`minions hook …`), the coordinator's `Bash(minions …)` calls and git's credential helper all go
  through it. `host/bin/gh` is `docker/gh-wrapper.sh` with the host's real gh and token path.
- **Delegation.** `status`, `pause`, `resume`, `work publish|approve`, `telegram probe|install|status`
  run the shim with inherited stdio instead of `docker compose exec`. `start` = warning → host tools
  (`tmux`, `claude`, `backlog`, `git` required; `gh` optional) → Claude key refresh (key methods) →
  token copies → shims → `workspace setup` → bundle import if the clone is missing → `coordinator sync`
  → `minions coordinator` (tmux `-L minions-<id8>` `new-session -A`). `down` = `tmux -L … kill-server`
  plus token-copy removal. `import`/`export` use the same bundle flow through
  `host/transfer/{import,exports}` (`TransferTarget`; host-owned, not agent-writable; copies open the
  source `O_NOFOLLOW` + fstat and create the target `O_EXCL`, and the dirs must be real 0700 dirs). `uninstall` kills the tmux server; `--delete-data`
  deletes `host/`.
- **Claude auth.** `login` reuses the user's own Claude Code login (no `CLAUDE_CONFIG_DIR` override).
  Key methods use `apiKeyHelper: "cat '<secrets>/anthropic-api-key'"` (shell-quoted); env values are
  not loopback-rewritten.
- **Claude Code launch.** `claude --setting-sources= --strict-mcp-config --add-dir <workspace> <state>`
  plus `--settings`. `--setting-sources` takes `user,project,local` (`claude --help`); the empty list is
  what the Agent SDK passes for `settingSources: []` (verified in its source), and `--strict-mcp-config`
  without `--mcp-config` is the SDK's form for "no MCP servers". Excluded: user/project/local hooks, MCP
  servers, plugins, statusLine, permission rules, `sandbox.excludedCommands`, repo `CLAUDE.md`
  auto-loading. Still applied: managed settings, user `sandbox.credentials` deny entries (documented),
  the minions plugin and its hooks. Login credentials are not settings, so `login` keeps working.
  `--permission-mode` is forced to `default` (the config value may come from the repository). The
  doctor/coordinator probe also requires these flags in `claude --help`.
- **Hardening (coordinator `--settings`).** Keys verified in the Claude Code 2.1.292 docs
  (code.claude.com/docs/en/sandboxing, settings-reference, cli-reference): `sandbox.enabled`,
  `autoAllowBashIfSandboxed: false`, `allowUnsandboxedCommands: false` (also makes the sandbox
  admin-required, so repository sandbox loosening is ignored), `failIfUnavailable: true`;
  `filesystem.allowWrite` = workspace, state (no home paths; caches redirected); `denyWrite` = the
  clone's `.git/config` and `.git/hooks`, tmux's socket dir; `denyRead` = `HOST_SECRET_DIRS` (keys,
  cloud CLIs, gh/hub, `.git-credentials`, `.claude.json`, `.claude/.credentials.json`, browser
  profiles, cookies, Safari, Mail, Messages, shell histories, 1Password/Vault/Terraform/Cargo/Gem/
  Maven/Gradle/OCI/Azure/gcloud), the whole minions data root, the credential store, the Claude key
  and bot-token copies, tmux's dir; `allowRead` (narrower paths re-open part of a denied region,
  documented overlap rule) = workspace, state, `host/bin`, `runtime/`, `plugin/`, `secrets/github-token`,
  toolchain dirs under `~` (`readableToolDirs`: absolute PATH entries and real paths, install prefixes
  of node/minions/claude/backlog/git/gh/tmux, known toolchain dirs; never `~` itself or a secret dir);
  `network.allowedDomains` = GitHub + npm, `allowUnixSockets: []`, `allowAllUnixSockets: false`,
  `allowLocalBinding: false`; `permissions.blockReadsOutsideWorkingDirectories: true` (Read tool
  refuses reads outside the working dirs; sandboxed commands lose `~` except working dirs, needed
  `~/.claude` parts and the global git config). Permission denies: `Read`/`Edit` of the secret dirs,
  credential store, other projects (exact paths), the key/bot-token copies, data-root `*.json`,
  `credentials.json`; `Edit` of shell rc files, `~/.gitconfig`, `~/.config/git`, `~/Library/LaunchAgents`,
  `~/.claude`, the project's host-control files (`*.json`, `runtime/`, `plugin/`, `secrets/`, `host/bin`,
  `host/logs`, `host/transfer`), the clone's `.git/config|config.worktree|hooks`, and `.claude/**` /
  `.mcp.json` in the workspace (not all of `.git`: Edit denies become sandbox write denies and would
  break commits); `Bash(security …)`, `Bash(gh auth …)`, `git -c`, `git config`, `--exec-path`,
  `--git-dir`, `--work-tree`. Allow rules: `minions`, `backlog`, `HOST_GIT_SUBCOMMANDS` (no config,
  remote, fetch or push), and verification commands that pass `safeVerificationCommand` (no globs,
  operators, quotes, substitutions; not a shell, wrapper, interpreter `-e`, or credential/network CLI).
  The Seatbelt profile in the 2.1.292 binary allows `mach-lookup` of `com.apple.SecurityServer`, so
  Keychain access is not blocked by the sandbox (see "Keychain" below). Not exercised against a real
  Claude session in tests (fakes only).
- **Git run outside the sandbox** (`src/runtime/git-hardening.ts`, used by `git()` in host mode and by
  `HostRuntime.exec('git', …)`): `-c core.hooksPath=/dev/null core.fsmonitor=false
  core.sshCommand=/usr/bin/false core.askPass=/usr/bin/false core.pager=cat core.attributesFile=/dev/null
  credential.helper=` (empties the list) + the minions helper for `https://github.com`, `gc.auto=0`,
  `maintenance.auto=false`, no submodule recursion, `protocol.allow=never`, `https` always, `file`
  always except for network ops (push, ls-remote, fetch from a URL), and ssh/git/http/ext/fd/ftp(s)/rsync
  explicitly never (a repository `protocol.<x>.allow` would beat the generic key); env without
  inherited `GIT_*`, with `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM`, askpass `/usr/bin/false`. Work-tree
  commands also get `GIT_WORK_TREE=<cwd>` (a repository `core.worktree` is not overridden by `-c`,
  tested) and empty `filter.<name>.{clean,smudge,process}` for every driver not defined only in the
  global config (read right before the call; an unsafe name fails closed). Publication and origin fetch
  name the normalized https URL instead of `origin`; gh runs with cwd `/` (it gets `--repo`).
- **Keychain.** `selectStore` returns the file store while any project (or the host-wide default) uses
  the host runtime, and `prepareHostRuntime` moves every registered project's minions Keychain items to
  the file store (`moveKeychainTokensToFileStore`). Rejected alternative: `security add-generic-password
  -T ''` (no trusted apps) prompts on every read by minions itself, and "Always Allow" re-adds
  `/usr/bin/security`. Residual: Claude Code's own login item.
- **Hooks log.** Hooks run unsandboxed, so `hookLog` opens `O_NOFOLLOW|O_APPEND`, requires a regular
  file, escapes control characters and caps lines at 2000 characters; in host mode it writes to
  `host/logs` (`MINIONS_LOG_DIR`), outside the agent-writable state.
- **tmux.** Kept on `-L minions-<id8>` (tmux's private `/tmp/tmux-<uid>`, 0700, ownership-checked):
  a `-S` socket under `<project>/host/` would exceed the 104-byte macOS socket path limit with the
  default data root. Sandboxed commands get no Unix sockets and no access to that directory.
- **Not supported in host mode:** container resources/ports, Telegram (`decideTelegram` disables it
  with a reason, `telegram install` refuses: the plugin would live in the user's Claude Code settings,
  which the host runtime doesn't load). `init --runtime host` needs the typed confirmation
  interactively or `--yes`; a `defaults.json` runtime of host is never inherited non-interactively.
- **`requireMode` is UX, not a boundary.** It reads `MINIONS_RUNTIME`, which an agent can unset inside
  its sandboxed shell; host-control files are protected by the sandbox write policy and Edit denies.
## CI awareness

Decision record for required-checks readiness, `minions sync` and CI setup guidance
(`src/runtime/ci.ts`, `ci.requiredChecks` in `src/host/doctor.ts`).

- **Read-only.** GitHub access is read-only (REST GETs plus a read-only `gh pr view` GraphQL query):
  REST reads use `gh api --method GET` in the container (the gh wrapper injects the token), or a plain
  `fetch` GET with the stored token on the host; `minions sync` reads PR state with `gh pr view
  --json`, which gh sends as a GraphQL POST carrying a query, never a mutation. minions never creates
  workflows and never edits branch protection or rulesets. The only write is the opt-in auto-merge
  pass (see "CI-gated auto-merge"), which arms/disarms GitHub auto-merge and never merges past it.
- **Required checks.** Union of classic branch protection (`GET /repos/{repo}/branches/{base}`,
  `protection.required_status_checks` unless `enforcement_level` is `off`; readable with repository
  read access, so no Administration permission is needed) and rulesets (`GET
  /repos/{repo}/rules/branches/{base}`, rules of type `required_status_checks`; 404 = no rulesets).
  `GET /repos/{repo}/actions/workflows` counts workflows. `configured` = at least one required check;
  `none` only when both sources were read; otherwise `unknown` (never treated as "none").
- **doctor.** `ci.requiredChecks` runs `minions ci status --json` in a running container; when that is
  unavailable (container stopped, older image) it falls back to host GETs if the GitHub credential is
  `ok`. Mapping to `delivery.requiredChecksConfigured`: checks present → `ok` (hint to set the flag
  when it is false); none and flag false → `unavailable` ("usable for local work and pull-request
  delivery; automatic merge unavailable") with the setup plan as hint; none but flag true → `warn`
  (never treated as zero required checks); unknown → `warn`. Never `fail`: no CI does not make doctor
  unhealthy.
- **Setup plan.** `ciSetupPlan` prints step-by-step external setup (add a workflow running the
  configured verification commands, let it report once, mark it required in branch protection or a
  ruleset, then set `delivery.requiredChecksConfigured`). Shown by `minions init` (external setup,
  GitHub remotes only; no workflow step when `.github/workflows` exists), by doctor, and by
  `minions ci status`. The installer never writes workflow files. `hasWorkflows` is tri-state: `true`
  (no workflow step), `false` (add a workflow), `null` = the workflow count could not be read (the
  workflow step is worded conditionally, "if the repository has no CI workflow yet", and never claims
  workflows are missing). With required checks configured the plan is empty unless workflows are
  definitely absent.
- **`minions sync [taskIds...]`.** One explicit pass (no LLM polling loop), host delegates into the
  container. For tasks with a `prUrl` (default: all except `done`/`cancelled`) it runs `gh pr view
  <url> --json …statusCheckRollup` and summarizes checks: `no-checks`, `awaiting-ci` (any check pending),
  `failing` (failure/timed-out/cancelled/action-required/startup-failure/stale, or status
  failure/error), `passing`. The observation is recorded as `ci` evidence bound to the PR head SHA
  (outcome `<prState>:<ciState>`, details JSON), plus a `ci-observation` event; a task note is added
  only when the outcome changes. Open PRs keep their status (`delivered`; a failing PR is reported,
  not reworked automatically). They are deliberately not moved to `awaiting-ci`: the scheduler counts
  `awaiting-ci`/`merging` as in-flight (`IN_FLIGHT` in `src/runtime/scheduler.ts`), so every open PR
  waiting on human review would hold an active-task slot (`maxActiveTasks`) and starve new work.
  `delivered` is outside that set, so open PRs cost no scheduler capacity. Reconciliation: `MERGED` → `done` (plus `merge` evidence `merged` and a note); `CLOSED` without merge → `blocked`
  with a note (only from `delivered`/`awaiting-ci`/`merging`); tasks with an active lease are never
  moved. A PR head differing from the approved publication head is reported as a warning. Per-task gh
  failures and per-task backlog write errors (for example a version conflict on `addNote`,
  `closeTask` or `updateTask`) are reported on that task's result, the remaining tasks are still
  synced, and the command exits 1; nothing is thrown away. A task whose backlog update failed gets no
  auto-merge pass in that run.

## CI as verification authority

Decision record for `verification.ciAuthority: "github"` (`src/runtime/ci-gate.ts`, the tester/reviewer
gate in `src/runtime/scheduler.ts`, `ci.authority` in `src/host/doctor.ts`). Owner direction
2026-10-19: pull requests are the primary path and CI is trusted, so tester/reviewer stages need not
re-run the full verification when CI already proved it for the same commit.

- **One gate, fail closed.** `evaluateCiGate` answers one question: did every *required* check of the
  base branch pass for exactly this head? Inputs: required checks read now through read-only GETs
  (branch protection + rulesets, as in "CI awareness"), and `minions sync` observations (`ci`
  evidence) recorded for that head SHA. States: `pass`; `fail` (a required check failed); `pending`
  (a required check is running or not reported yet, within `verification.ciPendingTimeoutMinutes`,
  default 60, counted from the first observation of the head); `timeout`; `missing` (no observation
  of this head); `unknown` (required checks unreadable or none configured, never treated as zero
  required checks; an observation without per-check results; a skipped required check); `disabled`
  (`ciAuthority: none`). Only `pass` is evidence. Observations of an earlier head never carry over.
  Checks that are not required are ignored. The same gate (`Scheduler.ciGate(taskId, head)`) is what
  the auto-merge gate (task-1.9, "CI-gated auto-merge") evaluates for the approved head.
- **Stages.** The claim brief of a tester/reviewer carries the gate for `expectedHead` (`ci`). A
  result may cite CI as `checks[]` entries with `"source": "ci"` (the check name as `command`,
  outcome `pass`/`fail`). The runtime re-evaluates the gate when recording: `pass` → the stage is
  satisfied (each `ci` entry must name a required check that passed, else a correctable validation
  error); `fail` → no approval, task → `changes-requested` (a reviewer repair cycle); any other
  state → falls back to the result's own passing local checks if it has any, otherwise no approval and
  the task stays in its stage (`testing`/`reviewing`) for a re-run with local verification. A
  blocked stage records its role evidence as `ci-<state>`, never `complete`, so publication cannot
  treat it as approved; every evaluation is recorded as `ci-gate` evidence.
- **Result contract.** `checks[].source` is optional (`local` default). `ci` entries are rejected
  without `ciAuthority: github`, from engineers (they always run targeted local checks), and with
  outcome `skipped`. A worker's claim about CI is never evidence by itself.
- **Partial reads are unknown.** Required checks are `configured` only when both sources were read
  (branch protection, and rulesets or a 404 meaning none apply). If either is unreadable (403, 5xx,
  rate limit, transport error) the state is `unknown` even when the other lists checks, because the
  unreadable source may require more.
- **Conclusions.** A check run passes only with conclusion `SUCCESS` or `NEUTRAL`; `SKIPPED` is kept
  apart (never evidence); a completed run with a missing or unrecognised conclusion is `pending`
  (so the gate waits, then times out). Commit statuses pass only with `SUCCESS`.
- **Check source (app pinning).** When branch protection (`checks[].app_id`) or a ruleset
  (`integration_id`) pins a required check to a GitHub App, only a check run reported by that app
  counts: `minions sync` then also reads `GET /repos/{repo}/commits/{head}/check-runs` (read-only) and
  records each check's `source` (`check-run`/`status`) and `appId`. A commit status or another app's
  run with the same name is ignored (the check stays `pending`, then `timeout`). If the check runs
  cannot be read, a pinned check is `unknown`. `app_id` null or -1 means "any source".
- **Pagination is complete or unknown.** The app-aware check-run read follows `&page=N` until
  `total_count` is reached (at most 10 pages of 100). A read error, a hit page cap or inconsistent
  counts make the whole read unreadable (pinned checks `unknown`, never a partial list). The result is
  merged with failing rollup check runs rather than replacing them (a failure is never dropped),
  so a failing run seen in either source cannot disappear.
- **Residual: name-only matching.** A required check that GitHub does not pin to an app (legacy
  `contexts`, `app_id` null/-1, a ruleset entry without `integration_id`) is matched by name only, as
  GitHub itself does: anyone who can post a commit status with that name (for example with the
  delivery token) can satisfy it before the real check reports. A failing or pending run of the same
  name still wins (worst result per name). Pin the check to its app in branch protection or the
  ruleset to close this.
- **Sync.** With `ciAuthority: github`, `minions sync` also reports the gate per PR head. Observations
  now include per-check results (`ci.checks[]`: name, pass/fail/pending/skipped, source, and app id
  when known).
- **Readiness.** `minions doctor` reports `ci.authority`: ready only with `ciAuthority: github`,
  pull-request delivery, and readable required checks; otherwise `warn` with what is missing
  (never `fail`). With `ciAuthority: none` it is `ok` and hints when required checks exist.
- **When CI evidence exists.** CI runs on the pull request, which is opened when the reviewer approves.
  CI evidence therefore applies to heads that are already on a PR (re-review or QA of a published
  head, and the merge gate); a head that was never pushed has no observation (`missing`) and is
  verified locally. Pushing heads for CI before review is not part of this decision.
- **Setup default (PR-first).** With a GitHub remote, a stored token and `git.push` not denied,
  `minions setup` (and `minions setup github`, the init wizard) offers `pull-request` as the default
  delivery answer, also to a project still on `local`; `local` and `branch` stay selectable.
  Without GitHub or a token nothing is offered and delivery stays `local`. Non-interactive runs keep
  the configured mode (project-owner defaults to `pull-request` when the token exists).

## CI-gated auto-merge

Decision record for `delivery.merge: "auto-when-eligible"` (task-1.9; `src/runtime/merge.ts`,
`Scheduler.autoMerge` / `approveMerge`, the sync hook in `src/runtime/ci.ts`, `merge.readiness` in
`src/host/doctor.ts`). Owner decision 2026-10-20: build auto-merge on top of the CI evidence gate.

- **Opt-in.** `delivery.merge` defaults to `disabled`; `auto-when-eligible` turns it on. The setup
  question *Enable auto-merge?* (only with pull-request delivery, default no) records it in
  `config.local.json`. Configuration prerequisites (`autoMergeConfigReasons`): pull-request delivery to
  GitHub, `delivery.requiredChecksConfigured: true`, `verification.ciAuthority: "github"` (required
  checks, including app pinning, are only read as evidence under it), and `pr.merge` not `deny`.
  `listUnavailable` and doctor `merge.readiness` report any that are missing; doctor also needs
  required checks to be readable and configured on the base, and a usable GitHub credential.
- **Where it runs.** Only in the runtime's own command path: after each PR observation in
  `minions sync` (the hook runs after the `ci` evidence for the head is recorded) and after delivery in
  `minions work publish` / `minions work record`. No polling loop, no new command. The coordinator's
  Claude Code deny rules for `gh pr merge` stay; the runtime calls gh through the PATH wrapper like
  publication does, with a PR URL and cwd `/` (gh never touches the workspace or its branches).
- **Gates, all for the approved publication head** (`publications.head_sha`), re-evaluated on every
  pass (`evaluateMergeGate`): the configuration prerequisites; the live PR (`gh pr view`, never a
  cached observation) is open, not a draft, from the same repository, targets `git.baseBranch`, and its
  head equals the approved head; reviewer evidence `complete` for that head at the current config
  revision; `Scheduler.ciGate(taskId, head)` is `pass` (fail closed: unknown, missing, pending, timeout,
  failing, unconfigured required checks all block); the sensitive-path diff over trusted bases
  (`gateChangedPaths`, shared with publication; no trustworthy base blocks) and `can(pr.merge)`.
  `deny` → `denied`. `ask` (the default in every profile that allows merging, and the sensitive-path
  upgrade allow→ask) → a host-signed approval of scope `merge` for exactly that task and head must
  verify against the runtime's read-only public key, otherwise `awaiting-approval`.
- **Merge approvals.** `minions work approve <taskId> --head <sha> --merge` on the host signs
  `{scope: "merge", taskId, head, …}` with the same per-project key as publication approvals and
  delegates `work approve … --merge --signature <token>`; the runtime verifies it (`approveMerge`) and
  stores it as an `approvals` row of scope `merge` (no schema change). Scopes never substitute for each
  other: a publication approval does not authorize a merge, and a merge token is rejected by
  publication. Unsigned rows, other heads, other tasks and expired tokens fail closed.
- **Arm (native auto-merge).** Only when every gate passes: `gh pr merge <url> --auto --<method>
  --match-head-commit <head>` (`delivery.method`). GitHub then merges when branch protection is
  satisfied, so protection is enforced by GitHub at merge time. Never `--admin`, never a force merge.
  When GitHub refuses to enable auto-merge because the PR is mergeable right now ("clean status"),
  the same merge without `--auto` is run only if GitHub's `mergeStateStatus` is `CLEAN` (every
  requirement met), still with `--match-head-commit`. The PR is read back afterwards (gh may merge at
  once). A PR whose auto-merge is already enabled is not re-armed.
- **Disarm.** If a PR minions armed (last `merge` evidence `armed`) no longer passes a gate — new PR
  head, CI no longer passing, approval gone or expired, policy or config changed, including turning
  `delivery.merge` off — the next pass runs `gh pr merge <url> --disable-auto`. Auto-merge enabled on
  GitHub by someone else is left alone (reported). A failed disarm is reported (exit 1) and retried on
  the next sync; GitHub still enforces protection, and `--match-head-commit` bound the arm to the head.
- **States.** `merge` evidence bound to the approved head records `waiting`, `awaiting-approval`,
  `denied`, `armed`, `disarmed`, `merged` (written on change, with a note). The task stays
  `delivered` while armed (an open PR, not in-flight capacity) and becomes `done` when merged (by
  GitHub, observed by sync, or by the direct merge above). Responses carry `merged` and `merge`
  (`state`, `reasons`, `ci`, `approvalError`, `action`).
- **Residuals.** A merge happens only after a `minions sync` pass observes passing checks and arms
  auto-merge; between passes nothing is armed. Required checks matched by name only can be satisfied by
  anyone who can post a status with that name (see "CI as verification authority"); pin them to their
  app. Code that already runs in the container can still use the token directly (see "Host-signed
  publication approvals"); branch protection on GitHub stays the final control.

## GitHub intake sync

Decision record for GitHub-filtered intake (`src/runtime/intake-sync.ts`, config `intake.github`).

- **A source, not a backend.** Issues are imported into the Backlog.md backlog; the GitHub Issues backend
  stays deferred. Config `intake.github` (optional, strict): `enabled`, `repository` (`owner/repo`,
  null = workspace origin), `labels` (all must match), `assignee` (login, `none`, `*`, null),
  `milestone` (title or number, `none`, `*`, null; a title is resolved through `GET /milestones`),
  `state` (`open`/`closed`/`all`). Unset = off, so existing configs stay valid.
- **When.** `minions sync` (no task ids) runs one intake pass before the PR/CI refresh; the
  coordinator wrapper runs one after taking the project lock and before claude starts (`onStart`,
  failures only logged). No polling loop and no new top-level command.
- **Startup budget.** The startup pass has an overall budget of 25 s (`STARTUP_INTAKE_BUDGET_MS`):
  gh children are killed on the abort (see "Aborts kill gh" below), an `AbortSignal` makes in-flight reads resolve as failed and
  stops the import, and after a 2 s grace the coordinator starts whether or not the pass returned.
  An aborted pass keeps what it imported, evaluates no departures (pauses nothing) and is completed
  by the next `minions sync`, which keeps the 120 s per-call gh timeout.
- **Untrusted text.** Issue titles and bodies are task data. Every `<!--` in them becomes
  `&lt;!--` before import, so an issue cannot forge the minions meta block (provenance, links, PR URL)
  or hide text. The Backlog.md adapter also only parses the LAST `<!-- minions:meta ... -->` block
  (the one minions appends), `replaceMeta` updates that same block, and `composeDescription` /
  `replaceMeta` neutralise meta markers in all user content they write, so no task text (pasted
  tickets, worker-created tasks) can carry a second block. Notes are a separate section and are
  never parsed for meta.
- **Read-only.** `gh api --method GET /repos/{repo}/issues?state&labels&assignee&milestone` (100 per
  page, at most 10 pages), plus `GET /repos/{repo}/issues/{n}` to explain a departure.
- **Additive, idempotent.** Key `intake:gh:<owner>/<repo>#<n>` in the idempotency table, issue URL in
  the task meta `externalLinks` (also used to re-link when the DB row is missing). New tasks: status
  `idea`, provenance `external-requirement`, issue body plus an "Imported from" line. Reruns never
  overwrite title/description (the coordinator may have triaged them), never delete, and never
  re-create a task that was removed from the backlog. minions' own record of each imported issue
  (task id, assignees, in-filter flag, pending pause) is the meta row `intake_github`.
- **Intake pause.** The `intake:` keys are intake creation (`isIntakeCreation`): while paused, new
  issues are skipped and counted (`skippedIntakePaused`), and the sync does not fail. Reconciliation
  of already-imported issues still runs (it creates nothing).
- **Reconciliation** (spec section 9). An imported issue missing from a *complete* query result left the
  filter (reason `closed`, `not-visible`, `reassigned` or `left-filter`); an issue still in the
  filter whose recorded non-empty assignee set changed was `reassigned` (first assignment of an
  unassigned issue is not). Either pauses the linked task: status `blocked` and a note, plus an
  `intake-reconcile` event. done/delivered/cancelled tasks are left (`finished`); an already blocked
  task is `already-blocked`; a task with an active lease is not moved (`lease-active`) and the pause is
  retried on each later sync. An issue that matches again is recorded as `returned` with a note; the
  task is not resumed automatically. A failed query, an unknown milestone or a truncated result (more
  than 1000 issues) evaluates no departures, so nothing is paused on missing data.
- **Setup.** `minions setup` asks *Import GitHub issues into the backlog?* after CI (default no; on a
  rerun the current setting), then labels, assignee, milestone and state, and records `intake.github`
  in `config.local.json`. No GitHub call is made at setup. A filter that anyone can satisfy (no labels,
  assignee null or `none`, milestone null or `none`) gets a setup warning, as does the README: on a
  public repository anyone can open an issue, while labels, assignees and milestones need triage
  access. Warn only, nothing is blocked. An author (`creator`) filter was considered and deferred
  (task-39): it needs a new config field, schema and prompt, and a maintainer-only label already covers it.
- **Provenance fallback (task-39).** The Backlog.md adapter falls back to `user-decision` when a task's
  meta block is missing or malformed. For tasks recorded in the meta row `intake_github` the runtime
  installs a `provenanceFallback` (`intakeProvenanceFallback`), so they fall back to
  `external-requirement` instead. The global default is unchanged for every other task: they are
  created by the owner or the coordinator, and changing it could demote real owner decisions.
- **Aborts kill gh.** `run()` (`src/core/exec.ts`) takes an optional `AbortSignal`: on abort it sends
  SIGTERM, then SIGKILL after 2 s, like the timeout. The startup pass passes its signal to every gh
  child (`ghWithTimeout(budget, signal)`), and that signal is aborted by both the budget and the
  coordinator's pre-spawn guard (`stop`), so no gh child outlives the pass. A failed or aborted list
  read reports `matched: null` ("issue list not read"), not the pages read so far.
- **Creates in flight (task-40).** `backlog task create` is a subprocess, and a wrapper stopped by a
  pre-spawn signal exits without waiting for it, so the task can appear after its pass is gone, with
  neither the idempotency row nor the sync record written. Each create is marked in the meta row
  `intake_github_inflight` (key -> start time) before the subprocess starts and unmarked once it
  settles (recorded or failed). A pass that meets an issue with no linked task and a mark younger than
  10 minutes skips it with a warning instead of creating a second task; once the task shows up (found
  by its issue link) the mark is dropped, and an older mark counts as a create that never happened.

## Guided setup

Decision record for `minions setup` (`src/host/setup.ts`).

- **One command, existing code.** `setup` runs `runInit` (wizard, plan, apply) with `skipIntegrations`:
  the wizard skips its delivery, channel, and token questions, and init does not offer the token prompts.
  Setup then asks them in order: GitHub (in a terminal, the guided flow of `minions setup github`,
  `runGithubSetup` with `skipDelivery`: remote, base branch, pre-filled token link, hidden token prompt;
  a piped token goes straight to `provisionGithubToken`; then setup's own delivery-mode question), CI
  (read-only `requiredChecksStatus` with the stored token, plus `ciSetupPlan`), auto-merge (shown as
  not available yet, default no, nothing written), and Telegram (`provisionTelegramToken`, pairing
  instructions; skipped in the host runtime, which has no Telegram; with channel `auto` a stored token
  keeps `auto`). Runtime start, import, and coordinator launch reuse the `minions start` code
  (`ensureUp` / `ensureHost`, `importRepo`, Telegram plugin install, and `coordinator sync
  --start-detached`) through the `SetupRuntime` seam, which tests replace with a fake. The runtime
  (`--runtime`, or the wizard's question with its typed confirmation for `host`) and the Claude
  authorization method are init wizard questions.
- **One `setup` command.** Bare `minions setup [path]` is the guided flow; `minions setup github` and
  `minions setup assist` are its subcommands (`--yes` / `--dry-run` after the subcommand name are
  parsed by `setup` and read by the subcommand through `optsWithGlobals`). In a terminal the guided flow ends by offering the setup assistant (`offerSetupAssistant`,
  opt out with `--no-assistant`); when the assistant is not launched it then offers to attach.
- **Where choices go.** Integration choices that differ from the project configuration
  (`delivery.mode`/`delivery.provider`, `communication.channel`) are written to the host-only
  `config.local.json`. They are never written into the shared `.minions/config.json`, because a token is
  personal and another clone may not have one. After a change, setup reruns `runInit --yes`, the same
  path as a rerun of init, so the plugin and runtime config are regenerated with the new layer.
- **Defaults.** Optional integrations (GitHub, CI, auto-merge, Telegram) default to no. Core steps
  (apply the plan, start the container, import, launch, attach) default to yes. `--yes` takes the
  defaults. A token piped with `--github-token-stdin` / `--telegram-token-stdin` enables that
  integration; an empty piped token is an error (non-zero exit, nothing changed). `--delivery` is
  honoured only when it is selectable.
- **Init options.** `--config <file>`, `--attach` and `--new-identity` are forwarded to `runInit` with
  the same semantics as `minions init`, so `./install.sh path --config cfg.json` keeps working. With
  `--config` the init wizard, the keep/change question, the delivery-mode question and the
  "Set up Telegram?" question are skipped (the file sets `delivery.mode` and
  `communication.channel`); token questions are still asked in a terminal, and like init, `--config`
  works without a terminal. The coordinator-attach opt-out is `--no-attach-coordinator` because
  `--attach` has init's meaning.
- **Idempotent rerun.** Setup detects the registered project and offers keep or change (change reruns
  the wizard with the existing values as defaults; visibility stays as installed). For a stored GitHub
  token it offers keep, change, or remove. For Telegram it offers keep, change, or disable. A running
  container is reused, and an imported repository is kept unless you ask to import again. Keeping
  every answer writes nothing.
- **Unknown required checks.** Setup passes `ciSetupPlan` a boolean `hasWorkflows`: local
  `.github/workflows` files of this checkout, or GitHub's workflow count when that is readable
  (`ciSetupPlan` itself treats `null` as unknown, not as missing).
  Required checks that cannot be read (no token, API error) are reported as `unknown`, never as `none`,
  and the plan is labelled conditional.
- **Never.** Setup never writes workflow files, never changes branch protection, never sets
  `delivery.requiredChecksConfigured`, and never enables auto-merge. Secrets are read only through the
  non-echoing prompt or stdin. They never come from argv and never appear in output, notes, or prompts.
  Setup cannot approve Telegram pairing; it prints the `/telegram:access` steps for the coordinator
  terminal.

## Upgrade

`minions upgrade` (host, `src/host/upgrade.ts`) moves a project onto the installed minions package
without losing progress. The host drives the container through `docker compose exec`; lease and pause
state stay in the runtime DB in the state volume. Bringing the host checkout and the installed CLI up to
date is the source phase. It runs before everything else (see "Upgrade from the container" below).

- **Order.** Preflight (read-only) → `pause --starts --drain --reason upgrade` → drain → regenerate derived files → image →
  materialize secrets → `compose up --force-recreate` → `workspace setup` → `importRepo` (refreshes
  the clone, which is never re-cloned, and configures origin) → `resume --starts` → `coordinator restart --recover`.
- **Derived files.** compose.yaml, the runtime config and the plugin (`<project dir>/plugin`, bind-mounted
  read-only at /opt/minions/plugin) are rendered from the package of the CLI that runs the step: after a
  CLI rebuild/reinstall that is the new CLI the upgrade hands off to. Files are replaced one by one
  (atomic rename inside the directory, never the directory itself, so the mount sees them); files the
  user edited are kept with a warning, files no longer generated are removed when unchanged. The same
  refresh runs on every `minions start` and config/auth/runtime change. Afterwards the files step reports
  whether the plugin matches the installed package (`plugin` in the result), and `minions doctor` has a
  `plugin` check. Until task-46 only `minions init` wrote the plugin, so upgrades left it stale.
- **Drain.** Workers are Agent subagents of the coordinator's claude process, so draining means
  waiting until their leases end (recorded or released by the coordinator) while no new stage can
  start. The pause also records a drain request (runtime DB `controls` row `drain` with reason,
  time and event id, mirrored by the flag file `/state/run/drain`; `status --json` shows `draining`).
  Workers learn about it from a plugin PreToolUse hook on every tool, gated by a shell test
  (`[ ! -e "$MINIONS_STATE_DIR/run/drain" ] || minions hook drain`) so node never starts otherwise. It
  acts only on subagents (hook input `agent_id`) of a `minions:<role>` type while an active lease of
  that role exists; the coordinator, other subagents and unleased sessions are never affected. The first
  call adds the checkpoint notice (commit `wip:`, return a partial result listing the remaining work;
  reviewers return partial at once); after 10 more calls only read-only tools, the Handback tool and
  allowlisted Bash commands are allowed. The Bash check (`drainSafeBash`, task-3.9) is a strict
  allowlist of whole command forms, not a shell parser: anything it does not recognize is denied. A
  one-line command is simple commands joined only by `&&` (optionally starting with `cd <path> &&`),
  made of plain words (`[A-Za-z0-9_./:=@%+,-]`), single-quoted strings and double-quoted strings
  without `$`, backticks or `\`; every other character outside quotes (substitutions, expansions,
  globs, `;`, `|`, redirections, `#`, tabs) is denied, except the exact trailing tokens `>/dev/null`,
  `2>&1` and `| head -<n>`/`| tail -<n>`. Allowed commands: `git [-C <path>] [--no-pager]` with
  `status|log|diff|show|rev-parse` (no `--output`), `branch` (listing only), `add <paths|-A|-u>`
  and `commit -m <quoted message>` (no other flags, so no `--amend`; `git -c` is denied), plus `ls`,
  `cat <file>`, `pwd`, `echo` and `minions work submit|brief <lease> [--role <r>] --json`. Multi-line
  commands must match one of three heredoc forms as a whole string, with single-quoted delimiters and
  an unparsed body: the result-contract submit (`minions work submit … --json <<'RESULT'`), the Claude
  Code commit (`git commit -m "$(cat <<'EOF'` … `EOF` `)"`, nothing after) and `git commit -F - <<'EOF'`,
  each optionally preceded by `cd <path> &&` (commit forms also by `git add … &&`). The drain is a cooperative safeguard, not a sandbox: allowed git commands can run programs set in repo config/attributes (core.fsmonitor, diff.external, filter/textconv drivers, commit hooks), and `git -C <path>` or `cd <path>` can point at a repo with pre-staged config; this residual is accepted as the same trust class as worker code already running. A hook error allows the call, except for a leased worker during
  a drain, which is restricted the same way. The coordinator needs no new wake-up: worker completions
  wake it, claims are refused while starts are paused, and a partial from a lease that was active when
  a drain was requested is recorded with `drain: true` (not a failed attempt or a repair cycle). The
  next claim of that task for the same role gets a `resume` block in its brief (remaining work,
  checkpoint head); `/minions:recover` re-dispatches. `resume --starts` clears the request; when
  the starts stay paused (the user's pause) the finish or abort runs `resume --drain`. A runtime that
  rejects `--drain` (an older image) is paused the old way and only waited for. The wait is up to `--timeout` seconds (default 1800). When it runs out, the default aborts:
  starts are resumed and the container is left alone. With `--now` the remaining leases are released
  and reported as `interrupted`, and the recovery prompt re-dispatches them. `--now` on its own means
  no wait at all. A release answered with `CONFLICT` "already ended" means the lease ended on its own
  after the last poll; it counts as drained, not interrupted. If a release fails for another reason,
  the abort lists the leases already released. A failed `status` poll is retried after 2, 5 and 10
  seconds before the drain gives up.
- **Image.** The image is rebuilt only when its `minions.build` label differs from the package
  fingerprint (`ensureImage`).
- **Pause ownership.** Starts that the user paused before the upgrade stay paused. A pause made by an
  upgrade is recorded in `projects/<id>/upgrade.json` until it is resumed, so a rerun after a failure
  still resumes it. The marker holds the id of the runtime `controls` event that paused starts
  (`minions status --json` reports the last one as `pauseChanges`). A rerun counts the current pause as
  its own only when that event is the marker's, so a pause the user made after resuming by hand stays
  paused and the stale marker is dropped. A marker without an event id matches a pause recorded within
  a few minutes of its timestamp. A runtime that predates `pauseChanges` leaves only the marker to go
  by. With the container down, ownership is decided after the recreate.
- **Interrupts.** SIGINT or SIGTERM before the recreate waits for an in-flight pause, resumes the starts
  the upgrade paused, prints one line with a hint to rerun `minions upgrade`, and exits (130/143). Once
  the recreate has started it prints only the hint; the marker lets the rerun resume starts. A second
  signal exits at once.
- **Resume before restart.** The recovery prompt dispatches only when starts are not paused.
- **Failures.** A failure before the recreate resumes starts and changes nothing else. That includes a
  stored token that cannot be read (secrets step), since the new container would start without it. A failed
  recreate keeps the volumes and points to a rerun. After the recreate, each remaining step is still
  attempted and failures are reported (`ok: false`, exit code 1).
- **Volumes.** The upgrade never runs `down -v` or volume commands. `--dry-run` only reads (compose
  ps, image inspect, `minions status`) and lists every step.
- **Host runtime.** Not supported: `minions upgrade` refuses with `PRECONDITION` for a project on the
  host runtime (there is no image or container to move). Install the new CLI, let workers finish
  (`minions status`, or `minions pause --starts`), then `minions down && minions start`, which
  regenerates the plugin, shim and sandbox settings and restarts the coordinator.

### Upgrade from the container

The source phase (`src/host/upgrade-source.ts`) adds two steps, `sync` and `cli`, ahead of
`preflight`. Both finish before any pause, drain or recreate.

- **`--from-container [branch]`** runs `exportRepo`, then moves `branch` (default: the base branch) to
  `refs/remotes/minions/<base>`. The move happens only when `git merge-base --is-ancestor` holds and
  `git status --porcelain` is empty. That check covers the repository's worktree and the worktree that
  has the branch checked out; untracked files count as dirty. If the branch is checked out, the move is
  `merge --ff-only`. Otherwise it is `update-ref <ref> <new> <old>`, a compare-and-swap with a reflog
  entry. A dirty tree refuses with `PRECONDITION` and a divergence refuses with `CONFLICT`. Neither
  changes anything. A branch that is already up to date or ahead is left alone. Nothing here forces,
  resets, stashes or checks out. `--dry-run` does not export; it checks against the refs from the last
  export and reports a refusal as a failed step.
- **Installed CLI vs checkout.** This check runs only when the project repository is a minions
  checkout. `esbuild.config.mjs` writes `dist/build.json` = `{version, source, kind}`. `source` is
  `scripts/source-fingerprint.mjs`, a hash of `src/ templates/ docker/ scripts/` plus the package,
  lock and esbuild files, regular files only. The upgrade recomputes that hash on the checkout and
  compares it, together with the version, against the global install at `<npm root -g>/minions`.
- **Install kinds and what happens.** A symlink is a `link` (`npm install -g <dir>`). If it points at the
  checkout, the upgrade rebuilds it (`npm run build`, or `npm ci` when build deps are missing). A real
  directory stamped `kind: packed` comes from `install.sh`, which exports `MINIONS_BUILD_KIND=packed`.
  The upgrade reinstalls it in place: `npm pack` of the checkout into a temp dir, then
  `npm install -g <tgz>`. A real directory whose `npm ls -g --long` `resolved` or package.json
  `_resolved`/`_from` is a git spec is a `git` install. Any other real directory is `unknown`; npm 10
  records nothing that tells a git-URL install from a tarball install. For `git`, `unknown`, a link
  elsewhere, or a missing install, the upgrade does not touch npm. It prints
  `cd <checkout> && npm ci && MINIONS_BUILD_KIND=packed npm pack && npm uninstall -g minions && npm install -g ./minions-<v>.tgz`
  plus the rerun command and stops (`stopped`, `ok: false`, exit 1).
- **No self-continuation (task-3 decision).** The running CLI never runs container steps from a
  package it just replaced. After a rebuild or reinstall it re-checks the install, then runs
  `node <installed>/dist/cli.js --json upgrade [--timeout N] [--now]` with `MINIONS_UPGRADE_HANDOFF=1`
  and returns that result, source steps first, with `continued: true`. Under the hand-off variable a
  CLI that still differs stops with the command instead of reinstalling again.
- **Trust.** Rebuilding runs the checkout's npm lifecycle scripts, `esbuild.config.mjs` and lockfile
  dependencies on the host and installs the result as the global CLI, and anything in a project repo
  can claim to be a minions checkout (`package.json` name plus `src/cli.ts`). So the rebuild/reinstall
  runs only with `--rebuild-cli`; without it the upgrade stops with the command (`ok: false`) and a
  rerun that opts in. Commits fast-forwarded by `--from-container` are never built in the same run,
  even with `--rebuild-cli`: the upgrade stops, names the range to review and logs it
  (`git log --oneline <from>..<to>`, up to 20 commits). A dry run plans these stops (`ok: false`).

### origin/<base> as the single source of truth

Owner policy (task-28): with GitHub delivery (`delivery.mode` `branch` or `pull-request`,
`isGithubDelivery` in `src/config/delivery.ts`), `origin/<base>` is the only source of the base branch.
`local` delivery keeps every behaviour described above.

- **No local base merges.** Nothing in minions merges into a local base: publication pushes
  `agent/<slug>` and opens a PR, and merging happens only on GitHub when policy allows (`pr.merge`
  stays `ask`; CI-gated auto-merge is task-1.9). The local auto-merge of approved branches (task-15) is
  a `local` delivery practice; the coordinator prompt for GitHub delivery forbids merging, rebasing,
  cherry-picking or committing into the local base. Enforcement is deterministic at the next claim
  (below) rather than a permission rule: a `git merge` deny would also stop workers that update their
  own task branch.
- **Pre-claim sync** (`src/runtime/base-sync.ts`, called from `Scheduler.claim` for every role before
  the lease exists). Fetch `+refs/heads/<base>:refs/remotes/origin/<base>` (container: the `origin`
  remote; host runtime: the normalized https URL, as `configureOrigin` and `publishTask` do), then
  fast-forward only: `merge --ff-only` in the worktree that has the base checked out, else
  `update-ref <ref> <new> <old>`; a missing local base is created at origin. Blocks the claim, with no
  lease and the task status unchanged, when origin is not github.com (`PRECONDITION`), the fetch fails
  (the classified error, `NETWORK_RETRYABLE` by default), the local base is ahead of or diverged from
  origin (`CONFLICT`), or the fast-forward itself fails (`CONFLICT`). Each block is recorded as a
  `base-sync-blocked` event (role, base, code, message, details); a moved base as `base-sync`. The
  coordinator reports the error; nothing merges or resets automatically.
- **Import.** `minions workspace import` still fetches the host refs into `refs/remotes/host/*`, but
  under GitHub delivery (`baseFrom: 'origin'`) it no longer fast-forwards the workspace base to the
  host's base, because the host's local base may hold commits that never went through a PR.
- **Upgrade source** (`src/host/upgrade-source.ts`, `upgradeSourceMode`). `--from-container` stays,
  for `local` delivery only; with GitHub delivery it is refused with `PRECONDITION` (no new flag or
  command). In a minions checkout the source phase instead fetches `<base>` from the project's recorded
  remote URL (else `origin`) into `refs/remotes/origin/<base>`, moves the host base with the same strict
  fast-forward rules, and requires the checkout to be exactly that commit with a clean tree before the
  CLI check; otherwise the `cli` step fails and the upgrade stops with the command to get there.
  Because `origin/<base>` commits were reviewed and merged on GitHub, a fresh fast-forward from origin
  may be built in the same run (still only with `--rebuild-cli`); commits from the container never are.

## Telegram bot token

A second credential kind on the same mechanism (`CredentialKind` in `src/host/credentials.ts`;
stores, reference file, and secrets mount are shared, not duplicated). Full design: [telegram.md](telegram.md).

- **Channel.** After storing, `auth telegram` offers (interactive, default yes) to switch an explicit `terminal`
  channel to `auto`; non-interactive runs print `minions channel set auto` instead.
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

## Communication channel

- `minions channel show`: configured `communication.channel` (and its layer), effective channel, reason.
- `minions channel set terminal|telegram|auto [--dry-run] [--yes]`: edits the project config file the install
  uses (shared `.minions/config.json` or `<host data root>/projects/<id>/config.json`) via `editProjectConfig`
  (`src/host/config-write.ts`): strict parse (a file that fails to parse is never overwritten), `configRevision`
  bump, validation with `config.local.json`, atomic write, derived files refreshed. Needs `--yes` or a
  confirmation. Never commits (shared: prints a commit reminder) and never restarts: restart-required, so it prints
  `minions down && minions start` when the runtime is running, `minions auth telegram` when no token is stored, and a
  host-runtime warning (no Telegram there). `config.local.json` overriding the value is reported.
- Resolution matrix and fallbacks: [telegram.md](telegram.md#channel-selection-terminal--telegram--auto).
  `minions status` shows `channel: {configured, effective, reason, source}`; doctor adds `communication.channel`.

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
  host/assistant.ts          setup assistant: host plugin + claude argv, init offer, `setup assist`
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
templates/assistant/         setup assistant instructions and skill (see "Setup assistant")
docker/Dockerfile  docker/entrypoint.sh
test/                        vitest unit tests; test/docker/ opt-in (MINIONS_DOCKER_TESTS=1)
scripts/prepare.mjs          npm prepare hook: builds dist/ on git-URL installs (`npm install -g github:…`)
scripts/verify-git-install.sh  offline check of the git-URL install into a temp prefix (`npm run verify:git-install`)
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
    assistant-plugin/                host-only plugin of the setup assistant (`minions setup assist`), regenerated per launch
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
/home/node/.cache     vol  npm and tool caches; tmp/ = TMPDIR (disk-backed, exec-allowed scratch),
                           tmp/leases/<leaseId>/ = per-lease scratch (removed at lease end and coordinator start);
                           coordinator start also removes other tmp/ entries whose newest mtime (entry + tree,
                           lstat only) is over 24 h old, keeping leases/ (10 s budget, kept if unsure; only the
                           default minions-owned root, never an overridden MINIONS_SCRATCH_DIR, never a symlink)
/home/node, /tmp      tmpfs (noexec; /tmp capped at container.tmpSizeMiB, default 1024 MiB)
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
coordinator?: { permissionMode?: 'auto' | 'acceptEdits'; disallowedTools?: string[]; toolSearch?: boolean; bundledSkills?: boolean }   // coordinator session; unset = auto, default tool trim, tool search on, bundled skills off; never bypass
permissionMode?: 'default' | 'acceptEdits' | 'auto'   // legacy: only 'default' is still honoured (when coordinator.permissionMode is unset)
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
- File hand-offs (coordinator context diet). `work claim` also stores the brief at
  `/state/briefs/<leaseId>.json`; `--compact` prints only leaseId, briefMarker, taskId, title, role,
  attempt, branch, worktree, expectedHead and the brief command. `work brief <leaseId> --role <role>`
  returns the stored brief and `work submit <leaseId> --role <role>` (stdin/--result-file) writes the raw
  result to `/state/results/<leaseId>.json`; `work record <leaseId> --submitted [--correction]` records
  that file through the same `record` path (same validation, stale-head checks, one correction). An
  invalid submission is renamed to `<leaseId>.rejected.json`, so a correction needs a fresh submit; a
  final record (valid or unvalidated) deletes the file (the DB keeps `result_json`). A missing file is
  `NOT_FOUND` with a hint. Stdin/--result-file recording is unchanged.
  Decision (ownership): `brief` and `submit` require an active lease, the lease's role, and a cwd
  (realpath) inside the lease's worktree. One active stage per task plus per-task worktrees mean a
  worker in its own worktree can reach only its own lease; this is a misuse guard, not a security
  boundary against a worker that deliberately `cd`s elsewhere (workers share one OS user). Lease ids are
  shape-checked so they cannot escape the directories. No DB schema change: briefs and submissions are
  files. The PreToolUse(Agent) hook is unchanged; prompts carry the marker, a `worktree:` line and notes.
- `backlog list|ready --compact` (= `--fields id,title,status,priority,dependencies`) or
  `--fields a,b` projects JSON task objects; unknown fields are `PRECONDITION`. Human output is unchanged.
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
  Other agent types pass through. Registered as `minions hook pre-agent || exit 2`: the CLI always exits
  0 and denies through JSON, while a missing binary or a crash becomes exit 2, the only blocking
  PreToolUse exit, so the gate fails closed.

## Coordinator context resets

Owner decision (task-45): keep the coordinator's context small by restarting the session routinely with a short
handoff, instead of one long session whose re-read context grows every turn. Implemented in
`src/runtime/context-reset.ts`; guidance in `coordinator.md` (Limits), the orchestrate and recover skills.

- Handoff: `minions coordinator handoff --json` (note on stdin) writes `<state>/coordinator-handoff.json` (mode
  0600, atomic, replaced on every write). The text is redacted (the CLI-wide `redact()` plus private keys, AWS keys,
  `sk-`/`xox*-` tokens, `password=`-style assignments, URL credentials) and capped at 4 KB after redaction; an
  oversized note is refused (`PRECONDITION`) and the previous handoff is kept, nothing is cut off silently. The
  `coordinator-handoff` event records only size and redaction count, never the text. It holds what only the
  conversation knows: open owner questions with the recommended answers, pending decisions, what the session waits
  on, the spend tally, chat context. A fresh coordinator reads it first (`handoff --read --json`, named in the
  recovery prompt and step 1 of the recover skill), together with `minions status`.
- Settings: `coordinator.contextReset` `{ enabled, afterDelivery?, contextTokens?, handoffs? }`. Unset means on with
  the defaults (existing projects get resets without a config edit); `enabled: false` is the opt-out, which leaves
  resets to an explicit owner request. Unset trigger fields take the defaults (after delivery on, 60000 context
  tokens, 10 hand-offs); `null` turns one trigger off.
- Triggers are evaluated on demand from DB events, never by a timer. The session is scoped to the current lock by
  event id: events after the latest `coordinator-lock` event naming the current holder (pid and session). That
  event is written by `acquireCoordinatorLock`, the only writer of the lock, on every holder change; a re-entrant
  acquire keeps the session. Ids rather than timestamps, so a previous session's events from the same millisecond
  never count; a DB without such an event falls back to the lock's `acquiredAt`. A reset is due when no lease is
  active, no drain runs, a coordinator holds the lock, and one trigger holds: a task reached `delivered`/`done` in
  this session, the context reached `contextTokens`, or `handoffs` worker records/releases happened.
- Context figure: the Stop hook stores the main session's `transcript_path` (meta only, no event, so the stop
  guard's fingerprint is unchanged); the check reads the transcript's last 512 KB and takes the latest
  main-session (non-sidechain) assistant turn's usage: input + cache read + cache creation + output tokens. When no
  usage is readable (no hook record yet for this session, unknown format), the context trigger is inactive and the
  hand-off count is the fallback.
- Surfacing: `work record|release` responses carry `contextReset` (`due`, `reason`, `steps`) only when due, to keep
  responses small; `coordinator handoff --check --json` shows the full check (triggers, blockers, session counts);
  `minions status` adds a `context reset:` line and `contextReset` in `--json`.
- The runtime never restarts the coordinator by itself. The coordinator, told by a response, finishes the current
  owner exchange, sends pending notifications, writes the handoff, then runs
  `minions coordinator restart --recover --detach --json`. `--detach` is needed because the restart kills the tmux
  session the caller runs in: it checks active leases in-band (refusing with `PRECONDITION`), then runs the real
  `coordinator restart --recover` in a detached process (own session, output appended to
  `<state>/logs/context-reset.log`), which checks the leases again, kills the session and relaunches it detached.

## Plugin (`templates/plugin` → `projects/<id>/plugin`)

```
.claude-plugin/plugin.json   { "name": "minions", "version": <pkg>, "description": ... }
agents/engineer.md  agents/tester.md  agents/reviewer.md
skills/{orchestrate,status,intake,recover,maintain-context}/SKILL.md
hooks/hooks.json             Stop -> minions hook stop ; PreToolUse(Agent) -> minions hook pre-agent || exit 2
coordinator.md               appended to the coordinator system prompt
```
`models.effort` (optional; `low|medium|high|xhigh|max`) adds `effort:` to the worker frontmatter and
`--effort` to the coordinator launch; `models.coordinator` (optional, must be in `models.allowed`) adds
`--model`. Both verified against Claude Code 2.1.292 (`claude --help`; agent definition schema field
`effort`). The probe requires the flags only when they are configured.
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
  `/tmp` (size-capped: tmpfs is RAM counted against `mem_limit`) and `/home/node`, `TMPDIR` on the
  cache volume (`/home/node/.cache/tmp`), named volumes above, ro bind mounts for plugin and config only, no `ports`
  unless configured (always `127.0.0.1:<host>:<container>`), `init: true`,
  command `sh -c "mkdir -p /home/node/.cache/tmp; exec sleep infinity"` (the coordinator is launched via
  `docker compose exec`). `minions doctor` warns when `/tmp` is 80% full or the scratch volume 90% full.
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
