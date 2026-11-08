import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { ALL_SECRETS, SOURCE_SECRETS } from '../src/env.ts';
import { SourceError } from '../src/errors.ts';
import { failureHint, formatDuration, formatFailureAlert, recordFailure, recordSuccess } from '../src/health.ts';
import type { FetchLike } from '../src/http.ts';
import { classifyBlueskyError, fetchBlueskyPosts, type BlueskySource } from '../src/sources/bluesky.ts';
import { feedUrl, fetchFeedPosts, parseFeed, type FeedSource } from '../src/sources/feed.ts';
import { allAdapters, findAdapter, SOURCE_TYPES, type SourceContext } from '../src/sources/index.ts';
import { fetchXPosts, newestId, type XSource } from '../src/sources/x.ts';
import { decodeEntities, htmlToText } from '../src/sources/xml.ts';
import { fetchYoutubePosts, type YoutubeSource } from '../src/sources/youtube.ts';
import { runRadar } from '../src/radar.ts';
import { emptyState, newSourceState, parseState } from '../src/state.ts';
import { HOUR, json, MINUTE, SECRETS, testConfig } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 8, 12, 0);

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** fetch, который отвечает `reply` и запоминает адреса и заголовки запросов. */
function fakeFetch(reply: (url: URL) => Response): { fetch: FetchLike; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: input, headers });
    return reply(new URL(input));
  };
  return { fetch, calls };
}

function ctx(fetch: FetchLike, extra: Partial<SourceContext> = {}): SourceContext {
  return { config: testConfig(), secrets: SECRETS, fetch, ...extra };
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
}

// ---------- Bluesky ----------

const BSKY: BlueskySource = { id: 'bluesky', type: 'bluesky', label: 'Bluesky', handle: 'discours.bsky.social' };
const DID = 'did:plc:eclio37ymobqex2ncko63h4r';

/** Элемент ленты в форме живого ответа getAuthorFeed (08.11.2026), текст свой. */
function bskyItem(rkey: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    post: {
      uri: `at://${DID}/app.bsky.feed.post/${rkey}`,
      cid: 'bafyreidagco53bymlyir36hxfygoahonorulrmlrjjbwddcwhvlggk2g54',
      author: { did: DID, handle: 'discours.bsky.social', displayName: 'Дискурс' },
      record: { $type: 'app.bsky.feed.post', createdAt, text: `Пост ${rkey}\nвторая строка`, langs: ['ru'] },
      indexedAt: createdAt,
    },
    ...extra,
  };
}

