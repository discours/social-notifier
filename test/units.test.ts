import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig, parseConfig } from '../src/config.ts';
import { SourceError, toSourceError } from '../src/errors.ts';
import { escapeHtml, formatDigest, snippet } from '../src/format.ts';
import { takeDue } from '../src/group.ts';
import { claimAlertRed, failureHint, recordFailure, recordSuccess, REALERT_AFTER_MS } from '../src/health.ts';
import { requestJson } from '../src/http.ts';
import { fetchFacebookPosts, parseFacebookPosts } from '../src/sources/facebook.ts';
import { fetchInstagramPosts, parseInstagramMedia } from '../src/sources/instagram.ts';
import { classifyGraphError } from '../src/sources/meta.ts';
import { classifyVkError, fetchVkPosts, parseVkWall } from '../src/sources/vk.ts';
import { emptyState, loadState, newSourceState, parseState, rememberSeen, saveState, SEEN_LIMIT, sourceStateOf } from '../src/state.ts';
import { sendTelegramMessage } from '../src/telegram.ts';
import type { PendingPost, Post, VkSource } from '../src/types.ts';
import { makeRedactor, parseGraphTime } from '../src/util.ts';
import { FakeWorld, MINUTE, PAGE_ID, PAGE_TOKEN, SECRETS, json, redact, testConfig } from './helpers.ts';

const VK: VkSource = { id: 'vk', type: 'vk', label: 'VK', ownerId: -89236419 };

function pending(id: string, publishedAt: number, detectedAt = publishedAt): PendingPost {
  return { sourceId: 'vk', id, url: `https://vk.com/wall-1_${id}`, publishedAt, detectedAt, text: '' };
}

describe('takeDue', () => {
  it('пустая очередь и открытое окно — ничего', () => {
    assert.equal(takeDue([], 0, 10 * MINUTE), null);
    assert.equal(takeDue([pending('1', 0)], 9 * MINUTE, 10 * MINUTE), null);
  });
  it('окно закрылось — вся очередь по времени публикации', () => {
    const due = takeDue([pending('2', 5 * MINUTE), pending('1', 0)], 10 * MINUTE, 10 * MINUTE);
    assert.deepEqual(due?.map((p) => p.id), ['1', '2']);
  });
  it('отсчёт от обнаружения, если время публикации в будущем', () => {
    const future = pending('1', 60 * MINUTE, 0);
    assert.ok(takeDue([future], 10 * MINUTE, 10 * MINUTE));
  });
});

