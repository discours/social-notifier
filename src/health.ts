import type { FailureKind, FailureRecord } from './errors.ts';
import { escapeHtml, type OutgoingMessage } from './format.ts';
import type { Texts } from './i18n/index.ts';
import { adapterFor, type SourceConfig } from './sources/index.ts';
import type { SourceState } from './state.ts';

/** Алерт уходит со второго неудачного запуска подряд: разовый сбой сети не повод будить человека. */
export const ALERT_AFTER_FAILURES = 2;
/**
 * Алерт и красный запуск по одному источнику — не чаще раза в сутки. Отметки
 * `alertedAt` и `alertRedAt` не сбрасываются успехом, а стареют: иначе
 * источник, который сбоит через раз, слал бы алерт, «снова читаются» и письмо
 * GitHub каждые полчаса.
 */
export const REALERT_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Отмечает неудачу. Возвращает true, если пора слать алерт. `partial` —
 * ответ разобрался не целиком, и разобранные посты идут дальше. Текст ошибки
 * сохраняется на языке конфига.
 */
export function recordFailure(state: SourceState, err: FailureRecord, now: number, partial = false): boolean {
  // Начало серии известно, только если серия началась при этой версии: у
  // сбоя, тянущегося с прошлой версии, поля нет, и алерт считает запуски.
  if (state.consecutiveFailures === 0) state.failingSince = now;
  state.consecutiveFailures += 1;
  state.lastError = { kind: err.kind, message: err.message, at: now, ...(err.code ? { code: err.code } : {}) };
  if (state.consecutiveFailures < ALERT_AFTER_FAILURES) return false;
  // Алерт о частичном сбое обещал, что разобранные посты приходят. Если
  // источник лёг целиком, обещание ложно: новый алерт — сразу, а не через сутки.
  if (state.alertedPartial === true && !partial) return true;
  return state.alertedAt === undefined || now - state.alertedAt >= REALERT_AFTER_MS;
}

/** Алерт доставлен: отсчёт суток до следующего и ожидание уведомления о починке. */
export function markAlertSent(state: SourceState, now: number, partial = false): void {
  state.alertedAt = now;
  state.alertOpen = true;
  if (partial) state.alertedPartial = true;
  else delete state.alertedPartial;
}

/**
 * Красный запуск из-за алерта — не чаще раза в сутки. Сам алерт повторяется
 * каждый запуск, пока не дойдёт; но если чат алертов его не принимает (бот
 * заблокирован, никто не нажал /start), письмо GitHub каждые 10 минут ничего
 * не добавит. Отметка ставится при попытке, а не при доставке.
 */
export function claimAlertRed(state: SourceState, now: number): boolean {
  if (state.alertRedAt !== undefined && now - state.alertRedAt < REALERT_AFTER_MS) return false;
  state.alertRedAt = now;
  return true;
}

/**
 * Отмечает успех. Возвращает true, если человек получил алерт и ещё не
 * получил «снова читаются». Флаг `alertOpen` снимает только доставка этого
 * уведомления: если Telegram в этот момент недоступен, оно повторится
 * следующим успешным запуском.
 */
export function recordSuccess(state: SourceState): boolean {
  state.consecutiveFailures = 0;
  delete state.failingSince;
  delete state.lastError;
  return state.alertOpen === true;
}

/**
 * «Снова читаются» доставлено: алерт закрыт, и обещание частичного алерта
 * («разобранные посты приходят») — тоже. Не при успехе: если уведомление не
 * дошло, последним человек видел обещание, и полный сбой должен его опровергнуть.
 */
export function markRecoverySent(state: SourceState): void {
  delete state.alertOpen;
  delete state.alertedPartial;
}

/** Секреты источника в тексте: `VK_TOKEN`, `A и B`; пустая строка — сеть без ключа. */
export function secretsOf(source: SourceConfig, t: Texts): string {
  return t.list(adapterFor(source).secrets);
}

/** Что делать человеку: первое слово — действие, без кода ошибки. */
export function failureHint(kind: FailureKind, source: SourceConfig, t: Texts): string {
  return t.hint[kind]({ secret: secretsOf(source, t), network: adapterFor(source).network, sourceId: source.id });
}

/** «20 мин», «3 ч», «2 дня» — сколько длится сбой. */
export function formatDuration(ms: number, t: Texts): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return t.duration.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t.duration.hours(hours);
  return t.duration.days(Math.floor(hours / 24));
}

export interface AlertContext {
  t: Texts;
  now: number;
  /** Порог свежести из конфига: посты старше после починки не придут. */
  maxPostAgeHours: number;
  /** Сколько последних постов радар читает за раз: вышедшие сверх этого за время сбоя он не увидит. */
  fetchLimit: number;
  /** Ответ разобрался не целиком: разобранные посты уже идут в очередь. */
  partial?: boolean;
  runUrl?: string;
}

/**
 * Алерт о сбое: сначала что сломалось и как давно, затем что сделать, что
 * будет с постами и только потом код ошибки — он для того, кто откроет лог.
 * Тексты каталога экранируются, как и всё остальное: разметку ставит только этот код.
 */
export function formatFailureAlert(source: SourceConfig, state: SourceState, err: FailureRecord, ctx: AlertContext): OutgoingMessage {
  const { t } = ctx;
  const partial = ctx.partial === true;
  const since =
    state.failingSince === undefined
      ? { failures: state.consecutiveFailures }
      : { duration: formatDuration(ctx.now - state.failingSince, t) };
  const lines = [
    `<b>${escapeHtml(source.label)}</b>: ${escapeHtml(t.alert.headline(partial, since))}`,
    escapeHtml(t.alert.whatToDo(failureHint(err.kind, source, t))),
    escapeHtml(t.alert.postsAfterFix(partial, ctx.fetchLimit, ctx.maxPostAgeHours)),
    `${escapeHtml(t.alert.reason)}: <code>${escapeHtml(err.kind)}</code> — ${escapeHtml(err.message)}`,
  ];
  if (ctx.runUrl) lines.push(`<a href="${escapeHtml(ctx.runUrl)}">${escapeHtml(t.alert.runLog)}</a>`);
  return { html: lines.join('\n'), disablePreview: true };
}

export function formatRecoveryNotice(source: SourceConfig, t: Texts): OutgoingMessage {
  return { html: `<b>${escapeHtml(source.label)}</b>: ${escapeHtml(t.alert.recovered)}`, disablePreview: true };
}
