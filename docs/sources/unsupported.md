# Networks that are not supported yet

**English** · [Русский](unsupported.ru.md)

Checked on November 8, 2026 against the networks' documentation. This page says what blocks each network and what would change the decision.

## TikTok

The list of an account's videos is returned only by the Display API (`/v2/video/list/`), and only with an OAuth sign-in by the account owner. There are two obstacles:

- **The token changes by itself.** The access token lives 2 hours, the refresh token 180 days, and every refresh issues a new refresh token ([documentation](https://developers.tiktok.com/doc/oauth-user-access-token-management)). A workflow would have to rewrite the secret every two hours. That needs a personal GitHub token with permission to write secrets, and one failed write breaks the chain, after which a person has to sign in again.
- **App review.** You need a website, a privacy policy, and a demo video, and the app must not be "for personal use" ([review guidelines](https://developers.tiktok.com/doc/app-review-guidelines)).

The decision would change if there were a secret store a workflow can write to (for example, Cloudflare KV), or if TikTok introduced tokens that do not change on refresh.

## Threads

The [Threads API](https://developers.facebook.com/docs/threads) reads posts with a Threads user token, not with a Meta system user token. A long-lived token lasts 60 days, and renewing it issues a new token. So every 50–60 days a person has to issue a token by hand and update the secret; if you miss it, an `auth` alert arrives.

The adapter is simple (`GET /{user-id}/threads`, reposts are marked `REPOST_FACADE`). It is worth building if renewing by hand every two months is acceptable.

## Telegram channels

The Bot API cannot read a channel's history. A bot that is an administrator of the channel receives new posts as `channel_post` updates through `getUpdates`, but Telegram keeps them only for 24 hours, and `getUpdates` does not work if the bot has a webhook. The public preview `t.me/s/<channel>` is website markup, not an API: it changes without warning, and Telegram's rules do not describe such scraping. You can connect a channel through a third-party bridge to RSS (for example, RSSHub) as a [feed](feed.md), at your own risk.

## LinkedIn, Dzen, Odnoklassniki

- **LinkedIn:** posts of a company page are returned only by the Community Management API, and access to it is granted by application.
- **Dzen:** there is no public API or feed export, only importing a site into Dzen.
- **Odnoklassniki:** no official documentation of a method for group posts could be found.

## Suggest a network

Open an issue with the "New network" template: which network, which account, and whether it has an official API.