describe('Bluesky', () => {
  it('свои посты — в выдаче, репост чужого — нет, ссылка по хэндлу', async () => {
    const repost = {
      ...bskyItem('3mzrepost22b', '2026-11-08T10:00:00.000Z'),
      reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: { did: DID }, indexedAt: '2026-11-08T10:01:00.000Z' },
    };
    const { fetch, calls } = fakeFetch(() =>
      json({ feed: [bskyItem('3mzod4qisq22c', '2026-11-08T04:10:04.144885Z'), repost], cursor: 'x' }),
    );
    const { posts, skipped } = await fetchBlueskyPosts(BSKY, ctx(fetch));
    assert.equal(skipped, 0);
    assert.deepEqual(
      posts.map((p) => [p.id, p.url, p.text.split('\n')[0]]),
      [['3mzod4qisq22c', 'https://bsky.app/profile/discours.bsky.social/post/3mzod4qisq22c', 'Пост 3mzod4qisq22c']],
    );
    const url = new URL(calls[0]?.url ?? '');
    assert.equal(url.searchParams.get('actor'), 'discours.bsky.social');
    assert.equal(url.searchParams.get('filter'), 'posts_no_replies');
    assert.equal(url.searchParams.get('limit'), '10');
  });

  it('время — меньшее из createdAt и indexedAt: дата из будущего не держит пост', async () => {
    const item = bskyItem('3mzfuture22a', '2027-01-01T00:00:00.000Z');
    item.post.indexedAt = '2026-11-08T11:00:00.000Z';
    const { fetch } = fakeFetch(() => json({ feed: [item] }));
    const { posts } = await fetchBlueskyPosts(BSKY, ctx(fetch));
    assert.equal(posts[0]?.publishedAt, Date.parse('2026-11-08T11:00:00.000Z'));
  });

  it('чужой uri, кривой rkey и пост без даты не разбираются и считаются', async () => {
    const alien = bskyItem('3mzalien22a', '2026-11-08T10:00:00.000Z');
    alien.post.uri = 'at://did:plc:someoneelse/app.bsky.feed.post/3mzalien22a';
    const badKey = bskyItem('bad key', '2026-11-08T10:00:00.000Z');
    const noDate = bskyItem('3mznodate22a', 'вчера');
    noDate.post.indexedAt = 'тоже нет';
    const { fetch } = fakeFetch(() => json({ feed: [bskyItem('3mzok222222a', '2026-11-08T10:00:00.000Z'), alien, badKey, noDate] }));
    const { posts, skipped } = await fetchBlueskyPosts(BSKY, ctx(fetch));
    assert.deepEqual(posts.map((p) => p.id), ['3mzok222222a']);
    assert.equal(skipped, 3);
  });

  it('без хэндла в ответе ссылка строится по DID', async () => {
    const item = bskyItem('3mzdid222222', '2026-11-08T10:00:00.000Z');
    item.post.author.handle = 'handle.invalid!';
    const { fetch } = fakeFetch(() => json({ feed: [item] }));
    const { posts } = await fetchBlueskyPosts(BSKY, ctx(fetch));
    assert.equal(posts[0]?.url, `https://bsky.app/profile/${DID}/post/3mzdid222222`);
  });

  it('несуществующий профиль — ошибка настройки, частота — rate_limit', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'InvalidRequest', message: 'Profile not found' }, 400));
    await assert.rejects(fetchBlueskyPosts(BSKY, ctx(fetch)), (e) => e instanceof SourceError && e.kind === 'config');
    assert.equal(classifyBlueskyError(429, 'RateLimitExceeded', undefined), 'rate_limit');
    assert.equal(classifyBlueskyError(400, 'BlockedActor', undefined), 'permission');
    assert.equal(classifyBlueskyError(502, undefined, undefined), 'http');
  });
});

// ---------- RSS / Atom ----------

const FEED: FeedSource = { id: 'mastodon', type: 'feed', label: 'Mastodon', url: 'https://mastodon.social/@Mastodon.rss' };

/** RSS 2.0 в форме живой ленты Mastodon: без заголовков, HTML в description. */
const MASTODON_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Mastodon</title>
    <link>https://mastodon.social/@Mastodon</link>
    <item>
      <guid isPermaLink="true">https://mastodon.social/@Mastodon/117466985005297414</guid>
      <link>https://mastodon.social/@Mastodon/117466985005297414</link>
      <pubDate>Mon, 19 Oct 2026 09:59:05 +0000</pubDate>
      <description>&lt;p&gt;Первый абзац &amp;amp; ссылка&lt;/p&gt;&lt;p&gt;Второй&lt;/p&gt;</description>
      <media:content url="https://files.example/1.png"><media:title>картинка</media:title></media:content>
    </item>
    <item>
      <guid isPermaLink="true">https://mastodon.social/@Mastodon/117466983307949301</guid>
      <link>https://mastodon.social/@Mastodon/117466983307949301</link>
      <pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate>
      <description><![CDATA[<p>Текст в <b>CDATA</b> &amp; без раскрытия</p>]]></description>
    </item>
  </channel>
