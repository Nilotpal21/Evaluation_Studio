# Auth Profile Redundancy Analysis

> Produced 2026-03-11. Companion to `2026-03-11-auth-profile-design.md`.

---

## 1. Duplicate OAuth Implementations

The codebase contains **four independent OAuth flow implementations**, each with its own state management, code exchange, and token storage.

### 1A. Studio Connection OAuth (Connector OAuth)

| Item          | Path                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Utilities     | `apps/studio/src/lib/connector-oauth.ts` (191 LOC)                                               |
| Initiate      | `apps/studio/src/app/api/projects/[id]/connections/oauth/initiate/route.ts` (47 LOC)             |
| Callback      | `apps/studio/src/app/api/projects/[id]/connections/oauth/callback/route.ts` (119 LOC)            |
| Storage layer | `apps/studio/src/lib/connection-service.ts` (62 LOC) — wires `ConnectionService` with encryption |

**Flow:** Studio frontend calls initiate route -> in-memory `Map<string, PendingOAuthState>` stores state -> user redirected to IdP -> callback route exchanges code via `fetch()` -> `ConnectionService.create()` + `completeOAuthSetup()` stores encrypted tokens in `ConnectorConnection`.

**Key characteristics:**

- In-memory state store (single-pod, no TTL cleanup timer, MAX 1000 entries)
- Provider credentials from env vars: `OAUTH_PROVIDER_<PROVIDER>_CLIENT_ID/SECRET`
- Static `CONNECTOR_TO_PROVIDER` mapping (13 connectors -> 8 providers)
- Token exchange is raw `fetch()` to token URL
- No token refresh logic — tokens stored and used as-is

### 1B. Runtime Tool OAuth (End-User OAuth)

| Item          | Path                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| Service       | `apps/runtime/src/services/tool-oauth-service.ts` (556 LOC)                |
| Routes        | `apps/runtime/src/routes/oauth.ts` (406 LOC)                               |
| State storage | `InMemoryOAuthStateStore` or `RedisOAuthStateStore` (both in service file) |
| Token storage | `OAuthTokenStore` interface — pluggable, uses `EndUserOAuthToken` in Mongo |

**Flow:** Studio frontend calls `/api/v1/oauth/authorize/:provider` -> state in Redis or in-memory -> user redirected to IdP -> callback exchanges code -> tokens encrypted with `encryptor.encryptForTenant()` -> stored via `OAuthTokenStore.upsertToken()`.

**Key characteristics:**

- Redis-backed state store for multi-pod (with in-memory fallback)
- Provider credentials from env vars (same convention, scanned dynamically)
- Full token lifecycle: initiate, callback, getAccessToken (with auto-refresh), revoke
- Tenant-scoped encryption via `OAuthEncryptor` interface
- 60s expiry buffer for refresh
- Token listing and pagination endpoints

### 1C. Channel OAuth

| Item          | Path                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| Service       | `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts` (118 LOC)                               |
| Provider intf | `apps/runtime/src/services/channel-oauth/channel-oauth-provider.ts` (33 LOC)                               |
| Providers     | `providers/meta-oauth-provider.ts` (148), `slack-oauth-provider.ts` (91), `msteams-oauth-provider.ts` (89) |
| Routes        | `apps/runtime/src/routes/channel-oauth.ts` (267 LOC)                                                       |
| Studio client | `apps/studio/src/api/channel-oauth.ts` (73 LOC)                                                            |
| **Total**     | **905 LOC**                                                                                                |

**Flow:** Studio calls `/api/v1/channel-oauth/:channelType/authorize` -> reuses `OAuthStateStore` from Tool OAuth -> state stored in Redis/memory -> user redirected -> callback exchanges code via provider adapter -> returns credentials for `ChannelConnection` creation.

**Key characteristics:**

- Reuses `OAuthStateStore` from Tool OAuth (good)
- But does NOT reuse any other logic — separate service, routes, validation
- Provider-specific adapters (`ChannelOAuthProvider` interface) vs. generic approach
- No token refresh — channels get long-lived tokens or manage refresh themselves

