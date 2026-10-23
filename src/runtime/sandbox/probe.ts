// Credential-free capability probe for process harnesses (docs/design/agent-runtimes.md D7), run inside
// the container by `minions work probe` and reported by `minions status --check` / `doctor` as `harness.*`.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../../core/exec.js';
import { redact } from '../../core/output.js';
import { DEFAULT_TCP_CONNECT_PORTS, SANDBOX_BIN } from './rules.js';
import { cachedSandboxSelfTest, probeIdentity, runSandboxSelfTest, type Exec, type RealTargets, type SelfTestReport } from './selftest.js';

/** How to find and pin each known process harness. The pinned version is an image build argument (D8), exposed as ENV. */
export interface HarnessBinarySpec { id: string; bin: string; pinEnv: string }
export const PROCESS_HARNESSES: Readonly<Record<string, HarnessBinarySpec>> = {
  codex: { id: 'codex', bin: 'codex', pinEnv: 'MINIONS_CODEX_VERSION' },
  junie: { id: 'junie', bin: 'junie', pinEnv: 'MINIONS_JUNIE_VERSION' },
};

export interface HarnessBinaryReport {
  id: string;
  found: boolean;
  version: string | null;
  pinned: string | null;
  /** Binary found, and its version equals the pin (a missing pin is reported, not failed). */
  ok: boolean;
  detail: string;
}

const VERSION_RE = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

/** `<bin> --version` (no credentials, no network). */
export async function probeHarnessBinary(id: string, opts: { exec?: Exec; env?: NodeJS.ProcessEnv } = {}): Promise<HarnessBinaryReport> {
  const spec = PROCESS_HARNESSES[id];
  if (!spec) return { id, found: false, version: null, pinned: null, ok: false, detail: `unknown process harness "${id}"` };
  const env = opts.env ?? process.env;
  const pinned = env[spec.pinEnv]?.trim() || null;
  const r = await (opts.exec ?? run)(spec.bin, ['--version'], { allowFailure: true, timeoutMs: 15_000 });
  if (r.code === 127 || r.code === 126) return { id, found: false, version: null, pinned, ok: false, detail: `${spec.bin} not found on PATH` };
  if (r.code !== 0) {
    const why = redact((r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? '').slice(0, 200);
    return { id, found: true, version: null, pinned, ok: false, detail: `\`${spec.bin} --version\` failed (exit ${r.code}${why ? `: ${why}` : ''})` };
  }
  const version = VERSION_RE.exec(r.stdout)?.[1] ?? null;
  if (!version) return { id, found: true, version: null, pinned, ok: false, detail: `\`${spec.bin} --version\` printed no version` };
  if (pinned && pinned !== version) return { id, found: true, version, pinned, ok: false, detail: `${spec.bin} ${version}, but the image pins ${pinned}` };
  return { id, found: true, version, pinned, ok: true, detail: pinned ? `${spec.bin} ${version} (pinned)` : `${spec.bin} ${version} (no pinned version in this image)` };
}

export interface TcpListener { address: string; port: number; family: 4 | 6 }

const hexPort = (h: string) => parseInt(h, 16);

/** IPv4 in /proc/net/tcp is one little-endian 32-bit word (on the little-endian hosts we support). */
function ipv4(hex: string): string {
  const b = hex.match(/../g)!.map((x) => parseInt(x, 16)).reverse();
  return b.join('.');
}

/** IPv6 in /proc/net/tcp6 is four little-endian 32-bit words. Only the forms we classify are rendered. */
function ipv6(hex: string): string {
  const words = hex.match(/.{8}/g)!.map((w) => w.match(/../g)!.reverse().join(''));
  const full = words.join('');
  if (/^0{32}$/.test(full)) return '::';
  if (full === '0'.repeat(31) + '1') return '::1';
  if (full.startsWith('0'.repeat(20) + 'ffff')) return `::ffff:${ipv4(full.slice(24).match(/../g)!.reverse().join(''))}`;
  return full.match(/.{4}/g)!.join(':');
}

/**
 * Listening sockets reachable over loopback: bound to 127.0.0.0/8, ::1, ::ffff:127.x, or a wildcard
 * address (a wildcard listener accepts loopback connections too). `st` 0A is TCP_LISTEN.
 */
export function parseProcNetTcp(text: string, family: 4 | 6): TcpListener[] {
  const out: TcpListener[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[3] !== '0A') continue;
    const [addrHex, portHex] = (f[1] ?? '').split(':');
    if (!addrHex || !portHex) continue;
    if (family === 4 && addrHex.length !== 8) continue;
    if (family === 6 && addrHex.length !== 32) continue;
    const address = family === 4 ? ipv4(addrHex) : ipv6(addrHex.toLowerCase());
    const loopbackOrAny = family === 4
      ? address.startsWith('127.') || address === '0.0.0.0'
      : address === '::1' || address === '::' || address.startsWith('::ffff:127.') || address === '::ffff:0.0.0.0';
    if (loopbackOrAny) out.push({ address, port: hexPort(portHex), family });
  }
  return out;
}

