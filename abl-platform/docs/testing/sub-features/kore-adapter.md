# Test Specification: Kore SmartAssist Agent Transfer Adapter

**Feature Spec**: `docs/features/sub-features/kore-adapter.md`
**Parent Feature**: [Agent Transfer](../../features/agent-transfer.md)
**HLD**: TBD
**LLD**: TBD
**Status**: IN PROGRESS
**Last Updated**: 2026-03-30

---

## 1. Feature Metadata

- **Package(s)**: `packages/agent-transfer`, `apps/runtime`, `apps/studio`
- **Feature Area**: integrations, customer experience, enterprise
- **Risk Level**: Medium-High (external API integration, webhook security, Redis session atomicity, lazy orgId resolution with DB persistence, singleton adapter isolation)

---

## 2. Current State

86+ tests passing across 14 Kore-specific test files (unit + integration + e2e), plus 400+ shared agent-transfer infrastructure tests across 45 total test files. E2E tests gated by `AGENT_TRANSFER_E2E=1`. Key gap: FR-7 (lazy orgId resolution) is NOT TESTED. Several FRs (FR-2, FR-9, FR-16, FR-17) have only unit coverage. Only 1 E2E scenario exists (session lifecycle), 2 integration scenarios (transfer flow, backward compat). Additional E2E and integration scenarios needed for STABLE promotion.

### Existing Test Files

| File                                                                             | Type        | Lines | Coverage Focus                                                                                      |
| -------------------------------------------------------------------------------- | ----------- | ----- | --------------------------------------------------------------------------------------------------- |
| `packages/agent-transfer/src/__tests__/kore-adapter-wiring.test.ts`              | unit        | 406   | KoreAdapter send, control, precheck, endSession wiring                                              |
| `packages/agent-transfer/src/__tests__/kore-adapter-key-fixes.test.ts`           | unit        | 214   | Session key format (C6, I2), postAgentAction extraction                                             |
| `packages/agent-transfer/src/__tests__/smartassist-client-protocol.test.ts`      | unit        | 378   | SmartAssistClient configurable paths, XO payload, sendEvent, non-retryable initTransfer, JSON parse |
| `packages/agent-transfer/src/__tests__/event-mapping-fixes.test.ts`              | unit        | 139   | KoreEventHandler 22 XO→ABL event type mappings                                                      |
| `packages/agent-transfer/src/__tests__/unit/event-handler-attachments.test.ts`   | unit        | ~80   | Attachment extraction from XO events                                                                |
| `packages/agent-transfer/src/__tests__/unit/smartassist-update-transfer.test.ts` | unit        | 68    | updateTransfer endpoint delegation                                                                  |
| `packages/agent-transfer/src/__tests__/session-lua-fixes.test.ts`                | unit        | 387   | Session Lua script atomicity (C7, C8, I8)                                                           |
| `packages/agent-transfer/src/__tests__/security-hardening.test.ts`               | unit        | 261   | Webhook nonce dedup, session key validation, rate limiter, SSRF guard                               |
| `packages/agent-transfer/src/__tests__/health.test.ts`                           | unit        | 109   | Health check API contract                                                                           |
| `packages/agent-transfer/src/__tests__/metrics.test.ts`                          | unit        | 86    | Metrics recording contract                                                                          |
| `packages/agent-transfer/src/__tests__/integration/kore-transfer-flow.test.ts`   | integration | 134   | Transfer flow orchestration with DI-injected mock adapter                                           |
| `packages/agent-transfer/src/__tests__/integration/backward-compat.test.ts`      | integration | ~200  | agentId→botId, tenantId→orgId backward compat (10 guarantees)                                       |
| `packages/agent-transfer/src/__tests__/e2e/kore-e2e.test.ts`                     | e2e         | 333   | Full session lifecycle against real Redis                                                           |
| `apps/runtime/src/__tests__/agent-transfer-webhooks.test.ts`                     | unit        | 220   | Webhook HTTP handlers, signature verification                                                       |
| `apps/runtime/src/__tests__/agent-transfer-webhook-routing.test.ts`              | unit        | 233   | Webhook routing, no double-delivery                                                                 |
| `apps/runtime/src/__tests__/agent-transfer-bridge.test.ts`                       | unit        | 132   | Message bridge WebSocket delivery                                                                   |
| `apps/runtime/src/__tests__/agent-transfer-boot.test.ts`                         | unit        | 414   | Boot config loading, Redis-ready init, shutdown hooks                                               |
| `apps/runtime/src/__tests__/auth/agent-transfer-routes-authz.test.ts`            | unit        | 335   | Route authorization enforcement                                                                     |
| `apps/runtime/src/__tests__/escalation-transfer-wiring.test.ts`                  | unit        | 194   | Escalation → adapter registry → session store wiring                                                |
| `apps/runtime/src/__tests__/transfer-tool-executor.test.ts`                      | unit        | 235   | Transfer tool dispatch, context population                                                          |

---

## 3. Coverage Matrix

