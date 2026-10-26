// task-14.3: the credential-free process-harness probe (docs/design/agent-runtimes.md D7): harness binaries
// and pinned versions, loopback listeners on allowed connect ports, the config view, and `work probe`.
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { buildProgram } from '../../src/program.js';
import {
  PROCESS_HARNESSES, formatWorkProbe, harnessView, listenersOnAllowedPorts, loopbackListeners, parseProcNetTcp, probeHarnessBinary, workProbe,
} from '../../src/runtime/sandbox/probe.js';
import { FIXED_CANARIES } from '../../src/runtime/sandbox/selftest.js';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const TCP4 = [HEADER,
  '   0: 0100007F:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0',  // 127.0.0.1:443 LISTEN
  '   1: 0B00007F:9143 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 100 0 0 10 0',  // 127.0.0.11:37187 (Docker DNS)
  '   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 100 0 0 10 0',  // 0.0.0.0:8080
  '   3: 0500000A:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4 1 0000000000000000 100 0 0 10 0',  // 10.0.0.5:443 (not loopback)
  '   4: 0100007F:C350 0100007F:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 5 1 0000000000000000 100 0 0 10 0',  // ESTABLISHED
].join('\n');
const TCP6 = [HEADER,
  '   0: 00000000000000000000000001000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 6 1',   // [::1]:443
  '   1: 00000000000000000000000000000000:20FB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 7 1',   // [::]:8443
  '   2: 0000000000000000FFFF00000100007F:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 8 1',   // ::ffff:127.0.0.1:80
  '   3: 0000B80D000000000000000001000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 9 1',   // 2001:db8 global
].join('\n');

describe('loopback listeners (/proc/net/tcp{,6})', () => {
  it('finds LISTEN sockets on loopback or wildcard addresses only', () => {
    expect(parseProcNetTcp(TCP4, 4)).toEqual([
      { address: '127.0.0.1', port: 443, family: 4 },
      { address: '127.0.0.11', port: 37187, family: 4 },
      { address: '0.0.0.0', port: 8080, family: 4 },
    ]);
    expect(parseProcNetTcp(TCP6, 6)).toEqual([
      { address: '::1', port: 443, family: 6 },
      { address: '::', port: 8443, family: 6 },
      { address: '::ffff:127.0.0.1', port: 80, family: 6 },
    ]);
    expect(parseProcNetTcp('garbage\nnot a row', 4)).toEqual([]);
  });

  it('keeps only listeners on allowed connect ports (each is a status --check warning)', async () => {
    const proc = await mkdtemp(join(tmpdir(), 'probe-proc-'));
    await mkdir(join(proc, 'net'));
    await writeFile(join(proc, 'net', 'tcp'), TCP4);
    await writeFile(join(proc, 'net', 'tcp6'), TCP6);
    const all = await loopbackListeners(proc);
    expect(listenersOnAllowedPorts(all, [443]).map((l) => `${l.address}:${l.port}`)).toEqual(['127.0.0.1:443', '::1:443']);
    expect(listenersOnAllowedPorts(all, [8443, 9999]).map((l) => l.port)).toEqual([8443]);
    expect(await loopbackListeners(join(proc, 'missing'))).toEqual([]);
  });
});

describe('harnessView (loose read until task-14.2 adds the schema)', () => {
  it('lists the process harnesses a config assigns and the connect ports', () => {
    expect(harnessView({})).toEqual({ processHarnesses: [], tcpConnectPorts: [443] });
    expect(harnessView(undefined)).toEqual({ processHarnesses: [], tcpConnectPorts: [443] });
    expect(harnessView({ harnesses: { default: 'claude' }, roles: { engineer: { harness: 'claude' } } }).processHarnesses).toEqual([]);
    expect(harnessView({ harnesses: { default: 'codex', network: { tcpConnectPorts: [443, 8443] } }, roles: { 'codex-reviewer': { harness: 'codex' }, tester: { harness: 'junie' }, x: {} } }))
      .toEqual({ processHarnesses: ['codex', 'junie'], tcpConnectPorts: [443, 8443] });
    for (const bad of [[], [0], ['443'], [1.5], 'x']) {
      expect(harnessView({ harnesses: { network: { tcpConnectPorts: bad } } }).tcpConnectPorts).toEqual([443]);
    }
  });
});

const exec = (answers: Record<string, RunResult>) => async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> =>
  answers[[cmd, ...args].join(' ')] ?? { code: 127, stdout: '', stderr: `${cmd}: not found` };

