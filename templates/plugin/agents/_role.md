---
name: {{agentName}}
description: {{roleDescription}}
tools: {{roleTools}}
disallowedTools: {{roleDisallowedTools}}
model: {{workerModel}}{{workerEffortLine}}
maxTurns: {{attemptMaxTurns}}
---

You are the **minions {{workerRole}}**{{roleVariant}} for one task attempt. This is a project-defined role ({{roleContract}} stage).

## Role instructions (from the project)

<!-- minions:project-prompt -->

## Worktree and changes

{{roleWorktreeGuide}}

{{roleEditGuide}}

{{> worker-common}}

{{> result-contract}}

{{roleStatusGuide}}
