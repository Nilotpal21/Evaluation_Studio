# Feature Test Guide: Identity Verification

**Feature**: Identity Verification -- hexagonal architecture for multi-method identity verification with three-tier identity model
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [../features/identity-verification.md](../features/identity-verification.md)
**First tested**: 2026-03-22
**Last updated**: 2026-04-23
**Overall status**: BETA -- 244 tests total (225 runtime + 19 compiler). 7 E2E scenarios (13 tests), 5 delivery integration tests, 48 BETA unit tests (OAuth adapters, email delivery, compiler tier, middleware)

---

## Current State (as of 2026-04-23)

Identity verification has comprehensive test coverage across its hexagonal architecture. All six verifier adapters (HMAC, OTP, OAuth, email link, provider, webhook) have dedicated unit test suites with SSRF protection tests for webhook. Domain logic, use cases, and infrastructure stores are thoroughly tested. Route-level integration tests validate Express endpoints with mocked use cases. 7 E2E test scenarios (13 test cases) in `identity-e2e-http.test.ts` exercise the full HTTP API with real Express servers, real verifier implementations, and an InMemoryRedis — covering HMAC, OTP complete flow, rate limiting + TTL expiry, cross-tenant isolation, OAuth with mock provider, input validation, and webhook with real HTTP test server.

The remaining design-contract gap is provenance and project safety. Current automated coverage proves tenant isolation well, but it does not yet prove that verification attempts, status reads, and session-resolution records carry canonical `projectId`, `sessionPrincipalId`, `policySource`, `grantScope`, and `traceId` strongly enough for omnichannel continuity and session-scope enforcement.

**BETA additions:** OAuth adapters (Google, Microsoft, GitHub) tested via DI-injected `ArcticLikeProvider` fakes — no `vi.mock()`. Email delivery adapter tested with injected `EmailSender`. 5 delivery integration tests exercise the route handler → delivery service → response stripping pipeline. Compiler identity tier tests cover all 3 compilation paths (`compileTools`, `compileToolDefinitionAST`, `mergeAgentToolBehavior`). Identity tier gate middleware tests cover block/pass/absent/error scenarios. E2E-8 (DSL tier gate E2E) deferred — requires ToolBindingExecutor test infrastructure. Total: 244 tests (225 runtime + 19 compiler).

### Quick Health Dashboard

| Area                                      | Status     | Last Verified | Notes                                                                                            |
| ----------------------------------------- | ---------- | ------------- | ------------------------------------------------------------------------------------------------ |
| HMAC verifier (single-step sync)          | PASS       | 2026-03-22    | Secret key, timestamp validation, replay defense                                                 |
| OTP verifier (two-step async)             | PASS       | 2026-03-22    | Code generation, timing-safe compare, rate limit                                                 |
| OAuth verifier (PKCE + state)             | PASS       | 2026-03-22    | Initiate, complete, state mismatch, expiry                                                       |
| Email link verifier (magic link)          | PASS       | 2026-03-22    | Token generation, hash comparison, used-token                                                    |
| Provider verifier (channel-verified)      | PASS       | 2026-03-22    | Sync channel artifact check                                                                      |
| Webhook verifier (external webhook)       | PASS       | 2026-03-22    | Challenge/response with external endpoint                                                        |
| Identity domain (artifact, tier, attempt) | PASS       | 2026-03-22    | SHA-256 hash, tier promotion, attempt lifecycle                                                  |
| Promote tier use case                     | PASS       | 2026-03-22    | Valid promotions, no-ops, rejections                                                             |
| Verify identity use case (dispatcher)     | PASS       | 2026-03-22    | Method routing, no-verifier fallback                                                             |
| Resolve session use case                  | PASS       | 2026-03-22    | Key lookup, create-new signal                                                                    |
| Redis verification token store            | PASS       | 2026-03-22    | CRUD, TTL, tenant isolation, Date serialization                                                  |
| Redis resolution key store                | PASS       | 2026-03-22    | Key format, TTL, tenant isolation                                                                |
| Verification routes (Express)             | PASS       | 2026-03-22    | Initiate, complete, get, auth required (401)                                                     |
| Full HMAC identity -> contact cycle       | PASS       | 2026-03-22    | In-memory stores, not HTTP API                                                                   |
| E2E HMAC (valid/invalid/no-auth)          | PASS       | 2026-03-24    | Real Express server, E2E-1                                                                       |
| E2E OTP complete flow                     | PASS       | 2026-03-24    | Initiate→status→complete→verified, E2E-2                                                         |
| E2E OTP rate limiting + TTL expiry        | PASS       | 2026-03-24    | 5 wrong codes→blocked→TTL expiry→404, E2E-3                                                      |
| E2E Cross-tenant isolation                | PASS       | 2026-03-24    | Tenant-B cannot see/complete tenant-A attempts                                                   |
| Project-safe status/read isolation        | NOT TESTED | -             | No wrong-project or wrong-session-principal E2E                                                  |
| E2E OAuth (mock provider)                 | PASS       | 2026-03-24    | PKCE + state + token exchange, E2E-5                                                             |
| E2E Input validation                      | PASS       | 2026-03-24    | Missing fields→400, nonexistent→404, E2E-6                                                       |
| E2E Webhook with real HTTP server         | PASS       | 2026-03-24    | Challenge→capture→complete, E2E-7                                                                |
| OAuth adapters (Google/Microsoft/GitHub)  | PASS       | 2026-03-25    | DI fakes, userinfo fetch, error paths (16 tests)                                                 |
| Email delivery adapter                    | PASS       | 2026-03-25    | Templates, errors, XSS escaping (8 tests)                                                        |
| Delivery integration (route→delivery)     | PASS       | 2026-03-25    | Code delivery + response stripping (5 tests)                                                     |
| Compiler identity tier (3 paths)          | PASS       | 2026-03-25    | compileTools, profile, merge (9 tests)                                                           |
| Identity tier gate middleware             | PASS       | 2026-03-25    | Block/pass/absent/error format (10 tests)                                                        |
| Multi-method flow (OTP -> OAuth)          | NOT TESTED | -             | No cross-verifier scenario tests                                                                 |
| Tier progression E2E (0 -> 1 -> 2)        | NOT TESTED | -             | No end-to-end tier upgrade verification                                                          |
| Session resolution + verification chain   | NOT TESTED | -             | No project-safe `SessionResolutionRecord` coverage yet                                           |
| Audit + trace provenance                  | NOT TESTED | -             | No automated assertion for `verificationAttemptId` / `sessionPrincipalId` / `traceId` durability |

