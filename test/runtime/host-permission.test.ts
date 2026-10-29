// Task-8: the owner's host-only opt-in to a looser coordinator permission mode. The host runtime honours
// coordinator.permissionMode auto/acceptEdits only from the host-written runtime/host-permission.json (the
// config.local.json layer), fails closed to default otherwise, never allows bypassPermissions/dontAsk, and
// emits the same allow/deny/ask rules and sandbox in every mode. Temp dirs only; no real claude.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import {
  HOST_PERMISSION_FILE, hostPermissionPath, hostPermissionRecord, permissionSourceLabel, readHostPermission,
} from '../../src/runtime/host-permission.js';
import { buildClaudeCommand, decidePermissionMode, hostPermissionFromEnv, launchPermission } from '../../src/runtime/coordinator.js';
import { humanPermission, runtimePermissionStatus } from '../../src/runtime/commands.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';

const ALL_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const NO_AUTO = ['acceptEdits', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

const dirs: string[] = [];
const mkTmp = () => { const d = mkdtempSync(join(tmpdir(), 'minions-hostperm-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const savedEnv = { ...process.env };
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv); });

/** A host-runtime layout: plugin, workspace, state and <root>/runtime (MINIONS_CONFIG's dir) for the record. */
function hostLayout(record?: unknown) {
  const root = mkTmp();
  mkdirSync(join(root, 'plugin'), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'coordinator prompt\n');
  for (const d of ['ws', 'state', 'runtime']) mkdirSync(join(root, d), { recursive: true });
  const file = join(root, 'runtime', HOST_PERMISSION_FILE);
  if (record !== undefined) writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
  const env = {
    MINIONS_RUNTIME: 'host', MINIONS_PLUGIN_DIR: join(root, 'plugin'), MINIONS_STATE_DIR: join(root, 'state'),
    MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_SECRETS_DIR: join(root, 'secrets'), MINIONS_CONFIG: join(root, 'runtime', 'config.json'),
  };
  return { root, file, env, local: join(root, 'config.local.json') };
}
const rec = (mode: unknown, source = '/owner/config.local.json') => ({ version: 1, coordinatorPermissionMode: mode, source });
const withCoord = (permissionMode?: string): MinionsConfig =>
  ({ ...defaults(), ...(permissionMode ? { coordinator: { permissionMode } } : {}) }) as MinionsConfig;
const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

describe('host permission record', () => {
  it('the host writes only the config.local.json value, and only an opt-in mode', () => {
    expect(hostPermissionRecord({ coordinator: { permissionMode: 'auto' } }, '/p/config.local.json'))
      .toEqual({ version: 1, coordinatorPermissionMode: 'auto', source: '/p/config.local.json' });
    expect(hostPermissionRecord({ coordinator: { permissionMode: 'acceptEdits' } }, '/l').coordinatorPermissionMode).toBe('acceptEdits');
    for (const raw of [undefined, null, [], {}, { coordinator: {} }, { coordinator: { permissionMode: 'bypassPermissions' } },
      { coordinator: { permissionMode: 'dontAsk' } }, { coordinator: { permissionMode: 'default' } }, { permissionMode: 'auto' }]) {
      expect(hostPermissionRecord(raw, '/l').coordinatorPermissionMode).toBeNull();
    }
  });

  it('the record path is next to MINIONS_CONFIG on the host; never in the container or without MINIONS_CONFIG', () => {
    expect(hostPermissionPath({ MINIONS_CONFIG: '/p/runtime/config.json' }, false)).toBe(join('/p/runtime', HOST_PERMISSION_FILE));
    expect(hostPermissionPath({ MINIONS_CONFIG: '/p/runtime/config.json' }, true)).toBeNull();
    expect(hostPermissionPath({ MINIONS_CONFIG: '/p/runtime/config.json', MINIONS_RUNTIME: 'container' }, false)).toBeNull();
    expect(hostPermissionPath({}, false)).toBeNull();
  });

  it('reads a valid record; fails closed (no opt-in) on missing, invalid, forbidden or agent-writable records', () => {
    const { root, file } = hostLayout(rec('auto', '/owner/config.local.json'));
    const writable = [join(root, 'ws'), join(root, 'state')];
    expect(readHostPermission(file, writable)).toEqual({ layer: { mode: 'auto', source: '/owner/config.local.json' } });
    expect(readHostPermission(null, writable)).toEqual({ layer: null });
    expect(readHostPermission(join(root, 'runtime', 'missing.json'), writable)).toEqual({ layer: null });
    expect(readHostPermission(file, writable, () => JSON.stringify(rec(null)))).toEqual({ layer: null });

    const bad = (text: string) => readHostPermission(file, writable, () => text);
    expect(bad('{not json')).toMatchObject({ layer: null, note: expect.stringMatching(/not valid JSON/) });
    expect(bad(JSON.stringify({ version: 2, coordinatorPermissionMode: 'auto', source: 'x' }))).toMatchObject({ layer: null, note: expect.stringMatching(/not a host permission record/) });
    expect(bad('null')).toMatchObject({ layer: null, note: expect.any(String) });
    for (const m of ['bypassPermissions', 'dontAsk', 'default', 'plan']) {
      expect(bad(JSON.stringify(rec(m)))).toMatchObject({ layer: null, note: expect.stringMatching(/may never use/) });
    }
    expect(readHostPermission(file, writable, () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); }))
      .toMatchObject({ layer: null, note: expect.stringMatching(/not readable/) });

    // A record an agent could have written (inside the workspace or state) is never honoured.
    for (const d of writable) {
      const planted = join(d, HOST_PERMISSION_FILE);
      writeFileSync(planted, JSON.stringify(rec('auto')));
      expect(readHostPermission(planted, writable)).toMatchObject({ layer: null, note: expect.stringMatching(/agent-writable/) });
    }
  });

  it('hostPermissionFromEnv reads <dirname MINIONS_CONFIG>/host-permission.json; a container never reads it', () => {
    const { env } = hostLayout(rec('acceptEdits'));
    Object.assign(process.env, env);
    expect(hostPermissionFromEnv(process.env).layer).toEqual({ mode: 'acceptEdits', source: '/owner/config.local.json' });
    process.env.MINIONS_RUNTIME = 'container';
    expect(hostPermissionFromEnv(process.env).layer).toBeNull();
  });
});

