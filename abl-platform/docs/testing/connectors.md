# Test Spec: Connectors Platform

**Feature:** connectors
**Status:** BETA
**Last Updated:** 2026-03-25

---

## Current State

- **37 existing test files** across packages/connectors, packages/connectors/base, packages/connectors/sharepoint, and apps/search-ai
- Primary coverage: unit tests for SDK components, adapter wrappers, base infrastructure, SharePoint connector
- **Service-layer E2E coverage added** (3 files): connection CRUD lifecycle, connection test lifecycle, webhook trigger processing — using real MongoDB (MongoMemoryServer), real encryption, real Redis dedup. These tests call the service/handler layer directly (not via HTTP) because `packages/connectors` has no Express routes.
- **HTTP-level E2E coverage added** (5 files): connection CRUD, OAuth flow, tool execution with scope resolution, trigger lifecycle with webhook security, and SearchAI discovery-to-sync — all using real Express servers with full middleware chains (auth, validation, tenant isolation)
- **Skipped tests fixed** (47 tests across 5 files): full-sync-coordinator library filtering, sync-permission-integration, sync-flow error handling, oauth-flow integration, token-manager rewrite
- **Integration tests implemented (69 tests across 8 files)**: INT-1 (credential encryption, 15 tests), INT-2 (executor-resolver chain, 6 tests), INT-3 (webhook dispatch, 5 tests), INT-4 (polling trigger, 11 tests), INT-5 (oauth-refresh-lock, 7 tests), INT-6 (tenant isolation, 6 tests), INT-7 (auto-pause, 4 tests), INT-9 (registry boot failure, 6 tests). INT-8 deferred (SearchAI webhook uses Graph clientState, not tenantId).
- **Remaining gaps**: No HTTP-level E2E for polling trigger lifecycle (E2E-7); cron scheduler E2E not implemented

## Health Dashboard

| Area                           | Unit Tests | Integration Tests                                  | E2E Tests               | Status  |
| ------------------------------ | ---------- | -------------------------------------------------- | ----------------------- | ------- |
| Connector SDK (types/registry) | 3 files    | registry-boot-failure (6)                          | 0                       | Good    |
| ConnectionService (CRUD)       | 1 file     | credential-encryption (10), tenant-isolation (7)   | 1 svc-E2E + 1 HTTP-E2E  | Good    |
| ConnectionResolver (auth)      | 1 file     | oauth-refresh-lock (7), connection-resolution (11) | 1 HTTP-E2E (OAuth flow) | Good    |
| ConnectorToolExecutor          | 1 file     | executor-resolver-chain (7)                        | 1 HTTP-E2E (tool exec)  | Good    |
| WorkflowToolExecutor           | 1 file     | 0                                                  | 0                       | Partial |
| TriggerEngine                  | 1 file     | webhook-dispatch (9)                               | 1 HTTP-E2E (trigger)    | Good    |
| WebhookHandler                 | 1 file     | webhook-dispatch (subset)                          | 1 svc-E2E + 1 HTTP-E2E  | Good    |
| PollingScheduler               | 1 file     | polling-trigger (12)                               | 0                       | Good    |
| CronScheduler                  | 1 file     | 0                                                  | 0                       | Partial |
| Activepieces adapter           | 2 files    | 0                                                  | 0                       | Partial |
| Nango adapter                  | 1 file     | 0                                                  | 0                       | Partial |
| Connection test lifecycle      | 0          | 0                                                  | 1 svc-E2E + 1 HTTP-E2E  | Good    |
| HTTP connector                 | 0          | 0                                                  | 1 HTTP-E2E (tool exec)  | Partial |
| Base infrastructure            | 5 files    | 0                                                  | 0                       | Partial |
| SharePoint connector           | 9 files    | 2 files                                            | 1 HTTP-E2E (discovery)  | Good    |
| SearchAI connector routes      | 2 files    | 0                                                  | 1 HTTP-E2E (discovery)  | Good    |
| Studio connections UI          | 1 file     | 0                                                  | 0                       | Minimal |
| Channel OAuth (runtime)        | 4 files    | 0                                                  | 0                       | Partial |

---

## E2E Test Scenarios (Minimum 5)

