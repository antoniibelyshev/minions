# Project-defined worker roles and per-task workflows

Status: design (task-33, attempt 1). Implementation is split into child tasks (end of this document).
Owner request (2026-10-20): built-in engineer/tester/reviewer stay as customizable defaults; a project
can add its own worker roles (researcher, writer, deploy engineer, ...) and plug them into a task's
workflow. No custom role ships with minions.

Ground truth this design starts from (main @ 3f603e2):

- `ROLES` / `Role` (`src/config/schema.ts`) and `LeaseRole` (`src/runtime/db.ts`) are closed unions;
  capability sub-rules validate `roles` with `z.enum(ROLES)`.
- The stage machine is hard-coded in `Scheduler.claim` / `recordResult` (`src/runtime/scheduler.ts`):
  `ROLE_STATUSES` maps role to claimable statuses, engineer `complete` goes to `testing` when
  `qaRequirement` gives reasons, else to `reviewing` (or `delivered` without a reviewer), reviewer
  `needs_changes` increments `repairs` and goes to `awaiting-human` at `maxRepairCyclesBeforeReplan`.
- The worktree kind follows the role: reviewer = detached review worktree at the exact head;
  engineer/tester = branch worktree; QA sweep = detached at the base head.
- `validateResult(raw, role)` hard-codes role rules (verdict only for reviewer, `needsQa` only for
  reviewer, no failing checks in a tester/reviewer `complete`, CI evidence only for tester/reviewer).
- `preAgentHook` accepts only `minions:(engineer|tester|reviewer)(-deep)?` and requires an active lease
  of that role. `work claim|brief|submit --role` accept the same three names.
- `generatePlugin` renders `templates/plugin/agents/{engineer,tester,reviewer}.md` plus
  `engineer-deep`; effort comes from `models.effortByRole` (task-30), model from `models.default`.
- task-22: the default flow is engineer → reviewer; a tester stage is added per task by
  `verification.testerRequired`, a QA label, sensitive paths, a missing diff (fail closed) or the
  reviewer's `needsQa`.
- Config is host-controlled: the container reads a resolved runtime config from a read-only mount and
  the plugin dir is generated on the host and mounted read-only. `.minions/**` is a sensitive path.

## Decisions

### D1. Where a role is defined

A role is **project configuration**, not a workspace file the runtime reads.

- Structured fields live in the project config under a new top-level `roles` object
  (`.minions/config.json` for shared installs, the private `config.json` otherwise), validated by the
  config schema like every other field.
- The prompt body lives in a Markdown file next to the config: `.minions/agents/<role>.md` (shared) or
  `<project dir>/agents/<role>.md` (private). `roles.<name>.prompt` names it relative to the config dir.
  Inline `promptText` is accepted for short prompts so a role can be a single config edit.
- The host resolves both into the runtime config (`runtime/config.json`) and the generated plugin, so
  the container only ever sees the approved, resolved version. Editing `.minions/agents/x.md` inside the
  workspace changes nothing until the host applies it.

Why not "files only under `.minions/agents/`": the runtime would read a sensitive path from the
workspace, where any worker branch could change it; and the policy table, capacity and workflow
validation all need the role in the schema anyway.

### D2. Approval path

New or changed roles always need the owner (host) to apply them. The coordinator can only propose.

1. **Propose (runtime).** The coordinator drafts a proposal JSON `{name, role: {...}, promptText,
   reason, workflows?}` and stores it with `minions config roles propose --file <f> --json`. The CLI
   validates it against the schema and the role-name rules, stores it in the runtime DB
   (`role_proposals`: id, name, json, created_at, state) and returns `proposalId` plus a rendered summary
   (fields, the policy row it implies, tools, edit scope). Nothing becomes effective.
