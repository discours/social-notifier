import type { ParsedPosts, SourceConfig } from '../types.ts';
import type { SourceContext } from './context.ts';
import { fetchFacebookPosts } from './facebook.ts';
import { fetchInstagramPosts } from './instagram.ts';
import { fetchVkPosts } from './vk.ts';

export type { SourceContext } from './context.ts';

/** Последние посты источника. Новая сеть — новая ветка здесь и адаптер рядом. */
export function fetchSourcePosts(source: SourceConfig, ctx: SourceContext): Promise<ParsedPosts> {
  switch (source.type) {
    case 'vk':
      return fetchVkPosts(source, ctx);
    case 'facebook':
      return fetchFacebookPosts(source, ctx);
    case 'instagram':
      return fetchInstagramPosts(source, ctx);
  }
}
