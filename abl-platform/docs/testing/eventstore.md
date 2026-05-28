# EventStore Test Spec

> **Status**: STABLE
> **Package**: `packages/eventstore` (`@abl/eventstore`)
> **Last Updated**: 2026-03-22
> **Feature Spec**: `docs/features/eventstore.md`

---

## 1. Test Coverage Matrix

### Existing Unit Tests (14 files, all passing)

| Test File                        | Component                  | Key Scenarios                                             | Status |
| -------------------------------- | -------------------------- | --------------------------------------------------------- | ------ |
| `factory.test.ts`                | `createEventStore()`       | embedded/remote/service modes, validation, error handling | PASS   |
| `event-emitter.test.ts`          | `EventEmitter`             | validation, enrichment, batch, strict mode, unknown types | PASS   |
| `event-registry.test.ts`         | `EventRegistry`            | register, validate, PII detection, duplicate rejection    | PASS   |
| `event-categories.test.ts`       | `getCategoryFromEventType` | all 15 categories, edge cases                             | PASS   |
| `store-contract.test.ts`         | `MemoryEventStore`         | write, query, aggregate, count, lifecycle ops             | PASS   |
| `queue-contract.test.ts`         | All queue types            | enqueue, process, flush, health check, close              | PASS   |
| `query-service.test.ts`          | `EventQueryService`        | caching, tenant-isolated keys, convenience methods        | PASS   |
| `webhook-forwarder.test.ts`      | `EventWebhookForwarder`    | pattern matching, cache eviction, delivery                | PASS   |
| `evaluation-dispatcher.test.ts`  | `EvaluationDispatcher`     | sampling, fan-out, stats, config lookup                   | PASS   |
| `evaluation-code-scorer.test.ts` | `CodeScorer`               | deterministic metrics, edge cases                         | PASS   |
| `evaluation-llm-judge.test.ts`   | `LLMJudgeEvaluator`        | structured scoring, error handling                        | PASS   |
| `alerting-scheduler.test.ts`     | `AlertScheduler`           | rule eval, cooldown, notification, concurrency            | PASS   |
| `alerting-threshold.test.ts`     | Threshold functions        | all operators, state transitions, shouldNotify            | PASS   |
| `retention-gdpr.test.ts`         | Retention + GDPR           | purge, scrub PII, cascade delete, anonymize               | PASS   |

### Coverage Gaps Identified

| Gap ID | Area                                                   | Description                                                            | Priority |
| ------ | ------------------------------------------------------ | ---------------------------------------------------------------------- | -------- |
| G-1    | E2E: ClickHouse write path                             | No test writes events to real ClickHouse and reads them back           | P0       |
| G-2    | E2E: Analytics API                                     | No HTTP-level test of `/api/projects/:projectId/analytics/*` endpoints | P0       |
| G-3    | Integration: trace-emitter dual-write                  | No test verifying trace events arrive in EventStore                    | P1       |
| G-4    | Integration: WAL recovery                              | No test simulating queue failure -> WAL -> recovery                    | P1       |
| G-5    | Integration: GDPR cascade                              | No test of session deletion cascading through EventStore               | P1       |
| G-6    | Security: cross-tenant isolation                       | No test verifying tenant A cannot see tenant B events                  | P0       |
| G-7    | Security: SQL injection in sql-query endpoint          | No test with malicious SQL payloads                                    | P1       |
| G-8    | Integration: webhook forwarding                        | No test with real BullMQ delivery                                      | P2       |
| G-9    | Security: cross-tenant wildcard (EvaluationDispatcher) | No test for `tenantId: '*'` behavior                                   | P0       |
| G-10   | Performance: high-throughput write                     | No load test for sustained event write                                 | P2       |

## 2. E2E Test Scenarios (Minimum 5)

All E2E tests interact ONLY via HTTP API. No mocks of codebase components. No direct DB access.

### E2E-1: Event Write-Read Round Trip via Analytics API

**Goal**: Verify events emitted during a session appear in analytics query results.

**Setup**: Start real runtime server on random port with ClickHouse backend.

