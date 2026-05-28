# LLD + Implementation Plan: Webhook System

**Feature:** `webhook-system`
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22
**Phases:** 5

---

## Pre-Implementation Checklist

- [x] Feature spec exists: `docs/features/webhook-system.md`
- [x] Test spec exists: `docs/testing/webhook-system.md`
- [x] HLD exists: `docs/specs/webhook-system.hld.md`
- [x] Core infrastructure implemented (models, routes, workers, security)
- [ ] E2E tests written
- [ ] Integration tests written
- [ ] Circuit breaker / auto-disable threshold
- [ ] Session lifecycle events wired (session.completed, session.escalated)
- [ ] Delivery rate limiting per subscription

---

## Phase 1: Test Infrastructure & Signature Verification Tests

**Goal:** Establish test infrastructure for E2E and integration testing of the webhook system. Verify HMAC signature round-trip.

### Tasks

1. **Create E2E test helper: local webhook receiver server**
   - File: `apps/runtime/src/__tests__/helpers/webhook-test-server.ts`
   - Starts an HTTP server on a random port that records received requests
   - Supports configurable response codes (200, 410, 500) for retry testing
   - Provides `getReceivedRequests()`, `waitForDelivery(timeout)`, `reset()`, `close()`
   - No mocking — real HTTP server

2. **Create E2E test helper: test tenant setup**
   - File: `apps/runtime/src/__tests__/helpers/webhook-test-setup.ts`
   - Creates test tenant, project, and auth context via API
   - Provides `createSubscription(callbackUrl)` and `sendMessage(subscriptionId, message)` helpers
   - All interactions via HTTP API (no direct DB access)

3. **Integration test: HMAC signature round-trip (INT-4)**
   - File: `apps/runtime/src/__tests__/integration/webhook-signature.test.ts`
   - Tests `generateWebhookSecret()`, `buildSignatureHeaders()`, `verifyWebhookSignature()`
   - Tests tampered body detection, replay protection, wrong-length signatures
   - Uses real `@agent-platform/shared-kernel/security` package

4. **Integration test: Callback URL SSRF validation (INT-6)**
   - File: `apps/runtime/src/__tests__/integration/callback-url-policy.test.ts`
   - Tests all SSRF rejection scenarios (private IPs, localhost, metadata, DNS resolution)
   - Tests production vs dev mode behavior
   - Uses real `assertAllowedCallbackUrl()` function

### Exit Criteria

- [ ] Webhook test server starts on random port and records requests
- [ ] Test setup helper creates subscriptions via API
- [ ] Signature round-trip test passes (sign → verify → tamper → reject)
- [ ] SSRF validation test passes for all blocked IP ranges
- [ ] All tests pass: `pnpm test --filter=runtime -- --grep "webhook"`

---

## Phase 2: Subscription CRUD Integration & E2E Tests

**Goal:** Verify subscription lifecycle management end-to-end.

### Tasks

1. **Integration test: Subscription CRUD with real MongoDB (INT-3)**
   - File: `apps/runtime/src/__tests__/integration/webhook-subscription-crud.test.ts`
   - Tests create, list, get, update, deactivate via HTTP API
   - Verifies encryption plugin encrypts secrets
   - Verifies tenant isolation on all operations
   - Uses MongoMemoryServer for isolated MongoDB

2. **E2E test: Tenant isolation (E2E-3)**
   - File: `apps/runtime/src/__tests__/e2e/webhook-tenant-isolation.test.ts`
   - Two separate tenant contexts
   - Cross-tenant GET/PATCH/DELETE all return 404
   - Original subscription unchanged after cross-tenant attempts

3. **E2E test: Subscription lifecycle (E2E-5)**
   - File: `apps/runtime/src/__tests__/e2e/webhook-subscription-lifecycle.test.ts`
   - Create → deliver → pause → no delivery → resume → deliver → deactivate → no delivery
   - Uses webhook test server from Phase 1

4. **E2E test: SSRF protection (E2E-2)**
   - File: `apps/runtime/src/__tests__/e2e/webhook-ssrf-protection.test.ts`
   - Tests all blocked URL patterns via the subscribe endpoint
   - Verifies 400 responses with meaningful error messages

### Exit Criteria

