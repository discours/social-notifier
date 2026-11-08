# X

**English** · [Русский](x.ru.md)

Account posts are read through the X API v2 (`GET /2/users/:id/tweets`) with an app token (Bearer).

**What you need:** an X developer account, an app, and credits on the balance. **Cost:** paid. Since February 6, 2026, X charges for every post read: $0.005 per post ([pricing](https://docs.x.com/x-api/getting-started/pricing)). There is no free tier for new apps.

## What it costs

The radar asks X only for posts newer than the last one it saw (`since_id`). So you mostly pay for new posts:

- the first run reads up to `fetchLimit` posts: $0.125 at 25;
- after that, $0.005 for each new post: about $0.45 a month at three posts a day;
- each probe run reads the 5 latest posts again, which is $0.025.

X documentation does not say whether an empty response is billed, or what the minimum top-up is. Check in the console after the first day.

## Token

1. In the [X developer console](https://developer.x.com/), create an app and top up the balance.
2. In the app → **Keys and tokens** → **Bearer Token** → **Generate**.
3. Save the token:

   ```bash
   gh secret set X_BEARER_TOKEN --repo OWNER/REPO
   ```

4. Find the numeric account ID. This is one paid request. Replace `USERNAME` with the account name without `@`. The command asks for the token without showing it and passes it to curl through stdin, not in arguments, so it ends up neither in the terminal history nor in the process list. It works in bash and zsh.

   ```bash
   printf 'Bearer Token: '; read -rs T; echo; printf 'Authorization: Bearer %s\n' "$T" | curl -s -H @- https://api.x.com/2/users/by/username/USERNAME; unset T
   ```

   The ID is in the `data.id` field.

## Source in the config

```json
{ "id": "x", "type": "x", "label": "X", "userId": "1234567890", "username": "discours_io" }
```

`userId` is the numeric account ID: a name can be changed, an ID cannot. `username` is optional and is used only for links like `x.com/discours_io/status/…`; without it the link goes to `x.com/i/web/status/…`.

## What arrives

- The account's own posts.
- Replies and reposts do not arrive (`exclude=replies,retweets`).

## If you get a `billing` alert

X refused because of payment: the credits ran out, or the app is not connected to a plan. Top up the balance in the developer console and run the probe.
