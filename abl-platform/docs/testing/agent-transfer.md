# Test Spec: Agent Transfer

- **Feature ID:** F014
- **Feature Spec:** `docs/features/agent-transfer.md`
- **Status:** ALPHA
- **Created:** 2026-03-23
- **Last Updated:** 2026-04-14

---

## 1. Test Strategy

The agent-transfer feature spans three layers: the core SDK package (`packages/agent-transfer`), the runtime service integration (`apps/runtime`), and the Studio UI (`apps/studio`). Testing follows the pyramid with emphasis on E2E and integration tests for the critical transfer lifecycle paths.

### 1.1 Test Layers

| Layer       | Purpose                                                                           | Tools                               | Location                                             |
| ----------- | --------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Unit        | Individual functions, Lua scripts, type validators, form rendering, log redaction | vitest                              | `packages/agent-transfer/src/__tests__/unit/`        |
| Integration | Session store with real Redis, adapter registry lifecycle, event queue processing | vitest + ioredis-mock or real Redis | `packages/agent-transfer/src/__tests__/integration/` |
| E2E         | Full transfer lifecycle through HTTP API with real Express + Redis                | vitest + supertest                  | `apps/runtime/src/__tests__/`                        |
| UI E2E      | Studio settings and session management pages                                      | Playwright (future)                 | `apps/studio/e2e/`                                   |

### 1.2 Test Infrastructure Requirements

- **Redis:** Real Redis instance (or ioredis-mock for unit tests) for session store, rate limiter, nonce store
- **Express Server:** Real Express app started on random port (`:0`) with full middleware chain
- **SmartAssist Mock:** nock-based HTTP mock for SmartAssist API calls (external service, allowed to mock)
- **BullMQ:** Real Redis-backed queues for durable event and timeout scheduler tests

---

## 2. Coverage Matrix

### 2.1 Unit Test Coverage (Existing)

| Test File                                  | Component                         | Status | Tests |
| ------------------------------------------ | --------------------------------- | ------ | ----- |
| `unit/concurrency.test.ts`                 | Session store concurrent access   | Pass   | ~5    |
| `unit/config-reloader.test.ts`             | Config reload via Redis pub/sub   | Pass   | ~4    |
| `unit/csat-handler.test.ts`                | CSAT survey handler               | Pass   | ~6    |
| `unit/dead-letter-store.test.ts`           | Dead-letter store operations      | Pass   | ~5    |
| `unit/disposition-handler.test.ts`         | Disposition code handler          | Pass   | ~4    |
| `unit/durable-events.test.ts`              | Durable event queue               | Pass   | ~6    |
| `unit/edge-cases.test.ts`                  | Edge case handling                | Pass   | ~8    |
| `unit/error-resilience.test.ts`            | Error recovery patterns           | Pass   | ~5    |
| `unit/fallback-executor.test.ts`           | Fallback adapter execution        | Pass   | ~4    |
| `unit/graceful-shutdown.test.ts`           | Shutdown handler ordering         | Pass   | ~5    |
| `unit/helpers.test.ts`                     | Utility functions                 | Pass   | ~3    |
| `unit/history-formatter.test.ts`           | Conversation history formatting   | Pass   | ~6    |
| `unit/input-validation.test.ts`            | Input validation                  | Pass   | ~5    |
| `unit/log-redactor.test.ts`                | Log redaction                     | Pass   | ~4    |
| `unit/parse-session-hash.test.ts`          | Redis hash parsing                | Pass   | ~3    |
| `unit/rate-limiter.test.ts`                | Rate limiting logic               | Pass   | ~4    |
| `unit/session-timeout-scheduler.test.ts`   | Session timeout BullMQ jobs       | Pass   | ~5    |
| `unit/shutdown.test.ts`                    | Shutdown lifecycle                | Pass   | ~3    |
| `unit/smartassist-update-transfer.test.ts` | SmartAssist update transfer       | Pass   | ~4    |
| `unit/ssrf-guard.test.ts`                  | SSRF URL validation               | Pass   | ~6    |
| `unit/tenant-isolation.test.ts`            | Tenant isolation in session store | Pass   | ~5    |
| `unit/trace-events.test.ts`                | Trace event emission              | Pass   | ~4    |
| `unit/trace-store-adapter.test.ts`         | TraceStore adapter                | Pass   | ~3    |
| `unit/parse-session-hash.test.ts`          | Session hash extended fields      | Pass   | ~5    |
| `metrics.test.ts`                          | Metrics collection                | Pass   | ~3    |
| `event-mapping-fixes.test.ts`              | XO event map fixes (I7, M2)       | Pass   | ~5    |
| `kore-adapter-key-fixes.test.ts`           | Kore adapter key format fixes     | Pass   | ~4    |
| `smartassist-client-protocol.test.ts`      | SmartAssist client protocol       | Pass   | ~6    |

