# LLD + Implementation Plan: Model Hub Gap Closure

**Feature**: Model Hub -- LLM Management System
**Date**: 2026-03-22
**Feature Spec**: [docs/features/model-hub.md](../features/model-hub.md)
**HLD**: [docs/specs/model-hub.hld.md](../specs/model-hub.hld.md)
**Test Spec**: [docs/testing/model-hub.md](../testing/model-hub.md)

---

## 1. Design Decisions

### Decision Log

| Decision                                                              | Rationale                                                                                                                               | Alternatives Rejected                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Use existing `tenant_llm_policies` schema for enforcement             | Schema already has `allowedProviders`, `monthlyTokenBudget`, `dailyTokenBudget`, `maxRequestsPerMinute` fields -- no migration needed   | New policy collection (unnecessary schema duplication)                                            |
| Middleware-based policy enforcement (not in `ModelResolutionService`) | Separation of concerns: resolution finds the model, middleware enforces governance. Easier to feature-flag and test independently.      | Inline enforcement in resolution service (couples resolution logic to policy)                     |
| Redis pub/sub for cache invalidation (not full Redis config layer)    | Minimal change: publish events on credential/model mutation, subscribe in each pod to invalidate local cache. No dual-write complexity. | Full Redis config (too invasive), TTL-only (30min staleness unacceptable for credential rotation) |
| Background worker for health checks (not cron job)                    | BullMQ worker with repeatable jobs integrates with existing worker infrastructure. Configurable cadence per tenant.                     | External cron (operational overhead), inline on-request (adds latency to every request)           |
| Feature flags for all new enforcement features                        | Rollback safety: disable flag reverts to current behavior (tracking without blocking). Supports gradual rollout per tenant.             | No flags (risky for production), code branching (messy)                                           |

### Key Interfaces & Types

```typescript
// Policy enforcement middleware context
interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  code?: 'PROVIDER_NOT_ALLOWED' | 'BUDGET_EXCEEDED' | 'RATE_LIMIT_EXCEEDED';
  currentUsage?: { tokens: number; requests: number };
  limit?: { tokens: number; requests: number };
}

// Health check worker job data
interface HealthCheckJobData {
  tenantId: string;
  tenantModelId: string;
  connectionId: string;
  credentialId: string;
  provider: string;
  modelId: string;
}

// Health check result
interface HealthCheckResult {
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  message?: string;
  checkedAt: Date;
}

// Cache invalidation event
interface CacheInvalidationEvent {
  type: 'credential_changed' | 'model_changed' | 'connection_changed';
  tenantId: string;
  entityId: string;
  timestamp: number;
}
```

### Module Boundaries

| Module                     | Responsibility                                | Dependencies                                                                 |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `llm-policy-middleware.ts` | Enforce tenant LLM policies before resolution | `tenant_llm_policies` model, `llm_usage_metrics` model, Redis (for counters) |
| `health-check-worker.ts`   | Automated connection health checks            | BullMQ, `tenant-model-repo`, `llm_credentials`, provider factory             |
| `cache-invalidation.ts`    | Cross-pod provider cache invalidation         | Redis pub/sub, provider cache reference                                      |
| `llm-policy-routes.ts`     | Tenant LLM policy CRUD endpoints              | `tenant_llm_policies` model, auth middleware                                 |
| `llm-usage-routes.ts`      | Usage summary and budget status               | `llm_usage_metrics` model, auth middleware                                   |

---

## 2. File-Level Change Map

### New Files

| File                                                        | Purpose                                                 | LOC Estimate |
| ----------------------------------------------------------- | ------------------------------------------------------- | ------------ |
| `apps/runtime/src/middleware/llm-policy-middleware.ts`      | Tenant LLM policy enforcement middleware                | ~150         |
| `apps/runtime/src/workers/health-check-worker.ts`           | BullMQ worker for automated model health checks         | ~200         |
| `apps/runtime/src/services/llm/cache-invalidation.ts`       | Redis pub/sub for cross-pod provider cache invalidation | ~120         |
| `apps/runtime/src/routes/llm-policy.ts`                     | Tenant LLM policy CRUD routes                           | ~180         |
| `apps/runtime/src/routes/llm-usage.ts`                      | LLM usage summary and budget status routes              | ~120         |
| `apps/runtime/src/__tests__/llm-policy-enforcement.test.ts` | Policy enforcement middleware tests                     | ~300         |
| `apps/runtime/src/__tests__/health-check-worker.test.ts`    | Health check worker tests                               | ~250         |
| `apps/runtime/src/__tests__/cache-invalidation.test.ts`     | Cache invalidation pub/sub tests                        | ~200         |
| `apps/runtime/src/__tests__/llm-policy-routes.test.ts`      | Policy route authorization and CRUD tests               | ~250         |
| `apps/runtime/src/__tests__/llm-usage-routes.test.ts`       | Usage summary route tests                               | ~200         |

