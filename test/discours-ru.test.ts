import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseConfig } from '../src/config.ts';
import { DISCOURS_CONFIG, runScenarios, type Golden } from './scenarios.ts';

const FIXTURE = new URL('./fixtures/discours-ru.json', import.meta.url);

/**
 * Эталон снят на коде до выноса текстов в каталог языков (test/scenarios.ts
 * объясняет как). Сообщения, алерты, лог и состояние «Дискурса» по-русски
 * должны остаться прежними байт в байт: расхождение здесь — изменение того,
 * что видит редакция, а не рефакторинг.
 */
describe('Дискурс по-русски: байт в байт с эталоном', () => {
  it('radar.config.json — тот же конфиг, что в сценариях', () => {
    const file = loadConfig(fileURLToPath(new URL('../radar.config.json', import.meta.url)));
    assert.deepEqual(file, parseConfig(JSON.parse(JSON.stringify(DISCOURS_CONFIG))));
  });

  it('сообщения, алерты, лог, состояние и ошибки конфига совпадают с эталоном', async () => {
    const text = readFileSync(FIXTURE, 'utf8');
    const golden = JSON.parse(text) as Golden;
    const actual = await runScenarios();
    assert.equal(actual.scenarios.length, golden.scenarios.length, 'число сценариев');
    actual.scenarios.forEach((scenario, i) => {
      assert.deepStrictEqual(scenario, golden.scenarios[i], `сценарий «${scenario.name}»`);
    });
    assert.deepStrictEqual(actual.configErrors, golden.configErrors, 'ошибки конфига');
    // Поэлементное сравнение даёт читаемый дифф, а строковое — гарантию байт в байт.
    assert.equal(`${JSON.stringify(actual, null, 2)}\n`, text);
  });
});
