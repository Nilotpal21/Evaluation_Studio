/**
 * Shared types for crawl intelligence algorithms (POC-2 through POC-5).
 *
 * CrawlResult mirrors the Go struct at:
 *   apps/crawler-go-worker/pkg/types/job.go lines 35-59
 *
 * WHY a TypeScript mirror instead of Go import:
 *   No cross-language tooling needed for POC validation.
 *   Field names match the Go JSON tags exactly.
 */

/** Extracted link from a crawled page — mirrors Go `Link` struct */
export interface CrawlResultLink {
  text: string;
  href: string;
  title?: string;
  rel?: string;
  target?: string;
}

/**
 * Result of crawling a single page — mirrors Go `CrawlResult` struct.
 *
 * This is the output from the Go HTTP crawler (colly-based).
 * POC-2 (Failure Scoring) evaluates these fields to predict
 * whether a page needs browser/LLM escalation.
 */
export interface CrawlResult {
  /** The URL that was crawled */
  url: string;
  /** HTTP status code */
  statusCode: number;
  /** Page title extracted from <title> tag */
  title: string;
  /** Raw HTML content (may be empty if omitted for size) */
  html: string;
  /** Extracted visible text content */
  text: string;
  /** Links found on the page */
  links: CrawlResultLink[];
  /** Key-value metadata extracted from the page */
  metadata: Record<string, string>;
  /** When the page was crawled (ISO 8601 string) */
  crawledAt: string;
  /** Crawl duration in milliseconds */
  duration: number;
  /** Whether the crawl succeeded */
  success: boolean;
  /** Error message if crawl failed */
  error?: string;
  /** HTTP Content-Length header value */
  contentLength: number;
  /** HTTP Content-Type header value */
  contentType: string;
  /** Crawl depth from seed URL (0 = seed) */
  depth: number;
}

/**
 * Factory function for creating test CrawlResult fixtures.
 * Provides sensible defaults — override only what you're testing.
 */
export function createCrawlResult(overrides?: Partial<CrawlResult>): CrawlResult {
  return {
    url: 'https://example.com/page',
    statusCode: 200,
    title: 'Example Page',
    html: '<html><head><title>Example Page</title></head><body><h1>Hello</h1><p>Content here</p></body></html>',
    text: 'Hello Content here',
    links: [{ text: 'Home', href: 'https://example.com/' }],
    metadata: {},
    crawledAt: new Date().toISOString(),
    duration: 150,
    success: true,
    contentLength: 500,
    contentType: 'text/html; charset=utf-8',
    depth: 0,
    ...overrides,
  };
}
