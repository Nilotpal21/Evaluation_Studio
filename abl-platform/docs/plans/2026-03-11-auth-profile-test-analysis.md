# Auth Profile — Test Impact Analysis

> Companion to `2026-03-11-auth-profile-design.md`. Catalogs every test that breaks, needs updating, or must be written for the Auth Profile migration.

---

## 1. Existing Tests That Will BREAK

These tests directly import, mock, or instantiate the three models being deleted (`LLMCredential`, `EndUserOAuthToken`, `ToolSecret`) or reference inline auth fields on `ConnectorConnection` (`encryptedCredentials`, `oauth2RefreshToken`, `oauth2Provider`). They will fail at compile time or runtime once those models/fields are removed.

### 1.1 ToolSecret Model & CRUD

| #   | File                                                                 | Test Names                                                                                                                                                                                                      | Why It Breaks                                                                                         |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | `packages/database/src/__tests__/model-security.test.ts`             | `ToolSecret` describe block (12 tests): "sets default fields", "requires tenantId/projectId/toolName/secretKey/encryptedValue/environment/createdBy", "defaults version to 1", "enforces unique compound index" | Imports `ToolSecret` model directly — model is deleted                                                |
| 2   | `packages/database/src/__tests__/encryption-e2e.test.ts`             | "ToolSecret: save encrypts encryptedValue, findOne decrypts it (v3)", "ToolSecret: save->find round-trip returns decrypted encryptedValue"                                                                      | Imports `ToolSecret` model for encryption round-trip — model is deleted                               |
| 3   | `packages/shared/src/__tests__/security-repo.test.ts`                | Entire "Tool Secrets" describe block (15+ tests): `findToolSecretById`, `createToolSecret`, `findToolSecrets`, `countToolSecrets`, `updateToolSecret`, `deleteToolSecret` with tenant isolation                 | Mocks `ToolSecret` from `@agent-platform/database/models` — model is deleted                          |
| 4   | `apps/runtime/src/__tests__/tool-secrets-authz.test.ts`              | All 24 tests across OWNER/ADMIN/OPERATOR/MEMBER/VIEWER/Unauthenticated roles for `POST /`, `GET /`, `POST /:id/rotate`, `DELETE /:id`                                                                           | Mocks `@agent-platform/shared/repos` tool secret functions — routes are replaced by Auth Profile CRUD |
| 5   | `apps/runtime/src/__tests__/secrets-provider.test.ts`                | "getSecret - DB store" tests (4 tests): "resolves from store, decrypts", "rejects expired secret", "returns undefined when store returns null", "handles store error gracefully"                                | `ToolSecretStore` interface changes — Auth Profile replaces DB-backed secret resolution               |
| 6   | `apps/runtime/src/__tests__/services/credential-age-monitor.test.ts` | All 4 tests: "emits warning event", "emits critical event", "emits nothing when all fresh", "skips credentials where rotatedAt is recent"                                                                       | Mocks both `ToolSecret.find` and `LLMCredential.find` — both models deleted                           |
| 7   | `apps/runtime/src/__tests__/repos-data.test.ts`                      | All `ToolSecret`, `EndUserOAuthToken`, and `LLMCredential` integration tests (dynamic imports of these models)                                                                                                  | Imports deleted models from `@agent-platform/database/models`                                         |

### 1.2 EndUserOAuthToken Model & CRUD

| #   | File                                                     | Test Names                                                                                                                                                                                                 | Why It Breaks                                                                                                                         |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | `packages/database/src/__tests__/model-security.test.ts` | `EndUserOAuthToken` describe block (8 tests): "sets default fields", "requires tenantId/userId/provider/providerUserId/encryptedAccessToken/scope/consentedAt", "enforces unique tenantId+userId+provider" | Imports `EndUserOAuthToken` model — model is deleted                                                                                  |
| 9   | `packages/shared/src/__tests__/security-repo.test.ts`    | "End User OAuth Tokens" describe block (5 tests): `findEndUserOAuthTokens` with filtering/pagination, `countEndUserOAuthTokens`                                                                            | Mocks `EndUserOAuthToken` from database/models — model is deleted                                                                     |
| 10  | `apps/runtime/src/__tests__/oauth-authz.test.ts`         | All 18 tests across OWNER/ADMIN/OPERATOR/MEMBER/VIEWER/Unauthenticated for `POST /authorize/:provider`, `GET /tokens`, `DELETE /tokens/:provider`                                                          | Mocks `findEndUserOAuthTokens`, `countEndUserOAuthTokens` from `../repos/security-repo.js` — replaced by Auth Profile OAuth endpoints |

### 1.3 LLMCredential Model & Resolution

