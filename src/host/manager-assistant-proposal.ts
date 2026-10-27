// The host manager's natural-language assistant, part 3b: the strict proposal schema (docs/design/host-manager-assistant.md,
// "Decisions" 2-4, "Trust boundary"; task-65.3).
//
// The model answers one JSON object {reply, proposal}: a reply text and at most one proposal, or null. The answer is
// untrusted output. parseAssistantAnswer accepts a proposal only when
// - it is one object (a list, or a second proposal field, is refused: one proposal per reply),
// - its kind is config-set, restart, upgrade, sync or undo (approve and rebuild-cli are typed by the owner only),
// - it has exactly the fields of its kind (unknown fields are refused), and
// - parseOwnerCommand, the transport's parser of the typed commands, builds exactly the same OwnerCommand from it, so
//   the key, value and id patterns are the typed commands' own.
// Anything else is dropped with a reason; the reply text is still returned. The proposal only becomes an OwnerCommand
// for ManagerCommands.propose: the host plans it and the owner's Confirm tap stays the only approval.
import { z } from 'zod';
import { parseOwnerCommand } from './manager-telegram.js';
import type { OwnerCommand } from './manager.js';

/** The OwnerCommand kinds the assistant may propose. */
export const PROPOSAL_KINDS = ['config-set', 'restart', 'upgrade', 'sync', 'undo'] as const;
export type ProposalKind = typeof PROPOSAL_KINDS[number];
/** OwnerCommand kinds that only the owner types. */
export const TYPED_ONLY_KINDS = ['approve', 'rebuild-cli'] as const;
/** A reply longer than this is refused as a whole (the chat shows at most 1,500 characters of it anyway). */
export const REPLY_MAX = 16_000;

const KEY_PATTERN = '^[A-Za-z0-9_.-]+$';
const UNDO_ID_PATTERN = '^(?:cr|ow)_[0-9a-f]{8}$';

const ProposalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('config-set'), key: z.string().min(1).max(200).regex(new RegExp(KEY_PATTERN)), value: z.string().min(1).max(500), layer: z.enum(['local', 'shared']) }).strict(),
  z.object({ kind: z.literal('restart') }).strict(),
  z.object({ kind: z.literal('upgrade') }).strict(),
  z.object({ kind: z.literal('sync') }).strict(),
  z.object({ kind: z.literal('undo'), target: z.string().min(1).max(100) }).strict(),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

/** The --json-schema of a call: the same shape as ProposalSchema, one object {reply, proposal}. */
export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'proposal'],
  properties: {
    reply: { type: 'string', minLength: 1, maxLength: REPLY_MAX, description: 'Plain text for the owner. Never claim that anything was applied.' },
    proposal: {
      description: 'At most one typed command for the host to plan, or null.',
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false, required: ['kind', 'key', 'value', 'layer'],
          properties: {
            kind: { const: 'config-set' }, key: { type: 'string', pattern: KEY_PATTERN, maxLength: 200 },
            value: { type: 'string', minLength: 1, maxLength: 500 }, layer: { enum: ['local', 'shared'] },
          },
        },
        { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'restart' } } },
        { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'upgrade' } } },
        { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'sync' } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'target'], properties: { kind: { const: 'undo' }, target: { type: 'string', pattern: UNDO_ID_PATTERN } } },
      ],
    },
  },
} as const;

export type ProposalCheck = { ok: true; command: OwnerCommand } | { ok: false; reason: string };

const sameCommand = (a: OwnerCommand, b: OwnerCommand) => JSON.stringify(a) === JSON.stringify(b);

/** The typed command a proposal stands for, as the owner would have typed it (cmd and argument text). */
function asTyped(p: Proposal): { cmd: string; arg: string } {
  if (p.kind === 'config-set') return { cmd: 'set', arg: `${p.key} ${p.value}${p.layer === 'shared' ? ' shared' : ''}` };
  if (p.kind === 'undo') return { cmd: 'undo', arg: p.target };
  return { cmd: p.kind, arg: '' };
}

