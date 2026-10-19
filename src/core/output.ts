import { EXIT_CODES, MinionsError, type ErrorCode } from './errors.js';

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_[REDACTED]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b(bot)?\d{6,12}:[A-Za-z0-9_-]{30,}/g, '[REDACTED_BOT_TOKEN]'],
];

/** Masks credential-shaped substrings (Anthropic keys, GitHub tokens, Bearer tokens, Telegram bot tokens). */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

const redactDeep = (v: unknown): unknown => JSON.parse(redact(JSON.stringify(v ?? null)));

export function emit(data: unknown, opts: { json: boolean; human?: (d: any) => string }): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, data: redactDeep(data) }) + '\n');
    return;
  }
  const text = opts.human ? opts.human(data) : typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (text) process.stdout.write(redact(text).replace(/\n?$/, '\n'));
}

export function toMinionsError(err: unknown): MinionsError {
  if (err instanceof MinionsError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new MinionsError('INTERNAL', msg, 'This is likely a bug; rerun with MINIONS_DEBUG=1 for a stack trace.');
}

/** Formats an error for output without exiting. Returns the exit code. */
export function reportError(err: unknown, opts: { json: boolean }): number {
  const e = toMinionsError(err);
  if (opts.json) {
    const error: Record<string, unknown> = { code: e.code, message: redact(e.message) };
    if (e.hint) error.hint = redact(e.hint);
    if (e.details !== undefined) error.details = redactDeep(e.details);
    process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
  } else {
    process.stderr.write(`error [${e.code}]: ${redact(e.message)}\n`);
    if (e.hint) process.stderr.write(`hint: ${redact(e.hint)}\n`);
  }
  if (process.env.MINIONS_DEBUG === '1' && err instanceof Error && err.stack) process.stderr.write(redact(err.stack) + '\n');
  return EXIT_CODES[e.code as ErrorCode] ?? 1;
}

/** Top-level handler: reports and exits with EXIT_CODES[code]. */
export function handleError(err: unknown, opts: { json: boolean }): never {
  process.exit(reportError(err, opts));
}