| #   | File                                                                             | Test Names                                                                                      | Why It Breaks                                                                |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 11  | `apps/search-ai/src/services/llm-config/__tests__/resolver.test.ts`              | Tests that mock `LLMCredential` model via `getModel('LLMCredential')` for credential resolution | LLMCredential model deleted — replaced by AuthProfile with `category: 'llm'` |
| 12  | `apps/search-ai/src/services/llm-config/__tests__/embedding-credentials.test.ts` | `resolveEmbeddingCredentials` tests that query `LLMCredential` via `getModel` mock              | Same — LLMCredential model deleted                                           |
| 13  | `apps/runtime/src/__tests__/services/credential-age-monitor.test.ts`             | (also listed above) — mocks `LLMCredential.find` for age monitoring                             | LLMCredential model deleted                                                  |

### 1.4 ConnectorConnection Inline Auth Fields

| #   | File                                                                 | Test Names                                                                                                                                                                                                                                                                                         | Why It Breaks                                                                                              |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 14  | `packages/database/src/__tests__/model-connector-connection.test.ts` | "requires encryptedCredentials", "stores OAuth2 fields" (oauth2TokenExpiresAt, oauth2RefreshToken, oauth2Provider, scopes), "sets default fields on instantiation" (encryptedCredentials check)                                                                                                    | `encryptedCredentials`, `oauth2RefreshToken`, `oauth2Provider` fields are dropped from ConnectorConnection |
| 15  | `packages/connectors/src/__tests__/connection-resolver.test.ts`      | `makeConnection()` fixture uses `encryptedCredentials`, `encryptionKeyVersion`; "decrypts credentials using EncryptionService" test calls `resolver.decrypt(connection)` on `encryptedCredentials`; "triggers refresh for OAuth2 with expiring token" uses `oauth2RefreshToken`, `oauth2Provider`  | ConnectorConnection no longer carries inline auth fields — uses `authProfileId`                            |
| 16  | `packages/connectors/src/__tests__/connection-service.test.ts`       | "encrypts credentials when provided" (`encryptedCredentials` assertion), "stores empty string for credentials when none provided", "re-encrypts credentials on update", "list returns redacted summaries without encryptedCredentials", `completeOAuthSetup` tests (oauth2RefreshToken assertions) | `ConnectionService.create/update/completeOAuthSetup` signatures change — no more inline credentials        |
| 17  | `packages/project-io/src/__tests__/connections-assembler.test.ts`    | Connection export/import fixtures with `encryptedCredentials` and OAuth2 inline fields                                                                                                                                                                                                             | Serialization format changes — `authProfileId` replaces inline credentials                                 |

### 1.5 OAuth Service Tests

| #   | File                                                                              | Test Names                                                                                                                                                     | Why It Breaks                                                                                                      |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 18  | `apps/runtime/src/__tests__/tool-oauth-service.test.ts`                           | All 17+ tests: `ToolOAuthService` — `initiateOAuthFlow`, `handleOAuthCallback`, `getAccessToken`, `revokeToken`, `RedisOAuthStateStore`, multi-pod state store | `ToolOAuthService` is replaced by Auth Profile's unified OAuth flow (`/auth-profiles/oauth/initiate`, `/callback`) |
| 19  | `apps/runtime/src/services/channel-oauth/__tests__/channel-oauth-service.test.ts` | `ChannelOAuthService` — `initiateFlow`, `handleCallback`                                                                                                       | Channel OAuth merges into Auth Profile OAuth flow                                                                  |
| 20  | `apps/runtime/src/__tests__/channel-oauth-routes.test.ts`                         | Route tests for `POST /channel-oauth/:channelType/authorize`, `GET /channel-oauth/:channelType/callback`                                                       | Routes replaced by unified Auth Profile OAuth endpoints                                                            |

**Total: ~20 test files with ~130+ individual tests will break.**

---

## 2. Existing Tests That Need UPDATING (Not Broken, But Reference Changed APIs)

These tests mock credential services or set up connection fixtures with inline auth fields. They will not fail at import time but will need mock updates or fixture changes.

