export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Строка как есть; конечное число — в виде строки (ID в ответах API бывают и тем и другим). */
export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Время из Graph API: `2026-11-07T13:17:00+0000`. Смещение без двоеточия
 * не входит в стандарт ISO, поэтому перед разбором двоеточие добавляется.
 */
export function parseGraphTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return isPlausibleTime(ms) ? ms : undefined;
}

/**
 * Длиннее ссылка не бывает в настоящем посте. Ссылка уходит в сообщение
 * Telegram, и сообщение, которое он не примет, встало бы первым в очереди
 * всех сетей.
 */
export const MAX_URL_LENGTH = 2048;

/**
 * Ссылка из ответа API, если это настоящий http(s)-адрес не длиннее
 * MAX_URL_LENGTH: в нормализованном виде (`URL.href`). Пустая строка,
 * `javascript:` и прочее — undefined, и адаптер берёт запасную ссылку.
 */
export function httpUrl(value: unknown): string | undefined {
  // Длина — до разбора: разбор punycode в URL квадратичен по длине имени
  // хоста, и ссылка в сотни килобайт останавливала бы опрос на секунды.
  if (typeof value !== 'string' || value === '' || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    // Кириллица и пробелы при нормализации кодируются и удлиняют адрес.
    return url.href.length <= MAX_URL_LENGTH ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Заменяет одиночные суррогаты на U+FFFD. Текст из API бывает обрезан
 * посередине эмодзи; Telegram такое сообщение отвергает (не UTF-8), и
 * отвергнутое сообщение застряло бы первым в очереди.
 */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, String.fromCharCode(0xfffd));
}

const EARLIEST_POST = Date.UTC(2000, 0, 1);
const LATEST_POST = Date.UTC(2100, 0, 1);

/**
 * Время поста — конечное число в разумных пределах. Иначе мусорное значение
 * из API (огромное число, Infinity) попало бы в очередь, в JSON стало бы null
 * и сломало бы чтение состояния во всех следующих запусках.
 */
export function isPlausibleTime(ms: unknown): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= EARLIEST_POST && ms <= LATEST_POST;
}

const MIN_SECRET_LENGTH = 6;
// Длинная сплошная строка из символов токена: страховка на случай, если API
// вернёт в тексте ошибки токен, которого нет в списке известных секретов.
// Токены короче 40 символов — отдельно по их виду: у бота Telegram двоеточие
// режет токен на «ID:хвост из 35 символов», ключ Google — 39 символов.
const TOKEN_LIKE = /[A-Za-z0-9_\-.]{40,}|\d{5,12}:[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{30,}/g;

/**
 * Вычищает из текста известные секреты и всё, что похоже на токен. Метки
 * замены — на языке конфига (`t.redacted`): они видны в алертах.
 */
export function makeRedactor(
  secrets: readonly (string | undefined)[],
  marks: { readonly secret: string; readonly hidden: string },
): (text: string) => string {
  const known = secrets.filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH);
  return (text) => {
    let out = text;
    for (const secret of known) out = out.split(secret).join(marks.secret);
    return out.replace(TOKEN_LIKE, marks.hidden);
  };
}
