import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FailureKind } from './errors.ts';
import { LocalizedError, type Phrase } from './i18n/index.ts';
import type { PendingPost } from './types.ts';
import { isRecord } from './util.ts';

/** «Файл состояния повреждён: …» на языке, которым его покажет вызывающий. */
function corrupted(detail: Phrase): LocalizedError {
  return new LocalizedError((t) => t.state.corrupted(detail(t)));
}

export const STATE_VERSION = 1;
/** Сколько последних ID поста помнить по каждому источнику. */
export const SEEN_LIMIT = 200;

export interface SourceState {
  /** Первый успешный опрос пройден. */
  bootstrapped: boolean;
  /**
   * С какого момента радар следит за источником (первая попытка опроса, даже
   * неудачная). Действует на каждом опросе: пост, вышедший раньше, — архив и
   * запоминается молча, вышедший позже уходит как новый. Сдвинутое вперёд
   * значение молча проглотит посты; без значения архива нет.
   */
  watchingSince?: number;
  /** Последние известные ID постов, новые в начале. */
  seen: string[];
  consecutiveFailures: number;
  /** Первый сбой текущей серии: по нему алерт говорит, как давно источник не читается. */
  failingSince?: number;
  lastError?: { kind: FailureKind; code?: string; message: string; at: number };
  /** Когда последний раз доставлен алерт о поломке этого источника. */
  alertedAt?: number;
  /** Алерт доставлен, а «снова отвечает» — ещё нет. */
  alertOpen?: true;
  /** Последний алерт был о частичном сбое: если источник ляжет целиком, алерт повторится сразу. */
  alertedPartial?: true;
  /** Когда запуск последний раз покраснел из-за алерта по этому источнику. */
  alertRedAt?: number;
}

export interface TelegramHealth {
  consecutiveFailures: number;
  /** Когда запуск последний раз завершился красным из-за Telegram. */
  redAt?: number;
}

export interface RadarState {
  version: typeof STATE_VERSION;
  sources: Record<string, SourceState>;
  /** Новые посты, которые ждут закрытия окна группировки. */
  pending: PendingPost[];
  telegram?: TelegramHealth;
  /**
   * GitHub выключает расписание публичного репозитория после 60 дней без
   * активности. Раз в 25 дней это поле меняется, и workflow коммитит состояние.
   */
  keepaliveAt?: number;
}

export function emptyState(): RadarState {
  return { version: STATE_VERSION, sources: {}, pending: [] };
}

/**
 * Состояние источника по id; новое начинает наблюдение с `now`. Имена свойств
 * прототипа (`constructor`, `__proto__`) вернули бы чужой объект или подменили
 * бы прототип; конфиг такие id и так отклоняет, здесь вторая линия.
 */
export function sourceStateOf(state: RadarState, id: string, now: number): SourceState {
  if (id in Object.prototype) throw new LocalizedError((t) => t.state.invalidSourceId(id));
  if (!Object.hasOwn(state.sources, id)) state.sources[id] = newSourceState(now);
  return state.sources[id] as SourceState;
}

export function newSourceState(now?: number): SourceState {
  return { bootstrapped: false, ...(now === undefined ? {} : { watchingSince: now }), seen: [], consecutiveFailures: 0 };
}

/** Добавляет ID в начало списка известных, без повторов, с ограничением длины. */
export function rememberSeen(state: SourceState, ids: readonly string[]): void {
  const merged = [...ids, ...state.seen];
  state.seen = [...new Set(merged)].slice(0, SEEN_LIMIT);
}

export function loadState(path: string): RadarState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return emptyState();
    throw err;
  }
  return parseState(text);
}

/**
 * Повреждённое состояние — ошибка, а не повод начать с нуля: молчаливый сброс
 * потерял бы очередь неотправленных постов. Проверяются все поля, от которых
 * зависит отправка и алерты: состояние могли поправить руками.
 */
export function parseState(text: string): RadarState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupted((t) => t.state.notJson);
  }
  if (!isRecord(raw) || raw.version !== STATE_VERSION) {
    throw corrupted((t) => t.state.expectedVersion(STATE_VERSION));
  }
  if (!isRecord(raw.sources) || !Array.isArray(raw.pending)) {
    throw corrupted((t) => t.state.noSourcesOrPending);
  }
  for (const [id, source] of Object.entries(raw.sources)) {
    if (
      !isRecord(source) ||
      typeof source.bootstrapped !== 'boolean' ||
      !Array.isArray(source.seen) ||
      !source.seen.every((s) => typeof s === 'string') ||
      !isCount(source.consecutiveFailures) ||
      !isOptionalTime(source.watchingSince) ||
      !isOptionalTime(source.failingSince) ||
      !isOptionalTime(source.alertedAt) ||
      !isOptionalTime(source.alertRedAt) ||
      !(source.alertOpen === undefined || source.alertOpen === true) ||
      !(source.alertedPartial === undefined || source.alertedPartial === true) ||
      !(source.lastError === undefined || isRecord(source.lastError))
    ) {
      throw corrupted((t) => t.state.source(id));
    }
  }
  for (const post of raw.pending) {
    if (
      !isRecord(post) ||
      typeof post.sourceId !== 'string' ||
      typeof post.id !== 'string' ||
      typeof post.url !== 'string' ||
      typeof post.text !== 'string' ||
      !Number.isFinite(post.publishedAt) ||
      !Number.isFinite(post.detectedAt)
    ) {
      throw corrupted((t) => t.state.pendingPost);
    }
  }
  if (
    raw.telegram !== undefined &&
    (!isRecord(raw.telegram) || !isCount(raw.telegram.consecutiveFailures) || !isOptionalTime(raw.telegram.redAt))
  ) {
    throw corrupted(() => 'telegram');
  }
  if (!isOptionalTime(raw.keepaliveAt)) throw corrupted(() => 'keepaliveAt');
  return raw as unknown as RadarState;
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOptionalTime(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

/** Запись через временный файл: прерванный запуск не оставит обрезанный JSON. */
export function saveState(path: string, state: RadarState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
