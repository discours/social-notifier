import { createHash } from 'node:crypto';
import { SourceError } from '../errors.ts';
import { readText } from '../http.ts';
import type { ParsedPosts, Post } from '../types.ts';
import { httpUrl, isPlausibleTime, MAX_URL_LENGTH } from '../util.ts';
import type { SourceAdapter, SourceBase, SourceContext } from './adapter.ts';
import { collectPosts } from './parse.ts';
import {
  blocks,
  childElement,
  childText,
  htmlToText,
  normalizeXml,
  plainText,
  removeElements,
  rootElement,
  tagAttributes,
  textContent,
  type XmlElement,
} from './xml.ts';

/**
 * Лента RSS 2.0 или Atom 1.0: Mastodon (`https://mastodon.social/@имя.rss`),
 * Substack, блоги, подкасты — всё, что отдаёт ленту по открытому адресу.
 */
export interface FeedSource extends SourceBase {
  type: 'feed';
  /** Адрес ленты, только https. */
  url: string;
}

/** ID записи длиннее этого заменяется хэшем: он хранится в состоянии и пишется в лог. */
const MAX_ID_LENGTH = 200;

export const feedAdapter: SourceAdapter<FeedSource> = {
  type: 'feed',
  network: 'RSS/Atom',
  secrets: [],
  docs: 'docs/sources/feed.md',
  parse(raw, base, issues) {
    const url = feedUrl(raw.url);
    if (!url) {
      issues.add('url', 'адрес ленты: https://…, без логина и пароля в адресе');
      return undefined;
    }
    return { ...base, type: 'feed', url };
  },
  fetch: fetchFeedPosts,
};

/**
 * Адрес ленты лежит в публичном конфиге и уходит в запрос как есть, поэтому
 * только https и без учётных данных: логин в адресе увидели бы все.
 */
export function feedUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
  return url.href;
}

export async function fetchFeedPosts(source: FeedSource, ctx: SourceContext): Promise<ParsedPosts> {
  const { status, text, url } = await readText(ctx.fetch, source.url, {
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' },
  });
  // fetch идёт за перенаправлением и на http: тогда ленту мог подменить кто угодно по пути.
  if (url !== '' && !url.startsWith('https:')) throw new SourceError('config', 'лента перенаправила на адрес без https');
  if (status === 429) throw new SourceError('rate_limit', `лента ответила HTTP 429`);
  if (status === 401 || status === 403) throw new SourceError('permission', `лента ответила HTTP ${status}`);
  if (status === 404 || status === 410) throw new SourceError('config', `лента не найдена (HTTP ${status})`);
  if (status >= 400) throw new SourceError('http', `лента ответила HTTP ${status}`);
  return parseFeed(source, text, ctx.config.fetchLimit, ctx.notBefore);
}

/** Запись ленты: пост, если разобралась, и время, если оно нашлось. */
interface Entry {
  post?: Post;
  publishedAt?: number;
}

/**
 * Самые свежие `limit` записей ленты. Лента бывает длиннее и упорядочена как
 * угодно, а радар помнит ограниченное число ID: сотни старых записей вытеснили
 * бы из памяти уже отправленные посты, и те пришли бы снова.
 */
export function parseFeed(source: SourceBase, xml: string, limit: number, notBefore = -Infinity): ParsedPosts {
  const doc = normalizeXml(xml);
  const root = rootElement(doc);
  const isAtom = root === 'feed';
  if (!isAtom && root !== 'rss' && root !== 'rdf:RDF') throw new SourceError('bad_response', 'по адресу ленты не RSS и не Atom');
  const found = blocks(doc, isAtom ? 'entry' : 'item');
  if (found.length === 0 && PREFIXED_ENTRY.test(doc)) {
    // Иначе такая лента навсегда выглядела бы как «новых постов нет».
    throw new SourceError('bad_response', 'записи ленты с префиксом пространства имён (например, rss:item) не поддерживаются');
  }
  // `<source>` в записи Atom описывает ленту-первоисточник со своими id и ссылкой.
  const entries = found.map((block) => (isAtom ? atomEntry(source, removeElements(block, 'source')) : rssItem(source, block)));
  const { posts } = collectPosts(entries, (entry) => entry.post, 'Лента');
  const newest = posts.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, limit);
  // Неразобранная запись — сбой, только если из-за неё мог потеряться пост:
  // она не старше `notBefore` и попала бы в `limit` свежих. Запись без даты —
  // если стоит среди `limit` записей со стороны новых: обычно это начало
  // ленты, но бывают ленты от старых к новым, и тогда это конец.
  // Иначе одна старая битая запись давала бы алерт раз в сутки, пока она в ленте.
  const oldestKept = newest.length === limit ? (newest.at(-1)?.publishedAt ?? -Infinity) : -Infinity;
  const threshold = Math.max(oldestKept, notBefore);
  const newestAtEnd = isOldestFirst(entries);
  const amongNewest = (i: number) => (newestAtEnd ? i >= entries.length - limit : i < limit);
  const skipped = entries.filter((e, i) => !e.post && (e.publishedAt === undefined ? amongNewest(i) : e.publishedAt >= threshold)).length;
  return { posts: newest, skipped };
}

