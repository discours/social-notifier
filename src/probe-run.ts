/**
 * Проба доступов: читает каждый источник, показывает, что видит токен Meta, и
 * проверяет бота. Состояние не меняет и ничего не отправляет, кроме двух
 * случаев по флагу: тестового сообщения с образцом уведомления в чат алертов
 * (`sendTest`) и сообщений с ID чата в найденные чаты, кроме уже записанных в
 * секреты (`findChats`, подробности — у probeChats). Лог публичный: только
 * счётчики, ID постов, даты, типы чатов и публичные названия страниц, которые
 * видит токен Meta; ID чатов — никогда.
 */
import type { Secrets } from './env.ts';
import { toSourceError } from './errors.ts';
import { escapeHtml, formatDigest, TELEGRAM_TEXT_LIMIT } from './format.ts';
import type { FetchLike } from './http.ts';
import { describe, type Texts } from './i18n/index.ts';
import { probeSourcePosts } from './sources/index.ts';
import { graphGet } from './sources/meta.ts';
import { checkChatAccess, findRecentChats, getBotIdentity, resolveChatId, sendTelegramMessage, TelegramError } from './telegram.ts';
import type { Post, RadarConfig } from './types.ts';
import { asString, isRecord } from './util.ts';

export interface ProbeDeps {
  /** Конфиг; без него (не прочитался) работает только поиск чатов. */
  config: RadarConfig | undefined;
  t: Texts;
  secrets: Secrets;
  fetch: FetchLike;
  log: (line: string) => void;
  redact: (text: string) => string;
  now: () => number;
  /** Тестовое сообщение с образцом уведомления в чат алертов. */
  sendTest?: boolean;
  /** Только поиск чатов: ответить в каждый найденный чат его ID. */
  findChats?: boolean;
}

/** Код выхода пробы: 0 — всё в порядке, 1 — есть проблемы. */
export async function runProbe(deps: ProbeDeps): Promise<0 | 1> {
  if (deps.findChats) {
    if (deps.sendTest) deps.log(deps.t.probe.testSkippedForChats);
    return probeChats(deps);
  }
  if (!deps.config) return 1;
  return probeAccess(deps, deps.config);
}

async function probeAccess(deps: ProbeDeps, config: RadarConfig): Promise<0 | 1> {
  const { t, secrets, log, redact } = deps;
  const ctx = { config, secrets, fetch: deps.fetch, notBefore: deps.now() - config.maxPostAgeHours * 60 * 60 * 1000 };
  const samples: Post[] = [];
  let failed = 0;

  log(t.probe.sourcesSection);
  for (const source of config.sources) {
    try {
      const { posts, skipped } = await probeSourcePosts(source, ctx);
      const latest = posts.reduce<Post | undefined>((best, p) => (best === undefined || p.publishedAt > best.publishedAt ? p : best), undefined);
      if (latest) samples.push(latest);
      log(
        t.probe.sourceOk({
          id: source.id,
          count: posts.length,
          skipped,
          ...(latest ? { latest: { at: new Date(latest.publishedAt).toISOString(), id: latest.id } } : {}),
        }),
      );
    } catch (err) {
      failed += 1;
      const e = toSourceError(err, redact);
      log(t.probe.error(source.id, e.kind, e.code, e.phrase(t)));
    }
  }

  if (secrets.META_TOKEN) {
    log(t.probe.metaSection);
    try {
      // Только id: лог публичный, а при личном токене имя — это имя человека.
      const me = await graphGet(ctx, 'me', { fields: 'id' });
      log(t.probe.metaOwner(asString(me.id) ?? '?'));
      // Поля перечислены явно: без них ответ содержал бы токены страниц.
      const pages = await graphGet(ctx, 'me/accounts', {
        fields: 'id,name,instagram_business_account{id,username}',
        limit: '25',
      });
      const data = Array.isArray(pages.data) ? pages.data : [];
      if (data.length === 0) log(t.probe.metaNoPages);
      for (const page of data) {
        if (!isRecord(page)) continue;
        const ig = isRecord(page.instagram_business_account) ? page.instagram_business_account : undefined;
        const igText = ig ? `@${asString(ig.username) ?? '?'} (${asString(ig.id) ?? '?'})` : undefined;
        log(t.probe.metaPage(asString(page.name) ?? '?', asString(page.id) ?? '?', igText));
      }
    } catch (err) {
      failed += 1;
      const e = toSourceError(err, redact);
      log(t.probe.error('Meta', e.kind, e.code, e.phrase(t)));
    }
  }

  log(t.probe.telegramSection);
  const token = secrets.TELEGRAM_BOT_TOKEN;
  if (!token) {
    failed += 1;
    log(t.probe.botTokenMissing);
  } else {
    failed += await probeTelegram(deps, config, token, samples);
  }

  log(t.probe.result(failed));
  return failed === 0 ? 0 : 1;
}

