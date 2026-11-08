import { SourceError, type FailureKind } from '../errors.ts';
import { requestJson } from '../http.ts';
import type { ParsedPosts, Post } from '../types.ts';
import { asString, isPlausibleTime, isRecord } from '../util.ts';
import { requireSecret, type SourceAdapter, type SourceBase, type SourceContext } from './adapter.ts';
import { collectPosts } from './parse.ts';

export const VK_WALL_GET_URL = 'https://api.vk.com/method/wall.get';

export interface VkSource extends SourceBase {
  type: 'vk';
  /** ID стены. У сообщества он отрицательный: -89236419. */
  ownerId: number;
}

export const vkAdapter: SourceAdapter<VkSource> = {
  type: 'vk',
  network: 'VK',
  secrets: ['VK_TOKEN'],
  docs: 'docs/sources/vk.md',
  parse(raw, base, issues) {
    const ownerId = raw.ownerId;
    if (typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId) || ownerId === 0) {
      issues.add('ownerId', (t) => t.config.fields.vkOwnerId);
      return undefined;
    }
    return { ...base, type: 'vk', ownerId };
  },
  fetch: fetchVkPosts,
};

export async function fetchVkPosts(source: VkSource, ctx: SourceContext): Promise<ParsedPosts> {
  const token = requireSecret(ctx, 'VK_TOKEN');
  // Токен уходит в теле POST-запроса, а не в URL.
  const form = new URLSearchParams({
    owner_id: String(source.ownerId),
    count: String(ctx.config.fetchLimit),
    filter: 'owner', // только посты самого сообщества, без предложенных и чужих
    v: ctx.config.vkApiVersion,
    access_token: token,
  });
  const { status, body } = await requestJson(ctx.fetch, VK_WALL_GET_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return parseVkWall(source, status, body);
}

export function parseVkWall(source: VkSource, status: number, body: unknown): ParsedPosts {
  if (isRecord(body) && isRecord(body.error)) {
    const code = Number(body.error.error_code);
    const message = asString(body.error.error_msg);
    throw new SourceError(classifyVkError(code), (t) => `VK API ${code}: ${message ?? t.errors.noDescription}`, String(code));
  }
  if (status >= 400) throw new SourceError('http', (t) => t.errors.apiHttp('VK API', status));
  const response = isRecord(body) ? body.response : undefined;
  const items = isRecord(response) ? response.items : undefined;
  if (!Array.isArray(items)) throw new SourceError('bad_response', (t) => t.errors.noPostList('VK'));

  return collectPosts(
    items,
    (item): Post | undefined => {
      if (!isRecord(item)) return undefined;
      const id = asString(item.id);
      const publishedAt = typeof item.date === 'number' ? item.date * 1000 : undefined;
      if (!id || !/^\d+$/.test(id) || !isPlausibleTime(publishedAt)) return undefined;
      return {
        sourceId: source.id,
        id,
        url: `https://vk.com/wall${source.ownerId}_${id}`,
        publishedAt,
        text: vkText(item),
      };
    },
    'VK',
  );
}

/** Текст поста, а у репоста без своего текста — текст исходной записи. */
function vkText(item: Record<string, unknown>): string {
  const own = asString(item.text) ?? '';
  if (own.trim() !== '') return own;
  const history = Array.isArray(item.copy_history) ? item.copy_history : [];
  const first: unknown = history[0];
  return isRecord(first) ? (asString(first.text) ?? '') : '';
}

// Коды ошибок VK API: https://dev.vk.com/ru/reference/errors
export function classifyVkError(code: number): FailureKind {
  if (code === 5) return 'auth';
  if ([7, 15, 27, 30, 200, 203].includes(code)) return 'permission';
  if ([6, 9, 29].includes(code)) return 'rate_limit';
  if (code === 100 || code === 113) return 'config';
  return 'http';
}
