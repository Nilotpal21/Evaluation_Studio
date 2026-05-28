# Low-Level Design & Implementation Plan: Channels

**Feature**: Channels
**Status**: STABLE (implemented system; hardening backlog remains)
**Date**: 2026-04-03
**HLD**: `docs/specs/channels.hld.md`
**Test Spec**: `docs/testing/channels.md`
**Feature Spec**: `docs/features/channels.md`

---

## 1. Current State Assessment

The channels system is substantially implemented with 27 channel types in the manifest, 18 adapter implementations, CRUD APIs, BullMQ pipeline, session resolution, Studio UI, parity-contract checks, bounded WebSocket connection managers, and a broad existing test surface.

The original March 2026 plan assumed little or no end-to-end coverage. That is no longer accurate. The current branch now includes control-plane E2E coverage, HTTP Async continuity E2E coverage, voice ingress E2E coverage, SDK WebSocket handler coverage, dispatcher tests, and deep provider/adapter suites.

The remaining backlog is now mostly:

1. **Operational hardening**: health checks, metrics, queue visibility, and connection probes
2. **Selective coverage expansion**: broader black-box webhook → delivery parity for more providers
3. **Performance follow-up**: optional Redis L2 cache for connection resolution if profiling justifies it
4. **Observability depth**: channel-specific trace/metric surfaces beyond structured logs

The phased plan below is kept as historical context for the hardening program.

---

## 2. Implementation Phases

### Phase 1: Test Infrastructure & Core E2E Tests

**Goal**: Establish test infrastructure and write the highest-priority E2E tests.
**Duration**: 3-4 days
**Priority**: P0

#### 2.1.1 Test Fixture Setup

**File**: `apps/runtime/src/__tests__/fixtures/channel-test-helpers.ts`

```typescript
// Provides:
// - HMAC signature generation for Slack, WhatsApp, Twilio
// - Test channel connection creation via API
// - BullMQ job waiting utilities
// - Mock Slack/WhatsApp webhook payload generators
// - Runtime server setup on random port with full middleware
```

**Implementation details**:

- `generateSlackSignature(body: string, signingSecret: string, timestamp?: number): { 'x-slack-signature': string; 'x-slack-request-timestamp': string }` -- Implements Slack's `v0=hmac-sha256(signingSecret, v0:timestamp:body)` algorithm.
- `generateWhatsAppSignature(body: string, appSecret: string): { 'x-hub-signature-256': string }` -- HMAC-SHA256 of raw body.
- `generateTwilioSignature(url: string, params: Record<string, string>, authToken: string): { 'x-twilio-signature': string }` -- Twilio's HMAC-SHA1 signature algorithm.
- `createTestRuntimeServer(options?: { withRedis?: boolean; withMongo?: boolean }): Promise<{ app: Express; port: number; close: () => Promise<void> }>` -- Starts runtime with real middleware on random port.
- `waitForBullMQJob(queueName: string, timeout?: number): Promise<Job>` -- Polls BullMQ until job completes or timeout.

#### 2.1.2 E2E-CH-01: Channel Connection CRUD

**File**: `apps/runtime/src/__tests__/e2e/channel-connection-crud.e2e.test.ts`

**Tests**:

1. Create Slack connection with credentials -> 201, encrypted
2. List connections -> returns created connection
3. Get single connection -> full details, no raw secrets
4. Update display name -> 200, updated
5. Update credentials -> 200, re-encrypted
6. Delete (deactivate) -> 200, status=inactive
7. Re-create with same identifier -> 201 (unique index partial on active)
8. Create with missing required credentials -> 400

**Dependencies**: MongoDB, encryption master key, auth middleware.

#### 2.1.3 E2E-CH-06: Tenant and Project Isolation

**File**: `apps/runtime/src/__tests__/e2e/channel-isolation.e2e.test.ts`

**Tests**:

1. Tenant A creates connection
2. Tenant B GET -> 404 (not 403)
3. Tenant B PATCH -> 404
4. Tenant B DELETE -> 404
5. Tenant B list in Tenant A's project -> empty array or 403
6. Cross-project access within same tenant -> 404

**Dependencies**: Two test tenant fixtures, project membership middleware.

#### Exit Criteria Phase 1

- [ ] `channel-test-helpers.ts` provides signature generators for Slack, WhatsApp, Twilio
- [ ] `channel-connection-crud.e2e.test.ts` passes with 8+ assertions
- [ ] `channel-isolation.e2e.test.ts` passes with 6+ assertions
- [ ] All tests use real servers on random ports with full middleware
- [ ] No `vi.mock()` or direct DB access in E2E tests
- [ ] Tests pass in CI (pnpm build && pnpm test)