describe('probeHarnessBinary', () => {
  const env = { MINIONS_CODEX_VERSION: '0.130.0' };

  it('ok when the binary is on PATH and its version equals the image pin', async () => {
    const r = await probeHarnessBinary('codex', { env, exec: exec({ 'codex --version': { code: 0, stdout: 'codex-cli 0.130.0\n', stderr: '' } }) });
    expect(r).toEqual({ id: 'codex', found: true, version: '0.130.0', pinned: '0.130.0', ok: true, detail: 'codex 0.130.0 (pinned)' });
  });

  it('not ok when missing, failing, version-less or not the pinned version; a missing pin is reported', async () => {
    expect(await probeHarnessBinary('codex', { env, exec: exec({}) })).toMatchObject({ found: false, ok: false, detail: 'codex not found on PATH' });
    expect(await probeHarnessBinary('codex', { env, exec: exec({ 'codex --version': { code: 2, stdout: '', stderr: 'boom\n' } }) }))
      .toMatchObject({ found: true, ok: false, detail: '`codex --version` failed (exit 2: boom)' });
    expect(await probeHarnessBinary('codex', { env, exec: exec({ 'codex --version': { code: 0, stdout: 'codex\n', stderr: '' } }) }))
      .toMatchObject({ ok: false, detail: '`codex --version` printed no version' });
    expect(await probeHarnessBinary('codex', { env, exec: exec({ 'codex --version': { code: 0, stdout: 'codex-cli 0.131.2\n', stderr: '' } }) }))
      .toMatchObject({ ok: false, version: '0.131.2', detail: 'codex 0.131.2, but the image pins 0.130.0' });
    expect(await probeHarnessBinary('junie', { env: {}, exec: exec({ 'junie --version': { code: 0, stdout: 'Junie 1.2.3-eap\n', stderr: '' } }) }))
      .toMatchObject({ ok: true, version: '1.2.3-eap', pinned: null, detail: 'junie 1.2.3-eap (no pinned version in this image)' });
    expect(await probeHarnessBinary('fake', { exec: exec({}) })).toMatchObject({ ok: false, detail: 'unknown process harness "fake"' });
    expect(Object.keys(PROCESS_HARNESSES)).toEqual(['codex', 'junie']);
  });
});

describe('workProbe (what `minions work probe` reports)', () => {
  async function helper(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'probe-helper-'));
    const bin = join(dir, 'minions-sandbox');
    await writeFile(bin, `#!${process.execPath}
const rules = JSON.parse(require('fs').readFileSync(process.argv[3], 'utf8'));
const names = [...${JSON.stringify(FIXED_CANARIES)}, ...rules.selfTest.denyWrite.map((p) => 'fs.write:' + p), ...rules.selfTest.denyRead.map((p) => 'fs.read:' + p), 'fd.inherited:3'];
console.log(['minions-sandbox-selftest\\t1', 'version\\t1.0.0', 'arch\\taarch64', 'abi\\t8',
  ...names.map((n) => 'check\\t' + n + '\\t' + (n.startsWith('abi.') ? 'skip' : 'pass') + '\\tok'), 'result\\tok\\tall'].join('\\n'));
`);
    await chmod(bin, 0o755);
    return bin;
  }

  it('combines the self-test, the configured harnesses and the listeners; no harness configured: binaries are not probed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'probe-work-'));
    const proc = join(root, 'proc');
    await mkdir(join(proc, 'net'), { recursive: true });
    await writeFile(join(proc, 'net', 'tcp'), TCP4);
    const bin = await helper();
    const calls: string[] = [];
    const ex = async (cmd: string, args: string[], o?: RunOptions): Promise<RunResult> => {
      calls.push(cmd);
      if (cmd === 'codex') return { code: 0, stdout: 'codex-cli 0.130.0\n', stderr: '' };
      const { run } = await import('../../src/core/exec.js');
      return run(cmd, args, o);
    };
    const base = { cacheFile: join(root, 'state', 'run', 'sandbox-probe.json'), scratchRoot: join(root, 'scratch'), protectedPaths: [], real: { read: [], write: [] }, bin, exec: ex, proc, env: {} };
    const r = await workProbe({ ...base, config: { harnesses: { default: 'codex' } } });
    expect(r.sandbox).toMatchObject({ state: 'ok', cached: false });
    expect(r.harnesses).toEqual([expect.objectContaining({ id: 'codex', ok: true, version: '0.130.0', pinned: null })]);
    expect(r.tcpConnectPorts).toEqual([443]);
    expect(r.listeners).toEqual([{ address: '127.0.0.1', port: 443, family: 4 }]);
    expect(formatWorkProbe(r)).toContain('warning: 127.0.0.1:443 listens on an allowed connect port');
    calls.length = 0;
    const none = await workProbe({ ...base, config: {} });
    expect(none.harnesses).toEqual([]);
    expect(calls).not.toContain('codex');
  });
});

describe('CLI surface', () => {
  it('`minions work probe` is an internal work subcommand with --refresh', () => {
    const work = buildProgram().commands.find((c) => c.name() === 'work')!;
    const probe = work.commands.find((c) => c.name() === 'probe');
    expect(probe?.description()).toMatch(/no credentials/);
    expect(probe?.options.map((o) => o.long)).toEqual(['--refresh']);
  });
});

describe('the runtime image pins the Codex CLI (task-14.15)', () => {
  const repo = join(import.meta.dirname, '..', '..');
  it('installs @openai/codex at the pinned version next to Claude Code and exposes the pin as the probe env', async () => {
    const dockerfile = await readFile(join(repo, 'docker', 'Dockerfile'), 'utf8');
    const pin = /^ARG CODEX_VERSION=(\d+\.\d+\.\d+)$/m.exec(dockerfile)?.[1];
    expect(pin).toBe('0.164.0');
    // One `npm install -g` step installs Claude Code and Codex together.
    const npmStep = /RUN npm install -g [^\n]*\\\n([^\n]*)\n/.exec(dockerfile)?.[1] ?? '';
    expect(npmStep).toContain('"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
    expect(npmStep).toContain('"@openai/codex@${CODEX_VERSION}"');
    // The final stage carries the pin as the env var `work probe` compares `codex --version` against.
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    expect(finalStage).toContain('ARG CODEX_VERSION=');
    expect(finalStage).toMatch(new RegExp(`^\\s+${PROCESS_HARNESSES.codex!.pinEnv}=\\$\\{CODEX_VERSION\\} \\\\$`, 'm'));
    const compat = await readFile(join(repo, 'docs', 'compatibility.md'), 'utf8');
    expect(compat).toContain(`\`@openai/codex@${pin}\``);
  });
});
