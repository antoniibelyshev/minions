# minions repository instructions

## Coordinator: request a self-update after meaningful integrations

For the coordinator of the minions project only (workers ignore this section). Design:
[docs/design/coordinator-self-update.md](docs/design/coordinator-self-update.md), Decision 2 (owner, TG 465), and
[docs/design/local-auto-integration.md](docs/design/local-auto-integration.md), Decision 4.

After an `integrated` notice (the local integrator landed a task on `main`; the task is `done` and the event lists
the changed `paths`), decide whether the landed range is **meaningful**: it touches runtime, CLI or plugin code.
Check the event's paths or `git diff --name-only <main before>..main`. While local integration is off here and you
merge by hand, apply the same rule after your merge.

- Meaningful: `src/**`, `templates/**` (plugin, coordinator and assistant prompts), `docker/**`, `schema/**`,
  `package.json`, `package-lock.json`, `esbuild.config.mjs`, and `scripts/**` other than `scripts/dev/**`.
- Not meaningful on its own: `docs/**`, `test/**`, `README.md`, the backlog, `scripts/dev/**` (the host script loads
  its code once; the owner restarts it), and this file. A range of only these needs no update.

When the range is meaningful, request the update yourself, without waiting to be asked:

```bash
minions upgrade --from-container --reason "self-update: <first sha>..<last sha>, <one-line summary>" --json
```

- Request once per batch of landings, and check `minions settings requests --json` first. A `proposed` `upgrade`
  already covers these commits (applying it syncs all of `main`): skip. A `confirmed` one is being applied and may
  have synced before the landing: request once it is `applied` or `failed`. While a drain is in progress
  (`draining` in `minions status --json`), request once it has ended.
- Active leases and a running integration are no reason to wait: the host script applies only when no worker runs
  and the integrator does not hold its lock.
- The request only records a proposal. The owner's host-side `scripts/dev/self-update.mjs` applies it (or the owner
  does, on the host); tell the owner the request id, never that the update is done.
- Never run `minions upgrade` in any other form, and never restart the container or yourself for this.
