# Test Spec: LiveKit Voice Integration

**Feature:** LiveKit Voice Integration
**Status:** ALPHA
**Created:** 2026-03-23
**Last Updated:** 2026-03-23

---

## 1. Coverage Matrix

| Component                       | Unit    | Integration | E2E     | Status  |
| ------------------------------- | ------- | ----------- | ------- | ------- |
| RuntimeLLMAdapter               | 8 cases | 4 cases     | 2 cases | Planned |
| Agent Worker (startAgentInRoom) | 6 cases | 3 cases     | 2 cases | Planned |
| Worker Entry (lifecycle)        | 5 cases | 2 cases     | 1 case  | Planned |
| Token Generation Route          | 4 cases | 3 cases     | 3 cases | Planned |
| Voice Service Factory           | 6 cases | 3 cases     | -       | Planned |
| Trace Hooks                     | 5 cases | -           | -       | Planned |
| Studio Voice Preview            | 3 cases | 2 cases     | 2 cases | Planned |
| Studio Token/Capabilities Proxy | 2 cases | 2 cases     | 1 case  | Planned |
| SIP Trunk Service               | 6 cases | 3 cases     | 2 cases | Planned |
| DTMF Handler                    | 4 cases | 2 cases     | 1 case  | Planned |
| Call Lifecycle Handler          | 5 cases | 3 cases     | 2 cases | Planned |
| Telephony Routes                | 8 cases | 4 cases     | 2 cases | Planned |

**Totals:** 62 unit, 31 integration, 18 E2E = **111 test cases**

---

## 2. E2E Test Scenarios

All E2E tests interact exclusively via HTTP API. No mocks of codebase components. Real servers started on random ports.

### E2E-1: Voice Token Generation — Happy Path

**Objective:** Verify that an authenticated user can request a LiveKit token and receive valid connection details.

**Preconditions:**

- Runtime server running with `FEATURE_LIVEKIT_ENABLED=true`
- LiveKit server running (or mocked via external service)
- Tenant has STT + TTS credentials configured in DB

**Steps:**

1. `POST /api/v1/livekit/token` with valid `sessionId`, `projectId`, auth header
2. Assert response contains `token`, `roomName`, `url`, `identity`
3. Assert `roomName` matches pattern `voice_{tenantId}_{projectId}_{sessionId}`
4. Assert response status is 200

**Expected:** Valid token returned with correct room name format and LiveKit server URL.

### E2E-2: Voice Token Generation — Missing Credentials

**Objective:** Verify credential pre-flight rejects requests when STT or TTS credentials are missing.

**Preconditions:**

- Runtime server running
- Tenant has NO STT credentials configured

**Steps:**

1. `POST /api/v1/livekit/token` with valid auth but tenant missing voice credentials
2. Assert response status is 422
3. Assert response body contains `error` with details about missing STT/TTS

**Expected:** 422 with specific credential gap details.

### E2E-3: Voice Token Generation — Concurrency Limit

**Objective:** Verify the concurrency guard rejects requests when max rooms are reached.

**Preconditions:**

- Runtime server running with `maxConcurrentRooms` set to a low value (e.g., 2)
- Two voice sessions already active

**Steps:**

1. Start 2 voice sessions via token endpoint
2. Attempt a 3rd `POST /api/v1/livekit/token`
3. Assert response status is 429

**Expected:** 429 Too Many Requests when concurrent room limit exceeded.

### E2E-4: Voice Token Generation — Input Validation

**Objective:** Verify that malicious or malformed IDs are rejected.

**Steps:**

1. `POST /api/v1/livekit/token` with `sessionId: "../../../etc/passwd"` -> assert 400
2. `POST /api/v1/livekit/token` with `sessionId: ""` -> assert 400
3. `POST /api/v1/livekit/token` with `projectId` containing SQL injection -> assert 400

**Expected:** All malformed inputs rejected with 400.

### E2E-5: Voice Token Generation — Auth Required

**Objective:** Verify unauthenticated requests are rejected.

**Steps:**

1. `POST /api/v1/livekit/token` without Authorization header or API key
2. Assert response status is 401

**Expected:** 401 Unauthorized.

### E2E-6: Voice Token — Cross-Tenant Isolation

**Objective:** Verify tenant A cannot generate tokens for tenant B's project.

**Preconditions:**

- Two tenants with separate projects

**Steps:**

1. Authenticate as tenant A
2. `POST /api/v1/livekit/token` with tenant B's projectId
3. Assert response status is 404 (not 403 — avoid leaking existence)

**Expected:** 404 Not Found for cross-tenant project access.

### E2E-7: Capabilities Endpoint

**Objective:** Verify the capabilities endpoint reports LiveKit status correctly.

**Steps:**