E2E tests must start real Express servers, use real middleware chains (auth, validation, tenant isolation), and interact only via HTTP API. No mocks of codebase components.

### E2E-1: Connection CRUD Lifecycle via API

**Objective:** Verify the full connection create/read/update/delete lifecycle through the HTTP API with real auth middleware.

**Setup:**

- Start workflow-engine Express server on random port (`{ port: 0 }`)
- Seed a test tenant and project in MongoDB
- Generate a valid auth token for the test tenant

**Steps:**

1. `POST /api/projects/:projectId/connections` with `{ connectorName: "http", displayName: "Test HTTP", authType: "api_key", credentials: { apiKey: "test-key-123" } }`
2. Assert 201 response with `hasCredentials: true`, `status: "active"`, `encryptedCredentials` NOT present in response
3. `GET /api/projects/:projectId/connections` -- assert the connection appears in the list
4. `GET /api/projects/:projectId/connections/:id` -- assert connection details match
5. `PUT /api/projects/:projectId/connections/:id` with `{ displayName: "Updated" }` -- assert 200 with updated name
6. `DELETE /api/projects/:projectId/connections/:id` -- assert 200
7. `GET /api/projects/:projectId/connections/:id` -- assert 404

**Assertions:**

- Credentials are never returned in any response body
- Tenant isolation: a request with a different tenant's token returns 404 for the connection
- Project isolation: a request targeting a different projectId returns 404

### E2E-2: OAuth2 Flow End-to-End

**Objective:** Verify the OAuth2 authorization code flow including token storage and refresh.

**Setup:**

- Start Express server on random port
- Mock external OAuth provider (separate HTTP server on random port) that returns predictable tokens
- Seed tenant, project, and a pending OAuth2 connection

**Steps:**

1. `POST /api/connectors/:id/auth/initiate` -- assert redirect URL contains correct `client_id`, `redirect_uri`, `scope`
2. Simulate provider callback: `POST /api/connectors/auth/callback` with `{ code: "test-auth-code", state: "<connection-id>" }`
3. Assert the mock OAuth provider received the token exchange request with correct `grant_type=authorization_code`
4. `GET /api/connectors/:id/auth/status` -- assert `{ status: "active" }`
5. Advance time past token expiry; make an API call that triggers the connection resolver
6. Assert the mock OAuth provider received a refresh token request
7. Assert the connection's `oauth2TokenExpiresAt` was updated

**Assertions:**

- Tokens are encrypted before storage (verify via DB read that `encryptedCredentials` is not plaintext)
- Refresh token rotation: if provider returns a new refresh token, it replaces the old one
- Failed refresh marks connection as `expired`

### E2E-3: Connector Action Execution via Agent Tool Call

**Objective:** Verify that an agent can execute a connector action through the runtime API, including connection resolution, credential decryption, and timeout enforcement.

**Setup:**

- Start runtime Express server on random port with full middleware chain
- Register the HTTP connector in the ConnectorRegistry
- Seed a tenant, project, and active connection for the HTTP connector
- Start a mock target HTTP server that returns `{ "result": "ok" }`

**Steps:**

1. Create a session via `POST /api/sessions`
2. Send a message that triggers the `http.request` tool with `{ url: "<mock-server>/test", method: "GET" }`
3. Assert the agent response includes the tool result `{ status: 200, body: { result: "ok" } }`
4. Verify the mock target server received the request with the correct `Authorization` header from the connection's credentials
5. Test timeout: configure a slow mock endpoint (10s delay), send a tool call with `timeout_ms: 100`, assert timeout error in response

**Assertions:**

- Connection credentials are decrypted and applied to the outbound request
- SSRF protection: a tool call with `url: "http://169.254.169.254/metadata"` returns an SSRF error
- Timeout is enforced and produces a structured error

### E2E-4: Webhook Trigger End-to-End

**Objective:** Verify inbound webhook processing including signature verification, replay protection, and dedup.

**Setup:**

- Start runtime Express server on random port with full auth middleware
- Auth context requires `connection:read` / `connection:write` permissions for trigger management routes (the codebase has no trigger-specific permissions — triggers use connection permissions)
- Start a mock Restate ingress server on random port
- Seed a trigger registration in MongoDB with `status: "active"` and a webhook secret
- Start Redis for dedup