| #   | File                                                                                         | What Changes                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/runtime/src/__tests__/llm-wiring.test.ts`                                              | Mocks `mockGetToolOAuthService` — OAuthTokenResolver interface changes to use AuthProfileService.resolve()                        |
| 2   | `apps/runtime/src/__tests__/secrets-provider.test.ts`                                        | `OAuthTokenResolver` mock interface (`getAccessToken(tenantId, userId, provider)`) changes to `AuthProfileService.resolve({...})` |
| 3   | `packages/shared/src/__tests__/mcp-auth-resolver.test.ts`                                    | `McpAuthConfig` type union will gain new auth types and the implementation may change to delegate to AuthProfileService           |
| 4   | `apps/runtime/src/__tests__/connection-resolver-isolation.test.ts`                           | ConnectionResolver mocks with `encryptedCredentials` — needs `authProfileId` fixtures                                             |
| 5   | `apps/runtime/src/__tests__/inbound-worker.test.ts`                                          | Mocks ConnectionResolver for channel credential resolution — needs authProfileId path                                             |
| 6   | `apps/runtime/src/__tests__/webhooks/gupshup-webhook-route.test.ts`                          | ConnectionResolver mock with inline credentials                                                                                   |
| 7   | `apps/runtime/src/__tests__/webhooks/channel-webhooks-route.test.ts`                         | ConnectionResolver mock with inline credentials                                                                                   |
| 8   | `apps/runtime/src/__tests__/webhooks/infobip-webhook-route.test.ts`                          | ConnectionResolver mock with inline credentials                                                                                   |
| 9   | `apps/runtime/src/__tests__/webhooks/channel-webhooks-twilio-route.test.ts`                  | ConnectionResolver mock with inline credentials                                                                                   |
| 10  | `apps/runtime/src/__tests__/slack-slash-commands.test.ts`                                    | ConnectionResolver mock                                                                                                           |
| 11  | `apps/runtime/src/__tests__/slack-interactive-parsing.test.ts`                               | ConnectionResolver mock                                                                                                           |
| 12  | `apps/runtime/src/__tests__/email/email-smtp-server.test.ts`                                 | ConnectionResolver mock for email transport                                                                                       |
| 13  | `apps/runtime/src/__tests__/email/resolve-transport.test.ts`                                 | Email transport credential resolution                                                                                             |
| 14  | `apps/runtime/src/__tests__/email/graph-transport.test.ts`                                   | OAuth2 credential mock for Microsoft Graph                                                                                        |
| 15  | `apps/runtime/src/__tests__/tenant-model-routes.test.ts`                                     | Connection sub-routes mock `credentialId` in fixtures — changes to `authProfileId`                                                |
| 16  | `apps/runtime/src/__tests__/tenant-models-authz.test.ts`                                     | Same — `credentialId` in connection fixtures                                                                                      |
| 17  | `apps/runtime/src/routes/__tests__/platform-admin-models.test.ts`                            | `credentialId` in model connection fixtures                                                                                       |
| 18  | `apps/studio/src/__tests__/model-management.test.tsx`                                        | UI test with `credentialId` in model/connection mocks                                                                             |
| 19  | `apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts`                               | Channel adapter credential mocks                                                                                                  |
| 20  | `apps/runtime/src/__tests__/adapters/messenger-adapter.test.ts`                              | Channel adapter credential mocks                                                                                                  |
| 21  | `apps/runtime/src/__tests__/adapters/msteams-auth.test.ts`                                   | MS Teams auth credential mocks                                                                                                    |
| 22  | `apps/runtime/src/services/channel-oauth/providers/__tests__/slack-oauth-provider.test.ts`   | Slack OAuth provider — credential format changes                                                                                  |
| 23  | `apps/runtime/src/services/channel-oauth/providers/__tests__/meta-oauth-provider.test.ts`    | Meta OAuth provider — credential format changes                                                                                   |
| 24  | `apps/runtime/src/services/channel-oauth/providers/__tests__/msteams-oauth-provider.test.ts` | MS Teams OAuth provider — credential format changes                                                                               |
| 25  | `packages/compiler/src/__tests__/ir/auth-config-builder.test.ts`                             | `buildAuthConfigFromAST` may need new auth types for `auth: "profile-name"` DSL syntax                                            |
| 26  | `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`                      | HTTP tool auth resolution may change to use AuthProfile                                                                           |
| 27  | `apps/search-ai/src/__tests__/llm-config-api.test.ts`                                        | LLM config API response shape changes (credentialId -> authProfileId)                                                             |
| 28  | `apps/search-ai/src/__tests__/per-index-config-integration.test.ts`                          | LLM credential resolution chain changes                                                                                           |
| 29  | `apps/workflow-engine/src/__tests__/connections-routes.test.ts`                              | Connection CRUD routes — field changes                                                                                            |
| 30  | `apps/workflow-engine/src/__tests__/connectors-routes.test.ts`                               | Connector auth config changes                                                                                                     |
| 31  | `packages/project-io/src/__tests__/channels-assembler.test.ts`                               | Channel connection export fixtures with encryptedCredentials                                                                      |
| 32  | `packages/project-io/src/__tests__/export-import-roundtrip.test.ts`                          | Round-trip serialization of connections with auth fields                                                                          |
| 33  | `packages/connectors/sharepoint/src/__tests__/integration/oauth-flow.integration.test.ts`    | SharePoint OAuth flow — credential storage changes                                                                                |
| 34  | `packages/connectors/sharepoint/src/__tests__/microsoft-oauth-provider.test.ts`              | Microsoft OAuth provider — token storage                                                                                          |
| 35  | `packages/connectors/base/src/__tests__/token-manager.test.ts.skip`                          | Token manager — already skipped but needs AuthProfile integration                                                                 |
| 36  | `packages/connectors/base/src/__tests__/device-code-flow.test.ts`                            | Device code flow — token storage changes                                                                                          |
| 37  | `packages/database/src/__tests__/mongo-cascade.test.ts`                                      | Cascade delete tests that may reference LLMCredential/EndUserOAuthToken                                                           |
| 38  | `apps/studio/src/__tests__/security-services.test.ts`                                        | Studio security service mocks for tool secrets                                                                                    |
| 39  | `apps/studio/src/__tests__/tool-test-service.test.ts`                                        | Tool test service that resolves secrets                                                                                           |
| 40  | `apps/studio/src/components/tools/__tests__/HttpConfigForm.test.ts`                          | HTTP tool config form — auth type options may change                                                                              |

