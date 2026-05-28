# Feature Test Guide: Audit Logging

**Feature**: Audit Logging -- structured, append-only audit trail across the shared Kafka -> ClickHouse stream plus specialized Mongo audit paths
**Owner**: Platform team
**Branch**: `KI0326/feature/audit-logging-system`
**Related Feature Doc**: [docs/features/audit-logging.md](../features/audit-logging.md)
**First tested**: 2026-03-08
**Last updated**: 2026-04-23
**Overall status**: BETA-ready -- shared codec, stores, singleton, retention, alerting, Studio/Admin compatibility, and public-API audit roundtrips are covered; no remaining implementation blockers were found in the current hardening scope

---

## Current State (as of 2026-04-23)

Audit logging now has dedicated coverage for the shared audit codec, Kafka-backed shared-path behavior, singleton backend selection and alert wiring, runtime environment resolution, PII shutdown durability, real Mongo TTL expiry for PII, ClickHouse retention DDL, Studio/Admin ClickHouse readers, actor propagation through the Mongoose audit trail plugin, and the shared audit contract. The public audit surfaces now also have black-box HTTP coverage for Studio roundtrip writes, tenant isolation, fire-and-forget failure handling, Admin query filters, and Admin CSV export, with a shared in-memory audit backend used only by the HTTP harnesses.

### Quick Health Dashboard

| Area                                         | Status | Last Verified | Notes                                                                                  |
| -------------------------------------------- | ------ | ------------- | -------------------------------------------------------------------------------------- |
| KMS audit logger (ClickHouse write)          | PASS   | 2026-04-21    | Single event and batch write verified                                                  |
| KMS audit fallback (CH unavailable)          | PASS   | 2026-04-21    | Falls back to structured console log                                                   |
| Audit trail ciphertext masking               | PASS   | 2026-04-21    | Encrypted fields masked as `[ENCRYPTED]`                                               |
| Auth profile audit event constants           | PASS   | 2026-04-21    | 13 events verified                                                                     |
| Audit helper calls in routes                 | PASS   | 2026-04-21    | Authz and wiring regressions cover shared helpers, contact wiring, and env resolution  |
| ClickHouseAuditStore (append/query/summary)  | PASS   | 2026-04-21    | Dedicated parity and migration coverage                                                |
| ClickHouse audit retention DDL               | PASS   | 2026-04-21    | Shared `audit_events` cold-storage + delete TTL and KMS 3-year retention verified      |
| Audit store singleton (backend selection)    | PASS   | 2026-04-22    | Strict pipeline mode when enabled; otherwise direct ClickHouse or InMemory plus alerts |
| In-memory shared audit test backend          | PASS   | 2026-04-22    | Test-only backend for Studio/Admin HTTP audit roundtrips                               |
| InMemoryAuditStore (query/summary)           | PASS   | 2026-04-21    | Covered via alerting and contract integration tests                                    |
| PII audit log (TTL auto-expiry)              | PASS   | 2026-04-21    | Real Mongo TTL monitor deletes expired rows                                            |
| Alert dispatch (webhook/Slack)               | PASS   | 2026-04-21    | Dedicated webhook and Slack tests                                                      |
| Admin audit API (GET /api/audit, export)     | PASS   | 2026-04-21    | Compatibility readers plus real HTTP filter and CSV export coverage                    |
| Studio audit API (GET /api/audit)            | PASS   | 2026-04-21    | Compatibility decoding plus real HTTP roundtrip, tenant isolation, and failure isolate |
| Studio audit service (metadata sanitization) | PASS   | 2026-04-21    | Dedicated service-level tests                                                          |
| Tool audit logger                            | PASS   | 2026-04-21    | Dedicated logger and runtime environment resolution tests                              |
| Contact audit emitter                        | PASS   | 2026-04-21    | DDD wiring and contact authz regressions                                               |

---

## Audit Scope

This guide covers:

- Abstract AuditStore base class and the shared ClickHouse/InMemory implementations used by the current pipeline
- Audit store singleton initialization, strict pipeline behavior, and backend selection for the shared runtime path
- Domain-specific audit helpers (contact, workflow, session, version, subscription, test context)
- Mongoose audit trail plugin with AsyncLocalStorage actor context
- Tool execution audit logger
- KMS operation audit logger
- PII access audit logger with TTL
- Alert system for critical events
- Studio audit service with metadata sanitization
- Admin dashboard audit API
- Contact audit DDD port

---

## Test Inventory

### Unit Tests

| Test File                                                                | Suites | Status | Key Scenarios                                                                              |
| ------------------------------------------------------------------------ | ------ | ------ | ------------------------------------------------------------------------------------------ |
| `apps/runtime/src/services/kms/__tests__/kms-audit-logger.test.ts`       | ~4     | PASS   | Single event write to CH, batch write, CH unavailable fallback, event-to-row mapping       |
| `packages/database/src/__tests__/audit-trail-ciphertext-masking.test.ts` | ~3     | PASS   | Encrypted field masking in audit diffs                                                     |
| `packages/database/src/__tests__/auth-profile-audit-events.test.ts`      | ~2     | PASS   | Auth profile event constant completeness                                                   |
| `apps/runtime/src/__tests__/tool-audit-logger.test.ts`                   | ~2     | PASS   | Tool audit logger write and error handling                                                 |
| `packages/compiler/src/__tests__/shared-audit-codec.test.ts`             | ~6     | PASS   | Canonical encode/decode, legacy compatibility, retention helpers                           |
| `packages/compiler/src/__tests__/audit-store-alerting.test.ts`           | ~4     | PASS   | Webhook and Slack critical-event dispatch                                                  |
| `packages/database/src/__tests__/audit-log.model.test.ts`                | ~5     | PASS   | Canonical schema fields, indexes, TTL gate                                                 |
| `packages/database/src/__tests__/clickhouse-audit-retention.test.ts`     | ~3     | PASS   | Shared `audit_events` cold/delete TTL plus KMS retention DDL                               |
| `packages/compiler/src/__tests__/in-memory-audit-test-backend.test.ts`   | ~2     | PASS   | Shared in-memory backend used by Studio/Admin audit E2E harnesses                          |
| `packages/database/src/__tests__/audit-trail-actor-propagation.test.ts`  | ~3     | PASS   | Plugin actor propagation and compatibility decode                                          |
| `apps/runtime/src/__tests__/audit-environment.test.ts`                   | ~5     | PASS   | Runtime audit environment resolution and precedence                                        |
| `apps/runtime/src/__tests__/audit-helpers.test.ts`                       | ~3     | PASS   | Shared helper writes use resolved runtime environment                                      |
| `apps/runtime/src/__tests__/clickhouse-audit-store.test.ts`              | ~5     | PASS   | ClickHouse shared-contract parity                                                          |
| `apps/runtime/src/__tests__/clickhouse-audit-migration.test.ts`          | ~4     | PASS   | ClickHouse legacy compatibility and backfill planning                                      |
| `apps/runtime/src/__tests__/audit-store-singleton.test.ts`               | ~4     | PASS   | Singleton initialization, pipeline strictness, direct CH fallback, alert env config        |
| `apps/runtime/src/__tests__/auth-repo-batching.test.ts`                  | ~5     | PASS   | Auth audit canonical event shaping, singleton-backed writes, shutdown drain, failure stats |
| `apps/runtime/src/__tests__/pii-audit-shutdown.test.ts`                  | ~2     | PASS   | PII buffered flush on shutdown                                                             |
| `apps/runtime/src/__tests__/tools-deployment/tool-audit-logger.test.ts`  | ~3     | PASS   | Tool audit logger write, error handling, environment resolution                            |
| `apps/studio/src/__tests__/audit-service.test.ts`                        | ~4     | PASS   | Metadata sanitization and canonical writes                                                 |
| `apps/studio/src/__tests__/audit-explorer-query.test.ts`                 | ~4     | PASS   | Workspace explorer filter parsing, bounded search, tenant-scoped SQL, and CSV hardening    |
| `apps/studio/src/__tests__/studio-clickhouse-audit-reader.test.ts`       | ~1     | PASS   | Studio reader routes trace/session filters through the explorer SQL path                   |
| `apps/admin/src/__tests__/audit-page-export.test.ts`                     | ~1     | PASS   | CSV serialization for compatibility-decoded rows                                           |

