# Contacts Management — Implementation Plan (LLD)

> **Feature:** #49 Contacts Management
> **Date:** 2026-03-23
> **HLD:** `docs/specs/contacts.hld.md`
> **Test Spec:** `docs/testing/contacts.md`
> **Feature Spec:** `docs/features/contacts.md`

---

## Goal

Fix identified security gaps, consolidate duplicate store layers, add missing RBAC and rate limiting, replace console.error with structured logging, and implement comprehensive E2E + integration test coverage for the contacts feature.

## Tech Stack

- Node.js/TypeScript, Express, MongoDB/Mongoose, Redis (ioredis), ClickHouse
- Vitest for testing, MongoMemoryServer for test MongoDB instances
- `@agent-platform/shared` EncryptionService for crypto operations

---

## Phase Overview

| Phase | Name                  | Description                                                            | Independent?       | Est. Effort |
| ----- | --------------------- | ---------------------------------------------------------------------- | ------------------ | ----------- |
| 1     | Security Hardening    | Fix tenant isolation gaps, add RBAC to merge routes, add rate limiting | Yes                | 1 day       |
| 2     | Code Quality          | Replace console.error with createLogger, consolidate dual store layers | Yes                | 1 day       |
| 3     | Integration Tests     | INT-01 through INT-07 from test spec                                   | Depends on Phase 1 | 2 days      |
| 4     | E2E Tests             | E2E-01 through E2E-08 from test spec                                   | Depends on Phase 1 | 3 days      |
| 5     | Pagination and Polish | Add pagination to merge suggestions, add Prometheus metrics            | Yes                | 1 day       |

---

## Phase 1: Security Hardening

### Task 1.1: Fix MongoContactStore Tenant Isolation

**Addresses:** GAP-01, GAP-02 from feature spec

**Files:**

- Modify: `apps/runtime/src/services/stores/mongo-contact-store.ts`

**Changes:**

- [ ] Fix `delete()` method to use `findOneAndDelete({ _id: id, tenantId })` instead of `findByIdAndDelete(id)`. Add `tenantId` parameter.
- [ ] Fix `touchLastSeen()` method to use `findOneAndUpdate({ _id: id, tenantId }, ...)` instead of `findByIdAndUpdate(id, ...)`. Add `tenantId` parameter.
- [ ] Update all callers of `delete()` and `touchLastSeen()` to pass `tenantId`.

**Caller Updates:**

- `apps/runtime/src/routes/contacts.ts` line 459: `contactStore.touchLastSeen(req.params.id)` must pass `req.tenantContext!.tenantId`

**Exit Criteria:**

- [ ] `delete()` and `touchLastSeen()` both include tenantId in query filter
- [ ] No remaining `findByIdAndDelete` or `findByIdAndUpdate` calls in mongo-contact-store.ts
- [ ] Build succeeds (`pnpm build --filter=@agent-platform/runtime`)

### Task 1.2: Add RBAC to Merge and GDPR Routes

**Addresses:** GAP-04 from feature spec

**Files:**

- Modify: `apps/runtime/src/routes/contact-merge.ts`
- Modify: `apps/runtime/src/routes/merge-suggestions.ts`

**Changes:**

- [ ] Import `requirePermissionInline` from `../middleware/rbac.js` in contact-merge.ts
- [ ] Add permission check at the start of each route handler:
  - POST `/merge`: `requirePermissionInline(req, res, 'agent:execute')`
  - POST `/:id/self-merge`: `requirePermissionInline(req, res, 'agent:execute')`
  - DELETE `/:id/gdpr`: `requirePermissionInline(req, res, 'agent:execute')`
- [ ] Import `requirePermissionInline` in merge-suggestions.ts
- [ ] Add permission check to PUT `/:id` (accept/reject): `requirePermissionInline(req, res, 'agent:execute')`

**Exit Criteria:**

- [ ] All merge/GDPR endpoints check RBAC before processing
- [ ] Unauthorized requests receive 403 response
- [ ] Build succeeds

### Task 1.3: Add Rate Limiting to Merge and GDPR Routes

**Addresses:** GAP-05 from feature spec

**Files:**

- Modify: `apps/runtime/src/routes/contact-merge.ts`
- Modify: `apps/runtime/src/routes/merge-suggestions.ts`

**Changes:**

- [ ] Import `tenantRateLimit` from `../middleware/rate-limiter.js` (or equivalent)
- [ ] Add `router.use(tenantRateLimit('request'))` at the top of each factory-created router, after the auth middleware check
- [ ] For GDPR delete specifically, consider a stricter rate limit (e.g., 10 req/min per tenant)

