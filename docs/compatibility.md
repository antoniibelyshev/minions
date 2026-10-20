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

## Known gaps

- **Intel (amd64) hosts** are not tested. The image is built natively on the host from a multi-arch
  base, so amd64 should work, but no amd64 run has been recorded.
- **Linux / Windows hosts** are untested; the host data root falls back to `$XDG_DATA_HOME/minions`
  on non-macOS hosts.
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
  the container cannot read it (untested).
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
- **Deferred features** (reported as unavailable by `minions doctor`): GitHub Issues backend,
  auto-merge and merge requests, review publication, the notification outbox, config plan/apply transactions,
  backlog migration, upgrade, budgets, companion containers, GitHub App short-lived tokens (a long-lived
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
  coordinator's poller. Telegram then stays down until the coordinator reconnects. minions cannot
  stop this from outside the plugin. Do not enable the plugin in a config dir that other sessions
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