### Modified Files

| File                                                  | Change Description                                                     | Risk   |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| `apps/runtime/src/server.ts`                          | Register new routes (llm-policy, llm-usage) and health check worker    | Low    |
| `apps/runtime/src/routes/tenant-models.ts`            | Add health check trigger endpoint; emit cache invalidation on mutation | Low    |
| `apps/runtime/src/services/llm/model-resolution.ts`   | Emit cache invalidation events on resolution cache changes             | Low    |
| `apps/runtime/src/services/llm/session-llm-client.ts` | Subscribe to cache invalidation events; clear local provider cache     | Medium |
| `apps/runtime/src/repos/tenant-model-repo.ts`         | Add health check status update method                                  | Low    |
| `apps/runtime/src/services/execution/llm-wiring.ts`   | Wire policy middleware before LLM calls                                | Medium |
| `apps/runtime/src/config/index.ts`                    | Add feature flags for policy enforcement and health checks             | Low    |

### Deleted Files

None -- all changes are additive.

---

## 3. Implementation Phases

### Phase 1: Tenant LLM Policy Routes & Enforcement Middleware

**Goal**: Add CRUD routes for tenant LLM policies and enforcement middleware that can block disallowed providers and budget overages.

**Tasks**:

1.1. Create `apps/runtime/src/routes/llm-policy.ts` with GET/PUT `/api/tenants/:tenantId/llm-policy` routes using `tenantIsolationPlugin`-backed queries, OWNER/ADMIN auth, Zod validation, and standard error envelope.

1.2. Create `apps/runtime/src/middleware/llm-policy-middleware.ts` implementing `checkLLMPolicy(tenantId, provider, estimatedTokens)` that reads `tenant_llm_policies` and returns `PolicyCheckResult`. Feature-flagged via `ENABLE_LLM_POLICY_ENFORCEMENT` config key.

1.3. Create `apps/runtime/src/routes/llm-usage.ts` with GET `/api/tenants/:tenantId/llm-usage/summary` that aggregates `llm_usage_metrics` by tenant for the current month/day and compares against policy budgets.

1.4. Wire policy middleware into `apps/runtime/src/services/execution/llm-wiring.ts` before the `createVercelProvider()` call. If policy check returns `allowed: false`, throw `AppError` with `POLICY_VIOLATION` code.

1.5. Register new routes in `apps/runtime/src/server.ts`.

1.6. Add `ENABLE_LLM_POLICY_ENFORCEMENT` to `apps/runtime/src/config/index.ts` (default: `false`).

1.7. Write tests: `llm-policy-enforcement.test.ts` (middleware unit tests for allowed/blocked providers, budget exceeded, rate limit exceeded) and `llm-policy-routes.test.ts` (route CRUD, authz, isolation).

**Files Touched**:

- `apps/runtime/src/routes/llm-policy.ts` -- new CRUD routes
- `apps/runtime/src/middleware/llm-policy-middleware.ts` -- new enforcement middleware
- `apps/runtime/src/routes/llm-usage.ts` -- new usage summary route
- `apps/runtime/src/services/execution/llm-wiring.ts` -- wire middleware
- `apps/runtime/src/server.ts` -- register routes
- `apps/runtime/src/config/index.ts` -- add feature flag
- `apps/runtime/src/__tests__/llm-policy-enforcement.test.ts` -- new tests
- `apps/runtime/src/__tests__/llm-policy-routes.test.ts` -- new tests
- `apps/runtime/src/__tests__/llm-usage-routes.test.ts` -- new tests

**Exit Criteria**:

- [ ] `GET /api/tenants/:tenantId/llm-policy` returns the tenant's LLM policy document
- [ ] `PUT /api/tenants/:tenantId/llm-policy` creates/updates the policy with Zod validation
- [ ] Policy enforcement blocks requests with disallowed providers when `ENABLE_LLM_POLICY_ENFORCEMENT=true`
- [ ] Policy enforcement allows all requests when `ENABLE_LLM_POLICY_ENFORCEMENT=false` (default)
- [ ] `GET /api/tenants/:tenantId/llm-usage/summary` returns monthly/daily token counts and budget status
- [ ] Cross-tenant access to policy routes returns 404
- [ ] All policy tests pass: `pnpm --filter runtime test -- llm-policy`
- [ ] `pnpm build --filter=runtime` succeeds with 0 type errors