**Steps:**

1. `POST /webhooks/:connectorName/:registrationId` with valid HMAC-SHA256 signature, valid timestamp, and unique event ID
2. Assert 200 response with `{ ok: true, executionId: "<uuid>" }`
3. Assert the mock Restate server received a `startWorkflow` call with correct payload
4. Replay the same request (same event ID) -- assert 200 with `{ deduplicated: true }`
5. Send a request with an invalid HMAC signature -- assert 401
6. Send a request with a stale timestamp (> 5 min old) -- assert 401 replay detected
7. Send consecutive failing webhook requests (mock Restate returns 503) until `TRIGGER_AUTO_PAUSE_THRESHOLD` -- verify trigger status changes to `error`

**Assertions:**

- Signature verification uses timing-safe comparison
- Dedup window is enforced via Redis
- Auto-pause after consecutive failures

### E2E-5: SearchAI Connector Full Sync Flow

**Objective:** Verify the complete connector configuration and sync trigger flow through the SearchAI API.

**Setup:**

- Start SearchAI Express server on random port
- Seed tenant, project, and search index in MongoDB
- Mock the SharePoint Graph API server to return test sites/drives/items

**Steps:**

1. `POST /api/indexes/:indexId/connectors` with `{ connectorType: "sharepoint", config: {...} }` -- assert 201
2. `POST /api/connectors/:id/auth/initiate` -- complete OAuth setup
3. `POST /api/connectors/:id/discover` -- assert discovery returns sites and drives from mock Graph API
4. `POST /api/connectors/:id/sync/start` -- assert sync starts
5. `GET /api/connectors/:id/sync/status` -- poll until sync completes
6. Assert SearchDocuments were created in the database with correct metadata
7. Assert filter application: items outside date range or excluded content types are NOT synced

**Assertions:**

- Tenant isolation: connector created by one tenant is not visible to another
- Sync state is tracked (lastFullSyncAt updated)
- Error state: if mock Graph API returns 500, connector's errorState.consecutiveFailures increments

### E2E-6: Connection Test Lifecycle

**Objective:** Verify the connection test endpoint exercises real credential validation.

**Setup:**

- Start Express server on random port
- Register a test connector with a `test_connection` action
- Seed connections in both `active` and `expired` states

**Steps:**

1. `POST /api/projects/:projectId/connections/:id/test` for an active connection with valid credentials -- assert `{ success: true, latencyMs: <number> }`
2. `POST /api/projects/:projectId/connections/:id/test` for a connection with invalid/expired credentials -- assert `{ success: false, error: "..." }` and connection status set to `expired`
3. `POST /api/projects/:projectId/connections/:id/test` for a nonexistent connection -- assert 404
4. `POST /api/projects/:projectId/connections/:id/test` with a different tenant's token -- assert 404

**Assertions:**

- Test result includes measured latency
- Connection status transitions are persisted (active -> expired on failure)
- Credential decryption errors produce a meaningful message

### E2E-7: Polling Trigger Lifecycle

**Objective:** Verify polling trigger registration, execution cycle, and deregistration.

**Setup:**

- Start Express server and Redis on random ports
- Register a connector with a polling trigger (short interval: 1s)
- Mock Restate ingress

**Steps:**

1. Register a polling trigger via API with `pollingIntervalMs: 1000`
2. Wait for at least 2 poll cycles
3. Assert mock Restate received workflow invocations with correct trigger metadata
4. Pause the trigger via API
5. Verify no further poll invocations after pause
6. Resume the trigger; verify polling resumes
7. Deregister the trigger; verify BullMQ job removed

**Assertions:**

- Polling interval is respected
- Pause/resume works correctly
- Deregistration cleans up BullMQ jobs

---

## Integration Test Scenarios (Minimum 5)

Integration tests test real service boundaries within a single package. They may use test databases (MongoMemoryServer) but must NOT mock codebase components. External third-party services (Graph API, OAuth providers) may be mocked via dependency injection.

### INT-1: ConnectionResolver OAuth2 Refresh with Distributed Lock

**Objective:** Verify that concurrent OAuth2 refresh requests are serialized via distributed locking.

**Setup:**

