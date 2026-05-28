# Test Specification: Five9 Agent Transfer Adapter

**Feature Spec**: `docs/features/sub-features/five9-adapter.md`
**Parent Feature**: [Agent Transfer](../../features/agent-transfer.md)
**HLD**: `docs/specs/five9-adapter.hld.md`
**LLD**: `docs/plans/2026-03-24-five9-adapter-impl-plan.md`
**Status**: IN PROGRESS
**Last Updated**: 2026-03-25

---

## 1. Feature Metadata

- **Package(s)**: `packages/agent-transfer`, `apps/runtime`, `apps/studio`
- **Feature Area**: integrations, customer experience
- **Risk Level**: Medium (new external API integration, webhook route control-flow change, webhook security relies on URL uniqueness)

---

## 2. Current State

77+ tests passing across 9 test files (23 unit + 28 integration + 26 E2E + escalation wiring). E2E tests gated by `AGENT_TRANSFER_E2E=1`. Post-implementation enhancements (435 handling, availability check, message forwarding, session flag reset) verified via manual testing with live Five9 tenant. Test mocks aligned with actual API shapes after develop merge (2026-03-25): metadata response uses `metadata.dataCenters` with `{host,port}` objects, `createConversation` requires `tenantId`, `checkAgentAvailability` step added to adapter execute flow, schema host transform normalizes protocol/path. Latest changes (2026-03-25): contact details (firstName, lastName, email, phone) and conversation history now passed to Five9 createConversation payload; `sendMessage` uses Five9 `messageType`/`message` format with `farmId` header; `contactDisplayName` resolved from Contact entity during SDK session init and propagated via `CallerContext`; `TransferContact` type added to `types.ts`; `ContactLinkingResult` returned from contact linking with `displayName`.

Test files:

- `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.test.ts` — 23 unit tests
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-event-handler.test.ts` — 11 unit tests
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter.test.ts` — 15 unit tests
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.integration.test.ts` — 17 integration tests
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-cleanup.integration.test.ts` — 3 integration tests
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-registry.integration.test.ts` — 8 integration tests
- `apps/runtime/src/__tests__/five9-webhook.e2e.test.ts` — E2E webhook tests (gated)
- `apps/runtime/src/__tests__/five9-transfer.e2e.test.ts` — E2E transfer lifecycle tests (gated)
- `apps/runtime/src/__tests__/escalation-transfer-wiring.test.ts` — handleEscalate → agent-transfer wiring, HITL fallback

---

## 3. Coverage Matrix

| FR    | Description                                     | Unit | Integration | E2E | Manual | Status   |
| ----- | ----------------------------------------------- | ---- | ----------- | --- | ------ | -------- |
| FR-1  | Anonymous auth with Five9                       | ✅   | ✅          | ✅  | -      | COVERED  |
| FR-2  | Supervisor auth with Five9                      | ✅   | ✅          | ✅  | -      | COVERED  |
| FR-3  | Metadata discovery (orgId, farmId, targetHost)  | ✅   | ✅          | -   | -      | COVERED  |
| FR-4  | Conversation creation on Five9                  | ✅   | ✅          | ✅  | -      | COVERED  |
| FR-5  | Forward user messages to Five9                  | ✅   | -           | ✅  | -      | COVERED  |
| FR-6  | Webhook receives and normalizes Five9 events    | -    | -           | ✅  | -      | COVERED  |
| FR-7  | Event type mapping (Five9 → AgentEventType)     | ✅   | ✅          | -   | -      | COVERED  |
| FR-8  | Message bridge routes agent messages to user    | -    | -           | ✅  | -      | COVERED  |
| FR-9  | Session end (API + Five9-initiated)             | ✅   | ✅          | ✅  | -      | COVERED  |
| FR-10 | Session token encrypted in Redis                | -    | ❌          | -   | -      | DEFERRED |
| FR-11 | Five9 provider registered in Studio             | -    | ✅          | -   | -      | PARTIAL  |
| FR-12 | Zod schema validates Five9 config               | ✅   | -           | -   | -      | COVERED  |
| FR-13 | Edit icon opens EditConnectionDialog            | -    | ❌          | -   | -      | DEFERRED |
| FR-14 | Password masking and changed-fields-only save   | -    | ❌          | -   | -      | DEFERRED |
| FR-15 | Tenant isolation via callback URL `tid` param   | -    | -           | ✅  | -      | COVERED  |
| FR-16 | Agent availability check blocks when no agents  | -    | -           | -   | ✅     | COVERED  |
| FR-17 | 435 "Service migrated" handling + retry         | -    | -           | -   | ✅     | COVERED  |
| FR-18 | Post-transfer message forwarding to Five9       | -    | -           | -   | ✅     | COVERED  |
| FR-19 | Session flags reset on transfer failure         | ✅   | -           | -   | ✅     | COVERED  |
| FR-20 | Async handleEscalate returns failure messages   | ✅   | -           | -   | ✅     | COVERED  |
| FR-21 | Contact details passed to Five9 conversation    | -    | -           | -   | ✅     | PARTIAL  |
| FR-22 | Conversation history forwarded to Five9         | -    | -           | -   | ✅     | PARTIAL  |
| FR-23 | contactDisplayName resolved from Contact entity | ✅   | -           | -   | -      | PARTIAL  |
| FR-24 | Typing indicator sent to Five9 (best-effort)    | ✅   | -           | -   | -      | COVERED  |

Legend: ✅ = Covered, ❌ = Not covered, - = N/A

---

## 4. E2E Test Scenarios

> CRITICAL: E2E tests must exercise the real system through its HTTP API. No mocks of codebase components, no direct DB access, no stubbed servers. Only the Five9 external API may be mocked via dependency injection in `Five9Client`.

### E2E-1: Five9 Webhook — Valid Agent Message Routed

**Covers**: FR-6, FR-7, FR-8, FR-15
**Preconditions**: Five9Adapter registered in AdapterRegistry, transfer session active in Redis with `provider=five9`, provider reverse index seeded, `onAgentMessage` callback wired to a capture array

**Steps**:

1. Start real Express server on random port (`{ port: 0 }`) with full middleware chain (agent-transfer webhook route mounted)
2. Create a transfer session in Redis via `TransferSessionStore.create()` with `provider: 'five9'`, `tenantId: 'tenant-e2e-1'`, `providerSessionId: 'conv-five9-001'`
3. POST to `http://localhost:{port}/api/v1/agent-transfer/webhooks/five9?tid=tenant-e2e-1` with body:
   ```json
   {
     "type": "agent_message",
     "conversationId": "conv-five9-001",
     "message": "Hello from Five9 agent",
     "agentInfo": { "name": "Agent Smith", "id": "agent-42" }
   }
   ```