---

## Coverage Matrix

| FR    | Description                                                                     | Unit | Integration | E2E | Manual | Status      |
| ----- | ------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ----------- |
| FR-1  | Six verification methods supported                                              | YES  | NO          | YES | NO     | PASS        |
| FR-2  | Three-tier identity model (0, 1, 2)                                             | YES  | YES         | YES | NO     | PASS        |
| FR-3  | Tier promotion strictly upward                                                  | YES  | YES         | NO  | NO     | PARTIAL     |
| FR-4  | OTP codes hashed with HMAC-SHA256, timing-safe compare                          | YES  | NO          | YES | NO     | PASS        |
| FR-5  | OAuth PKCE + state parameter                                                    | YES  | NO          | YES | NO     | PASS        |
| FR-6  | Max attempt count + expiry window enforcement                                   | YES  | NO          | YES | NO     | PASS        |
| FR-7  | Identity artifacts hashed with SHA-256                                          | YES  | YES         | NO  | NO     | PARTIAL     |
| FR-8  | All operations tenant-scoped; continuity-sensitive flows also project-scoped    | YES  | YES         | NO  | NO     | PARTIAL     |
| FR-9  | REST API: initiate, complete, status endpoints                                  | YES  | YES         | YES | NO     | PASS        |
| FR-10 | VerifyIdentity dispatches to first matching verifier                            | YES  | YES         | YES | NO     | PASS        |
| FR-11 | Webhook verifier sends challenge, verifies response                             | YES  | NO          | YES | NO     | PASS        |
| FR-12 | Session resolution maps artifact hash to project-safe `SessionResolutionRecord` | YES  | YES         | NO  | NO     | PARTIAL     |
| FR-13 | Status reads enforce matching tenant, project, and session principal            | NO   | NO          | NO  | NO     | NOT STARTED |
| FR-14 | Verification lifecycle emits durable provenance to audit and traces             | NO   | NO          | NO  | NO     | NOT STARTED |

---

## E2E Test Scenarios (Mandatory -- minimum 5)

### E2E-1: HMAC Verification via HTTP API

**Preconditions**: Real Express server started on random port with full auth middleware. `HmacVerifier` registered with a test secret key. Redis-backed `VerificationTokenStore` connected.

**Steps**:

1. `POST /api/identity/verify/initiate` with valid SDK session auth token, body: `{ "method": "hmac", "identityValue": "user@example.com", "identityType": "email", "metadata": { "hmac": "<valid-hmac>", "timestamp": <current-ts> } }`
2. Assert response status 200, body `{ success: true }` (HMAC is single-step; no `attemptId` needed)
3. `POST /api/identity/verify/initiate` with **invalid** HMAC: `{ "metadata": { "hmac": "wrong", "timestamp": <ts> } }`
4. Assert response status 200, body `{ success: false, error: { code: "HMAC_INVALID" } }`
5. `POST /api/identity/verify/initiate` with **no auth token**
6. Assert response status 401, body `{ success: false, error: { code: "UNAUTHORIZED" } }`

**Expected Result**: Valid HMAC succeeds immediately; invalid HMAC fails with specific error code; missing auth returns 401.

**Auth Context**: SDK session token carrying `tenantId: "e2e-tenant-1"`, `sessionId: "e2e-session-1"`.

**Isolation Check**: Request from `tenantId: "e2e-tenant-2"` with same HMAC signature for same user succeeds independently (no cross-tenant leakage in identity).

---

### E2E-2: OTP Verification Complete Flow via HTTP API

**Preconditions**: Real Express server. `OtpVerifier` registered with test HMAC secret. Redis-backed token store. Auth middleware passing `tenantContext`.

**Steps**:

1. `POST /api/identity/verify/initiate` with auth, body: `{ "method": "otp", "identityValue": "user@example.com", "identityType": "email" }`
2. Assert response `{ success: true, attemptId: "<uuid>", challengeData: { userAction: "enter_otp", code: "<6-digit>" } }`
3. Extract `attemptId` and `code` from response
4. `GET /api/identity/verify/<attemptId>` with auth
5. Assert response `{ attemptId, status: "pending", method: "otp" }`
6. `POST /api/identity/verify/complete` with auth, body: `{ "attemptId": "<uuid>", "proof": { "type": "otp_code", "value": "<correct-code>", "metadata": { "tenantId": "e2e-tenant-1" } } }`
7. Assert response `{ success: true, identityTier: 2, verifiedIdentity: "user@example.com" }`
8. `GET /api/identity/verify/<attemptId>` with auth
9. Assert response `{ status: "verified" }`

**Expected Result**: Full OTP initiate -> complete cycle via HTTP API. Attempt transitions from pending to verified.

**Auth Context**: SDK session token with `tenantId: "e2e-tenant-1"` plus the canonical project/session scope used to create the attempt.

**Isolation Check**: `GET /api/identity/verify/<attemptId>` from `tenantId: "e2e-tenant-2"` returns 404.

---

### E2E-3: OTP Rate Limiting and Expiry via HTTP API

**Preconditions**: Real Express server. OTP verifier with `maxAttempts: 5`.

**Steps**:

1. `POST /api/identity/verify/initiate` with auth, body: `{ "method": "otp", "identityValue": "user@example.com", "identityType": "email" }`
2. Extract `attemptId`
3. Submit 5 incorrect OTP codes via `POST /complete` with wrong `proof.value`
4. Assert each response: `{ success: false, error: { code: "OTP_INVALID" } }` for first 4, then `{ success: false, error: { code: "OTP_MAX_ATTEMPTS" } }` on 5th
5. Submit correct OTP code via `POST /complete`
6. Assert response: `{ success: false, error: { code: "OTP_MAX_ATTEMPTS" } }` (rate limit exceeded even with correct code)
7. Wait for TTL expiry (or manipulate Redis TTL in test setup)
8. `GET /api/identity/verify/<attemptId>`
9. Assert response 404 (expired attempt cleaned up by Redis TTL)

**Expected Result**: Rate limiting enforced at max attempts. Expired attempts return 404.

**Auth Context**: SDK session token with `tenantId: "e2e-tenant-1"`.

---

### E2E-4: Cross-Tenant Isolation for Verification Attempts

**Preconditions**: Real Express server. OTP verifier registered. Two separate tenant auth tokens.

**Steps**:

1. As `tenantId: "tenant-A"`: `POST /api/identity/verify/initiate` with OTP method
2. Extract `attemptId`
3. As `tenantId: "tenant-A"`: `GET /api/identity/verify/<attemptId>` -- assert 200 with `status: "pending"`
4. As `tenantId: "tenant-B"`: `GET /api/identity/verify/<attemptId>` -- assert 404 (cross-tenant isolation)
5. As `tenantId: "tenant-B"`: `POST /api/identity/verify/complete` with the attemptId from tenant-A
6. Assert: completion fails because token store scopes lookup by tenantId (returns not found or error)
7. As `tenantId: "tenant-A"`: `POST /api/identity/verify/complete` with correct code -- assert success

**Expected Result**: Verification attempts are fully isolated by tenant. Cross-tenant access returns 404 or error, never leaking data.

**Auth Context**: Two separate SDK session tokens for `tenant-A` and `tenant-B`.

---

### E2E-4b: Status Reads Fail Closed on Wrong Project or Wrong Session Principal

**Preconditions**: Real Express server. OTP verifier registered. Two SDK session tokens in the same tenant: one for the original project/session principal and one for either a different project or a different session principal.

**Steps**:

1. As project A / session principal A: `POST /api/identity/verify/initiate` with OTP method and extract `attemptId`.
2. As the original caller: `GET /api/identity/verify/<attemptId>` and assert success.
3. As the same tenant but different project: `GET /api/identity/verify/<attemptId>` and assert non-leaky `404`.
4. As the same tenant and project but a different session principal: `GET /api/identity/verify/<attemptId>` and assert non-leaky `404`.
5. Repeat `POST /complete` from the mismatched callers and assert failure.

**Expected Result**: Verification status and completion remain bound to the originating `tenantId`, `projectId`, and `sessionPrincipalId`; wrong-project and wrong-session-principal callers cannot observe or complete the attempt.

---

### E2E-5: OAuth Verification Redirect Flow via HTTP API

**Preconditions**: Real Express server. `OAuthVerifier` registered with a mock `OAuthProviderAdapter` (this is the one case where a mock is acceptable -- the OAuth provider is an external third-party service, not a codebase component). Mock provider returns test authorization URL and test tokens.

**Steps**:

1. `POST /api/identity/verify/initiate` with auth, body: `{ "method": "oauth", "identityValue": "user@example.com", "identityType": "email" }`
2. Assert response `{ success: true, attemptId: "<uuid>", challengeData: { userAction: "redirect", redirectUrl: "<mock-auth-url>" } }`
3. Extract `attemptId` from response
4. `GET /api/identity/verify/<attemptId>` -- assert status `"pending"`
5. `POST /api/identity/verify/complete` with auth, body: `{ "attemptId": "<uuid>", "proof": { "type": "oauth_token", "value": "<mock-auth-code>", "metadata": { "tenantId": "e2e-tenant-1", "state": "<state-from-redirect-url>" } } }`
6. Assert response `{ success: true, identityTier: 2, verifiedIdentity: "user@example.com" }`
7. `GET /api/identity/verify/<attemptId>` -- assert status `"verified"`

**Expected Result**: OAuth flow initiates with PKCE + state, completes with token exchange, returns tier 2.

**Auth Context**: SDK session token with `tenantId: "e2e-tenant-1"`.

**Isolation Check**: Attempting to complete with wrong state parameter returns `{ error: { code: "OAUTH_STATE_MISMATCH" } }`.

---

### E2E-6: Input Validation on API Endpoints

**Preconditions**: Real Express server with full middleware chain.

**Steps**:

1. `POST /api/identity/verify/initiate` with auth, body: `{}` (missing required fields)
2. Assert response status 400, body: `{ success: false, error: { code: "INVALID_INPUT" } }`
3. `POST /api/identity/verify/complete` with auth, body: `{}` (missing attemptId and proof)
4. Assert response status 400, body: `{ success: false, error: { code: "INVALID_INPUT" } }`
5. `POST /api/identity/verify/complete` with auth, body: `{ "attemptId": "nonexistent-uuid", "proof": { "type": "otp_code", "value": "123456", "metadata": { "tenantId": "e2e-tenant-1" } } }`
6. Assert response: `{ success: false, error: { code: "OTP_ATTEMPT_NOT_FOUND" } }` (valid input but nonexistent attempt)
7. `GET /api/identity/verify/nonexistent-uuid` with auth
8. Assert response status 404

**Expected Result**: Invalid input returns 400. Nonexistent resources return 404 or structured error. Server does not crash.

---

### E2E-7: Webhook Verification Complete Flow

**Preconditions**: Real Express server. Real HTTP test server acting as webhook endpoint (started on random port). `WebhookVerifier` registered with `sendChallenge` function that POSTs to the test webhook server.

**Steps**:

1. Start a test HTTP server that captures POST requests and stores the challenge
2. `POST /api/identity/verify/initiate` with auth, body: `{ "method": "webhook", "identityValue": "api-key-123", "identityType": "api_client", "metadata": { "webhookUrl": "http://localhost:<test-port>/webhook", "providerVerified": false } }`
3. Assert response `{ success: true, attemptId: "<uuid>", challengeData: { userAction: "await_webhook" } }`
4. Extract the challenge from the test webhook server's captured request
5. `POST /api/identity/verify/complete` with auth, body: `{ "attemptId": "<uuid>", "proof": { "type": "provider_assertion", "value": "<captured-challenge>", "metadata": { "tenantId": "e2e-tenant-1" } } }`
6. Assert response `{ success: true, identityTier: 1, verifiedIdentity: "api-key-123" }`

**Expected Result**: Webhook challenge is sent to external endpoint, response is verified, identity is confirmed at tier 1.

---

### E2E-8: Agent DSL Identity Tier Gate (BETA)

**Preconditions**: Real Express server with identity verification routes. `ToolBindingExecutor` wired with identity tier gate middleware. Test tool definition with `identity_tier_required: 2`.

**Steps**:

1. Build a test tool with `identity_tier_required: 2` in its `ToolDefinition`
2. Invoke tool as anonymous caller (identity tier 0)
3. Assert response contains `IDENTITY_TIER_INSUFFICIENT` error with `required_tier: 2` and `current_tier: 0`
4. Initiate OTP verification via `POST /api/identity/verify/initiate`
5. Complete OTP verification via `POST /api/identity/verify/complete` with correct code
6. Invoke tool again as verified caller (identity tier 2)
7. Assert tool executes successfully

**Expected Result**: Tool access is gated by identity tier. Anonymous callers are blocked with descriptive error. Verified callers proceed.

**Auth Context**: SDK session token with `tenantId: "e2e-tenant-1"`.

**Status**: DEFERRED (BETA) — Requires `ToolBindingExecutor` test infrastructure not yet available. Unit tests for `createIdentityTierGateMiddleware` (10 tests) and compiler tests for `identity_tier_required` (9 tests) provide coverage for BETA.

---

## Integration Test Scenarios (Mandatory -- minimum 5)

### INT-1: RedisVerificationTokenStore CRUD with Real Redis

**Boundary**: `RedisVerificationTokenStore` <-> Redis

**Setup**: Real Redis instance (Docker or ioredis-mock). Create store with Redis getter.

**Steps**:

1. Create a `StoredVerificationAttempt` with `tenantId: "int-tenant"`, `projectId: "int-project"`, `sessionPrincipalId: "sessp-1"`, `attemptId: "int-attempt-1"`, `status: "pending"`, `expiresAt: now + 10min`
2. Call `tokenStore.create(attempt)`
3. Call `tokenStore.get("int-tenant", "int-project", "int-attempt-1")` -- assert returns stored attempt with correct fields
4. Verify Date fields round-trip correctly (ISO string serialization/deserialization)
5. Call `tokenStore.incrementAttempts("int-tenant", "int-project", "int-attempt-1")` -- assert `attempts` incremented
6. Call `tokenStore.markVerified("int-tenant", "int-project", "int-attempt-1")` -- assert `status` becomes `"verified"`
7. Call `tokenStore.get("other-tenant", "int-project", "int-attempt-1")` -- assert returns null (tenant isolation)
8. Call `tokenStore.get("int-tenant", "other-project", "int-attempt-1")` -- assert returns null (project isolation)
9. Wait for Redis TTL expiry -- assert `tokenStore.get("int-tenant", "int-project", "int-attempt-1")` returns null

**Expected Result**: Full CRUD lifecycle with tenant isolation and TTL-based expiry.

**Failure Mode**: Redis down -> all operations throw; caller (route handler) catches and returns 500.

---

### INT-2: RedisResolutionKeyStore Session Mapping with Real Redis

**Boundary**: `RedisResolutionKeyStore` <-> Redis

**Setup**: Real Redis instance.

**Steps**:

1. Create `RedisResolutionKeyStore` with Redis getter
2. Save resolution key: `{ tenantId: "t1", projectId: "p1", channelId: "ch1", artifactHash: "hash1", sessionLocator: { tenantId: "t1", projectId: "p1", sessionId: "sess-1" }, sessionPrincipalId: "sessp-1", verificationAttemptId: "verify-1", policySource: "project_policy", grantScope: "project_contact", traceId: "trace-1", expiresAt: now + 24h }`
3. Call `findByKey("t1", "p1", "ch1", "hash1")` -- assert returns the stored session-resolution record
4. Call `findByKey("t2", "p1", "ch1", "hash1")` -- assert returns null (tenant isolation)
5. Call `findByKey("t1", "p2", "ch1", "hash1")` -- assert returns null (project isolation)
6. Call `findByKey("t1", "p1", "ch2", "hash1")` -- assert returns null (channel isolation)
7. Save new key with same tuple but `sessionId: "sess-2"` in the `sessionLocator` -- assert overwrites
8. Call `findByKey("t1", "p1", "ch1", "hash1")` -- assert returns the updated record with `sessionLocator.sessionId = "sess-2"`
9. Call `remove("t1", "p1", "ch1", "hash1")` -- assert deletion
10. Call `findByKey("t1", "p1", "ch1", "hash1")` -- assert returns null

**Expected Result**: Session resolution keys are tenant+project+channel+artifact scoped, return provenance-bearing records, and remain overwritable/deletable.

---

### INT-3: VerifyIdentity Dispatcher with Multiple Verifiers

**Boundary**: `VerifyIdentity` use case <-> multiple `IdentityVerifier` adapters

**Setup**: Register HMAC, OTP, and Provider verifiers in the verifier map.

**Steps**:

1. Create input with `metadata: { hmac: "...", timestamp: 123 }` -- assert dispatches to `HmacVerifier`
2. Create input with `metadata: { providerVerified: true }` -- assert dispatches to `ProviderVerifier`
3. Create input with empty metadata `{}` -- assert dispatches to `OtpVerifier` (first catch-all that supports)
4. Create verifier map with only `HmacVerifier` -- input with empty metadata returns `{ success: false, error: { code: "NO_VERIFIER" } }`
5. Verify iteration order: HMAC checked before OTP (Map insertion order)

**Expected Result**: Dispatcher routes to correct verifier based on `supports()` check.

---

### INT-4: Full Identity Lifecycle (Verification -> Tier Promotion -> Session Resolution)

**Boundary**: `VerifyIdentity` + `PromoteTier` + `RegisterResolutionKey` + `ResolveSession` with in-memory stores

**Setup**: Wire all use cases with real implementations. In-memory stores for resolution (the infrastructure boundary is tested separately in INT-1 and INT-2).

**Steps**:

1. Initiate HMAC verification with valid credentials -- assert success
2. Promote tier from 0 to 2 via `hmac` method -- assert `{ success: true, newTier: 2 }`
3. Attempt to promote from 2 back to 1 via `cookie` -- assert `{ success: false, error: { code: "TIER_NOT_PROMOTED" } }`
4. Register resolution key: `(tenant, project, channel, artifactHash) -> SessionResolutionRecord`
5. Resolve session by same key -- assert returns the stored `SessionResolutionRecord`
6. Resolve session by different tenant or project -- assert returns `{ found: false }`

**Expected Result**: Complete identity lifecycle from verification through project-safe session resolution, with isolation and provenance enforced.

---

### INT-5: OTP Verifier Concurrent Attempt Race Condition

**Boundary**: `OtpVerifier` <-> `VerificationTokenStore`

**Setup**: In-memory or real Redis token store. Single OTP verification attempt.

**Steps**:

1. Initiate OTP verification, extract `attemptId` and `code`
2. Submit 3 concurrent `complete()` calls: 2 with wrong code, 1 with correct code
3. Assert: exactly one succeeds with `identityTier: 2`
4. Assert: the others fail with `OTP_INVALID` or `OTP_MAX_ATTEMPTS`
5. After completion, additional attempts return failure (attempt already verified or exhausted)

**Expected Result**: Concurrent verification attempts are handled safely. At most one succeeds. Rate limiting is enforced even under concurrency.

**Failure Mode**: Non-atomic increment could allow extra attempts under high concurrency (known GAP-009).

---

### INT-6: createIdentityContext Factory Wiring

**Boundary**: `createIdentityContext()` factory <-> all use cases

**Setup**: Create identity context with mock dependencies.

**Steps**:

1. Call `createIdentityContext({ verifiers, resolutionStore, tokenStore })`
2. Assert returned object has `verifyIdentity` (instance of `VerifyIdentity`)
3. Assert returned object has `resolveSession` (instance of `ResolveSession`)
4. Assert returned object has `registerResolutionKey` (instance of `RegisterResolutionKey`)
5. Assert returned object has `promoteTier` (instance of `PromoteTier`)
6. Execute each use case to verify wiring (not just type presence)

**Expected Result**: Factory correctly wires all use cases with injected dependencies.

---

### INT-7: Email Link Verifier Token Already Used

**Boundary**: `EmailLinkVerifier` <-> `VerificationTokenStore`

**Setup**: In-memory token store. EmailLinkVerifier with test signing key.

**Steps**:

1. Initiate email link verification, extract `attemptId` and `token`
2. Complete verification with correct token -- assert success, tier 2
3. Attempt to complete again with same token
4. Assert: `{ success: false, error: { code: "ALREADY_VERIFIED" } }` (token cannot be reused)

**Expected Result**: Email link tokens are single-use. Replay attacks are prevented.

---

### INT-8: Verification Code Delivery Dispatch (BETA)

**Boundary**: `IdentityVerificationRouter` + `VerificationDeliveryService` + `OtpVerifier`

**Setup**: Real Express server with OTP verifier. `VerificationDeliveryService` injected via DI (mock implementation tracking calls). Auth middleware passing `tenantContext`.

**Steps**:

1. Initiate OTP verification with delivery service configured
2. Assert delivery service `deliverCode('email', identityValue, code)` was called with correct arguments
3. Assert HTTP response does NOT contain `challengeData.code` (raw code stripped)
4. Assert HTTP response contains `challengeData.deliveryStatus: 'sent'`
5. Initiate email-link verification with delivery service configured
6. Assert delivery service called with token
7. Assert HTTP response does NOT contain `challengeData.token` (raw token stripped)
8. Initiate OTP verification WITHOUT delivery service configured (backward compat)
9. Assert HTTP response DOES contain `challengeData.code` (ALPHA behavior preserved)

**Expected Result**: Delivery service is called for OTP and email-link flows. Raw codes/tokens are always stripped from HTTP responses when delivery is configured. Backward-compatible when delivery service is absent.

**Status**: PASS — 5 integration tests in `delivery-integration.test.ts`. Covers OTP delivery + code stripping, email-link delivery + token stripping, backward compat (no delivery service), and delivery failure resilience.

---

## Unit Test Scenarios

All existing unit tests cover the following modules. These are already implemented and passing.

| Module                        | Key Scenarios                                                               | Test File                                |
| ----------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| `HmacVerifier`                | Valid HMAC, invalid HMAC, missing metadata, supports() routing              | `hmac-verifier.test.ts`                  |
| `OtpVerifier`                 | Code generation, HMAC hash, timing-safe compare, rate limit, expiry         | `otp-verifier.test.ts`                   |
| `OAuthVerifier`               | Initiate (PKCE+state), complete (exchange+email), state mismatch, expiry    | `oauth-verifier.test.ts`                 |
| `EmailLinkVerifier`           | Token generation, hash comparison, expiry, already-verified, token mismatch | `email-link-verifier.test.ts`            |
| `ProviderVerifier`            | Provider-verified true, false, supports() check                             | `provider-verifier.test.ts`              |
| `WebhookVerifier`             | Challenge send, hash comparison, webhook send failure, expiry, SSRF block   | `provider-verifier.test.ts` (combined)   |
| `VerificationAttempt`         | Create, isExpired, canAttempt, maxAttempts boundary                         | `identity-domain.test.ts`                |
| `IdentityTier`                | canPromoteTo (all combinations), tierFromVerification                       | `identity-domain.test.ts`                |
| `IdentityArtifact`            | SHA-256 hash, create with type                                              | `identity-domain.test.ts`                |
| `PromoteTier`                 | Valid 0->2, 0->1, 1->2; rejected 2->1, 1->1, 0->0                           | `promote-tier.test.ts`                   |
| `VerifyIdentity`              | Dispatch to correct verifier, NO_VERIFIER fallback                          | `verify-identity.test.ts`                |
| `ResolveSession`              | Key found, key not found                                                    | `resolve-session.test.ts`                |
| `RedisVerificationTokenStore` | CRUD, TTL, tenant isolation, Date serialization                             | `redis-verification-token-store.test.ts` |
| `RedisResolutionKeyStore`     | Key format, TTL, tenant isolation, removal                                  | `resolution-key-store.test.ts`           |
| Route handlers                | Auth check (401), input validation (400), happy path                        | `verification-routes.test.ts`            |
| `GoogleOAuthAdapter`          | Auth URL, validate code, fetchUserEmail, no-email error, non-OK status      | `oauth-adapters.test.ts`                 |
| `MicrosoftOAuthAdapter`       | Auth URL, validate code, fetchUserEmail, UPN fallback, no-email, non-OK     | `oauth-adapters.test.ts`                 |
| `GitHubOAuthAdapter`          | Auth URL (no PKCE), validate code, primary verified email, no-email, non-OK | `oauth-adapters.test.ts`                 |
| `EmailDeliveryAdapter`        | Email send, SMS fallback, Error/non-Error, OTP/magic-link template, XSS     | `email-delivery-adapter.test.ts`         |
| Compiler identity tier        | compileTools tiers 0/1/2/undefined, compileToolDefinitionAST, merge         | `compiler-identity-tier.test.ts`         |
| Identity tier gate middleware | Block insufficient, pass sufficient, pass absent, error response format     | `identity-tier-gate-middleware.test.ts`  |

