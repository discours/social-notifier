import { describeError, SourceError, toSourceError } from './errors.ts';
import { formatDigest, type OutgoingMessage } from './format.ts';
import { postKey, takeDue } from './group.ts';
import {
  claimAlertRed,
  formatFailureAlert,
  formatRecoveryNotice,
  markAlertSent,
  recordFailure,
  recordSuccess,
  REALERT_AFTER_MS,
} from './health.ts';
import type { FetchLike } from './http.ts';
import { fetchSourcePosts } from './sources/index.ts';
import { rememberSeen, sourceStateOf, type RadarState } from './state.ts';
import { sendTelegramMessage } from './telegram.ts';
import type { Secrets } from './env.ts';
import type { ParsedPosts, RadarConfig } from './types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const KEEPALIVE_AFTER_MS = 25 * DAY;

export interface RadarDeps {
  config: RadarConfig;
  secrets: Secrets;
  fetch: FetchLike;
  now: () => number;
  log: (line: string) => void;
  /** Вычищает секреты из текста, который попадёт в лог, состояние или Telegram. */
  redact: (text: string) => string;
  /** Ссылка на лог текущего запуска для алертов. */
  runUrl?: string;
  /** Ничего не отправлять, только показать в логе. Состояние вызывающий не сохраняет. */
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface RadarResult {
  /** 1 — запуск должен покраснеть: пора алертить или Telegram не принимает сообщения. */
  exitCode: 0 | 1;
  postsSent: number;
  alertsSent: number;
}

interface Alert {
  message: OutgoingMessage;
  onSent: () => void;
}

/**
 * Один запуск радара: опросить источники, поставить новые посты в очередь,
 * отправить очередь, если окно группировки закрылось, и разослать алерты.
 * Меняет `state` на месте; сохраняет его вызывающий.
 *
 * Гарантия доставки — «хотя бы раз»: пост снимается с очереди после того, как
 * Telegram принял его сообщение, но состояние сохраняется уже после запуска.
 * Если сохранить его не удалось, следующий запуск пришлёт те же посты снова.
 */
export async function runRadar(state: RadarState, deps: RadarDeps): Promise<RadarResult> {
  const { config, log } = deps;
  const now = deps.now();
  const alerts: Alert[] = [];
  let alertRed = false;

  for (const source of config.sources) {
    const sourceState = sourceStateOf(state, source.id, now);
    const fail = (error: SourceError, partial = false): void => {
      const shouldAlert = recordFailure(sourceState, error, now);
      log(
        `${source.id}: ошибка ${error.kind}${error.code ? ` (${error.code})` : ''}: ${error.message}; ` +
          `подряд ${sourceState.consecutiveFailures}`,
      );
      if (shouldAlert) {
        if (claimAlertRed(sourceState, now)) alertRed = true;
        alerts.push({
          message: formatFailureAlert(source, sourceState, error, {
            now,
            maxPostAgeHours: config.maxPostAgeHours,
            fetchLimit: config.fetchLimit,
            partial,
            ...(deps.runUrl ? { runUrl: deps.runUrl } : {}),
          }),
          onSent: () => markAlertSent(sourceState, now),
        });
      }
    };

    let parsed: ParsedPosts;
    try {
      parsed = await fetchSourcePosts(source, {
        config,
        secrets: deps.secrets,
        fetch: deps.fetch,
        known: sourceState.seen,
        notBefore: now - config.maxPostAgeHours * HOUR,
      });
    } catch (err) {
      fail(toSourceError(err, deps.redact));
      continue;
    }

    const { posts, skipped } = parsed;
    if (skipped > 0) {
      // Среди нераспознанных элементов может быть новый пост. Это сбой
      // источника (два запуска подряд — алерт), но разобранные посты идут дальше.
      fail(new SourceError('bad_response', `не разобрано элементов ответа: ${skipped} из ${skipped + posts.length}`), true);
    } else if (recordSuccess(sourceState)) {
      alerts.push({
        message: formatRecoveryNotice(source),
        onSent: () => {
          delete sourceState.alertOpen;
        },
      });
    }

    if (!sourceState.bootstrapped) {
      sourceState.bootstrapped = true;
      sourceState.watchingSince ??= now;
      log(`${source.id}: первый успешный опрос`);
    }

    // Посты, вышедшие до начала наблюдения, — архив: их не шлём, даже если радар
    // видит их впервые (первый опрос, выросший fetchLimit, закреплённый старый
    // пост). Вышедшие позже идут как новые, в том числе за время, пока источник
    // был сломан с первого запуска. Без отметки начала наблюдения (состояние
    // правили руками) архива нет: иначе «сейчас» проглотило бы каждый пост.
    const since = sourceState.watchingSince;
    const known = new Set(sourceState.seen);
    const unseen = posts.filter((p) => !known.has(p.id));
    const archive = since === undefined ? [] : unseen.filter((p) => p.publishedAt < since);
    if (archive.length > 0) {
      log(`${source.id}: запомнено без уведомления, вышли до начала наблюдения: ${archive.length}`);
    }
    const queued = new Set(state.pending.map(postKey));
    const fresh = unseen
      .filter((p) => since === undefined || p.publishedAt >= since)
      .sort((a, b) => a.publishedAt - b.publishedAt);
    const cutoff = now - config.maxPostAgeHours * HOUR;
    let added = 0;
    for (const post of fresh) {
      if (post.publishedAt < cutoff) {
        log(`${source.id}: пост ${post.id} старше ${config.maxPostAgeHours} ч, пропущен`);
        continue;
      }
      const key = postKey(post);
      if (queued.has(key)) continue;
      queued.add(key);
      state.pending.push({ ...post, detectedAt: now });
      added += 1;
    }
    rememberSeen(sourceState, unseen.map((p) => p.id));
    log(`${source.id}: получено ${posts.length}, новых в очереди ${added}`);
  }

  const labels = new Map(config.sources.map((s) => [s.id, s.label]));
  const due = takeDue(state.pending, now, config.groupWindowMinutes * MINUTE);
  const digest = due ? formatDigest(config.messageTitle, due, (id) => labels.get(id) ?? id) : [];
  if (!due && state.pending.length > 0) {
    log(`в очереди ${state.pending.length}, окно группировки ещё не закрылось`);
  }

  if (state.keepaliveAt === undefined || now - state.keepaliveAt >= KEEPALIVE_AFTER_MS) {
    state.keepaliveAt = now;
  }

  if (deps.dryRun) {
    for (const message of digest) log(`[dry-run] в чат:\n${message.html}`);
    for (const alert of alerts) log(`[dry-run] в чат алертов:\n${alert.message.html}`);
    return { exitCode: alertRed ? 1 : 0, postsSent: 0, alertsSent: 0 };
  }

  const token = deps.secrets.TELEGRAM_BOT_TOKEN;
  const chatId = deps.secrets.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('не заданы секреты TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID');
  const alertChatId = deps.secrets.TELEGRAM_ALERT_CHAT_ID || chatId;
  const send = (chat: string, message: OutgoingMessage) =>
    sendTelegramMessage(deps.fetch, token, chat, message, deps.sleep);

  let telegramError: string | undefined;
  let postsSent = 0;
  let messagesSent = 0;
  const delaysMin: number[] = [];
  // Посты снимаются с очереди после каждого доставленного сообщения: если
  // Telegram откажет посередине длинного дайджеста, повторится только остаток.
  for (const message of digest) {
    try {
      await send(chatId, message);
    } catch (err) {
      telegramError = describeError(err, deps.redact);
      // Ключи постов нужны, чтобы снять из очереди сообщение, которое Telegram
      // не принимает никогда (docs/setup.md, «Если посты перестали приходить»).
      log(`не доставлено сообщение с постами: ${message.posts.map(postKey).join(', ')}`);
      break;
    }
    const sent = new Set(message.posts.map(postKey));
    state.pending = state.pending.filter((p) => !sent.has(postKey(p)));
    postsSent += message.posts.length;
    messagesSent += 1;
    for (const post of message.posts) delaysMin.push(Math.round((now - post.publishedAt) / MINUTE));
  }
  if (messagesSent > 0) {
    // Задержка от публикации до отправки — то, что видит редакция; по ней
    // подбирают окно группировки и судят, не отстаёт ли расписание GitHub.
    const low = Math.min(...delaysMin);
    const high = Math.max(...delaysMin);
    log(
      `отправлено постов: ${postsSent}, сообщений: ${messagesSent}; ` +
        `от публикации до отправки: ${low === high ? low : `${low}–${high}`} мин`,
    );
  }

  let alertsSent = 0;
  for (const alert of alerts) {
    try {
      await send(alertChatId, alert.message);
      alert.onSent();
      alertsSent += 1;
    } catch (err) {
      telegramError ??= describeError(err, deps.redact);
    }
  }

  // Если Telegram не принимает сообщения, сообщить об этом можно только красным
  // запуском (GitHub пришлёт письмо). Чтобы не слать письмо каждые 10 минут —
  // не чаще раза в сутки.
  const telegram = (state.telegram ??= { consecutiveFailures: 0 });
  let telegramRed = false;
  if (telegramError !== undefined) {
    telegram.consecutiveFailures += 1;
    log(`Telegram: ${telegramError}; подряд ${telegram.consecutiveFailures}`);
    if (telegram.redAt === undefined || now - telegram.redAt >= REALERT_AFTER_MS) {
      telegram.redAt = now;
      telegramRed = true;
    }
  } else if (messagesSent + alertsSent > 0 && (telegram.consecutiveFailures > 0 || telegram.redAt !== undefined)) {
    // Починку доказывает только доставленное сообщение. Запуск, которому нечего
    // было отправить, о Telegram ничего не знает: если бы он сбрасывал отметку,
    // мигающий источник при заблокированном чате алертов красил бы каждый
    // второй запуск.
    telegram.consecutiveFailures = 0;
    delete telegram.redAt;
  }

  return { exitCode: alertRed || telegramRed ? 1 : 0, postsSent, alertsSent };
}
