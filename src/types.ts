import type { Language } from './i18n/index.ts';
import type { SourceSettings } from './sources/adapter.ts';
import type { SourceConfig } from './sources/index.ts';

export interface RadarConfig extends SourceSettings {
  /** Язык сообщений, алертов, пробы и лога; без поля в конфиге — `en`. */
  language: Language;
  /** Первая строка каждого сообщения о новых постах. */
  messageTitle: string;
  /** Окно группировки: посты, вышедшие в его пределах, уходят одним сообщением. */
  groupWindowMinutes: number;
  /** Посты старше этого порога не присылаются, даже если радар увидел их впервые. */
  maxPostAgeHours: number;
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

/** Разобранный ответ источника: посты и число элементов, которые разобрать не удалось. */
export interface ParsedPosts {
  posts: Post[];
  skipped: number;
}

export interface PendingPost extends Post {
  /** Когда радар впервые увидел пост, мс. */
  detectedAt: number;
}
