import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';
import type { Secrets } from '../src/env.ts';
import { ALL_SECRETS, secretValues } from '../src/env.ts';
import type { FailureKind } from '../src/errors.ts';
import { formatDigest, TELEGRAM_TEXT_LIMIT } from '../src/format.ts';
import { formatFailureAlert, formatRecoveryNotice } from '../src/health.ts';
import type { FetchLike } from '../src/http.ts';
import { en } from '../src/i18n/en.ts';
import { LANGUAGES, textsFor, type Texts } from '../src/i18n/index.ts';
import { ru } from '../src/i18n/ru.ts';
import { runProbe, testMessage } from '../src/probe-run.ts';
import { newSourceState } from '../src/state.ts';
import { findRecentChats, MAX_FOUND_CHATS, TelegramError } from '../src/telegram.ts';
import type { Post, RadarConfig } from '../src/types.ts';
import { makeRedactor } from '../src/util.ts';
import { HOUR, json, MINUTE } from './helpers.ts';

const CYRILLIC = /[Ѐ-ӿ]/;
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

// ---------- Храповик: тексты для людей живут только в каталоге ----------

type Context = { kind: 'code'; depth: number } | { kind: 'template' };

/** Конец строкового литерала, начатого кавычкой в позиции start. */
function endOfString(src: string, start: number, quote: string): number {
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') i += 1;
    else if (ch === quote || ch === '\n') return i + 1;
  }
  return src.length;
}

/** Конец литерала регулярного выражения с флагами; символьный класс может содержать «/». */
function endOfRegex(src: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') i += 1;
    else if (ch === '\n') return i;
    else if (inClass) inClass = ch !== ']';
    else if (ch === '[') inClass = true;
    else if (ch === '/') {
      let end = i + 1;
      while (end < src.length && /[a-z]/.test(src[end] ?? '')) end += 1;
      return end;
    }
  }
  return src.length;
}

/** «/» после этих символов и слов начинает регулярное выражение, а не деление. */
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|void|delete|throw|new|else|do|yield|await))\s*$/;

/**
 * Код без комментариев: строки, шаблоны (с вложенными `${…}`) и регулярные
 * выражения сохраняются, комментарии вырезаются. Кириллица, оставшаяся после
 * этого, — текст для людей вне каталога.
 */
