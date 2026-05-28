# Auth Profile — Connection Handling Analysis

> Comprehensive analysis of how connections are currently handled across the ABL platform,
> and what changes Auth Profile requires. Produced 2026-03-11.

---

## Table of Contents

1. [Credential Models Inventory](#1-credential-models-inventory)
2. [Connection Lifecycle Flows](#2-connection-lifecycle-flows)
3. [Connection Resolution at Runtime](#3-connection-resolution-at-runtime)
4. [Token Refresh Implementations](#4-token-refresh-implementations)
5. [Credential Encryption Patterns](#5-credential-encryption-patterns)
6. [Connection State Management](#6-connection-state-management)
7. [Auth Profile Impact Analysis](#7-auth-profile-impact-analysis)

---

## 1. Credential Models Inventory

The platform currently stores credentials across **8 separate models** in MongoDB, each with its own
encryption approach, schema shape, and lifecycle management.

### 1.1 Models to be Replaced (3)

| Model               | File                                                         | Encrypted Fields                                | Encryption Method     |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------------- | --------------------- |
| `LLMCredential`     | `packages/database/src/models/llm-credential.model.ts`       | `encryptedApiKey`, `encryptedEndpoint`          | `encryptionPlugin` v3 |
| `EndUserOAuthToken` | `packages/database/src/models/end-user-oauth-token.model.ts` | `encryptedAccessToken`, `encryptedRefreshToken` | `encryptionPlugin` v3 |
| `ToolSecret`        | `packages/database/src/models/tool-secret.model.ts`          | `encryptedValue`                                | `encryptionPlugin` v3 |

### 1.2 Models to be Simplified (drop inline auth fields, add `authProfileId`)

| Model                 | File                                                         | Fields to Drop                                                                         | Encryption Method                              |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ConnectorConnection` | `packages/database/src/models/connector-connection.model.ts` | `encryptedCredentials`, `oauth2RefreshToken`, `oauth2Provider`, `oauth2TokenExpiresAt` | Manual (no plugin); ConnectionService encrypts |
| `ChannelConnection`   | `packages/database/src/models/channel-connection.model.ts`   | `encryptedCredentials`, `config.encryptedInboundAuthToken`                             | `encryptionPlugin` + manual for nested config  |
| `MCPServerConfig`     | `packages/database/src/models/mcp-server-config.model.ts`    | `encryptedEnv`, `encryptedAuthConfig`                                                  | `encryptionPlugin` v3                          |
| `ServiceNode`         | `packages/database/src/models/service-node.model.ts`         | `encryptedSecrets`, `authConfig`                                                       | `encryptionPlugin` (skipTenantScoping)         |
| `OrgProxyConfig`      | `packages/database/src/models/org-proxy-config.model.ts`     | 6 encrypted fields (username, password, token, caCert, clientCert, clientKey)          | `encryptionPlugin` v3                          |
| `TenantModel`         | `packages/database/src/models/tenant-model.model.ts`         | `connections[].credentialId` (indirect ref to LLMCredential)                           | None (refs LLMCredential which is encrypted)   |

### 1.3 Untouched Models

| Model                 | Reason                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `ApiKey`              | Platform access keys (JWT alternative), not service auth              |
| `TenantKMS`           | Encryption infrastructure, not auth                                   |
| `EnvironmentVariable` | Deployment config; secret env vars storing credentials should migrate |

---

## 2. Connection Lifecycle Flows

### 2.1 Connector OAuth Connections (Gmail, Slack, etc.)

```
Studio UI                     Studio API                    Runtime API              External Provider
    |                              |                             |                         |
    |  Browse connector catalog    |                             |                         |
    |  (static JSON served from    |                             |                         |
    |   connector-catalog.json)    |                             |                         |
    |                              |                             |                         |
    |  Click "Connect" on Gmail    |                             |                         |
    |--POST connections/create---->|                             |                         |
    |                              | ConnectionService.create()  |                         |
    |                              | - validates connector name  |                         |
    |                              |   against ConnectorRegistry |                         |
    |                              | - derives authType from     |                         |
    |                              |   registry if not provided  |                         |
    |                              | - encrypts credentials via  |                         |
    |                              |   enc.encryptForTenant()    |                         |
    |                              | - stores in ConnectorConnection                       |
    |                              |   (status='active')         |                         |
    |                              |                             |                         |
    | [For OAuth2 connectors]      |                             |                         |
    |  OAuth popup opens           |                             |                         |
    |  redirects to provider-------|----------------------------->|---authorize URL-------->|
    |                              |                             |                         |
    |  Provider callback           |                             |                         |
    |<-code+state------------------|<----------------------------|<---code+state-----------|
    |                              |                             |                         |
    |--POST connections/:id/oauth->|                             |                         |
    |                              | ConnectionService           |                         |
    |                              |   .completeOAuthSetup()     |                         |
    |                              | - encrypts accessToken      |                         |
    |                              | - encrypts refreshToken     |                         |
    |                              | - sets oauth2TokenExpiresAt |                         |
    |                              | - sets scopes               |                         |
    |                              | - status='active'           |                         |
```

**Key files:**

- Studio singleton: `apps/studio/src/lib/connection-service.ts` (lines 30-41)
- CRUD service: `packages/connectors/src/services/connection-service.ts` (lines 101-376)
- Connection model: `packages/database/src/models/connector-connection.model.ts` (lines 16-87)

**Note:** The `ConnectorConnection` model explicitly does NOT use `encryptionPlugin` (line 71 comment).
Encryption is done manually in `ConnectionService` via injected `encrypt`/`decrypt` callbacks
because the OAuth token refresh cycle uses `findOneAndUpdate` with pre-encrypted values.

### 2.2 LLM Provider Connections

```
Studio Settings Page           Studio API                     Runtime (ModelResolution)
    |                              |                                    |
    |  Add LLM Provider            |                                    |
    |  (e.g. OpenAI, Anthropic)    |                                    |
    |                              |                                    |
    |--POST /api/credentials------>|                                    |
    |  { provider, name,           |                                    |
    |    apiKey, endpoint }        |                                    |
    |                              | LLMCredential.create()             |
    |                              | - encryptionPlugin auto-encrypts   |
    |                              |   encryptedApiKey, encryptedEndpoint|
    |                              | - scoped to tenant via ownerId     |
    |                              |                                    |
    |  Add Model (TenantModel)     |                                    |
    |--POST /api/models----------->|                                    |
    |  { provider, modelId,        |                                    |
    |    connections: [{            |                                    |
    |      credentialId: "..."     |                                    |
    |    }] }                      |                                    |
    |                              | TenantModel.create()               |
    |                              | - no direct encryption             |
    |                              | - stores credentialId ref          |
    |                              |                                    |
    |                              |                 At runtime:        |
    |                              |                                    |
    |                              |         ModelResolutionService     |
    |                              |           .resolve(context)        |
    |                              |         - 5-level resolution chain |
    |                              |         - finds TenantModel        |
    |                              |         - loads LLMCredential by   |
    |                              |           connection.credentialId  |
    |                              |         - plugin auto-decrypts     |
    |                              |         - returns ResolvedCredential|
```

**Key files:**

- Model resolution: `apps/runtime/src/services/llm/model-resolution.ts`
  - `buildTenantModelResolution()` at line 825 — loads LLMCredential by credentialId, relies on plugin auto-decrypt
  - `resolveCredential()` at line 1060 — fallback chain: user credential, tenant credential, TenantModel-by-provider
- Resolution repo: `apps/runtime/src/repos/llm-resolution-repo.ts`
  - `findCredentialById()` at line 398 — uses `LLMCredential.findById()` (NOTE: this violates the tenant isolation rule of never using findById)
  - `findDefaultUserCredential()` at line 346 — scoped by `credentialScope: 'user'`, ownerId, provider
  - `findDefaultTenantCredential()` at line 372 — scoped by `credentialScope: 'tenant'`, ownerId (tenantId), provider
- LLMCredential model: `packages/database/src/models/llm-credential.model.ts`

**Credential resolution chain at runtime (from model-resolution.ts lines 1060-1122):**

1. Check credential policy (`user_only`, `org_first`, `user_first`, `org_only`)
2. Try user-scoped LLMCredential (`findDefaultUserCredential`)
3. Try tenant-scoped LLMCredential (`findDefaultTenantCredential`)
4. Last-resort: TenantModel-by-provider fallback (`findTenantModelByProvider` then `buildTenantModelResolution`)
5. FAIL if no credential found

### 2.3 MCP Server Connections

```
Studio MCP Config Page         Studio API                 Runtime (MCPServerRegistryService)
    |                              |                                |
    |  Add MCP Server              |                                |
    |  { name, url, transport,     |                                |
    |    authType, authConfig,     |                                |
    |    env: { KEY: "secret" } }  |                                |
    |                              |                                |
    |--POST /api/mcp-servers------>|                                |
    |                              | MCPServerConfig.create()       |
    |                              | - encryptionPlugin encrypts    |
    |                              |   encryptedEnv, encryptedAuthConfig
    |                              |                                |
    |                              |             At runtime:        |
    |                              |                                |
    |                              |   MCPServerRegistryService     |
    |                              |     .getServerConfigs()        |
    |                              |   - loads from DB              |
    |                              |   - decrypts encryptedEnv via  |
    |                              |     decryptor.decryptForTenant |
    |                              |   - decrypts encryptedAuthConfig|
    |                              |   - calls resolveAuthHeaders() |
    |                              |     to produce HTTP headers    |
    |                              |   - caches per project (60s TTL)|
```

**Key files:**

- Registry service: `packages/shared/src/services/mcp-server-registry.ts` (lines 63-227)
  - `toServerConfig()` at line 125 — decrypts env and auth, calls `resolveAuthHeaders()`
- Auth resolver: `packages/shared/src/services/mcp-auth-resolver.ts` (lines 44-131)
  - Handles `bearer`, `api_key`, `custom_headers`, `oauth2_client_credentials`
  - OAuth2 client_credentials: in-memory token cache with 60s pre-expiry buffer
- MCP model: `packages/database/src/models/mcp-server-config.model.ts`
  - `authType`: `none | bearer | api_key | custom_headers | oauth2_client_credentials`
  - Two encrypted fields: `encryptedEnv` (env vars) and `encryptedAuthConfig` (auth details)

### 2.4 Channel Connections

```
Studio Deployment Page         Runtime API                  Inbound Worker
    |                              |                              |
    |  Deploy to Slack             |                              |
    |  [OAuth flow for Slack]      |                              |
    |                              |                              |
    |--POST channel-oauth/         |                              |
    |  :channelType/authorize----->|                              |
    |                              | ChannelOAuthService          |
    |                              |   .initiateFlow()            |
    |                              | - generates CSRF state       |
    |                              | - stores in Redis/memory     |
    |                              | - delegates to provider:     |
    |                              |   SlackOAuthProvider         |
    |                              |   MetaOAuthProvider          |
    |                              |   MSTeamsOAuthProvider       |
    |                              |                              |
    |  Provider callback           |                              |
    |--GET channel-oauth/          |                              |
    |  :channelType/callback------>|                              |
    |                              | ChannelOAuthService          |
    |                              |   .handleCallback()          |
    |                              | - validates state            |
    |                              | - delegates code exchange    |
    |                              | - returns credentials +      |
    |                              |   externalIdentifier         |
    |                              |                              |
    |  Store in DB                 |                              |
    |  (via channel-connections    |                              |
    |   route, lines 14-33)        |                              |
    |                              | ChannelConnection.create()   |
    |                              | - encryptionPlugin encrypts  |
    |                              |   encryptedCredentials       |
    |                              | - manual encrypt for         |
    |                              |   config.encryptedInboundAuthToken
    |                              |                              |
    |                              |              At runtime:     |
    |                              |                              |
    |                              |   resolveChannelConnection() |
    |                              |   - queries by channelType + |
    |                              |     externalIdentifier       |
    |                              |   - decrypts credentials via |
    |                              |     getEncryptionService()   |
    |                              |     .decryptJsonForTenant()  |
    |                              |   - also decrypts nested     |
    |                              |     config.encryptedInbound  |
    |                              |     AuthToken                |
```

**Key files:**

- Channel OAuth service: `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts` (lines 30-118)
- Channel OAuth routes: `apps/runtime/src/routes/channel-oauth.ts`
- Channel OAuth providers: `apps/runtime/src/services/channel-oauth/providers/`
  - `slack-oauth-provider.ts`, `meta-oauth-provider.ts`, `msteams-oauth-provider.ts`
- Channel connection resolver: `apps/runtime/src/channels/connection-resolver.ts` (lines 18-307)
  - `resolveChannelConnection()` — by channelType + externalIdentifier
  - `resolveConnectionById()` — by connection ID (with optional tenantId filter)
  - `resolveConnectionByVerifyToken()` — for Meta webhook verification (SHA-256 hash lookup, no tenantId filter)
  - `findOrCreateHttpAsyncConnection()` — upsert for HTTP async channels
- Channel connection model: `packages/database/src/models/channel-connection.model.ts`
- Channel connections route: `apps/runtime/src/routes/channel-connections.ts`

**Note on tenant isolation gap:** `resolveChannelConnection()` at line 26 queries by `channelType + externalIdentifier`
without tenantId. This is by design for inbound message routing (the external identifier uniquely maps to a connection),
but `resolveConnectionById()` at line 110 makes tenantId optional, which is a weaker isolation pattern.

### 2.5 Service Node Connections

```
Studio Workflow Editor         Studio API                     Runtime
    |                              |                              |
    |  Configure service node      |                              |
    |  { endpoint, method,         |                              |
    |    authType, authConfig,     |                              |
    |    secrets: {...} }          |                              |
    |                              |                              |
    |--POST /api/service-nodes---->|                              |
    |                              | ServiceNode.create()         |
    |                              | - encryptionPlugin encrypts  |
    |                              |   encryptedSecrets           |
    |                              | - skipTenantScoping=true     |
    |                              |   (uses projectId join)      |
    |                              |                              |
    |                              |         At runtime:          |
    |                              | ServiceNode loaded, plugin   |
    |                              | auto-decrypts encryptedSecrets|
    |                              | authConfig used directly for |
    |                              | HTTP auth header construction|
```

**Key file:** `packages/database/src/models/service-node.model.ts`

**Note:** ServiceNode uses `skipTenantScoping: true` in the encryption plugin (line 75) because it
does not have a `tenantId` field. Tenant isolation is enforced via `projectId -> Project.tenantId` join.
This is a weaker pattern that Auth Profile should fix by adding `tenantId` to the auth profile reference.

### 2.6 Tool Secrets (DSL `{{secrets.KEY}}`)

```
Studio Settings                Studio API                     Runtime (SecretsProvider)
    |                              |                              |
    |  Add tool secret             |                              |
    |  { toolName, secretKey,      |                              |
    |    value, environment }      |                              |
    |                              |                              |
    |--POST /api/tool-secrets----->|                              |
    |                              | ToolSecret.create()          |
    |                              | - encryptionPlugin encrypts  |
    |                              |   encryptedValue             |
    |                              |                              |
    |                              |         At runtime:          |
    |                              |                              |
    |                              | RuntimeSecretsProvider       |
    |                              |   .getSecret(key)            |
    |                              | 1. Special keys (auth_token) |
    |                              | 2. ToolSecret store lookup   |
    |                              |    + decrypt                 |
    |                              | 3. Agent IR credentials map  |
    |                              | 4. Environment variables     |
    |                              | 5. undefined (warn)          |
```

**Key files:**

- Secrets provider: `apps/runtime/src/services/secrets-provider.ts` (lines 72-308)
  - `getSecret()` — 5-layer lookup chain
  - `getUserOAuthToken()` — delegates to OAuthTokenResolver (ToolOAuthService)
  - `getEnvVar()` — encrypted env var lookup from `EnvironmentVariable` model
- Tool secret model: `packages/database/src/models/tool-secret.model.ts`
- LLM wiring (wires secrets provider): `apps/runtime/src/services/execution/llm-wiring.ts`

### 2.7 Git Integration Credentials

```
Studio Git Settings            Studio API
    |                              |
    |  Configure git integration   |
    |  { type: 'oauth'|'token',   |
    |    secretId: "encrypted..." }|
    |                              |
    |  resolveGitCredentials()     |
    |  - decryptForTenant()        |
    |  - handles "user:token" format|
    |  - returns usable token      |
```

**Key file:** `apps/studio/src/lib/git-credentials.ts` (lines 1-50)

Stores a `secretId` (encrypted token) on the git integration record. Decrypted
at resolve time via `enc.decryptForTenant()`.

### 2.8 Org Proxy Config

The most encrypted model in the system with **6 separately encrypted fields:**

- `encryptedProxyUsername`
- `encryptedProxyPassword`
- `encryptedProxyToken`
- `encryptedCaCertificate`
- `encryptedClientCert`
- `encryptedClientKey`

**Key file:** `packages/database/src/models/org-proxy-config.model.ts`

All handled by `encryptionPlugin` with v3 tenant-scoped encryption.

---

## 3. Connection Resolution at Runtime

### 3.1 Connector Tool Execution Flow

```
Agent invokes "gmail.send_email"
        |
        v
ConnectorToolExecutor.execute()          [packages/connectors/src/executor/connector-tool-executor.ts:44]
        |
        | 1. parseToolName("gmail.send_email") → { connector: "gmail", action: "send_email" }
        | 2. registry.getAction("gmail", "send_email") → action definition
        |
        v
ConnectionResolver.resolve(opts)          [packages/connectors/src/auth/connection-resolver.ts:64]
        |
        | Priority:
        | 1. If connectionId provided → findOne({ _id, tenantId, projectId, status: 'active' })
        | 2. If userId provided → findOne({ connectorName, tenantId, projectId, scope: 'user', userId })
        | 3. Fallback → findOne({ connectorName, tenantId, projectId, scope: 'tenant' })
        |
        v
ConnectionResolver.resolveAuth(connection)  [connection-resolver.ts:127]
        |
        | If OAuth2 + token expired (60s buffer):
        |   → refreshOAuth2(connection)
        | Else:
        |   → decrypt(connection) → JSON.parse(decrypted)
        |
        v
action.run({ auth, params, tenantId, projectId, ... })
```

### 3.2 LLM Credential Resolution Flow

```
SessionLLMClient needs API key
        |
        v
ModelResolutionService.resolve(context)    [model-resolution.ts:344]
        |
        | 5-level resolution chain:
        | Level 0: Deployment model override
        | Level 1: Agent IR (DSL model)
        | Level 2: Agent DB (per-agent config)
        | Level 3: Project DB (ModelConfig → TenantModel)
        | Level 3b: Voice-specific
        | Level 4: Tenant Model (tier-specific → any default)
        | Level 5: Platform Demo fallback
        |
        v
buildTenantModelResolution(tm)            [model-resolution.ts:825]
        |
        | If connection.credentialId exists:
        |   findCredentialById(credentialId) → LLMCredential
        |   encryptionPlugin auto-decrypts encryptedApiKey
        |   Returns { apiKey, endpoint, authType, authConfig }
        |
        | Elif connection.encryptedApiKey (inline):
        |   isEncryptedFormat() check
        |   encryption.decryptForTenant()
        |
        | Elif integrationType === 'api':
        |   Returns empty credential (IAM/header auth)
        |
        v
resolveCredential(context, provider, policy)  [model-resolution.ts:1060]
        |
        | Fallback when no TenantModel:
        | 1. User-scoped LLMCredential
        | 2. Tenant-scoped LLMCredential
        | 3. TenantModel-by-provider lookup
```

**Caching strategy:** Model metadata is cached (5-min TTL, 10k entries max), but **decrypted credentials
are never cached**. The `rehydrateCredential()` method (line 300) re-decrypts from DB on every call,
which is the correct security practice.

### 3.3 Channel Credential Resolution Flow

```
Inbound message arrives (e.g., Slack webhook)
        |
        v
resolveChannelConnection(channelType, externalIdentifier)
        [apps/runtime/src/channels/connection-resolver.ts:18]
        |
        | 1. ChannelConnection.findOne({ channelType, externalIdentifier })
        |    NOTE: No tenantId filter — resolved from the externalIdentifier
        | 2. Check status === 'active'
        | 3. If encryptedCredentials present:
        |    getEncryptionService().decryptJsonForTenant(encrypted, tenantId)
        | 4. If config.encryptedInboundAuthToken present:
        |    getEncryptionService().decryptForTenant(encrypted, tenantId)
        |
        v
Returns ResolvedConnection { id, tenantId, projectId, agentId, credentials, config }
```

### 3.4 MCP Server Credential Resolution Flow

```
Agent needs to call MCP tool
        |
        v
MCPServerRegistryService.getServerConfigs(tenantId, projectId)
        [packages/shared/src/services/mcp-server-registry.ts:76]
        |
        | 1. Check 60s TTL cache
        | 2. Load MCPServerConfig documents from DB
        | 3. For each config:
        |    a. Decrypt encryptedEnv → env vars object
        |    b. If authType !== 'none':
        |       Decrypt encryptedAuthConfig → auth config object
        |       resolveAuthHeaders(authConfig, tenantId) → HTTP headers
        | 4. Cache and return
        |
        v
resolveAuthHeaders(config, tenantId)
        [packages/shared/src/services/mcp-auth-resolver.ts:44]
        |
        | switch(config.type):
        |   'bearer'  → { Authorization: "Bearer <token>" }
        |   'api_key' → { <headerName>: <value> }
        |   'custom_headers' → { ...headers } (capped at 20)
        |   'oauth2_client_credentials' → fetch token, cache it, return Bearer header
```

### 3.5 End-User OAuth Token Resolution Flow

```
Agent tool needs user's Gmail token
        |
        v
RuntimeSecretsProvider.getUserOAuthToken(userId, provider)
        [apps/runtime/src/services/secrets-provider.ts:216]
        |
        v
ToolOAuthService.getAccessToken(tenantId, userId, provider)
        [apps/runtime/src/services/tool-oauth-service.ts:365]
        |
        | 1. tokenStore.findToken(tenantId, userId, provider)
        |    → EndUserOAuthToken document (plugin auto-decrypts)
        | 2. Check expiry (60s buffer)
        | 3. If expired + has refresh token:
        |    refreshToken() → fetch new tokens → re-encrypt → upsert
        | 4. If expired + no refresh token:
        |    return undefined (user must re-authorize)
        | 5. Decrypt access token: encryptor.decryptForTenant()
        | 6. Fire-and-forget: updateLastUsed()
```

---

## 4. Token Refresh Implementations

There are **three separate OAuth token refresh implementations** in the codebase. Auth Profile will
unify these into a single refresh mechanism.

### 4.1 ConnectionResolver Refresh (Connector Connections)

**File:** `packages/connectors/src/auth/connection-resolver.ts` lines 142-245

**Mechanism:**

- Checks `connection.oauth2TokenExpiresAt` with 60s buffer
- Uses distributed lock (`SET NX PX` via LockManagerLike) to prevent concurrent refresh
- If lock acquisition fails, waits 2s then reads updated token from DB
- Gets clientId/clientSecret from **environment variables** (`OAUTH2_CLIENT_ID_<PROVIDER>`)
- Gets tokenUrl from `ProviderConfigRegistry` (600+ Nango-sourced provider configs)
- On failure: marks connection `status: 'expired'`
- On success: updates `encryptedCredentials` and `oauth2TokenExpiresAt`
- Handles refresh token rotation (stores new refresh token if provider issues one)

**Weakness:** OAuth app credentials come from env vars, not from the connector configuration itself.
This means all tenants share the same OAuth app credentials for a given provider.

### 4.2 ToolOAuthService Refresh (End-User OAuth Tokens)

**File:** `apps/runtime/src/services/tool-oauth-service.ts` lines 415-475

**Mechanism:**

- No distributed locking (single-threaded per service instance)
- Gets clientId/clientSecret from **in-memory providerConfigs Map** (loaded from env vars at startup)
- Uses `tokenUrl` from provider config
- On failure: returns undefined (no status update)
- On success: upserts new encrypted tokens via `tokenStore.upsertToken()`
- Handles refresh token rotation (keeps old if provider does not issue new one)
- Scope preservation: uses new scope from response or keeps existing scope

**Weakness:** No distributed lock means concurrent refresh from multiple pods is possible. Also
no "expired" status tracking on the token record.

### 4.3 MCP Auth Resolver Refresh (OAuth2 Client Credentials)

**File:** `packages/shared/src/services/mcp-auth-resolver.ts` lines 73-131

**Mechanism:**

- In-memory token cache (Map with 200 max entries, FIFO eviction)
- Pre-fetches new token when within 60s of expiry
- HTTPS enforced on token endpoint
- No distributed locking (cache is per-pod)
- No persistent storage of tokens (re-fetched after pod restart)
- 15s request timeout via AbortSignal

**Note:** This is not truly a "refresh" — it is a `client_credentials` grant that fetches a new
short-lived access token. No refresh tokens involved.

### 4.4 What Unified Refresh Looks Like Under Auth Profile

```
Auth Profile Token Refresh (single implementation)
    |
    | 1. Load oauth2_token profile (the expired one)
    | 2. Check config.expiresAt (60s buffer)
    | 3. Acquire distributed lock: Redis SET NX PX
    |    key: "auth-profile:refresh:<profileId>"
    |    ttl: 30s
    | 4. If lock fails: wait 2s, reload from DB, return
    | 5. Load linkedAppProfileId → oauth2_app profile
    |    - Decrypts clientId, clientSecret from oauth2_app.encryptedSecrets
    |    - Gets tokenUrl from oauth2_app.config.tokenUrl
    | 6. POST token endpoint with refresh_token grant
    | 7. If config.refreshTokenRotation: store new refresh token atomically
    | 8. Update oauth2_token.encryptedSecrets (new accessToken, optionally new refreshToken)
    | 9. Update oauth2_token.config.expiresAt
    |10. Release lock
    |
    | On failure:
    | - Set oauth2_token.status = 'expired'
    | - Consumers get "Authorization expired. [Re-authorize]"
```

**Key improvement:** The `linkedAppProfileId` link means OAuth app credentials (clientId/clientSecret)
are stored in the database per tenant/project, not in environment variables. This enables multi-tenant
OAuth app isolation.

---

## 5. Credential Encryption Patterns

### 5.1 Encryption Architecture

The platform has three encryption versions coexisting:

| Version | Method                                     | Used By                       |
| ------- | ------------------------------------------ | ----------------------------- |
| v1      | Master key wraps per-document CEK (PBKDF2) | Legacy documents              |
| v2      | KMS provider wraps per-document CEK (HSM)  | Enterprise deployments        |
| v3      | Tenant-scoped HKDF key derivation (no CEK) | Default for all new documents |

**Core file:** `packages/database/src/mongo/plugins/encryption.plugin.ts`

The plugin adds metadata fields to every encrypted document:

- `ire` — encryption reference version (`v1`, `v2`, `v3`)
- `cek` — encrypted content encryption key (v1/v2 only)
- `iv` — initialization vector (v1 only)
- `kmsKeyId` — KMS key identifier (v2 only)
- `fieldsToEncrypt` — array of field names that are encrypted

### 5.2 Encryption Service

**File:** `packages/shared/src/encryption/engine.ts`

- `EncryptionService` class with methods:
  - `encryptForTenant(plaintext, tenantId)` — HKDF key derivation from master key + tenantId salt
  - `decryptForTenant(encryptedData, tenantId)` — reverse
  - `decryptJsonForTenant<T>(encrypted, tenantId)` — decrypt + JSON.parse
  - `encrypt(plaintext, userId)` — user-scoped encryption
- Algorithm: AES-256-GCM with 96-bit IV, 128-bit auth tag
- Key derivation: HKDF-SHA256 for tenant keys, PBKDF2 for user keys
- Tenant key cache: `TenantKeyCache` with configurable max size and TTL
- Output format: `iv:authTag:ciphertext` (hex 3-part) or `Z1|<base64>` (compressed)

### 5.3 All Encryption/Decryption Call Sites

#### Automatic (via encryptionPlugin)

These models have the plugin which auto-encrypts on save and auto-decrypts on find:

| Model               | Fields                                                              | Source Line                      |
| ------------------- | ------------------------------------------------------------------- | -------------------------------- |
| `LLMCredential`     | `encryptedApiKey`, `encryptedEndpoint`                              | llm-credential.model.ts:65       |
| `EndUserOAuthToken` | `encryptedAccessToken`, `encryptedRefreshToken`                     | end-user-oauth-token.model.ts:60 |
| `ToolSecret`        | `encryptedValue`                                                    | tool-secret.model.ts:57          |
| `ChannelConnection` | `encryptedCredentials`                                              | channel-connection.model.ts:93   |
| `MCPServerConfig`   | `encryptedEnv`, `encryptedAuthConfig`                               | mcp-server-config.model.ts:88    |
| `ServiceNode`       | `encryptedSecrets`                                                  | service-node.model.ts:73         |
| `OrgProxyConfig`    | 6 fields (username, password, token, caCert, clientCert, clientKey) | org-proxy-config.model.ts:68     |

#### Manual Encryption Call Sites

| Location                                                      | Operation       | What                                   |
| ------------------------------------------------------------- | --------------- | -------------------------------------- |
| `packages/connectors/src/auth/connection-resolver.ts:218`     | encrypt         | New OAuth access token after refresh   |
| `packages/connectors/src/auth/connection-resolver.ts:230`     | encrypt         | New OAuth refresh token rotation       |
| `packages/connectors/src/auth/connection-resolver.ts:116-120` | decrypt         | Connection credentials                 |
| `packages/connectors/src/auth/connection-resolver.ts:170`     | decrypt         | Refresh token for OAuth refresh        |
| `packages/connectors/src/services/connection-service.ts:173`  | encrypt         | Create connection credentials          |
| `packages/connectors/src/services/connection-service.ts:207`  | encrypt         | Update connection credentials          |
| `packages/connectors/src/services/connection-service.ts:239`  | encrypt         | OAuth setup (access token)             |
| `packages/connectors/src/services/connection-service.ts:254`  | encrypt         | OAuth setup (refresh token)            |
| `packages/connectors/src/services/connection-service.ts:293`  | decrypt         | Test connection (decrypt creds)        |
| `apps/runtime/src/channels/connection-resolver.ts:45`         | decryptJson     | Channel connection credentials         |
| `apps/runtime/src/channels/connection-resolver.ts:71`         | decrypt         | Inbound auth token (nested config)     |
| `apps/runtime/src/services/tool-oauth-service.ts:337-342`     | encrypt         | OAuth callback: access + refresh       |
| `apps/runtime/src/services/tool-oauth-service.ts:400`         | decrypt         | Get stored access token                |
| `apps/runtime/src/services/tool-oauth-service.ts:426`         | decrypt         | Refresh: decrypt stored refresh token  |
| `apps/runtime/src/services/tool-oauth-service.ts:454-457`     | encrypt         | Refresh: re-encrypt new tokens         |
| `apps/runtime/src/services/llm/model-resolution.ts:883-891`   | decrypt         | Inline encrypted API key on connection |
| `apps/runtime/src/services/secrets-provider.ts:279`           | decrypt         | ToolSecret value lookup                |
| `apps/runtime/src/services/secrets-provider.ts:202`           | decrypt         | Environment variable lookup            |
| `apps/studio/src/lib/connection-service.ts:38-39`             | encrypt/decrypt | Studio connection service wiring       |
| `apps/studio/src/lib/git-credentials.ts:30`                   | decrypt         | Git integration credentials            |
| `packages/shared/src/services/mcp-server-registry.ts:132`     | decrypt         | MCP server env vars                    |
| `packages/shared/src/services/mcp-server-registry.ts:191`     | decrypt         | MCP server auth config                 |

### 5.4 Key Management

- **Master key:** Set at startup via `ENCRYPTION_MASTER_KEY` env var (64 hex chars = 32 bytes)
- **Tenant keys:** Derived via HKDF from master key + tenantId salt. Cached in `TenantKeyCache`
- **KMS integration:** Optional per-tenant KMS via `setKMSResolverFn()` for v2 CEK wrapping
- **Key rotation:** v1/v2 support via re-encryption on save; v3 rotates by changing master key (requires re-encrypt all)

---

## 6. Connection State Management

### 6.1 Connection Status Values

| Model                 | Status Values                                             | Transitions                                            |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| `ConnectorConnection` | `active`, `expired`, `revoked`                            | active→expired (refresh fail), active→revoked (manual) |
| `ChannelConnection`   | `active`, `inactive`                                      | Binary toggle via CRUD                                 |
| `LLMCredential`       | `isActive` boolean                                        | No expired state; just deactivated                     |
| `EndUserOAuthToken`   | Implicit via `revokedAt` and `expiresAt`                  | consented→revoked (manual), expired (by time)          |
| `MCPServerConfig`     | `lastConnectionStatus`: `connected`, `failed`, `untested` | Updated by health check                                |
| `ServiceNode`         | `isActive` boolean                                        | Binary toggle                                          |
| `OrgProxyConfig`      | `enabled` boolean                                         | Binary toggle                                          |
| `ToolSecret`          | Implicit via `expiresAt`                                  | Expired secrets rejected by SecretsProvider            |

### 6.2 Health Checks and Validation

**LLM Credentials:**

- `TenantModelConnection.healthStatus`: `healthy | unhealthy | unknown | unchecked`
- `TenantModelConnection.lastHealthCheck`: timestamp
- `TenantModelConnection.healthMessage`: error details
- Checked via Studio admin UI or API

**MCP Servers:**

- `MCPServerConfig.lastConnectionStatus`: `connected | failed | untested`
- `MCPServerConfig.lastConnectionAt`: timestamp
- `MCPServerConfig.lastConnectionLatencyMs`: performance metric
- `MCPServerConfig.lastConnectionToolCount`: discovered tools count
- `MCPServerConfig.lastConnectionError`: error message

**Connector Connections:**

- `ConnectionService.test()` (line 276): runs `test_connection` action, updates status
- On success: marks `active`
- On failure: marks `expired`

**Credential Age Monitoring:**

- `apps/runtime/src/services/credential-age-monitor.ts`
- Scans ToolSecret, LLMCredential, ApiKey for age > threshold
- Emits warning events at 60 days, critical events at 90 days
- Runs on 24h interval

### 6.3 Cleanup and Expiry

- **ToolSecret:** `expiresAt` field checked by `RuntimeSecretsProvider.resolveFromStore()` — expired secrets return undefined
- **EndUserOAuthToken:** No automatic cleanup job; `revokedAt` set on revocation, `expiresAt` checked at access time
- **ConnectorConnection:** `status: 'expired'` set by ConnectionResolver on refresh failure; no automatic cleanup
- **ChannelConnection:** No automatic expiry; inactive connections filtered out at query time
- **OAuth pending states:** Redis TTL auto-cleanup (or in-memory cleanup every 60s with 10min TTL)

---

## 7. Auth Profile Impact Analysis

### 7.1 Models That Change

#### Models Deleted (replaced by AuthProfile)

| Current Model       | Auth Profile Type                                       | Migration Complexity                                                       |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `LLMCredential`     | `authType: api_key \| azure_ad \| aws_iam`              | Medium — must update all TenantModel.connections[].credentialId references |
| `EndUserOAuthToken` | `authType: oauth2_token`, `visibility: personal`        | Medium — must update ToolOAuthService and SecretsProvider                  |
| `ToolSecret`        | `authType: api_key \| bearer \| basic` (by secret type) | Low — DSL changes from `{{secrets.KEY}}` to `auth: profile-name`           |

#### Models Simplified (drop inline auth, add authProfileId)

| Model                 | Auth Ref Change                                                                                                   | Consumers to Update                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ConnectorConnection` | Drop `encryptedCredentials`, `oauth2RefreshToken`, `oauth2Provider`, `oauth2TokenExpiresAt`. Add `authProfileId`. | ConnectionResolver, ConnectionService, ConnectorToolExecutor                  |
| `ChannelConnection`   | Drop `encryptedCredentials`. Add `authProfileId`.                                                                 | Channel connection resolver, channel-connections route, all channel providers |
| `MCPServerConfig`     | Drop `encryptedEnv`, `encryptedAuthConfig`. Add `authProfileId`.                                                  | MCPServerRegistryService, mcp-auth-resolver                                   |
| `ServiceNode`         | Drop `encryptedSecrets`, `authConfig`. Add `authProfileId`.                                                       | Service node executor                                                         |
| `OrgProxyConfig`      | Drop 6 encrypted fields. Add `authProfileId`.                                                                     | ProxyConfigService                                                            |
| `TenantModel`         | `connections[].credentialId` → `connections[].authProfileId`                                                      | ModelResolutionService, llm-resolution-repo                                   |

### 7.2 Services That Change

| Service                     | Current Auth Source                                        | Auth Profile Change                                                 |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `ConnectionResolver`        | Decrypts `encryptedCredentials` from ConnectorConnection   | Loads AuthProfile by `authProfileId`, decrypts from profile         |
| `ConnectionService`         | Encrypts/decrypts credentials inline                       | Creates/links AuthProfile instead of inline creds                   |
| `ToolOAuthService`          | Manages EndUserOAuthToken + env-based provider configs     | Manages `oauth2_token` AuthProfiles, links to `oauth2_app` profiles |
| `ChannelOAuthService`       | Provider-specific code exchange, manual credential storage | Creates `oauth2_token` AuthProfile on callback                      |
| `ModelResolutionService`    | LLMCredential via credentialId, inline encrypted keys      | AuthProfile via authProfileId on TenantModel connection             |
| `MCPServerRegistryService`  | Decrypts encryptedEnv/encryptedAuthConfig                  | Loads AuthProfile by authProfileId, gets headers                    |
| `MCP Auth Resolver`         | Direct auth config → headers                               | AuthProfile config → headers (same logic, different source)         |
| `RuntimeSecretsProvider`    | ToolSecret store + ToolOAuthService                        | AuthProfile resolution for tool auth; unchanged for env vars        |
| `CredentialAgeMonitor`      | Scans ToolSecret, LLMCredential, ApiKey                    | Scans AuthProfile with `lastValidatedAt` + `expiresAt`              |
| Channel connection resolver | Decrypts encryptedCredentials from ChannelConnection       | Loads AuthProfile by authProfileId                                  |

### 7.3 Resolution Priority Change

**Current (per connection type, inconsistent):**

```
ConnectorConnection: user-scoped → tenant-scoped (by connectorName)
LLMCredential:       user policy → tenant policy (by credential policy)
EndUserOAuthToken:   userId + provider → undefined
ChannelConnection:   channelType + externalIdentifier (no priority chain)
MCPServerConfig:     project-scoped only (no fallback)
```

**Auth Profile (unified, from design doc section 4):**

```
1. Personal oauth2_token for user + connector (if per_user)
2. Shared oauth2_token for connector (if shared)
3. Project-level AuthProfile with matching authProfileId
4. Tenant-level AuthProfile fallback
```

### 7.4 Token Refresh Unification

**Replaces 3 implementations → 1:**

| Current Implementation               | File                         | Auth Profile Replacement                        |
| ------------------------------------ | ---------------------------- | ----------------------------------------------- |
| `ConnectionResolver.refreshOAuth2()` | `connection-resolver.ts:142` | `AuthProfileService.refreshToken()`             |
| `ToolOAuthService.refreshToken()`    | `tool-oauth-service.ts:415`  | `AuthProfileService.refreshToken()`             |
| `resolveOAuth2Headers()`             | `mcp-auth-resolver.ts:73`    | `AuthProfileService.resolveClientCredentials()` |

**Unified refresh uses:**

- `linkedAppProfileId` instead of env vars for clientId/clientSecret
- Distributed lock for all token types (not just connector connections)
- Consistent status tracking (`expired`, `revoked`, `invalid`)
- `lastUsedAt` and `lastValidatedAt` on all profiles

### 7.5 Encryption Simplification

**Current:** Each model has its own encryption setup:

- 7 models use `encryptionPlugin` with different field lists
- 1 model (ConnectorConnection) uses manual encryption
- Mixed config fields (ChannelConnection.config.encryptedInboundAuthToken) encrypted manually

**Auth Profile:** Single `encryptedSecrets` field on AuthProfile document:

- All sensitive values in one AES-256-GCM encrypted JSON blob
- `encryptionKeyVersion` for rotation tracking
- `previousEncryptedSecrets` for grace period during rotation
- Consumer models store only `authProfileId` — no encrypted fields at all

### 7.6 New Capabilities Enabled by Auth Profile

| Capability                     | Currently                                         | With Auth Profile                                                |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| Tenant-level OAuth app config  | Env vars shared across all tenants                | `oauth2_app` profile per tenant/project                          |
| Project-level auth override    | Not supported                                     | Project-scoped profiles override tenant-level                    |
| Two-layer OAuth                | Partially: separate models for app vs user creds  | Unified: `oauth2_app` linked to `oauth2_token`                   |
| Pre-flight auth consent        | Not supported                                     | Compiler bubbles `per_user` requirements up                      |
| Auth type validation           | No enforcement at link time                       | Validated when consumer links to profile                         |
| Credential rotation with grace | Not supported                                     | `rotationPolicy` + `previousEncryptedSecrets`                    |
| Status tracking                | Inconsistent across models                        | Uniform `active/expired/revoked/invalid`                         |
| Audit trail                    | Per-model audit plugins                           | Single `createdAt/updatedAt` + audit events                      |
| Cross-consumer reuse           | Not possible (credentials embedded in each model) | One profile, many consumers via `authProfileId`                  |
| 17 auth types                  | 5-6 per model                                     | All 17 types available for any consumer                          |
| Addon layers                   | Not supported                                     | Signing, JWT wrapping, webhook verification, cert pinning, proxy |

### 7.7 Migration Risk Areas

1. **`findCredentialById` without tenantId** (llm-resolution-repo.ts:400) — violates isolation, must be
   replaced with `findOne({ _id, tenantId })` when migrating to AuthProfile lookups.

2. **ConnectorConnection manual encryption** — since the model opts out of encryptionPlugin, migration
   must ensure the new `authProfileId` reference approach doesn't break the OAuth refresh cycle that
   currently uses `findOneAndUpdate` with pre-encrypted values.

3. **Channel connection resolver without tenantId** (connection-resolver.ts:26-28) — inbound routing
   queries by `channelType + externalIdentifier` without tenantId. Auth Profile resolution requires
   tenantId. The tenantId is available on the matched connection document, so the profile can be
   loaded after the initial lookup.

4. **ServiceNode without tenantId** (service-node.model.ts:75) — uses `skipTenantScoping`. The
   AuthProfile it references will have tenantId, creating a cross-table join pattern.

5. **In-memory OAuth state stores** — `ToolOAuthService` and `ChannelOAuthService` share the
   `OAuthStateStore` interface. Auth Profile should continue using this pattern (Redis preferred
   for multi-pod) but unify the state format.

6. **ProviderConfigRegistry** (600+ Nango configs) — still needed for provider metadata (token URLs,
   refresh URLs, etc.) even after Auth Profile. The `oauth2_app` profile stores these URLs but Nango
   provides defaults for quick setup.

7. **Credential age monitoring** — Currently scans 3 separate collections. Must be updated to scan
   the single `auth_profiles` collection with the unified status/expiry fields.
