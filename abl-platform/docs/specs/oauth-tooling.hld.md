# High-Level Design: OAuth Tooling

**Date:** 2026-03-23
**Status:** PLANNED
**Feature:** [oauth-tooling](../features/oauth-tooling.md)
**Test Spec:** [oauth-tooling](../testing/oauth-tooling.md)

---

## 1. Architecture Overview

OAuth Tooling unifies tool-level OAuth credential management under the existing Auth Profile system. The design introduces three new integration points -- Studio OAuth Config UI, Studio OAuth Consent Flow, and Runtime Auth Profile-based tool credential resolution -- while preserving backward compatibility with the legacy `ToolOAuthService` via a feature flag.

### System Context

```
                    +-----------------+
                    |   Studio UI     |
                    | (HttpConfigForm)|
                    +--------+--------+
                             |
                    [1] Configure tool auth
                    [2] Initiate OAuth flow
                    [3] Test connection
                             |
                    +--------v--------+
                    | Studio API      |
                    | (Next.js routes)|
                    +--------+--------+
                             |
          +------------------+------------------+
          |                  |                  |
  +-------v-------+  +------v------+  +--------v--------+
  | Auth Profile   |  | OAuth Flow  |  | Tool Test       |
  | Service        |  | Handler     |  | Service         |
  | (CRUD + link)  |  | (PKCE+state)|  | (health check)  |
  +-------+-------+  +------+------+  +--------+--------+
          |                  |                  |
          +------------------+------------------+
                             |
                    +--------v--------+
                    |   MongoDB       |
                    | (AuthProfile,   |
                    |  ProjectTool)   |
                    +--------+--------+
                             |
                    +--------v--------+
                    | Redis           |
                    | (OAuth state,   |
                    |  CC token cache,|
                    |  refresh locks) |
                    +-----------------+

                    +-----------------+
                    |   Runtime       |
                    | (tool execution)|
                    +--------+--------+
                             |
                    [4] Resolve credentials
                    [5] Apply auth headers
                    [6] Refresh if expired
                             |
          +------------------+------------------+
          |                  |                  |
  +-------v-------+  +------v------+  +--------v--------+
  | Secrets        |  | Token       |  | applyAuth       |
  | Provider       |  | Refresh Svc |  | Dispatcher      |
  | (Auth Profile  |  | (distributed|  | (headers/TLS)   |
  |  resolver)     |  |  locking)   |  |                 |
  +-----------------+  +-------------+  +-----------------+
```

---

## 2. Component Design

### 2.1 Studio OAuth Config Panel

**Location:** `apps/studio/src/components/tools/OAuthConfigPanel.tsx`

New component rendered inside `HttpConfigForm` when `auth` is `oauth2_client` or `oauth2_user`.

**Props:**

```typescript
interface OAuthConfigPanelProps {
  authType: 'oauth2_client' | 'oauth2_user';
  projectId: string;
  authProfileId?: string;
  scopes?: string[];
  onAuthProfileChange: (profileId: string | undefined) => void;
  onScopesChange: (scopes: string[]) => void;
}
```

**Sub-components:**

- `AuthProfileSelector` -- dropdown of `oauth2_app` profiles for the current project, fetched via `GET /api/projects/:projectId/auth-profiles?authType=oauth2_app`
- `ScopeEditor` -- multi-select/tag input for OAuth scopes, pre-populated from the linked `oauth2_app`'s `defaultScopes`
- `ConnectAccountButton` (only for `oauth2_user`) -- initiates the OAuth authorization code flow
- `TokenStatusBadge` -- shows current token health for the linked profile

### 2.2 Studio OAuth Flow Handler

**Location:** `apps/studio/src/app/api/oauth/tool-auth/route.ts`

