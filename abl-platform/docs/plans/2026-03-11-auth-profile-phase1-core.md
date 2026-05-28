# Auth Profile — Phase 1: Connector OAuth (3-4 Sprints)

> **Master design doc:** [`2026-03-11-auth-profile-design.md`](./2026-03-11-auth-profile-design.md)
> **Phase 2 (Credential Consolidation):** [`2026-03-11-auth-profile-phase2-consolidation.md`](./2026-03-11-auth-profile-phase2-consolidation.md)
> **Phase 3 (Enterprise & Cleanup):** [`2026-03-11-auth-profile-phase3-enterprise.md`](./2026-03-11-auth-profile-phase3-enterprise.md)

---

## Goal

Unblock the connector OAuth flow end-to-end. Introduce the `AuthProfile` model with the minimum set of auth types needed for connectors, wire it into the connector setup flow in Studio, and establish the foundation that Phase 2 and Phase 3 build on.

---

## 1. Auth Types (Phase 1 Only)

Phase 1 implements **6 auth types**. No others.

| `authType`                  | `config` (non-sensitive)                                                                                                                                                                                                                                          | `encryptedSecrets` (sensitive)                                | Library         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------- |
| `none`                      | ---                                                                                                                                                                                                                                                               | ---                                                           | ---             |
| `api_key`                   | `headerName`, `prefix`, `placement: 'header' \| 'query'` (default `'header'`)                                                                                                                                                                                     | `apiKey`                                                      | ---             |
| `bearer`                    | ---                                                                                                                                                                                                                                                               | `token`                                                       | ---             |
| `oauth2_app`                | `authorizationUrl`, `tokenUrl`, `refreshUrl?`, `revocationUrl?`, `deviceAuthorizationUrl?`, `tokenIntrospectionUrl?`, `defaultScopes[]`, `scopeSeparator`, `pkceRequired`, `pkceMethod: 'S256' \| 'plain'`, `supportedGrantTypes[]`, `setupGuideUrl?`, `docsUrl?` | `clientId`, `clientSecret`                                    | `simple-oauth2` |
| `oauth2_token`              | `provider`, `scopes[]`, `grantedScopes[]`, `tokenType: 'bearer' \| 'mac'`, `issuedAt?`, `expiresAt?`, `refreshTokenExpiresAt?`, `refreshTokenRotation: boolean`                                                                                                   | `accessToken`, `refreshToken?`, `idToken?`, `providerUserId?` | `simple-oauth2` |
| `oauth2_client_credentials` | `tokenUrl`, `scopes[]`                                                                                                                                                                                                                                            | `clientId`, `clientSecret`                                    | `simple-oauth2` |

> **`providerUserId` is PII** and is stored in `encryptedSecrets` (not `config`). It is only accessible via decryption, which requires `AUTH_PROFILE_DECRYPT` permission.

### `searchai` Migration Note

The compiler's `ToolAuthTypeIR` includes a `'searchai'` auth type. This type is NOT added to the Auth Profile enum. Instead:

- **Migration mapping:** `searchai` DSL auth is migrated to `oauth2_client_credentials`.
- **Field mapping:** `searchai.tokenUrl` -> `config.tokenUrl`, `searchai.clientId`/`clientSecret` -> `encryptedSecrets.clientId`/`clientSecret`. The `botId` and `headerName` fields are stored as `config.botId` and `config.customHeaderName` extension fields.

### Validation Rules (Phase 1 Types Only)

| authType                    | Required config                                             | Required secrets           |
| --------------------------- | ----------------------------------------------------------- | -------------------------- |
| `none`                      | ---                                                         | ---                        |
| `api_key`                   | `headerName`. `placement` defaults to `'header'` if omitted | `apiKey`                   |
| `bearer`                    | ---                                                         | `token`                    |
| `oauth2_app`                | `authorizationUrl`, `tokenUrl`                              | `clientId`, `clientSecret` |
| `oauth2_token`              | `provider`                                                  | `accessToken`              |
| `oauth2_client_credentials` | `tokenUrl`                                                  | `clientId`, `clientSecret` |