- [ ] Subscription CRUD integration test passes with real MongoDB
- [ ] Tenant isolation E2E: cross-tenant access returns 404
- [ ] Subscription lifecycle E2E: pause/resume/deactivate controls delivery
- [ ] SSRF E2E: all private/reserved IPs rejected at subscribe time
- [ ] All tests pass: `pnpm test --filter=runtime -- --grep "webhook"`

---

## Phase 3: Delivery Pipeline Integration & E2E Tests

**Goal:** Verify the full message-to-delivery pipeline including retry behavior.

### Tasks

1. **Integration test: Delivery worker (INT-1)**
   - File: `apps/runtime/src/__tests__/integration/webhook-delivery-worker.test.ts`
   - Creates subscription + delivery record in MongoDB
   - Enqueues job to BullMQ
   - Starts delivery worker
   - Verifies webhook received with correct signature headers
   - Verifies delivery record updated (status, httpStatus, attempts)

2. **Integration test: Inbound worker → delivery queue (INT-2)**
   - File: `apps/runtime/src/__tests__/integration/webhook-inbound-worker.test.ts`
   - Creates channel connection + subscription in MongoDB
   - Enqueues inbound job
   - Verifies delivery record created and delivery job enqueued
   - Agent execution mocked at runtime boundary only (not codebase components)

3. **E2E test: Full message flow (E2E-1)**
   - File: `apps/runtime/src/__tests__/e2e/webhook-full-flow.test.ts`
   - Subscribe → send message → receive delivery at test server
   - Verify payload structure, signature headers, and HMAC verification
   - Verify delivery status via API

4. **E2E test: Delivery retry on 5xx (E2E-4)**
   - File: `apps/runtime/src/__tests__/e2e/webhook-retry.test.ts`
   - Test server returns 500 for first N requests, then 200
   - Verify retry count and eventual success
   - Verify delivery record shows correct attempt count

5. **E2E test: 410 Gone auto-deactivation (E2E-7)**
   - File: `apps/runtime/src/__tests__/e2e/webhook-410-deactivation.test.ts`
   - Test server returns 410 Gone
   - Verify subscription status changed to `deactivated`
   - Verify delivery marked as failed

### Exit Criteria

- [ ] Delivery worker integration test passes with real Redis + MongoDB
- [ ] Inbound worker integration test verifies delivery record creation
- [ ] Full flow E2E: subscribe → send → receive → verify signature
- [ ] Retry E2E: 5xx triggers retry, eventual delivery succeeds
- [ ] 410 E2E: subscription auto-deactivated
- [ ] All tests pass: `pnpm test --filter=runtime -- --grep "webhook"`

---

## Phase 4: Idempotency, Auth Profile, & Queue Configuration Tests

**Goal:** Test advanced features — idempotency, auth profile dual-read, and queue configuration.

### Tasks

1. **E2E test: Idempotency (E2E-6)**
   - File: `apps/runtime/src/__tests__/e2e/webhook-idempotency.test.ts`
   - Duplicate `idempotency_key` returns 409
   - Test server receives exactly one delivery
   - Different keys process independently

2. **Integration test: Auth profile dual-read (INT-5)**
   - File: `apps/runtime/src/__tests__/integration/webhook-auth-profile.test.ts`
   - Subscription with `authProfileId` uses auth profile secret
   - Fallback to legacy encrypted secret on auth profile failure
   - Warning log emitted on fallback

3. **Integration test: Queue configuration (INT-7)**
   - File: `apps/runtime/src/__tests__/integration/webhook-queue-config.test.ts`
   - Verify queue initialization with correct retry/backoff settings
   - Verify `removeOnComplete` and `removeOnFail` options

4. **Update testing README**
   - Add webhook-system entry to `docs/testing/README.md` feature index

### Exit Criteria

- [ ] Idempotency E2E: duplicate keys return 409, single delivery
- [ ] Auth profile integration: dual-read with graceful fallback
- [ ] Queue config integration: correct retry/backoff settings
- [ ] Testing README updated
- [ ] All tests pass: `pnpm test --filter=runtime -- --grep "webhook"`

---

## Phase 5: Session Lifecycle Events & Documentation Sync

**Goal:** Wire `session.completed` and `session.escalated` event types into the delivery pipeline. Update all documentation.

### Tasks

