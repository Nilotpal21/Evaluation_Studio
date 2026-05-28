# Test Specification: Arch AI Audit Logs

**Feature Spec**: `docs/features/arch-audit-logs.md`
**HLD**: `docs/specs/arch-audit-logs.hld.md`
**LLD**: `docs/plans/2026-04-12-arch-audit-logs-impl-plan.md`
**Status**: IN PROGRESS
**Last Updated**: 2026-04-12

---

## 1. Coverage Matrix

| FR    | Description                            | Unit    | Integration | E2E     | Manual  | Status    |
| ----- | -------------------------------------- | ------- | ----------- | ------- | ------- | --------- |
| FR-1  | 7 event categories captured            | ✅ PASS | planned     | planned | ❌      | UNIT PASS |
| FR-2  | Required fields on every entry         | ✅ PASS | planned     | ❌      | ❌      | UNIT PASS |
| FR-3  | LLM call token/cost capture            | ✅ PASS | ❌          | planned | ❌      | UNIT PASS |
| FR-4  | onStepFinish on all 3 streamText sites | ❌      | ❌          | planned | ❌      | CODE ONLY |
| FR-5  | Non-blocking buffered emitter          | ✅ PASS | planned     | ❌      | ❌      | UNIT PASS |
| FR-6  | List endpoint filters/pagination       | ❌      | planned     | planned | ❌      | CODE ONLY |
| FR-7  | Summary endpoint aggregate stats       | ❌      | planned     | planned | ❌      | CODE ONLY |
| FR-8  | Session timeline endpoint              | ❌      | planned     | planned | ❌      | CODE ONLY |
| FR-9  | Cost breakdown endpoint                | ❌      | planned     | planned | ❌      | CODE ONLY |
| FR-10 | Tenant isolation on all endpoints      | ❌      | planned     | planned | ❌      | CODE ONLY |
| FR-11 | 90-day TTL index                       | ✅ PASS | ❌          | ❌      | ❌      | UNIT PASS |
| FR-12 | Manual refresh button                  | ❌      | ❌          | ❌      | planned | CODE ONLY |
| FR-13 | CSV/JSON export                        | ❌      | planned     | planned | ❌      | CODE ONLY |
| FR-14 | Inline session timeline expansion      | ❌      | ❌          | ❌      | planned | CODE ONLY |
| FR-15 | Error event structure                  | ✅ PASS | planned     | ❌      | ❌      | UNIT PASS |
| FR-16 | Build event structure                  | ✅ PASS | planned     | ❌      | ❌      | UNIT PASS |

---

## 2. E2E Test Scenarios (MANDATORY)

> CRITICAL: E2E tests exercise the real system through HTTP API. No mocks, no direct DB access, no stubbed servers. All tests use `requireTenantAuth` via auth headers.
>
> **Seeding strategy**: E2E tests seed data by triggering the real audit emission path. Send `POST /api/arch-ai/message` with auth headers to generate natural audit log entries (user_action, llm_call events). For scenarios requiring precise control over entry counts/categories, use a dedicated test-only `POST /api/arch-ai/audit-logs/_seed` endpoint (guarded by `NODE_ENV=test` check) that accepts an array of entries and writes them through the same `AuditLogEmitter.emit()` + `flush()` path, exercising the real write pipeline including tenant context injection. Direct `insertMany` on the MongoDB collection is NOT permitted in E2E tests.

### E2E-1: Full Emit-to-Query Lifecycle

- **Preconditions**: Real MongoDB running. Seed 15 audit log entries across 3 categories (`llm_call` x5, `tool_execution` x5, `error` x5) for `tenant-e2e-1` via `POST /api/arch-ai/audit-logs/_seed` (test-only seeding endpoint that writes through the real emitter pipeline).
- **Steps**:
  1. `GET /api/arch-ai/audit-logs` with auth headers for `tenant-e2e-1`, no filters
  2. Assert response has `{ success: true, entries: [...], total: 15, page: 1, hasMore: false }`
  3. Assert each entry contains: `_id`, `tenantId`, `category`, `severity`, `summary`, `timestamp`
  4. Assert entries are ordered by `timestamp` descending (newest first)
  5. `GET /api/arch-ai/audit-logs?category=llm_call` with same auth
  6. Assert response has exactly 5 entries, all with `category: 'llm_call'`