1. `GET /api/v1/livekit/capabilities` with valid auth
2. Assert response contains `enabled`, `configured` booleans
3. When LiveKit is configured: `enabled: true, configured: true`
4. When LiveKit env vars missing: `enabled: false`

**Expected:** Correct capability reporting based on configuration state.

### E2E-8: SIP Trunk CRUD (when implemented)

**Objective:** Full lifecycle test of SIP trunk management API.

**Steps:**

1. `POST /api/projects/:projectId/telephony/trunks` — create trunk
2. `GET /api/projects/:projectId/telephony/trunks` — list, verify trunk present
3. `GET /api/projects/:projectId/telephony/trunks/:id` — get detail
4. `PATCH /api/projects/:projectId/telephony/trunks/:id` — update name
5. `DELETE /api/projects/:projectId/telephony/trunks/:id` — delete
6. `GET /api/projects/:projectId/telephony/trunks` — verify deleted

**Expected:** Full CRUD lifecycle works with proper tenant/project isolation.

### E2E-9: SIP Trunk — Project Isolation

**Objective:** Verify trunks are isolated per project.

**Steps:**

1. Create trunk in project A
2. Attempt to read trunk from project B using trunk ID from project A
3. Assert 404

**Expected:** Cross-project trunk access returns 404.

### E2E-10: Phone Number Provisioning (when implemented)

**Objective:** Verify number search and provisioning flow via API.

**Steps:**

1. `POST /api/projects/:projectId/telephony/numbers/search` — search available numbers
2. `POST /api/projects/:projectId/telephony/numbers` — provision selected number
3. `GET /api/projects/:projectId/telephony/numbers` — verify number listed
4. `PATCH /api/projects/:projectId/telephony/numbers/:id` — configure routing
5. `DELETE /api/projects/:projectId/telephony/numbers/:id` — release number

**Expected:** Full number lifecycle with Twilio API integration.

### E2E-11: Call History Query (when implemented)

**Objective:** Verify call records are persisted and queryable.

**Preconditions:**

- Completed voice session (or seeded call record via API)

**Steps:**

1. `GET /api/projects/:projectId/telephony/calls` — list calls
2. Filter by date range, direction, status
3. `GET /api/projects/:projectId/telephony/calls/:callId` — get detail
4. Verify session trace linkage

**Expected:** Paginated call history with filtering and session correlation.

### E2E-12: Voice Session Cleanup on Disconnect

**Objective:** Verify resources are cleaned up when a voice session ends.

**Steps:**

1. Start a voice session via token endpoint
2. Verify room count incremented via capabilities or internal metric
3. Simulate disconnect (or let LiveKit detect participant left)
4. Verify room count decremented
5. Verify adapter disposed (endSession called on RuntimeExecutor)

**Expected:** All resources cleaned up, no leaked rooms or adapters.

### E2E-13: LiveKit Feature Flag Disabled

**Objective:** Verify voice endpoints return appropriate errors when LiveKit is disabled.

**Preconditions:**

- `FEATURE_LIVEKIT_ENABLED=false` or not set

**Steps:**

1. `POST /api/v1/livekit/token` -> assert 503 or feature-disabled response
2. `GET /api/v1/livekit/capabilities` -> assert `enabled: false`

**Expected:** Graceful degradation when feature flag is off.

### E2E-14: Telephony Route Auth — RBAC

**Objective:** Verify telephony management endpoints enforce proper permissions.

**Steps:**

1. Authenticate as read-only user
2. `POST /api/projects/:projectId/telephony/trunks` -> assert 403
3. Authenticate as project admin
4. `POST /api/projects/:projectId/telephony/trunks` -> assert 201

**Expected:** RBAC enforced on telephony management routes.

### E2E-15: Voice Credential Rotation

**Objective:** Verify credential cache invalidation when auth profiles are updated.

**Steps:**

1. Configure STT credentials for tenant
2. Generate token (should succeed)
3. Update STT credentials via auth profile API
4. Wait for cache invalidation (or trigger via Redis pub/sub)
5. Generate new token — should use updated credentials

**Expected:** Credential rotation takes effect within cache TTL.

### E2E-16: Concurrent Voice Sessions

**Objective:** Verify multiple concurrent voice sessions work independently.

**Steps:**

1. Start 5 concurrent voice sessions via token endpoint
2. Verify all 5 get unique room names and tokens
3. Verify active room count = 5
4. Disconnect 3 sessions
5. Verify active room count = 2

**Expected:** Sessions are independent; cleanup of one does not affect others.

### E2E-17: Deployment-Aware Voice Session

**Objective:** Verify voice sessions use pre-compiled IR when deploymentId is provided.

**Steps:**

1. Create a deployment with compiled agents
2. `POST /api/v1/livekit/token` with `deploymentId`
3. Verify session initialized via DeploymentResolver (check logs or trace events)

