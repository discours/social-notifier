import type { FetchLike } from '../src/http.ts';
import { parseConfig } from '../src/config.ts';
import type { RadarConfig, Secrets } from '../src/types.ts';
import { makeRedactor } from '../src/util.ts';
import { secretValues } from '../src/env.ts';

export const PAGE_ID = '1430627470564984';
export const IG_ID = '17841400000000001';
/** Токен страницы, который Graph API выдаёт в обмен на META_TOKEN; длинный, как настоящий. */
export const PAGE_TOKEN = `EAAPage${'x'.repeat(60)}`;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const SECRETS: Secrets = {
  telegramBotToken: '123456:TEST-bot-token-value',
  telegramChatId: '-100111',
  telegramAlertChatId: '222',
  vkToken: 'vk1.a.test-vk-token-value',
  metaToken: 'EAATestMetaTokenValue',
};

export const redact = makeRedactor(secretValues(SECRETS));

export function testConfig(overrides: Partial<Record<string, unknown>> = {}): RadarConfig {
  return parseConfig({
    messageTitle: 'Новые посты:',
    groupWindowMinutes: 10,
    maxPostAgeHours: 48,
    fetchLimit: 10,
    graphApiVersion: 'v25.0',
    vkApiVersion: '5.199',
    sources: [
      { id: 'vk', type: 'vk', label: 'VK', ownerId: -89236419 },
      { id: 'instagram', type: 'instagram', label: 'Instagram', pageId: PAGE_ID },
      { id: 'facebook', type: 'facebook', label: 'Facebook', pageId: PAGE_ID },
    ],
    ...overrides,
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Failure = Response | Error;

/** Graph API пишет время со смещением без двоеточия — как в живых ответах. */
export function graphTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

/**
 * Поддельные VK, Graph API и Telegram в одном объекте. Посты задаются
 * списками, сбои — полем `fail`, отправленные в Telegram сообщения копятся в `sent`.
 */
export class FakeWorld {
  vk: { id: number; date: number; text: string; is_pinned?: number }[] = [];
  fb: { id: string; created_time: string; message?: string; permalink_url: string }[] = [];
  ig: { id: string; timestamp: string; caption?: string; permalink: string }[] = [];
  fail: Partial<Record<'vk' | 'graph' | 'telegram', Failure>> = {};
  sent: { chatId: string; text: string; previewDisabled: boolean }[] = [];
  calls: Call[] = [];

  addVk(id: number, publishedAt: number, text = `VK пост ${id}`): void {
    this.vk.unshift({ id, date: Math.floor(publishedAt / 1000), text });
  }
  addFb(id: string, publishedAt: number, message = `FB пост ${id}`): void {
    this.fb.unshift({ id, created_time: graphTime(publishedAt), message, permalink_url: `https://www.facebook.com/${id}` });
  }
  addIg(id: string, publishedAt: number, caption = `IG пост ${id}`): void {
    this.ig.unshift({ id, timestamp: graphTime(publishedAt), caption, permalink: `https://www.instagram.com/p/${id}/` });
  }

  fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === 'string' ? init.body : '';
    this.calls.push({ url: input, method: init?.method ?? 'GET', headers, body });
    const url = new URL(input);

    if (url.hostname === 'api.vk.com') return this.respond('vk', () => json({ response: { count: this.vk.length, items: this.vk } }));
    if (url.hostname === 'graph.facebook.com') {
      return this.respond('graph', () => {
        if (url.pathname === `/v25.0/${PAGE_ID}`) {
          const fields = url.searchParams.get('fields') ?? '';
          return json({
            id: PAGE_ID,
            ...(fields.includes('access_token') ? { access_token: PAGE_TOKEN } : {}),
            ...(fields.includes('instagram_business_account') ? { instagram_business_account: { id: IG_ID } } : {}),
          });
        }
        if (url.pathname === `/v25.0/${PAGE_ID}/posts`) {
          if (headers.authorization !== `Bearer ${PAGE_TOKEN}`) {
            return json({ error: { code: 190, message: 'This method must be called with a Page Access Token' } }, 400);
          }
          return json({ data: this.fb });
        }
        if (url.pathname === `/v25.0/${IG_ID}/media`) return json({ data: this.ig });
        return json({ error: { code: 803, message: 'Some of the aliases you requested do not exist' } }, 404);
      });
    }
    if (url.hostname === 'api.telegram.org') {
      return this.respond('telegram', () => {
        const payload = JSON.parse(body) as { chat_id: string; text: string; link_preview_options: { is_disabled: boolean } };
        this.sent.push({
          chatId: payload.chat_id,
          text: payload.text,
          previewDisabled: payload.link_preview_options.is_disabled,
        });
        return json({ ok: true, result: { message_id: this.sent.length } });
      });
    }
    throw new Error(`неожиданный запрос: ${url.hostname}`);
  };

  private respond(kind: 'vk' | 'graph' | 'telegram', ok: () => Response): Response {
    const failure = this.fail[kind];
    if (failure instanceof Error) throw failure;
    if (failure) return failure.clone();
    return ok();
  }

  /** Сообщения в основной чат (посты) и в чат алертов. */
  postsMessages(): string[] {
    return this.sent.filter((m) => m.chatId === SECRETS.telegramChatId).map((m) => m.text);
  }
  alertMessages(): string[] {
    return this.sent.filter((m) => m.chatId === SECRETS.telegramAlertChatId).map((m) => m.text);
  }
}
