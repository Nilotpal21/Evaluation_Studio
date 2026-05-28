/**
 * Circuit Breaker for Guardrail Providers
 *
 * Implements the standard CLOSED -> OPEN -> HALF-OPEN state machine
 * to protect against cascading failures when guardrail providers
 * become unavailable or degrade.
 *
 * States:
 * - CLOSED: Normal operation. Requests pass through. Failures are tracked.
 * - OPEN: Too many consecutive failures. All requests fail immediately.
 *         After resetTimeoutMs, transitions to HALF-OPEN.
 * - HALF-OPEN: Allows a single test request. Success -> CLOSED, Failure -> OPEN.
 *
 * This is an in-memory implementation for the compiler package.
 * The runtime package (Phase 4) will extend this with Redis-backed state
 * for distributed circuit breaker coordination across pods.
 */

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold: number;
  /** Duration in ms to stay OPEN before transitioning to HALF-OPEN (default: 30000) */
  resetTimeoutMs: number;
  /** Maximum attempts allowed in HALF-OPEN before re-opening (default: 1) */
  halfOpenMaxAttempts?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;
const DEFAULT_HALF_OPEN_MAX_ATTEMPTS = 1;

export class CircuitBreaker {
  private _state: CircuitBreakerState = 'closed';
  private _consecutiveFailures = 0;
  private _halfOpenAttempts = 0;
  private _halfOpenFailures = 0;
  private openedAt = 0;
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      resetTimeoutMs: config?.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS,
      halfOpenMaxAttempts: config?.halfOpenMaxAttempts ?? DEFAULT_HALF_OPEN_MAX_ATTEMPTS,
    };
  }

  /** Current circuit breaker state */
  get state(): CircuitBreakerState {
    return this._state;
  }

  /** Current circuit breaker configuration (read-only) */
  get currentConfig(): Readonly<Required<CircuitBreakerConfig>> {
    return this.config;
  }

  /** Number of consecutive failures since last success or reset */
  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  /**
   * Check whether a request is allowed to proceed.
   *
   * - CLOSED: always allows execution.
   * - OPEN: blocks execution unless resetTimeoutMs has elapsed,
   *   in which case it transitions to HALF-OPEN and allows one attempt.
   * - HALF-OPEN: allows execution (test request).
   */
  canExecute(): boolean {
    if (this._state === 'closed') return true;

    if (this._state === 'open') {
      if (Date.now() - this.openedAt >= this.config.resetTimeoutMs) {
        this._state = 'half-open';
        this._halfOpenAttempts = 0;
        this._halfOpenFailures = 0;
        return true;
      }
      return false;
    }

    // half-open: allow test attempts up to halfOpenMaxAttempts
    if (this._halfOpenAttempts < this.config.halfOpenMaxAttempts) {
      this._halfOpenAttempts++;
      return true;
    }
    return false;
  }

  /**
   * Record a successful execution.
   * Resets consecutive failure count and closes the circuit.
   */
  recordSuccess(): void {
    this._consecutiveFailures = 0;
    this._halfOpenAttempts = 0;
    this._halfOpenFailures = 0;
    this._state = 'closed';
  }

  /**
   * Record a failed execution.
   * Increments consecutive failure count and may open the circuit.
   *
   * - In HALF-OPEN: immediately re-opens the circuit.
   * - In CLOSED: opens the circuit if failure threshold is reached.
   */
  recordFailure(): void {
    this._consecutiveFailures++;

    if (this._state === 'half-open') {
      this._halfOpenFailures++;
      if (this._halfOpenFailures >= this.config.halfOpenMaxAttempts) {
        this._state = 'open';
        this.openedAt = Date.now();
      }
      return;
    }

    if (this._consecutiveFailures >= this.config.failureThreshold) {
      this._state = 'open';
      this.openedAt = Date.now();
    }
  }
}
