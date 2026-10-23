// `harness.*` checks of `minions status --check` / `doctor` (docs/design/agent-runtimes.md D7). One
// `harness.<id>` check per configured process harness (binary, pinned version, L1 self-test) and one
// `harness.network` warning per loopback listener on an allowed TCP connect port. Nothing is reported
// when no process harness is configured, so Claude-only projects see no change.
import type { RunResult } from '../core/exec.js';
import { redact } from '../core/output.js';
import type { HarnessView, WorkProbeReport } from '../runtime/sandbox/probe.js';
import { summarizeSandbox } from '../runtime/sandbox/selftest.js';
import type { Check } from './doctor.js';

const PROBE_HINT = 'Run `minions start` to rebuild the image (it builds minions-sandbox), then `minions status --check` again.';

/** `minions work probe --json` output from the container; an error string when it is unusable (e.g. an older image). */
export function parseWorkProbe(r: RunResult): WorkProbeReport | { error: string } {
  const why = () => redact((r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? '').slice(0, 300);
  if (r.code !== 0) {
    try {
      const env = JSON.parse(r.stdout) as { ok?: boolean; error?: { message?: string } };
      if (env.ok === false && env.error?.message) return { error: `probe failed: ${redact(env.error.message).slice(0, 300)}` };
    } catch { /* not JSON */ }
    return { error: `probe failed (exit ${r.code})${why() ? `: ${why()}` : ''}` };
  }
  try {
    const env = JSON.parse(r.stdout) as { ok?: boolean; data?: WorkProbeReport };
    const d = env.ok ? env.data : undefined;
    if (d && Array.isArray(d.harnesses) && Array.isArray(d.listeners) && Array.isArray(d.tcpConnectPorts)) return d;
  } catch { /* fall through */ }
  return { error: 'probe printed no usable report' };
}

/** The checks for a running container, from the probe report. */
export function harnessChecks(view: HarnessView, probe: WorkProbeReport | { error: string }): Check[] {
  if (!view.processHarnesses.length) return [];
  if ('error' in probe) return view.processHarnesses.map((id) => ({ name: `harness.${id}`, status: 'fail', detail: probe.error, hint: PROBE_HINT }));
  const checks: Check[] = [];
  const sandbox = probe.sandbox;
  const isolation = sandbox ? `isolation ${summarizeSandbox(sandbox)}` : 'isolation not checked';
  for (const id of view.processHarnesses) {
    const bin = probe.harnesses.find((h) => h.id === id);
    const parts = [bin ? bin.detail : 'not probed', isolation];
    if (!bin || !bin.ok) {
      checks.push({ name: `harness.${id}`, status: 'fail', detail: parts.join('; '), hint: bin?.found ? 'Rebuild the image with the pinned harness version (`minions start`).' : 'The image has no such harness; `minions start` rebuilds it with the configured harnesses.' });
    } else if (!sandbox || sandbox.state !== 'ok') {
      checks.push({ name: `harness.${id}`, status: 'fail', detail: `${parts.join('; ')}; every launch is refused (process isolation unavailable)`,
        hint: sandbox?.state === 'unavailable' && sandbox.abi !== null ? 'Process harnesses need Linux 6.12 or newer with Landlock enabled (Docker Desktop, Debian 13, recent Ubuntu HWE kernels).' : PROBE_HINT });
    } else if (!bin.pinned) {
      checks.push({ name: `harness.${id}`, status: 'warn', detail: parts.join('; '), hint: 'The image should pin the harness version; rebuild it with `minions start`.' });
    } else {
      checks.push({ name: `harness.${id}`, status: 'ok', detail: parts.join('; ') });
    }
  }
  for (const l of probe.listeners) {
    checks.push({ name: 'harness.network', status: 'warn',
      detail: `${l.address}:${l.port} listens on an allowed TCP connect port, so every process worker can connect to it`,
      hint: 'Stop that listener, or remove the port from harnesses.network.tcpConnectPorts.' });
  }
  return checks;
}

/** When the probe cannot run: host runtime (D9: container only), container down, or Docker unavailable. */
export function harnessSkipChecks(view: HarnessView, why: 'host-runtime' | 'not-running' | 'no-docker'): Check[] {
  return view.processHarnesses.map((id): Check => why === 'host-runtime'
    ? { name: `harness.${id}`, status: 'fail', detail: 'process harnesses run only in the Docker runtime (the host runtime refuses them)', hint: 'Switch with `minions runtime set docker`, or set the roles back to the claude harness.' }
    : { name: `harness.${id}`, status: 'warn', detail: why === 'not-running' ? 'skipped: container not running' : 'skipped: Docker unavailable' });
}
