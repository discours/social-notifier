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

async function readText(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    throw new SourceError('network', `запрос не прошёл: ${describeNetworkError(err)}`);
  }
}

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return 'неизвестная ошибка';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'таймаут';
  const cause: unknown = (err as { cause?: unknown }).cause;
  const code = isRecord(cause) ? asString(cause.code) : undefined;
  return code ? `${err.name} (${code})` : err.name;
}
