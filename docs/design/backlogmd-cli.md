# Backlog.md CLI reference for the minions adapter

Tested on 2026-10-19 with `backlog.md@1.54.0` from npm on darwin-arm64. Every behavior below was observed by running the CLI. Nothing here comes only from the docs.

The npm package is a thin Node launcher (`cli.js`). It spawns a prebuilt Bun binary from the platform package `backlog.md-<os>-<arch>` (about 96 MB). The binary is `node_modules/.bin/backlog`.

## TL;DR for the adapter

- Always pass `--json` (for `task list`/`task view`) or `--plain`, and always pass the required positional args (title, id). With a TTY, `task view` without flags opens a full-screen blessed TUI, `task create` without a title prompts, and `config` without a subcommand starts a wizard. With piped stdio (non-TTY) those commands fall back to plain text or fail fast with exit 1. Nothing hung in non-TTY use, and no command opened an editor or browser in the commands we use. Run with `stdin` closed or piped, not inherited.
- Errors go to **stderr**, the exit code is **1**, and stdout is empty. Error output is never JSON, even with `--json`.
- `task create` has **no `--json`**. Parse the ID from stdout line 1, `Created task TASK-7`, or from line 2, `File: <abs path>`. Then call `task view <id> --json`.
- `task list --json` does **not** include `description`, `dependencies`, AC items, notes, or comments. Use `task view <id> --json` for those.
  No command returns full task bodies in bulk (`search --json` and `--watch` emit the same summaries), so listings read `backlog/tasks/*.md` in-process (`src/backlog/taskfile.ts`, task-24.1): one `task list --json` for the set, order and archived/draft filtering, then a strict parser for the file layout Backlog.md 1.54 writes. A file outside that layout (comments, legacy unmarked sections, unknown keys, CRLF, `[X]` boxes, AC index gaps, duplicate ids) or one that disagrees with its list summary falls back to `task view` for that task only. Writes still go through the CLI.
- **Terminal ("completed") status is hard-coded as the LAST entry of `statuses`.** The name "done" means nothing special. Readiness, `isReady`, `--ready`, `dependencyGraph.nodes[].completed`, and `backlog cleanup` all use the last status. See "Statuses" below.
- Statuses with hyphens work fine. You can't set them with `config set`. Write `config.yml` directly.
- `task edit --dep` **replaces** the whole dependency list. It does not append.
- HTML comments in descriptions (`<!-- minions:meta {...} -->`) round-trip byte-for-byte, except that the description is **trimmed** at both ends.

## Project setup (non-interactive)

### Option A: pre-write config.yml (recommended, no init needed)

The CLI works with only `backlog/config.yml` present. It creates `backlog/tasks/` and `backlog/.locks/` lazily on first write.

```yaml
project_name: "minions"
default_status: "idea"
statuses: ["idea", "ready", "implementing", "testing", "reviewing", "changes-requested", "awaiting-human", "awaiting-ci", "merging", "blocked", "cancelled", "delivered", "done"]
labels: []
date_format: yyyy-mm-dd
auto_open_browser: false
remote_operations: false
auto_commit: false
filesystem_only: true          # disables all git integration (what --no-git writes)
check_active_branches: false
task_prefix: "task"
# zero_padded_ids: 3           # optional -> TASK-001
# onStatusChange: 'cmd'        # optional hook, see below
```

Config file locations, searched in this order: `backlog/config.yml`, `.backlog/config.yml`, `backlog.config.yml` (root). Root discovery walks up from cwd, or starts from `$BACKLOG_CWD` if set. There is no global `--cwd` flag, except on `mcp start`. Set `cwd` on the subprocess, or set `BACKLOG_CWD`.

### Option B: `backlog init`

```sh
backlog init "minions" --defaults --integration-mode none            # inside a git repo
backlog init "minions" --defaults --integration-mode none --no-git   # no git; writes filesystem_only: true
```

