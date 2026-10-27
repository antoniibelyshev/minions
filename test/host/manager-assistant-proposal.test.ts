// The manager assistant's strict proposal schema (task-65.3): only config-set, restart, upgrade, sync and undo, with
// the typed commands' own patterns (parseOwnerCommand); approve, rebuild-cli, unknown fields and more than one proposal
// are refused, and the reply text survives a refused proposal. Pure; no claude.
import { describe, expect, it } from 'vitest';
import { ANSWER_JSON_SCHEMA, PROPOSAL_KINDS, checkProposal, parseAssistantAnswer } from '../../src/host/manager-assistant-proposal.js';
import { parseOwnerCommand } from '../../src/host/manager-telegram.js';

const SHA = 'a'.repeat(40);
const answer = (proposal: unknown, reply = 'I proposed it: check the plan below. Nothing is applied yet.') => parseAssistantAnswer({ text: '', structured: { reply, proposal } });

describe('checkProposal', () => {
  it('accepts each allowed kind as exactly the OwnerCommand the typed command parses to', () => {
    expect(checkProposal({ kind: 'config-set', key: 'delivery.merge', value: 'manual', layer: 'local' })).toEqual({ ok: true, command: parseOwnerCommand('set', 'delivery.merge manual') });
    expect(checkProposal({ kind: 'config-set', key: 'models.allowed', value: 'sonnet, opus', layer: 'shared' })).toEqual({ ok: true, command: parseOwnerCommand('set', 'models.allowed sonnet, opus shared') });
    for (const k of ['restart', 'upgrade', 'sync'] as const) expect(checkProposal({ kind: k })).toEqual({ ok: true, command: { kind: k } });
    expect(checkProposal({ kind: 'undo', target: 'ow_0a1b2c3d' })).toEqual({ ok: true, command: { kind: 'undo', target: 'ow_0a1b2c3d' } });
  });

  it('refuses approve and rebuild-cli, whatever their fields', () => {
    expect(checkProposal({ kind: 'approve', taskId: 'task-1', head: SHA, merge: false })).toEqual({ ok: false, reason: 'approve is never proposed: the owner types it' });
    expect(checkProposal({ kind: 'rebuild-cli' })).toEqual({ ok: false, reason: 'rebuild-cli is never proposed: the owner types it' });
    for (const kind of ['cli-rollback', 'assistant', 'config-unset', 'shell', 'Restart']) expect(checkProposal({ kind })).toMatchObject({ ok: false, reason: expect.stringMatching(/is not one the assistant may propose/) });
    expect(checkProposal({ key: 'a' })).toMatchObject({ ok: false, reason: 'the proposal has no kind' });
  });

  it('refuses unknown or missing fields', () => {
    expect(checkProposal({ kind: 'restart', mode: 'drain' })).toEqual({ ok: false, reason: 'unknown field "mode" in a restart proposal' });
    expect(checkProposal({ kind: 'config-set', key: 'a.b', value: 'x', layer: 'local', confirm: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown field "confirm"/) });
    expect(checkProposal({ kind: 'undo', target: 'ow_0a1b2c3d', nonce: 'f'.repeat(32) })).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown field "nonce"/) });
    expect(checkProposal({ kind: 'config-set', key: 'a.b', value: 'x' })).toEqual({ ok: false, reason: 'malformed config-set proposal' });
    expect(checkProposal({ kind: 'undo' })).toEqual({ ok: false, reason: 'malformed undo proposal' });
    expect(checkProposal({ kind: 'config-set', key: 'a.b', value: 3, layer: 'local' })).toEqual({ ok: false, reason: 'malformed config-set proposal' });
  });

  it('applies the typed commands patterns: key, value and undo id', () => {
    const bad = (p: Record<string, unknown>) => expect(checkProposal({ kind: 'config-set', layer: 'local', key: 'a.b', value: 'x', ...p }).ok).toBe(false);
    bad({ key: 'a b' }); bad({ key: 'a;rm' }); bad({ key: '' });
    bad({ value: '--yes' }); bad({ value: '-1' }); bad({ value: '' }); bad({ value: 'x'.repeat(501) });
    // Would not survive the typed command's word split: refused rather than silently changed.
    bad({ value: 'a\nb' }); bad({ value: 'a  b' }); bad({ value: ' a' });
    // "x shared" as the local value would be typed as `/set a.b x shared`, the shared layer: refused.
    bad({ value: 'x shared' });
    for (const target of ['ow_123', 'cr_XYZ', 'task-1', '../x', 'ow_0a1b2c3d extra']) expect(checkProposal({ kind: 'undo', target }).ok).toBe(false);
    expect(checkProposal({ kind: 'config-set', key: 'a.b', value: 'shared', layer: 'local' })).toEqual({ ok: true, command: { kind: 'config-set', key: 'a.b', value: 'shared', layer: 'local' } });
  });

  it('refuses more than one proposal', () => {
    expect(checkProposal([{ kind: 'restart' }, { kind: 'sync' }])).toEqual({ ok: false, reason: 'more than one proposal (one per reply)' });
    expect(checkProposal([{ kind: 'restart' }])).toEqual({ ok: false, reason: 'a proposal must be one object, not a list' });
    expect(checkProposal('restart')).toEqual({ ok: false, reason: 'the proposal is not an object' });
  });
});