</rss>`;

/** Atom в форме живой ленты релизов GitHub. */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/nodejs/node/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/nodejs/node/releases"/>
  <title>Release notes</title>
  <entry>
    <id>tag:github.com,2008:Repository/27193779/v27.0.0</id>
    <updated>2026-10-29T18:36:37Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/nodejs/node/releases/tag/v27.0.0"/>
    <title>Version 27.0.0 &#8212; Alpha</title>
    <content type="html">&lt;h3&gt;Notable&lt;/h3&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/27193779/v26.9.0</id>
    <published>2026-10-20T10:00:00Z</published>
    <link rel="self" href="https://example.com/self"/>
    <link href="https://github.com/nodejs/node/releases/tag/v26.9.0"/>
    <title type="html">&lt;b&gt;Version&lt;/b&gt; 26.9.0</title>
  </entry>
</feed>`;

describe('RSS и Atom', () => {
  it('RSS Mastodon: ссылка, дата, текст из HTML описания; media:title не путается с заголовком', () => {
    const { posts, skipped } = parseFeed(FEED, MASTODON_RSS, 10);
    assert.equal(skipped, 0);
    assert.deepEqual(
      posts.map((p) => [p.url, new Date(p.publishedAt).toISOString(), p.text]),
      [
        ['https://mastodon.social/@Mastodon/117466985005297414', '2026-10-19T09:59:05.000Z', 'Первый абзац & ссылка\nВторой'],
        ['https://mastodon.social/@Mastodon/117466983307949301', '2026-10-19T09:58:39.000Z', 'Текст в CDATA & без раскрытия'],
      ],
    );
    assert.equal(posts[0]?.id, 'https://mastodon.social/@Mastodon/117466985005297414');
  });

  it('Atom: ссылка rel=alternate или без rel, а не self; дата published, иначе updated', () => {
    const { posts } = parseFeed(FEED, ATOM, 10);
    assert.deepEqual(
      posts.map((p) => [p.url, p.text]),
      [
        ['https://github.com/nodejs/node/releases/tag/v27.0.0', 'Version 27.0.0 — Alpha'],
        ['https://github.com/nodejs/node/releases/tag/v26.9.0', 'Version 26.9.0'],
      ],
    );
    assert.equal(posts[1]?.publishedAt, Date.parse('2026-10-20T10:00:00Z'));
  });

  it('из длинной ленты — только самые свежие fetchLimit записей, даже если она упорядочена от старых', () => {
    const items = Array.from({ length: 30 }, (_, i) => {
      const at = new Date(NOW - (30 - i) * HOUR).toUTCString();
      return `<item><guid>id-${i}</guid><link>https://example.com/${i}</link><pubDate>${at}</pubDate><title>Пост ${i}</title></item>`;
    }).join('');
    const { posts } = parseFeed(FEED, `<rss><channel>${items}</channel></rss>`, 5);
    assert.deepEqual(posts.map((p) => p.id), ['id-29', 'id-28', 'id-27', 'id-26', 'id-25']);
  });

  it('запись без даты или без ссылки не разбирается; длинный ID заменяется хэшем', () => {
    const longGuid = `https://example.com/${'x'.repeat(300)}`;
    const xml = `<rss><channel>
      <item><guid>a</guid><link>https://example.com/a</link><title>Без даты</title></item>
      <item><guid>b</guid><link>javascript:alert(1)</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate></item>
      <item><guid>${longGuid}</guid><link>https://example.com/c</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate></item>
    </channel></rss>`;
    const { posts, skipped } = parseFeed(FEED, xml, 10);
    assert.equal(skipped, 2);
    assert.match(posts[0]?.id ?? '', /^sha256:[0-9a-f]{64}$/);
  });

  it('страница вместо ленты — ошибка формата; 404 — ошибка настройки', async () => {
    assert.throws(() => parseFeed(FEED, '<!DOCTYPE html><html><body>404</body></html>', 10), /не RSS и не Atom/);
    const { fetch } = fakeFetch(() => text('<html>Not Found</html>', 404));
    await assert.rejects(fetchFeedPosts(FEED, ctx(fetch)), (e) => e instanceof SourceError && e.kind === 'config');
  });

  it('пустая лента — не ошибка: новых постов нет', () => {
    assert.deepEqual(parseFeed(FEED, '<rss><channel><title>t</title></channel></rss>', 10), { posts: [], skipped: 0 });
  });

  it('адрес ленты — только https и без логина в адресе', () => {
    assert.equal(feedUrl('https://example.com/feed.xml'), 'https://example.com/feed.xml');
    assert.equal(feedUrl('http://example.com/feed.xml'), undefined);
    assert.equal(feedUrl('https://user:pass@example.com/feed.xml'), undefined);
    assert.equal(feedUrl('file:///etc/passwd'), undefined);
    assert.equal(feedUrl(42), undefined);
  });

  it('сущности: числовые и частые именованные раскрываются, неизвестные и DTD — нет', () => {
    assert.equal(decodeEntities('&#8212; &#x2014; &laquo;а&raquo; &amp;amp; &unknown; &#xD800;'), '— — «а» &amp; &unknown; &#xD800;');
    assert.equal(htmlToText('<p>Раз<br>два</p><ul><li>три</li></ul>'), 'Раз\nдва\nтри');
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "ВЗРЫВ">]><rss><channel><item><guid>a</guid><link>https://e.com/a</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate><title>&x;</title></item></channel></rss>`;
    assert.equal(parseFeed(FEED, xxe, 10).posts[0]?.text, '&x;');
  });
});