**Test Strategy**:

- Unit: Policy check logic (allowed/blocked providers, budget thresholds, rate limits)
- Integration: Policy routes with real MongoDB, authz checks, isolation
- Integration: Usage aggregation pipeline accuracy

**Rollback**: Set `ENABLE_LLM_POLICY_ENFORCEMENT=false` to disable enforcement. Routes remain but enforcement middleware becomes a pass-through.

---

### Phase 2: Cross-Pod Cache Invalidation via Redis Pub/Sub

**Goal**: Ensure credential and model changes are reflected across all runtime pods within seconds, not waiting for 30-minute TTL expiry.

**Tasks**:

2.1. Create `apps/runtime/src/services/llm/cache-invalidation.ts` with `CacheInvalidationService` that publishes `CacheInvalidationEvent` messages to a Redis pub/sub channel `model-hub:cache-invalidation`.

2.2. Subscribe to the invalidation channel in `apps/runtime/src/services/llm/session-llm-client.ts` at startup. On receiving an event, call `clearProviderCache()` for the affected provider/credential.

2.3. Emit invalidation events from `apps/runtime/src/routes/tenant-models.ts` on: model create/update/delete, connection add/update/delete, inference toggle.

2.4. Emit invalidation events from credential mutation routes (existing credential CRUD in the tenant routes).

2.5. Add graceful degradation: if Redis pub/sub is unavailable, log a warning and fall back to TTL-based expiry (current behavior).

2.6. Write tests: `cache-invalidation.test.ts` verifying event publishing, subscription, cache clearing, and graceful degradation when Redis is unavailable.

**Files Touched**:

- `apps/runtime/src/services/llm/cache-invalidation.ts` -- new pub/sub service
- `apps/runtime/src/services/llm/session-llm-client.ts` -- subscribe to events
- `apps/runtime/src/routes/tenant-models.ts` -- emit events on mutations
- `apps/runtime/src/__tests__/cache-invalidation.test.ts` -- new tests

**Exit Criteria**:

- [ ] Credential changes emit `credential_changed` events to Redis pub/sub
- [ ] Model changes emit `model_changed` events to Redis pub/sub
- [ ] Connection changes emit `connection_changed` events to Redis pub/sub
- [ ] Subscriber pods clear local provider cache within 1 second of event
- [ ] Redis pub/sub unavailability logs a warning but does not crash the service
- [ ] All cache invalidation tests pass: `pnpm --filter runtime test -- cache-invalidation`
- [ ] `pnpm build --filter=runtime` succeeds with 0 type errors

**Test Strategy**:

- Unit: Event serialization/deserialization
- Integration: Publish/subscribe round-trip with real Redis
- Integration: Cache clearing verified after event received
- Integration: Graceful degradation when Redis is down

**Rollback**: Remove pub/sub subscription. Cache falls back to TTL-based expiry (current behavior). No data loss.

---

### Phase 3: Automated Health Check Worker

**Goal**: Replace manual-only health check triggers with an automated BullMQ worker that periodically validates model connections.

**Tasks**:

3.1. Create `apps/runtime/src/workers/health-check-worker.ts` implementing a BullMQ worker that:

- Queries all tenant models with active connections
- For each connection, makes a lightweight test call to the provider (list models or simple completion)
- Updates `healthStatus`, `healthMessage`, and `lastHealthCheck` on the connection subdocument
- Uses a repeatable job with configurable cadence (default: every 4 hours)

  3.2. Add a health check trigger route at `POST /api/tenants/:tenantId/models/:id/health-check` that enqueues an immediate health check job for a specific model.

  3.3. Add method `updateConnectionHealthStatus(tenantId, modelId, connectionId, status, message)` to `apps/runtime/src/repos/tenant-model-repo.ts`.

  3.4. Add `HEALTH_CHECK_INTERVAL_HOURS` and `ENABLE_HEALTH_CHECKS` config keys to `apps/runtime/src/config/index.ts`.

  3.5. Register the worker in the runtime startup sequence (feature-flagged via `ENABLE_HEALTH_CHECKS`).

  3.6. Write tests: `health-check-worker.test.ts` verifying job processing, status updates, error handling, and rate limiting of health check calls.

**Files Touched**:

