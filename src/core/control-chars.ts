// Terminal-safe text: strips ANSI/terminal escape sequences (CSI, OSC, DCS/SOS/PM/APC strings, two-byte
// ESC sequences, and their 8-bit C1 forms) and other control characters from text that came from
// somewhere else (container output, agent-influenced strings) before the host writes it to the user's
// terminal. Newline and tab are kept. One state machine serves whole strings and split streams.
import { StringDecoder } from 'node:string_decoder';

const ESC = '\x1b';
const BEL = '\x07';
/** 8-bit C1 introducers of control strings: DCS, SOS, OSC, PM, APC (terminated by BEL or ST). */
const C1_STRING = new Set(['\x90', '\x98', '\x9d', '\x9e', '\x9f']);
/** ESC-prefixed introducers of control strings: DCS (P), SOS (X), OSC (]), PM (^), APC (_). */
const ESC_STRING = new Set(['P', 'X', ']', '^', '_']);
/** An unterminated control string stops swallowing output after this many characters. */
export const MAX_CONTROL_STRING = 4096;

type State = 'text' | 'esc' | 'csi' | 'str' | 'strEsc';

export interface ControlStripper {
  /** Sanitized text for `chunk`; an escape sequence split across chunks is held until it completes. */
  push(chunk: string | Buffer): string;
  /** Flushes the decoder; an incomplete trailing escape sequence is dropped. */
  end(): string;
}

/**
 * Stateful stripper. `keepControls` removes only escape sequences and leaves single control characters
 * (C0, DEL) in place, for callers that interpret them (secret entry reads backspace, Ctrl-C, Enter).
 */
export function createControlStripper(opts: { keepControls?: boolean } = {}): ControlStripper {
  const decoder = new StringDecoder('utf8');
  let state: State = 'text';
  let strLen = 0;
  const isDroppedControl = (c: number) => !opts.keepControls && c !== 0x0a && c !== 0x09 && (c < 0x20 || (c >= 0x7f && c <= 0x9f));

  const feed = (s: string): string => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      const c = ch.charCodeAt(0);
      switch (state) {
        case 'text':
          if (ch === ESC) state = 'esc';
          else if (ch === '\x9b') state = 'csi';
          else if (C1_STRING.has(ch)) { state = 'str'; strLen = 0; }
          else if (!isDroppedControl(c)) out += ch;
          break;
        case 'esc':
          if (ch === '[') state = 'csi';
          else if (ESC_STRING.has(ch)) { state = 'str'; strLen = 0; }
          else if (c >= 0x20 && c <= 0x2f) { /* intermediate byte (e.g. ESC ( B): wait for the final byte */ }
          else if (c >= 0x30 && c <= 0x7e) state = 'text'; // final byte: two-byte sequence consumed
          else { state = 'text'; i--; } // not a sequence: drop the ESC, handle this char as text
          break;
        case 'csi':
          if (c >= 0x20 && c <= 0x3f) { /* parameter / intermediate bytes */ }
          else if (c >= 0x40 && c <= 0x7e) state = 'text'; // final byte
          else { state = 'text'; i--; } // malformed: abort the sequence, handle this char as text
          break;
        case 'str':
          if (ch === BEL || ch === '\x9c') state = 'text';
          else if (ch === ESC) state = 'strEsc';
          else if (++strLen > MAX_CONTROL_STRING) { state = 'text'; i--; }
          break;
        case 'strEsc':
          if (ch === '\\') state = 'text'; // ST
          else { state = 'esc'; i--; } // ESC ends the string and starts a new sequence
          break;
      }
    }
    return out;
  };

  return {
    push: (chunk) => feed(typeof chunk === 'string' ? chunk : decoder.write(chunk)),
    end: () => { const out = feed(decoder.end()); state = 'text'; return out; },
  };
}

/** `s` with terminal escape sequences and control characters other than newline and tab removed. */
export function stripControlChars(s: string): string {
  const st = createControlStripper();
  return st.push(s) + st.end();
}

/** `s` with terminal escape sequences removed; single control characters are kept. */
export function stripTerminalEscapes(s: string): string {
  const st = createControlStripper({ keepControls: true });
  return st.push(s) + st.end();
}

/** Relays `from` to `to` through a control-character stripper (stream end flushes; `to` is not ended). */
export function relayStripped(from: NodeJS.ReadableStream, to: Pick<NodeJS.WritableStream, 'write'>): void {
  const st = createControlStripper();
  from.on('data', (chunk: Buffer | string) => { const s = st.push(chunk); if (s) to.write(s); });
  from.on('end', () => { const s = st.end(); if (s) to.write(s); });
}

/**
 * Unicode format and invisible characters: general category Cf (bidi embeddings/overrides/isolates, zero-width
 * space/joiners, BOM, ...), tag characters (U+E0000..U+E007F, including unassigned ones) and the line/paragraph
 * separators. They are not terminal escapes, but they reorder or hide what the user reads.
 */
export const FORMAT_CHAR = /[\p{Cf}\u2028\u2029\u{E0000}-\u{E007F}]/u;
const FORMAT_CHARS_G = new RegExp(FORMAT_CHAR.source, 'gu');

/** `s` with every Unicode format/invisible character replaced by a visible `<U+XXXX>` marker. */
export function escapeFormatChars(s: string): string {
  return s.replace(FORMAT_CHARS_G, (ch) => `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
}

/** Text that came from an untrusted source, made safe to show: control characters stripped, format characters escaped. */
export function displayText(s: string): string {
  return escapeFormatChars(stripControlChars(s));
}

/**
 * `s` cut to at most `max` UTF-16 code units without splitting a surrogate pair: if the cut would leave a lone high
 * surrogate at the end, that unit is dropped too. The result is well formed whenever `s` is (no half of an emoji that a
 * strict UTF-8 consumer such as the Telegram Bot API could reject).
 */
export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  const n = Math.max(0, Math.floor(max));
  const code = n > 0 ? s.charCodeAt(n - 1) : 0;
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}