Server-side Next.js route that handles the OAuth authorization code flow for tools.

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/oauth/tool-auth/initiate` | Generate authorization URL with PKCE |
| GET | `/api/oauth/tool-auth/callback` | Handle IdP redirect, exchange code for tokens |

**Flow:**

1. **Initiate:** Studio frontend calls `POST /api/oauth/tool-auth/initiate` with `{ authProfileId, scopes, redirectUri }`.
2. Server loads the `oauth2_app` Auth Profile, generates PKCE `code_verifier` + `code_challenge` (S256), creates CSPRNG state, stores `{ state, code_verifier, authProfileId, userId, tenantId }` in Redis with 10-minute TTL.
3. Returns `{ authUrl }` with all OAuth parameters.
4. **Callback:** IdP redirects to `GET /api/oauth/tool-auth/callback?code=...&state=...`.
5. Server retrieves and deletes state from Redis (atomic), exchanges code + `code_verifier` for tokens at the `oauth2_app`'s `tokenUrl`.
6. Creates a new `oauth2_token` Auth Profile linked to the `oauth2_app` via `linkedAppProfileId`, scoped to the user (`visibility: 'personal'`).
7. Redirects user back to Studio tool editor with success indicator.

**Security:**

- PKCE S256 mandatory for all flows
- State validated before code exchange
- `clientSecret` never sent to browser
- Redirect URI validated against allowlist
- Token exchange uses server-side `httpsPost` (avoiding `fetch` dual-stack issues per `oauth-http.ts`)

### 2.3 Tool Test Service

**Location:** `apps/studio/src/services/tool-test-service.ts` (extends existing)

The existing `tool-test-service.ts` is extended to resolve OAuth credentials when testing OAuth-authenticated tools.

**Resolution chain:**

1. Load tool's linked Auth Profile
2. For `oauth2_client` tools: call `resolveClientCredentialsToken` to get an access token
3. For `oauth2_user` tools: load the user's `oauth2_token` Auth Profile for this tool's connector
4. Call `applyAuth` to set headers
5. Execute test request with resolved headers

### 2.4 Runtime Auth Profile Resolution

**Location:** Extensions to `apps/runtime/src/services/secrets-provider.ts`

The existing `AuthProfileResolver` interface in `RuntimeSecretsProvider` is already defined. This design wires it to the full Auth Profile chain:

**Resolution order (existing + new):**

1. Special keys (`auth_token`, `bearer_token`) -> session authToken
2. **Auth Profile resolution (enhanced):**
   a. Check if the executing tool has an `authProfileId` (loaded from ProjectTool document at session init)
   b. If `authProfileId` is set, load the Auth Profile by `{ _id: authProfileId, tenantId }`
   c. For `oauth2_client_credentials`: call `resolveClientCredentialsToken` to get/cache access token
   d. For `oauth2_token` (per-user): load the user's token profile by `{ linkedAppProfileId, createdBy: userId, tenantId }`
   e. Check `needsProactiveRefresh` -> trigger `refreshOAuth2Token` if needed
   f. Return decrypted secrets via `applyAuth`
3. Legacy Auth Profile resolver (by secret key pattern, when `authProfileId` is not set)
4. Encrypted DB-backed ToolSecret (legacy fallback)
5. Agent IR tool credentials config map
6. undefined (with warning)

### 2.5 Token Health Service

**Location:** `packages/shared/src/services/auth-profile/token-health.ts` (new)

Computes token health status from Auth Profile documents.

```typescript
type TokenHealthStatus = 'active' | 'expiring' | 'expired' | 'revoked' | 'unknown';

interface TokenHealth {
  status: TokenHealthStatus;
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  profileId: string;
}

