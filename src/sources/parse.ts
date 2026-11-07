import { SourceError } from '../errors.ts';
import type { ParsedPosts, Post } from '../types.ts';

/**
 * Разбирает элементы ответа по одному. Нераспознанный элемент не роняет
 * источник, но считается: его число попадает в лог. Если не разобрался ни один
 * элемент непустого ответа, значит, API поменял формат — это ошибка, и через
 * два запуска она дойдёт до алерта, а не превратится в тихое «новых постов нет».
 */
export function collectPosts(
  items: readonly unknown[],
  parseOne: (item: unknown) => Post | undefined,
  what: string,
): ParsedPosts {
  const posts: Post[] = [];
  let skipped = 0;
  for (const item of items) {
    const post = parseOne(item);
    if (post) posts.push(post);
    else skipped += 1;
  }
  if (items.length > 0 && posts.length === 0) {
    throw new SourceError('bad_response', `${what}: не разобран ни один из ${items.length} элементов ответа`);
  }
  return { posts, skipped };
}