**Exit Criteria:**

- [ ] Rate limiting middleware applied to merge and suggestion routes
- [ ] Build succeeds

---

## Phase 2: Code Quality

### Task 2.1: Replace console.error with Structured Logging

**Addresses:** GAP-03 from feature spec

**Files:**

- Modify: `apps/runtime/src/routes/contacts.ts` (6 instances of `console.error`)
- Modify: `apps/runtime/src/routes/contact-merge.ts` (3 instances of `console.error`)
- Modify: `apps/runtime/src/routes/merge-suggestions.ts` (2 instances of `console.error`)
- Modify: `apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts` (1 instance of `console.error`)
- Modify: `apps/runtime/src/contexts/contact/use-cases/execute-merge.ts` (1 instance of `console.error`)
- Modify: `apps/runtime/src/contexts/contact/use-cases/self-merge.ts` (2 instances of `console.error`)

**Changes:**

- [ ] Add `import { createLogger } from '@abl/compiler/platform'` to each file that lacks it
- [ ] Create logger instance: `const log = createLogger('<module-name>')` per file
- [ ] Replace all `console.error(...)` with `log.error('message', { error: err instanceof Error ? err.message : String(err), ...context })` using the correct logger signature (message first, context object second)
- [ ] Verify no `console.log` or `console.error` remain in any of the above files

**Exit Criteria:**

- [ ] Zero `console.error` or `console.log` calls in contact-related runtime files
- [ ] All error logging uses `createLogger` with structured context
- [ ] Build succeeds

### Task 2.2: Consolidate Dual Store Layers (Optional)

**Addresses:** GAP-08 from feature spec

**Files:**

- `apps/runtime/src/services/stores/mongo-contact-store.ts` (legacy adapter)
- `apps/runtime/src/contexts/contact/infrastructure/contact-mongo-repository.ts` (domain adapter)
- `apps/runtime/src/services/stores/store-factory.ts` (wiring)
- `apps/runtime/src/routes/contacts.ts` (consumer)

**Assessment:**
The CRUD routes use `MongoContactStore` via the store factory. The merge/GDPR routes use `ContactMongoRepository` via the contact context factory. Both access the same MongoDB collection but have different APIs. Consolidation would reduce code duplication but requires touching the store factory pattern used by other store types.

**Decision:** DEFER to a separate PR. The two layers are not harmful in production -- they just add maintenance overhead. Phase 1 fixes ensure both layers enforce tenant isolation.

**Exit Criteria:**

- [ ] Decision documented and deferred

---

## Phase 3: Integration Tests

### Task 3.1: Test Infrastructure Setup

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/contact/test-helpers.ts`

**Changes:**

- [ ] Create shared test helper with:
  - `createTestEncryptionService()`: returns EncryptionService with random test master key
  - `createTestContactRepo(model)`: returns ContactMongoRepository with MongoMemoryServer model
  - `createTestContact(overrides)`: factory for domain Contact objects
  - MongoMemoryServer setup/teardown helpers

**Exit Criteria:**

- [ ] Helper file compiles and exports all utilities
- [ ] MongoMemoryServer connects and disconnects cleanly

### Task 3.2: INT-01 — ResolveOrCreateContact with Encryption

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/contact/resolve-or-create.integration.test.ts`

**Changes:**

- [ ] Test: resolves existing contact by blind index (email normalization)
- [ ] Test: creates new contact when no match found
- [ ] Test: different tenants create separate contacts for same email
- [ ] Test: encrypted value differs from plaintext
- [ ] Test: blind index is deterministic for same tenant + value

**Exit Criteria:**

- [ ] All 5 tests pass
- [ ] Uses real EncryptionService and MongoMemoryServer
- [ ] No mocking of codebase components

### Task 3.3: INT-02 — ExecuteMerge with Session Reassignment

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/contact/execute-merge.integration.test.ts`

**Changes:**

- [ ] Test: merge deduplicates identities by blind index
- [ ] Test: merge combines session counts
- [ ] Test: secondary has mergedInto set and is soft-deleted
- [ ] Test: channel history is merged (union)
- [ ] Test: session reassigner callback invoked with correct IDs

**Exit Criteria:**

- [ ] All 5 tests pass
- [ ] Uses MongoMemoryServer

### Task 3.4: INT-03 — CascadeDeleteContact

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/contact/cascade-delete.integration.test.ts`

**Changes:**

- [ ] Test: hard-delete removes document from MongoDB
- [ ] Test: encryption salt nullified before deletion
- [ ] Test: audit callback receives correct event
- [ ] Test: message scrub callback invoked
- [ ] Test: ClickHouse cleanup callback invoked (when provided)

