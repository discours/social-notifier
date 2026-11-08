/**
 * Сценарии радара «Дискурса» для эталона: всё, что видит редакция (сообщения и
 * алерты в Telegram), что пишет лог и что ложится в state.json. Эталон
 * `test/fixtures/discours-ru.json` снят этим файлом на коде до выноса текстов
 * в каталог языков; тест `discours-ru.test.ts` сверяет с ним байт в байт.
 * Сценарии пользуются только публичным контрактом — `parseConfig`, `runRadar`
 * и состоянием, — поэтому один и тот же файл работает на старом и новом коде.
 */
import { parseConfig } from '../src/config.ts';
import type { FetchLike } from '../src/http.ts';
import { runRadar } from '../src/radar.ts';
import { emptyState, type RadarState } from '../src/state.ts';
import type { RadarConfig } from '../src/types.ts';
import { FakeWorld, HOUR, json, MINUTE, PAGE_ID, redact, SECRETS } from './helpers.ts';
import type { Secrets } from '../src/env.ts';

/** Конфиг «Дискурса» из radar.config.json; тест сверяет, что файл совпадает с ним. */
export const DISCOURS_CONFIG = {
  language: 'ru',
  messageTitle: 'Давайте поддержим новые посты!',
  groupWindowMinutes: 10,
  maxPostAgeHours: 48,
  fetchLimit: 25,
  graphApiVersion: 'v25.0',
  vkApiVersion: '5.199',
  sources: [
    { id: 'vk', type: 'vk', label: 'VK', ownerId: -89236419 },
    { id: 'instagram', type: 'instagram', label: 'IG', pageId: PAGE_ID },
    { id: 'facebook', type: 'facebook', label: 'FB', pageId: PAGE_ID },
    { id: 'youtube', type: 'youtube', label: 'YT', channelId: 'UCXEydGIYsqj-fjDnqAOXNNg' },
  ],
};

const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
const DAY = 24 * HOUR;
const RUN_URL = 'https://github.com/discours/social-notifier/actions/runs/42';
const UPLOADS = 'UUXEydGIYsqj-fjDnqAOXNNg';

export interface RunRecord {
  at: number;
  exitCode: number;
  postsSent: number;
  alertsSent: number;
  telegram: { chat: 'posts' | 'alerts'; text: string; previewDisabled: boolean }[];
  log: string[];
}

export interface ScenarioRecord {
  name: string;
  runs: RunRecord[];
  state: RadarState;
}

export interface Golden {
  scenarios: ScenarioRecord[];
  configErrors: { name: string; message: string }[];
}

type Override = (url: URL, init: RequestInit | undefined) => Response | Error | undefined;

/** FakeWorld с YouTube и точечной подменой ответа любого запроса. */
class DiscoursWorld extends FakeWorld {
  yt: { id: string; publishedAt: number; title: string; privacy?: string }[] = [];
  override: Override | undefined;

  addYt(id: string, publishedAt: number, title = `Видео ${id}`): void {
    this.yt.unshift({ id, publishedAt, title });
  }

  world: FetchLike = async (input, init) => {
    const url = new URL(input);
    const replaced = this.override?.(url, init);
    if (replaced instanceof Error) throw replaced;
    if (replaced) return replaced.clone();
    if (url.hostname === 'www.googleapis.com') {
      if (url.pathname.endsWith('/channels')) {
        return json({ items: [{ id: 'UCXEydGIYsqj-fjDnqAOXNNg', contentDetails: { relatedPlaylists: { uploads: UPLOADS } } }] });
      }
      return json({
        items: this.yt.map((v) => ({
          snippet: { title: v.title, publishedAt: new Date(v.publishedAt).toISOString(), resourceId: { videoId: v.id } },
          contentDetails: { videoId: v.id, videoPublishedAt: new Date(v.publishedAt).toISOString() },
          status: { privacyStatus: v.privacy ?? 'public' },
        })),
      });
    }
    return this.fetch(input, init);
  };
}

function discoursConfig(): RadarConfig {
  return parseConfig(JSON.parse(JSON.stringify(DISCOURS_CONFIG)));
}