> The Zod schema for `none` MUST still use `.strict()` to prevent unknown fields. All config schemas use `.strict()`.

---

## 2. Addons

**None in Phase 1.** The `signing`, `webhookVerification`, and `proxy` addon fields exist in the schema (for forward-compatibility) but are not validated, not populated, and not applied. Any attempt to set addon fields in Phase 1 should be rejected with a 400 error: `"Addon mechanisms are not yet supported."` Phase 2 activates addons.

---

## 3. Core Model — `AuthProfile` Mongoose Schema

This is the **full schema** that serves as the foundation for all phases. Phase 1 implements the full document shape; only auth type validation and addon enforcement are phased.

### MongoDB Document

```typescript
{
  _id: string;
  name: string;
  description?: string;
  tenantId: string;
  projectId: string | null;         // explicit null for tenant-level, NEVER undefined
  scope: 'tenant' | 'project';
  environment: string | null;       // null = all environments
  visibility: 'shared' | 'personal';
  createdBy: string;                // immutable — set from ctx.user.id, never from request body
  authType: 'none' | 'api_key' | 'bearer' | 'basic'
    | 'oauth2_app' | 'oauth2_token' | 'oauth2_client_credentials'
    | 'custom_header' | 'aws_iam' | 'azure_ad'
    | 'ssh_key' | 'mtls';
    // Phase 3+ deferred: 'digest' | 'kerberos' | 'saml' | 'hawk' | 'ws_security'
  config: Record<string, unknown>;
  encryptedSecrets: string;
  encryptionKeyVersion: number;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
  status: 'active' | 'expired' | 'revoked' | 'invalid';
  expiresAt?: Date;
  lastValidatedAt?: Date;
  lastUsedAt?: Date;
  rotationPolicy?: object;
  previousEncryptedSecrets?: string;
  rotationGracePeriodMs?: number;
  // Addon mechanisms (present in schema, not active in Phase 1)
  signing?: object;
  webhookVerification?: object;
  proxy?: object;
  // Phase 3+ deferred: jwtWrapping?: object; certificatePinning?: object;
  // Audit
  createdAt: Date;
  updatedAt: Date;
}
```

### Schema Plugins (REQUIRED)

```typescript
AuthProfileSchema.plugin(tenantIsolationPlugin); // auto-injects tenantId into all queries
AuthProfileSchema.plugin(encryptionPlugin, {
  // auto-encrypts encryptedSecrets
  fieldsToEncrypt: ['encryptedSecrets', 'previousEncryptedSecrets'],
});
AuthProfileSchema.plugin(auditTrailPlugin); // tracks all changes
```

### Indexes

```
{ tenantId, scope }                                          // list tenant-level
{ tenantId, projectId, scope }                               // list project-level
{ tenantId, projectId, connector, authType }                 // find connector auth
{ tenantId, projectId, visibility, createdBy }               // find personal profiles
{ tenantId, projectId, connector, visibility, createdBy }    // personal profile resolution
{ tenantId, projectId, category }                            // filter by category
{ linkedAppProfileId }                                       // find all tokens for an app
{ status, expiresAt, authType }                              // cleanup expired + batch refresh
```

### Unique Constraints

Two partial unique indexes to handle `projectId: null` correctly:

```
// Tenant-level: unique name per tenant + environment
{ tenantId, name, environment }
  UNIQUE, partialFilterExpression: { projectId: null }

// Project-level: unique name per tenant + project + environment
{ tenantId, projectId, name, environment }
  UNIQUE, partialFilterExpression: { projectId: { $ne: null } }
```

---

## 4. Scoping & Resolution

### Scoping Fields