- `apps/runtime/src/workers/health-check-worker.ts` -- new worker
- `apps/runtime/src/routes/tenant-models.ts` -- add health check trigger endpoint
- `apps/runtime/src/repos/tenant-model-repo.ts` -- add health status update method
- `apps/runtime/src/config/index.ts` -- add config keys
- `apps/runtime/src/server.ts` -- register worker
- `apps/runtime/src/__tests__/health-check-worker.test.ts` -- new tests

**Exit Criteria**:

- [ ] Health check worker processes jobs and updates connection `healthStatus` to `healthy` or `unhealthy`
- [ ] `POST /api/tenants/:tenantId/models/:id/health-check` enqueues an immediate health check job
- [ ] Worker uses repeatable jobs with configurable interval (default 4 hours)
- [ ] Worker handles provider errors gracefully (marks connection `unhealthy` with error message)
- [ ] Worker respects `ENABLE_HEALTH_CHECKS` feature flag
- [ ] Cross-tenant health check trigger returns 404
- [ ] All health check tests pass: `pnpm --filter runtime test -- health-check`
- [ ] `pnpm build --filter=runtime` succeeds with 0 type errors

**Test Strategy**:

- Unit: Health check job processing logic
- Integration: Worker with real BullMQ queue, status updates in MongoDB
- Integration: Health check trigger route with authz

**Rollback**: Set `ENABLE_HEALTH_CHECKS=false`. Worker stops processing. Manual health checks via admin UI continue to work.

---

### Phase 4: E2E Test Coverage for Gap Scenarios

**Goal**: Implement the E2E test scenarios defined in the test spec that exercise real HTTP API flows without mocking codebase components.

**Tasks**:

4.1. Implement E2E-1 (Full Model Provisioning to Execution Journey): Create tenant model, add connection, set project overrides, set agent overrides, verify resolution chain behavior through the API.

4.2. Implement E2E-2 (Cross-Tenant Model Isolation): Two-tenant setup verifying all cross-tenant operations return 404.

4.3. Implement E2E-4 (Project Operation-Tier Override Layering): Multiple models at different tiers, verify operation type maps to correct tier.

4.4. Implement E2E-5 (Agent Model Override with Full Parameter Control): Agent-level overrides with temperature, maxTokens, hyperParameters, streaming settings.

4.5. Implement E2E-7 (Credential Lifecycle and Cache Invalidation): Connection credential rotation with cache invalidation verification.

**Files Touched**:

- `apps/runtime/src/__tests__/e2e/model-hub-provisioning.e2e.test.ts` -- new E2E test file
- `apps/runtime/src/__tests__/e2e/model-hub-isolation.e2e.test.ts` -- new E2E test file
- `apps/runtime/src/__tests__/e2e/model-hub-overrides.e2e.test.ts` -- new E2E test file

**Exit Criteria**:

- [ ] E2E-1 test passes: provisioning -> override -> execution journey verified through HTTP API
- [ ] E2E-2 test passes: all cross-tenant operations return 404
- [ ] E2E-4 test passes: operation-tier mapping resolves correct model per operation type
- [ ] E2E-5 test passes: agent override parameters are used in resolution
- [ ] All E2E tests start real Express server with full middleware chain (no `vi.mock`)
- [ ] All E2E tests interact only via HTTP API (no direct DB access)
- [ ] `pnpm --filter runtime test -- model-hub` passes all new E2E tests
- [ ] `pnpm build --filter=runtime` succeeds with 0 type errors

**Test Strategy**:

- E2E: Real Express server on random port, full middleware chain, HTTP API only
- No mocking of codebase components
- Auth context seeded via test utilities

**Rollback**: Tests are additive -- removing them has no runtime impact.

---

## 4. Wiring Checklist

- [x] `budget-enforcement.ts` created with `checkAndRecordBudget()` / `recordActualUsage()` — enforcement in `ModelResolutionService.resolve()` (not middleware; see deviations)
- [x] LLM usage routes already existed (3 routes: platform-admin-usage, tenant-usage, chat) — no new `llm-usage.ts` needed
- [x] `model-cache-invalidation.ts` extended with `ModelInvalidationTransport` pub/sub + HMAC signing, initialized in `server.ts`
- [x] `tenant-models.ts` emits cache invalidation events on all mutations including PATCH (bug fixed)
- [x] `model-health-service.ts` created with `startModelHealthJob()` / `stopModelHealthJob()` using `setInterval` (not BullMQ; see deviations)
- [x] Health check trigger route in `tenant-models.ts` refactored to use extracted service
- [x] Feature flags added to `config/index.ts`: `enableLlmBudgetEnforcement`, `enableHealthChecks`, `healthCheckIntervalHours`
- [x] `provider-cache.ts` extracted from `session-llm-client.ts` for zero-mock testability
- [x] All new test files pass with `pnpm --filter runtime test`