### 1D. Connector Connection Resolver (Runtime OAuth Refresh)

| Item    | Path                                                            |
| ------- | --------------------------------------------------------------- |
| Service | `packages/connectors/src/auth/connection-resolver.ts` (259 LOC) |

**Flow:** At runtime, when a connector needs credentials -> `ConnectionResolver.resolveAuth()` checks `oauth2TokenExpiresAt` -> if expired, acquires distributed lock via `LockManagerLike` -> refreshes via `fetch()` to token URL -> updates encrypted tokens in DB.

**Key characteristics:**

- Distributed lock for concurrent refresh protection
- Provider credentials from env: `OAUTH2_CLIENT_ID_<PROVIDER>` / `OAUTH2_CLIENT_SECRET_<PROVIDER>` (different convention!)
- Uses `getProviderConfig()` for token URLs
- Marks connection as "expired" on refresh failure
- 60s refresh buffer, 30s lock TTL

### 1E. Connector Token Manager (SearchAI End-User OAuth)

| Item    | Path                                                           |
| ------- | -------------------------------------------------------------- |
| Service | `packages/connectors/base/src/auth/token-manager.ts` (215 LOC) |

**Flow:** `TokenManager.getAccessToken()` -> loads token from `EndUserOAuthToken` -> checks expiry via `provider.needsRefresh()` -> refreshes via `IOAuthProvider.refreshToken()` -> saves updated token.

**Key characteristics:**

- 5-minute refresh buffer
- Delegates to `IOAuthProvider` interface for provider-specific refresh
- No distributed lock — relies on single-caller pattern
- Stores tokens in `EndUserOAuthToken` model (same as Tool OAuth)

### 1F. Agent Transfer OAuth2 Client

| Item    | Path                                                                  |
| ------- | --------------------------------------------------------------------- |
| Service | `packages/agent-transfer/src/adapters/auth/oauth2-client.ts` (56 LOC) |

**Flow:** Client credentials grant only — `fetchToken()` calls token URL with `grant_type=client_credentials`.

**Key characteristics:**

- Simplest implementation — no refresh token, no user auth
- SSRF protection via `assertAllowedUrl`
- Returns `AuthCredentials` with expiration

### 1G. HTTP Tool Executor OAuth (Compiler)

| Item    | Path                                                                                         |
| ------- | -------------------------------------------------------------------------------------------- |
| Service | `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` (1346 LOC total) |

The `applyAuth()` method handles `oauth2_client` (client credentials) and `oauth2_user` (end-user token via `secrets.getUserOAuthToken()`).

**Key characteristics:**

- In-memory `TokenCache` for client credential tokens
- `oauth2_user` delegates to `SecretsProvider.getUserOAuthToken()`
- Has its own `getOAuthToken()` with bounded cache

---

### OAuth Comparison Matrix

| Feature                 | Studio Connector    | Tool OAuth (Runtime) | Channel OAuth         | Connection Resolver   | Token Manager        | Agent Transfer |
| ----------------------- | ------------------- | -------------------- | --------------------- | --------------------- | -------------------- | -------------- |
| Grant type              | Auth code           | Auth code            | Auth code             | Refresh only          | Refresh only         | Client creds   |
| State store             | In-memory Map       | Redis / In-memory    | Reuses Tool OAuth     | N/A                   | N/A                  | N/A            |
| Env var convention      | `OAUTH_PROVIDER_*`  | `OAUTH_PROVIDER_*`   | Per-provider hardcode | `OAUTH2_CLIENT_ID_*`  | N/A (IOAuthProvider) | Per-config     |
| Token storage           | ConnectorConnection | EndUserOAuthToken    | ChannelConnection     | ConnectorConnection   | EndUserOAuthToken    | In-memory      |
| Encryption              | ConnectionService   | OAuthEncryptor       | Provider-returned     | EncryptionServiceLike | Raw field storage    | None           |
| Token refresh           | None                | Yes (60s buffer)     | None                  | Yes (60s, dist lock)  | Yes (5min buffer)    | None           |
| Distributed lock        | No                  | No                   | No                    | Yes                   | No                   | No             |
| SSRF protection         | No                  | No                   | No                    | No                    | No                   | Yes            |
| Redirect URI validation | No                  | Yes (allowlist)      | Yes (allowlist)       | N/A                   | N/A                  | N/A            |

