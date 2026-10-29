// scripts/dev/channel-spike/server.mjs (task-2, phase 0 of docs/design/telegram-channel.md): the dependency-free stdio
// channel server for the live spike. Driven as a subprocess with newline-delimited JSON-RPC, like Claude Code does.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SERVER = join(import.meta.dirname, '..', 'scripts', 'dev', 'channel-spike', 'server.mjs');

interface Msg { jsonrpc: string; id?: number | null; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

let dir: string;
let child: ChildProcessWithoutNullStreams | null = null;

afterEach(async () => {
  // Wait for the exit: the server may still be appending to its log, which would race the directory removal.
  if (child && child.exitCode === null && child.signalCode === null) {
    const c = child;
    await new Promise<void>((resolve) => { c.once('exit', () => resolve()); c.kill(); });
  }
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function start(env: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'channel-spike-'));
  const logPath = join(dir, 'spike.log');
  const p = spawn(process.execPath, [SERVER], { env: { ...process.env, SPIKE_LOG: logPath, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child = p;
  const got: Msg[] = [];
  const waiters: Array<() => void> = [];
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c: string) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      got.push(JSON.parse(buf.slice(0, nl)) as Msg);
      buf = buf.slice(nl + 1);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const sendMsg = (m: object) => p.stdin.write(JSON.stringify(m) + '\n');
  const waitFor = (pred: (m: Msg) => boolean, ms = 5000) => new Promise<Msg>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(got)}`)), ms);
    const check = () => {
      const hit = got.find(pred);
      if (hit) { clearTimeout(deadline); resolve(hit); } else waiters.push(check);
    };
    check();
  });
  const logLines = () => readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
  return { got, sendMsg, waitFor, logLines };
}

async function handshake(s: ReturnType<typeof start>) {
  s.sendMsg({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  const init = await s.waitFor((m) => m.id === 1);
  s.sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return init;
}

describe('channel spike server', () => {
  it('declares experimental claude/channel and echoes the protocol version', async () => {
    const s = start({ SPIKE_INTERVAL_MS: '0' });
    const init = await handshake(s);
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities.experimental).toEqual({ 'claude/channel': {} });
    expect(init.result.capabilities.tools).toEqual({});
    expect(init.result.serverInfo.name).toBe('spike');
  });

  it('sends no channel notification before initialized, then one start notification', async () => {
    const s = start({ SPIKE_INTERVAL_MS: '0' });
    s.sendMsg({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    await s.waitFor((m) => m.id === 1);
    s.sendMsg({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await s.waitFor((m) => m.id === 2);
    expect(s.got.filter((m) => m.method === 'notifications/claude/channel')).toEqual([]);
    s.sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const n = await s.waitFor((m) => m.method === 'notifications/claude/channel');
    expect(n.params.meta).toMatchObject({ kind: 'start', seq: '1' });
    expect(typeof n.params.content).toBe('string');
    for (const v of Object.values(n.params.meta)) expect(typeof v).toBe('string');
  });

  it('emits timer notifications and stops after SPIKE_MAX_TICKS', async () => {
    const s = start({ SPIKE_INTERVAL_MS: '30', SPIKE_MAX_TICKS: '2' });
    await handshake(s);
    await s.waitFor((m) => m.method === 'notifications/claude/channel' && m.params.meta.seq === '3');
    await new Promise((r) => setTimeout(r, 150));
    const kinds = s.got.filter((m) => m.method === 'notifications/claude/channel').map((m) => `${m.params.meta.kind}:${m.params.meta.seq}`);
    expect(kinds).toEqual(['start:1', 'tick:2', 'tick:3']);
    expect(s.logLines().some((l) => l.event === 'timer-stopped' && l.ticks === 2)).toBe(true);
  });

  it('lists spike_ack and logs tool calls to the log file', async () => {
    const s = start({ SPIKE_INTERVAL_MS: '0' });
    await handshake(s);
    s.sendMsg({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const list = await s.waitFor((m) => m.id === 3);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['spike_ack']);
    s.sendMsg({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spike_ack', arguments: { seq: '1', note: 'hello' } } });
    const call = await s.waitFor((m) => m.id === 4);
    expect(call.result.content[0].text).toBe('ack recorded for seq 1');
    const logged = s.logLines().find((l) => l.event === 'tool-call');
    expect(logged).toMatchObject({ name: 'spike_ack', arguments: { seq: '1', note: 'hello' } });
    expect(s.logLines().some((l) => l.event === 'notify' && l.meta.kind === 'start')).toBe(true);
  });

  it('exits 0 when stdin closes, with the timer running, after flushing its output', async () => {
    const s = start({ SPIKE_INTERVAL_MS: '60000' });
    await handshake(s);
    const c = child!;
    const code = await new Promise<number | null>((resolve) => { c.once('exit', (n) => resolve(n)); c.stdin.end(); });
    expect(code).toBe(0);
    expect(s.got.some((m) => m.method === 'notifications/claude/channel' && m.params.meta.kind === 'start')).toBe(true);
    expect(s.logLines().at(-1)?.event).toBe('stdin-closed');
  });

  it('answers unknown methods and tools with JSON-RPC errors and survives bad JSON', async () => {
    const s = start({ SPIKE_INTERVAL_MS: '0' });
    await handshake(s);
    s.sendMsg({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    expect((await s.waitFor((m) => m.id === 5)).error?.code).toBe(-32601);
    s.sendMsg({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    expect((await s.waitFor((m) => m.id === 6)).error?.code).toBe(-32602);
    child!.stdin.write('not json\n');
    await s.waitFor((m) => m.error?.code === -32700);
    s.sendMsg({ jsonrpc: '2.0', id: 7, method: 'ping' });
    expect((await s.waitFor((m) => m.id === 7)).result).toEqual({});
  });
});
