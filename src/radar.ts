import { describeError, failureRecord, SourceError, toSourceError } from './errors.ts';
import { formatDigest, type OutgoingMessage } from './format.ts';
import { postKey, takeDue } from './group.ts';
import {
  claimAlertRed,
  formatFailureAlert,
  formatRecoveryNotice,
  markAlertSent,
  markRecoverySent,
  recordFailure,
  recordSuccess,
  REALERT_AFTER_MS,
} from './health.ts';
import type { FetchLike } from './http.ts';
import { LocalizedError, textsFor } from './i18n/index.ts';
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
 * Меняет `state` на месте; сохраняет его вызывающий. Сообщения, алерты, лог и
 * тексты ошибок в состоянии — на языке конфига.
 *
 * Гарантия доставки — «хотя бы раз»: пост снимается с очереди после того, как
 * Telegram принял его сообщение, но состояние сохраняется уже после запуска.
 * Если сохранить его не удалось, следующий запуск пришлёт те же посты снова.
 */
export async function runRadar(state: RadarState, deps: RadarDeps): Promise<RadarResult> {
  const { config, log } = deps;
  const t = textsFor(config.language);
  const now = deps.now();
  const alerts: Alert[] = [];
  let alertRed = false;

  for (const source of config.sources) {
    const sourceState = sourceStateOf(state, source.id, now);
    // Пост старше порога или вышедший до начала наблюдения в очередь не попадёт.
    const cutoff = now - config.maxPostAgeHours * HOUR;
    const fail = (error: SourceError, partial = false): void => {
      const failure = failureRecord(error, t);
      const shouldAlert = recordFailure(sourceState, failure, now, partial);
      log(t.log.sourceError(source.id, failure.kind, failure.code, failure.message, sourceState.consecutiveFailures));
      if (shouldAlert) {
        if (claimAlertRed(sourceState, now)) alertRed = true;
        alerts.push({
          message: formatFailureAlert(source, sourceState, failure, {
            t,
            now,
            maxPostAgeHours: config.maxPostAgeHours,
            fetchLimit: config.fetchLimit,
            partial,
            ...(deps.runUrl ? { runUrl: deps.runUrl } : {}),
          }),
          onSent: () => markAlertSent(sourceState, now, partial),
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
        // Битая запись старше этого — не потерянный пост, а архив или старьё.
        notBefore: Math.max(cutoff, sourceState.watchingSince ?? -Infinity),
      });
    } catch (err) {
      fail(toSourceError(err, deps.redact));
      continue;
    }

    const { posts, skipped } = parsed;
    if (skipped > 0) {
      // Среди нераспознанных элементов может быть новый пост. Это сбой
      // источника (два запуска подряд — алерт), но разобранные посты идут дальше.
      fail(new SourceError('bad_response', (tt) => tt.errors.partlyParsed(skipped, skipped + posts.length)), true);
    } else if (recordSuccess(sourceState)) {
      alerts.push({
        message: formatRecoveryNotice(source, t),
        onSent: () => markRecoverySent(sourceState),
      });
    }

    if (!sourceState.bootstrapped) {
      sourceState.bootstrapped = true;
      sourceState.watchingSince ??= now;
      log(t.log.firstPoll(source.id));
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
      log(t.log.archived(source.id, archive.length));
    }
    const queued = new Set(state.pending.map(postKey));
    const fresh = unseen
      .filter((p) => since === undefined || p.publishedAt >= since)
      .sort((a, b) => a.publishedAt - b.publishedAt);
    let added = 0;
    for (const post of fresh) {
      if (post.publishedAt < cutoff) {
        log(t.log.tooOld(source.id, post.id, config.maxPostAgeHours));
        continue;
      }
      const key = postKey(post);
      if (queued.has(key)) continue;
      queued.add(key);
      state.pending.push({ ...post, detectedAt: now });
      added += 1;
    }
    rememberSeen(sourceState, unseen.map((p) => p.id));
    log(t.log.polled(source.id, posts.length, added));
  }

  const labels = new Map(config.sources.map((s) => [s.id, s.label]));
  const due = takeDue(state.pending, now, config.groupWindowMinutes * MINUTE);
  const digest = due ? formatDigest(t, config.messageTitle, due, (id) => labels.get(id) ?? id) : [];
  if (!due && state.pending.length > 0) {
    log(t.log.windowOpen(state.pending.length));
  }

  if (state.keepaliveAt === undefined || now - state.keepaliveAt >= KEEPALIVE_AFTER_MS) {
    state.keepaliveAt = now;
  }

  if (deps.dryRun) {
    for (const message of digest) log(t.log.dryRunPosts(message.html));
    for (const alert of alerts) log(t.log.dryRunAlert(alert.message.html));
    return { exitCode: alertRed ? 1 : 0, postsSent: 0, alertsSent: 0 };
  }

  const token = deps.secrets.TELEGRAM_BOT_TOKEN;
  const chatId = deps.secrets.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new LocalizedError((tt) => tt.log.telegramSecretsMissing);
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
      telegramError = describeError(err, t, deps.redact);
      // Ключи постов нужны, чтобы снять из очереди сообщение, которое Telegram
      // не принимает никогда (docs/setup.md, «If posts stopped arriving»).
      log(t.log.notDelivered(message.posts.map(postKey).join(', ')));
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
    log(t.log.sent(postsSent, messagesSent, low === high ? String(low) : `${low}–${high}`));
  }

  let alertsSent = 0;
  for (const alert of alerts) {
    try {
      await send(alertChatId, alert.message);
      alert.onSent();
      alertsSent += 1;
    } catch (err) {
      telegramError ??= describeError(err, t, deps.redact);
    }
  }

  // Если Telegram не принимает сообщения, сообщить об этом можно только красным
  // запуском (GitHub пришлёт письмо). Чтобы не слать письмо каждые 10 минут —
  // не чаще раза в сутки.
  const telegram = (state.telegram ??= { consecutiveFailures: 0 });
  let telegramRed = false;
  if (telegramError !== undefined) {
    telegram.consecutiveFailures += 1;
    log(t.log.telegramFailure(telegramError, telegram.consecutiveFailures));
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