**Total: ~40 test files need mock/fixture updates.**

---

## 3. NEW Tests Needed

### 3.1 Unit Tests — P0 (Must Have Before Merge)

#### 3.1.1 AuthProfile Model Validation

| Test Case                                                    | Input                                                                                   | Expected            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------- |
| Valid `api_key` profile with all required fields             | `{ authType: 'api_key', config: { headerName: 'X-API-Key' }, encryptedSecrets: '...' }` | Passes validation   |
| Missing `headerName` for `api_key`                           | `{ authType: 'api_key', config: {} }`                                                   | Validation error    |
| Valid `bearer` profile                                       | `{ authType: 'bearer' }` with `encryptedSecrets` containing `token`                     | Passes              |
| Valid `basic` profile                                        | Config empty, secrets with `username` + `password`                                      | Passes              |
| Valid `oauth2_app` profile                                   | Config with `authorizationUrl` + `tokenUrl`, secrets with `clientId` + `clientSecret`   | Passes              |
| Missing `tokenUrl` for `oauth2_app`                          | Config without `tokenUrl`                                                               | Validation error    |
| Valid `oauth2_token` profile                                 | Config with `provider`, secrets with `accessToken`                                      | Passes              |
| Valid `oauth2_client_credentials`                            | Config with `tokenUrl`, secrets with `clientId` + `clientSecret`                        | Passes              |
| Valid `custom_header` profile                                | Config with header names, secrets with header values                                    | Passes              |
| Valid `aws_iam` profile                                      | Config with `region`, secrets with `accessKeyId` + `secretAccessKey`                    | Passes              |
| Valid `azure_ad` profile                                     | Config with `tenantId` + `resource`, secrets with `clientId` + `clientSecret`           | Passes              |
| Invalid `authType` enum value                                | `{ authType: 'invalid_type' }`                                                          | Validation error    |
| Valid `scope` enum                                           | `'tenant'`, `'project'`                                                                 | Passes              |
| Invalid `scope` enum                                         | `'global'`                                                                              | Validation error    |
| Valid `visibility` enum                                      | `'shared'`, `'personal'`                                                                | Passes              |
| Invalid `visibility` enum                                    | `'private'`                                                                             | Validation error    |
| Valid `status` enum                                          | `'active'`, `'expired'`, `'revoked'`, `'invalid'`                                       | Passes              |
| Required fields: `tenantId`, `name`, `authType`, `createdBy` | Missing each individually                                                               | Validation error    |
| Unique constraint: `tenantId` + `projectId` + `name`         | Duplicate creation                                                                      | Duplicate key error |
| `linkedAppProfileId` on `oauth2_token`                       | Valid link to `oauth2_app`                                                              | Passes              |

**File:** `packages/database/src/__tests__/model-auth-profile.test.ts`

#### 3.1.2 AuthProfile Encryption

| Test Case                                 | Input                         | Expected                                           |
| ----------------------------------------- | ----------------------------- | -------------------------------------------------- |
| Encrypt secrets on save, decrypt on read  | Create with plaintext secrets | Raw DB has ciphertext, Mongoose read has plaintext |
| `encryptedSecrets` field uses AES-256-GCM | Raw document inspection       | `ire: 'v3'` present                                |
| `toJSON()` strips encryption metadata     | Call `.toJSON()`              | No `ire`, `cek`, `iv` fields                       |
| Secrets field redacted in list responses  | Service list method           | `encryptedSecrets` not in response                 |
| Key version tracking                      | Save with version 1           | `encryptionKeyVersion: 1`                          |

**File:** `packages/database/src/__tests__/encryption-e2e.test.ts` (extend existing)

#### 3.1.3 AuthProfile Resolution Priority

| Test Case                                       | Input                                 | Expected                |
| ----------------------------------------------- | ------------------------------------- | ----------------------- |
| Personal `oauth2_token` for user takes priority | Personal + shared tokens exist        | Personal token returned |
| Shared `oauth2_token` returned when no personal | Only shared token                     | Shared token returned   |
| Project-level overrides tenant-level            | Both exist with same connector        | Project-level returned  |
| Tenant-level used as fallback                   | Only tenant-level exists              | Tenant-level returned   |
| Resolution by connector name + authType         | Multiple profiles, query by connector | Correct profile matched |
| `null` returned when nothing matches            | Empty DB                              | `null` or error         |

