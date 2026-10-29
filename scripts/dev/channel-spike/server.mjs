#!/usr/bin/env node
// Phase 0 spike channel server (docs/design/telegram-channel.md, task-2). A trivial, dependency-free stdio MCP server
// that declares the experimental `claude/channel` capability. After the client's `notifications/initialized` it sends
// one `notifications/claude/channel` (kind=start), then one more every SPIKE_INTERVAL_MS (kind=tick). It offers one tool,
// `spike_ack`, and logs every received message, every sent notification and every tool call to SPIKE_LOG.
//
// Dev tool only: never shipped (package.json "files" leaves scripts/ out) and not in any launch path. See README.md.
//
// Environment:
//   SPIKE_LOG          log file (JSON lines, appended). Default: $TMPDIR/channel-spike.log
//   SPIKE_INTERVAL_MS  timer period in ms. Default 30000. 0 disables the timer (start notification only).
//   SPIKE_MAX_TICKS    stop the timer after this many ticks. Default 20.
// stdout carries JSON-RPC only (one message per line). Nothing else is ever written to stdout.
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER_NAME = 'spike';
const PROTOCOL_VERSION = '2025-06-18';
const LOG = process.env.SPIKE_LOG || join(tmpdir(), 'channel-spike.log');
const INTERVAL_MS = intEnv('SPIKE_INTERVAL_MS', 30000);
const MAX_TICKS = intEnv('SPIKE_MAX_TICKS', 20);

function intEnv(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : dflt;
}

function log(event, data = {}) {
  try { appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data }) + '\n'); } catch { /* logging must never break the server */ }
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

let seq = 0;
function channel(kind, content) {
  seq += 1;
  const params = { content, meta: { kind, seq: String(seq), sent_at: new Date().toISOString() } };
  send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params });
  log('notify', params);
}

let started = false;
let timer = null;
function startChannel() {
  if (started) return;
  started = true;
  channel('start', 'Channel spike: start notification. If you can read this, the development channel delivers notifications. Call the spike_ack tool with seq=1.');
  if (INTERVAL_MS > 0) {
    let ticks = 0;
    timer = setInterval(() => {
      ticks += 1;
      channel('tick', `Channel spike: timer notification ${ticks}. Call the spike_ack tool with this seq.`);
      if (ticks >= MAX_TICKS) { clearInterval(timer); timer = null; log('timer-stopped', { ticks }); }
    }, INTERVAL_MS);
  }
}

const TOOLS = [{
  name: 'spike_ack',
  description: 'Acknowledge a channel spike notification. Pass the seq from its meta and any note.',
  inputSchema: { type: 'object', properties: { seq: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false },
}];

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  const ok = (result) => send({ jsonrpc: '2.0', id, result });
  const err = (code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  switch (method) {
    case 'initialize': {
      const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      log('initialize', { protocolVersion: asked, clientInfo: params?.clientInfo ?? null, clientCapabilities: params?.capabilities ?? null });
      return ok({
        protocolVersion: asked,
        capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
        serverInfo: { name: SERVER_NAME, version: '0.0.1' },
        instructions: 'Spike channel server. Messages arrive as <channel source="spike" ...>. Answer each by calling the spike_ack tool with its seq.',
      });
    }
    case 'notifications/initialized':
      log('initialized');
      return startChannel();
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      log('tool-call', { name, arguments: args });
      if (name !== 'spike_ack') return err(-32602, `unknown tool: ${String(name)}`);
      return ok({ content: [{ type: 'text', text: `ack recorded for seq ${String(args.seq ?? '?')}` }] });
    }
    default:
      if (isRequest) return err(-32601, `method not found: ${String(method)}`);
      return undefined; // other notifications (cancelled, roots changed, ...) need no answer
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('parse-error', { line: line.slice(0, 200) }); send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    log('recv', { method: msg.method ?? null, id: msg.id ?? null });
    try { handle(msg); } catch (e) {
      log('error', { message: String(e?.message ?? e) });
      if (msg.id !== undefined && msg.id !== null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'internal error' } });
    }
  }
});
// No process.exit here: stdout to a pipe is asynchronous on macOS, so let pending writes drain and exit naturally.
process.stdin.on('end', () => { log('stdin-closed'); if (timer) clearInterval(timer); timer = null; });
process.on('SIGTERM', () => { log('sigterm'); process.exit(0); });

log('spawned', { argv: process.argv.slice(2), cwd: process.cwd(), intervalMs: INTERVAL_MS, maxTicks: MAX_TICKS, node: process.version });