### Integration Tests

| Test File                                                                   | Status | Key Scenarios                                                                         |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/integration/audit-contract.integration.test.ts` | PASS   | Append-only history, tenant isolation, actor attribution, trace lookup, legacy decode |
| `packages/database/src/__tests__/pii-audit-log.ttl.test.ts`                 | PASS   | Real Mongo TTL monitor auto-deletes expired PII audit rows                            |
| `apps/studio/src/__tests__/api-routes/api-audit.test.ts`                    | PASS   | Studio audit API filtering, compatibility decoding, personal-scope behavior           |
| `apps/studio/src/__tests__/api-routes/api-audit-export.test.ts`             | PASS   | Workspace filtered CSV/JSON/NDJSON audit export, admin gating, and export audit event |
| `apps/studio/src/__tests__/api-routes/audit-export-route.test.ts`           | PASS   | Admin-gated tenant-scoped audit export manifest creation                              |
| `apps/admin/src/__tests__/audit-route.test.ts`                              | PASS   | Admin audit query compatibility and filtering                                         |
| `apps/admin/src/__tests__/secret-rotation-history.test.ts`                  | PASS   | Secondary admin consumer compatibility                                                |

### E2E Tests

| Test File                                         | Status | Key Scenarios                                                                |
| ------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/audit-api.e2e.test.ts` | PASS   | Studio workspace audit roundtrip, tenant isolation, fire-and-forget fallback |
| `apps/admin/src/__tests__/audit-api.e2e.test.ts`  | PASS   | Admin audit query filters and CSV export over real HTTP with admin auth      |

### Indirect Coverage

| Test File                                                | Coverage                        | Notes                                                 |
| -------------------------------------------------------- | ------------------------------- | ----------------------------------------------------- |
| `apps/runtime/src/__tests__/sessions-authz.test.ts`      | Audit helper call verification  | Verifies `auditSessionCreated` is called              |
| `apps/runtime/src/__tests__/contacts-authz.test.ts`      | Audit helper call verification  | Verifies `auditContactCreated`/`Updated`/`Deleted`    |
| `apps/runtime/src/__tests__/workflows-authz.test.ts`     | Audit helper call verification  | Verifies workflow audit helpers                       |
| `apps/runtime/src/__tests__/versions-authz.test.ts`      | Audit helper call verification  | Verifies version audit helpers                        |
| `apps/runtime/src/__tests__/wiring.test.ts`              | Wiring verification             | Verifies audit singleton is initialized at startup    |
| `apps/runtime/src/__tests__/auth/contacts-authz.test.ts` | Contact audit path verification | Verifies contact lifecycle audit writes are exercised |

---

## How to Run

```bash
# KMS audit logger tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- apps/runtime/src/services/kms/__tests__/kms-audit-logger.test.ts

# Audit trail ciphertext masking tests
pnpm build --filter=@agent-platform/database && pnpm test --filter=@agent-platform/database -- src/__tests__/audit-trail-ciphertext-masking.test.ts

# All authz tests (includes indirect audit helper verification)
pnpm test --filter=runtime -- --reporter=verbose -t "authz"

# All audit-related tests (broad search)
pnpm test --filter=runtime -- --reporter=verbose -t "audit"
```

---

## Coverage Matrix

### By Subsystem