---

## Security & Isolation Tests

- [x] Cross-tenant token store access returns null (unit test in `redis-verification-token-store.test.ts`)
- [x] Cross-tenant resolution key returns null (unit test in `resolution-key-store.test.ts`)
- [x] Cross-tenant contact resolution returns different contacts (`identity.e2e.test.ts`)
- [x] Missing auth returns 401 (`verification-routes.test.ts`)
- [x] Cross-tenant verification attempt access via HTTP API returns 404 (E2E-4)
- [x] Cross-tenant OTP completion fails via HTTP API (E2E-4)
- [x] Invalid HMAC fails verification (unit test + integration test + E2E-1)
- [x] OTP rate limiting enforced at max attempts (unit test + E2E-3)
- [x] OAuth state mismatch rejected (unit test)
- [ ] HMAC replay attack with expired timestamp (requires E2E with real verifier)
- [x] Input validation rejects malformed bodies (E2E-6)
- [x] SSRF protection blocks private IPs, localhost, cloud metadata (webhook verifier unit tests)
- [x] TTL expiry returns 404 (E2E-3)

---

## Performance & Load Tests

Not applicable for initial implementation. Consider adding:

- **Concurrent OTP verification**: 100 concurrent `complete()` calls to verify rate limiting holds under load
- **Redis token store throughput**: Measure read/write latency under sustained verification load
- **Session resolution lookup latency**: Benchmark `findByKey()` under production-like key counts

---

## Test Infrastructure

### Required Services

- **Redis**: Required for `RedisVerificationTokenStore` and `RedisResolutionKeyStore` integration tests. Use Docker Redis or ioredis-mock.
- **Express**: Start real Express server on `port: 0` (random port) for E2E tests.

### Data Seeding Strategy

- E2E tests create their own verification attempts via API calls (no pre-seeded data)
- Integration tests create in-memory or Redis-based stores and populate them within each test
- Each test uses unique `tenantId` values to avoid cross-test interference

### Environment Variables

- No special environment variables needed beyond standard runtime configuration
- HMAC secrets, OTP secrets, and OAuth config are injected via constructor parameters in test setup
- OAuth tests use a mock `OAuthProviderAdapter` (external third-party service)

### CI Configuration

- Unit tests: `pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/`
- Integration tests: Require Redis (start Docker Redis in CI before tests)
- E2E tests: Require Redis + Express server startup

---

## Test File Mapping

