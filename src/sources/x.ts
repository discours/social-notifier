import { SourceError, type FailureKind } from '../errors.ts';
import { requestJson } from '../http.ts';
import type { ParsedPosts, Post } from '../types.ts';
import { asString, isPlausibleTime, isRecord } from '../util.ts';
import { requireSecret, type SourceAdapter, type SourceBase, type SourceContext } from './adapter.ts';
import { collectPosts } from './parse.ts';

export const X_API = 'https://api.x.com/2';

/**
 * Аккаунт X через API v2 токеном приложения (Bearer). X берёт плату за каждый
 * прочитанный пост, поэтому радар просит только посты новее последнего
 * виденного (`since_id`): в обычный запуск ответ пустой.
 */
export interface XSource extends SourceBase {
  type: 'x';
  /** Числовой ID аккаунта (не имя): имя можно сменить, ID — нет. */
  userId: string;
  /** Имя без @ — только для красивой ссылки на пост. */
  username?: string;
}

const USER_ID = /^\d{1,20}$/;
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const POST_ID = /^\d{1,20}$/;
// Меньше пяти постов за запрос X не отдаёт, больше ста — тоже.
const MIN_RESULTS = 5;
const MAX_RESULTS = 100;

export const xAdapter: SourceAdapter<XSource> = {
  type: 'x',
  network: 'X',
  secrets: ['X_BEARER_TOKEN'],
  docs: 'docs/sources/x.md',
  probeLimit: MIN_RESULTS,
  parse(raw, base, issues) {
    const { userId, username } = raw;
    if (typeof userId !== 'string' || !USER_ID.test(userId)) {
      issues.add('userId', (t) => t.config.fields.xUserId);
      return undefined;
    }
    if (username !== undefined && (typeof username !== 'string' || !USERNAME.test(username))) {
      issues.add('username', (t) => t.config.fields.xUsername);
      return undefined;
    }
    return { ...base, type: 'x', userId, ...(username === undefined ? {} : { username }) };
  },
  fetch: fetchXPosts,
};

export async function fetchXPosts(source: XSource, ctx: SourceContext): Promise<ParsedPosts> {
  const token = requireSecret(ctx, 'X_BEARER_TOKEN');
  const url = new URL(`${X_API}/users/${source.userId}/tweets`);
  url.searchParams.set('max_results', String(Math.min(Math.max(ctx.config.fetchLimit, MIN_RESULTS), MAX_RESULTS)));
  url.searchParams.set('exclude', 'replies,retweets');
  url.searchParams.set('tweet.fields', 'created_at');
  const since = newestId(ctx.known ?? []);
  if (since) url.searchParams.set('since_id', since);
  const { status, body } = await requestJson(ctx.fetch, url.toString(), { headers: { authorization: `Bearer ${token}` } });
  return parseXTimeline(source, status, body);
}

/** Самый новый из виденных ID: у X они растут со временем, но сравниваются как числа, а не строки. */
export function newestId(ids: readonly string[]): string | undefined {
  let best: bigint | undefined;
  for (const id of ids) {
    if (!POST_ID.test(id)) continue;
    const n = BigInt(id);
    if (best === undefined || n > best) best = n;
  }
  return best === undefined ? undefined : String(best);
}

export function parseXTimeline(source: XSource, status: number, body: unknown): ParsedPosts {
  if (status >= 400) {
    const title = isRecord(body) ? asString(body.title) : undefined;
    const detail = isRecord(body) ? asString(body.detail) : undefined;
    throw new SourceError(classifyXError(status, body), `X API HTTP ${status}: ${title ?? ''}${detail ? ` — ${detail}` : ''}`, String(status));
  }
  if (!isRecord(body)) throw new SourceError('bad_response', (t) => t.errors.notObject('X API'));
  const data = body.data;
  // Без новых постов X отвечает {"meta": {"result_count": 0}} — поля data нет.
  if (data === undefined) {
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const first: unknown = errors[0];
    if (isRecord(first)) {
      // Ошибки ресурса приходят с HTTP 200: аккаунт не найден, закрыт или заблокирован.
      const detail = asString(first.detail) ?? asString(first.title);
      const kind: FailureKind = asString(first.title) === 'Not Found Error' ? 'config' : 'permission';
      throw new SourceError(kind, (t) => `X API: ${detail ?? t.errors.noDescription}`);
    }
    const meta = isRecord(body.meta) ? body.meta : undefined;
    if (meta?.result_count === 0) return { posts: [], skipped: 0 };
    throw new SourceError('bad_response', (t) => t.errors.xNoPostsNorCount);
  }
  if (!Array.isArray(data)) throw new SourceError('bad_response', (t) => t.errors.xDataNotList);
  const profile = source.username ?? 'i/web';
  return collectPosts(
    data,
    (item): Post | undefined => {
      if (!isRecord(item)) return undefined;
      const id = asString(item.id);
      const publishedAt = typeof item.created_at === 'string' ? Date.parse(item.created_at) : NaN;
      if (!id || !POST_ID.test(id) || !isPlausibleTime(publishedAt)) return undefined;
      return {
        sourceId: source.id,
        id,
        url: `https://x.com/${profile}/status/${id}`,
        publishedAt,
        text: asString(item.text) ?? '',
      };
    },
    'X',
  );
}

// Коды: https://docs.x.com/x-api/fundamentals/response-codes-and-errors
export function classifyXError(status: number, body: unknown): FailureKind {
  const type = isRecord(body) ? (asString(body.type) ?? '') : '';
  const title = isRecord(body) ? asString(body.title) : undefined;
  // Исчерпанный лимит тарифа приходит и с 429, и с 403: это оплата, а не «обращайтесь реже».
  if (/usage-capped/.test(type) || title === 'UsageCapExceeded') return 'billing';
  if (status === 401) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  if (status === 403) {
    // «client-not-enrolled» и подобные: приложение не в проекте или тариф не включает метод.
    return /client-forbidden|not-enrolled/.test(type) ? 'billing' : 'permission';
  }
  if (status === 400 || status === 404) return 'config';
  return 'http';
}