class Scenario {
  readonly world = new DiscoursWorld();
  readonly state: RadarState = emptyState();
  readonly runs: RunRecord[] = [];
  secrets: Secrets = SECRETS;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async run(at: number, options: { runUrl?: boolean; dryRun?: boolean } = {}): Promise<void> {
    const before = this.world.sent.length;
    const log: string[] = [];
    const result = await runRadar(this.state, {
      config: discoursConfig(),
      secrets: this.secrets,
      fetch: this.world.world,
      now: () => at,
      log: (line) => log.push(redact(line)),
      redact,
      sleep: async () => {},
      ...(options.runUrl === false ? {} : { runUrl: RUN_URL }),
      ...(options.dryRun ? { dryRun: true } : {}),
    });
    this.runs.push({
      at,
      exitCode: result.exitCode,
      postsSent: result.postsSent,
      alertsSent: result.alertsSent,
      telegram: this.world.sent.slice(before).map((m) => ({
        chat: m.chatId === SECRETS.TELEGRAM_CHAT_ID ? 'posts' : 'alerts',
        text: m.text,
        previewDisabled: m.previewDisabled,
      })),
      log,
    });
  }

  /** Старые посты в каждой сети и первый запуск: они уходят в архив. */
  async bootstrap(at = T0): Promise<void> {
    this.world.addVk(100, at - 5 * HOUR, 'Старый пост VK');
    this.world.addFb(`${PAGE_ID}_1`, at - 4 * HOUR, 'Старый пост Facebook');
    this.world.addIg('9001', at - 3 * HOUR, 'Старый пост Instagram');
    this.world.addYt('oldVideo001', at - 6 * HOUR, 'Старое видео');
    await this.run(at);
  }

  record(): ScenarioRecord {
    return { name: this.name, runs: this.runs, state: JSON.parse(JSON.stringify(this.state)) as RadarState };
  }
}

/** Ответ, который сеть отдаёт при сбое: на хост и, если нужно, на путь. */
function failOn(host: string, response: () => Response | Error, path?: string): Override {
  return (url) => (url.hostname === host && (path === undefined || url.pathname.includes(path)) ? response() : undefined);
}

function networkError(code: string): Error {
  return new TypeError('fetch failed', { cause: { code } });
}

function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

function html(status: number): Response {
  return new Response('<html><body>502 Bad Gateway</body></html>', { status, headers: { 'content-type': 'text/html' } });
}

