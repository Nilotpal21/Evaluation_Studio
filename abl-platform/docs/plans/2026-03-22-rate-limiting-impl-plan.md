# LLD + Implementation Plan: Rate Limiting

**Feature Spec**: [docs/features/rate-limiting.md](../features/rate-limiting.md)
**HLD**: [docs/specs/rate-limiting.hld.md](../specs/rate-limiting.hld.md)
**Test Spec**: [docs/testing/rate-limiting.md](../testing/rate-limiting.md)
**Date**: 2026-03-22

---

## 1. Design Decisions

### Decision Log

| Decision                                       | Rationale                                                                                                        | Alternatives Rejected                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Keep purpose-built limiters per surface        | Each surface has fundamentally different traffic patterns (sliding window, fixed window, token bucket, counters) | Unified rate-limit package (forces same algorithm on all surfaces)    |
| Add Redis-backed E2E tests before code changes | Proves existing correctness before modifying anything; highest-value improvement                                 | Skip tests and add features first (risky without correctness proof)   |
| Add eval rate limiter unit tests               | Eval limiter is the only surface without dedicated test coverage                                                 | Trust incidental coverage from higher-level eval tests (insufficient) |
| Use Docker Redis for integration tests         | Matches CI infrastructure already used by other packages; portable                                               | Testcontainers (adds dependency), mock Redis (defeats purpose)        |
| Add budget inspection API in later phase       | Test coverage gaps are more urgent than operator dashboards                                                      | Build dashboards first (less impact on correctness)                   |

### Key Interfaces & Types

All types below already exist in the codebase. No new interfaces are needed for the test-focused phases.

```typescript
// apps/runtime/src/middleware/rate-limiter.ts (existing)
export interface TenantRateLimitConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
  concurrentSessions: number;
  toolCallsPerMinute: number;
}

export type RateLimitOperation =
  | 'request'
  | 'llm_tokens'
  | 'session'
  | 'tool_call'
  | 'session_message';

// apps/runtime/src/services/resilience/hybrid-rate-limiter.ts (existing)
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

// packages/pipeline-engine/src/pipeline/services/eval/eval-rate-limiter.ts (existing)
export interface TenantEvalLimits {
  maxConcurrentRuns: number;
  maxConcurrentConversations: number;
  maxLLMCallsPerMinute: number;
}

// packages/agent-transfer/src/security/rate-limiter.ts (existing)
export interface RateLimitConfig {
  maxTransfers: number;
  windowMs: number;
}
```

### Module Boundaries

| Module                          | Responsibility                                                 | Dependencies                                        |
| ------------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| Runtime rate-limiter middleware | Plan resolution, per-key/per-tenant enforcement, 429 responses | HybridRateLimiter, TenantConfigService              |
| HybridRateLimiter               | Redis-primary + memory fallback orchestration                  | RedisRateLimiter, InMemoryRateLimiter, Redis client |
| RedisRateLimiter                | Lua sorted-set sliding window                                  | Redis client (ioredis)                              |
| InMemoryRateLimiter             | Bounded in-memory sliding window                               | None                                                |
| SearchAI rate-limit middleware  | Fixed-window Redis + memory fallback                           | ioredis (lazy-loaded)                               |
| Studio rate-limit helpers       | Redis sliding window + in-memory fallback                      | Redis client (optional)                             |
| Connector RateLimiter           | Token-bucket algorithm                                         | None                                                |
| Eval rate limiter               | Tier-based in-memory counters                                  | None                                                |
| Agent-transfer rate limiter     | Redis sorted-set with conditional ZADD                         | Redis client (ioredis)                              |

---

## 2. File-Level Change Map

### New Files