2. **Ask.** The coordinator asks the owner (one decision, with the summary and the apply command).
3. **Apply (host only).** `minions config roles apply <proposalId>` reads the proposal through the
   runtime delegate, prints the config diff and the prompt file, asks for confirmation (or `--yes`),
   writes config + prompt file via `editProjectConfig` (strict parse, `configRevision + 1`,
   `resolveEffective`, atomic write), regenerates derived files and marks the proposal applied. Shared
   installs get the usual commit reminder for `.minions/`. It never commits and never restarts: plugin
   changes are restart-required (`minions down && minions start`, or the coordinator's idle restart).
4. `minions config roles list|show <name>` (host and runtime, read-only) and
   `minions config roles remove <name>` (host only, refused while a workflow or an active lease uses it).

This stays inside the `config` advanced command (minimal CLI surface, no new top-level command). A
role can still be changed by editing the config file by hand on the host; validation is the same.
An in-runtime `apply` is rejected like an in-runtime `work approve`.

### D3. Role fields

```jsonc
"roles": {
  "researcher": {
    "description": "Researches a question and writes findings to a notes file. No code edits.",
    "prompt": "agents/researcher.md",          // or "promptText": "..."
    "contract": "producer",                      // producer | verifier | gate (D4)
    "worktree": "branch",                        // branch | review (default from contract)
    "edits": { "paths": ["docs/research/**"] },  // "none" | "any" | { paths: [globs] }
    "commits": true,
    "tools": ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
    "model": "sonnet",                           // default; must be in models.allowed
    "effort": "medium",
    "maxTurns": 60,                              // default execution.attemptMaxTurns
    "deepVariant": false,                        // also generate minions:<name>-deep
    "stageStatus": "implementing",               // implementing | testing | reviewing (D6)
    "requires": ["network.use"],                 // capabilities the stage needs; deny => claim refused
    "capabilities": { "pr.review": "deny" }      // this role's column in the policy table (D8)
  }
}
```

- `name` (the key): `^[a-z][a-z0-9-]{1,30}$`; not `coordinator`, not ending in `-deep`, not a skill
  name (`orchestrate`, `status`, `recover`, `intake`, `maintain-context`). Built-in names may appear
  only with the override fields of D9.
- `tools`: an allowlist rendered into frontmatter. `Agent`, `SendMessage` and every MCP tool
  (Telegram) are always removed; `Edit`, `Write`, `NotebookEdit` are removed when `edits` is `none` or
  the worktree is `review`. Unknown tool names are a config error only if they contain characters
  outside `[A-Za-z0-9_*()-]` (Claude Code owns the tool list; minions does not pin it).
- `edits` + `commits` are enforced, not advisory: `code.edit` / `git.commit` for the role are derived
  from them (deny when `none` / `false`), and at record time the branch diff of the stage
  (lease `head_sha` at claim → result head) must stay within `edits.paths`; a violation is an invalid
  result (one correction, as today). `review` worktrees imply `edits: none, commits: false`.

### D4. Result-contract variants

`WorkerResultSchema` stays one schema (one parser, one contract string). A role picks a variant that
decides the role rules in `validateResult` and the transition in `recordResult`:

| Variant | Built-in | Worktree | Rules | `complete` means |
| - | - | - | - | - |
| `producer` | engineer | branch | no `verdict`, no `needsQa`, no CI evidence; `needs_changes` = back for replanning | stage done, go to next stage |
| `verifier` | tester | branch, may add commits on top (never rewrite) | no `verdict`; `complete` may not report failing checks; may cite CI (ciAuthority github) | verified at head |
| `gate` | reviewer | review (detached at exact head) | `complete` requires `verdict: approve`; `needs_changes` = `request-changes`; may set `needsQa`; may cite CI; head must not move | approved at head (evidence) |

`validateResult(raw, role)` becomes `validateResult(raw, contract, opts)`; the role → contract lookup is
in the registry. The contract text in the brief (`resultContract`) is rendered per variant so a
producer is never told about `verdict`. Statuses `blocked`, `needs_split`, `partial` (and drain
partials) mean the same for every variant.

### D5. Workflow model

A **workflow** is an ordered list of stages; each stage is a role name or
`{ role, when?: "qa", model?: "<alias>" }`.

- `when: "qa"` = conditional stage, run only when `qaRequirement` gives reasons (task-22 semantics).
- `model` = per-stage model hint (an allowed Agent alias), the main lever for cheap low-risk stages.

Named workflows live in config:

```jsonc
"workflows": {
  "docs":     ["engineer", { "role": "reviewer", "model": "haiku" }],
  "research": ["researcher", "writer", "reviewer"]
}
```

**The default workflow is derived, never stored**, from the verification settings:
`[engineer, {role: tester, when: testerRequired ? always : "qa"}, reviewer if reviewerRequired]`.
With current defaults that is engineer → (tester on QA) → reviewer, exactly today's flow. A project may
name its own `workflows.default` to replace it.

**Per-task assignment.** The coordinator sets it at creation or later:
`minions backlog create ... --workflow docs` / `minions backlog update <id> --workflow docs`. It is
stored in the minions meta block (`workflow: "docs"`) so it is visible in the backlog and survives a
state reset; an inline list is not accepted on the CLI (named workflows only, so they are approved
config). Changing the workflow of an in-flight task is allowed only between stages and resets the
position to the first stage whose role differs from completed evidence at the current head.

**Invariants (checked when a workflow is configured and when it is assigned):**

1. Every role in it is configured; unknown roles are a config error.
2. With `verification.reviewerRequired`, a `gate` stage comes after the last stage that can commit.
3. QA cannot be skipped by choosing a workflow: when `qaRequirement` gives reasons and the workflow has
   no runnable `verifier` stage before its final gate, the runtime inserts the built-in `tester` there
   (same reasons, same QA label recording as today). Sensitive paths therefore always get a tester.
4. A QA sweep (`qa-sweep` label) ignores workflows: tester only, as today.

Skipping stages for small or low-risk work is "pick a shorter configured workflow" plus a cheaper model
hint, never "the coordinator drops a stage on the fly"; the invariants keep the floor (review when
required, tester when risky).

### D6. Transitions, statuses, leases

The backlog status set does **not** change (Backlog.md configs of existing projects keep working).
Instead the runtime tracks the workflow position:

- New DB table `task_stages(task_id PK, workflow TEXT, stages_json, position INT, updated_at)`, written by
  claim/record. Legacy tasks without a row derive it: default workflow, position from status
  (`ready|changes-requested|implementing` → first producer, `testing` → tester, `reviewing` → reviewer).
- Each role has a `stageStatus` (built-ins: engineer `implementing`, tester `testing`, reviewer
  `reviewing`; custom default: `reviewing` for gates, `testing` for verifiers, `implementing` for
  producers). While a stage is pending or running, the task sits in that status; the active lease says
  whether it is running.
- **Claim** (`work claim <taskId> [--role <r>]`): the role must equal the current stage's role (if
  `--role` is omitted the CLI uses it). Position 0 is claimable from `ready` / `changes-requested`
  (authorization and dependency checks as today); later positions from their `stageStatus`. Worktree
  kind from the role. Everything else (one active stage per task, pause/drain, budget, base sync)
  is unchanged.
