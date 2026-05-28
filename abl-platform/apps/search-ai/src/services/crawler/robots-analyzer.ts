/**
 * Robots.txt Analyzer — Fetch and parse robots.txt for a given URL
 *
 * Extracts crawl-delay, disallowed paths, and sitemap URLs from robots.txt.
 * Returns a structured analysis rather than throwing on errors.
 */

// robots-parser is CJS (module.exports = function) with a declare module .d.ts.
// ESM interop wraps it in { default: fn }. Cast to resolve TS2349.
import robotsParserDefault from 'robots-parser';

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
  getPreferredHost(): string | null;
}

type RobotsParserFn = (url: string, robotstxt: string) => Robot;

const robotsParser: RobotsParserFn = robotsParserDefault as unknown as RobotsParserFn;
import { createLogger } from '@abl/compiler/platform';
import { isURLAllowed } from '../../utils/ssrf-protection.js';

const logger = createLogger('robots-analyzer');

// ─── Constants ──────────────────────────────────────────────────────

const ROBOTS_TXT_FETCH_TIMEOUT_MS = 5000;
const ROBOTS_TXT_MAX_SIZE_BYTES = 512 * 1024;
const DEFAULT_USER_AGENT = '*';

// ─── Types ──────────────────────────────────────────────────────────

export interface RobotsTxtAnalysis {
  found: boolean;
  crawlDelay: number | null;
  disallowedPaths: string[];
  sitemapUrls: string[];
  userAgent: string;
  rawContent?: string;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Fetch and analyze robots.txt for a given page URL.
 *
 * Constructs the robots.txt URL by stripping the path and appending /robots.txt.
 * Never throws — returns `{ found: false }` on 404 or fetch error.
 */
export async function analyzeRobotsTxt(url: string): Promise<RobotsTxtAnalysis> {
  const emptyResult: RobotsTxtAnalysis = {
    found: false,
    crawlDelay: null,
    disallowedPaths: [],
    sitemapUrls: [],
    userAgent: DEFAULT_USER_AGENT,
  };

  let robotsUrl: string;
  try {
    const parsed = new URL(url);
    robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
  } catch {
    logger.warn('Invalid URL for robots.txt analysis', { url });
    return emptyResult;
  }

  // SSRF defense-in-depth: validate URL before fetching
  const urlCheck = await isURLAllowed(robotsUrl);
  if (!urlCheck.allowed) {
    logger.warn('SSRF blocked: robots.txt URL targets private/reserved address', {
      url: robotsUrl,
      reason: urlCheck.reason,
    });
    return emptyResult;
  }

  let responseText: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROBOTS_TXT_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ABL-SearchAI-Crawler/1.0 (+https://kore.ai)',
        },
      });

      if (!response.ok) {
        logger.info('robots.txt not found or inaccessible', {
          url: robotsUrl,
          status: response.status,
        });
        return emptyResult;
      }

      // Read with size cap
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > ROBOTS_TXT_MAX_SIZE_BYTES) {
        // Truncate: read only first ROBOTS_TXT_MAX_SIZE_BYTES
        const reader = response.body?.getReader();
        if (!reader) return emptyResult;

        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        while (totalSize < ROBOTS_TXT_MAX_SIZE_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalSize += value.length;
        }
        reader.cancel().catch(() => {
          // Intentional: cancel is fire-and-forget after we have enough data
        });
        responseText = new TextDecoder()
          .decode(Buffer.concat(chunks))
          .substring(0, ROBOTS_TXT_MAX_SIZE_BYTES);
      } else {
        responseText = await response.text();
        // Truncate if body exceeds cap (no content-length header case)
        if (responseText.length > ROBOTS_TXT_MAX_SIZE_BYTES) {
          responseText = responseText.substring(0, ROBOTS_TXT_MAX_SIZE_BYTES);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to fetch robots.txt', { url: robotsUrl, error: message });
    return emptyResult;
  }

  // Parse robots.txt
  try {
    const robots = robotsParser(robotsUrl, responseText);

    // Extract crawl-delay
    const crawlDelay = robots.getCrawlDelay(DEFAULT_USER_AGENT) ?? null;

    // Extract disallowed paths by scanning the raw content
    const disallowedPaths: string[] = [];
    for (const line of responseText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('disallow:')) {
        const path = trimmed.substring('disallow:'.length).trim();
        if (path) {
          disallowedPaths.push(path);
        }
      }
    }

    // Extract sitemap URLs
    const sitemapUrls: string[] = robots.getSitemaps();

    return {
      found: true,
      crawlDelay: typeof crawlDelay === 'number' ? crawlDelay : null,
      disallowedPaths,
      sitemapUrls,
      userAgent: DEFAULT_USER_AGENT,
      rawContent: responseText.substring(0, 2048),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to parse robots.txt', { url: robotsUrl, error: message });
    return emptyResult;
  }
}
