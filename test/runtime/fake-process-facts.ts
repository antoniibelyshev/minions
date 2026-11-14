// A ProcessFacts for the unit tier on macOS (task-137.2.5). On darwin the coordinator lock, the supervisor lock and
// the run records read process liveness through `ps`/`sysctl` (systemProcessFacts, src/runtime/process-facts.ts),
// which the unit tier refuses; on Linux they read /proc, which needs no subprocess. A test file opts in with
//
//   vi.mock('../../src/runtime/process-facts.js', async (orig) => (await import('./fake-process-facts.js')).mockProcessFacts(await orig()));
//
// The fake knows exactly one process, the test process itself (fixed start time and command line, so a lock it
// takes reads back as held by a live owner); any other pid reads as gone. Off darwin systemProcessFacts still
// returns null, so the Linux /proc path is untouched. Production code is unchanged.
import type * as Facts from '../../src/runtime/process-facts.js';
import type { ProcessFact, ProcessFacts } from '../../src/runtime/process-facts.js';

const self: ProcessFact = {
  pid: process.pid, ppid: process.ppid, pgid: process.pid, state: 'S',
  startTime: String(Math.floor(Date.now() / 1000 - process.uptime())), cmdline: process.argv.join(' '),
};

export const fakeProcessFacts: ProcessFacts = {
  process: (pid) => (pid === process.pid ? { ...self } : null),
  list: () => [{ ...self }],
  bootId: () => 'fake-boot-id',
};

/** The vi.mock factory body for src/runtime/process-facts.js. */
export function mockProcessFacts(orig: typeof Facts): typeof Facts {
  return { ...orig, systemProcessFacts: (platform: NodeJS.Platform = process.platform) => (platform === 'darwin' ? fakeProcessFacts : null) };
}
