import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FailureKind } from './errors.ts';
import type { PendingPost } from './types.ts';
import { isRecord } from './util.ts';

export const STATE_VERSION = 1;
/** Сколько последних ID поста помнить по каждому источнику. */
export const SEEN_LIMIT = 200;

export interface SourceState {
  /** Первый успешный опрос пройден: текущие посты запомнены без уведомления. */
  bootstrapped: boolean;
  /** Последние известные ID постов, новые в начале. */
  seen: string[];
  consecutiveFailures: number;
  lastError?: { kind: FailureKind; code?: string; message: string; at: number };
  /** Когда последний раз ушёл алерт о поломке этого источника. */
  alertedAt?: number;
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

export function newSourceState(): SourceState {
  return { bootstrapped: false, seen: [], consecutiveFailures: 0 };
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
 * потерял бы очередь неотправленных постов.
 */
export function parseState(text: string): RadarState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('файл состояния повреждён: не JSON');
  }
  if (!isRecord(raw) || raw.version !== STATE_VERSION) {
    throw new Error(`файл состояния повреждён: ожидается version ${STATE_VERSION}`);
  }
  if (!isRecord(raw.sources) || !Array.isArray(raw.pending)) {
    throw new Error('файл состояния повреждён: нет sources или pending');
  }
  for (const [id, source] of Object.entries(raw.sources)) {
    if (!isRecord(source) || typeof source.bootstrapped !== 'boolean' || !Array.isArray(source.seen)) {
      throw new Error(`файл состояния повреждён: источник ${id}`);
    }
  }
  for (const post of raw.pending) {
    if (
      !isRecord(post) ||
      typeof post.sourceId !== 'string' ||
      typeof post.id !== 'string' ||
      typeof post.url !== 'string' ||
      typeof post.publishedAt !== 'number' ||
      typeof post.detectedAt !== 'number'
    ) {
      throw new Error('файл состояния повреждён: пост в очереди');
    }
  }
  return raw as unknown as RadarState;
}

export function saveState(path: string, state: RadarState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
