/**
 * Rate Limiter
 *
 * Token bucket algorithm for API rate limiting.
 * Configurable limits, automatic token refill, async acquisition.
 */

// ─── Rate Limiter ────────────────────────────────────────────────────────

export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private lastRefill: number; // timestamp in milliseconds

  /**
   * Create a rate limiter with token bucket algorithm.
   *
   * @param maxTokens - Maximum tokens in bucket
   * @param refillRate - Tokens added per second
   */
  constructor(maxTokens: number, refillRate: number) {
    if (maxTokens <= 0) {
      throw new Error('maxTokens must be greater than 0');
    }
    if (refillRate <= 0) {
      throw new Error('refillRate must be greater than 0');
    }

    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens; // Start with full bucket
    this.lastRefill = Date.now();
  }

  /**
   * Acquire tokens from the bucket.
   * Waits if not enough tokens are available.
   *
   * @param cost - Number of tokens to consume (default: 1)
   */
  async acquire(cost: number = 1): Promise<void> {
    if (cost <= 0) {
      throw new Error('cost must be greater than 0');
    }
    if (cost > this.maxTokens) {
      throw new Error(`cost (${cost}) exceeds maxTokens (${this.maxTokens})`);
    }

    // Refill tokens based on elapsed time
    this.refill();

    // Wait if not enough tokens
    while (this.tokens < cost) {
      // Calculate wait time
      const tokensNeeded = cost - this.tokens;
      const waitMs = (tokensNeeded / this.refillRate) * 1000;

      // Wait and refill
      await this.sleep(Math.ceil(waitMs));
      this.refill();
    }

    // Consume tokens
    this.tokens -= cost;
  }

  /**
   * Try to acquire tokens without waiting.
   *
   * @param cost - Number of tokens to consume
   * @returns true if tokens were acquired, false otherwise
   */
  tryAcquire(cost: number = 1): boolean {
    this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }

    return false;
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Get current token count.
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Get maximum token count.
   */
  getMaxTokens(): number {
    return this.maxTokens;
  }

  /**
   * Get refill rate (tokens per second).
   */
  getRefillRate(): number {
    return this.refillRate;
  }

  /**
   * Reset the rate limiter to full capacity.
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