// ---------- YouTube ----------

const YT: YoutubeSource = { id: 'youtube', type: 'youtube', label: 'YouTube', channelId: 'UCXEydGIYsqj-fjDnqAOXNNg' };
const UPLOADS = 'UUXEydGIYsqj-fjDnqAOXNNg';

function ytVideo(videoId: string, publishedAt: string, privacyStatus = 'public') {
  return {
    kind: 'youtube#playlistItem',
    id: `item-${videoId}`,
    snippet: { publishedAt, title: `Видео ${videoId}`, resourceId: { kind: 'youtube#video', videoId } },
    contentDetails: { videoId, videoPublishedAt: publishedAt },
    status: { privacyStatus },
  };
}

function youtubeApi(items: unknown[]): (url: URL) => Response {
  return (url) => {
    if (url.pathname.endsWith('/channels')) {
      return json({ items: [{ id: YT.channelId, contentDetails: { relatedPlaylists: { uploads: UPLOADS } } }] });
    }
    assert.equal(url.searchParams.get('playlistId'), UPLOADS);
    return json({ items });
  };
}

describe('YouTube', () => {
  it('видео из «Загрузок» канала; приватное и по ссылке не приходят; ключ — только в заголовке', async () => {
    const { fetch, calls } = fakeFetch(
      youtubeApi([
        ytVideo('dQw4w9WgXcQ', '2026-11-08T09:00:00Z'),
        ytVideo('privateVid1', '2026-11-08T08:00:00Z', 'private'),
        ytVideo('unlistedVi1', '2026-11-08T07:00:00Z', 'unlisted'),
      ]),
    );
    const { posts, skipped } = await fetchYoutubePosts(YT, ctx(fetch));
    assert.equal(skipped, 0);
    assert.deepEqual(posts.map((p) => [p.id, p.url, p.text]), [['dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Видео dQw4w9WgXcQ']]);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(!call.url.includes(SECRETS.YOUTUBE_API_KEY ?? '-'), 'ключ не в адресе');
      assert.equal(call.headers['x-goog-api-key'], SECRETS.YOUTUBE_API_KEY);
    }
  });

  it('элемент без статуса не отбрасывается молча, а считается неразобранным', async () => {
    const broken = { ...ytVideo('noStatus123', '2026-11-08T09:00:00Z'), status: undefined };
    const { fetch } = fakeFetch(youtubeApi([ytVideo('dQw4w9WgXcQ', '2026-11-08T09:00:00Z'), broken]));
    assert.equal((await fetchYoutubePosts(YT, ctx(fetch))).skipped, 1);
  });

  it('неверный ключ — auth, квота — rate_limit, нет канала — config', async () => {
    const cases: [unknown, number, string][] = [
      [{ error: { code: 400, message: 'API key not valid.', errors: [{ reason: 'badRequest' }], details: [{ reason: 'API_KEY_INVALID' }] } }, 400, 'auth'],
      [{ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } }, 403, 'rate_limit'],
      [{ error: { code: 403, message: 'not enabled', errors: [{ reason: 'accessNotConfigured' }] } }, 403, 'permission'],
      [{ items: [] }, 200, 'config'],
    ];
    for (const [body, status, kind] of cases) {
      const { fetch } = fakeFetch(() => json(body, status));
      await assert.rejects(fetchYoutubePosts(YT, ctx(fetch)), (e) => e instanceof SourceError && e.kind === kind, kind);
    }
  });

  it('без ключа запрос не уходит', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const secrets = { ...SECRETS };
    delete secrets.YOUTUBE_API_KEY;
    await assert.rejects(fetchYoutubePosts(YT, ctx(fetch, { secrets })), /YOUTUBE_API_KEY/);
    assert.equal(calls.length, 0);
  });
});