- Real Redis instance (or test Redis)
- Seeded ConnectorConnection with near-expired OAuth2 token
- Mock OAuth provider via DI that returns new tokens

**Steps:**

1. Call `connectionResolver.resolveAuth(connection)` concurrently from 3 "pods" (Promise.all)
2. Assert only ONE refresh request was sent to the mock OAuth provider
3. Assert all 3 callers received the same refreshed access token
4. Verify the connection's `oauth2TokenExpiresAt` was updated exactly once

**Assertions:**

- Distributed lock prevents thundering herd on refresh
- Wait-and-read fallback works for non-lock-acquiring callers
- Connection updated atomically

### INT-2: ConnectorToolExecutor Connection Resolution Priority

**Objective:** Verify user-scoped connections take priority over tenant-scoped, and the executor handles missing connections correctly.

**Setup:**

- MongoMemoryServer with both user-scoped and tenant-scoped connections for the same connector
- Real ConnectorRegistry with test connector registered

**Steps:**

1. Execute tool with `userId` set -- assert user-scoped connection is used
2. Execute tool without `userId` -- assert tenant-scoped connection is used
3. Execute tool with specific `connectionId` -- assert that exact connection is used
4. Execute tool for a connector with no connections -- assert descriptive error message
5. Execute tool for an unknown connector -- assert "Unknown connector" error

**Assertions:**

- Resolution priority: explicit connectionId > user-scoped > tenant-scoped
- Error messages include connector name and tenant ID for debuggability
- Credentials are decrypted before being passed to the action

### INT-3: TriggerEngine Strategy Routing

**Objective:** Verify the TriggerEngine correctly routes registrations to webhook, polling, or cron handlers.

**Setup:**

- Real ConnectorRegistry with connectors having different trigger strategies
- Mock BullMQ queues (test doubles, not mocks of our code)
- Mock Restate client

**Steps:**

1. Register a webhook trigger -- assert no BullMQ jobs created (webhook is push-based)
2. Register a polling trigger -- assert BullMQ repeatable job created with correct interval
3. Register a cron trigger -- assert BullMQ repeatable job created with correct cron expression
4. Attempt cron trigger without cronExpression -- assert error thrown
5. Deregister each trigger type -- assert correct cleanup

**Assertions:**

- Strategy routing is exhaustive (never falls through)
- Polling default interval matches `DEFAULT_POLLING_INTERVAL_MS`
- Deregistration removes the correct BullMQ jobs

### INT-4: ConnectionService Credential Encryption Round-Trip

**Objective:** Verify credentials are encrypted before storage and correctly decrypted on read.

**Setup:**

- MongoMemoryServer for ConnectorConnection model
- Real encryption service with test keys

**Steps:**

1. Create a connection with `credentials: { apiKey: "secret-123", secretKey: "super-secret" }`
2. Read the raw database document -- assert `encryptedCredentials` is NOT the plaintext JSON
3. Call `connectionService.test()` which decrypts internally -- assert decrypted credentials match original
4. Update credentials; assert the new encrypted value differs from the old one
5. Call `completeOAuthSetup()` with tokens -- assert both access and refresh tokens are encrypted
6. Delete the connection -- assert the document is removed from DB

**Assertions:**

- Encrypted credentials are not reversible without the tenant key
- `hasCredentials: true` in summary responses, but no raw credentials exposed
- `encryptionKeyVersion` is set on create and update

### INT-5: Activepieces Adapter Piece Wrapping

**Objective:** Verify the Activepieces adapter correctly extracts piece metadata and wraps actions for execution.

**Setup:**

- Direct import of test AP piece module (e.g., `@activepieces/piece-slack`)
- Real type-mapper and context-translator

**Steps:**

1. Call `extractPieceFromExport(slackModule)` -- assert it returns a valid piece object
2. Call `wrapActivepiecesPiece("slack", slackModule)` -- assert the result conforms to the Connector interface
3. Verify auth type mapping (AP oauth2 -> our oauth2)
4. Verify action props are mapped to ConnectorProperty array
5. Verify trigger props are mapped with correct strategy
6. Call a wrapped action's `run()` with a mock AP context -- assert the context translator produces correct AP format

**Assertions:**