**Steps**:

1. Create a session via `POST /api/projects/:projectId/sessions`
2. Send a user message via WebSocket to trigger trace events (session.started, llm.call.completed, etc.)
3. Wait for BufferedWriter flush (5s or explicit flush)
4. `GET /api/projects/:projectId/analytics/events?category=session` -- verify session.started appears
5. `GET /api/projects/:projectId/analytics/events?category=llm` -- verify llm.call.completed appears
6. Verify each event has correct `tenant_id`, `project_id`, `session_id`
7. Verify event `data` field contains expected payload structure

**Exit Criteria**: At least 2 event categories returned with correct tenant/project scoping.

### E2E-2: Tenant Isolation in Analytics Queries

**Goal**: Verify tenant A cannot see tenant B's events.

**Setup**: Two authenticated users from different tenants.

**Steps**:

1. Emit events with tenant_id='tenant-A' and tenant_id='tenant-B'
2. Query analytics as tenant A: `GET /api/projects/:projectId/analytics/events`
3. Verify ALL returned events have `tenant_id='tenant-A'`
4. Query as tenant B: verify ALL returned events have `tenant_id='tenant-B'`
5. Attempt cross-tenant query (if applicable) -- verify 404 or empty result, NOT 403

**Exit Criteria**: Zero events from other tenant visible. No existence leakage.

### E2E-3: Aggregation Metrics API

**Goal**: Verify aggregation endpoints return correct computed metrics.

**Steps**:

1. Emit a known set of events: 10 session.started, 8 session.ended (2 with errors), 20 llm.call.completed
2. `GET /api/projects/:projectId/analytics/metrics?groupBy=category&metrics=count,error_rate`
3. Verify session count=18 (started+ended), error_rate for sessions matches 2/18
4. `GET /api/projects/:projectId/analytics/session-metrics` -- verify totalSessions=10, completedSessions=8
5. `GET /api/projects/:projectId/analytics/cost-breakdown` -- verify model/provider breakdown

**Exit Criteria**: All computed metrics match expected values from emitted events.

### E2E-4: SQL Query Endpoint Security

**Goal**: Verify the developer SQL query endpoint enforces security constraints.

**Steps**:

1. `POST /api/projects/:projectId/analytics/sql-query` with valid SELECT -- verify success
2. POST with `DELETE FROM ...` -- verify 400 rejection
3. POST with `SELECT * FROM other_database.table` -- verify 400 rejection
4. POST without `tenant_id` filter -- verify 400 rejection
5. POST with SQL injection attempt in WHERE clause -- verify error or safe parameterization
6. POST without auth -- verify 401

**Exit Criteria**: All security constraints enforced. No mutation or cross-table access possible.

### E2E-5: GDPR Session Cascade Delete

**Goal**: Verify deleting a session cascades to event deletion.

**Steps**:

1. Create a session and emit trace events via API
2. Verify events exist via analytics API query
3. Delete the session via platform API (triggers GDPR cascade)
4. Re-query analytics for the deleted session's events
5. Verify zero events returned for that session_id

**Exit Criteria**: All events for deleted session removed from ClickHouse.

### E2E-6: Event Count and Category Filtering

**Goal**: Verify event-counts endpoint returns correct breakdown by category.

**Steps**:

1. Emit events across multiple categories (session, llm, tool, agent)
2. `GET /api/projects/:projectId/analytics/event-counts`
3. Verify counts match emitted event distribution
4. `GET /api/projects/:projectId/analytics/events?category=llm&hasError=true`
5. Verify only LLM error events returned

**Exit Criteria**: Category filtering and error filtering work correctly.

### E2E-7: Ad-Hoc Query and Aggregate POST Endpoints

**Goal**: Verify POST-based query endpoints accept full filter options.

**Steps**:

1. `POST /api/projects/:projectId/analytics/query` with `{ timeRange, category: 'llm', limit: 5 }`
2. Verify response has `events` array with max 5 items, `total`, `hasMore`
3. `POST /api/projects/:projectId/analytics/aggregate` with `{ groupBy: ['event_type'], metrics: ['count', 'avg_duration'] }`
4. Verify response has `buckets` with grouped results