4. Assert response is `200 OK` with `{ success: true }`
5. Assert the `onAgentMessage` capture received an `AgentEvent` with:
   - `type: 'agent:message'`
   - `tenantId: 'tenant-e2e-1'`
   - `data.message` containing "Hello from Five9 agent"

**Auth context**: No platform auth required on webhook endpoint (Five9 callbacks are unauthenticated)
**Isolation check**: Repeat step 3 with `?tid=tenant-OTHER` → assert 404

---

### E2E-2: Five9 Webhook — Unknown Conversation Returns 404

**Covers**: FR-6, FR-15
**Preconditions**: Five9Adapter registered, no matching transfer session in Redis

**Steps**:

1. Start real Express server on random port with full middleware chain
2. POST to `http://localhost:{port}/api/v1/agent-transfer/webhooks/five9?tid=tenant-e2e-2` with body:
   ```json
   {
     "type": "agent_message",
     "conversationId": "conv-nonexistent",
     "message": "This should fail"
   }
   ```
3. Assert response is `404` with `{ success: false, error: { code: 'SESSION_NOT_FOUND' } }`

---

### E2E-3: Five9 Webhook — Tenant Mismatch Returns 404

**Covers**: FR-15
**Preconditions**: Five9Adapter registered, transfer session exists for `tenantId: 'tenant-A'` with `conversationId: 'conv-tenant-test'`

**Steps**:

1. Start real Express server on random port with full middleware chain
2. Create session in Redis with `tenantId: 'tenant-A'`, `provider: 'five9'`, `providerSessionId: 'conv-tenant-test'`
3. POST to `http://localhost:{port}/api/v1/agent-transfer/webhooks/five9?tid=tenant-B` with body:
   ```json
   {
     "type": "agent_message",
     "conversationId": "conv-tenant-test",
     "message": "Cross-tenant attempt"
   }
   ```
4. Assert response is `404` (NOT 403 — per platform invariant to avoid leaking session existence)
5. Assert response body contains `{ success: false, error: { code: 'SESSION_NOT_FOUND' } }`

---

### E2E-4: Five9 Webhook — Malformed Payload Returns 400

**Covers**: FR-6
**Preconditions**: Five9Adapter registered

**Steps**:

1. Start real Express server on random port with full middleware chain
2. POST to `http://localhost:{port}/api/v1/agent-transfer/webhooks/five9?tid=tenant-e2e-4` with body `{}` (empty object — missing `type` and `conversationId`)
3. Assert response is `400` with `{ success: false, error: { code: 'INVALID_EVENT' } }`

**Variant**: POST with `{ "type": "agent_message" }` (missing `conversationId`) → also 400

---

### E2E-5: Full Transfer Lifecycle (with Mocked Five9 API)

