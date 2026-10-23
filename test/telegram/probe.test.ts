import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import {
  evaluateTelegram, gatherTelegramFacts, MANAGED_SETTINGS_PATH, parseClaudeVersion, probeTelegram,
  TELEGRAM_CHANNEL_SPEC, TELEGRAM_PLUGIN_ID, telegramDoctorCheck, type ManagedSettings, type TelegramFacts,
} from '../../src/telegram/probe.js';

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const err = (code: number, stderr: string): RunResult => ({ code, stdout: '', stderr });

// Shapes observed from Claude Code 2.1.292 (`claude plugin marketplace list --json`, `claude plugin list --json`).
const MARKETPLACES = JSON.stringify([{ name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official', installLocation: '/home/node/.claude/plugins/marketplaces/claude-plugins-official' }]);
const pluginEntry = (over: Record<string, unknown> = {}) => ({
  id: TELEGRAM_PLUGIN_ID, version: '0.0.7', scope: 'user', enabled: true,
  installPath: '/home/node/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7',
  mcpServers: { telegram: { command: 'bun', args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', '--shell=bun', '--silent', 'start'] } },
  projectEnabled: false, ...over,
});

const facts = (over: Partial<TelegramFacts> = {}): TelegramFacts => ({
  claude: ok('2.1.292 (Claude Code)\n'),
  bun: ok('1.3.1\n'),
  marketplaces: ok(MARKETPLACES),
  plugins: ok(JSON.stringify([pluginEntry()])),
  managed: { present: false },
  ...over,
});
const item = (r: ReturnType<typeof evaluateTelegram>, name: string) => r.items.find((i) => i.name === name)!;

describe('telegram capability probe: evaluation', () => {
  it('reports available when Claude Code, Bun, the official marketplace and plugin are present', () => {
    const r = evaluateTelegram(facts());
    expect(r.availability).toBe('available');
    expect(r.available).toBe(true);
    expect(r.channelSpec).toBe(TELEGRAM_CHANNEL_SPEC);
    expect(TELEGRAM_CHANNEL_SPEC).toBe('plugin:telegram@claude-plugins-official');
    expect(r.claudeVersion).toBe('2.1.292');
    expect(item(r, 'org.policy').status).toBe('unknown');
    // Things a credential-free probe cannot know are listed, not assumed.
    expect(r.unverified.join('\n')).toMatch(/authentication/);
    expect(r.unverified.join('\n')).toMatch(/token/);
    expect(r.unverified.join('\n')).toMatch(/409/);
  });

  it('is unavailable without Bun, with a precise message', () => {
    const r = evaluateTelegram(facts({ bun: err(127, 'Command not found: bun') }));
    expect(r.availability).toBe('unavailable');
    expect(r.summary).toMatch(/Bun is not installed/);
    expect(item(r, 'bun').hint).toMatch(/ships a pinned Bun/);
  });

  it('is unavailable when claude itself fails', () => {
    const r = evaluateTelegram(facts({ claude: err(127, 'spawn claude ENOENT') }));
    expect(r.availability).toBe('unavailable');
    expect(r.claudeVersion).toBeNull();
    expect(r.summary).toMatch(/claude --version` failed \(exit 127\)/);
  });

  it('treats an unverified Claude Code version as unknown, not as supported or broken', () => {
    const r = evaluateTelegram(facts({ claude: ok('2.2.0 (Claude Code)') }));
    expect(item(r, 'claude').status).toBe('unknown');
    expect(item(r, 'claude').detail).toMatch(/hidden from --help/);
    expect(r.availability).toBe('available');
  });

  it('reports not-installed with install hints when marketplace or plugin is missing', () => {
    const noMarket = evaluateTelegram(facts({ marketplaces: ok('[]'), plugins: ok('[]') }));
    expect(noMarket.availability).toBe('not-installed');
    expect(item(noMarket, 'marketplace').hint).toBe('claude plugin marketplace add anthropics/claude-plugins-official');
    expect(item(noMarket, 'plugin').hint).toBe(`claude plugin install ${TELEGRAM_PLUGIN_ID} --scope user`);

    // Task-51: off at user scope is the intended state; the coordinator launch enables it for itself.
    const userOff = evaluateTelegram(facts({ plugins: ok(JSON.stringify([pluginEntry({ enabled: false })])) }));
    expect(userOff.availability).toBe('available');
    expect(item(userOff, 'plugin').detail).toMatch(/off at user scope, enabled only by the coordinator launch/);

    const other = evaluateTelegram(facts({ plugins: ok(JSON.stringify([{ ...pluginEntry(), id: 'telegram@someone-else' }])) }));
    expect(other.availability).toBe('not-installed');
  });

  it('notes refused dependencies reported by Claude Code at install time', () => {
    const r = evaluateTelegram(facts({ plugins: ok(JSON.stringify([pluginEntry({ noteDetails: [{ type: 'dependencies-refused', plugin: 'telegram' }] })])) }));
    expect(item(r, 'plugin').detail).toMatch(/dependencies were not installed/);
  });

  it('blocks a marketplace named like the official one but pointing elsewhere', () => {
    const r = evaluateTelegram(facts({ marketplaces: ok(JSON.stringify([{ name: 'claude-plugins-official', source: 'github', repo: 'evil/fork' }])) }));
    expect(r.availability).toBe('blocked');
    expect(r.summary).toMatch(/evil\/fork/);
  });

  it('degrades to not-installed when the plugin CLI output is unusable', () => {
    const r = evaluateTelegram(facts({ plugins: ok('not json'), marketplaces: err(1, 'boom') }));
    expect(r.availability).toBe('not-installed');
    expect(item(r, 'plugin').status).toBe('unknown');
    expect(item(r, 'marketplace').detail).toMatch(/exit 1: boom/);
    expect(evaluateTelegram(facts({ plugins: ok('{"a":1}') })).items.find((i) => i.name === 'plugin')!.detail).toMatch(/expected an array/);
  });

  describe('organization policy from file-based managed settings', () => {
    const managed = (json: unknown): ManagedSettings => ({ present: true, json });
    it('blocks when channelsEnabled is not true', () => {
      const r = evaluateTelegram(facts({ managed: managed({ permissions: {} }) }));
      expect(r.availability).toBe('blocked');
      expect(r.summary).toMatch(/channelsEnabled: true/);
      expect(item(r, 'org.policy').hint).toMatch(/Terminal mode keeps working/);
    });
    it('blocks when allowedChannelPlugins excludes telegram', () => {
      const r = evaluateTelegram(facts({ managed: managed({ channelsEnabled: true, allowedChannelPlugins: [{ marketplace: 'claude-plugins-official', plugin: 'discord' }] }) }));
      expect(r.availability).toBe('blocked');
      expect(r.summary).toMatch(/allowedChannelPlugins/);
    });
    it('accepts channelsEnabled with telegram allowed or the default allowlist', () => {
      expect(evaluateTelegram(facts({ managed: managed({ channelsEnabled: true, allowedChannelPlugins: [{ marketplace: 'claude-plugins-official', plugin: 'telegram' }] }) })).availability).toBe('available');
      const r = evaluateTelegram(facts({ managed: managed({ channelsEnabled: true }) }));
      expect(item(r, 'org.policy').status).toBe('ok');
    });
    it('reports unreadable managed settings as unknown', () => {
      const r = evaluateTelegram(facts({ managed: { present: true, error: 'invalid JSON: x' } }));
      expect(item(r, 'org.policy').status).toBe('unknown');
      expect(r.availability).toBe('available');
    });
  });

  it('blocked takes precedence over missing Bun', () => {
    expect(evaluateTelegram(facts({ bun: err(127, ''), managed: { present: true, json: {} } })).availability).toBe('blocked');
  });

  it('parses Claude Code versions', () => {
    expect(parseClaudeVersion('2.1.292 (Claude Code)')).toBe('2.1.292');
    expect(parseClaudeVersion('garbage')).toBeNull();
  });
});

describe('telegram capability probe: fact gathering', () => {
  it('runs only read-only, session-free commands and reads only the managed settings file', async () => {
    const calls: string[] = [];
    const reads: string[] = [];
    const runner = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'bun') return err(127, 'Command not found: bun');
      if (args[0] === '--version') return ok('2.1.292 (Claude Code)');
      if (args.join(' ') === 'plugin marketplace list --json') return ok(MARKETPLACES);
      return ok('[]');
    };
    const readText = async (p: string) => {
      reads.push(p);
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    };
    const r = await probeTelegram({ runner, readText });
    expect(calls.sort()).toEqual(['bun --version', 'claude --version', 'claude plugin list --json', 'claude plugin marketplace list --json']);
    expect(reads).toEqual([MANAGED_SETTINGS_PATH]);
    expect(r.availability).toBe('unavailable');
    expect(item(r, 'org.policy').status).toBe('unknown');
  });

  it('distinguishes missing, invalid, and unreadable managed settings', async () => {
    const runner = async () => ok('[]');
    const parsed = await gatherTelegramFacts({ runner, readText: async () => '{"channelsEnabled":true}' });
    expect(parsed.managed).toEqual({ present: true, json: { channelsEnabled: true } });
    const invalid = await gatherTelegramFacts({ runner, readText: async () => '{' });
    expect(invalid.managed).toMatchObject({ present: true, error: expect.stringMatching(/invalid JSON/) });
    const denied = await gatherTelegramFacts({ runner, readText: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
    expect(denied.managed).toEqual({ present: true, error: 'unreadable (EACCES)' });
  });
});

describe('telegram doctor check (host side)', () => {
  const envelope = (data: unknown) => ok(JSON.stringify({ ok: true, data }));
  it('maps an available report to ok', () => {
    const c = telegramDoctorCheck(envelope(evaluateTelegram(facts())));
    expect(c.status).toBe('ok');
    expect(c.detail).toMatch(/installed and launchable/);
  });
  it('maps unavailable/blocked/not-installed to unavailable (never fail) with the first hint', () => {
    const c = telegramDoctorCheck(envelope(evaluateTelegram(facts({ bun: err(127, '') }))));
    expect(c).toMatchObject({ status: 'unavailable', hint: expect.stringMatching(/Bun/) });
    const b = telegramDoctorCheck(envelope(evaluateTelegram(facts({ managed: { present: true, json: {} } }))));
    expect(b.status).toBe('unavailable');
    expect(b.hint).toMatch(/admin/);
  });
  it('warns when the probe command fails or prints garbage (e.g. an outdated image)', () => {
    expect(telegramDoctorCheck(err(1, "error: unknown command 'telegram'"))).toMatchObject({ status: 'warn', detail: expect.stringMatching(/unknown command/) });
    expect(telegramDoctorCheck(ok('hello')).status).toBe('warn');
    expect(telegramDoctorCheck(ok(JSON.stringify({ ok: false, error: {} }))).status).toBe('warn');
  });
  it('redacts token-shaped strings from probe output', () => {
    const c = telegramDoctorCheck(err(1, 'bad 123456789:AAHfiqksKZ8aaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    expect(c.detail).not.toMatch(/AAHfiqks/);
  });
});

describe('telegram capability probe: robustness', () => {
  it('bounds every external command with a timeout and tolerates failure', async () => {
    const seen: Array<{ cmd: string; timeoutMs?: number; allowFailure?: boolean }> = [];
    const runner = async (cmd: string, _a: string[], o?: { timeoutMs?: number; allowFailure?: boolean }) => {
      seen.push({ cmd, ...(o ?? {}) });
      return ok('[]');
    };
    await gatherTelegramFacts({ runner, readText: async () => '{}' });
    expect(seen).toHaveLength(4);
    for (const s of seen) {
      expect(s.allowFailure).toBe(true);
      expect(s.timeoutMs).toBeGreaterThan(0);
      expect(s.timeoutMs).toBeLessThanOrEqual(60_000);
    }
  });

  it('treats timed-out commands (code 124) as failures without throwing', () => {
    const timedOut: RunResult = { code: 124, stdout: '', stderr: '', timedOut: true };
    const r = evaluateTelegram(facts({ claude: timedOut, bun: timedOut, plugins: timedOut, marketplaces: timedOut }));
    expect(r.availability).toBe('unavailable');
    expect(item(r, 'plugin').status).toBe('unknown');
  });

  it('handles empty, null and non-object JSON from the plugin CLI and managed settings', () => {
    for (const out of ['', 'null', '"x"', '42']) {
      const r = evaluateTelegram(facts({ plugins: ok(out), marketplaces: ok(out) }));
      expect(r.availability).toBe('not-installed');
    }
    for (const json of [null, [], 'str', 7]) {
      const r = evaluateTelegram(facts({ managed: { present: true, json } }));
      expect(r.availability).toBe('blocked');
    }
    expect(evaluateTelegram(facts({ claude: ok('') })).claudeVersion).toBeNull();
  });

  it('runs against genuinely missing binaries without throwing (real runner)', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent-minions-test';
    try {
      const r = await probeTelegram({ readText: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
      expect(r.availability).toBe('unavailable');
      expect(r.available).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('doctor check warns, never fails, for timeout or non-JSON from the container', () => {
    expect(telegramDoctorCheck({ code: 124, stdout: '', stderr: '', timedOut: true }).status).toBe('warn');
    expect(telegramDoctorCheck(ok('')).status).toBe('warn');
    expect(telegramDoctorCheck(ok('{')).status).toBe('warn');
    expect(telegramDoctorCheck(ok(JSON.stringify({ ok: true, data: { availability: 1 } }))).status).toBe('warn');
  });
});