- **Record**: a `complete` advances `position` to the next runnable stage (skipping `when: qa` stages
  without QA reasons, inserting the tester per invariant 3); after the last stage the task is delivered
  / published exactly as after a reviewer approval today, with the same evidence-by-head rule: delivery
  needs `complete` gate evidence for the current head (when reviewer required) and `complete` verifier
  evidence when QA is required. A stage after the gate that moves the head therefore sends the task
  back to the gate.
- `release` restores a position-0 producer's pre-claim status (today's `restoreAfterEngineer`); other
  stages leave status and position unchanged.

### D7. Repair cycles and replan

- A `gate` or `verifier` `needs_changes` sends the task to **its repair target**: `roles.<r>.repairTo`
  if set, else the nearest earlier stage whose role can commit. Status → `changes-requested`, position →
  that stage. Gate results increment the per-task `repairs` counter (as reviewer results do today);
  verifier results do not (unchanged).
- At `maxRepairCyclesBeforeReplan` the task goes to `awaiting-human` with `replan: true`, unchanged.
- A producer's `needs_changes` returns the task for replanning (pre-claim status), unchanged.
- CI `fail` from a gate/verifier is a repair as today; `unverified` keeps the stage.

### D8. Capacity and policy

**Capacity.** New `execution.maxByRole: { <role>: n }`. `maxEngineers` stays valid and means
`maxByRole.engineer`; if both are set they must agree (config error otherwise), and new configs write
`maxByRole`. A role without a limit is bounded only by `maxActiveTasks`. `Capacity` gains
`byRole: { role: {active, max, free} }`; `activeEngineers` / `maxEngineers` / `freeEngineerSlots` stay
in the JSON for older coordinators. `-deep` variants count as their base role.