describe('format', () => {
  it('escapeHtml экранирует разметку и кавычки', () => {
    assert.equal(escapeHtml('<b>"A&B"</b>'), '&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
  });
  it('snippet: первая непустая строка, обрезка по слову, эмодзи целы', () => {
    assert.equal(snippet('\n\n  Первая строка  \nвторая'), 'Первая строка');
    assert.equal(snippet(''), '');
    const long = 'слово '.repeat(30);
    const cut = snippet(long, 20);
    assert.ok(cut.endsWith('…'));
    assert.ok([...cut].length <= 20);
    assert.ok(!cut.includes('слов…'), 'не режет слово посередине');
    const emoji = snippet('😀'.repeat(50), 10);
    assert.equal([...emoji].length, 10);
    assert.ok(!emoji.includes('�'));
  });
  it('formatDigest: превью только у одиночного поста, текст и ссылка экранированы', () => {
    const post: Post = { sourceId: 'vk', id: '1', url: 'https://x.test/?a=1&b="2"', publishedAt: 0, text: '<script>' };
    const [single] = formatDigest('Заголовок', [post], () => 'VK');
    assert.equal(single?.disablePreview, false);
    assert.ok(single?.html.includes('href="https://x.test/?a=1&amp;b=&quot;2&quot;"'));
    assert.ok(single?.html.includes('&lt;script&gt;'));
    const [multi] = formatDigest('Заголовок', [post, { ...post, id: '2', text: '' }], () => 'VK');
    assert.equal(multi?.disablePreview, true);
    assert.ok(multi?.html.includes('пост без подписи'));
  });
  it('formatDigest: длинная очередь делится на несколько сообщений с заголовком', () => {
    const posts: Post[] = Array.from({ length: 10 }, (_, i) => ({
      sourceId: 'vk',
      id: String(i),
      url: `https://vk.com/wall-1_${i}`,
      publishedAt: i,
      text: `пост номер ${i}`,
    }));
    const messages = formatDigest('Заголовок', posts, () => 'VK', 300);
    assert.ok(messages.length > 1);
    for (const m of messages) {
      assert.ok(m.html.startsWith('Заголовок'));
      assert.ok(m.html.length <= 300);
    }
    const total = messages.reduce((n, m) => n + (m.html.match(/<a href/g)?.length ?? 0), 0);
    assert.equal(total, 10, 'ни один пост не потерян');
  });
});

describe('VK', () => {
  it('разбирает стену: закреп, репост без текста, мусор пропускается и считается', () => {
    const { posts, skipped } = parseVkWall(VK, 200, {
      response: {
        count: 3,
        items: [
          { id: 900, date: 1_700_000_000, is_pinned: 1, text: 'Закреп' },
          { id: 901, date: 1_700_000_100, text: '', copy_history: [{ text: 'Текст репоста' }] },
          { id: 'плохой', date: 1_700_000_000 },
          { id: 902, date: 1e15, text: 'дата из будущего тысячелетия' },
          { id: 903, date: Number.MAX_VALUE },
          'не объект',
        ],
      },
    });
    assert.deepEqual(
      posts.map((p) => [p.id, p.url, p.text, p.publishedAt]),
      [
        ['900', 'https://vk.com/wall-89236419_900', 'Закреп', 1_700_000_000_000],
        ['901', 'https://vk.com/wall-89236419_901', 'Текст репоста', 1_700_000_100_000],
      ],
    );
    assert.equal(skipped, 4);
  });
  it('ответ, где не разобран ни один элемент, — ошибка формата, а не «новых нет»', () => {
    assert.throws(
      () => parseVkWall(VK, 200, { response: { items: [{ id: 1, created: 1_700_000_000 }] } }),
      (e: unknown) => e instanceof SourceError && e.kind === 'bad_response' && e.message.includes('VK'),
    );
    assert.deepEqual(parseVkWall(VK, 200, { response: { items: [] } }), { posts: [], skipped: 0 }, 'пустая стена — не ошибка');
  });
  it('классифицирует ошибки VK', () => {
    assert.throws(
      () => parseVkWall(VK, 200, { error: { error_code: 5, error_msg: 'User authorization failed' } }),
      (e: unknown) => e instanceof SourceError && e.kind === 'auth' && e.code === '5',
    );
    assert.equal(classifyVkError(6), 'rate_limit');
    assert.equal(classifyVkError(15), 'permission');
    assert.equal(classifyVkError(100), 'config');
    assert.throws(() => parseVkWall(VK, 200, { response: {} }), (e: unknown) => e instanceof SourceError && e.kind === 'bad_response');
  });
  it('без секрета VK_TOKEN запрос не уходит', async () => {
    const world = new FakeWorld();
    await assert.rejects(
      fetchVkPosts(VK, { config: testConfig(), secrets: {}, fetch: world.fetch }),
      (e: unknown) => e instanceof SourceError && e.kind === 'config',
    );
    assert.equal(world.calls.length, 0);
  });
});

describe('Meta', () => {
  it('время Graph API со смещением без двоеточия', () => {
    assert.equal(parseGraphTime('2026-11-07T13:17:00+0000'), Date.UTC(2026, 10, 7, 13, 17));
    assert.equal(parseGraphTime('2026-11-07T15:17:00+0200'), Date.UTC(2026, 10, 7, 13, 17));
    assert.equal(parseGraphTime('мусор'), undefined);
  });
  it('разбирает посты Facebook', () => {
    const { posts, skipped } = parseFacebookPosts(
      { id: 'facebook', type: 'facebook', label: 'Facebook', pageId: PAGE_ID },
      { data: [{ id: '1_2', created_time: '2026-11-07T13:17:00+0000', message: 'Пятеро детей', permalink_url: 'https://www.facebook.com/p/1' }, { id: '1_3' }] },
    );
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.text, 'Пятеро детей');
    assert.equal(skipped, 1);
  });
  it('Instagram: без permalink ссылка строится по shortcode, без обоих — элемент считается пропущенным', () => {
    const source = { id: 'instagram', type: 'instagram', label: 'Instagram', pageId: PAGE_ID } as const;
    const time = '2026-11-07T13:17:00+0000';
    const { posts, skipped } = parseInstagramMedia(source, {
      data: [
        { id: '1', timestamp: time, permalink: 'https://www.instagram.com/p/AAA/' },
        { id: '2', timestamp: time, shortcode: 'BBB_-1' },
        { id: '3', timestamp: time },
        { id: '4', timestamp: time, shortcode: '../evil' },
      ],
    });
    assert.deepEqual(
      posts.map((p) => p.url),
      ['https://www.instagram.com/p/AAA/', 'https://www.instagram.com/p/BBB_-1/'],
    );
    assert.equal(skipped, 2);
    assert.throws(
      () => parseInstagramMedia(source, { data: [{ id: '3', timestamp: time }] }),
      (e: unknown) => e instanceof SourceError && e.kind === 'bad_response',
    );
  });
  it('классифицирует ошибки Graph API', () => {
    assert.equal(classifyGraphError(190), 'auth');
    assert.equal(classifyGraphError(200), 'permission');
    assert.equal(classifyGraphError(10), 'permission');
    assert.equal(classifyGraphError(4), 'rate_limit');
    assert.equal(classifyGraphError(80002), 'rate_limit');
    assert.equal(classifyGraphError(100), 'config');
    assert.equal(classifyGraphError(1), 'http');
  });
  it('страница не назначена владельцу токена — ошибка доступа, посты не запрашиваются', async () => {
    const urls: string[] = [];
    const ctx = {
      config: testConfig(),
      secrets: SECRETS,
      fetch: async (url: string) => {
        urls.push(url);
        return json({ id: PAGE_ID });
      },
    };
    await assert.rejects(
      fetchFacebookPosts({ id: 'facebook', type: 'facebook', label: 'Facebook', pageId: PAGE_ID }, ctx),
      (e: unknown) => e instanceof SourceError && e.kind === 'permission',
    );
    assert.equal(urls.length, 1);
  });
  it('токен страницы, попавший в текст ошибки, вычищается', async () => {
    const ctx = {
      config: testConfig(),
      secrets: SECRETS,
      fetch: async (url: string) =>
        url.includes('/posts')
          ? json({ error: { code: 190, message: `Invalid token ${PAGE_TOKEN}` } }, 400)
          : json({ id: PAGE_ID, access_token: PAGE_TOKEN }),
    };
    const err = await fetchFacebookPosts({ id: 'facebook', type: 'facebook', label: 'Facebook', pageId: PAGE_ID }, ctx).then(
      () => assert.fail('ожидалась ошибка'),
      (e: unknown) => toSourceError(e, redact),
    );
    assert.equal(err.kind, 'auth');
    assert.ok(!err.message.includes(PAGE_TOKEN));
    assert.ok(err.message.includes('Invalid token [скрыто]'), 'текст ошибки сохранился, вычищен только токен');
  });
  it('у страницы нет Instagram-аккаунта — понятная ошибка настройки', async () => {
    const ctx = {
      config: testConfig(),
      secrets: SECRETS,
      fetch: async () => json({ id: PAGE_ID }),
    };
    await assert.rejects(
      fetchInstagramPosts({ id: 'instagram', type: 'instagram', label: 'Instagram', pageId: PAGE_ID }, ctx),
      (e: unknown) => e instanceof SourceError && e.kind === 'config' && e.message.includes('instagram_basic'),
    );
  });
});

