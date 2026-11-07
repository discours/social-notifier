import type { PendingPost } from './types.ts';

/**
 * Правило окна: посты копятся в очереди, пока с самого раннего из них не
 * пройдёт `windowMs`. Тогда вся очередь уходит одним сообщением.
 *
 * Отсчёт идёт от времени публикации, а если радар увидел пост раньше, чем
 * указано в нём (часы сети спешат), — от времени обнаружения. Пост, найденный
 * с опозданием (расписание GitHub задержалось), уходит сразу, без лишнего ожидания.
 *
 * Возвращает посты к отправке по возрастанию времени публикации или `null`.
 */
export function takeDue(pending: readonly PendingPost[], now: number, windowMs: number): PendingPost[] | null {
  if (pending.length === 0) return null;
  const anchor = Math.min(...pending.map((p) => Math.min(p.publishedAt, p.detectedAt)));
  if (now - anchor < windowMs) return null;
  return [...pending].sort((a, b) => a.publishedAt - b.publishedAt);
}

export function postKey(post: { sourceId: string; id: string }): string {
  return `${post.sourceId}:${post.id}`;
}