**Policy table.** `Role` becomes `string` validated against the registry (`coordinator` + built-ins +
configured roles). Capability sub-rule `roles` are validated by a config-level refinement instead of
`z.enum(ROLES)`. A role's `capabilities` object is its column: each entry becomes a sub-rule
`{effect, roles: [name]}`. Because roles are host-applied config, a column may be as permissive as a
hand-written sub-rule, and the existing semantics hold: a base `deny` (e.g. `deploy.execute` in every
profile) cannot be overridden by a column. Columns not given default to the base effect, except
`code.edit` / `git.commit`, which are derived from `edits` / `commits` (D3), and `pr.merge`,
`external.*`, `ci.edit`, `infrastructure.edit`, `deploy.execute`, which default to `deny` for custom
roles (workers never need them unless the owner says so). `renderCapabilityTable` gets one column per
configured role.

**Unknown roles are denied everywhere:** `can()` returns `deny` for any role not in the registry; claim,
brief, submit, hook and record refuse them with `POLICY_DENIED` / `INVALID_CONFIG`.

`requires`: capabilities the stage cannot work without. At claim, any `deny` for the role refuses the
claim (`POLICY_DENIED`, naming the capability); `ask` refuses it with `awaiting-human` guidance (a
host-signed approval for stage capabilities is out of scope). So "engineer → deploy-engineer" can be
configured, but with the default `deploy.execute: deny` it stops at the deploy stage with a clear
reason until the owner changes the policy.

### D9. Customizing the built-ins

`roles.engineer|tester|reviewer` accept only: `promptAppend` (text) or `prompt` (a file appended to the
built-in body, under a "Project instructions" heading), `model`, `effort`, `maxTurns`, `tools` (may only
remove tools), `stageStatus` is fixed, `contract` is fixed. Effort precedence:
`roles.<r>.effort` > `models.effortByRole.<r>` (task-30, kept for back-compat) > `models.effort`.
`roles.engineer.deepEffort` mirrors `effortByRole.engineerDeep`. The built-in templates stay in
`templates/plugin/agents/`; custom roles use one generic template.

### D10. Plugin generation and the hook

- `generatePlugin` iterates the registry: built-ins from their templates (plus overrides), custom roles
  from a new `templates/plugin/agents/_role.md` (frontmatter from the role fields; body = role header,
  the project prompt, `worker-common`, the contract partial for its variant). The project prompt is
  inserted **after** template rendering (so `{{` in it is literal text, never a placeholder) and may not
  contain a frontmatter fence at its start.
- `preAgentHook`: `minions:<name>` or `minions:<name>-deep` (only when `deepVariant`) is accepted iff
  `<name>` is in the registry of the runtime config; the lease must be active and of that role. Any other
  `minions:*` type is denied. The hook already loads config through `HookLoader`.
- The drain notice and `work brief|submit --role` use the contract variant instead of the role name.

### D11. Coordinator guidance (orchestrate skill and coordinator.md)

- Replace "role by status" with the CLI: `minions work next --json` lists runnable stages
  (`taskId, role, agentType, position, workflow, suggestedModel, reason`); claim without `--role`.
- **Assigning a workflow** at task creation: default unless the task fits a configured one (docs-only →
  `docs`, research → `research`); record the choice in the create call, not in a report.