- **Expected Result**: All 15 entries returned unfiltered; 5 returned with category filter. All entries have correct schema.
- **Auth Context**: `{ tenantId: 'tenant-e2e-1', userId: 'user-e2e-1' }` via `requireTenantAuth`
- **Isolation Check**: Separate query as `tenant-e2e-2` returns 0 entries

### E2E-2: Tenant Isolation Across All Endpoints

- **Preconditions**: Via `POST /api/arch-ai/audit-logs/_seed`: seed 10 entries for `tenant-iso-A` (session `sess-A`, project `proj-A`), 8 entries for `tenant-iso-B` (session `sess-B`, project `proj-B`). Include `llm_call` entries with `tokens` subdocument.
- **Steps**:
  1. As `tenant-iso-A`: `GET /api/arch-ai/audit-logs` — assert 10 entries
  2. As `tenant-iso-A`: `GET /api/arch-ai/audit-logs/summary` — assert `totalEvents: 10`
  3. As `tenant-iso-A`: `GET /api/arch-ai/audit-logs/sessions/sess-A/timeline` — assert entries returned
  4. As `tenant-iso-A`: `GET /api/arch-ai/audit-logs/sessions/sess-B/timeline` — assert 0 entries (cross-tenant session)
  5. As `tenant-iso-A`: `GET /api/arch-ai/audit-logs/cost-breakdown` — assert only tenant-A costs
  6. As `tenant-iso-B`: `GET /api/arch-ai/audit-logs` — assert 8 entries (none from tenant-A)
  7. As `tenant-iso-B`: `GET /api/arch-ai/audit-logs/summary` — assert `totalEvents: 8`
- **Expected Result**: Each tenant sees only its own data across all 4 endpoints. Cross-tenant session timeline returns empty.
- **Auth Context**: Two separate auth contexts, one per tenant
- **Isolation Check**: This IS the isolation test — bidirectional verification

### E2E-3: Pagination and Multi-Filter Combination

- **Preconditions**: Via `_seed` endpoint: seed 60 entries for `tenant-page-1`: 20 `llm_call` (10 in BUILD phase, 10 in INTERVIEW), 20 `error` (severity: 10 `warning`, 10 `error`), 20 `tool_execution`.
- **Steps**:
  1. `GET /api/arch-ai/audit-logs?limit=25&page=1` — assert 25 entries, `hasMore: true`, `total: 60`
  2. `GET /api/arch-ai/audit-logs?limit=25&page=2` — assert 25 entries, `hasMore: true`
  3. `GET /api/arch-ai/audit-logs?limit=25&page=3` — assert 10 entries, `hasMore: false`
  4. `GET /api/arch-ai/audit-logs?category=llm_call&phase=BUILD` — assert 10 entries
  5. `GET /api/arch-ai/audit-logs?category=error&severity=error` — assert 10 entries
  6. `GET /api/arch-ai/audit-logs?category=error&severity=warning&phase=BUILD` — assert matching subset
- **Expected Result**: Pagination metadata correct at each page boundary. Multi-filter AND combination works.
- **Auth Context**: `{ tenantId: 'tenant-page-1', userId: 'user-page-1' }`
- **Isolation Check**: N/A (single-tenant test)

### E2E-4: Session Timeline Ordering and Completeness

- **Preconditions**: Via `_seed` endpoint: seed 12 entries for session `sess-timeline-1` across all 7 categories, with timestamps 1 second apart. Include entries from different phases (INTERVIEW, BLUEPRINT, BUILD).
- **Steps**:
  1. `GET /api/arch-ai/audit-logs/sessions/sess-timeline-1/timeline`
  2. Assert 12 entries returned
  3. Assert entries are in ascending timestamp order (oldest first — timeline view)
  4. Assert all 7 categories are represented
  5. Assert each entry includes `phase`, `specialist`, `summary`, `detail`
  6. `GET /api/arch-ai/audit-logs/sessions/nonexistent-sess/timeline` — assert empty array (not 404)
- **Expected Result**: Timeline returns all session events in chronological order. Non-existent session returns empty, not error.
- **Auth Context**: `{ tenantId: 'tenant-timeline-1', userId: 'user-timeline-1' }`
- **Isolation Check**: Timeline for a session belonging to another tenant returns empty

### E2E-5: Summary Aggregation with Token Data