// ---------- X ----------

const X: XSource = { id: 'x', type: 'x', label: 'X', userId: '2244994945', username: 'discours_io' };

describe('X', () => {
  it('просит только посты новее виденных: since_id — наибольший ID как число, а не как строка', async () => {
    assert.equal(newestId(['999', '1000', 'мусор', '20']), '1000');
    assert.equal(newestId([]), undefined);
    const { fetch, calls } = fakeFetch(() => json({ meta: { result_count: 0 } }));
    const result = await fetchXPosts(X, ctx(fetch, { known: ['1460323737035677698', '999'] }));
    assert.deepEqual(result, { posts: [], skipped: 0 }, 'пустой ответ — не ошибка');
    const url = new URL(calls[0]?.url ?? '');
    assert.equal(url.pathname, '/2/users/2244994945/tweets');
    assert.equal(url.searchParams.get('since_id'), '1460323737035677698');
    assert.equal(url.searchParams.get('exclude'), 'replies,retweets');
    assert.equal(url.searchParams.get('max_results'), '10');
    assert.equal(calls[0]?.headers.authorization, `Bearer ${SECRETS.X_BEARER_TOKEN}`);
    assert.ok(!calls[0]?.url.includes(SECRETS.X_BEARER_TOKEN ?? '-'));
  });

  it('первый опрос — без since_id и не меньше пяти постов, как требует X', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ data: [{ id: '1460323737035677698', text: 'Новый текст', created_at: '2026-11-08T09:00:00.000Z' }], meta: { result_count: 1 } }),
    );
    const config = { ...testConfig(), fetchLimit: 1 };
    const { posts } = await fetchXPosts(X, ctx(fetch, { config }));
    const url = new URL(calls[0]?.url ?? '');
    assert.equal(url.searchParams.get('since_id'), null);
    assert.equal(url.searchParams.get('max_results'), '5');
    assert.deepEqual(posts.map((p) => p.url), ['https://x.com/discours_io/status/1460323737035677698']);
  });

  it('радар передаёт адаптеру виденные ID: второй опрос просит только новое, новый пост приходит', async () => {
    const posts = [{ id: '1900000000000000001', text: 'Старый пост', created_at: '2026-11-08T08:00:00.000Z' }];
    const sinceIds: (string | null)[] = [];
    const sent: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      if (url.hostname === 'api.telegram.org') {
        sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return json({ ok: true, result: {} });
      }
      const since = url.searchParams.get('since_id');
      sinceIds.push(since);
      const fresh = posts.filter((p) => since === null || BigInt(p.id) > BigInt(since));
      return json(fresh.length > 0 ? { data: fresh, meta: { result_count: fresh.length } } : { meta: { result_count: 0 } });
    };
    const config = testConfig({ sources: [{ id: 'x', type: 'x', label: 'X', userId: '2244994945' }] });
    const run = (now: number) =>
      runRadar(state, { config, secrets: SECRETS, fetch, now: () => now, log: () => {}, redact: (t) => t, sleep: async () => {} });
    const state = emptyState();

    await run(NOW - 3 * HOUR);
    posts.unshift({ id: '1900000000000000002', text: 'Новый пост', created_at: new Date(NOW - 20 * MINUTE).toISOString() });
    await run(NOW);

    assert.deepEqual(sinceIds, [null, '1900000000000000001']);
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? '', /x\.com\/i\/web\/status\/1900000000000000002">Новый пост</);
  });

  it('ошибки: 401 — auth, 402 — billing, 429 — rate_limit, ненайденный аккаунт с HTTP 200 — config', async () => {
    const cases: [unknown, number, string][] = [
      [{ title: 'Unauthorized', status: 401 }, 401, 'auth'],
      [{ title: 'Payment Required', status: 402 }, 402, 'billing'],
      [{ title: 'Client Forbidden', type: 'https://api.twitter.com/2/problems/client-forbidden', reason: 'client-not-enrolled' }, 403, 'billing'],
      [{ title: 'Too Many Requests', status: 429 }, 429, 'rate_limit'],
      [{ errors: [{ title: 'Not Found Error', detail: 'Could not find user with id: [1].' }] }, 200, 'config'],
      [{ errors: [{ title: 'Authorization Error', detail: 'Sorry, you are not authorized.' }] }, 200, 'permission'],
      [{ something: 'else' }, 200, 'bad_response'],
    ];
    for (const [body, status, kind] of cases) {
      const { fetch } = fakeFetch(() => json(body, status));
      await assert.rejects(fetchXPosts(X, ctx(fetch)), (e) => e instanceof SourceError && e.kind === kind, kind);
    }
  });
});

