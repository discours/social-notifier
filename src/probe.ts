/**
 * Проба доступов из командной строки: `node src/probe.ts [--config путь]
 * [--send-test] [--find-chats]`. Что она делает — в src/probe-run.ts.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { readSecrets, secretValues } from './env.ts';
import { DEFAULT_LANGUAGE, describe, textsFor, type Texts } from './i18n/index.ts';
import { runProbe } from './probe-run.ts';
import type { RadarConfig } from './types.ts';
import { makeRedactor } from './util.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'radar.config.json' },
    'send-test': { type: 'boolean', default: false },
    'find-chats': { type: 'boolean', default: false },
  },
});

const secrets = readSecrets(process.env);
let t: Texts = textsFor(DEFAULT_LANGUAGE);
let redact = makeRedactor(secretValues(secrets), t.redacted);
const log = (line: string) => console.log(redact(line));

async function main(): Promise<number> {
  let config: RadarConfig | undefined;
  try {
    config = loadConfig(values.config);
    t = textsFor(config.language);
    redact = makeRedactor(secretValues(secrets), t.redacted);
  } catch (err) {
    log(t.probe.crashed(describe(err, t)));
    // Поиск чатов конфигу не нужен: ID чата узнают раньше, чем пишут конфиг.
    if (!values['find-chats']) return 1;
  }
  const code = await runProbe({
    config,
    t,
    secrets,
    fetch: globalThis.fetch,
    log,
    redact,
    now: Date.now,
    sendTest: values['send-test'] === true,
    findChats: values['find-chats'] === true,
  });
  // Без конфига сюда доходит только поиск чатов: его итог и есть код выхода.
  return code;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log(t.probe.crashed(describe(err, t)));
    process.exitCode = 1;
  },
);
