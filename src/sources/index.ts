import type { ParsedPosts } from '../types.ts';
import type { SourceAdapter, SourceContext, SourceSettings } from './adapter.ts';
import { blueskyAdapter, type BlueskySource } from './bluesky.ts';
import { facebookAdapter, type FacebookSource } from './facebook.ts';
import { feedAdapter, type FeedSource } from './feed.ts';
import { instagramAdapter, type InstagramSource } from './instagram.ts';
import { vkAdapter, type VkSource } from './vk.ts';
import { xAdapter, type XSource } from './x.ts';
import { youtubeAdapter, type YoutubeSource } from './youtube.ts';

export type { SourceAdapter, SourceBase, SourceContext } from './adapter.ts';

/** Источник любой сети. Новая сеть — новый член объединения и строка в ADAPTERS. */
export type SourceConfig =
  | VkSource
  | InstagramSource
  | FacebookSource
  | BlueskySource
  | YoutubeSource
  | XSource
  | FeedSource;

export type SourceType = SourceConfig['type'];

/**
 * Реестр сетей. Тип требует адаптер для каждого члена SourceConfig и только
 * для них: забытая строка — ошибка компиляции.
 */
const ADAPTERS: { readonly [T in SourceType]: SourceAdapter<Extract<SourceConfig, { type: T }>> } = {
  vk: vkAdapter,
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  bluesky: blueskyAdapter,
  youtube: youtubeAdapter,
  x: xAdapter,
  feed: feedAdapter,
};

export const SOURCE_TYPES = Object.keys(ADAPTERS) as SourceType[];

/** Адаптер по значению `type` из конфига; чужое значение, включая имена прототипа, — undefined. */
export function findAdapter(type: unknown): SourceAdapter<SourceConfig> | undefined {
  if (typeof type !== 'string' || !Object.hasOwn(ADAPTERS, type)) return undefined;
  return ADAPTERS[type as SourceType] as unknown as SourceAdapter<SourceConfig>;
}

export function adapterFor(source: SourceConfig): SourceAdapter<SourceConfig> {
  const adapter = findAdapter(source.type);
  if (!adapter) throw new Error(`нет адаптера для сети ${source.type}`);
  return adapter;
}

export function allAdapters(): SourceAdapter<SourceConfig>[] {
  return Object.values(ADAPTERS) as unknown as SourceAdapter<SourceConfig>[];
}

/**
 * Сколько постов читает проба. Столько же, сколько радар, чтобы проба видела
 * те же неразобранные записи; у платной сети — не больше её `probeLimit`,
 * потому что каждый прочитанный пост стоит денег.
 */
export function probeFetchLimit(source: SourceConfig, config: SourceSettings): number {
  const { probeLimit } = adapterFor(source);
  return probeLimit === undefined ? config.fetchLimit : Math.min(config.fetchLimit, probeLimit);
}

/** Последние посты источника. */
export function fetchSourcePosts(source: SourceConfig, ctx: SourceContext): Promise<ParsedPosts> {
  return adapterFor(source).fetch(source, ctx);
}

/** Посты источника для пробы: не больше `probeFetchLimit`. */
export function probeSourcePosts(source: SourceConfig, ctx: SourceContext): Promise<ParsedPosts> {
  return fetchSourcePosts(source, { ...ctx, config: { ...ctx.config, fetchLimit: probeFetchLimit(source, ctx.config) } });
}