| FR    | Description                                     | Unit | Integration | E2E | Manual | Status  |
| ----- | ----------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | SmartAssist API key auth in `apiKey` header     | ✅   | ✅          | -   | ✅     | COVERED |
| FR-2  | KoreServer API key auth (koreApiKey fallback)   | ✅   | ✅          | -   | ✅     | COVERED |
| FR-3  | Business hours pre-check                        | ✅   | ✅          | -   | ✅     | COVERED |
| FR-4  | Agent availability pre-check                    | ✅   | ✅          | -   | ✅     | COVERED |
| FR-5  | Queue validation pre-check                      | ✅   | ✅          | -   | ✅     | COVERED |
| FR-6  | Synthetic user creation (fallback to contactId) | ✅   | ✅          | -   | ✅     | COVERED |
| FR-7  | Lazy orgId resolution + DB persistence          | ✅   | ✅          | -   | ✅     | COVERED |
| FR-8  | Transfer initiation with full XO payload        | ✅   | ✅          | ✅  | ✅     | COVERED |
| FR-9  | ABL webhook URL embedding (metaInfo.abl)        | ✅   | ✅          | -   | ✅     | COVERED |
| FR-10 | Forward user messages via event handle API      | ✅   | -           | ✅  | ✅     | COVERED |
| FR-11 | Forward control events (typing, close)          | ✅   | ✅          | -   | ✅     | COVERED |
| FR-12 | Webhook route with HMAC verification            | ✅   | ✅          | ✅  | ✅     | COVERED |
| FR-13 | 22 XO event type mappings (10 ABL types)        | ✅   | -           | -   | -      | COVERED |
| FR-14 | Redis session with provider index + alias keys  | ✅   | ✅          | ✅  | -      | COVERED |
| FR-15 | Channel-specific session TTLs with atomic Lua   | ✅   | ✅          | ✅  | -      | COVERED |
| FR-16 | check-hours ABL tool                            | ✅   | ✅          | -   | -      | COVERED |
| FR-17 | set-queue ABL tool                              | ✅   | ✅          | -   | -      | COVERED |
| FR-18 | Post-agent actions (end vs return)              | ✅   | -           | -   | ✅     | COVERED |
| FR-19 | Channel→source mapping                          | ✅   | -           | -   | -      | COVERED |
| FR-20 | Language mapping (LANGUAGE_MAP)                 | ✅   | ✅          | -   | -      | COVERED |
| FR-21 | updateTransfer endpoint                         | ✅   | ✅          | -   | -      | COVERED |
| FR-22 | Tenant isolation on webhook events              | ✅   | ✅          | ✅  | -      | COVERED |

Legend: ✅ = Covered, ❌ = Not covered, - = N/A

### Priority Gaps

1. **FR-7** (HIGH): Lazy orgId resolution — zero automated coverage. GAP-008 (singleton stale orgId) is High severity.
2. **FR-12/FR-22** (MEDIUM): Webhook HMAC + tenant isolation — unit-only, no integration or E2E.
3. **FR-16/FR-17** (MEDIUM): ABL tools — unit-only, no integration test for tool executor → adapter flow.
4. **FR-9** (LOW): Webhook URL embedding — unit-only, could verify in integration transfer flow.

---

## 4. E2E Test Scenarios (MANDATORY)

> CRITICAL: E2E tests must exercise the real system through its HTTP API. No mocks of codebase components, no direct DB access, no stubbed servers. Only SmartAssist/KoreServer external APIs may be mocked via dependency injection in `SmartAssistClient` constructor.

> **Environment**: Redis 7-alpine (docker-compose, port 6379, password `localdev`). Gated by `AGENT_TRANSFER_E2E=1`. Test key isolation via `e2e_test_${Date.now()}` prefix.

### E2E-1: Webhook Inbound — Agent Message Delivery via Real Express Server

**Covers**: FR-12, FR-13, FR-10, FR-14
**Preconditions**: Real Express server started on random port (`app.listen(0)`) with full agent-transfer middleware (webhook route, adapter registry, session store, message bridge). Real Redis. SmartAssistClient DI-injected for external API only. Active session seeded in Redis.
**Auth Context**: Webhook HMAC signature, tenant `tenant-e2e-1`, orgId `o-e2e-1`

**Steps**:

1. Start Express server with `app.listen(0)` — full middleware chain including auth, rate limiting, webhook route
2. Seed active session in Redis: `agent_transfer:tenant-e2e-1:contact-1:chat` with `providerSessionId: 'conv-e2e-1'`, `providerData: { orgId: 'o-e2e-1' }`
3. Seed alias key: `at_by_provider:smartassist:o-e2e-1:conv-e2e-1`
4. Wire message bridge capture callback
5. POST `http://localhost:${port}/api/v1/agent-transfer/webhooks/smartassist` with `{ type: 'agent_message', conversationId: 'conv-e2e-1', orgId: 'o-e2e-1', message: 'Hello from agent', attachments: [{ url: 'https://files.example.com/doc.pdf', name: 'doc.pdf' }] }` and valid HMAC header
6. Assert 200 response
7. Assert message bridge callback received `{ type: 'agent:message', message: 'Hello from agent' }` with attachment
8. Assert session `lastActivityAt` updated in Redis
9. Assert session TTL extended

**Expected Result**: Agent messages flow through real HTTP → middleware → adapter → bridge pipeline.

### E2E-2: Webhook Agent Message — HMAC Verification and Tenant Isolation

**Covers**: FR-12, FR-13, FR-22
**Preconditions**: Active transfer session in Redis with `providerData.orgId = 'o-e2e-org'`, HMAC webhook secret configured, Express middleware chain active
**Auth Context**: Webhook HMAC signature (not bearer token), tenant isolation via orgId match

**Steps**:

1. Seed Redis session: `at_by_provider:smartassist:o-e2e-org:conv-e2e-2` alias key pointing to session
2. POST `/api/v1/agent-transfer/webhooks/smartassist` with valid `agent_message` XO event body, valid HMAC `X-Signature` header, `orgId: 'o-e2e-org'`
3. Assert 200 response
4. Assert event mapped to `agent:message` AgentEventType with correct message text
5. Assert message bridge callback dispatched to correct session
6. Assert session `lastActivityAt` updated

**Isolation checks**:

