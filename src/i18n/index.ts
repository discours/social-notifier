/**
 * Каталог текстов для людей: сообщения, алерты, вывод пробы, строки лога и
 * ошибки. Все тексты живут в `ru.ts` и `en.ts` и только там; код собирает из
 * них строки и сам добавляет разметку Telegram, поэтому в каталоге нет HTML.
 * Новый язык — файл с объектом типа `Texts` и строка в CATALOG: компилятор
 * не пропустит язык, в котором не хватает хоть одного текста.
 */
import type { FailureKind } from '../errors.ts';
import { en } from './en.ts';
import { ru } from './ru.ts';

export const LANGUAGES = ['en', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];
/** Язык конфига без поля `language`. */
export const DEFAULT_LANGUAGE: Language = 'en';

/** Сколько длится сбой: число минут, или часов, или дней — что выбрал formatDuration. */
export type Since = { duration: string } | { failures: number };

export interface HintContext {
  /** Секреты сети через «и»; пустая строка — сеть читается без ключа. */
  secret: string;
  /** Название сети для людей: VK, Bluesky. */
  network: string;
  sourceId: string;
}

export interface ProbeSourceLine {
  id: string;
  count: number;
  skipped: number;
  latest?: { at: string; id: string };
}

export interface ChatAccessLine {
  label: string;
  type: string;
  status?: string;
  canPost: boolean;
}

/** Все тексты одного языка. Ни в одном нет разметки: экранирует и размечает код. */
export interface Texts {
  readonly language: Language;
  /** Перечисление: «A и B», «A and B». */
  list(items: readonly string[]): string;
  /** Чем заменяются секреты и всё, похожее на токен, в логе, алертах и состоянии. */
  readonly redacted: { readonly secret: string; readonly hidden: string };

  readonly digest: {
    /** Вместо текста поста без подписи. */
    readonly untitledPost: string;
  };

  readonly alert: {
    /** После подписи сети: «посты не читаются, уже 20 мин.» */
    headline(partial: boolean, since: Since): string;
    /** «Что сделать: …» — подсказка из `hint`. */
    whatToDo(hint: string): string;
    /** Что будет с постами, вышедшими за время сбоя. */
    postsAfterFix(partial: boolean, fetchLimit: number, maxPostAgeHours: number): string;
    /** Подпись перед кодом ошибки: «Причина». */
    readonly reason: string;
    readonly runLog: string;
    /** После подписи сети: «посты снова читаются.» */
    readonly recovered: string;
  };

  /** Что делать человеку: первое слово — действие, без кода ошибки. */
  readonly hint: { readonly [K in FailureKind]: (ctx: HintContext) => string };

  readonly duration: {
    minutes(n: number): string;
    hours(n: number): string;
    days(n: number): string;
  };

  /** Тексты ошибок источников: попадают в причину алерта, лог и state.json. */
  readonly errors: {
    unexpected(description: string): string;
    notJson(status: number): string;
    requestFailed(description: string): string;
    tooLarge(megabytes: number): string;
    readonly unknownError: string;
    readonly timeout: string;
    /** Когда сеть не прислала описания ошибки. */
    readonly noDescription: string;
    secretMissing(name: string): string;
    /** «VK API ответил HTTP 500». */
    apiHttp(api: string, status: number): string;
    notObject(api: string): string;
    noPostList(network: string): string;
    readonly blueskyNoFeed: string;
    readonly instagramNoMedia: string;
    readonly instagramNotLinked: string;
    readonly instagramIdNotNumber: string;
    facebookNoPageToken(pageId: string): string;
    readonly youtubeNoVideos: string;
    readonly youtubeChannelNotFound: string;
    readonly youtubeNoUploads: string;
    readonly xNoPostsNorCount: string;
    readonly xDataNotList: string;
    readonly feedName: string;
    readonly feedNotHttps: string;
    feedHttp(status: number): string;
    feedNotFound(status: number): string;
    readonly feedNotRssOrAtom: string;
    readonly feedPrefixedEntries: string;
    /** Ни один элемент непустого ответа не разобрался. */
    noneParsed(what: string, total: number): string;
    /** Часть элементов ответа не разобралась. */
    partlyParsed(skipped: number, total: number): string;
    noAdapter(type: string): string;
  };

  /** Ошибки конфига: строки списка «ошибки в конфиге». */
  readonly config: {
    cannotRead(path: string, reason: string): string;
    readonly notObject: string;
    errors(list: readonly string[]): string;
    nonEmptyString(key: string): string;
    numberRange(key: string, min: number, max: number): string;
    versionFormat(key: string, example: string, fallback: string): string;
    titleTooLong(max: number): string;
    readonly sourcesEmpty: string;
    duplicateId(where: string, id: string): string;
    sourceNotObject(where: string): string;
    sourceId(where: string): string;
    sourceLabel(where: string, max: number): string;
    sourceType(where: string, types: readonly string[]): string;
    language(languages: readonly string[]): string;
    /** Поля источников по сетям: что ожидается. */
    readonly fields: {
      readonly vkOwnerId: string;
      readonly metaPageId: string;
      readonly blueskyHandle: string;
      readonly youtubeChannelId: string;
      readonly xUserId: string;
      readonly xUsername: string;
      readonly feedUrl: string;
    };
  };