| Subsystem                        | Unit     | Integration | E2E     | Overall |
| -------------------------------- | -------- | ----------- | ------- | ------- |
| AuditStore base class (InMemory) | partial  | partial     | 0%      | PARTIAL |
| In-memory shared test backend    | strong   | n/a         | 100%    | GOOD    |
| ClickHouseAuditStore             | strong   | partial     | 0%      | GOOD    |
| Audit store singleton            | strong   | partial     | 0%      | GOOD    |
| Audit helpers (20+ functions)    | indirect | partial     | partial | GOOD    |
| Audit trail Mongoose plugin      | strong   | partial     | 0%      | GOOD    |
| Tool audit logger                | strong   | 0%          | 0%      | GOOD    |
| KMS audit logger                 | 90%      | partial     | 0%      | GOOD    |
| PII audit logger                 | partial  | strong      | 0%      | GOOD    |
| Studio audit service             | strong   | partial     | partial | GOOD    |
| Admin audit API                  | partial  | strong      | strong  | GOOD    |
| Studio audit API                 | partial  | strong      | strong  | GOOD    |
| Alert system                     | strong   | partial     | 0%      | GOOD    |
| Contact audit emitter            | partial  | partial     | 0%      | PARTIAL |

### By Compliance Requirement

| Requirement                                  | Tested  | Notes                                                                                                    |
| -------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| Append-only (no update/delete)               | PARTIAL | Shared contract and API tests cover append-only reads; no storage-engine immutability audit exists       |
| Fire-and-forget (audit failures don't block) | YES     | Studio HTTP E2E verifies write failure does not block the primary operation                              |
| PII auto-expiry (90 days)                    | YES     | `pii-audit-log.ttl.test.ts` verifies real MongoDB TTL deletion                                           |
| KMS 3-year retention                         | YES     | `clickhouse-audit-retention.test.ts` verifies `kms_audit_log` 1095-day DELETE TTL                        |
| Metadata encryption                          | PARTIAL | Ciphertext masking is tested; encryption-at-rest mechanics are covered by the broader encryption feature |
| Tenant isolation                             | YES     | Shared contract tests plus Studio HTTP E2E verify tenant-safe audit reads                                |
| Sensitive metadata redaction                 | YES     | `audit-service.test.ts` covers sanitization behavior                                                     |

---

## E2E Test Scenarios (Required -- Minimum 5)

### E2E-1: Full Audit Roundtrip via HTTP API

**Objective**: Verify that a user action creates an audit event that can be queried back.

Implemented by: `apps/studio/src/__tests__/audit-api.e2e.test.ts`

**Steps**:

1. Start a real Express server with the shared in-memory audit test backend enabled
2. Authenticate as a test user
3. Perform an auditable operation (e.g., create a project via `POST /api/projects`)
4. Query the audit API (`GET /api/audit?action=project_created`)
5. Verify the returned audit event has correct fields: action, actor (userId), timestamp, metadata

**Assertions**:

- Response status 200
- At least one audit event returned
- Event action matches the operation performed
- Event userId matches the authenticated user
- Timestamp is within the last 60 seconds

### E2E-2: Admin Audit Query with Filters

**Objective**: Verify the admin audit API returns filtered results correctly.

Implemented by: `apps/admin/src/__tests__/audit-api.e2e.test.ts`

**Steps**:

1. Start real admin Express server
2. Seed multiple audit events with different actors, actions, and timestamps
3. Query with actor filter: verify only that actor's events returned
4. Query with action filter: verify only that action type returned
5. Query with date range filter: verify only events within range returned
6. Query with limit: verify pagination works correctly

**Assertions**:

- Each filter correctly narrows results
- Pagination returns correct count
- Empty filters return all events

### E2E-3: Tenant Isolation in Audit Logs

**Objective**: Verify that tenant A cannot see tenant B's audit events.

Implemented by: `apps/studio/src/__tests__/audit-api.e2e.test.ts`

**Steps**:

1. Start real Express server
2. Create audit events for tenant A (via authenticated operation)
3. Create audit events for tenant B (via authenticated operation)
4. Query audit API as tenant A user
5. Verify no tenant B events are returned

**Assertions**:

- Tenant A query returns only tenant A events
- No cross-tenant data leakage

### E2E-4: Fire-and-Forget Audit Write Failure

**Objective**: Verify that audit write failures do not block the primary operation.

Implemented by: `apps/studio/src/__tests__/audit-api.e2e.test.ts`

**Steps**:

1. Start real Express server
2. Simulate shared audit backend failure through the HTTP harness failure toggle
3. Perform an auditable operation (e.g., create a session)
4. Verify the operation succeeds despite audit failure
5. Verify error is logged (check logger output)

**Assertions**:

- Primary operation returns success (2xx status)
- No 5xx error from audit failure
- Warning/error logged for audit write failure

### E2E-5: Studio Audit Service Metadata Sanitization

**Objective**: Verify that sensitive metadata is redacted before storage.

**Steps**:

1. Start Studio server
2. Perform an operation that includes sensitive metadata (e.g., credential creation with password field)
3. Query the audit log for the event
4. Verify sensitive fields are `[REDACTED]` in the stored metadata

**Assertions**:

- Metadata contains `[REDACTED]` for password/token/secret keys
- Non-sensitive metadata is preserved unchanged

### E2E-6: Audit CSV Export

**Objective**: Verify the admin audit CSV export produces valid output.

Implemented by: `apps/admin/src/__tests__/audit-api.e2e.test.ts`

**Steps**:

1. Start admin server with seeded audit events
2. Navigate to audit page or call audit API
3. Trigger CSV export
4. Parse the CSV output

**Assertions**:

- CSV has correct header row (Timestamp, Actor, Role, Action, Target, Environment, IP Address)
- Data rows match the displayed audit entries
- Special characters are properly escaped

### E2E-7: KMS Audit Event End-to-End

**Objective**: Verify KMS operations produce audit events in the KMS audit log.

**Steps**:

1. Start runtime with ClickHouse available
2. Perform a KMS operation (key creation or rotation)
3. Query the `kms_audit_log` table
4. Verify the audit event has correct operation, key_id, success, latency_ms

**Assertions**:

- Event recorded in `kms_audit_log`
- All fields populated correctly
- `success` field reflects operation outcome

---

## Integration Test Scenarios (Required -- Minimum 5)

### INT-1: Audit Store Singleton Backend Selection

**Objective**: Verify the singleton correctly enforces the shared runtime selection rules: strict Kafka pipeline when enabled, direct ClickHouse when pipeline mode is off and ClickHouse is available, and InMemory only when pipeline mode is off and ClickHouse is unavailable.

**Steps**:

1. Initialize with `auditPipelineEnabled: true`, `clickhouseReady: true` -- verify pipeline store selected
2. Initialize with `auditPipelineEnabled: true`, `clickhouseReady: false` -- verify initialization fails closed
3. Initialize with `clickhouseReady: true` and pipeline disabled -- verify ClickHouseAuditStore selected
4. Initialize with `clickhouseReady: false` and pipeline disabled -- verify InMemoryAuditStore selected

**Assertions**:

- Correct store type selected at each level
- Pipeline mode does not silently downgrade when ClickHouse is unavailable
- Logged messages indicate which backend was chosen

### INT-2: Shared In-Memory Audit Test Backend Query and Filters

**Objective**: Verify the shared in-memory audit backend used by the HTTP harnesses persists and filters canonical audit events correctly.

**Steps**:

1. Create/reset the shared in-memory audit test backend
2. Append multiple audit events with different actions, actors, resources
3. Query with various filters (eventTypes, actor, resourceType, time range)
4. Verify pagination and tenant scoping behavior

**Assertions**:

- All appended events can be queried back
- Filters correctly narrow results
- Test-only write failures surface synchronously when configured

### INT-3: Audit Trail Plugin with Actor Context

**Objective**: Verify the Mongoose audit trail plugin captures write operations with actor context.

**Steps**:

1. Apply `auditTrailPlugin` to a test schema
2. Use `withAuditActor()` to set actor context
3. Create a document -- verify audit entry with operation='create'
4. Update a document -- verify audit entry with operation='update' and changes
5. Delete a document -- verify audit entry with operation='delete'

**Assertions**:

- Each write operation creates an audit entry
- Actor context (userId, email, ip) is captured
- Changes reflect the actual modified fields
- Encrypted fields are masked as `[ENCRYPTED]`

### INT-4: PII Audit Log TTL Verification

**Objective**: Verify PII audit logs are auto-deleted after the TTL period.

**Steps**:

1. Create PII audit log entries with `expireAt` set to past (e.g., 1 second ago)
2. Wait for MongoDB TTL monitor to run (up to 60 seconds in test)
3. Query for the entries
4. Verify they have been deleted

**Assertions**:

- Entries with past `expireAt` are deleted by MongoDB
- Entries with future `expireAt` remain

### INT-5: Alert System Dispatch

**Objective**: Verify critical audit events trigger webhook and Slack alerts.

**Steps**:

1. Create InMemoryAuditStore with AlertConfig pointing to mock HTTP server
2. Log a critical event (matching `AlertConfig.criticalEvents`)
3. Log a non-critical event
4. Verify mock server received alert for critical event only

**Assertions**:

- Webhook receives POST with AlertPayload for critical events
- Slack webhook receives Block Kit formatted message
- Non-critical events do not trigger alerts
- Alert failure does not block audit logging

### INT-6: ClickHouseAuditStore Query with Tenant Scoping

**Objective**: Verify ClickHouse audit queries correctly filter by tenant.

**Steps**:

1. Create ClickHouseAuditStore with mocked ClickHouse client
2. Insert events for tenant A and tenant B
3. Query for tenant A events
4. Verify only tenant A events returned

**Assertions**:

- WHERE clause includes `tenant_id` filter
- Parameterized queries prevent SQL injection
- `max_execution_time` setting is applied

### INT-7: Studio Audit Service Error Recovery

**Objective**: Verify Studio audit service falls back to stderr when primary logging fails.

**Steps**:

1. Inject a failing shared audit writer at the Studio audit-service boundary
2. Call `logAuditEvent()` with a test event
3. Verify the event was written to stderr as JSON
4. Verify the caller was not affected (no exception thrown)

**Assertions**:

- stderr contains JSON with `type: 'audit_fallback'`
- stderr contains event action and userId
- No exception propagated to caller

---

## Coverage Gap Analysis

No critical or important implementation blockers remain for the current hardening scope. The highest-risk gaps called out in the original plan are now covered by real HTTP E2E tests and retention contract checks.

### Optional Future Enhancements

| #   | Opportunity                               | Why it could still help                                                  |
| --- | ----------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Direct InMemory query/summary suite       | Makes dev/test-only backend behavior easier to reason about explicitly   |
| 2   | Crawl model-level schema regression       | Adds extra guardrails if crawl operational-history requirements change   |
| 3   | Dedicated contact-emitter unit suite      | Helps if the DDD audit port expands beyond current route/wiring checks   |
| 4   | Full KMS operation HTTP/system E2E        | Would complement the existing KMS writer tests and retention contracts   |
| 5   | Full Studio sanitization public-route E2E | Would verify redaction through a public workflow instead of service-only |

---

## What Good Looks Like

A passing audit E2E test should:

1. Start a real Express server with audit store singleton initialized
2. Perform an auditable operation (e.g., create a session via API)
3. Query the audit API to verify the event was recorded
4. Verify the audit event has all required fields populated correctly
5. Verify tenant isolation: audit events from tenant A are not visible to tenant B
6. Verify fire-and-forget: audit write failure does not cause the operation to fail

A passing audit integration test should:

1. Test real service boundaries (store implementations with real or in-memory databases)
2. Verify query filtering, pagination, and aggregation accuracy
3. Test selective backend availability and strict pipeline behavior
4. Verify TTL behavior with real MongoDB TTL indexes

---

## Environment Requirements

- MongoDB: Required for PII audit tests and Studio/Admin HTTP harness setup
- ClickHouse: Required for ClickHouseAuditStore tests and KMS audit tests (can be mocked)
- No special environment variables needed beyond standard runtime configuration
- Admin auth context needed for admin API tests
- Studio auth context needed for Studio API tests