describe('parseAssistantAnswer', () => {
  it('structured output: reply and one proposal, or reply and null', () => {
    expect(answer({ kind: 'config-set', key: 'delivery.merge', value: 'manual', layer: 'local' })).toEqual({
      reply: 'I proposed it: check the plan below. Nothing is applied yet.', command: { kind: 'config-set', key: 'delivery.merge', value: 'manual', layer: 'local' }, invalid: null,
    });
    expect(answer(null, 'You can change these groups: ...')).toEqual({ reply: 'You can change these groups: ...', command: null, invalid: null });
  });

  it('a refused proposal is dropped with its reason and the reply is kept', () => {
    expect(answer({ kind: 'approve', taskId: 'task-1', head: SHA, merge: true }, 'Type /approve task-1 <sha> merge.')).toEqual({ reply: 'Type /approve task-1 <sha> merge.', command: null, invalid: 'approve is never proposed: the owner types it' });
    expect(answer([{ kind: 'restart' }, { kind: 'upgrade' }])).toMatchObject({ command: null, invalid: 'more than one proposal (one per reply)', reply: expect.any(String) });
  });

  it('refuses unknown answer fields, including a second proposal field', () => {
    for (const extra of ['proposals', 'proposal2', 'commands']) {
      expect(parseAssistantAnswer({ text: '', structured: { reply: 'r', proposal: { kind: 'restart' }, [extra]: [{ kind: 'sync' }] } })).toEqual({ reply: 'r', command: null, invalid: 'more than one proposal (one per reply)' });
    }
    expect(parseAssistantAnswer({ text: '', structured: { reply: 'r', proposal: null, applied: true } })).toEqual({ reply: 'r', command: null, invalid: 'unknown field "applied" in the answer' });
    expect(parseAssistantAnswer({ text: '', structured: 'just text' })).toMatchObject({ command: null, invalid: 'the answer is not one JSON object' });
    expect(parseAssistantAnswer({ text: '', structured: { reply: '', proposal: { kind: 'restart' } } })).toMatchObject({ reply: null, command: null, invalid: expect.stringMatching(/reply/) });
    expect(parseAssistantAnswer({ text: '', structured: { reply: 'x'.repeat(16_001), proposal: { kind: 'restart' } } })).toMatchObject({ reply: null, command: null });
  });

  it('without structured output: exactly one fenced JSON block holds the answer', () => {
    const text = 'Here is the plan.\n```json\n{"reply": "Proposed: check the plan below.", "proposal": {"kind": "sync"}}\n```';
    expect(parseAssistantAnswer({ text })).toEqual({ reply: 'Proposed: check the plan below.', command: { kind: 'sync' }, invalid: null });
    expect(parseAssistantAnswer({ text: 'Plain answer, no proposal.' })).toEqual({ reply: 'Plain answer, no proposal.', command: null, invalid: null });
    const two = 'a\n```json\n{"reply": "r", "proposal": {"kind": "sync"}}\n```\n```json\n{"reply": "r", "proposal": {"kind": "restart"}}\n```';
    expect(parseAssistantAnswer({ text: two })).toEqual({ reply: 'a', command: null, invalid: 'more than one proposal block (one per reply)' });
    expect(parseAssistantAnswer({ text: 'text\n```json\n{not json}\n```' })).toEqual({ reply: 'text', command: null, invalid: 'the proposal block is not valid JSON' });
    expect(parseAssistantAnswer({ text: 'text\n```json\n{"proposal": {"kind": "upgrade"}}\n```' })).toEqual({ reply: 'text', command: { kind: 'upgrade' }, invalid: null });
    expect(parseAssistantAnswer({ text: 'x\n```json\n{"reply": "r", "proposal": {"kind": "rebuild-cli"}}\n```' })).toMatchObject({ command: null, invalid: 'rebuild-cli is never proposed: the owner types it' });
  });
});

describe('ANSWER_JSON_SCHEMA', () => {
  it('names exactly the allowed kinds, each closed to other fields', () => {
    const variants = ANSWER_JSON_SCHEMA.properties.proposal.anyOf;
    const kinds = variants.flatMap((v) => ('properties' in v ? [v.properties.kind.const] : []));
    expect(kinds).toEqual([...PROPOSAL_KINDS]);
    expect(ANSWER_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(ANSWER_JSON_SCHEMA.required).toEqual(['reply', 'proposal']);
    for (const v of variants) if ('properties' in v) expect(v.additionalProperties).toBe(false);
    expect(variants[0]).toEqual({ type: 'null' });
    expect(JSON.stringify(ANSWER_JSON_SCHEMA)).not.toMatch(/approve|rebuild/);
  });

  it('its patterns agree with the typed commands', () => {
    const cs = ANSWER_JSON_SCHEMA.properties.proposal.anyOf[1];
    const undo = ANSWER_JSON_SCHEMA.properties.proposal.anyOf[5];
    const keyRe = new RegExp(cs.properties.key.pattern);
    const idRe = new RegExp(undo.properties.target.pattern);
    for (const k of ['delivery.merge', 'roles.engineer.harness', 'capabilities.pr-merge']) expect(keyRe.test(k) && parseOwnerCommand('set', `${k} v`) !== null).toBe(true);
    for (const id of ['ow_0a1b2c3d', 'cr_0123abcd']) expect(idRe.test(id) && parseOwnerCommand('undo', id) !== null).toBe(true);
    for (const id of ['ow_0a1b2c3', 'cr_0123abcde', 'xx_0123abcd']) expect(idRe.test(id) || parseOwnerCommand('undo', id) !== null).toBe(false);
  });
});
