// Telegram bot token shape. Shared by the host credential store and the in-container coordinator
// wrapper, so a value is validated before it is written to a `security -i` line or an environment.
import { MinionsError } from '../core/errors.js';

export const BOTFATHER_URL = 'https://t.me/BotFather';

/**
 * Bot API token: numeric bot id, colon, secret. A subset of the redaction pattern in core/output.ts,
 * and free of whitespace, quotes and shell metacharacters.
 */
const TELEGRAM_TOKEN = /^(\d{6,12}):[A-Za-z0-9_-]{30,64}$/;

export function checkTelegramTokenFormat(raw: string): { token: string; botId: string } {
  const token = raw.trim().replace(/^bot(?=\d)/, '');
  if (!token) throw new MinionsError('INVALID_CONFIG', 'No token entered.', 'Paste the bot token at the prompt.');
  const m = TELEGRAM_TOKEN.exec(token);
  if (!m) {
    throw new MinionsError('INVALID_CONFIG', 'That does not look like a Telegram bot token (expected <digits>:<secret>, as sent by BotFather).',
      `Create a bot with /newbot at ${BOTFATHER_URL} and copy the token it sends.`);
  }
  return { token, botId: m[1]! };
}
