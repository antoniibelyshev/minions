/**
 * Tool trim of the coordinator session (task-48). One place for the list: the config schema validates
 * `coordinator.disallowedTools` against it and src/runtime/coordinator.ts passes it to `claude
 * --disallowedTools`. Worker agents are not affected: their frontmatter `tools:` allowlists (Read, Edit,
 * Write, Grep, Glob, Bash) name none of these tools.
 *
 * Why (measured 2026-10-23, Claude Code 2.1.292): the coordinator's first call cached 55.2k tokens vs
 * 27.9k the session before. The earlier session ran with tool search on (31 tools deferred, 14 inline);
 * the later one had it off, so all 35 tool definitions (~224k chars, ~128k more) were inline. Claude
 * Code decides tool search per session from account/feature-flag state (the earlier session carried an
 * org credential and a claude.ai connector), which minions does not control, so the launch now asks for
 * tool search explicitly and removes the tools the coordinator never uses.
 */

/**
 * Claude Code built-in tools the coordinator never uses. Each is a full tool definition in every
 * request unless removed (Artifact alone is ~48k chars). The coordinator dispatches workers, runs the
 * minions/git/backlog CLIs and talks over Telegram; it does not author artifacts, schedule itself,
 * edit notebooks, switch worktrees, plan-mode, browse the web or run workflows.
 */
export const COORDINATOR_DISALLOWED_TOOLS = [
  'Artifact', 'ArtifactComments', 'ArtifactData', 'DesignSync', 'Workflow',
  'CronCreate', 'CronDelete', 'CronList', 'Monitor', 'ScheduleWakeup', 'RemoteTrigger',
  'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'ExitPlanMode',
  'WebSearch', 'WebFetch', 'SendFeedback', 'ReportFindings',
] as const;

/**
 * Tools the coordinator needs; `coordinator.disallowedTools` may not name them. `Task` is the older name
 * of Agent; ToolSearch loads the deferred tools (Telegram replies among them) when tool search is on.
 */
export const COORDINATOR_REQUIRED_TOOLS = [
  'Agent', 'Task', 'SendMessage', 'TaskStop', 'ListAgents', 'PushNotification', 'AskUserQuestion',
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Skill', 'ToolSearch',
] as const;

/** Prefix of the Telegram plugin's MCP tools; never disallowed either. */
export const TELEGRAM_MCP_TOOL_PREFIX = 'mcp__plugin_telegram_';

/** Whether a disallowedTools entry would remove a tool the coordinator needs (bare name or `Name(...)` rule). */
export function isRequiredCoordinatorTool(entry: string): boolean {
  const name = entry.trim().replace(/\(.*$/s, '');
  return (COORDINATOR_REQUIRED_TOOLS as readonly string[]).includes(name) || name.startsWith(TELEGRAM_MCP_TOOL_PREFIX);
}