describe('health', () => {
  it('алерт со второго сбоя и не чаще раза в сутки', () => {
    const s = newSourceState();
    const err = new SourceError('auth', 'x');
    assert.equal(recordFailure(s, err, 0), false);
    assert.equal(recordFailure(s, err, 1), true);
    s.alertedAt = 1;
    assert.equal(recordFailure(s, err, 2), false);
    assert.equal(recordFailure(s, err, 1 + REALERT_AFTER_MS), true);
    assert.equal(recordSuccess(s), true, 'после алерта успех — это починка');
    assert.equal(recordSuccess(s), true, 'пока уведомление о починке не доставлено, оно остаётся к отправке');
    delete s.alertedAt; // так делает доставка уведомления
    assert.equal(recordSuccess(s), false);
    assert.equal(s.consecutiveFailures, 0);
  });
  it('красный запуск из-за алерта — не чаще раза в сутки, починка сбрасывает отсчёт', () => {
    const s = newSourceState();
    assert.equal(claimAlertRed(s, 0), true);
    assert.equal(claimAlertRed(s, REALERT_AFTER_MS - 1), false);
    assert.equal(claimAlertRed(s, REALERT_AFTER_MS), true);
    recordSuccess(s);
    assert.equal(claimAlertRed(s, REALERT_AFTER_MS + 1), true);
  });
  it('подсказка называет нужный секрет', () => {
    assert.ok(failureHint('auth', VK).includes('VK_TOKEN'));
    assert.ok(failureHint('auth', { id: 'fb', type: 'facebook', label: 'FB', pageId: PAGE_ID }).includes('META_TOKEN'));
  });
});

