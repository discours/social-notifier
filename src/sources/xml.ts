/**
 * Минимальный разбор RSS и Atom без зависимостей. Это не XML-парсер: он
 * вытаскивает элементы ленты по именам тегов и не исполняет DTD, поэтому
 * сущности из DOCTYPE (XXE, «миллиард смешков») ему не страшны — их он просто
 * не раскрывает.
 *
 * Лента — чужой ввод. Поэтому всё ищется через `indexOf` с движением только
 * вперёд, и время разбора линейно от размера ответа при любом содержимом.
 * Ленивые регулярки на незакрытых тегах давали квадрат: мегабайт мусора
 * разбирался минуты, а синхронный разбор останавливал опрос всех сетей.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
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
    return Object.hasOwn(NAMED, ref) ? (NAMED[ref] ?? whole) : whole;
  });
}

/**
 * Текст элемента и значение атрибута длиннее этого целиком не разбираются.
 * От поста хранится 1000 символов (MAX_STORED_TEXT), а раскрытие миллионов
 * сущностей в чужом мегабайтном тексте съедало гигабайты памяти и роняло
 * запуск всех сетей. Предел в десятки раз больше предела ссылки: обрезанная
 * ссылка всё равно длиннее допустимой и не примется.
 */
export const MAX_ELEMENT_SOURCE = 100_000;

const bounded = (text: string) => (text.length > MAX_ELEMENT_SOURCE ? text.slice(0, MAX_ELEMENT_SOURCE) : text);

/** Содержимое `<![CDATA[…]]>` как есть, остальное — с раскрытыми сущностями; не длиннее MAX_ELEMENT_SOURCE. */
export function textContent(inner: string): string {
  const source = bounded(inner);
  let out = '';
  let pos = 0;
  for (;;) {
    const start = source.indexOf('<![CDATA[', pos);
    if (start === -1) break;
    const end = source.indexOf(']]>', start + 9);
    if (end === -1) break;
    out += decodeEntities(source.slice(pos, start)) + source.slice(start + 9, end);
    pos = end + 3;
  }
  return (out + decodeEntities(source.slice(pos))).trim();
}

/** Непустые строки текста без пробелов по краям. */
export function plainText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

const LINE_BREAK = /^br\s*\/?$/i;
const BLOCK_END = /^\/(p|div|li|h[1-6]|blockquote)$/i;

/** HTML описания поста в простой текст: абзацы и переносы — новые строки, теги и комментарии — прочь. */
export function htmlToText(source: string): string {
  const html = bounded(source);
  let out = '';
  let pos = 0;
  // Пока дальше есть «-->», комментарий вырезается целиком: в нём бывает «>»,
  // и `<!-- a > b -->` иначе оставил бы в тексте «b -->». Когда «-->» больше
  // нет, «<!--» — обычный тег: повторный поиск на каждом дал бы квадрат.
  let commentEnds = true;
  for (;;) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;
    if (commentEnds && html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end !== -1) {
        out += html.slice(pos, lt);
        pos = end + 3;
        continue;
      }
      commentEnds = false;
    }
    const gt = html.indexOf('>', lt + 1);
    // Дальше нет ни одного «>», значит, и тегов нет: остаток — текст как есть.
    if (gt === -1) break;
    const tag = html.slice(lt + 1, gt);
    out += html.slice(pos, lt) + (LINE_BREAK.test(tag) || BLOCK_END.test(tag) ? '\n' : '');
    pos = gt + 1;
  }
  return plainText(decodeEntities(out + html.slice(pos)));
}

export interface XmlElement {
  attrs: Record<string, string>;
  /** Содержимое между открывающим и закрывающим тегом; у `<name/>` — пустая строка. */
  inner: string;
}

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';

/** Открывающий тег `<name` ровно с этим именем: `<title` не совпадёт с `<titles` и `<media:title`. */
function openTag(xml: string, name: string, from: number): { start: number; attrsStart: number } | undefined {
  const open = `<${name}`;
  let pos = from;
  for (;;) {
    const start = xml.indexOf(open, pos);
    if (start === -1) return undefined;
    const after = start + open.length;
    const ch = xml[after];
    if (ch === '>' || ch === '/' || isSpace(ch)) return { start, attrsStart: after };
    pos = after;
  }
}