---

## 2. Duplicate Encryption Patterns

### 2A. Encryption Engine (`packages/shared/src/encryption/engine.ts`, 279 LOC)

The canonical `EncryptionService` class. AES-256-GCM with HKDF or PBKDF2 key derivation. Two scoping modes:

- **User-scoped:** `encrypt(plaintext, userId)` / `decrypt(encryptedData, userId)`
- **Tenant-scoped:** `encryptForTenant(plaintext, tenantId)` / `decryptForTenant(cipher, tenantId)`
- Also: `encryptJsonForTenant()` / `decryptJsonForTenant()` for JSON serialization

### 2B. Mongoose Encryption Plugin (`packages/database/src/mongo/plugins/encryption.plugin.ts`)

Field-level encryption in pre-save / post-find hooks. Uses its own master key (`setMasterKey()`) separate from the EncryptionService singleton. Supports v1 (master key wrapped CEK) and v2 (KMS-backed).

### 2C. Encryption Call Sites (105 files reference encryption)

Major patterns:

| Pattern                                         | Files      | Example                                                                     |
| ----------------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `getEncryptionService().encryptForTenant()`     | ~30        | `connection-service.ts`, `connection-resolver.ts`, `channel-connections.ts` |
| `getEncryptionService().decryptForTenant()`     | ~30        | Same files — symmetric encrypt/decrypt                                      |
| `getEncryptionService().decryptJsonForTenant()` | ~10        | `connection-resolver.ts` (channels)                                         |
| Mongoose plugin auto-encrypt/decrypt            | ~15 models | `LLMCredential.encryptedApiKey`, `encryptedEndpoint`                        |
| `OAuthEncryptor` interface                      | 1          | `tool-oauth-service.ts` (wraps EncryptionService)                           |
| `EncryptionServiceLike` interface               | 1          | `connectors/auth/connection-resolver.ts`                                    |
| `InlineMcpDecryptor` interface                  | 1          | `inline-mcp-provider.ts`                                                    |
| Manual AES in encryption plugin                 | 1          | `encryption.plugin.ts` (field-level)                                        |
| `EncryptedVault`                                | 1          | `compiler/platform/security/encrypted-vault.ts`                             |

**Finding:** Three decoupled encryption interfaces (`OAuthEncryptor`, `EncryptionServiceLike`, `InlineMcpDecryptor`) that all ultimately wrap the same `EncryptionService.encryptForTenant()` / `decryptForTenant()`. These interfaces exist for testability but create indirection.

---

## 3. Duplicate Credential Resolution

### 3A. LLM Credential Resolution — Runtime (`model-resolution.ts`, 1237 LOC)

5-level resolution chain: Deployment override -> Agent IR -> Agent DB -> Project DB -> Tenant Model. Resolves `TenantModel` -> `connections[].credentialId` -> `LLMCredential.encryptedApiKey` (auto-decrypted by Mongoose plugin).

### 3B. LLM Credential Resolution — SearchAI (`tenant-model-adapter.ts`, 345 LOC)

Mirrors 3A but simplified: `TenantModel.findOne({ tenantId, tier })` -> primary connection -> `LLMCredential.findOne()`. Same `TenantModel` + `LLMCredential` + Mongoose auto-decrypt pattern.

### 3C. LLM Credential Resolution — SearchAI-Runtime (`query-model-resolver.ts`, 154 LOC)