**Covers**: FR-1, FR-3, FR-4, FR-5, FR-8, FR-9, FR-10
**Preconditions**: Five9Adapter registered with `Five9Client` constructor injected with a mock Five9 HTTP server URL

**Steps**:

1. Start mock Five9 API server on random port responding to:
   - `POST /appsvcs/rs/svc/auth/anon?cookieless=true` → `{ tokenId: 'mock-token-123' }`
   - `GET /appsvcs/rs/svc/auth/metadata` → `{ orgId: 'org-mock', farmId: 'farm-1', metadata: { dataCenters: [{ apiUrls: [{ host: 'localhost:{mockPort}' }] }] } }`
   - `POST /appsvcs/rs/svc/conversations` → `{ conversationId: 'conv-lifecycle-001' }`
   - `POST /appsvcs/rs/svc/conversations/conv-lifecycle-001/messages` → `200 OK`
   - `DELETE /appsvcs/rs/svc/conversations/conv-lifecycle-001` → `200 OK`
2. Start real Express server on random port with full middleware chain (webhook route mounted)
3. Call `adapter.execute(transferPayload)` where `transferPayload` includes `tenantId: 'tenant-lifecycle'`, `contactId: 'contact-1'`, `channel: 'chat'`
4. Assert `TransferResult` has `status: 'success'` and `conversationId: 'conv-lifecycle-001'`
5. Assert session exists in Redis via `sessionStore.get()` with `provider: 'five9'`, `providerSessionId: 'conv-lifecycle-001'`
6. Call `adapter.sendUserMessage(sessionKey, { content: 'User says hello' })`
7. Assert mock Five9 server received POST to `/appsvcs/rs/svc/conversations/conv-lifecycle-001/messages` with body containing "User says hello"
8. POST to webhook via HTTP: `http://localhost:{port}/api/v1/agent-transfer/webhooks/five9?tid=tenant-lifecycle` with `{ type: 'agent_message', conversationId: 'conv-lifecycle-001', message: 'Agent reply' }`
9. Assert `onAgentMessage` callback received the agent event
10. Call `adapter.endSession(sessionKey, 'user_ended')`
11. Assert mock Five9 server received DELETE to `/appsvcs/rs/svc/conversations/conv-lifecycle-001`
12. Assert session no longer exists in Redis (verify via `sessionStore.get()` returns null)

**Auth context**: Transfer initiation (steps 3, 6, 10) calls adapter methods directly. The webhook portion (step 8) exercises the full Express middleware chain via HTTP.

**Justification for direct adapter calls**: Agent transfers are initiated by the runtime execution pipeline when an AI agent invokes the `transfer_to_agent` tool — there is no HTTP endpoint that directly triggers `adapter.execute()`. The execution pipeline is an internal code path, not an HTTP API. The same applies to `sendUserMessage()` (called by the message relay loop) and `endSession()` (called by the session manager). The auth layer sits above the adapter at the execution pipeline level (tenant/project context is resolved before the adapter is called). The webhook portion (step 8) is the only HTTP-facing surface and IS exercised via real HTTP. This matches the existing `kore-e2e.test.ts` pattern.

**Note**: Five9 API is the only external dependency mocked (via DI, not `vi.mock()`). All internal infrastructure (Redis, Express, middleware) is real.

---

### E2E-6: Kore Webhook Backward Compatibility Regression

**Covers**: FR-6, FR-7 (backward compatibility)
**Preconditions**: Both KoreAdapter and Five9Adapter registered, Kore transfer session active in Redis

**Steps**:

1. Start real Express server on random port with full middleware chain
2. Create a Kore transfer session in Redis with `provider: 'kore'`, `tenantId: 'tenant-kore-compat'`, `providerSessionId: 'conv-kore-001'`
3. POST to `http://localhost:{port}/api/v1/agent-transfer/webhooks/kore` with standard Kore XOEvent body:
   ```json
   {
     "type": "agent_message",
     "conversationId": "conv-kore-001",
     "orgId": "tenant-kore-compat",
     "message": "Kore agent message",
     "agentInfo": { "firstName": "Kore", "lastName": "Agent" }
   }
   ```
4. Assert response is `200 OK`
5. Assert the `onAgentMessage` callback received the event correctly
6. Verify the `KoreEventHandler.mapEventType()` path was used (not Five9EventHandler)

**Why this test matters**: The webhook route at `agent-transfer-webhooks.ts` is the ONLY modification to existing production code. This test ensures Kore webhooks continue to work identically after the Five9 normalization block is added.

---

### E2E-7: Five9 Webhook — Missing `tid` Query Parameter

**Covers**: FR-15
**Preconditions**: Five9Adapter registered

**Steps**:

