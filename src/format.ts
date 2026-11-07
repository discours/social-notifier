import type { Post } from './types.ts';

/** Предел длины сообщения в Telegram. Считаем по HTML: он не короче видимого текста. */
export const TELEGRAM_TEXT_LIMIT = 4096;
export const SNIPPET_LENGTH = 80;

export interface OutgoingMessage {
  html: string;
  disablePreview: boolean;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

/**
 * Сообщение о новых постах: заголовок и по строке на пост. Если всё не влезает
 * в одно сообщение Telegram, остаток уходит следующими. Превью ссылки
 * показывается, только когда в сообщении один пост.
 */
export function formatDigest(
  title: string,
  posts: readonly Post[],
  labelOf: (sourceId: string) => string,
  limit = TELEGRAM_TEXT_LIMIT,
): OutgoingMessage[] {
  const header = `${escapeHtml(title)}\n`;
  const lines = posts.map((post) => {
    const label = escapeHtml(labelOf(post.sourceId));
    const text = escapeHtml(snippet(post.text) || 'пост без подписи');
    return `\n<b>${label}</b>: <a href="${escapeHtml(post.url)}">${text}</a>`;
  });

  const chunks: { html: string; count: number }[] = [];
  let current = { html: header, count: 0 };
  for (const line of lines) {
    if (current.count > 0 && current.html.length + line.length > limit) {
      chunks.push(current);
      current = { html: header, count: 0 };
    }
    current.html += line;
    current.count += 1;
  }
  if (current.count > 0) chunks.push(current);
  return chunks.map((c) => ({ html: c.html, disablePreview: c.count > 1 }));
}
