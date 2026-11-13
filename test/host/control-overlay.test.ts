// The coordinator's control overlay on the host side (runtime health fix): doctor, merge.readiness and the
// `minions settings` listing see what the coordinator set with `minions control set` (verification.commands,
// delivery.merge), instead of reporting the host config alone. Temp MINIONS_HOME; no Docker.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fs-git.js')).withFsGit(await orig()));

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      return [];
    },
  };
});

const { hostRuntimePaths } = await import('../../src/core/paths.js');
const { overlayPath } = await import('../../src/runtime/control.js');
const { loadEffectiveConfig, loadProjectJson, projectConfigPath } = await import('../../src/host/project.js');
const { mergeOverlay, projectOverlayText } = await import('../../src/host/control-overlay.js');
const { mergeReadiness, setupGapsCheck } = await import('../../src/host/doctor.js');
const { READ_OVERLAY } = await import('../../src/host/tools.js');
const S = await import('../../src/host/settings.js');
const { initFromTemplate, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const OVERLAY = JSON.stringify({ revision: 3, updatedAt: '2026-11-01T00:00:00.000Z', config: { verification: { commands: ['npm test'] }, delivery: { merge: 'auto-when-eligible' } } });

/** A private install whose host config has no verification commands and local integration off. */
async function install() {
  const { projectId } = await initFromTemplate(env.root, { visibility: 'private' });
  const project = await loadProjectJson(projectId);
  const file = projectConfigPath(project);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...raw, verification: { ...(raw.verification as object), commands: [] }, delivery: { ...(raw.delivery as object), merge: 'disabled' } }, null, 2));
  return project;
}

describe('control overlay on the host', () => {
  it('mergeOverlay applies the overlay with provenance `control`; invalid or unreadable overlays are ignored with a warning', async () => {
    const project = await install();
    const eff = await loadEffectiveConfig(project);
    expect(mergeReadiness(eff.config)[1]).toMatch(/local integration off/);
    expect(setupGapsCheck(eff.config, { telegramToken: 'missing', nodeProject: false }).detail).toMatch(/incomplete: .*verification/);
    const m = mergeOverlay(eff, OVERLAY);
    expect(m.warning).toBeUndefined();
    expect(m.config.verification.commands).toEqual(['npm test']);
    expect(m.overlayKeys.sort()).toEqual(['delivery.merge', 'verification.commands']);
    expect(m.provenance['verification.commands']).toBe('control');
    expect(mergeReadiness(m.config)).toEqual(['ok', expect.stringMatching(/local integration ready: .*npm test/)]);
    expect(setupGapsCheck(m.config, { telegramToken: 'missing', nodeProject: false }).detail).not.toMatch(/incomplete: .*verification/);
    expect(mergeOverlay(eff, null)).toMatchObject({ config: eff.config, overlayKeys: [] });
    expect(mergeOverlay(eff, '{"revision":0,"config":{}}')).toMatchObject({ config: eff.config, overlayKeys: [] });
    expect(mergeOverlay(eff, 'not json')).toMatchObject({ config: eff.config, warning: expect.stringMatching(/not valid JSON/) });
    expect(mergeOverlay(eff, JSON.stringify({ config: { delivery: { merge: 'yolo' } } }))).toMatchObject({ config: eff.config, warning: expect.stringMatching(/does not validate/) });
  });

  it('reads the overlay file on the host runtime, and through the running container on Docker', async () => {
    const project = await install();
    const host = { projectId: project.projectId, runtime: 'host' as const };
    expect(await projectOverlayText(host)).toBeNull();
    const file = overlayPath(hostRuntimePaths(project.projectId).state);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, OVERLAY);
    expect(await projectOverlayText(host)).toBe(OVERLAY);
    const docker = { projectId: project.projectId, runtime: 'docker' as const };
    const calls: string[][] = [];
    const exec = async (args: string[]) => { calls.push(args); return { code: 0, stdout: OVERLAY, stderr: '' }; };
    expect(await projectOverlayText(docker, { running: async () => false, exec })).toBeNull();
    expect(calls).toEqual([]);
    expect(await projectOverlayText(docker, { running: async () => true, exec })).toBe(OVERLAY);
    expect(calls).toEqual([READ_OVERLAY]);
    await expect(projectOverlayText(docker, { running: async () => true, exec: async () => ({ code: 1, stdout: '', stderr: 'x' }) })).rejects.toThrow(/exit 1/);
  });

  it('the settings listing shows overlay values with source "coordinator overlay"; without the reader nothing changes', async () => {
    const project = await install();
    const plain = S.listSettings(await S.loadSettingsContext(project)).find((v) => v.key === 'verification.commands')!;
    expect(plain).toMatchObject({ value: [], source: 'project config' });
    const ctx = await S.loadSettingsContext(project, { controlOverlay: async () => OVERLAY });
    const views = S.listSettings(ctx);
    expect(views.find((v) => v.key === 'verification.commands')).toMatchObject({ value: ['npm test'], source: 'coordinator overlay' });
    expect(views.find((v) => v.key === 'delivery.merge')).toMatchObject({ value: 'auto-when-eligible', source: 'coordinator overlay' });
    expect(ctx.overlayWarning).toBeUndefined();
    const bad = await S.loadSettingsContext(project, { controlOverlay: async () => { throw new Error('container exec failed'); } });
    expect(bad.overlayWarning).toMatch(/could not be read \(container exec failed\)/);
    expect(S.listSettings(bad).find((v) => v.key === 'verification.commands')).toMatchObject({ source: 'project config' });
  });
});
