import type { FailureKind, SourceError } from './errors.ts';
import { escapeHtml, type OutgoingMessage } from './format.ts';
import type { SourceState } from './state.ts';
import type { SourceConfig } from './types.ts';

/** Алерт уходит со второго неудачного запуска подряд: разовый сбой сети не повод будить человека. */
export const ALERT_AFTER_FAILURES = 2;
/**
 * Алерт и красный запуск по одному источнику — не чаще раза в сутки. Отметки
 * `alertedAt` и `alertRedAt` не сбрасываются успехом, а стареют: иначе
 * источник, который сбоит через раз, слал бы алерт, «снова отвечает» и письмо
 * GitHub каждые полчаса.
 */
export const REALERT_AFTER_MS = 24 * 60 * 60 * 1000;

/** Отмечает неудачу. Возвращает true, если пора слать алерт. */
export function recordFailure(state: SourceState, err: SourceError, now: number): boolean {
  state.consecutiveFailures += 1;
  state.lastError = { kind: err.kind, message: err.message, at: now, ...(err.code ? { code: err.code } : {}) };
  if (state.consecutiveFailures < ALERT_AFTER_FAILURES) return false;
  return state.alertedAt === undefined || now - state.alertedAt >= REALERT_AFTER_MS;
}

/** Алерт доставлен: отсчёт суток до следующего и ожидание уведомления о починке. */
export function markAlertSent(state: SourceState, now: number): void {
  state.alertedAt = now;
  state.alertOpen = true;
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
 * получил «снова отвечает». Флаг `alertOpen` снимает только доставка этого
 * уведомления: если Telegram в этот момент недоступен, оно повторится
 * следующим успешным запуском.
 */
export function recordSuccess(state: SourceState): boolean {
  state.consecutiveFailures = 0;
  delete state.lastError;
  return state.alertOpen === true;
}

export function secretNameFor(source: SourceConfig): string {
  return source.type === 'vk' ? 'VK_TOKEN' : 'META_TOKEN';
}

export function failureHint(kind: FailureKind, source: SourceConfig): string {
  const secret = secretNameFor(source);
  switch (kind) {
    case 'auth':
      return `Токен не принят. Выпусти новый и обнови секрет ${secret} в настройках репозитория.`;
    case 'permission':
      return `Токену не хватает прав. Проверь права токена ${secret} и его доступ к странице или сообществу.`;
    case 'rate_limit':
      return 'Сеть временно ограничила частоту запросов. Обычно проходит само; если алерт повторится через сутки, увеличь интервал опроса.';
    case 'config':
      return `Проверь источник «${source.id}» в radar.config.json и секрет ${secret}.`;
    case 'network':
    case 'http':
      return 'Сеть недоступна или отвечает ошибкой. Если алерт повторится через сутки, открой лог запуска.';
    case 'bad_response':
      return 'Ответ пришёл в неожиданном формате: возможно, сеть поменяла API, и радару нужна правка. Открой лог запуска.';
  }
}

export function formatFailureAlert(
  source: SourceConfig,
  err: SourceError,
  failures: number,
  runUrl?: string,
): OutgoingMessage {
  const lines = [
    `Радар постов: <b>${escapeHtml(source.label)}</b> не отвечает ${failures} запуска подряд.`,
    `Ошибка: <code>${err.kind}</code>, ${escapeHtml(err.message)}`,
    `Что сделать: ${escapeHtml(failureHint(err.kind, source))}`,
  ];
  if (runUrl) lines.push(`<a href="${escapeHtml(runUrl)}">Лог запуска</a>`);
  return { html: lines.join('\n'), disablePreview: true };
}

export function formatRecoveryNotice(source: SourceConfig): OutgoingMessage {
  return { html: `Радар постов: <b>${escapeHtml(source.label)}</b> снова отвечает.`, disablePreview: true };
}
