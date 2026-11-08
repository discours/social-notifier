import { SourceError, type FailureKind } from '../errors.ts';
import { requestJson } from '../http.ts';
import type { ParsedPosts, Post } from '../types.ts';
import { asString, isPlausibleTime, isRecord } from '../util.ts';
import type { SourceAdapter, SourceBase, SourceContext } from './adapter.ts';
import { collectPosts } from './parse.ts';

/** Публичный AppView Bluesky: читает открытые профили без входа и ключа. */
export const BLUESKY_FEED_URL = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';

export interface BlueskySource extends SourceBase {
  type: 'bluesky';
  /** Хэндл (`discours.bsky.social`, `example.com`) или DID (`did:plc:…`). */
  handle: string;
}

// Синтаксис хэндла и DID из спецификации AT Protocol.
const HANDLE = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const DID = /^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/;
const RKEY = /^[a-zA-Z0-9._~:-]{1,512}$/;
const REPOST = 'app.bsky.feed.defs#reasonRepost';

export const blueskyAdapter: SourceAdapter<BlueskySource> = {
  type: 'bluesky',
  network: 'Bluesky',
  secrets: [],
  docs: 'docs/sources/bluesky.md',
  parse(raw, base, issues) {
    const handle = raw.handle;
    if (typeof handle !== 'string' || handle.length > 253 || !(HANDLE.test(handle) || DID.test(handle))) {
      issues.add('handle', (t) => t.config.fields.blueskyHandle);
      return undefined;
    }
    return { ...base, type: 'bluesky', handle };
  },
  fetch: fetchBlueskyPosts,
};

export async function fetchBlueskyPosts(source: BlueskySource, ctx: SourceContext): Promise<ParsedPosts> {
  const url = new URL(BLUESKY_FEED_URL);
  url.searchParams.set('actor', source.handle);
  // Ответы другим и продолжения своих тредов не нужны: тред — одно уведомление.
  url.searchParams.set('filter', 'posts_no_replies');
  url.searchParams.set('limit', String(ctx.config.fetchLimit));
  const { status, body } = await requestJson(ctx.fetch, url.toString(), { headers: { accept: 'application/json' } });
  return parseBlueskyFeed(source, status, body);
}

export function parseBlueskyFeed(source: BlueskySource, status: number, body: unknown): ParsedPosts {
  if (status >= 400 || (isRecord(body) && typeof body.error === 'string')) {
    const code = isRecord(body) ? asString(body.error) : undefined;
    const message = isRecord(body) ? asString(body.message) : undefined;
    throw new SourceError(
      classifyBlueskyError(status, code, message),
      (t) => `Bluesky ${code ?? `HTTP ${status}`}: ${message ?? t.errors.noDescription}`,
      code,
    );
  }
  const feed = isRecord(body) ? body.feed : undefined;
  if (!Array.isArray(feed)) throw new SourceError('bad_response', (t) => t.errors.blueskyNoFeed);
  // Репост — чужой пост в ленте профиля: не наш и не повод звать на лайк.
  const own = feed.filter((item) => !(isRecord(item) && isRecord(item.reason) && item.reason.$type === REPOST));
  return collectPosts(own, (item) => parseItem(source, item), 'Bluesky');
}

function parseItem(source: BlueskySource, item: unknown): Post | undefined {
  if (!isRecord(item) || !isRecord(item.post)) return undefined;
  const { post } = item;
  const uri = asString(post.uri);
  const author = isRecord(post.author) ? post.author : undefined;
  const did = author ? asString(author.did) : undefined;
  const record = isRecord(post.record) ? post.record : undefined;
  if (!uri || !did || !DID.test(did) || !record) return undefined;
  // at://did:plc:…/app.bsky.feed.post/<rkey>
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  const rkey = match?.[2];
  if (!match || match[1] !== did || !rkey || !RKEY.test(rkey)) return undefined;
  const publishedAt = postTime(record.createdAt, post.indexedAt);
  if (publishedAt === undefined) return undefined;
  const handle = author ? asString(author.handle) : undefined;
  // `handle.invalid` AppView ставит, когда хэндл не подтверждён: ссылка с ним не откроется.
  const profile = handle && handle !== 'handle.invalid' && HANDLE.test(handle) ? handle : did;
  return {
    sourceId: source.id,
    id: rkey,
    url: `https://bsky.app/profile/${profile}/post/${rkey}`,
    publishedAt,
    text: asString(record.text) ?? '',
  };
}

/**
 * `createdAt` пишет клиент, `indexedAt` — сервер. Берётся меньшее: пост с
 * датой из будущего не застрянет в очереди, а импортированный архив со старой
 * датой уйдёт в архив радара, а не в группу.
 */
function postTime(createdAt: unknown, indexedAt: unknown): number | undefined {
  const times = [createdAt, indexedAt]
    .map((v) => (typeof v === 'string' ? Date.parse(v) : NaN))
    .filter((ms) => isPlausibleTime(ms));
  return times.length > 0 ? Math.min(...times) : undefined;
}

// Коды ошибок — из lexicon app.bsky.feed.getAuthorFeed; «Profile not found» приходит как 400 InvalidRequest.
export function classifyBlueskyError(status: number, code: string | undefined, message: string | undefined): FailureKind {
  if (status === 429 || code === 'RateLimitExceeded') return 'rate_limit';
  if (code === 'BlockedActor' || code === 'BlockedByActor' || /takedown|deactivated|suspended/i.test(message ?? '')) {
    return 'permission';
  }
  if (status === 400 && code === 'InvalidRequest') return 'config';
  if (status === 401 || status === 403) return 'permission';
  return 'http';
}
