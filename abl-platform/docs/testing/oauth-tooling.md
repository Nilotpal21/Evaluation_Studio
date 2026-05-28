# Test Spec: OAuth Tooling

**Date:** 2026-03-23
**Status:** PLANNED
**Feature:** [oauth-tooling](../features/oauth-tooling.md)

---

## 1. Coverage Matrix

| Component                                              | Unit   | Integration | E2E    | Status  |
| ------------------------------------------------------ | ------ | ----------- | ------ | ------- |
| Studio OAuth Config UI (`HttpConfigForm` OAuth panels) | 5      | 2           | 3      | Planned |
| Auth Profile linking (tool -> `oauth2_app`)            | 3      | 2           | 2      | Planned |
| End-user OAuth consent flow (Studio)                   | 2      | 3           | 3      | Planned |
| Token health dashboard                                 | 3      | 1           | 2      | Planned |
| Tool OAuth test runner                                 | 2      | 2           | 2      | Planned |
| Runtime OAuth credential resolution                    | 5      | 3           | 3      | Planned |
| Token refresh during execution                         | 3      | 2           | 2      | Planned |
| Connector OAuth migration                              | 2      | 2           | 2      | Planned |
| **Totals**                                             | **25** | **17**      | **19** |         |

---

## 2. E2E Test Scenarios

All E2E tests exercise the real system through HTTP API. No mocks, no direct DB access, no stubbed servers.

### E2E-1: Create HTTP tool with `oauth2_client` auth type and linked Auth Profile

**Steps:**

1. POST `/api/projects/:projectId/auth-profiles` -- create `oauth2_app` profile with `tokenUrl`, `clientId`, `clientSecret`
2. POST `/api/projects/:projectId/auth-profiles` -- create `oauth2_client_credentials` profile linked to the app profile
3. POST `/api/projects/:projectId/tools` -- create HTTP tool with `auth: 'oauth2_client'`, `authConfig.authProfileId` set to the client credentials profile ID
4. GET `/api/projects/:projectId/tools/:toolId` -- verify tool has OAuth config persisted
5. Verify tool config includes `authProfileId`, `tokenUrl`, `scopes`

**Assertions:**

- Tool creation returns 201 with correct `auth` and `authConfig` fields
- GET returns tool with linked auth profile ID
- Auth profile reference is validated (invalid ID returns 400)

### E2E-2: Create HTTP tool with `oauth2_user` auth type and initiate consent flow

**Steps:**

1. POST `/api/projects/:projectId/auth-profiles` -- create `oauth2_app` profile with authorization URL, token URL, PKCE settings
2. POST `/api/projects/:projectId/tools` -- create HTTP tool with `auth: 'oauth2_user'`, linked to the app profile
3. POST `/api/v1/oauth/authorize/:provider` -- initiate OAuth flow for the tool's provider
4. Verify response contains `authUrl` with correct `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge` (PKCE)
5. Verify state is stored in Redis (or in-memory for test) and expires within 10 minutes

**Assertions:**

- Authorization URL includes all required OAuth parameters
- PKCE `code_challenge_method` is `S256`
- State parameter is 64 hex characters (32 bytes CSPRNG)
- Duplicate state creation is idempotent (does not leak previous state)

### E2E-3: OAuth callback creates `oauth2_token` Auth Profile linked to `oauth2_app`

**Steps:**

1. Create `oauth2_app` profile (setup)
2. Create HTTP tool with `oauth2_user` linked to app profile (setup)
3. Initiate OAuth flow to get state parameter
4. Mock external IdP token endpoint (test-only HTTP server returning valid token response)
5. GET `/api/v1/oauth/callback?code=test_code&state=<state>` -- simulate OAuth callback
6. GET `/api/projects/:projectId/auth-profiles?authType=oauth2_token&connector=<connector>` -- verify token profile was created
7. Verify token profile is linked to the app profile via `linkedAppProfileId`

**Assertions:**

