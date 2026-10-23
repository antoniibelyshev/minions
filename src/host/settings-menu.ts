// The interactive `minions settings` menu over the settings model (src/host/settings.ts). On a TTY it is
// a small readline renderer: grouped sections, arrow keys (or j/k) move, Enter edits, q / Esc quits; each
// row shows the current value and its source, and the selected row its one-line effect. Without a TTY it
// degrades to numbered prompts; token items then only point to `minions auth <kind> --stdin` (the auth
// flow must not read the menu's piped stdin). Edits go through applySetting (validation, loosening
// confirmation, layer write, regeneration); restarts are collected and offered once when leaving the menu.
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { MinionsError } from '../core/errors.js';
import type { ProjectJson } from './project.js';
import { applySetting, formatSet, restartCoordinator, runtimePaused, type SettingsRuntime } from './settings-cli.js';
import { SETTING_GROUPS, formatValue, listSettings, loadSettingsContext, type SettingLayer, type SettingView } from './settings.js';

export type MenuKey = 'up' | 'down' | 'enter' | 'quit' | 'other';

/** Terminal IO of the menu (a fake in tests). */
export interface MenuIO {
  /** Arrow-key mode; false = numbered prompts. */
  tty: boolean;
  write(text: string): void;
  /** Next key press (tty mode only). */
  key(): Promise<MenuKey>;
  /** One line of input (no secrets are ever asked here); null = end of input. */
  line(prompt: string): Promise<string | null>;
  close?(): void;
}

export interface MenuDeps {
  io: MenuIO;
  runtime: SettingsRuntime;
  /** Runs the existing auth flow for a token item (`minions auth github|telegram`). */
  runAuth: (kind: 'github' | 'telegram') => Promise<void>;
  layer?: SettingLayer;
}

const CLEAR = '\x1b[2J\x1b[H';
const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const INV = (s: string) => `\x1b[7m${s}\x1b[0m`;

const rowText = (v: SettingView) => `${v.label.padEnd(30)} ${formatValue(v.value).padEnd(22)} ${v.source}`;

function render(views: SettingView[], cursor: number, status: string[]): string {
  const out = [BOLD('minions settings') + DIM('  (up/down move, Enter edit, q quit)'), ''];
  let i = 0;
  for (const g of SETTING_GROUPS) {
    const items = views.filter((v) => v.group === g);
    if (!items.length) continue;
    out.push(BOLD(g));
    for (const v of items) {
      out.push(i === cursor ? INV(`> ${rowText(v)}`) : `  ${rowText(v)}`);
      i++;
    }
  }
  const sel = ordered(views)[cursor];
  if (sel) out.push('', `${sel.key}: ${sel.description}`, DIM(sel.effect));
  if (status.length) out.push('', ...status);
  return CLEAR + out.join('\n') + '\n';
}

/** Views in display order (grouped). */
const ordered = (views: SettingView[]) => SETTING_GROUPS.flatMap((g) => views.filter((v) => v.group === g));

/** Picks one of `options`: arrows on a TTY, a number otherwise. Returns null for cancel. */
async function pick(io: MenuIO, title: string, options: string[], current: number): Promise<number | null> {
  if (!io.tty) {
    io.write(`${title}\n${options.map((o, i) => `  ${i + 1}) ${o}${i === current ? ' (current)' : ''}`).join('\n')}\n`);
    const a = ((await io.line(`Choice [1-${options.length}, Enter = keep]: `)) ?? '').trim();
    if (!a) return null;
    const n = Number(a);
    if (!Number.isInteger(n) || n < 1 || n > options.length) { io.write(`Not a choice: ${a}\n`); return null; }
    return n - 1;
  }
  let c = Math.max(0, current);
  for (;;) {
    io.write(CLEAR + BOLD(title) + DIM('  (up/down, Enter choose, q cancel)') + '\n' + options.map((o, i) => (i === c ? INV(`> ${o}`) : `  ${o}`)).join('\n') + '\n');
    const k = await io.key();
    if (k === 'up') c = (c + options.length - 1) % options.length;
    else if (k === 'down') c = (c + 1) % options.length;
    else if (k === 'enter') return c;
    else if (k === 'quit') return null;
  }
}