const FAILURES: { name: string; override: Override }[] = [
  { name: 'VK: токен отозван (5)', override: failOn('api.vk.com', () => json({ error: { error_code: 5, error_msg: 'User authorization failed: invalid access_token (4).' } })) },
  { name: 'VK: нет доступа (15)', override: failOn('api.vk.com', () => json({ error: { error_code: 15, error_msg: 'Access denied: wall is disabled' } })) },
  { name: 'VK: слишком часто (29)', override: failOn('api.vk.com', () => json({ error: { error_code: 29, error_msg: 'Rate limit reached' } })) },
  { name: 'VK: неверный параметр (100)', override: failOn('api.vk.com', () => json({ error: { error_code: 100, error_msg: 'One of the parameters specified was missing or invalid: owner_id' } })) },
  { name: 'VK: незнакомый код (1)', override: failOn('api.vk.com', () => json({ error: { error_code: 1, error_msg: 'Unknown error occurred' } })) },
  { name: 'VK: ошибка без описания', override: failOn('api.vk.com', () => json({ error: { error_code: 10 } })) },
  { name: 'VK: HTTP 502 страницей прокси', override: failOn('api.vk.com', () => html(502)) },
  { name: 'VK: HTTP 500 в JSON', override: failOn('api.vk.com', () => json({ message: 'oops' }, 500)) },
  { name: 'VK: ответ 200 не в JSON', override: failOn('api.vk.com', () => new Response('<html></html>', { status: 200 })) },
  { name: 'VK: сеть недоступна', override: failOn('api.vk.com', () => networkError('ECONNRESET')) },
  { name: 'VK: таймаут', override: failOn('api.vk.com', () => timeoutError()) },
  { name: 'VK: нет списка постов', override: failOn('api.vk.com', () => json({ response: { count: 0 } })) },
  { name: 'VK: ни один пост не разобран', override: failOn('api.vk.com', () => json({ response: { count: 2, items: [{ id: 'x' }, { date: 'вчера' }] } })) },
  { name: 'Meta: токен истёк (190)', override: failOn('graph.facebook.com', () => json({ error: { code: 190, error_subcode: 463, message: 'Error validating access token: Session has expired' } }, 400)) },
  { name: 'Meta: нет разрешения (10)', override: failOn('graph.facebook.com', () => json({ error: { code: 10, message: 'Application does not have permission for this action' } }, 403)) },
  { name: 'Meta: лимит (4)', override: failOn('graph.facebook.com', () => json({ error: { code: 4, message: 'Application request limit reached' } }, 400)) },
  { name: 'Meta: объект не найден (803)', override: failOn('graph.facebook.com', () => json({ error: { code: 803, message: 'Some of the aliases you requested do not exist' } }, 404)) },
  { name: 'Meta: HTTP 500 без ошибки', override: failOn('graph.facebook.com', () => json({}, 500)) },
  { name: 'Meta: ответ не объект', override: failOn('graph.facebook.com', () => json([1, 2, 3])) },
  { name: 'Meta: сеть недоступна', override: failOn('graph.facebook.com', () => networkError('ENOTFOUND')) },
  {
    name: 'Instagram: аккаунт не привязан',
    override: (url) => (url.hostname === 'graph.facebook.com' && url.searchParams.get('fields')?.includes('instagram_business_account') ? json({ id: PAGE_ID }) : undefined),
  },
  { name: 'Instagram: нет списка публикаций', override: failOn('graph.facebook.com', () => json({ paging: {} }), '/media') },
  {
    name: 'Facebook: нет токена страницы',
    override: (url) => (url.hostname === 'graph.facebook.com' && url.searchParams.get('fields')?.includes('access_token') ? json({ id: PAGE_ID }) : undefined),
  },
  { name: 'Facebook: нет списка постов', override: failOn('graph.facebook.com', () => json({ paging: {} }), '/posts') },
  { name: 'YouTube: квота (quotaExceeded)', override: failOn('www.googleapis.com', () => json({ error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } }, 403)) },
  {
    name: 'YouTube: ключ неверен (API_KEY_INVALID)',
    override: failOn('www.googleapis.com', () => json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }], details: [{ reason: 'API_KEY_INVALID' }] } }, 400)),
  },
  { name: 'YouTube: API выключен (accessNotConfigured)', override: failOn('www.googleapis.com', () => json({ error: { code: 403, message: 'YouTube Data API v3 has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }, 403)) },
  { name: 'YouTube: канал не найден', override: failOn('www.googleapis.com', () => json({ items: [] }), '/channels') },
  { name: 'YouTube: нет плейлиста загрузок', override: failOn('www.googleapis.com', () => json({ items: [{ contentDetails: {} }] }), '/channels') },
  { name: 'YouTube: плейлист не найден (404)', override: failOn('www.googleapis.com', () => json({ error: { code: 404, message: 'The playlist identified with the request\'s playlistId parameter cannot be found.', errors: [{ reason: 'playlistNotFound' }] } }, 404), '/playlistItems') },
  { name: 'YouTube: HTTP 503 без ошибки', override: failOn('www.googleapis.com', () => json({}, 503)) },
  { name: 'YouTube: ответ не объект', override: failOn('www.googleapis.com', () => json('строка'), '/playlistItems') },
  { name: 'YouTube: нет списка видео', override: failOn('www.googleapis.com', () => json({ kind: 'youtube#playlistItemListResponse' }), '/playlistItems') },
];

async function digestScenarios(): Promise<ScenarioRecord[]> {
  const out: ScenarioRecord[] = [];

  const four = new Scenario('дайджест четырёх сетей');
  await four.bootstrap();
  four.world.addVk(101, T0 + 2 * MINUTE, 'Дом — это люди <b>&</b> "кавычки"\nвторая строка');
  four.world.addIg('9002', T0 + 3 * MINUTE, '');
  four.world.addFb(`${PAGE_ID}_2`, T0 + 4 * MINUTE, `\n\n   Пятеро детей — не повод отказываться от себя: ${'очень длинная подпись '.repeat(6)}`);
  four.world.addYt('newVideo001', T0 + 5 * MINUTE, 'Лекция 🎙️ о главном');
  await four.run(T0 + 6 * MINUTE);
  await four.run(T0 + 16 * MINUTE);
  out.push(four.record());

  const one = new Scenario('один пост — с превью ссылки');
  await one.bootstrap();
  one.world.addVk(102, T0 + MINUTE, 'Один пост');
  await one.run(T0 + 12 * MINUTE, { runUrl: false });
  out.push(one.record());

  const long = new Scenario('длинный дайджест режется на сообщения');
  await long.bootstrap();
  for (let i = 0; i < 70; i += 1) long.world.addVk(200 + i, T0 + MINUTE + i * 1000, `Пост номер ${i}: ${'слово '.repeat(30)}`);
  await long.run(T0 + 12 * MINUTE);
  out.push(long.record());

  const stale = new Scenario('пост старше порога и архив');
  await stale.bootstrap();
  stale.world.addVk(300, T0 - 10 * HOUR, 'Архивный пост, впервые в выдаче');
  stale.world.addFb(`${PAGE_ID}_3`, T0 + MINUTE, 'Свежий пост');
  await stale.run(T0 + 5 * MINUTE);
  await stale.run(T0 + 3 * DAY);
  stale.world.addVk(301, T0 + 3 * DAY - 50 * HOUR, 'Пост за пределом 48 ч');
  await stale.run(T0 + 3 * DAY + 10 * MINUTE);
  out.push(stale.record());

  const dry = new Scenario('dry-run');
  await dry.bootstrap();
  dry.world.addVk(400, T0 + MINUTE, 'Пост для пробного запуска');
  await dry.run(T0 + 12 * MINUTE, { dryRun: true });
  out.push(dry.record());

  const telegramDown = new Scenario('Telegram не принимает сообщения');
  await telegramDown.bootstrap();
  telegramDown.world.addVk(500, T0 + MINUTE, 'Пост, который не доставлен');
  telegramDown.world.fail.telegram = json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400);
  await telegramDown.run(T0 + 12 * MINUTE);
  await telegramDown.run(T0 + 22 * MINUTE);
  delete telegramDown.world.fail.telegram;
  await telegramDown.run(T0 + 32 * MINUTE);
  out.push(telegramDown.record());

  return out;
}

async function failureScenarios(): Promise<ScenarioRecord[]> {
  const out: ScenarioRecord[] = [];
  for (const failure of FAILURES) {
    const s = new Scenario(failure.name);
    await s.bootstrap();
    s.world.override = failure.override;
    await s.run(T0 + 10 * MINUTE);
    await s.run(T0 + 20 * MINUTE);
    await s.run(T0 + 30 * MINUTE);
    await s.run(T0 + 10 * MINUTE + 26 * HOUR);
    s.world.override = undefined;
    await s.run(T0 + 27 * HOUR);
    out.push(s.record());
  }
  return out;
}

async function healthScenarios(): Promise<ScenarioRecord[]> {
  const out: ScenarioRecord[] = [];

  const secretless = new Scenario('не заданы секреты VK, Meta и YouTube');
  secretless.secrets = { TELEGRAM_BOT_TOKEN: SECRETS.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: SECRETS.TELEGRAM_CHAT_ID, TELEGRAM_ALERT_CHAT_ID: SECRETS.TELEGRAM_ALERT_CHAT_ID };
  await secretless.bootstrap();
  await secretless.run(T0 + 10 * MINUTE);
  out.push(secretless.record());

  const durations = new Scenario('давность сбоя: минуты, часы, дни');
  await durations.bootstrap();
  durations.world.override = failOn('api.vk.com', () => json({ error: { error_code: 5, error_msg: 'User authorization failed' } }));
  await durations.run(T0 + 10 * MINUTE);
  await durations.run(T0 + 69 * MINUTE);
  for (const days of [1, 2, 3, 4, 5, 11, 21, 22, 25, 101, 111]) {
    await durations.run(T0 + 10 * MINUTE + days * DAY + 3 * HOUR);
  }
  out.push(durations.record());

  const legacy = new Scenario('сбой тянется с версии без failingSince');
  await legacy.bootstrap();
  const vk = legacy.state.sources.vk;
  if (vk) {
    vk.consecutiveFailures = 3;
    vk.lastError = { kind: 'http', message: 'VK API ответил HTTP 500', at: T0 };
  }
  legacy.world.fail.vk = json({}, 500);
  await legacy.run(T0 + 10 * MINUTE);
  out.push(legacy.record());

  const partial = new Scenario('частичный сбой, затем полный');
  await partial.bootstrap();
  partial.world.addVk(600, T0 + MINUTE, 'Разобранный пост');
  partial.world.vk.unshift({ id: 'битый', date: 0, text: 'Неразобранный' } as never);
  await partial.run(T0 + 5 * MINUTE);
  await partial.run(T0 + 15 * MINUTE);
  partial.world.override = failOn('api.vk.com', () => json({ error: { error_code: 5, error_msg: 'User authorization failed' } }));
  await partial.run(T0 + 25 * MINUTE);
  partial.world.override = undefined;
  partial.world.vk = partial.world.vk.filter((p) => typeof p.id === 'number');
  await partial.run(T0 + 35 * MINUTE);
  out.push(partial.record());

  const blinking = new Scenario('мигающий источник и заблокированный чат алертов');
  await blinking.bootstrap();
  blinking.world.blockedChats.add(SECRETS.TELEGRAM_ALERT_CHAT_ID ?? '');
  const broken = failOn('graph.facebook.com', () => json({ error: { code: 190, message: 'Invalid OAuth access token.' } }, 400));
  for (let i = 1; i <= 6; i += 1) {
    blinking.world.override = i % 3 === 0 ? undefined : broken;
    await blinking.run(T0 + i * 10 * MINUTE);
  }
  out.push(blinking.record());

  const tokenInError = new Scenario('токен в тексте ошибки API');
  await tokenInError.bootstrap();
  tokenInError.world.override = failOn('api.vk.com', () =>
    json({ error: { error_code: 5, error_msg: `invalid token ${SECRETS.VK_TOKEN ?? ''} and ${'A'.repeat(45)}` } }),
  );
  await tokenInError.run(T0 + 10 * MINUTE);
  await tokenInError.run(T0 + 20 * MINUTE);
  out.push(tokenInError.record());

  return out;
}

// Конфиг-не-объект в эталон не входит: он не может назвать свой язык, и ошибка
// о нём пишется языком по умолчанию (тест «язык конфига» в i18n.test.ts).
const BAD_CONFIGS: { name: string; patch: (c: Record<string, unknown>) => unknown }[] = [
  { name: 'пустой заголовок', patch: (c) => ({ ...c, messageTitle: '  ' }) },
  { name: 'длинный заголовок', patch: (c) => ({ ...c, messageTitle: 'я'.repeat(257) }) },
  { name: 'числа вне пределов', patch: (c) => ({ ...c, groupWindowMinutes: 500, maxPostAgeHours: 0, fetchLimit: 'много' }) },
  { name: 'версии API', patch: (c) => ({ ...c, graphApiVersion: '25', vkApiVersion: 'v5' }) },
  { name: 'нет источников', patch: (c) => ({ ...c, sources: [] }) },
  {
    name: 'ошибки источников',
    patch: (c) => ({
      ...c,
      sources: [
        'vk',
        { id: 'VK!', type: 'vk', label: 'VK', ownerId: 1 },
        { id: 'constructor', type: 'vk', label: 'VK', ownerId: 1 },
        { id: 'a', type: 'vk', label: '', ownerId: 1 },
        { id: 'b', type: 'tiktok', label: 'TikTok' },
        { id: 'c', type: 'vk', label: 'VK', ownerId: 0 },
        { id: 'd', type: 'facebook', label: 'FB', pageId: 'discours' },
        { id: 'e', type: 'bluesky', label: 'Bluesky', handle: '@discours' },
        { id: 'f', type: 'youtube', label: 'YouTube', channelId: 'discours' },
        { id: 'g', type: 'x', label: 'X', userId: '@discours' },
        { id: 'h', type: 'x', label: 'X', userId: '1', username: 'слишком_длинное_имя' },
        { id: 'i', type: 'feed', label: 'RSS', url: 'http://user:pass@example.com/feed' },
        { id: 'j', type: 'vk', label: 'VK', ownerId: 1 },
        { id: 'j', type: 'vk', label: 'VK', ownerId: 2 },
      ],
    }),
  },
];

function configErrors(): { name: string; message: string }[] {
  return BAD_CONFIGS.map(({ name, patch }) => {
    try {
      parseConfig(patch(JSON.parse(JSON.stringify(DISCOURS_CONFIG)) as Record<string, unknown>));
      return { name, message: '(ошибки нет)' };
    } catch (err) {
      return { name, message: err instanceof Error ? err.message : String(err) };
    }
  });
}

export async function runScenarios(): Promise<Golden> {
  return {
    scenarios: [...(await digestScenarios()), ...(await failureScenarios()), ...(await healthScenarios())],
    configErrors: configErrors(),
  };
}