- `--integration-mode none` **cannot be combined with** `--agent-instructions` (`Skipping AI integration cannot be combined with --agent-instructions or --install-claude-agent.`, exit 1). With the default `cli` mode, init writes agent instruction files (CLAUDE.md/AGENTS.md). Use `none` to avoid that.
- Running outside a git repo without `--no-git` and with no TTY exits 1: `No Git repository found and no interactive terminal is available...`.
- Running in a git repo without `--defaults` and with no TTY still succeeded with defaults. Pass `--defaults` anyway.
- Other useful flags: `--task-prefix <letters>` (default `task`, read-only afterwards), `--zero-padded-ids <n>`, `--backlog-dir <path>`, `--config-location folder|root`, `--auto-open-browser false`, `--check-branches false`, `--include-remote false`.
- init always writes `statuses: ["To Do", "In Progress", "Done"]`. Afterwards, rewrite the `statuses:` and `default_status:` lines yourself.
- In a git repo with no remote, init prints a `remoteOperations` warning to stdout. Fix it with `backlog config set remoteOperations false`.
- init never committed anything with the defaults (`auto_commit: false`). The created files were left untracked.

### `config` subcommands

```sh
backlog config list
backlog config get statuses        # -> "idea, ready, implementing, ..." (comma+space joined)
backlog config set autoCommit false
backlog config set remoteOperations false
backlog config set checkActiveBranches false
backlog config set autoOpenBrowser false
backlog config set statuses ...    # REFUSED, exit 1: "statuses cannot be set directly ... Edit the list in the project config file"
```

`taskPrefix` is read-only. `backlog config` without a subcommand starts an interactive wizard, so avoid it.

## Statuses

- All 13 of our statuses were accepted, hyphens included. Values are matched **case-insensitively** (`-s READY` is stored as `ready`). An invalid status fails with exit 1: `Invalid status: nonsense. Valid statuses are: idea, ready, ...`.
- **The terminal status is `statuses[statuses.length - 1]`**. This is hard-coded (`function fv(e){...return e[e.length-1]}`) and has no config key. Test: with `cancelled` last, a dependency in `done` or `delivered` stayed *blocking*, and a dependency in `cancelled` counted as completed.
  - **Fix:** order the list so the status that should unblock dependents comes last. The sample config above puts `done` last. If both `done` and `delivered` must unblock dependents, Backlog.md can't express it. The adapter should then compute readiness itself from `dependencies` plus statuses, and ignore `isReady`/`readiness`/`--ready`.
  - Board column order follows list order, which is cosmetic.
- `Draft` is a special pseudo-status for drafts (`--draft`). Don't use it.
- `--plan`/`--notes` on create are documented as "only for an active status", but this isn't enforced. `--notes` on an `idea` task worked.

## IDs and files

- Default IDs are `TASK-<n>`, and are output in **uppercase**. Input is case-insensitive: `task-3`, `TASK-3`, and bare `3` all work.
- A custom prefix (`--task-prefix mn`) gives `MN-1`. With `zero_padded_ids: 3` you get `MN-001`, and `mn-1` still resolves.
- **Subtasks get hierarchical IDs**: `task create -p task-1 ...` produces `TASK-1.1`. The parent's view lists them under `subtasks: [{id,title}]`.
- File path: `backlog/tasks/<lowercase-id> - <Title-with-dashes>.md`, for example `backlog/tasks/task-1.1 - Child-task.md`. View JSON returns the relative `path`. Create prints the absolute path.
- The file format is YAML frontmatter plus sections fenced by markers (`<!-- SECTION:DESCRIPTION:BEGIN -->`, `<!-- AC:BEGIN -->`, `<!-- SECTION:NOTES:BEGIN -->`, `<!-- COMMENTS:BEGIN -->`).
- Timestamps have **minute resolution** (`'2026-10-19 10:15'`). Don't use `updatedAt` for fine-grained change detection.

## Commands the adapter uses

### Create

```sh
backlog task create "Title" \
  -d $'multi\nline description' \
  --ac "First AC" --ac "Second AC" \
  --priority high            # case-insensitive; configured: High, Medium, Low (stored as given, e.g. "high")
  -l "foo,bar-baz"           # or repeat -l
  --dep task-2 --dep task-3  # or comma list; deps must exist
  -p task-1                  # parent -> child id TASK-1.1
  -s implementing            # default_status if omitted
  --notes "text"             # implementation notes (optional)
```