**File:** `apps/runtime/src/__tests__/services/auth-profile-resolver.test.ts`

#### 3.1.4 Per-AuthType Secret Validation

| Test Case                                                            | Input                 | Expected         |
| -------------------------------------------------------------------- | --------------------- | ---------------- |
| `api_key` requires `apiKey` in secrets                               | Missing `apiKey`      | Validation error |
| `bearer` requires `token` in secrets                                 | Missing `token`       | Validation error |
| `basic` requires `username` + `password`                             | Missing either        | Validation error |
| `oauth2_app` requires `clientId` + `clientSecret`                    | Missing either        | Validation error |
| `oauth2_token` requires `accessToken`                                | Missing `accessToken` | Validation error |
| `aws_iam` requires `accessKeyId` + `secretAccessKey`                 | Missing either        | Validation error |
| `kerberos` requires `keytab` or `password`                           | Neither present       | Validation error |
| `saml` requires `idpCertificate`                                     | Missing               | Validation error |
| `ssh_key` requires `privateKey`                                      | Missing               | Validation error |
| `mtls` requires `clientCert` + `clientKey`                           | Missing either        | Validation error |
| `ws_security` mode `username_token` requires `username` + `password` | Missing either        | Validation error |

**File:** `packages/shared/src/__tests__/auth-profile-validation.test.ts`

### 3.2 Unit Tests — P1 (Should Have)

#### 3.2.1 Token Refresh Logic

| Test Case                                                 | Input                                 | Expected                                         |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Refresh when access token expired (60s buffer)            | `expiresAt` in 30s                    | Triggers refresh                                 |
| No refresh when access token is fresh                     | `expiresAt` in 1h                     | Returns existing token                           |
| Refresh loads `linkedAppProfileId` for client credentials | `oauth2_token` linked to `oauth2_app` | Fetches client credentials from linked profile   |
| Refresh stores new tokens atomically                      | Successful refresh                    | `encryptedSecrets` updated with new access token |
| Refresh rotation: stores new refresh token                | `refreshTokenRotation: true`          | New refresh token stored                         |
| Distributed lock prevents concurrent refresh              | Two simultaneous refresh calls        | Only one HTTP call made                          |
| Refresh failure sets status to `expired`                  | Token endpoint returns 401            | `status: 'expired'`                              |

**File:** `apps/runtime/src/__tests__/services/auth-profile-token-refresh.test.ts`

#### 3.2.2 Pre-flight Auth Requirement Extraction (Compiler)

| Test Case                                       | Input                                               | Expected                  |
| ----------------------------------------------- | --------------------------------------------------- | ------------------------- |
| `per_user` + `preflight` bubbles to entry point | DSL with `connection: per_user, consent: preflight` | `authRequirements` in IR  |
| `per_user` + `inline` bubbles as optional       | DSL with `consent: inline`                          | Optional auth requirement |
| `shared` does not bubble                        | DSL with `connection: shared`                       | No auth requirement       |
| Nested agent -> workflow collects requirements  | Agent calls workflow with per_user tools            | Union of requirements     |
| Duplicate connectors union scopes               | Gmail in agent needs `send`, workflow needs `read`  | Combined scopes           |

**File:** `packages/compiler/src/__tests__/ir/auth-requirements-propagation.test.ts`

#### 3.2.3 Consumer Linking Validation

| Test Case                                                                                    | Input                    | Expected                                |
| -------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------- |
| LLM Provider accepts `api_key`, `azure_ad`, `aws_iam`, `oauth2_client_credentials`           | Link with matching type  | Succeeds                                |
| LLM Provider rejects `ssh_key`                                                               | Link with `ssh_key` type | Validation error: incompatible authType |
| MCP Server accepts `api_key`, `bearer`, `custom_header`, `oauth2_client_credentials`, `none` | Matching types           | Succeeds                                |
| Connector Connection (Layer 2) accepts `oauth2_token`, `api_key`, `bearer`, `basic`          | Matching types           | Succeeds                                |
| Channel Connection rejects `kerberos`                                                        | Incompatible link        | Validation error                        |

**File:** `packages/shared/src/__tests__/auth-profile-consumer-validation.test.ts`

### 3.3 Integration Tests — P0 (Must Have Before Merge)

#### 3.3.1 Auth Profile CRUD Operations