// ---------- Реестр, конфиг и проводка ----------

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('реестр сетей', () => {
  it('у каждой сети есть страница настройки, а её секреты известны', () => {
    for (const adapter of allAdapters()) {
      assert.ok(existsSync(new URL(`../${adapter.docs}`, import.meta.url)), `${adapter.type}: нет ${adapter.docs}`);
      for (const secret of adapter.secrets) assert.ok((SOURCE_SECRETS as readonly string[]).includes(secret));
    }
    assert.deepEqual([...SOURCE_TYPES].sort(), ['bluesky', 'facebook', 'feed', 'instagram', 'vk', 'x', 'youtube']);
  });

  it('каждый секрет передан шагу радара и шагу пробы, и ни одного лишнего', () => {
    for (const workflow of ['.github/workflows/radar.yml', '.github/workflows/probe.yml']) {
      const passed = [...read(workflow).matchAll(/^\s+([A-Z_]+): \$\{\{ secrets\.([A-Z_]+) \}\}$/gm)];
      for (const [, env, secret] of passed) assert.equal(env, secret, `${workflow}: ${env} берёт чужой секрет`);
      assert.deepEqual(passed.map((m) => m[1]).sort(), [...ALL_SECRETS].sort(), workflow);
    }
  });

  it('тип сети ищется только среди своих: имена прототипа не адаптер', () => {
    assert.equal(findAdapter('constructor'), undefined);
    assert.equal(findAdapter('__proto__'), undefined);
    assert.equal(findAdapter(7), undefined);
    assert.equal(findAdapter('bluesky')?.network, 'Bluesky');
  });

  it('примеры источников в документации проходят проверку конфига', () => {
    const dir = new URL('../docs/sources/', import.meta.url);
    let checked = 0;
    for (const file of readdirSync(dir)) {
      const md = readFileSync(new URL(file, dir), 'utf8');
      for (const [, block] of md.matchAll(/```json\n([\s\S]*?)```/g)) {
        const parsed: unknown = JSON.parse(block ?? '');
        const sources = Array.isArray(parsed) ? parsed : [parsed];
        assert.doesNotThrow(() => parseConfig({ messageTitle: 't', groupWindowMinutes: 10, maxPostAgeHours: 48, fetchLimit: 10, sources }), file);
        checked += sources.length;
      }
    }
    assert.ok(checked >= 7, `проверено примеров: ${checked}`);
  });

  it('версии API можно не указывать; неверный формат и чужие поля сетей называются', () => {
    const base = { messageTitle: 't', groupWindowMinutes: 10, maxPostAgeHours: 48, fetchLimit: 10 };
    const config = parseConfig({ ...base, sources: [{ id: 'b', type: 'bluesky', label: 'B', handle: 'discours.bsky.social' }] });
    assert.equal(config.graphApiVersion, 'v25.0');
    assert.throws(
      () =>
        parseConfig({
          ...base,
          graphApiVersion: '25',
          sources: [
            { id: 'b', type: 'bluesky', label: 'B', handle: 'not a handle' },
            { id: 'y', type: 'youtube', label: 'Y', channelId: 'discoursio' },
            { id: 'x', type: 'x', label: 'X', userId: '@discours_io' },
            { id: 'f', type: 'feed', label: 'F', url: 'http://example.com/rss' },
            { id: 't', type: 'tiktok', label: 'T' },
          ],
        }),
      (err: Error) =>
        ['graphApiVersion', 'sources[0].handle', 'sources[1].channelId', 'sources[2].userId', 'sources[3].url', 'sources[4].type: одна из сетей'].every(
          (part) => err.message.includes(part),
        ),
    );
  });
});