describe('decidePermissionMode on the host runtime', () => {
  const local = (mode: 'auto' | 'acceptEdits') => ({ mode, source: '/owner/config.local.json' });

  it('auto from config.local.json -> auto; acceptEdits fallback when this Claude Code lacks auto or --help is unreadable', () => {
    const cfg = withCoord('auto');
    expect(decidePermissionMode(cfg, { hostRuntime: true, modes: ALL_MODES, hostLocal: local('auto') }))
      .toMatchObject({ configured: 'auto', mode: 'auto', fallback: false, source: 'host-local', sourceFile: '/owner/config.local.json' });
    for (const modes of [NO_AUTO, null]) {
      expect(decidePermissionMode(cfg, { hostRuntime: true, modes, hostLocal: local('auto') }))
        .toMatchObject({ configured: 'auto', mode: 'acceptEdits', fallback: true, source: 'host-local' });
    }
    expect(decidePermissionMode(withCoord('acceptEdits'), { hostRuntime: true, modes: ALL_MODES, hostLocal: local('acceptEdits') }))
      .toMatchObject({ configured: 'acceptEdits', mode: 'acceptEdits', fallback: false, source: 'host-local' });
  });

  it('the same value only in the repository / shared config is ignored on the host (stays default)', () => {
    for (const m of ['auto', 'acceptEdits']) {
      const d = decidePermissionMode(withCoord(m), { hostRuntime: true, modes: ALL_MODES, hostLocal: null });
      expect(d).toMatchObject({ configured: 'default', mode: 'manual', fallback: false, source: 'host-default' });
      expect(d.reason).toMatch(new RegExp(`coordinator.permissionMode "${m}" from the project configuration is ignored on the host runtime`));
    }
    expect(decidePermissionMode(defaults(), { hostRuntime: true, modes: ['acceptEdits', 'auto', 'default'], hostLocal: null }))
      .toMatchObject({ configured: 'default', mode: 'default', source: 'host-default' });
  });

  it('a record that does not match the runtime config (stale or hand-edited) fails closed to default', () => {
    const d = decidePermissionMode(withCoord('acceptEdits'), { hostRuntime: true, modes: ALL_MODES, hostLocal: local('auto') });
    expect(d).toMatchObject({ mode: 'manual', source: 'host-default' });
    expect(d.reason).toMatch(/does not match the runtime config/);
    expect(decidePermissionMode(defaults(), { hostRuntime: true, modes: ALL_MODES, hostLocal: local('auto') }).source).toBe('host-default');
  });

  it('bypassPermissions / dontAsk are refused from every layer', () => {
    for (const m of ['bypassPermissions', 'dontAsk']) {
      for (const hostRuntime of [true, false]) {
        expect(() => decidePermissionMode(withCoord(m), { hostRuntime, modes: ALL_MODES, hostLocal: null })).toThrow(/never allowed/);
        expect(() => decidePermissionMode({ ...defaults(), permissionMode: m } as MinionsConfig, { hostRuntime, modes: ALL_MODES, hostLocal: null })).toThrow(/never allowed/);
      }
      expect(() => decidePermissionMode(withCoord(m), { hostRuntime: true, modes: ALL_MODES, hostLocal: { mode: m as 'auto', source: 'x' } }))
        .toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
    }
  });

  it('the container ignores the host record: the merged config decides', () => {
    expect(decidePermissionMode(withCoord('acceptEdits'), { hostRuntime: false, modes: ALL_MODES }))
      .toMatchObject({ mode: 'acceptEdits', source: 'config' });
    expect(decidePermissionMode(defaults(), { hostRuntime: false, modes: ALL_MODES })).toMatchObject({ mode: 'auto', source: 'default' });
  });

  it('labels name the layer that chose the mode', () => {
    expect(permissionSourceLabel({ source: 'host-local', sourceFile: '/o/config.local.json' })).toBe('host-only config.local.json (/o/config.local.json)');
    expect(permissionSourceLabel({ source: 'host-default' })).toBe('host runtime default');
    expect(permissionSourceLabel({ source: 'config' })).toBe('project configuration');
    expect(permissionSourceLabel({ source: 'default' })).toBe('built-in default');
  });
});