- All AP property types are mapped to our ConnectorPropertyType
- Dynamic dropdown refreshers are preserved
- Wrapped connectors have unique names matching the short name

### INT-6: Base Filter Engine Evaluation

**Objective:** Verify the base filter engine correctly applies date, size, and content type filters.

**Setup:**

- Direct instantiation of BaseFilterEngine with test filter config

**Steps:**

1. Configure date filter: `modifiedSince: "2026-01-01"` -- assert items before that date are rejected
2. Configure size filter: `maxSizeBytes: 1048576` (1 MB) -- assert items > 1 MB are rejected
3. Configure content type filter: include `["application/pdf", "text/plain"]` -- assert other types rejected
4. Configure exclude mode for content types -- assert listed types are rejected, others pass
5. Combine multiple filters -- assert AND logic (all filters must pass)
6. Verify statistics tracking: `evaluateResults.passed`, `evaluateResults.rejected`

**Assertions:**

- Filter evaluation is deterministic
- Statistics accurately reflect filter decisions
- Custom filter override point is called when subclass provides it

### INT-7: Connector Catalog Generation Integrity

**Objective:** Verify the static catalog generation produces correct, complete entries.

**Setup:**

- Run the catalog generation script against the installed AP pieces

**Steps:**

1. Load `connector-catalog.json` from generated output
2. Assert all 25+ entries from `PIECE_PACKAGES` have corresponding catalog entries
3. Verify each entry has: name, displayName, version, category, authType, actions[], triggers[]
4. Verify OAuth-enriched entries have `oauth2.authorizationUrl`, `oauth2.tokenUrl`, `oauth2.defaultScopes`
5. Verify the HTTP native connector is included
6. Assert no duplicate connector names

**Assertions:**

- Catalog is complete (matches PIECE_PACKAGES count + native connectors)
- All required fields are populated
- Nango OAuth enrichment is applied where available

---

## Test Coverage Map

| Component                  | Unit | Integration | E2E                                | Target |
| -------------------------- | ---- | ----------- | ---------------------------------- | ------ |
| ConnectorRegistry          | Yes  | ✅ INT-9    | -                                  | Done   |
| Connector types/properties | Yes  | -           | -                                  | Done   |
| ConnectionService CRUD     | Yes  | ✅ INT-1    | ✅ E2E-1 (svc + HTTP)              | BETA   |
| ConnectionResolver OAuth2  | Yes  | ✅ INT-5    | ✅ E2E-4 (OAuth flow, HTTP)        | BETA   |
| ConnectorToolExecutor      | Yes  | ✅ INT-2    | ✅ E2E-2 (tool exec, HTTP)         | BETA   |
| WorkflowToolExecutor       | Yes  | -           | -                                  | Alpha  |
| TriggerEngine              | Yes  | ✅ INT-3    | ✅ E2E-3 (trigger lifecycle, HTTP) | BETA   |
| WebhookHandler             | Yes  | ✅ INT-3    | ✅ E2E-8 (webhook security, HTTP)  | BETA   |
| PollingScheduler           | Yes  | ✅ INT-4    | E2E-7 (planned)                    | BETA   |
| CronScheduler              | Yes  | -           | -                                  | Alpha  |
| HTTP connector             | -    | -           | ✅ E2E-2 (tool exec, HTTP)         | BETA   |
| Activepieces adapter       | Yes  | -           | -                                  | Alpha  |
| Base filter engine         | Yes  | -           | -                                  | Alpha  |
| SharePoint connector       | Yes  | Yes         | ✅ E2E-5 (discovery, HTTP)         | BETA   |
| SearchAI connector routes  | Yes  | -           | ✅ E2E-5 (discovery, HTTP)         | BETA   |
| Tenant isolation           | -    | ✅ INT-6    | ✅ E2E-1 (cross-tenant 404)        | BETA   |
| Channel OAuth              | Yes  | -           | -                                  | Alpha  |
| Studio connections UI      | Yes  | -           | -                                  | Alpha  |
| Static catalog generation  | -    | -           | -                                  | Alpha  |
| Connection test lifecycle  | -    | ✅ INT-1    | ✅ E2E-6 (svc + HTTP)              | BETA   |

## Existing Test Files (45+ across packages/connectors, connectors/base, connectors/sharepoint, search-ai, runtime)

