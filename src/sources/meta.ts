import { SourceError, type FailureKind } from '../errors.ts';
import { requestJson } from '../http.ts';
import { asString, isRecord } from '../util.ts';
import type { SourceContext } from './context.ts';

export const GRAPH_ORIGIN = 'https://graph.facebook.com';

/**
 * GET к Graph API. Токен передаётся только в заголовке Authorization, не в адресе.
 * По умолчанию — META_TOKEN; `token` нужен для запросов с токеном страницы.
 */
export async function graphGet(
  ctx: SourceContext,
  path: string,
  params: Record<string, string>,
  token: string | undefined = ctx.secrets.metaToken,
): Promise<Record<string, unknown>> {
  if (!token) throw new SourceError('config', 'не задан секрет META_TOKEN');
  const url = new URL(`${GRAPH_ORIGIN}/${ctx.config.graphApiVersion}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const { status, body } = await requestJson(ctx.fetch, url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (isRecord(body) && isRecord(body.error)) {
    const code = Number(body.error.code);
    const subcode = asString(body.error.error_subcode);
    const message = asString(body.error.message) ?? 'без описания';
    throw new SourceError(
      classifyGraphError(code),
      `Graph API ${code}${subcode ? `/${subcode}` : ''}: ${message}`,
      String(code),
    );
  }
  if (status >= 400) throw new SourceError('http', `Graph API ответил HTTP ${status}`);
  if (!isRecord(body)) throw new SourceError('bad_response', 'ответ Graph API не объект');
  return body;
}

// Коды ошибок Graph API: https://developers.facebook.com/docs/graph-api/guides/error-handling
export function classifyGraphError(code: number): FailureKind {
  if ([102, 190, 463, 467].includes(code)) return 'auth';
  if (code === 10 || (code >= 200 && code <= 299)) return 'permission';
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014)) return 'rate_limit';
  if (code === 100 || code === 803) return 'config';
  return 'http';
}
