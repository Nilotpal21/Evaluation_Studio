/**
 * Retry Handler
 *
 * Exponential backoff retry logic for transient failures.
 * Handles rate limit responses (429) and network errors.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** HTTP status codes to retry */
  retryableStatusCodes: number[];
  /** Error codes to retry (provider-specific) */
  retryableErrorCodes?: string[];
}

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: any;
}

// ─── Default Options ─────────────────────────────────────────────────────

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

// ─── Retry Handler ───────────────────────────────────────────────────────

export class RetryHandler {
  private readonly options: RetryOptions;

  constructor(options: Partial<RetryOptions> = {}) {
    this.options = { ...DEFAULT_RETRY_OPTIONS, ...options };
  }

  /**
   * Execute function with retry logic.
   *
   * @param fn - Async function to execute
   * @param onRetry - Optional callback for retry events
   * @returns Function result
   */
  async execute<T>(fn: () => Promise<T>, onRetry?: (context: RetryContext) => void): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;

        // Check if error is retryable
        if (!this.isRetryable(error)) {
          throw error;
        }

        // Don't retry on last attempt
        if (attempt === this.options.maxAttempts) {
          throw error;
        }

        // Calculate delay with exponential backoff
        const delayMs = this.calculateDelay(attempt, error);

        // Call retry callback
        if (onRetry) {
          onRetry({
            attempt,
            maxAttempts: this.options.maxAttempts,
            delayMs,
            error,
          });
        }

        // Wait before retry
        await this.sleep(delayMs);
      }
    }

    // Should never reach here, but TypeScript doesn't know that
    throw lastError;
  }

  /**
   * Check if error is retryable.
   */
  private isRetryable(error: any): boolean {
    // Check HTTP status code
    if (error.statusCode && this.options.retryableStatusCodes.includes(error.statusCode)) {
      return true;
    }
    if (error.status && this.options.retryableStatusCodes.includes(error.status)) {
      return true;
    }

    // Check error code
    if (error.code && this.options.retryableErrorCodes?.includes(error.code)) {
      return true;
    }

    // Network errors (ECONNRESET, ETIMEDOUT, etc.)
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true;
    }

    return false;
  }

  /**
   * Calculate delay with exponential backoff.
   * Respects Retry-After header for 429 responses.
   */
  private calculateDelay(attempt: number, error: any): number {
    // Check for Retry-After header (429 Too Many Requests)
    if (error.headers?.['retry-after']) {
      const retryAfter = error.headers['retry-after'];
      // Can be seconds (number) or HTTP date (string)
      if (/^\d+$/.test(retryAfter)) {
        return parseInt(retryAfter, 10) * 1000;
      } else {
        const retryDate = new Date(retryAfter);
        const now = new Date();
        return Math.max(0, retryDate.getTime() - now.getTime());
      }
    }

    // Exponential backoff
    const exponentialDelay =
      this.options.initialDelayMs * Math.pow(this.options.backoffMultiplier, attempt - 1);

    // Add jitter (±25%)
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
    const delayWithJitter = exponentialDelay + jitter;

    // Cap at max delay
    return Math.min(this.options.maxDelayMs, Math.max(0, delayWithJitter));
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
