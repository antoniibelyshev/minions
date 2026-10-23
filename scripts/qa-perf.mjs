#!/usr/bin/env node
// QA sweep performance probe (task-24): times CLI startup and the hot paths the coordinator calls often
// (status, backlog list/ready, work next/claim/record) against a throwaway state dir, and reports the
// size of dist/cli.js. Never touches /state: every MINIONS_* path points into a fresh mkdtemp dir that is
// removed at the end. Usage: npm run build && node scripts/qa-perf.mjs [--tasks 40] [--runs 5] [--json]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const TASKS = arg('--tasks', 40);
const RUNS = arg('--runs', 5);
const JSON_OUT = process.argv.includes('--json');
const repo = resolve(new URL('..', import.meta.url).pathname);
const cliJs = join(repo, 'dist', 'cli.js');
try { statSync(cliJs); } catch { console.error('dist/cli.js missing: run `npm run build` first'); process.exit(1); }

const root = mkdtempSync(join(tmpdir(), 'minions-qa-perf-'));
const state = join(root, 'state');
const workspace = join(root, 'workspace');
const config = join(root, 'config.json');
const env = {
  ...process.env, MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: config,
  MINIONS_WORKSPACE: workspace, MINIONS_SECRETS_DIR: join(root, 'secrets'), MINIONS_PLUGIN_DIR: join(root, 'plugin'),
  MINIONS_SCRATCH_DIR: join(root, 'scratch'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'QA', GIT_AUTHOR_EMAIL: 'qa@example.com', GIT_COMMITTER_NAME: 'QA', GIT_COMMITTER_EMAIL: 'qa@example.com',
};
if (env.MINIONS_STATE_DIR === '/state' || !state.startsWith(root)) throw new Error('refusing to run against a real state dir');

const cli = (args, opts = {}) => spawnSync(process.execPath, [cliJs, ...args], { env, encoding: 'utf8', cwd: opts.cwd ?? root, input: opts.input });
const ok = (args, opts) => {
  const r = cli([...args, '--json'], opts);
  const last = (r.stdout || '').trim().split('\n').pop() || '';
  let parsed; try { parsed = JSON.parse(last); } catch { parsed = undefined; }
  if (!parsed?.ok) throw new Error(`minions ${args.join(' ')} failed: ${last || r.stderr}`);
  return parsed.data;
};

/** Times `fn` RUNS times (after one warm-up) and returns min/median/max in ms. */
function time(label, fn) {
  fn();
  const xs = [];
  for (let i = 0; i < RUNS; i++) { const t = process.hrtime.bigint(); fn(); xs.push(Number(process.hrtime.bigint() - t) / 1e6); }
  xs.sort((a, b) => a - b);
  return { label, min: Math.round(xs[0]), median: Math.round(xs[Math.floor(xs.length / 2)]), max: Math.round(xs.at(-1)) };
}

try {
  // Config + Backlog.md project from the real source (bundled on the fly; no TS runtime needed).
  const helper = join(root, 'helper.mjs');
  await build({
    stdin: {
      contents: `export { profileDefaults } from './src/config/profiles.ts'; export { writeBacklogConfig } from './src/backlog/factory.ts';`,
      resolveDir: repo, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', outfile: helper, external: ['node:*'], logLevel: 'error',
    define: { __MINIONS_VERSION__: '"0.0.0"' },
  });
  const { profileDefaults, writeBacklogConfig } = await import(helper);
  const ctx = { hasGitHub: false, baseBranch: 'main', identity: { name: 'QA', email: 'qa@example.com' }, projectId: '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f', packageVersion: '0.1.0' };
  writeFileSync(config, JSON.stringify(profileDefaults('project-owner', ctx).config));
  mkdirSync(state, { recursive: true });
  await writeBacklogConfig(join(state, 'backlog'));
  mkdirSync(join(workspace, 'worktrees'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', join(workspace, 'repo')], { env });
  writeFileSync(join(workspace, 'repo', 'README.md'), '# qa\n');
  execFileSync('git', ['-C', join(workspace, 'repo'), 'add', '.'], { env });
  execFileSync('git', ['-C', join(workspace, 'repo'), 'commit', '-q', '-m', 'init'], { env });

  // Seed the backlog: half ready (with a dependency chain every 5th task), half idea.
  const seedStart = process.hrtime.bigint();
  const ids = [];
  for (let i = 0; i < TASKS; i++) {
    const args = ['backlog', 'create', '--title', `QA task ${i}`, '--ac', 'works', '--status', i % 2 ? 'idea' : 'ready', '--key', `qa-perf:${i}`];
    if (i % 5 === 4 && ids.length) args.push('--dep', ids[ids.length - 1]);
    const d = ok(args);
    ids.push(d.task?.id ?? d.id);
  }
  const seedMs = Number(process.hrtime.bigint() - seedStart) / 1e6;

  const backlogBin = process.env.MINIONS_BACKLOG_BIN || 'backlog';
  const raw = (args) => { const r = spawnSync(backlogBin, args, { env, cwd: join(state, 'backlog'), encoding: 'utf8' }); if (r.status !== 0) throw new Error(`backlog ${args.join(' ')} failed: ${r.stderr}`); };
  const rows = [
    time('node -e 0 (baseline)', () => spawnSync(process.execPath, ['-e', '0'])),
    time('minions --version', () => cli(['--version'])),
    time('minions --help', () => cli(['--help'])),
    time(`backlog --version (raw Backlog.md CLI)`, () => raw(['--version'])),
    time(`backlog task list --plain (raw)`, () => raw(['task', 'list', '--plain'])),
    time(`backlog task view --json (raw, one task)`, () => raw(['task', 'view', ids[0].toUpperCase(), '--json'])),
    time('minions status --json', () => ok(['status'])),
    time(`minions backlog list --json (${TASKS} tasks)`, () => ok(['backlog', 'list'])),
    time('minions backlog ready --json', () => ok(['backlog', 'ready'])),
    time('minions work next --json', () => ok(['work', 'next'])),
    time('minions backlog show --json', () => ok(['backlog', 'show', ids[0]])),
  ];

  // work claim + record: each run claims a fresh ready task and records a blocked result for it.
  const ready = ids.filter((_, i) => i % 2 === 0 && i % 5 !== 4);
  let k = 0;
  const claimTimes = []; const recordTimes = [];
  for (let i = 0; i < Math.min(RUNS + 1, ready.length); i++) {
    const id = ready[k++];
    let t = process.hrtime.bigint();
    const brief = ok(['work', 'claim', id, '--role', 'engineer']);
    claimTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
    const head = execFileSync('git', ['-C', brief.worktree, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
    const result = { status: 'blocked', summary: 'qa perf probe', branch: brief.branch, headSha: head, modifiedPaths: [], checks: [], acceptanceEvidence: [], findings: ['probe'], nextAction: 'none' };
    const file = join(root, `result-${i}.json`);
    writeFileSync(file, JSON.stringify(result));
    t = process.hrtime.bigint();
    ok(['work', 'record', brief.leaseId, '--result-file', file]);
    recordTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const summarize = (label, xs) => { const s = [...xs].sort((a, b) => a - b); return { label, min: Math.round(s[0]), median: Math.round(s[Math.floor(s.length / 2)]), max: Math.round(s.at(-1)) }; };
  if (claimTimes.length) rows.push(summarize('minions work claim --json', claimTimes), summarize('minions work record --json', recordTimes));

  const bytes = readFileSync(cliJs);
  const out = { tasks: TASKS, runs: RUNS, seedMsPerCreate: Math.round(seedMs / TASKS), distCliBytes: bytes.length, distCliGzipBytes: gzipSync(bytes).length, rows };
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`dist/cli.js: ${bytes.length} bytes (${out.distCliGzipBytes} gzip); backlog create: ~${out.seedMsPerCreate} ms/task; ${TASKS} tasks, ${RUNS} runs`);
    console.log('command | min ms | median ms | max ms');
    for (const r of rows) console.log(`${r.label} | ${r.min} | ${r.median} | ${r.max}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