/** Бот и оба чата; с `sendTest` — тестовое сообщение. Возвращает число проблем. */
async function probeTelegram(deps: ProbeDeps, config: RadarConfig, token: string, samples: readonly Post[]): Promise<number> {
  const { t, secrets, log, redact } = deps;
  let failed = 0;
  try {
    const bot = await getBotIdentity(deps.fetch, token);
    log(t.probe.bot(bot.username));
    // Тип чата и статус бота не раскрывают ни чат, ни людей: лог публичный.
    const checkChat = async (label: string, chatId: string | undefined, missing: string): Promise<void> => {
      if (!chatId) {
        log(`${label}: ${missing}`);
        return;
      }
      try {
        const access = await checkChatAccess(deps.fetch, token, chatId, bot.id);
        const type = access.type ?? t.probe.unknown;
        if (access.canPost === undefined) {
          log(t.probe.chatVisible(label, type));
          return;
        }
        log(t.probe.chatAccess({ label, type, ...(access.status ? { status: access.status } : {}), canPost: access.canPost }));
        if (!access.canPost) failed += 1;
      } catch (err) {
        failed += 1;
        log(t.probe.failure(label, redact(describe(err, t))));
      }
    };
    if (!secrets.TELEGRAM_CHAT_ID) failed += 1;
    await checkChat(t.probe.postsChat, secrets.TELEGRAM_CHAT_ID, t.probe.postsChatMissing);
    await checkChat(t.probe.alertsChat, secrets.TELEGRAM_ALERT_CHAT_ID, t.probe.alertsChatMissing);
    if (deps.sendTest) {
      // Только в чат алертов: пробное сообщение в группе постов увидели бы все.
      const target = secrets.TELEGRAM_ALERT_CHAT_ID;
      if (!target) throw new TelegramError((tt) => tt.probe.sendTestNeedsAlertChat);
      for (const message of testMessages(t, config, samples)) await sendTelegramMessage(deps.fetch, token, target, message);
      log(t.probe.testSent);
    }
  } catch (err) {
    failed += 1;
    log(t.probe.failure('Telegram', redact(describe(err, t))));
  }
  return failed;
}

/**
 * Тестовое сообщение: проверка связи и, если источники отдали посты, образец
 * настоящего уведомления — по последнему посту каждого источника. Образец
 * собирает тот же formatDigest, что и радар: не влезло в одно сообщение
 * Telegram — продолжение уходит следующими, как и у радара.
 */