Stdout (exit 0):

```
Created task TASK-1.1
File: /abs/path/backlog/tasks/task-1.1 - Child-task.md
```

Literal `\n` is stored as text. Pass real newlines (an argv array, not a shell string). An invalid priority fails with `Invalid priority: urgent. Valid values are: High, Medium, Low` (exit 1). Other flags: `-a @name`, `--type`, `--milestone`, `--ref`, `--doc`, `--dod`, `--no-dod-defaults`, `--ordinal`, `--draft`.

### Edit

```sh
backlog task edit task-1.1 -s testing
backlog task edit task-1.1 -d $'new description'      # replaces
backlog task edit task-1.1 --append-notes "note A" --append-notes "note B"   # joined with a blank line
backlog task edit task-1.1 --notes "replace all notes"
backlog task edit task-1.1 --check-ac 1 --check-ac 2   # 1-based; also --uncheck-ac, --remove-ac, --ac (add)
backlog task edit task-1.1 --dep task-2,task-3 --dep task-1   # SETS full list -> [TASK-2, TASK-3, TASK-1]
backlog task edit task-1.1 --clear-deps
backlog task edit task-1.1 --add-label x --remove-label foo   # -l/--label replaces all
backlog task edit task-1.1 --comment "text" --comment-author minions
backlog task edit task-1 task-2 -s blocked              # several IDs, same change
```

Stdout: `Updated task TASK-1.1` (exit 0). Several flags in one call apply atomically. If any check fails, nothing changes and you get `No changes were applied.`

Dependency validation, with exit 1 and no changes applied:
- Cycle: `These dependencies would create a cycle: TASK-1 -> TASK-1.1 -> TASK-2 -> TASK-1`
- Self: `Task TASK-3 cannot depend on itself ("task-3" names this task).`
- Missing: `The following dependencies do not exist: task-99. Please create these tasks first or verify the IDs. ...`
- `backlog doctor` reports cycles and self-dependencies in existing files, for example ones edited by hand.

Comment bodies can't contain a standalone `---` line (exit 1).

### List

```sh
backlog task list --json [-s ready,implementing] [--exclude-status done] [-p task-1] [-l a,b] [--ready] [--search q] [--sort id] [--max-count n --skip n]
```

```json
{
  "schemaVersion": 1,
  "kind": "task-list",
  "tasks": [
    {
      "id": "TASK-1.1",
      "title": "Child task",
      "status": "implementing",
      "archived": false,
      "type": null,
      "priority": "medium",
      "project": null,
      "assignees": [],
      "reporter": null,
      "labels": ["foo", "bar-baz"],
      "milestone": null,
      "parentTaskId": "TASK-1",
      "acceptanceCriteriaCompleted": 1,
      "acceptanceCriteriaCount": 2,
      "references": [],
      "modifiedFiles": [],
      "ordinal": 3000,
      "createdAt": "2026-10-19T10:15:00Z",
      "updatedAt": "2026-10-19T10:16:00Z",
      "dueDate": null,
      "isReady": false
    }
  ]
}
```

With `--max-count`/`--skip`, the top level also gets `"total": 5, "nextSkip": 1`. `--json --watch` streams full replacement JSON documents, which could later replace polling. Without `--json`/`--plain` in a non-TTY you get plain text grouped by status.

### View

```sh
backlog task view task-1.1 --json
```