**Exit Criteria:**

- [ ] All 5 tests pass
- [ ] Callbacks are real functions (not vi.mock stubs), using callback tracking

### Task 3.5: INT-04 — ContactContextService with Redis Cache

**Files:**

- Create: `apps/runtime/src/__tests__/services/contact-context-service.integration.test.ts`

**Changes:**

- [ ] Test: cache miss returns null, then DB hit returns context
- [ ] Test: cache hit returns context without DB query
- [ ] Test: update writes to DB and invalidates cache
- [ ] Test: invalidation removes cache entry
- [ ] Test: Redis failure falls through to DB (fail-open)

**Exit Criteria:**

- [ ] All 5 tests pass
- [ ] Uses in-memory Redis mock implementing RedisLike interface (DI, not vi.mock)
- [ ] Uses MongoMemoryServer for DB

### Task 3.6: INT-05 — SelfMerge Identity Resolution

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/contact/self-merge.integration.test.ts`

**Changes:**

- [ ] Test: merges when identity owned by another contact
- [ ] Test: picks more recently seen contact as primary
- [ ] Test: returns merged=false when identity already owned by current contact
- [ ] Test: adds new identity when no conflict
- [ ] Test: returns error when current contact not found

**Exit Criteria:**

- [ ] All 5 tests pass
- [ ] Uses real EncryptionService and MongoMemoryServer

### Task 3.7: INT-06 — ContactMongoRepository Tenant Isolation

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/contact/repo-tenant-isolation.integration.test.ts`

**Changes:**

- [ ] Test: findById returns null for wrong tenant
- [ ] Test: findByBlindIndex returns null for wrong tenant
- [ ] Test: softDelete has no effect for wrong tenant
- [ ] Test: hardDelete has no effect for wrong tenant
- [ ] Test: contact still exists for correct tenant after cross-tenant operations

**Exit Criteria:**

- [ ] All 5 tests pass
- [ ] Demonstrates 404 (not 403) pattern

### Task 3.8: INT-07 — DetectMergeCandidates

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/contact/detect-merge-candidates.integration.test.ts`

**Changes:**

- [ ] Test: finds contacts sharing blind indexes
- [ ] Test: excludes soft-deleted contacts
- [ ] Test: excludes contacts from other tenants
- [ ] Test: returns multiple candidates when overlap exists
- [ ] Test: returns empty for no overlaps

**Exit Criteria:**

- [ ] All 5 tests pass

---

## Phase 4: E2E Tests

### Task 4.1: E2E Test Infrastructure

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/contacts/test-server.ts`

**Changes:**

- [ ] Create Express server startup helper that:
  - Starts on random port (port: 0)
  - Connects to MongoMemoryServer
  - Mounts full middleware chain (auth, rate limiting, contacts routes)
  - Returns server instance and cleanup function
- [ ] Create auth token generation helper for test tenants
- [ ] Create HTTP request helpers that include auth headers

**Exit Criteria:**

- [ ] Server starts and stops cleanly
- [ ] Auth tokens are accepted by middleware chain

### Task 4.2: E2E-01 — Contact CRUD Lifecycle

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/contacts/crud-lifecycle.e2e.test.ts`

**Changes:**

- [ ] Full 8-step CRUD lifecycle from test spec E2E-01
- [ ] All assertions verified via HTTP response only (no DB queries)

**Exit Criteria:**

- [ ] 8+ assertions pass
- [ ] No `vi.mock` or direct DB access

### Task 4.3: E2E-02 — Tenant Isolation

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/contacts/tenant-isolation.e2e.test.ts`

**Changes:**

- [ ] Two tenant auth tokens
- [ ] Cross-tenant access returns 404 (all 6 steps from test spec)

**Exit Criteria:**

- [ ] 6+ assertions pass
- [ ] Cross-tenant never returns 403

### Task 4.4: E2E-03 — Contact Merge Workflow

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/contacts/merge-workflow.e2e.test.ts`

**Changes:**

- [ ] Create two contacts, merge via API, verify results
- [ ] All 6 steps from test spec

**Exit Criteria:**

- [ ] Merge endpoint returns success with execution data
- [ ] Primary has merged identities, secondary has mergedInto

### Task 4.5: E2E-04 — Self-Merge

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/contacts/self-merge.e2e.test.ts`

**Changes:**

- [ ] Create two contacts, self-merge via API
- [ ] Verify merged=true, surviving contact has identity

**Exit Criteria:**

- [ ] Self-merge returns correct response

