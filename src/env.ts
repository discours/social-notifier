/** Секреты Telegram: куда отправлять посты и алерты. */
export const TELEGRAM_SECRETS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_ALERT_CHAT_ID'] as const;

/**
 * Секреты сетей. Новый секрет добавляется сюда, в `secrets` адаптера и в `env`
 * шагов обоих workflow (radar.yml, probe.yml); тест проверяет, что ни одно из
 * трёх мест не забыто.
 */
export const SOURCE_SECRETS = ['VK_TOKEN', 'META_TOKEN', 'YOUTUBE_API_KEY', 'X_BEARER_TOKEN'] as const;

export type TelegramSecret = (typeof TELEGRAM_SECRETS)[number];
export type SourceSecret = (typeof SOURCE_SECRETS)[number];
export type SecretName = TelegramSecret | SourceSecret;

/** Секреты по имени переменной окружения; незаданного нет в объекте. */
export type Secrets = Partial<Record<SecretName, string>>;

export const ALL_SECRETS: readonly SecretName[] = [...TELEGRAM_SECRETS, ...SOURCE_SECRETS];

/** Секреты из переменных окружения. Пустая строка считается незаданной. */
export function readSecrets(env: NodeJS.ProcessEnv): Secrets {
  const secrets: Secrets = {};
  for (const name of ALL_SECRETS) {
    const value = env[name]?.trim();
    if (value) secrets[name] = value;
  }
  return secrets;
}

/** Значения, которые надо вычищать из логов. ID чатов тоже: в публичном логе им не место. */
export function secretValues(secrets: Secrets): string[] {
  return Object.values(secrets).filter((v): v is string => typeof v === 'string');
}

/** Ссылка на лог текущего запуска GitHub Actions, если радар работает там. */
export function runUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}