| Field         | Type                     | Description                                                                                                                            |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `tenantId`    | string                   | Always present (tenant isolation)                                                                                                      |
| `projectId`   | string (default `null`)  | `null` = tenant-level, set = project-level override. Always stored as explicit `null`, never `undefined`. Schema uses `default: null`. |
| `scope`       | `'tenant' \| 'project'`  | Scope discriminator (derived from `projectId` presence)                                                                                |
| `environment` | string?                  | Optional: `'dev' \| 'staging' \| 'production'` or null = all envs                                                                      |
| `visibility`  | `'shared' \| 'personal'` | shared = anyone in scope, personal = only creator                                                                                      |
| `createdBy`   | string                   | userId of the creator. **Immutable** --- set from `ctx.user.id` on creation, never accepted from request body, never updatable.        |

### 5-Level Resolution Query (Runtime)

Resolution priority:

1. Personal `oauth2_token` for this user + connector + environment (if `per_user`)
2. Shared `oauth2_token` for this connector + environment (if `shared`)
3. Project-level Auth Profile with matching `authProfileId` + environment
4. Project-level Auth Profile with `environment: null` (any-environment fallback)
5. Tenant-level Auth Profile fallback

```typescript
authProfileService.resolve({
  tenantId,
  projectId,
  connector: 'gmail',
  connectionMode: 'per_user' | 'shared',
  environment?: 'production',
  userId?,
}): Promise<DecryptedCredentials>
```

### `validateAuthProfileAccess` Helper

All consumers MUST validate `authProfileId` at link time:

```typescript
async function validateAuthProfileAccess(
  authProfileId: string,
  tenantId: string,
  projectId: string,
): Promise<AuthProfile> {
  const profile = await AuthProfile.findOne({
    _id: authProfileId,
    tenantId, // CRITICAL: same tenant
    $or: [
      { projectId: null }, // tenant-level: accessible by all projects
      { projectId }, // project-level: must match
    ],
  });
  if (!profile) throw new NotFoundError('Auth profile not found');
  return profile;
}
```

### Personal Profile Visibility

List queries MUST enforce visibility at the DB level, not as post-query filter:

```typescript
if (!isAdmin) {
  filter.$or = [{ visibility: 'shared' }, { visibility: 'personal', createdBy: userId }];
}
```

Tenant admins can see all personal profiles (for audit/troubleshooting), with audit logging when viewing another user's personal profile. Secrets remain redacted unless `AUTH_PROFILE_DECRYPT` permission is held.

---

## 5. Consumer Mapping (Phase 1 Only)

Phase 1 wires only connector consumers. All other consumers are Phase 2.

| Consumer                                      | Auth Profile Types Expected         | Reference Field                                           |
| --------------------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| Connector (Layer 1 --- app config)            | `oauth2_app`                        | `ConnectorConfig.authProfileId`                           |
| Connector Connection (Layer 2 --- user token) | `oauth2_token`, `api_key`, `bearer` | `ConnectorConnection.authProfileId`                       |
| Connector Config (SearchAI)                   | `oauth2_token`                      | `ConnectorConfig.authProfileId` (replaces `oauthTokenId`) |

### Dual-Read Pattern (Phase 1)

Only `ConnectorConfig` and `ConnectorConnection` get dual-read in Phase 1:

```typescript
const credential = entity.authProfileId
  ? await authProfileService.resolve({ authProfileId: entity.authProfileId, tenantId })
  : await legacyCredentialService.resolve({
      credentialId: entity.credentialId,
      tenantId,
    });
```

---

## 6. Two-Layer OAuth Model

### Layer 1: `oauth2_app` (App Credentials)

Created by project admins or workspace admins. Stores `clientId`/`clientSecret` for an OAuth app.

### Layer 2: `oauth2_token` (User Tokens)

Created when a user authorizes. Links back to Layer 1 via `linkedAppProfileId`.

```
oauth2_app (Layer 1)                    oauth2_token (Layer 2)
+---------------------+                +---------------------------+
| id: "ap-google-1"   |<---linked------| id: "up-abc123"           |
| authType: oauth2_app|                | authType: oauth2_token    |
| config:             |                | visibility: personal      |
|   authorizationUrl  |                | createdBy: user-prasanna  |
|   tokenUrl          |                | linkedAppProfileId:       |
|   defaultScopes     |                |   "ap-google-1"           |
| secrets:            |                | secrets:                  |
|   clientId          |                |   accessToken             |
|   clientSecret      |                |   refreshToken            |
+---------------------+                +---------------------------+
       ^                                        ^
       |                                        |
  Project admin                          End user (or workflow
  configures once                        developer for "shared")
```

