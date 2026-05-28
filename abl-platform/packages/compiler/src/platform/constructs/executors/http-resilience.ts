/**
 * HTTP Resilience Utilities
 *
 * Circuit breaker and rate limiter patterns extracted from
 * ServiceNodeExecutor for reuse in IR-driven tool execution.
 */

// =============================================================================
// CIRCUIT BREAKER
// =============================================================================

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
}

export class CircuitBreaker {
  private state: CircuitBreakerState = {
    failures: 0,
    lastFailure: 0,
    state: 'closed',
  };
  private probeInProgress = false;

  constructor(
    private threshold: number,
    private resetMs: number,
  ) {}

  isOpen(): boolean {
    if (this.state.state === 'closed') {
      return false;
    }

    if (this.state.state === 'open') {
      // Check if reset time has passed
      if (Date.now() - this.state.lastFailure > this.resetMs) {
        this.state.state = 'half-open';
        this.probeInProgress = true;
        return false;
      }
      return true;
    }

    // half-open: only allow one probe request through
    if (this.probeInProgress) {
      return true;
    }
    this.probeInProgress = true;
    return false;
  }

  recordSuccess(): void {
    this.state.failures = 0;
    this.state.state = 'closed';
    this.probeInProgress = false;
  }

  recordFailure(): void {
    this.state.failures++;
    this.state.lastFailure = Date.now();
    this.probeInProgress = false;

    if (this.state.failures >= this.threshold) {
      this.state.state = 'open';
    }
  }

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state.state;
  }
}

// =============================================================================
// RATE LIMITER (Token Bucket)
// =============================================================================

interface RateLimitState {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private state: RateLimitState;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(requestsPerMinute: number) {
    if (requestsPerMinute <= 0) {
      throw new Error(`RateLimiter: requestsPerMinute must be positive, got ${requestsPerMinute}`);
    }
    this.maxTokens = requestsPerMinute;
    this.refillRate = requestsPerMinute / 60000; // Convert to per ms
    this.state = {
      tokens: this.maxTokens,
      lastRefill: Date.now(),
    };
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.state.tokens < 1) {
      // Calculate wait time for next token
      const waitMs = Math.ceil((1 - this.state.tokens) / this.refillRate);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refill();
    }

    this.state.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;

    this.state.tokens = Math.min(this.maxTokens, this.state.tokens + tokensToAdd);
    this.state.lastRefill = now;
  }
}