const yesNo = (io: MenuIO) => async (q: string): Promise<boolean> => {
  const raw = await io.line(`${q} `);
  if (raw === null) return false; // end of input is never a yes
  const a = raw.trim().toLowerCase();
  if (!a) return io.tty && /\(Y\/n\)/.test(q); // Enter takes the shown default on a TTY only
  return a === 'y' || a === 'yes';
};

/** Asks for the new value of one setting; null = keep. */
async function askValue(io: MenuIO, v: SettingView): Promise<string | null> {
  if (v.type === 'bool') {
    const i = await pick(io, `${v.label} (${v.key})`, ['true', 'false'], v.value === true ? 0 : 1);
    return i === null ? null : ['true', 'false'][i]!;
  }
  if (v.type === 'control') {
    const i = await pick(io, `${v.label} (${v.key})`, ['running', 'paused'], v.value === 'paused' ? 1 : 0);
    return i === null ? null : ['running', 'paused'][i]!;
  }
  if (v.type === 'enum') {
    const choices = [...v.choices!, ...(v.optional ? ['default'] : [])];
    const i = await pick(io, `${v.label} (${v.key})`, choices, choices.indexOf(formatValue(v.value)));
    return i === null ? null : choices[i]!;
  }
  const a = ((await io.line(`${v.label} (${v.key}) [${formatValue(v.value)}]${v.type === 'models' ? ' (comma-separated)' : v.type === 'list' ? ' (comma-separated; none = keep every tool; default = unset)' : ''}: `)) ?? '').trim();
  return a || null;
}

/**
 * Runs the menu until the user quits. Returns the keys that were changed. Pending coordinator restarts are
 * offered once on exit.
 */
export async function runSettingsMenu(project: ProjectJson, deps: MenuDeps): Promise<string[]> {
  const { io, runtime } = deps;
  const layer = deps.layer ?? 'local';
  const changed: string[] = [];
  let restartPending = false;
  let status: string[] = [`Changes are saved to ${layer === 'shared' ? 'the shared .minions/config.json' : 'the host-only config.local.json'}.`];
  let cursor = 0;
  const load = () => loadSettingsContext(project, { pausedState: (p) => runtimePaused(p, runtime) });
  let ctx = await load();
  try {
    for (;;) {
      const views = ordered(listSettings(ctx));
      let choice: number | null;
      if (io.tty) {
        io.write(render(views, cursor, status));
        const k = await io.key();
        if (k === 'up') { cursor = (cursor + views.length - 1) % views.length; continue; }
        if (k === 'down') { cursor = (cursor + 1) % views.length; continue; }
        if (k === 'quit') break;
        if (k !== 'enter') continue;
        choice = cursor;
      } else {
        const lines: string[] = [];
        let group = '';
        views.forEach((v, i) => {
          if (v.group !== group) { group = v.group; lines.push(`${group}:`); }
          lines.push(`  ${String(i + 1).padStart(2)}) ${rowText(v)}`);
        });
        io.write([...lines, ...status, ''].join('\n'));
        const a = ((await io.line(`Setting to change [1-${views.length}, q = quit]: `)) ?? '').trim();
        if (!a || a === 'q') break;
        const n = Number(a);
        if (!Number.isInteger(n) || n < 1 || n > views.length) { status = [`Not a setting number: ${a}`]; continue; }
        choice = n - 1;
      }
      const v = views[choice]!;
      io.write(`\n${v.key}: ${v.description}\n${v.effect}\n`);
      if (v.type === 'secret') {
        const kind = v.key === 'secrets.github' ? 'github' : 'telegram';
        if (!io.tty) {
          // The numbered menu reads a piped (non-TTY) stdin: the auth flow would read the token from that same
          // stream (the menu's next lines) or fail without a terminal. Point to the piped auth form instead.
          status = [`${v.label}: not changed here (no terminal to enter a token without echo)`, `hint: run \`minions auth ${kind} --stdin < token-file\` instead`];
          continue;
        }
        await deps.runAuth(kind);
        ctx = await load();
        status = [`${v.label}: ${formatValue(currentToken(ctx, kind))}`];
        continue;
      }
      const value = await askValue(io, v);
      if (value === null) { status = [`${v.key}: unchanged`]; continue; }
      try {
        const r = await applySetting(ctx, v.key, value, { layer, restart: false }, { runtime, confirm: yesNo(io) });
        if (r.changed && r.written) changed.push(v.key);
        if (r.needsRestart && r.written) restartPending = true;
        status = formatSet({ ...r, restart: null }).split('\n');
        if (r.needsRestart && r.written) status.push('needs a coordinator restart (offered when you leave the menu)');
      } catch (e) {
        status = [`not saved: ${e instanceof MinionsError ? e.message : String(e)}`, ...(e instanceof MinionsError && e.hint ? [`hint: ${e.hint}`] : [])];
      }
      ctx = await load();
    }
    if (restartPending) {
      if (!(await runtime.running(project))) io.write('The runtime is not running; the next `minions start` uses the new settings.\n');
      else if (await yesNo(io)('Some changes need a coordinator restart (graceful; refused while workers are active). Restart now? (Y/n)')) {
        const r = await restartCoordinator(project, runtime);
        io.write(`coordinator restart: ${r.action} - ${r.detail}\n`);
      } else io.write('Restart later with `minions settings restart`.\n');
    }
    return changed;
  } finally {
    io.close?.();
  }
}