### Task 4.6: E2E-05 — GDPR Cascade Delete

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/contacts/gdpr-delete.e2e.test.ts`

**Changes:**

- [ ] Create contact, link session, GDPR delete, verify 404

**Exit Criteria:**

- [ ] Contact completely gone after GDPR delete
- [ ] Subsequent GET returns 404

### Task 4.7: E2E-06 — Input Validation

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/contacts/validation.e2e.test.ts`

**Changes:**

- [ ] 8 validation scenarios from test spec
- [ ] Each returns 400 with structured error

**Exit Criteria:**

- [ ] All 8 validation cases return 400

### Task 4.8: E2E-07 — Contact History Pagination

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/contacts/history-pagination.e2e.test.ts`

**Changes:**

- [ ] Seed contact with messages, paginate through history
- [ ] Verify cursor-based pagination, anonymous contact returns 404

**Exit Criteria:**

- [ ] Pagination works correctly with cursor
- [ ] Anonymous contacts excluded

### Task 4.9: E2E-08 — Authentication and Authorization

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/contacts/auth.e2e.test.ts`

**Changes:**

- [ ] All 5 auth scenarios from test spec
- [ ] Unauthenticated requests return 401

**Exit Criteria:**

- [ ] All endpoints return 401 without auth

---

## Phase 5: Pagination and Polish

### Task 5.1: Add Pagination to Merge Suggestions

**Addresses:** GAP-06 from feature spec

**Files:**

- Modify: `apps/runtime/src/routes/merge-suggestions.ts`
- Modify: `apps/runtime/src/contexts/contact/infrastructure/merge-suggestion-store.ts`

**Changes:**

- [ ] Add `limit` and `offset` query parameters to GET `/` endpoint
- [ ] Default limit: 50, max limit: 1000
- [ ] Update `MergeSuggestionStore.findByTenant` to accept pagination params
- [ ] Return `{ success: true, data: [...], total: N }` response format

**Exit Criteria:**

- [ ] Merge suggestions endpoint supports pagination
- [ ] Total count returned in response

### Task 5.2: Add Contact Operation Metrics (Optional)

**Files:**

- Create or modify: `apps/runtime/src/services/metrics/contact-metrics.ts`

**Changes:**

- [ ] Counter: `contacts_operations_total` (labels: operation, status)
- [ ] Histogram: `contacts_operation_duration_seconds` (labels: operation)
- [ ] Counter: `contacts_cache_hits_total` / `contacts_cache_misses_total`
- [ ] Counter: `contacts_merge_total` (labels: type: admin|self)

**Exit Criteria:**

- [ ] Metrics exported to Prometheus
- [ ] Contact context cache hit/miss tracked

---

## Wiring Checklist

| Item                                                  | File                   | Status |
| ----------------------------------------------------- | ---------------------- | ------ |
| `MongoContactStore.delete()` includes tenantId        | mongo-contact-store.ts | TODO   |
| `MongoContactStore.touchLastSeen()` includes tenantId | mongo-contact-store.ts | TODO   |
| Merge routes check RBAC                               | contact-merge.ts       | TODO   |
| Merge suggestions route checks RBAC (PUT)             | merge-suggestions.ts   | TODO   |
| Rate limiting on merge routes                         | contact-merge.ts       | TODO   |
| Rate limiting on suggestion routes                    | merge-suggestions.ts   | TODO   |
| console.error replaced in contacts.ts                 | contacts.ts            | TODO   |
| console.error replaced in contact-merge.ts            | contact-merge.ts       | TODO   |
| console.error replaced in merge-suggestions.ts        | merge-suggestions.ts   | TODO   |
| console.error replaced in use cases                   | 3 use case files       | TODO   |
| touchLastSeen caller passes tenantId                  | contacts.ts            | TODO   |
| INT-01 through INT-07 pass                            | test files             | TODO   |
| E2E-01 through E2E-08 pass                            | test files             | TODO   |

---

## Risk Log

| Risk                                                       | Phase | Impact | Mitigation                                           |
| ---------------------------------------------------------- | ----- | ------ | ---------------------------------------------------- |
| MongoContactStore.delete() signature change breaks callers | 1     | HIGH   | Search all callers, update in same commit            |
| E2E test server startup flaky                              | 4     | MEDIUM | Use port: 0, retry with backoff, cleanup in afterAll |
| MongoMemoryServer slow in CI                               | 3-4   | LOW    | Use shared instance per suite, parallel test files   |
| Rate limiter middleware import path differs between routes | 1     | LOW    | Verify import path from existing contacts.ts usage   |