describe('state', () => {
  it('нет файла — пустое состояние; запись и чтение совпадают', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-'));
    const path = join(dir, 'nested', 'state.json');
    assert.deepEqual(loadState(path), emptyState());
    const state = emptyState();
    state.pending.push(pending('1', 5));
    saveState(path, state);
    assert.deepEqual(loadState(path), state);
  });
  it('повреждённый файл — ошибка, а не тихий сброс', () => {
    assert.throws(() => parseState('{'), /не JSON/);
    assert.throws(() => parseState('{"version":2,"sources":{},"pending":[]}'), /version/);
    assert.throws(() => parseState('{"version":1,"sources":{},"pending":[{"id":1}]}'), /очереди/);
    const post = { sourceId: 'vk', id: '1', url: 'https://vk.com/wall-1_1', publishedAt: 1, detectedAt: 1, text: '' };
    const withPost = (p: object) => JSON.stringify({ version: 1, sources: {}, pending: [p] });
    assert.doesNotThrow(() => parseState(withPost(post)), 'исправный пост проходит');
    assert.throws(() => parseState(withPost({ ...post, publishedAt: null })), /очереди/, 'Infinity после JSON — null');
    const { text: _text, ...withoutText } = post;
    assert.throws(() => parseState(withPost(withoutText)), /очереди/);
    const source = { bootstrapped: true, seen: ['1'], consecutiveFailures: 0 };
    const withSource = (s: object) => JSON.stringify({ version: 1, sources: { vk: s }, pending: [] });
    assert.doesNotThrow(() => parseState(withSource(source)));
    assert.throws(() => parseState(withSource({ ...source, seen: [1] })), /источник vk/);
    assert.throws(() => parseState(withSource({ ...source, consecutiveFailures: -1 })), /источник vk/);
    const dir = mkdtempSync(join(tmpdir(), 'radar-'));
    writeFileSync(join(dir, 's.json'), '[]');
    assert.throws(() => loadState(join(dir, 's.json')));
  });
  it('rememberSeen: новые в начале, без повторов, с ограничением', () => {
    const s = newSourceState();
    rememberSeen(s, ['1', '2']);
    rememberSeen(s, ['3', '1']);
    assert.deepEqual(s.seen, ['3', '1', '2']);
    rememberSeen(s, Array.from({ length: SEEN_LIMIT + 50 }, (_, i) => `n${i}`));
    assert.equal(s.seen.length, SEEN_LIMIT);
  });
});

