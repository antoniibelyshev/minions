# minions

minions installs a small Claude Code development team into a Git project on your Mac. A **coordinator** takes requests from a terminal or Telegram, keeps a backlog, and hands bounded pieces of work to **engineer** and **reviewer** workers (plus **testers** for QA sweeps). Approved work lands as local commits; you push it yourself.

Everything the model controls runs inside one Docker container per project. Your Mac runs only a small, trusted `minions` CLI that manages the container, credentials, and the import and export of the repository.

> **Status:** version 0.1. The full manual is [docs/guide.md](docs/guide.md); the command reference is [docs/cli.md](docs/cli.md).

## Built with minions

| Project | What the team built |
| - | - |
| [minions-chess-bot](https://github.com/antoniibelyshev/minions-chess-bot) | A chess engine in Rust (bitboards, alpha-beta search, NNUE evaluation), a self-play reinforcement-learning loop that trains the net in PyTorch, a benchmarking and Elo-testing harness, and a React web UI to play against it. Its best net plays at about 2600 Elo against a Stockfish `UCI_Elo` ladder (10+0.1, 800 games per bot; approximate). 35 tasks and 97 commits from 31 Oct to 14 Nov 2026, about 89M tokens on a Claude subscription; since 14 Nov the team plans its own next steps from [standing goals](docs/guide.md#task-lifecycle). |

## How it works

```
 macOS host                              Project container (Linux, non-root)
┌──────────────────────┐                ┌──────────────────────────────────────────┐
│ minions CLI          │  lifecycle,    │ Coordinator (main Claude Code session)    │
│  - install / config  │  read-only     │   ├─ minions:engineer  (subagent)        │
│  - Docker lifecycle  │  token files,  │   ├─ minions:tester    (subagent)        │
│  - credentials       │  explicit      │   └─ minions:reviewer  (subagent)        │
│  - import / export   │  import/export │ minions helpers (backlog, leases, policy) │
│                      │ ─────────────▶ │ Git clone + per-task worktrees            │
│ Keychain / 0600 files│                │ SQLite runtime state, private backlog     │
└──────────────────────┘                └──────────────────────────────────────────┘
                                            named volumes: repo, state, Claude, cache
```

- **The coordinator** turns your goals into tasks with acceptance criteria, splits them, picks models, and decides when to ask you.
- **Each task** goes engineer → verify → reviewer → merge. The engineer works on `agent/<task-slug>` in its own worktree and writes tests. The runtime runs your verification commands on the result. The reviewer checks the exact head commit. A failure goes back to the engineer, and after three repair cycles the coordinator replans.
- **Deterministic helpers** enforce the rules: no task is claimed twice, results are validated, and evidence is tied to commit SHAs. The model decides what to do; the helpers decide what is allowed.
- **State lives outside the conversation.** Backlog, decisions, and progress survive a lost session or a container restart, and the coordinator resets its own context to stay small.

## Requirements

- macOS (Linux is a preview)
- Docker Desktop with Compose v2
- Node.js 22.13 or later
- A Git repository (no remote needed)
- A Claude account or API key
- Optional: a Telegram bot for remote control

## Install and start

```sh
npm install -g github:antoniibelyshev/minions
minions setup path/to/your/repo
```

`minions setup` asks for the mode, sets up Claude authorization and (optionally) Telegram, builds the image, imports the committed history of your base branch, and attaches you to the coordinator. Rerunning it is safe. To upgrade, run `npm uninstall -g minions` first and then install again.

## Everyday use

| Command | What it does |
| - | - |
| `minions setup [path]` | Install or reconfigure minions for a repository |
| `minions start` | Start the team and attach to the coordinator |
| `minions status` | Queue, workers, pause state, spend. `--check` runs health checks |
| `minions settings` | List every setting; `settings set <key> <value>` changes one |
| `minions upgrade` | Move the running team onto the installed version without losing work |
| `minions down` | Stop the team; data is kept |
| `minions uninstall` | Remove minions from the project |

Then talk to the coordinator in plain language, in the terminal or over Telegram: "Add rate limiting to the public API", "What's the status?", "Pause new tasks", "Use opus for the migration task".

To take the team's work to your remote, on the host:

```sh
minions pull            # fetch the agents' branches and fast-forward your base branch
git push origin main
```

## Modes

| | `independent` | `supervised` |
| - | - | - |
| Who merges | The runtime lands approved, verified work on the local base | You review and merge everything |
| Runtime | Docker | Host |
| Communication | Telegram when a bot token is stored, daily digest | Terminal |
| Architecture | Decides and records decisions | Proposes; asks about risky changes |
| Limits | 3 tasks, 2 engineers | 2 tasks, 1 engineer |

In both modes deployment is denied, and changes to sensitive paths (agent and Git hook configuration, CI workflows) need your approval, signed on the host, before they land.

## Security

- Agents run as a non-root user in a container with a read-only root filesystem, dropped capabilities, and CPU, memory, and process limits.
- They never get the Docker socket, your home directory, your SSH agent, or your host Claude config. The workspace is a fresh clone, not a mount of your checkout.
- Secrets stay on the host (Keychain or 0600 files); configuration holds only references.
- Outbound internet is open by default, and workers share one container. A host runtime without Docker exists as an explicit, less safe opt-in.

Details: [Security model](docs/guide.md#security-model), [Running without Docker](docs/guide.md#running-without-docker).

## Documentation

- [Guide](docs/guide.md): configuration, permissions, roles and workflows, Telegram, Claude authorization, Codex reviewers
- [CLI reference](docs/cli.md)
- [Troubleshooting and recovery](docs/troubleshooting.md)
- [Specification](docs/spec.md) and [design notes](docs/design/)

## License

MIT, see [LICENSE](LICENSE). Claude Code, which the Docker image installs at build time, is distributed under Anthropic's own terms and is not covered by this license.
