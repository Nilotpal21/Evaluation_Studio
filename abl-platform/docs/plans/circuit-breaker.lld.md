# Circuit Breaker / Resilience — Low-Level Design

## Implementation Structure

The circuit breaker is a standalone package with 4 Lua scripts for atomic Redis operations, a `RedisCircuitBreaker` class for individual breakers, and a `CircuitBreakerRegistry` for managing hierarchical breakers. Integration with the runtime is done at the request-wrapping level.

## Key Files

| File                                                    | Purpose                                                                                                                                                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/circuit-breaker/src/types.ts`                 | Core types: `BreakerState` (CLOSED/OPEN/HALF_OPEN), `BreakerLevel` (tenant/app/llm_provider/tool_service), `CircuitBreakerConfig`, `BREAKER_DEFAULTS`, events, errors, `breakerKeys()` for Redis key layout          |
| `packages/circuit-breaker/src/redis-circuit-breaker.ts` | `RedisCircuitBreaker` class: `execute(key, fn)`, `checkState(key)`, `recordFailure(key)`, `recordSuccess(key)`, `forceReset(key, state)`, event listener management                                                  |
| `packages/circuit-breaker/src/registry.ts`              | `CircuitBreakerRegistry`: factory methods `tenant(id)`, `app(tenantId, appId)`, `llmProvider(tenantId, provider)`, `toolService(tenantId, service)`. Manages per-tenant overrides. Caches breaker instances in Maps. |
| `packages/circuit-breaker/src/scripts.ts`               | Lua script loader: `registerScripts(redis)` loads 4 scripts from disk, registers with ioredis `defineCommand`. Lazy loading with cache.                                                                              |
| `packages/circuit-breaker/src/lua/check-state.lua`      | Checks current state and handles OPEN->HALF_OPEN transition on reset timeout. Returns `{state, canExecute, retryAfterMs}`.                                                                                           |
| `packages/circuit-breaker/src/lua/record-failure.lua`   | Records failure in sorted set, checks threshold and rate. Transitions CLOSED->OPEN or HALF_OPEN->OPEN. Returns `{state, failureCount, totalCount, failureRate}`.                                                     |
| `packages/circuit-breaker/src/lua/record-success.lua`   | Records success. Transitions HALF_OPEN->CLOSED on success threshold. Returns `{state, successCount}`.                                                                                                                |
| `packages/circuit-breaker/src/lua/force-reset.lua`      | Force-resets breaker to target state (CLOSED or HALF_OPEN). Clears counters. Returns `{state, action}`.                                                                                                              |
| `packages/circuit-breaker/src/index.ts`                 | Public exports: RedisCircuitBreaker, CircuitBreakerRegistry, all types                                                                                                                                               |

### Default Configurations

| Level        | failureThreshold | successThreshold | resetTimeout | monitorWindow | halfOpenMaxConcurrent | failureRateThreshold | minimumRequestCount |
| ------------ | ---------------- | ---------------- | ------------ | ------------- | --------------------- | -------------------- | ------------------- |
| tenant       | 50               | 5                | 30,000ms     | 60,000ms      | 3                     | 50%                  | 20                  |
| app          | 20               | 3                | 15,000ms     | 30,000ms      | 2                     | 40%                  | 10                  |
| llm_provider | 10               | 2                | 60,000ms     | 30,000ms      | 1                     | 30%                  | 5                   |
| tool_service | 10               | 2                | 30,000ms     | 30,000ms      | 1                     | 40%                  | 5                   |

## Test Files

| File                                          | Scenarios                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `src/__tests__/redis-circuit-breaker.test.ts` | State transitions, atomic ops, concurrency, force reset, metrics, events |
| `src/__tests__/registry.test.ts`              | Hierarchical factory, per-tenant overrides, level isolation              |
| `src/__tests__/helpers/mock-redis.ts`         | Mock Redis simulating Lua script behavior                                |

## Known Gaps

| ID      | Gap                                        | Severity | Notes                             |
| ------- | ------------------------------------------ | -------- | --------------------------------- |
| GAP-001 | No integration test with real Redis        | Medium   | Mock Redis may miss real behavior |
| GAP-002 | No test for Redis unavailability fail-open | Medium   | Critical resilience untested      |
| GAP-003 | No metrics export (Prometheus, etc.)       | Low      | Events emitted but not exported   |
| GAP-004 | No E2E test wrapping real runtime requests | Medium   | Integration in runtime not tested |
