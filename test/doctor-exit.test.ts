import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';

const report = vi.hoisted(() => ({ value: { healthy: true, projectId: null, checks: [] as unknown[] } }));
vi.mock('../src/host/doctor.js', async (orig) => ({ ...(await orig<typeof import('../src/host/doctor.js')>()), runDoctor: async () => report.value }));

const { buildProgram } = await import('../src/program.js');

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const runtime = process.env.MINIONS_RUNTIME;
  delete process.env.MINIONS_RUNTIME;
  const program = buildProgram();
  let out = '';
  const cap = (c: Command) => { c.exitOverride().configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } }); c.commands.forEach(cap); };
  cap(program);
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'minions', ...args]);
    return { code: Number(process.exitCode ?? 0), out };
  } finally {
    process.stdout.write = write;
    process.exitCode = before;
    if (runtime !== undefined) process.env.MINIONS_RUNTIME = runtime;
  }
}

describe('doctor exit code', () => {
  afterEach(() => { report.value = { healthy: true, projectId: null, checks: [] }; });

  it('exits 0 when healthy (warnings do not block)', async () => {
    report.value = { healthy: true, projectId: null, checks: [{ name: 'x', status: 'warn', detail: 'd' }] };
    expect((await run(['doctor'])).code).toBe(0);
    expect((await run(['status', '--check'])).code).toBe(0);
  });

  it('exits non-zero on a blocking FAIL for doctor and status --check, still printing the report', async () => {
    report.value = { healthy: false, projectId: null, checks: [{ name: 'x', status: 'fail', detail: 'd' }] };
    for (const args of [['doctor'], ['status', '--check']]) {
      const r = await run([...args, '--json']);
      expect(r.code, args.join(' ')).toBe(1);
      expect(JSON.parse(r.out).data.healthy).toBe(false);
    }
  });
});
