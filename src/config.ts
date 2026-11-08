import { readFileSync } from 'node:fs';
import { findAdapter, SOURCE_TYPES, type SourceConfig } from './sources/index.ts';
import type { RadarConfig } from './types.ts';
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
    throw new Error(`не удалось прочитать ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfig(raw);
}

export function parseConfig(raw: unknown): RadarConfig {
  if (!isRecord(raw)) throw new Error('конфиг: ожидается объект');
  const errors: string[] = [];

  const text = (key: string): string => {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    errors.push(`${key}: нужна непустая строка`);
    return '';
  };
  const number = (key: string, min: number, max: number): number => {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return value;
    errors.push(`${key}: нужно число от ${min} до ${max}`);
    return min;
  };
  const version = (key: string, fallback: string, pattern: RegExp, example: string): string => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value === 'string' && pattern.test(value)) return value;
    errors.push(`${key}: формат ${example}; можно не указывать, тогда ${fallback}`);
    return fallback;
  };

  const config: RadarConfig = {
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
    errors.push(`messageTitle: не длиннее ${MAX_TITLE_LENGTH} символов`);
  }

  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    errors.push('sources: нужен непустой список');
  } else {
    const ids = new Set<string>();
    raw.sources.forEach((item: unknown, index: number) => {
      const source = parseSource(item, `sources[${index}]`, errors);
      if (!source) return;
      if (ids.has(source.id)) errors.push(`sources[${index}].id: «${source.id}» повторяется`);
      ids.add(source.id);
      config.sources.push(source);
    });
  }

  if (errors.length > 0) throw new Error(`ошибки в конфиге:\n- ${errors.join('\n- ')}`);
  return config;
}

function parseSource(item: unknown, where: string, errors: string[]): SourceConfig | undefined {
  if (!isRecord(item)) {
    errors.push(`${where}: ожидается объект`);
    return undefined;
  }
  const { id, label, type } = item;
  if (typeof id !== 'string' || !SOURCE_ID.test(id) || id in Object.prototype) {
    errors.push(`${where}.id: латиница в нижнем регистре, цифры, «-» и «_», до 32 символов; не служебное имя вроде constructor`);
    return undefined;
  }
  if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL_LENGTH) {
    errors.push(`${where}.label: непустая строка до ${MAX_LABEL_LENGTH} символов`);
    return undefined;
  }
  const adapter = findAdapter(type);
  if (!adapter) {
    errors.push(`${where}.type: одна из сетей — ${SOURCE_TYPES.join(', ')}`);
    return undefined;
  }
  return adapter.parse(item, { id, label }, { add: (field, message) => errors.push(`${where}.${field}: ${message}`) });
}