**Expected:** Deployment-aware path used, faster initialization.

### E2E-18: Graceful Server Shutdown with Active Voice Sessions

**Objective:** Verify all voice sessions are cleanly terminated during server shutdown.

**Steps:**

1. Start 3 active voice sessions
2. Initiate graceful shutdown (SIGTERM)
3. Verify all sessions closed, rooms disconnected, adapters disposed
4. Verify shutdown completes within 30 seconds

**Expected:** No leaked resources, no abrupt disconnections.

---

## 3. Integration Test Scenarios

### INT-1: RuntimeLLMAdapter — Deployment Path

**Objective:** Verify adapter initialization via DeploymentResolver with real DB records.

**Setup:** MongoDB with deployment, project, and agent records.

**Steps:**

1. Create RuntimeLLMAdapter with deploymentId
2. Call `initialize()`
3. Verify `getSessionId()` returns a valid session ID
4. Call `chat("hello")` and verify response text

**Constraints:** Real MongoDB, real RuntimeExecutor, no mocked codebase components.

### INT-2: RuntimeLLMAdapter — Legacy DSL Path

**Objective:** Verify adapter initialization via DSL cache + compile fallback.

**Setup:** MongoDB with project containing agent DSL, no deployment.

**Steps:**

1. Create RuntimeLLMAdapter without deploymentId
2. Call `initialize()`
3. Verify DSL cache populated
4. Call `chat("hello")` and verify response

### INT-3: RuntimeLLMAdapter — Chat Timeout

**Objective:** Verify the 30-second timeout prevents indefinite hangs.

**Setup:** RuntimeExecutor configured with an agent that delays response.

**Steps:**

1. Initialize adapter
2. Call `chat()` with input that triggers long-running execution
3. Verify timeout error thrown after 30 seconds

### INT-4: Voice Service Factory — Credential Resolution

**Objective:** Verify tenant-scoped credential resolution with encryption.

**Setup:** MongoDB with TenantServiceInstance records (deepgram, elevenlabs).

**Steps:**

1. Call `resolveVoiceCredentials(tenantId)`
2. Verify STT credentials (apiKey, model) returned
3. Verify TTS credentials (apiKey, voiceId, model) returned
4. Call again within TTL — verify cache hit (no DB query)
5. Wait past TTL — verify cache miss, fresh DB query

### INT-5: Voice Service Factory — Missing Credentials

**Objective:** Verify graceful handling when credentials are partially configured.

**Steps:**

1. Configure only STT credentials (no TTS)
2. Call `resolveVoiceCredentials(tenantId)`
3. Verify `stt` populated, `tts` is null

### INT-6: Voice Service Factory — Auth Profile Invalidation

**Objective:** Verify credential cache invalidation via Redis pub/sub.

**Steps:**

1. Resolve credentials (populates cache)
2. Publish `auth-profile:updated` event for tenant with `category: 'voice'`
3. Verify cache invalidated for that tenant

### INT-7: Worker Entry — Spawn and Cleanup

**Objective:** Verify full agent spawn and cleanup lifecycle.

**Setup:** LiveKit server available (or stubbed external).

**Steps:**

1. Call `startLiveKitWorker()`
2. Call `spawnAgentForRoom(roomName, metadata)`
3. Verify `activeRoomCount()` incremented
4. Call cleanup function from active connection
5. Verify `activeRoomCount()` decremented

### INT-8: Worker Entry — Duplicate Prevention

**Objective:** Verify duplicate agent spawn is rejected.

**Steps:**

1. Spawn agent in room "test-room"
2. Attempt to spawn another agent in "test-room"
3. Verify second spawn is a no-op (logged warning, no error)

### INT-9: Token Route — Credential Pre-flight

**Objective:** Verify token endpoint performs credential check before generating token.

**Setup:** Real HTTP server, real MongoDB.

**Steps:**

1. Remove TTS credentials for tenant
2. `POST /api/v1/livekit/token` with valid auth
3. Verify 422 with details showing TTS missing

### INT-10: Trace Hooks — Turn Lifecycle

**Objective:** Verify voice trace hooks produce correct timing breakdown.

**Steps:**

1. Call `traceLiveKitTurnStart()` with sessionId and utterance
2. Call `traceLiveKitSTT()` with transcript and confidence
3. Call `traceLiveKitLLMStart()` and `traceLiveKitLLMEnd()` with response
4. Call `traceLiveKitTTSStart()` and `traceLiveKitTTSEnd()`
5. Call `traceLiveKitTurnComplete()` — verify breakdown has all phases

### INT-11: SIP Trunk Service — CRUD with LiveKit API

**Objective:** Verify trunk service syncs with LiveKit SIP API.