**Near-duplicate of 3B.** Same `resolveTenantModelById()`, `resolveTenantModelWithFallback()`, same fallback chains. Comment says "Mirrors the resolution logic from search-ai's tenant-model-adapter.ts".

### 3D. Embedding Credential Resolution (`embedding-credentials.ts`, 136 LOC)

`LLMCredential.findOne({ tenantId, provider, isActive })` with env-var fallback (`OPENAI_API_KEY`, `COHERE_API_KEY`). Only for embedding providers (openai, cohere).

### 3E. Connector Connection Credential Resolution

Two paths:

1. `packages/connectors/src/auth/connection-resolver.ts` — resolves `ConnectorConnection` with user/tenant scope priority, decrypts credentials, handles OAuth2 refresh
2. `apps/runtime/src/channels/connection-resolver.ts` — resolves `ChannelConnection` by type/identifier, decrypts credentials

### 3F. MCP Server Auth Resolution (`inline-mcp-provider.ts`)

Reads `mcp_binding.server_config` from IR (compile-time baked). Decrypts env vars via `InlineMcpDecryptor`. No DB lookup.

### 3G. HTTP Tool Auth Resolution (`http-tool-executor.ts`)

`applyAuth()` method handles 6 auth types: `api_key`, `bearer`, `oauth2_client`, `oauth2_user`, `custom`, `searchai`. Resolves secrets via `SecretsProvider`. OAuth2 client tokens cached in-memory.

### Credential Resolution Comparison

| System            | Storage Model         | Encryption Method                | Resolution Chain                          |
| ----------------- | --------------------- | -------------------------------- | ----------------------------------------- |
| LLM (Runtime)     | TenantModel + LLMCred | Mongoose plugin auto-decrypt     | 5-level (deploy->IR->agent->proj->tenant) |
| LLM (SearchAI)    | TenantModel + LLMCred | Mongoose plugin auto-decrypt     | Tier -> fallback chain                    |
| LLM (SearchAI-RT) | TenantModel + LLMCred | Mongoose plugin auto-decrypt     | Tier -> fallback chain (copy)             |
| Embedding         | LLMCredential         | Mongoose plugin auto-decrypt     | Provider+tenant -> env fallback           |
| Connector         | ConnectorConnection   | Manual encrypt/decrypt           | User-scope -> tenant-scope                |
| Channel           | ChannelConnection     | Manual encryptJsonForTenant      | Type+identifier lookup                    |
| MCP               | IR (compile-time)     | AES decrypt (InlineMcpDecryptor) | Direct from tool def                      |
| HTTP Tool         | Secrets provider      | SecretsProvider interface        | Auth type switch                          |
| Tool OAuth        | EndUserOAuthToken     | OAuthEncryptor interface         | Tenant+user+provider                      |

---

## 4. Duplicate Token Refresh Logic

### Comparison of All Token Refresh Implementations

| Feature          | Tool OAuth Service       | Connection Resolver                | Token Manager              |
| ---------------- | ------------------------ | ---------------------------------- | -------------------------- |
| File             | `tool-oauth-service.ts`  | `connection-resolver.ts`           | `token-manager.ts`         |
| LOC (refresh)    | ~60                      | ~100                               | ~40                        |
| Buffer           | 60 seconds               | 60 seconds                         | 5 minutes                  |
| Lock             | None                     | Distributed (Redis)                | None                       |
| Token URL source | `providerConfigs` Map    | `getProviderConfig()`              | `IOAuthProvider` interface |
| Client creds     | From provider config     | From env vars                      | From IOAuthProvider        |
| Rotation         | Keeps old if not rotated | Stores new if rotated              | Stores new if rotated      |
| Error handling   | Return undefined         | Mark connection "expired"          | Throw TokenManagerError    |
| Storage update   | `tokenStore.upsertToken` | `connectionModel.findOneAndUpdate` | `token.save()`             |

**Proposed unified refresh:**