export function withoutComments(src: string): string {
  let out = '';
  const stack: Context[] = [{ kind: 'code', depth: 0 }];
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1] as Context;
    const ch = src[i] as string;
    const next = src[i + 1];
    if (top.kind === 'template') {
      if (ch === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (ch === '`') {
        stack.pop();
        out += ch;
        i += 1;
      } else if (ch === '$' && next === '{') {
        stack.push({ kind: 'code', depth: 0 });
        out += '${';
        i += 2;
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = endOfString(src, i, ch);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template' });
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && REGEX_AFTER.test(out)) {
      const end = endOfRegex(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '{') top.depth += 1;
    if (ch === '}') {
      if (top.depth === 0 && stack.length > 1) {
        stack.pop();
        out += ch;
        i += 1;
        continue;
      }
      top.depth -= 1;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('тексты для людей — только в каталоге языков', () => {
  it('сканер видит кириллицу в строке, шаблоне и регулярке и не видит её в комментариях', () => {
    const found = (code: string) => CYRILLIC.test(withoutComments(code));
    // Нарушения: каждое должно найтись, иначе храповик ниже ничего не доказывает.
    assert.ok(found("const a = 'привет';"));
    assert.ok(found('const a = "привет";'));
    assert.ok(found('const b = `x ${y} привет`;'));
    assert.ok(found("const b = `${'a'}привет`;"));
    assert.ok(found('const b = `${f({ a: 1 })} привет`;'));
    assert.ok(found('const c = /привет/;'));
    assert.ok(found('if (/привет/.test(x)) {}'));
    assert.ok(found('function f() { return /привет/.test(x); }'));
    assert.ok(found("const r = /\\/\\//; const s = 'привет';"));
    assert.ok(found("const r = /[/]/; const s = 'привет';"));
    assert.ok(found("const d = a / b; const s = 'привет';"));
    assert.ok(found("const u = 'http://x'; const s = 'привет';"));
    // Комментарии — не нарушение.
    assert.ok(!found('// привет\nconst d = 1;'));
    assert.ok(!found('/* привет */ const d = 1;'));
    assert.ok(!found('/**\n * привет\n */\nconst d = 1;'));
    assert.ok(!found("const u = 'http://x'; // привет"));
    assert.ok(!found('const t = `${a /* привет */}`;'));
    assert.ok(!found('const r = /\\/\\//; // привет'));
    assert.ok(!found('const d = a / b; // привет / c'));
  });

  it('вне src/i18n/ru.ts в литералах кода нет кириллицы', () => {
    const files = sourceFiles('src').filter((path) => path !== join('src', 'i18n', 'ru.ts'));
    assert.ok(files.length >= 20, `файлов просмотрено: ${files.length}`);
    assert.ok(files.includes(join('src', 'i18n', 'en.ts')));
    const offenders = files.flatMap((path) =>
      withoutComments(readFileSync(path, 'utf8'))
        .split('\n')
        .filter((line) => CYRILLIC.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
    assert.deepEqual(offenders, []);
  });

  it('каталоги перечислены полностью и называют свой язык', () => {
    assert.deepEqual([...LANGUAGES], ['en', 'ru']);
    for (const language of LANGUAGES) assert.equal(textsFor(language).language, language);
    assert.equal(textsFor('en'), en);
    assert.equal(textsFor('ru'), ru);
  });
});

// ---------- Поле language в конфиге ----------

const BASE = { messageTitle: 'New posts:', groupWindowMinutes: 10, maxPostAgeHours: 48, fetchLimit: 10 };
const ONE_SOURCE = [{ id: 'vk', type: 'vk', label: 'VK', ownerId: -1 }];

function configError(raw: unknown): string {
  try {
    parseConfig(raw);
  } catch (err) {
    return (err as Error).message;
  }
  assert.fail('конфиг принят, а ждали ошибку');
}

describe('язык конфига', () => {
  it('без поля — английский, ru и en — как указано', () => {
    assert.equal(parseConfig({ ...BASE, sources: ONE_SOURCE }).language, 'en');
    assert.equal(parseConfig({ ...BASE, language: 'ru', sources: ONE_SOURCE }).language, 'ru');
    assert.equal(parseConfig({ ...BASE, language: 'en', sources: ONE_SOURCE }).language, 'en');
  });

  it('неизвестный язык — ошибка по-английски со списком языков', () => {
    for (const language of ['de', 'RU', 'ru-RU', '', 1, null, ['ru']]) {
      const message = configError({ ...BASE, language, sources: ONE_SOURCE });
      assert.ok(message.includes('language: one of en, ru; may be omitted, then en'), `${JSON.stringify(language)}: ${message}`);
      assert.ok(!CYRILLIC.test(message), message);
    }
  });

  it('ошибки конфига — на языке конфига; не объект — по-английски', () => {
    const bad = { ...BASE, fetchLimit: 0, sources: ONE_SOURCE };
    assert.match(configError(bad), /^config errors:\n- fetchLimit: must be a number from/);
    assert.ok(CYRILLIC.test(configError({ ...bad, language: 'ru' })));
    // Неверный язык и другая ошибка рядом: язык неизвестен — весь список по-английски.
    const both = configError({ ...bad, language: 'de' });
    assert.ok(both.includes('fetchLimit') && both.includes('language:') && !CYRILLIC.test(both), both);
    for (const raw of [null, [], 'ru', 7]) assert.equal(configError(raw), 'config: expected an object');
  });
});

// ---------- Разметка: всё, что уходит в Telegram, — допустимый HTML ----------

const TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote']);
const TAG = /<(\/?)([a-z]+)((?:\s+[a-z]+="[^"<>]*")*)>/y;

/** Разметка Telegram: только его теги, закрыты по порядку, «&» — только сущностью, длина — в пределе. */
function assertTelegramHtml(html: string, where: string): void {
  assert.ok(html.length <= TELEGRAM_TEXT_LIMIT, `${where}: длина ${html.length}`);
  const open: string[] = [];
  for (let i = 0; i < html.length; ) {
    const ch = html[i];
    if (ch === '<') {
      TAG.lastIndex = i;
      const match = TAG.exec(html);
      assert.ok(match, `${where}: «<» вне тега: ${html.slice(i, i + 30)}`);
      const [all, slash, name = '', attrs = ''] = match;
      assert.ok(TAGS.has(name), `${where}: тег ${name}`);
      if (slash) {
        assert.equal(open.pop(), name, `${where}: закрыт не тот тег`);
      } else {
        if (name === 'a') assert.match(attrs, /^\s+href="https:\/\/[^"]+"$/, `${where}: ссылка`);
        else assert.equal(attrs, '', `${where}: атрибуты у ${name}`);
        open.push(name);
      }
      i += all.length;
      continue;
    }
    if (ch === '>') assert.fail(`${where}: «>» вне тега`);
    if (ch === '&') assert.match(html.slice(i, i + 7), /^&(?:lt|gt|amp|quot);/, `${where}: «&» без сущности`);
    i += 1;
  }
  assert.deepEqual(open, [], `${where}: незакрытые теги`);
}

const ALL_KINDS: FailureKind[] = ['auth', 'permission', 'rate_limit', 'billing', 'network', 'http', 'bad_response', 'config'];
const LABEL = 'R&D <News> "Daily"';

function everyNetwork(language: string): RadarConfig {
  return parseConfig({
    ...BASE,
    language,
    sources: [
      { id: 'vk', type: 'vk', label: LABEL, ownerId: -1 },
      { id: 'ig', type: 'instagram', label: LABEL, pageId: '1430627470564984' },
      { id: 'fb', type: 'facebook', label: LABEL, pageId: '1430627470564984' },
      { id: 'yt', type: 'youtube', label: LABEL, channelId: 'UCXEydGIYsqj-fjDnqAOXNNg' },
      { id: 'x', type: 'x', label: LABEL, userId: '12345' },
      { id: 'bsky', type: 'bluesky', label: LABEL, handle: 'discours.bsky.social' },
      { id: 'feed', type: 'feed', label: LABEL, url: 'https://example.com/feed.xml' },
    ],
  });
}

describe('алерты и сообщения — допустимый HTML на каждом языке', () => {
  it('алерт о сбое: каждая сеть × вид сбоя × частичный × длительность', () => {
    let checked = 0;
    for (const t of [en, ru]) {
      const config = everyNetwork(t.language);
      for (const source of config.sources) {
        for (const kind of ALL_KINDS) {
          for (const partial of [false, true]) {
            for (const failingSince of [undefined, NOW - 5 * MINUTE, NOW - 3 * HOUR, NOW - 9 * 24 * HOUR]) {
              const state = { ...newSourceState(NOW - 10 * 24 * HOUR), consecutiveFailures: 3, ...(failingSince === undefined ? {} : { failingSince }) };
              const alert = formatFailureAlert(source, state, { kind, message: 'API said <b>&nbsp;"x"' }, {
                t,
                now: NOW,
                maxPostAgeHours: config.maxPostAgeHours,
                fetchLimit: config.fetchLimit,
                partial,
                runUrl: 'https://github.com/o/r/actions/runs/1?a=1&b=2',
              });
              const where = `${t.language}/${source.type}/${kind}/${partial}/${failingSince}`;
              assertTelegramHtml(alert.html, where);
              assert.ok(alert.html.includes('R&amp;D &lt;News&gt; &quot;Daily&quot;'), where);
              if (t === en) assert.ok(!CYRILLIC.test(alert.html), `${where}: ${alert.html}`);
              checked += 1;
            }
          }
        }
      }
    }
    assert.equal(checked, 2 * 7 * ALL_KINDS.length * 2 * 4);
  });

  it('«снова читаются» и сообщение с постами', () => {
    for (const t of [en, ru]) {
      const config = everyNetwork(t.language);
      for (const source of config.sources) assertTelegramHtml(formatRecoveryNotice(source, t).html, `${t.language}/recovery/${source.type}`);
      const posts: Post[] = Array.from({ length: 120 }, (_, i) => ({
        sourceId: config.sources[i % config.sources.length]?.id ?? 'vk',
        id: String(i),
        url: `https://example.com/p/${i}?a=1&b=<2>`,
        publishedAt: NOW - i * MINUTE,
        text: i % 10 === 0 ? '' : `Post <${i}> & "${'word '.repeat(40)}"`,
      }));
      const chunks = formatDigest(t, 'Title <with> & "quotes"', posts, () => LABEL);
      assert.ok(chunks.length > 1, 'длинная сводка делится на сообщения');
      for (const [index, chunk] of chunks.entries()) assertTelegramHtml(chunk.html, `${t.language}/digest/${index}`);
      assert.ok(chunks[0]?.html.includes(escapeHtmlLike(t.digest.untitledPost)));
      if (t === en) assert.ok(!chunks.some((chunk) => CYRILLIC.test(chunk.html)));
    }
  });

  it('английский алерт целиком', () => {
    const [source] = parseConfig({ ...BASE, fetchLimit: 25, sources: [{ id: 'vk', type: 'vk', label: 'VK', ownerId: -1 }] }).sources;
    assert.ok(source);
    const state = { ...newSourceState(NOW - 24 * HOUR), consecutiveFailures: 4, failingSince: NOW - 2 * HOUR - 5 * MINUTE };
    const alert = formatFailureAlert(source, state, { kind: 'auth', message: 'VK: User authorization failed: invalid access_token (5)' }, {
      t: en,
      now: NOW,
      maxPostAgeHours: 48,
      fetchLimit: 25,
      runUrl: 'https://github.com/discours/social-notifier/actions/runs/1',
    });
    assert.equal(
      alert.html,
      [
        "<b>VK</b>: can't read posts for 2 h.",
        'What to do: issue a new token and update the VK_TOKEN secret in the repository settings (Settings → Secrets and variables → Actions).',
        'Posts published in the meantime will arrive after the fix if they are among the latest 25 and no older than 48 h.',
        'Reason: <code>auth</code> — VK: User authorization failed: invalid access_token (5)',
        '<a href="https://github.com/discours/social-notifier/actions/runs/1">Run log</a>',
      ].join('\n'),
    );
    assert.equal(formatRecoveryNotice(source, en).html, '<b>VK</b>: posts are being read again.');
  });

  it('метки скрытых секретов — на языке каталога', () => {
    const secret = 'super-secret-token-value';
    assert.equal(makeRedactor([secret], en.redacted)(`token ${secret}`), 'token [secret]');
    assert.equal(makeRedactor([secret], ru.redacted)(`token ${secret}`), 'token [секрет]');
  });
});

function escapeHtmlLike(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Поиск чатов ----------

const TOKEN = '123456:TEST-bot-token-value';

interface BotCall {
  method: string;
  params: Record<string, unknown>;
}

/** Поддельный Bot API: getUpdates отдаёт `updates`, sendMessage копит сообщения. */
class FakeBot {
  updates: unknown[] = [];
  updatesStatus = 200;
  calls: BotCall[] = [];
  sent: { chatId: string; text: string }[] = [];
  blocked = new Set<string>();
  chats = new Map<string, { type: string; status?: string }>();
  vkPosts: { id: number; date: number; text: string }[] = [];

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'api.vk.com') return json({ response: { count: this.vkPosts.length, items: this.vkPosts } });
    assert.equal(url.hostname, 'api.telegram.org');
    const method = url.pathname.split('/').pop() ?? '';
    const params = JSON.parse(typeof init?.body === 'string' && init.body ? init.body : '{}') as Record<string, unknown>;
    this.calls.push({ method, params });
    if (method === 'getMe') return json({ ok: true, result: { id: 42, is_bot: true, username: 'radar_bot' } });
    if (method === 'getUpdates') {
      if (this.updatesStatus !== 200) {
        return json({ ok: false, error_code: this.updatesStatus, description: "Conflict: can't use getUpdates method while webhook is active" }, this.updatesStatus);
      }
      return json({ ok: true, result: this.updates });
    }
    const chatId = String(params.chat_id);
    if (method === 'getChat') return json({ ok: true, result: { id: Number(chatId), type: this.chats.get(chatId)?.type ?? 'private' } });
    if (method === 'getChatMember') return json({ ok: true, result: { status: this.chats.get(chatId)?.status ?? 'administrator', can_post_messages: true } });
    if (method === 'sendMessage') {
      if (this.blocked.has(chatId)) return json({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the group chat' }, 403);
      this.sent.push({ chatId, text: String(params.text) });
      return json({ ok: true, result: { message_id: this.sent.length } });
    }
    throw new Error(`неожиданный метод: ${method}`);
  };
}

const message = (chatId: number, type: string) => ({ update_id: 1, message: { message_id: 1, chat: { id: chatId, type }, text: '/start' } });
const channelPost = (chatId: number) => ({ update_id: 1, channel_post: { message_id: 1, chat: { id: chatId, type: 'channel' }, text: 'post' } });
const membership = (chatId: number, type: string, status: string) => ({
  update_id: 1,
  my_chat_member: { chat: { id: chatId, type }, from: { id: 7 }, date: 1, old_chat_member: { status: 'member' }, new_chat_member: { status } },
});

describe('поиск чатов по обновлениям бота', () => {
  it('находит личный чат, группу и канал; запрос не подтверждает обновления и не меняет подписку', async () => {
    const bot = new FakeBot();
    bot.updates = [message(987654321, 'private'), membership(-4455667788, 'supergroup', 'member'), channelPost(-1009988776655)];
    const chats = await findRecentChats(bot.fetch, TOKEN);
    assert.deepEqual(chats, [
      { id: '987654321', type: 'private' },
      { id: '-4455667788', type: 'supergroup' },
      { id: '-1009988776655', type: 'channel' },
    ]);
    assert.deepEqual(bot.calls, [{ method: 'getUpdates', params: { timeout: 0, limit: 100 } }]);
  });

  it('правленое сообщение и пост тоже называют чат; повтор чата переносит его в конец', async () => {
    const bot = new FakeBot();
    bot.updates = [
      message(1, 'private'),
      { update_id: 2, edited_message: { chat: { id: 2, type: 'group' } } },
      { update_id: 3, edited_channel_post: { chat: { id: 3, type: 'channel' } } },
      message(1, 'private'),
    ];
    assert.deepEqual(
      (await findRecentChats(bot.fetch, TOKEN)).map((chat) => chat.id),
      ['2', '3', '1'],
    );
  });

  it('чат, откуда бота убрали, не возвращается; вернули снова — возвращается', async () => {
    const bot = new FakeBot();
    bot.updates = [membership(-1, 'group', 'member'), membership(-2, 'group', 'member'), membership(-1, 'group', 'kicked'), membership(-3, 'channel', 'left')];
    assert.deepEqual(
      (await findRecentChats(bot.fetch, TOKEN)).map((chat) => chat.id),
      ['-2'],
    );
    bot.updates.push(membership(-1, 'group', 'administrator'));
    assert.deepEqual(
      (await findRecentChats(bot.fetch, TOKEN)).map((chat) => chat.id),
      ['-2', '-1'],
    );
  });

  it('не больше десяти чатов — последние по времени', async () => {
    const bot = new FakeBot();
    bot.updates = Array.from({ length: 15 }, (_, i) => message(1000 + i, 'private'));
    const chats = await findRecentChats(bot.fetch, TOKEN);
    assert.equal(MAX_FOUND_CHATS, 10);
    assert.deepEqual(
      chats.map((chat) => chat.id),
      Array.from({ length: 10 }, (_, i) => String(1005 + i)),
    );
  });

  it('чужие формы ID и типа отбрасываются', async () => {
    const bot = new FakeBot();
    bot.updates = [
      null,
      'update',
      { update_id: 1 },
      { update_id: 2, message: { chat: { id: '123', type: 'private' } } },
      { update_id: 3, message: { chat: { id: 1.5, type: 'private' } } },
      { update_id: 4, message: { chat: { id: 2 ** 60, type: 'private' } } },
      { update_id: 5, message: { chat: null } },
      { update_id: 6, message: { chat: { id: 77, type: '<b>group</b>' } } },
      { update_id: 7, message: { chat: { id: 78 } } },
    ];
    assert.deepEqual(await findRecentChats(bot.fetch, TOKEN), [
      { id: '77', type: undefined },
      { id: '78', type: undefined },
    ]);
  });

  it('бот с webhook — ошибка со статусом 409; не список — ошибка', async () => {
    const bot = new FakeBot();
    bot.updatesStatus = 409;
    await assert.rejects(findRecentChats(bot.fetch, TOKEN), (err) => err instanceof TelegramError && err.status === 409);
    const odd = new FakeBot();
    odd.updates = { not: 'a list' } as unknown as unknown[];
    await assert.rejects(findRecentChats(odd.fetch, TOKEN), TelegramError);
  });

  it('разбор линеен: сто тысяч обновлений по разным чатам', async () => {
    const bot = new FakeBot();
    bot.updates = Array.from({ length: 100_000 }, (_, i) => message(i + 1, 'private'));
    const started = performance.now();
    const chats = await findRecentChats(bot.fetch, TOKEN);
    const elapsed = performance.now() - started;
    assert.equal(chats.length, MAX_FOUND_CHATS);
    assert.equal(chats.at(-1)?.id, '100000');
    assert.ok(elapsed < 3000, `разбор занял ${Math.round(elapsed)} мс`);
  });
});

// ---------- Проба: поиск чатов и тестовое сообщение ----------

const PROBE_SECRETS: Secrets = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_CHAT_ID: '-100111222333',
  TELEGRAM_ALERT_CHAT_ID: '444555666',
  VK_TOKEN: 'vk1.a.test-vk-token-value',
};

function probeDeps(bot: FakeBot, t: Texts, config: RadarConfig | undefined, extra: { sendTest?: boolean; findChats?: boolean }) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      config,
      t,
      secrets: PROBE_SECRETS,
      fetch: bot.fetch,
      log: (line: string) => lines.push(line),
      redact: makeRedactor(secretValues(PROBE_SECRETS), t.redacted),
      now: () => NOW,
      ...extra,
    },
  };
}

describe('проба', () => {
  const ids = ['987654321', '-4455667788', '-1009988776655'];

  it('поиск чатов отвечает в каждый чат его ID, а в публичный лог ID не попадает', async () => {
    for (const t of [en, ru]) {
      const bot = new FakeBot();
      bot.updates = [message(987654321, 'private'), membership(-4455667788, 'supergroup', 'member'), channelPost(-1009988776655)];
      const { lines, deps } = probeDeps(bot, t, undefined, { findChats: true });
      assert.equal(await runProbe(deps), 0);
      assert.deepEqual(
        bot.sent.map((sent) => sent.chatId),
        ids,
      );
      for (const [index, sent] of bot.sent.entries()) {
        assert.ok(sent.text.startsWith(`${escapeHtmlLike(t.probe.chatIdIntro)} <code>${ids[index]}</code>\n`), sent.text);
        assertTelegramHtml(sent.text, `${t.language}/chat-id`);
      }
      const log = lines.join('\n');
      for (const id of ids) assert.ok(!log.includes(id.replace('-', '')), `${t.language}: ID ${id} в логе:\n${log}`);
      assert.ok(log.includes(t.probe.chatName(3, 'channel')));
      assert.ok(log.includes(t.probe.chatsSummary(3, 3)));
      if (t === en) assert.ok(!CYRILLIC.test(log), log);
      assert.ok(!bot.calls.some((call) => call.method === 'sendMessage' && ids.indexOf(String(call.params.chat_id)) === -1));
    }
  });

  it('поиск чатов: отказ одного чата не мешает остальным; ни одного ответа — код 1', async () => {
    const bot = new FakeBot();
    bot.updates = [message(987654321, 'private'), membership(-4455667788, 'supergroup', 'member')];
    bot.blocked.add('-4455667788');
    const { lines, deps } = probeDeps(bot, en, undefined, { findChats: true });
    assert.equal(await runProbe(deps), 0);
    assert.deepEqual(
      bot.sent.map((sent) => sent.chatId),
      ['987654321'],
    );
    assert.ok(lines.some((line) => line.startsWith('chat 2 (supergroup): ERROR Telegram responded with HTTP 403')), lines.join('\n'));
    assert.ok(lines.includes(en.probe.chatsSummary(2, 1)));
    bot.blocked.add('987654321');
    bot.sent = [];
    assert.equal(await runProbe(probeDeps(bot, en, undefined, { findChats: true }).deps), 1);
  });

  it('поиск чатов: нет чатов, webhook, нет токена — понятная строка и код 1', async () => {
    const empty = new FakeBot();
    const none = probeDeps(empty, en, undefined, { findChats: true });
    assert.equal(await runProbe(none.deps), 1);
    assert.ok(none.lines.includes(en.probe.chatsNone));
    assert.deepEqual(empty.sent, []);

    const hooked = new FakeBot();
    hooked.updatesStatus = 409;
    const webhook = probeDeps(hooked, en, undefined, { findChats: true });
    assert.equal(await runProbe(webhook.deps), 1);
    assert.ok(webhook.lines.includes(en.probe.chatsWebhook));

    const lines: string[] = [];
    const code = await runProbe({ ...probeDeps(new FakeBot(), en, undefined, {}).deps, secrets: {}, findChats: true, log: (line) => lines.push(line) });
    assert.equal(code, 1);
    assert.ok(lines.includes(en.probe.botTokenMissing));
  });

  it('send_test шлёт образец уведомления только в чат алертов', async () => {
    for (const t of [en, ru]) {
      const bot = new FakeBot();
      bot.chats.set('-100111222333', { type: 'supergroup', status: 'administrator' });
      bot.vkPosts = [
        { id: 2, date: Math.floor((NOW - HOUR) / 1000), text: 'Latest <post> & more' },
        { id: 1, date: Math.floor((NOW - 2 * HOUR) / 1000), text: 'Older post' },
      ];
      const config = parseConfig({ ...BASE, language: t.language, sources: [{ id: 'vk', type: 'vk', label: 'VK', ownerId: -5 }] });
      const { lines, deps } = probeDeps(bot, t, config, { sendTest: true });
      assert.equal(await runProbe(deps), 0, lines.join('\n'));
      assert.equal(bot.sent.length, 1);
      const [sent] = bot.sent;
      assert.equal(sent?.chatId, '444555666');
      assertTelegramHtml(sent?.text ?? '', `${t.language}/send-test`);
      assert.ok(sent?.text.includes(escapeHtmlLike(t.probe.previewIntro)));
      assert.ok(sent?.text.includes('New posts:'));
      assert.ok(sent?.text.includes('https://vk.com/wall-5_2'), sent?.text);
      assert.ok(!sent?.text.includes('wall-5_1'), 'в образце — только последний пост источника');
      if (t === en) assert.ok(!CYRILLIC.test(lines.join('\n')), lines.join('\n'));
    }
  });

  it('образец уведомления влезает в одно сообщение при любом числе источников', () => {
    const sources = Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, type: 'vk', label: `Long source label number ${i}`, ownerId: -(i + 1) }));
    const config = parseConfig({ ...BASE, messageTitle: 'T'.repeat(256), sources });
    const samples: Post[] = sources.map((source, i) => ({
      sourceId: source.id,
      id: String(i),
      url: `https://vk.com/wall-${i + 1}_${i}`,
      publishedAt: NOW - i * MINUTE,
      text: `<${'long text '.repeat(30)}>`,
    }));
    for (const t of [en, ru]) {
      const html = testMessage(t, config, samples).html;
      assertTelegramHtml(html, `${t.language}/sample`);
      assert.ok(html.length > TELEGRAM_TEXT_LIMIT - 500, 'образец заполняет сообщение, а не обрывается рано');
    }
    assert.equal(testMessage(en, config, []).html, escapeHtmlLike(en.probe.testMessage));
  });

  it('send_test без чата алертов не пишет в чат постов', async () => {
    const bot = new FakeBot();
    const config = parseConfig({ ...BASE, sources: [{ id: 'vk', type: 'vk', label: 'VK', ownerId: -5 }] });
    const { lines, deps } = probeDeps(bot, en, config, { sendTest: true });
    const { TELEGRAM_ALERT_CHAT_ID: _alert, ...withoutAlerts } = PROBE_SECRETS;
    assert.equal(await runProbe({ ...deps, secrets: withoutAlerts }), 1);
    assert.deepEqual(bot.sent, []);
    assert.ok(lines.some((line) => line.includes(en.probe.sendTestNeedsAlertChat)), lines.join('\n'));
  });
});

describe('проводка флагов пробы', () => {
  it('workflow probe передаёт send_test и find_chats в CLI', () => {
    const workflow = readFileSync(join('.github', 'workflows', 'probe.yml'), 'utf8');
    for (const [input, env, flag] of [
      ['send_test', 'SEND_TEST', '--send-test'],
      ['find_chats', 'FIND_CHATS', '--find-chats'],
    ] as const) {
      assert.match(workflow, new RegExp(`\\n      ${input}:\\n        description: '[^']+'\\n        type: boolean\\n        default: false\\n`), input);
      assert.ok(workflow.includes(`          ${env}: \${{ inputs.${input} }}\n`), env);
      assert.ok(workflow.includes(`          if [ "$${env}" = "true" ]; then args+=(${flag}); fi\n`), flag);
    }
  });

  it('CLI с --find-chats ищет чаты даже без конфига, без флага — нет', () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ALL_SECRETS) delete env[name];
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['src/probe.ts', '--config', 'no-such-config.json', ...args], { env, encoding: 'utf8', timeout: 30_000 });
    const withFlag = run(['--find-chats']);
    assert.equal(withFlag.status, 1, withFlag.stderr);
    assert.ok(withFlag.stdout.includes(en.probe.crashed('cannot read no-such-config.json')), withFlag.stdout);
    assert.ok(withFlag.stdout.includes(en.probe.botTokenMissing), withFlag.stdout);
    const withoutFlag = run([]);
    assert.equal(withoutFlag.status, 1, withoutFlag.stderr);
    assert.ok(!withoutFlag.stdout.includes(en.probe.botTokenMissing), withoutFlag.stdout);
  });
});