- **Preconditions**: Via `_seed` endpoint, seed entries for `tenant-summary-1`:
  - 5 `llm_call` entries with `tokens: { input: 1000, output: 500, total: 1500, estimatedCost: 0.015 }` each
  - 3 `error` entries: 1 `critical`, 1 `error`, 1 `warning`
  - 2 `llm_call` entries with `durationMs: 2000` and `durationMs: 4000`
  - 4 `tool_execution` entries, 2 `build_event`, 1 `phase_transition`
- **Steps**:
  1. `GET /api/arch-ai/audit-logs/summary?from=<start>&to=<end>`
  2. Assert `totalEvents: 17`
  3. Assert `totalTokens.total: 10500` (7 llm_call entries x 1500)
  4. Assert `totalTokens.input: 7000`, `totalTokens.output: 3500`
  5. Assert `estimatedCost: 0.105` (7 x 0.015)
  6. Assert `errorCount: 3` with breakdown `{ critical: 1, error: 1, warning: 1 }`
  7. Assert `byCategory` contains: `{ llm_call: 7, error: 3, tool_execution: 4, build_event: 2, phase_transition: 1 }`
- **Expected Result**: All aggregate numbers match the seeded data exactly.
- **Auth Context**: `{ tenantId: 'tenant-summary-1', userId: 'user-summary-1' }`
- **Isolation Check**: Summary for a different tenant shows different (or zero) numbers

### E2E-6: Cost Breakdown Grouping

- **Preconditions**: Via `_seed` endpoint, seed `llm_call` entries for `tenant-cost-1`:
  - User A, BUILD phase, model `claude-sonnet-4`: 3 entries, cost 0.01 each
  - User A, INTERVIEW phase, model `claude-sonnet-4`: 2 entries, cost 0.005 each
  - User B, BUILD phase, model `claude-haiku-3.5`: 4 entries, cost 0.002 each
- **Steps**:
  1. `GET /api/arch-ai/audit-logs/cost-breakdown?from=<start>&to=<end>`
  2. Assert 3 groups returned (User A/BUILD/sonnet, User A/INTERVIEW/sonnet, User B/BUILD/haiku)
  3. Assert User A BUILD total: `{ totalCost: 0.03, totalTokens: ..., callCount: 3 }`
  4. Assert User A INTERVIEW total: `{ totalCost: 0.01, totalTokens: ..., callCount: 2 }`
  5. Assert User B BUILD total: `{ totalCost: 0.008, totalTokens: ..., callCount: 4 }`
  6. Assert results sorted by `totalCost` descending
- **Expected Result**: Cost correctly grouped by user+phase+model with accurate sums.
- **Auth Context**: `{ tenantId: 'tenant-cost-1', userId: 'admin-cost-1' }`
- **Isolation Check**: Different tenant sees only its own cost data

### E2E-7: CSV Export with Active Filters

- **Preconditions**: Via `_seed` endpoint: seed 20 entries for `tenant-export-1`: 10 `llm_call`, 5 `error`, 5 `build_event`.
- **Steps**:
  1. `GET /api/arch-ai/audit-logs?category=error&format=csv` with auth headers
  2. Assert response Content-Type is `text/csv`
  3. Assert response Content-Disposition includes `attachment; filename=`
  4. Parse CSV: assert header row contains `_id,tenantId,category,severity,summary,timestamp,...`
  5. Assert 5 data rows (only `error` category)
  6. `GET /api/arch-ai/audit-logs?format=json&category=llm_call`
  7. Assert response is a JSON array of 10 entries
- **Expected Result**: Export respects the active category filter. CSV has correct headers and row count. JSON is a valid array.
- **Auth Context**: `{ tenantId: 'tenant-export-1', userId: 'admin-export-1' }`
- **Isolation Check**: Export for different tenant returns only that tenant's data

### E2E-8: Date Range Filtering

- **Preconditions**: Via `_seed` endpoint, seed entries for `tenant-date-1`:
  - 5 entries at `2026-04-01T10:00:00Z`
  - 5 entries at `2026-04-05T10:00:00Z`
  - 5 entries at `2026-04-10T10:00:00Z`
- **Steps**:
  1. `GET /api/arch-ai/audit-logs?from=2026-04-04T00:00:00Z&to=2026-04-06T00:00:00Z`
  2. Assert exactly 5 entries returned (only the April 5th entries)
  3. `GET /api/arch-ai/audit-logs/summary?from=2026-04-04T00:00:00Z&to=2026-04-06T00:00:00Z`
  4. Assert `totalEvents: 5`
  5. `GET /api/arch-ai/audit-logs?from=2026-04-01T00:00:00Z&to=2026-04-11T00:00:00Z`
  6. Assert 15 entries (full range)
