import type { FetchLike } from '../http.ts';
import type { RadarConfig, Secrets } from '../types.ts';

export interface SourceContext {
  config: RadarConfig;
  secrets: Secrets;
  fetch: FetchLike;
}