describe('host launch argv: only --permission-mode changes across modes', () => {
  it('coordinator: the record in runtime/ selects the mode; --settings (allow/deny/ask, sandbox) is identical', async () => {
    const launches: Record<string, string[]> = {};
    for (const [name, record, cfg] of [
      ['none', undefined, withCoord('auto')], // repo-only value: ignored
      ['auto', rec('auto'), withCoord('auto')],
      ['acceptEdits', rec('acceptEdits'), withCoord('acceptEdits')],
      ['stale', rec('auto'), withCoord('acceptEdits')],
    ] as const) {
      const { env } = hostLayout(record);
      Object.assign(process.env, env);
      // Use one fixed layout per launch, then compare settings modulo paths.
      const c = await buildClaudeCommand(cfg, runtimePaths(), { permissionModes: ALL_MODES });
      const root = env.MINIONS_STATE_DIR.slice(0, -'/state'.length);
      launches[name] = c.args.map((a) => a.split(root).join('<root>'));
    }
    expect(argOf(launches.none!, '--permission-mode')).toBe('manual');
    expect(argOf(launches.auto!, '--permission-mode')).toBe('auto');
    expect(argOf(launches.acceptEdits!, '--permission-mode')).toBe('acceptEdits');
    expect(argOf(launches.stale!, '--permission-mode')).toBe('manual');

    const settings = Object.fromEntries(Object.entries(launches).map(([k, a]) => [k, JSON.parse(argOf(a, '--settings'))]));
    expect(settings.none.permissions.deny.length).toBeGreaterThan(0);
    expect(settings.none.sandbox).toBeDefined();
    for (const k of ['auto', 'acceptEdits', 'stale']) {
      expect(settings[k].permissions).toEqual(settings.none.permissions); // allow, deny, ask
      expect(settings[k].sandbox).toEqual(settings.none.sandbox);
      expect(settings[k]).toEqual(settings.none);
      // Everything but the --permission-mode value is the same argv.
      const strip = (a: string[]) => a.filter((_, i) => i !== a.indexOf('--permission-mode') + 1);
      expect(strip(launches[k]!)).toEqual(strip(launches.none!));
    }
  });

  it('explicit hostLocal: settings identical for null / auto / acceptEdits while the mode differs', async () => {
    const { env } = hostLayout();
    Object.assign(process.env, env);
    const build = (cfg: MinionsConfig, hostLocal: { mode: 'auto' | 'acceptEdits'; source: string } | null) =>
      buildClaudeCommand(cfg, runtimePaths(), { permissionModes: ALL_MODES, hostLocal });
    const base = await build(withCoord('auto'), null);
    const auto = await build(withCoord('auto'), { mode: 'auto', source: '/l' });
    const edits = await build(withCoord('acceptEdits'), { mode: 'acceptEdits', source: '/l' });
    expect([base, auto, edits].map((c) => argOf(c.args, '--permission-mode'))).toEqual(['manual', 'auto', 'acceptEdits']);
    expect(argOf(auto.args, '--settings')).toBe(argOf(base.args, '--settings'));
    expect(argOf(edits.args, '--settings')).toBe(argOf(base.args, '--settings'));
  });
});