describe('config', () => {
  it('рабочий radar.config.json проходит проверку', () => {
    const config = loadConfig('radar.config.json');
    assert.deepEqual(
      config.sources.map((s) => s.type),
      ['vk', 'instagram', 'facebook'],
    );
  });
  it('отклоняет нечисловой pageId, повтор id и нулевой ownerId', () => {
    const base = {
      messageTitle: 'x',
      groupWindowMinutes: 10,
      maxPostAgeHours: 48,
      fetchLimit: 10,
      graphApiVersion: 'v25.0',
      vkApiVersion: '5.199',
    };
    assert.throws(() => parseConfig({ ...base, sources: [{ id: 'fb', type: 'facebook', label: 'FB', pageId: '../me' }] }), /pageId/);
    assert.throws(
      () =>
        parseConfig({
          ...base,
          sources: [
            { id: 'a', type: 'vk', label: 'VK', ownerId: -1 },
            { id: 'a', type: 'vk', label: 'VK', ownerId: -2 },
          ],
        }),
      /повторяется/,
    );
    assert.throws(() => parseConfig({ ...base, sources: [{ id: 'a', type: 'vk', label: 'VK', ownerId: 0 }] }), /ownerId/);
  });
  it('отклоняет служебные имена в id и слишком длинный заголовок', () => {
    const base = {
      messageTitle: 'x',
      groupWindowMinutes: 10,
      maxPostAgeHours: 48,
      fetchLimit: 10,
      graphApiVersion: 'v25.0',
      vkApiVersion: '5.199',
    };
    const vk = { type: 'vk', label: 'VK', ownerId: -1 };
    assert.doesNotThrow(() => parseConfig({ ...base, sources: [{ ...vk, id: 'vk' }] }));
    for (const id of ['constructor', '__proto__', 'tostring', 'hasownproperty'].filter((s) => s in Object.prototype || s === '__proto__')) {
      assert.throws(() => parseConfig({ ...base, sources: [{ ...vk, id }] }), /служебное имя/, id);
    }
    assert.doesNotThrow(() => parseConfig({ ...base, messageTitle: 'я'.repeat(256), sources: [{ ...vk, id: 'vk' }] }));
    assert.throws(() => parseConfig({ ...base, messageTitle: 'я'.repeat(257), sources: [{ ...vk, id: 'vk' }] }), /messageTitle/);
  });
  it('sourceStateOf не отдаёт свойства прототипа', () => {
    const state = emptyState();
    assert.throws(() => sourceStateOf(state, 'constructor'));
    assert.equal(sourceStateOf(state, 'vk'), sourceStateOf(state, 'vk'), 'одно и то же состояние');
    assert.equal(Object.getPrototypeOf(state.sources), Object.prototype);
  });
});

describe('секреты и сеть', () => {
  it('redactor вычищает известные секреты и длинные токены, ссылки не трогает', () => {
    const r = makeRedactor(['secret-value-1', undefined, 'abc']);
    assert.equal(r('токен secret-value-1 тут'), 'токен [секрет] тут');
    assert.equal(r('коротко abc'), 'коротко abc', 'слишком короткое значение не считается секретом');
    assert.equal(r(`x ${'A'.repeat(60)} y`), 'x [скрыто] y');
    assert.equal(r('https://vk.com/wall-89236419_24072'), 'https://vk.com/wall-89236419_24072');
  });
  it('сетевая ошибка не раскрывает адрес запроса', async () => {
    const failing = async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${SECRETS.telegramBotToken}/sendMessage`);
    };
    await assert.rejects(requestJson(failing, 'https://example.test'), (e: unknown) => {
      return e instanceof SourceError && e.kind === 'network' && !e.message.includes(SECRETS.telegramBotToken ?? '-');
    });
  });
  it('Telegram: один повтор после 429 с retry_after', async () => {
    let calls = 0;
    const slept: number[] = [];
    const fetchFn = async () => {
      calls += 1;
      return calls === 1 ? json({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, 429) : json({ ok: true });
    };
    await sendTelegramMessage(fetchFn, 't', 'c', { html: 'x', disablePreview: true }, async (ms) => {
      slept.push(ms);
    });
    assert.equal(calls, 2);
    assert.deepEqual(slept, [3000]);
  });
});
