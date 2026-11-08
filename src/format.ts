import type { Texts } from './i18n/index.ts';
import type { Post } from './types.ts';
import { wellFormed } from './util.ts';

/** Предел длины сообщения в Telegram. Считаем по HTML: он не короче видимого текста. */
export const TELEGRAM_TEXT_LIMIT = 4096;
export const SNIPPET_LENGTH = 80;

export interface OutgoingMessage {
  html: string;
  disablePreview: boolean;
}

/**
 * Экранирует текст для parse_mode HTML. Через неё проходит всё динамическое
 * содержимое сообщений и все тексты каталога языков, поэтому здесь же чинятся
 * одиночные суррогаты.
 */
export function escapeHtml(text: string): string {
  return wellFormed(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Первая непустая строка текста, сжатая до `max` символов по границе слова. */
export function snippet(text: string, max = SNIPPET_LENGTH): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return '';
  const flat = line.replace(/\s+/g, ' ');
  const chars = [...flat]; // по кодовым точкам, чтобы не резать эмодзи пополам
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  const trimmed = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${trimmed.trimEnd()}…`;
}

/** Сообщение дайджеста и посты в нём: после доставки они снимаются с очереди. */
export interface DigestMessage extends OutgoingMessage {
  posts: Post[];
}

/**
 * Сообщение о новых постах: заголовок и по строке на пост. Если всё не влезает
 * в одно сообщение Telegram, остаток уходит следующими. Превью ссылки
 * показывается, только когда в сообщении один пост.
 */
export function formatDigest(
  t: Texts,
  title: string,
  posts: readonly Post[],
  labelOf: (sourceId: string) => string,
  limit = TELEGRAM_TEXT_LIMIT,
): DigestMessage[] {
  const header = `${escapeHtml(title)}\n`;
  const chunks: { html: string; posts: Post[] }[] = [];
  let current: { html: string; posts: Post[] } = { html: header, posts: [] };
  for (const post of posts) {
    const label = escapeHtml(labelOf(post.sourceId));
    const text = escapeHtml(snippet(post.text) || t.digest.untitledPost);
    const line = `\n<b>${label}</b>: <a href="${escapeHtml(post.url)}">${text}</a>`;
    if (current.posts.length > 0 && current.html.length + line.length > limit) {
      chunks.push(current);
      current = { html: header, posts: [] };
    }
    current.html += line;
    current.posts.push(post);
  }
  if (current.posts.length > 0) chunks.push(current);
  return chunks.map((c) => ({ html: c.html, disablePreview: c.posts.length > 1, posts: c.posts }));
}
