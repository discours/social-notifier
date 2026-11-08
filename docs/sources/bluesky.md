# Bluesky

**English** · [Русский](bluesky.ru.md)

A public profile is read through the public Bluesky API (`app.bsky.feed.getAuthorFeed` on `public.api.bsky.app`), without signing in and without a key.

**What you need:** only the profile handle. **Cost:** free.

## Source in the config

```json
{ "id": "bluesky", "type": "bluesky", "label": "Bluesky", "handle": "discours.bsky.social" }
```

`handle` is the profile handle without `@`: `name.bsky.social` or your own domain such as `example.com`. Instead of a handle you can use a DID (`did:plc:…`): it does not change even if you change the handle.

## What arrives

- The profile's own posts, including posts with a quote.
- Reposts of other people's posts, replies, and continuations of the profile's own threads do not arrive: a thread is one notification.
- The post time is the earlier of the time set by the app (`createdAt`) and the time the server first saw the post (`indexedAt`). A post dated in the future does not get stuck in the queue, and an imported archive with old dates does not flood the group.
