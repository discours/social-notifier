import { SourceError, type FailureKind } from '../errors.ts';
import { requestJson } from '../http.ts';
import type { ParsedPosts, Post } from '../types.ts';
import { asString, isPlausibleTime, isRecord } from '../util.ts';
import { requireSecret, type SourceAdapter, type SourceBase, type SourceContext } from './adapter.ts';
import { collectPosts } from './parse.ts';

export const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

/**
 * Канал YouTube через Data API v3 ключом. RSS канала (`feeds/videos.xml`)
 * бесплатен и без ключа, но в ноябре 2026 отвечал 404 и официальным каналам,
 * поэтому основной путь — API: два запроса на запуск, около 290 единиц квоты
 * в сутки из бесплатных 10 000.
 */
export interface YoutubeSource extends SourceBase {
  type: 'youtube';
  /** ID канала: `UC` и 22 символа. */
  channelId: string;
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const youtubeAdapter: SourceAdapter<YoutubeSource> = {
  type: 'youtube',
  network: 'YouTube',
  secrets: ['YOUTUBE_API_KEY'],
  docs: 'docs/sources/youtube.md',
  parse(raw, base, issues) {
    const channelId = raw.channelId;
    if (typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) {
      issues.add('channelId', (t) => t.config.fields.youtubeChannelId);
      return undefined;
    }
    return { ...base, type: 'youtube', channelId };
  },
  fetch: fetchYoutubePosts,
};

export async function fetchYoutubePosts(source: YoutubeSource, ctx: SourceContext): Promise<ParsedPosts> {
  const key = requireSecret(ctx, 'YOUTUBE_API_KEY');
  const channel = await youtubeGet(ctx, key, 'channels', { part: 'contentDetails', id: source.channelId });
  const uploads = uploadsPlaylist(channel);
  const items = await youtubeGet(ctx, key, 'playlistItems', {
    part: 'snippet,contentDetails,status',
    playlistId: uploads,
    maxResults: String(Math.min(ctx.config.fetchLimit, 50)),
  });
  return parsePlaylistItems(source, items);
}

/** GET к Data API. Ключ — в заголовке `x-goog-api-key`, не в адресе. */
async function youtubeGet(
  ctx: SourceContext,
  key: string,
  method: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${YOUTUBE_API}/${method}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const { status, body } = await requestJson(ctx.fetch, url.toString(), { headers: { 'x-goog-api-key': key } });
  if (isRecord(body) && isRecord(body.error)) {
    const reason = errorReason(body.error);
    const message = asString(body.error.message);
    throw new SourceError(
      classifyYoutubeError(status, reason),
      (t) => `YouTube API ${reason ?? status}: ${message ?? t.errors.noDescription}`,
      reason,
    );
  }
  if (status >= 400) throw new SourceError('http', (t) => t.errors.apiHttp('YouTube API', status));
  if (!isRecord(body)) throw new SourceError('bad_response', (t) => t.errors.notObject('YouTube API'));
  return body;
}

function errorReason(error: Record<string, unknown>): string | undefined {
  const first: unknown = Array.isArray(error.errors) ? error.errors[0] : undefined;
  const fromErrors = isRecord(first) ? asString(first.reason) : undefined;
  // У неверного ключа причина лежит в details: reason API_KEY_INVALID.
  const details = Array.isArray(error.details) ? error.details : [];
  const fromDetails = details.map((d) => (isRecord(d) ? asString(d.reason) : undefined)).find(Boolean);
  return fromDetails ?? fromErrors;
}

// Причины ошибок: https://developers.google.com/youtube/v3/docs/errors
export function classifyYoutubeError(status: number, reason: string | undefined): FailureKind {
  if (reason === 'API_KEY_INVALID' || reason === 'keyInvalid' || reason === 'API_KEY_EXPIRED') return 'auth';
  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return 'rate_limit';
  }
  if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED' || reason === 'API_KEY_SERVICE_BLOCKED') {
    return 'permission';
  }
  if (status === 404 || reason === 'playlistNotFound' || reason === 'channelNotFound') return 'config';
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  return 'http';
}

/** Плейлист «Загрузки» канала: в нём все публичные видео, новые первыми. */
function uploadsPlaylist(body: Record<string, unknown>): string {
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) throw new SourceError('config', (t) => t.errors.youtubeChannelNotFound);
  const first: unknown = items[0];
  const details = isRecord(first) && isRecord(first.contentDetails) ? first.contentDetails : undefined;
  const related = details && isRecord(details.relatedPlaylists) ? details.relatedPlaylists : undefined;
  const uploads = related ? asString(related.uploads) : undefined;
  if (!uploads || !PLAYLIST_ID.test(uploads)) throw new SourceError('bad_response', (t) => t.errors.youtubeNoUploads);
  return uploads;
}

export function parsePlaylistItems(source: YoutubeSource, body: Record<string, unknown>): ParsedPosts {
  if (!Array.isArray(body.items)) throw new SourceError('bad_response', (t) => t.errors.youtubeNoVideos);
  // Приватные и доступные по ссылке видео тоже лежат в «Загрузках», но звать
  // на них нельзя. Элемент без статуса не отбрасывается молча: он не разберётся
  // и, если формат ответа сменился, дойдёт до алерта.
  const hidden = (item: unknown): boolean =>
    isRecord(item) && isRecord(item.status) && typeof item.status.privacyStatus === 'string' && item.status.privacyStatus !== 'public';
  return collectPosts(
    body.items.filter((item) => !hidden(item)),
    (item): Post | undefined => {
      if (!isRecord(item) || !isRecord(item.snippet) || !isRecord(item.status)) return undefined;
      const details = isRecord(item.contentDetails) ? item.contentDetails : {};
      const videoId = asString(details.videoId) ?? (isRecord(item.snippet.resourceId) ? asString(item.snippet.resourceId.videoId) : undefined);
      // videoPublishedAt — когда видео стало публичным; snippet.publishedAt — когда попало в плейлист.
      const published = asString(details.videoPublishedAt) ?? asString(item.snippet.publishedAt);
      const publishedAt = published ? Date.parse(published) : NaN;
      if (!videoId || !VIDEO_ID.test(videoId) || !isPlausibleTime(publishedAt)) return undefined;
      return {
        sourceId: source.id,
        id: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt,
        text: asString(item.snippet.title) ?? '',
      };
    },
    'YouTube',
  );
}
