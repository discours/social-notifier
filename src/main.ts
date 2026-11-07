import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { readSecrets, runUrlFromEnv, secretValues } from './env.ts';
import { runRadar } from './radar.ts';
import { loadState, saveState } from './state.ts';
import { makeRedactor } from './util.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'radar.config.json' },
    state: { type: 'string', default: 'state/state.json' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const secrets = readSecrets(process.env);
const redact = makeRedactor(secretValues(secrets));
const log = (line: string) => console.log(redact(line));
const dryRun = values['dry-run'] === true || process.env.RADAR_DRY_RUN === '1';

async function main(): Promise<number> {
  const config = loadConfig(values.config);
  if (!dryRun && (!secrets.telegramBotToken || !secrets.telegramChatId)) {
    log('не заданы секреты TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID: отправлять некуда');
    return 1;
  }
  const state = loadState(values.state);
  const result = await runRadar(state, {
    config,
    secrets,
    fetch: globalThis.fetch,
    now: Date.now,
    log,
    redact,
    runUrl: runUrlFromEnv(process.env),
    dryRun,
  });
  if (!dryRun) saveState(values.state, state);
  log(`итог: постов отправлено ${result.postsSent}, алертов ${result.alertsSent}, код ${result.exitCode}`);
  return result.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log(`сбой запуска: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