### Cross-Reference Validation

When creating or updating an `oauth2_token`, the `linkedAppProfileId` MUST be validated:

1. Must resolve to a profile in the **same tenant** (prevents cross-tenant credential theft)
2. Must have `authType: 'oauth2_app'`
3. Must be re-validated at token refresh time (link could be tampered with)

---

## 7. Token Refresh

Token refresh applies to `oauth2_token` and `oauth2_client_credentials` only in Phase 1.

### `oauth2_token` Refresh Flow

1. Check `config.expiresAt` (configurable buffer via `AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS`, default 60s). **If `config.expiresAt` is null, proactive refresh is skipped; the 401 retry-with-refresh path handles expired tokens reactively.**
2. If expired, load `linkedAppProfileId` -> validate same tenant -> get `clientId`, `clientSecret`, `tokenUrl`
3. Acquire tenant-scoped distributed lock (Redis `SET NX PX`, TTL 30s) to prevent concurrent refresh
4. Exchange `refreshToken` for new tokens
5. If `refreshTokenRotation: true`, store new refresh token atomically
6. Update `encryptedSecrets` and `config.expiresAt`
7. Release lock

### Lock Contention Strategy

Callers that fail to acquire the lock wait with 100ms exponential backoff (max 2s), re-read from DB, and use the refreshed token if available. If still expired after max wait, fail with `AUTH_PROFILE_TOKEN_REFRESH_FAILED`.

### Redis Unavailability Policy

If Redis is unavailable (connection refused), proceed without the lock (risking a duplicate refresh) rather than failing the session. Log `auth_profile_lock_unavailable` trace event. This matches the existing behavior where `ToolOAuthService` refreshes without any lock.

> **Correctness note:** The existing `ToolOAuthService.refreshToken()` has NO distributed lock --- this is a known race condition being fixed, not just a refactoring exercise.

### `oauth2_client_credentials` Token Caching

Redis cache key: `auth-profile:cc-token:{tenantId}:{profileId}`. Shared across all sessions. TTL based on token `expires_in` minus refresh buffer. Known limitation: externally revoked tokens will be used until TTL expires.

---

## 8. API Design

### Permissions (RBAC)

New permissions in `StudioPermission`:

```typescript
AUTH_PROFILE_READ: 'auth-profile:read',     // view profile metadata, redacted secrets
AUTH_PROFILE_WRITE: 'auth-profile:write',    // create/update profiles
AUTH_PROFILE_DELETE: 'auth-profile:delete',  // delete profiles (with consumer impact check)
AUTH_PROFILE_DECRYPT: 'auth-profile:decrypt', // view decrypted secrets (admin only)
```

### Project-Scoped CRUD (Phase 1 Only)

```
GET    /api/projects/:pid/auth-profiles                # list (project + inherited tenant)
POST   /api/projects/:pid/auth-profiles                # create project-level
GET    /api/projects/:pid/auth-profiles/:id
PUT    /api/projects/:pid/auth-profiles/:id
DELETE /api/projects/:pid/auth-profiles/:id
POST   /api/projects/:pid/auth-profiles/:id/validate   # test credentials
```

**All project-level ID-based queries MUST include `projectId` in the filter**, not just `tenantId`:

```typescript
const profile = await AuthProfile.findOne({ _id: id, tenantId, projectId: params.id });
```

> **No tenant-level routes in Phase 1.** Tenant-scoped CRUD (`/api/auth-profiles/*`) is added in Phase 2.

### OAuth Flows