---

### Phase 2: Webhook Pipeline E2E Tests

**Goal**: E2E tests for the webhook ingress -> BullMQ -> execution -> delivery pipeline.
**Duration**: 3-4 days
**Priority**: P0

#### 2.2.1 E2E-CH-02: Webhook Ingress and Message Pipeline

**File**: `apps/runtime/src/__tests__/e2e/channel-webhook-pipeline.e2e.test.ts`

**Tests**:

1. POST valid Slack webhook with correct HMAC -> 200 `{ ok: true }`
2. Verify BullMQ job created with correct payload
3. Verify channel session created in DB
4. Second message with same thread -> same session reused
5. Invalid HMAC signature -> 401
6. Non-existent connection identifier -> 404
7. Unknown channel type -> 400
8. Verify fast ACK (< 3s response time)

**Key implementation**: Must start BullMQ inbound worker in test setup to process jobs. Use `waitForBullMQJob` helper to verify processing.

#### 2.2.2 E2E-CH-08: Meta Webhook Verification

**File**: `apps/runtime/src/__tests__/e2e/channel-meta-verification.e2e.test.ts`

**Tests**:

1. Create WhatsApp connection with verify_token
2. GET webhook with correct verify_token -> 200, challenge echoed
3. GET with incorrect token -> 403
4. GET for non-Meta channel type -> 404
5. Multiple connections with different tokens -> independently verifiable

#### 2.2.3 E2E-CH-07: Webhook Delivery Pipeline

**File**: `apps/runtime/src/__tests__/e2e/channel-delivery-pipeline.e2e.test.ts`

**Tests**:

1. Create HTTP Async connection + webhook subscription
2. Send inbound message -> processed, delivery job created
3. Mock callback server receives POST with HMAC headers
4. Callback returns 5xx -> delivery retried (verify attempt count)
5. Callback returns 410 -> subscription deactivated
6. Callback returns 4xx -> marked failed, no retry

**Key implementation**: Spin up a local HTTP callback server in tests. Use `express()` on random port as the mock callback.

#### Exit Criteria Phase 2

- [ ] `channel-webhook-pipeline.e2e.test.ts` passes with 8+ assertions
- [ ] `channel-meta-verification.e2e.test.ts` passes with 5+ assertions
- [ ] `channel-delivery-pipeline.e2e.test.ts` passes with 6+ assertions
- [ ] BullMQ inbound worker processes test jobs end-to-end
- [ ] Delivery worker delivers to mock callback server
- [ ] Response time for webhook ACK < 3s verified

---

### Phase 3: Integration Tests

**Goal**: Integration tests for internal service boundaries -- session resolution, dispatcher, manifest, dedup.
**Duration**: 3-4 days
**Priority**: P1

#### 2.3.1 INT-CH-01: Adapter Registry and Normalization

**File**: `apps/runtime/src/channels/__tests__/adapter-registry.integration.test.ts`

**Tests**:

1. Registry has all 18 adapters registered
2. Slack adapter: verify HMAC, normalize message, transform output
3. WhatsApp adapter: verify HMAC, normalize, interactive output
4. MS Teams adapter: verify JWT, normalize, adaptive card output
5. Telegram adapter: verify token, normalize, keyboard output

#### 2.3.2 INT-CH-02: Session Resolution with Email Threading

**File**: `apps/runtime/src/channels/__tests__/session-resolver.integration.test.ts`

**Tests**:

1. First email -> new session, emailMessageIds seeded
2. Reply with In-Reply-To -> same session, IDs updated
3. Reply with References -> same session
4. Unrelated email -> new session
5. Subject-based fallback -> session resolved
6. Stale session recovery -> new runtime session created

**Dependencies**: MongoMemoryServer, mock runtime executor.

#### 2.3.3 INT-CH-05: Manifest Derived Helpers

**File**: `apps/runtime/src/channels/__tests__/manifest-helpers.integration.test.ts`

**Tests**:

1. `getWebhookChannelTypes()` returns correct set
2. `getConnectionChannelTypes()` returns correct set
3. `getVoiceChannelTypes()` returns correct set
4. `buildWebhookUrl()` with various inputs
5. `getRequiredCredentials()` per channel type
6. `isKnownChannelType()` positive and negative

#### 2.3.4 INT-CH-04: Channel Dispatcher Multi-Tier Delivery

