/**
 * Retry & Circuit Breaker Helpers
 *
 * Provides application-level retry with exponential backoff and jitter,
 * plus a circuit breaker for degraded mode protection.
 */

import { isRetryableError, MongoErrorCode } from '../middleware/error-handler.js';

// ─── Retry with Backoff ──────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Base delay in ms (default: 100) */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 5000) */
  maxDelayMs?: number;
  /** Add jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
  /** Custom retry predicate — defaults to isRetryableError */
  shouldRetry?: (error: unknown) => boolean;
  /** Called on each retry attempt */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Execute a function with exponential backoff retry.
 *
 * Default: 3 retries with 100ms base delay → 100ms, 200ms, 400ms (+ jitter)
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    jitter = true,
    shouldRetry = isRetryableError,
    onRetry,
  } = options ?? {};

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Exponential backoff: baseDelay * 2^attempt
      let delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);

      // Add jitter: random value between 0 and delay
      if (jitter) {
        delay = Math.floor(delay * (0.5 + Math.random() * 0.5));
      }

      onRetry?.(error, attempt + 1, delay);

      await sleep(delay);
    }
  }

  throw lastError;
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures to trip the breaker (default: 5) */
  failureThreshold?: number;
  /** Time in ms to wait before transitioning from open → half-open (default: 30000) */
  resetTimeoutMs?: number;
  /** Max attempts in half-open state before closing (default: 3) */
  halfOpenMaxAttempts?: number;
  /** Called on state transitions */
  onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;
}

export class CircuitBreaker {
  private _state: CircuitBreakerState = 'closed';
  private failureCount = 0;
  private halfOpenAttempts = 0;
  private lastFailureTime = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;
  private readonly onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.resetTimeoutMs = options?.resetTimeoutMs ?? 30_000;
    this.halfOpenMaxAttempts = options?.halfOpenMaxAttempts ?? 3;
    this.onStateChange = options?.onStateChange;
  }

  get state(): CircuitBreakerState {
    // Auto-transition from open → half-open after resetTimeout
    if (this._state === 'open' && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.transitionTo('half-open');
    }
    return this._state;
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CircuitBreakerOpenError when the breaker is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state;

    if (currentState === 'open') {
      throw new CircuitBreakerOpenError(
        `Circuit breaker is open. Retry after ${this.resetTimeoutMs}ms.`,
      );
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Reset the circuit breaker to closed state */
  reset(): void {
    this.transitionTo('closed');
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
    this.lastFailureTime = 0;
  }

  private onSuccess(): void {
    if (this._state === 'half-open') {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        this.transitionTo('closed');
        this.failureCount = 0;
        this.halfOpenAttempts = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this._state === 'half-open') {
      this.transitionTo('open');
      this.halfOpenAttempts = 0;
    } else if (this.failureCount >= this.failureThreshold) {
      this.transitionTo('open');
    }
  }

  private transitionTo(newState: CircuitBreakerState): void {
    if (this._state === newState) return;
    const from = this._state;
    this._state = newState;
    this.onStateChange?.(from, newState);
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