- **Expected Result**: Date range correctly bounds results on both list and summary endpoints.
- **Auth Context**: `{ tenantId: 'tenant-date-1', userId: 'user-date-1' }`
- **Isolation Check**: N/A (single-tenant test)

### E2E-9: Admin Role Enforcement (Non-Admin Gets 403)

- **Preconditions**: Via `_seed` endpoint: seed 5 entries for `tenant-role-1`.
- **Steps**:
  1. As admin user (`role: 'ADMIN'`): `GET /api/arch-ai/audit-logs` — assert 200 with entries
  2. As admin user: `GET /api/arch-ai/audit-logs/summary` — assert 200
  3. As regular user (`role: 'MEMBER'`, same tenant): `GET /api/arch-ai/audit-logs` — assert 403 `{ success: false, error: { code: 'FORBIDDEN' } }`
  4. As regular user: `GET /api/arch-ai/audit-logs/summary` — assert 403
  5. As regular user: `GET /api/arch-ai/audit-logs/sessions/sess-1/timeline` — assert 403
  6. As regular user: `GET /api/arch-ai/audit-logs/cost-breakdown` — assert 403
- **Expected Result**: All 4 endpoints return 403 for non-admin users. Admin users get 200 with data.
- **Auth Context**: Two auth contexts — one ADMIN, one MEMBER — both in `tenant-role-1`
- **Isolation Check**: This IS the permission isolation test

### E2E-10: Export Ignores Pagination (Full Filtered Set)

- **Preconditions**: Via `_seed` endpoint: seed 300 `llm_call` entries for `tenant-export-full`.
- **Steps**:
  1. `GET /api/arch-ai/audit-logs?category=llm_call&limit=50&page=1` — assert 50 entries, `total: 300`, `hasMore: true`
  2. `GET /api/arch-ai/audit-logs?category=llm_call&format=csv` — assert all 300 rows in CSV (pagination ignored)
  3. Parse CSV: assert 300 data rows + 1 header row
  4. `GET /api/arch-ai/audit-logs?category=llm_call&format=json` — assert JSON array with 300 entries
- **Expected Result**: Export mode returns full filtered result set regardless of page/limit. Normal mode respects pagination.
- **Auth Context**: `{ tenantId: 'tenant-export-full', userId: 'admin-export-full', role: 'ADMIN' }`
- **Isolation Check**: N/A

---

## 3. Integration Test Scenarios (MANDATORY)

> Integration tests exercise real service boundaries (emitter → MongoDB, API route → MongoDB aggregation). Only external third-party services may be mocked. The `AuditLogEmitter` accepts `Model<IArchAuditLog>` via constructor DI, so tests can inject a real MongoDB-backed model or a test double for the model interface.

### INT-1: AuditLogEmitter — Buffer Flush at Threshold

- **Boundary**: `AuditLogEmitter` → MongoDB `insertMany`
- **Setup**: Create a real `ArchAuditLog` model connected to test MongoDB. Instantiate `AuditLogEmitter` with context `{ tenantId: 'int-1', userId: 'u1', sessionId: 's1' }` and the real model. Set buffer threshold to 5 (override default for test speed).
- **Steps**:
  1. Call `emitter.emit(...)` 4 times with different categories
  2. Assert `ArchAuditLog.countDocuments({ tenantId: 'int-1' })` returns 0 (below threshold)
  3. Call `emitter.emit(...)` 1 more time (reaches threshold of 5)
  4. Wait for flush promise to resolve (small async delay)
  5. Assert `ArchAuditLog.countDocuments({ tenantId: 'int-1' })` returns 5
  6. Verify each document has correct `tenantId`, `userId`, `sessionId`, `timestamp`
- **Expected Result**: Events buffered until threshold, then flushed as a single `insertMany`.
- **Failure Mode**: If MongoDB is unreachable, `insertMany` throws — emitter should catch and log, not throw.

### INT-2: AuditLogEmitter — Flush on Done (Below Threshold)