- Callback returns 302 redirect to success page
- Token profile created with `authType: 'oauth2_token'`
- Token profile `linkedAppProfileId` matches the app profile ID
- `encryptedSecrets` contains encrypted `accessToken` and `refreshToken`
- Token profile `scope` is `personal` (user-scoped)
- Invalid/expired state returns 400

### E2E-4: Runtime resolves OAuth credentials for tool execution

**Steps:**

1. Create `oauth2_app` and `oauth2_client_credentials` profiles (setup)
2. Create HTTP tool linked to client credentials profile (setup)
3. Start a runtime session via WebSocket
4. Send a message that triggers the HTTP tool
5. Mock the external API endpoint to echo the Authorization header
6. Verify the tool execution sends `Authorization: Bearer <token>` header

**Assertions:**

- Runtime resolves client credentials via `resolveClientCredentialsToken`
- Tool HTTP request includes `Authorization: Bearer` header with valid token
- Token is cached in Redis for subsequent calls
- Trace events emitted for credential resolution

### E2E-5: Token refresh during tool execution with distributed locking

**Steps:**

1. Create `oauth2_app` and `oauth2_token` profiles with an expired `expiresAt` (setup)
2. Create HTTP tool linked to the token profile (setup)
3. Start runtime session
4. Trigger tool execution
5. Mock the token refresh endpoint to return a new access token
6. Verify tool execution succeeds with the refreshed token

**Assertions:**

- `needsProactiveRefresh` detects the expired token
- Token refresh acquires Redis lock (`SET NX PX`)
- New token is persisted in the Auth Profile
- Tool execution uses the refreshed token
- `REFRESH_START` and `REFRESH_SUCCESS` trace events emitted

### E2E-6: Tool test connection from Studio

**Steps:**

1. Create `oauth2_app` and `oauth2_client_credentials` profiles (setup)
2. Create HTTP tool with endpoint pointing to a test echo server (setup)
3. POST `/api/projects/:projectId/tools/:toolId/test` -- trigger test connection
4. Verify response includes HTTP status, latency, and success flag

**Assertions:**

- Test connection resolves OAuth credentials
- Response includes `{ success: true, status: 200, latencyMs: <number> }`
- Failed connection returns `{ success: false, error: { code, message } }`
- Test with expired/missing token returns appropriate error code

### E2E-7: Token health status on tool list

**Steps:**

1. Create tools with various token states: active, expiring (< 24h), expired, revoked (setup)
2. GET `/api/projects/:projectId/tools` -- fetch tool list
3. Verify each tool includes `tokenStatus` field

**Assertions:**

- Active token shows `status: 'active'`
- Token expiring within 24h shows `status: 'expiring'`
- Expired token shows `status: 'expired'`
- Revoked token shows `status: 'revoked'`
- Tool without OAuth auth shows `tokenStatus: null`

### E2E-8: Cross-tenant isolation for OAuth Auth Profiles

**Steps:**

1. Create `oauth2_app` profile in Tenant A
2. Attempt to create tool in Tenant B linked to Tenant A's auth profile
3. Attempt to read Tenant A's token via Tenant B's session

**Assertions:**

- Linking to cross-tenant auth profile returns 404 (not 403)
- Token resolution for cross-tenant profile returns null
- No error message leaks the existence of the cross-tenant resource

### E2E-9: End-user OAuth with PKCE S256

**Steps:**

1. Create `oauth2_app` profile with `pkceRequired: true`, `pkceMethod: 'S256'` (setup)
2. Initiate OAuth flow
3. Verify `code_challenge` and `code_challenge_method` in authorization URL
4. Simulate callback with valid code
5. Verify token exchange includes `code_verifier`

**Assertions:**

- Authorization URL includes `code_challenge` (Base64URL-encoded SHA-256 of verifier)
- Authorization URL includes `code_challenge_method=S256`
- Token exchange POST body includes `code_verifier`
- `code_verifier` is 43-128 characters (RFC 7636)

### E2E-10: Connector OAuth migration to Auth Profile flow

**Steps:**

