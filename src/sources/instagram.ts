import { SourceError } from '../errors.ts';
import type { ParsedPosts, Post } from '../types.ts';
import { asString, httpUrl, isRecord, parseGraphTime } from '../util.ts';
import type { SourceAdapter, SourceContext } from './adapter.ts';
import { graphGet, parsePageId, type MetaPageSource } from './meta.ts';
import { collectPosts } from './parse.ts';

/** Профессиональный аккаунт Instagram; `pageId` — страница Facebook, к которой он привязан. */
export interface InstagramSource extends MetaPageSource {
  type: 'instagram';
}

export const instagramAdapter: SourceAdapter<InstagramSource> = {
  type: 'instagram',
  network: 'Instagram',
  secrets: ['META_TOKEN'],
  docs: 'docs/sources/meta.md',
  parse(raw, base, issues) {
    const pageId = parsePageId(raw, issues);
    return pageId === undefined ? undefined : { ...base, type: 'instagram', pageId };
  },
  fetch: fetchInstagramPosts,
};

/**
 * Instagram читается через Graph API: сначала у страницы Facebook берётся
 * привязанный профессиональный аккаунт, затем его последние публикации
 * (посты, карусели и Reels; сторис сюда не входят).
 */
export async function fetchInstagramPosts(source: InstagramSource, ctx: SourceContext): Promise<ParsedPosts> {
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
    fields: 'id,permalink,shortcode,timestamp,caption',
    limit: String(ctx.config.fetchLimit),
  });
  return parseInstagramMedia(source, body);
}

/** Ссылка на публикацию: permalink, а если Graph API его не отдал — по shortcode. */
function mediaUrl(item: Record<string, unknown>): string | undefined {
  const permalink = httpUrl(item.permalink);
  if (permalink) return permalink;
  const shortcode = asString(item.shortcode);
  return shortcode && /^[A-Za-z0-9_-]+$/.test(shortcode) ? `https://www.instagram.com/p/${shortcode}/` : undefined;
}

export function parseInstagramMedia(source: InstagramSource, body: Record<string, unknown>): ParsedPosts {
  const data = body.data;
  if (!Array.isArray(data)) throw new SourceError('bad_response', 'в ответе Instagram нет списка публикаций');
  return collectPosts(
    data,
    (item): Post | undefined => {
      if (!isRecord(item)) return undefined;
      const id = asString(item.id);
      const url = mediaUrl(item);
      const publishedAt = parseGraphTime(item.timestamp);
      if (!id || !/^\d+$/.test(id) || !url || publishedAt === undefined) return undefined;
      return { sourceId: source.id, id, url, publishedAt, text: asString(item.caption) ?? '' };
    },
    'Instagram',
  );
}
