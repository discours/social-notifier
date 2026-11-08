import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { readSecrets, runUrlFromEnv, secretValues } from './env.ts';
import { DEFAULT_LANGUAGE, describe, textsFor, type Texts } from './i18n/index.ts';
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
// До чтения конфига язык неизвестен: сбой чтения пишется языком по умолчанию.
let t: Texts = textsFor(DEFAULT_LANGUAGE);
let redact = makeRedactor(secretValues(secrets), t.redacted);
const log = (line: string) => console.log(redact(line));
const dryRun = values['dry-run'] === true || process.env.RADAR_DRY_RUN === '1';

async function main(): Promise<number> {
  const config = loadConfig(values.config);
  t = textsFor(config.language);
  redact = makeRedactor(secretValues(secrets), t.redacted);
  if (!dryRun && (!secrets.TELEGRAM_BOT_TOKEN || !secrets.TELEGRAM_CHAT_ID)) {
    log(t.log.nothingToSendTo);
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
  log(t.log.summary(result.postsSent, result.alertsSent, result.exitCode));
  return result.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log(t.log.runFailed(describe(err, t)));
    process.exitCode = 1;
  },
);