**Steps:**

1. Create trunk via service — verify LiveKit API called
2. Update trunk — verify LiveKit API updated
3. Delete trunk — verify LiveKit API deleted
4. Verify DB records match API state

### INT-12: DTMF Handler — Digit Collection

**Objective:** Verify DTMF digits are collected with timeout.

**Steps:**

1. Start digit collection (maxDigits=4, timeout=3000ms)
2. Send digits "1", "2", "3", "4"
3. Verify collected "1234"
4. Start new collection
5. Send "5", wait for timeout
6. Verify collected "5"

### INT-13: Call Lifecycle — DID Resolution

**Objective:** Verify inbound call routing from DID to agent.

**Setup:** PhoneNumber record mapped to project + deployment + agent.

**Steps:**

1. Simulate inbound call webhook with DID number
2. Verify resolution chain: DID -> tenant -> project -> deployment -> agent
3. Verify agent spawned in correct room

---

## 4. Unit Test Scenarios

### UT-1: RuntimeLLMAdapter

- `initialize()` sets `initialized=true` and `sessionId`
- `initialize()` is idempotent (second call is no-op)
- `chat()` calls `initialize()` if not already initialized
- `chat()` returns `ChatResponse` with text, sessionId, token counts
- `dispose()` calls `executor.endSession()` and resets state
- `getSessionId()` returns null before init, valid ID after
- DSL cache eviction when max size reached
- DSL cache TTL expiry

### UT-2: Agent Worker

- `parseAndValidateMetadata()` — valid JSON returns RoomMetadata
- `parseAndValidateMetadata()` — invalid JSON returns null
- `parseAndValidateMetadata()` — missing required fields returns null
- `parseAndValidateMetadata()` — invalid ID patterns rejected
- `findLastUserMessage()` — extracts string content from last user message
- `findLastUserMessage()` — handles ChatContent array format
- `findLastUserMessage()` — returns null when no user messages
- `createTextStream()` — creates ReadableStream from string

### UT-3: Worker Entry

- `startLiveKitWorker()` — validates config, sets workerRunning
- `startLiveKitWorker()` — throws when config missing
- `stopLiveKitWorker()` — disposes all adapters, clears maps
- `activeRoomCount()` — reflects adapter map size
- `spawnAgentForRoom()` — throws when worker not running

### UT-4: Trace Hooks

- `traceLiveKitTurnStart()` — returns VoiceTurnContext with turnId
- `traceLiveKitSTT()` — records transcript and confidence
- `traceLiveKitLLMStart/End()` — records LLM phase duration
- `traceLiveKitTurnComplete()` — returns timing breakdown
- `traceLiveKitTurnFailed()` — marks turn as failed

### UT-5: Voice Config Schema

- Valid configuration parsed correctly
- Defaults applied for optional fields
- Invalid URL rejected for `livekit.url`
- Negative numbers rejected for `tokenTtlSeconds`
- `maxConcurrentRooms` defaults to 50

### UT-6: Input Validation

- `ID_PATTERN` accepts valid alphanumeric with hyphens and underscores
- `ID_PATTERN` rejects path traversal (`../`)
- `ID_PATTERN` rejects special characters
- `AGENT_NAME_PATTERN` enforces 64-char limit

---

## 5. Test Infrastructure

### 5.1 Required Test Fixtures

- **LiveKit Server Mock**: External service stub for token validation and room management (E2E tests can use LiveKit dev server via `scripts/start-livekit.sh`)
- **MongoDB Test Database**: MongoMemoryServer for integration tests, seeded with tenant/project/agent records
- **Redis Test Instance**: For credential cache invalidation tests
- **Encrypted Credentials**: Pre-encrypted TenantServiceInstance records for credential resolution tests

### 5.2 Test Environment Variables

```bash
FEATURE_LIVEKIT_ENABLED=true
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
ENCRYPTION_MASTER_KEY=test-key-32-bytes-long-enough-ok
```

### 5.3 Test Execution Order

1. Unit tests (no external dependencies) — run in parallel
2. Integration tests (require MongoDB + Redis) — run sequentially per suite
3. E2E tests (require full runtime server) — run sequentially

---

## 6. Coverage Targets

| Layer                        | Target                 | Current |
| ---------------------------- | ---------------------- | ------- |
| Unit (RuntimeLLMAdapter)     | 85% line coverage      | TBD     |
| Unit (Agent Worker)          | 90% line coverage      | TBD     |
| Unit (Worker Entry)          | 85% line coverage      | TBD     |
| Integration (Voice Pipeline) | 75% line coverage      | TBD     |
| E2E (Token + Capabilities)   | 100% scenario coverage | TBD     |
| E2E (Telephony CRUD)         | 100% scenario coverage | TBD     |
