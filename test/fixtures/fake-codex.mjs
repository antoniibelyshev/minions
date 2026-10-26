#!/usr/bin/env node
// A fake `codex` CLI for the Codex adapter tests (task-14.6). Started as `node fake-codex.mjs <scenario.json> exec ...`
// through codexAdapter({ command: [node, script, scenario] }). It checks the invocation the adapter plans, then prints
// `codex exec --json` JSONL (shapes of exec/src/exec_events.rs, 0.164) and writes the --output-last-message file.
// Scenario: { echo?: path, usage?: [[input, output, cached], ...] (running totals), result?: {...}, nulls?: bool,
//             message?: string (raw final text), stderr?: string, exitCode?: number }.
// Never talks to a model.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [scenarioFile, sub, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const fail = (msg) => { process.stderr.write(`fake-codex: ${msg}\n`); process.exit(2); };

if (sub !== 'exec') fail(`expected the exec subcommand, got ${sub}`);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
for (const f of ['--json', '--ephemeral', '--strict-config']) if (!args.includes(f)) fail(`missing ${f}`);
if (args.at(-1) !== '-') fail('the prompt must come from stdin (-)');
const cd = flag('--cd');
const schemaFile = flag('--output-schema');
const lastFile = flag('--output-last-message');
if (!cd || !schemaFile || !lastFile) fail('missing --cd, --output-schema or --output-last-message');
if (!process.env.CODEX_API_KEY) fail('CODEX_API_KEY is not set');
const configFile = join(process.env.CODEX_HOME ?? '', 'config.toml');
if (!existsSync(configFile)) fail(`no ${configFile}`);
const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));

let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch { /* closed */ }

if (scenario.echo) {
  writeFileSync(scenario.echo, JSON.stringify({ argv: process.argv, env: process.env, stdin, cwd: process.cwd(), config: readFileSync(configFile, 'utf8'), schema }));
}
if (scenario.stderr) process.stderr.write(scenario.stderr);

out({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
out({ type: 'turn.started' });
out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Reviewing the diff**' } });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cd, encoding: 'utf8' }).trim();
const { branch } = JSON.parse(readFileSync(process.env.MINIONS_BRIEF_FILE, 'utf8'));
out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "git rev-parse HEAD"', aggregated_output: head + '\n', exit_code: 0, status: 'completed' } });
const nul = scenario.nulls === false ? {} : { needsQa: null };
const text = typeof scenario.message === 'string' ? scenario.message : JSON.stringify({
  status: 'complete', summary: 'Reviewed by fake codex.', branch, headSha: head, modifiedPaths: [],
  checks: [{ command: 'npm test', outcome: 'pass', details: null, source: null }],
  acceptanceEvidence: [{ criterion: 'works', evidence: 'fake review' }], findings: [], nextAction: 'merge', verdict: 'approve', ...nul,
  ...(scenario.result ?? {}),
});
out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text } });
writeFileSync(lastFile, text);
for (const [i, o, c] of scenario.usage ?? [[1000, 100, 800]]) out({ type: 'turn.completed', usage: { input_tokens: i, cached_input_tokens: c, output_tokens: o } });
process.exit(scenario.exitCode ?? 0);
