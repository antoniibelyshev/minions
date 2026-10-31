import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkflow } from '../../src/config/workflows.js';
import {
  appliesOn, changedKeys, controlApply, controlSet, controlShow, controlUndo, controlUnset, journalPath, mergeObj, overlayPath, parseValue,
  readJournal, readOverlay, unsetPath, withControl,
} from '../../src/runtime/control.js';
import type { MinionsError } from '../../src/core/errors.js';
import { defaults } from '../helpers.js';

let state: string;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), 'minions-control-')); });
afterEach(() => rmSync(state, { recursive: true, force: true }));

const deps = () => ({ state, base: defaults(), now: () => new Date('2026-10-31T10:00:00Z') });
const researcher = { description: 'Researches.', promptText: 'Research it.', contract: 'producer', edits: { paths: ['docs/research/**'] } };

describe('control overlay', () => {
  it('applies a change at once: the next config load sees it, and the journal records it', async () => {
    const c = await controlSet(deps(), 'workflows.default', ['engineer', 'reviewer'], 'drop the tester');
    expect(c.revision).toBe(1);
    expect(c.keys).toEqual([{ key: 'workflows.default', appliesOn: 'next-stage', hostOwned: true }]);
    const cfg = withControl(defaults(), state);
    expect(resolveWorkflow(cfg, null)!.stages.map((s) => s.role)).toEqual(['engineer', 'reviewer']);
    const [entry] = readJournal(state);
    expect(entry).toMatchObject({ revision: 1, op: 'set', keys: ['workflows.default'], reason: 'drop the tester', before: {} });
  });

  it('defines a role and the workflow that uses it in one apply', async () => {
    await controlApply(deps(), { roles: { researcher }, workflows: { research: ['researcher', 'reviewer'] } }, 'research tasks');
    const cfg = withControl(defaults(), state);
    expect(cfg.roles?.researcher).toMatchObject({ promptText: 'Research it.' });
    expect(resolveWorkflow(cfg, "research")!.stages.map((s) => s.role)).toEqual(['researcher', 'reviewer']);
  });

  it('refuses an invalid change and writes nothing', async () => {
    await expect(controlSet(deps(), 'workflows.docs', ['nobody'], 'typo')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(readOverlay(state).revision).toBe(0);
    expect(readJournal(state)).toEqual([]);
    await expect(controlSet(deps(), 'execution.maxActiveTasks', 1, '  ')).rejects.toMatchObject({ code: 'PRECONDITION' });
  });

  it('may lift a project deny (full control), unlike the local layer', async () => {
    const base = defaults();
    expect(base.capabilities['git.push']).toBeDefined();
    await controlSet(deps(), 'capabilities.git.push', 'allow', 'owner said the coordinator may push');
    expect(withControl(base, state).capabilities['git.push']).toBe('allow');
  });

  it('unset falls back to the lower layers; undo restores the snapshot before a revision', async () => {
    const base = defaults();
    await controlSet(deps(), 'execution.maxActiveTasks', 7, 'more parallel work');
    await controlSet(deps(), 'execution.maxRepairCyclesBeforeReplan', 5, 'more repairs');
    expect(withControl(base, state).execution.maxActiveTasks).toBe(7);
    const u = await controlUnset(deps(), 'execution.maxActiveTasks', 'back to default');
    expect(u.keys.map((k) => k.key)).toEqual(['execution.maxActiveTasks']);
    expect(withControl(base, state).execution.maxActiveTasks).toBe(base.execution.maxActiveTasks);
    expect(readOverlay(state).config).toEqual({ execution: { maxRepairCyclesBeforeReplan: 5 } });
    const undo = await controlUndo(deps(), 'oops');
    expect(undo).toMatchObject({ revision: 4, op: 'undo' });
    expect(withControl(base, state).execution.maxActiveTasks).toBe(7);
    await controlUndo(deps(), 'start over', 1);
    expect(readOverlay(state).config).toEqual({});
    expect(readJournal(state).at(-1)).toMatchObject({ op: 'undo', undid: 1 });
    await expect(controlUndo(deps(), 'x', 99)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a no-op change creates no revision', async () => {
    await controlSet(deps(), 'execution.maxActiveTasks', 3, 'a');
    const again = await controlSet(deps(), 'execution.maxActiveTasks', 3, 'a');
    expect(again).toMatchObject({ revision: 1, keys: [] });
    expect(readJournal(state)).toHaveLength(1);
  });

  it('show lists the effective value of every overlay key', async () => {
    await controlSet(deps(), 'execution.maxActiveTasks', 4, 'x');
    expect(controlShow(deps())).toMatchObject({ revision: 1, overlay: { execution: { maxActiveTasks: 4 } }, effective: { 'execution.maxActiveTasks': 4 } });
  });

  it('a malformed overlay is an error, never silently ignored', () => {
    mkdirSync(join(state, 'control'), { recursive: true });
    writeFileSync(overlayPath(state), '{not json');
    expect(() => readOverlay(state)).toThrow(/not valid JSON/);
    writeFileSync(overlayPath(state), JSON.stringify({ revision: 'x', config: {} }));
    let err: MinionsError | undefined;
    try { readOverlay(state); } catch (e) { err = e as MinionsError; }
    expect(err?.code).toBe('INVALID_CONFIG');
  });

  it('keeps the overlay and journal private', async () => {
    await controlSet(deps(), 'execution.maxActiveTasks', 2, 'x');
    expect(JSON.parse(readFileSync(overlayPath(state), 'utf8')).revision).toBe(1);
    expect(readFileSync(journalPath(state), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('control helpers', () => {
  it('parses values as JSON with a plain-string fallback', () => {
    expect(parseValue('3')).toBe(3);
    expect(parseValue('["a"]')).toEqual(['a']);
    expect(parseValue('haiku')).toBe('haiku');
  });
  it('merges objects, replaces arrays, and prunes empty parents on unset', () => {
    expect(mergeObj({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } })).toEqual({ a: { b: 1, c: [2], d: 3 } });
    expect(unsetPath({ a: { b: { c: 1 } }, x: 1 }, ['a', 'b', 'c'])).toEqual({ x: 1 });
    expect(changedKeys({ a: { b: 1 } }, { a: { b: 2, c: 3 } })).toEqual(['a.b', 'a.c']);
  });
  it('says when a key applies', () => {
    expect(appliesOn('execution.maxActiveTasks').appliesOn).toBe('next-command');
    expect(appliesOn('roles.researcher.model').appliesOn).toBe('next-stage');
    expect(appliesOn('models.coordinator').appliesOn).toBe('coordinator-restart');
    expect(appliesOn('container.cpus').appliesOn).toBe('container-recreate');
  });
});