| File                                                                           | Purpose                                                            | LOC Estimate |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------ |
| `apps/runtime/src/__tests__/e2e/rate-limiter-redis.test.ts`                    | Runtime Redis-backed E2E tests (E2E-1, E2E-2, E2E-5, E2E-6, E2E-7) | ~300         |
| `apps/runtime/src/__tests__/integration/redis-sliding-window.test.ts`          | Redis Lua sliding-window atomicity tests (INT-1)                   | ~150         |
| `apps/runtime/src/__tests__/integration/session-slot-redis.test.ts`            | Session slot claim/release with real Redis (INT-4)                 | ~120         |
| `apps/runtime/src/__tests__/integration/hybrid-fallback.test.ts`               | HybridRateLimiter fallback transition tests (INT-3)                | ~150         |
| `apps/search-ai/src/__tests__/e2e/rate-limit-redis.test.ts`                    | SearchAI Redis-backed E2E tests (E2E-4)                            | ~150         |
| `apps/search-ai/src/__tests__/integration/fixed-window-redis.test.ts`          | SearchAI Lua fixed-window atomicity tests (INT-2)                  | ~120         |
| `packages/pipeline-engine/src/__tests__/eval-rate-limiter.test.ts`             | Eval rate limiter unit tests (INT-5)                               | ~200         |
| `packages/agent-transfer/src/__tests__/integration/rate-limiter-redis.test.ts` | Agent-transfer Redis integration tests (INT-7)                     | ~120         |

### Modified Files

| File                                          | Change Description                                       | Risk |
| --------------------------------------------- | -------------------------------------------------------- | ---- |
| `docs/features/rate-limiting.md`              | Update §17 testing table with new test results           | Low  |
| `docs/testing/rate-limiting.md`               | Update coverage matrix status and test file mapping      | Low  |
| `apps/runtime/src/middleware/rate-limiter.ts` | No code changes in Phase 1; potential cleanup in Phase 3 | Low  |
| `apps/search-ai/src/middleware/rate-limit.ts` | No code changes in Phase 1; potential cleanup in Phase 3 | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Runtime Redis-Backed Integration Tests

**Goal**: Prove the Runtime Redis Lua sliding-window path is correct under real Redis, including concurrent requests and session slot management.

**Tasks**:

1.1. Create `apps/runtime/src/__tests__/integration/redis-sliding-window.test.ts`:

- Start a real Redis instance (Docker or CI-provided).
- Instantiate `RedisRateLimiter` with the real Redis client.
- Test: 20 concurrent `check()` calls for limit=10 — exactly 10 allowed.
- Test: Window expiry resets counter.
- Test: EVALSHA caching works (first call uses EVAL, subsequent use EVALSHA).
- Test: `peek()` returns correct count without incrementing.

  1.2. Create `apps/runtime/src/__tests__/integration/session-slot-redis.test.ts`:

- Test: `claimSessionSlot()` enforces limit via Lua atomic check-and-add.
- Test: `releaseSessionSlot()` correctly decrements.
- Test: Attempting to claim beyond limit returns -1.
- Test: Session SET has correct SCARD after claim/release sequences.
- Test: SET TTL is applied correctly.

  1.3. Create `apps/runtime/src/__tests__/integration/hybrid-fallback.test.ts`:

- Test: `HybridRateLimiter` uses Redis when available.
- Test: Falls back to memory when Redis connection fails.
- Test: `isUsingRedis()` reflects current state accurately.
- Test: Recovery timer restores Redis usage after reconnection.

**Files Touched**:

- `apps/runtime/src/__tests__/integration/redis-sliding-window.test.ts` — new
- `apps/runtime/src/__tests__/integration/session-slot-redis.test.ts` — new
- `apps/runtime/src/__tests__/integration/hybrid-fallback.test.ts` — new

**Exit Criteria**:

- [ ] `redis-sliding-window.test.ts` passes with 0 failures when Redis is available
- [ ] 20 concurrent requests with limit=10 result in exactly 10 allowed (proven atomicity)
- [ ] `session-slot-redis.test.ts` passes with correct SCARD values after claim/release
- [ ] `hybrid-fallback.test.ts` passes with verified fallback and recovery transitions
- [ ] `pnpm build --filter=apps/runtime` succeeds with 0 errors

**Test Strategy**:

