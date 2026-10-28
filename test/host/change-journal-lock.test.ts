// task-80: the journal lock is created empty (O_EXCL) and its holder written right after. A contender that read the
// lock in that window took it over (no pid: "dead"), so two confirmations of one offer could both pass the spent
// check and both apply. The window is held open here on purpose (the holder's write waits on a gate), so the race is
// deterministic instead of depending on how the thread pool orders a write and a read. Temp MINIONS_HOME.
import { existsSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** While set, the first write to a freshly created journal.lock waits for it (the create-then-write window). */
let writeGate: Promise<void> | null = null;
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const open = async (...args: Parameters<typeof fs.open>) => {
    // The gate as it was when the lock file was being created (the test clears it right after).
    const gate = String(args[0]).endsWith('journal.lock') && args[1] === 'wx' ? writeGate : null;
    const h = await fs.open(...args);
    if (gate) {
      const write = h.writeFile.bind(h);
      h.writeFile = (async (...w: Parameters<typeof h.writeFile>) => { await gate; return write(...w); }) as typeof h.writeFile;
    }
    return h;
  };
  return { ...fs, default: { ...fs, open }, open };
});

const J = await import('../../src/host/change-journal.js');
const { withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => { writeGate = null; env.cleanup(); });

const lockFile = () => join(J.managerDir(), 'journal.lock');
const until = async (cond: () => boolean) => { while (!cond()) await new Promise((r) => setImmediate(r)); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('journal lock (task-80)', () => {
  it('a contender never takes a lock whose holder is still being written: the two critical sections never overlap', async () => {
    let open!: () => void;
    writeGate = new Promise((r) => { open = r; });
    let inside = 0, max = 0;
    const order: string[] = [];
    const section = (name: string) => async () => { inside++; max = Math.max(max, inside); order.push(`${name} in`); await sleep(20); order.push(`${name} out`); inside--; };
    const a = J.withJournalLock(section('a'));
    await until(() => existsSync(lockFile())); // a created the lock; its holder is not written yet
    writeGate = null; // b's own write (once it gets the lock) is not held
    const b = J.withJournalLock(section('b'), 5_000);
    await sleep(200); // b polls the empty lock several times meanwhile
    expect(order).toEqual([]);
    open();
    await Promise.all([a, b]);
    expect(max).toBe(1);
    expect(order).toEqual(['a in', 'a out', 'b in', 'b out']);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('a lock left without a holder past the grace period (its writer died) is taken over', async () => {
    mkdirSync(J.managerDir(), { recursive: true });
    writeFileSync(lockFile(), '');
    const old = new Date(Date.now() - J.LOCK_WRITE_GRACE_MS - 1_000);
    utimesSync(lockFile(), old, old);
    await expect(J.withJournalLock(async () => 'taken', 500)).resolves.toBe('taken');
  });

  it('a fresh lock without a holder is held: a short wait ends in CONFLICT, nothing runs', async () => {
    mkdirSync(J.managerDir(), { recursive: true });
    writeFileSync(lockFile(), '');
    const fn = vi.fn(async () => 'ran');
    await expect(J.withJournalLock(fn, 150)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/locked by another process/) });
    expect(fn).not.toHaveBeenCalled();
    expect(existsSync(lockFile())).toBe(true);
  });

  it('a lock of a dead pid (the old `<pid>` format too) is taken over; a live one is not', async () => {
    mkdirSync(J.managerDir(), { recursive: true });
    writeFileSync(lockFile(), '2147483646');
    await expect(J.withJournalLock(async () => 'taken', 500)).resolves.toBe('taken');
    writeFileSync(lockFile(), `${process.pid} feedfacefeedface`);
    await expect(J.withJournalLock(async () => 'ran', 150)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining(`process ${process.pid}`) });
  });

  it('the release leaves a lock that is no longer this holder\'s', async () => {
    await J.withJournalLock(async () => { writeFileSync(lockFile(), `${process.pid} 0123456789abcdef`); });
    expect(existsSync(lockFile())).toBe(true);
  });

  it('many concurrent writers in one process: each section runs alone', async () => {
    let inside = 0, max = 0;
    await Promise.all(Array.from({ length: 12 }, (_, i) => J.withJournalLock(async () => {
      inside++; max = Math.max(max, inside);
      await new Promise((r) => setImmediate(r));
      inside--;
      return i;
    })));
    expect(max).toBe(1);
  });
});
