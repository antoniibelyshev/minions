# Compatibility (v0.1)

## Tested matrix

| Component | Tested | Notes |
| - | - | - |
| Host OS | macOS 15.8 (Darwin 24.6), Apple Silicon (arm64) | Only tested host. |
| Docker | Docker Desktop, Engine 29.8.2 | `docker info` must succeed. |
| Docker Compose | v5.5.1 | v2+ is required; v1 (`docker-compose`) is rejected. |
| Host Node.js | 22.13+ required; tested 25.6 (dev), 22.x (CI target) | Host runs only the minions CLI. |
| Runtime base image | `node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` (Node 22.23.3) | Multi-arch index digest, resolved 2026-10-19. |
| Claude Code (in image) | `@anthropic-ai/claude-code@2.1.292` | Pinned in `docker/Dockerfile`; auto-updater disabled. |
| Claude Code flags/fields used optionally | `--model`, `--effort <low\|medium\|high\|xhigh\|max>`, agent frontmatter `effort` | Verified in 2.1.292 (`claude --help`, agent definition schema). Sent only when `models.coordinator` / `models.effort` / `models.effortByRole` are set (`minions:engineer-deep` always carries an `effort`). The Agent tool's `model` accepts only the aliases `sonnet`, `opus`, `haiku`, `fable`; full IDs go in frontmatter. |
| Backlog.md (in image) | `backlog.md@1.54.0` | Pinned in `docker/Dockerfile`. |
| GitHub CLI (in image) | `gh` 2.102.0 (official release tarball `gh_2.102.0_linux_{amd64,arm64}.tar.gz`) | Pinned in `docker/Dockerfile` with SHA-256 per architecture (`ADD --checksum`, BuildKit). Real binary at `/opt/gh/bin/gh`; `/usr/local/bin/gh` is the token wrapper (`docker/gh-wrapper.sh`). Image with gh not yet built/tested. |
| Telegram channel plugin | `telegram@claude-plugins-official` 0.0.7 (marketplace commit `1e96c6b`) | Interface read and install verified on Claude Code 2.1.292 without credentials. Not bundled: `minions start` runs `minions telegram install` (user scope, claude volume) when `communication.channel` is `telegram`; other versions get a warning. `minions telegram probe` and doctor checks `telegram.*` report readiness. No live bot/pairing run recorded yet. See [design/telegram.md](design/telegram.md). |
| Bun (in image) | `1.4.3` (`bun-linux-aarch64`, `bun-linux-x64-baseline`) | Pinned with SHA-256 checksums from the release `SHASUMS256.txt` in `docker/Dockerfile`, fetched in a throwaway build stage; runs the Telegram plugin's MCP server. The aarch64 checksum was re-verified against the downloaded archive on 2026-10-19. The updated image has not been built in the development sandbox (no Docker there). |
| System packages (in image) | git, tmux, ca-certificates, ripgrep, less, procps (Debian bookworm) | Installed at build time only. |

`MINIONS_DOCKER_TESTS=1 npx vitest run test/docker` builds the image (tag `minions-test-runtime:latest`),
starts a test project, and checks: uid 1000, not privileged, read-only rootfs, `cap_drop: ALL`,
no-new-privileges, CPU/memory/pids limits, no Docker socket, only read-only binds for the plugin and
runtime config, loopback-only published ports, no host network/PID namespace, host paths and
ignored `.env` absent, volumes survive recreation. All test resources are removed afterwards.

`npm run e2e` (scripts/e2e.sh) drives the full terminal workflow without a Claude login: pack and
install into a temp prefix, private and shared `init`, `doctor`, `start --no-attach`, the
engineer → tester → reviewer lease flow, hooks, `export`, restart persistence, helper-mode Claude
key provisioning (fake key script), and `uninstall`.
It uses a temp `MINIONS_HOME` and disposable repos and removes its containers and volumes on exit.

`npm run e2e:host` (scripts/e2e-host.sh) drives the host runtime with no Docker on `PATH`: init
`--runtime host`, doctor host checks, `start --no-attach` (warning, separate clone, 0700 dirs), the lease
flow through the shim, host-delegated status/pause/resume, a coordinator launch through a fake tmux and
fake claude (dedicated `-L` server, sandbox settings, user `GH_TOKEN` dropped), the git credential helper
through a shim path with a space, `export`, helper-mode Claude key (`apiKeyHelper` quoting), `runtime
set`, and `uninstall --delete-data`. It installs the real `backlog.md@1.54.0` into its temp dir.

The guided GitHub setup (`minions setup github`, init) is covered by unit tests with temp repos and a
fake GitHub API; the pre-filled token URL follows GitHub's documented template URL parameters
(verified against docs.github.com on 2026-10-19), but opening it in a real browser is not automated.