### 2.2 Integration Test Coverage (Existing)

| Test File                                | Component               | Status | Tests |
| ---------------------------------------- | ----------------------- | ------ | ----- |
| `integration/backward-compat.test.ts`    | Backward compatibility  | Pass   | ~4    |
| `integration/kore-transfer-flow.test.ts` | Full Kore transfer flow | Pass   | ~6    |
| `integration/session-lifecycle.test.ts`  | Session lifecycle       | Pass   | ~8    |
| `integration/voice-transfer.test.ts`     | Voice transfer flow     | Pass   | ~3    |

### 2.3 Runtime Test Coverage (Existing)

| Test File                                | Component                                                         | Status | Tests |
| ---------------------------------------- | ----------------------------------------------------------------- | ------ | ----- |
| `agent-transfer-boot.test.ts`            | Boot service init + config loader + TTL injection                 | Pass   | ~8    |
| `agent-transfer-bridge.test.ts`          | Message bridge multi-channel routing (WS, voice, channel adapter) | Pass   | ~12   |
| `agent-transfer-routes-authz.test.ts`    | Route authorization                                               | Pass   | ~8    |
| `agent-transfer-webhook-routing.test.ts` | Webhook event routing                                             | Pass   | ~5    |
| `agent-transfer-webhooks.test.ts`        | Webhook endpoint                                                  | Pass   | ~6    |
| `escalation-transfer-wiring.test.ts`     | Escalation -> transfer wiring via routing executor                | Pass   | ~5    |
| `transfer-tool-executor.test.ts`         | Transfer tool routing                                             | Pass   | ~8    |

### 2.4 Studio UI Test Coverage (New)

| Test File                         | Component                                 | Status | Tests |
| --------------------------------- | ----------------------------------------- | ------ | ----- |
| `connections-page.test.tsx`       | ConnectionsPage loading, search, grouping | Pass   | ~10   |
| `edit-connection-dialog.test.tsx` | Edit dialog for agent desktop connections | Pass   | ~8    |

---

## 3. E2E Test Scenarios (Required)

These E2E tests exercise the real system through its HTTP API. No mocking of codebase components. Only external services (SmartAssist API) may be mocked via nock.

### E2E-01: Complete Transfer Lifecycle (Chat Channel)

**Objective:** Validate the full transfer lifecycle: initiation -> webhook events -> session end.

**Steps:**

1. Start real Express server on random port with agent-transfer subsystem initialized (real Redis)
2. POST to `/api/v1/agent-transfer/sessions` (or use transfer tool endpoint) to initiate transfer
3. Verify session appears in `GET /api/v1/agent-transfer/sessions` with state `pending`
4. POST webhook event to `/api/v1/agent-transfer/webhooks/kore` with `agent_connected` event
5. Verify session state transitions to `active`
6. POST webhook event with `agent_message` event
7. Verify message is routed (check WebSocket delivery or event queue)
8. POST to `/api/v1/agent-transfer/sessions/:id/end`
9. Verify session is cleaned up from Redis

**Assertions:**

- Session creation returns 200 with session key
- Session list includes the created session with correct tenant scoping
- Webhook events return 200 and modify session state
- Session end returns 200 and removes session from active set

### E2E-02: Webhook Signature Verification

**Objective:** Validate webhook signature verification rejects tampered requests.

**Steps:**

1. Start server with `SMARTASSIST_WEBHOOK_SECRET` configured
2. POST webhook with valid HMAC signature -> expect 200
3. POST webhook with invalid signature -> expect 401
4. POST webhook with missing timestamp header -> expect 401
5. POST webhook with replayed nonce -> expect 401

**Assertions:**

- Valid signatures pass through to event processing
- Invalid signatures return `INVALID_SIGNATURE` error
- Nonce replay protection prevents duplicate event processing

### E2E-03: Tenant Isolation in Session Operations

**Objective:** Validate that tenant A cannot see or modify tenant B's transfer sessions.

**Steps:**

1. Create session for tenant-A
2. Create session for tenant-B
3. List sessions as tenant-A -> only tenant-A sessions visible
4. Attempt to end tenant-B session as tenant-A -> 404 (not 403)
5. Webhook event with mismatched orgId -> 404

**Assertions:**

- Cross-tenant access returns 404 (not 403, to avoid leaking existence)
- Session list is strictly tenant-scoped
- Webhook tenant validation prevents cross-tenant event injection

### E2E-04: Session Timeout and TTL Expiry

**Objective:** Validate session TTL enforcement and timeout queue processing.

**Steps:**

1. Create session with short TTL (5 seconds for test)
2. Verify session exists immediately
3. Wait for TTL expiry
4. Verify session is removed from active sessions set
5. Verify session hash is expired from Redis

**Assertions:**

