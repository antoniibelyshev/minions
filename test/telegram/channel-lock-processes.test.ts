// Cross-process check of the channel.lock takeover (task-67.2 retest): two real node processes race to take over the
// same released lock, round after round. Before the fix (write, then read back) both won in more than half of the
// rounds. Only the lock code runs in the children: no Bot API, no token, no claude.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
  writeFileSync(entry, `
import { createInterface } from 'node:readline';
import { acquireChannelLock } from ${JSON.stringify(join(repo, 'src/telegram/channel/server.ts'))};
const pid = Number(process.env.RACER_PID);
const proc = { alive: () => true, startTime: () => 's' };
for await (const line of createInterface({ input: process.stdin })) {
  const path = line.slice(3);
  const got = await acquireChannelLock(path, { pid, start: 's', launchId: 'launch-a' }, proc);
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

function racer(pid: number): (path: string) => Promise<string> {
  const child = spawn(process.execPath, [bundle], { env: { ...process.env, RACER_PID: String(pid) }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout! }).on('line', (line) => waiting.shift()?.(line));
  return (path) => new Promise((r) => { waiting.push(r); child.stdin!.write(`go ${path}\n`); });
}

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
});