```
# Initiate OAuth (resolve authorization URL from oauth2_app profile)
POST   /api/projects/:pid/auth-profiles/oauth/initiate
       Body: { connectorName, authProfileId }
       Returns: { authUrl, state }
       Rate limit: { limit: 20, windowMs: 60_000, scope: 'user' }

# OAuth callback (exchange code -> create oauth2_token profile)
POST   /api/projects/:pid/auth-profiles/oauth/callback
       Body: { code, state, displayName? }
       Returns: { authProfile }
       Rate limit: { limit: 10, windowMs: 60_000, scope: 'user' }

# End-user OAuth (runtime consent flow)
POST   /api/projects/:pid/auth-profiles/oauth/user-consent
       Body: { connectorName, sessionId }
       Returns: { authUrl, state }
```

### Consumers Endpoint

```
GET    /api/projects/:pid/auth-profiles/:id/consumers
       Returns: list of entities referencing this auth profile
```

### Revoke Endpoint

```
POST   /api/projects/:pid/auth-profiles/:id/revoke
       Sets status to 'revoked', calls provider revocation endpoint if configured
```

### List Endpoint Enrichment

Project-level `GET /api/projects/:pid/auth-profiles` returns merged results:

- Project-level profiles first
- Tenant-level profiles not overridden, marked `inherited: true`
- Override defined as: same `connector` + `authType` match (not name). Overridden tenant profiles appear as `{ inherited: true, overridden: true }`
- Filtering: `?authType=oauth2_app&connector=gmail&environment=production`

---

## 9. Error Handling

### `AuthProfileError` with Typed Reasons

```typescript
class AuthProfileError extends AppError {
  constructor(
    public readonly reason: AuthProfileErrorReason,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
  }
}
```

### Error Codes (Phase 1 Subset)

| Scenario                                          | Code | Behavior                                                                                                                            |
| ------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Auth Profile not found (deleted while referenced) | 404  | Consumers with dangling `authProfileId` get: "Auth profile 'X' not found. Reconfigure authentication." Consumer status -> `invalid` |
| Token expired, refresh fails                      | 502  | `oauth2_token` status -> `expired`. Runtime returns: "Gmail authorization expired. [Re-authorize]"                                  |
| `oauth2_app` deleted while tokens exist           | 409  | Block deletion: "Cannot delete --- N active connections use this OAuth app. Revoke them first."                                     |
| Duplicate profile name in same scope              | 409  | "An auth profile named 'X' already exists in this project."                                                                         |
| Incompatible authType for consumer                | 422  | Validation at link time: "Connector Connection requires oauth2_token, api_key, or bearer. Got ssh_key."                             |
| Cross-tenant `linkedAppProfileId`                 | 400  | Reject on create/update: "Linked OAuth app must belong to the same tenant."                                                         |
| Cross-project `authProfileId` reference           | 404  | "Auth profile not accessible from this project." (unless tenant-scoped)                                                             |
| Token refresh lock contention timeout             | 503  | `AUTH_PROFILE_TOKEN_REFRESH_FAILED` --- retryable                                                                                   |
| Decryption failure                                | 500  | `AUTH_PROFILE_DECRYPTION_FAILED` --- PagerDuty alert if > 0 in production                                                           |

### Trace Events

Four trace events via `TraceStore`:

1. `auth_profile_resolved` --- successful credential resolution
2. `auth_profile_refresh` --- token refresh attempt (success/failure)
3. `auth_profile_lock_unavailable` --- Redis lock unavailable, proceeding without lock
4. `auth_profile_decryption_failed` --- decryption failure

---

## 10. Security & Compliance

### GDPR Cascade (Right to Erasure) --- Day One Requirement

Auth Profile MUST be included in both `cascade-delete.ts` AND `MongoGDPRStore` from day one:

1. **User deletion:** Delete all personal Auth Profiles where `createdBy === subjectId`

   ```typescript
   await AuthProfile.deleteMany({ createdBy: subjectId, visibility: 'personal' });
   ```

