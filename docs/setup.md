# Setup

**English** · [Русский](setup.ru.md)

Order: your own copy of the repository → Telegram bot → sources → probe → first run → schedule. Every token goes only into repository secrets: not into code, not into an issue, not into a chat.

The commands below use the [GitHub CLI](https://cli.github.com/); `OWNER/REPO` is your repository. `gh secret set` asks for the value itself and does not show it on screen.

## 0. Your own copy

- **Fork** — if you want to receive updates with the **Sync fork** button. Leave **Copy the main branch only** checked. GitHub does not run workflows in a fork until you enable them on the **Actions** tab — do it before the probe.
- **Template** (**Use this template**) — if you want an independent copy with no link to the original. Do not check **Include all branches**. Updates are carried over by hand.

Copy only `main`. The original's `state` branch holds the queue and the seen posts of Discours: with it, the first run could send Discours posts and an archive of your own sources to your group. If the `state` branch was copied anyway, delete it before the first run:

```bash
gh api --method DELETE repos/OWNER/REPO/git/refs/heads/state
```

Keep the copy public: GitHub Actions minutes are free for public repositories. In a private one every run is rounded up to a minute, and polling every 10 minutes adds up to about 4,400 minutes a month — more than the free allowance of the GitHub Free plan.

In a public repository the run logs and the `state` branch are visible. They hold no secrets: the log has only counters, IDs and dates; the state has post IDs, texts of posts waiting to be sent, timestamps and error texts scrubbed of tokens.

**Secrets only for `main` (recommended).** The `radar` and `probe` jobs use the `production` environment. Create it with a rule that admits only `main`, and keep the secrets there instead of the repository secrets: then code pushed to any other branch cannot read them, even if the push comes from someone with write access or from their leaked token. Without the environment GitHub creates an empty one on the first run, and the jobs take the repository secrets.

```bash
gh api --method PUT repos/OWNER/REPO/environments/production --input - <<< '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
```

```bash
gh api --method POST repos/OWNER/REPO/environments/production/deployment-branch-policies -f name=main -f type=branch
```

In the commands of the following sections add `--env production` to `gh secret set`. The probe started from another branch then stops before its first step: that is the rule at work. If the secrets are already in the repository secrets, set each one again with `--env production` and then delete the repository copy with `gh secret delete NAME --repo OWNER/REPO`: a copy left there can be read from any branch, because a workflow changed in it simply drops the `environment` key.

**Your own config.** The root holds the working `radar.config.json` of Discours, and the examples on the network pages are its accounts too. In a fork, copy this file in the `main` branch, for example to `config/newsroom.json`, put in your own `language`, `messageTitle` and sources, and set the path in a repository variable:

```bash
gh variable set RADAR_CONFIG --body config/newsroom.json --repo OWNER/REPO
```

Then **Sync fork** will not conflict with the original's config. Changes to workflow files, such as the schedule in `radar.yml`, **Sync fork** will ask you to merge by hand. In a copy from the template you can simply edit `radar.config.json`.

The `language` field sets the language of messages, alerts and logs: `"en"` or no field for English, `"ru"` for Russian. A config written before the field appeared has no `language` and now gets English; add `"language": "ru"` to keep it Russian.

## 1. Telegram bot

1. In [@BotFather](https://t.me/BotFather): `/newbot` for a new bot, or `/mybots` → the bot → **API Token** for an existing one. Do not press **Revoke**: the old token would stop working everywhere it is already used.
2. Save the token:

   ```bash
   gh secret set TELEGRAM_BOT_TOKEN --repo OWNER/REPO
   ```

3. **Posts chat.** Add the bot to a group or a channel; in a channel the bot needs the right to post messages.
4. **Alerts chat** — usually the private chat of the person in charge. Send `/start` to the bot: without it the bot cannot write first.
5. **Chat IDs.** Run the chat search:

   ```bash
   gh workflow run probe.yml -f find_chats=true --repo OWNER/REPO
   ```

   The bot replies in up to 10 chats where it recently appeared — group, channel and private chat — with a message holding that chat's ID. Chats whose IDs are already saved in `TELEGRAM_CHAT_ID` or `TELEGRAM_ALERT_CHAT_ID` get no message and do not count toward the 10; any other chat gets it on every search, so save the IDs before searching again. If there are more than 10 new chats, the ID goes to the 10 with the latest updates, the search says so, and the run is red. IDs never reach the public log: it shows only the number and type of each chat. A group ID is a negative number; for a supergroup or a channel it starts with `-100`.

   Telegram keeps a bot's updates for 24 hours, and the search reads the first 100 of them; if there are more, it says so. If the bot was added earlier, send the command `/start@your_bot_name` to the group (by default the bot does not see ordinary group messages), publish any post in the channel, and run the search again. If another service already receives the bot's updates — through a webhook or its own polling — the search will not see them; take the ID from that service's settings.

   Save both IDs:

   ```bash
   gh secret set TELEGRAM_CHAT_ID --repo OWNER/REPO
   ```

   ```bash
   gh secret set TELEGRAM_ALERT_CHAT_ID --repo OWNER/REPO
   ```

   Without `TELEGRAM_ALERT_CHAT_ID` alerts go to the posts chat.

## 2. Sources

Replace the sources in the config with your own: the IDs in the examples are Discours accounts. How to get access and what to put into the config is on each network's page:

| Network | Page | Secret |
| --- | --- | --- |
| VK | [vk.md](sources/vk.md) | `VK_TOKEN` |
| Instagram, Facebook | [meta.md](sources/meta.md) | `META_TOKEN` |
| Bluesky | [bluesky.md](sources/bluesky.md) | not needed |
| YouTube | [youtube.md](sources/youtube.md) | `YOUTUBE_API_KEY` |
| X | [x.md](sources/x.md) | `X_BEARER_TOKEN` |
| RSS and Atom | [feed.md](sources/feed.md) | not needed |
| Telegram channels | [telegram.md](sources/telegram.md) | not needed |

The other config fields are described in the [README](../README.md#configuration).

## 3. Access probe

The probe reads every source the same way the radar does (X only the latest 5 posts: each post read is paid for), shows the pages and Instagram accounts the Meta token can see, and checks the bot. It does not touch the state.

```bash
gh workflow run probe.yml --repo OWNER/REPO
```

If the alerts chat is set, add `-f send_test=true`: the bot sends a test message there with a sample notification — the latest post of each source, exactly as posts will appear in the posts chat, in one or more messages. Without `TELEGRAM_ALERT_CHAT_ID` the probe with this flag ends with an error.

The result is in the run log (Actions → probe). Each source shows `OK` and the date of its latest post, or `ERROR` with the reason.

The probe checks the posts chat without sending anything there: the whole group would see a test message. The log shows the chat type, the bot's status and the verdict, for example `posts chat: supergroup, bot is administrator, can post`. If it says `CANNOT post` or `chat not found`, the bot is not in the group, lost the right to post, or the chat ID is wrong.

A private chat's rights cannot be checked: Telegram does not say whether the bot is blocked, and the probe writes `its rights can't be checked`. Delivery there is proven by `send_test=true`. The test message goes only to the alerts chat; if `TELEGRAM_ALERT_CHAT_ID` is not set, the probe refuses to send it rather than write to the group.

## 4. First run and schedule

The first run remembers the current posts and sends nothing:

```bash
gh workflow run radar.yml --repo OWNER/REPO
```

After it the repository has a `state` branch. Turn on the schedule:

```bash
gh variable set RADAR_ENABLED --body true --repo OWNER/REPO
```

To turn it off: `gh variable delete RADAR_ENABLED --repo OWNER/REPO`.

You can add a new source to the config later as well: its first poll also only remembers the current posts.

## If you get an alert

The alert names the network, how long it has been failing, what to do and the reason. Common reasons:

| Reason | What it means | What to do |
| --- | --- | --- |
| `auth` | the token was revoked or expired | issue a new token and update the secret named in the alert |
| `permission` | the token lacks a permission or access to the account | check access and permissions on the network's page |
| `billing` | the network refused because of payment | top up the balance or check the plan in the developer console |
| `rate_limit` | the network asked to slow down, or the daily quota ran out | usually passes on its own |
| `network` | the network did not respond | usually passes on its own |
| `http` | the network returned an error without a clear code | if it repeats for a day, open the run log |
| `bad_response` | the response could not be fully parsed: an unknown format, a feed entry without a date or link, a response larger than 32 MB | open the run log; if the network changed its response format, the code needs a fix |
| `config` | a wrong ID in the config or a missing secret | compare with the probe output |

When the network answers again, a “posts are being read again” message arrives, and posts published during the outage come in a regular message if they are younger than `maxPostAgeHours` and among the source's latest `fetchLimit` posts. After updating a secret, run the probe: it shows right away whether that helped.

## If posts stopped arriving

If runs turn red once a day, posts do not arrive, and the log of the `Radar` step has the lines `message with posts not delivered: ...` and `Telegram: ...`, look at the response code in the second one.

- **The chat or the bot is broken:** `HTTP 401`, `403`, a network error, or `HTTP 400` with a description about the chat or rights — `chat not found`, `group chat was upgraded to a supergroup chat`, `need administrator rights`, `not enough rights`. Fix the secret or the bot's rights and leave the queue alone: it waits for the fix. If the group became a supergroup, it has a new ID (usually starting with `-100`) — update `TELEGRAM_CHAT_ID` and check with the probe.
- **The message itself is broken:** `HTTP 400` with a description about the text — `message is too long`, `can't parse entities`, `text must be non-empty` — and every run names the same posts, for example `vk:123, facebook:456_789`. Telegram will never accept this message, and everything queued after it waits too. Remove these posts from the queue by hand. They are already published on the networks: only the notification about them is lost.

To remove posts from the queue:

1. Turn off the schedule so that a run does not overwrite your edit:

   ```bash
   gh variable delete RADAR_ENABLED --repo OWNER/REPO
   ```

2. Wait for the current run to finish, if one is going. Clone the state branch:

   ```bash
   git clone --branch state --single-branch https://github.com/OWNER/REPO.git radar-state
   ```

3. In `radar-state/state.json`, delete the entries with these `sourceId` and `id` from the `pending` array. Leave everything else: the IDs in `sources.*.seen` keep the radar from sending these posts again.

4. Save and turn the schedule back on:

   ```bash
   git -C radar-state commit -am "state: drop undeliverable posts" && git -C radar-state push
   ```

   ```bash
   gh variable set RADAR_ENABLED --body true --repo OWNER/REPO
   ```

If `state.json` no longer parses after the edit, the radar stops with the error `state file is corrupted` and sends nothing. No data is lost: fix the file and run again.

If something broke that is not covered here, open an issue with the Bug template.

## Good to know

- If more than `fetchLimit` posts were published on one network between two successful polls, the radar does not see the extra ones. With polling every 10 minutes this happens only after a long outage.
- The earliest post of a message arrives no sooner than `groupWindowMinutes` after publication, usually within the next 10 minutes: the first run after the window closes sends it, and GitHub may delay that run too. A shorter window delivers posts faster, but a crosspost to neighbouring networks more often splits into two messages.
- Delivery is “at least once”: a post that has entered the queue can arrive twice but is never lost. A duplicate happens if the state was not saved (a GitHub failure, a run killed by timeout) or if Telegram accepted the message but its reply never reached the radar.
- The GitHub Actions schedule is not exact: a run can be several minutes late, more at peak hours.
- GitHub disables the schedule of a public repository after 60 days without activity. The radar commits to the `state` branch and re-enables its workflow through the API, but whether GitHub counts that as activity is not documented. If the schedule does get disabled, the Actions page shows a warning, and the **Enable workflow** button turns it back on.
