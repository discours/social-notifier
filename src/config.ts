import { readFileSync } from 'node:fs';
import type { RadarConfig, SourceConfig } from './types.ts';
import { isRecord } from './util.ts';

const SOURCE_ID = /^[a-z0-9_-]{1,32}$/;
// ID страниц и аккаунтов подставляются в путь запроса, поэтому только цифры.
const NUMERIC_ID = /^\d{5,25}$/;

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

  const config: RadarConfig = {
    messageTitle: text('messageTitle'),
    groupWindowMinutes: number('groupWindowMinutes', 0, 120),
    maxPostAgeHours: number('maxPostAgeHours', 1, 720),
    fetchLimit: number('fetchLimit', 1, 100),
    graphApiVersion: text('graphApiVersion'),
    vkApiVersion: text('vkApiVersion'),
    sources: [],
  };
  if (config.graphApiVersion && !/^v\d+\.\d+$/.test(config.graphApiVersion)) {
    errors.push('graphApiVersion: формат v25.0');
  }
  if (config.vkApiVersion && !/^\d+\.\d+$/.test(config.vkApiVersion)) {
    errors.push('vkApiVersion: формат 5.199');
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
  if (typeof id !== 'string' || !SOURCE_ID.test(id)) {
    errors.push(`${where}.id: латиница в нижнем регистре, цифры, «-» и «_», до 32 символов`);
    return undefined;
  }
  if (typeof label !== 'string' || label.trim() === '' || label.length > 32) {
    errors.push(`${where}.label: непустая строка до 32 символов`);
    return undefined;
  }
  switch (type) {
    case 'vk': {
      const ownerId = item.ownerId;
      if (typeof ownerId !== 'number' || !Number.isInteger(ownerId) || ownerId === 0) {
        errors.push(`${where}.ownerId: целое число, у сообщества отрицательное`);
        return undefined;
      }
      return { id, label, type, ownerId };
    }
    case 'facebook':
    case 'instagram': {
      const pageId = item.pageId;
      if (typeof pageId !== 'string' || !NUMERIC_ID.test(pageId)) {
        errors.push(`${where}.pageId: строка из цифр (ID страницы Facebook)`);
        return undefined;
      }
      return { id, label, type, pageId };
    }
    default:
      errors.push(`${where}.type: vk, facebook или instagram`);
      return undefined;
  }
}