2. **Shared profiles:** Do NOT delete. Reassign `createdBy` to a system account or anonymize
3. **Token revocation:** When deleting personal `oauth2_token` profiles, call provider's revocation endpoint (if `revocationUrl` is configured in linked `oauth2_app`)
4. **User removed from project:** Revoke (not delete) their personal profiles in that project: `status: 'revoked'`
5. **Audit trail:** Log the erasure with anonymized subject ID (SHA-256 hash, matching existing `anonymizeAuditEntries` pattern)
6. **Fix pre-existing gap:** `EndUserOAuthToken` is not currently in the GDPR cascade --- fix this as part of Phase 1.

### Audit Trail Ciphertext Masking

The `auditTrailPlugin` logs full document diffs. When `encryptedSecrets` changes, the audit log contains the ciphertext blob. Fix: mask `encryptedSecrets` and `previousEncryptedSecrets` in audit diffs to `"[ENCRYPTED]"`.

### Audit Events

| Operation                    | Audit Action                    | Metadata                                     |
| ---------------------------- | ------------------------------- | -------------------------------------------- |
| Create profile               | `AUTH_PROFILE_CREATED`          | `{ profileId, authType, scope, visibility }` |
| Update profile               | `AUTH_PROFILE_UPDATED`          | `{ profileId, changedFields[] }`             |
| Delete profile               | `AUTH_PROFILE_DELETED`          | `{ profileId, authType, consumerCount }`     |
| Decrypt secrets              | `AUTH_PROFILE_SECRETS_ACCESSED` | `{ profileId, accessedBy, purpose }`         |
| Token refresh                | `AUTH_PROFILE_TOKEN_REFRESHED`  | `{ profileId, connector, success }`          |
| Validate/test                | `AUTH_PROFILE_VALIDATED`        | `{ profileId, result }`                      |
| Status change                | `AUTH_PROFILE_STATUS_CHANGED`   | `{ profileId, from, to }`                    |
| Link consumer                | `AUTH_PROFILE_LINKED`           | `{ profileId, consumerType, consumerId }`    |
| Admin views personal profile | `AUTH_PROFILE_ADMIN_VIEWED`     | `{ profileId, adminUserId, ownerUserId }`    |

### SSRF Validation

All URL fields (`authorizationUrl`, `tokenUrl`, `refreshUrl`, `revocationUrl`, `deviceAuthorizationUrl`, `tokenIntrospectionUrl`, `setupGuideUrl`, `docsUrl`) MUST pass SSRF validation before storage. Use the existing `validateUrl()` utility.

### Zod `.strict()`

All config schemas use `.strict()` to prevent unknown fields from being stored.

### Cross-Reference Security

| Reference                | Validation                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `linkedAppProfileId`     | Same tenantId, authType must be `oauth2_app`. Validated on create, update, AND at refresh time. |
| Consumer `authProfileId` | Same tenantId, and either tenant-scoped OR same projectId.                                      |

---

## 11. UI Touchpoints

### Auth Profiles Management Page (Settings > Auth Profiles)

Limited to Phase 1's 6 auth types.

- Table/grid: name, authType icon, status badge, scope, environment, visibility, last used, linked consumers count
- "New Auth Profile" -> type selector -> type-specific form
- Status: active (green), expired (amber), revoked (red), invalid (gray)
- Filter by: authType, status, scope, environment
- Bulk actions: revoke, delete

### `AuthProfilePicker` Component

Dropdown/combobox used across connector setup and other forms:

- Lists available Auth Profiles filtered by `authType`, `connector`, `scope`
- Shows status badge inline
- "Create new" option at bottom
- Respects visibility rules (personal profiles only shown to creator)

### Connector Setup Flow (Connections Page)

When a user clicks "Connect" on a connector:

- **Step 1: App Credentials** --- "Does this project have OAuth app credentials?"
  - If yes -> show linked `oauth2_app`, option to change
  - If no -> inline form with Nango's `setup_guide_url` as help. Creates `oauth2_app` Auth Profile
  - If tenant-level exists -> "Using workspace default" with override option
- **Step 2: Authorization** --- "Who authorizes?"
  - "I'll authorize now (shared)" -> OAuth flow -> `oauth2_token` with `visibility: shared`
  - "End users will authorize themselves" -> `connection: per_user` in DSL