**Exit Criteria**: POST endpoints return correctly structured responses.

## 3. Integration Test Scenarios (Minimum 5)

Integration tests test real service boundaries. Only external third-party services may be mocked.

### INT-1: EventEmitter -> Queue -> MemoryEventStore Write Path

**Goal**: Verify the full emit -> enqueue -> store.write pipeline.

**Setup**: `createEventStore({ mode: 'embedded', backend: 'memory' })`

**Steps**:

1. Emit a `session.started` event with all required fields
2. Flush the queue
3. Query the store for the emitted event
4. Verify event_id was auto-generated (ULID format)
5. Verify category was auto-inferred from event_type
6. Verify timestamp was set

**Exit Criteria**: Event persisted with all auto-enrichment fields.

### INT-2: Resilient Emitter 3-Level Failover

**Goal**: Verify the failover cascade works when primary queue is unhealthy.

**Setup**: Create ResilientEventEmitter with a mock primary queue that reports `isHealthy() = false`.

**Steps**:

1. Emit an event -- verify it goes to Level 2 (fallback queue -> store)
2. Make both queues throw -- verify event goes to Level 3 (WAL)
3. Verify WAL file contains the event (replay and check)
4. Restore primary health -- verify next emit goes to Level 1
5. Run WAL recovery -- verify event written to store

**Exit Criteria**: All 3 failover levels activated, events not lost.

### INT-3: EventQueryService Cache Behavior

**Goal**: Verify query results are cached with tenant-isolated keys.

**Setup**: EventQueryService with in-memory cache provider.

**Steps**:

1. Query events for tenant-A -- verify cache miss (store queried)
2. Query same params again -- verify cache hit (store NOT queried)
3. Query for tenant-B with same params -- verify cache miss (different key)
4. Wait for TTL expiry -- verify next query is a cache miss
5. Verify cache key format: `eventstore:{tenantId}:{operation}:{hash}`

**Exit Criteria**: Cache correctly isolates per tenant, respects TTL.

### INT-4: EventWebhookForwarder Pattern Matching

**Goal**: Verify webhook forwarding correctly matches event patterns.

**Setup**: Create forwarder with mock delivery queue and subscription provider.

**Steps**:

1. Register subscription with pattern `events.session.*`
2. Forward `session.started` event -- verify delivery enqueued
3. Forward `session.ended` event -- verify delivery enqueued
4. Forward `llm.call.completed` event -- verify NOT enqueued (pattern mismatch)
5. Register subscription with exact match `events.llm.call.completed`
6. Forward `llm.call.completed` -- verify delivery enqueued
7. Verify subscription cache works (second call uses cache, not provider)

**Exit Criteria**: Wildcard and exact patterns matched correctly. Cache functional.

### INT-5: EvaluationDispatcher Session Processing

**Goal**: Verify the evaluation pipeline processes session.ended events correctly.

**Setup**: Create dispatcher with mock config provider, conversation provider, and evaluators.

**Steps**:

1. Configure project with 2 evaluators (code_scorer + llm_judge)
2. Set global sampling to rate=1.0 (run all)
3. Call `processSessionEnded()` with a session.ended event
4. Verify both evaluators called with correct EvaluationInput
5. Verify `evaluation.started` and `evaluation.completed` events emitted
6. Verify stats: evaluationsStarted=2, evaluationsCompleted=2
7. Set sampling rate=0 -- verify evaluationsSkipped increments

**Exit Criteria**: Full dispatch cycle with sampling, fan-out, and result emission.

### INT-6: Retention Service Plan-Based Purge

**Goal**: Verify retention service correctly calculates cutoff dates and delegates.

**Setup**: EventRetentionService with MemoryEventStore.

**Steps**:

1. Write events with timestamps spread across 7, 30, 90, 365 days ago
2. Run retention with FREE plan (totalRetentionDays=30, piiRetentionDays=7)
3. Verify events >30 days deleted
4. Verify PII events >7 days scrubbed (data replaced with `{"anonymized":true}`)
5. Verify events <7 days untouched