```json
{
  "schemaVersion": 1,
  "kind": "task-view",
  "task": {
    "id": "TASK-1.1",
    "title": "Child task",
    "status": "implementing",
    "archived": false,
    "type": null,
    "priority": "medium",
    "project": null,
    "assignees": [],
    "reporter": null,
    "labels": ["foo", "bar-baz"],
    "milestone": null,
    "parentTaskId": "TASK-1",
    "acceptanceCriteriaCompleted": 0,
    "acceptanceCriteriaCount": 2,
    "references": [],
    "modifiedFiles": [],
    "ordinal": 3000,
    "createdAt": "2026-10-19T10:15:00Z",
    "updatedAt": null,
    "dueDate": null,
    "isReady": false,
    "path": "backlog/tasks/task-1.1 - Child-task.md",
    "description": "Line one\n\n<!-- minions:meta {\"a\":1,\"b\":\"x y\"} -->\nLine after",
    "dependencies": ["TASK-2"],
    "dependencyGraph": {
      "root": "TASK-1.1",
      "nodes": [
        { "id": "TASK-1.1", "title": "Child task", "status": "implementing", "state": "resolved", "completed": false, "dependencyDepth": 0, "dependentDepth": 0 },
        { "id": "TASK-2", "title": "Dep task", "status": "ready", "state": "resolved", "completed": false, "dependencyDepth": 1, "dependentDepth": null }
      ],
      "edges": [ { "from": "TASK-1.1", "to": "TASK-2" } ]
    },
    "readiness": { "isReady": false, "isBlocked": true, "blockingDependencies": ["TASK-2"], "missingDependencies": [] },
    "documentation": [],
    "subtasks": [],
    "acceptanceCriteria": [
      { "index": 1, "text": "First AC", "checked": false },
      { "index": 2, "text": "Second AC", "checked": false }
    ],
    "definitionOfDone": [],
    "implementationPlan": null,
    "implementationNotes": null,
    "comments": [],
    "finalSummary": null
  }
}
```

After the edits, the sample's `implementationNotes` became `"note A\n\nnote B\nmultiline\n\nnote C"` and `comments` became `[{"index":1,"body":"a comment","createdAt":"2026-10-19T10:16:00Z","author":"minions"}]`.

### Errors

```
$ backlog task view task-99 --json      # stdout empty, exit 1, stderr:
Task task-99 not found. Task lookups read only the local working copy; use 'backlog browser' to see tasks from other branches.
```

`task edit` on a missing ID gives the same message plus `No changes were applied.` (exit 1). Commander usage errors (`error: unknown option '--json'`, `error: missing required argument 'title'`) also exit 1.

## Metadata in descriptions

The description below survived create, edit, other field edits (status, notes, AC, labels), and view unchanged. JSON escaping inside the comment and fenced code with `--` were preserved:

~~~~
New desc
<!-- minions:meta {"phase":"testing","attempts":2,"q":"a\"b"} -->

```
code -- here
```
~~~~

Caveats:
- Leading and trailing whitespace of the whole description is **trimmed**. Compare after trimming.
- `## Heading` and `- [ ] #1 ...` lines inside a description stay in the description and don't become AC. Never put Backlog's own markers (`<!-- SECTION:DESCRIPTION:END -->`, `<!-- AC:BEGIN -->`) in content.

## Git and side effects

- `auto_commit: false` (the default) made no commits during init, create, or edit. The files stayed untracked. `filesystem_only: true` turns off git access entirely, including branch scans. If we keep git integration, also set `remote_operations: false` and `check_active_branches: false` to avoid fetches and cross-branch scans.
- Writes take a lock under `backlog/.locks/`. Add it to `.gitignore` if the backlog dir is committed.
- Optional hook: config key `onStatusChange: '<shell cmd>'` (also settable per task in frontmatter) runs `sh -c` after a status change, with env vars `TASK_ID`, `OLD_STATUS`, `NEW_STATUS`, `TASK_TITLE`. Verified output: `TASK-4 idea testing Plain create`.
- Editor and browser: `$EDITOR`/`$VISUAL`/`default_editor` are only used by interactive TUI paths. `backlog browser` starts a web server and opens a browser unless `auto_open_browser: false`. The adapter uses neither.
- Env vars the binary reads that matter here: `BACKLOG_CWD` (project root), `NO_COLOR`/`FORCE_COLOR`, `EDITOR`/`VISUAL`. There is no "non-interactive" env var. Non-interactive behavior comes from not having a TTY plus explicit flags.

## Not verified

- Concurrent writers (the lock exists but wasn't stress-tested).
- `--watch` output under load.
- Behavior with `auto_commit: true`.
- Platforms other than darwin-arm64.
