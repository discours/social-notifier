import { SourceError } from '../errors.ts';
import { readText } from '../http.ts';
import type { ParsedPosts, Post } from '../types.ts';
import { isPlausibleTime } from '../util.ts';
import type { SourceAdapter, SourceBase, SourceContext } from './adapter.ts';
import { collectPosts } from './parse.ts';
import { htmlToText } from './xml.ts';

/**
 * Публичный канал Telegram. Bot API историю канала не отдаёт, поэтому посты
 * читаются со страницы предпросмотра `t.me/s/<канал>` — той, что Telegram
 * показывает в браузере без входа: ключ не нужен, бот в канал не добавляется.
 * Это разметка сайта, а не API. Если Telegram её поменяет, посты перестанут
 * разбираться, и это дойдёт до алерта, а не станет тихим «новых постов нет».
 */
export interface TelegramSource extends SourceBase {
  type: 'telegram';
  /** Публичное имя канала без @: `discoursio` у t.me/discoursio. */
  channel: string;
}

export const TME_ORIGIN = 'https://t.me';

// Имя канала уходит в путь запроса. Латиница, цифры и «_», с буквы; короче
// пяти символов бывают коллекционные имена, длиннее 32 — не бывает.
const CHANNEL = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const MESSAGE_ID = /^\d{1,12}$/;

export const telegramAdapter: SourceAdapter<TelegramSource> = {
  type: 'telegram',
  network: 'Telegram',
  secrets: [],
  docs: 'docs/sources/telegram.md',
  parse(raw, base, issues) {
    const channel = raw.channel;
    if (typeof channel === 'string' && CHANNEL.test(channel)) return { ...base, type: 'telegram', channel };
    issues.add('channel', (t) => t.config.fields.telegramChannel);
    return undefined;
  },
  fetch: fetchTelegramPosts,
};

export async function fetchTelegramPosts(source: TelegramSource, ctx: SourceContext): Promise<ParsedPosts> {
  const { status, text, url } = await readText(ctx.fetch, `${TME_ORIGIN}/s/${source.channel}`, { headers: { accept: 'text/html' } });
  if (status === 429) throw new SourceError('rate_limit', (t) => t.errors.apiHttp('t.me', status));
  if (status === 404) throw new SourceError('config', (t) => t.errors.telegramNoPreview(source.channel));
  if (status >= 400) throw new SourceError('http', (t) => t.errors.apiHttp('t.me', status));
  // Канала нет, он закрытый, или это пользователь либо бот: t.me уводит со
  // страницы предпросмотра на карточку `t.me/<имя>`, где постов нет вовсе.
  // Пустой `url` — у подделанного в тестах ответа.
  if (url !== '' && !isPreviewUrl(url)) throw new SourceError('config', (t) => t.errors.telegramNoPreview(source.channel));
  return parseChannelPage(source, text, ctx.config.fetchLimit);
}

/** Адрес после перенаправлений — всё ещё страница предпросмотра на https. */
function isPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 't.me' && url.pathname.startsWith('/s/');
  } catch {
    return false;
  }
}

/** Атрибут, с которого в разметке начинается каждое сообщение канала: `data-post="discoursio/9621"`. */
const ANCHOR = 'data-post="';
const SERVICE = 'service_message';
const DATE_LINK = 'class="tgme_widget_message_date"';
const DATETIME = 'datetime="';
const TEXT_CLASS = 'class="tgme_widget_message_text';

/**
 * Самые свежие `limit` постов страницы предпросмотра.
 *
 * Страница — чужой ввод, поэтому разбор линейный: сообщения ищутся через
 * `indexOf` с движением только вперёд, и каждое разбирается внутри своего
 * куска — от его `data-post` до следующего. Поиск внутри куска не уходит
 * дальше его конца, сколько бы мусора ни было в остальной странице.
 */
export function parseChannelPage(source: TelegramSource, html: string, limit: number): ParsedPosts {
  const anchors: number[] = [];
  for (let at = html.indexOf(ANCHOR); at !== -1; at = html.indexOf(ANCHOR, at + ANCHOR.length)) anchors.push(at);
  // Канал без единого сообщения на странице не бывает: даже у нового есть
  // служебное «канал создан». Пусто — значит, сменилась разметка.
  if (anchors.length === 0) throw new SourceError('bad_response', (t) => t.errors.telegramNoPosts);

  const messages: string[] = [];
  anchors.forEach((at, i) => {
    // Открывающий тег сообщения — от последнего «<» перед его data-post: там класс.
    const before = html.slice(anchors[i - 1] ?? 0, at);
    const tag = before.slice(Math.max(before.lastIndexOf('<'), 0));
    // Служебное сообщение («канал создан», «закреплено …») — не пост канала.
    if (tag.includes(SERVICE)) return;
    messages.push(html.slice(at, anchors[i + 1] ?? html.length));
  });
  const { posts, skipped } = collectPosts(messages, (message) => parseMessage(source, message), 'Telegram');
  // Страница идёт от старых к новым, но порядок здесь не важен: время у каждого поста своё.
  return { posts: posts.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, limit), skipped };
}

function parseMessage(source: TelegramSource, message: string): Post | undefined {
  const end = message.indexOf('"', ANCHOR.length);
  if (end === -1 || end - ANCHOR.length > 64) return undefined;
  const [name = '', id = '', ...rest] = message.slice(ANCHOR.length, end).split('/');
  // Сообщение другого канала на странице этого — не наш пост, а сбой разбора.
  if (rest.length > 0 || !CHANNEL.test(name) || name.toLowerCase() !== source.channel.toLowerCase() || !MESSAGE_ID.test(id)) {
    return undefined;
  }
  const publishedAt = messageTime(message);
  if (publishedAt === undefined) return undefined;
  // Ссылка строится из проверенных частей, а не берётся из разметки.
  return { sourceId: source.id, id, url: `${TME_ORIGIN}/${name}/${id}`, publishedAt, text: messageText(message) };
}

/** Время публикации из ссылки-даты в подвале сообщения; у правленого поста — исходное. */
function messageTime(message: string): number | undefined {
  const link = message.indexOf(DATE_LINK);
  if (link === -1) return undefined;
  const start = message.indexOf(DATETIME, link + DATE_LINK.length);
  if (start === -1) return undefined;
  const end = message.indexOf('"', start + DATETIME.length);
  if (end === -1 || end - start > 64) return undefined;
  const ms = Date.parse(message.slice(start + DATETIME.length, end));
  return isPlausibleTime(ms) ? ms : undefined;
}

/**
 * Текст поста простым текстом; у поста из одних картинок — пустая строка.
 * Берётся до первого `</div>`: внутри текста Telegram ставит только строчные
 * теги, а сообщению радара нужна лишь первая строка.
 */
function messageText(message: string): string {
  let at = message.indexOf(TEXT_CLASS);
  // Класс ровно этот, а не начинающийся с него: следующий символ — пробел или кавычка.
  while (at !== -1 && message[at + TEXT_CLASS.length] !== ' ' && message[at + TEXT_CLASS.length] !== '"') {
    at = message.indexOf(TEXT_CLASS, at + TEXT_CLASS.length);
  }
  if (at === -1) return '';
  const open = message.indexOf('>', at + TEXT_CLASS.length);
  if (open === -1) return '';
  const close = message.indexOf('</div>', open + 1);
  return htmlToText(message.slice(open + 1, close === -1 ? message.length : close));
}
