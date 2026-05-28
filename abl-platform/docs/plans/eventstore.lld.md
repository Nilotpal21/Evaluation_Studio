# EventStore Low-Level Design (LLD)

> **Status**: STABLE
> **Package**: `packages/eventstore` (`@abl/eventstore`)
> **Last Updated**: 2026-03-22
> **Feature Spec**: `docs/features/eventstore.md`
> **Test Spec**: `docs/testing/eventstore.md`
> **HLD**: `docs/specs/eventstore.hld.md`

---

## 1. Implementation Status

EventStore is a fully implemented, STABLE feature. This LLD documents the existing implementation structure and identifies remaining work needed for production hardening.

### Current State Summary

| Subsystem           | Files  | Lines (approx) | Test Coverage          | Status     |
| ------------------- | ------ | -------------- | ---------------------- | ---------- |
| Interfaces          | 6      | ~300           | N/A (types only)       | COMPLETE   |
| Schema/Registry     | 17     | ~700           | Unit tests             | COMPLETE   |
| Emitter             | 2      | ~350           | Unit tests             | COMPLETE   |
| Queues              | 5      | ~400           | Unit tests             | COMPLETE   |
| Stores (ClickHouse) | 4      | ~600           | Unit (Memory contract) | COMPLETE   |
| Query Service       | 3      | ~250           | Unit tests             | COMPLETE   |
| Retention/GDPR      | 3      | ~150           | Unit tests             | COMPLETE   |
| Webhook Forwarder   | 1      | ~180           | Unit tests             | COMPLETE   |
| Resilience (WAL)    | 3      | ~450           | Unit tests             | COMPLETE   |
| Evaluation Pipeline | 5      | ~500           | Unit tests             | COMPLETE   |
| Alerting Engine     | 5      | ~400           | Unit tests             | COMPLETE   |
| Migration Bridge    | 1      | ~80            | None                   | COMPLETE   |
| Runtime Integration | 3      | ~750           | E2E (partial)          | COMPLETE   |
| Analytics API       | 1      | ~740           | None                   | COMPLETE   |
| **Total**           | **59** | **~5,850**     | **14 test files**      | **STABLE** |

## 2. Remaining Work (Production Hardening)

### Phase 1: Security Fixes (P0)

#### 1.1 Fix Cross-Tenant Wildcard in EvaluationDispatcher

**File**: `packages/eventstore/src/evaluation/evaluation-dispatcher.ts`
**Lines**: 185-206 (`pollAndProcess` method)

**Current code** (line 192-197):

```typescript
const result = await this.config.reader.query({
  tenantId: '*', // Cross-tenant poll
  projectId: '*',
  timeRange: { from, to: now },
  eventTypes: ['session.ended'],
  limit: 50,
});
```

**Problem**: Uses `tenantId: '*'` which:

1. Against ClickHouse, matches literal `'*'` (returns 0 results -- safely broken)
2. Against MemoryEventStore, behavior depends on implementation (could leak)
3. Violates platform tenant isolation invariant

**Fix options**:

- **Option A (Recommended)**: Replace polling with event handler callback. The dispatcher should receive `session.ended` events pushed from the emitter, not poll for them. Add an `onEvent(type, handler)` method to IEventEmitter.
- **Option B**: Iterate over known tenants. Query `IEvaluationConfigProvider.getActiveTenants()` and issue per-tenant queries.
- **Option C**: Accept `tenantId: '*'` as system-level query and add explicit wildcard support to IEventReader with authorization check.

**Exit criteria**: No query issued without a concrete `tenantId` value. Existing tests still pass.

#### 1.2 Validate tenant_id is Non-Empty in EventEmitter

**File**: `packages/eventstore/src/emitter/event-emitter.ts`

**Current gap**: No validation that `tenant_id` is non-empty before enqueueing. An event with `tenant_id: ''` would be written to ClickHouse and not properly scoped.

**Fix**: Add validation in `enrichEvent()`:

```typescript
if (!event.tenant_id) {
  console.warn('EventEmitter: Missing tenant_id, dropping event');
  return; // or throw in strict mode
}
```

**Exit criteria**: Events without `tenant_id` are rejected.

### Phase 2: Code Quality (P1)

#### 2.1 Replace console.log with createLogger

**Files affected** (9 files, 58 occurrences):

- `src/resilience/event-recovery-service.ts` (10)
- `src/resilience/filesystem-wal.ts` (16)
- `src/webhook/event-webhook-forwarder.ts` (1)
- `src/emitter/resilient-event-emitter.ts` (10)
- `src/stores/clickhouse/clickhouse-event-store.ts` (1)
- `src/queues/kafka-queue.ts` (11)
- `src/emitter/event-emitter.ts` (4)
- `src/queues/direct-queue.ts` (1)
- `src/queues/bullmq-queue.ts` (4)

**Fix**: Add `import { createLogger } from '@abl/compiler/platform'` and replace all `console.X` calls with `log.X` using correct signature (`log.error('message', { context })`).

**Exit criteria**: Zero `console.log/warn/error/debug` in packages/eventstore/src. All existing tests pass.

#### 2.2 Add Size Limit to EvaluationDispatcher Evaluators Map

**File**: `packages/eventstore/src/evaluation/evaluation-dispatcher.ts`
**Line**: 53

**Current**: `private evaluators = new Map<string, IEvaluator>();` (no max size)

**Fix**: Add max size constant and reject registration beyond limit:

```typescript
private static readonly MAX_EVALUATORS = 50;

registerEvaluator(evaluator: IEvaluator): void {
  if (this.evaluators.size >= EvaluationDispatcher.MAX_EVALUATORS) {
    throw new Error(`Max evaluators (${EvaluationDispatcher.MAX_EVALUATORS}) reached`);
  }
  this.evaluators.set(evaluator.name, evaluator);
}
```

**Exit criteria**: Map size bounded. Test for rejection at limit.

### Phase 3: Testing (P1)

#### 3.1 E2E Tests Against Real ClickHouse

**Location**: `packages/eventstore/src/__tests__/e2e/`

Write E2E tests per test spec scenarios E2E-1 through E2E-7, using Docker-based ClickHouse:

1. Write-read round trip
2. Tenant isolation
3. Aggregation metrics
4. GDPR cascade delete
5. Cross-tenant wildcard behavior verification

**Exit criteria**: 5+ E2E tests passing against real ClickHouse.

#### 3.2 Integration Tests for Resilience

**Location**: `packages/eventstore/src/__tests__/integration/`

Write integration tests per test spec scenarios INT-1 through INT-8:

1. Full emit-enqueue-store pipeline
2. 3-level failover with unhealthy queue
3. Cache isolation
4. Webhook pattern matching
5. Evaluation dispatcher fan-out
6. Retention plan-based purge
7. GDPR actor anonymization
8. Alert threshold state machine

**Exit criteria**: 8 integration tests passing.

### Phase 4: Observability (P2)

#### 4.1 Wire OTEL Metrics

**Files**: emitter, queues, stores, WAL

Add OpenTelemetry observable gauges as described in INTEGRATION.md:

- `eventstore.buffer.pending` -- emitter pending count
- `eventstore.queue.pending` -- queue pending count
- `eventstore.wal.buffer_size` -- WAL in-memory buffer
- `eventstore.wal.file_size_bytes` -- current WAL file size
- `eventstore.cache.hit_rate` -- query cache hit/miss ratio

**Exit criteria**: Metrics visible in Coroot/Grafana dashboards.

#### 4.2 Add Health Check Endpoint

**Location**: `apps/runtime/src/routes/health.ts` (extend existing)

Add EventStore health to the runtime health check:

```json
{
  "eventstore": {
    "status": "healthy",
    "backend": "clickhouse",
    "pendingEvents": 42,
    "walPending": 0,
    "primaryQueueHealthy": true
  }
}
```

**Exit criteria**: Health check reflects EventStore status.

## 3. File Change Map

### Phase 1 (Security)

