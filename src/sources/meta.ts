import { SourceError, type FailureKind } from '../errors.ts';
import { requestJson } from '../http.ts';
import { asString, isRecord } from '../util.ts';
import type { ConfigIssues, SourceBase, SourceContext } from './adapter.ts';

export const GRAPH_ORIGIN = 'https://graph.facebook.com';

/** Источник Meta: страница Facebook или привязанный к ней Instagram. */
export interface MetaPageSource extends SourceBase {
  /** Классический ID страницы Facebook (тот, что видит Graph API). */
  pageId: string;
}

// ID страницы подставляется в путь запроса, поэтому только цифры.
const PAGE_ID = /^\d{5,25}$/;

export function parsePageId(raw: Record<string, unknown>, issues: ConfigIssues): string | undefined {
  const pageId = raw.pageId;
  if (typeof pageId === 'string' && PAGE_ID.test(pageId)) return pageId;
  issues.add('pageId', (t) => t.config.fields.metaPageId);
  return undefined;
}

/**
 * GET к Graph API. Токен передаётся только в заголовке Authorization, не в адресе.
 * По умолчанию — META_TOKEN; `token` нужен для запросов с токеном страницы.
 */
export async function graphGet(
  ctx: SourceContext,
  path: string,
  params: Record<string, string>,
  token: string | undefined = ctx.secrets.META_TOKEN,
): Promise<Record<string, unknown>> {
  if (!token) throw new SourceError('config', (t) => t.errors.secretMissing('META_TOKEN'));
  const url = new URL(`${GRAPH_ORIGIN}/${ctx.config.graphApiVersion}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const { status, body } = await requestJson(ctx.fetch, url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (isRecord(body) && isRecord(body.error)) {
    const code = Number(body.error.code);
    const subcode = asString(body.error.error_subcode);
    const message = asString(body.error.message);
    throw new SourceError(
      classifyGraphError(code),
      (t) => `Graph API ${code}${subcode ? `/${subcode}` : ''}: ${message ?? t.errors.noDescription}`,
      String(code),
    );
  }
  if (status >= 400) throw new SourceError('http', (t) => t.errors.apiHttp('Graph API', status));
  if (!isRecord(body)) throw new SourceError('bad_response', (t) => t.errors.notObject('Graph API'));
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
