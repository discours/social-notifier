# YouTube

**English** · [Русский](youtube.ru.md)

Channel videos are read through the YouTube Data API v3 with a key: the channel's "Uploads" playlist, newest videos first.

**What you need:** an API key from Google Cloud. **Cost:** free. Each run spends 2 quota units: about 290 a day out of the free 10,000.

The channel also has an RSS feed without a key (`https://www.youtube.com/feeds/videos.xml?channel_id=…`), and you can connect it as a [feed](feed.md). But in November 2026 it returned 404 even for official channels, so the API is the main path.

## Key

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project or pick an existing one.
2. **APIs & Services** → **Library** → **YouTube Data API v3** → **Enable**.
3. **APIs & Services** → **Credentials** → **Create credentials** → **API key**.
4. On the key, click **Edit API key** → **API restrictions** → **Restrict key** → only **YouTube Data API v3**. Then a leaked key does not open other APIs of the project.
5. Save the key:

   ```bash
   gh secret set YOUTUBE_API_KEY --repo OWNER/REPO
   ```

The same from the command line, if you have [gcloud](https://cloud.google.com/sdk/docs/install) installed. The key goes from Google Cloud straight into the secret and never appears on screen. The `--async` flag of `create` is required: without it gcloud prints the whole response, including the key itself.

```bash
gcloud services enable youtube.googleapis.com --project PROJECT
gcloud services api-keys create --async --project PROJECT --display-name="social-notifier YouTube" --api-target=service=youtube.googleapis.com
gcloud services api-keys list --project PROJECT --format="value(displayName,name.basename())"
gcloud services api-keys get-key-string KEY_ID --project PROJECT --format="value(keyString)" | gh secret set YOUTUBE_API_KEY --repo OWNER/REPO
```

`KEY_ID` is the second column of the `list` output, in the row of the `social-notifier YouTube` key. With `--async` gcloud does not wait for the key to be created: if the new key is not in the list yet, run `list` again in a few seconds.

The radar sends the key in the `x-goog-api-key` header, not in the request URL.

## Source in the config

```json
{ "id": "youtube", "type": "youtube", "label": "YouTube", "channelId": "UCXEydGIYsqj-fjDnqAOXNNg" }
```

`channelId` is the channel ID: `UC` and 22 more characters. You can see it in an address like `youtube.com/channel/UC…`. If the channel address has `@name`, open the channel description → **Share**: it has an item that copies the channel ID.

## What arrives

- Public videos, Shorts, and livestream recordings of the channel. The time is when the video became public.
- Private videos and unlisted videos do not arrive.
- The API has no Shorts flag: they arrive as regular videos.