/** Validates one proposal value (untrusted). */
export function checkProposal(raw: unknown): ProposalCheck {
  if (Array.isArray(raw)) return { ok: false, reason: raw.length > 1 ? 'more than one proposal (one per reply)' : 'a proposal must be one object, not a list' };
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'the proposal is not an object' };
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return { ok: false, reason: 'the proposal has no kind' };
  if ((TYPED_ONLY_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `${kind} is never proposed: the owner types it` };
  if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `kind ${JSON.stringify(kind).slice(0, 40)} is not one the assistant may propose` };
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const unknown = issue?.code === 'unrecognized_keys' ? (issue as { keys?: string[] }).keys ?? [] : [];
    return { ok: false, reason: unknown.length ? `unknown field${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => JSON.stringify(k).slice(0, 40)).join(', ')} in a ${kind} proposal` : `malformed ${kind} proposal` };
  }
  const typed = asTyped(parsed.data);
  const command = parseOwnerCommand(typed.cmd, typed.arg);
  const expected: OwnerCommand = parsed.data.kind === 'config-set' ? { kind: 'config-set', key: parsed.data.key, value: parsed.data.value, layer: parsed.data.layer }
    : parsed.data.kind === 'undo' ? { kind: 'undo', target: parsed.data.target } : { kind: parsed.data.kind };
  if (!command || !sameCommand(command, expected)) return { ok: false, reason: `the ${kind} proposal does not parse as the typed command would` };
  return { ok: true, command };
}

/** The model's answer as the host reads it. */
export interface AssistantAnswer {
  /** The reply text to show (labelled by the caller); null when the answer has none. */
  reply: string | null;
  /** The validated proposal, or null. */
  command: OwnerCommand | null;
  /** Why a proposal (or the answer's shape) was refused; null when nothing was refused. */
  invalid: string | null;
}

const FENCE = /```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;

function fromObject(raw: unknown, fallbackReply: string | null): AssistantAnswer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reply: fallbackReply, command: null, invalid: 'the answer is not one JSON object' };
  const obj = raw as Record<string, unknown>;
  const replyOk = typeof obj.reply === 'string' && obj.reply.trim() !== '' && obj.reply.length <= REPLY_MAX;
  const reply = replyOk ? obj.reply as string : fallbackReply;
  const extra = Object.keys(obj).filter((k) => k !== 'reply' && k !== 'proposal');
  if (extra.length) {
    const many = extra.some((k) => /^proposals?\d*$|^proposal[_-]?\d+$|^commands?$/i.test(k));
    return { reply, command: null, invalid: many ? 'more than one proposal (one per reply)' : `unknown field${extra.length === 1 ? '' : 's'} ${extra.map((k) => JSON.stringify(k).slice(0, 40)).join(', ')} in the answer` };
  }
  if (!replyOk && obj.reply !== undefined) return { reply, command: null, invalid: 'the reply is not a non-empty text within the limit' };
  if (obj.proposal === undefined || obj.proposal === null) return { reply, command: null, invalid: null };
  const check = checkProposal(obj.proposal);
  return check.ok ? { reply, command: check.command, invalid: null } : { reply, command: null, invalid: check.reason };
}

/**
 * Reads a call's answer. With structured output (--json-schema) the structured object is the answer. Without it the
 * reply text must end with exactly one fenced JSON block holding the same object; the text around the block is the
 * reply when the object has none. No block: the text is the reply and there is no proposal. Never throws.
 */
export function parseAssistantAnswer(out: { text: string; structured?: unknown }): AssistantAnswer {
  if (out.structured !== undefined) return fromObject(out.structured, out.text.trim() && !out.text.trim().startsWith('{') ? out.text.trim() : null);
  const text = out.text ?? '';
  const blocks = [...text.matchAll(FENCE)];
  const rest = text.replace(FENCE, '').trim() || null;
  if (!blocks.length) return { reply: text.trim() || null, command: null, invalid: null };
  if (blocks.length > 1) return { reply: rest, command: null, invalid: 'more than one proposal block (one per reply)' };
  let parsed: unknown;
  try { parsed = JSON.parse(blocks[0]![1]!); } catch { return { reply: rest, command: null, invalid: 'the proposal block is not valid JSON' }; }
  return fromObject(parsed, rest);
}