export async function loopbackListeners(proc = '/proc'): Promise<TcpListener[]> {
  const read = (f: string) => readFile(join(proc, 'net', f), 'utf8').catch(() => '');
  return [...parseProcNetTcp(await read('tcp'), 4), ...parseProcNetTcp(await read('tcp6'), 6)];
}

/** D4 "Landlock network": a listener on an allowed connect port is reachable from every process worker. */
export const listenersOnAllowedPorts = (listeners: readonly TcpListener[], ports: readonly number[]) =>
  listeners.filter((l) => ports.includes(l.port));

/**
 * The process harnesses a config uses and the TCP connect allowlist. Read loosely on purpose: the
 * `harnesses` schema and `roles.<r>.harness` land in task-14.2; until then a config simply has none.
 */
export interface HarnessView { processHarnesses: string[]; tcpConnectPorts: number[] }

export function harnessView(config: unknown): HarnessView {
  const c = (config ?? {}) as { harnesses?: { default?: unknown; network?: { tcpConnectPorts?: unknown } }; roles?: Record<string, { harness?: unknown } | undefined> };
  const ids = new Set<string>();
  const add = (h: unknown) => { if (typeof h === 'string' && h && h !== 'claude') ids.add(h); };
  add(c.harnesses?.default);
  for (const role of Object.values(c.roles ?? {})) add(role?.harness);
  const ports = c.harnesses?.network?.tcpConnectPorts;
  const valid = Array.isArray(ports) && ports.length > 0 && ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
  return { processHarnesses: [...ids].sort(), tcpConnectPorts: valid ? [...(ports as number[])] : [...DEFAULT_TCP_CONNECT_PORTS] };
}

/** `minions work probe --json` data. */
export interface WorkProbeReport {
  harnesses: HarnessBinaryReport[];
  sandbox: (SelfTestReport & { cached?: boolean }) | null;
  tcpConnectPorts: number[];
  /** Loopback/wildcard listeners on an allowed connect port (each one is a warning). */
  listeners: TcpListener[];
}

export function formatWorkProbe(r: WorkProbeReport): string {
  return [
    `isolation: ${r.sandbox ? (r.sandbox.state === 'ok' ? r.sandbox.detail : `${r.sandbox.state}: ${r.sandbox.detail}`) : 'not checked'}${r.sandbox?.cached ? ' (cached for this container start)' : ''}`,
    ...r.harnesses.map((h) => `harness ${h.id}: ${h.ok ? 'ok' : 'not usable'} - ${h.detail}`),
    `tcp connect ports: ${r.tcpConnectPorts.join(', ')}`,
    ...r.listeners.map((l) => `warning: ${l.address}:${l.port} listens on an allowed connect port; process workers can reach it`),
  ].join('\n');
}

/**
 * The whole probe: the self-test (once per container start, cached in `cacheFile`), every configured
 * harness binary, and loopback listeners on the allowed connect ports. Sends no model request.
 */
export async function workProbe(opts: {
  config: unknown; cacheFile: string; scratchRoot: string; protectedPaths: readonly string[]; real: RealTargets;
  refresh?: boolean; bin?: string; exec?: Exec; env?: NodeJS.ProcessEnv; proc?: string;
}): Promise<WorkProbeReport> {
  const view = harnessView(opts.config);
  const bin = opts.bin ?? SANDBOX_BIN;
  const sandbox = await cachedSandboxSelfTest({
    cacheFile: opts.cacheFile,
    identity: await probeIdentity(bin, opts.proc),
    refresh: opts.refresh,
    run: () => runSandboxSelfTest({ parent: opts.scratchRoot, protectedPaths: opts.protectedPaths, tcpConnectPorts: view.tcpConnectPorts, real: opts.real, bin, exec: opts.exec }),
  });
  const harnesses = await Promise.all(view.processHarnesses.map((id) => probeHarnessBinary(id, { exec: opts.exec, env: opts.env })));
  return { harnesses, sandbox, tcpConnectPorts: view.tcpConnectPorts, listeners: listenersOnAllowedPorts(await loopbackListeners(opts.proc), view.tcpConnectPorts) };
}