1. Start real Express server on random port with full middleware chain
2. POST to `http://localhost:{port}/api/v1/agent-transfer/webhooks/five9` (NO `tid` parameter) with a valid Five9 payload:
   ```json
   {
     "type": "agent_message",
     "conversationId": "conv-no-tid",
     "message": "Missing tenant"
   }
   ```
3. Assert response is `400` with `{ success: false, error: { code: 'MISSING_TENANT' } }`

**Why**: Five9 payloads lack `orgId`. Without `tid`, tenant cannot be resolved.

---

### E2E-8: Five9 Transfer Lifecycle — Supervisor Auth Mode

**Covers**: FR-2, FR-3, FR-4
**Preconditions**: Five9Adapter initialized with `authMode: 'supervisor'`, mock Five9 API server configured for supervisor auth

**Steps**:

1. Start mock Five9 API server on random port responding to:
   - `POST /appsvcs/rs/svc/auth/anon?cookieless=true` → verify request body includes `username` and `password`, return `{ tokenId: 'supervisor-token' }`
   - `GET /appsvcs/rs/svc/auth/metadata` → return metadata
   - `POST /appsvcs/rs/svc/conversations` → return `{ conversationId: 'conv-super-001' }`
2. Start real Express server on random port with full middleware chain
3. Call `adapter.execute(transferPayload)` with supervisor config
4. Assert mock Five9 server received auth request with `username` and `password` fields in body
5. Assert `TransferResult` has `status: 'success'`
6. Assert session exists in Redis via `sessionStore.get()` with encrypted `token` field

**Auth context**: Transfer initiation calls adapter directly (see E2E-5 justification — `adapter.execute()` is invoked by the runtime execution pipeline, not an HTTP endpoint). Tenant/project auth is resolved at the execution pipeline level before the adapter is called.

---

### E2E-9: Five9 Transfer Initiation — Five9 API Auth Failure

**Covers**: FR-1, FR-2 (error path)
**Preconditions**: Five9Adapter registered with mock Five9 API server that returns 401 for auth

**Steps**:

1. Start mock Five9 API server on random port responding to:
   - `POST /appsvcs/rs/svc/auth/anon?cookieless=true` → `401 Unauthorized` with `{ error: 'Invalid tenant' }`
2. Start real Express server on random port with full middleware chain
3. Call `adapter.execute(transferPayload)` with `tenantId: 'tenant-auth-fail'`
4. Assert `TransferResult` has `status: 'failed'` and `error: { code: 'FIVE9_AUTH_FAILED' }`
5. Assert NO session was created in Redis (verify via `sessionStore.get()` returns null)
6. Assert mock Five9 server received exactly one auth request (no retry)

**Auth context**: Same justification as E2E-5 — direct adapter call from execution pipeline.

**Why this test matters**: Five9 auth failure is the most likely production error path (wrong tenant name, expired credentials). The system must return a structured error and must NOT create orphaned sessions.

---

## 5. Integration Test Scenarios

### INT-1: Five9Client Authentication — Anonymous Mode

**Boundary**: Five9Client → Five9 REST API (mock HTTP server)
**Covers**: FR-1

**Setup**: Start mock HTTP server responding to `POST /appsvcs/rs/svc/auth/anon?cookieless=true` with `{ tokenId: 'anon-token-xyz' }`

**Steps**:

1. Create `Five9Client` with mock server URL as `host`
2. Call `client.authenticate({ authMode: 'anonymous', tenantName: 'test-tenant' })`
3. Assert returns `{ token: 'anon-token-xyz' }`
4. Assert mock server received request with body containing `tenantName: 'test-tenant'`
5. Assert request body does NOT contain `username` or `password`

**Failure Mode**: Mock returns 401 → `Five9Client` throws with `code: 'FIVE9_AUTH_FAILED'`

---

### INT-2: Five9Client Authentication — Supervisor Mode

**Boundary**: Five9Client → Five9 REST API (mock HTTP server)
**Covers**: FR-2

**Setup**: Start mock HTTP server responding to supervisor auth endpoint

**Steps**:

1. Create `Five9Client` with mock server URL
2. Call `client.authenticate({ authMode: 'supervisor', tenantName: 'test-tenant', username: 'admin', password: 'secret123' })`
3. Assert returns auth result with token
4. Assert mock server received request body containing `tenantName`, `username`, and `password`

---

### INT-3: Five9Client — Auth Failure Returns Structured Error

**Boundary**: Five9Client → Five9 REST API (mock HTTP server)
**Covers**: FR-1, FR-2 (error paths)

**Setup**: Start mock HTTP server returning 401 for auth endpoint

**Steps**:

1. Create `Five9Client` with mock server URL
2. Call `client.authenticate(...)` for both anonymous and supervisor modes
3. Assert each throws with structured error: `{ code: 'FIVE9_AUTH_FAILED', message: '<descriptive>' }`
4. Assert error message includes the HTTP status code

