// Standing goals (docs/design/autonomy.md Decision 15): the owner's measurable objectives, and the coordinator's
// marks on them.
//
// - The owner writes `goals.md` next to the project config (shared: `<repo>/.minions/goals.md`; private: the project
//   dir). The host copies it into the runtime config dir at start, upgrade and every settings change, like the role
//   prompt files: the runtime reads only that host-resolved copy (`/opt/minions/config/goals.md`, read-only), so a
//   worker branch that edits `.minions/goals.md` changes nothing.
// - Format: one `## <title>` heading per goal, free text under it, and optional `Status: open|done|paused` and
//   `Measure: <how it is measured>` lines. Text before the first `## ` heading is an introduction. Tolerant: an
//   unknown status reads as open, and nothing in the file is ever an error.
// - The coordinator cannot edit the file. Its marks (`minions backlog goals set`), the "nothing worthwhile left"
//   record that stops planning wakes, and the last retrospective live in `<state>/goals.json`. A mark applies while the
//   goal's own status line is what it was when the mark was made: an owner edit of that line wins.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Task, TaskStatus } from '../backlog/types.js';
import { atomicWrite, sha256 } from '../core/fsutil.js';

export const GOALS_FILE = 'goals.md';
export const GOAL_STATUSES = ['open', 'done', 'paused'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
/** The runtime reads at most this much of the goals file. */
export const GOALS_MAX_BYTES = 64 * 1024;
export const MAX_GOALS = 50;
const BODY_MAX = 4000;
/** A retrospective is due after this many tasks landed (done) since the last one, or after a goal was marked done. */
export const RETRO_EVERY_DONE = 10;
const LOG_MAX = 50;

/** Statuses that keep the team busy: work the dispatcher can start, runs or lands. `idea`, `blocked`, `awaiting-human` and the end states do not. */
export const QUEUED_STATUSES: ReadonlySet<TaskStatus> = new Set(['ready', 'implementing', 'testing', 'reviewing', 'changes-requested', 'awaiting-ci', 'merging']);

export interface Goal {
  id: string;
  title: string;
  /** Effective status: the coordinator's mark when it applies, else the file's. */
  status: GoalStatus;
  /** The status line of the file (open when it has none). */
  fileStatus: GoalStatus;
  /** The `Measure:` (or `Metric:`, `Target:`) line: how the goal is measured; pursue it through experiments. */
  measure: string | null;
  body: string;
  /** The coordinator's mark, when it applies. */
  mark?: GoalMark;
}

export interface GoalMark { status: GoalStatus; fileStatus: GoalStatus; at: string; reason: string }

export interface GoalsState {
  marks: Record<string, GoalMark>;
  /** Planning found nothing worthwhile for the goals as they were (hash): no plan wake until they change. */
  exhausted: { hash: string; at: string; reason: string } | null;
  /** The last retrospective, with the done-task count at the time. */
  retro: { at: string; done: number; summary: string } | null;
  log: { at: string; what: string; id?: string; reason: string }[];
}

const EMPTY_STATE: GoalsState = { marks: {}, exhausted: null, retro: null, log: [] };

const STATUS_WORDS: Record<string, GoalStatus> = {
  open: 'open', active: 'open', todo: 'open', 'in-progress': 'open', ongoing: 'open',
  done: 'done', met: 'done', complete: 'done', completed: 'done', achieved: 'done', closed: 'done',
  paused: 'paused', hold: 'paused', 'on-hold': 'paused', parked: 'paused', deferred: 'paused',
};
const FIELD = /^\s*(?:[-*]\s+)?(?:\*\*|__)?(status|measure|metric|target)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*?)\s*$/i;

export const goalStatusOf = (word: string): GoalStatus | null => STATUS_WORDS[word.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z-]/g, '')] ?? null;

function slug(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'goal';
}

