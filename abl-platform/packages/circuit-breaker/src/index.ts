/**
 * @agent-platform/circuit-breaker
 *
 * Redis-backed hierarchical circuit breaker with Lua scripts for
 * atomic state transitions. Supports tenant, app, LLM provider,
 * and tool service isolation levels.
 *
 * @example
 * ```typescript
 * import { CircuitBreakerRegistry } from '@agent-platform/circuit-breaker';
 * import { createRedisConnection } from '@agent-platform/redis';
 *
 * const redis = createRedisConnection({ host: 'localhost', port: 6379 });
 * const registry = new CircuitBreakerRegistry(redis.client);
 *
 * // Tenant-level protection
 * await registry.tenant('acme-corp').execute(async () => {
 *   return await processRequest();
 * });
 *
 * // LLM provider protection with fallback
 * try {
 *   await registry.llmProvider('acme-corp', 'anthropic').execute(async () => {
 *     return await callClaude(messages);
 *   });
 * } catch (error) {
 *   if (error instanceof CircuitOpenError) {
 *     // Anthropic circuit open — try fallback
 *     return await callOpenAI(messages);
 *   }
 *   throw error;
 * }
 *
 * // Monitor breaker health
 * const health = await registry.getTenantHealth('acme-corp');
 * console.log(health.hasOpenCircuits);
 *
 * // Emergency force-reset
 * await registry.forceResetTenant('acme-corp', 'CLOSED');
 * ```
 */

// Core
export { RedisCircuitBreaker } from './redis-circuit-breaker.js';
export { CircuitBreakerRegistry, BreakerHandle } from './registry.js';

// Types
export {
  type BreakerState,
  type BreakerLevel,
  type CircuitBreakerConfig,
  type BreakerStateChangeEvent,
  type BreakerExecutionEvent,
  type BreakerEvent,
  type BreakerEventListener,
  type CheckStateResult,
  type RecordFailureResult,
  type RecordSuccessResult,
  type ForceResetResult,
  CircuitOpenError,
  BREAKER_DEFAULTS,
  breakerKeys,
} from './types.js';

export type { TenantHealth, TenantBreakerOverride } from './registry.js';

// Lua script constants (for advanced usage / direct EVAL via runLuaScript)
export {
  BREAKER_RECORD_FAILURE,
  BREAKER_RECORD_SUCCESS,
  BREAKER_CHECK_STATE,
  BREAKER_FORCE_RESET,
} from './scripts.js';
