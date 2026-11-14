# minions

A small Claude Code development team for your Git project. A **coordinator** takes requests from the terminal or Telegram, keeps a backlog, and hands work to **engineer** and **reviewer** workers. Verified work lands as local commits; you push it yourself. Agents run in a Docker container; your Mac runs only the `minions` CLI.

## Built with minions

[minions-chess-bot](https://github.com/antoniibelyshev/minions-chess-bot): a Rust chess engine with NNUE evaluation, a self-play training loop, an Elo harness and a web UI. It plays at about 2600 Elo (approximate) and was built in 35 tasks over two weeks. The team now plans its own next steps from standing goals.

## Install

Requires macOS, Docker Desktop, Node.js 22.13+ and a Claude account. Telegram is optional.

```sh
npm install -g github:antoniibelyshev/minions
minions setup path/to/your/repo
```

## Use

```sh
minions start      # start the team and attach to the coordinator
minions status     # queue, workers, spend
minions pull       # bring the team's work into your checkout, then git push
minions down       # stop the team; data is kept
```

Then talk to the coordinator in plain language: "Add rate limiting to the public API", "What's the status?"

## Docs

[Guide](docs/guide.md) · [CLI reference](docs/cli.md) · [Troubleshooting](docs/troubleshooting.md) · [Security model](docs/guide.md#security-model)

MIT licensed, see [LICENSE](LICENSE). Claude Code, installed into the image at build time, is under Anthropic's own terms.
