/**
 * Минимальный разбор RSS и Atom без зависимостей. Это не XML-парсер: он
 * вытаскивает элементы ленты по именам тегов и не исполняет DTD, поэтому
 * сущности из DOCTYPE (XXE, «миллиард смешков») ему не страшны — их он просто
 * не раскрывает.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  hellip: '…',
};

/** Раскрывает числовые ссылки и распространённые именованные сущности; неизвестные оставляет как есть. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref] ?? whole;
  });
}

/** Содержимое `<![CDATA[…]]>` как есть, остальное — с раскрытыми сущностями. */
export function textContent(inner: string): string {
  let out = '';
  let rest = inner;
  for (;;) {
    const start = rest.indexOf('<![CDATA[');
    if (start === -1) break;
    const end = rest.indexOf(']]>', start + 9);
    if (end === -1) break;
    out += decodeEntities(rest.slice(0, start)) + rest.slice(start + 9, end);
    rest = rest.slice(end + 3);
  }
  return (out + decodeEntities(rest)).trim();
}

/** HTML описания поста в простой текст: абзацы и переносы — новые строки, теги — прочь. */
export function htmlToText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ''))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Имя тега ровно как задано, с префиксом пространства имён, если он нужен:
 * `title` не совпадёт с `media:title`, а `yt:videoId` надо назвать целиком.
 */
function tagPattern(name: string): string {
  return name.replace(/[^\w:-]/g, '');
}

/** Блоки `<name …>…</name>` верхнего уровня; вложенные одноимённые не поддерживаются — в лентах их нет. */
export function blocks(xml: string, name: string): string[] {
  const tag = tagPattern(name);
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1] ?? '');
}

/** Текст первого дочернего элемента или undefined. Пустой элемент — пустая строка. */
export function childText(block: string, name: string): string | undefined {
  const tag = tagPattern(name);
  // Ленивый `[^>]*?` нужен, чтобы `<content type="html"/>` распознался как пустой элемент.
  const re = new RegExp(`<${tag}(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`);
  const match = re.exec(block);
  if (!match) return undefined;
  return textContent(match[1] ?? '');
}

/** Открывающие теги `<name …>` со значениями атрибутов. */
export function tagAttributes(block: string, name: string): Record<string, string>[] {
  const tag = tagPattern(name);
  const re = new RegExp(`<${tag}(\\s[^>]*?)?/?>`, 'g');
  return [...block.matchAll(re)].map((m) => {
    const attrs: Record<string, string> = {};
    for (const a of (m[1] ?? '').matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const key = a[1];
      if (key !== undefined) attrs[key] = decodeEntities(a[3] ?? a[4] ?? '');
    }
    return attrs;
  });
}