- **Boundary**: `AuditLogEmitter` → MongoDB `insertMany`
- **Setup**: Same as INT-1. Buffer threshold 50 (default).
- **Steps**:
  1. Call `emitter.emit(...)` 3 times
  2. Assert 0 documents in DB (below threshold, timer not elapsed)
  3. Call `emitter.flush()` (simulates SSE `done` event)
  4. Assert 3 documents now in DB
  5. Call `emitter.flush()` again
  6. Assert still 3 documents (idempotent — empty buffer)
- **Expected Result**: Manual flush writes remaining buffer. Double-flush is safe.
- **Failure Mode**: N/A

### INT-3: AuditLogEmitter — Fire-and-Forget Error Swallowing

- **Boundary**: `AuditLogEmitter` → MongoDB `insertMany` (failure path)
- **Setup**: Create emitter with a model wrapper that throws `MongoServerError` on `insertMany`. Capture `createLogger` warn calls.
- **Steps**:
  1. Call `emitter.emit(...)` enough times to trigger flush
  2. Wait for flush to complete
  3. Assert no exception was thrown to the caller
  4. Assert the warning log was called with error details
  5. Assert the emitter buffer is now empty (events discarded on failure, not re-queued)
- **Expected Result**: Write failure is swallowed. Warning logged. Buffer cleared.
- **Failure Mode**: This IS the failure mode test.

### INT-4: List Endpoint — Filter and Pagination Against Real MongoDB

- **Boundary**: `GET /api/arch-ai/audit-logs` route handler → MongoDB query
- **Setup**: Seed 30 documents directly into `arch_audit_logs` collection via Mongoose model:
  - 10 `llm_call` (5 in BUILD, 5 in INTERVIEW)
  - 10 `error` (5 `warning`, 5 `error` severity)
  - 10 `tool_execution`
    All for `tenantId: 'int-4'`.
- **Steps**:
  1. Call route handler with mock NextRequest: `GET ?category=llm_call&phase=BUILD&limit=10&page=1`, auth context `{ tenantId: 'int-4' }`
  2. Assert response: `{ success: true, entries: [...], total: 5, page: 1, hasMore: false }`
  3. Assert all 5 entries have `category: 'llm_call'` AND `phase: 'BUILD'`
  4. Call with `?category=error&severity=error`
  5. Assert 5 entries returned, all with `severity: 'error'`
  6. Call with `?limit=10&page=1` (no filters)
  7. Assert 10 entries with `hasMore: true`, `total: 30`
  8. Call with `?limit=10&page=4` — assert 0 entries, `hasMore: false`
- **Expected Result**: Filters compose with AND logic. Pagination metadata is accurate.
- **Failure Mode**: Invalid filter value (e.g., `category=invalid`) returns 400 with error message.

### INT-5: Summary Endpoint — Aggregation Pipeline Accuracy

- **Boundary**: `GET /api/arch-ai/audit-logs/summary` route handler → MongoDB `$facet` aggregation
- **Setup**: Seed 20 documents for `tenantId: 'int-5'`:
  - 8 `llm_call` with `tokens: { input: 100, output: 50, total: 150, estimatedCost: 0.003 }`
  - 4 `error` (2 critical, 1 error, 1 warning)
  - 5 `tool_execution` with `durationMs` values: [100, 200, 300, 400, 500]
  - 3 `build_event`
- **Steps**:
  1. Call summary handler with auth context `{ tenantId: 'int-5' }`, date range covering all entries
  2. Assert `totalEvents: 20`
  3. Assert `totalTokens: { input: 800, output: 400, total: 1200 }`
  4. Assert `estimatedCost: 0.024` (8 x 0.003)
  5. Assert `errorCount: { total: 4, critical: 2, error: 1, warning: 1 }`
  6. Assert `byCategory: { llm_call: 8, error: 4, tool_execution: 5, build_event: 3 }`
- **Expected Result**: All aggregation numbers match seeded data exactly.
- **Failure Mode**: Empty date range returns zeroes (not error).

### INT-6: Session Timeline — Chronological Ordering

- **Boundary**: `GET /api/arch-ai/audit-logs/sessions/:id/timeline` → MongoDB query
- **Setup**: Seed 8 entries for `sessionId: 'sess-int-6'`, `tenantId: 'int-6'`. Timestamps are 1 second apart. Categories: `user_action`, `llm_call`, `tool_execution`, `llm_call`, `build_event`, `build_event`, `error`, `system_event`.
- **Steps**:
  1. Call timeline handler for session `sess-int-6`
  2. Assert 8 entries returned
  3. Assert `entries[0].timestamp < entries[1].timestamp < ... < entries[7].timestamp` (ascending)
  4. Assert categories match the seeded order
  5. Call timeline for `sess-nonexistent` — assert empty array, 200 status
