import { SourceError } from './errors.ts';
import { asString, isRecord } from './util.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JsonResponse {
  status: number;
  body: unknown;
}

export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Запрос с таймаутом и разбором JSON. В текст ошибок не попадают ни URL,
 * ни тело ответа: логи публичного репозитория видны всем, а в URL Telegram
 * Bot API по протоколу лежит токен бота.
 */
export async function requestJson(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<JsonResponse> {
  const { status, text } = await readText(fetchFn, url, init, timeoutMs);
  if (text.trim() === '') return { status, body: null };
  try {
    return { status, body: JSON.parse(text) as unknown };
  } catch {
    // Страница ошибки прокси («502 Bad Gateway» в HTML) — временный сбой сети,
    // а не смена формата API: подсказка «радару нужна правка» здесь ложная.
    if (status >= 400) throw new SourceError('http', `ответ не в JSON (HTTP ${status})`);
    throw new SourceError('bad_response', `ответ не в JSON (HTTP ${status})`);
  }
}

/**
 * Ответ больше этого не дочитывается. Посты за один опрос занимают килобайты,
 * а ответ в сотни мегабайт от чужой ленты занял бы память и время всего запуска.
 * Запас — под ленты подкастов с многолетней историей: каждый выпуск там со своим описанием.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Запрос с таймаутом; ответ — текстом, `url` — адрес после перенаправлений
 * (пустой у подделанного в тестах ответа). Сетевая ошибка — SourceError без
 * адреса запроса.
 */
export async function readText(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; text: string; url: string }> {
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: await readBody(res, MAX_RESPONSE_BYTES), url: res.url };
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError('network', `запрос не прошёл: ${describeNetworkError(err)}`);
  }
}

async function readBody(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SourceError('bad_response', `ответ больше ${maxBytes / 1024 / 1024} МБ, дальше не читается`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoderFor(res.headers.get('content-type'), bytes).decode(bytes);
}

const XML_ENCODING = /^<\?xml\s[^>]*?encoding\s*=\s*["']([\w.:-]{1,40})["']/;
const HEADER_CHARSET = /;\s*charset\s*=\s*"?([\w.:-]{1,40})/i;

/**
 * Кодировка ответа: метка порядка байтов, затем объявление `<?xml … encoding>`
 * в начале документа (кроме UTF-16 без BOM), затем charset из Content-Type,
 * иначе UTF-8. Объявление
 * важнее заголовка: его пишет автор ленты, а заголовок — настройка сервера,
 * которая чаще врёт. Без этого лента в windows-1251 пришла бы знаками «�».
 */
export function decoderFor(contentType: string | null, bytes: Uint8Array): TextDecoder {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be');
  // Объявление — ASCII в первых байтах при любой однобайтовой кодировке.
  const head = String.fromCharCode(...bytes.subarray(0, 256));
  const declared = XML_ENCODING.exec(head)?.[1];
  // Объявление прочиталось побайтово, значит, документ не в UTF-16: без BOM
  // такая метка врёт и пропускается — дальше заголовок, иначе UTF-8.
  const trusted = declared !== undefined && !/^utf-?16/i.test(declared) ? declared : undefined;
  const label = trusted ?? HEADER_CHARSET.exec(contentType ?? '')?.[1];
  if (label !== undefined) {
    try {
      return new TextDecoder(label);
    } catch {
      // Неизвестная метка: UTF-8 верен для большинства лент.
    }
  }
  return new TextDecoder('utf-8');
}

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return 'неизвестная ошибка';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'таймаут';
  const cause: unknown = (err as { cause?: unknown }).cause;
  const code = isRecord(cause) ? asString(cause.code) : undefined;
  return code ? `${err.name} (${code})` : err.name;
}