7. POST same endpoint with valid HMAC but `orgId: 'o-wrong-org'` — assert 404 response (not 403, per CLAUDE.md cross-scope rule)
8. POST same endpoint with invalid HMAC signature — assert 401 response
9. POST same endpoint with missing signature and no webhook secret configured — assert event still processed (HMAC optional when no secret)
10. POST same endpoint with replayed nonce — assert 409 or rejection

**Expected Result**: Valid events processed, invalid HMAC rejected, wrong tenant returns 404.

### E2E-3: Webhook Post-Agent Return — Session Preserved for AI Resumption

**Covers**: FR-12, FR-18
**Preconditions**: Real Express server on random port, real Redis. Active session with `metadata: { postAgentAction: 'return', sourceAgentId: 'agent-src' }`.
**Auth Context**: Webhook HMAC, tenant `tenant-ret`, orgId `o-ret`

**Steps**:

1. Start Express server with full middleware chain
2. Seed active session with `postAgentAction: 'return'` in metadata
3. POST `http://localhost:${port}/api/v1/agent-transfer/webhooks/smartassist` with `{ type: 'closed', conversationId: 'conv-ret-1', orgId: 'o-ret' }` and valid HMAC
4. Assert 200 response
5. Assert session NOT ended (postAgentAction=`return` preserves session)
6. Verify session still exists in Redis with state transition to `post_agent`
7. POST another webhook with `{ type: 'agent_message', conversationId: 'conv-ret-1', orgId: 'o-ret', message: 'Transfer complete' }` — assert still processed (session alive)

**Expected Result**: `return` post-agent action preserves session for AI agent resumption, unlike `end` which cleans up.

### E2E-4: Webhook Session Management Endpoints — List and End via HTTP

**Covers**: FR-14, FR-15
**Preconditions**: Real Express server on random port with auth middleware, real Redis. Multiple active sessions seeded.
**Auth Context**: Bearer token with project permissions, tenant `tenant-mgmt`, project `proj-mgmt`

**Steps**:

1. Start Express server with full middleware chain (auth, rate limiting, agent-transfer routes)
2. Seed 3 active sessions in Redis for different contacts in same tenant/project
3. GET `http://localhost:${port}/api/v1/projects/${projectId}/agent-transfer/sessions` with valid bearer token
4. Assert 200 response with array of 3 sessions, each containing tenantId, contactId, channel, state, provider
5. POST `http://localhost:${port}/api/v1/projects/${projectId}/agent-transfer/sessions/${sessionKey}/end` with valid bearer token
6. Assert 200 response
7. Assert session ended in Redis (key deleted, index cleaned)
8. GET sessions list again — assert only 2 sessions remain
9. Attempt same endpoints with wrong projectId — assert 404 (project isolation)

**Expected Result**: Session management HTTP endpoints work through full auth + middleware chain with project isolation.

### E2E-5: Webhook Tenant Isolation — Cross-Tenant Returns 404

**Covers**: FR-12, FR-22
**Preconditions**: Real Express server started on random port with full middleware chain (webhook route, HMAC verification, adapter registry, session store with real Redis). Active transfer session seeded in Redis.
**Auth Context**: Webhook HMAC signature, tenant `tenant-iso`, orgId `o-iso-org`

**Steps**:

1. Start Express server with `app.listen(0)` — full middleware chain
2. Seed Redis session for `tenant-iso` with `providerData.orgId: 'o-iso-org'`, `providerSessionId: 'conv-iso-1'`
3. POST `http://localhost:${port}/api/v1/agent-transfer/webhooks/smartassist` with body `{ type: 'agent_message', conversationId: 'conv-iso-1', orgId: 'o-iso-org', message: 'Hello' }`, valid HMAC header
4. Assert 200 response — event processed
5. POST same endpoint with `orgId: 'o-attacker-org'` and valid HMAC — assert **404** response (not 403)
6. POST same endpoint with `conversationId: 'conv-nonexistent'` and valid HMAC — assert **404**
7. POST same endpoint with no HMAC header but webhook secret configured — assert **401**
8. Verify Redis session still exists and unmodified after rejection attempts

**Expected Result**: Webhook enforces tenant isolation via orgId matching. Cross-scope access returns 404 to avoid leaking existence.

### E2E-6: Webhook Boot Guard — 503 Before Initialization Complete

**Covers**: FR-12
**Preconditions**: Real Express server on random port. Agent transfer subsystem NOT yet initialized (boot service not called).
**Auth Context**: Webhook HMAC

**Steps**:

1. Start Express server with webhook route mounted but `isAgentTransferInitialized()` returns false (boot not complete)
2. POST `http://localhost:${port}/api/v1/agent-transfer/webhooks/smartassist` with valid XO event body and HMAC
3. Assert **503** response (service unavailable — not yet initialized)
4. Call boot service initialization (connect to Redis, register adapters)
5. POST same webhook request again
6. Assert 200 or 404 (processed, not blocked by boot guard)

**Expected Result**: Webhook route returns 503 before agent transfer boot completes. After initialization, requests are processed normally.

### E2E-7: Webhook Event Type Mapping — Full Pipeline Through HTTP

**Covers**: FR-12, FR-13, FR-18
**Preconditions**: Real Express server on random port, real Redis, active session with `postAgentAction: 'end'` in metadata, message bridge wired to capture array
**Auth Context**: Webhook HMAC, tenant `tenant-evt`

**Steps**:

1. Start Express server with full agent-transfer middleware chain
2. Seed active session in Redis with `metadata: { postAgentAction: 'end' }`
3. POST webhook with `{ type: 'agent_accepted', conversationId: 'conv-evt-1', orgId: 'o-evt' }` — assert 200, event mapped to `agent:connected`
4. POST webhook with `{ type: 'conversation_queued', conversationId: 'conv-evt-1', orgId: 'o-evt' }` — assert mapped to `agent:queued`
5. POST webhook with `{ type: 'agent_message', conversationId: 'conv-evt-1', orgId: 'o-evt', message: 'Agent reply', attachments: [{ url: 'https://example.com/file.pdf', name: 'file.pdf' }] }` — assert mapped to `agent:message` with attachment extracted
6. POST webhook with `{ type: 'typing', conversationId: 'conv-evt-1', orgId: 'o-evt' }` — assert mapped to `agent:typing`
7. POST webhook with `{ type: 'closed', conversationId: 'conv-evt-1', orgId: 'o-evt' }` — assert mapped to `agent:disconnected`
8. Assert session ended (postAgentAction=`end` triggers cleanup)
9. Verify session key and index keys deleted from Redis

**Expected Result**: All major XO event types flow through the full HTTP → adapter → session → bridge pipeline correctly.

---

## 5. Integration Test Scenarios (MANDATORY)

### INT-1: SmartAssistClient — initTransfer Non-Retryable vs Retryable Operations

**Covers**: FR-8
**Boundary**: SmartAssistClient → internal post() → executeRequest/executeWithRetry
**Preconditions**: SmartAssistClient with retry config (maxAttempts=2, backoffMs=100)

**Steps**:

1. Spy on `executeRequest` and `executeWithRetry` private methods
2. Mock HTTP pool to return 500 on initTransfer path
3. Call `client.initTransfer(payload)` — assert `executeRequest` called once, `executeWithRetry` NOT called
4. Assert only 1 HTTP request made (no retry for initTransfer)
5. Mock HTTP pool to return 500 on businessHours path
6. Call `client.checkBusinessHours(botId, hoursId)` — assert `executeWithRetry` called
7. Assert 3 HTTP requests made (initial + 2 retries)
8. Verify backoff timing: second attempt after ~100ms, third after ~200ms

**Expected Result**: initTransfer is non-retryable (idempotency concern). All other operations use retry with exponential backoff.

### INT-2: KoreAdapter execute() — Full Flow Ordering with DI Mock Client

**Covers**: FR-3, FR-4, FR-5, FR-6, FR-7, FR-8
**Boundary**: KoreAdapter → SmartAssistClient → TransferSessionStore
**Preconditions**: KoreAdapter with DI-injected mock SmartAssistClient, real TransferSessionStore with mock Redis

**Steps**:

1. Record call order via mock.calls timestamps
2. Call `adapter.execute()` with `hoursId`, no queue
3. Assert call order: `getAccountIdByBotId` (if no orgId) → `checkBusinessHours` → `checkAgentAvailability` → `createSyntheticUser` → `initTransfer`
4. Assert `store.create()` called after initTransfer success with correct session fields
5. Call `adapter.execute()` with queue specified
6. Assert call order includes `validateQueue` instead of `checkAgentAvailability`
7. Mock `createSyntheticUser` to return failure
8. Call `adapter.execute()` — assert `initTransfer` still called with `contactId` as userId fallback
9. Mock `checkBusinessHours` to return `{ isValid: false }`
10. Call `adapter.execute()` — assert `createSyntheticUser` and `initTransfer` NOT called (short-circuit)

**Expected Result**: Execute flow follows strict ordering. Pre-check failures short-circuit. Synthetic user failure falls back gracefully.

### INT-3: SmartAssistClient — Credential Resolution and Payload Assembly

**Covers**: FR-2, FR-9, FR-20, FR-21
**Boundary**: SmartAssistClient → HTTP pool (credential headers + payload fields)
**Preconditions**: SmartAssistClient with `koreApiKey` configured separately from `apiKey`, `ablWebhookBaseUrl` configured

**Steps**:

1. Configure client with `apiKey: 'sa-key'`, `koreApiKey: 'kore-key'`, `ablWebhookBaseUrl: 'https://abl.example.com'`
2. Spy on HTTP pool.request to capture headers and body
3. Call `client.createSyntheticUser(appId)` — assert `apiKey` header uses `'kore-key'` (KoreServer path uses koreApiKey)
4. Call `client.initTransfer(payload)` — assert `apiKey` header uses `'sa-key'` (SmartAssist path uses apiKey)
5. Assert initTransfer body includes `metaInfo.abl` with `{ webhookUrl: 'https://abl.example.com/api/v1/agent-transfer/webhooks/smartassist' }`
6. Call `client.initTransfer({ ...payload, language: 'pt-pt' })` — assert body includes `language: 'pt_pt'` (LANGUAGE_MAP applied)
7. Call `client.initTransfer({ ...payload, language: 'en' })` — assert body includes `language: 'en'` (passthrough for unmapped)
8. Call `client.updateTransfer('conv-1', { queue: 'vip' })` — assert correct endpoint called with `{ conversationId: 'conv-1', queue: 'vip' }`

**Fallback path**:

9. Configure client without `koreApiKey` — call `client.createSyntheticUser(appId)` — assert `apiKey` header falls back to `'sa-key'`
10. Configure client without `ablWebhookBaseUrl` — call `client.initTransfer(payload)` — assert `metaInfo.abl` not present

**Expected Result**: Credential selection follows koreApiKey→apiKey fallback. Webhook URL embedded when configured. Language mapping applied. updateTransfer delegates correctly.

### INT-4: Session Store — Provider Alias Index Lifecycle

**Covers**: FR-14
**Boundary**: TransferSessionStore → Redis (Lua scripts)
**Preconditions**: Mock Redis with eval/hgetall/hmget spies

**Steps**:

1. Create session with `provider: 'smartassist'`, `providerSessionId: 'conv-int-1'`, `providerData: { orgId: 'o-alias-org' }`
2. Assert primary index key created: `at_by_provider:smartassist:tenant-1:conv-int-1`
3. Assert alias key created: `at_by_provider:smartassist:o-alias-org:conv-int-1`
4. Look up by provider with tenantId: `getByProvider('smartassist', 'tenant-1', 'conv-int-1')` — assert returns session
5. Look up by alias orgId: `getByProvider('smartassist', 'o-alias-org', 'conv-int-1')` — assert returns same session
6. End session — assert both primary index and alias key deleted atomically
7. Create session with empty `providerSessionId: ''` — assert NO index key created (C7 guard)
8. Create session without providerData.orgId — assert NO alias key created

**Expected Result**: Provider alias index enables webhook lookup by Kore orgId. Empty providerSessionId skipped. Cleanup is atomic.

### INT-5: Webhook Route → Event Handler → Session Store Pipeline

**Covers**: FR-12, FR-13, FR-22
**Boundary**: Express webhook route → KoreAdapter.handleInboundEvent → TransferSessionStore
**Preconditions**: Express app with webhook route mounted, adapter registered, active session in Redis

**Steps**:

1. Seed session in Redis with `tenantId: 'tenant-wh'`, `providerSessionId: 'conv-wh-1'`, `providerData: { orgId: 'o-wh-org' }`
2. POST webhook with `{ type: 'agent_message', conversationId: 'conv-wh-1', orgId: 'o-wh-org', message: 'Agent reply' }`
3. Assert adapter.handleInboundEvent called with mapped XO event
4. Assert session looked up by provider alias (orgId path)
5. Assert session TTL extended
6. Assert message bridge callback invoked with `{ type: 'agent:message', message: 'Agent reply' }`

**Tenant isolation**:

7. POST webhook with `orgId: 'o-different'` — assert session NOT found, 404 returned
8. POST webhook with conversationId that has no session — assert 404

**Expected Result**: Webhook events flow through full pipeline. Tenant isolation enforced at session lookup.

### INT-6: Routing Executor → Adapter Registry → Connection Resolution

**Covers**: FR-1, FR-7
**Boundary**: routing-executor → adapter registry → ConnectorConnection → KoreAdapter.initialize
**Preconditions**: Mock adapter registry with KoreAdapter, mock ConnectorConnection query

**Steps**:

1. Simulate escalation with connection name `smartassist`
2. Assert adapter registry queried for `smartassist` provider
3. Assert ConnectorConnection queried by `connectionId` + `tenantId`
4. Assert encrypted credentials decrypted via `decryptJsonForTenant`
5. Assert `adapter.initialize()` called with merged config (per-connection over env defaults)
6. Assert `setOnOrgIdResolved` callback wired for DB persistence

**orgId persistence callback**:

7. Trigger `onOrgIdResolved('o-new-org')` — assert ConnectorConnection.updateOne called with `{ $set: { encryptedCredentials: <re-encrypted with orgId> } }`
8. Assert encryption uses `encryptJsonForTenant` with correct tenantId

**Expected Result**: Escalation flow resolves connection, initializes adapter, wires orgId persistence.

### INT-7: Message Bridge — Agent→User WebSocket Routing

**Covers**: FR-10, FR-11
**Boundary**: MessageBridge → WebSocket session → user
**Preconditions**: MessageBridge with registered WebSocket session, active transfer

**Steps**:

1. Register WebSocket mock for session key `agent_transfer:t1:c1:chat`
2. Route agent message `{ type: 'agent:message', message: 'Hello from agent', attachments: [] }`
3. Assert WebSocket.send called with serialized agent message
4. Route agent typing event `{ type: 'agent:typing' }`
5. Assert WebSocket.send called with typing indicator
6. Unregister WebSocket — route another message
7. Assert message NOT delivered (no crash, logged warning)

**Expected Result**: Messages routed to correct WebSocket. Missing WebSocket handled gracefully.

### INT-8: Session Atomicity — Concurrent End and Extend TTL

**Covers**: FR-14, FR-15
**Boundary**: TransferSessionStore → Redis (Lua scripts, concurrent execution)
**Preconditions**: Real Redis instance, active session created via `store.create()`

**Steps**:

1. Create session: `store.create({ tenantId: 'tenant-atom', contactId: 'contact-atom', channel: 'chat', provider: 'smartassist', providerSessionId: 'conv-atom', ownerPod: 'pod-1' })`
2. Verify session exists and provider index created
3. Launch concurrent operations: `Promise.all([store.end(sessionKey), store.extendTTL(sessionKey, 1800, 'chat')])`
4. Assert session key fully deleted (no orphan)
5. Assert provider index key deleted
6. Assert no ghost records: scan Redis for `*tenant-atom*` keys
7. Run 10 iterations of steps 1-6 to verify no race condition flakiness

**Expected Result**: Atomic Lua scripts ensure no orphaned keys under concurrent mutation.

### INT-9: Session TTL Expiry and Channel-Specific Behavior

**Covers**: FR-15
**Boundary**: TransferSessionStore → Redis (TTL configuration per channel)
**Preconditions**: Real Redis instance

**Steps**:

1. Create chat session with TTL override of 2 seconds (for test speed)
2. Assert session exists immediately
3. Wait 3 seconds
4. Assert `store.get(sessionKey)` returns null (expired)
5. Assert `store.extendTTL(sessionKey, 1800, 'chat')` returns false (no ghost record)
6. Create voice session (TTL=0, infinite)
7. Assert voice session has no TTL set (Redis TTL returns -1)
8. Assert `extendTTL` for voice returns true without running Lua script

**Expected Result**: Chat sessions expire per TTL. Voice sessions persist indefinitely. No ghost records after expiry.