**File**: `apps/runtime/src/services/execution/__tests__/channel-dispatcher.integration.test.ts`

**Tests**:

1. Deliver to active local WebSocket -> protocol messages sent
2. Deliver to disconnected WS -> falls to Pub/Sub tier
3. No Pub/Sub -> falls to PendingDeliveryStore
4. Async channel with connectionId -> marked delivered
5. A2A with push notification -> delivered
6. Message always persisted regardless of tier

#### 2.3.5 INT-CH-06: Message Deduplication

**File**: `apps/runtime/src/services/queues/__tests__/inbound-dedup.integration.test.ts`

**Tests**:

1. First message -> processed
2. Duplicate -> skipped
3. Retry (attemptsMade > 0) -> not deduped
4. Different key -> processed

**Dependencies**: Real Redis.

#### Exit Criteria Phase 3

- [ ] All 5 integration test files pass
- [ ] Adapter tests cover Slack, WhatsApp, Teams, Telegram (4 most critical)
- [ ] Session resolver tests cover email threading (RFC 5322)
- [ ] Dispatcher tests verify all 3 tiers
- [ ] Dedup tests use real Redis

---

### Phase 4: SDK & OAuth E2E Tests

**Goal**: E2E tests for SDK HMAC enforcement and OAuth flows.
**Duration**: 2-3 days
**Priority**: P1

#### 2.4.1 E2E-CH-03: SDK Channel HMAC

**File**: `apps/runtime/src/__tests__/e2e/sdk-channel-hmac.e2e.test.ts`

**Tests**:

1. Create SDK channel -> 201
2. Set HMAC enforcement to `required` -> 200
3. WebSocket with valid HMAC -> accepted
4. WebSocket with invalid HMAC -> rejected
5. WebSocket with no HMAC when required -> rejected
6. HMAC enforcement `optional` + no HMAC -> accepted
7. HMAC enforcement `disabled` + no HMAC -> accepted
8. Delete SDK channel -> 200

#### 2.4.2 E2E-CH-04: Channel OAuth Flow

**File**: `apps/runtime/src/__tests__/e2e/channel-oauth-flow.e2e.test.ts`

**Tests**:

1. POST authorize -> 200, authUrl + state
2. State stored in Redis with correct metadata
3. Callback with valid code + state -> credentials returned
4. State consumed (replay blocked)
5. Invalid/expired state -> error
6. Unsupported channel type -> 400

**Key implementation**: Mock Slack OAuth token exchange endpoint via DI or local HTTP server.

#### 2.4.3 E2E-CH-05: Deployment/Environment Binding

**File**: `apps/runtime/src/__tests__/e2e/channel-deployment-binding.e2e.test.ts`

**Tests**:

1. Connection with deploymentId -> resolves deployment's versions
2. Connection with environment -> resolves environment's active versions
3. Connection with neither -> falls to working copy
4. Deactivated deployment -> graceful handling

#### Exit Criteria Phase 4

- [ ] SDK HMAC test verifies all 3 enforcement modes
- [ ] OAuth test verifies state lifecycle (create, consume, expire)
- [ ] Deployment binding test covers 3 resolution strategies
- [ ] WebSocket tests use real WS connections (not mocked)

---

### Phase 5: Observability & Performance Hardening

**Goal**: Add channel-specific trace events and connection resolution caching.
**Duration**: 3-4 days
**Priority**: P1

#### 2.5.1 Channel Trace Events

**File**: `apps/runtime/src/channels/trace-events.ts` (new)

Define channel-specific trace event types:

- `channel.webhook.received` -- channelType, connectionId, messageCount
- `channel.session.resolved` -- sessionId, isNew, resolutionMethod
- `channel.execution.started` -- sessionId, channelType
- `channel.delivery.completed` -- deliveryId, httpStatus, attempts
- `channel.delivery.failed` -- deliveryId, error, attempts

**Wiring**: Emit from inbound-worker.ts and delivery-worker.ts at key lifecycle points.

#### 2.5.2 Connection Resolution Cache

**File**: Modify `apps/runtime/src/channels/connection-resolver.ts`

Add Redis L2 cache for `resolveChannelConnection()`:

- Cache key: `ch:conn:${channelType}:${externalIdentifier}`
- TTL: 60 seconds (configurable via `CHANNEL_CONNECTION_CACHE_TTL_SEC`)
- Invalidation: On PATCH/DELETE in channel-connections.ts route, publish `ch:conn:invalidate:${connectionId}` to Redis Pub/Sub
- Cache miss: Fall through to MongoDB, then populate cache
- Cache hit: Skip DB query, decrypt credentials from cached encrypted form

