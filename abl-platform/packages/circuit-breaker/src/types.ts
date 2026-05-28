/**
 * Circuit Breaker Types
 *
 * Defines the configuration, state, and event types for the
 * Redis-backed hierarchical circuit breaker system.
 */

import { AppError, ErrorCodes } from '@agent-platform/shared/errors';
import { hashTag } from '@agent-platform/redis';

// ── State Machine ────────────────────────────────────────────

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type BreakerLevel = 'tenant' | 'app' | 'llm_provider' | 'tool_service';

// ── Configuration ────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Absolute failure count before opening the circuit */
  failureThreshold: number;
  /** Successes needed in HALF_OPEN to close the circuit */
  successThreshold: number;
  /** Time (ms) to wait in OPEN before transitioning to HALF_OPEN */
  resetTimeout: number;
  /** Rolling window (ms) for counting failures/successes */
  monitorWindow: number;
  /** Max concurrent requests allowed through in HALF_OPEN state */
  halfOpenMaxConcurrent: number;
  /** Failure rate % threshold (alternative to absolute count) */
  failureRateThreshold: number;
  /** Minimum total requests before rate calculation applies */
  minimumRequestCount: number;
}

/** Default configs tuned per breaker level */
export const BREAKER_DEFAULTS: Record<BreakerLevel, CircuitBreakerConfig> = {
  tenant: {
    failureThreshold: 50,
    successThreshold: 5,
    resetTimeout: 30_000,
    monitorWindow: 60_000,
    halfOpenMaxConcurrent: 3,
    failureRateThreshold: 50,
    minimumRequestCount: 20,
  },
  app: {
    failureThreshold: 20,
    successThreshold: 3,
    resetTimeout: 15_000,
    monitorWindow: 30_000,
    halfOpenMaxConcurrent: 2,
    failureRateThreshold: 40,
    minimumRequestCount: 10,
  },
  llm_provider: {
    failureThreshold: 10,
    successThreshold: 2,
    resetTimeout: 60_000,
    monitorWindow: 30_000,
    halfOpenMaxConcurrent: 1,
    failureRateThreshold: 30,
    minimumRequestCount: 5,
  },
  tool_service: {
    failureThreshold: 10,
    successThreshold: 2,
    resetTimeout: 30_000,
    monitorWindow: 30_000,
    halfOpenMaxConcurrent: 1,
    failureRateThreshold: 40,
    minimumRequestCount: 5,
  },
};

// ── Events ───────────────────────────────────────────────────

export interface BreakerStateChangeEvent {
  level: BreakerLevel;
  key: string;
  from: BreakerState;
  to: BreakerState;
  failureCount: number;
  totalCount: number;
  failureRate: number;
  timestamp: number;
}

export interface BreakerExecutionEvent {
  level: BreakerLevel;
  key: string;
  state: BreakerState;
  action: 'allowed' | 'rejected' | 'succeeded' | 'failed';
  duration?: number;
  error?: string;
  timestamp: number;
}

export type BreakerEvent = BreakerStateChangeEvent | BreakerExecutionEvent;

export type BreakerEventListener = (event: BreakerEvent) => void;

// ── Errors ───────────────────────────────────────────────────

export class CircuitOpenError extends AppError {
  public readonly level: BreakerLevel;
  public readonly key: string;
  public readonly retryAfterMs: number;
  public readonly state: BreakerState;

  constructor(level: BreakerLevel, key: string, retryAfterMs: number) {
    super(`Circuit breaker OPEN [${level}:${key}] — retry after ${retryAfterMs}ms`, {
      ...ErrorCodes.CIRCUIT_OPEN,
    });
    this.level = level;
    this.key = key;
    this.retryAfterMs = retryAfterMs;
    this.state = 'OPEN';
  }
}

// ── Script Results ───────────────────────────────────────────

export interface RecordFailureResult {
  state: BreakerState;
  failureCount: number;
  totalCount: number;
  failureRate: number;
}

export interface RecordSuccessResult {
  state: BreakerState;
  successCount: number;
}

export interface CheckStateResult {
  state: BreakerState;
  canExecute: boolean;
  retryAfterMs: number;
}

export interface ForceResetResult {
  state: BreakerState;
  action: 'forced';
}

// ── Redis Key Layout ─────────────────────────────────────────

/**
 * Redis key scheme for a circuit breaker. The `{level:key}` hash tag forces
 * all five keys for a given (level, key) pair onto the same cluster slot,
 * which is required for multi-key Lua scripts. The braces are inert in
 * standalone mode — same keyspace, no behaviour change.
 *
 *   breaker:{level:key}:state            → string: CLOSED | OPEN | HALF_OPEN
 *   breaker:{level:key}:failures         → sorted set (score=timestamp)
 *   breaker:{level:key}:successes        → sorted set (score=timestamp)
 *   breaker:{level:key}:opened_at        → string: timestamp ms
 *   breaker:{level:key}:half_open_count  → string: counter
 */
export function breakerKeys(level: BreakerLevel, key: string) {
  const prefix = `breaker:${hashTag(level, key)}`;
  return {
    state: `${prefix}:state`,
    failures: `${prefix}:failures`,
    successes: `${prefix}:successes`,
    openedAt: `${prefix}:opened_at`,
    halfOpenCount: `${prefix}:half_open_count`,
  } as const;
}