### Host runtime (no Docker)

| Component | Tested | Notes |
| - | - | - |
| Claude Code (host) | 2.1.292 | Sandbox keys checked against this version's settings schema; doctor warns on other versions. No real session in automated tests. |
| Backlog.md (host) | 1.54.0 | Installed by you (`npm install -g backlog.md@1.54.0`). |
| tmux (host) | fake only in e2e | `brew install tmux`; any 3.x expected to work (`-L`, `new-session -A/-d`, `has-session`, `kill-server`). |
| gh (host) | not exercised | Optional, for pull-request delivery; wrapped by `host/bin/gh`. |

### Linux hosts (preview)

Status: implemented for Docker Engine and covered by unit tests with fakes
(`test/host/linux-host.test.ts`, `test/host/secrets-access.test.ts`, Secret Service cases in `test/host/credentials.test.ts`). **No live
run on a Linux host has been recorded yet** (no Ubuntu LTS or RPM-distro result). Until it is, treat
Linux as a preview, not a tested platform.

| Area | macOS (unchanged) | Linux |
| - | - | - |
| Host data root | `~/Library/Application Support/Minions` | `$XDG_DATA_HOME/minions` (absolute values only, per the XDG spec), else `~/.local/share/minions`. Everything stays under this one root; `XDG_CONFIG_HOME` is not used, so a project's state is never split. `MINIONS_HOME` overrides on both. |
| Credential store | Keychain (`security`), else 0600 file | Secret Service via libsecret `secret-tool` (GNOME Keyring, KWallet bridge, KeePassXC) when a session bus answers and a lookup succeeds; else the 0600 file store. Token on stdin, never argv; verified by read-back. Host runtime: forced to the file store, like the Keychain. |
| Docker | Docker Desktop | Docker Engine (rootful). `doctor` hints: socket `permission denied` → `sudo usermod -aG docker "$USER"` + re-login (root-equivalent) or rootless Docker with `DOCKER_HOST`; daemon down → `sudo systemctl enable --now docker`, rootless socket present but `DOCKER_HOST` unset → the exact `export`, rootless service down → `systemctl --user start docker`. |
| Compose | bundled | v2 plugin required. `doctor` names `docker-compose-plugin` (apt/dnf with Docker's repository) or `docker-compose-v2` (Ubuntu's own packages), and says when only legacy `docker-compose` v1 is installed. |
| `host.docker.internal` | built in | `extra_hosts: host.docker.internal:host-gateway` is added on non-macOS hosts when the container environment references it (JetBrains Central / loopback base URL rewrite); nothing else relies on it. Needs Docker Engine 20.10+. |
| SELinux | n/a | `doctor` (`docker.selinux`) warns when `getenforce` is Enforcing and the daemon labels containers (`name=selinux` in `docker info` SecurityOptions), with the exact `semanage fcontext … container_file_t` + `restorecon` fix for `<root>/projects`. compose.yaml is not changed (no `:z` relabel yet). |
| Bind-mount ownership | Desktop maps ownership | Rootful Engine keeps host ownership. Host uid 1000 (the default first user on Ubuntu/Fedora): the 0600 secret files are readable by the container user (uid 1000) as is (`docker.uid: ok`). Other uids (rootful): supported when your primary group is a private user group (same name as your user, no other member and no other account with that primary gid, per `/etc/passwd` + `/etc/group`; the Ubuntu/Fedora `useradd` default): compose.yaml gets `group_add: ["<gid>"]` and the secrets dir/files are 0750/0640 with that group (`docker.uid: ok`). A shared primary group (e.g. `users`), root, or an account only known through NSS/LDAP: `docker.uid` warns and the files stay 0600. Never a chown or ACL for uid 1000. macOS and host uid 1000 are unchanged (no `group_add`, 0700/0600). Rootless Docker: `docker.rootless` warns (uid 1000 maps to a subordinate uid); not supported yet for host-provisioned secrets. |
| install.sh | as before | Prints a preview note instead of the macOS-only warning, and Docker Engine-specific fixes. |

Nothing minions writes on the host is root-owned: every bind mount is read-only with
`create_host_path: false` (the daemon never creates a missing source dir as root), all container
writes go to named volumes, and exports are copied out by the CLI running as you (`docker compose cp`).

Linux gap list (audit of the macOS-specific host paths, 2026-10-23):

- `src/host/credentials.ts`: Keychain only on macOS; Secret Service added (above). Downgrade: older builds
  reject the `secret-service` backend in `credentials.json`; re-provision with `MINIONS_CREDENTIAL_STORE=file` first.
