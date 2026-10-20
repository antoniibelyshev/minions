// Real-process check of the coordinator wrapper's signal handling: the wrapper runs in its own node
// process with the real `process` signal target and a real long-running child (`sleep`) standing in
// for claude. Signals are delivered with process.kill, so this exercises Node's actual default
// SIGINT/SIGQUIT behavior rather than a fake listener registry.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { RuntimeDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { tmp } from '../runtime/fixtures.js';

const repo = resolve(__dirname, '..', '..');
let bundle: string;
let root: string;

beforeAll(async () => {
  root = tmp('minions-wrapsig-');
  const entry = join(root, 'entry.ts');
  writeFileSync(entry, `
import { spawn } from 'node:child_process';
import { coordinatorWrapper, runCoordinator } from ${JSON.stringify(join(repo, 'src/runtime/coordinator.ts'))};
import { defaults } from ${JSON.stringify(join(repo, 'test/helpers.ts'))};
const paths = JSON.parse(process.env.WRAP_PATHS!);
if (process.env.WRAP_MODE === 'prespawn') {
  // task-38: the lock is held while \`claude --help\` hangs; a signal must release it and exit.
  await coordinatorWrapper(async () => defaults(), {
    paths, env: {}, log: () => {},
    permissionModes: () => { process.stdout.write('ready\\n'); return new Promise((r) => setTimeout(() => r(null), 30_000)); }, // like a hung probe (30 s timeout)
    spawn: (() => { process.stdout.write('spawned\\n'); throw new Error('claude must not start'); }) as never,
    exitAfterSignal: (c) => { process.stdout.write('code ' + c + '\\n'); process.exit(c); },
  });
  process.stdout.write('returned without exiting\\n');
  process.exit(99);
}
const code = await runCoordinator(defaults(), {
  paths, env: {}, log: () => {}, permissionModes: async () => ['acceptEdits', 'auto'],
  spawn: (() => { const c = spawn('sleep', ['30'], { stdio: 'ignore' }); c.on('spawn', () => process.stdout.write('ready\\n')); return c; }) as never,
});
process.stdout.write('code ' + code + '\\n');
process.exit(code);
`);
  bundle = join(root, 'wrapper.mjs');
  await build({
    entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', target: 'node22', format: 'esm',
    external: ['node:*'], define: { __MINIONS_VERSION__: '"0.0.0-test"' }, logLevel: 'silent',
  });
}, 30_000);

function startWrapper(mode = ''): { child: ChildProcess; out: () => string; ready: Promise<void>; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; paths: ReturnType<typeof runtimePaths> } {
  const dir = tmp('minions-wrapsig-run-');
  for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'plugin', 'coordinator.md'), 'You are the coordinator.');
  const paths = {
    ...runtimePaths({ MINIONS_WORKSPACE: join(dir, 'ws'), MINIONS_STATE_DIR: join(dir, 'state'), MINIONS_SECRETS_DIR: join(dir, 'secrets') }),
    pluginDir: join(dir, 'plugin'), coordinatorPrompt: join(dir, 'plugin', 'coordinator.md'),
  };
  const child = spawn(process.execPath, [bundle], { env: { ...process.env, MINIONS_RUNTIME: 'container', WRAP_MODE: mode, WRAP_PATHS: JSON.stringify(paths) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let markReady: () => void;
  const ready = new Promise<void>((r) => { markReady = r; });
  child.stdout!.on('data', (d) => { buf += String(d); if (buf.includes('ready')) markReady(); });
  child.stderr!.on('data', (d) => { buf += String(d); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, out: () => buf, ready, done, paths };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('tester: wrapper signal handling in a real process', () => {
  it('survives SIGINT and SIGQUIT while claude runs, forwards SIGTERM, and exits 143', async () => {
    const w = startWrapper();
    await w.ready;
    process.kill(w.child.pid!, 'SIGINT');
    process.kill(w.child.pid!, 'SIGQUIT');
    await pause(300);
    expect(w.child.exitCode, w.out()).toBeNull();
    expect(w.child.signalCode, w.out()).toBeNull();
    process.kill(w.child.pid!, 'SIGTERM');
    const r = await w.done;
    expect(r, w.out()).toEqual({ code: 143, signal: null });
    expect(w.out()).toContain('code 143');
  }, 20_000);

  it('forwards SIGHUP (tmux kill-session) and exits 129', async () => {
    const w = startWrapper();
    await w.ready;
    process.kill(w.child.pid!, 'SIGINT');
    await pause(100);
    process.kill(w.child.pid!, 'SIGHUP');
    const r = await w.done;
    expect(r, w.out()).toEqual({ code: 129, signal: null });
  }, 20_000);

  for (const [sig, code] of [['SIGHUP', 129], ['SIGTERM', 143], ['SIGINT', 130]] as const) {
    it(`${sig} while the lock is held and \`claude --help\` hangs releases the lock and exits ${code} (task-38)`, async () => {
      const w = startWrapper('prespawn');
      await w.ready;
      const db = new RuntimeDb(w.paths.db);
      expect(db.coordinatorLock(), w.out()).toMatchObject({ pid: w.child.pid });
      process.kill(w.child.pid!, sig);
      const r = await w.done;
      expect(r, w.out()).toEqual({ code, signal: null });
      expect(w.out()).toContain(`code ${code}`);
      expect(w.out()).not.toContain('spawned');
      expect(db.coordinatorLock()).toBeUndefined();
      db.close();
    }, 20_000);
  }
});