### INT-10: ABL Tools — check-hours and set-queue via Tool Executor

**Covers**: FR-16, FR-17
**Boundary**: TransferToolExecutor → KoreAdapter → SmartAssistClient
**Preconditions**: KoreAdapter with DI-injected mock SmartAssistClient, tool executor wired

**Steps**:

1. Execute `check-hours` tool with `{ hoursId: 'hrs-1' }` — assert `client.checkBusinessHours` called with correct botId and hoursId
2. Mock returns `{ isValid: true }` — assert tool returns success with `available: true`
3. Mock returns `{ isValid: false }` — assert tool returns success with `available: false`
4. Mock returns error — assert tool returns structured error (not throw)
5. Execute `set-queue` tool with `{ queueId: 'support' }` — assert `client.validateQueue` called
6. Mock returns `{ isValid: true }` — assert tool returns success, `client.updateTransfer` called
7. Mock returns `{ isValid: false }` — assert tool returns validation error, `updateTransfer` NOT called

**Expected Result**: ABL tools delegate to SmartAssistClient correctly. Errors returned as structured results, not thrown.

### INT-11: KoreAdapter Pre-Check Flow — Business Hours, Queue, Availability

**Covers**: FR-3, FR-4, FR-5
**Boundary**: KoreAdapter.execute() → SmartAssistClient (pre-check APIs)
**Preconditions**: KoreAdapter with DI-injected SmartAssistClient, real Redis for session store

**Steps**:

1. Configure mocks: businessHours `{ isValid: true }`, queueAvailability `{ isValid: true }`
2. Call `adapter.execute()` with `hoursId: 'hrs-1'` and `queue: 'support'`
3. Assert `checkBusinessHours` called → then `validateQueue` called → `checkAgentAvailability` NOT called
4. Mock businessHours `{ isValid: false }` → assert error `OUTSIDE_HOURS`, initTransfer NOT called
5. Remove queue, mock availability `{ agentAvailability: false }` → assert error `NO_AGENTS`
6. Mock queue validation `{ isValid: false }` → assert error `QUEUE_INVALID`

**Expected Result**: Pre-checks enforce business rules. Queue presence determines which check runs.

### INT-12: KoreAdapter Lazy orgId Resolution — Fetch, Cache, Persist

**Covers**: FR-7
**Boundary**: KoreAdapter.resolveOrgId() → SmartAssistClient.getAccountIdByBotId → onOrgIdResolved callback
**Preconditions**: KoreAdapter with DI-injected SmartAssistClient, no orgId in config, `onOrgIdResolved` callback capture

**Steps**:

1. Initialize adapter with `appId: 'app-test'`, no orgId
2. Mock `getAccountIdByBotId` → `{ success: true, data: 'o-resolved' }`
3. Call `adapter.execute()` → assert `getAccountIdByBotId` called with `{ streamId: 'app-test' }`
4. Assert `orgId: 'o-resolved'` in initTransfer payload
5. Assert `onOrgIdResolved` callback invoked with `'o-resolved'`
6. Call `adapter.execute()` again → assert `getAccountIdByBotId` NOT called (cached)
7. Mock failure → assert transfer proceeds without orgId (degraded)

**Expected Result**: orgId fetched once, cached, persisted via callback. Failure degrades gracefully.

### INT-13: Singleton Adapter Isolation — No Stale orgId Leak (GAP-008)

**Covers**: FR-7, FR-22
**Boundary**: KoreAdapter singleton → initialize() → resolveOrgId()
**Preconditions**: KoreAdapter singleton instance, two connection configs

**Steps**:

1. Initialize adapter with project A: `{ orgId: 'o-project-a', appId: 'app-a' }`
2. Call `adapter.execute()` → assert `orgId: 'o-project-a'` used
3. Re-initialize with project B: `{ appId: 'app-b' }` — no orgId
4. Mock `getAccountIdByBotId` → `{ data: 'o-project-b' }`
5. Call `adapter.execute()` → assert uses `'o-project-b'`, NOT `'o-project-a'`

**Expected Result**: Singleton adapter does not leak orgId across project re-initializations.

---

## 6. Unit Test Scenarios

### UT-1: SmartAssistClient — getAccountIdByBotId

**Module**: `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`
**Covers**: FR-7

1. Mock HTTP to return `{ orgId: 'o-123', accountId: 'acc-456' }` — assert `orgId` preferred over `accountId`
2. Mock HTTP to return `{ accountId: 'acc-789' }` (no orgId) — assert `accountId` used as fallback
3. Mock HTTP to return empty body — assert `{ success: false, error: { code: 'KORE_GET_ACCOUNT_ID_FAILED' } }`
4. Mock HTTP timeout — assert structured error returned
5. Mock HTTP 401 — assert structured error with status code

### UT-2: SmartAssistClient — createSyntheticUser

**Module**: `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`
**Covers**: FR-6

1. Mock success response with `{ userId: 'u-abc123' }` — assert userId extracted
2. Mock 409 conflict (user exists) — assert handled gracefully
3. Mock server error — assert structured error returned

### UT-3: KoreAdapter — resolveOrgId Private Method

**Module**: `packages/agent-transfer/src/adapters/kore/index.ts`
**Covers**: FR-7

1. Config already has orgId — assert `getAccountIdByBotId` NOT called
2. Config already has accountId — assert `getAccountIdByBotId` NOT called
3. Config has no orgId/accountId, has appId — assert `getAccountIdByBotId` called
4. Config has no appId — assert warning logged, no API call
5. Resolution success — assert `smartAssistConfig.orgId` updated in-place
6. Resolution success — assert `onOrgIdResolved` callback invoked
7. `onOrgIdResolved` callback throws — assert error caught, logged, does not propagate