- Session TTL is correctly set per channel type
- Expired sessions are cleaned from the active sessions set
- Timeout queue callback fires and ends expired sessions

### E2E-05: Transfer Tool Execution Pipeline

**Objective:** Validate that transfer tools execute correctly through the runtime tool binding pipeline.

**Steps:**

1. Start real Express server with SmartAssist mock (nock)
2. Call `check_hours` tool -> expect hours response
3. Call `check_availability` tool -> expect availability response
4. Call `set_queue` tool -> expect queue confirmation
5. Call `transfer_to_agent` tool -> expect transfer initiation with session creation
6. Call `transfer_to_agent` again for same contact+channel -> expect duplicate rejection

**Assertions:**

- Pre-check tools return structured results
- Transfer tool creates session and returns transfer result
- Duplicate transfer for same contact+channel is rejected atomically

### E2E-06: Voice Channel Tool Restrictions

**Objective:** Validate voice-only tools are rejected on non-voice channels.

**Steps:**

1. Create transfer context with `channel: 'chat'`
2. Call `ivr_menu` tool -> expect `CHANNEL_MISMATCH` error
3. Call `ivr_digit_input` tool -> expect `CHANNEL_MISMATCH` error
4. Call `call_transfer` tool -> expect `CHANNEL_MISMATCH` error
5. Call `deflect_to_chat` tool -> expect `CHANNEL_MISMATCH` error

**Assertions:**

- All voice-only tools return structured error with `CHANNEL_MISMATCH` code
- Non-voice-only tools (`transfer_to_agent`, `check_hours`) work on chat channel

### E2E-07: Rate Limiting on Transfer Initiation

**Objective:** Validate per-tenant rate limiting on `transfer_to_agent`.

**Steps:**

1. Configure rate limit to 3 transfers per 60 seconds
2. Execute 3 successful transfers (different contactIds)
3. Execute 4th transfer -> expect `RATE_LIMIT_EXCEEDED` error
4. Verify rate limit response includes reset time

**Assertions:**

- First N transfers succeed within the window
- Transfers beyond the limit return structured rate limit error
- Rate limit is per-tenant (different tenants have separate windows)

### E2E-08: Project-Level Settings CRUD

**Objective:** Validate settings API for project-level agent transfer configuration.

**Steps:**

1. Start server with database available
2. GET settings for new project -> expect default settings
3. PUT custom settings (TTLs, routing, voice, PII)
4. GET settings -> expect custom settings returned
5. PUT with prototype pollution keys (**proto**) -> expect 400

**Assertions:**

- Default settings are returned when none configured
- Settings are persisted and retrievable
- Prototype pollution keys are rejected
- Settings are scoped to tenant + project

### E2E-09: Durable Event Queue Reliability

**Objective:** Validate that agent events survive transient failures via the durable event queue.

**Steps:**

1. Start server with durable event queue enabled
2. Enqueue agent event to durable queue
3. Verify event is processed by the event worker
4. Simulate worker failure on next event
5. Verify event is retried and eventually succeeds or moved to dead-letter

**Assertions:**

- Events are persisted in Redis before processing
- Failed events are retried per the configured retry policy
- Permanently failed events land in the dead-letter store

### E2E-10: Session Recovery After Pod Crash

**Objective:** Validate that orphaned sessions are reclaimed by the recovery service.

**Steps:**

1. Create session owned by pod-A
2. Simulate pod-A crash (no heartbeat renewal)
3. Start recovery service on pod-B (leader elected)
4. Verify session is reclaimed from pod-A to pod-B
5. Verify session remains functional after recovery

**Assertions:**

- Recovery service detects stale pod heartbeats
- Orphaned sessions are redistributed to healthy pods
- Session state is preserved during recovery

---

## 4. Integration Test Scenarios (Required)

### INT-01: Session Store Atomicity

**Objective:** Verify Lua script atomicity prevents race conditions in session creation.

**Setup:** Real Redis instance (or ioredis-mock with Lua support)

**Steps:**

1. Simultaneously create 10 sessions for the same tenant+contact+channel
2. Verify exactly 1 session is created
3. Verify 9 attempts receive `SESSION_EXISTS` error

### INT-02: Session Field Encryption Round-Trip

**Objective:** Verify encrypted fields are correctly encrypted on write and decrypted on read.

**Setup:** Real encryption service with test keys

**Steps:**

1. Create session with metadata containing PII
2. Read raw Redis hash -> verify metadata field is encrypted (not plaintext)
3. Read session via store API -> verify metadata is decrypted correctly

### INT-03: Adapter Registry Lifecycle

**Objective:** Verify adapter registration, health check, and shutdown.

**Steps:**

1. Register KoreAdapter with mock SmartAssist config
2. Verify `registry.get('kore')` returns the adapter
3. Execute health check -> verify result
4. Unregister adapter -> verify `registry.get('kore')` returns undefined
5. Verify adapter's `close()` was called during unregister

