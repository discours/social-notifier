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
  return Number.isNaN(ms) ? undefined : ms;
}

const MIN_SECRET_LENGTH = 6;
// Длинная сплошная строка из символов токена: страховка на случай, если API
// вернёт в тексте ошибки токен, которого нет в списке известных секретов.
const TOKEN_LIKE = /[A-Za-z0-9_\-.]{40,}/g;

/** Вычищает из текста известные секреты и всё, что похоже на токен. */
export function makeRedactor(secrets: readonly (string | undefined)[]): (text: string) => string {
  const known = secrets.filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH);
  return (text) => {
    let out = text;
    for (const secret of known) out = out.split(secret).join('[секрет]');
    return out.replace(TOKEN_LIKE, '[скрыто]');
  };
}
