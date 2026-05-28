/**
 * Lightweight in-memory circuit breaker for git provider operations.
 *
 * Tracks consecutive failures per GitSyncService instance. After
 * `failureThreshold` consecutive failures the circuit opens for
 * `resetTimeoutMs`, rejecting immediately. After the timeout one
 * probe request is allowed through (half-open). On probe success
 * the circuit closes; on failure it re-opens.
 *
 * This is intentionally simpler than the Redis-backed circuit breaker
 * in `@agent-platform/circuit-breaker` — git sync is per-request and
 * does not need distributed state.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { CircuitOpenError } from '@agent-platform/circuit-breaker';

const log = createLogger('git-circuit-breaker');

export type GitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface GitCircuitBreakerConfig {
  /** Consecutive failures before opening the circuit */
  failureThreshold: number;
  /** Time (ms) to stay OPEN before allowing a probe */
  resetTimeoutMs: number;
}

const DEFAULT_CONFIG: GitCircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
};

export class GitCircuitBreakerError extends CircuitOpenError {
  constructor(retryAfterMs: number) {
    super('tool_service', 'git', retryAfterMs);
    this.name = 'GitCircuitBreakerError';
  }
}

export class GitCircuitBreaker {
  private state: GitBreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenProbeInProgress = false;
  private readonly config: GitCircuitBreakerConfig;

  constructor(config?: Partial<GitCircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute `fn` through the circuit breaker.
   * Throws `GitCircuitBreakerError` if the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.config.resetTimeoutMs) {
        if (this.halfOpenProbeInProgress) {
          const retryAfter = this.config.resetTimeoutMs;
          log.warn('Circuit breaker HALF_OPEN probe already in progress — rejecting request', {
            retryAfterMs: retryAfter,
          });
          throw new GitCircuitBreakerError(retryAfter);
        }
        // Transition to half-open — allow one probe
        this.state = 'HALF_OPEN';
        this.halfOpenProbeInProgress = true;
        log.info('Circuit breaker transitioning to HALF_OPEN');
      } else {
        const retryAfter = this.config.resetTimeoutMs - elapsed;
        log.warn('Circuit breaker OPEN — rejecting request', { retryAfterMs: retryAfter });
        throw new GitCircuitBreakerError(retryAfter);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      this.halfOpenProbeInProgress = false;
    }
  }

  /** Current breaker state (for testing / monitoring). */
  getState(): GitBreakerState {
    return this.state;
  }

  /** Current consecutive failure count (for testing / monitoring). */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      log.info('Circuit breaker probe succeeded — closing circuit');
    }
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      log.warn('Circuit breaker OPEN', {
        consecutiveFailures: this.consecutiveFailures,
        resetTimeoutMs: this.config.resetTimeoutMs,
      });
    }
  }
}