```
UnifiedTokenRefresh:
  - Configurable buffer (default 60s)
  - Distributed lock support (optional, via LockManager)
  - Provider-agnostic: takes tokenUrl + clientId + clientSecret + refreshToken
  - Handles rotation (stores new refresh token if returned)
  - Error classification: EXPIRED (needs reauth), TRANSIENT (retry), REVOKED (mark dead)
  - Storage-agnostic: callback to persist updated tokens
```

---

## 5. Code That Can Be REUSED As-Is

### 5A. Encryption Utilities (REUSE)

- `packages/shared/src/encryption/engine.ts` — `EncryptionService` class is mature and production-proven
- `packages/shared/src/encryption/master-key-resolver.ts` — vault/env resolution
- `packages/database/src/mongo/plugins/encryption.plugin.ts` — field-level auto-encrypt
- **Action:** AuthProfile model should use the Mongoose encryption plugin for `encryptedCredentials` field (same pattern as `LLMCredential.encryptedApiKey`)

### 5B. OAuth Popup/Callback UI Patterns (REUSE)

- `apps/studio/src/app/api/projects/[id]/connections/oauth/` — route handler pattern with `withRouteHandler` + permissions
- Studio's `OAuthFlowDialog` component (popup + postMessage callback)
- **Action:** AuthProfile OAuth UI can reuse the popup dialog pattern

### 5C. Permission Middleware (REUSE)

- `withRouteHandler` (Studio) and `requirePermission` (Runtime) are stable
- **Action:** AuthProfile routes add new permissions (`auth_profile:read`, `auth_profile:write`) to existing middleware

### 5D. Route Handler Patterns (REUSE)

- OpenAPI router pattern from runtime (`createOpenAPIRouter` with Zod schemas)
- `withRouteHandler` from Studio
- Error envelope: `{ success: true/false, data/error: { code, message } }`

### 5E. Redis State Store (REUSE)

- `RedisOAuthStateStore` from `tool-oauth-service.ts` — production-grade with TTL, atomic getdel
- **Action:** Unified OAuth initiate should reuse this store implementation

### 5F. Distributed Lock Pattern (REUSE)

- `LockManagerLike` interface from `connection-resolver.ts` — for concurrent refresh protection
- **Action:** Unified token refresh should use this pattern

---

## 6. Code That Needs REWRITING

### 6A. All Credential Storage (REWRITE -> AuthProfile)

Currently credentials are scattered across 5 different MongoDB collections:

| Collection            | Credential Type         | Encrypted Fields                                |
| --------------------- | ----------------------- | ----------------------------------------------- |
| `LLMCredential`       | LLM API keys            | `encryptedApiKey`, `encryptedEndpoint`          |
| `ConnectorConnection` | Connector OAuth tokens  | `encryptedCredentials` (JSON blob)              |
| `ChannelConnection`   | Channel tokens/secrets  | `encryptedCredentials` (JSON blob)              |
| `EndUserOAuthToken`   | End-user OAuth tokens   | `encryptedAccessToken`, `encryptedRefreshToken` |
| Tool secrets          | API keys, bearer tokens | Via `SecretsProvider` (env/DB)                  |

**Rewrite:** All move to `AuthProfile` collection with `authType` discriminator.

### 6B. All Credential Resolution (REWRITE -> AuthProfileService)

The 9 resolution paths (Section 3) collapse to:

```
AuthProfileService.resolve(scope, context) -> decrypted credentials
  scope: { tenantId, projectId?, agentId?, userId? }
  context: { profileType, provider?, connectionId? }
```

### 6C. Token Refresh (REWRITE -> Unified)

Three refresh implementations (Section 4) collapse to one:

```
AuthProfileService.ensureFreshToken(profileId) -> decrypted access token
  - Checks expiry with configurable buffer
  - Acquires distributed lock if available
  - Calls token URL with client credentials
  - Handles rotation
  - Persists via AuthProfile model
```

### 6D. OAuth Initiate/Callback (REWRITE -> Unified Routes)

Four OAuth initiate/callback implementations (Section 1) collapse to:

```
POST /api/v1/auth-profiles/oauth/initiate
  body: { profileType, provider, scopes, redirectUri, projectId? }
  -> Unified state store (Redis)
  -> Returns authUrl + state

POST /api/v1/auth-profiles/oauth/callback
  body: { code, state }
  -> Exchanges code for tokens
  -> Creates AuthProfile with encrypted tokens
  -> Returns AuthProfile ID
```

### 6E. Env-Var Provider Config Loading (REWRITE)

Two different env-var conventions:

- `OAUTH_PROVIDER_<NAME>_CLIENT_ID/SECRET` (Tool OAuth, Connector OAuth)
- `OAUTH2_CLIENT_ID_<PROVIDER>` / `OAUTH2_CLIENT_SECRET_<PROVIDER>` (Connection Resolver)

**Rewrite:** Single convention, loaded once, shared via `AuthProfileOAuthRegistry`.

---

## 7. Lines of Code Impact

### Lines to DELETE (redundant implementations)

| File / Module                                                               | LOC        | Reason                              |
| --------------------------------------------------------------------------- | ---------- | ----------------------------------- |
| `apps/studio/src/lib/connector-oauth.ts`                                    | 191        | Replaced by unified OAuth           |
| `apps/studio/src/app/api/.../connections/oauth/initiate/route.ts`           | 47         | Replaced by AuthProfile OAuth route |
| `apps/studio/src/app/api/.../connections/oauth/callback/route.ts`           | 119        | Replaced by AuthProfile OAuth route |
| `apps/runtime/src/services/tool-oauth-service.ts` (partial)                 | ~300       | Initiate/callback/refresh logic     |
| `apps/runtime/src/routes/oauth.ts` (partial)                                | ~250       | Initiate/callback routes            |
| `apps/runtime/src/services/channel-oauth/` (entire directory)               | 905        | Replaced by unified OAuth           |
| `apps/runtime/src/routes/channel-oauth.ts`                                  | 267        | Replaced by unified OAuth route     |
| `apps/studio/src/api/channel-oauth.ts`                                      | 73         | Replaced by unified client          |
| `packages/connectors/base/src/auth/token-manager.ts`                        | 215        | Replaced by AuthProfile refresh     |
| `packages/connectors/src/auth/connection-resolver.ts` (refresh part)        | ~100       | Replaced by AuthProfile refresh     |
| `apps/search-ai-runtime/src/services/llm-config/query-model-resolver.ts`    | 154        | Replaced by shared resolution       |
| `apps/search-ai/src/services/llm-config/tenant-model-adapter.ts` (partial)  | ~200       | Resolution logic moves to shared    |
| `apps/search-ai/src/services/llm-config/embedding-credentials.ts` (partial) | ~80        | Resolution via AuthProfile          |
| **Subtotal DELETE**                                                         | **~2,901** |                                     |

### Lines to MODIFY (consumer references)

| File / Module                                                               | LOC to Modify | Change                                     |
| --------------------------------------------------------------------------- | ------------- | ------------------------------------------ |
| `apps/runtime/src/services/llm/model-resolution.ts`                         | ~100          | Resolve credentials via AuthProfileService |
| `apps/runtime/src/services/llm/session-llm-client.ts`                       | ~30           | Pass AuthProfile context                   |
| `apps/runtime/src/channels/connection-resolver.ts`                          | ~80           | Use AuthProfile for channel credentials    |
| `apps/studio/src/lib/connection-service.ts`                                 | ~20           | Reference AuthProfile for OAuth creds      |
| `apps/studio/src/repos/credential-repo.ts`                                  | ~50           | Add AuthProfile CRUD, adapt LLMCred calls  |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | ~60           | Resolve auth via AuthProfile               |
| `apps/runtime/src/services/mcp/inline-mcp-provider.ts`                      | ~20           | Use AuthProfile for encrypted env vars     |
| `apps/runtime/src/server.ts`                                                | ~30           | Wire AuthProfile service + routes          |
| `apps/runtime/src/routes/oauth.ts` (retained list/revoke)                   | ~50           | Delegate to AuthProfile                    |
| Tests (various)                                                             | ~300          | Update mocks/assertions                    |
| **Subtotal MODIFY**                                                         | **~740**      |                                            |

