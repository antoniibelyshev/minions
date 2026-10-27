# Host manager assistant (natural language in the manager chat): design

Status: **proposed** (task-65). It needs the owner's agreement before any build task starts (poll ref
#task-53-claude). It extends [host-manager.md](host-manager.md) and revises its decision 1 (see
[Revision of decision 1](#revision-of-decision-1)).

## Goal

Owner request (Telegram msg 288, 2026-10-27): the owner should be able to talk to the host manager in plain language
("switch to manual merges", "what can I change?", "why is nothing happening?"). Today the manager accepts a fixed
command set and answers anything else with the help text. The owner cannot know every command and setting key. For
example, `/set delivery.mode pull-request` got "already pull-request; nothing to apply", when the owner meant the
merge setting (`delivery.merge`).

Owner direction (poll, option 1): a **Claude front-end on the host manager**. Claude explains the settings and the
commands, and it turns a request into a **normal change request**. The host still computes the plan
deterministically, and nothing applies until the owner taps Confirm. The deterministic `/commands` stay. They are the
fallback when Claude is unavailable or fails.

## Decisions

1. **The model only talks and proposes.** It has no tools. It cannot run commands, read files or reach the network
   (see [Invocation](#invocation)). The host gives it the facts it needs as data in the prompt, and it returns a
   reply text plus at most one **proposal**. A proposal is one `OwnerCommand` (`src/host/manager.ts`), the same value
   the transport's `parseOwnerCommand` builds from a typed command.
2. **A proposal is a typed command, nothing more.** The host checks it against a strict schema and passes it to the
   existing `ManagerCommands.propose`. `buildPlan` then validates it, computes the plan, the diff and the `loosens`
   text, and journals the offer. The owner confirms that offer with the same buttons, nonce, expiry, revision and
   digest checks, and the same double tap. The model adds no apply path and no approval path.
3. **Proposals are limited to a subset of kinds:** `config-set`, `restart`, `upgrade`, `sync` and `undo`. The model
   never proposes `approve` (a signed publication or merge approval) or the dev-only `rebuild-cli`. The owner types
   those as commands. An approval binds an exact head SHA from an awaiting-approval message. A model that rewrites or
   guesses that SHA is a risk with no benefit, and a typed command is already short.
4. **One proposal per reply.** A request that needs several changes is proposed one at a time. The reply names the
   next step, and the owner asks for it after confirming the first ("yes, next"). Two offers made at the same config
   revision would refuse each other on the revision check anyway.
5. **Slash commands never reach the model.** A message that starts with `/` is parsed exactly as today. Only other
   text from the paired owner goes to the assistant. Forwarded messages and other senders are still dropped
   without a reply.
6. **Stateless calls, short memory in the manager.** Each message is one `claude -p` call with a fresh config dir.
   The manager keeps the short conversation history in memory (see [Conversation state](#conversation-state)).
7. **No new top-level command.** The assistant is a part of the manager. It is set up in the manager step of
   `minions setup`, shown in `minions status`, and switched on and off in the chat with `/assistant on|off`.

## Revision of decision 1

[host-manager.md](host-manager.md) decision 1 says: "It does not interpret free text and it has no model". That
decision is revised as follows. **The apply path stays deterministic and model-free. Only the chat front-end may
use a model.** The reasons:

- A fixed command set needs the owner to know key names and value choices. The no-op `/set` above shows that the help
  text and `minions settings --list` on the host do not close that gap in a phone chat.
- What decision 1 protected still holds. Every change is still a host-computed plan bound to a digest, confirmed by
  the owner's tap, and run as the same child command. The model's output only selects which typed command to plan,
  and the owner could have typed that command anyway.
- The deterministic commands stay complete. Nothing becomes reachable only through the model.

## Trust boundary

```
owner (Telegram, paired)           host manager (owner's user)                 claude -p (child, no tools)
──────────────────────────         ─────────────────────────────────          ─────────────────────────────
free text  ───────────────────────► builds the context bundle (data) ───────► reply text + proposal JSON
                                     validates the proposal (schema)  ◄─────── (untrusted output)
                                     ManagerCommands.propose → buildPlan
                     ◄──────────────  assistant text (labelled, no buttons)
                     ◄──────────────  host offer: plan + Confirm / Reject
Confirm tap  ─────────────────────►  confirmOffer (nonce, expiry, revision, digest) → child apply
```

- **The model's output is untrusted.** It may be wrong, or steered by injected text. The host never acts on its
  reply text. A proposal is parsed with a strict schema (only the allowed kinds, only known fields, the same key,
  value and id patterns as `parseOwnerCommand`). Anything else is dropped and reported as "the assistant's proposal
  was invalid", and the reply text is still shown.
- **The Confirm tap on a host-computed plan stays the only approval.** The offer is a separate host message with the
  usual plan text, sent after the assistant's reply. Its summary line says "proposed by the assistant from your
  message", so the owner knows they did not type it. The plan carries `via: 'assistant'`. The field is absent for
  typed commands and container requests, so their digests stay unchanged. The journal records it for the audit.
  Host-owned keys may be proposed, because the owner's message is an owner-initiated request (host-manager.md owner
  decision Q2). They keep the double tap, as does any plan that loosens policy.
- **The assistant cannot claim an action.** Its text is plain text (no `parse_mode`, link previews off), goes through
  `displayText`, is cut to 1,500 characters and always starts with the fixed label `Assistant:`. Every outcome
  ("Applying…", "applied", "failed") comes only from the host. The system prompt tells the model to say "check the
  plan below" and never "done". The label and the separate offer message keep a misleading reply from hiding what
  the plan does.
- **Owner text is owner intent, but untrusted content.** The paired owner wrote it, but it may contain pasted text
  (an error message, a log line, a coordinator message). It cannot do more than the owner could type, because the
  only effect is a plan the owner confirms.
- **Secrets never reach the model.** The context bundle is built from an allowlist (below). It never includes
  tokens, credential references, `access.json`, journal nonces or digests (a nonce is the capability behind a
  Confirm button), approval signatures, file paths under the credential store, or environment values. The Claude
  credential the call uses is in the child's environment only, and a process with no tools cannot read it.
- **Container-originated text is kept out.** The free-text `reason` of container change requests is not in the
  bundle. Pending requests appear only as the host's own summaries. Runtime status uses the same typed fields as
  `/status`. That removes the main path for a prompt injection from the container into the model.

## Invocation

**Per message, `claude -p`, no session.** A long-lived session would need a persistent transcript, a supervised
second process and its own restart rules. A print-mode call per message costs a few seconds and keeps no state
outside the manager. The manager sends `sendChatAction typing` while it waits.

The call (built by a pure function, so tests check the argv):

- `claude -p --model <model> --output-format json`, with structured output against the proposal schema
  (`--json-schema`). If the installed CLI lacks it, the reply must end with one fenced JSON block, which the host
  parses with the same schema.
- **No tools:** `--tools ""`, plus `--disallowedTools` with every built-in tool and the `assistantDeniedPaths` rules
  from `src/host/assistant.ts` as defence in depth. `--strict-mcp-config` with an empty MCP config. No
  `--plugin-dir`, no `--channels`.
- **The setup assistant's safety model, reused:** `--permission-mode default` (never bypass, acceptEdits or auto),
  and `--settings` with `disableBypassPermissionsMode: "disable"`. In print mode, a tool that would prompt is denied,
  so `default` with no allowed tools means that nothing runs.
- **A fresh `CLAUDE_CONFIG_DIR` per call:** `<MINIONS_HOME>/manager/assistant/run-<random>` (0700), created before the
  call and removed after it. It is never `~/.claude` or the user's own config dir. So the call loads no user plugin
  and no Telegram channel, takes no bot (the task-51 failure class), and leaves no transcript. Session persistence is
  also off where the CLI supports it.
- **cwd** is an empty directory inside that run dir, so no `CLAUDE.md`, project settings or repository files load.
- **Env** is an allowlist (`PASS_ENV` from `src/host/runtime.ts` without `CLAUDE_CONFIG_DIR`), plus the fresh config
  dir and the assistant credential. Nothing else from the manager's environment passes through.
- **Input on stdin**, never in argv. The owner's text can be private and long, and argv is visible in `ps`.
- **Bounds:** a 60 s timeout (kill, then fallback), a 64 KiB output cap, owner text cut to 2,000 characters, and
  `--max-turns 1`.
- **Startup check.** The manager runs `claude --version` once and checks it against a minimum version that supports
  the safety flags above. If a safety flag is unknown, the assistant is disabled and reports why. It fails closed: it
  never runs without one of the flags.

**Authentication.** A fresh config dir has no login. A new host credential kind, `manager-claude-token`, holds a
long-lived Claude token (`claude setup-token`) or an Anthropic API key. It follows the rules of `manager-bot-token`:
fixed account `manager`, the host store, entered at the hidden prompt in `minions setup`, and never materialized for a
project. The manager reads it per call and passes it to the child as `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
in the environment, never in argv. Copying the user's own login into the run dir was rejected, because it would
spread a secret into a directory created for every message. Reusing a project's `claudeAuth` was rejected, because
the manager is host-wide.

**Model and cost.** The default is `sonnet`: the explanations need judgement, and a call is small. `haiku` and `opus`
can be picked in setup. The bundle is about 4k to 6k tokens (mostly the settings catalog), so one message costs a few
cents. Limits live in `<MINIONS_HOME>/manager/assistant.json` (`{version, enabled, model, dailyLimit}`, 0600,
written by setup and by `/assistant on|off`): 50 calls per day by default, and `--max-budget-usd 0.25` per call where
the CLI supports it. Over the limit, the manager answers with the deterministic fallback and says so once a day. The
assistant cannot change its own settings, because `/assistant` is a typed command and `assistant.json` is not a
proposal kind.

## Context bundle

The host builds the bundle for each call as JSON data. The system prompt says that everything in it is data, not
instructions. The bundle holds:

- **The settings catalog**, from `listSettings` (the source of `minions settings --list`) for the selected project.
  For each key: label, description, type, choices or minimum, current value, source layer, how a change takes effect
  (`takesEffect` and its one-line reason) and whether it is host-owned. This is what lets the model map "manual
  merges" to `delivery.merge manual`, and say "delivery.mode is already pull-request" before it proposes a no-op.
- **The command catalog:** the help lines, including what only typed commands do (`/approve`, and `/rebuild_cli`
  when it exists), so the model can tell the owner what to type.
- **Projects** (names, the selected one) and the **status** of the selected project (the typed fields of `/status`).
- **Pending offers** as host summaries (kind, summary, expiry), plus the ids of recent applied config changes for
  `/undo`. No nonces, digests or container reasons.
- **What is out of reach in the chat** (secrets, pairing, uninstall, `minions auth`), so the model can point to the
  terminal command instead.
- **The conversation history** (below).

The system prompt is a template (`templates/manager-assistant/system-prompt.md`). It covers the role, the label
rule, the "plan below, nothing applied yet" wording, the allowed proposal kinds, one proposal per reply, and asking
when a request is ambiguous instead of guessing.

## Conversation state

- In memory, for the paired owner chat only: the last 6 exchanges (owner text, assistant reply, the proposal's host
  summary, and the host outcome of that offer once it exists), at most 8 KiB in total.
- It is cleared after 30 minutes without a message, on `/project <name>` (another project's context), on
  `/assistant off`, and when the manager restarts. It is never written to disk. The only durable trace is the
  journaled offer with `via: 'assistant'`.
- Current values are read again for every call, so an old history entry cannot make the model work from stale
  settings.

## Discovery and explanations

- "What can I change?": the model summarizes the catalog by group, names the keys that need a restart or an upgrade,
  and points out the host-owned ones.
- "Switch to manual merges": the reply explains `delivery.merge` (`disabled` → `manual`: "minions may merge pull
  requests on GitHub when asked") and proposes `config-set delivery.merge manual`. The host plan follows. It is
  host-owned and loosens policy, so it asks twice.
- A no-op or an invalid request gets an explanation and no proposal. A proposal that `buildPlan` still refuses is
  answered with the host's usual `/<cmd> failed: <reason>` line after the reply.
- **The deterministic side improves as well (phase 1).** It must stay useful without a model. `/settings [query]`
  lists keys with their values, sources, how a change takes effect and the host-owned mark, filtered by group or by a
  key substring. A no-op `/set` names the current value, its source and the other choices. An unknown key lists the
  closest keys.

## Failure and fallback

Each of the following gets one reply: `Assistant unavailable (<reason>). Commands:` and the help text. The manager
loop and the commands are never affected:

- the assistant is switched off, not set up, or has no credential;
- `claude` is not on PATH, or it is older than the minimum version;
- the daily limit is reached;
- a timeout, a non-zero exit, output over the cap, or output that is not valid JSON;
- an auth error (401 or an expired token: the reason names `minions setup`).

An invalid proposal next to a valid reply shows the reply and "the assistant's proposal was invalid; nothing was
planned". The last assistant error is shown in `minions status` (manager block) and in the chat `/status`, once per
distinct reason. A failure never tries a second strategy, and never retries a call by itself.

## CLI surface

No new top-level command (the minimal CLI surface):

- `minions setup`, manager step: a new optional sub-step "Natural-language assistant (uses Claude)". It asks yes or no
  (default no), the model, and the token (hidden prompt or `--manager-claude-token-stdin`). `--yes` never enables it.
- `minions status` / `doctor`, manager block: assistant enabled, model, calls today and limit, last error. A new
  `manager.assistant` check warns and never fails.
- Manager chat: `/assistant on|off|status` and `/settings [query]`. Both are deterministic and never call the model.

## Phases

Proposed child tasks. Do not file them before the owner agrees to this design.

1. **child: Deterministic discovery in the manager chat** | criteria: `/settings [query]` lists keys with value,
   source, takes-effect and host-owned mark from `listSettings`, filtered by group or key substring and cut to the
   message limit; a no-op `/set` names the current value, its source and the other choices; an unknown key suggests
   the closest keys; the help text lists `/settings`; tests with the fake transport | depends: none
2. **child: Assistant invocation and credential** | criteria: `manager-claude-token` credential (host store, account
   `manager`, never materialized for a project, hidden prompt or stdin in the setup manager step, `--yes` never
   enables it); `assistant.json` (enabled, model, dailyLimit); a pure argv and env builder (no tools, empty MCP config,
   permission mode default, bypass disabled, deny rules reused from `assistant.ts`, a fresh `CLAUDE_CONFIG_DIR` under
   `<MINIONS_HOME>/manager/assistant/` removed after the call, an empty cwd, stdin input, no secret in argv, never the
   user's config dir); timeout, output cap and a fail-closed minimum-version check; tests with a fake spawn only (no
   real `claude` run); `status` / `doctor` `manager.assistant` | depends: none
3. **child: Context bundle and proposal schema** | criteria: the bundle from `listSettings`, the help lines, typed
   status, pending offer summaries and undo ids, and nothing else (a test asserts that no nonce, digest, token,
   credential path or container reason appears); a strict proposal schema mapping to the allowed `OwnerCommand` kinds
   with the `parseOwnerCommand` patterns; `approve`, `rebuild-cli`, unknown fields and more than one proposal are
   refused; the system prompt template | depends: 2
4. **child: Chat integration and fallback** | criteria: non-slash owner text goes to the assistant, slash commands
   never do; the labelled reply first, then the host offer through `ManagerCommands.propose`, with `via: 'assistant'`
   in the plan and the journal (the digests of typed and container plans unchanged); the double tap is unchanged for
   loosening plans; in-memory history (6 exchanges, 8 KiB, 30-minute idle clear, cleared on `/project` and
   `/assistant off`); the daily limit; `/assistant on|off|status`; every failure in
   [Failure and fallback](#failure-and-fallback) falls back to the help text, tested with a fake assistant runner;
   docs (README, cli.md, host-manager.md); a live check run by the coordinator (below) | depends: 1, 3

**Live check (coordinator only, for phase 4).** No worker launches Claude. With no worker running, the coordinator
runs one real call through the manager's runner on a scratch `MINIONS_HOME` (the runner creates its own fresh
`CLAUDE_CONFIG_DIR`). It checks three things: "switch to manual merges" yields a valid `config-set delivery.merge
manual` proposal; "what can I change?" yields no proposal; and a request to approve a task yields no proposal and
names `/approve`.
