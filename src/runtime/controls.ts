// Plain-language owner controls (docs/design/telegram.md#terminal-equivalent-controls). Over Telegram the
// owner writes "pause intake", "status", "cancel task-7"...; the coordinator maps each control to the
// same deterministic `minions` command a terminal user runs. Every command here also works from the host
// terminal without Claude (the host CLI delegates it to the project runtime). The table is the single
// source for the coordinator prompt (src/plugin/generate.ts) and the docs.
import type { RuntimeDb } from './db.js';

export interface Control {
  id: string;
  /** What the owner writes (lowercase; `<task>` is a task id). */
  phrases: string[];
  /** The `minions` argv the coordinator runs (always with `--json`); `<task>` is replaced by the task id. */
  argv: string[];
  description: string;
}

export const CONTROLS: readonly Control[] = [
  { id: 'pause-intake', phrases: ['pause intake'], argv: ['pause', '--intake'], description: 'stop turning new requests/issues into tasks' },
  { id: 'pause-starts', phrases: ['pause starts', 'pause new starts', 'stop starting'], argv: ['pause', '--starts'], description: 'start no new tasks; running workers finish' },
  { id: 'pause', phrases: ['pause', 'pause all', 'pause everything'], argv: ['pause'], description: 'pause intake and starts' },
  { id: 'resume-intake', phrases: ['resume intake'], argv: ['resume', '--intake'], description: 'resume intake only' },
  { id: 'resume-starts', phrases: ['resume starts'], argv: ['resume', '--starts'], description: 'resume starts only' },
  { id: 'resume', phrases: ['resume', 'resume all', 'unpause'], argv: ['resume'], description: 'resume intake and starts' },
  { id: 'status', phrases: ['status', 'progress'], argv: ['status'], description: 'queue, workers, pause state, pending notifications' },
  { id: 'sync', phrases: ['sync'], argv: ['sync'], description: 'import issues, refresh PR/CI state, report pending notifications' },
  { id: 'cancel', phrases: ['cancel <task>', 'stop <task>'], argv: ['work', 'cancel', '<task>', '--reason', 'owner cancelled'], description: 'release the task\'s worker leases (best effort; worktree kept); stop its running subagents' },
  { id: 'cancel-all', phrases: ['cancel all', 'stop all workers'], argv: ['work', 'cancel', '--all', '--reason', 'owner cancelled'], description: 'release every worker lease (best effort; worktrees kept)' },
];

/** Task ids as minions/Backlog.md write them (`task-7`, `task-2.3`, `TASK-2.3`). */
const TASK_ID = /^task-\d+(?:\.\d+)*$/i;

const normalize = (text: string) => text.toLowerCase().replace(/^\s*\/+/, '').replace(/[!?.,;]+\s*$/, '').replace(/\s+/g, ' ').trim();

export interface ControlMatch { control: Control; argv: string[]; command: string }

/**
 * Deterministic match of a short owner message to a control; null when the message is anything else
 * (then it is an ordinary request for the coordinator to handle). Only exact phrases match, so
 * "please pause intake for the weekend" is left to the coordinator's judgment.
 */
export function matchControl(text: string): ControlMatch | null {
  const msg = normalize(text);
  for (const control of CONTROLS) {
    for (const phrase of control.phrases) {
      if (!phrase.includes('<task>')) {
        if (msg === phrase) return build(control);
        continue;
      }
      const [before, after] = phrase.split('<task>') as [string, string];
      if (!msg.startsWith(before) || !msg.endsWith(after)) continue;
      const task = msg.slice(before.length, msg.length - after.length).trim();
      if (TASK_ID.test(task)) return build(control, task);
    }
  }
  return null;
}

function build(control: Control, task?: string): ControlMatch {
  const argv = control.argv.map((a) => (a === '<task>' ? task ?? a : a));
  return { control, argv, command: `minions ${argv.map(shellWord).join(' ')}` };
}

const shellWord = (w: string) => (/^[A-Za-z0-9._:/@=+-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/** The terminal command of a control, as shown in docs and the prompt. */
export const controlCommand = (c: Control): string => `minions ${c.argv.map(shellWord).join(' ')}`;

/** Markdown table for the coordinator prompt and docs. */
export function controlsTable(): string {
  return [
    '| Owner says | Run (add `--json`) | Effect |',
    '| - | - | - |',
    ...CONTROLS.map((c) => `| ${c.phrases.map((p) => `"${p}"`).join(', ')} | \`${controlCommand(c)}\` | ${c.description} |`),
  ].join('\n');
}

// ---------------------------------------------------------------- cancel

export interface CancelDeps {
  db: RuntimeDb;
  release: (leaseId: string, reason: string) => Promise<unknown>;
}

export interface CancelReport {
  released: { leaseId: string; taskId: string; role: string; holder: string | null; worktree: string | null }[];
  failed: { leaseId: string; taskId: string; error: string }[];
  /** Requested tasks without an active lease (nothing to cancel). */
  idle: string[];
}

/**
 * `minions work cancel`: releases every active lease of the given tasks (or all, with `all`) without a
 * result. Best effort: a failing release is reported and the rest continue. Worktrees and branches are
 * kept (release never deletes them). It cannot kill a worker subagent itself; the coordinator stops
 * the subagents named by the released holders, and a late submit from one is refused (its lease ended).
 */
export async function cancelWork(deps: CancelDeps, target: { taskIds: string[]; all?: boolean }, reason: string): Promise<CancelReport> {
  const active = deps.db.activeLeases();
  const wanted = new Set(target.taskIds.map((t) => t.toLowerCase()));
  const leases = target.all ? active : active.filter((l) => wanted.has(l.task_id.toLowerCase()));
  const report: CancelReport = { released: [], failed: [], idle: target.all ? [] : target.taskIds.filter((t) => !active.some((l) => l.task_id.toLowerCase() === t.toLowerCase())) };
  for (const l of leases) {
    try {
      await deps.release(l.id, reason);
      report.released.push({ leaseId: l.id, taskId: l.task_id, role: l.role, holder: l.holder, worktree: l.worktree });
    } catch (e) {
      report.failed.push({ leaseId: l.id, taskId: l.task_id, error: (e as Error).message });
    }
  }
  deps.db.addEvent('cancel', null, { reason, all: !!target.all, taskIds: target.taskIds, released: report.released.map((r) => r.leaseId), failed: report.failed.map((f) => f.leaseId) });
  return report;
}

export function formatCancel(r: CancelReport): string {
  const out: string[] = [];
  out.push(r.released.length ? `released ${r.released.length} lease(s): ${r.released.map((x) => `${x.leaseId} (${x.taskId} ${x.role})`).join(', ')}; worktrees kept` : 'no active leases released');
  for (const f of r.failed) out.push(`failed: ${f.leaseId} (${f.taskId}): ${f.error}`);
  if (r.idle.length) out.push(`no active lease: ${r.idle.join(', ')}`);
  return out.join('\n');
}