// ---------- Документация на двух языках ----------

const ROOT_DOCS = ['README', 'SECURITY', 'CONTRIBUTING'];

/** Пары документации: английский `x.md` и русский `x.ru.md`. */
function docPairs(): { en: string; ru: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.md') ? [path] : [];
    });
  const english = [...walk('docs'), ...ROOT_DOCS.map((name) => `${name}.md`)].filter((path) => !path.endsWith('.ru.md'));
  return english.map((path) => ({ en: path, ru: path.replace(/\.md$/, '.ru.md') }));
}

/** Якорь заголовка, как его строит GitHub. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsOf(path: string): Set<string> {
  const anchors = new Set<string>();
  let inCode = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trimStart().startsWith('```')) inCode = !inCode;
    const heading = !inCode && /^#{1,6} (.+)$/.exec(line);
    if (heading) anchors.add(slug(heading[1] ?? ''));
  }
  return anchors;
}

/**
 * Относительные ссылки Markdown вне блоков кода: [текст](путь#якорь). Строка
 * переключателя языка (третья) не в счёт: её проверяет отдельный тест.
 */
function linksOf(path: string): { target: string; anchor: string | undefined }[] {
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .filter((_, i) => i !== 2)
    .join('\n')
    .replace(/```[\s\S]*?```/g, '');
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1] ?? '')
    .filter((href) => !/^[a-z]+:/.test(href))
    .map((href) => {
      const [file = '', anchor] = href.split('#');
      return { target: file === '' ? path : join(dirname(path), file), anchor };
    });
}

