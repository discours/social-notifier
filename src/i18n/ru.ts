import type { Texts } from './index.ts';

/**
 * Русские тексты. Сообщения, алерты и лог «Дискурса» сверяет с эталоном тест
 * test/discours-ru.test.ts: правка здесь меняет то, что видит редакция.
 */
const SECRETS_PLACE = 'в настройках репозитория (Settings → Secrets and variables → Actions)';

function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

const code = (value: string | undefined): string => (value ? ` (${value})` : '');

export const ru: Texts = {
  language: 'ru',
  list: (items) => items.join(' и '),
  redacted: { secret: '[секрет]', hidden: '[скрыто]' },

  digest: {
    untitledPost: 'пост без подписи',
  },

  alert: {
    headline: (partial, since) =>
      `${partial ? 'часть постов не читается' : 'посты не читаются'}, ${
        'duration' in since ? `уже ${since.duration}` : `сбоев подряд: ${since.failures}`
      }.`,
    whatToDo: (hint) => `Что сделать: ${hint}`,
    postsAfterFix: (partial, fetchLimit, maxPostAgeHours) => {
      const range = `из последних ${fetchLimit} и не старше ${maxPostAgeHours} ч`;
      return partial
        ? `Разобранные посты приходят как обычно. Остальные придут после починки, если окажутся ${range}.`
        : `Посты, вышедшие за это время, придут после починки — ${range}.`;
    },
    reason: 'Причина',
    runLog: 'Лог запуска',
    recovered: 'посты снова читаются.',
  },

  hint: {
    auth: ({ secret, network }) =>
      secret
        ? `выпустите новый токен и обновите секрет ${secret} ${SECRETS_PLACE}.`
        : `проверьте, что аккаунт открыт: ${network} перестал отдавать его посты без входа.`,
    permission: ({ secret }) =>
      secret ? `проверьте права токена ${secret} и его доступ к аккаунту.` : 'проверьте, что аккаунт открыт и не заблокирован.',
    billing: ({ network }) => `пополните баланс или проверьте тариф в кабинете разработчика ${network}.`,
    rate_limit: () =>
      'обычно ничего: сеть просит обращаться реже, и это проходит само. Если алерт повторится через сутки, сделайте опрос реже — строка cron в .github/workflows/radar.yml.',
    config: ({ sourceId, secret }) =>
      `проверьте источник «${sourceId}» в конфиге (radar.config.json или файл из переменной RADAR_CONFIG)${secret ? ` и секрет ${secret}` : ''}.`,
    network: () => 'обычно ничего: сбой на стороне сети проходит сам. Если алерт повторится через сутки, откройте лог запуска.',
    http: () => 'обычно ничего: сбой на стороне сети проходит сам. Если алерт повторится через сутки, откройте лог запуска.',
    bad_response: () =>
      'откройте лог запуска: ответ сети не разобрался, подробности — в причине ниже. Если сеть поменяла формат ответа, коду нужна правка.',
  },

  duration: {
    minutes: (n) => `${n} мин`,
    hours: (n) => `${n} ч`,
    days: (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`,
  },

  errors: {
    unexpected: (description) => `непредвиденная ошибка: ${description}`,
    notJson: (status) => `ответ не в JSON (HTTP ${status})`,
    requestFailed: (description) => `запрос не прошёл: ${description}`,
    tooLarge: (megabytes) => `ответ больше ${megabytes} МБ, дальше не читается`,
    unknownError: 'неизвестная ошибка',
    timeout: 'таймаут',
    noDescription: 'без описания',
    secretMissing: (name) => `не задан секрет ${name}`,
    apiHttp: (api, status) => `${api} ответил HTTP ${status}`,
    notObject: (api) => `ответ ${api} не объект`,
    noPostList: (network) => `в ответе ${network} нет списка постов`,
    blueskyNoFeed: 'в ответе Bluesky нет ленты',
    instagramNoMedia: 'в ответе Instagram нет списка публикаций',
    instagramNotLinked: 'к странице не привязан профессиональный аккаунт Instagram или у токена нет права instagram_basic',
    instagramIdNotNumber: 'ID аккаунта Instagram не число',
    facebookNoPageToken: (pageId) => `Graph API не выдал токен страницы ${pageId}: страница не назначена владельцу META_TOKEN`,
    youtubeNoVideos: 'в ответе YouTube нет списка видео',
    youtubeChannelNotFound: 'канал YouTube не найден: проверьте channelId',
    youtubeNoUploads: 'у канала YouTube нет плейлиста загрузок',
    xNoPostsNorCount: 'в ответе X API нет ни постов, ни meta.result_count',
    xDataNotList: 'в ответе X API data не список',
    feedName: 'Лента',
    feedNotHttps: 'лента перенаправила на адрес без https',
    feedHttp: (status) => `лента ответила HTTP ${status}`,
    feedNotFound: (status) => `лента не найдена (HTTP ${status})`,
    feedNotRssOrAtom: 'по адресу ленты не RSS и не Atom',
    feedPrefixedEntries: 'записи ленты с префиксом пространства имён (например, rss:item) не поддерживаются',
    noneParsed: (what, total) => `${what}: не разобран ни один из ${total} элементов ответа`,
    partlyParsed: (skipped, total) => `не разобрано элементов ответа: ${skipped} из ${total}`,
    noAdapter: (type) => `нет адаптера для сети ${type}`,
  },

  config: {
    cannotRead: (path, reason) => `не удалось прочитать ${path}: ${reason}`,
    notObject: 'конфиг: ожидается объект',
    errors: (list) => `ошибки в конфиге:\n- ${list.join('\n- ')}`,
    nonEmptyString: (key) => `${key}: нужна непустая строка`,
    numberRange: (key, min, max) => `${key}: нужно число от ${min} до ${max}`,
    versionFormat: (key, example, fallback) => `${key}: формат ${example}; можно не указывать, тогда ${fallback}`,
    titleTooLong: (max) => `messageTitle: не длиннее ${max} символов`,
    sourcesEmpty: 'sources: нужен непустой список',
    duplicateId: (where, id) => `${where}.id: «${id}» повторяется`,
    sourceNotObject: (where) => `${where}: ожидается объект`,
    sourceId: (where) =>
      `${where}.id: латиница в нижнем регистре, цифры, «-» и «_», до 32 символов; не служебное имя вроде constructor`,
    sourceLabel: (where, max) => `${where}.label: непустая строка до ${max} символов`,
    sourceType: (where, types) => `${where}.type: одна из сетей — ${types.join(', ')}`,
    language: (languages) => `language: один из языков — ${languages.join(', ')}; можно не указывать, тогда en`,
    fields: {
      vkOwnerId: 'целое число, у сообщества отрицательное',
      metaPageId: 'строка из цифр (ID страницы Facebook)',
      blueskyHandle: 'хэндл вида discours.bsky.social или DID вида did:plc:…',
      youtubeChannelId: 'ID канала: UC и ещё 22 символа',
      xUserId: 'строка из цифр: ID аккаунта, не имя',
      xUsername: 'имя аккаунта без @: латиница, цифры и «_», до 15 символов',
      feedUrl: 'адрес ленты: https://…, без логина и пароля в адресе',
    },
  },

  state: {
    corrupted: (detail) => `файл состояния повреждён: ${detail}`,
    notJson: 'не JSON',
    expectedVersion: (version) => `ожидается version ${version}`,
    noSourcesOrPending: 'нет sources или pending',
    source: (id) => `источник ${id}`,
    pendingPost: 'пост в очереди',
    invalidSourceId: (id) => `недопустимый id источника: ${id}`,
  },

  telegram: {
    httpError: (status, description) => `Telegram ответил HTTP ${status}: ${description ?? 'без описания'}`,
    noBotIdentity: 'Telegram не вернул id и имя бота',
  },

  log: {
    sourceError: (id, kind, errorCode, message, inRow) => `${id}: ошибка ${kind}${code(errorCode)}: ${message}; подряд ${inRow}`,
    firstPoll: (id) => `${id}: первый успешный опрос`,
    archived: (id, count) => `${id}: запомнено без уведомления, вышли до начала наблюдения: ${count}`,
    tooOld: (id, postId, maxPostAgeHours) => `${id}: пост ${postId} старше ${maxPostAgeHours} ч, пропущен`,
    polled: (id, fetched, queued) => `${id}: получено ${fetched}, новых в очереди ${queued}`,
    windowOpen: (pending) => `в очереди ${pending}, окно группировки ещё не закрылось`,
    dryRunPosts: (html) => `[dry-run] в чат:\n${html}`,
    dryRunAlert: (html) => `[dry-run] в чат алертов:\n${html}`,
    telegramSecretsMissing: 'не заданы секреты TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID',
    nothingToSendTo: 'не заданы секреты TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID: отправлять некуда',
    notDelivered: (keys) => `не доставлено сообщение с постами: ${keys}`,
    sent: (posts, messages, delay) => `отправлено постов: ${posts}, сообщений: ${messages}; от публикации до отправки: ${delay} мин`,
    telegramFailure: (error, inRow) => `Telegram: ${error}; подряд ${inRow}`,
    summary: (posts, alerts, exitCode) => `итог: постов отправлено ${posts}, алертов ${alerts}, код ${exitCode}`,
    runFailed: (message) => `сбой запуска: ${message}`,
  },

  probe: {
    sourcesSection: '== Источники ==',
    sourceOk: ({ id, count, skipped, latest }) =>
      `${id}: OK, постов в ответе ${count}${skipped > 0 ? `, нераспознанных ${skipped}` : ''}${
        latest ? `, последний ${latest.at} (id ${latest.id})` : ''
      }`,
    error: (subject, kind, errorCode, message) => `${subject}: ОШИБКА ${kind}${code(errorCode)}: ${message}`,
    metaSection: '== Что видит токен Meta ==',
    metaOwner: (id) => `владелец токена: id ${id}`,
    metaNoPages: 'страниц не видно: проверьте, что системному пользователю выдан доступ к странице',
    metaPage: (name, pageId, instagram) => `страница «${name}» pageId=${pageId}, Instagram: ${instagram ?? 'не привязан'}`,
    telegramSection: '== Telegram ==',
    botTokenMissing: 'не задан секрет TELEGRAM_BOT_TOKEN',
    bot: (username) => `бот: @${username}`,
    postsChat: 'чат для постов',
    alertsChat: 'чат для алертов',
    postsChatMissing: 'НЕ задан',
    alertsChatMissing: 'не задан, алерты пойдут в чат для постов',
    unknown: 'неизвестный',
    chatVisible: (label, type) => `${label}: ${type}, бот чат видит; права не проверить — доставку покажет send_test`,
    chatAccess: ({ label, type, status, canPost }) =>
      `${label}: ${type}${status ? `, бот — ${status}` : ''}, писать ${canPost ? 'может' : 'НЕ может'}`,
    failure: (subject, message) => `${subject}: ОШИБКА ${message}`,
    sendTestNeedsAlertChat: 'send_test: не задан TELEGRAM_ALERT_CHAT_ID, а в чат постов проба не пишет',
    testMessage: 'Проверка связи: бот может писать в этот чат. Сообщение отправила проба доступов (workflow probe).',
    previewIntro: 'Так будут выглядеть уведомления — по последнему посту каждого источника:',
    testSent: 'тестовое сообщение отправлено в чат алертов',
    result: (problems) => (problems === 0 ? 'проба: всё в порядке' : `проба: проблем ${problems}`),
    crashed: (message) => `сбой пробы: ${message}`,
    chatsSection: '== Поиск чатов ==',
    chatsWebhook:
      'Telegram не отдаёт обновления: у бота настроен webhook, их получает другой сервис. ID чата возьмите в настройках того сервиса.',
    chatsNone:
      'новых чатов нет: добавьте бота в группу или канал (в канал — администратором с правом публиковать), напишите боту /start в личку и запустите поиск снова. Telegram хранит обновления сутки. Если обновления бота читает другой сервис, ID чата возьмите в его настройках.',
    chatsTruncated:
      'у бота 100 и больше неполученных обновлений, а поиск видит только 100 самых ранних: чат, добавленный позже, может не найтись. Telegram удаляет обновления старше суток, поэтому поиск позже увидит более новые.',
    chatName: (index, type) => `чат ${index} (${type})`,
    chatReplied: 'ID отправлен туда сообщением',
    chatKnown: (secret) => `уже записан в ${secret}, сообщение не отправлено`,
    chatsSummary: (found, replied) =>
      replied === 0 ? `найдено чатов: ${found}, ID никуда не отправлен` : `найдено чатов: ${found}, ID отправлен в ${replied}: ищите сообщение бота в этих чатах`,
    testSkippedForChats: 'send_test пропущен: поиск чатов идёт отдельно, запустите пробу с send_test ещё раз',
    chatIdIntro: 'ID этого чата:',
    chatIdHint:
      'Впишите его в секрет TELEGRAM_CHAT_ID, если сюда должны приходить посты, или в TELEGRAM_ALERT_CHAT_ID, если алерты. Сообщение отправила проба доступов (workflow probe).',
  },
};
