/**
 * Runtime robots.txt enforcement for bulk crawl worker.
 * Caches per-domain robots.txt parsing results.
 * Uses robots-parser npm package (NOT cross-package import from search-ai).
 */
import robotsParser from 'robots-parser';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('robots-checker');

export interface RobotsCheckerConfig {
  cacheTtlMs: number; // default 3_600_000 (1 hour)
  maxCacheSize: number; // default 100
  userAgent: string; // default 'ABLBot/1.0'
}

interface CacheEntry {
  parser: ReturnType<typeof robotsParser>;
  expiresAt: number;
  crawlDelay: number | null;
}

const DEFAULT_CONFIG: RobotsCheckerConfig = {
  cacheTtlMs: 3_600_000,
  maxCacheSize: 100,
  userAgent: 'ABLBot/1.0',
};

export class RobotsChecker {
  private cache: Map<string, CacheEntry>;
  private readonly config: RobotsCheckerConfig;

  constructor(config?: Partial<RobotsCheckerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new Map();
  }

  /**
   * Check if a URL is allowed by robots.txt. Fetches and caches per domain.
   * Never throws — returns true (allow) on any error (permissive default).
   */
  async isAllowed(url: string): Promise<boolean> {
    try {
      const entry = await this.getOrFetch(url);
      if (!entry) return true; // Fetch failed → allow
      return entry.parser.isAllowed(url, this.config.userAgent) !== false;
    } catch {
      return true; // Permissive default
    }
  }

  /**
   * Get the crawl-delay for a domain from robots.txt.
   * Returns null if not specified.
   */
  async getCrawlDelay(url: string): Promise<number | null> {
    try {
      const entry = await this.getOrFetch(url);
      return entry?.crawlDelay ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Preload robots.txt for a domain. Called at job start.
   */
  async preload(domain: string): Promise<void> {
    const robotsUrl = `https://${domain}/robots.txt`;
    await this.fetchAndCache(domain, robotsUrl);
  }

  getStats(): { cacheSize: number; maxSize: number } {
    return { cacheSize: this.cache.size, maxSize: this.config.maxCacheSize };
  }

  private async getOrFetch(url: string): Promise<CacheEntry | null> {
    const domain = new URL(url).hostname;
    const cached = this.cache.get(domain);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    const robotsUrl = `${new URL(url).protocol}//${domain}/robots.txt`;
    return this.fetchAndCache(domain, robotsUrl);
  }

  private async fetchAndCache(domain: string, robotsUrl: string): Promise<CacheEntry | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(robotsUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        // No robots.txt or error → allow everything
        const emptyEntry: CacheEntry = {
          parser: robotsParser(robotsUrl, ''),
          expiresAt: Date.now() + this.config.cacheTtlMs,
          crawlDelay: null,
        };
        this.setCacheEntry(domain, emptyEntry);
        return emptyEntry;
      }

      const text = await response.text();
      const parser = robotsParser(robotsUrl, text);
      const rawDelay = parser.getCrawlDelay(this.config.userAgent);

      const entry: CacheEntry = {
        parser,
        expiresAt: Date.now() + this.config.cacheTtlMs,
        crawlDelay: rawDelay != null ? rawDelay * 1000 : null, // Convert seconds to ms
      };
      this.setCacheEntry(domain, entry);
      return entry;
    } catch (err) {
      log.warn('Failed to fetch robots.txt', {
        domain,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private setCacheEntry(domain: string, entry: CacheEntry): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.config.maxCacheSize && !this.cache.has(domain)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(domain, entry);
  }
}
