import { SourceError } from '../errors.ts';
import type { InstagramSource, Post } from '../types.ts';
import { asString, isRecord, parseGraphTime } from '../util.ts';
import type { SourceContext } from './context.ts';
import { graphGet } from './meta.ts';

/**
 * Instagram читается через Graph API: сначала у страницы Facebook берётся
 * привязанный профессиональный аккаунт, затем его последние публикации
 * (посты, карусели и Reels; сторис сюда не входят).
 */
export async function fetchInstagramPosts(source: InstagramSource, ctx: SourceContext): Promise<Post[]> {
  const page = await graphGet(ctx, source.pageId, { fields: 'instagram_business_account' });
  const account = isRecord(page.instagram_business_account) ? asString(page.instagram_business_account.id) : undefined;
  if (!account) {
    throw new SourceError(
      'config',
      'к странице не привязан профессиональный аккаунт Instagram или у токена нет права instagram_basic',
    );
  }
  if (!/^\d+$/.test(account)) throw new SourceError('bad_response', 'ID аккаунта Instagram не число');
  const body = await graphGet(ctx, `${account}/media`, {
    fields: 'id,permalink,timestamp,caption',
    limit: String(ctx.config.fetchLimit),
  });
  return parseInstagramMedia(source, body);
}

export function parseInstagramMedia(source: InstagramSource, body: Record<string, unknown>): Post[] {
  const data = body.data;
  if (!Array.isArray(data)) throw new SourceError('bad_response', 'в ответе Instagram нет списка публикаций');
  const posts: Post[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    const url = asString(item.permalink);
    const publishedAt = parseGraphTime(item.timestamp);
    if (!id || !url || publishedAt === undefined) continue;
    posts.push({ sourceId: source.id, id, url, publishedAt, text: asString(item.caption) ?? '' });
  }
  return posts;
}