**Variant**: Mock returns network timeout → throws with `code: 'FIVE9_AUTH_TIMEOUT'`

---

### INT-4: Five9Client — Metadata Discovery Resolves targetHost

**Boundary**: Five9Client → Five9 REST API (mock HTTP server)
**Covers**: FR-3

**Setup**: Mock server responds to `GET /appsvcs/rs/svc/auth/metadata` with farm/datacenter metadata

**Steps**:

1. Authenticate successfully (mock auth endpoint returns token)
2. Call `client.discoverMetadata(token)`
3. Assert returns `{ orgId, farmId, targetHost }` extracted from the metadata response
4. Assert subsequent API calls (conversation creation) use `targetHost` as base URL

**Failure Mode**: Mock returns 500 for metadata → throws with `code: 'FIVE9_DISCOVERY_FAILED'`

---

### INT-5: Five9Client — Conversation Creation

**Boundary**: Five9Client → Five9 REST API (mock HTTP server)
**Covers**: FR-4

**Setup**: Mock server responds to `POST /appsvcs/rs/svc/conversations` with `{ conversationId: 'conv-int-001' }`

**Steps**:

1. Call `client.createConversation({ campaignName: 'Support', callbackUrl: 'https://example.com/webhook', contactInfo: { name: 'User' } })`
2. Assert returns `{ conversationId: 'conv-int-001' }`
3. Assert mock received request body containing `campaignName`, `callbackUrl`, and `contactInfo`

**Failure Mode**: Mock returns 400 → throws with `code: 'FIVE9_CONVERSATION_FAILED'`

---

### INT-6: Five9Client — SSRF Guard Validates Outbound URLs

**Boundary**: Five9Client → SSRF guard → (blocked)
**Covers**: Security

**Steps**:

1. Create `Five9Client` with `host: 'localhost'`
2. Call `client.authenticate(...)`
3. Assert SSRF guard rejects the request BEFORE it is sent
4. Assert error message includes "SSRF blocked"

**Variants**: Test with `host: '127.0.0.1'`, `host: '10.0.0.1'`, `host: '169.254.169.254'`, `host: '[::1]'`

---

### INT-7: Five9Adapter — Session Token Encrypted in Redis

**Boundary**: Five9Adapter → TransferSessionStore → TenantScopedSessionEncryptor → Redis
**Covers**: FR-10

**Setup**: Real Redis, real `TenantScopedSessionEncryptor` with test encryption key

**Steps**:

1. Initialize `Five9Adapter` with mock Five9 API returning `tokenId: 'sensitive-bearer-token'`
2. Execute a transfer that creates a session in Redis
3. Read the raw Redis hash directly (exception to "no direct Redis access" rule — documented here)
4. Assert the `token` field value is NOT `'sensitive-bearer-token'` (it's encrypted)
5. Assert the session store's `get()` method returns the decrypted `token: 'sensitive-bearer-token'`

**Why direct Redis access**: This is the ONLY integration test that needs direct Redis access — to verify encryption at rest. Documented as an explicit exception per feature spec Section 17 Testing Notes. Direct Redis reads use the same key prefix convention (`e2e_five9_{Date.now()}`) and are cleaned up in `afterAll` alongside all other test keys.

---

### INT-8: Five9Adapter — endSession Cleans Up Even When Five9 API Fails

**Boundary**: Five9Adapter → Five9Client (failing) + TransferSessionStore (real Redis)
**Covers**: FR-9 (error path)

**Setup**: Mock Five9 API returns 500 for DELETE conversation

**Steps**:

1. Create active session in Redis via `adapter.execute()`
2. Call `adapter.endSession(sessionKey, 'user_ended')`
3. Assert the session is cleaned up from Redis (session store returns null)
4. Assert Five9 API failure was logged at WARN level (not thrown)

**Why this matters**: Feature spec error handling table states: "Five9 end conversation failure → WARN, session still cleaned up locally"

---

### INT-9: EditConnectionDialog — Renders Provider Fields

**Boundary**: EditConnectionDialog → agent-desktop-registry
**Covers**: FR-13

**Setup**: Render `EditConnectionDialog` component with `providerId: 'five9'` and mock connection data

**Steps**:

1. Assert all 7 Five9 fields rendered: `tenantName`, `campaignName`, `host`, `authMode`, `username`, `password`, `callbackUrl`
2. Assert `password` field has `type="password"` (masked)
3. Assert field labels match provider definition from `AGENT_DESKTOP_PROVIDERS`
4. Assert dialog title includes provider display name

---

### INT-10: EditConnectionDialog — Saves Only Changed Fields

**Boundary**: EditConnectionDialog → PUT API (`updateConnection()`)
**Covers**: FR-14

**Setup**: Render dialog with empty credential fields, mock the PUT API endpoint

**Steps**:

1. Render dialog for a Five9 connection — password fields start empty
2. Fill `campaignName` field with "Support", leave password blank
3. Click save button
4. Assert PUT request body contains `{ credentials: { campaignName: 'Support' } }` — password omitted because user left it blank
5. Assert `updateConnection()` was called with correct `projectId` and `connectionId`

---

### INT-11: Five9Adapter Registration in AdapterRegistry

**Boundary**: Five9Adapter → AdapterRegistry
**Covers**: FR-11 (runtime side)

**Steps**:

1. Create `AdapterRegistry` instance
2. Register `Five9Adapter`: `registry.register('five9', five9Adapter)`
3. Assert `registry.get('five9')` returns the adapter instance
4. Assert `registry.has('five9')` returns `true`
5. Assert `registry.listNames()` includes `'five9'`
6. Attempt duplicate registration: `registry.register('five9', anotherAdapter)` → throws
7. Assert `registry.get('nonexistent')` returns `undefined`

---

### INT-12: Five9Client — Handles Unexpected HTTP Status Codes

**Boundary**: Five9Client → Five9 REST API (mock HTTP server)
**Covers**: Error handling

**Setup**: Mock Five9 server returning various non-2xx responses

**Steps**:

1. Mock returns `429 Too Many Requests` with body `{ "error": "Rate limit exceeded" }` → verify error includes status code and body (truncated to 500 chars)
2. Mock returns `500 Internal Server Error` with large body (>1000 chars) → verify error body is truncated to 500 chars
3. Mock returns `503 Service Unavailable` → verify structured error with descriptive message
4. Mock returns `200 OK` with malformed JSON → verify error handling for parse failure

---

## 6. Unit Test Scenarios

### UT-1: Five9Client — authenticate() Constructs Correct Request Body

**Module**: `five9-client.ts`
**Input**: `{ authMode: 'anonymous', tenantName: 'acme' }`
**Expected**: POST body = `{ tenantName: 'acme' }`, URL ends with `/appsvcs/rs/svc/auth/anon?cookieless=true`

### UT-2: Five9Client — authenticate() Supervisor Mode Includes Credentials

**Module**: `five9-client.ts`
**Input**: `{ authMode: 'supervisor', tenantName: 'acme', username: 'admin', password: 'pass' }`
**Expected**: POST body includes `tenantName`, `username`, `password`

### UT-3: Five9Adapter — execute() Stores Session with Correct Fields

**Module**: `five9/index.ts`
**Input**: Valid `TransferPayload`
**Expected**: `TransferSessionStore.create()` called with `provider: 'five9'`, `providerSessionId: <conversationId>`, Five9 metadata fields

### UT-4: Five9Adapter — sendUserMessage() Looks Up Session and Forwards

**Module**: `five9/index.ts`
**Input**: Valid session key, `{ content: 'Hello' }`
**Expected**: `Five9Client.sendMessage()` called with correct `conversationId` and message content

### UT-5: Five9Adapter — endSession() Calls Five9 API and Cleans Store

**Module**: `five9/index.ts`
**Input**: Valid session key, reason `'user_ended'`
**Expected**: `Five9Client.endConversation()` called, then `sessionStore.delete()` called

### UT-6: Five9Adapter — handleInboundEvent() Fires Correct Callbacks

**Module**: `five9/index.ts`
**Input**: XOEvent with `type: 'agent_message'`
**Expected**: `onAgentMessage` callback fired with normalized `AgentEvent`

### UT-7: Five9EventHandler — Unknown Event Type Returns Undefined

**Module**: `five9-event-handler.ts`
**Input**: `'some_future_five9_event'`
**Expected**: Returns `undefined` (Map.get() semantics — event is logged and dropped, not an error)

### UT-8: Five9Adapter — initialize() Rejects Invalid authMode

**Module**: `five9/index.ts`
**Input**: Config with `authMode: 'oauth2'`
**Expected**: Throws with descriptive error about invalid auth mode

### UT-9: Five9Client — createConversation() Includes callbackUrl with tid

**Module**: `five9-client.ts`
**Input**: `{ campaignName: 'Support', callbackUrl: 'https://app.example.com/api/v1/agent-transfer/webhooks/five9?tid=tenant-1' }`
**Expected**: POST body includes the full `callbackUrl` with `tid` query parameter

### UT-10: Five9Client — sendMessage() Uses targetHost from Discovery

**Module**: `five9-client.ts`
**Input**: Message to send after metadata discovery returned `targetHost: 'farm2.five9.com'`
**Expected**: Request URL uses `https://farm2.five9.com/appsvcs/rs/svc/conversations/{id}/messages`

### UT-11: Five9EventHandler — Maps All Five9 Event Types

**Module**: `five9-event-handler.ts`
**Input/Expected**:

1. `mapEventType('agent_message')` → `'agent:message'`
2. `mapEventType('agent_joined')` → `'agent:joined'`
3. `mapEventType('conversation_closed')` → `'agent:disconnected'`
4. `mapEventType('conversation_queued')` → `'agent:queued'`
5. `mapEventType('unknown_event_type')` → `undefined`

### UT-12: Zod Schema — Validates Five9 Provider Config

**Module**: `config/schema.ts`
**Input/Expected**:

1. Valid anonymous config `{ tenantName: 'acme', campaignName: 'Support', host: 'app.five9.com', authMode: 'anonymous' }` → succeeds
2. Valid supervisor config with `username`/`password` → succeeds
3. Supervisor without password → fails with "username and password required for supervisor auth mode"
4. Invalid `authMode: 'oauth2'` → fails
5. Missing `tenantName` → fails
6. Missing `campaignName` → fails

### UT-13: Five9Client — sendMessage() Failure Throws Structured Error

**Module**: `five9-client.ts`
**Input**: `sendMessage(conversationId, message)` where Five9 API returns `500 Internal Server Error`
**Expected**: Throws with structured error including Five9 HTTP status code. Error is NOT silently swallowed — caller in execution pipeline handles retries/fallback per existing agent-transfer patterns.

---

## 7. Security & Isolation Tests

### Tenant Isolation

- [x] Cross-tenant webhook access returns 404 (E2E-3) — `tid=tenant-B` with session belonging to `tenant-A`
- [x] Missing `tid` returns 400 (E2E-7) — Five9 payload lacks `orgId`, no `tid` in URL
- [x] Provider reverse index is tenant-scoped — `at_by_provider:five9:{tenantId}:{conversationId}` prevents collisions
- [x] Session lookup requires BOTH `tenantId` AND `conversationId` — neither alone is sufficient

### Project Isolation

- [x] Five9 connections are project-scoped via existing connection CRUD API — cross-project access returns 404
- [x] Connection CRUD routes use `requireProjectPermission()` middleware
- Note: Cross-project isolation for connections is covered by the existing connection CRUD test suite (`apps/studio/src/__tests__/connections.test.ts`). No Five9-specific project isolation test needed — Five9 uses the same connection model as all other providers.

### User Isolation

- [x] Sessions scoped to `contactId` + `channel` — a user can only interact with their own active transfer session
- [x] Five9 `conversationId` is opaque — never used in MongoDB queries or filesystem operations

### Credential Security

- [P] Five9 bearer token encrypted at rest in Redis via `TenantScopedSessionEncryptor` (INT-7) — DEFERRED (no React test setup)
- [x] Supervisor password used only in HTTPS auth request body — never stored in Redis session
- [P] Password fields masked in `EditConnectionDialog` (INT-9) — DEFERRED (no React test setup)
- [x] Connection credentials encrypted in MongoDB via `encryptionPlugin`
- [x] Bearer tokens, passwords, PII never appear in log context

### Input Validation

- [x] Malformed webhook payload returns 400 (E2E-4) — missing `type` or `conversationId`
- [x] Zod schema rejects invalid `authMode` values (UT-12 case 4)
- [x] Zod schema rejects supervisor mode without credentials (UT-12 case 3)
- [x] `conversationId` from Five9 treated as opaque string — never interpolated into queries

### SSRF Protection

- [x] SSRF guard blocks private IPs, localhost, link-local (INT-6)
- [x] All outbound Five9Client HTTP calls go through SSRF guard

Legend: P = Planned (deferred), X = Covered by tests

---

## 8. Performance & Load Tests

No dedicated performance/load test scenarios for the Five9 adapter. Rationale:

- Five9 API calls are mocked in tests — load testing against mocks is meaningless
- Session store throughput is a parent feature concern (NFR-03 of Agent Transfer)
- Webhook processing is O(1) normalization + session lookup (same as Kore)

**Latency assertion** (included in E2E-5): Transfer initiation against mock Five9 API should complete in < 5 seconds (generous for mock; production target is < 3s per feature spec).

---

## 9. Test Infrastructure

### Required Services

| Service                | Purpose                               | Setup                                                |
| ---------------------- | ------------------------------------- | ---------------------------------------------------- |
| Redis                  | Session store, provider reverse index | `docker-compose.yml` → `redis://localhost:6379`      |
| Mock Five9 HTTP server | Simulates Five9 REST API              | Express server on random port, started in test setup |

### Environment Variables

| Variable             | Value                    | Purpose                                       |
| -------------------- | ------------------------ | --------------------------------------------- |
| `AGENT_TRANSFER_E2E` | `1`                      | Gates E2E test execution (skipped by default) |
| `REDIS_URL`          | `redis://localhost:6379` | Redis connection (default if unset)           |

### Data Seeding

- **Redis sessions**: Created via `TransferSessionStore.create()` with unique test prefixes (`e2e_five9_{Date.now()}`)
- **Provider reverse index**: Automatically created by session store's Lua create script
- **Mock Five9 API**: Express server responding to auth, metadata, conversation, message, and end endpoints
- **Cleanup**: All Redis keys with test prefix deleted in `afterAll`

### Test Helpers (new)

| Helper                 | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `mock-five9-server.ts` | Creates Express server mimicking Five9 REST API endpoints   |
| `five9-fixtures.ts`    | Five9-specific test data: payloads, configs, webhook events |

### CI Configuration

- E2E tests run in CI with `AGENT_TRANSFER_E2E=1` and Redis service container
- Build order: `pnpm build --filter=@agent-platform/agent-transfer` before test execution

---

## 10. Test File Mapping

| Test File                                                                                               | Type        | Covers                                                    | Status   |
| ------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- | -------- |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.test.ts`                             | unit        | FR-1, FR-2, FR-3, FR-4, FR-5, FR-12 (UT-1, UT-2, UT-9–13) | PASSING  |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter.test.ts`                            | unit        | FR-4, FR-5, FR-9 (UT-3, UT-4, UT-5, UT-6, UT-8)           | PASSING  |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-event-handler.test.ts`                      | unit        | FR-7 (UT-7, UT-11)                                        | PASSING  |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.integration.test.ts`                 | integration | FR-1, FR-2, FR-3, FR-4 (INT-1 through INT-6, INT-12)      | PASSING  |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-registry.integration.test.ts`       | integration | FR-11 (INT-11)                                            | PASSING  |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-cleanup.integration.test.ts`        | integration | FR-9 (INT-8)                                              | PASSING  |
| `apps/runtime/src/__tests__/five9-webhook.e2e.test.ts`                                                  | e2e         | FR-6, FR-7, FR-8, FR-15 (E2E-1 through E2E-4, E2E-7)      | PASSING  |
| `apps/runtime/src/__tests__/five9-transfer.e2e.test.ts`                                                 | e2e         | FR-1, FR-2, FR-4, FR-5, FR-9 (E2E-5, E2E-6, E2E-8, E2E-9) | PASSING  |
| ~~`packages/agent-transfer/src/adapters/five9/__tests__/five9-session-encryption.integration.test.ts`~~ | integration | FR-10 (INT-7)                                             | DEFERRED |
| ~~`apps/studio/src/__tests__/edit-connection-dialog.test.tsx`~~                                         | integration | FR-13, FR-14 (INT-9, INT-10)                              | DEFERRED |

**E2E test file location**: E2E tests are placed under `apps/runtime/src/__tests__/` (not `packages/agent-transfer/src/__tests__/e2e/`) because they need the full runtime Express app with all middleware (auth, rate limiting, tenant isolation, webhook routes). The existing `kore-e2e.test.ts` in the package directory tests session store operations against Redis only, not the full HTTP stack.

---

## 11. Open Testing Questions

1. **Five9 webhook payload structure**: The test payloads are based on the inferred `Five9WebhookPayload` type from the design spec. Live Five9 API documentation or a test tenant is needed to validate the exact field names and nesting. Tests should be updated post-validation.
2. **Five9 retry behavior**: If Five9 retries failed webhook deliveries, deduplication tests may be needed. Currently, reprocessing is idempotent (TTL extension only).
3. **Existing Kore E2E test pattern**: The current `kore-e2e.test.ts` uses `vi.mock('@abl/compiler/platform')` for logger, which conflicts with CLAUDE.md E2E standards. Five9 E2E tests must NOT follow this pattern. Consider refactoring `kore-e2e.test.ts` separately.
4. **Mock Five9 server fidelity**: The mock server simulates happy paths and common errors. Edge cases in Five9's actual API behavior (rate limiting, partial responses, connection drops) cannot be tested until access to a real Five9 test environment is available.

---

## 12. Testing Notes

- E2E tests MUST start real Express servers on random ports (`{ port: 0 }`) with full middleware chain
- Only Five9 external API may be mocked — via dependency injection in `Five9Client` constructor, NOT via `vi.mock()`
- No `vi.mock()` or `jest.mock()` of codebase components in E2E tests
- No direct Redis access in E2E test assertions — use HTTP API responses and `sessionStore.get()` to verify state
- Session token encryption verification (INT-7) requires reading Redis directly — documented as an explicit exception
- All test Redis keys must use unique prefixes (`e2e_five9_{Date.now()}`) and be cleaned up in `afterAll`
- `pnpm build` must run before `pnpm test` (Turbo enforces build order)
- Run `npx prettier --write <files>` on all changed test files before committing