**Important**: Cache the raw encrypted document, decrypt after cache hit. Never cache plaintext credentials in Redis.

#### 2.5.3 Connection Resolution Metrics (Optional)

If Prometheus client is available, add:

- `channel_connection_resolution_duration_seconds` (histogram)
- `channel_webhook_processing_duration_seconds` (histogram)
- `channel_delivery_attempts_total` (counter, by status)
- `channel_session_resolution_type` (counter: new vs reused vs stale_recovery)

#### Exit Criteria Phase 5

- [ ] Channel trace events emitted and visible in Observatory
- [ ] Connection resolution cache reduces DB queries by > 80% in load test
- [ ] Cache invalidation works correctly on connection update/delete
- [ ] No plaintext credentials in Redis cache
- [ ] Trace events include channelType, connectionId, sessionId context

---

### Phase 6: Unit Tests & Cleanup

**Goal**: Fill remaining unit test gaps, update docs to reflect implementation.
**Duration**: 2 days
**Priority**: P2

#### 2.6.1 Unit Tests

**Files**:

- `apps/runtime/src/channels/__tests__/output-transform.unit.test.ts` -- UNIT-CH-01
- `apps/runtime/src/services/channel/__tests__/strip-for-voice.unit.test.ts` -- UNIT-CH-02
- `apps/runtime/src/channels/__tests__/webhook-url-builder.unit.test.ts` -- UNIT-CH-03
- `apps/runtime/src/channels/__tests__/connection-type-validation.unit.test.ts` -- UNIT-CH-04
- `apps/runtime/src/channels/__tests__/caller-context-extraction.unit.test.ts` -- UNIT-CH-05

#### 2.6.2 Doc Sync

Run `/post-impl-sync channels` to update:

- Feature spec status (ALPHA -> BETA if criteria met)
- Test coverage map with actual results
- HLD gaps closed

#### Exit Criteria Phase 6

- [ ] All 5 unit test files pass
- [ ] Test coverage map updated with actual pass/fail
- [ ] Feature spec status reviewed against BETA criteria
- [ ] All SDLC log files up to date

---

## 3. File Inventory

### New Files

| File                                                                                   | Phase | Purpose                         |
| -------------------------------------------------------------------------------------- | ----- | ------------------------------- |
| `apps/runtime/src/__tests__/fixtures/channel-test-helpers.ts`                          | 1     | Shared test infrastructure      |
| `apps/runtime/src/__tests__/e2e/channel-connection-crud.e2e.test.ts`                   | 1     | Connection CRUD E2E             |
| `apps/runtime/src/__tests__/e2e/channel-isolation.e2e.test.ts`                         | 1     | Tenant isolation E2E            |
| `apps/runtime/src/__tests__/e2e/channel-webhook-pipeline.e2e.test.ts`                  | 2     | Webhook pipeline E2E            |
| `apps/runtime/src/__tests__/e2e/channel-meta-verification.e2e.test.ts`                 | 2     | Meta verification E2E           |
| `apps/runtime/src/__tests__/e2e/channel-delivery-pipeline.e2e.test.ts`                 | 2     | Delivery pipeline E2E           |
| `apps/runtime/src/channels/__tests__/adapter-registry.integration.test.ts`             | 3     | Adapter integration             |
| `apps/runtime/src/channels/__tests__/session-resolver.integration.test.ts`             | 3     | Session resolver integration    |
| `apps/runtime/src/channels/__tests__/manifest-helpers.integration.test.ts`             | 3     | Manifest helpers integration    |
| `apps/runtime/src/services/execution/__tests__/channel-dispatcher.integration.test.ts` | 3     | Dispatcher integration          |
| `apps/runtime/src/services/queues/__tests__/inbound-dedup.integration.test.ts`         | 3     | Dedup integration               |
| `apps/runtime/src/__tests__/e2e/sdk-channel-hmac.e2e.test.ts`                          | 4     | SDK HMAC E2E                    |
| `apps/runtime/src/__tests__/e2e/channel-oauth-flow.e2e.test.ts`                        | 4     | OAuth flow E2E                  |
| `apps/runtime/src/__tests__/e2e/channel-deployment-binding.e2e.test.ts`                | 4     | Deployment binding E2E          |
| `apps/runtime/src/channels/trace-events.ts`                                            | 5     | Channel trace event definitions |
| `apps/runtime/src/channels/__tests__/output-transform.unit.test.ts`                    | 6     | Output transform unit           |
| `apps/runtime/src/services/channel/__tests__/strip-for-voice.unit.test.ts`             | 6     | Voice stripping unit            |
| `apps/runtime/src/channels/__tests__/webhook-url-builder.unit.test.ts`                 | 6     | URL builder unit                |
| `apps/runtime/src/channels/__tests__/connection-type-validation.unit.test.ts`          | 6     | Connection type unit            |
| `apps/runtime/src/channels/__tests__/caller-context-extraction.unit.test.ts`           | 6     | Caller context unit             |