1. Configure a SearchAI connector (e.g., Gmail) with OAuth
2. Initiate connector OAuth flow via new Auth Profile-based route
3. Complete callback
4. Verify connector connection stores `authProfileId` instead of inline tokens

**Assertions:**

- OAuth state stored in Redis (not in-memory)
- Callback creates `oauth2_token` Auth Profile
- Connector connection document references `authProfileId`
- Legacy `consumePendingState` in-memory store is not used

---

## 3. Integration Test Scenarios

### INT-1: `ToolOAuthService` resolves via `AuthProfileOAuthResolver` fallback chain

**Setup:** Real `ToolOAuthService` with `AuthProfileOAuthResolver` injected.
**Test:** Call `getAccessToken()` -- should check Auth Profile first, fall through to legacy `EndUserOAuthToken` store if not found.
**Assert:** Auth Profile hit returns token without querying legacy store.

### INT-2: `RuntimeSecretsProvider` resolves OAuth secrets from Auth Profile

**Setup:** Real `RuntimeSecretsProvider` with `AuthProfileResolver` configured.
**Test:** Request secret `oauth2.google.access_token` -- should resolve via Auth Profile chain.
**Assert:** Returns decrypted access token from Auth Profile, not legacy ToolSecret.

### INT-3: `applyAuth` correctly applies `oauth2_token` credentials

**Setup:** Call `applyAuth` with `authType: 'oauth2_token'` and mock secrets.
**Test:** Verify output headers include `Authorization: Bearer <token>`.
**Assert:** Header correctly set; no credential leakage to other fields.

### INT-4: Token refresh with concurrent pod simulation

**Setup:** Two concurrent calls to `refreshOAuth2Token` for the same profile with real Redis.
**Test:** Both calls execute simultaneously.
**Assert:** Only one acquires the lock; the other reads the refreshed token. No duplicate refresh requests to the external provider.

### INT-5: `validateLinkedAppProfile` rejects invalid references

**Setup:** Real MongoDB with Auth Profile documents.
**Test:** Call with non-existent ID, wrong auth type, inactive profile.
**Assert:** Each case throws the correct `AuthProfileError` code.

### INT-6: Studio OAuth initiate route validates redirect URI against allowlist

**Setup:** Real Express server with OAuth routes and configured allowlist.
**Test:** POST `/api/v1/oauth/authorize/google` with allowed and disallowed redirect URIs.
**Assert:** Allowed URI returns 200 with auth URL; disallowed URI returns 400.

### INT-7: Client credentials token cache in Redis

**Setup:** Real Redis + `resolveClientCredentialsToken`.
**Test:** Call twice within token TTL.
**Assert:** Second call returns cached token (`cached: true`), no HTTP request to token URL.

---

## 4. Unit Test Scenarios

### Validation Layer

| ID   | Test                                                                                  | Component                 |
| ---- | ------------------------------------------------------------------------------------- | ------------------------- |
| UT-1 | `CreateHttpToolSchema` validates `oauth2_client` auth type with required `authConfig` | `project-tool-schemas.ts` |
| UT-2 | `CreateHttpToolSchema` validates `oauth2_user` auth type with required `authConfig`   | `project-tool-schemas.ts` |
| UT-3 | `CreateHttpToolSchema` rejects `oauth2_client` without `authConfig.tokenUrl`          | `project-tool-schemas.ts` |
| UT-4 | `OAuth2AppConfigSchema` validates all fields including PKCE options                   | `auth-profile.schema.ts`  |
| UT-5 | `OAuth2TokenConfigSchema` validates `refreshTokenRotation` boolean                    | `auth-profile.schema.ts`  |

### Service Layer

| ID    | Test                                                                     | Component                  |
| ----- | ------------------------------------------------------------------------ | -------------------------- |
| UT-6  | `needsProactiveRefresh` returns true when token expires within 5 minutes | `token-refresh-service.ts` |
| UT-7  | `needsProactiveRefresh` returns false for null/undefined `expiresAt`     | `token-refresh-service.ts` |
| UT-8  | `isValidProvider` rejects special characters and overly long names       | `oauth.ts` (route)         |
| UT-9  | `isAllowedRedirectUri` validates against configured origins              | `oauth.ts` (route)         |
| UT-10 | `getOAuthProvider` maps connector names to provider names                | `connector-oauth.ts`       |

