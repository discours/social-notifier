import type { FailureKind, SourceError } from './errors.ts';
import { escapeHtml, type OutgoingMessage } from './format.ts';
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
 * ответ разобрался не целиком, и разобранные посты идут дальше.
 */
export function recordFailure(state: SourceState, err: SourceError, now: number, partial = false): boolean {
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
export function secretsOf(source: SourceConfig): string {
  return adapterFor(source).secrets.join(' и ');
}

const SECRETS_PLACE = 'в настройках репозитория (Settings → Secrets and variables → Actions)';

/** Что делать человеку: первое слово — действие, без кода ошибки. */
export function failureHint(kind: FailureKind, source: SourceConfig): string {
  const secret = secretsOf(source);
  const network = adapterFor(source).network;
  switch (kind) {
    case 'auth':
      return secret
        ? `выпустите новый токен и обновите секрет ${secret} ${SECRETS_PLACE}.`
        : `проверьте, что аккаунт открыт: ${network} перестал отдавать его посты без входа.`;
    case 'permission':
      return secret
        ? `проверьте права токена ${secret} и его доступ к аккаунту.`
        : 'проверьте, что аккаунт открыт и не заблокирован.';
    case 'billing':
      return `пополните баланс или проверьте тариф в кабинете разработчика ${network}.`;
    case 'rate_limit':
      return 'обычно ничего: сеть просит обращаться реже, и это проходит само. Если алерт повторится через сутки, сделайте опрос реже — строка cron в .github/workflows/radar.yml.';
    case 'config':
      return `проверьте источник «${source.id}» в конфиге (radar.config.json или файл из переменной RADAR_CONFIG)${secret ? ` и секрет ${secret}` : ''}.`;
    case 'network':
    case 'http':
      return 'обычно ничего: сбой на стороне сети проходит сам. Если алерт повторится через сутки, откройте лог запуска.';
    case 'bad_response':
      return 'откройте лог запуска: ответ сети не разобрался, подробности — в причине ниже. Если сеть поменяла формат ответа, коду нужна правка.';
  }
}

/** «20 мин», «3 ч», «2 дня» — сколько длится сбой. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

export interface AlertContext {
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
 */
export function formatFailureAlert(source: SourceConfig, state: SourceState, err: SourceError, ctx: AlertContext): OutgoingMessage {
  const since =
    state.failingSince === undefined
      ? `сбоев подряд: ${state.consecutiveFailures}`
      : `уже ${formatDuration(ctx.now - state.failingSince)}`;
  const range = `из последних ${ctx.fetchLimit} и не старше ${ctx.maxPostAgeHours} ч`;
  const lines = [
    `<b>${escapeHtml(source.label)}</b>: ${ctx.partial ? 'часть постов не читается' : 'посты не читаются'}, ${since}.`,
    `Что сделать: ${escapeHtml(failureHint(err.kind, source))}`,
    ctx.partial
      ? `Разобранные посты приходят как обычно. Остальные придут после починки, если окажутся ${range}.`
      : `Посты, вышедшие за это время, придут после починки — ${range}.`,
    `Причина: <code>${err.kind}</code> — ${escapeHtml(err.message)}`,
  ];
  if (ctx.runUrl) lines.push(`<a href="${escapeHtml(ctx.runUrl)}">Лог запуска</a>`);
  return { html: lines.join('\n'), disablePreview: true };
}

export function formatRecoveryNotice(source: SourceConfig): OutgoingMessage {
  return { html: `<b>${escapeHtml(source.label)}</b>: посты снова читаются.`, disablePreview: true };
}