const currentToken = (ctx: Awaited<ReturnType<typeof loadSettingsContext>>, kind: 'github' | 'telegram') => (ctx.credentials[kind] ? 'provisioned' : 'missing');

/**
 * Line reader for a non-TTY stdin (a pipe or a terminal emulator without a TTY): one readline interface for
 * the whole menu, so lines that arrive together are queued instead of lost between prompts. At end of input
 * every read answers null (the menu's "quit" / "keep"; never a yes), so the menu always ends.
 */
function pipedLines(stdin: NodeJS.ReadableStream): { next(): Promise<string | null>; close(): void } {
  const rl = createInterface({ input: stdin, terminal: false });
  const queue: string[] = [];
  const waiting: ((l: string | null) => void)[] = [];
  let ended = false;
  rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else queue.push(l); });
  rl.on('close', () => { ended = true; while (waiting.length) waiting.shift()!(null); });
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()!) : ended ? Promise.resolve(null) : new Promise((r) => { waiting.push(r); })),
    close: () => rl.close(),
  };
}

/** The real terminal: raw-mode key presses on stdin, output on stderr (stdout stays clean). Without a TTY: numbered prompts. */
export function terminalMenuIO(stdin: NodeJS.ReadStream = process.stdin, out: NodeJS.WritableStream = process.stderr): MenuIO {
  const tty = !!stdin.isTTY;
  if (tty) emitKeypressEvents(stdin);
  let piped: ReturnType<typeof pipedLines> | undefined;
  if (!tty) {
    return {
      tty,
      write: (t) => { out.write(t); },
      key: async () => 'quit',
      line: async (prompt) => { out.write(prompt); piped ??= pipedLines(stdin); return piped.next(); },
      close: () => piped?.close(),
    };
  }
  return {
    tty,
    write: (t) => { out.write(t); },
    key: () => new Promise<MenuKey>((resolve) => {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.once('keypress', (_s: string, k: { name?: string; ctrl?: boolean } = {}) => {
        stdin.setRawMode(false);
        stdin.pause();
        if (k.ctrl && k.name === 'c') resolve('quit');
        else if (k.name === 'up' || k.name === 'k') resolve('up');
        else if (k.name === 'down' || k.name === 'j') resolve('down');
        else if (k.name === 'return' || k.name === 'enter') resolve('enter');
        else if (k.name === 'q' || k.name === 'escape') resolve('quit');
        else resolve('other');
      });
    }),
    line: async (prompt) => {
      const rl = createInterface({ input: stdin, output: out as NodeJS.WriteStream });
      try { return await rl.question(prompt); } finally { rl.close(); }
    },
  };
}
