import { describe, LocalizedError, type Phrase, type Texts } from './i18n/index.ts';

export type FailureKind =
  | 'auth' // токен не принят
  | 'permission' // токену не хватает прав
  | 'rate_limit' // сеть ограничила частоту запросов или исчерпана квота
  | 'billing' // сеть отказала из-за оплаты: кончились кредиты, тариф не включает метод
  | 'network' // запрос не дошёл или не дождался ответа
  | 'http' // сеть ответила ошибкой без понятного кода
  | 'bad_response' // ответ не того вида, что ждали
  | 'config'; // ошибка в настройках источника или не задан секрет

/**
 * Сбой источника. Текст — фраза каталога языков (`(t) => t.errors.…`): адаптер
 * не знает языка конфига, а алерт и лог показывают текст на нём. Строка
 * вместо фразы — текст, который не переводится (ответ API как есть).
 */
export class SourceError extends LocalizedError {
  readonly kind: FailureKind;
  readonly code: string | undefined;

  constructor(kind: FailureKind, message: Phrase | string, code?: string) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
    this.code = code;
  }
}

/** Сбой в виде, который хранит состояние и показывает алерт: текст уже на языке конфига. */
export interface FailureRecord {
  kind: FailureKind;
  code?: string | undefined;
  message: string;
}

/** Любую ошибку адаптера приводит к SourceError с очищенным от секретов текстом. */
export function toSourceError(err: unknown, redact: (text: string) => string): SourceError {
  if (err instanceof SourceError) {
    return new SourceError(err.kind, (t) => redact(err.phrase(t)), err.code);
  }
  const description = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new SourceError('bad_response', (t) => redact(t.errors.unexpected(description)));
}

/** Сбой источника на языке `t` для состояния и алерта. */
export function failureRecord(err: SourceError, t: Texts): FailureRecord {
  return { kind: err.kind, code: err.code, message: err.phrase(t) };
}

export function describeError(err: unknown, t: Texts, redact: (text: string) => string): string {
  return redact(describe(err, t));
}