/** Лента идёт от старых к новым: первая запись с датой старше последней. */
function isOldestFirst(entries: readonly Entry[]): boolean {
  const first = entries.find((e) => e.publishedAt !== undefined)?.publishedAt;
  const last = entries.findLast((e) => e.publishedAt !== undefined)?.publishedAt;
  return first !== undefined && last !== undefined && first < last;
}

const PREFIXED_ENTRY = /<[A-Za-z_][\w.-]*:(?:item|entry)[\s>/]/;

function rssItem(source: SourceBase, item: string): Entry {
  const publishedAt = feedTime(childText(item, 'pubDate') ?? childText(item, 'dc:date'));
  const guid = childText(item, 'guid');
  // Ссылка — `<link>`, затем `<guid>` с адресом (isPermaLink по умолчанию true),
  // затем файл выпуска из `<enclosure>`: у подкастов `<link>` часто нет.
  const url = httpUrl(childText(item, 'link')) ?? httpUrl(guid) ?? httpUrl(tagAttributes(item, 'enclosure')[0]?.url);
  const id = entryId(guid || url);
  if (!url || !id || publishedAt === undefined) return { publishedAt };
  // В RSS заголовок — простой текст, описание — HTML. У Mastodon заголовка нет.
  const text = plainText(childText(item, 'title') ?? '') || htmlToText(childText(item, 'description') ?? '');
  return { publishedAt, post: { sourceId: source.id, id, url, publishedAt, text } };
}

function atomEntry(source: SourceBase, entry: string): Entry {
  const links = tagAttributes(entry, 'link');
  const alternate = links.find((a) => a.rel === undefined || a.rel === 'alternate');
  const url = httpUrl(alternate?.href);
  const publishedAt = feedTime(childText(entry, 'published') ?? childText(entry, 'updated'));
  const id = entryId(childText(entry, 'id') || url);
  if (!url || !id || publishedAt === undefined) return { publishedAt };
  let text = '';
  for (const tag of ['title', 'summary', 'content']) {
    const element = childElement(entry, tag);
    text = element ? atomText(element) : '';
    if (text !== '') break;
  }
  return { publishedAt, post: { sourceId: source.id, id, url, publishedAt, text } };
}

/**
 * Текст Atom по атрибуту `type`: `text` (по умолчанию), `html` или `xhtml`.
 * У `<content>` там может стоять и MIME-тип: `text/html`, `text/plain`.
 */
function atomText(element: XmlElement): string {
  const type = (element.attrs.type ?? 'text').toLowerCase();
  if (type === 'html' || type === 'text/html') return htmlToText(textContent(element.inner));
  if (type === 'xhtml' || type === 'application/xhtml+xml') return htmlToText(element.inner);
  if (type === 'text' || type.startsWith('text/')) return plainText(textContent(element.inner));
  // Прочие MIME-типы (картинка, base64) — не текст поста.
  return '';
}

function entryId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.length <= MAX_ID_LENGTH) return raw;
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

/** RFC 822 (`Sun, 08 Nov 2026 05:31:11 +0000`) у RSS, ISO 8601 у Atom; оба понимает Date.parse. */
function feedTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return isPlausibleTime(ms) ? ms : undefined;
}
