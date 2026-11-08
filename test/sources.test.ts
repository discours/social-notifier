import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { ALL_SECRETS, SOURCE_SECRETS } from '../src/env.ts';
import { SourceError } from '../src/errors.ts';
import { failureHint, formatDuration, formatFailureAlert, markAlertSent, recordFailure, recordSuccess } from '../src/health.ts';
import { readText, type FetchLike } from '../src/http.ts';
import { classifyBlueskyError, fetchBlueskyPosts, type BlueskySource } from '../src/sources/bluesky.ts';
import { feedUrl, fetchFeedPosts, parseFeed, type FeedSource } from '../src/sources/feed.ts';
import { allAdapters, findAdapter, probeFetchLimit, probeSourcePosts, SOURCE_TYPES, type SourceContext } from '../src/sources/index.ts';
import { fetchXPosts, newestId, type XSource } from '../src/sources/x.ts';
import { MAX_STORED_TEXT } from '../src/sources/parse.ts';
import { decodeEntities, htmlToText } from '../src/sources/xml.ts';
import { fetchYoutubePosts, type YoutubeSource } from '../src/sources/youtube.ts';
import { runRadar } from '../src/radar.ts';
import { emptyState, newSourceState, parseState } from '../src/state.ts';
import { httpUrl, MAX_URL_LENGTH } from '../src/util.ts';
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

  it('импортированный архив: старая createdAt при свежем indexedAt — пост старый, а не новый', async () => {
    const item = bskyItem('3mzimport22a', '2019-05-01T00:00:00.000Z');
    item.post.indexedAt = '2026-11-08T11:00:00.000Z';
    const { fetch } = fakeFetch(() => json({ feed: [item] }));
    const { posts } = await fetchBlueskyPosts(BSKY, ctx(fetch));
    assert.equal(posts[0]?.publishedAt, Date.parse('2019-05-01T00:00:00.000Z'));
  });

  it('неподтверждённый хэндл (handle.invalid) — ссылка по DID', async () => {
    const item = bskyItem('3mzinvalid2a', '2026-11-08T10:00:00.000Z');
    item.post.author.handle = 'handle.invalid';
    const { fetch } = fakeFetch(() => json({ feed: [item] }));
    const { posts } = await fetchBlueskyPosts(BSKY, ctx(fetch));
    assert.equal(posts[0]?.url, `https://bsky.app/profile/${DID}/post/3mzinvalid2a`);
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
    assert.equal(decodeEntities('&toString; &valueOf;'), '&toString; &valueOf;', 'имена прототипа — не сущности');
  });

  it('враждебная лента разбирается за линейное время: незакрытые теги и «<» без «>» не вешают радар', () => {
    const item = (body: string) => `<rss><channel><item><guid>a</guid><link>https://e.com/a</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate>${body}</item></channel></rss>`;
    // Размеры подобраны так, чтобы квадратичный разбор краснел за секунды, а не висел минутами.
    const hostile = [
      `<rss><channel>${'<item>'.repeat(60_000)}</channel></rss>`,
      item(`${'<title>'.repeat(50_000)}`),
      item(`<description>${'&lt;'.repeat(80_000)}</description>`),
      `<feed><entry><id>a</id><link ${'h'.repeat(100_000)}/><updated>2026-10-19T09:58:39Z</updated></entry></feed>`,
      `<rss><channel>${'<item><guid>'.repeat(30_000)}</channel></rss>`,
      `${'<!a>'.repeat(400_000)}<rss><channel></channel></rss>`,
      `<rss><channel>${'<![CDATA[a]]>'.repeat(100_000)}<!-- x --></channel></rss>`,
      `<feed><entry><id>a</id>${'<source>'.repeat(100_000)}</entry></feed>`,
      `<rss><channel>${'<!--x-->'.repeat(100_000)}<![CDATA[</channel></rss>`,
    ];
    const started = performance.now();
    // Повторный поиск «>» после каждого «<» тоже квадратичен, просто быстр: ловится только объёмом.
    assert.equal(htmlToText('<'.repeat(1_500_000)).length, 1_500_000);
    assert.equal(htmlToText(`a${'<!--<b>'.repeat(60_000)}`), 'a');
    for (const xml of hostile) {
      try {
        parseFeed(FEED, xml, 10);
      } catch (err) {
        assert.ok(err instanceof SourceError, String(err));
      }
    }
    // Прежний разбор регулярками тратил на такие входы минуты, линейный — миллисекунды.
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3000, `разбор занял ${Math.round(elapsed)} мс`);
  });

  it('тип ленты — по корневому элементу: запись Atom может цитировать разметку RSS', () => {
    const atom = `<?xml version="1.0"?><!-- комментарий --><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>a</id><link href="https://e.com/a"/><updated>2026-10-19T09:58:39Z</updated>
      <content type="html"><![CDATA[Как начать: <rss version="2.0"> и <channel>]]></content></entry></feed>`;
    assert.deepEqual(parseFeed(FEED, atom, 10).posts.map((p) => p.url), ['https://e.com/a']);
    const rss = `<rss><channel><item><guid>b</guid><link>https://e.com/b</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate>
      <description>&lt;feed&gt; и &lt;entry&gt; — это Atom</description></item></channel></rss>`;
    assert.deepEqual(parseFeed(FEED, rss, 10).posts.map((p) => p.url), ['https://e.com/b']);
    const rdf = `<?xml version="1.0"?><rdf:RDF><channel><title>t</title></channel><item><link>https://e.com/c</link><dc:date>2026-10-19T09:58:39Z</dc:date><title>RSS 1.0</title></item></rdf:RDF>`;
    assert.deepEqual(parseFeed(FEED, rdf, 10).posts.map((p) => p.text), ['RSS 1.0']);
  });

  it('заголовок — простой текст, сущности раскрываются один раз; HTML чистится только там, где он HTML', () => {
    const rss = `<rss><channel><item><guid>a</guid><link>https://e.com/a</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate>
      <title>a &lt; b и c &gt; d, &amp;amp;</title></item></channel></rss>`;
    assert.equal(parseFeed(FEED, rss, 10).posts[0]?.text, 'a < b и c > d, &amp;');
    const entry = (title: string) =>
      `<feed><entry><id>a</id><link href="https://e.com/a"/><updated>2026-10-19T09:58:39Z</updated>${title}</entry></feed>`;
    assert.equal(parseFeed(FEED, entry('<title>x &lt;y&gt; z</title>'), 10).posts[0]?.text, 'x <y> z');
    assert.equal(parseFeed(FEED, entry('<title type="html">x &lt;b&gt;жирный&lt;/b&gt; &amp;amp; z</title>'), 10).posts[0]?.text, 'x жирный & z');
    assert.equal(parseFeed(FEED, entry('<title type="xhtml"><div>x <b>y</b> &amp; z</div></title>'), 10).posts[0]?.text, 'x y & z');
  });

  it('имя тега — целиком: <title> не путается с <titleHint> и <media:title>, <link> — с <links>', () => {
    const rss = `<rss><channel><item><guid>a</guid><links>https://e.com/wrong</links><link>https://e.com/a</link>
      <pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate><titleHint>нет</titleHint><media:title>нет</media:title><title>да</title></item></channel></rss>`;
    assert.deepEqual(parseFeed(FEED, rss, 10).posts.map((p) => [p.url, p.text]), [['https://e.com/a', 'да']]);
  });

  it('старая неразобранная запись за пределами свежих не даёт вечного сбоя; свежая — считается', () => {
    const good = (i: number) =>
      `<item><guid>g${i}</guid><link>https://e.com/${i}</link><pubDate>${new Date(NOW - i * HOUR).toUTCString()}</pubDate></item>`;
    const noLink = (hoursAgo: number) => `<item><guid>broken</guid><pubDate>${new Date(NOW - hoursAgo * HOUR).toUTCString()}</pubDate></item>`;
    const feed = (extra: string) => `<rss><channel>${good(1)}${good(2)}${good(3)}${extra}</channel></rss>`;
    assert.deepEqual(parseFeed(FEED, feed(noLink(100)), 2), { posts: parseFeed(FEED, feed(''), 2).posts, skipped: 0 });
    assert.equal(parseFeed(FEED, feed(noLink(0)), 2).skipped, 1, 'новее оставленных — могла бы прийти');
    assert.equal(parseFeed(FEED, feed(noLink(100)), 10).skipped, 1, 'все записи в выдаче, порога нет — считается любая');
    assert.equal(parseFeed(FEED, feed(noLink(100)), 10, NOW - 48 * HOUR).skipped, 0, 'старше maxPostAgeHours — ничего не теряет');
    assert.equal(parseFeed(FEED, feed(noLink(5)), 10, NOW - 48 * HOUR).skipped, 1, 'свежая битая запись — сбой');
    const undated = '<item><guid>x</guid><link>https://e.com/x</link></item>';
    assert.equal(parseFeed(FEED, `<rss><channel>${undated}${good(1)}${good(2)}${good(3)}</channel></rss>`, 2).skipped, 1, 'без даты в голове ленты — могла быть новой');
    assert.equal(parseFeed(FEED, feed(undated), 2).skipped, 0, 'без даты в хвосте ленты — старая');
  });

  it('радар передаёт ленте порог свежести: старая битая запись не даёт алерта', async () => {
    const good = (i: number) =>
      `<item><guid>g${i}</guid><link>https://e.com/${i}</link><pubDate>${new Date(NOW - i * HOUR).toUTCString()}</pubDate><title>Пост ${i}</title></item>`;
    const rss = `<rss><channel>${good(1)}${good(2)}<item><guid>old</guid><pubDate>${new Date(NOW - 900 * HOUR).toUTCString()}</pubDate></item></channel></rss>`;
    const alerts: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      if (new URL(input).hostname === 'api.telegram.org') {
        alerts.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return json({ ok: true, result: {} });
      }
      return text(rss);
    };
    const config = testConfig({ fetchLimit: 20, sources: [{ id: 'blog', type: 'feed', label: 'Блог', url: 'https://e.com/feed' }] });
    const state = emptyState();
    for (const at of [NOW, NOW + 10 * MINUTE, NOW + 20 * MINUTE]) {
      await runRadar(state, { config, secrets: SECRETS, fetch, now: () => at, log: () => {}, redact: (t) => t, sleep: async () => {} });
    }
    assert.equal(state.sources.blog?.consecutiveFailures, 0);
    assert.deepEqual(alerts.filter((m) => m.includes('не читается') || m.includes('не читаются')), []);
  });

  it('закомментированная запись не приходит; «<!--» внутри CDATA — просто текст', () => {
    const rss = `<rss><channel><!-- <item><guid>draft</guid><link>https://e.com/draft</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate><title>Черновик</title></item> -->
      <item><guid>a</guid><link>https://e.com/a</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate><title><![CDATA[Про <!-- комментарии -->]]></title></item></channel></rss>`;
    assert.deepEqual(parseFeed(FEED, rss, 10), {
      posts: [{ sourceId: 'mastodon', id: 'a', url: 'https://e.com/a', publishedAt: Date.parse('2026-10-19T09:58:39Z'), text: 'Про <!-- комментарии -->' }],
      skipped: 0,
    });
  });

  it('вложенный <source> записи Atom не подменяет её id, ссылку и заголовок', () => {
    const entry = (n: number) => `<entry><source><id>urn:planet:orig</id><link href="https://planet.example/"/><title>Планета</title></source>
      <id>urn:post:${n}</id><link href="https://e.com/${n}"/><title>Пост ${n}</title><updated>2026-10-19T0${n}:00:00Z</updated></entry>`;
    const { posts } = parseFeed(FEED, `<feed>${entry(1)}${entry(2)}</feed>`, 10);
    assert.deepEqual(posts.map((p) => [p.id, p.url, p.text]), [
      ['urn:post:2', 'https://e.com/2', 'Пост 2'],
      ['urn:post:1', 'https://e.com/1', 'Пост 1'],
    ]);
  });

  it('записи с префиксом пространства имён — ошибка формата, а не вечное «новых нет»', () => {
    const rdf = `<rdf:RDF><rss:channel><rss:title>t</rss:title></rss:channel><rss:item><rss:link>https://e.com/a</rss:link></rss:item></rdf:RDF>`;
    assert.throws(() => parseFeed(FEED, rdf, 10), (e) => e instanceof SourceError && e.kind === 'bad_response' && /rss:item/.test(e.message));
  });

  it('у content Atom с MIME-типом text/html теги снимаются', () => {
    const atom = `<feed><entry><id>a</id><link href="https://e.com/a"/><updated>2026-10-19T09:58:39Z</updated>
      <content type="text/html">&lt;p&gt;Абзац&lt;/p&gt;</content></entry></feed>`;
    assert.equal(parseFeed(FEED, atom, 10).posts[0]?.text, 'Абзац');
  });

  it('у выпуска подкаста без <link> ссылка — файл из <enclosure>', () => {
    const rss = `<rss><channel><item><guid isPermaLink="false">ep-12</guid><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate>
      <title>Выпуск 12</title><enclosure url="https://cdn.e.com/ep12.mp3" length="1" type="audio/mpeg"/></item></channel></rss>`;
    assert.deepEqual(parseFeed(FEED, rss, 10).posts.map((p) => [p.id, p.url]), [['ep-12', 'https://cdn.e.com/ep12.mp3']]);
  });

  it('ответ больше 32 МБ не дочитывается: тело читается потоком, и чтение отменяется', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 80) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const huge = fakeFetch(() => new Response(endless, { status: 200 }));
    await assert.rejects(fetchFeedPosts(FEED, ctx(huge.fetch)), (e) => e instanceof SourceError && e.kind === 'bad_response' && /32 МБ/.test(e.message));
    assert.ok(pulled <= 34, `прочитано кусков по 1 МБ: ${pulled}`);
    assert.ok(cancelled, 'чтение тела отменено');
  });

  it('UTF-8, разрезанный между кусками ответа, собирается без потерь', async () => {
    const bytes = new TextEncoder().encode('Привет, мир 👋 — «ёж»');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const { text: body } = await readText(async () => new Response(stream), 'https://e.com/');
    assert.equal(body, 'Привет, мир 👋 — «ёж»');
  });

  it('перенаправление на http — отказ, на https — как обычно', async () => {
    const downgraded = fakeFetch(() => {
      const res = text(MASTODON_RSS);
      Object.defineProperty(res, 'url', { value: 'http://mastodon.social/@Mastodon.rss' });
      return res;
    });
    await assert.rejects(fetchFeedPosts(FEED, ctx(downgraded.fetch)), (e) => e instanceof SourceError && e.kind === 'config' && /без https/.test(e.message));
    const kept = fakeFetch(() => {
      const res = text(MASTODON_RSS);
      Object.defineProperty(res, 'url', { value: 'https://mastodon.social/@Mastodon.rss' });
      return res;
    });
    assert.equal((await fetchFeedPosts(FEED, ctx(kept.fetch))).posts.length, 2);
  });

  it('текст поста хранится обрезанным: длинная запись не раздувает состояние', () => {
    const rss = `<rss><channel><item><guid>a</guid><link>https://e.com/a</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate>
      <title>${'слово '.repeat(2000)}</title></item></channel></rss>`;
    const post = parseFeed(FEED, rss, 10).posts[0];
    assert.equal(post?.text.length, MAX_STORED_TEXT);
    assert.ok(post?.text.startsWith('слово слово'));
  });

  it('незакрытый «<!--» не уносит записи после себя: остаток ленты разбирается как есть', () => {
    const good = (i: number) =>
      `<item><guid>g${i}</guid><link>https://e.com/${i}</link><pubDate>Mon, 19 Oct 2026 0${i}:00:00 +0000</pubDate><title>Пост ${i}</title></item>`;
    const inTitle = `<rss><channel><title>Блог <!-- черновик</title>${good(1)}${good(2)}</channel></rss>`;
    assert.deepEqual(parseFeed(FEED, inTitle, 10), { posts: parseFeed(FEED, `<rss><channel>${good(1)}${good(2)}</channel></rss>`, 10).posts, skipped: 0 });
    const inItem = `<rss><channel>${good(1)}<item><guid>g2</guid><link>https://e.com/2</link><pubDate>Mon, 19 Oct 2026 02:00:00 +0000</pubDate><title>Про <!-- </title></item>${good(3)}</channel></rss>`;
    const { posts, skipped } = parseFeed(FEED, inItem, 10);
    assert.deepEqual([posts.map((p) => p.id), skipped], [['g3', 'g2', 'g1'], 0]);
  });

  it('«</item>» в тексте CDATA не закрывает запись: ссылка и дата после описания на месте', () => {
    const rss = `<rss><channel><item><guid>a</guid><title><![CDATA[Как закрыть </item> в RSS &amp; не сломать]]></title>
      <link>https://e.com/a</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate></item></channel></rss>`;
    assert.deepEqual(parseFeed(FEED, rss, 10), {
      posts: [{ sourceId: 'mastodon', id: 'a', url: 'https://e.com/a', publishedAt: Date.parse('2026-10-19T09:58:39Z'), text: 'Как закрыть </item> в RSS &amp; не сломать' }],
      skipped: 0,
    }, 'текст CDATA — как есть, «&amp;» в нём не сущность');
    const spoof = `<rss><channel><item><guid>b</guid><description><![CDATA[<title >Подмена</title >]]></description><title>Настоящий</title>
      <link>https://e.com/b</link><pubDate>Mon, 19 Oct 2026 09:58:39 +0000</pubDate></item></channel></rss>`;
    assert.equal(parseFeed(FEED, spoof, 10).posts[0]?.text, 'Настоящий', 'тег внутри CDATA — текст, а не элемент');
  });

  it('комментарий HTML в описании вырезается целиком, даже если в нём есть «>»', () => {
    assert.equal(htmlToText('<!-- a > b --><p>Текст</p>'), 'Текст');
    assert.equal(htmlToText('до <!-- без конца <b>и</b> после'), 'до и после', 'без «-->» — обычный тег до «>»');
  });

  it('запись без даты в ленте от старых к новым считается по концу ленты', () => {
    const good = (i: number) =>
      `<item><guid>g${i}</guid><link>https://e.com/${i}</link><pubDate>${new Date(NOW - i * HOUR).toUTCString()}</pubDate></item>`;
    const undated = '<item><guid>x</guid><link>https://e.com/x</link></item>';
    const oldestFirst = (head: string, tail: string) => `<rss><channel>${head}${good(3)}${good(2)}${good(1)}${tail}</channel></rss>`;
    assert.equal(parseFeed(FEED, oldestFirst('', undated), 2).skipped, 1, 'в конце — среди новых, могла быть новой');
    assert.equal(parseFeed(FEED, oldestFirst(undated, ''), 2).skipped, 0, 'в начале — среди старых');
  });

  it('ссылка длиннее 2048 символов — не ссылка: такое сообщение Telegram мог бы не принять', () => {
    const base = 'https://e.com/';
    const longest = base + 'a'.repeat(MAX_URL_LENGTH - base.length);
    assert.equal(httpUrl(longest), longest);
    assert.equal(httpUrl(`${longest}a`), undefined);
    assert.equal(httpUrl(base + 'я'.repeat(400)), undefined, 'кириллица при кодировании растёт вшестеро');
    const item = (guid: string) =>
      `<rss><channel><item><guid>${guid}</guid><link>${base}${'a'.repeat(50_000)}</link><pubDate>${new Date(NOW - HOUR).toUTCString()}</pubDate></item></channel></rss>`;
    assert.deepEqual(parseFeed(FEED, item('https://e.com/short'), 10).posts.map((p) => p.url), ['https://e.com/short'], 'запасная ссылка — guid');
    assert.throws(() => parseFeed(FEED, item('not-a-url'), 10), (e) => e instanceof SourceError && e.kind === 'bad_response');
  });

  it('кодировка ответа: метка BOM, объявление <?xml encoding>, затем charset заголовка, иначе UTF-8', async () => {
    const ascii = (str: string) => Uint8Array.from(str, (c) => c.charCodeAt(0));
    const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));
    const cp1251 = Uint8Array.of(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2); // «Привет»
    const utf8 = new TextEncoder().encode('Привет');
    const read = async (bytes: Uint8Array<ArrayBuffer>, contentType?: string) =>
      (await readText(async () => new Response(bytes, contentType ? { headers: { 'content-type': contentType } } : {}), 'https://e.com/')).text;
    const decl = (enc: string) => `<?xml version="1.0" encoding="${enc}"?>`;
    assert.equal(await read(join(ascii(decl('windows-1251')), cp1251)), `${decl('windows-1251')}Привет`);
    assert.equal(await read(cp1251, 'text/xml; charset=windows-1251'), 'Привет');
    assert.equal(await read(join(ascii(decl('UTF-8')), utf8), 'text/xml; charset=windows-1251'), `${decl('UTF-8')}Привет`, 'объявление важнее заголовка');
    assert.equal(await read(join(Uint8Array.of(0xef, 0xbb, 0xbf), utf8), 'text/xml; charset=windows-1251'), 'Привет', 'BOM важнее всего');
    assert.equal(await read(utf8, 'text/xml; charset=x-unknown'), 'Привет', 'неизвестная метка — UTF-8');
    assert.equal(await read(utf8), 'Привет');
  });

  it('битая запись до начала наблюдения — архив; вышедшая после — сбой', async () => {
    const good = (i: number) =>
      `<item><guid>g${i}</guid><link>https://e.com/${i}</link><pubDate>${new Date(NOW - i * HOUR).toUTCString()}</pubDate><title>Пост ${i}</title></item>`;
    const broken = (at: number) => `<item><guid>b${at}</guid><pubDate>${new Date(at).toUTCString()}</pubDate></item>`;
    let rss = `<rss><channel>${good(1)}${good(2)}${broken(NOW - 5 * HOUR)}</channel></rss>`;
    const fetch: FetchLike = async (input) => (new URL(input).hostname === 'api.telegram.org' ? json({ ok: true, result: {} }) : text(rss));
    const config = testConfig({ fetchLimit: 20, sources: [{ id: 'blog', type: 'feed', label: 'Блог', url: 'https://e.com/feed' }] });
    const state = emptyState();
    const run = (at: number) => runRadar(state, { config, secrets: SECRETS, fetch, now: () => at, log: () => {}, redact: (t) => t, sleep: async () => {} });
    await run(NOW);
    assert.equal(state.sources.blog?.consecutiveFailures, 0, 'источник только добавлен: битая запись из архива');
    rss = `<rss><channel>${broken(NOW + 5 * MINUTE)}${good(1)}${good(2)}</channel></rss>`;
    await run(NOW + 10 * MINUTE);
    assert.equal(state.sources.blog?.consecutiveFailures, 1, 'свежая битая запись — сбой');
    assert.equal(state.sources.blog?.lastError?.kind, 'bad_response');
  });

  it('после алерта о частичном сбое полный сбой даёт новый алерт сразу', async () => {
    const good = (i: number) =>
      `<item><guid>g${i}</guid><link>https://e.com/${i}</link><pubDate>${new Date(NOW - i * HOUR).toUTCString()}</pubDate><title>Пост ${i}</title></item>`;
    const partly = `<rss><channel>${good(1)}<item><guid>b</guid><pubDate>${new Date(NOW + MINUTE).toUTCString()}</pubDate></item></channel></rss>`;
    let reply = (): Response => text(partly);
    const alerts: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      if (new URL(input).hostname !== 'api.telegram.org') return reply();
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      if (body.chat_id === SECRETS.TELEGRAM_ALERT_CHAT_ID) alerts.push(body.text.split('\n')[0] ?? '');
      return json({ ok: true, result: {} });
    };
    const config = testConfig({ fetchLimit: 20, sources: [{ id: 'blog', type: 'feed', label: 'Блог', url: 'https://e.com/feed' }] });
    const state = emptyState();
    state.sources.blog = { ...newSourceState(NOW - 10 * HOUR), bootstrapped: true };
    const run = (at: number) => runRadar(state, { config, secrets: SECRETS, fetch, now: () => at, log: () => {}, redact: (t) => t, sleep: async () => {} });
    await run(NOW + 10 * MINUTE);
    await run(NOW + 20 * MINUTE);
    await run(NOW + 30 * MINUTE);
    reply = () => text('Internal Server Error', 500);
    await run(NOW + 40 * MINUTE);
    await run(NOW + 50 * MINUTE);
    assert.deepEqual(alerts, ['<b>Блог</b>: часть постов не читается, уже 10 мин.', '<b>Блог</b>: посты не читаются, уже 30 мин.']);
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

  it('время видео — публикация, а не попадание в плейлист: старое видео, добавленное сегодня, — старое', async () => {
    const video = ytVideo('dQw4w9WgXcQ', '2026-11-08T11:00:00Z');
    video.contentDetails.videoPublishedAt = '2021-03-01T10:00:00Z';
    const { fetch } = fakeFetch(youtubeApi([video]));
    const { posts } = await fetchYoutubePosts(YT, ctx(fetch));
    assert.equal(posts[0]?.publishedAt, Date.parse('2021-03-01T10:00:00Z'));
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
  it('проба читает у X не больше 5 постов: каждый стоит денег; у остальных сетей — fetchLimit', () => {
    assert.equal(probeFetchLimit(X, testConfig({ fetchLimit: 25 })), 5);
    assert.equal(probeFetchLimit(X, testConfig({ fetchLimit: 3 })), 3);
    assert.equal(probeFetchLimit(FEED, testConfig({ fetchLimit: 25 })), 25);
  });

  it('проба просит у X 5 постов, а не fetchLimit радара', async () => {
    const { fetch, calls } = fakeFetch(() => json({ meta: { result_count: 0 } }));
    await probeSourcePosts(X, ctx(fetch, { config: testConfig({ fetchLimit: 25 }) }));
    assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('max_results')), ['5']);
  });

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
      [{ title: 'UsageCapExceeded', type: 'https://api.twitter.com/2/problems/usage-capped', detail: 'Usage cap exceeded: Monthly product cap' }, 429, 'billing'],
      [{ title: 'Forbidden', type: 'about:blank' }, 403, 'permission'],
      [{ title: 'Invalid Request', type: 'https://api.twitter.com/2/problems/invalid-request' }, 400, 'config'],
      [{ title: 'Not Found Error', type: 'https://api.twitter.com/2/problems/resource-not-found' }, 404, 'config'],
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
    const used = new Set<string>(allAdapters().flatMap((adapter) => adapter.secrets));
    assert.deepEqual(SOURCE_SECRETS.filter((secret) => !used.has(secret)), [], 'секрет, которого не просит ни одна сеть');
    assert.deepEqual([...SOURCE_TYPES].sort(), ['bluesky', 'facebook', 'feed', 'instagram', 'vk', 'x', 'youtube']);
  });

  it('каждый секрет передан именно шагу радара и шагу пробы, и ни одного лишнего', () => {
    for (const [workflow, step] of [
      ['.github/workflows/radar.yml', 'Радар'],
      ['.github/workflows/probe.yml', 'Проба'],
    ] as const) {
      const steps = read(workflow).split(/^(?=\s+- name: )/m);
      const stepText = steps.find((s) => s.trimStart().startsWith(`- name: ${step}\n`)) ?? '';
      const passed = [...stepText.matchAll(/^\s+([A-Z_]+): \$\{\{ secrets\.([A-Z_]+) \}\}$/gm)];
      for (const [, env, secret] of passed) assert.equal(env, secret, `${workflow}: ${env} берёт чужой секрет`);
      assert.deepEqual(passed.map((m) => m[1]).sort(), [...ALL_SECRETS].sort(), `${workflow}, шаг «${step}»`);
      const elsewhere = steps.filter((s) => s !== stepText).join('').match(/secrets\.[A-Z_]+/g) ?? [];
      assert.deepEqual(elsewhere, [], `${workflow}: секреты сетей уходят в другие шаги`);
    }
  });

  it('тип сети ищется только среди своих: имена прототипа не адаптер', () => {
    assert.equal(findAdapter('constructor'), undefined);
    assert.equal(findAdapter('__proto__'), undefined);
    assert.equal(findAdapter(7), undefined);
    assert.equal(findAdapter('bluesky')?.network, 'Bluesky');
  });

  it('у каждой сети на её странице есть пример источника, и он проходит проверку конфига', () => {
    const dir = new URL('../docs/sources/', import.meta.url);
    const examples = new Map<string, Set<unknown>>();
    for (const file of readdirSync(dir)) {
      const md = readFileSync(new URL(file, dir), 'utf8');
      for (const [, block] of md.matchAll(/```json\n([\s\S]*?)```/g)) {
        const parsed: unknown = JSON.parse(block ?? '');
        const sources: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        assert.doesNotThrow(() => parseConfig({ messageTitle: 't', groupWindowMinutes: 10, maxPostAgeHours: 48, fetchLimit: 10, sources }), file);
        const types = examples.get(`docs/sources/${file}`) ?? new Set<unknown>();
        for (const source of sources) types.add((source as { type?: unknown }).type);
        examples.set(`docs/sources/${file}`, types);
      }
    }
    for (const adapter of allAdapters()) {
      assert.ok(examples.get(adapter.docs)?.has(adapter.type), `${adapter.docs}: нет примера источника типа ${adapter.type}`);
    }
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
    const lines = formatFailureAlert(VK_SOURCE, state, err, { now: NOW, maxPostAgeHours: 48, fetchLimit: 25, runUrl: 'https://github.com/o/r/actions/runs/1' }).html.split('\n');
    assert.equal(lines[0], '<b>VK</b>: посты не читаются, уже 20 мин.');
    assert.match(lines[1] ?? '', /^Что сделать: выпустите новый токен/);
    assert.equal(lines[2], 'Посты, вышедшие за это время, придут после починки — из последних 25 и не старше 48 ч.');
    assert.equal(lines[3], 'Причина: <code>auth</code> — VK API 5: User authorization failed');
    assert.equal(lines[4], '<a href="https://github.com/o/r/actions/runs/1">Лог запуска</a>');
    recordSuccess(state);
    assert.equal(state.failingSince, undefined, 'успех закрывает серию');
  });

  it('сбой, начавшийся до появления failingSince, считается запусками, а не «уже 1 мин»', () => {
    const state = { ...newSourceState(NOW - 5 * HOUR), consecutiveFailures: 3 };
    const err = new SourceError('network', 'запрос не прошёл: таймаут');
    recordFailure(state, err, NOW);
    assert.equal(state.failingSince, undefined);
    const first = formatFailureAlert(VK_SOURCE, state, err, { now: NOW, maxPostAgeHours: 48, fetchLimit: 25 }).html.split('\n')[0];
    assert.equal(first, '<b>VK</b>: посты не читаются, сбоев подряд: 4.');
    recordSuccess(state);
    recordFailure(state, err, NOW + HOUR);
    assert.equal(state.failingSince, NOW + HOUR, 'новая серия — с отметкой начала');
  });

  it('подсказка про конфиг называет и переменную RADAR_CONFIG', () => {
    assert.match(failureHint('config', BLUESKY_SOURCE), /«bluesky» в конфиге \(radar\.config\.json или файл из переменной RADAR_CONFIG\)/);
  });

  it('начало серии сбоев в состоянии проверяется при чтении', () => {
    const withSource = (extra: Record<string, unknown>) =>
      JSON.stringify({ version: 1, pending: [], sources: { vk: { bootstrapped: true, seen: [], consecutiveFailures: 2, ...extra } } });
    assert.doesNotThrow(() => parseState(withSource({ failingSince: NOW })));
    assert.throws(() => parseState(withSource({ failingSince: 'вчера' })), /источник vk/);
    assert.doesNotThrow(() => parseState(withSource({ alertedPartial: true })));
    assert.throws(() => parseState(withSource({ alertedPartial: 'да' })), /источник vk/);
  });

  it('частичный алерт и полный: полный — сразу, дальше снова раз в сутки; успех закрывает обещание', () => {
    const state = newSourceState(NOW - HOUR);
    const partial = new SourceError('bad_response', 'не разобрано элементов ответа: 1 из 3');
    const down = new SourceError('http', 'лента ответила HTTP 500');
    assert.equal(recordFailure(state, partial, NOW, true), false);
    assert.equal(recordFailure(state, partial, NOW + 10 * MINUTE, true), true);
    markAlertSent(state, NOW + 10 * MINUTE, true);
    assert.equal(recordFailure(state, partial, NOW + 20 * MINUTE, true), false, 'тот же частичный сбой — не чаще раза в сутки');
    assert.equal(recordFailure(state, down, NOW + 30 * MINUTE), true, 'лёг целиком — сразу');
    markAlertSent(state, NOW + 30 * MINUTE);
    assert.equal(recordFailure(state, down, NOW + 40 * MINUTE), false, 'дальше — раз в сутки');
    markAlertSent(state, NOW + 50 * MINUTE, true);
    recordSuccess(state);
    recordFailure(state, down, NOW + 60 * MINUTE);
    assert.equal(recordFailure(state, down, NOW + 70 * MINUTE), false, 'после «снова читаются» обещания нет');
  });

  it('давность сбоя по-русски', () => {
    assert.deepEqual(
      [20 * MINUTE, 3 * HOUR, 47 * HOUR, 49 * HOUR, 5 * 24 * HOUR, 21 * 24 * HOUR, 11 * 24 * HOUR].map(formatDuration),
      ['20 мин', '3 ч', '47 ч', '2 дня', '5 дней', '21 день', '11 дней'],
    );
  });
});
