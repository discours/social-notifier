import { readFileSync } from 'node:fs';
import { DEFAULT_LANGUAGE, isLanguage, LANGUAGES, LocalizedError, textsFor } from './i18n/index.ts';
import { findAdapter, SOURCE_TYPES, type SourceConfig } from './sources/index.ts';
import type { RadarConfig } from './types.ts';
import type { Texts } from './i18n/index.ts';
import { isRecord } from './util.ts';

const SOURCE_ID = /^[a-z0-9_-]{1,32}$/;
const MAX_TITLE_LENGTH = 256;
const MAX_LABEL_LENGTH = 32;
/** Версии API по умолчанию: поднимаются в коде, а в конфиге их можно не указывать. */
export const DEFAULT_GRAPH_API_VERSION = 'v25.0';
export const DEFAULT_VK_API_VERSION = '5.199';

export function loadConfig(path: string): RadarConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Язык записан в самом конфиге: непрочитанный файл описывается на языке вызывающего.
    const reason = err instanceof Error ? err.message : String(err);
    throw new LocalizedError((t) => t.config.cannotRead(path, reason));
  }
  return parseConfig(raw);
}

/**
 * Язык конфига: поле `language`, а без него или с чужим значением — язык по
 * умолчанию. Им же пишутся ошибки конфига, поэтому он разбирается первым.
 */
export function configLanguage(raw: unknown): Texts {
  const value = isRecord(raw) ? raw.language : undefined;
  return textsFor(isLanguage(value) ? value : DEFAULT_LANGUAGE);
}

export function parseConfig(raw: unknown): RadarConfig {
  const t = configLanguage(raw);
  if (!isRecord(raw)) throw new Error(t.config.notObject);
  const errors: string[] = [];

  const text = (key: string): string => {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    errors.push(t.config.nonEmptyString(key));
    return '';
  };
  const number = (key: string, min: number, max: number): number => {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return value;
    errors.push(t.config.numberRange(key, min, max));
    return min;
  };
  const version = (key: string, fallback: string, pattern: RegExp, example: string): string => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value === 'string' && pattern.test(value)) return value;
    errors.push(t.config.versionFormat(key, example, fallback));
    return fallback;
  };

  if (raw.language !== undefined && !isLanguage(raw.language)) errors.push(t.config.language(LANGUAGES));

  const config: RadarConfig = {
    language: t.language,
    messageTitle: text('messageTitle'),
    groupWindowMinutes: number('groupWindowMinutes', 0, 120),
    maxPostAgeHours: number('maxPostAgeHours', 1, 720),
    fetchLimit: number('fetchLimit', 1, 100),
    graphApiVersion: version('graphApiVersion', DEFAULT_GRAPH_API_VERSION, /^v\d+\.\d+$/, 'v25.0'),
    vkApiVersion: version('vkApiVersion', DEFAULT_VK_API_VERSION, /^\d+\.\d+$/, '5.199'),
    sources: [],
  };
  // Заголовок повторяется в каждом куске дайджеста: длинный не оставил бы места постам.
  if (config.messageTitle.length > MAX_TITLE_LENGTH) {
    errors.push(t.config.titleTooLong(MAX_TITLE_LENGTH));
  }

  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    errors.push(t.config.sourcesEmpty);
  } else {
    const ids = new Set<string>();
    raw.sources.forEach((item: unknown, index: number) => {
      const where = `sources[${index}]`;
      const source = parseSource(item, where, errors, t);
      if (!source) return;
      if (ids.has(source.id)) errors.push(t.config.duplicateId(where, source.id));
      ids.add(source.id);
      config.sources.push(source);
    });
  }

  if (errors.length > 0) throw new Error(t.config.errors(errors));
  return config;
}

function parseSource(item: unknown, where: string, errors: string[], t: Texts): SourceConfig | undefined {
  if (!isRecord(item)) {
    errors.push(t.config.sourceNotObject(where));
    return undefined;
  }
  const { id, label, type } = item;
  if (typeof id !== 'string' || !SOURCE_ID.test(id) || id in Object.prototype) {
    errors.push(t.config.sourceId(where));
    return undefined;
  }
  if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL_LENGTH) {
    errors.push(t.config.sourceLabel(where, MAX_LABEL_LENGTH));
    return undefined;
  }
  const adapter = findAdapter(type);
  if (!adapter) {
    errors.push(t.config.sourceType(where, SOURCE_TYPES));
    return undefined;
  }
  return adapter.parse(item, { id, label }, { add: (field, message) => errors.push(`${where}.${field}: ${message(t)}`) });
}