- **Expected Result**: Entries in ascending chronological order. Nonexistent session returns empty array.
- **Failure Mode**: N/A

### INT-7: Cost Breakdown — GroupBy Aggregation

- **Boundary**: `GET /api/arch-ai/audit-logs/cost-breakdown` → MongoDB `$group` aggregation
- **Setup**: Seed `llm_call` entries for `tenantId: 'int-7'`:
  - userId `u1`, phase `BUILD`, model `claude-sonnet-4`: 3 entries, cost 0.01 each
  - userId `u1`, phase `INTERVIEW`, model `claude-sonnet-4`: 2 entries, cost 0.005 each
  - userId `u2`, phase `BUILD`, model `claude-haiku-3.5`: 1 entry, cost 0.001
- **Steps**:
  1. Call cost-breakdown handler with date range
  2. Assert 3 groups returned
  3. Verify group `{ userId: 'u1', phase: 'BUILD', model: 'claude-sonnet-4' }` has `totalCost: 0.03, callCount: 3`
  4. Verify group `{ userId: 'u1', phase: 'INTERVIEW', model: 'claude-sonnet-4' }` has `totalCost: 0.01, callCount: 2`
  5. Verify group `{ userId: 'u2', phase: 'BUILD', model: 'claude-haiku-3.5' }` has `totalCost: 0.001, callCount: 1`
  6. Assert sorted by `totalCost` descending
- **Expected Result**: Groups are correct with accurate sum/count.
- **Failure Mode**: No `llm_call` entries in range returns empty array.

### INT-8: Export — CSV Format Correctness

- **Boundary**: `GET /api/arch-ai/audit-logs?format=csv` → CSV serialization
- **Setup**: Seed 5 entries for `tenantId: 'int-8'` with varied categories and `detail` payloads including nested objects and arrays.
- **Steps**:
  1. Call list endpoint with `?format=csv`
  2. Assert Content-Type header is `text/csv` (or `text/csv; charset=utf-8`)
  3. Parse CSV output
  4. Assert header row contains all expected columns
  5. Assert 5 data rows
  6. Assert `detail` column contains JSON-stringified payload (nested objects serialized)
  7. Assert `tokens` column contains stringified subdocument (when present)
- **Expected Result**: CSV is well-formed, nested fields are JSON-stringified.
- **Failure Mode**: N/A

---

## 4. Unit Test Scenarios

### UT-1: AuditLogEmitter — Constructor and Defaults

- **Module**: `packages/arch-ai/src/audit/audit-log-emitter.ts`
- **Input**: `new AuditLogEmitter({ tenantId: 't1', userId: 'u1', sessionId: 's1' }, mockModel)`
- **Expected Output**: Emitter created with empty buffer, timer not started.

### UT-2: AuditLogEmitter — emit() Adds to Buffer

- **Module**: `packages/arch-ai/src/audit/audit-log-emitter.ts`
- **Input**: Call `emit({ category: 'llm_call', severity: 'info', summary: 'test', detail: {} })`
- **Expected Output**: Buffer length increases by 1. Entry has `tenantId`, `userId`, `sessionId` from context. `timestamp` is set automatically.

### UT-3: AuditLogEmitter — Timer-Based Flush

- **Module**: `packages/arch-ai/src/audit/audit-log-emitter.ts`
- **Input**: Emit 3 events (below threshold). Advance timers by flush interval.
- **Expected Output**: `insertMany` called once with 3 entries after timer fires.

### UT-4: AuditLogEmitter — Buffer Cap (Max 100)

- **Module**: `packages/arch-ai/src/audit/audit-log-emitter.ts`
- **Input**: Emit 120 events rapidly (exceeds max buffer size of 100).
- **Expected Output**: At most 100 events in buffer at any time. Flush is triggered when threshold or max is reached. No memory leak.

### UT-5: Audit Log Entry Type Validation

- **Module**: `packages/arch-ai/src/audit/types.ts`
- **Input**: Create entries with each of the 7 category values. Create entry with invalid category.
- **Expected Output**: Valid categories accepted. Invalid category rejected at type level (compile-time) and schema level (runtime validation).

### UT-6: ArchAuditLog Schema — Required Fields

