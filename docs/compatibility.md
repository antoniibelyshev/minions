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
| Backlog.md (in image) | `backlog.md@1.54.0` | Pinned in `docker/Dockerfile`. |
| Telegram channel plugin | `telegram@claude-plugins-official` 0.0.7 (marketplace commit `1e96c6b`) | Interface read and install verified on Claude Code 2.1.292 without credentials; not shipped in v0.1. Needs Bun, which the image does not include yet. `minions telegram probe` and doctor check `telegram.plugin` report availability. See [design/telegram.md](design/telegram.md). |
| System packages (in image) | git, tmux, ca-certificates, ripgrep, less, procps (Debian bookworm) | Installed at build time only. |

`MINIONS_DOCKER_TESTS=1 npx vitest run test/docker` builds the image (tag `minions-test-runtime:latest`),
starts a test project, and checks: uid 1000, not privileged, read-only rootfs, `cap_drop: ALL`,
no-new-privileges, CPU/memory/pids limits, no Docker socket, only read-only binds for the plugin and
runtime config, loopback-only published ports, no host network/PID namespace, host paths and
ignored `.env` absent, volumes survive recreation. All test resources are removed afterwards.

`npm run e2e` (scripts/e2e.sh) drives the full terminal workflow without a Claude login: pack and
install into a temp prefix, private and shared `init`, `doctor`, `start --no-attach`, the
engineer → tester → reviewer lease flow, hooks, `export`, restart persistence, and `uninstall`.
It uses a temp `MINIONS_HOME` and disposable repos and removes its containers and volumes on exit.

## Known gaps

- **Intel (amd64) hosts** are not tested. The image is built natively on the host from a multi-arch
  base, so amd64 should work, but no amd64 run has been recorded.
- **Linux / Windows hosts** are untested; the host data root falls back to `$XDG_DATA_HOME/minions`
  on non-macOS hosts.
- **No prebuilt image** is published; the first `minions start` builds `minions-runtime:<version>`
  locally (needs network access to Docker Hub, Debian mirrors, and npm). The image carries a
  `minions.build` label (hash of `dist/cli.js`, the Dockerfile and `package.json`); `minions start`
  rebuilds it when the installed package differs, and `doctor` warns about a stale image.
- **Claude login** happens interactively inside the container (`/login`) and is stored in the
  project's `claude` volume. API-key provisioning and host login reuse are not supported.
- **GitHub token file ownership**: the materialized token (`/opt/minions/secrets/github-token`) is a
  0600 file owned by the host user. Docker Desktop on macOS maps bind-mount ownership so the
  container user (uid 1000) can read it. On a Linux Docker Engine whose host user is not uid 1000,
  the container cannot read it (untested).
- **Outbound network is unrestricted** in the container (`network: outbound-internet`). There is no
  egress allowlist, and the container can reach the host/LAN like any Docker Desktop container.
- **Single container, shared credentials**: engineer, tester, and reviewer run in one container and
  can read the same in-container files (incl. the Claude login). There is no per-worker isolation.
- **Repository import** copies committed history of the base branch only (Git bundle). Uncommitted,
  untracked, and ignored files are never imported; tracked secret-looking files trigger a warning
  but detection is best effort.
- **Deferred features** (reported as unavailable by `minions doctor`): GitHub Issues backend,
  branch/PR/auto-merge delivery, review publication, Telegram, config plan/apply transactions,
  backlog migration, upgrade, budgets, companion containers.
- Native macOS/iOS builds (Xcode) cannot run inside the Linux runtime.