/** Закрывающий `</name>` (пробелы перед «>» допустимы) после `from`: позиция за ним. */
function closeTag(xml: string, name: string, from: number): { start: number; end: number } | undefined {
  const close = `</${name}`;
  let pos = from;
  for (;;) {
    const start = xml.indexOf(close, pos);
    if (start === -1) return undefined;
    let i = start + close.length;
    while (isSpace(xml[i])) i += 1;
    if (xml[i] === '>') return { start, end: i + 1 };
    pos = start + close.length;
  }
}

/** Элементы `<name …>…</name>` и `<name …/>` подряд; вложенные одноимённые не поддерживаются — в лентах их нет. */
function* elements(xml: string, name: string): Generator<XmlElement & { selfClosing: boolean }> {
  let pos = 0;
  for (;;) {
    const open = openTag(xml, name, pos);
    if (!open) return;
    const gt = xml.indexOf('>', open.attrsStart);
    if (gt === -1) return;
    const rawAttrs = xml.slice(open.attrsStart, gt);
    if (rawAttrs.endsWith('/')) {
      yield { attrs: parseAttributes(rawAttrs.slice(0, -1)), inner: '', selfClosing: true };
      pos = gt + 1;
      continue;
    }
    const close = closeTag(xml, name, gt + 1);
    // Закрывающего тега нет нигде дальше — значит, и у следующих открывающих его не будет.
    if (!close) return;
    yield { attrs: parseAttributes(rawAttrs), inner: xml.slice(gt + 1, close.start), selfClosing: false };
    pos = close.end;
  }
}

/**
 * Текст как содержимое элемента: `&`, `<` и `>` — сущностями. Через split и
 * join: на миллионах совпадений это втрое быстрее replace и replaceAll
 * (замер 08.11.2026, Node 22: 8 млн «<» — 350 мс против 1100–2300 мс).
 */
function escapeText(text: string): string {
  return text.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
}

/**
 * Документ, в котором разметка — только разметка. Комментарии `<!-- … -->`
 * вырезаются: закомментированная запись — не пост. Секции CDATA становятся
 * экранированным текстом: иначе `</item>` в тексте описания закрыл бы запись,
 * а «<!--» в нём открыл бы комментарий. Незакрытый «<!--» или «<![CDATA[» —
 * не секция: остаток документа остаётся как есть, а не исчезает вместе со
 * всеми записями после него.
 */
export function normalizeXml(xml: string): string {
  let out = '';
  let pos = 0;
  // Следующие позиции ищутся заново, только когда разбор их миновал: так
  // документ просматривается один раз, сколько бы в нём ни было секций.
  let comment = xml.indexOf('<!--');
  let cdata = xml.indexOf('<![CDATA[');
  for (;;) {
    if (cdata !== -1 && (comment === -1 || cdata < comment)) {
      const end = xml.indexOf(']]>', cdata + 9);
      // Дальше нет ни одного «]]>»: и этот, и следующие «<![CDATA[» — просто текст.
      if (end === -1) {
        cdata = -1;
        continue;
      }
      out += xml.slice(pos, cdata) + escapeText(xml.slice(cdata + 9, end));
      pos = end + 3;
    } else if (comment !== -1) {
      const end = xml.indexOf('-->', comment + 4);
      if (end === -1) {
        comment = -1;
        continue;
      }
      out += xml.slice(pos, comment);
      pos = end + 3;
    } else {
      break;
    }
    if (comment !== -1 && comment < pos) comment = xml.indexOf('<!--', pos);
    if (cdata !== -1 && cdata < pos) cdata = xml.indexOf('<![CDATA[', pos);
  }
  return out + xml.slice(pos);
}

