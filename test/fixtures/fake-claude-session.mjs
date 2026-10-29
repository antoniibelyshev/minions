#!/usr/bin/env node
// A fake resident `claude -p --input-format stream-json --output-format stream-json` for the session supervisor tests
// (task-57 phase 5). Never talks to a model. It appends what it sees to $FAKE_LOG as JSON lines:
//   {ev:'start', pid, pgid?, argv, env: {MINIONS_SESSION, CLAUDE_CONFIG_DIR, TMPDIR, telegram: [names], secrets: [names]}}
//   {ev:'msg', text} for each stdin user message, {ev:'eof'} at stdin end, {ev:'signal', name}.
// It prints the stream-json `system` init event (session id: the --resume value, else $FAKE_SESSION_ID or sess-1) and
// one `result` event per message. A message containing CRASH makes it exit 3.
// FAKE_MODE: crash-on-start (init, then exit 4 before any turn) | ignore-eof (stays alive after stdin ends).
// FAKE_IGNORE_SIGINT=1: SIGINT is logged and ignored (SIGTERM still ends it).
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (o) => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n'); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const id = at >= 0 ? args[at + 1] : (process.env.FAKE_SESSION_ID || 'sess-1');
const names = Object.keys(process.env);
log({
  ev: 'start', pid: process.pid, argv: args,
  env: {
    MINIONS_SESSION: process.env.MINIONS_SESSION ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, TMPDIR: process.env.TMPDIR ?? null,
    telegram: names.filter((n) => n.startsWith('TELEGRAM_')),
    secrets: names.filter((n) => ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'MINIONS_WORKER_LEASE', 'MINIONS_ROLE'].includes(n)),
  },
});
process.on('SIGINT', () => { log({ ev: 'signal', name: 'SIGINT' }); if (process.env.FAKE_IGNORE_SIGINT !== '1') process.exit(130); });
process.on('SIGTERM', () => { log({ ev: 'signal', name: 'SIGTERM' }); process.exit(143); });

out({ type: 'system', subtype: 'init', session_id: id });
if (process.env.FAKE_MODE === 'crash-on-start') { process.stderr.write('fake-claude: boom at start\n'); setTimeout(() => process.exit(4), 20); }
else {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const text = m?.message?.content?.[0]?.text ?? '';
    log({ ev: 'msg', text });
    if (text.includes('CRASH')) { process.stderr.write('fake-claude: crashed on purpose\n'); process.exit(3); }
    out({ type: 'assistant', session_id: id, message: { content: [{ type: 'text', text: 'ok' }] } });
    out({ type: 'result', subtype: 'success', session_id: id });
  });
  rl.on('close', () => {
    log({ ev: 'eof' });
    if (process.env.FAKE_MODE === 'ignore-eof') setInterval(() => undefined, 1000);
    else setTimeout(() => process.exit(0), 10);
  });
}