| Test Case                                  | HTTP                                    | Expected                                               |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------------ |
| Create tenant-level profile                | `POST /api/auth-profiles`               | 201, profile returned with redacted secrets            |
| Create project-level profile               | `POST /api/projects/:pid/auth-profiles` | 201, `projectId` set                                   |
| List tenant-level profiles                 | `GET /api/auth-profiles`                | 200, array of profiles                                 |
| List project-level (merged with inherited) | `GET /api/projects/:pid/auth-profiles`  | 200, project + tenant profiles, `inherited: true` flag |
| Get single profile (redacted secrets)      | `GET /api/auth-profiles/:id`            | 200, no `encryptedSecrets` in response                 |
| Update profile                             | `PUT /api/auth-profiles/:id`            | 200, updated fields                                    |
| Delete profile                             | `DELETE /api/auth-profiles/:id`         | 200 or 204                                             |
| Validate profile credentials               | `POST /api/auth-profiles/:id/validate`  | 200, `{ success: true/false }`                         |
| Duplicate name in same scope               | `POST` with existing name               | 409 Conflict                                           |
| Filter by authType                         | `GET ?authType=oauth2_app`              | Filtered results                                       |
| Filter by connector                        | `GET ?connector=gmail`                  | Filtered results                                       |

**File:** `apps/runtime/src/__tests__/auth-profile-crud.test.ts`

#### 3.3.2 Auth Profile Tenant Isolation (Security — P0)

| Test Case                                               | Input                                   | Expected                 |
| ------------------------------------------------------- | --------------------------------------- | ------------------------ |
| Cross-tenant GET returns 404                            | Tenant A profile, tenant B request      | 404 (not 403)            |
| Cross-tenant UPDATE returns 404                         | Tenant A profile, tenant B request      | 404                      |
| Cross-tenant DELETE returns 404                         | Tenant A profile, tenant B request      | 404                      |
| Cross-project GET returns 404                           | Project A profile, project B request    | 404                      |
| Personal profile hidden from other users                | User A personal profile, user B request | Not in list results      |
| Shared profile visible to all users in scope            | Shared profile                          | Visible to all           |
| `findOne({ _id, tenantId })` pattern (never `findById`) | All queries                             | tenantId always in query |

**File:** `apps/runtime/src/__tests__/auth-profile-authz.test.ts`

#### 3.3.3 Auth Profile Permission Checks (Security — P0)

| Test Case                           | Role              | Expected                      |
| ----------------------------------- | ----------------- | ----------------------------- |
| OWNER can create/read/update/delete | `*:*`             | All pass                      |
| ADMIN can create/read/update/delete | `credential:*`    | All pass                      |
| OPERATOR can only read              | `credential:read` | GET pass, POST/PUT/DELETE 403 |
| MEMBER can only read                | `credential:read` | GET pass, POST/PUT/DELETE 403 |
| VIEWER can only read                | `credential:read` | GET pass, POST/PUT/DELETE 403 |
| Unauthenticated                     | No token          | 401 on all endpoints          |

**File:** `apps/runtime/src/__tests__/auth-profile-authz.test.ts` (combined with isolation)

### 3.4 Integration Tests — P1 (Should Have)

#### 3.4.1 OAuth Initiate / Callback

| Test Case                           | HTTP                                                   | Expected                                    |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| Initiate OAuth flow                 | `POST /api/projects/:pid/auth-profiles/oauth/initiate` | `{ authUrl, state }`                        |
| Callback exchanges code for token   | `POST /api/projects/:pid/auth-profiles/oauth/callback` | Creates `oauth2_token` Auth Profile         |
| Callback links token to app profile | Valid state + code                                     | `linkedAppProfileId` set on created profile |
| Invalid state rejected              | Bad state parameter                                    | 400 error                                   |
| Expired state rejected              | State older than 10 min                                | 400 error                                   |
| State consumed only once            | Double callback                                        | Second call fails                           |
| End-user consent flow               | `POST .../oauth/user-consent`                          | Creates personal `oauth2_token`             |

**File:** `apps/runtime/src/__tests__/auth-profile-oauth-flows.test.ts`

#### 3.4.2 Runtime Token Resolution

| Test Case                                       | Input                                     | Expected                                                  |
| ----------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Resolve `api_key` for LLM provider              | LLM connection with `authProfileId`       | Decrypted API key returned                                |
| Resolve `oauth2_token` for connector            | Connector connection with `authProfileId` | Decrypted access token returned                           |
| Resolve personal token for per_user tool        | User-scoped oauth2_token                  | User's token returned                                     |
| Resolve shared token for shared tool            | Shared oauth2_token                       | Developer's token returned                                |
| Token refresh triggered on expired access token | Expired `oauth2_token`                    | New access token fetched and stored                       |
| Resolution failure returns meaningful error     | Auth profile not found                    | "Auth profile 'X' not found. Reconfigure authentication." |

**File:** `apps/runtime/src/__tests__/auth-profile-runtime-resolution.test.ts`

### 3.5 E2E Tests — P2 (Nice to Have)

#### 3.5.1 Full OAuth Flow Through Auth Profile

| Test Case                                                                                                | Flow            | Expected                                       |
| -------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------- |
| Admin creates `oauth2_app` -> user authorizes -> `oauth2_token` created -> runtime resolves token        | Full end-to-end | Token available at runtime                     |
| Pre-flight consent: agent requires Gmail -> session start blocked -> user authorizes -> session proceeds | Pre-flight flow | `auth_required` -> authorize -> session starts |
| Inline consent: agent mid-conversation needs Calendar -> prompts user -> creates token                   | Inline flow     | Tool available after consent                   |

