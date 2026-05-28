/**
 * Shared types for the crawler package.
 */
export {
  type DiscoveredUrl,
  type UrlConfidence,
  type PageRole,
  fromDepthProbeLink,
  fromDiscoveredLink,
} from './discovered-url.js';

export type { CrawlErrorType } from './crawl-error.js';