- Integration: Real Redis instance via Docker. Tests skip gracefully if Redis is unavailable.
- No mocking of Redis in these tests (that would defeat the purpose).

**Rollback**: Delete the new test files. No production code is changed.

---

### Phase 2: SearchAI and Agent-Transfer Redis Integration Tests

**Goal**: Prove the SearchAI fixed-window Lua path and agent-transfer conditional ZADD path with real Redis.

**Tasks**:

2.1. Create `apps/search-ai/src/__tests__/integration/fixed-window-redis.test.ts`:

- Start a real Redis instance.
- Call `redisCheck()` directly with a real Redis client.
- Test: Counter increments correctly up to limit.
- Test: Counter resets after window expiry (PEXPIRE).
- Test: Orphaned key self-healing (manually remove PTTL, verify Lua script re-applies PEXPIRE).
- Test: Different tenant keys are isolated.

  2.2. Create `apps/search-ai/src/__tests__/e2e/rate-limit-redis.test.ts`:

- Start SearchAI Express server on random port with real Redis.
- Test: 3 requests allowed (limit=3), 4th returns 429.
- Test: Response includes `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.
- Test: Different tenants have independent counters.
- Test: IP fallback works when no tenant context is present.

  2.3. Create `packages/agent-transfer/src/__tests__/integration/rate-limiter-redis.test.ts`:

- Test: `checkRateLimit()` with real Redis enforces limit correctly.
- Test: Conditional ZADD does not add entries when limit is exceeded (verify ZCARD stays at limit).
- Test: Window expiry allows new requests.

**Files Touched**:

- `apps/search-ai/src/__tests__/integration/fixed-window-redis.test.ts` — new
- `apps/search-ai/src/__tests__/e2e/rate-limit-redis.test.ts` — new
- `packages/agent-transfer/src/__tests__/integration/rate-limiter-redis.test.ts` — new

**Exit Criteria**:

- [ ] `fixed-window-redis.test.ts` passes with correct counter behavior and window expiry
- [ ] `rate-limit-redis.test.ts` E2E passes with real SearchAI server returning 429 and headers
- [ ] `rate-limiter-redis.test.ts` passes with ZCARD verification proving conditional ZADD
- [ ] `pnpm build --filter=apps/search-ai` succeeds with 0 errors
- [ ] `pnpm build --filter=packages/agent-transfer` succeeds with 0 errors

**Test Strategy**:

- Integration: Real Redis via Docker.
- E2E: Real SearchAI Express server on random port (`{ port: 0 }`). Full middleware chain.
- No mocking of codebase components.

**Rollback**: Delete the new test files.

---

### Phase 3: Eval Rate Limiter Tests and Coverage Completion

**Goal**: Add dedicated tests for the eval rate limiter and update documentation to reflect new coverage.

**Tasks**:

3.1. Create `packages/pipeline-engine/src/__tests__/eval-rate-limiter.test.ts`:

- Test: `acquireRunSlot()` enforces `maxConcurrentRuns` per tier (free=1, team=2, business=3, enterprise=5).
- Test: `releaseRunSlot()` frees slot correctly.
- Test: `acquireConversationSlot()` enforces `maxConcurrentConversations`.
- Test: `releaseConversationSlot()` frees slot correctly.
- Test: `checkLLMRateLimit()` enforces `maxLLMCallsPerMinute` with sliding window.
- Test: LLM window resets after 60 seconds.
- Test: `getTenantEvalUsage()` returns accurate current counters.
- Test: `shutdownEvalRateLimiter()` clears all state.
- Test: Tenant eviction when `MAX_TENANT_ENTRIES` (1000) is exceeded.
- Test: Cleanup timer removes idle tenants after 2 minutes.

  3.2. Update `docs/testing/rate-limiting.md`:

- Update coverage matrix status for each FR.
- Add new test files to test file mapping.
- Update "What the Current Coverage Actually Proves" section.

  3.3. Update `docs/features/rate-limiting.md` §17:

- Add rows for new integration/E2E tests.
- Update status from NOT TESTED to PASS for covered scenarios.

**Files Touched**:

- `packages/pipeline-engine/src/__tests__/eval-rate-limiter.test.ts` — new
- `docs/testing/rate-limiting.md` — update coverage matrix
- `docs/features/rate-limiting.md` — update §17

**Exit Criteria**:

- [ ] `eval-rate-limiter.test.ts` passes with all tier-based limits verified
- [ ] Tier limits: free(1,3,10), team(2,10,30), business(3,20,60), enterprise(5,50,120) verified
- [ ] `getTenantEvalUsage()` returns matching counters for each test scenario
- [ ] `pnpm build --filter=packages/pipeline-engine` succeeds with 0 errors
- [ ] Coverage matrix in `docs/testing/rate-limiting.md` reflects all new test files

**Test Strategy**:

- Unit: In-memory only (eval limiter has no Redis dependency). Pure function testing.
- No external dependencies needed.

**Rollback**: Delete the new test file. Revert doc changes.

---

## 4. Wiring Checklist

Since this plan focuses on adding tests (not new production features), the wiring checklist is simplified:

- [ ] New test files are in `__tests__/` directories matching the source file locations
- [ ] Integration test files use real Redis (skip gracefully if unavailable for CI without Docker)
- [ ] E2E test files start real servers on random ports with full middleware chain
- [ ] Test files import from the production source paths (no copy-pasted implementations)
- [ ] No `vi.mock()` or `jest.mock()` for codebase components in E2E tests
- [ ] Test files are TypeScript and included in the package's `tsconfig.json`
- [ ] Package `vitest.config.ts` or `jest.config.ts` includes the new test directories
- [ ] CI configuration supports Docker Redis for integration tests (or tests skip gracefully)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. All rate-limit state is ephemeral (Redis with TTL or in-memory).

### Feature Flags

None. Tests do not require feature flags.

### Configuration Changes

New environment variables may be needed for test infrastructure:

| Variable           | Default                  | Purpose                                         |
| ------------------ | ------------------------ | ----------------------------------------------- |
| `REDIS_TEST_URL`   | `redis://localhost:6379` | Redis URL for integration tests                 |
| `SKIP_REDIS_TESTS` | `false`                  | Skip Redis-dependent tests in CI without Docker |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 3 phases complete with exit criteria met
- [ ] Runtime Redis Lua sliding-window atomicity proven with 20 concurrent requests
- [ ] SearchAI Redis Lua fixed-window behavior proven with real Redis
- [ ] Agent-transfer conditional ZADD proven with real Redis (ZCARD verification)
- [ ] Eval rate limiter all 4 tiers verified with dedicated tests
- [ ] Session slot claim/release atomicity proven with real Redis
- [ ] HybridRateLimiter fallback/recovery transitions proven
- [ ] No regressions in existing rate-limiter tests (all 12 existing test files still pass)
- [ ] Feature spec §17 updated with actual coverage
- [ ] Testing matrix updated with new test files and status
- [ ] Coverage matrix shows integration/E2E coverage for FR-1 through FR-8

---

## 7. Open Questions

1. Should Redis integration tests use a shared Docker Compose Redis or spin up per-test instances? (Recommendation: shared Docker Compose for speed, test isolation via key prefixes.)

2. Should the E2E tests in Phase 1/2 be run in CI by default, or only when `SKIP_REDIS_TESTS !== true`? (Recommendation: skip by default in CI until Docker Redis is reliably available, with explicit opt-in via env var.)

3. Should we add a `vitest.workspace.ts` configuration for integration tests that require Docker? (Recommendation: separate vitest config file, e.g., `vitest.integration.config.ts`, to keep unit tests fast.)

4. What is the minimum Redis version requirement for the Lua scripts? (The scripts use ZREMRANGEBYSCORE, ZADD, ZCARD, ZRANGE, EXPIRE, PEXPIRE, INCR, PTTL — all available since Redis 2.6. EVALSHA since 2.6.)