- **Module**: `packages/database/src/models/arch-audit-log.model.ts`
- **Input**: Attempt to create document missing `tenantId`, `category`, `summary`, `severity`, or `timestamp`.
- **Expected Output**: Mongoose validation error for each missing required field.

### UT-7: ArchAuditLog Schema — Category and Severity Enums

- **Module**: `packages/database/src/models/arch-audit-log.model.ts`
- **Input**: Create document with `category: 'invalid_category'` or `severity: 'unknown'`.
- **Expected Output**: Mongoose validation error — enum constraint violated.

### UT-8: ArchAuditLog Schema — TTL Index Presence

- **Module**: `packages/database/src/models/arch-audit-log.model.ts`
- **Input**: Read schema indexes after model compilation.
- **Expected Output**: TTL index on `{ timestamp: 1 }` with `expireAfterSeconds: 7776000` (90 days).

### UT-9: ArchAuditLog Schema — Tenant Isolation Plugin Applied

- **Module**: `packages/database/src/models/arch-audit-log.model.ts`
- **Input**: Check schema plugins after model compilation.
- **Expected Output**: `tenantIsolationPlugin` is applied.

### UT-10: LLM Call Detail Payload Structure

- **Module**: `packages/arch-ai/src/audit/types.ts`
- **Input**: Create an `llm_call` detail payload with: `model`, `inputTokens`, `outputTokens`, `totalTokens`, `estimatedCost`, `finishReason`, `specialist`, `phase`.
- **Expected Output**: Type validates. All fields present. `estimatedCost` computed from `estimateCost()`.

### UT-11: Error Detail Payload Structure

- **Module**: `packages/arch-ai/src/audit/types.ts`
- **Input**: Create `error` detail payloads with all `errorCode` variants (`llm_timeout`, `compile_error`, `rate_limit`, `context_exceeded`, `session_busy`, `invalid_transition`, `tool_error`, `network_error`).
- **Expected Output**: All variants are type-valid. `severity`, `source`, and `recoveryAction` fields present.

---

## 5. Security & Isolation Tests

- [x] **Cross-tenant access returns empty**: Query as tenant-A, assert tenant-B's entries are not returned (E2E-2)
- [x] **Cross-tenant session timeline returns empty**: Request timeline for a session belonging to another tenant (E2E-2, step 4)
- [x] **Cross-tenant cost breakdown isolated**: Cost breakdown as tenant-A excludes tenant-B data (E2E-6)
- [x] **Non-admin user returns 403**: Request any endpoint as MEMBER role → 403 `{ success: false, error: { code: 'FORBIDDEN' } }` (E2E-9)
- [x] **Admin user returns 200**: Same request as ADMIN/OWNER role → 200 with data (E2E-9)
- [x] **Missing auth returns 401**: Request any endpoint without auth headers → 401 response with `{ success: false, error: { code: 'UNAUTHORIZED' } }`
- [x] **Invalid date range returns 400**: Request with `from` after `to` → 400 with descriptive error
- [x] **Invalid category filter returns 400**: Request with `category=nonexistent` → 400 with valid values listed
- [x] **No PII in audit data**: Verify `detail` payloads never contain raw LLM prompts, API keys, or user email addresses. Spot-check all 7 category payloads.
- [x] **Export respects tenant isolation**: CSV/JSON export for tenant-A contains zero entries from tenant-B (E2E-7)
- [x] **tenantIsolationPlugin active**: ArchAuditLog model has the plugin applied (UT-9)

---

## 6. Performance & Load Tests

### PERF-1: Emitter Write Latency

- **Goal**: Verify `AuditLogEmitter.emit()` adds < 0.1ms latency to the calling code path
- **Method**: Time 1000 `emit()` calls in a tight loop. Assert total time < 100ms (0.1ms/call average).
- **Rationale**: `emit()` is called on the SSE streaming hot path. Any blocking behavior degrades user-perceived latency.

### PERF-2: Aggregation Query Time

- **Goal**: Summary aggregation completes in < 500ms for 10K entries
- **Method**: Seed 10,000 entries for a single tenant. Time `GET /api/arch-ai/audit-logs/summary`. Assert < 500ms.
- **Rationale**: The `$facet` aggregation runs on every page load of the audit logs tab.

### PERF-3: List Endpoint Pagination at Scale