**Exit Criteria**: Correct purge and scrub based on plan policy.

### INT-7: GDPR Service Actor Anonymization

**Goal**: Verify actor anonymization replaces actor_id across all events.

**Setup**: MemoryEventStore with events from multiple actors.

**Steps**:

1. Write 10 events with actor_id='user-123' and 5 with actor_id='user-456'
2. Call `gdpr.anonymizeActor('tenant-1', 'user-123')`
3. Query all events for tenant-1
4. Verify all events previously with 'user-123' now have `[ANONYMIZED:user-123]`
5. Verify 'user-456' events untouched

**Exit Criteria**: Only targeted actor anonymized, others preserved.

### INT-8: Alerting Threshold Evaluation

**Goal**: Verify alert rules correctly fire and resolve.

**Setup**: AlertScheduler with mock stores and metric reader.

**Steps**:

1. Create rule: error_rate > 10% over 1 hour
2. Return metric value 15% -- verify state transitions ok -> firing
3. Verify notification sent
4. Return metric value 5% -- verify state transitions firing -> resolved
5. Verify resolve notification sent
6. Return metric value 15% again -- verify cooldown prevents re-fire
7. Clear cooldown -- verify alert fires again

**Exit Criteria**: Full state machine cycle with cooldown.

## 4. Security Test Scenarios

### SEC-1: Cross-Tenant Event Isolation

- Emit events for tenant-A and tenant-B to same ClickHouse table
- Query as tenant-A -- verify zero tenant-B events in results
- Query as tenant-B -- verify zero tenant-A events in results
- Verify cache keys are tenant-scoped (no cross-tenant cache poisoning)

### SEC-2: Cross-Tenant Wildcard in EvaluationDispatcher

- Call `pollAndProcess()` which uses `tenantId: '*'`
- Verify ClickHouse query with literal `'*'` returns zero results (not all tenants)
- Verify MemoryEventStore behavior with `tenantId: '*'`
- Document whether this is a real vulnerability or safe-by-accident

### SEC-3: SQL Query Endpoint Injection

- Attempt UNION-based injection in SQL query
- Attempt subquery-based injection
- Attempt comment-based injection (`-- DROP TABLE`)
- Verify all blocked by keyword check and table allowlist

### SEC-4: SSRF in Webhook URLs

- Attempt webhook subscription with internal IP (127.0.0.1, 10.x.x.x)
- Verify SSRF protection blocks delivery

## 5. Performance Test Scenarios

### PERF-1: Sustained Write Throughput

- Emit 100K events in 10 seconds via DirectQueue
- Verify all events buffered and flushed to store
- Measure p99 enqueue latency (<1ms)

### PERF-2: Query Latency Under Load

- Pre-populate 1M events across 10 tenants
- Execute concurrent queries (10 parallel) for different tenants
- Verify p95 query response <500ms

### PERF-3: WAL Recovery Performance

- Write 50K events to WAL (simulating infrastructure failure)
- Measure recovery time (replay + batch write + flush)
- Verify all events recovered with zero loss

## 6. Test Infrastructure Requirements

| Requirement    | Description                                                    |
| -------------- | -------------------------------------------------------------- |
| ClickHouse     | Required for E2E tests. Use Docker container or test instance. |
| Redis          | Required for BullMQ queue integration tests.                   |
| Express server | Start on random port for API tests. Full middleware chain.     |
| Auth           | Real auth middleware with test tenant tokens.                  |
| MongoDB        | Required for runtime integration (session store, eval config). |

## 7. Test File Naming Convention

```
packages/eventstore/src/__tests__/
  *.test.ts                         # Unit tests (existing)
  integration/
    *.integration.test.ts           # Integration tests
  e2e/
    *.e2e.test.ts                   # E2E tests (requires infra)

apps/runtime/src/__tests__/e2e/
  analytics-api-e2e.test.ts         # Analytics API E2E
  eventstore-cascade-e2e.test.ts    # GDPR cascade E2E
```
