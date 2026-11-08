/**
 * Проба доступов: читает каждый источник и показывает, что видит токен Meta.
 * Ничего не отправляет (кроме тестового сообщения с флагом --send-test) и не
 * меняет состояние. Печатает только счётчики, ID и даты: лог публичный.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { readSecrets, secretValues } from './env.ts';
import { toSourceError } from './errors.ts';
import { fetchSourcePosts } from './sources/index.ts';
import { graphGet } from './sources/meta.ts';
import { checkChatAccess, getBotIdentity, sendTelegramMessage } from './telegram.ts';
import { asString, isRecord, makeRedactor } from './util.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'radar.config.json' },
    'send-test': { type: 'boolean', default: false },
  },
});

const secrets = readSecrets(process.env);
const redact = makeRedactor(secretValues(secrets));
const log = (line: string) => console.log(redact(line));
const fetchFn = globalThis.fetch;

async function main(): Promise<number> {
  const config = loadConfig(values.config);
  const ctx = { config, secrets, fetch: fetchFn };
  let failed = 0;

  log('== Источники ==');
  for (const source of config.sources) {
    try {
      const { posts, skipped } = await fetchSourcePosts(source, ctx);
      const latest = posts.reduce<(typeof posts)[number] | undefined>(
        (best, p) => (best === undefined || p.publishedAt > best.publishedAt ? p : best),
        undefined,
      );
      const tail = latest ? `, последний ${new Date(latest.publishedAt).toISOString()} (id ${latest.id})` : '';
      const skippedNote = skipped > 0 ? `, нераспознанных ${skipped}` : '';
      log(`${source.id}: OK, постов в ответе ${posts.length}${skippedNote}${tail}`);
    } catch (err) {
      failed += 1;
      const e = toSourceError(err, redact);
      log(`${source.id}: ОШИБКА ${e.kind}${e.code ? ` (${e.code})` : ''}: ${e.message}`);
    }
  }

  if (secrets.META_TOKEN) {
    log('== Что видит токен Meta ==');
    try {
      // Только id: лог публичный, а при личном токене имя — это имя человека.
      const me = await graphGet(ctx, 'me', { fields: 'id' });
      log(`владелец токена: id ${asString(me.id) ?? '?'}`);
      // Поля перечислены явно: без них ответ содержал бы токены страниц.
      const pages = await graphGet(ctx, 'me/accounts', {
        fields: 'id,name,instagram_business_account{id,username}',
        limit: '25',
      });
      const data = Array.isArray(pages.data) ? pages.data : [];
      if (data.length === 0) log('страниц не видно: проверь, что странице выдан доступ');
      for (const page of data) {
        if (!isRecord(page)) continue;
        const ig = isRecord(page.instagram_business_account) ? page.instagram_business_account : undefined;
        const igText = ig ? `@${asString(ig.username) ?? '?'} (${asString(ig.id) ?? '?'})` : 'не привязан';
        log(`страница «${asString(page.name) ?? '?'}» pageId=${asString(page.id) ?? '?'}, Instagram: ${igText}`);
      }
    } catch (err) {
      failed += 1;
      const e = toSourceError(err, redact);
      log(`Meta: ОШИБКА ${e.kind}${e.code ? ` (${e.code})` : ''}: ${e.message}`);
    }
  }

  log('== Telegram ==');
  if (!secrets.TELEGRAM_BOT_TOKEN) {
    failed += 1;
    log('не задан секрет TELEGRAM_BOT_TOKEN');
  } else {
    const token = secrets.TELEGRAM_BOT_TOKEN;
    try {
      const bot = await getBotIdentity(fetchFn, token);
      log(`бот: @${bot.username}`);
      // Тип чата и статус бота не раскрывают ни чат, ни людей: лог публичный.
      const checkChat = async (label: string, chatId: string | undefined, fallback: string): Promise<void> => {
        if (!chatId) {
          log(`${label}: ${fallback}`);
          return;
        }
        try {
          const access = await checkChatAccess(fetchFn, token, chatId, bot.id);
          if (access.canPost === undefined) {
            log(`${label}: ${access.type}, бот чат видит; права не проверить — доставку покажет send_test`);
            return;
          }
          const status = access.status ? `, бот — ${access.status}` : '';
          log(`${label}: ${access.type}${status}, писать ${access.canPost ? 'может' : 'НЕ может'}`);
          if (!access.canPost) failed += 1;
        } catch (err) {
          failed += 1;
          log(`${label}: ОШИБКА ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      if (!secrets.TELEGRAM_CHAT_ID) failed += 1;
      await checkChat('чат для постов', secrets.TELEGRAM_CHAT_ID, 'НЕ задан');
      await checkChat('чат для алертов', secrets.TELEGRAM_ALERT_CHAT_ID, 'не задан, алерты пойдут в чат для постов');
      if (values['send-test']) {
        // Только в чат алертов: пробное сообщение в группе постов увидели бы все.
        const target = secrets.TELEGRAM_ALERT_CHAT_ID;
        if (!target) throw new Error('send_test: не задан TELEGRAM_ALERT_CHAT_ID, а в чат постов проба не пишет');
        await sendTelegramMessage(fetchFn, secrets.TELEGRAM_BOT_TOKEN, target, {
          html: 'Проверка связи: бот может писать в этот чат. Сообщение отправила проба доступов (workflow probe).',
          disablePreview: true,
        });
        log('тестовое сообщение отправлено в чат алертов');
      }
    } catch (err) {
      failed += 1;
      log(`Telegram: ОШИБКА ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(failed === 0 ? 'проба: всё в порядке' : `проба: проблем ${failed}`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log(`сбой пробы: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
