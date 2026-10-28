// Coordinator transcript lines in the shapes Claude Code 2.1 really writes (copied from live coordinator
// transcripts, ids and text shortened): Telegram owner messages from the official plugin, the expanded form of
// typed slash commands, and assistant turns. Shared by the coordinator-usage tests and the tests of the
// consumers of the last owner message time (routine, digest, auto-promote).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackCoordinatorUsage } from '../../src/runtime/coordinator-usage.js';
import type { RuntimeDb } from '../../src/runtime/db.js';
import { tmp } from './fixtures.js';

const meta = (sessionId: string) => ({ userType: 'external', entrypoint: 'cli', cwd: '/workspace/repo', sessionId, version: '2.1.292', gitBranch: 'main' });

/**
 * A Telegram owner message as the official plugin (0.0.7) delivers it: `source="plugin:telegram:telegram"`, an
 * `isMeta` user line with a channel origin. `source` = 'telegram' gives the task-67 server's form.
 */
export function ownerLine(text: string, o: { sessionId?: string; ts?: string; source?: string } = {}) {
  const ts = o.ts ?? '2026-10-27T18:09:36.000Z';
  const source = o.source ?? 'plugin:telegram:telegram';
  return {
    parentUuid: 'c7d8df2a-fae5-43f8-95e7-4786d05a05ef', isSidechain: false, promptId: '16e4d181-2102-4a67-be5c-671cc87e0b4c', type: 'user',
    message: { role: 'user', content: `<channel source="${source}" chat_id="828508958" message_id="376" user="owner" user_id="828508958" ts="${ts}">\n${text}\n</channel>` },
    isMeta: true, uuid: '8c966893-c9a7-493b-943f-035de2a36957', timestamp: ts, permissionMode: 'auto',
    origin: { kind: 'channel', server: source }, promptSource: 'system', turnOrigin: 'peer', ...meta(o.sessionId ?? 'sess-1'),
  };
}

/** A typed slash command as Claude Code writes it: the expanded `<command-message>`/`<command-name>`/`<command-args>` tags. */
export function slashCommandLine(name: string, args: string, o: { sessionId?: string; order?: ('message' | 'name' | 'args')[] } = {}) {
  const tags = { message: `<command-message>${name}</command-message>`, name: `<command-name>/${name}</command-name>`, args: `<command-args>${args}</command-args>` };
  const content = (o.order ?? ['message', 'name', 'args']).map((k) => tags[k]).join('\n');
  return {
    parentUuid: null, isSidechain: false, promptId: '4c014cba-5d48-4a3b-8f76-1d9b6d80a59b', type: 'user', message: { role: 'user', content },
    uuid: '8fa16573-5586-4fb3-8fdf-1c89734d1038', timestamp: '2026-10-28T20:18:25.616Z', origin: { kind: 'human' }, turnOrigin: 'human', ...meta(o.sessionId ?? 'sess-1'),
  };
}

/** The skill body Claude Code adds after an expanded slash command (an `isMeta` user line with text blocks). */
export function skillBodyLine(text: string, sessionId = 'sess-1') {
  return { parentUuid: '8fa16573-5586-4fb3-8fdf-1c89734d1038', isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, isMeta: true, ...meta(sessionId) };
}

export function assistantLine(id: string, cacheRead = 1000, content: unknown[] = [{ type: 'text', text: 'ok' }], sessionId = 'sess-1') {
  return {
    parentUuid: 'x', isSidechain: false, type: 'assistant',
    message: { id, type: 'message', role: 'assistant', model: 'claude-opus-4-5', content, usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: 12 } },
    ...meta(sessionId),
  };
}

export const jsonl = (xs: unknown[]) => xs.map((x) => JSON.stringify(x) + '\n').join('');

/**
 * The Stop hook's path end to end: a coordinator transcript with one plugin-shaped owner message is tracked at
 * `now`, which records the last owner message time. Takes the coordinator lock when none is held.
 */
export function recordOwnerMessageViaStop(db: RuntimeDb, now: Date, sessionId = 'sess-owner'): { recorded: boolean; reason: string } {
  if (!db.coordinatorLock()) db.acquireCoordinatorLock('coordinator', 4242, () => false);
  const file = join(tmp('minions-owner-t-'), `${sessionId}.jsonl`);
  writeFileSync(file, jsonl([slashCommandLine('minions:orchestrate', '', { sessionId }), assistantLine('m1', 1000, undefined, sessionId), ownerLine("how's it going?", { sessionId }), assistantLine('m2', 2000, undefined, sessionId)]));
  return trackCoordinatorUsage({ db, env: {}, now }, { transcript_path: file, session_id: sessionId });
}