export function testMessages(t: Texts, config: RadarConfig, samples: readonly Post[]): { html: string; disablePreview: boolean }[] {
  const check = escapeHtml(t.probe.testMessage);
  if (samples.length === 0) return [{ html: check, disablePreview: true }];
  const intro = `${check}\n${escapeHtml(t.probe.previewIntro)}\n\n`;
  const labels = new Map(config.sources.map((s) => [s.id, s.label]));
  const sorted = [...samples].sort((a, b) => a.publishedAt - b.publishedAt);
  const chunks = formatDigest(t, config.messageTitle, sorted, (id) => labels.get(id) ?? id, TELEGRAM_TEXT_LIMIT - intro.length);
  const [first, ...rest] = chunks;
  if (!first) return [{ html: check, disablePreview: true }];
  return [{ html: `${intro}${first.html}`, disablePreview: first.disablePreview }, ...rest];
}

/**
 * Поиск чатов: бот отвечает сообщением с ID чата не больше чем в
 * MAX_FOUND_CHATS чатов из первых 100 своих обновлений за сутки, кроме чатов,
 * чьи ID уже записаны в секреты; записанный ID не узнался — не пишет никуда.
 * ID видит только тот, кто в чате; в публичный лог попадают номер и тип чата.
 */
async function probeChats(deps: ProbeDeps): Promise<0 | 1> {
  const { t, log, redact } = deps;
  log(t.probe.telegramSection);
  const token = deps.secrets.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log(t.probe.botTokenMissing);
    return 1;
  }
  let found;
  try {
    const bot = await getBotIdentity(deps.fetch, token);
    log(t.probe.bot(bot.username));
    log(t.probe.chatsSection);
    found = await findRecentChats(deps.fetch, token);
  } catch (err) {
    log(err instanceof TelegramError && err.status === 409 ? t.probe.chatsWebhook : t.probe.failure('Telegram', redact(describe(err, t))));
    return 1;
  }
  // Выборка полная: чат, добавленный позже, в неё мог не попасть — сказать
  // об этом прямо, а не только «новых чатов нет».
  if (found.truncated) log(t.probe.chatsTruncated);
  const { chats } = found;
  if (chats.length === 0) {
    log(t.probe.chatsNone);
    return 1;
  }
  // Чат, чей ID уже в секретах, ответа не получает: в группе постов его
  // увидели бы все подписчики. Сравнение — по числовому ID, как его даёт поиск.
  const known = new Map<string, string>();
  for (const name of ['TELEGRAM_CHAT_ID', 'TELEGRAM_ALERT_CHAT_ID'] as const) {
    const value = deps.secrets[name]?.trim();
    if (!value) continue;
    try {
      known.set(await resolveChatId(deps.fetch, token, value), name);
    } catch (err) {
      // Не узнали числовой ID записанного чата — не пишем никуда: ответ мог уйти в него.
      log(t.probe.failure(name, redact(describe(err, t))));
      return 1;
    }
  }
  let replied = 0;
  let failed = 0;
  for (const [index, chat] of chats.entries()) {
    const name = t.probe.chatName(index + 1, chat.type ?? t.probe.unknown);
    const secret = known.get(chat.id);
    if (secret) {
      log(`${name}: ${t.probe.chatKnown(secret)}`);
      continue;
    }
    const html = `${escapeHtml(t.probe.chatIdIntro)} <code>${escapeHtml(chat.id)}</code>\n${escapeHtml(t.probe.chatIdHint)}`;
    try {
      await sendTelegramMessage(deps.fetch, token, chat.id, { html, disablePreview: true });
      replied += 1;
      log(`${name}: ${t.probe.chatReplied}`);
    } catch (err) {
      failed += 1;
      log(t.probe.failure(name, redact(describe(err, t))));
    }
  }
  log(t.probe.chatsSummary(chats.length, replied));
  // Все найденные чаты уже в секретах: нового нет — та же подсказка, что при пустой выборке.
  if (replied + failed === 0) log(t.probe.chatsNone);
  // Зелёный — только если ID дошёл до каждого нового чата и выборка полная.
  // Отказ одного чата не мешает остальным, но в тот чат ID не дошёл; в
  // неполной выборке нужный чат мог не оказаться.
  return failed === 0 && replied > 0 && !found.truncated ? 0 : 1;
}