### State Management

| ID    | Test                                                                           | Component               |
| ----- | ------------------------------------------------------------------------------ | ----------------------- |
| UT-11 | `InMemoryOAuthStateStore` evicts oldest entries at capacity                    | `tool-oauth-service.ts` |
| UT-12 | `RedisOAuthStateStore` validates state format before Redis query               | `tool-oauth-service.ts` |
| UT-13 | `InMemoryOAuthStateStore.getAndDelete` is atomic (returns null on second call) | `tool-oauth-service.ts` |

### Auth Profile Integration

| ID    | Test                                                                              | Component                 |
| ----- | --------------------------------------------------------------------------------- | ------------------------- |
| UT-14 | `resolveOAuth2AppCredentials` throws when linked profile not found                | `oauth2-app-resolver.ts`  |
| UT-15 | `resolveOAuth2AppCredentials` throws when linked profile is wrong auth type       | `oauth2-app-resolver.ts`  |
| UT-16 | `resolveOAuth2AppCredentials` throws when linked profile is not active            | `oauth2-app-resolver.ts`  |
| UT-17 | `validateLinkedAppProfile` uses `findOne({ _id, tenantId })` for tenant isolation | `linked-app-validator.ts` |

### UI Components

| ID    | Test                                                                    | Component            |
| ----- | ----------------------------------------------------------------------- | -------------------- |
| UT-18 | `HttpConfigForm` renders OAuth fields when auth type is `oauth2_client` | `HttpConfigForm.tsx` |
| UT-19 | `HttpConfigForm` renders "Connect Account" button for `oauth2_user`     | `HttpConfigForm.tsx` |
| UT-20 | `HttpConfigForm` hides client secret field (server-side only)           | `HttpConfigForm.tsx` |
| UT-21 | Token health badge renders correct color for each status                | New component        |
| UT-22 | Auth Profile selector dropdown filters by `authType: 'oauth2_app'`      | New component        |

---

## 5. Edge Cases & Negative Tests

| ID     | Scenario                                                  | Expected Behavior                                                                        |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| NEG-1  | OAuth callback with expired state (> 10 min)              | Return 400 "OAuth state expired"                                                         |
| NEG-2  | OAuth callback with state from different provider         | Return 400 "Invalid OAuth state"                                                         |
| NEG-3  | Token refresh when refresh token is missing               | Throw "No refresh token available" error; tool execution fails with clear message        |
| NEG-4  | Token refresh when linked `oauth2_app` profile is deleted | Throw "Linked OAuth app profile not found" with remediation guidance                     |
| NEG-5  | Concurrent token refresh from 3 pods                      | Only one pod refreshes; other 2 read refreshed token from DB                             |
| NEG-6  | OAuth redirect URI not in allowlist                       | Return 400 before initiating flow                                                        |
| NEG-7  | External IdP returns error during token exchange          | Return clear error with IdP status code; do not store partial tokens                     |
| NEG-8  | Tool test connection with network timeout                 | Return `{ success: false, error: { code: 'TIMEOUT', message: '...' } }` within 5 seconds |
| NEG-9  | Create tool linked to cross-tenant Auth Profile           | Return 404 (not 403)                                                                     |
| NEG-10 | PKCE flow with `plain` method when app requires `S256`    | Reject at Auth Profile validation level                                                  |

---

## 6. Test Infrastructure Requirements

| Requirement                        | Implementation                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Mock external IdP token endpoint   | Lightweight Express server on random port returning configurable token responses |
| Redis for distributed lock tests   | Real Redis instance (Docker `redis:7-alpine`)                                    |
| MongoDB for Auth Profile storage   | Real MongoDB instance (Docker or MongoMemoryServer)                              |
| Encryption for token storage       | Real `EncryptionService` with test master key                                    |
| WebSocket for runtime consent flow | Real WebSocket server on random port                                             |