### UT-4: Channel→Source and Channel→ConversationType Mapping

**Module**: `packages/agent-transfer/src/adapters/kore/index.ts`
**Covers**: FR-19

1. `chat` → source `rtm`, conversationType `livechat`
2. `voice` → source `voice`, conversationType `call`
3. `email` → source `email`, conversationType `email`
4. `whatsapp` → source `whatsapp`, conversationType `livechat`
5. `slack` → source `slack`, conversationType `livechat`
6. `msteams` → source `msteams`, conversationType `livechat`
7. Unknown channel → assert default mapping or error

### UT-5: ABL Tools — check-hours and set-queue

**Module**: `packages/agent-transfer/src/tools/check-hours.ts`, `set-queue.ts`
**Covers**: FR-16, FR-17

1. check-hours: SmartAssist returns `{ isValid: true }` → tool returns available
2. check-hours: SmartAssist returns `{ isValid: false }` → tool returns unavailable
3. check-hours: SmartAssist error → tool returns structured error
4. set-queue: valid queue → SmartAssist returns `{ isValid: true }` → tool returns success
5. set-queue: invalid queue → SmartAssist returns `{ isValid: false }` → tool returns validation error
6. set-queue: calls updateTransfer after successful validation

### UT-6: Event Handler — All 22 XO Event Mappings with Structured Content

**Module**: `packages/agent-transfer/src/adapters/kore/event-handler.ts`
**Covers**: FR-13

1. For each of 22 XO event type entries in `XO_EVENT_MAP`, construct minimal XO event — assert correct ABL `AgentEventType`: `agent_message`→`agent:message`, `agent_accepted`→`agent:connected`, `conversation_queued`→`agent:queued`, `closed`/`conversation_closed`→`agent:disconnected`, `typing`→`agent:typing`, `form_message`→`agent:form`
2. Test structured content: `agent_message` with `{ type: 'text', value: 'Hello', attachments: [{ url: 'https://...', name: 'file.pdf', type: 'application/pdf' }] }` — assert attachment extracted
3. Test unknown event type — assert handled gracefully
4. Test empty/null message — assert no crash

---

## 7. Security & Isolation Tests

### Tenant Isolation

- [x] Webhook with mismatched `event.orgId` vs session `tenantId` returns **404** (not 403) — prevents existence leaking
- [x] Webhook with mismatched `event.orgId` vs session `providerData.orgId` returns **404**
- [x] Session lookup by provider requires matching tenantId in key: `at_by_provider:smartassist:{tenantId}:{conversationId}`
- [x] Session lookup by alias uses Kore orgId: `at_by_provider:smartassist:{koreOrgId}:{conversationId}`
- [x] Cross-tenant session access via direct key manipulation blocked by key structure (E2E-5 step 5-6 — crafted orgId returns 404)

### Project Isolation

- [x] ConnectorConnection queried with both `_id` and `tenantId` — cross-tenant connection access impossible
- [x] Connection credentials from project A not used when adapter re-initialized for project B (E2E-6 — GAP-008 regression, INT-6 step 7-8)

### User Isolation

- [x] Session keyed by `contactId` — different contacts have different session keys
- [x] User messages only forwarded for the active session's contact (session key match)

### Authentication

- [x] Webhook HMAC verification: invalid signature → 401
- [x] Webhook HMAC verification: missing signature with configured secret → 401
- [x] Webhook without configured secret: signature check skipped (permissive mode)
- [x] Webhook nonce replay detection: same nonce resubmitted → rejected
- [x] Route authorization: agent-transfer routes require `requireProjectPermission`

### Input Validation

- [x] Session key colon validation: keys with extra colons rejected
- [x] SSRF guard: internal IPs, localhost, private ranges blocked for outbound URLs
- [x] Zod schema validates SmartAssist config fields (baseUrl required, timeout numeric)
- [x] Webhook payload Zod validation: malformed body → 400

---

## 8. Performance & Load Tests

| Scenario                          | Type        | Metric                                    | Target        |
| --------------------------------- | ----------- | ----------------------------------------- | ------------- |
| Concurrent session create/end     | Correctness | No orphaned keys after 100 concurrent ops | 0 orphans     |
| Session TTL expiry under activity | Correctness | extendTTL prevents premature expiry       | 100%          |
| Rate limiter threshold            | Correctness | Requests above limit → 429                | As configured |
| Lua script execution time         | Performance | CREATE/END/EXTEND latency                 | < 5ms each    |

Note: Sustained throughput and connection pool exhaustion tests are out of scope for vitest. Use separate load testing tooling for those.

---

## 9. Test Infrastructure

### Required Services

| Service         | Provider                              | Config                                        |
| --------------- | ------------------------------------- | --------------------------------------------- |
| Redis 7         | Docker (docker-compose.yml)           | Port 6379, password `localdev`                |
| SmartAssist API | DI-injected mock in SmartAssistClient | Constructor injection, not vi.mock()          |
| KoreServer API  | DI-injected mock in SmartAssistClient | Same client, different paths                  |
| MongoDB         | Not required                          | orgId persistence tested via callback capture |

### Environment Variables

| Variable                 | Value                              | Purpose                          |
| ------------------------ | ---------------------------------- | -------------------------------- |
| `AGENT_TRANSFER_E2E`     | `1`                                | Gates E2E test execution         |
| `REDIS_URL`              | `redis://:localdev@localhost:6379` | Redis connection for E2E         |
| `AGENT_TRANSFER_ENABLED` | `true`                             | Enables agent transfer subsystem |

### Data Seeding