### INT-04: KoreEventHandler Event Type Normalization

**Objective:** Verify XO event types are correctly mapped to ABL event types.

**Steps:**

1. Map `agent_message` -> `agent:message`
2. Map `agent_connected` -> `agent:connected`
3. Map `agent_disconnected` -> `agent:disconnected`
4. Map `agent_typing` -> `agent:typing`
5. Map unknown type -> returns null

### INT-05: Message Bridge Multi-Channel Routing

**Objective:** Verify message bridge correctly routes to different channel types.

**Steps:**

1. Register a WebSocket for session-A -> deliver via WS
2. Set event with `channel: 'chat'` and `channelType` + `connectionId` -> deliver via channel adapter
3. Set event with `channel: 'voice'` -> deliver via voice gateway
4. Set event with unknown channel and no metadata -> log warning

### INT-06: Webhook Nonce Store Prevents Replay

**Objective:** Verify Redis-backed nonce store prevents webhook event replay attacks.

**Steps:**

1. Create nonce store with test Redis
2. Check nonce "abc-123" -> not seen (valid)
3. Mark nonce "abc-123" as used
4. Check nonce "abc-123" again -> seen (replay)
5. Verify nonce TTL is set correctly

### INT-07: History Formatter Provider Strategies

**Objective:** Verify conversation history is formatted correctly per provider.

**Steps:**

1. Format history with KoreHistoryStrategy -> verify Kore-specific format
2. Format history with GenericHistoryStrategy -> verify generic format
3. Verify empty history returns empty output
4. Verify message truncation for long histories

### INT-08: Dead Letter Store CRUD

**Objective:** Verify dead-letter entries are stored, listed, and cleaned up.

**Steps:**

1. Store failed event in dead-letter store
2. List entries -> verify event appears
3. Delete entry -> verify removed
4. Verify TTL-based cleanup (if applicable)

---

## 5. Test Data Requirements

### 5.1 Fixtures

| Fixture                   | Location                                                    | Content                                                            |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Transfer payloads         | `packages/agent-transfer/src/__tests__/helpers/fixtures.ts` | Standard transfer payloads for chat/voice/email channels           |
| XO webhook events         | Test inline                                                 | Agent message, connected, disconnected, typing events in XO format |
| SmartAssist API responses | nock mocks                                                  | Transfer initiation, hours check, availability check responses     |
| Redis session hashes      | Created via session store API                               | Session data for various states and channels                       |

### 5.2 Test Credentials

- SmartAssist API: Use `SMARTASSIST_API_KEY=test-key-e2e` in test environment
- Webhook secrets: Use `SMARTASSIST_WEBHOOK_SECRET=test-secret-e2e` for signature tests
- Encryption keys: Use `ENCRYPTION_MASTER_KEY=test-master-key-32chars!!` for encryption tests

---

## 6. Coverage Targets

| Layer                                 | Current (est.) | Target | Gap                                                                          |
| ------------------------------------- | -------------- | ------ | ---------------------------------------------------------------------------- |
| Unit (packages/agent-transfer)        | ~90%           | 90%    | Near target; event mapping, client protocol, session hash tests added        |
| Integration (packages/agent-transfer) | ~65%           | 80%    | Voice transfer added; session encryption, nonce store, dead-letter remaining |
| E2E (apps/runtime)                    | ~35%           | 70%    | Boot + bridge tests added; full lifecycle with real Redis still needed       |
| Studio UI (apps/studio)               | ~20%           | 50%    | Connections page + edit dialog tested; settings page, session list remaining |

---

## 7. Known Test Gaps

| ID    | Gap                                                                                                                                                                        | Priority | Blocking         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| TG-01 | No E2E test exercises the full transfer lifecycle through HTTP API with real Redis                                                                                         | P0       | Yes (BETA gate)  |
| TG-02 | No E2E test validates tenant isolation across webhook + session endpoints                                                                                                  | P0       | Yes (BETA gate)  |
| TG-03 | ~~Voice tools tested only in unit tests~~ Partially mitigated: voice-transfer integration test added, but not full execution pipeline E2E                                  | P1       | No               |
| TG-04 | Session recovery tested only in unit tests, not with real pod simulation                                                                                                   | P1       | No               |
| TG-05 | Durable event queue not tested with real BullMQ failure scenarios                                                                                                          | P1       | No               |
| TG-06 | ~~Studio UI has zero automated test coverage~~ Partially mitigated: connections-page and edit-connection-dialog tests added; settings page and session list still untested | P2       | No               |
| TG-07 | Performance/load tests do not exist for NFR-03 (1,000 concurrent sessions)                                                                                                 | P2       | No (STABLE gate) |
| TG-08 | Connection-backed agent desktop flow has no E2E test with real server + middleware                                                                                         | P1       | No               |