---

## 5. Cross-Phase Concerns

### Database Migrations

No schema migrations required. All new functionality uses existing collections and fields:

- Policy enforcement reads `tenant_llm_policies` (existing)
- Health checks update `healthStatus`/`lastHealthCheck` on `tenant_models.connections` (existing fields)
- Usage summary aggregates `llm_usage_metrics` (existing)
- Cache invalidation is purely in-memory + Redis

### Feature Flags

| Flag                            | Default | Phase | Purpose                            |
| ------------------------------- | ------- | ----- | ---------------------------------- |
| `ENABLE_LLM_POLICY_ENFORCEMENT` | `false` | 1     | Gate policy enforcement middleware |
| `ENABLE_HEALTH_CHECKS`          | `false` | 3     | Gate health check worker startup   |
| `HEALTH_CHECK_INTERVAL_HOURS`   | `4`     | 3     | Configurable health check cadence  |

### Configuration Changes

| Config Key                      | Phase | Type    | Default |
| ------------------------------- | ----- | ------- | ------- |
| `ENABLE_LLM_POLICY_ENFORCEMENT` | 1     | boolean | false   |
| `ENABLE_HEALTH_CHECKS`          | 3     | boolean | false   |
| `HEALTH_CHECK_INTERVAL_HOURS`   | 3     | number  | 4       |

No new environment variables required beyond the feature flags above.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] FR-7 (Tenant LLM policy enforcement) tested with real middleware
- [ ] GAP-005 (real-time policy enforcement) closed
- [ ] GAP-007 (health check automation) closed
- [ ] GAP-011 (cross-pod cache invalidation) closed
- [ ] 5+ new E2E tests passing without mocking codebase components
- [ ] 5+ new integration tests passing
- [ ] No regressions in existing 18 model hub test files
- [ ] Feature spec updated with new implementation details
- [ ] Testing matrix updated with actual coverage
- [ ] `pnpm build --filter=runtime` succeeds with 0 type errors
- [ ] `pnpm --filter runtime test` passes all tests

---

## 7. Open Questions

1. Should policy enforcement provide a "warn" mode (log but don't block) before "enforce" mode, or is the feature flag sufficient?
2. What lightweight test call should health checks make? `GET /models` (least intrusive) or a minimal completion call with 1 token (most accurate)?
3. Should Redis pub/sub failures trigger an alert, or is the warning log sufficient?
4. Should the usage summary route support custom date ranges, or just current month/day?
5. Should E2E tests use a real LLM provider for the execution step, or mock only the final HTTP call to the provider while testing the full resolution chain?

---

## 8. Post-Implementation Notes (2026-03-27)

### Deviations from Plan

| Area               | Plan                                          | Actual                                                                   | Reason                                                                                       |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Health checks      | BullMQ repeatable worker                      | `setInterval` in `model-health-service.ts`                               | All other periodic jobs in the codebase use `setInterval` — consistency over complexity      |
| Policy enforcement | Middleware-based (`llm-policy-middleware.ts`) | Inline in `ModelResolutionService.resolve()` via `budget-enforcement.ts` | Provider allowlist was already enforced inline at line ~716; budget checks belong next to it |
| LLM usage routes   | New `llm-usage.ts` route file                 | Dropped — 3 usage routes already existed                                 | `platform-admin-usage.ts`, `tenant-usage.ts`, `chat.ts` with ClickHouse materialized views   |
| Provider cache     | In `session-llm-client.ts`                    | Extracted to `provider-cache.ts`                                         | Zero-mock testability — broke transitive dep chain to `@agent-platform/database`             |
| E2E test location  | `__tests__/e2e/` subdirectory                 | `__tests__/` (top-level)                                                 | Matches existing E2E test pattern in the codebase                                            |
| Feature flag names | `ENABLE_LLM_POLICY_ENFORCEMENT`               | `FEATURE_ENABLE_LLM_BUDGET_ENFORCEMENT`                                  | More specific — budget enforcement is one aspect of policy                                   |

### Completion Status

- **Phase 1 (Policy Enforcement)**: DONE — budget enforcement + provider allowlist
- **Phase 2 (Cache Invalidation)**: DONE — Redis pub/sub + HMAC + PATCH bug fix
- **Phase 3 (Health Checks)**: DONE — extracted service + setInterval job
- **Phase 4 (E2E Tests)**: DONE — 3 suites (17 tests), all passing with real servers
- **Additional**: Provider cache extraction for zero-mock testability, platform-mock-lint hook
