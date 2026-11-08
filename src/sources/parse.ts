import { SourceError } from '../errors.ts';
import type { Phrase } from '../i18n/index.ts';
import type { ParsedPosts, Post } from '../types.ts';

/**
 * Текст поста хранится обрезанным: сообщению нужна только первая строка, а
 * пост из очереди лежит в state.json, и запись ленты в мегабайт раздула бы его.
 * Разрезанную пополам эмодзи чинит escapeHtml при отправке.
 */
export const MAX_STORED_TEXT = 1000;

/**
 * Разбирает элементы ответа по одному. Нераспознанный элемент не роняет
 * источник, но считается: его число попадает в лог. Если не разобрался ни один
 * элемент непустого ответа, значит, API поменял формат — это ошибка, и через
 * два запуска она дойдёт до алерта, а не превратится в тихое «новых постов нет».
 */
export function collectPosts<T>(
  items: readonly T[],
  parseOne: (item: T) => Post | undefined,
  what: string | Phrase,
): ParsedPosts {
  const posts: Post[] = [];
  let skipped = 0;
  for (const item of items) {
    const post = parseOne(item);
    if (!post) skipped += 1;
    else posts.push(post.text.length > MAX_STORED_TEXT ? { ...post, text: post.text.slice(0, MAX_STORED_TEXT) } : post);
  }
  if (items.length > 0 && posts.length === 0) {
    const total = items.length;
    throw new SourceError('bad_response', (t) => t.errors.noneParsed(typeof what === 'string' ? what : what(t), total));
  }
  return { posts, skipped };
}