- **Step 3: Confirmation** --- summary of created profiles

For non-OAuth connectors: single credential form, creates Auth Profile directly.

### OAuth Popup Flow

Runtime consent flow for end-user OAuth:

- **Pre-flight:** Before agent starts: "This agent needs access to: Gmail, Calendar. [Authorize Gmail] [Authorize Calendar]"
- **Inline:** Mid-conversation: "I need access to your Gmail to send that email. [Authorize]" -> OAuth popup -> creates personal `oauth2_token`

### Inline Setup Help (Nango-Powered)

For every `oauth2_app` creation form:

- "How to get these credentials?" -> expandable panel
- Content from Nango's `setup_guide_url` and `docs_connect`
- Shows: required redirect URI (auto-generated, copy-able), common scopes, gotchas
- Provider-specific guidance (Google consent screen, Slack bot scopes, etc.)

---

## 12. Health Check & Alerting

### Health Check

Add `AuthProfile` to the existing `service-registry.ts` health registry. The health check verifies:

- MongoDB connection can query `AuthProfile`
- A known test profile can be decrypted
- Redis lock mechanism is reachable

### Alerting Thresholds (Phase 1)

| Failure Mode                                 | Alert Threshold                         | Action                         |
| -------------------------------------------- | --------------------------------------- | ------------------------------ |
| `AUTH_PROFILE_TOKEN_REFRESH_FAILED` at scale | > 5 failures/minute sustained for 5 min | PagerDuty                      |
| `AUTH_PROFILE_DECRYPTION_FAILED`             | > 0 in production                       | PagerDuty (key rotation issue) |
| Redis lock contention timeout on refresh     | > 10% of refresh attempts over 5 min    | Warning --- investigate        |

---

## 13. Test Infrastructure

### Shared `AuthProfile` Mock Factory

Add to `packages/test-helpers/`:

```typescript
// packages/test-helpers/src/auth-profile-factory.ts
export function makeAuthProfile(overrides?: Partial<IAuthProfile>): IAuthProfile;
export function makeDecryptedCredentials(authType: string): DecryptedCredentials;
```

This follows the existing `makeToolSecret()` / `makeLLMCredential()` patterns.

### Test Categories for Phase 1

1. **Unit tests:** `AuthProfileService` methods (create, update, delete, resolve, validateAccess)
2. **Unit tests:** Zod validation for all 6 auth types (valid and invalid payloads)
3. **Unit tests:** Token refresh with mock Redis lock
4. **Integration tests:** OAuth initiate/callback flow end-to-end
5. **Integration tests:** Dual-read fallback (authProfileId present vs absent)
6. **Integration tests:** GDPR cascade deletes personal profiles
7. **API tests:** All CRUD endpoints with auth enforcement (correct permission, cross-tenant 404, missing auth 401)
8. **API tests:** Rate limits on OAuth endpoints

---

## 14. Environment Variables

### New Variables

| Variable                                    | Required By                      | Default | Purpose                                 |
| ------------------------------------------- | -------------------------------- | ------- | --------------------------------------- |
| `AUTH_PROFILE_ENABLED`                      | Studio, Runtime, Search-AI, etc. | `false` | Feature flag for migration rollout      |
| `AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS` | Runtime                          | `60`    | Configurable buffer before token expiry |

### Rotation Fields --- Inert in Phase 1

The `rotationPolicy`, `previousEncryptedSecrets`, and `rotationGracePeriodMs` fields exist in the schema but are inert until Phase 2 delivers the `EncryptionService` multi-key prerequisite. If a user attempts to set `rotationPolicy`, reject with: `"Key rotation is not yet supported. Coming in a future release."`

---

## 15. Libraries

| Library         | Version | Purpose                      | Loading Strategy |
| --------------- | ------- | ---------------------------- | ---------------- |
| `simple-oauth2` | latest  | OAuth 2.0 protocol mechanics | Direct import    |

### Package Placement

- Core Auth Profile (model, service, repo, types, validation): `packages/database` + `packages/shared`
- No new workspace packages needed for Phase 1