### packages/connectors/src/**tests**/ (unit)

- `registry.test.ts`, `types.test.ts`, `properties.test.ts`
- `connection-resolver.test.ts`, `connection-service.test.ts`
- `connector-tool-executor.test.ts`, `workflow-tool-executor.test.ts`
- `trigger-engine.test.ts`, `webhook-handler.test.ts`, `polling-scheduler.test.ts`, `cron-scheduler.test.ts`
- `activepieces-importer.test.ts`, `nango-importer.test.ts`

### packages/connectors/src/**tests**/integration/ (Integration — 69 tests across 8 files)

> Real MongoMemoryServer + real AES-256-GCM encryption. External service doubles via DI (not vi.mock). Run with: `npx vitest run --config vitest.integration.config.ts`

- `credential-encryption.integration.test.ts` — INT-1: credential encrypt/decrypt round-trip (15 tests)
- `tenant-isolation.integration.test.ts` — INT-6: cross-tenant list, getById, update, delete, cross-project, concurrent (6 tests)
- `executor-resolver-chain.integration.test.ts` — INT-2: full tool execution chain with scope resolution (6 tests)
- `oauth-refresh-lock.integration.test.ts` — INT-5: concurrent OAuth refresh with distributed lock (7 tests)
- `registry-boot-failure.integration.test.ts` — INT-9: registry boot with broken connectors, max size, clear (6 tests)
- `webhook-dispatch.integration.test.ts` — INT-3/INT-7: webhook HMAC, dedup, replay, auto-pause (9 tests)
- `polling-trigger.integration.test.ts` — INT-4: polling dispatch, cursor pagination, dedup by hash (11 tests)
- `connection-resolution.integration.test.ts` — connection resolution priority (user > tenant > fallback) (6 tests)

### packages/connectors/src/**tests**/e2e/ (Service-layer E2E)

> These tests use real MongoDB (MongoMemoryServer) and real encryption but call services/handlers directly (not via HTTP). `packages/connectors` has no Express routes — HTTP E2E requires runtime/workflow-engine routes.

- `connection-crud.e2e.test.ts` — Connection CRUD lifecycle via ConnectionService (E2E-1)
- `connection-test.e2e.test.ts` — Connection test lifecycle via ConnectionService (E2E-6)
- `webhook-trigger.e2e.test.ts` — Webhook trigger processing with HMAC, dedup, replay protection via handleWebhook() (E2E-4)

### packages/connectors/base/src/**tests**/

- `base-filter-engine.test.ts`, `base-resource-discovery.test.ts`
- `device-code-flow.test.ts`, `rate-limiter.test.ts`, `retry-handler.test.ts`
- `token-manager.test.ts` (rewritten from `.skip` — 12 tests, all passing)

### packages/connectors/sharepoint/src/**tests**/

- `graph-client.test.ts`, `full-sync-coordinator.test.ts`, `delta-sync-coordinator.test.ts`
- `microsoft-oauth-provider.test.ts`, `sharepoint-filter-engine.test.ts`
- `sharepoint-permission-crawler.test.ts`, `sharepoint-resource-discovery.test.ts`
- `sync-permission-integration.test.ts`
- `integration/oauth-flow.integration.test.ts`, `integration/sync-flow.integration.test.ts`

### apps/search-ai/src/**tests**/

- `connector-sync-worker.test.ts`, `connector-delta-sync.test.ts` (scheduler)

### apps/runtime/src/services/channel-oauth/

- `__tests__/channel-oauth-service.test.ts`
- `providers/__tests__/meta-oauth-provider.test.ts`
- `providers/__tests__/msteams-oauth-provider.test.ts`
- `providers/__tests__/slack-oauth-provider.test.ts`

### apps/runtime/src/**tests**/ (HTTP-level E2E — NEW)

> These tests start real Express servers with full auth middleware, interact only via HTTP API, and validate tenant/project isolation. No mocks of codebase components.

- `connector-connection-crud.e2e.test.ts` — Connection CRUD lifecycle + tenant isolation (E2E-1, E2E-6)
- `connector-oauth-flow.e2e.test.ts` — OAuth2 connection create, token storage, credential update, revoke (E2E-4)
- `connector-tool-execution.e2e.test.ts` — Tool execution via registry + scope resolution priority (E2E-2, E2E-7)
- `connector-trigger-lifecycle.e2e.test.ts` — Trigger create/pause/resume/delete + webhook security (E2E-3, E2E-8)

