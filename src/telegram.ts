import type { OutgoingMessage } from './format.ts';
import { requestJson, type FetchLike } from './http.ts';
import { asString, isRecord } from './util.ts';

export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramError';
  }
}

const MAX_RETRY_AFTER_S = 30;

function botUrl(token: string, method: string): string {
  // Bot API требует токен в пути URL. Поэтому URL не попадает ни в логи,
  // ни в тексты ошибок (см. requestJson).
  return `https://api.telegram.org/bot${token}/${method}`;
}

export async function sendTelegramMessage(
  fetchFn: FetchLike,
  token: string,
  chatId: string,
  message: OutgoingMessage,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  const payload = JSON.stringify({
    chat_id: chatId,
    text: message.html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: message.disablePreview },
  });
  for (let attempt = 1; ; attempt += 1) {
    const { status, body } = await requestJson(fetchFn, botUrl(token, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    if (isRecord(body) && body.ok === true) return;

    const retryAfter = isRecord(body) && isRecord(body.parameters) ? Number(body.parameters.retry_after) : NaN;
    if (status === 429 && attempt === 1 && retryAfter > 0 && retryAfter <= MAX_RETRY_AFTER_S) {
      await sleep(retryAfter * 1000);
      continue;
    }
    const description = isRecord(body) ? asString(body.description) : undefined;
    throw new TelegramError(`Telegram ответил HTTP ${status}: ${description ?? 'без описания'}`);
  }
}

/** Имя бота по токену: проверка, что токен рабочий. */
export async function getBotUsername(fetchFn: FetchLike, token: string): Promise<string> {
  const { status, body } = await requestJson(fetchFn, botUrl(token, 'getMe'));
  const result = isRecord(body) && body.ok === true && isRecord(body.result) ? body.result : undefined;
  const username = result ? asString(result.username) : undefined;
  if (!username) {
    const description = isRecord(body) ? asString(body.description) : undefined;
    throw new TelegramError(`Telegram ответил HTTP ${status}: ${description ?? 'без описания'}`);
  }
  return username;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
