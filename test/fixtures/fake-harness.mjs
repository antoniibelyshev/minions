#!/usr/bin/env node
// The fake process harness (docs/design/agent-runtimes.md D10, adapter id `fake`). Driven by the scenario file
// in $FAKE_SCENARIO: `{ "steps": [ { "op": ... }, ... ] }`, run in order in the cwd (the per-lease clone).
// Never talks to a model and never starts a Claude session.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const scenario = JSON.parse(readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
const brief = JSON.parse(readFileSync(process.env.MINIONS_BRIEF_FILE, 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abs = (p) => (p.startsWith('/') ? p : join(process.cwd(), p));

// The prompt arrives on stdin (the runner writes the instructions and closes it).
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch { /* closed */ }

for (const s of scenario.steps ?? []) {
  switch (s.op) {
    case 'write': mkdirSync(dirname(abs(s.path)), { recursive: true }); writeFileSync(abs(s.path), s.content ?? ''); break;
    case 'append': appendFileSync(abs(s.path), s.content ?? ''); break;
    case 'rm': rmSync(abs(s.path), { recursive: true, force: true }); break;
    case 'symlink': rmSync(abs(s.path), { recursive: true, force: true }); symlinkSync(s.target, abs(s.path)); break;
    case 'commit':
      mkdirSync(dirname(abs(s.file)), { recursive: true });
      writeFileSync(abs(s.file), s.content ?? `${Math.random()}\n`);
      git('add', '--', s.file);
      git('commit', '-q', '--no-verify', '-m', s.message ?? `edit ${s.file}`);
      break;
    case 'git': git(...s.args); break;
    // A shell script in the clone (forged objects, replace refs, FIFOs); $BRANCH is the lease branch, $CLAIM the claim head.
    case 'sh': execFileSync('sh', ['-c', s.script], { cwd: process.cwd(), env: { ...process.env, BRANCH: brief.branch, CLAIM: brief.expectedHead }, stdio: ['ignore', 'pipe', 'pipe'] }); break;
    case 'dotgitCommit': {
      // A commit whose tree has a `.git` entry (fsck hasDotgit): built with plumbing, the porcelain refuses it.
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: '[core]\n\thooksPath = /tmp/evil\n', encoding: 'utf8' }).trim();
      const inner = execFileSync('git', ['mktree'], { input: `100644 blob ${blob}\tconfig\n`, encoding: 'utf8' }).trim();
      const tree = execFileSync('git', ['mktree'], { input: `040000 tree ${inner}\t.git\n`, encoding: 'utf8' }).trim();
      const commit = execFileSync('git', ['commit-tree', tree, '-p', 'HEAD', '-m', 'dotgit'], { encoding: 'utf8' }).trim();
      git('update-ref', `refs/heads/${brief.branch}`, commit);
      break;
    }
    case 'usage': process.stdout.write(JSON.stringify({ type: 'usage', input: s.input, output: s.output }) + '\n'); break;
    case 'final': process.stdout.write(JSON.stringify({ type: 'final', text: typeof s.text === 'string' ? s.text : JSON.stringify(s.result) }) + '\n'); break;
    case 'stderr': process.stderr.write(s.text); break;
    case 'result': {
      const head = git('rev-parse', 'HEAD');
      const r = { status: 'complete', summary: 'fake work', branch: brief.branch, headSha: head, modifiedPaths: [], checks: [{ command: 'npm test', outcome: 'pass' }],
        acceptanceEvidence: brief.task.acceptanceCriteria.map((c) => ({ criterion: c.text, evidence: 'fake' })), findings: [], nextAction: 'continue', ...(s.result ?? {}) };
      writeFileSync(process.env.MINIONS_RESULT_FILE, JSON.stringify(r));
      break;
    }
    case 'echoEnv': writeFileSync(process.env.MINIONS_RESULT_FILE + '.env', JSON.stringify({ env: process.env, argv: process.argv, stdin })); break;
    case 'ignoreTerm': process.on('SIGTERM', () => {}); break;
    case 'grandchild': {
      // A detached (setsid) grandchild that outlives this process unless something kills it.
      const c = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(s.pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`], { detached: !!s.setsid, stdio: 'ignore' });
      c.unref();
      await sleep(200);
      break;
    }
    case 'pidfile': writeFileSync(s.path, String(process.pid)); break;
    case 'sleep': await sleep(s.ms); break;
    case 'exit': process.exit(s.code ?? 0);
    default: throw new Error(`unknown op ${s.op}`);
  }
}
process.exit(scenario.exitCode ?? 0);
