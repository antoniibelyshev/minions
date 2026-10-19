import { describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { installTelegramPlugin } from '../../src/telegram/install.js';
import { TELEGRAM_PLUGIN_ID } from '../../src/telegram/probe.js';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const official = { name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' };
const plugin = (over: Record<string, unknown> = {}) => ({ id: TELEGRAM_PLUGIN_ID, version: '0.0.7', scope: 'user', enabled: true, ...over });

/** Fake `claude plugin …` CLI with mutable marketplace/plugin state. */
function fakeClaude(state: { marketplaces: unknown[]; plugins: Record<string, unknown>[] }) {
  const calls: string[][] = [];
  const runner = async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    const a = args.join(' ');
    if (a === 'plugin marketplace list --json') return ok(JSON.stringify(state.marketplaces));
    if (a === 'plugin list --json') return ok(JSON.stringify(state.plugins));
    if (a === 'plugin marketplace add anthropics/claude-plugins-official') { state.marketplaces.push(official); return ok(); }
    if (a === `plugin install ${TELEGRAM_PLUGIN_ID} --scope user`) { state.plugins.push(plugin()); return ok(); }
    if (a === `plugin enable ${TELEGRAM_PLUGIN_ID}`) { state.plugins[0]!.enabled = true; return ok(); }
    return { code: 1, stdout: '', stderr: `unexpected: ${a}` };
  };
  return { calls, runner };
}

describe('minions telegram install', () => {
  it('adds the official marketplace and installs at user scope (never --plugin-dir, never update)', async () => {
    const f = fakeClaude({ marketplaces: [], plugins: [] });
    const r = await installTelegramPlugin({ runner: f.runner });
    expect(r).toEqual({ marketplace: 'added', plugin: 'installed', version: '0.0.7', warnings: [] });
    const flat = f.calls.map((c) => c.join(' '));
    expect(flat).toContain('claude plugin marketplace add anthropics/claude-plugins-official');
    expect(flat).toContain(`claude plugin install ${TELEGRAM_PLUGIN_ID} --scope user`);
    expect(flat.some((c) => /--plugin-dir|plugin update/.test(c))).toBe(false);
  });

  it('is idempotent and enables a disabled install; warns on unverified versions', async () => {
    const present = fakeClaude({ marketplaces: [official], plugins: [plugin()] });
    expect(await installTelegramPlugin({ runner: present.runner })).toMatchObject({ marketplace: 'present', plugin: 'present' });
    expect(present.calls.every((c) => c.includes('--json'))).toBe(true);
    const disabled = fakeClaude({ marketplaces: [official], plugins: [plugin({ enabled: false, version: '0.1.0' })] });
    const r = await installTelegramPlugin({ runner: disabled.runner });
    expect(r.plugin).toBe('enabled');
    expect(r.warnings.join()).toMatch(/0\.1\.0 is not a verified version/);
  });

  it('refuses a marketplace that points at another repository', async () => {
    const f = fakeClaude({ marketplaces: [{ ...official, repo: 'evil/plugins' }], plugins: [] });
    await expect(installTelegramPlugin({ runner: f.runner })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.calls.some((c) => c.includes('install'))).toBe(false);
  });
});