// ---------- Тексты алертов ----------

describe('алерты для людей', () => {
  const BLUESKY_SOURCE = { id: 'bluesky', type: 'bluesky' as const, label: 'Bluesky', handle: 'discours.bsky.social' };
  const VK_SOURCE = { id: 'vk', type: 'vk' as const, label: 'VK', ownerId: -1 };

  it('подсказка сети без ключа не просит обновить секрет; оплата — своя подсказка', () => {
    assert.ok(!failureHint('auth', BLUESKY_SOURCE).includes('секрет'));
    assert.ok(failureHint('auth', VK_SOURCE).includes('секрет VK_TOKEN'));
    assert.ok(failureHint('billing', { id: 'x', type: 'x', label: 'X', userId: '1' }).includes('кабинете разработчика X'));
  });

  it('алерт: сеть и давность первыми, затем действие, судьба постов и код', () => {
    const state = newSourceState(NOW - HOUR);
    const err = new SourceError('auth', 'VK API 5: User authorization failed', '5');
    recordFailure(state, err, NOW - 20 * MINUTE);
    recordFailure(state, err, NOW - 10 * MINUTE);
    const lines = formatFailureAlert(VK_SOURCE, state, err, { now: NOW, maxPostAgeHours: 48, runUrl: 'https://github.com/o/r/actions/runs/1' }).html.split('\n');
    assert.equal(lines[0], '<b>VK</b>: посты не читаются, уже 20 мин.');
    assert.match(lines[1] ?? '', /^Что сделать: выпустите новый токен/);
    assert.equal(lines[2], 'Посты, вышедшие за это время, придут после починки, если им будет меньше 48 ч.');
    assert.equal(lines[3], 'Причина: <code>auth</code> — VK API 5: User authorization failed');
    assert.equal(lines[4], '<a href="https://github.com/o/r/actions/runs/1">Лог запуска</a>');
    recordSuccess(state);
    assert.equal(state.failingSince, undefined, 'успех закрывает серию');
  });

  it('начало серии сбоев в состоянии проверяется при чтении', () => {
    const withSource = (extra: Record<string, unknown>) =>
      JSON.stringify({ version: 1, pending: [], sources: { vk: { bootstrapped: true, seen: [], consecutiveFailures: 2, ...extra } } });
    assert.doesNotThrow(() => parseState(withSource({ failingSince: NOW })));
    assert.throws(() => parseState(withSource({ failingSince: 'вчера' })), /источник vk/);
  });

  it('давность сбоя по-русски', () => {
    assert.deepEqual(
      [20 * MINUTE, 3 * HOUR, 47 * HOUR, 49 * HOUR, 5 * 24 * HOUR, 21 * 24 * HOUR, 11 * 24 * HOUR].map(formatDuration),
      ['20 мин', '3 ч', '47 ч', '2 дня', '5 дней', '21 день', '11 дней'],
    );
  });
});
