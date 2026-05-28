/**
 * CrawlErrorType — classification of crawl failures.
 *
 * Used by the error classifier (crawl-error-classifier.ts) and persisted
 * in the CrawlError collection's `type` field.
 */
export type CrawlErrorType =
  | 'http_4xx'
  | 'http_5xx'
  | 'connection_error'
  | 'timeout'
  | 'robots_blocked'
  | 'quality_gated'
  | 'content_filtered'
  | 'ssrf_blocked'
  | 'crawl_error';