- **Goal**: List endpoint responds in < 200ms with 50K entries in collection
- **Method**: Seed 50,000 entries. Time `GET /api/arch-ai/audit-logs?limit=50&page=1`. Assert < 200ms.
- **Rationale**: Covering indexes should make this fast regardless of collection size.

---

## 7. Test Infrastructure

### Required Services

- **MongoDB**: Real MongoDB instance (Docker or in-memory via `mongodb-memory-server`). All integration and E2E tests require it.
- **No ClickHouse**: This feature uses MongoDB only.
- **No Redis**: No queue infrastructure.
- **No external services**: No LLM providers, no Vercel. Token capture tests verify the callback wiring, not actual LLM calls.

### Data Seeding

Test helper function to seed audit log entries:

```typescript
async function seedAuditLogs(
  model: Model<IArchAuditLog>,
  tenantId: string,
  entries: Array<Partial<IArchAuditLog>>,
): Promise<void> {
  const docs = entries.map((e, i) => ({
    tenantId,
    userId: e.userId ?? 'test-user',
    sessionId: e.sessionId ?? 'test-session',
    category: e.category ?? 'llm_call',
    severity: e.severity ?? 'info',
    summary: e.summary ?? `Test entry ${i}`,
    detail: e.detail ?? {},
    timestamp: e.timestamp ?? new Date(Date.now() - (entries.length - i) * 1000),
    ...e,
  }));
  await model.insertMany(docs);
}
```

### Environment Variables

| Variable                           | Test Value | Purpose                                                        |
| ---------------------------------- | ---------- | -------------------------------------------------------------- |
| `ARCH_AUDIT_LOG_ENABLED`           | `true`     | Enable audit logging (also test `false` to verify kill switch) |
| `ARCH_AUDIT_LOG_BUFFER_SIZE`       | `5`        | Lower threshold for faster test execution                      |
| `ARCH_AUDIT_LOG_FLUSH_INTERVAL_MS` | `100`      | Faster flush for test timing                                   |

### CI Configuration

- Tests run in the `apps/studio` and `packages/arch-ai` workspaces
- MongoDB via Docker or `mongodb-memory-server`
- No special CI secrets needed (no external service calls)

---

## 8. Test File Mapping

| Test File                                                                   | Type        | Covers                                          |
| --------------------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| `packages/arch-ai/src/__tests__/audit-log-emitter.test.ts`                  | unit        | FR-5 (UT-1 through UT-4), FR-1, FR-2            |
| `packages/arch-ai/src/__tests__/audit-log-types.test.ts`                    | unit        | FR-1, FR-15, FR-16 (UT-5, UT-10, UT-11)         |
| `packages/database/src/__tests__/arch-audit-log.model.test.ts`              | unit        | FR-2, FR-11 (UT-6 through UT-9)                 |
| `apps/studio/src/__tests__/arch-ai/audit-logs-list.integration.test.ts`     | integration | FR-6, FR-10, FR-13 (INT-4, INT-8)               |
| `apps/studio/src/__tests__/arch-ai/audit-logs-summary.integration.test.ts`  | integration | FR-7 (INT-5)                                    |
| `apps/studio/src/__tests__/arch-ai/audit-logs-timeline.integration.test.ts` | integration | FR-8 (INT-6)                                    |
| `apps/studio/src/__tests__/arch-ai/audit-logs-cost.integration.test.ts`     | integration | FR-9 (INT-7)                                    |
| `apps/studio/src/__tests__/arch-ai/audit-logs-emitter.integration.test.ts`  | integration | FR-5 (INT-1, INT-2, INT-3)                      |
| `apps/studio/src/__tests__/arch-ai/audit-logs-e2e.test.ts`                  | e2e         | FR-1 through FR-10, FR-13 (E2E-1 through E2E-8) |

---

## 9. Open Testing Questions

1. Should there be a dedicated test for the `ARCH_AUDIT_LOG_ENABLED=false` kill switch (emitter becomes a no-op)?
2. How to test TTL auto-deletion? MongoDB TTL runner checks every 60 seconds — likely needs a manual index verification test (UT-8) rather than a time-based deletion test.
3. Should there be a stress test for concurrent emitters (multiple simultaneous SSE streams writing audit logs)? Low risk given per-request emitter scope, but worth verifying under load.
4. The `onStepFinish` token capture cannot be tested without a real LLM call. Should E2E-4 (token capture) be marked as requiring manual verification, or should we create a mock Vercel AI SDK stream for this specific scenario?