/** Текст без элементов `<name>…</name>` и `<name/>`: так из записи Atom убирается вложенный `<source>`. */
export function removeElements(xml: string, name: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = openTag(xml, name, pos);
    if (!open) break;
    const gt = xml.indexOf('>', open.attrsStart);
    if (gt === -1) break;
    const end = xml[gt - 1] === '/' ? gt + 1 : closeTag(xml, name, gt + 1)?.end;
    if (end === undefined) break;
    out += xml.slice(pos, open.start);
    pos = end;
  }
  return out + xml.slice(pos);
}

/** Содержимое элементов `<name>…</name>` верхнего уровня; `<name/>` — не запись, пропускается. */
export function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  for (const element of elements(xml, name)) if (!element.selfClosing) out.push(element.inner);
  return out;
}

/** Первый дочерний элемент или undefined. */
export function childElement(block: string, name: string): XmlElement | undefined {
  for (const element of elements(block, name)) return element;
  return undefined;
}

/** Текст первого дочернего элемента или undefined. Пустой элемент — пустая строка. */
export function childText(block: string, name: string): string | undefined {
  const element = childElement(block, name);
  return element === undefined ? undefined : textContent(element.inner);
}

/** Атрибуты каждого открывающего тега `<name …>`, закрыт он или нет. */
export function tagAttributes(block: string, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let pos = 0;
  for (;;) {
    const open = openTag(block, name, pos);
    if (!open) return out;
    const gt = block.indexOf('>', open.attrsStart);
    if (gt === -1) return out;
    const raw = block.slice(open.attrsStart, gt);
    out.push(parseAttributes(raw.endsWith('/') ? raw.slice(0, -1) : raw));
    pos = gt + 1;
  }
}

const NAME_CHAR = /[\w:.-]/;

/** `a="1" b='2'` в словарь без прототипа; атрибут без кавычек или без значения пропускается. */
function parseAttributes(text: string): Record<string, string> {
  const attrs = Object.create(null) as Record<string, string>;
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && !NAME_CHAR.test(text[i] ?? '')) i += 1;
    const nameStart = i;
    while (i < n && NAME_CHAR.test(text[i] ?? '')) i += 1;
    const name = text.slice(nameStart, i);
    while (isSpace(text[i])) i += 1;
    if (text[i] !== '=') continue;
    i += 1;
    while (isSpace(text[i])) i += 1;
    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = text.indexOf(quote, i + 1);
    if (end === -1) break;
    // Длинное значение отбрасывается, а не обрезается: обрезанное было бы другим значением.
    if (name !== '' && end - i - 1 <= MAX_ELEMENT_SOURCE) attrs[name] = decodeEntities(text.slice(i + 1, end));
    i = end + 1;
  }
  return attrs;
}

/**
 * Имя корневого элемента: пролог `<?xml…?>`, комментарии и DOCTYPE
 * пропускаются. По нему, а не по подстроке где угодно, ясно, RSS это или
 * Atom: текст записи может цитировать чужую разметку.
 */
export function rootElement(xml: string): string | undefined {
  let pos = 0;
  for (;;) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) return undefined;
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) return undefined;
      pos = end + 2;
    } else if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) return undefined;
      pos = end + 3;
    } else if (xml.startsWith('<!', lt)) {
      // DOCTYPE, возможно, с внутренним подмножеством `[…]`, в котором свои «>».
      // «[» ищется только внутри этого тега: поиск до конца документа на каждом
      // `<!…>` давал квадрат на ленте из тысяч `<!a>`.
      const gt = xml.indexOf('>', lt);
      if (gt === -1) return undefined;
      const bracket = xml.slice(lt, gt).indexOf('[');
      if (bracket === -1) {
        pos = gt + 1;
      } else {
        const subsetEnd = xml.indexOf(']', lt + bracket);
        const end = subsetEnd === -1 ? -1 : xml.indexOf('>', subsetEnd);
        if (end === -1) return undefined;
        pos = end + 1;
      }
    } else {
      return /^<([A-Za-z_][\w:.-]*)/.exec(xml.slice(lt, lt + 128))?.[1];
    }
  }
}
