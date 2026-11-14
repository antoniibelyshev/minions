// The Telegram channel report (`minions telegram probe`; src/telegram/channel/launch.ts hostChannelServerProbe builds it
// for the minions channel server in both runtimes) and the host doctor's reading of it. Credential-free.
import type { RunResult } from '../core/exec.js';
import { redact } from '../core/output.js';

export type ProbeItemStatus = 'ok' | 'missing' | 'blocked' | 'unknown';
export interface ProbeItem { name: string; status: ProbeItemStatus; detail: string; hint?: string }
/** available: every credential-free precondition holds. Anything else names the first blocking reason. */
export type TelegramAvailability = 'available' | 'blocked' | 'unavailable' | 'not-installed';
export interface TelegramProbeReport {
  availability: TelegramAvailability;
  available: boolean;
  summary: string;
  channelSpec: string;
  claudeVersion: string | null;
  items: ProbeItem[];
  /** Preconditions this probe cannot verify without credentials or a live session. */
  unverified: string[];
}

const short = (s: string) => redact(s.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '').slice(0, 300);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function formatTelegramProbe(r: TelegramProbeReport): string {
  const L = [r.summary, ...r.items.map((i) => `  [${i.status.padEnd(7)}] ${i.name}: ${i.detail}${i.hint ? `\n             hint: ${i.hint}` : ''}`)];
  L.push('  not verified without credentials:', ...r.unverified.map((u) => `    - ${u}`));
  return L.join('\n');
}

/** Host doctor: maps the in-container `minions telegram probe --json` result to a doctor check. Never 'fail': terminal mode must stay usable. */
export function telegramDoctorCheck(r: RunResult): { status: 'ok' | 'warn' | 'unavailable'; detail: string; hint?: string } {
  if (r.code !== 0) {
    return { status: 'warn', detail: `telegram probe failed (exit ${r.code}): ${short(r.stderr || r.stdout) || 'no output'}`, hint: '`minions start` rebuilds an outdated image.' };
  }
  let report: TelegramProbeReport | undefined;
  try {
    const env = JSON.parse(r.stdout) as unknown;
    const data = isObj(env) && env.ok === true ? env.data : undefined;
    if (isObj(data) && typeof data.availability === 'string' && typeof data.summary === 'string' && Array.isArray(data.items)) report = data as unknown as TelegramProbeReport;
  } catch { /* handled below */ }
  if (!report) return { status: 'warn', detail: `telegram probe returned unexpected output: ${short(r.stdout) || 'no output'}` };
  if (report.available) return { status: 'ok', detail: redact(report.summary) };
  const reason = report.items.find((i) => i.status === 'blocked') ?? report.items.find((i) => i.status === 'missing') ?? report.items.find((i) => i.status === 'unknown');
  return { status: 'unavailable', detail: redact(report.summary), ...(reason?.hint ? { hint: redact(reason.hint) } : {}) };
}