| Test File                                                                             | Type        | Covers                                                 | Status |
| ------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ | ------ |
| `apps/runtime/src/__tests__/contexts/identity/hmac-verifier.test.ts`                  | unit        | FR-1                                                   | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/otp-verifier.test.ts`                   | unit        | FR-1, FR-4, FR-6                                       | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/oauth-verifier.test.ts`                 | unit        | FR-1, FR-5, FR-6                                       | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/email-link-verifier.test.ts`            | unit        | FR-1, FR-6                                             | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/provider-verifier.test.ts`              | unit        | FR-1                                                   | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/identity-domain.test.ts`                | unit        | FR-2, FR-3, FR-7                                       | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/promote-tier.test.ts`                   | unit        | FR-2, FR-3                                             | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/verify-identity.test.ts`                | unit        | FR-10                                                  | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/resolve-session.test.ts`                | unit        | FR-12                                                  | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/redis-verification-token-store.test.ts` | unit        | FR-8                                                   | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/resolution-key-store.test.ts`           | unit        | FR-12                                                  | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/verification-routes.test.ts`            | integration | FR-9                                                   | PASS   |
| `apps/runtime/src/__tests__/contexts/integration/identity.e2e.test.ts`                | integration | FR-2, FR-3, FR-7, FR-8, FR-10, FR-12                   | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/oauth-adapters.test.ts`                 | unit        | FR-1, FR-5 (BETA: OAuth adapter DI)                    | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/email-delivery-adapter.test.ts`         | unit        | BETA: delivery adapter templates, XSS                  | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/delivery-integration.test.ts`           | integration | BETA: INT-8 delivery + response stripping              | PASS   |
| `packages/compiler/src/__tests__/compiler-identity-tier.test.ts`                      | unit        | BETA: identityTierRequired compilation (3 paths)       | PASS   |
| `packages/compiler/src/__tests__/identity-tier-gate-middleware.test.ts`               | unit        | BETA: identity tier gate block/pass/error              | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/identity-e2e-http.test.ts`              | e2e         | FR-1, FR-2, FR-4, FR-5, FR-6, FR-8, FR-9, FR-10, FR-11 | PASS   |

---

## Coverage Gap Analysis

### Critical Gaps (RESOLVED)

All critical gaps resolved in ALPHA and BETA implementation:

- E2E-1 through E2E-7 implemented with real Express servers (ALPHA)
- Cross-tenant isolation tested (E2E-4) (ALPHA)
- SSRF protection added and tested (ALPHA)
- E2E-8 deferred — covered by unit + integration tests (BETA)
- INT-8 delivery integration implemented (5 tests) (BETA)
- OAuth adapter tests refactored to DI (no `vi.mock()`) (BETA)
- Compiler identity tier tests cover all 3 compilation paths (BETA)

### Important Gaps (should address for STABLE)

| #   | Gap                                               | Risk                                                   | Recommendation                                          |
| --- | ------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| 4   | No real Redis integration tests (INT-1, INT-2)    | InMemoryRedis misses real TTL/serialization edge cases | Implement with Docker Redis in CI                       |
| 5   | No concurrent verification test (INT-5)           | Race condition under high concurrency                  | Implement with parallel Promise.all                     |
| 7   | No email link single-use enforcement test (INT-7) | Token replay could succeed                             | Implement INT-7                                         |
| 11  | E2E-8 DSL tier gate E2E test deferred             | Tier gate middleware only tested via unit tests        | Implement when ToolBindingExecutor test infra available |

### Low Priority Gaps

| #   | Gap                                    | Risk                                     | Recommendation                            |
| --- | -------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| 8   | No createIdentityContext factory test  | Wiring errors in factory could break DI  | Implement INT-6                           |
| 10  | No multi-method verification flow test | Method switching mid-session could break | Integration test OTP fail → OAuth success |

---

## Open Testing Questions

1. ~~Should E2E tests use Docker Redis or ioredis-mock?~~ **RESOLVED**: Using `InMemoryRedis` (implements `RedisLike` interface including `eval` for Lua scripts). Real Redis deferred to BETA integration tests.
2. ~~Should OAuth E2E tests use a real OAuth server or mock?~~ **RESOLVED**: Using `TestOAuthProvider` class implementing `OAuthProviderAdapter` interface directly — acceptable as external third-party service mock.
3. ~~What auth token format for E2E?~~ **RESOLVED**: Using header-based auth middleware (`x-tenant-id`, `x-session-id` headers) that populates `req.tenantContext`. No auth token required — tests set the context directly via middleware.

---

## How to Run

```bash
# All identity unit tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/

# Specific verifier tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/hmac-verifier.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/otp-verifier.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/oauth-verifier.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/email-link-verifier.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/provider-verifier.test.ts

# Domain and use case tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/identity-domain.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/promote-tier.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/verify-identity.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/resolve-session.test.ts

# Infrastructure store tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/redis-verification-token-store.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/resolution-key-store.test.ts

# Route tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/verification-routes.test.ts

# BETA: OAuth adapters
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/oauth-adapters.test.ts

# BETA: Email delivery adapter
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/email-delivery-adapter.test.ts

# BETA: Delivery integration
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/delivery-integration.test.ts

# Integration test (HMAC identity lifecycle)
pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/integration/identity.e2e.test.ts

# BETA: Compiler identity tier tests
cd packages/compiler && pnpm vitest run src/__tests__/compiler-identity-tier.test.ts

# BETA: Identity tier gate middleware tests
cd packages/compiler && pnpm vitest run src/__tests__/identity-tier-gate-middleware.test.ts
```

---

## What Good Looks Like

A passing identity verification E2E test suite should:

1. Start a real Express server with the identity verification router mounted and real auth middleware
2. Configure a real Redis-backed VerificationTokenStore and ResolutionKeyStore
3. Initiate verification via `POST /initiate` with valid auth token
4. Complete verification via `POST /complete` with correct proof
5. Verify the attempt status via `GET /:attemptId` shows `"verified"`
6. Verify tenant isolation: attempt from tenant A returns 404 for tenant B
7. Verify rate limiting: excessive failed attempts return rejection before max attempts
8. Verify expiry: expired attempts cannot be completed
9. Verify input validation: malformed requests return structured error responses
10. Verify webhook flow: external endpoint receives challenge, response verified

---

## Environment Requirements

- **Redis**: Required for RedisVerificationTokenStore and RedisResolutionKeyStore integration tests
- **No MongoDB required**: Identity verification uses Redis for state, not MongoDB
- **No special environment variables**: All secrets are injected via constructor parameters in test setup
- **OAuth tests**: Require mock OAuthProviderAdapter (not real OAuth server)
