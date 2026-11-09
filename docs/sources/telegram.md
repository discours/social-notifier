# Telegram channels

**English** · [Русский](telegram.ru.md)

A public channel is read from its web preview `t.me/s/<channel>` — the page Telegram shows in a browser without signing in. No key is needed, and the bot does not have to be added to the channel.

**What you need:** only the public name of the channel. **Cost:** free.

## Source in the config

```json
[
  { "id": "telegram", "type": "telegram", "label": "TG", "channel": "discoursio" },
  { "id": "iskra", "type": "telegram", "label": "Iskra", "channel": "mediaiskra" }
]
```

`channel` is the public name without `@`, as in `t.me/discoursio`: Latin letters, digits and `_`, from 4 to 32 characters. Each channel is a separate source with its own `id` and `label`.

## What arrives

- Posts of the channel, including forwarded ones. An album is one notification.
- Service messages — "channel created", "pinned", a new channel photo — do not arrive.
- The post time is the publication time; an edited post does not arrive again.
- The preview shows about the last 20 messages (an album counts as several). If a channel publishes more between two polls, the older ones are missed.

## Limits and risks

- **The preview is website markup, not an API.** Telegram can change it without warning. Then the posts stop being recognized, and from the second run an alert with the `bad_response` kind arrives — the radar never silently decides that there are no new posts. The fix is in [`src/sources/telegram.ts`](../../src/sources/telegram.ts).
- **Telegram's rules do not describe automated reading of the preview.** The radar opens the page as a browser would: one request per channel per poll, without signing in.
- **Only public channels.** A private channel, a group, a user, or a bot has no preview: `t.me` redirects to the profile card, and the alert says to check the config.
- A channel without a single message — even without the service "channel created" — is treated as changed markup.

## Why not the Bot API

The Bot API cannot read a channel's history. A bot that is an administrator of the channel receives new posts as `channel_post` updates through `getUpdates`, but Telegram keeps them only for 24 hours, the bot has to be an administrator of every channel, including other people's, and the radar would compete with the probe's `find_chats` for the same updates. The preview works for any public channel and needs nothing from its owners.
