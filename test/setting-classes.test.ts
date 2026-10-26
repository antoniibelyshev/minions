// task-53.2 (host-manager phase 1): the settings classification guard. Every key of MinionsConfigSchema has
// a class (live / restart / recreate / fixed) and a host-owned flag (src/config/setting-classes.ts); the
// schema is walked, so a new key without an entry fails here. Also: the settings model (src/host/settings.ts)
// agrees with the table, and the classes match the code that applies the keys (restart-by-prompt keys
// change the generated plugin, so a coordinator restart is what applies them).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateConfig } from '../src/config/resolve.js';
import { MinionsConfigSchema, type MinionsConfig } from '../src/config/schema.js';
import { KEY_CLASSES, SETTING_CLASSES, classifyKey, schemaKeyPaths } from '../src/config/setting-classes.js';
import { SETTINGS, getPath, setPath, type SettingDef } from '../src/host/settings.js';
import { generatePlugin } from '../src/plugin/generate.js';
import { defaults } from './helpers.js';

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

const paths = schemaKeyPaths();

describe('schema walk', () => {
  it('finds the leaf keys of every section (so the guard below is not vacuous)', () => {
    expect(paths.length).toBeGreaterThan(60);
    for (const k of ['schemaVersion', 'execution.maxActiveTasks', 'execution.maxByRole', 'verification.commands', 'models.effortByRole.coordinator',
      'container.cpus', 'container.mountDockerSocket', 'git.identity.name', 'git.baseBranch', 'capabilities.git.push', 'capabilities.deploy.execute',
      'coordinator.contextReset.enabled', 'coordinator.contextReset.contextTokens', 'intake.github.enabled', 'intake.scope.allowedPaths',
      'roles.engineer.model', 'workflows', 'harnesses.codex.models.default', 'harnesses.network.tcpConnectPorts', 'permissionMode', 'budgets.dailyUsd']) {
      expect(paths, k).toContain(k);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('reports a key added to the schema as unclassified', () => {
    const extended = MinionsConfigSchema.extend({ newThing: z.object({ knob: z.number().optional() }).strict().optional() });
    const unclassified = schemaKeyPaths(extended).filter((p) => !classifyKey(p));
    expect(unclassified).toEqual(['newThing.knob']);
  });
});

describe('guard: every schema key has a class and a host-owned flag', () => {
  it('classifies every key', () => {
    const unclassified = paths.filter((p) => !classifyKey(p));
    expect(unclassified, 'add these keys to KEY_CLASSES in src/config/setting-classes.ts (docs/design/host-manager.md)').toEqual([]);
    for (const p of paths) {
      const c = classifyKey(p)!;
      expect(SETTING_CLASSES, p).toContain(c.class);
      expect(typeof c.hostOwned, p).toBe('boolean');
      expect(c.reason, p).not.toBe('');
    }
  });

  it('has no stale or duplicate entries: each entry covers at least one schema key', () => {
    const keys = KEY_CLASSES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    const stale = KEY_CLASSES.filter((e) => !paths.some((p) => p === e.key || p.startsWith(e.key + '.'))).map((e) => e.key);
    expect(stale).toEqual([]);
  });

  it('matches the design table for the classes and host-owned keys', () => {
    const cls = (k: string) => classifyKey(k)?.class;
    const owned = (k: string) => classifyKey(k)?.hostOwned;
    for (const k of ['execution.maxActiveTasks', 'execution.maxEngineers', 'execution.maxByRole', 'execution.maxRepairCyclesBeforeReplan',
      'coordinator.contextReset.enabled', 'verification.commands', 'verification.qaLabels', 'verification.ciPendingTimeoutMinutes',
      'intake.github.labels', 'intake.scope.milestone', 'intake.sources']) expect(cls(k), k).toBe('live');
    for (const k of ['execution.attemptMaxTurns', 'budgets.taskUsd', 'communication.progress', 'models.default', 'models.allowed',
      'models.selection', 'models.effortByRole.engineer', 'models.coordinator', 'models.effort', 'models.effortByRole.coordinator',
      'coordinator.toolSearch']) expect([cls(k), owned(k)], k).toEqual(['restart', false]);
    for (const k of ['communication.channel', 'capabilities.pr.merge', 'sensitivePaths', 'architecture', 'intake.startReady', 'delivery.mode',
      'delivery.merge', 'verification.testerRequired', 'verification.reviewerRequired', 'verification.ciAuthority', 'coordinator.permissionMode',
      'coordinator.disallowedTools', 'coordinator.bundledSkills', 'permissionMode', 'roles.engineer.tools', 'roles.researcher', 'workflows',
      'harnesses.default']) expect([cls(k), owned(k)], k).toEqual(['restart', true]);
    for (const k of ['git.identity.email', 'container.cpus', 'container.memoryMiB', 'container.pidsLimit', 'container.tmpSizeMiB'])
      expect([cls(k), owned(k)], k).toEqual(['recreate', false]);
    for (const k of ['container.network', 'container.publishPorts', 'container.mountHostRepository', 'container.mountDockerSocket'])
      expect([cls(k), owned(k)], k).toEqual(['recreate', true]);
    for (const k of ['schemaVersion', 'configRevision', 'projectId', 'packageVersion', 'profile', 'visibility', 'backlog.backend',
      'git.baseBranch', 'container.required', 'container.workspace', 'execution.oneActiveStagePerTask']) expect(cls(k), k).toBe('fixed');
    // The most specific entry wins: git.identity (recreate) under git, effortByRole.coordinator (launch) next to the worker roles.
    expect(classifyKey('git.identity.name')?.key).toBe('git.identity');
    expect(classifyKey('models.effortByRole.coordinator')?.reason).toMatch(/--effort/);
  });
});

describe('the settings model agrees with the classification', () => {
  const schemaBacked = SETTINGS.filter((d) => d.type !== 'secret' && d.type !== 'control');

  it('every config setting is a classified schema key with the same class and host-owned flag; none is fixed', () => {
    for (const d of schemaBacked) {
      const c = classifyKey(d.key);
      expect(c, d.key).toBeDefined();
      expect(paths.some((p) => p === d.key || p.startsWith(d.key + '.')), `${d.key} is a schema key`).toBe(true);
      expect({ key: d.key, class: d.class, hostOwned: d.hostOwned }).toEqual({ key: d.key, class: c!.class, hostOwned: c!.hostOwned });
      expect(d.class).not.toBe('fixed');
    }
  });

  it('prompt and launch both mean restart; non-schema items declare their flag', () => {
    for (const d of SETTINGS) {
      expect(d.class, d.key).toBe(d.apply === 'live' ? 'live' : d.apply === 'recreate' ? 'recreate' : 'restart');
      expect(typeof d.hostOwned, d.key).toBe('boolean');
    }
    const byKey = (k: string) => SETTINGS.find((d) => d.key === k)!;
    expect([byKey('secrets.github').hostOwned, byKey('secrets.telegram').hostOwned]).toEqual([true, true]);
    expect([byKey('pause.intake').hostOwned, byKey('pause.starts').hostOwned]).toEqual([false, false]);
    expect(byKey('capabilities.git.push')).toMatchObject({ class: 'restart', hostOwned: true });
    expect(byKey('execution.maxActiveTasks')).toMatchObject({ class: 'live', hostOwned: false });
  });
});

/** A different valid value for a setting (for the plugin comparison). */
function otherValue(d: SettingDef, cfg: MinionsConfig): unknown {
  const cur = getPath(cfg, d.key);
  switch (d.type) {
    case 'int': return (typeof cur === 'number' ? cur : 1) + 7;
    case 'bool': return !(cur ?? false);
    case 'enum': return d.choices!.find((c) => c !== (typeof cur === 'object' && cur ? (cur as { effect: string }).effect : cur));
    case 'model': return cfg.models.allowed.find((m) => m !== cur);
    case 'models': return [...cfg.models.allowed, 'claude-test-extra'];
    default: throw new Error(`no alternative for ${d.key}`);
  }
}

async function pluginText(cfg: MinionsConfig): Promise<Map<string, string>> {
  const out = await mkdtemp(join(tmpdir(), 'minions-classes-'));
  dirs.push(out);
  const files = await generatePlugin(cfg, out);
  return new Map(await Promise.all(files.map(async (f) => [relative(out, f.path), await readFile(f.path, 'utf8')] as [string, string])));
}

describe('classes match the code that applies the key', () => {
  it('every prompt-applied restart setting changes the generated plugin (so a coordinator restart applies it)', async () => {
    const base = defaults();
    base.models.allowed = ['sonnet', 'opus', 'haiku'];
    base.models.default = 'sonnet';
    base.delivery.provider = 'github'; // so delivery.mode may move off local
    // delivery.merge only reaches the prompt with pull-request delivery and auto-merge (its other values are
    // enforced by the runtime gates): compare there.
    const probes: Record<string, { base: (c: MinionsConfig) => void; to: unknown }> = {
      'delivery.merge': { base: (c) => { c.delivery.mode = 'pull-request'; c.delivery.requiredChecksConfigured = true; c.verification.ciAuthority = 'github'; }, to: 'auto-when-eligible' },
    };
    const prompt = SETTINGS.filter((d) => d.apply === 'prompt');
    expect(prompt.length).toBeGreaterThan(20);
    const unchanged: string[] = [];
    for (const d of prompt) {
      const from = structuredClone(base);
      probes[d.key]?.base(from);
      const before = await pluginText(validateConfig(from, 'test'));
      const next = setPath(structuredClone(from) as unknown as Record<string, unknown>, d.key, probes[d.key] ? probes[d.key]!.to : otherValue(d, from));
      const after = await pluginText(validateConfig(next, 'test'));
      if ([...after].every(([k, v]) => before.get(k) === v)) unchanged.push(d.key);
    }
    expect(unchanged).toEqual([]);
  }, 60_000);
});
