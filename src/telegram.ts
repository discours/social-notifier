import type { OutgoingMessage } from './format.ts';
import { requestJson, type FetchLike } from './http.ts';
import { LocalizedError, type Phrase } from './i18n/index.ts';
import { asString, isRecord } from './util.ts';

export class TelegramError extends LocalizedError {
  /** HTTP-статус ответа Telegram, если он ответил. */
  readonly status: number | undefined;

  constructor(message: Phrase | string, status?: number) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
  }
}

const MAX_RETRY_AFTER_S = 30;

function botUrl(token: string, method: string): string {
  // Bot API требует токен в пути URL. Поэтому URL не попадает ни в логи,
  // ни в тексты ошибок (см. requestJson).
  return `https://api.telegram.org/bot${token}/${method}`;
}

function httpError(status: number, body: unknown): TelegramError {
  const description = isRecord(body) ? asString(body.description) : undefined;
  return new TelegramError((t) => t.telegram.httpError(status, description), status);
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
    throw httpError(status, body);
  }
}

/** Вызов метода Bot API; ошибка Telegram — исключение. Результат — как прислал Telegram. */
async function callBotRaw(
  fetchFn: FetchLike,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ status: number; result: unknown }> {
  const { status, body } = await requestJson(fetchFn, botUrl(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (isRecord(body) && body.ok === true && 'result' in body) return { status, result: body.result };
  throw httpError(status, body);
}

/** Вызов метода Bot API, который возвращает объект. */
async function callBot(
  fetchFn: FetchLike,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { status, result } = await callBotRaw(fetchFn, token, method, params);
  if (isRecord(result)) return result;
  throw httpError(status, undefined);
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
    throw new TelegramError((t) => t.telegram.noBotIdentity);
  }
  return { id, username };
}

export interface ChatAccess {
  /** Тип чата по Bot API: private, group, supergroup, channel; undefined — Telegram не сказал. */
  type: string | undefined;
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
  const type = asString(chat.type);
  if (type === 'private') return { type };
  const member = await callBot(fetchFn, token, 'getChatMember', { chat_id: chatId, user_id: botId });
  const status = asString(member.status);
  const defaults = isRecord(chat.permissions) ? chat.permissions : {};
  return {
    type,
    ...(status === undefined ? {} : { status }),
    canPost: botCanPost(type ?? '', status ?? '', member, defaults),
  };
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

/** Чат, о котором бот узнал из обновлений: ID и тип по Bot API. */
export interface FoundChat {
  id: string;
  type: string | undefined;
}

/** Больше чатов поиск не отвечает: сообщение с ID уходит в каждый, и это не рассылка. */
export const MAX_FOUND_CHATS = 10;
const CHAT_TYPE = /^[a-z_]{1,20}$/;
/** Обновления, в которых есть чат; в каждом — поле с объектом `chat`. */
const CHAT_UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member'] as const;

/**
 * Чаты из последних обновлений бота: группы и каналы, куда его добавили, и
 * личные чаты людей, написавших ему. Так человек узнаёт ID чата, не читая
 * ответ Bot API руками. getUpdates вызывается без `offset` и `allowed_updates`:
 * обновления не подтверждаются и остаются в очереди, а подписка бота на типы
 * обновлений не меняется. Чат, откуда бота убрали, не возвращается.
 * Возвращает до MAX_FOUND_CHATS чатов, последние по времени обновления.
 * Бот с webhook отвечает HTTP 409 — исключение TelegramError со статусом 409.
 */
export async function findRecentChats(fetchFn: FetchLike, token: string): Promise<FoundChat[]> {
  const { status, result } = await callBotRaw(fetchFn, token, 'getUpdates', { timeout: 0, limit: 100 });
  if (!Array.isArray(result)) throw httpError(status, undefined);
  // Повторное упоминание переносит чат в конец: порядок — по последнему обновлению.
  const chats = new Map<string, FoundChat & { removed: boolean }>();
  for (const update of result) {
    if (!isRecord(update)) continue;
    const field = CHAT_UPDATES.find((name) => isRecord(update[name]));
    const item = field ? update[field] : undefined;
    const chat = isRecord(item) && isRecord(item.chat) ? item.chat : undefined;
    if (!chat || typeof chat.id !== 'number' || !Number.isSafeInteger(chat.id)) continue;
    const id = String(chat.id);
    const rawType = asString(chat.type);
    const type = rawType !== undefined && CHAT_TYPE.test(rawType) ? rawType : undefined;
    const member = field === 'my_chat_member' && isRecord(item) && isRecord(item.new_chat_member) ? item.new_chat_member : undefined;
    const removed = member !== undefined && (member.status === 'left' || member.status === 'kicked');
    chats.delete(id);
    chats.set(id, { id, type, removed });
  }
  return [...chats.values()]
    .filter((chat) => !chat.removed)
    .slice(-MAX_FOUND_CHATS)
    .map(({ id, type }) => ({ id, type }));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
