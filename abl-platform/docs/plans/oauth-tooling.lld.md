# OAuth Tooling — Low-Level Design

## Task T-1: Core ToolOAuthService

### Files

- `apps/runtime/src/services/tool-oauth-service.ts` — Core service (~550 LOC)

### Class: ToolOAuthService

Constructor dependencies:

- `tokenStore: OAuthTokenStore` — Pluggable token persistence
- `encryptor: OAuthEncryptor` — Tenant-scoped encryption
- `providerConfigs: Map<string, OAuthProviderConfig>` — Provider settings
- `stateStore?: OAuthStateStore` — Optional (defaults to InMemoryOAuthStateStore)
- `authProfileResolver?: AuthProfileOAuthResolver` — Optional auth profile integration

### Key Methods

- `registerProvider(name, config)` — Add provider config at runtime
- `getRegisteredProviders()` — List registered provider names
- `initiateOAuthFlow(provider, tenantId, userId, scopes, redirectUri)` — Generate authorization URL with CSRF state
- `handleOAuthCallback(provider, code, state)` — Exchange code, encrypt tokens, store
- `getAccessToken(tenantId, userId, provider, options?)` — Get decrypted token, auto-refresh if expired
- `revokeToken(tenantId, userId, provider)` — Revoke at provider + local mark revoked
- `initiateOAuthFlowWithAuthProfile(...)` — Flow with auth profile context
- `handleOAuthCallbackWithAuthProfile(...)` — Callback with auth profile context

### Provider Resolution

- `resolveProviderContext(params)` — Tries auth profile first (if `preferAuthProfile`), falls back to legacy config
- `resolveProviderContextById(params)` — Direct auth profile lookup by ID
- `resolveLegacyProviderContext(provider)` — Simple Map lookup

### Token Refresh

- Checks `expiresAt` against current time
- If expired and `encryptedRefreshToken` exists: POST to tokenUrl with `grant_type=refresh_token`
- Uses `compareAndSwapToken` for concurrent safety
- Preserves scope unless refresh response provides new scope
- Updates `lastUsedAt` on every access

---

## Task T-2: State Stores

### InMemoryOAuthStateStore

- `pendingStates: Map<string, PendingOAuthState>` (max 10,000, LRU eviction)
- Cleanup interval: 60 seconds (evicts expired states)
- `set(state, data)` — Store with overflow eviction
- `getAndDelete(state)` — Atomic retrieve and remove
- `destroy()` — Clear cleanup timer

### RedisOAuthStateStore

- Redis key: `oauth_state:{state}` with TTL
- `set(state, data)` — SET with EX (TTL from expiresAt)
- `getAndDelete(state)` — Atomic GETDEL (Redis >= 6.2)
- State format validation: must be 64 hex chars
- Malformed/missing field rejection

---

## Task T-3: MongoDB Token Store

### Files

- `apps/runtime/src/services/oauth-token-store.ts` — Mongo OAuthTokenStore implementation

### Key Operations

- `findToken(tenantId, userId, provider)` — Find non-revoked token, return with `__v` for CAS
- `upsertToken(params)` — Find existing + save (encryption plugin hook), or create new
- `compareAndSwapToken(params)` — Atomic update with `__v` check; supports upsert and revoke mutations
- `markRevoked(tenantId, userId, provider)` — Set `revokedAt`
- `updateLastUsed(tenantId, userId, provider)` — Set `lastUsedAt`

### CAS Edge Cases

- `expectedVersion === null` + upsert: try reactivate revoked, then create (catch dup key E11000)
- `expectedVersion === null` + revoke: return false (nothing to revoke)
- Standard CAS: `updateOne` with `__v: expectedVersion`, `$inc: { __v: 1 }`

---

## Task T-4: OAuth REST Routes

### Files

- `apps/runtime/src/routes/oauth.ts` — Express routes (~477 LOC)

### Routes

- `POST /api/v1/oauth/authorize/:provider` — Auth required, `credential:write` permission
  - Validates provider name (alphanumeric, max 64 chars)
  - Validates redirectUri against origin allowlist
  - Returns `{ success: true, authUrl, state }`

- `GET /api/v1/oauth/callback/:provider` — Uses `unifiedAuth` (no requireAuth, IdP redirects lack JWT)
  - Validates code + state query params
  - For JIT flows: renders popup result page with `postMessage`
  - For standard flows: returns JSON success

- `GET /api/v1/oauth/tokens` — Auth required, `credential:read` permission
  - Paginated listing (page, limit)
  - Returns provider names + metadata, no raw tokens

- `DELETE /api/v1/oauth/tokens/:provider` — Auth required, `credential:delete` permission
  - Revokes token and logs audit event

### Security

- Provider name: `/^[a-zA-Z0-9_-]+$/`, max 64 chars
- Redirect URI: origin must be in `security.oauthAllowedRedirectOrigins`
- Development default: `DEFAULT_LOCAL_ORIGINS` (localhost variants)
- Error messages sanitized (no internal details)
- Browser popup page uses `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`

---

## Task T-5: JIT OAuth Flow

### Design

- `jitMetadataMap: Map<state, JitOAuthMetadata>` (max 1,000 entries, 10-min TTL)
- Cleanup interval: 60 seconds
- JIT metadata: `{ sessionId, toolCallId, createdAt }`

### Flow

1. Tool execution finds no valid token
2. Runtime stores JIT metadata with OAuth state
3. WebSocket sends `authorization_required` to client
4. Client opens OAuth popup → standard flow with jitMetadata in state
5. Callback detects jitMetadata, renders popup result page
6. Popup posts message to opener
7. Client notifies runtime, execution resumes

### Rollback

- If JIT resume fails after token is stored, `rollbackPersistedJitAuthorization` restores previous token (or revokes new one) using CAS

---

## Task T-6: Auth Profile Integration

### Files

- `apps/runtime/src/services/auth-profile/auth-profile-oauth-resolver.ts` — Resolve OAuth providers from auth profiles
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` — Tool-level auth resolution

### Interface

```typescript
interface AuthProfileOAuthResolver {
  resolveProvider(params: {
    tenantId;
    userId?;
    provider;
    projectId?;
    environment?;
    scopes?;
    lookupScope?;
  }): Promise<ResolvedAuthProfileOAuthProvider | null>;
  resolveProviderById?(params: {
    tenantId;
    authProfileId;
    authProfileRef;
    scopes?;
  }): Promise<ResolvedAuthProfileOAuthProvider | null>;
}
```

### Resolution Order

1. If `preferAuthProfile` and resolver exists: try auth profile first
2. If auth profile returns result: use its config (clientId, clientSecret, scopes)
3. Otherwise: fall back to legacy `providerConfigs` Map

---

## Known Gaps

| Gap                                 | Severity | Notes                                         |
| ----------------------------------- | -------- | --------------------------------------------- |
| JIT metadata in-memory only         | Medium   | Lost on pod restart in multi-pod              |
| No PKCE support                     | Low      | Uses basic authorization code exchange        |
| No incremental consent              | Low      | Full re-authorization required for new scopes |
| Provider configs not hot-reloadable | Low      | Requires restart to pick up new providers     |

## Exit Criteria

- OAuth flow completes end-to-end (initiate → callback → stored encrypted token)
- Expired tokens refreshed automatically with CAS safety
- JIT OAuth pauses and resumes conversation correctly
- Redis state store supports multi-pod deployment
- Auth profile integration resolves providers before legacy fallback
- All unit and integration tests pass