describe('status: effective mode and the layer that chose it', () => {
  it('predicted from the configuration when no launch is recorded; the launch record once the coordinator ran', async () => {
    const { env } = hostLayout(rec('auto', '/owner/config.local.json'));
    Object.assign(process.env, env);
    const paths = runtimePaths();
    const cfg = withCoord('auto');
    const decide = () => launchPermission(decidePermissionMode(cfg, { hostRuntime: true, modes: ALL_MODES }));

    const predicted = await runtimePermissionStatus(cfg, { paths, decide });
    expect(predicted).toMatchObject({ mode: 'auto', source: 'host-local', sourceFile: '/owner/config.local.json', from: 'predicted' });
    expect(predicted.restartRequired).toBeUndefined();
    expect(humanPermission(predicted)).toBe('permission mode: auto, chosen by host-only config.local.json (/owner/config.local.json) (predicted)');

    // The coordinator last ran in default (before the opt-in): restart required.
    const launched = launchPermission(decidePermissionMode(cfg, { hostRuntime: true, modes: ALL_MODES, hostLocal: null }));
    writeFileSync(paths.coordinatorLaunch, JSON.stringify({ version: 1, pid: 1, startedAt: 'x', fingerprint: 'f', channel: 'terminal', telegram: {}, permission: launched }));
    const running = await runtimePermissionStatus(cfg, { paths, decide });
    expect(running).toMatchObject({ mode: 'manual', source: 'host-default', from: 'launch', restartRequired: true });
    expect(humanPermission(running)).toMatch(/^permission mode: manual, chosen by host runtime default \(running coordinator\); .*restart the coordinator/);

    // Same decision as the launch: no restart.
    writeFileSync(paths.coordinatorLaunch, JSON.stringify({ version: 1, pid: 1, startedAt: 'x', fingerprint: 'f', channel: 'terminal', telegram: {}, permission: decide() }));
    expect((await runtimePermissionStatus(cfg, { paths, decide })).restartRequired).toBeUndefined();
  });
});
