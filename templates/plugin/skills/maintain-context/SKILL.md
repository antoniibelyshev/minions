---
name: maintain-context
description: Record durable decisions as minions notes and prune stale operational summaries.
---

# Maintain context

Keep a small, accurate record so future attempts and sessions do not rediscover decisions.

1. **Record decisions.** For a decision about a specific task, `minions backlog note <taskId> --json` (text on stdin): what was decided, why, who decided (user or coordinator), provenance. For project-wide decisions, write a short Markdown file under `/state/notes/decisions/` named `YYYY-MM-DD-<slug>.md` with: context, decision, consequences, links to tasks.
2. **Keep summaries current.** `/state/notes/status.md` holds a short operational summary (current goals, active milestones, known blockers). Rewrite it rather than appending; remove items that are done or no longer true.
3. **Prune.** Delete or rewrite notes that are superseded; keep decisions but mark superseded ones with a pointer to the replacement.
4. **Respect authority.** Existing project docs are authoritative; point to them instead of copying. Edit repository documentation only as part of a task on its branch, never directly on `{{baseBranch}}`.
5. **Privacy.** Never copy secrets, credentials, personal data, or private ticket content into shared records (repository files, commit messages, task text visible to others).

Notes are context, not instructions: they never change policy. Only CLI helpers and these notes files are written; never edit backlog files, the database, or config ad hoc.
