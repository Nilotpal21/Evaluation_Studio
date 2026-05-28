# Auth Profiles & Connections

Everything you need to know about how auth profiles and connections work in this platform.

---

## 1. The Big Picture

The platform handles the **entire OAuth lifecycle natively**. There is no runtime dependency on Nango or Activepieces for auth — both are build-time data sources only.

```
Build time:
  Activepieces npm packages  →  connector-catalog.json   (38 connectors: auth type, scopes, OAuth URLs)
  Nango providers.yaml       →  providers.json           (600+ providers: enriched OAuth metadata)

Runtime:
  Auth Profile  ──linked──▶  ConnectorConnection  (credential-less bridge record)
       │
       ▼
  EndUserOAuthToken  (access + refresh tokens, encrypted at rest)
```

**Auth Profile** = the credential configuration (clientId/clientSecret, API key, bearer token, etc.)  
**ConnectorConnection** = a binding record that says "this integration uses this auth profile" — holds no credentials itself  
**EndUserOAuthToken** = the live OAuth grant (access token + refresh token) for a user or tenant

---

## 2. Auth Profile Types

| `authType`                  | What it stores                                       | Status flow                                             |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `oauth2_app`                | clientId + clientSecret (the OAuth app registration) | `pending_authorization` → `active` after OAuth callback |
| `oauth2_token`              | accessToken + refreshToken (legacy, system-managed)  | Created internally — cannot be created manually         |
| `oauth2_client_credentials` | clientId + clientSecret for machine-to-machine       | Created with `active` status; grant fetched inline      |
| `api_key`                   | API key value                                        | Created as `active`                                     |
| `bearer`                    | Bearer token                                         | Created as `active`                                     |
| `basic`                     | username + password                                  | Created as `active`                                     |
| `custom_header`             | arbitrary header key/value pairs                     | Created as `active`                                     |
| `aws_iam`                   | accessKeyId + secretAccessKey + region               | Created as `active`                                     |
| `azure_ad`                  | tenantId + clientId + clientSecret + resource        | Created as `active`                                     |
| `mtls`                      | client cert + key + optional CA                      | Created as `active`                                     |
| `ssh_key`                   | private key + passphrase                             | Created as `active`                                     |

---

## 3. Where Fields Come From (per integration)

When the UI renders the form for a specific integration (e.g. Gmail), the field list comes from a **three-layer merge** performed at API response time by `integration-provider-service.ts:buildIntegrationProviders()`.

### Layer 1 — Activepieces catalog (`connector-catalog.json`)

Generated at build time by `pnpm connectors:generate-catalog`. Provides:

- Which connectors exist
- The auth type for each connector
- OAuth authorization URL, token URL
- Default scopes (`auth.oauth2.scopes` on the AP piece)

### Layer 2 — Nango provider config (`providers.json`)

Generated at build time by `pnpm connectors:import-providers` from Nango's `providers.yaml` on GitHub. Provides:

- Better/corrected OAuth URLs (overrides AP's if present)
- `connectionConfig` fields — extra per-integration fields like subdomain, tenant slug, etc.
- PKCE flag
- Fallback default scopes (used only if AP has none)

Mapped via `NANGO_ALIAS_MAP` (e.g. `gmail → google`, `slack → slack`).

### Layer 3 — Platform overrides

`CONNECTOR_AUTH_TYPE_OVERRIDES` and `CONNECTOR_AUTH_PREFILL` in the platform config.

### Scope resolution (priority order)

```
1. Activepieces piece's auth.oauth2.scopes  (primary)
2. Nango provider's default_scopes          (fallback)
```

### Dynamic `connectionConfig` fields

These are integration-specific extra fields shown in the form (e.g. "Subdomain" for a Jira install). They come from Nango's `connection_config` section. Resolved at OAuth URL build time via `{{connectionConfig.fieldName}}` template placeholders.

---

## 4. Where Auth Profiles Are Stored

**Model:** `packages/database/src/models/auth-profile.model.ts`  
**Collection:** `auth_profiles`

Key fields:

```
_id           — profile ID
tenantId      — tenant isolation
name          — human-readable name
authType      — see table above
scope         — 'tenant' | 'project'
visibility    — 'shared' | 'personal'
projectId     — if scope is 'project'
createdBy     — owning user (for personal profiles)
config        — non-secret config (OAuth URLs, scopes, headerName, etc.)
encryptedSecrets — JSON blob of secrets, encrypted at rest by encryptionPlugin
linkedAppProfileId — for oauth2_token: points to the parent oauth2_app profile
connector     — connector name (e.g. 'gmail'), if integration-backed
status        — 'pending_authorization' | 'active' | 'inactive' | 'expired'
```

**Encryption:** `encryptedSecrets` is auto-encrypted by the Mongoose `encryptionPlugin` (AES-256-GCM, tenant-scoped DEK). Plaintext at the model boundary; never written to MongoDB in cleartext.

**No separate microservice.** Auth profile CRUD lives in:

- Studio Next.js routes — project-scoped: `apps/studio/src/app/api/projects/[id]/auth-profiles/`
- Studio Next.js routes — workspace-scoped: `apps/studio/src/app/api/admin/auth-profiles/`
- Runtime Express routes — external API: `apps/runtime/src/routes/auth-profiles.ts`

---

## 5. Full Creation Flow (UI → DB)

```
AuthProfileSlideOver.tsx
  └─ handleSave()
       └─ POST /api/projects/:id/auth-profiles

Studio route handler:
  1. Validate via CreateAuthProfileSchema
  2. SSRF-validate OAuth URLs
  3. Set status:
       oauth2_app / oauth2_token  →  'pending_authorization'
       everything else            →  'active'
  4. AuthProfile.create()  [encryptionPlugin encrypts secrets before write]
  5. createBridgeForProfile()  →  upsert ConnectorConnection (no credentials)
  6. For oauth2_client_credentials: run client_credentials grant inline → flip to 'active'
  7. For oauth2_app: return profile with status 'pending_authorization'
        UI opens OAuth popup (see Section 6)
```

---

## 6. OAuth Connection Flow (`oauth2_app` — e.g. Gmail)

This is a two-phase flow. Phase 1 creates the profile skeleton; Phase 2 completes the authorization.

### Phase 1 — Profile created (status: `pending_authorization`)

Auth profile saved to MongoDB. ConnectorConnection bridge upserted. UI shows "Authorize" button.

### Phase 2 — Initiate

```
POST /api/projects/:id/auth-profiles/oauth/initiate

1. Load oauth2_app profile, decrypt clientId
2. Build authorizationUrl with:
     client_id, redirect_uri, response_type=code
     scopes (from profile config)
     PKCE challenge (if provider requires it)
     connectionConfig template values
     authorizationParams from profile config
3. Generate 32-byte random state token
4. Store state in Redis:
     key: auth-profile:oauth-state:{tenantId}:{state}
     TTL: 10 minutes
5. Return { authUrl, state } → UI opens popup
```

### Phase 3 — Callback (user authenticated at provider)

```
POST /api/projects/:id/auth-profiles/oauth/callback

1. Redis GETDEL on state (atomic — prevents replay attacks)
2. Verify tenant + project + user ownership match state payload
3. Load oauth2_app profile, decrypt clientId + clientSecret
4. Exchange code for tokens:
     POST tokenUrl
     grant_type=authorization_code
     client_id, client_secret, redirect_uri, code
     code_verifier (if PKCE was used)
5. parseTokenResponse() → { accessToken, refreshToken, expiresIn, scope }
6. upsertOAuthGrant():
     EndUserOAuthToken upserted with:
       provider = "auth-profile:{profileId}"
       userId   = '__tenant__' (shared) | actual userId (personal)
       encryptedAccessToken, encryptedRefreshToken  [encrypted by plugin]
       scope, expiresAt, consentedAt
7. Flip AuthProfile.status → 'active'
```

**Token storage model:** `packages/database/src/models/end-user-oauth-token.model.ts`  
**Collection:** `end_user_oauth_tokens`  
Unique index: `{ tenantId, userId, provider }`

---

## 7. How Tokens Are Resolved at Tool Execution Time

When an agent tool fires (e.g. "send Gmail"), the resolution chain is:

```
resolveToolAuth()  [apps/runtime/src/services/auth-profile/resolve-tool-auth.ts]
  │
  ├─ Finds auth profile by name (resolveByName)
  │
  ├─ For oauth2_app / oauth2_token:
  │     resolveOAuthGrantAccessToken()
  │       └─ oauthService.getAccessToken()  [ToolOAuthService]
  │             ├─ Looks up EndUserOAuthToken by (tenantId, userId/tenant, provider)
  │             ├─ Checks scope coverage
  │             ├─ Checks expiry (Date.now() + 60s buffer)
  │             │     └─ If expired + has refresh token → refreshAuthProfileToken()
  │             └─ decryptForTenant(encryptedAccessToken) → plaintext token
  │
  └─ For all other auth types:
        applyAuth() → sets Authorization header based on authType
```

**Connection mode:**

- `shared` → `userId = '__tenant__'` (one token for all users)
- `per_user` → `userId = actual user ID` (each user needs their own OAuth grant)

---

## 8. Token Refresh Mechanism

### Trigger

Reactive only — triggered on-demand when `getAccessToken` detects the stored token is within **60 seconds** of expiry:

```ts
const isExpired = record.expiresAt && record.expiresAt.getTime() < Date.now() + 60_000;
```

> Note: `needsProactiveRefresh()` (5-minute buffer) is exported from the package and visible in tests but is not called anywhere in the production path.

### Refresh flow

```
refreshOAuth2Token()  [packages/shared-auth-profile/src/token-refresh-service.ts]
  │
  1. Acquire distributed Redis lock
  │    key: refresh-lock:{tenantId}:{profileId}:{userId}
  │    If another pod holds the lock: poll for completion (max 2s), return updated token
  │
  2. Load refresh target based on authType:
  │    oauth2_token  → reads AuthProfile.encryptedSecrets for refreshToken
  │    oauth2_app    → reads EndUserOAuthToken for encryptedRefreshToken
  │    oauth2_app + authScope:session → reads SessionOAuthArtifact
  │
  3. Resolve app credentials (clientId, clientSecret, tokenUrl):
  │    oauth2_token  → loads linkedAppProfileId profile
  │    oauth2_app    → profile IS the app (uses its own _id)
  │
  4. POST tokenUrl
  │    grant_type=refresh_token
  │    refresh_token, client_id, client_secret
  │    (+ provider-specific tokenParams from Nango config if present)
  │
  5. persistTokens() → save new tokens to DB
  │
  6. Return { accessToken (plaintext), refreshToken, expiresAt, scope, refreshed: true }
  │
  7. Release Redis lock (finally block)
```

### Three refresh storage targets

| Auth scope                         | Storage                          | Model                  |
| ---------------------------------- | -------------------------------- | ---------------------- |
| `tenant` / `user` (oauth2_app)     | `end_user_oauth_tokens`          | `EndUserOAuthToken`    |
| `session` (oauth2_app, chat flows) | `session_oauth_artifacts`        | `SessionOAuthArtifact` |
| Legacy `oauth2_token`              | `auth_profiles.encryptedSecrets` | `AuthProfile`          |

### Client credentials (separate path)

`oauth2_client_credentials` tokens are handled entirely by `client-credentials-service.ts` with Redis caching:

- Cache key: `auth-profile:cc-token:{profileId}:{tenantId}`
- TTL: `expires_in - 60s`
- No refresh needed — fetches a new token when cache misses

---

## 9. Token Lifetimes

| Token                    | Typical lifetime                        | Notes                                         |
| ------------------------ | --------------------------------------- | --------------------------------------------- |
| Google access token      | 1 hour                                  | Standard across all Google APIs               |
| Microsoft access token   | 1 hour                                  | Azure AD default                              |
| Slack access token       | Non-expiring (legacy) or 12h (granular) | Depends on scopes requested                   |
| Google refresh token     | Does not expire                         | Revoked on password change or explicit revoke |
| Microsoft refresh token  | 90 days sliding window                  | Resets on each use                            |
| OAuth state (CSRF)       | 10 minutes                              | Redis TTL, deleted on use                     |
| client_credentials token | Provider-defined (`expires_in`)         | Cached in Redis, refetched on miss            |
| Session OAuth artifact   | Tied to session TTL                     | Auto-deleted via MongoDB TTL index            |

---

## 10. ConnectorConnection — What It Is and Isn't

`packages/database/src/models/connector-connection.model.ts`  
Collection: `connector_connections`

**What it stores:**

```
tenantId, projectId
connectorName     — e.g. 'gmail'
authProfileId     — reference to the AuthProfile
scope             — 'tenant' | 'project'
status            — 'active' | 'inactive'
```

**What it does NOT store:** credentials, tokens, secrets. Zero. It is purely a binding record.

**Auto-created:** When an auth profile with a `connector` field is created via the Studio project route, `createBridgeForProfile()` automatically upserts a `ConnectorConnection`. You don't create these manually.

**Used by:** `ConnectionResolver` (`packages/connectors/src/auth/connection-resolver.ts`) — resolves credentials by delegating to the auth profile system, optionally merging OAuth grant tokens for `oauth2_app` profiles.

---

## 11. Known Bugs Fixed

### Bug 1 — Refresh returned ciphertext as access token (critical)

**Location:** `token-refresh-service.ts` (both `packages/shared-auth-profile` and `packages/shared`)

**What happened:** After `persistTokens()` called `grant.save()`, the Mongoose `encryptionPlugin` pre-save hook overwrote the in-memory `grant.encryptedAccessToken` with AES-GCM ciphertext. `parseStoredGrantTokens(grant)` read this ciphertext and returned it as the `accessToken`. Every downstream API call post-refresh sent `Authorization: Bearer <ciphertext>` → 401.

**Fix:** Return the raw token values directly from the OAuth response (`tokens.accessToken`) instead of reading back from the post-save document.

### Bug 2 — No distributed lock during auth-profile token refresh

**Location:** `tool-oauth-service.ts:refreshAuthProfileToken()`

**What happened:** `refreshOAuth2Token` was called without a `redis` client, silently bypassing the `if (params.redis)` lock guard. Multiple pods could simultaneously refresh the same token.

**Fix:** Pass `getRedisClient()` to `refreshOAuth2Token` so the `SET NX PX` distributed lock is acquired.

---

## 12. Key File Map

| Concern                                        | File                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| UI form for auth profiles                      | `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`           |
| Form field schema per auth type                | `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`              |
| Provider catalog merge (build-time enrichment) | `apps/studio/src/lib/integration-provider-service.ts`                         |
| Studio CRUD routes                             | `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`                |
| OAuth initiate route                           | `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts` |
| OAuth callback route                           | `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts` |
| Runtime CRUD route                             | `apps/runtime/src/routes/auth-profiles.ts`                                    |
| Token resolution at tool time                  | `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`                 |
| OAuth grant lookup + service                   | `apps/runtime/src/services/oauth-grant-service.ts`                            |
| ToolOAuthService (getAccessToken, refresh)     | `apps/runtime/src/services/tool-oauth-service.ts`                             |
| Token refresh logic                            | `packages/shared-auth-profile/src/token-refresh-service.ts`                   |
| App credential resolution (clientId/secret)    | `packages/shared-auth-profile/src/oauth2-app-resolver.ts`                     |
| Client credentials grant + Redis cache         | `packages/shared-auth-profile/src/client-credentials-service.ts`              |
| Apply auth to outbound HTTP                    | `packages/shared-auth-profile/src/apply-auth.ts`                              |
| Redis refresh lock                             | `packages/shared-auth-profile/src/refresh-lock.ts`                            |
| AuthProfile Mongoose model                     | `packages/database/src/models/auth-profile.model.ts`                          |
| EndUserOAuthToken model                        | `packages/database/src/models/end-user-oauth-token.model.ts`                  |
| SessionOAuthArtifact model                     | `packages/database/src/models/session-oauth-artifact.model.ts`                |
| ConnectorConnection model                      | `packages/database/src/models/connector-connection.model.ts`                  |
| Mongoose encryption plugin                     | `packages/database/src/mongo/plugins/encryption.plugin.ts`                    |
| Connector catalog generation                   | `scripts/generate-connector-catalog.ts`                                       |
| Nango provider import                          | `packages/connectors/src/adapters/nango/importer.ts`                          |
| ConnectionResolver                             | `packages/connectors/src/auth/connection-resolver.ts`                         |