| File                                                              | Change                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/eventstore/src/evaluation/evaluation-dispatcher.ts`     | Remove `tenantId: '*'` polling, add event handler callback |
| `packages/eventstore/src/interfaces/event-emitter.ts`             | Add `onEvent(type, handler)` method (Option A)             |
| `packages/eventstore/src/emitter/event-emitter.ts`                | Implement `onEvent`, add tenant_id validation              |
| `packages/eventstore/src/__tests__/evaluation-dispatcher.test.ts` | Update tests for new event-driven trigger                  |

### Phase 2 (Code Quality)

| File                                                                  | Change                   |
| --------------------------------------------------------------------- | ------------------------ |
| `packages/eventstore/src/resilience/event-recovery-service.ts`        | Replace 10 console calls |
| `packages/eventstore/src/resilience/filesystem-wal.ts`                | Replace 16 console calls |
| `packages/eventstore/src/webhook/event-webhook-forwarder.ts`          | Replace 1 console call   |
| `packages/eventstore/src/emitter/resilient-event-emitter.ts`          | Replace 10 console calls |
| `packages/eventstore/src/stores/clickhouse/clickhouse-event-store.ts` | Replace 1 console call   |
| `packages/eventstore/src/queues/kafka-queue.ts`                       | Replace 11 console calls |
| `packages/eventstore/src/emitter/event-emitter.ts`                    | Replace 4 console calls  |
| `packages/eventstore/src/queues/direct-queue.ts`                      | Replace 1 console call   |
| `packages/eventstore/src/queues/bullmq-queue.ts`                      | Replace 4 console calls  |
| `packages/eventstore/src/evaluation/evaluation-dispatcher.ts`         | Add MAX_EVALUATORS limit |

### Phase 3 (Testing)

| File                                                                                   | Change |
| -------------------------------------------------------------------------------------- | ------ |
| `packages/eventstore/src/__tests__/e2e/clickhouse-write-read.e2e.test.ts`              | NEW    |
| `packages/eventstore/src/__tests__/e2e/tenant-isolation.e2e.test.ts`                   | NEW    |
| `packages/eventstore/src/__tests__/e2e/aggregation.e2e.test.ts`                        | NEW    |
| `packages/eventstore/src/__tests__/e2e/gdpr-cascade.e2e.test.ts`                       | NEW    |
| `packages/eventstore/src/__tests__/e2e/wildcard-tenant.e2e.test.ts`                    | NEW    |
| `packages/eventstore/src/__tests__/integration/emit-pipeline.integration.test.ts`      | NEW    |
| `packages/eventstore/src/__tests__/integration/resilient-failover.integration.test.ts` | NEW    |
| `packages/eventstore/src/__tests__/integration/cache-isolation.integration.test.ts`    | NEW    |
| `packages/eventstore/src/__tests__/integration/webhook-patterns.integration.test.ts`   | NEW    |
| `packages/eventstore/src/__tests__/integration/eval-dispatcher.integration.test.ts`    | NEW    |
| `packages/eventstore/src/__tests__/integration/retention.integration.test.ts`          | NEW    |
| `packages/eventstore/src/__tests__/integration/gdpr-anonymize.integration.test.ts`     | NEW    |
| `packages/eventstore/src/__tests__/integration/alert-threshold.integration.test.ts`    | NEW    |
| `apps/runtime/src/__tests__/e2e/analytics-api-e2e.test.ts`                             | NEW    |

### Phase 4 (Observability)

| File                                                   | Change                      |
| ------------------------------------------------------ | --------------------------- |
| `packages/eventstore/src/emitter/event-emitter.ts`     | Add OTEL gauge              |
| `packages/eventstore/src/queues/*.ts`                  | Add OTEL gauges             |
| `packages/eventstore/src/resilience/filesystem-wal.ts` | Add OTEL gauge              |
| `packages/eventstore/src/query/event-query-service.ts` | Add cache hit/miss counters |
| `apps/runtime/src/routes/health.ts`                    | Add eventstore health check |

## 4. Wiring Checklist

### EventStore Package -> Runtime

| Wiring Point             | File                                                      | Status |
| ------------------------ | --------------------------------------------------------- | ------ |
| Singleton initialization | `apps/runtime/src/services/eventstore-singleton.ts`       | WIRED  |
| Trace-emitter dual-write | `apps/runtime/src/services/trace-emitter.ts`              | WIRED  |
| Analytics API routes     | `apps/runtime/src/routes/analytics.ts`                    | WIRED  |
| GDPR cascade hooks       | `apps/runtime/src/services/eventstore-singleton.ts:59-63` | WIRED  |
| WAL recovery on startup  | `apps/runtime/src/services/eventstore-singleton.ts:47-56` | WIRED  |
| Server startup init      | `apps/runtime/src/server.ts`                              | WIRED  |

### EventStore Package -> Database Package

| Wiring Point                    | File                                                   | Status |
| ------------------------------- | ------------------------------------------------------ | ------ |
| BufferedClickHouseWriter import | `stores/clickhouse/clickhouse-event-store.ts:14`       | WIRED  |
| getClickHouseClient import      | `apps/runtime/src/services/eventstore-singleton.ts:28` | WIRED  |
| registerEventCascadeHook import | `apps/runtime/src/services/eventstore-singleton.ts:12` | WIRED  |

### Missing Wiring (for future phases)

| Wiring Point                     | Status          | Notes                                                       |
| -------------------------------- | --------------- | ----------------------------------------------------------- |
| OTEL metrics registration        | NOT WIRED       | Phase 4                                                     |
| Health check endpoint            | NOT WIRED       | Phase 4                                                     |
| Retention scheduler daily cron   | PARTIALLY WIRED | Config exists in INTEGRATION.md but scheduler not confirmed |
| Evaluation dispatcher activation | NOT WIRED       | Factory creates it but no runtime caller activates polling  |

## 5. Rollback Strategy

Since EventStore is already STABLE and deployed, rollback for the hardening phases:

### Phase 1 (Security): Rollback via feature flag

- Add `EVENTSTORE_EVAL_POLLING_ENABLED=false` env var
- Default to false (disables the broken polling)
- Existing event-handler-based trigger continues working

### Phase 2 (Code Quality): No rollback needed

- Logger replacement is behavior-preserving
- Map size limit only affects future registrations

### Phase 3 (Testing): No rollback needed

- Test files only, no production code changes

### Phase 4 (Observability): Rollback via OTEL config

- OTEL metrics are additive -- disable via OTEL_SDK_DISABLED=true

## 6. Dependencies and Ordering

```
Phase 1 (Security) ──┐
                      ├──> Phase 3 (Testing) ──> Phase 4 (Observability)
Phase 2 (Quality) ───┘
```

- Phase 1 and 2 can run in parallel
- Phase 3 depends on Phase 1 (tests verify the security fix)
- Phase 4 can run after Phase 2 (needs createLogger in place)

## 7. Exit Criteria Per Phase

### Phase 1: Security Fixes

- [ ] No `tenantId: '*'` anywhere in EventStore package
- [ ] `tenant_id` validated as non-empty before enqueue
- [ ] All existing 14 unit test files pass
- [ ] New test verifies wildcard rejection

### Phase 2: Code Quality

- [ ] Zero `console.log/warn/error/debug` in `packages/eventstore/src/`
- [ ] `EvaluationDispatcher.evaluators` Map bounded at 50
- [ ] All existing 14 unit test files pass
- [ ] `pnpm build --filter=@abl/eventstore` succeeds

### Phase 3: Testing

- [ ] 5+ E2E tests against real ClickHouse
- [ ] 8+ integration tests for all subsystems
- [ ] Cross-tenant isolation verified
- [ ] WAL failover recovery verified
- [ ] GDPR cascade verified

### Phase 4: Observability

- [ ] 5 OTEL gauges registered and emitting
- [ ] Health check includes EventStore status
- [ ] Metrics visible in monitoring dashboard
