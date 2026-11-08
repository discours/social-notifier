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

/** Вызов метода Bot API, который возвращает объект; ошибка Telegram — исключение. */
async function callBot(
  fetchFn: FetchLike,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { status, body } = await requestJson(fetchFn, botUrl(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (isRecord(body) && body.ok === true && isRecord(body.result)) return body.result;
  const description = isRecord(body) ? asString(body.description) : undefined;
  throw new TelegramError(`Telegram ответил HTTP ${status}: ${description ?? 'без описания'}`);
}

export interface BotIdentity {
  id: number;
  username: string;
}

/** Кто бот по токену: проверка, что токен рабочий. */
export async function getBotIdentity(fetchFn: FetchLike, token: string): Promise<BotIdentity> {
  const result = await callBot(fetchFn, token, 'getMe');
  const id = result.id;
  const username = asString(result.username);
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || !username) {
    throw new TelegramError('Telegram не вернул id и имя бота');
  }
  return { id, username };
}

export interface ChatAccess {
  /** Тип чата по Bot API: private, group, supergroup, channel. */
  type: string;
  /** Статус бота в чате; у личного чата его нет. */
  status?: string;
  /** Может ли бот писать; у личного чата не проверить — поля нет. */
  canPost?: boolean;
}

/**
 * Может ли бот писать в чат — без отправки сообщения: пробное сообщение в чат
 * группы увидели бы все участники. Чат, которого бот не видит, — исключение
 * TelegramError («chat not found»).
 *
 * У личного чата права не проверить: getChat отвечает, если человек запускал
 * бота, но не говорит, не заблокирован ли бот. Это проверяет только отправка
 * (проба с флагом --send-test).
 */
export async function checkChatAccess(
  fetchFn: FetchLike,
  token: string,
  chatId: string,
  botId: number,
): Promise<ChatAccess> {
  const chat = await callBot(fetchFn, token, 'getChat', { chat_id: chatId });
  const type = asString(chat.type) ?? 'неизвестный';
  if (type === 'private') return { type };
  const member = await callBot(fetchFn, token, 'getChatMember', { chat_id: chatId, user_id: botId });
  const status = asString(member.status) ?? 'неизвестный';
  const defaults = isRecord(chat.permissions) ? chat.permissions : {};
  return { type, status, canPost: botCanPost(type, status, member, defaults) };
}

/**
 * Правила Bot API: в канал пишет только администратор с правом публикации;
 * в группе администратор пишет всегда, обычный участник — если это не
 * запрещено участникам по умолчанию, ограниченный — если ему оставили право
 * писать и оно не запрещено всем участникам: документация не говорит, учтены
 * ли права по умолчанию в его собственных, поэтому требуются оба.
 * Вышедший или исключённый бот не пишет никуда.
 */
export function botCanPost(
  type: string,
  status: string,
  member: Record<string, unknown>,
  chatDefaults: Record<string, unknown>,
): boolean {
  if (status === 'creator') return true;
  if (type === 'channel') return status === 'administrator' && member.can_post_messages === true;
  if (status === 'administrator') return true;
  if (status === 'member') return chatDefaults.can_send_messages !== false;
  if (status === 'restricted') {
    return member.is_member === true && member.can_send_messages === true && chatDefaults.can_send_messages !== false;
  }
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