---

## 16. Feature Flag

```typescript
const AUTH_PROFILE_ENABLED = process.env.AUTH_PROFILE_ENABLED === 'true'; // default: false
```

All credential resolution paths use dual-read during migration:

```typescript
const credential = entity.authProfileId
  ? await authProfileService.resolve({ authProfileId: entity.authProfileId, tenantId })
  : await legacyCredentialService.resolve({
      credentialId: entity.credentialId,
      tenantId,
    });
```

---

## 17. Out of Scope for Phase 1

The following are explicitly deferred to Phase 2 or Phase 3:

| Item                                                                                           | Deferred To |
| ---------------------------------------------------------------------------------------------- | ----------- |
| Enterprise auth types (`kerberos`, `saml`, `hawk`, `digest`, `ws_security`)                    | Phase 3     |
| Remaining core auth types (`basic`, `custom_header`, `aws_iam`, `azure_ad`, `mtls`, `ssh_key`) | Phase 2     |
| Addons (`signing`, `webhookVerification`, `proxy`)                                             | Phase 2     |
| Deferred addons (`certificatePinning`, `jwtWrapping`)                                          | Phase 3     |
| Worker migration (~10-12 direct changes + shared resolver)                                     | Phase 2     |
| `LLMCredential` migration                                                                      | Phase 2     |
| `EndUserOAuthToken` migration                                                                  | Phase 2     |
| `ToolSecret` migration                                                                         | Phase 2     |
| Pre-flight auth propagation (compiler + runtime)                                               | Phase 2     |
| Import/export auth mapping                                                                     | Phase 3     |
| Voice lifecycle auth                                                                           | Phase 3     |
| Multi-agent credential propagation (handoff, delegate, fan-out)                                | Phase 3     |
| Tenant-level CRUD routes (`/api/auth-profiles/*`)                                              | Phase 2     |
| `EncryptionService` multi-key prerequisite                                                     | Phase 2     |
| Key rotation batch job                                                                         | Phase 3     |
| `CredentialAgeMonitor` update                                                                  | Phase 2     |
| `VoiceServiceFactory` cache invalidation                                                       | Phase 2     |
| `RuntimeSecretsProvider` integration                                                           | Phase 2     |
| `OrgProxyConfig` multi-credential merge                                                        | Phase 2     |

---

## 18. Dependencies on Other Phases

Phase 1 has no dependencies on other phases. It is the foundation.

Phase 2 depends on Phase 1 being stable in production with canary tenant validation before starting.

---

## 19. Deliverables Checklist

1. [ ] `AuthProfile` Mongoose model (full schema from Section 3, all fields, correct plugins)
2. [ ] `AuthProfileService` with methods: `create`, `update`, `delete`, `resolve` (5-level `$or` query), `validateAccess`
3. [ ] Project-scoped CRUD API (`/api/projects/:pid/auth-profiles/*`) for the 6 auth types
4. [ ] OAuth initiate, callback, and user-consent endpoints
5. [ ] Consumers endpoint and revoke endpoint
6. [ ] `ConnectorConfig.authProfileId` and `ConnectorConnection.authProfileId` with dual-read
7. [ ] GDPR cascade: add `AuthProfile` to `cascade-delete.ts` AND `MongoGDPRStore`. Fix pre-existing `EndUserOAuthToken` GDPR gap.
8. [ ] Audit trail ciphertext masking fix
9. [ ] Studio connector setup flow and `AuthProfilePicker` component
10. [ ] Auth Profiles management page limited to Phase 1 auth types
11. [ ] SSRF validation on all URL fields
12. [ ] Zod `.strict()` on all config schemas
13. [ ] Structured `AuthProfileError` with `retryable` discriminator
14. [ ] Four trace events via `TraceStore`
15. [ ] Rate limits on OAuth endpoints
16. [ ] Health check in `service-registry.ts`
17. [ ] Shared `AuthProfile` mock factory in `packages/test-helpers`
18. [ ] Full test suite (unit, integration, API)