### Lines to ADD (new AuthProfile system)

| Component                                              | Est. LOC   | Notes                                 |
| ------------------------------------------------------ | ---------- | ------------------------------------- |
| `packages/database/src/models/auth-profile.model.ts`   | ~150       | Mongoose model with encryption plugin |
| `packages/shared/src/services/auth-profile-service.ts` | ~400       | Core service: CRUD, resolve, refresh  |
| `packages/shared/src/services/auth-profile-oauth.ts`   | ~200       | Unified OAuth initiate/callback       |
| `apps/runtime/src/routes/auth-profiles.ts`             | ~300       | REST API routes (CRUD + OAuth)        |
| `apps/studio/src/app/api/auth-profiles/` routes        | ~200       | Studio proxy routes                   |
| `apps/studio/src/components/auth-profile/`             | ~400       | UI components (list, create, detail)  |
| `apps/studio/src/api/auth-profiles.ts`                 | ~80        | Client API wrapper                    |
| `apps/studio/src/store/auth-profile-store.ts`          | ~60        | Zustand store                         |
| Migration script                                       | ~200       | Migrates existing credentials         |
| Tests                                                  | ~600       | Unit + integration + authz tests      |
| **Subtotal ADD**                                       | **~2,590** |                                       |

### Net Change Summary

| Metric        | Lines                       |
| ------------- | --------------------------- |
| Deleted       | ~2,901                      |
| Modified      | ~740                        |
| Added         | ~2,590                      |
| **Net delta** | **-311** (slight reduction) |

The net line count is roughly neutral, but the **architectural improvement** is significant:

- **9 credential resolution paths -> 1** unified `AuthProfileService.resolve()`
- **4 OAuth flow implementations -> 1** unified OAuth with Redis state
- **3 token refresh implementations -> 1** with distributed lock support
- **5 credential storage collections -> 1** `AuthProfile` collection
- **3 encryption wrapper interfaces -> 1** (Mongoose plugin handles it)
- **2 env-var conventions -> 1** standardized convention

---

## 8. Migration Risk Assessment

### Low Risk (can migrate independently)

- **LLM Credentials:** Already well-encapsulated in `LLMCredential` model with Mongoose plugin. AuthProfile can initially wrap the existing model.
- **Tool OAuth tokens:** `EndUserOAuthToken` is isolated. Migration is a data copy + redirect.

### Medium Risk (needs coordination)

- **Connector connections:** `ConnectorConnection.encryptedCredentials` is used by SearchAI sync workers, connector token refresh, and Studio UI. Migration requires updating all three consumers simultaneously.
- **Channel connections:** `ChannelConnection.encryptedCredentials` is used by inbound workers and connection resolver. Migration requires updating the inbound path.

### High Risk (critical path)

- **Runtime model resolution:** `model-resolution.ts` is on the hot path for every LLM call. The migration must be zero-downtime with a fallback path. Recommended approach: shadow reads from both old and new during migration, with feature flag.
- **HTTP tool executor OAuth:** Runs inside the compiler package, which is a build dependency. Changes here affect all downstream packages.

### Recommended Migration Order

1. **Phase 1:** Create `AuthProfile` model and service. Add new routes. No consumer changes yet.
2. **Phase 2:** Migrate Tool OAuth (`EndUserOAuthToken` -> `AuthProfile`). Feature flag.
3. **Phase 3:** Migrate LLM Credentials (`LLMCredential` -> `AuthProfile`). Dual-read.
4. **Phase 4:** Migrate Connector OAuth (unify initiate/callback routes).
5. **Phase 5:** Migrate Channel OAuth (unify with Phase 4 routes).
6. **Phase 6:** Remove old collections, old routes, old services. Cleanup.