- `src/host/docker.ts`, `doctor.ts`, `install.ts`: Docker Desktop hints are now platform-aware. Remaining:
  secrets readable for rootless Docker (see design below), `bind.selinux: z` in compose.yaml. Host uid ≠ 1000
  (rootful, private group) is implemented in `src/host/secrets-access.ts`.
- `src/host/setup.ts`, `wizard.ts`, `commands.ts`: credential messages name the actual backend. The
  wizard's Claude key source `keychain` (macOS `security`) has no Linux counterpart yet (`file` and `env` work).
  The GitHub token page is opened with `open` on macOS only; Linux prints the URL (no `xdg-open` yet).
- `src/core/paths.ts`: XDG handled (above). `tmuxSocket` comment cites the 104-byte macOS limit; Linux's
  limit is 108, so nothing changes.
- Host runtime (`runtime: host`) on Linux: not reviewed. Its sandbox settings target Seatbelt (macOS);
  `secret-tool` is denied at the permission layer like `security`, but bubblewrap-based sandboxing,
  `/tmp/tmux-<uid>` handling and the warning text ("your macOS user") need their own task.
- Image: built natively on the host from the multi-arch base, so amd64 and arm64 Linux hosts build
  their own arch; no published multi-arch image and no amd64 run recorded.

Host uid ≠ 1000, rootful (implemented, unit-tested with fakes; no live Linux run yet): `group_add:
["<host primary gid>"]` is added to the service and the secrets dir is materialized as 0750 / files 0640
with that group, only when the primary group is a private user group (single member, same name as the
user); otherwise `doctor` refuses (`docker.uid` warns) and modes stay 0700/0600. Root (uid 0) is always
refused. The decision is re-probed on every compose.yaml regeneration and secrets write, and existing
files in the secrets dir are re-moded when it changes. Never chown to uid 1000 and never use ACLs for
uid 1000: on the host that uid may be another person.

Design for the open ownership cases (not implemented; needs live validation):

- Rootless Docker: container uid 1000 is host uid `subuid_start + 999`. Options to validate: run the
  container with `userns_mode: keep-id`-like mapping (Podman only), or materialize the secrets into a
  tmpfs volume via `docker compose exec` at start instead of a bind mount. Prefer the latter (no host
  files owned by subordinate uids).
- SELinux: add `bind: { selinux: z }` to the three read-only binds when the doctor condition holds,
  recorded in project.json so the generated compose.yaml is stable.
- Multi-arch: `docker buildx build --platform linux/amd64,linux/arm64` for a published image; local
  builds stay native.

## Known gaps

- **Intel (amd64) hosts** are not tested. The image is built natively on the host from a multi-arch
  base, so amd64 should work, but no amd64 run has been recorded.