describe('документация на двух языках', () => {
  const pairs = docPairs();

  it('у каждой страницы есть пара на другом языке с переключателем под заголовком', () => {
    assert.ok(pairs.length >= 12, `пар: ${pairs.length}`);
    for (const { en: enPath, ru: ruPath } of pairs) {
      assert.ok(existsSync(ruPath), `${ruPath}: нет русской пары`);
      const enLines = readFileSync(enPath, 'utf8').split('\n');
      const ruLines = readFileSync(ruPath, 'utf8').split('\n');
      const name = basename(enPath);
      assert.equal(enLines[2], `**English** · [Русский](${basename(ruPath)})`, enPath);
      assert.equal(ruLines[2], `[English](${name}) · **Русский**`, ruPath);
    }
  });

  it('английские страницы без кириллицы, кроме переключателя', () => {
    for (const { en: enPath } of pairs) {
      const lines = readFileSync(enPath, 'utf8').split('\n');
      const offenders = lines.filter((line, i) => i !== 2 && CYRILLIC.test(line));
      assert.deepEqual(offenders, [], enPath);
    }
  });

  it('ссылки ведут на существующие файлы и заголовки, русские страницы — на русские пары', () => {
    let checked = 0;
    for (const { en: enPath, ru: ruPath } of pairs) {
      for (const path of [enPath, ruPath]) {
        for (const { target, anchor } of linksOf(path)) {
          assert.ok(existsSync(target), `${path}: нет файла ${target}`);
          if (anchor !== undefined) assert.ok(anchorsOf(target).has(anchor), `${path}: нет заголовка #${anchor} в ${target}`);
          if (target.endsWith('.md') && target !== path) {
            const isRu = target.endsWith('.ru.md');
            const twin = isRu ? target : target.replace(/\.md$/, '.ru.md');
            if (path === ruPath && existsSync(twin)) assert.ok(isRu, `${path}: ссылка на английскую ${target}`);
            if (path === enPath && isRu) assert.equal(target, ruPath, `${path}: ссылка на русскую ${target}`);
          }
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 60, `ссылок проверено: ${checked}`);
  });

  it('примеры конфига в README и инструкции проходят проверку конфига', () => {
    let blocks = 0;
    for (const path of ['README.md', 'README.ru.md', join('docs', 'setup.md'), join('docs', 'setup.ru.md')]) {
      for (const [, block] of readFileSync(path, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)) {
        const raw: unknown = JSON.parse((block ?? '').replace(/^ {3}/gm, ''));
        assert.doesNotThrow(() => parseConfig(raw), path);
        blocks += 1;
      }
    }
    assert.equal(blocks, 4);
  });
});