- **Redis sessions**: Seeded directly via `TransferSessionStore.create()` in beforeEach
- **SmartAssist responses**: Configured via DI mock client methods (`.mockResolvedValue()`)
- **Connection credentials**: Not seeded in DB — tested via callback capture pattern for orgId persistence
- **Test isolation**: Each test uses unique tenantId/contactId with timestamp prefix to prevent cross-test interference

### CI Configuration

- E2E tests run in CI with Redis service container
- Gated by `AGENT_TRANSFER_E2E=1` — skipped when not set
- Test timeout: 30s for E2E (Redis operations), 10s for integration, 5s for unit

---

## 10. Test File Mapping

| Test File                                                                              | Type        | Covers                                            | Status      |
| -------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------- | ----------- |
| `packages/agent-transfer/src/__tests__/smartassist-client-protocol.test.ts`            | unit        | FR-1, FR-8, FR-10, FR-11                          | EXISTS      |
| `packages/agent-transfer/src/__tests__/unit/smartassist-update-transfer.test.ts`       | unit        | FR-21                                             | EXISTS      |
| `packages/agent-transfer/src/__tests__/kore-adapter-wiring.test.ts`                    | unit        | FR-3, FR-4, FR-5, FR-6, FR-8, FR-10, FR-11, FR-18 | EXISTS      |
| `packages/agent-transfer/src/__tests__/kore-adapter-key-fixes.test.ts`                 | unit        | FR-14, FR-18                                      | EXISTS      |
| `packages/agent-transfer/src/__tests__/event-mapping-fixes.test.ts`                    | unit        | FR-13                                             | EXISTS      |
| `packages/agent-transfer/src/__tests__/unit/event-handler-attachments.test.ts`         | unit        | FR-13                                             | EXISTS      |
| `packages/agent-transfer/src/__tests__/session-lua-fixes.test.ts`                      | unit        | FR-14, FR-15                                      | EXISTS      |
| `packages/agent-transfer/src/__tests__/security-hardening.test.ts`                     | unit        | FR-12                                             | EXISTS      |
| `packages/agent-transfer/src/__tests__/integration/kore-transfer-flow.test.ts`         | integration | FR-3, FR-4, FR-5, FR-6, FR-8                      | EXISTS      |
| `packages/agent-transfer/src/__tests__/integration/backward-compat.test.ts`            | integration | FR-8, FR-19                                       | EXISTS      |
| `packages/agent-transfer/src/__tests__/e2e/kore-e2e.test.ts`                           | e2e         | FR-8, FR-14, FR-15                                | EXISTS      |
| `apps/runtime/src/__tests__/agent-transfer-webhooks.test.ts`                           | unit        | FR-12, FR-22                                      | EXISTS      |
| `apps/runtime/src/__tests__/agent-transfer-webhook-routing.test.ts`                    | unit        | FR-12, FR-13                                      | EXISTS      |
| `apps/runtime/src/__tests__/agent-transfer-bridge.test.ts`                             | unit        | FR-10                                             | EXISTS      |
| `apps/runtime/src/__tests__/agent-transfer-boot.test.ts`                               | unit        | FR-1                                              | EXISTS      |
| `apps/runtime/src/__tests__/auth/agent-transfer-routes-authz.test.ts`                  | unit        | FR-12                                             | EXISTS      |
| `apps/runtime/src/__tests__/escalation-transfer-wiring.test.ts`                        | unit        | FR-7                                              | EXISTS      |
| `apps/runtime/src/__tests__/transfer-tool-executor.test.ts`                            | unit        | FR-16, FR-17                                      | EXISTS      |
| `packages/agent-transfer/src/__tests__/unit/smartassist-orgid-resolution.test.ts`      | unit        | FR-7                                              | **PLANNED** |
| `packages/agent-transfer/src/__tests__/e2e/kore-orgid-resolution-e2e.test.ts`          | e2e         | FR-7                                              | **PLANNED** |
| `packages/agent-transfer/src/__tests__/e2e/kore-singleton-isolation-e2e.test.ts`       | e2e         | FR-7, FR-22                                       | **PLANNED** |
| `packages/agent-transfer/src/__tests__/integration/kore-webhook-pipeline.test.ts`      | integration | FR-12, FR-13, FR-22                               | **PLANNED** |
| `packages/agent-transfer/src/__tests__/integration/kore-abl-tools.test.ts`             | integration | FR-16, FR-17                                      | **PLANNED** |
| `packages/agent-transfer/src/__tests__/integration/kore-session-atomicity.test.ts`     | integration | FR-14, FR-15                                      | **PLANNED** |
| `packages/agent-transfer/src/__tests__/integration/kore-credential-resolution.test.ts` | integration | FR-2, FR-9, FR-20, FR-21                          | **PLANNED** |
| `apps/runtime/src/__tests__/kore-webhook-e2e.test.ts`                                  | e2e         | FR-12, FR-13, FR-22                               | **PLANNED** |

---

## 11. Open Testing Questions

1. ~~Should E2E tests for the webhook route start a real Express server?~~ **RESOLVED**: Yes. Per CLAUDE.md E2E standards, E2E tests must start real Express servers on random ports with full middleware chain. Adapter-level tests against Redis are classified as integration tests (INT-8, INT-9).
2. Should the orgId persistence callback be tested against real MongoDB in a separate E2E suite, or is the callback capture pattern sufficient?
3. Should circuit breaker behavior (open/half-open/close transitions) have dedicated integration tests, or is the current unit coverage in security-hardening.test.ts sufficient?
4. Should session recovery service (SSCAN-based) have E2E coverage, given it's marked as best-effort (GAP-004)?
5. What is the acceptable flakiness rate for concurrent Redis operation tests (INT-8)? Should we add retry logic to the test or require 100% pass rate?