1. **Wire session.completed event delivery**
   - Location: `apps/runtime/src/services/execution/` (completion detector callback)
   - When the completion detector fires, check if the session has an HTTP Async channel binding
   - If so, create a WebhookDelivery record with `eventType: 'session.completed'` and enqueue
   - The subscription must include `session.completed` in its events array

2. **Wire session.escalated event delivery**
   - Location: `apps/runtime/src/services/execution/` (handoff/escalation path)
   - When agent transfer is initiated, check for HTTP Async channel binding
   - Create WebhookDelivery record with `eventType: 'session.escalated'` and enqueue

3. **Update subscription creation to accept new event types**
   - Location: `apps/runtime/src/routes/http-async-channel.ts`
   - Expand `validEvents` to include `session.completed`, `session.escalated`, `delivery.failed`
   - Delivery worker already handles all `WebhookEventType` values

4. **Add integration tests for session lifecycle events**
   - File: `apps/runtime/src/__tests__/integration/webhook-session-events.test.ts`
   - Test session.completed delivery
   - Test session.escalated delivery
   - Test event filtering (subscription without session.completed doesn't receive it)

5. **Documentation sync**
   - Update feature spec status
   - Update test spec with new test results
   - Run `post-impl-sync` to align all docs

### Exit Criteria

- [ ] session.completed events delivered for HTTP Async sessions
- [ ] session.escalated events delivered on agent transfer
- [ ] Subscription creation accepts expanded event types
- [ ] Integration tests pass for session lifecycle events
- [ ] All docs updated to reflect implementation reality
- [ ] Feature status promoted to BETA (if all criteria met)

---

## Wiring Checklist

| Component                    | Wired To                                      | Verification                              |
| ---------------------------- | --------------------------------------------- | ----------------------------------------- |
| `WebhookSubscription` model  | `http-async-channel.ts` routes                | Subscription CRUD works                   |
| `WebhookDelivery` model      | `delivery-worker.ts`, `inbound-worker.ts`     | Delivery records created and updated      |
| `channel-inbound` queue      | `inbound-worker.ts`                           | Messages processed from queue             |
| `webhook-delivery` queue     | `delivery-worker.ts`                          | Deliveries processed from queue           |
| `buildSignatureHeaders()`    | `delivery-worker.ts`                          | Signatures included in outbound POST      |
| `assertAllowedCallbackUrl()` | `http-async-channel.ts`, `delivery-worker.ts` | SSRF checked at registration and delivery |
| `authMiddleware`             | `http-async-channel.ts`                       | Auth required on all endpoints            |
| `requirePermission()`        | `http-async-channel.ts`                       | Permissions checked per endpoint          |
| `tenantRateLimit()`          | `http-async-channel.ts`                       | Rate limiting active                      |
| `auditSubscription*()`       | `http-async-channel.ts`                       | Audit trail for CRUD operations           |
| `encryptionPlugin`           | `WebhookSubscription` schema                  | Secrets encrypted at rest                 |
| `tenantIsolationPlugin`      | Both models                                   | tenantId enforced on all operations       |
| Completion detector          | Phase 5                                       | `session.completed` events                |
| Handoff executor             | Phase 5                                       | `session.escalated` events                |

## Risk Register

| Risk                                                     | Impact                              | Mitigation                                                                   |
| -------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| E2E tests require full runtime stack                     | High setup complexity               | Provide dedicated test helpers; document docker-compose test config          |
| Auth profile service may not be available in test env    | Tests fail for INT-5                | Mock auth profile service at DI boundary only                                |
| BullMQ timing in tests                                   | Flaky tests                         | Use `waitForDelivery()` with configurable timeout; poll delivery status      |
| Completion detector / handoff executor internals complex | Phase 5 may be harder than expected | Read source before wiring; use existing trace patterns                       |
| DNS resolution in SSRF tests                             | Non-deterministic                   | Use IP literals for blocked tests; mock DNS only for resolution bypass tests |

## Dependencies Between Phases

```
Phase 1 (Test Infrastructure) ──► Phase 2 (CRUD Tests)
                                     │
Phase 1 ─────────────────────────► Phase 3 (Delivery Pipeline Tests)
                                     │
Phase 2 + Phase 3 ──────────────► Phase 4 (Advanced Features)
                                     │
Phase 4 ─────────────────────────► Phase 5 (Session Events + Doc Sync)
```

Phases 2 and 3 can run in parallel after Phase 1 is complete.
