/**
 * RedisCircuitBreaker
 *
 * A distributed circuit breaker backed by Redis Lua scripts for
 * atomic state transitions. Multiple platform instances share
 * breaker state through Redis.
 *
 * State machine:
 *
 *   CLOSED ──(failures >= threshold)──► OPEN
 *     ▲                                   │
 *     │                              (reset timeout)
 *     │                                   │
 *     │                                   ▼
 *     └──(successes >= threshold)── HALF_OPEN
 *                                         │
 *                                  (failure in half-open)
 *                                         │
 *                                         ▼
 *                                       OPEN
 *
 * Usage:
 *   const breaker = new RedisCircuitBreaker(redis, 'tenant', config);
 *   const result = await breaker.execute('acme-corp', () => callExternalService());
 */

import { runLuaScript, type RedisClient } from '@agent-platform/redis';
import {
  BREAKER_RECORD_FAILURE,
  BREAKER_RECORD_SUCCESS,
  BREAKER_CHECK_STATE,
  BREAKER_FORCE_RESET,
} from './scripts.js';
import {
  type BreakerLevel,
  type BreakerState,
  type CircuitBreakerConfig,
  type BreakerEvent,
  type BreakerEventListener,
  type CheckStateResult,
  type RecordFailureResult,
  type RecordSuccessResult,
  type ForceResetResult,
  CircuitOpenError,
  breakerKeys,
  BREAKER_DEFAULTS,
} from './types.js';

export class RedisCircuitBreaker {
  private readonly level: BreakerLevel;
  private readonly config: CircuitBreakerConfig;
  private readonly redis: RedisClient;
  private readonly listeners: BreakerEventListener[] = [];
  private counter = 0;

  constructor(redis: RedisClient, level: BreakerLevel, config?: Partial<CircuitBreakerConfig>) {
    this.redis = redis;
    this.level = level;
    this.config = { ...BREAKER_DEFAULTS[level], ...config };
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Execute a function with circuit breaker protection.
   *
   * If the circuit is OPEN, throws CircuitOpenError immediately.
   * If HALF_OPEN, allows limited concurrent requests through.
   * If CLOSED, executes normally and tracks success/failure.
   */
  async execute<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();

    // 1. Check if we can proceed
    const checkResult = await this.checkState(key);

    if (!checkResult.canExecute) {
      this.emitEvent({
        level: this.level,
        key,
        state: checkResult.state,
        action: 'rejected',
        timestamp: now,
      });
      throw new CircuitOpenError(this.level, key, checkResult.retryAfterMs);
    }

    // 2. Execute the function
    const startTime = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - startTime;

      // 3a. Record success
      const successResult = await this.recordSuccess(key);

      this.emitEvent({
        level: this.level,
        key,
        state: successResult.state,
        action: 'succeeded',
        duration,
        timestamp: Date.now(),
      });

      // Check for state change (HALF_OPEN → CLOSED)
      if (checkResult.state === 'HALF_OPEN' && successResult.state === 'CLOSED') {
        this.emitStateChange(key, 'HALF_OPEN', 'CLOSED');
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // 3b. Record failure
      const failResult = await this.recordFailure(key, error);

      this.emitEvent({
        level: this.level,
        key,
        state: failResult.state,
        action: 'failed',
        duration,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });

      // Check for state change (CLOSED → OPEN or HALF_OPEN → OPEN)
      if (failResult.state === 'OPEN' && checkResult.state !== 'OPEN') {
        this.emitStateChange(
          key,
          checkResult.state,
          'OPEN',
          failResult.failureCount,
          failResult.totalCount,
          failResult.failureRate,
        );
      }

      throw error;
    }
  }

  /**
   * Check the current state of a breaker without executing anything.
   */
  async checkState(key: string): Promise<CheckStateResult> {
    const keys = breakerKeys(this.level, key);
    const now = Date.now();

    const result = await runLuaScript<[string, string | number, string | number]>(
      this.redis,
      BREAKER_CHECK_STATE,
      [keys.state, keys.openedAt, keys.halfOpenCount],
      [String(now), String(this.config.resetTimeout), String(this.config.halfOpenMaxConcurrent)],
    );

    return {
      state: result[0] as BreakerState,
      canExecute: result[1] === '1' || result[1] === 1,
      retryAfterMs: Number(result[2]),
    };
  }

  /**
   * Get the current state without side effects (no OPEN → HALF_OPEN transition).
   * Use this for monitoring/dashboards.
   */
  async getState(key: string): Promise<BreakerState> {
    const keys = breakerKeys(this.level, key);
    const state = await this.redis.get(keys.state);
    return (state as BreakerState) || 'CLOSED';
  }