- **Linux hosts** are a preview with no live run recorded (see [Linux hosts (preview)](#linux-hosts-preview)).
  **Windows** is not supported (later, low priority).
- **No prebuilt image** is published; the first `minions start` builds `minions-runtime:<version>`
  locally (needs network access to Docker Hub, Debian mirrors, and npm). The image carries a
  `minions.build` label (hash of `dist/cli.js`, the Dockerfile and `package.json`); `minions start`
  rebuilds it when the installed package differs, and `doctor` warns about a stale image.
- **Claude authorization** defaults to an interactive `/login` inside the container (stored in the
  project's `claude` volume). Host-provisioned keys (`minions auth set api-key|helper|jbcentral`) are
  supported: the key file (`anthropic-api-key`) lives in the secrets directory mounted read-only at
  `/opt/minions/secrets` (shared with the GitHub/Telegram tokens) and Claude
  Code 2.1.292 reads it through `apiKeyHelper` (re-read every `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` =
  5 min). `npm run e2e` verifies this with a fake helper and a fake local endpoint: the key is
  readable and read-only in the container, a refreshed key becomes visible without a restart, the
  loopback base URL is rewritten to `host.docker.internal`, and Claude Code sends the key to it.
  The real JetBrains Central flow (`central proxy start … --return-key` + the local proxy on
  `127.0.0.1:19516`) is not exercised by the automated tests; reaching the host proxy at
  `host.docker.internal` was verified manually on Docker Desktop. Other engines get an
  `extra_hosts: host.docker.internal:host-gateway` entry (untested). Host login reuse is not supported.
- **Secret file ownership**: the materialized files in `/opt/minions/secrets` (GitHub token, Telegram
  bot token, Claude key) are 0600 files owned by the host user. Docker Desktop on macOS maps bind-mount ownership so the
  container user (uid 1000) can read it. On a Linux Docker Engine whose host user is not uid 1000,
  or with rootless Docker, the container cannot read it; `minions doctor` warns (`docker.uid`, `docker.rootless`).
- **Outbound network is unrestricted** in the container (`network: outbound-internet`). There is no
  egress allowlist, and the container can reach the host/LAN like any Docker Desktop container.
- **Single container, shared credentials**: engineer, tester, and reviewer run in one container and
  can read the same in-container files (incl. the Claude login). There is no per-worker isolation.
- **Repository import** copies committed history of the base branch only (Git bundle). Uncommitted,
  untracked, and ignored files are never imported; tracked secret-looking files trigger a warning
  but detection is best effort.
- **Downgrade after task-36 (coordinator permission mode)**: older builds' strict config schema
  requires the top-level `permissionMode` and rejects the `coordinator` key. Before reinstalling an
  older build, remove `coordinator` from the project config and set `permissionMode` (for example
  `"acceptEdits"`), otherwise config validation fails.
- **CI-gated auto-merge** (opt-in, `delivery.merge: "auto-when-eligible"`, default `disabled`) needs
  pull-request delivery, required status checks on the base branch, `delivery.requiredChecksConfigured: true`,
  `verification.ciAuthority: "github"`, and "Allow auto-merge" enabled in the GitHub repository settings.
  It is evaluated on `minions sync` (no polling loop), so a merge happens only after a sync pass; a
  required check matched by name only (not pinned to an app) can be satisfied by anyone who can post a
  commit status with that name (see "CI as verification authority").
- **Deferred features** (reported as unavailable by `minions doctor`): GitHub Issues backend,
  merge requests (`delivery.merge: "manual"`), review publication, the notification outbox, config plan/apply transactions,
  backlog migration, upgrade plan and schema migration (drift checks, journal), budgets, companion containers, GitHub App short-lived tokens (a long-lived
  fine-grained PAT is used instead), CODEOWNERS mapping of sensitive paths, shared backlog versioned in Git.
- **Telegram bot token exposure inside the container**: the token is mounted read-only and given only to
  the coordinator's `claude` process environment, but the coordinator's tools (and workers' Bash, which
  run in the same process tree) can read it. Revoke it in BotFather (`/revoke`) if the container is compromised.
- **Telegram preview**: `--channels` is a research-preview flag hidden from `claude --help`; whether the
  channel registered is visible only in the coordinator's startup notice. The plugin runs `bun install`
  at each start, so it needs npm registry access.
- **One Telegram poller per bot**: the plugin's server allows a single poller per bot and state
  dir. Any other `claude` session that loads the plugin (it is loaded whenever
  `telegram@claude-plugins-official` is enabled in that session's config dir, with or without
  `--channels`) logs `telegram channel: replacing stale poller pid=…` and kills the running
  coordinator's poller. Telegram then stays down until the coordinator reconnects. Inside the
  container every session would see the token (the coordinator's Bash tool, and so every worker,
  inherits its environment), so minions keeps the plugin **off at user scope** and enables it only
  in the coordinator launch (task-51): `minions coordinator run` writes
  `"enabledPlugins": {"telegram@claude-plugins-official": false}` to `$CLAUDE_CONFIG_DIR/settings.json`
  on every launch and passes `enabledPlugins: {…: true}` in its own `--settings` (flag settings win
  over user scope on Claude Code 2.1.292). `minions status` and `minions doctor` (`telegram.poller`)
  report when `bot.pid` is missing, dead, or not served by the coordinator claude itself (its nearest claude ancestor must be the wrapper's child; a nested `claude -p` under the coordinator is foreign); recover with
  /mcp → reconnect `plugin:telegram:telegram` in the coordinator terminal, or
  `minions coordinator restart --recover` when no worker runs. Do not enable the plugin in a config dir that other sessions
  share with the coordinator. Start nested or ad-hoc `claude` runs with a separate
  `CLAUDE_CONFIG_DIR`. The setup assistant (`minions setup assist`) passes no channel flags but
  uses your host config, so it loads the plugin if you enabled it there. The test suite sets
  `CLAUDE_CONFIG_DIR` to a temp dir (`test/setup/global.ts`), and `test/setup/claude-guard.ts`
  fails any test that would start `claude` with the real `~/.claude`.
- Native macOS/iOS builds (Xcode) cannot run inside the Linux runtime.
- **Host runtime** is less safe by design: agents run as your macOS user. The Claude Code sandbox
  (Seatbelt) confines Bash writes and denies credential reads, but the Read/Edit tools rely on
  permission rules only, your user-level Claude Code settings/hooks/plugins also apply, network
  outside the allowlist prompts rather than being blocked, and there are no CPU/memory/process limits.
  The sandbox configuration has not been exercised against a live Claude session in automated tests.
  Telegram is not set up automatically in host mode.
- **Keychain access list**: the GitHub and Telegram Keychain items are created without a `-T` access list, so any
  process running as your macOS user can read them (normal macOS behaviour). The plaintext copy mounted into the
  container is cleared when `minions start` fails to bring the container up and by `minions doctor` when the container is
  confirmed gone (exited, dead or absent; an uncertain state only produces a warning); the Keychain/file-store originals are never removed by that cleanup.

## Upgrading (`minions upgrade`)

`minions upgrade` (Docker runtime) moves a running project onto the installed minions package. The host
runtime has no image or container: install the new CLI, wait for no active workers, then run
`minions down && minions start`. Contract: [design/bootstrap.md](design/bootstrap.md#upgrade).

Flags: `--timeout <seconds>` (default 1800; 0 with `--now`), `--now`, `--from-container [branch]`,
`--rebuild-cli`, `--dry-run` (lists the steps, changes nothing), and the global `--json` (the result
envelope: steps, interrupted leases, image, coordinator, `plugin`, and for the source phase `sync`,
`cli`, `stopped`, `continued`). Exit code 1 when a step failed or the upgrade stopped.

Steps, in order (names as in `--json`):

1. `sync`, `cli` (source phase, before anything touches the container). `--from-container` (local
   delivery only, container must be running) exports the container branches and fast-forwards a host
   branch (default: the base branch) to `minions/<base>`, only on a strict fast-forward with clean trees;
   a dirty tree or divergence refuses and changes nothing. With GitHub delivery the host base is instead
   fast-forwarded to `origin/<base>` and `--from-container` is refused. When the project repository is a
   minions checkout whose build differs from the installed CLI, the CLI is rebuilt or reinstalled, but
   only with `--rebuild-cli` (it runs the checkout's npm scripts on the host; review it first), and the
   rest of the upgrade is handed off to the newly installed CLI (`continued: true`). Without
   `--rebuild-cli`, or for installs npm cannot replace in place (git URL, unknown), the exact command and
   the rerun command are printed and the upgrade stops before any container step.
2. `preflight` (read-only), `pause` (new starts, plus a drain request), `drain`. Workers commit work in
   progress (`wip:`) and return partial results; recovery re-dispatches their tasks. If workers outlast
   `--timeout`, the default aborts and resumes starts; `--now` releases them and reports them as
   interrupted. Starts you paused yourself stay paused. A partial counts as a drain partial (no failed
   attempt, no repair cycle) only when the worker hook delivered that lease the drain notice; each
   delivery is a `drain-notice` event with the subagent's `agent_id` / `agent_type`, and
   `minions status` shows the last one (`lastDrainNotice` in `--json`).
3. `files`: regenerates compose.yaml, the runtime config and the plugin the container mounts from the
   installed package, and reports whether the plugin matches it (`plugin` in `--json`; files you edited
   are kept with a warning). `minions doctor` has a `plugin` check for the same staleness.
4. `image`: rebuilt only when the `minions.build` fingerprint changed, otherwise skipped.
5. `secrets`, `recreate` (`docker compose up --force-recreate`), `workspace`, `origin` (the repository
   import is refreshed and origin reconfigured; the existing clone is kept).
6. `resume` (starts, before the coordinator restarts so recovery can dispatch), `coordinator`
   (`minions coordinator restart --recover`). The new coordinator session reads its handoff file if one
   exists, runs with the trimmed tool set (`coordinator.disallowedTools`, `toolSearch`, `bundledSkills`
   to adjust) and, unless `coordinator.contextReset` has `enabled: false`, resets its own context
   routinely afterwards.

Safety: the upgrade never runs `compose down -v`, never removes volumes and never re-clones the
workspace (clone, worktrees, backlog, runtime DB and Claude login live in named volumes). Any failure
before the container is recreated resumes starts and leaves the running container as is; after the
recreate, remaining steps are still attempted and failures reported. An interrupt (Ctrl-C) before the
recreate resumes the starts this upgrade paused; a rerun finishes an interrupted upgrade.

Restart-required: `minions status` and `minions doctor` (both with `--json`) report when the running
container no longer matches what the upgrade would give it (outdated image, container CLI version,
credential mounts, coordinator launch settings). Run `minions upgrade` to apply it. This check never
fails `doctor`.

Deferred (v0.1): the upgrade plan and the schema/config migration (config backup, drift checks of
managed files, the interrupted-operation journal). `minions doctor` lists "upgrade plan and schema
migration" as unavailable.
