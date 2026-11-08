import type { Secrets, SourceSecret } from '../env.ts';
import { SourceError } from '../errors.ts';
import type { Phrase } from '../i18n/index.ts';
import type { FetchLike } from '../http.ts';
import type { ParsedPosts } from '../types.ts';

/** Поля, общие для источника любой сети. */
export interface SourceBase {
  /** Уникальное имя источника: ключ в состоянии и в логах. */
  id: string;
  /** Подпись сети в сообщении Telegram. */
  label: string;
}

/** Настройки конфига, которые нужны адаптерам. */
export interface SourceSettings {
  /** Сколько последних постов запрашивать у каждой сети за один запуск. */
  fetchLimit: number;
  graphApiVersion: string;
  vkApiVersion: string;
}

export interface SourceContext {
  config: SourceSettings;
  secrets: Secrets;
  fetch: FetchLike;
  /**
   * ID постов этого источника, которые радар уже видел. Адаптер платной сети
   * может просить только более новые; проба передаёт пустой список.
   */
  known?: readonly string[];
  /**
   * Посты, вышедшие раньше этого момента, радар не пришлёт: они старше
   * `maxPostAgeHours` или вышли до начала наблюдения за источником (архив).
   * Неразобранную запись старше него адаптер может не считать сбоем: она
   * ничего не теряет, а алерт из-за неё приходил бы вечно.
   */
  notBefore?: number;
}

/** Куда адаптер складывает ошибки разбора своих полей конфига. */
export interface ConfigIssues {
  /** Ошибка поля источника: в сообщении станет `sources[2].handle: …`. Текст — из `t.config.fields`. */
  add(field: string, message: Phrase): void;
}

/**
 * Сеть, из которой радар читает посты. Новая сеть — это файл с адаптером в
 * `src/sources/` и строка в реестре `src/sources/index.ts`; порядок шагов —
 * в docs/adding-a-source.md.
 */
export interface SourceAdapter<S extends SourceBase & { type: string }> {
  /** Значение поля `type` в конфиге. */
  readonly type: S['type'];
  /** Название сети для людей: в подсказках алертов и в документации. */
  readonly network: string;
  /** Секреты, которые читает адаптер; пустой список — сеть читается без ключа. */
  readonly secrets: readonly SourceSecret[];
  /** Страница настройки сети, путь от корня репозитория. */
  readonly docs: string;
  /** Сколько постов читает проба, если меньше `fetchLimit`: у платной сети каждый прочитанный стоит денег. */
  readonly probeLimit?: number;
  /** Поля источника из конфига, кроме общих. Ошибки — в `issues`, тогда результат undefined. */
  parse(raw: Record<string, unknown>, base: SourceBase, issues: ConfigIssues): S | undefined;
  /** Последние посты источника, не больше `ctx.config.fetchLimit`. */
  fetch(source: S, ctx: SourceContext): Promise<ParsedPosts>;
}

/** Секрет адаптера или ошибка настройки, если он не задан. */
export function requireSecret(ctx: SourceContext, name: SourceSecret): string {
  const value = ctx.secrets[name];
  if (!value) throw new SourceError('config', (t) => t.errors.secretMissing(name));
  return value;
}