/** Parses the goals Markdown (see the header). Never throws. */
export function parseGoals(text: string): Omit<Goal, 'status' | 'mark'>[] {
  const out: Omit<Goal, 'status' | 'mark'>[] = [];
  const seen = new Map<string, number>();
  let cur: { title: string; lines: string[] } | null = null;
  let fence = false;
  const flush = () => {
    if (!cur || out.length >= MAX_GOALS) return;
    let fileStatus: GoalStatus = 'open';
    let measure: string | null = null;
    for (const l of cur.lines) {
      const m = FIELD.exec(l);
      if (!m) continue;
      const v = m[2]!.replace(/[*_`]+$/g, '').trim();
      if (m[1]!.toLowerCase() === 'status') fileStatus = goalStatusOf(v) ?? goalStatusOf(v.split(/[\s(,;.]/)[0] ?? '') ?? fileStatus;
      else if (v && measure === null) measure = v.slice(0, 300);
    }
    const base = slug(cur.title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ id: n > 1 ? `${base}-${n}` : base, title: cur.title.slice(0, 200), fileStatus, measure, body: cur.lines.join('\n').trim().slice(0, BODY_MAX) });
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { flush(); cur = { title: h[1]!.trim(), lines: [] }; continue; }
    cur?.lines.push(line);
  }
  flush();
  return out;
}

/** The goals with the coordinator's marks applied (a mark applies while the file's status is what it was). */
export function effectiveGoals(parsed: Omit<Goal, 'status' | 'mark'>[], state: GoalsState): Goal[] {
  return parsed.map((g) => {
    const m = state.marks[g.id];
    return m && m.fileStatus === g.fileStatus ? { ...g, status: m.status, mark: m } : { ...g, status: g.fileStatus };
  });
}

/** Identity of the goals as planning saw them: the file text and the effective statuses. */
export const goalsHash = (text: string, goals: Goal[]): string => sha256(text + '\0' + goals.map((g) => `${g.id}=${g.status}`).join(','));

// ---------------------------------------------------------------- files

/** The runtime's copy of the goals file: next to the effective config (`/opt/minions/config/goals.md`). */
export const runtimeGoalsPath = (configJson: string): string => join(dirname(configJson), GOALS_FILE);
export const goalsStatePath = (state: string): string => join(state, 'goals.json');

/** The goals file text (at most GOALS_MAX_BYTES), or null when there is none. */
export function readGoalsText(path: string): string | null {
  try { return readFileSync(path).subarray(0, GOALS_MAX_BYTES).toString('utf8'); } catch { return null; }
}

export function readGoalsState(state: string): GoalsState {
  try {
    const raw = JSON.parse(readFileSync(goalsStatePath(state), 'utf8')) as Partial<GoalsState>;
    return {
      marks: raw.marks && typeof raw.marks === 'object' ? raw.marks : {},
      exhausted: raw.exhausted ?? null, retro: raw.retro ?? null, log: Array.isArray(raw.log) ? raw.log : [],
    };
  } catch { return structuredClone(EMPTY_STATE); }
}

export async function writeGoalsState(state: string, s: GoalsState): Promise<void> {
  await atomicWrite(goalsStatePath(state), JSON.stringify({ ...s, log: s.log.slice(-LOG_MAX) }, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------- the view

export interface GoalsView {
  /** Whether the runtime has a goals file (the host copies it at start). */
  present: boolean;
  goals: Goal[];
  counts: Record<GoalStatus, number>;
  hash: string | null;
  /** The "nothing worthwhile left" record, when it still applies (the goals are unchanged since). */
  exhausted: GoalsState['exhausted'];
  retro: { last: GoalsState['retro']; doneSince: number; goalsDoneSince: number; due: boolean } | null;
}

/** Goals, counts and the planning records; `tasks` (the backlog) adds the retrospective check. */
export function goalsView(text: string | null, state: GoalsState, tasks?: Pick<Task, 'status'>[] | null): GoalsView {
  const goals = text === null ? [] : effectiveGoals(parseGoals(text), state);
  const counts = { open: 0, done: 0, paused: 0 };
  for (const g of goals) counts[g.status]++;
  const hash = text === null ? null : goalsHash(text, goals);
  const exhausted = state.exhausted && state.exhausted.hash === hash ? state.exhausted : null;
  let retro: GoalsView['retro'] = null;
  if (tasks) {
    const done = tasks.filter((t) => t.status === 'done').length;
    const doneSince = done - (state.retro?.done ?? 0);
    const goalsDoneSince = goals.filter((g) => g.status === 'done' && g.mark && (!state.retro || g.mark.at > state.retro.at)).length;
    retro = { last: state.retro, doneSince, goalsDoneSince, due: doneSince >= RETRO_EVERY_DONE || goalsDoneSince > 0 };
  }
  return { present: text !== null, goals, counts, hash, exhausted, retro };
}

/** One status line: the goal counts. */
export function humanGoals(v: Pick<GoalsView, 'present' | 'counts' | 'exhausted'>): string {
  if (!v.present) return 'goals: none (no goals file)';
  return `goals: ${v.counts.open} open, ${v.counts.done} done, ${v.counts.paused} paused${v.exhausted ? `; planning found nothing worthwhile left (${v.exhausted.at})` : ''}`;
}