### Modified Files

| File                                                  | Phase | Change                              |
| ----------------------------------------------------- | ----- | ----------------------------------- |
| `apps/runtime/src/channels/connection-resolver.ts`    | 5     | Add Redis L2 cache                  |
| `apps/runtime/src/routes/channel-connections.ts`      | 5     | Cache invalidation on update/delete |
| `apps/runtime/src/services/queues/inbound-worker.ts`  | 5     | Emit channel trace events           |
| `apps/runtime/src/services/queues/delivery-worker.ts` | 5     | Emit channel trace events           |

---

## 4. Wiring Checklist

| #   | Item                                      | Verification                                                                         |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Test helpers importable from E2E tests    | `import { generateSlackSignature } from '../fixtures/channel-test-helpers'` compiles |
| 2   | E2E tests use `createTestRuntimeServer()` | No manual Express setup in test files                                                |
| 3   | BullMQ workers start in test setup        | `startInboundWorker()` called in `beforeAll()`                                       |
| 4   | Cache invalidation wired in CRUD route    | PATCH and DELETE routes call `invalidateConnectionCache(connectionId)`               |
| 5   | Trace events wired in workers             | `emitChannelTraceEvent()` called at key lifecycle points                             |
| 6   | Test fixtures clean up after themselves   | `afterAll()` closes servers, drains queues, clears Redis keys                        |
| 7   | Vitest config includes E2E test patterns  | `apps/runtime/vitest.config.ts` includes `__tests__/e2e/**/*.e2e.test.ts`            |

---

## 5. Risk Register

| Risk                                       | Phase | Mitigation                                                                 |
| ------------------------------------------ | ----- | -------------------------------------------------------------------------- |
| E2E tests flaky due to BullMQ timing       | 2     | Use `waitForBullMQJob` with generous timeouts, run workers inline          |
| MongoMemoryServer startup slow in CI       | 3     | Share instance across test files via `globalSetup`                         |
| WebSocket tests unreliable                 | 4     | Use `ws` library directly (not browser WebSocket), explicit close handling |
| Connection cache invalidation race         | 5     | Use Pub/Sub for cross-pod invalidation, accept 60s staleness window        |
| Redis not available in all CI environments | 1-4   | Skip Redis-dependent tests with `describe.skipIf(!redisAvailable)`         |

---

## 6. Schedule Summary

| Phase                          | Duration | Depends On | Key Deliverable                 |
| ------------------------------ | -------- | ---------- | ------------------------------- |
| Phase 1: Test Infra + Core E2E | 3-4 days | -          | 2 E2E test suites, test helpers |
| Phase 2: Webhook Pipeline E2E  | 3-4 days | Phase 1    | 3 E2E test suites               |
| Phase 3: Integration Tests     | 3-4 days | Phase 1    | 5 integration test suites       |
| Phase 4: SDK & OAuth E2E       | 2-3 days | Phase 1    | 3 E2E test suites               |
| Phase 5: Observability & Perf  | 3-4 days | Phase 1-4  | Trace events, connection cache  |
| Phase 6: Unit Tests & Cleanup  | 2 days   | Phase 5    | 5 unit test files, doc sync     |

**Total**: ~17-21 days

---

## 7. BETA Promotion Criteria

The channels feature can be promoted from ALPHA to BETA when:

1. **E2E Test Coverage**: All 8 E2E scenarios pass (Phase 1-4)
2. **Integration Test Coverage**: All 8 integration scenarios pass (Phase 3)
3. **Unit Test Coverage**: All 6 unit test groups pass (Phase 6)
4. **Observability**: Channel trace events visible in Observatory (Phase 5)
5. **Performance**: Connection resolution cache operational (Phase 5)
6. **Security**: No CRITICAL or HIGH findings from security scan
7. **Documentation**: Feature spec, test spec, HLD, and LLD all up to date