- **Proposing a role**: only when recurring project work does not fit engineer/tester/reviewer (a
  different output than code, different tools, or a different gate), never for a one-off. Draft the
  smallest role (no edits unless needed, `edits.paths` scoped, no extra capabilities), `propose` it,
  and ask the owner once with the apply command. Never edit `.minions/**` to add a role.
- **Token efficiency**: follow `suggestedModel`; downgrade further only for mechanical stages; the
  deep variant and stronger models after a failed attempt, as today.

### D12. Deterministic stage runner: yes, in a thin form, now

The CLI must already compute the current stage to validate claims (D6), so returning it costs nothing
and removes the most error-prone coordinator reasoning (role by status, QA insertion, repair targets).
Decision:

- **Now** (part of the workflow work): `work next` and role inference in `claim`. `suggestedModel` is
  deterministic: stage `model` hint > role `model` > risk rule > `models.default`. Risk rule: task
  labelled `risk:low` (or a workflow whose stages are all hinted) → the cheapest allowed alias for
  gate/verifier stages; `risk:high` or a repair after a failed attempt → `-deep` variant and the
  strongest allowed alias. The coordinator may override within `models.allowed` (selection
  `coordinator`); with selection `fixed` the suggestion is always the default.
- **Not now**: a runner that also spawns workers or records results. Spawning needs the coordinator's
  Agent tool, and the coordinator's judgement (brief notes, splitting, user questions) is the part that
  is worth its tokens. Revisit after `work next` has run for a while: if the coordinator almost always
  follows it verbatim, a `work next --claim` that returns ready-made Agent call arguments is the next
  step.

## Back-compat summary

Existing configs validate unchanged (`roles`, `workflows`, `maxByRole` optional; `maxEngineers` and
`effortByRole` keep their meaning). Without `roles`/`workflows` the registry is the three built-ins and
the derived default workflow equals today's pipeline; existing tests of the stage machine must pass
untouched. Old coordinators that pass `--role` keep working. Leases in the DB keep their role text.

## Child tasks

1. **Role registry, config schema, policy columns and per-role capacity.** `src/config/roles.ts`
   registry (built-ins + `roles` config, name rules, D3 fields, D9 overrides, effort precedence),
   schema + JSON schema, `Role` as validated string, sub-rule role refinement, `can()` denies unknown
   roles, role columns + custom-role defaults, `renderCapabilityTable` columns, `execution.maxByRole`
   with `maxEngineers` back-compat and `Capacity.byRole`. Depends: none.
2. **Plugin generation and enforcement from the registry.** Generic `_role.md` template, prompt file
   resolution on the host, `-deep` variants, built-in overrides rendered, `preAgentHook` and
   `work claim|brief|submit --role` accept registry roles only, drain notice by contract. Depends: 1.
3. **Workflow model and generalized stage machine.** `workflows` config, derived default, invariants,
   `task_stages` table with legacy derivation, `--workflow` on backlog create/update (meta block),
   claim by stage position, record advancing position, repair targets and replan, QA insertion
   invariant, delivery evidence rule. Built-in roles only; current behaviour unchanged. Depends: 1.
4. **Custom-role stages: contract variants and edit scope.** `validateResult` by contract variant,
   per-variant contract text, worktree kind from role, `edits.paths` diff enforcement at record,
   `requires` at claim, end-to-end scheduler tests of researcher → writer → reviewer and
   engineer → deploy-engineer (denied). Depends: 1, 3.
5. **Stage runner and coordinator guidance.** `minions work next`, `claim` without `--role`,
   `suggestedModel` rules, orchestrate skill and coordinator.md rewrite (D11), status skill limits per
   role. Depends: 2, 3.
6. **Role proposal/approval flow and docs.** `config roles propose|list|show` (runtime),
   `config roles apply|remove` (host only), README "Custom roles" with the researcher worked example,
   docs/cli.md, orchestrate "proposing a role" section. Depends: 1, 2.
