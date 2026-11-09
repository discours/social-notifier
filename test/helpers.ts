import type { FetchLike } from '../src/http.ts';
import { parseConfig } from '../src/config.ts';
import type { RadarConfig } from '../src/types.ts';
import { makeRedactor } from '../src/util.ts';
import { secretValues, type Secrets } from '../src/env.ts';
import { ru } from '../src/i18n/ru.ts';

export const PAGE_ID = '1430627470564984';
export const IG_ID = '17841400000000001';
/** Токен страницы, который Graph API выдаёт в обмен на META_TOKEN; длинный, как настоящий. */
export const PAGE_TOKEN = `EAAPage${'x'.repeat(60)}`;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const SECRETS: Secrets = {
  TELEGRAM_BOT_TOKEN: '123456:TEST-bot-token-value',
  TELEGRAM_CHAT_ID: '-100111',
  TELEGRAM_ALERT_CHAT_ID: '222',
  VK_TOKEN: 'vk1.a.test-vk-token-value',
  META_TOKEN: 'EAATestMetaTokenValue',
  YOUTUBE_API_KEY: 'yt-test-key-value',
  X_BEARER_TOKEN: 'x-test-bearer-value',
};

export const redact = makeRedactor(secretValues(SECRETS), ru.redacted);

export function testConfig(overrides: Partial<Record<string, unknown>> = {}): RadarConfig {
  return parseConfig({
    language: 'ru',
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

/** Сообщение канала Telegram для страницы предпросмотра. `html` — разметка текста как есть. */
export interface TgMessage {
  id: number;
  publishedAt: number;
  html: string;
  /** Служебное сообщение: «Channel created», «… pinned …». */
  service?: boolean;
}

/**
 * Страница `t.me/s/<канал>` в форме живой (09.11.2026): сообщения от старых к
 * новым, у каждого `data-post`, текст и ссылка-дата в подвале. Картинки,
 * реакции и SVG хвостов сняты — разбор на них не смотрит.
 */
export function channelPage(channel: string, messages: readonly TgMessage[]): string {
  const items = [...messages]
    .sort((a, b) => a.id - b.id)
    .map(
      (m) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap${m.service ? ' service_message' : ''} js-widget_message" data-post="${channel}/${m.id}" data-view="eyJjIjotMTEyMTUwMzYxNX0">
  <div class="tgme_widget_message_user"><a href="https://t.me/${channel}"><i class="tgme_widget_message_user_photo bgcolor1" data-content="Д"></i></a></div>
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/${channel}"><span dir="auto">Канал</span></a></div>
<div class="media_supported_cont"><div class="tgme_widget_message_text js-message_text" dir="auto">${m.html}</div></div><div class="media_not_supported_cont"><div class="message_media_not_supported_wrap">
  <div class="message_media_not_supported">
    <div class="message_media_not_supported_label">Please open Telegram to view this post</div>
    <a href="https://t.me/${channel}/${m.id}" class="message_media_view_in_telegram">VIEW IN TELEGRAM</a>
  </div>
</div></div>
<div class="tgme_widget_message_footer compact js-message_footer">
  <div class="tgme_widget_message_info short js-message_info">
    <span class="tgme_widget_message_views">791</span><span class="copyonly"> views</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${channel}/${m.id}"><time datetime="${new Date(m.publishedAt).toISOString().replace(/\.\d{3}Z$/, '+00:00')}" class="time">09:08</time></a></span>
  </div>
</div>
  </div>
</div></div>`,
    );
  return `<!DOCTYPE html>
<html><head><meta property="og:title" content="Канал"></head><body>
<div class="tgme_channel_info"></div>
<section class="tgme_channel_history js-message_history">
${items.join('')}
</section></body></html>`;
}

/** Ответ страницы `t.me/s/…` с адресом после перенаправлений, как его видит fetch. */
export function tmePage(body: string, url: string, status = 200): Response {
  const res = new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

/**
 * Копия подменного ответа для повторной выдачи. `clone()` теряет адрес после
 * перенаправлений, заданный через defineProperty, а адаптер Telegram по нему
 * отличает страницу канала от карточки, куда t.me уводит с неё.
 */
export function copyResponse(res: Response): Response {
  const copy = res.clone();
  if (res.url !== '') Object.defineProperty(copy, 'url', { value: res.url });
  return copy;
}

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
  /** Открытые каналы Telegram по имени; страница неизвестного уводит на t.me/<имя>. */
  tg: Record<string, TgMessage[]> = {};
  fail: Partial<Record<'vk' | 'graph' | 'telegram' | 'tme', Failure>> = {};
  sent: { chatId: string; text: string; previewDisabled: boolean }[] = [];
  calls: Call[] = [];
  /** Чаты, которым Telegram отказывает (403, как при заблокированном боте). */
  blockedChats = new Set<string>();
  /** Номера вызовов sendMessage (с единицы, сквозная нумерация), на которых Telegram отвечает 500. */
  telegramFailOnCall = new Set<number>();
  private telegramCalls = 0;

  addVk(id: number, publishedAt: number, text = `VK пост ${id}`): void {
    this.vk.unshift({ id, date: Math.floor(publishedAt / 1000), text });
  }
  addFb(id: string, publishedAt: number, message = `FB пост ${id}`): void {
    this.fb.unshift({ id, created_time: graphTime(publishedAt), message, permalink_url: `https://www.facebook.com/${id}` });
  }
  addIg(id: string, publishedAt: number, caption = `IG пост ${id}`): void {
    this.ig.unshift({ id, timestamp: graphTime(publishedAt), caption, permalink: `https://www.instagram.com/p/${id}/` });
  }
  addTg(channel: string, id: number, publishedAt: number, html = `Пост канала ${channel} №${id}`, service = false): void {
    (this.tg[channel] ??= []).push({ id, publishedAt, html, service });
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
        this.telegramCalls += 1;
        if (this.telegramFailOnCall.has(this.telegramCalls)) {
          return json({ ok: false, error_code: 500, description: 'Internal Server Error' }, 500);
        }
        if (this.blockedChats.has(payload.chat_id)) {
          return json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403);
        }
        this.sent.push({
          chatId: payload.chat_id,
          text: payload.text,
          previewDisabled: payload.link_preview_options.is_disabled,
        });
        return json({ ok: true, result: { message_id: this.sent.length } });
      });
    }
    if (url.hostname === 't.me') {
      return this.respond('tme', () => {
        const channel = url.pathname.slice('/s/'.length);
        const messages = Object.hasOwn(this.tg, channel) ? this.tg[channel] : undefined;
        // Как живой t.me: неизвестное имя — перенаправление на карточку без постов.
        if (!messages) return tmePage('<html><body><div class="tgme_page"></div></body></html>', `https://t.me/${channel}`);
        return tmePage(channelPage(channel, messages), url.href);
      });
    }
    throw new Error(`неожиданный запрос: ${url.hostname}`);
  };

  private respond(kind: 'vk' | 'graph' | 'telegram' | 'tme', ok: () => Response): Response {
    const failure = this.fail[kind];
    if (failure instanceof Error) throw failure;
    if (failure) return copyResponse(failure);
    return ok();
  }

  /** Сообщения в основной чат (посты) и в чат алертов. */
  postsMessages(): string[] {
    return this.sent.filter((m) => m.chatId === SECRETS.TELEGRAM_CHAT_ID).map((m) => m.text);
  }
  alertMessages(): string[] {
    return this.sent.filter((m) => m.chatId === SECRETS.TELEGRAM_ALERT_CHAT_ID).map((m) => m.text);
  }
}
