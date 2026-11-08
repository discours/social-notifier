# RSS and Atom

**English** · [Русский](feed.ru.md)

Any RSS 2.0 or Atom 1.0 feed at a public address: Mastodon, Substack, blogs, podcasts, GitHub releases.

**What you need:** the feed URL, `https` only. **Cost:** free.

## Source in the config

```json
[
  { "id": "mastodon", "type": "feed", "label": "Mastodon", "url": "https://mastodon.social/@Mastodon.rss" },
  { "id": "substack", "type": "feed", "label": "Substack", "url": "https://example.substack.com/feed" }
]
```

The URL lives in the public config, so a username and password in it are forbidden. Private feeds are not supported. If a feed redirects to a non-`https` address or is larger than 32 MB, the radar does not read it and sends an alert.

## Where to find the URL

| Platform | Feed URL |
| --- | --- |
| Mastodon | `https://<server>/@<name>.rss` |
| Substack | `https://<name>.substack.com/feed` |
| WordPress | `https://<site>/feed/` |
| YouTube | `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` (unreliable, see [YouTube](youtube.md)) |
| GitHub, releases | `https://github.com/<owner>/<repository>/releases.atom` |

## What arrives

- The message text is the entry title. For feeds without titles (Mastodon), it is the first line of the description without HTML.
- The link is the entry's `<link>`; otherwise a `<guid>` that holds an address; for podcasts with neither, the episode file from `<enclosure>`. The time is `pubDate` in RSS and `published` (otherwise `updated`) in Atom.
- From a long feed, the `fetchLimit` newest entries are taken.
- An entry without a date or without a link cannot be parsed and counts as a feed failure: from the second such run, an alert arrives. An entry whose loss costs nothing does not count as a failure: one published earlier than `maxPostAgeHours` or before the feed was connected, one that would not fall into the `fetchLimit` newest, or, for an entry without a date, one that sits more than `fetchLimit` entries away from the fresh end of the feed. The fresh end is usually the start of the feed; for feeds ordered from old to new, it is the end.
- A link longer than 2048 characters is not accepted: Telegram might reject the message with it, and it would hold up the queue of all networks. In that case a fallback link from `<guid>` or `<enclosure>` is used, and if there is none, the entry counts as unparsed.
- Commented-out entries (`<!-- … -->`) do not arrive. An unclosed `<!--` or `<![CDATA[` is plain text: entries after it are parsed as usual. Text inside `<![CDATA[…]]>` is plain text: a `</item>` in it does not close the entry. In an Atom entry, a nested `<source>` (the description of the original feed) is not confused with the entry itself.
- The encoding is set by the byte order mark (BOM) if there is one; otherwise by the `<?xml … encoding="…"?>` declaration, then the `Content-Type` header, otherwise UTF-8. A UTF-16 declaration without a BOM is ignored: if it could be read byte by byte, the document is not UTF-16. Feeds in windows-1251 and other single-byte encodings are read.
