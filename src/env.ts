import type { Secrets } from './types.ts';

/** Секреты из переменных окружения. Пустая строка считается незаданной. */
export function readSecrets(env: NodeJS.ProcessEnv): Secrets {
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const secrets: Secrets = {};
  const pairs: [keyof Secrets, string][] = [
    ['telegramBotToken', 'TELEGRAM_BOT_TOKEN'],
    ['telegramChatId', 'TELEGRAM_CHAT_ID'],
    ['telegramAlertChatId', 'TELEGRAM_ALERT_CHAT_ID'],
    ['vkToken', 'VK_TOKEN'],
    ['metaToken', 'META_TOKEN'],
  ];
  for (const [key, name] of pairs) {
    const value = read(name);
    if (value !== undefined) secrets[key] = value;
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
