# Low-Level Design + Implementation Plan: Connectors Platform

**Feature ID:** F006
**Slug:** connectors
**Status:** BETA
**Date:** 2026-03-22
**HLD Reference:** `docs/specs/connectors.hld.md`
**Test Spec Reference:** `docs/testing/connectors.md`

---

## Executive Summary

The Connectors Platform is functionally complete (18/18 core implementation tasks done, 34 test files). This LLD focuses on hardening the existing implementation to production-grade quality by addressing the 10 open questions identified in the HLD, closing E2E test gaps, and fixing code quality violations.

The plan is organized into 5 phases with explicit exit criteria. Each phase is independently shippable.

---

## Phase 1: Code Quality Hardening (Priority: P0)

**Goal**: Fix CLAUDE.md violations and tech debt identified in HLD open questions OQ-3, OQ-4, OQ-6.

### Task 1.1: Fix Delta Sync Scheduler Logging

**File:** `apps/search-ai/src/scheduler/connector-delta-sync.ts`

**Current state:** Uses `console.log` and `console.error` (violates CLAUDE.md rule: "Never console.log in server code").

**Changes:**

1. Import `createLogger` from `@agent-platform/database` or `@abl/compiler/platform`
2. Replace all `console.log('[delta-sync-scheduler]...)` with `log.info('...',  { context })`
3. Replace `console.error(...)` with `log.error('...', { context, error: err instanceof Error ? err.message : String(err) })`
4. Use structured log context objects instead of string interpolation

**Exit criteria:**

- Zero `console.log` or `console.error` calls in the file
- All log calls use structured context objects
- `pnpm build --filter=search-ai` passes

### Task 1.2: Fix Delta Sync Scheduler Tenant Isolation

**File:** `apps/search-ai/src/scheduler/connector-delta-sync.ts`

**Current state:** `checkForDeltaTokens()` at line 122 calls `DriveDeltaToken.countDocuments({ connectorId })` without tenantId. `cleanupOrphanedDeltaTokens()` at line 158 calls `ConnectorConfig.findOne({ _id: connectorId })` without tenantId.

**Changes:**

1. `checkForDeltaTokens()`: Add `tenantId` parameter; include in countDocuments filter
2. `cleanupOrphanedDeltaTokens()`: Include `tenantId` in `ConnectorConfig.findOne()` filter
3. Pass `connector.tenantId` to these functions from the caller

**Exit criteria:**

- All DB queries include `tenantId` in filter
- No `findById` or `findOne({ _id })` without tenantId
- Existing tests pass

### Task 1.3: Add ConnectorRegistry Size Bounds

**File:** `packages/connectors/src/registry.ts`

**Current state:** `ConnectorRegistry` uses an unbounded `Map<string, Connector>`. CLAUDE.md requires: "Every in-memory Map needs max size, TTL, and eviction."

**Changes:**

1. Add `MAX_REGISTRY_SIZE` constant (default: 500 -- well above the 25 AP pieces + native connectors)
2. In `register()`, check `this.connectors.size >= MAX_REGISTRY_SIZE` and throw if exceeded
3. Add a note that TTL and eviction are not applicable since connectors are loaded once at boot and never change

**Exit criteria:**

- `register()` enforces max size
- Comment documenting why TTL/eviction are not applicable
- Existing registry tests pass + new test for max size enforcement

### Task 1.4: Fix SearchAI Connector Repository Isolation Gaps

**File:** `apps/search-ai/src/repos/connector.repository.ts`

**Current state:** `findOAuthTokenByFilter()` at line 151 accepts a raw filter without enforcing `tenantId` -- the caller must provide it.

**Changes:**

1. Change `findOAuthTokenByFilter()` to require `tenantId` as a named parameter
2. Ensure `tenantId` is always included in the filter
3. Review all callers to verify they pass `tenantId`

**Exit criteria:**

- All exported repository functions require `tenantId` as a parameter
- No path allows a query without tenant scoping

### Phase 1 Exit Criteria

