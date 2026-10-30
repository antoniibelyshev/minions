// task-98: workers read a task's notes through `minions backlog show <id> --json` (and the work brief);
// listings and exports stay without notes, and long notes keep only the most recent part.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NOTES_MAX_CHARS, boundNotes, toTask } from '../../src/backlog/backlogmd.js';
import { defaults } from '../helpers.js';
import { runCli } from './harness.js';

// The CLI runs in-process against an in-memory backlog (no Backlog.md subprocess); see harness.ts.
vi.mock('../../src/backlog/factory.js', async (orig) => (await import('./harness.js')).mockFactory(await orig()));

describe('boundNotes / toTask notes', () => {
  it('keeps short notes as is and maps empty notes to null', () => {
    expect(boundNotes('note A\n\nnote B\n')).toBe('note A\n\nnote B');
    expect(boundNotes(null)).toBeNull();
    expect(boundNotes('  \n')).toBeNull();
  });

  it('keeps the most recent part of long notes with a marker', () => {
    const old = Array.from({ length: 1000 }, (_, i) => `old note ${i}`).join('\n\n');
    const text = `${old}\n\nnewest note`;
    const b = boundNotes(text)!;
    expect(text.length).toBeGreaterThan(NOTES_MAX_CHARS);
    expect(b.length).toBeLessThanOrEqual(NOTES_MAX_CHARS + 60);
    expect(b).toMatch(/^\[\.\.\. \d+ earlier characters of notes omitted \.\.\.\]\n/);
    expect(b.endsWith('newest note')).toBe(true);
    expect(b).not.toContain('old note 0\n');
    // The cut lands on a line start, not mid-line.
    expect(b.split('\n')[1]).toMatch(/^(old note \d+)?$/);
  });

  it('only fills notes when asked, and the version ignores the option', () => {
    const raw = { id: 'TASK-3', title: 'T', status: 'ready', implementationNotes: 'remember the spike' };
    const plain = toTask(raw);
    const withNotes = toTask(raw, { notes: true });
    expect('notes' in plain).toBe(false);
    expect(withNotes.notes).toBe('remember the spike');
    expect(withNotes.version).toBe(plain.version);
    expect(toTask({ ...raw, implementationNotes: null }, { notes: true }).notes).toBeNull();
  });
});

let state: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG'] as const;

beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), 'minions-notescli-'));
  for (const k of ENV) saved[k] = process.env[k];
  const config = join(state, 'config.json');
  writeFileSync(config, JSON.stringify(defaults()));
  Object.assign(process.env, { MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: config });
});
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(state, { recursive: true, force: true });
});

const cli = runCli;
const data = <T>(out: string) => (JSON.parse(out) as { data: T }).data;

describe('backlog show --json returns notes (in-memory backlog)', () => {
  it('shows notes appended with backlog note; list and export leave them out', async () => {
    const c = await cli(['backlog', 'create', '--title', 'Noted task', '--key', 'notes-1']);
    expect(c.code, c.out).toBe(0);
    const id = data<{ task: { id: string; version: string } }>(c.out).task.id;
    const before = data<{ notes?: string | null; version: string }>((await cli(['backlog', 'show', id])).out);
    expect(before.notes).toBeNull();

    expect((await cli(['backlog', 'note', id, '--text', 'spike result: use the fast path\nsecond line'])).code).toBe(0);
    expect((await cli(['backlog', 'note', id, '--text', 'recovered wip commit abc123'])).code).toBe(0);
    const shown = data<{ notes?: string | null; version: string }>((await cli(['backlog', 'show', id])).out);
    expect(shown.notes).toBe('spike result: use the fast path\nsecond line\n\nrecovered wip commit abc123');
    expect(shown.version).not.toBe(before.version); // a note still changes the version, as before

    // The version from show still works for --expected-version.
    const upd = await cli(['backlog', 'update', id, '--expected-version', shown.version, '--priority', 'low']);
    expect(upd.code, upd.out).toBe(0);

    const listed = data<{ tasks: Record<string, unknown>[] }>((await cli(['backlog', 'list'])).out).tasks;
    expect(listed.find((t) => t.id === id)).toBeDefined();
    expect(listed.every((t) => !('notes' in t))).toBe(true);
    const exported = data<{ tasks: Record<string, unknown>[] }>((await cli(['backlog', 'export'])).out).tasks;
    expect(exported.every((t) => !('notes' in t))).toBe(true);
  });

  it('bounds long notes to the most recent part', async () => {
    const id = data<{ task: { id: string } }>((await cli(['backlog', 'create', '--title', 'Chatty task', '--key', 'notes-2'])).out).task.id;
    const chunk = 'x'.repeat(3000);
    for (let i = 0; i < 4; i++) expect((await cli(['backlog', 'note', id, '--text', `note ${i}: ${chunk}`])).code).toBe(0);
    const notes = data<{ notes: string }>((await cli(['backlog', 'show', id])).out).notes;
    expect(notes).toMatch(/^\[\.\.\. \d+ earlier characters of notes omitted \.\.\.\]\n/);
    expect(notes).toContain('note 3: ');
    expect(notes).not.toContain('note 0: ');
    expect(notes.length).toBeLessThanOrEqual(NOTES_MAX_CHARS + 60);
  });
});
