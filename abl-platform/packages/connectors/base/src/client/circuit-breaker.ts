/**
 * In-Process Circuit Breaker for Connector HTTP Clients
 *
 * A lightweight circuit breaker that protects external API calls from
 * cascading failures. Uses the standard CLOSED → OPEN → HALF_OPEN state
 * machine pattern.
 *
 * This is an in-process breaker (not Redis-backed) because individual
 * connector HTTP clients are instantiated without access to Redis. For
 * distributed circuit breaking (across pods), use the
 * `@agent-platform/circuit-breaker` package at the runtime layer.
 *
 * State machine:
 *   CLOSED ──(failures >= threshold)──► OPEN
 *     ▲                                   │
 *     │                              (resetTimeoutMs)
 *     │                                   ▼
 *     └──(halfOpen request succeeds)── HALF_OPEN
 *                                         │
 *                                  (halfOpen request fails)
 *                                         │
 *                                         ▼
 *                                       OPEN
 */

// ─── Logger ─────────────────────────────────────────────────────────────

/** Structured logger matching createLogger API shape from @abl/compiler/platform */
interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

function safeMeta(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return '[unserializable meta]';
  }
}

function createLocalLogger(module: string): Logger {
  const prefix = `[${module}]`;
  return {
    error(message: string, meta?: Record<string, unknown>) {
      console.error(prefix, message, meta ? safeMeta(meta) : '');
    },
    warn(message: string, meta?: Record<string, unknown>) {
      console.warn(prefix, message, meta ? safeMeta(meta) : '');
    },
    info(message: string, meta?: Record<string, unknown>) {
      console.info(prefix, message, meta ? safeMeta(meta) : '');
    },
    debug(message: string, meta?: Record<string, unknown>) {
      console.debug(prefix, message, meta ? safeMeta(meta) : '');
    },
  };
}

const log = createLocalLogger('connector-circuit-breaker');

// ─── Types ──────────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Name for logging — typically the connector name */
  name: string;
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms before transitioning from OPEN → HALF_OPEN (default: 60000) */
  resetTimeoutMs?: number;
  /** Max concurrent requests allowed in HALF_OPEN (default: 1) */
  halfOpenLimit?: number;
}

export class CircuitBreakerError extends Error {
  public readonly state: CircuitState;
  public readonly retryAfterMs: number;

  constructor(name: string, retryAfterMs: number) {
    super(`Circuit breaker OPEN for "${name}" — retry after ${retryAfterMs}ms`);
    this.name = 'CircuitBreakerError';
    this.state = 'OPEN';
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── Default Configuration ──────────────────────────────────────────────

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 60_000;
const DEFAULT_HALF_OPEN_LIMIT = 1;

// ─── Implementation ─────────────────────────────────────────────────────

export class ConnectorCircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private halfOpenAttempts = 0;
  private lastFailureAt = 0;

  private readonly connectorName: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenLimit: number;

  constructor(options: CircuitBreakerOptions) {
    this.connectorName = options.name;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.halfOpenLimit = options.halfOpenLimit ?? DEFAULT_HALF_OPEN_LIMIT;
  }

  /** Current circuit state (for monitoring/testing) */
  getState(): CircuitState {
    this.evaluateState();
    return this.state;
  }

  /**
   * Execute a function with circuit breaker protection.
   * Throws CircuitBreakerError if the circuit is OPEN.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.evaluateState();

    if (this.state === 'OPEN') {
      const retryAfterMs = Math.max(0, this.resetTimeoutMs - (Date.now() - this.lastFailureAt));
      throw new CircuitBreakerError(this.connectorName, retryAfterMs);
    }

    if (this.state === 'HALF_OPEN' && this.halfOpenAttempts >= this.halfOpenLimit) {
      // Already at half-open limit — reject additional requests
      const retryAfterMs = this.resetTimeoutMs;
      throw new CircuitBreakerError(this.connectorName, retryAfterMs);
    }

    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Record a successful execution */
  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      log.info('Circuit breaker closing after successful half-open probe', {
        connector: this.connectorName,
        from: 'HALF_OPEN',
        to: 'CLOSED',
      });
      this.state = 'CLOSED';
      this.consecutiveFailures = 0;
      this.halfOpenAttempts = 0;
    } else if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  /** Record a failed execution */
  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    if (this.state === 'HALF_OPEN') {
      log.warn('Circuit breaker re-opening after half-open failure', {
        connector: this.connectorName,
        from: 'HALF_OPEN',
        to: 'OPEN',
      });
      this.state = 'OPEN';
      this.halfOpenAttempts = 0;
      return;
    }

    if (this.state === 'CLOSED' && this.consecutiveFailures >= this.failureThreshold) {
      log.warn('Circuit breaker opening after failure threshold reached', {
        connector: this.connectorName,
        from: 'CLOSED',
        to: 'OPEN',
        consecutiveFailures: this.consecutiveFailures,
        failureThreshold: this.failureThreshold,
      });
      this.state = 'OPEN';
    }
  }

  /**
   * Check if we should transition OPEN → HALF_OPEN based on elapsed time.
   * Called before every execution attempt.
   */
  private evaluateState(): void {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureAt;
      if (elapsed >= this.resetTimeoutMs) {
        log.info('Circuit breaker transitioning to half-open', {
          connector: this.connectorName,
          from: 'OPEN',
          to: 'HALF_OPEN',
          elapsedMs: elapsed,
        });
        this.state = 'HALF_OPEN';
        this.halfOpenAttempts = 0;
      }
    }
  }
}