  readonly state: {
    corrupted(detail: string): string;
    readonly notJson: string;
    expectedVersion(version: number): string;
    readonly noSourcesOrPending: string;
    source(id: string): string;
    readonly pendingPost: string;
    invalidSourceId(id: string): string;
  };

  readonly telegram: {
    httpError(status: number, description: string | undefined): string;
    readonly noBotIdentity: string;
  };

  /** Строки лога радара. Лог публичный: только счётчики, ID и даты. */
  readonly log: {
    sourceError(id: string, kind: string, code: string | undefined, message: string, inRow: number): string;
    firstPoll(id: string): string;
    archived(id: string, count: number): string;
    tooOld(id: string, postId: string, maxPostAgeHours: number): string;
    polled(id: string, fetched: number, queued: number): string;
    windowOpen(pending: number): string;
    dryRunPosts(html: string): string;
    dryRunAlert(html: string): string;
    readonly telegramSecretsMissing: string;
    readonly nothingToSendTo: string;
    notDelivered(keys: string): string;
    sent(posts: number, messages: number, delay: string): string;
    telegramFailure(error: string, inRow: number): string;
    summary(posts: number, alerts: number, code: number): string;
    runFailed(message: string): string;
  };

  /** Вывод пробы доступов и сообщения, которые она отправляет. */
  readonly probe: {
    readonly sourcesSection: string;
    sourceOk(line: ProbeSourceLine): string;
    error(subject: string, kind: string, code: string | undefined, message: string): string;
    readonly metaSection: string;
    metaOwner(id: string): string;
    readonly metaNoPages: string;
    metaPage(name: string, pageId: string, instagram: string | undefined): string;
    readonly telegramSection: string;
    readonly botTokenMissing: string;
    bot(username: string): string;
    readonly postsChat: string;
    readonly alertsChat: string;
    readonly postsChatMissing: string;
    readonly alertsChatMissing: string;
    readonly unknown: string;
    chatVisible(label: string, type: string): string;
    chatAccess(line: ChatAccessLine): string;
    failure(subject: string, message: string): string;
    readonly sendTestNeedsAlertChat: string;
    /** Первая строка тестового сообщения в чат алертов. */
    readonly testMessage: string;
    /** Вторая строка, если есть посты для образца сообщения. */
    readonly previewIntro: string;
    readonly testSent: string;
    result(problems: number): string;
    crashed(message: string): string;
    readonly chatsSection: string;
    readonly chatsWebhook: string;
    readonly chatsNone: string;
    /** getUpdates отдал полную выборку: более поздние обновления не видны. */
    readonly chatsTruncated: string;
    /** Найденный чат в публичном логе: номер и тип, без ID и названия. */
    chatName(index: number, type: string): string;
    readonly chatReplied: string;
    /** Чат, чей ID уже записан в секрет: ему ничего не отправляется. */
    chatKnown(secret: string): string;
    chatsSummary(found: number, replied: number): string;
    /** Отмечены оба флага: поиск чатов идёт один, тестовое сообщение не уходит. */
    readonly testSkippedForChats: string;
    /** Сообщение в найденный чат: «ID этого чата:», затем сам ID, затем куда его вписать. */
    readonly chatIdIntro: string;
    readonly chatIdHint: string;
  };
}

const CATALOG: { readonly [L in Language]: Texts } = { en, ru };

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function textsFor(language: Language): Texts {
  return CATALOG[language];
}

/**
 * Текст, язык которого выбирается при показе. Адаптер, бросая ошибку, не знает
 * языка конфига: ошибка хранит фразу, а алерт и лог отрисовывают её на нём.
 */
export type Phrase = (t: Texts) => string;

/** Ошибка с текстом на любом языке каталога; `message` — на языке по умолчанию. */
export class LocalizedError extends Error {
  readonly phrase: Phrase;

  constructor(phrase: Phrase | string) {
    const render: Phrase = typeof phrase === 'string' ? () => phrase : phrase;
    super(render(CATALOG[DEFAULT_LANGUAGE]));
    this.name = 'LocalizedError';
    this.phrase = render;
  }
}

/** Текст ошибки на языке `t`; у чужих ошибок — их собственный текст. */
export function describe(err: unknown, t: Texts): string {
  if (err instanceof LocalizedError) return err.phrase(t);
  return err instanceof Error ? err.message : String(err);
}
