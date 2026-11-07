export type FailureKind =
  | 'auth' // токен не принят
  | 'permission' // токену не хватает прав
  | 'rate_limit' // сеть ограничила частоту запросов
  | 'network' // запрос не дошёл или не дождался ответа
  | 'http' // сеть ответила ошибкой без понятного кода
  | 'bad_response' // ответ не того вида, что ждали
  | 'config'; // ошибка в настройках источника или не задан секрет

export class SourceError extends Error {
  readonly kind: FailureKind;
  readonly code: string | undefined;

  constructor(kind: FailureKind, message: string, code?: string) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
    this.code = code;
  }
}

/** Любую ошибку адаптера приводит к SourceError с очищенным от секретов текстом. */
export function toSourceError(err: unknown, redact: (text: string) => string): SourceError {
  if (err instanceof SourceError) {
    return new SourceError(err.kind, redact(err.message), err.code);
  }
  const description = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new SourceError('bad_response', redact(`непредвиденная ошибка: ${description}`));
}

export function describeError(err: unknown, redact: (text: string) => string): string {
  const description = err instanceof Error ? err.message : String(err);
  return redact(description);
}
