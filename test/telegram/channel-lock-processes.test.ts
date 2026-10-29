// Cross-process check of the channel.lock takeover (task-67.2 retest): real node processes race to take over the
// same released lock, round after round. Before the fix (write, then read back) both won in more than half of the
// rounds. Only the lock code runs in the children: no Bot API, no token, no claude.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmp } from '../runtime/fixtures.js';

const repo = resolve(__dirname, '..', '..');
let root: string;
let bundle: string;

beforeAll(async () => {
  root = tmp('minions-chlock-');
  const entry = join(root, 'entry.ts');
  // Each child answers one acquire per "go <path>" line on stdin with "ok" or "lost".
  // RACER_REAL=1: real pid and /proc start times, so a SIGKILLed racer is seen as dead once reaped.
  writeFileSync(entry, `
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { acquireChannelLock } from ${JSON.stringify(join(repo, 'src/telegram/channel/server.ts'))};
const real = process.env.RACER_REAL === '1';
const pid = real ? process.pid : Number(process.env.RACER_PID);
const alive = (p: number) => { try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const startTime = (p: number) => { try { const s = readFileSync('/proc/' + p + '/stat', 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { return null; } };
const proc = real ? { alive, startTime } : { alive: () => true, startTime: () => 's' };
for await (const line of createInterface({ input: process.stdin })) {
  const path = line.slice(3);
  const got = await acquireChannelLock(path, { pid, start: real ? startTime(pid) : 's', launchId: 'launch-a' }, proc);
  process.stdout.write((got.ok ? 'ok' : 'lost') + '\\n');
}
`);
  bundle = join(root, 'racer.mjs');
  await build({
    entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', target: 'node22', format: 'esm',
    external: ['node:*'], define: { __MINIONS_VERSION__: '"0.0.0-test"' }, logLevel: 'silent',
  });
}, 30_000);

const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) c.kill(); });

function spawnRacer(env: NodeJS.ProcessEnv): { child: ChildProcess; go: (path: string) => Promise<string> } {
  const child = spawn(process.execPath, [bundle], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout! }).on('line', (line) => waiting.shift()?.(line));
  return { child, go: (path) => new Promise((r) => { waiting.push(r); child.stdin!.write(`go ${path}\n`); }) };
}
const racer = (pid: number) => spawnRacer({ RACER_PID: String(pid) }).go;
const realRacer = () => spawnRacer({ RACER_REAL: '1' });
const exited = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => c.once('exit', () => r())));

describe('channel.lock across processes', () => {
  it('two processes taking over the same released lock at once: exactly one wins every round', async () => {
    const a = racer(601);
    const b = racer(602);
    const released = JSON.stringify({ version: 1, pid: 600, start: 's', launchId: 'launch-a', kills: 1, released: true });
    for (let i = 0; i < 60; i++) {
      const path = join(root, `channel-${i}.lock`);
      writeFileSync(path, released);
      const got = await Promise.all([a(path), b(path)]);
      expect(got.filter((g) => g === 'ok').length, `round ${i}: ${got.join(',')}`).toBe(1);
      expect(JSON.parse(readFileSync(path, 'utf8')).kills).toBe(1);
    }
  }, 60_000);

  // QA (task-67.2 lock retest): more than two racers, and racers SIGKILLed at random points of the takeover (often
  // between creating the guard and replacing the lock). A dead taker's guard must not wedge the lock: once the killed
  // racers are gone, exactly one of the live racers wins and the launch's kill count is kept.
  it('five processes racing for a released or stale lock: exactly one wins every round', async () => {
    const go = [701, 702, 703, 704, 705].map(racer);
    const records = [
      { version: 1, pid: 600, start: 's', launchId: 'launch-a', kills: 1, released: true, nonce: 'n-released' },
      { version: 1, pid: 600, start: 'gone', launchId: 'launch-a', kills: 1, nonce: 'n-stale' }, // start differs: reused pid, stale
    ];
    for (let i = 0; i < 40; i++) {
      const path = join(root, `five-${i}.lock`);
      writeFileSync(path, JSON.stringify(records[i % 2]));
      const got = await Promise.all(go.map((g) => g(path)));
      expect(got.filter((g) => g === 'ok').length, `round ${i}: ${got.join(',')}`).toBe(1);
      expect(JSON.parse(readFileSync(path, 'utf8')).kills).toBe(1);
    }
  }, 60_000);

  it('racers killed mid-takeover never wedge the lock: the live racers still get exactly one winner', async () => {
    const live = [realRacer(), realRacer(), realRacer()];
    let guardsLeft = 0;
    for (let i = 0; i < 40; i++) {
      const sub = join(root, `kill-${i}`);
      mkdirSync(sub);
      const path = join(sub, 'channel.lock');
      writeFileSync(path, JSON.stringify({ version: 1, pid: process.pid, start: 'x', launchId: 'launch-a', kills: 1, released: true, nonce: `k${i}` }));
      const victims = Array.from({ length: 1 + (i % 3) }, realRacer);
      await Promise.all(victims.map((v) => v.go(join(sub, 'warm.lock')))); // loaded and ready
      for (const v of victims) void v.go(path);
      await new Promise((r) => setTimeout(r, Math.random() * (i % 2 ? 3 : 12)));
      for (const v of victims) v.child.kill('SIGKILL');
      await Promise.all(victims.map((v) => exited(v.child))); // reaped: an unreaped zombie still looks alive
      if (readdirSync(sub).some((f) => f.includes('.take-'))) guardsLeft++;
      const got = await Promise.all(live.map((r) => r.go(path)));
      expect(got.filter((g) => g === 'ok').length, `round ${i}: ${got.join(',')}`).toBe(1);
      expect(JSON.parse(readFileSync(path, 'utf8')).kills).toBe(1);
    }
    expect(guardsLeft).toBeGreaterThan(0); // some kills landed between guard and replace
  }, 120_000);
});
