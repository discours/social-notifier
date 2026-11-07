export type SourceType = 'vk' | 'facebook' | 'instagram';

interface SourceBase {
  /** Уникальное имя источника: ключ в состоянии и в логах. */
  id: string;
  /** Подпись сети в сообщении Telegram. */
  label: string;
}

export interface VkSource extends SourceBase {
  type: 'vk';
  /** ID стены. У сообщества он отрицательный: -89236419. */
  ownerId: number;
}

export interface FacebookSource extends SourceBase {
  type: 'facebook';
  /** Классический ID страницы Facebook (тот, что видит Graph API). */
  pageId: string;
}

export interface InstagramSource extends SourceBase {
  type: 'instagram';
  /** ID страницы Facebook, к которой привязан профессиональный аккаунт Instagram. */
  pageId: string;
}

export type SourceConfig = VkSource | FacebookSource | InstagramSource;

export interface RadarConfig {
  /** Первая строка каждого сообщения о новых постах. */
  messageTitle: string;
  /** Окно группировки: посты, вышедшие в его пределах, уходят одним сообщением. */
  groupWindowMinutes: number;
  /** Посты старше этого порога не присылаются, даже если радар увидел их впервые. */
  maxPostAgeHours: number;
  /** Сколько последних постов запрашивать у каждой сети за один запуск. */
  fetchLimit: number;
  graphApiVersion: string;
  vkApiVersion: string;
  sources: SourceConfig[];
}

export interface Post {
  sourceId: string;
  id: string;
  url: string;
  /** Время публикации, мс с начала эпохи. */
  publishedAt: number;
  /** Текст поста или подпись; может быть пустым. */
  text: string;
}

export interface PendingPost extends Post {
  /** Когда радар впервые увидел пост, мс. */
  detectedAt: number;
}

export interface Secrets {
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramAlertChatId?: string;
  vkToken?: string;
  metaToken?: string;
}