- [ ] Zero `console.log`/`console.error` in delta sync scheduler
- [ ] All delta sync DB queries include `tenantId`
- [ ] ConnectorRegistry has max size enforcement
- [ ] All connector repository functions enforce `tenantId`
- [ ] `pnpm build --filter=search-ai --filter=@agent-platform/connectors` passes
- [ ] All existing tests pass

---

## Phase 2: Observability and Security Hardening (Priority: P0)

**Goal**: Address HLD gaps OQ-1, OQ-5, OQ-7, OQ-8.

### Task 2.1: Add OpenTelemetry Spans to Connector Execution

**Files:**

- `packages/connectors/src/executor/connector-tool-executor.ts`
- `packages/connectors/src/triggers/webhook-handler.ts`

**Changes:**

1. Import `trace` from `@opentelemetry/api` (or the platform's shared tracing module)
2. In `ConnectorToolExecutor.execute()`: create span `connector.execute` with attributes `connector.name`, `action.name`, `tenant.id`, `connection.scope`, `execution.id`
3. In `handleWebhook()`: create span `connector.webhook` with attributes `connector.name`, `registration.id`, `tenant.id`
4. Set span status to ERROR on failure; record exception details
5. Propagate trace context through ActionContext (add optional `traceContext` field)

**Exit criteria:**

- Connector execution produces OTel spans
- Webhook processing produces OTel spans
- Span attributes include tenant, connector, and action identifiers

### Task 2.2: WebhookDelivery Retention Policy

**File:** New scheduler job or extension to existing cleanup scheduler

**Changes:**

1. Add a `WEBHOOK_DELIVERY_RETENTION_DAYS` constant (default: 30)
2. Create a scheduled cleanup function that deletes `WebhookDelivery` documents older than retention period
3. Add `tenantId` index on WebhookDelivery model if not present
4. Wire into the existing scheduler infrastructure

**Exit criteria:**

- WebhookDelivery documents are automatically cleaned up after retention period
- Cleanup is tenant-scoped
- Scheduler runs weekly (same cadence as `cleanupOrphanedDeltaTokens`)

### Task 2.3: Encryption Key Rotation Procedure

**File:** New utility in `packages/connectors/src/auth/` or `packages/shared/`

**Changes:**

1. Document the key rotation procedure
2. Implement a `rotateEncryptionKey()` utility that:
   - Reads all connections with `encryptionKeyVersion < currentVersion`
   - Decrypts with old key, re-encrypts with new key
   - Updates `encryptionKeyVersion`
   - Processes in batches (100 at a time) to avoid memory pressure
3. Add CLI command `connector rotate-keys --tenant-id=<id>` or make it a scheduled job

**Exit criteria:**

- Key rotation utility exists and is documented
- Batch processing prevents memory issues
- Can be run per-tenant or globally

### Task 2.4: Add Circuit Breaker for External API Calls

**File:** `packages/connectors/base/src/client/` (new file or extension of http-client.ts)

**Changes:**

1. Implement a circuit breaker using the existing `@agent-platform/circuit-breaker` package
2. Configure per-connector: threshold (5 failures), reset timeout (60s), half-open limit (1)
3. Wire into `BaseHttpClient` so all enterprise connector API calls pass through the breaker
4. Emit log events on state transitions (closed -> open, open -> half-open, half-open -> closed)

**Exit criteria:**

- External API calls protected by circuit breaker
- Circuit state transitions are logged
- Unit tests for breaker state machine

### Phase 2 Exit Criteria

- [ ] Connector execution produces OTel spans
- [ ] WebhookDelivery has retention policy with automated cleanup
- [ ] Encryption key rotation utility implemented and documented
- [ ] Circuit breaker protects external API calls
- [ ] All existing tests pass

---

## Phase 3: E2E Test Implementation (Priority: P0)

**Goal**: Implement the top-priority E2E tests from `docs/testing/connectors.md`.

### Task 3.1: E2E-1 -- Connection CRUD Lifecycle

**File:** `packages/connectors/src/__tests__/e2e/connection-crud.e2e.test.ts` (new)

**Implementation:**

1. Start a real Express server with connection routes, auth middleware, and tenant isolation
2. Use MongoMemoryServer for the database
3. Test full CRUD lifecycle: create, list, get, update, delete
4. Test tenant isolation: different tenant cannot access the connection
5. Test project isolation: different project cannot access the connection
6. Verify credentials are never returned in response body

**Exit criteria:**

- 10+ assertions covering CRUD, isolation, and credential redaction
- Server starts on random port with full middleware chain
- No mocks of codebase components

### Task 3.2: E2E-4 -- Webhook Trigger End-to-End

**File:** `packages/connectors/src/__tests__/e2e/webhook-trigger.e2e.test.ts` (new)

**Implementation:**

1. Start Express server with webhook route
2. Start mock Restate ingress server
3. Start Redis for dedup
4. Seed trigger registration with webhook secret
5. Test: valid webhook with correct HMAC -> 200 + workflow invocation
6. Test: replay with same event ID -> 200 + deduplicated
7. Test: invalid HMAC -> 401
8. Test: stale timestamp -> 401
9. Test: consecutive failures -> auto-pause

**Exit criteria:**

- All 5 webhook security scenarios tested
- Real Redis used for dedup
- Mock Restate verifies workflow invocation payload

### Task 3.3: E2E-6 -- Connection Test Lifecycle

**File:** `packages/connectors/src/__tests__/e2e/connection-test.e2e.test.ts` (new)

**Implementation:**

1. Register a test connector with a `test_connection` action that calls a mock external server
2. Seed connections in active and expired states
3. Test: successful test -> `{ success: true, latencyMs }` + status stays active
4. Test: failed test (mock returns error) -> `{ success: false }` + status changes to expired
5. Test: nonexistent connection -> 404
6. Test: cross-tenant -> 404

**Exit criteria:**

- Connection status transitions verified via subsequent GET
- Latency measurement is non-zero
- Tenant isolation enforced

### Phase 3 Exit Criteria

- [ ] E2E-1 (Connection CRUD) passes with 10+ assertions
- [ ] E2E-4 (Webhook Trigger) passes with 5+ security scenarios
- [ ] E2E-6 (Connection Test) passes with 4+ scenarios
- [ ] All E2E tests start real servers on random ports
- [ ] Zero mocks of codebase components in E2E tests

---

## Phase 4: Integration Test Implementation (Priority: P1)

**Goal**: Implement the top-priority integration tests from `docs/testing/connectors.md`.

### Task 4.1: INT-1 -- OAuth2 Refresh with Distributed Lock

**File:** `packages/connectors/src/__tests__/integration/oauth-refresh-lock.integration.test.ts` (new)

**Implementation:**

1. Start real Redis (or redis-memory-server)
2. Seed a ConnectorConnection with near-expired OAuth2 token
3. Create a mock OAuth provider HTTP server that counts requests
4. Call `connectionResolver.resolveAuth()` concurrently from 3 callers
5. Assert mock provider received exactly 1 refresh request
6. Assert all 3 callers received valid credentials

**Exit criteria:**

- Distributed lock prevents concurrent refresh
- Test uses real Redis, not a mock
- Concurrent execution verified via Promise.all

### Task 4.2: INT-4 -- Credential Encryption Round-Trip

**File:** `packages/connectors/src/__tests__/integration/credential-encryption.integration.test.ts` (new)

**Implementation:**

1. Use MongoMemoryServer
2. Create a real encryption service with test keys
3. Create a connection with credentials
4. Read raw DB document to verify encryption
5. Test via ConnectionService to verify decryption
6. Test completeOAuthSetup for token encryption
7. Verify encryptionKeyVersion is set

**Exit criteria:**

- Raw DB document contains only encrypted data
- Round-trip: encrypt -> store -> decrypt -> original
- Both access and refresh tokens encrypted

### Task 4.3: INT-2 -- Connection Resolution Priority

**File:** `packages/connectors/src/__tests__/integration/connection-resolution.integration.test.ts` (new)

**Implementation:**

1. Use MongoMemoryServer with both user-scoped and tenant-scoped connections
2. Test with userId -> user-scoped connection
3. Test without userId -> tenant-scoped connection
4. Test with specific connectionId -> exact connection
5. Test with no connections -> descriptive error
6. Test with unknown connector -> error

**Exit criteria:**

- All 5 resolution scenarios verified
- Error messages include connector name and tenant ID

### Phase 4 Exit Criteria

- [ ] INT-1 (OAuth Refresh Lock) passes with real Redis
- [ ] INT-4 (Credential Encryption) passes with real encryption
- [ ] INT-2 (Connection Resolution) passes with 5 scenarios
- [ ] No mocks of codebase components

---

## Phase 5: Consolidation and Documentation (Priority: P2)

**Goal**: Address remaining HLD open questions and consolidate parallel OAuth implementations.

### Task 5.1: Investigate and Fix Token Manager Test

**File:** `packages/connectors/base/src/__tests__/token-manager.test.ts.skip`

**Changes:**

1. Rename to `.test.ts` (remove .skip suffix)
2. Investigate why it was skipped (likely Mongoose type issues per IMPLEMENTATION_STATUS.md)
3. Fix the underlying issues
4. Ensure it passes in CI

### Task 5.2: Document OAuth Consolidation Path (OQ-10)

**File:** New doc in `docs/plans/`

**Changes:**

1. Analyze overlap between runtime channel OAuth (Slack, MS Teams, Meta) and connector SDK OAuth
2. Document a consolidation path that uses `ConnectionResolver` for both
3. Identify breaking changes and migration steps
4. This is documentation-only; implementation deferred to a future sprint

### Task 5.3: Verify Webhook Renewal Wiring (OQ-9)

**File:** `apps/search-ai/src/scheduler/webhook-renewal.ts`

**Changes:**

1. Read the webhook renewal scheduler and trace its wiring
2. Verify it correctly renews SharePoint webhook subscriptions before expiry
3. Add integration test if not present
4. Document findings in the HLD

### Task 5.4: Update Testing README

**File:** `docs/testing/README.md`

**Changes:**

1. Add connectors entry to the Feature Index table
2. Update status to reflect E2E and integration test additions from Phases 3-4

### Phase 5 Exit Criteria

- [x] Token manager test unskipped and passing (18 tests, rewritten against current API)
- [x] OAuth consolidation path documented (`docs/plans/oauth-consolidation-path.md`)
- [x] Webhook renewal wiring verified (4 gaps documented in HLD section 9.1)
- [x] Testing README updated (test counts: 226 unit, 69 integration, 35 E2E)

---

## Implementation Summary

| Phase | Tasks | Priority | Estimated Effort | Dependencies |
| ----- | ----- | -------- | ---------------- | ------------ |
| 1     | 4     | P0       | 1 day            | None         |
| 2     | 4     | P0       | 2 days           | Phase 1      |
| 3     | 3     | P0       | 2 days           | Phase 1      |
| 4     | 3     | P1       | 1.5 days         | Phase 2      |
| 5     | 4     | P2       | 1 day            | Phases 3-4   |

**Total estimated effort:** 7.5 days

## Wiring Checklist

Every new component or modification must be verified for correct wiring:

- [ ] New E2E tests added to `vitest.config.ts` test include patterns
- [ ] New integration tests can run with `pnpm test --filter=@agent-platform/connectors`
- [ ] OpenTelemetry spans are visible in the observability dashboard
- [ ] Circuit breaker is wired into the BaseHttpClient constructor
- [ ] WebhookDelivery cleanup scheduler is registered in the scheduler index
- [ ] Encryption key rotation utility is wired into CLI commands
- [ ] Testing README reflects new test coverage

## Risk Assessment

| Risk                                            | Mitigation                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| E2E tests flaky due to port conflicts           | Use `{ port: 0 }` for random port allocation; wait for listen     |
| Redis dependency in tests                       | Use redis-memory-server or skip gracefully with clear message     |
| Circuit breaker false positives during sync     | Configure per-connector thresholds; SharePoint uses higher limits |
| Encryption key rotation data loss               | Batch processing with transaction-like retry; dry-run mode first  |
| OpenTelemetry import adds bundle size to Studio | Only add spans in server-side packages, not Studio                |
