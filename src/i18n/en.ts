import type { Texts } from './index.ts';

/** English texts: the default for a config without `language`. */
const SECRETS_PLACE = 'in the repository settings (Settings → Secrets and variables → Actions)';

const code = (value: string | undefined): string => (value ? ` (${value})` : '');

export const en: Texts = {
  language: 'en',
  list: (items) => items.join(' and '),
  redacted: { secret: '[secret]', hidden: '[hidden]' },

  digest: {
    untitledPost: 'untitled post',
  },

  alert: {
    headline: (partial, since) =>
      `${partial ? "can't read some posts" : "can't read posts"}${
        'duration' in since ? ` for ${since.duration}` : `, failed ${since.failures} runs in a row`
      }.`,
    whatToDo: (hint) => `What to do: ${hint}`,
    postsAfterFix: (partial, fetchLimit, maxPostAgeHours) => {
      const range = `among the latest ${fetchLimit} and no older than ${maxPostAgeHours} h`;
      return partial
        ? `Posts that could be read arrive as usual. The rest will arrive after the fix if they are ${range}.`
        : `Posts published in the meantime will arrive after the fix if they are ${range}.`;
    },
    reason: 'Reason',
    runLog: 'Run log',
    recovered: 'posts are being read again.',
  },

  hint: {
    auth: ({ secret, network }) =>
      secret
        ? `issue a new token and update the ${secret} secret ${SECRETS_PLACE}.`
        : `check that the account is public: ${network} stopped serving its posts without signing in.`,
    permission: ({ secret }) =>
      secret
        ? `check the permissions of the ${secret} token and its access to the account.`
        : 'check that the account is public and not blocked.',
    billing: ({ network }) => `top up the balance or check the plan in the ${network} developer console.`,
    rate_limit: () =>
      'usually nothing: the network asks to slow down, and this passes on its own. If the alert repeats a day later, poll less often — the cron line in .github/workflows/radar.yml.',
    config: ({ sourceId, secret }) =>
      `check source “${sourceId}” in the config (radar.config.json or the file from the RADAR_CONFIG variable)${secret ? ` and the ${secret} secret` : ''}.`,
    network: () => "usually nothing: failures on the network's side pass on their own. If the alert repeats a day later, open the run log.",
    http: () => "usually nothing: failures on the network's side pass on their own. If the alert repeats a day later, open the run log.",
    bad_response: () =>
      "open the run log: the network's response could not be parsed, the details are in the reason below. If the network changed its response format, the code needs a fix.",
  },

  duration: {
    minutes: (n) => `${n} min`,
    hours: (n) => `${n} h`,
    days: (n) => `${n} ${n === 1 ? 'day' : 'days'}`,
  },

  errors: {
    unexpected: (description) => `unexpected error: ${description}`,
    notJson: (status) => `response is not JSON (HTTP ${status})`,
    requestFailed: (description) => `request failed: ${description}`,
    tooLarge: (megabytes) => `response is larger than ${megabytes} MB and was not read further`,
    unknownError: 'unknown error',
    timeout: 'timeout',
    noDescription: 'no description',
    secretMissing: (name) => `the ${name} secret is not set`,
    apiHttp: (api, status) => `${api} responded with HTTP ${status}`,
    notObject: (api) => `${api} response is not an object`,
    noPostList: (network) => `${network} response has no list of posts`,
    blueskyNoFeed: 'Bluesky response has no feed',
    instagramNoMedia: 'Instagram response has no list of media',
    instagramNotLinked: 'no Instagram professional account is linked to the page, or the token lacks the instagram_basic permission',
    instagramIdNotNumber: 'Instagram account ID is not a number',
    facebookNoPageToken: (pageId) =>
      `Graph API did not issue a token for page ${pageId}: the page is not assigned to the owner of META_TOKEN`,
    youtubeNoVideos: 'YouTube response has no list of videos',
    youtubeChannelNotFound: 'YouTube channel not found: check channelId',
    youtubeNoUploads: 'the YouTube channel has no uploads playlist',
    xNoPostsNorCount: 'X API response has neither posts nor meta.result_count',
    xDataNotList: 'X API response: data is not a list',
    feedName: 'Feed',
    feedNotHttps: 'the feed redirected to a non-https address',
    feedHttp: (status) => `the feed responded with HTTP ${status}`,
    feedNotFound: (status) => `feed not found (HTTP ${status})`,
    feedNotRssOrAtom: 'the feed URL serves neither RSS nor Atom',
    feedPrefixedEntries: 'feed entries with a namespace prefix (for example, rss:item) are not supported',
    noneParsed: (what, total) => `${what}: none of the ${total} response items could be parsed`,
    partlyParsed: (skipped, total) => `response items not parsed: ${skipped} of ${total}`,
    noAdapter: (type) => `no adapter for network ${type}`,
  },

  config: {
    cannotRead: (path, reason) => `cannot read ${path}: ${reason}`,
    notObject: 'config: expected an object',
    errors: (list) => `config errors:\n- ${list.join('\n- ')}`,
    nonEmptyString: (key) => `${key}: must be a non-empty string`,
    numberRange: (key, min, max) => `${key}: must be a number from ${min} to ${max}`,
    versionFormat: (key, example, fallback) => `${key}: format ${example}; may be omitted, then ${fallback}`,
    titleTooLong: (max) => `messageTitle: at most ${max} characters`,
    sourcesEmpty: 'sources: must be a non-empty list',
    duplicateId: (where, id) => `${where}.id: “${id}” is repeated`,
    sourceNotObject: (where) => `${where}: expected an object`,
    sourceId: (where) =>
      `${where}.id: lowercase Latin letters, digits, “-” and “_”, up to 32 characters; not a reserved name like constructor`,
    sourceLabel: (where, max) => `${where}.label: a non-empty string up to ${max} characters`,
    sourceType: (where, types) => `${where}.type: one of the networks — ${types.join(', ')}`,
    language: (languages) => `language: one of ${languages.join(', ')}; may be omitted, then en`,
    fields: {
      vkOwnerId: 'an integer, negative for a community',
      metaPageId: 'a string of digits (Facebook page ID)',
      blueskyHandle: 'a handle like discours.bsky.social or a DID like did:plc:…',
      youtubeChannelId: 'channel ID: UC followed by 22 more characters',
      xUserId: 'a string of digits: the account ID, not the name',
      xUsername: 'account name without @: Latin letters, digits and “_”, up to 15 characters',
      feedUrl: 'feed URL: https://…, without a username or password in it',
    },
  },

  state: {
    corrupted: (detail) => `state file is corrupted: ${detail}`,
    notJson: 'not JSON',
    expectedVersion: (version) => `expected version ${version}`,
    noSourcesOrPending: 'no sources or pending',
    source: (id) => `source ${id}`,
    pendingPost: 'queued post',
    invalidSourceId: (id) => `invalid source id: ${id}`,
  },

  telegram: {
    httpError: (status, description) => `Telegram responded with HTTP ${status}: ${description ?? 'no description'}`,
    noBotIdentity: 'Telegram did not return the bot id and name',
  },

  log: {
    sourceError: (id, kind, errorCode, message, inRow) => `${id}: error ${kind}${code(errorCode)}: ${message}; ${inRow} in a row`,
    firstPoll: (id) => `${id}: first successful poll`,
    archived: (id, count) => `${id}: remembered without notifying, published before watching started: ${count}`,
    tooOld: (id, postId, maxPostAgeHours) => `${id}: post ${postId} is older than ${maxPostAgeHours} h, skipped`,
    polled: (id, fetched, queued) => `${id}: fetched ${fetched}, new in queue ${queued}`,
    windowOpen: (pending) => `${pending} in queue, the grouping window is still open`,
    dryRunPosts: (html) => `[dry-run] to chat:\n${html}`,
    dryRunAlert: (html) => `[dry-run] to alerts chat:\n${html}`,
    telegramSecretsMissing: 'the TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets are not set',
    nothingToSendTo: 'the TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets are not set: nowhere to send',
    notDelivered: (keys) => `message with posts not delivered: ${keys}`,
    sent: (posts, messages, delay) => `posts sent: ${posts}, messages: ${messages}; from publication to sending: ${delay} min`,
    telegramFailure: (error, inRow) => `Telegram: ${error}; ${inRow} in a row`,
    summary: (posts, alerts, exitCode) => `result: posts sent ${posts}, alerts ${alerts}, exit code ${exitCode}`,
    runFailed: (message) => `run failed: ${message}`,
  },

  probe: {
    sourcesSection: '== Sources ==',
    sourceOk: ({ id, count, skipped, latest }) =>
      `${id}: OK, posts in response ${count}${skipped > 0 ? `, unrecognized ${skipped}` : ''}${
        latest ? `, latest ${latest.at} (id ${latest.id})` : ''
      }`,
    error: (subject, kind, errorCode, message) => `${subject}: ERROR ${kind}${code(errorCode)}: ${message}`,
    metaSection: '== What the Meta token sees ==',
    metaOwner: (id) => `token owner: id ${id}`,
    metaNoPages: 'no pages visible: check that the system user has been given access to the page',
    metaPage: (name, pageId, instagram) => `page “${name}” pageId=${pageId}, Instagram: ${instagram ?? 'not linked'}`,
    telegramSection: '== Telegram ==',
    botTokenMissing: 'the TELEGRAM_BOT_TOKEN secret is not set',
    bot: (username) => `bot: @${username}`,
    postsChat: 'posts chat',
    alertsChat: 'alerts chat',
    postsChatMissing: 'NOT set',
    alertsChatMissing: 'not set, alerts will go to the posts chat',
    unknown: 'unknown',
    chatVisible: (label, type) => `${label}: ${type}, the bot sees the chat; its rights can't be checked — send_test will show delivery`,
    chatAccess: ({ label, type, status, canPost }) =>
      `${label}: ${type}${status ? `, bot is ${status}` : ''}, ${canPost ? 'can post' : 'CANNOT post'}`,
    failure: (subject, message) => `${subject}: ERROR ${message}`,
    sendTestNeedsAlertChat: 'send_test: TELEGRAM_ALERT_CHAT_ID is not set, and the probe never writes to the posts chat',
    testMessage: 'Connection check: the bot can write to this chat. Sent by the access probe (probe workflow).',
    previewIntro: 'This is how notifications will look, with the latest post of each source:',
    testSent: 'test message sent to the alerts chat',
    result: (problems) => (problems === 0 ? 'probe: all good' : `probe: problems found: ${problems}`),
    crashed: (message) => `probe failed: ${message}`,
    chatsSection: '== Finding chats ==',
    chatsWebhook:
      "Telegram does not return updates: the bot is connected to another service via a webhook. Take the chat ID from that service's settings.",
    chatsNone:
      'no new chats: add the bot to a group or channel (to a channel as an admin allowed to post), send /start to the bot in a private chat and run the search again. Telegram keeps updates for 24 hours.',
    chatName: (index, type) => `chat ${index} (${type})`,
    chatReplied: 'ID sent there as a message',
    chatsSummary: (found, replied) => `chats found: ${found}, ID sent to ${replied}: look for the bot's message in each chat`,
    chatIdIntro: "This chat's ID:",
    chatIdHint:
      'Put it into the TELEGRAM_CHAT_ID secret if posts should arrive here, or into TELEGRAM_ALERT_CHAT_ID for alerts. Sent by the access probe (probe workflow).',
  },
};
