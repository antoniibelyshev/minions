# Channel spike harness (phase 0 of the Telegram channel design)

Task-2. Phase 0 of [docs/design/telegram-channel.md](../../../docs/design/telegram-channel.md). The host coordinator
starts with `--setting-sources= --strict-mcp-config` (`HOST_CLAUDE_FLAGS` in `src/runtime/coordinator.ts`), so it
cannot load the official Telegram plugin. The planned replacement is our own MCP channel server, passed with
`--mcp-config`. This spike answers three questions with a trivial server before more of that design is built:

1. Does `--dangerously-load-development-channels` accept a server from `--mcp-config`, and with which spec?
2. Does Claude Code ask for a confirmation at start, and does it ask again on every start?
3. Do channel notifications reach a session that runs detached in tmux?

Only the harness is built here. No worker started Claude for it: the live run is done later, by the coordinator or the
owner (see [Who runs it](#who-runs-it)).

## Files

- `server.mjs`: a stdio MCP server with no dependencies (Node 22 or newer, nothing to install). It declares
  `capabilities.experimental["claude/channel"] = {}` and `tools: {}`. After the client sends `notifications/initialized`,
  it sends one `notifications/claude/channel` with `meta.kind=start, seq=1`, then one `kind=tick` notification per
  timer period. It has one tool, `spike_ack {seq, note}`. Every received message, sent notification and tool call is
  appended as a JSON line to the log file. stdout carries JSON-RPC only.
  - `SPIKE_LOG`: the log file. Default: `$TMPDIR/channel-spike.log`.
  - `SPIKE_INTERVAL_MS`: the timer period. Default `30000`. `0` turns the timer off.
  - `SPIKE_MAX_TICKS`: the timer stops after this many ticks. Default `20`.
- Tests: `test/dev-channel-spike.test.ts` checks the handshake, that no notification comes before `initialized`, the
  timer and its limit, tool-call logging, and the error replies.

This is a dev tool only. It is not shipped (`package.json` `files` leaves `scripts/` out) and no launch path uses it.

## What `claude --help` and the 2.1.308 binary say (no session started)

Checked on Claude Code **2.1.308** (`claude --version`). Only `claude --version`, `claude --help`, and a `strings`
search of the binary (`/opt/homebrew/Caskroom/claude-code/2.1.308/claude`) were used. Nothing was launched.

`claude --help` lists:

- `--mcp-config <configs...>`: "Load MCP servers from JSON files or strings (space-separated)". Variadic.
- `--strict-mcp-config`: "Only use MCP servers from --mcp-config, ignoring all other MCP configurations".
- `--setting-sources <sources>`: user, project, local.
- `--plugin-dir <path>` (repeatable), `--plugin-url <url>`, `-p/--print`.

`claude --help` does **not** list `--channels` or `--dangerously-load-development-channels`. They are still hidden, as
on 2.1.292.

The binary shows the following. This is read from the bundled code, so the live run must confirm it:

- Both hidden options exist and are variadic: `--channels <servers...>` and
  `--dangerously-load-development-channels <servers...>`.
- Each entry must have a tag. An entry without one fails with
  `<flag> entries must be tagged: <entries>`, followed by the two forms:
  - `plugin:<name>@<marketplace>`: "plugin-provided channel (allowlist enforced)"
  - `server:<name>`: "manually configured MCP server"
  
  So for a `--mcp-config` server named `spike` the candidate spec is **`server:spike`**.
- The development flag is read only when the session is interactive (`if (!<non-interactive>)`). With `-p` it is
  ignored, as the docs say.
- An interactive start with development channels shows a dialog (`DevChannelsDialog`), titled
  **"WARNING: Loading development channels"**. It explains that the flag is for local channel development only, lists
  the channels (`server:spike`), and has two choices: **"I am using this for local development"** (confirm) and
  **"Exit"** (cancel, exits with code 1). No code path was found that saves the answer. Expect the dialog **on every
  start**. The dialog is skipped when channels are off for the session, when the API provider is not first party, or
  when the managed policy blocks channels.
- A server is gated as a channel when it declares `experimental["claude/channel"]`. Notifications use the method
  `notifications/claude/channel`. The relay method `notifications/claude/channel/permission` also exists, but this
  spike does not use it.
- The org gate is the managed setting `channelsEnabled` (claude.ai Team/Enterprise: off by default) and
  `allowedChannelPlugins`. The error texts are "channels not enabled by org policy (set channelsEnabled: true in
  managed settings)" and "is not on the approved channels allowlist (use --dangerously-load-development-channels for
  local dev)".

## Who runs it

The run needs an **interactive** Claude session in a terminal or tmux. The existing live-run path cannot do it:

- `minions coordinator live-run` refuses `--dangerously-load-development-channels` and `--channels` (`REFUSED_FLAGS` in
  `src/runtime/headless.ts`).
- It runs Claude headless (`-p`), and in that mode the development flag is ignored anyway.
- It is not available in the host runtime (`commands.ts`: "Live Claude runs are not available in the host runtime").

So the coordinator, at a controlled moment with no worker running, or the owner runs the steps below in a host terminal
outside the sandbox. Use a throwaway `CLAUDE_CONFIG_DIR`, so no plugin from the real config dir (above all the Telegram
poller) loads. Workers never run these steps.

## Steps

### 1. Setup (one shell)

```sh
REPO="$(git rev-parse --show-toplevel)"            # a checkout that contains this directory
SPIKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/channel-spike.XXXXXX")"
export CLAUDE_CONFIG_DIR="$SPIKE_DIR/config"      # fresh: no plugins, no settings, no MCP servers
mkdir -p "$CLAUDE_CONFIG_DIR"
cat > "$SPIKE_DIR/mcp.json" <<EOF
{ "mcpServers": { "spike": {
  "command": "$(command -v node)",
  "args": ["$REPO/scripts/dev/channel-spike/server.mjs"],
  "env": { "SPIKE_LOG": "$SPIKE_DIR/spike.log", "SPIKE_INTERVAL_MS": "30000", "SPIKE_MAX_TICKS": "10" }
} } }
EOF
echo "$SPIKE_DIR"
```

A fresh config dir has no login. Before the first run, provide a credential through the environment, never in argv.
Use `export CLAUDE_CODE_OAUTH_TOKEN=...` (from `claude setup-token`) or `export ANTHROPIC_API_KEY=...`. You can also
log in once in the dialog of the first run. The first run may also show onboarding (theme) and the folder-trust dialog.
Those come from the fresh config dir and are not the dialog this spike is about. Answer them, then run the candidate
again (step 3) to see what remains at a normal start.

Optional sanity check of the server without Claude (prints the init reply and the start notification):

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' | SPIKE_INTERVAL_MS=0 node "$REPO/scripts/dev/channel-spike/server.mjs"
```

### 2. Argv candidates

All candidates use the host coordinator's flags (`--setting-sources= --strict-mcp-config`). The options are variadic,
so the prompt goes after `--`. Run each one in the foreground first (`claude ...` in the shell from step 1), then
detached (step 3).

| # | argv (after `claude`) | Purpose | Expected (from the binary) |
| - | - | - | - |
| A | `--setting-sources= --strict-mcp-config --mcp-config "$SPIKE_DIR/mcp.json" --dangerously-load-development-channels server:spike -- "Wait for channel messages and answer each with spike_ack."` | Main candidate | The "WARNING: Loading development channels" dialog lists `server:spike`. After confirming, `<channel source="spike" kind="start" seq="1" ...>` reaches the session, followed by ticks every 30 s |
| B | Same as A with `--dangerously-load-development-channels=server:spike` | `=` form (a single value, so nothing more can be swallowed) | Same as A |
| C | Same as A with the bare `spike` (no tag) | Confirms the parser | Exits with "--dangerously-load-development-channels entries must be tagged: spike" |
| D | Same as A without `--dangerously-load-development-channels ...` | Control | No dialog. The server loads (`/mcp` lists `spike`, the `mcp__spike__spike_ack` tool works), but no `<channel>` reaches the session. The log still shows `notify` lines |
| E | Same as A with an inline config: `--mcp-config '{"mcpServers":{"spike":{"command":"node","args":["<abs path>/server.mjs"],"env":{"SPIKE_LOG":"<abs path>/spike.log"}}}}'` | JSON string instead of a file | Same as A |
| F | Same as A plus `-p` with the prompt on stdin | Headless control | No dialog and no channel: the flag is ignored with `-p` |
| G | Same as A plus `--channels server:spike` | Whether the allowlisted flag takes a server entry | Expected: the server is not on the allowlist, so a startup notice and no delivery. Record what happens |

### 3. Detached tmux (the real question)

The tmux server does not inherit the shell's exports, so pass the environment in the command:

```sh
tmux new-session -d -s chspike -x 200 -y 50 \
  "env CLAUDE_CONFIG_DIR='$CLAUDE_CONFIG_DIR' claude --setting-sources= --strict-mcp-config \
     --mcp-config '$SPIKE_DIR/mcp.json' --dangerously-load-development-channels server:spike \
     -- 'Wait for channel messages and answer each with spike_ack.'; sleep 600"
sleep 5; tmux capture-pane -p -t chspike          # is the dev-channels dialog waiting?
tmux send-keys -t chspike Enter                    # picks the highlighted first choice: "I am using this for local development"
sleep 40; tmux capture-pane -p -S -200 -t chspike  # start and tick notifications, spike_ack calls
cat "$SPIKE_DIR/spike.log"
tmux kill-session -t chspike
```

If a credential comes from the environment (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), the tmux server only
sees it when it was started from that shell. Otherwise log in once in the foreground run (step 2) first. Never put the
token in the tmux command line. Then start the same session a second time, with the same config dir, to see whether the
dialog comes back.

### 4. What to observe and record

| Question | Where to look | Record |
| - | - | - |
| Spec accepted for a `--mcp-config` server | A/B/E start, C error text | The exact working form (`server:spike`?), and whether `=` matters |
| Confirmation at start | The first pane capture | Dialog title and choices. Whether it shows on the **second** start with the same config dir. Whether `Enter` through `send-keys` accepts it |
| Delivery when detached | Pane after `send-keys`, `spike.log` | `<channel source="spike" ...>` with the meta attributes (`kind`, `seq`, `sent_at`). Whether ticks arrive while the session is idle and with no client attached. `tool-call` lines in the log (`spike_ack` with the seq) |
| Server lifecycle | `spike.log` | `spawned`, `initialize` (the client's protocol version and capabilities), `initialized`, `stdin-closed` at exit. Spawn count per session (one, or one per reconnect?) |
| Control D | Pane and log | `notify` lines in the log but nothing in the session. This proves the flag gates delivery |
| Org or provider gate | Startup notices | Any "channels not enabled by org policy" or allowlist notice |

Write the results into `docs/design/telegram-channel.md` (the phase 0 entry and the Unknowns table): the spec syntax,
whether the dialog shows and whether it repeats, and whether notifications arrive detached. The design's fallback
applies if the dialog shows on every start and `send-keys` cannot accept it reliably. Then try a `--plugin-dir` plugin
spec (`plugin:<name>@<marketplace>`; which marketplace name a `--plugin-dir` plugin gets is unknown). If that also asks
every time, keep the official plugin.

Clean up: `rm -rf "$SPIKE_DIR"`. That also removes the throwaway config dir and its transcripts.