function computeTokenHealth(profile: {
  status: string;
  config: Record<string, unknown>;
}): TokenHealthStatus {
  if (profile.status === 'revoked') return 'revoked';
  if (profile.status === 'expired') return 'expired';
  if (profile.status !== 'active') return 'unknown';

  const expiresAt = profile.config?.expiresAt as string | undefined;
  if (!expiresAt) return 'active'; // Non-expiring token
  const expiryMs = new Date(expiresAt).getTime();
  if (expiryMs < Date.now()) return 'expired';
  if (expiryMs < Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}
```

### 2.6 Connector OAuth Migration

**Migration path:**

1. `connector-oauth.ts` `initiateConnectorOAuth` redirected to create an `oauth2_app` Auth Profile from the connector catalog entry, then use the standard Auth Profile OAuth flow.
2. `consumePendingState` replaced by `RedisOAuthStateStore.getAndDelete`.
3. Callback creates `oauth2_token` Auth Profile instead of storing inline tokens in `ConnectorConnection`.
4. `ConnectorConnection` model gains an `authProfileId` field; existing inline tokens migrated via background job.

---

## 3. Data Model Changes

### 3.1 ProjectTool Extension

```
Collection: project_tools (existing)

New fields:
{
  authProfileId:   string | null    // Linked Auth Profile ID (oauth2_app or oauth2_client_credentials)
  oauthScopes:     string[] | null  // Scopes to request for this tool's OAuth flow
}
```

### 3.2 ConnectorConnection Extension

```
Collection: connector_connections (existing)

New fields:
{
  authProfileId:   string | null    // Linked Auth Profile ID (replaces inline tokens)
}
```

### 3.3 No New Collections

All OAuth data is stored in the existing `auth_profiles` collection. No new collections are introduced.

---

## 4. Twelve Architectural Concerns

### 4.1 Tenant Isolation

- Auth Profile queries always include `tenantId` in the filter: `findOne({ _id, tenantId })`
- Cross-tenant auth profile linking returns 404 (not 403) via `validateLinkedAppProfile`
- Token health queries scoped to `tenantId` + `projectId`
- OAuth state stored with `tenantId` -- callback validates state matches request tenant

### 4.2 Project Isolation

- Tool-to-Auth-Profile links validated at the project level
- `oauth2_token` profiles created with `projectId` from the tool's project
- Tool test service resolves credentials within project scope

### 4.3 User Isolation

- `oauth2_user` tokens stored with `visibility: 'personal'` and `createdBy = userId`
- Token resolution for per-user tools filters by `createdBy = userId` (from session)
- Users cannot see or use other users' OAuth tokens

### 4.4 Authentication & Authorization

- Studio OAuth routes use `authMiddleware` (JWT verification)
- OAuth callback uses `unifiedAuth` without `requireAuth` (IdP redirects don't carry JWT)
- Callback validates state parameter (CSRF protection)
- Tool CRUD requires `requireProjectPermission(req, res, 'tools:write')`

### 4.5 Encryption at Rest

- All tokens encrypted via `encryptionPlugin` (AES-256-GCM, tenant-scoped keys)
- `clientSecret` encrypted in `oauth2_app` Auth Profile `encryptedSecrets`
- `accessToken` and `refreshToken` encrypted in `oauth2_token` Auth Profile `encryptedSecrets`
- No plaintext tokens in Redis (OAuth state stores metadata only, not tokens)

### 4.6 Encryption in Transit

- All IdP communication over HTTPS (validated by `oauth-http.ts` helper)
- Studio-to-API communication over HTTPS in production
- Redis connections use TLS in production (via `rediss://` protocol)

### 4.7 Traceability

- OAuth operations emit `TraceEvent`s via `auth-profile/trace-events.ts`:
  - `OAUTH_FLOW_INITIATED`, `OAUTH_CALLBACK_RECEIVED`, `OAUTH_TOKEN_EXCHANGED`
  - `REFRESH_START`, `REFRESH_SUCCESS`, `REFRESH_ERROR`
  - `TOKEN_RESOLUTION_START`, `TOKEN_RESOLUTION_SUCCESS`, `TOKEN_RESOLUTION_FALLBACK`
- Tool execution traces include Auth Profile ID and resolution path

### 4.8 Performance

- Client credentials tokens cached in Redis with TTL (existing `resolveClientCredentialsToken`)
- Auth Profile resolution cached in-memory with 60s TTL and 100-entry max (`authProfileCache` in `RuntimeSecretsProvider`)
- Token health computed from DB fields (no external calls), cached in tool list API response
- PKCE code verifier generated once per flow (no repeated crypto operations)

### 4.9 Compliance

- Tokens have configurable TTLs via Auth Profile `expiresAt`
- Token revocation cascades through `auth_profiles.status = 'revoked'`
- Right to erasure: deleting a user cascades to their `personal` visibility Auth Profiles
- Audit log entries for token creation, refresh, revocation, and deletion

### 4.10 Stateless Distributed

- OAuth pending state in Redis (not in-memory) for multi-pod safety
- Token refresh uses Redis distributed locks (`SET NX PX`)
- Client credentials token cache in Redis
- No pod-local state as source of truth

### 4.11 Error Handling

- All OAuth errors return `{ success: false, error: { code, message } }` envelope
- Error codes: `OAUTH_STATE_EXPIRED`, `OAUTH_STATE_INVALID`, `OAUTH_TOKEN_EXCHANGE_FAILED`, `OAUTH_REDIRECT_URI_BLOCKED`, `AUTH_PROFILE_NOT_FOUND`, `AUTH_PROFILE_LINK_INVALID`
- Token refresh failures logged and traced; tool execution falls through to error response with remediation guidance
- Network timeouts to IdP: 15s for token exchange, 5s for test connection (fail-open for health checks)

### 4.12 Backward Compatibility

- `RuntimeSecretsProvider` resolves via Auth Profile whenever a consumer has `authProfileId`
- Legacy `ToolOAuthService` with `EndUserOAuthToken` store continues to work when flag is off
- Legacy `connector-oauth.ts` in-memory store remains operational during migration period
- Tool schema validation accepts both old format (`authConfig.token`) and new format (`authConfig.authProfileId`)

---

## 5. API Contracts

### 5.1 Studio API: Initiate Tool OAuth

```
POST /api/oauth/tool-auth/initiate
Content-Type: application/json
Authorization: Bearer <jwt>

Request:
{
  "authProfileId": "<oauth2_app profile ID>",
  "scopes": ["read", "write"],
  "redirectUri": "https://studio.example.com/oauth/callback"
}

Response 200:
{
  "success": true,
  "data": {
    "authUrl": "https://accounts.google.com/o/oauth2/auth?client_id=...&code_challenge=...&state=...",
    "state": "<64 hex chars>"
  }
}

Response 400:
{
  "success": false,
  "error": {
    "code": "OAUTH_REDIRECT_URI_BLOCKED",
    "message": "Redirect URI not in allowed origins"
  }
}
```

### 5.2 Studio API: Tool OAuth Callback

```
GET /api/oauth/tool-auth/callback?code=<auth_code>&state=<state>

Response 302:
Location: /projects/<projectId>/tools/<toolId>?oauth=success

Response 400 (invalid state):
{
  "success": false,
  "error": {
    "code": "OAUTH_STATE_INVALID",
    "message": "Invalid or expired OAuth state"
  }
}
```

### 5.3 Tool Test Connection

```
POST /api/projects/:projectId/tools/:toolId/test
Authorization: Bearer <jwt>

Response 200:
{
  "success": true,
  "data": {
    "status": 200,
    "latencyMs": 342,
    "headers": { "content-type": "application/json" }
  }
}

Response 200 (failure):
{
  "success": false,
  "error": {
    "code": "OAUTH_TOKEN_EXPIRED",
    "message": "Access token expired. Reconnect your account."
  }
}
```

### 5.4 Token Health Endpoint

```
GET /api/projects/:projectId/tools?includeTokenHealth=true
Authorization: Bearer <jwt>

Response 200:
{
  "success": true,
  "data": [
    {
      "id": "tool-1",
      "name": "google_calendar",
      "auth": "oauth2_user",
      "tokenHealth": {
        "status": "active",
        "expiresAt": "2026-03-24T12:00:00Z",
        "profileId": "auth-profile-123"
      }
    },
    {
      "id": "tool-2",
      "name": "slack_api",
      "auth": "oauth2_client",
      "tokenHealth": {
        "status": "expiring",
        "expiresAt": "2026-03-23T18:00:00Z",
        "profileId": "auth-profile-456"
      }
    }
  ]
}
```

---

## 6. Alternatives Considered

| Alternative                                         | Rejected Because                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Store OAuth tokens directly in ProjectTool document | Violates single responsibility; duplicates encryption/rotation logic already in Auth Profile                                       |
| Use `simple-oauth2` library for token exchange      | `token-refresh-service.ts` already uses native `fetch` successfully; adding a dependency for the same functionality is unnecessary |
| WebSocket-based OAuth flow for runtime consent      | Increases complexity; HTTP redirect flow is standard and works across all clients                                                  |
| Separate OAuth token collection (not Auth Profile)  | Auth Profile already supports `oauth2_token` with encryption, tenant isolation, and lifecycle management                           |
| Client-side PKCE only (no server state)             | Server must validate state for CSRF protection; PKCE alone does not protect against state forgery                                  |

---

## 7. Migration Strategy

### Phase 1: Auth Profile Integration (Non-Breaking)

- Add `authProfileId` field to `ProjectTool` schema
- Add `OAuthConfigPanel` to `HttpConfigForm`
- Wire `RuntimeSecretsProvider` to resolve via Auth Profile chain
- No global feature flag is required; rollout happens per consumer by setting `authProfileId`

### Phase 2: Studio OAuth Flow

- Add `/api/oauth/tool-auth/initiate` and `/callback` routes
- Add `ConnectAccountButton` to `OAuthConfigPanel`
- PKCE + Redis state management

### Phase 3: Token Health & Testing

- Add `token-health.ts` service
- Add `TokenStatusBadge` component
- Extend tool test service for OAuth credential resolution

### Phase 4: Connector OAuth Migration

- Add `authProfileId` to `ConnectorConnection`
- Migrate `connector-oauth.ts` to Auth Profile flow
- Background migration job for existing inline tokens
- Deprecate in-memory `pendingStates` in `connector-oauth.ts`