**File:** `apps/runtime/src/__tests__/e2e/auth-profile-oauth-e2e.test.ts`

#### 3.5.2 Connector Setup Flow

| Test Case                                                                     | Flow         | Expected                                 |
| ----------------------------------------------------------------------------- | ------------ | ---------------------------------------- |
| Create OAuth connector: app credentials -> authorize -> connection active     | Setup wizard | Both profiles created, connection active |
| Create API key connector: single form -> profile created -> connection active | Simple setup | Profile created with `api_key` type      |

#### 3.5.3 Error Handling E2E

| Test Case                                           | Scenario                                     | Expected                                                       |
| --------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| Dangling `authProfileId` on connector               | Delete auth profile, then use connector      | "Auth profile not found. Reconfigure authentication."          |
| Token expired, refresh fails                        | OAuth token expired, refresh endpoint down   | Status `expired`, runtime returns re-authorize prompt          |
| Blocked deletion of `oauth2_app` with active tokens | Try to delete app profile with linked tokens | 409: "Cannot delete — N active connections use this OAuth app" |

### 3.6 Addon Mechanism Tests — P2

| Test Case                               | Auth Type + Addon              | Expected                          |
| --------------------------------------- | ------------------------------ | --------------------------------- |
| `api_key` + `signing` (HMAC)            | Request signing applied        | Signed headers present            |
| `bearer` + `jwtWrapping`                | JWT generated from private key | Valid JWT in Authorization header |
| Any type + `proxy`                      | Proxy config applied           | Request routed through proxy      |
| `webhookVerification` validates inbound | Signed webhook payload         | Verification passes               |
| `certificatePinning` in strict mode     | Wrong certificate              | Connection rejected               |

**File:** `apps/runtime/src/__tests__/auth-profile-addons.test.ts`

---

## 4. Test Infrastructure

### 4.1 Current Auth Test Patterns

The codebase uses consistent patterns for auth/credential testing:

**Mock Pattern (unit tests):**

```typescript
vi.mock('@agent-platform/database/models', () => ({
  ToolSecret: { find: vi.fn(), findOne: vi.fn(), create: vi.fn(), ... },
  LLMCredential: { find: vi.fn(), findOne: vi.fn() },
  EndUserOAuthToken: { find: vi.fn(), countDocuments: vi.fn() },
}));
```

**Encryption Mock:**

```typescript
vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
    encryptJsonForTenant: vi.fn(() => 'encrypted'),
    decryptJsonForTenant: vi.fn(() => ({})),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));
```

**Route Authz Pattern (Express integration):**

```typescript
async function createServerForRole(role) {
  const app = express();
  app.use(express.json());
  const ctx = makeTenantContext('tenant-A', 'user-1', role);
  app.use(injectTenantContext(ctx));
  const router = (await import('../routes/auth-profiles.js')).default;
  app.use('/api/auth-profiles', router);
  // http.createServer + listen on port 0
}
```

**MongoMemoryServer (integration):**

- `packages/database/src/__tests__/helpers/setup-mongo.ts` — shared setup/teardown
- Used by model tests and encryption e2e tests

### 4.2 Test Database Setup

- **MongoMemoryServer**: Used in `packages/database` for model validation and encryption e2e
- **Dynamic imports**: `apps/runtime/src/__tests__/repos-data.test.ts` uses lazy model imports to avoid auto-connect
- **Encryption setup**: `setMasterKey('a'.repeat(64))` + `setTenantEncryption(...)` in beforeAll

### 4.3 New Test Utilities Needed

| Utility                            | Purpose                                                   | Location                                                          |
| ---------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| `makeAuthProfile(overrides)`       | Factory for AuthProfile test fixtures                     | `packages/database/src/__tests__/helpers/fixtures.ts`             |
| `makeAuthProfileFixture(authType)` | Per-type fixture with valid config + secrets              | Same                                                              |
| `mockAuthProfileService()`         | Mock AuthProfileService for route tests                   | `apps/runtime/src/__tests__/helpers/auth-profile-mock.ts`         |
| `mockAuthProfileRepo()`            | Mock repository layer                                     | `packages/shared/src/__tests__/helpers/auth-profile-repo-mock.ts` |
| `createTestOAuth2AppProfile()`     | Creates a valid `oauth2_app` profile for OAuth flow tests | `apps/runtime/src/__tests__/helpers/oauth-fixtures.ts`            |
| `createTestOAuth2TokenProfile()`   | Creates a valid `oauth2_token` profile linked to app      | Same                                                              |
| `mockTokenRefresh()`               | Mocks the fetch call for token refresh                    | Same                                                              |

### 4.4 Encryption Plugin Mock Pattern

For unit tests that need AuthProfile without real encryption:

```typescript
function mockAuthProfileEncryption() {
  return {
    encryptSecrets: vi.fn(
      (secrets: Record<string, string>, tenantId: string) =>
        `enc:${tenantId}:${JSON.stringify(secrets)}`,
    ),
    decryptSecrets: vi.fn((encrypted: string, _tenantId: string) => {
      const parts = encrypted.split(':');
      return JSON.parse(parts.slice(2).join(':'));
    }),
  };
}
```

---

## 5. Test Priority Matrix

### P0 — Must Have Before Merge (Blocks release)

| Category                                                   | Test Count (est.) | Files                             |
| ---------------------------------------------------------- | ----------------- | --------------------------------- |
| AuthProfile model validation (all 17 types)                | ~30               | `model-auth-profile.test.ts`      |
| AuthProfile encryption round-trip                          | ~8                | `encryption-e2e.test.ts` (extend) |
| AuthProfile CRUD route integration                         | ~15               | `auth-profile-crud.test.ts`       |
| Tenant isolation (cross-tenant 404)                        | ~10               | `auth-profile-authz.test.ts`      |
| Permission checks (RBAC per role)                          | ~24               | `auth-profile-authz.test.ts`      |
| Resolution priority (personal > shared > project > tenant) | ~8                | `auth-profile-resolver.test.ts`   |
| Per-authType secret validation                             | ~15               | `auth-profile-validation.test.ts` |
| **Subtotal**                                               | **~110**          | **6 files**                       |

### P1 — Should Have (Before GA)

| Category                                          | Test Count (est.) | Files                                      |
| ------------------------------------------------- | ----------------- | ------------------------------------------ |
| OAuth initiate/callback flows                     | ~10               | `auth-profile-oauth-flows.test.ts`         |
| Token refresh logic                               | ~10               | `auth-profile-token-refresh.test.ts`       |
| Runtime token resolution                          | ~8                | `auth-profile-runtime-resolution.test.ts`  |
| Pre-flight auth requirement extraction (compiler) | ~8                | `auth-requirements-propagation.test.ts`    |
| Consumer linking validation                       | ~10               | `auth-profile-consumer-validation.test.ts` |
| Update all broken tests (~20 files, ~130 tests)   | ~130              | Various existing files                     |
| Update mock/fixture tests (~40 files)             | ~40               | Various existing files                     |
| **Subtotal**                                      | **~216**          | **~65 files**                              |

### P2 — Nice to Have (Post-GA)

| Category                                                             | Test Count (est.) | Files                                 |
| -------------------------------------------------------------------- | ----------------- | ------------------------------------- |
| Addon mechanisms (signing, JWT, webhook, pinning, proxy)             | ~15               | `auth-profile-addons.test.ts`         |
| Enterprise auth types (kerberos, SAML, Hawk, WS-Security)            | ~12               | `model-auth-profile.test.ts` (extend) |
| Infrastructure types (SSH key, mTLS)                                 | ~6                | `model-auth-profile.test.ts` (extend) |
| E2E OAuth flow (admin setup -> user consent -> runtime)              | ~5                | `auth-profile-oauth-e2e.test.ts`      |
| E2E error handling (dangling refs, expired tokens, blocked deletion) | ~5                | `auth-profile-errors-e2e.test.ts`     |
| Key rotation (grace period, previous secrets)                        | ~5                | `auth-profile-rotation.test.ts`       |
| **Subtotal**                                                         | **~48**           | **~6 files**                          |

### Grand Total

| Priority  | Tests    | New Files | Existing Files Modified |
| --------- | -------- | --------- | ----------------------- |
| P0        | ~110     | 6         | 0                       |
| P1        | ~216     | 5         | ~65                     |
| P2        | ~48      | 6         | 0                       |
| **Total** | **~374** | **17**    | **~65**                 |

---

## 6. Migration Order for Tests

To avoid a "big bang" where all tests break simultaneously:

1. **Phase 1: Create AuthProfile model + tests** (P0 new tests only) — no existing code changes
2. **Phase 2: Create AuthProfileService + resolver + tests** (P0 + P1 new tests)
3. **Phase 3: Wire consumers to use authProfileId** — update existing tests that reference inline auth fields, one consumer at a time:
   - 3a. LLM Provider connections (`credentialId` -> `authProfileId`)
   - 3b. Connector connections (`encryptedCredentials` -> `authProfileId`)
   - 3c. OAuth flows (ToolOAuthService -> AuthProfile OAuth)
   - 3d. Channel OAuth (ChannelOAuthService -> AuthProfile OAuth)
   - 3e. MCP Server, Service Node, Channel Connection, Guardrail Provider
4. **Phase 4: Delete old models** — only after all consumers migrated. Remove `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` models and their dedicated tests
5. **Phase 5: Addon mechanisms and enterprise types** (P2)

Each phase should leave all tests green. The deleted model tests from Phase 4 are replaced by the AuthProfile model tests from Phase 1.
