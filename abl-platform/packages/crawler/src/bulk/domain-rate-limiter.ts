/**
 * Per-domain token bucket rate limiter for bulk crawl worker.
 * Enforces minimum delay between requests to a single domain.
 * In-memory MVP (single worker process). Redis version deferred.
 */

export class DomainRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private delayMs: number;
  private readonly maxTokens: number;

  constructor(delayMs: number, maxTokens = 1) {
    this.delayMs = delayMs;
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Wait until a token is available. Enforces minimum delay between requests.
   * If robots.txt crawl-delay is higher, uses that instead (max wins).
   */
  async acquire(robotsCrawlDelay?: number | null): Promise<void> {
    const effectiveDelay = Math.max(this.delayMs, robotsCrawlDelay ?? 0);
    if (effectiveDelay <= 0) return;

    // Refill tokens based on elapsed time
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / effectiveDelay);
    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill = now;
    }

    // If no tokens available, wait
    if (this.tokens <= 0) {
      const waitTime = effectiveDelay - (now - this.lastRefill);
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      this.tokens = this.maxTokens;
      this.lastRefill = Date.now();
    }

    this.tokens--;
  }

  /**
   * Update the base delay (e.g., after reading robots.txt crawl-delay).
   */
  setDelay(delayMs: number): void {
    this.delayMs = delayMs;
  }
}