### apps/search-ai/src/**tests**/e2e/ (HTTP-level E2E — NEW)

- `connector-discovery-sync.e2e.test.ts` — SharePoint discovery-to-sync lifecycle with recommendations, cross-tenant isolation, validation (E2E-5)

### Test Connector Fixture

The shared test connector fixture (`packages/connectors/src/__tests__/fixtures/test-connector.ts`) provides two variants used across integration and E2E tests:

```typescript
// ConnectorAuthField shape (actual — uses name/displayName/required/sensitive, NOT type: 'string')
auth: {
  type: 'api_key',
  fields: [
    {
      name: 'apiKey',
      displayName: 'API Key',
      required: true,
      sensitive: true,
    },
  ],
},
```

- `testConnector` — API key auth with echo action and webhook trigger (HMAC-SHA256 verification)
- `oauth2TestConnector` — OAuth2 auth with same action and trigger
- `registerTestConnector(registry)` / `registerOAuth2TestConnector(registry)` — registration helpers

## Priority Order for Remaining Tests

### Implemented (PASS)

1. ~~**E2E-1** (Connection CRUD)~~ — ✅ `connector-connection-crud.e2e.test.ts` (runtime)
2. ~~**E2E-2** (Tool Execution)~~ — ✅ `connector-tool-execution.e2e.test.ts` (runtime)
3. ~~**E2E-3** (Trigger Lifecycle)~~ — ✅ `connector-trigger-lifecycle.e2e.test.ts` (runtime)
4. ~~**E2E-4** (OAuth Flow)~~ — ✅ `connector-oauth-flow.e2e.test.ts` (runtime)
5. ~~**E2E-5** (SearchAI Discovery)~~ — ✅ `connector-discovery-sync.e2e.test.ts` (search-ai)
6. ~~**E2E-6** (Connection Test)~~ — ✅ `connector-connection-crud.e2e.test.ts` (runtime, same file as E2E-1)
7. ~~**E2E-7** (Scope Resolution)~~ — ✅ `connector-tool-execution.e2e.test.ts` (runtime, same file as E2E-2)
8. ~~**E2E-8** (Webhook Security)~~ — ✅ `connector-trigger-lifecycle.e2e.test.ts` (runtime, same file as E2E-3)

### Implemented Integration Tests (PASS)

1. ~~**INT-1** (Credential Encryption)~~ — ✅ `credential-encryption.integration.test.ts` (15 tests)
2. ~~**INT-2** (Executor-Resolver Chain)~~ — ✅ `executor-resolver-chain.integration.test.ts` (6 tests)
3. ~~**INT-3** (Webhook Dispatch)~~ — ✅ `webhook-dispatch.integration.test.ts` (5 tests)
4. ~~**INT-4** (Polling Trigger)~~ — ✅ `polling-trigger.integration.test.ts` (11 tests)
5. ~~**INT-5** (OAuth Refresh + Lock)~~ — ✅ `oauth-refresh-lock.integration.test.ts` (7 tests)
6. ~~**INT-6** (Tenant Isolation)~~ — ✅ `tenant-isolation.integration.test.ts` (6 tests)
7. ~~**INT-7** (Auto-Pause)~~ — ✅ `webhook-dispatch.integration.test.ts` (4 tests, auto-pause subset)
8. **INT-8** (SearchAI Webhook Tenant Isolation) — DEFERRED: Graph callback uses clientState HMAC, not tenantId
9. ~~**INT-9** (Registry Boot Failure)~~ — ✅ `registry-boot-failure.integration.test.ts` (6 tests)

### Remaining (not yet implemented)

1. **E2E-7** (Polling Trigger HTTP Lifecycle) — no HTTP-level E2E yet (polling tested at integration level)
2. **INT-5** (Activepieces Adapter) — not yet an integration test, only unit tests
3. **INT-6** (Base Filter Engine) — not yet an integration test, only unit tests
4. **INT-7** (Catalog Generation) — not yet an integration test