  /**
   * Get detailed metrics for a breaker key.
   */
  async getMetrics(key: string): Promise<{
    state: BreakerState;
    failureCount: number;
    successCount: number;
    totalCount: number;
    failureRate: number;
    openedAt: number | null;
    halfOpenCount: number;
  }> {
    const keys = breakerKeys(this.level, key);
    const windowStart = Date.now() - this.config.monitorWindow;

    const pipeline = this.redis.pipeline();
    pipeline.get(keys.state);
    pipeline.zcount(keys.failures, windowStart, '+inf');
    pipeline.zcount(keys.successes, windowStart, '+inf');
    pipeline.get(keys.openedAt);
    pipeline.get(keys.halfOpenCount);

    const results = await pipeline.exec();
    if (!results) {
      return {
        state: 'CLOSED',
        failureCount: 0,
        successCount: 0,
        totalCount: 0,
        failureRate: 0,
        openedAt: null,
        halfOpenCount: 0,
      };
    }

    const state = (results[0]?.[1] as BreakerState) || 'CLOSED';
    const failureCount = Number(results[1]?.[1] || 0);
    const successCount = Number(results[2]?.[1] || 0);
    const totalCount = failureCount + successCount;
    const openedAt = results[3]?.[1] ? Number(results[3][1]) : null;
    const halfOpenCount = Number(results[4]?.[1] || 0);

    return {
      state,
      failureCount,
      successCount,
      totalCount,
      failureRate: totalCount > 0 ? Math.floor((failureCount / totalCount) * 100) : 0,
      openedAt,
      halfOpenCount,
    };
  }

  /**
   * Force a breaker into a specific state. For ops team manual override.
   */
  async forceReset(key: string, targetState: BreakerState): Promise<ForceResetResult> {
    const keys = breakerKeys(this.level, key);
    const previousState = await this.getState(key);

    const result = await runLuaScript<[string, string]>(
      this.redis,
      BREAKER_FORCE_RESET,
      [keys.state, keys.failures, keys.successes, keys.halfOpenCount, keys.openedAt],
      [targetState, String(Date.now()), String(this.config.resetTimeout)],
    );

    const newState = result[0] as BreakerState;

    if (previousState !== newState) {
      this.emitStateChange(key, previousState, newState);
    }

    return {
      state: newState,
      action: 'forced',
    };
  }

  /**
   * Subscribe to breaker events (state changes, executions).
   */
  onEvent(listener: BreakerEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  // ── Internal ─────────────────────────────────────────────

  private async recordFailure(key: string, error: unknown): Promise<RecordFailureResult> {
    const keys = breakerKeys(this.level, key);
    const now = Date.now();
    const windowStart = now - this.config.monitorWindow;
    const errorId = this.serializeError(error);

    const result = await runLuaScript<[string, number | string, number | string, number | string]>(
      this.redis,
      BREAKER_RECORD_FAILURE,
      [keys.failures, keys.successes, keys.state, keys.openedAt, keys.halfOpenCount],
      [
        String(now),
        errorId,
        String(windowStart),
        String(this.config.failureThreshold),
        String(this.config.failureRateThreshold),
        String(this.config.minimumRequestCount),
        String(this.config.resetTimeout),
      ],
    );

    return {
      state: result[0] as BreakerState,
      failureCount: Number(result[1]),
      totalCount: Number(result[2]),
      failureRate: Number(result[3]),
    };
  }

  private async recordSuccess(key: string): Promise<RecordSuccessResult> {
    const keys = breakerKeys(this.level, key);
    const now = Date.now();
    const windowStart = now - this.config.monitorWindow;
    const nonce = String(++this.counter);

    const result = await runLuaScript<[string, number | string]>(
      this.redis,
      BREAKER_RECORD_SUCCESS,
      [keys.successes, keys.state, keys.failures, keys.halfOpenCount, keys.openedAt],
      [String(now), String(windowStart), String(this.config.successThreshold), nonce],
    );

    return {
      state: result[0] as BreakerState,
      successCount: Number(result[1]),
    };
  }

  private serializeError(error: unknown): string {
    const id = `${++this.counter}`;
    if (error instanceof Error) {
      return `${id}:${error.name}:${error.message}`.slice(0, 200);
    }
    return `${id}:${String(error)}`.slice(0, 200);
  }

  private emitEvent(event: BreakerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Never let a listener crash the breaker
      }
    }
  }

  private emitStateChange(
    key: string,
    from: BreakerState,
    to: BreakerState,
    failureCount = 0,
    totalCount = 0,
    failureRate = 0,
  ): void {
    this.emitEvent({
      level: this.level,
      key,
      from,
      to,
      failureCount,
      totalCount,
      failureRate,
      timestamp: Date.now(),
    });
  }
}
