import { SourceError } from '../errors.ts';
import type { FacebookSource, Post } from '../types.ts';
import { asString, isRecord, parseGraphTime } from '../util.ts';
import type { SourceContext } from './context.ts';
import { graphGet } from './meta.ts';

/**
 * Посты страницы читаются токеном страницы: Graph API выдаёт его в обмен на
 * токен пользователя, у которого есть задача на этой странице. Токен страницы
 * живёт только в памяти запуска и, как и META_TOKEN, уходит лишь в заголовке;
 * в тексты ошибок он не попадёт — редактор вычищает любые длинные токены.
 */
export async function fetchFacebookPosts(source: FacebookSource, ctx: SourceContext): Promise<Post[]> {
  const page = await graphGet(ctx, source.pageId, { fields: 'access_token' });
  const pageToken = asString(page.access_token);
  if (!pageToken) {
    throw new SourceError(
      'permission',
      `Graph API не выдал токен страницы ${source.pageId}: страница не назначена владельцу META_TOKEN`,
    );
  }
  const body = await graphGet(
    ctx,
    `${source.pageId}/posts`,
    { fields: 'id,permalink_url,created_time,message', limit: String(ctx.config.fetchLimit) },
    pageToken,
  );
  return parseFacebookPosts(source, body);
}

export function parseFacebookPosts(source: FacebookSource, body: Record<string, unknown>): Post[] {
  const data = body.data;
  if (!Array.isArray(data)) throw new SourceError('bad_response', 'в ответе Facebook нет списка постов');
  const posts: Post[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    const publishedAt = parseGraphTime(item.created_time);
    if (!id || publishedAt === undefined) continue;
    posts.push({
      sourceId: source.id,
      id,
      url: asString(item.permalink_url) ?? `https://www.facebook.com/${id}`,
      publishedAt,
      text: asString(item.message) ?? '',
    });
  }
  return posts;
}
