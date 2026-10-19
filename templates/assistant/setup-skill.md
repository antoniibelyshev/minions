---
name: setup
description: Finish setting up minions for this repository after `minions init` - gather state, close gaps (GitHub, Claude auth, Telegram, verification commands, models, first tasks), then verify with minions doctor.
---

# Finish minions setup

Work through the steps in order. Keep each message short: what you found, what you recommend, and what you need from the user. Skip steps that are already done.

## 1. Gather context first (read-only, no questions yet)

Run these and read the results before proposing anything:

- `minions doctor --json` (readiness; every `warn`/`fail` check with its hint)
- `minions status --json` (queue and controls; it fails with a precondition error while the runtime is not started, which is fine)
- `minions auth show --json` (Claude authorization method; never contains a key)
- `minions config show --explain` (effective configuration and the source of each value)
- `git remote -v`, `git status --short`, `git log --oneline -5`
- Build and CI files: `package.json` (scripts), `Makefile`, `justfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.github/workflows/*`, `CONTRIBUTING.md`, `CLAUDE.md`

Then give the user a short list of the gaps you found and ask what they want to do first. Ask about their goals for the team (step 8) early: it shapes the rest.

## 2. GitHub (only if delivery should reach GitHub)

If `github.setup` or `github.credential` is not `ok` and the user wants branches or pull requests: explain in two lines what a per-project fine-grained token enables, then ask the user to run `! minions setup github` (guided: remote, base branch, pre-filled token page, hidden token prompt, delivery mode). Do not run it, do not push, do not open the token page yourself. Afterwards rerun `minions doctor --json` and check `github.setup`.

## 3. Claude authorization for the agents

From `minions auth show --json`, explain the current method and the options in a few lines:

- `login` (default): docker runtime - the user logs in with `/login` inside the coordinator on the first `minions start`; host runtime - the user's own Claude Code login is used.
- `api-key`: the host reads a key from the Keychain, a file, or an environment variable and provisions it read-only (`minions auth set api-key --keychain-service <service> --keychain-account <account>`, or `--file <path>`, or `--env-var <NAME>`).
- `helper`: a host command that prints a key (`minions auth set helper -- <argv...>`); `jbcentral` when JetBrains Central is installed.

The user runs the chosen `! minions auth set ...` themselves (it shows the plan and asks). Never handle the key.

## 4. Telegram (optional)

Only if the user wants remote control: explain that it uses the official Claude Code channel plugin with their own bot (BotFather `/newbot`), one bot per project. Switching `communication.channel` to `telegram` is a configuration edit (step 5 procedure). The bot token goes in with `! minions auth telegram`. Pairing happens later in the coordinator terminal (`/telegram:access pair <code>`, then `/telegram:access policy allowlist`).

## 5. Verification commands

`verification.commands` are the checks the agents run before handing work over. Infer them only from the repository's real scripts and CI (for example `npm run typecheck`, `npm test`, `make check`), prefer what CI runs, and skip commands that need secrets, a network service, or a GUI. Propose the list with one line of reasoning per command.

To change the configuration (this step and steps 4 and 6):

1. Read `{{configPath}}`.
2. Show the exact diff (including `configRevision` + 1) and ask for a yes.
3. Edit only after the yes; keep the JSON valid and the rest of the file unchanged.
4. Run `minions config show --explain` to validate. On an error, fix or revert.
5. Tell the user it applies on the next `minions start`{{commitNote}}.

## 6. Models, effort and budgets

Explain the current `models` block in two lines (`default`, `allowed`, `selection`, optional `effort` and `coordinator`) and recommend keeping the defaults unless the user has a reason (cost, a specific model). Budgets (`budgets.taskUsd`, `budgets.dailyUsd`) are not enforced in v0.1: recommend leaving them `null`. Changes follow the step 5 procedure.

## 7. Doctor warnings

Walk through the remaining `warn`/`fail` checks from `minions doctor --json`. For each: one line on what it means and the exact command from its hint. List what the user must do (start Docker, `minions start`, `/login`); do not do it yourself.

## 8. First backlog tasks

Ask the user what they want the team to work on first. Turn the answer into 1-5 small, independent tasks, each with a title, a short description, 2-4 acceptance criteria, and a priority. Show them for review.

`minions backlog ...` runs only inside the agent runtime, so you cannot create tasks from here. Give the user one ready-to-paste message for the coordinator (after `minions start`), for example "Create these tasks in the backlog: ...". {{intakeNote}}

## 9. Finish

Run `minions doctor` and summarize in a short list:

- **Done:** what changed in this session (files edited, commands the user ran).
- **Remaining:** each open item with the exact command the user runs, for example `minions start`.
