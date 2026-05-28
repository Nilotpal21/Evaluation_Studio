# GAP-3.3: Consent State Persistence Across Browser Refreshes

> **Parent:** `docs/plans/2026-03-11-auth-profile-design.md` (Section 6 — Pre-flight Auth Propagation)
> **Gap Reference:** `docs/archive/auth-profile-reviews/2026-03-11-auth-profile-review-ux.md` (GAP-3.3)
> **Date:** 2026-03-13
> **Status:** Implementation Plan

---

## Dependencies

This plan depends on the following:

1. **GAP-3.2 Phase 1 (Compiler IR)** — Provides `AuthRequirementIR` types that define which connectors need consent.
2. **GAP-3.1 (Preflight Consent Modal)** — Defines the `AuthGate` session state model and WS events. This plan provides the `ConsentStateResolver` that GAP-3.1 calls.
3. **Infrastructure Gaps plan (Gap 1)** — Rotation grace period logic affects token validation. If decryption fails during token refresh, this plan must handle `AUTH_PROFILE_DECRYPTION_FAILED` as distinct from `invalid_grant`.

Plans that depend on this plan:

- **GAP-3.1** — Calls `ConsentStateResolver` for token lookup during preflight check.
- **GAP-3.4** — Relies on the token persistence model for cross-session consent state.

**Implementation sequence:** This plan is Sprint N+3, after GAP-3.2 Phase 1 (Sprint N), GAP-3.1 runtime (Sprint N+1), and GAP-3.4 UI (Sprint N+2).

---

## Problem Statement

When an end user authorizes a connector (e.g., Gmail) during an OAuth pre-flight popup and then refreshes the browser or returns in a new session, the system must remember the authorization. The auth profile design (Section 6) defines a `pending[]` / `satisfied[]` response for pre-flight, and Section 5 defines the resolution priority for `oauth2_token` lookup. However, no specification exists for:

1. How the runtime maps a returning browser session to previously stored tokens
2. When the pre-flight UI is skipped entirely vs shown again
3. How tokens are refreshed proactively in the background
4. How revoked tokens are detected and consent is re-prompted
5. How contact identity resolution bridges anonymous/identified users to their tokens
6. Privacy and GDPR cascade for end-user tokens
7. Multi-device token sharing via contact identity
8. Security requirements for token storage and tenant isolation

---

## 1. Token Storage Model

### 1.1 Existing Model: `EndUserOAuthToken`

The `EndUserOAuthToken` model already exists at `packages/database/src/models/end-user-oauth-token.model.ts` with this schema:

| Field                   | Type          | Description                                  |
| ----------------------- | ------------- | -------------------------------------------- |
| `_id`                   | UUID (uuidv7) | Primary key                                  |
| `tenantId`              | string        | Tenant isolation (plugin-enforced)           |
| `userId`                | string        | Identity key — see Section 3 for resolution  |
| `provider`              | string        | Connector name (e.g., `gmail`, `slack`)      |
| `providerUserId`        | string        | Provider-side user ID                        |
| `encryptedAccessToken`  | string        | AES-256-GCM encrypted via `encryptionPlugin` |
| `encryptedRefreshToken` | string / null | AES-256-GCM encrypted                        |
| `scope`                 | string        | Granted scopes (space-separated)             |
| `expiresAt`             | Date / null   | Access token expiry                          |
| `refreshedAt`           | Date / null   | Last successful refresh timestamp            |
| `consentedAt`           | Date          | When user originally authorized              |
| `revokedAt`             | Date / null   | Revocation timestamp (null = active)         |
| `lastUsedAt`            | Date / null   | Last time token was used for an API call     |
| `_v`                    | number        | Optimistic concurrency version               |

**Unique index:** `{ tenantId, userId, provider }` — one token per user per connector per tenant.

**Encryption:** `encryptedAccessToken` and `encryptedRefreshToken` are encrypted at rest via the `encryptionPlugin` (AES-256-GCM with tenant-scoped key derived via `EncryptionService` from `KeyVersion` model and HKDF/PBKDF2 key derivation in `packages/shared/src/encryption/engine.ts`).

### 1.2 Required Schema Changes

Add the following fields to `EndUserOAuthToken` to support consent persistence:

| Field               | Type          | Description                                                             |
| ------------------- | ------------- | ----------------------------------------------------------------------- |
| `projectId`         | string        | Project scope (required for multi-project tenants)                      |
| `contactId`         | string / null | Link to Contact model for cross-session persistence                     |
| `authProfileId`     | string / null | Link to the `oauth2_app` Auth Profile used for this consent             |
| `grantedScopes`     | string[]      | Array of individual scopes (replaces space-separated `scope` for query) |
| `tokenStatus`       | enum          | `'active' \| 'expired' \| 'revoked' \| 'refresh_failed'`                |
| `refreshFailCount`  | number        | Consecutive refresh failures (for backoff/revocation detection)         |
| `refreshFailedAt`   | Date / null   | Timestamp of last refresh failure                                       |
| `deviceFingerprint` | string / null | Optional: device that performed the initial consent (for audit)         |

**New indexes:**

```
{ tenantId: 1, contactId: 1, provider: 1 }          // Cross-session lookup by contact
{ tenantId: 1, projectId: 1, userId: 1, provider: 1 } // Project-scoped lookup (replace existing unique)
{ tenantId: 1, tokenStatus: 1, expiresAt: 1 }       // Background refresh worker query
{ tenantId: 1, revokedAt: 1 }                        // Cleanup worker
```

**Migration:** The existing unique index `{ tenantId, userId, provider }` must be replaced with `{ tenantId, projectId, userId, provider }` to support per-project tokens. This is a **breaking index change** requiring a migration step.

### 1.3 Relationship to Auth Profile Model

During the Phase 3 migration (auth-profile-design.md Section 18), `EndUserOAuthToken` documents will be migrated to Auth Profile documents with `authType: 'oauth2_token'` and `visibility: 'personal'`. Until migration completes, `EndUserOAuthToken` remains the source of truth for end-user tokens. The consent persistence logic must work with both models during the dual-read period.

**Dual-read strategy:**

1. Query `AuthProfile` first: `{ tenantId, authType: 'oauth2_token', visibility: 'personal', createdBy: contactId, connector: provider }`
2. Fall back to `EndUserOAuthToken`: `{ tenantId, contactId, provider }`
3. If found in `EndUserOAuthToken` only, optionally backfill to `AuthProfile` (lazy migration)

---

## 2. Session-Token Linking

### 2.1 Linking Keys

Tokens are linked to users via a composite key: `tenantId + contactId + provider + projectId`. The `contactId` is the durable identity that persists across sessions. The `userId` field on `EndUserOAuthToken` stores either a `contactId` or a session-derived identity (see Section 3).

### 2.2 Lookup Flow at Session Start

When a new runtime session starts for an agent with `per_user` auth requirements:

```
1. Extract callerContext from session (tenantId, contactId, channelArtifact, identityTier)
2. Resolve contactId:
   a. If callerContext.contactId is set → use directly
   b. If channelArtifact is set → lookup Contact by blindIndex → get contactId
   c. If anonymous (identityTier=0) → use anonymousId as transient key (no persistence)
3. For each authRequirement in agent IR:
   a. Query EndUserOAuthToken: { tenantId, contactId, provider, projectId, revokedAt: null }
   b. Check token validity (see Section 4)
   c. If valid → add to satisfied[]
   d. If missing or invalid → add to pending[]
4. Return { type: "auth_required", pending, satisfied } or skip pre-flight if pending is empty
```

### 2.3 Token Creation After Consent

When the OAuth callback completes (via `/auth-profiles/oauth/user-consent` flow):

```
1. Extract sessionId from OAuth state parameter
2. Load session → get callerContext → resolve contactId
3. Upsert EndUserOAuthToken:
   Filter: { tenantId, projectId, contactId (as userId), provider }
   Update: { encryptedAccessToken, encryptedRefreshToken, scope, grantedScopes,
             expiresAt, consentedAt: new Date(), revokedAt: null, tokenStatus: 'active',
             authProfileId, providerUserId }
4. Update session's auth state to move connector from pending[] to satisfied[]
5. If all preflight requirements now satisfied → allow session to proceed
```

---

## 3. Contact Identity Resolution

### 3.1 Identity Tiers and Token Persistence

The `CallerContext` (from `packages/shared-auth/src/types/index.ts`) provides identity information at three tiers:

| Tier | `identityTier` | Identity Source                 | Token Persistence                          |
| ---- | -------------- | ------------------------------- | ------------------------------------------ |
| 0    | 0              | Anonymous (no identity)         | **Session-scoped only** — no cross-session |
| 1    | 1              | Channel artifact (cookie, PSID) | **Cross-session via artifact hash**        |
| 2    | 2              | Verified (OAuth, OTP, HMAC)     | **Full cross-session via contactId**       |

### 3.2 Resolution Chain

```
Browser session
  → SDK session token (SDKSessionTokenPayload)
    → CallerContext { contactId?, channelArtifact?, identityTier }
      → Contact lookup (blindIndex on channelArtifact or direct contactId)
        → EndUserOAuthToken lookup (contactId + provider)
```

**Tier 0 (anonymous):** Tokens are stored with `userId = session.id` and `contactId = null`. These tokens are **not persisted across sessions**. The pre-flight will always appear for anonymous users. This is intentional — without identity, there is no way to safely associate tokens across sessions.

**Tier 1 (channel artifact):** Tokens are stored with `userId = contactId` where `contactId` is resolved from the Contact model via `blindIndex` lookup on the channel artifact. The same device/browser will produce the same channel artifact (e.g., cookie), allowing cross-session persistence. Different devices produce different artifacts, so tokens are not shared across devices at Tier 1.

**Tier 2 (verified identity):** Tokens are stored with `userId = contactId` where `contactId` is the verified contact. Since the Contact model links multiple identities (email, phone, external) to a single `contactId`, tokens persist across all devices and channels for the same verified user.

### 3.3 Contact Merge Handling

When two contacts are merged (Contact model has `mergedInto` field):

1. **Acquire distributed lock** on `contactId` before processing: `SET NX PX contact-merge:{contactId} 30000`. If lock acquisition fails, retry with exponential backoff. This prevents race conditions when merging contacts A+B and A+C simultaneously.
2. Query old contact's tokens: `{ userId: oldContactId }`
3. For each token, check if merged contact already has a token for the same provider
4. If no conflict: update `userId` to new `contactId`
5. If conflict (both contacts had Gmail tokens): keep the newer token (by `consentedAt`), revoke the older one
6. Release lock
7. Emit `AUTH_TOKEN_MERGED` audit event

---

## 4. Preflight Skip Logic

### 4.1 Decision Flow

```
Runtime receives session start request
  → Load agent IR → extract authRequirements[]
  → Filter to per_user requirements with consent: 'preflight'
  → For each requirement:
      → resolveExistingToken(tenantId, projectId, contactId, connector)
      → validateToken(token):
          - token exists?
          - token.revokedAt is null?
          - token.tokenStatus is 'active'?
          - token.grantedScopes includes all required scopes?
          - token.expiresAt is null OR token.expiresAt > now + BUFFER?
            (BUFFER = AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS, default 60s)
      → If all checks pass → satisfied
      → If any check fails → pending (with reason code)
  → If pending[] is empty → SKIP pre-flight entirely, start session immediately
  → If pending[] is non-empty → return auth_required response
```

### 4.2 Scope Expansion Handling

If an agent's required scopes have expanded since the user last consented (e.g., agent now also needs `gmail.compose` in addition to `gmail.send`), the existing token's `grantedScopes` will not include the new scope. In this case:

- The connector appears in `pending[]` with `reason: 'scope_expansion'`
- The pre-flight UI shows: "Gmail needs additional permissions: compose emails. [Update Authorization]"
- The OAuth flow requests the union of existing + new scopes
- On callback, the token is updated in-place with the expanded scopes

### 4.3 Token Near-Expiry Handling at Preflight

If a token exists but will expire within the refresh buffer window:

1. Attempt background refresh immediately (see Section 5)
2. If refresh succeeds within 5 seconds → mark as satisfied
3. If refresh fails or times out → mark as pending with `reason: 'token_expired'`

---

## 4A. ConsentStateResolver Service Specification

The `ConsentStateResolver` is the critical service that checks whether a user has valid tokens for their auth requirements. It is referenced by GAP-3.1 (Section 4.2 step 5), GAP-3.2 (Section 3.2), and Task 4 of this plan.

### 4A.1 Interface

```typescript
interface ConsentStateResolver {
  /**
   * Check whether a caller has valid tokens for all given auth requirements.
   * Uses dual-read strategy: AuthProfile first, EndUserOAuthToken fallback.
   */
  resolve(params: {
    tenantId: string;
    projectId: string;
    callerContext: CallerContext;
    authRequirements: AuthRequirementIR[];
  }): Promise<ConsentResolutionResult>;
}

interface ConsentResolutionResult {
  /** Requirements with valid tokens */
  satisfied: ConsentEntry[];
  /** Requirements without valid tokens (with reason codes) */
  pending: PendingConsentEntry[];
}

interface PendingConsentEntry extends ConsentEntry {
  reason: 'missing' | 'expired' | 'revoked' | 'scope_expansion' | 'refresh_failed';
}
```

### 4A.2 Resolution Algorithm (Dual-Read)

For each `AuthRequirementIR` entry:

1. Resolve `contactId` from `callerContext` using the 3-tier identity chain (Section 3.2).
2. **Primary read (AuthProfile):** Query `AuthProfile.findOne({ tenantId, authType: 'oauth2_token', visibility: 'personal', createdBy: contactId, connector: requirement.connector, projectId })`.
3. **Fallback read (EndUserOAuthToken):** If not found in AuthProfile, query `EndUserOAuthToken.findOne({ tenantId, projectId, userId: contactId, provider: requirement.connector, revokedAt: null })`.
4. If found in `EndUserOAuthToken` only, optionally trigger lazy backfill to AuthProfile (non-blocking).

### 4A.3 Scope Comparison

```typescript
function isScopeSatisfied(grantedScopes: string[], requiredScopes: string[]): boolean {
  const granted = new Set(grantedScopes);
  return requiredScopes.every((s) => granted.has(s));
}
```

If `isScopeSatisfied` returns false, the entry is `pending` with `reason: 'scope_expansion'`.

### 4A.4 Near-Expiry Handling

If a token exists but `expiresAt < now + AUTH_TOKEN_REFRESH_BUFFER_SECONDS`:

1. Attempt inline refresh with a 5-second timeout (acquire distributed lock, call provider's `tokenUrl` with `grant_type=refresh_token`).
2. If refresh succeeds within 5s: mark as `satisfied`, update token in DB.
3. If refresh fails or times out: mark as `pending` with `reason: 'expired'`.

### 4A.5 Error Cases

| Error                           | Behavior                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| Decryption failed               | Log `AUTH_PROFILE_DECRYPTION_FAILED`, mark as `pending` with `reason: 'refresh_failed'` |
| DB unreachable                  | Throw — caller (preflight check) returns an error response to the client                |
| Token found but `revokedAt` set | Mark as `pending` with `reason: 'revoked'`                                              |

### 4A.6 Caching

Results are **not cached** across requests. Each preflight check or inline consent check calls `ConsentStateResolver.resolve()` fresh to ensure token validity is current. The DB queries are indexed and fast (< 5ms for the dual-read).

---

## 5. Token Refresh

### 5.1 Background Refresh Worker

A BullMQ recurring job (`auth-token-refresh-worker`) runs every 5 minutes.

**Tenant isolation:** The `tenantIsolationPlugin` is applied to `EndUserOAuthToken`, so queries require tenant context. The worker must iterate over all tenants and run per-tenant queries.

**Tenant isolation bypass mechanism:** The worker uses `EndUserOAuthToken.collection.distinct('tenantId')` (direct MongoDB driver access) to obtain the list of tenants, bypassing Mongoose plugins. This is safe because:

1. The `distinct` query returns only tenant IDs (no token data).
2. All subsequent per-tenant queries go through the Mongoose model with `tenantId` filter, re-entering the plugin's isolation scope.
3. A code comment MUST document this bypass: `// SECURITY: Admin-level query via direct driver. Only returns tenantId strings, no secrets. Per-tenant queries below use the plugin-scoped model.`
4. The worker MUST NOT use direct driver access for any query that returns token data.

```
1. Query distinct tenantIds via EndUserOAuthToken.collection.distinct('tenantId')
2. For each tenantId:
   Query: EndUserOAuthToken.find({
     tenantId,
     tokenStatus: 'active',
     revokedAt: null,
     expiresAt: { $ne: null, $lt: new Date(Date.now() + PROACTIVE_REFRESH_WINDOW_MS) }
   })
   // PROACTIVE_REFRESH_WINDOW_MS = 10 * 60 * 1000 (10 minutes)
```

**Worker health monitoring:** Add metrics:

- `auth_token_refresh_worker_runs_total` (counter)
- `auth_token_refresh_worker_last_success_timestamp` (gauge)
- Alert if `last_success_timestamp` is older than 15 minutes.

For each token found:

1. Acquire distributed lock: `SET NX PX oauth2:user-refresh:{tokenId} 30000`
2. If lock acquired:
   a. Load linked `oauth2_app` Auth Profile (via `authProfileId`) to get `clientId`, `clientSecret`, `tokenUrl`
   b. Validate `authProfileId` is same tenant (cross-reference security)
   c. Decrypt `encryptedRefreshToken`
   d. POST to `tokenUrl` with `grant_type=refresh_token`
   e. On success: update `encryptedAccessToken`, `expiresAt`, `refreshedAt`, reset `refreshFailCount` to 0
   f. On failure: increment `refreshFailCount`, set `refreshFailedAt`
   g. Release lock
3. If lock not acquired: skip (another worker/pod is handling it)

### 5.2 Refresh Failure Escalation

| `refreshFailCount` | Action                                                                        |
| ------------------ | ----------------------------------------------------------------------------- |
| 1-2                | Retry on next worker cycle (5 minutes)                                        |
| 3                  | Set `tokenStatus: 'refresh_failed'`, emit `AUTH_TOKEN_REFRESH_FAILED` trace   |
| 5+                 | Set `tokenStatus: 'expired'`, stop retrying. Next session start shows consent |

### 5.3 On-Demand Refresh at Runtime

When a tool execution uses a `per_user` token:

1. Load token from `EndUserOAuthToken`
2. If `expiresAt < now + 60s` and `encryptedRefreshToken` is not null:
   a. Attempt refresh inline (with distributed lock, same as worker)
   b. If refresh succeeds → use new token, continue tool execution
   c. If refresh fails with `invalid_grant` → return tool error: `"Gmail authorization expired. [Re-authorize]"`
   d. **If decryption fails** (`AUTH_PROFILE_DECRYPTION_FAILED`) → set `tokenStatus: 'invalid'` (not 'expired') and require re-authorization. This is distinct from token expiry — it indicates a key rotation issue that should also trigger an alert.
3. Update `lastUsedAt` on the token

---

## 6. Token Revocation Detection

### 6.1 Detecting Revoked Tokens

Tokens can be revoked externally (user revokes via Google/Slack settings) or internally (admin revokes via Auth Profile management). Detection strategies:

**Strategy A — Reactive (API error):**

When a tool execution using the token receives a `401 Unauthorized` or `403 Forbidden` response from the provider:

1. Attempt one token refresh
2. If refresh also returns `invalid_grant` → token has been revoked at the provider
3. Set `revokedAt: new Date()`, `tokenStatus: 'revoked'`
4. Return tool error to agent: `"Your Gmail authorization was revoked. [Re-authorize]"`
5. Emit `AUTH_TOKEN_REVOKED` trace event

**Strategy B — Proactive (token introspection):**

For providers that support [RFC 7662 Token Introspection](https://tools.ietf.org/html/rfc7662) (configured via `oauth2_app.config.tokenIntrospectionUrl`):

1. The background refresh worker calls the introspection endpoint for tokens nearing expiry
2. If `active: false` → mark token as revoked
3. This catches revocations before the user encounters an error

**Strategy C — Webhook-based (provider callback):**

Deferred to a future phase. Some providers (Google, Slack) support revocation webhooks. When implemented, the webhook handler would directly update `tokenStatus: 'revoked'`.

### 6.2 Re-consent Flow After Revocation

When a user starts a session and their token is revoked:

1. Token appears in `pending[]` with `reason: 'revoked'`
2. Pre-flight UI shows: "Your Gmail access was revoked. [Re-authorize]"
3. User clicks authorize → standard OAuth popup flow
4. On callback: existing token is updated in-place (upsert), `revokedAt` reset to null, `tokenStatus: 'active'`

---

## 7. Cross-Session Persistence

### 7.1 Same User, New Session

When a user returns in a new browser session (same device or different):

```
1. SDK init → channelArtifact (cookie hash) or verified identity
2. Session token minted with contactId from Contact resolution
3. Session created → pre-flight check runs
4. Token lookup: { tenantId, contactId, provider, projectId }
5. If valid token found → pre-flight skipped, session starts immediately
```

The key insight: tokens are stored against `contactId`, not `sessionId`. Sessions are ephemeral (Redis TTL: 24h, cold storage: 90 days). Tokens are durable (MongoDB, no TTL — only explicit revocation or GDPR deletion).

### 7.2 Session Resumption

When a user reconnects to an existing session (e.g., page refresh within session TTL):

1. Session is rehydrated from Redis (or cold storage)
2. `callerContext` on the session already contains `contactId`
3. No pre-flight check is needed — the session already passed pre-flight
4. Token is still valid (refresh worker maintains it)

### 7.3 New Session After Token Expiry

If the background refresh worker has already refreshed the token:

1. New session starts → pre-flight check finds refreshed token → skip pre-flight

If the token expired and refresh failed:

1. New session starts → pre-flight finds `tokenStatus: 'expired'` → shows in `pending[]`
2. User re-authorizes → token updated → session proceeds

---

## 8. Multi-Device Support

### 8.1 Tier 2 (Verified Identity) — Token Sharing

When a user is verified (identityTier=2), their `contactId` is the same regardless of device. Therefore:

- User authorizes Gmail on desktop → token stored with `contactId`
- User opens agent on mobile → same `contactId` resolved → token found → pre-flight skipped
- Token is shared across all devices for the same verified contact

### 8.2 Tier 1 (Channel Artifact) — Device-Specific Tokens

At Tier 1, different devices produce different channel artifacts (different cookies). Each device maps to a different Contact record (unless contacts are later merged). Therefore:

- User authorizes Gmail on desktop → token stored with desktop `contactId`
- User opens on mobile → different `contactId` → no token found → pre-flight shown
- User authorizes Gmail on mobile → separate token stored with mobile `contactId`
- If contacts are later merged → tokens are consolidated (see Section 3.3)

### 8.3 Tier 0 (Anonymous) — No Sharing

Anonymous users have no persistent identity. Tokens are session-scoped and never shared.

---

## 9. Privacy and GDPR

### 9.1 Data Classification

| Data                      | Classification | Retention              | Encryption  |
| ------------------------- | -------------- | ---------------------- | ----------- |
| `encryptedAccessToken`    | PII / Secret   | Until revocation       | AES-256-GCM |
| `encryptedRefreshToken`   | PII / Secret   | Until revocation       | AES-256-GCM |
| `providerUserId`          | PII            | Until contact deletion | AES-256-GCM |
| `scope` / `grantedScopes` | Non-sensitive  | Until token deletion   | Plaintext   |
| `consentedAt`             | Audit          | Until token deletion   | Plaintext   |
| `contactId`               | Pseudonymous   | Until contact deletion | Plaintext   |

### 9.2 Right to Erasure Cascade

When a contact deletion request is processed (`DeletionRequest` model, `scope: 'contact'`):

```
1. Load all EndUserOAuthToken where { tenantId, userId: contactId }
2. For each token:
   a. If linked oauth2_app has revocationUrl configured:
      - Decrypt access token
      - Call provider's revocation endpoint
      - Log success/failure (do not block deletion on revocation failure)
   b. Hard-delete the EndUserOAuthToken document
3. Also delete from AuthProfile (Phase 3+): { tenantId, authType: 'oauth2_token',
   visibility: 'personal', createdBy: contactId }
4. Emit AUTH_TOKEN_ERASURE audit event with anonymized contactId (SHA-256 hash)
```

**Important:** Token deletion must be **hard delete**, not soft delete. GDPR right to erasure requires that the encrypted token material is irrecoverable.

### 9.3 Consent Record Retention

Even after token deletion, an anonymized consent audit record must be retained for compliance:

```typescript
{
  action: 'AUTH_TOKEN_ERASURE',
  tenantId,
  subjectHash: sha256(contactId),  // anonymized
  provider,
  originalConsentedAt,
  erasedAt: new Date(),
  providerRevocationResult: 'success' | 'failed' | 'not_configured',
}
```

### 9.4 Data Minimization

- Tokens for Tier 0 (anonymous) sessions are stored with `contactId: null` and should have a TTL index: expire after 24 hours (matching session TTL). Add index: `{ contactId: 1, createdAt: 1 }` with `partialFilterExpression: { contactId: null }` and `expireAfterSeconds: 86400`.
- `lastUsedAt` is updated at most once per hour (debounced) to avoid excessive writes.

---

## 10. Security

### 10.1 Token Encryption at Rest

All token material is encrypted via the existing `encryptionPlugin`:

- Uses AES-256-GCM with tenant-scoped key derived via `EncryptionService` from `KeyVersion` model and HKDF/PBKDF2 key derivation in `packages/shared/src/encryption/engine.ts`
- DEK is itself encrypted with the master key (`ENCRYPTION_MASTER_KEY` env var)
- Multi-key support: `encryptionKeyVersion` tracks which DEK version was used
- Key rotation: when DEK rotates, re-encrypt on next read (lazy re-encryption)

### 10.2 Tenant Isolation

The `tenantIsolationPlugin` is already applied to `EndUserOAuthToken`. This ensures:

- All queries automatically include `tenantId` filter
- Cross-tenant token access returns empty results (not 403)
- The unique index `{ tenantId, projectId, userId, provider }` prevents cross-tenant collisions

### 10.3 Authorization for Token Operations

| Operation                     | Required Permission / Identity                   |
| ----------------------------- | ------------------------------------------------ |
| Create token (OAuth callback) | Authenticated session with valid `callerContext` |
| Read own token (at runtime)   | Session `contactId` matches token `userId`       |
| Read any token (admin)        | `AUTH_PROFILE_DECRYPT` permission                |
| Revoke own token              | Session `contactId` matches token `userId`       |
| Revoke any token (admin)      | `AUTH_PROFILE_MANAGE` permission                 |
| Delete token (GDPR)           | System-level (deletion request worker)           |

### 10.4 OAuth State Parameter Security

The OAuth state parameter (used in `/oauth/user-consent` flow) must be:

1. **Encrypted** with AES-256-GCM using the platform encryption key (NOT just HMAC-signed — the state contains `sessionId` which must remain confidential)
2. Include: `sessionId`, `tenantId`, `projectId`, `contactId`, `connector`, `nonce`, `expiresAt`
3. Validated on callback: decryption, nonce uniqueness (Redis `SETEX` with TTL matching `AUTH_TOKEN_OAUTH_STATE_TTL_SECONDS` — MUST use `SETEX`, not bare `SET NX`, to prevent Redis memory leaks from abandoned OAuth flows), expiry check
4. TTL: 10 minutes (OAuth flows should complete quickly)

### 10.5 Token Access Logging

Every token decryption for runtime use must emit a trace event:

```typescript
{
  type: 'AUTH_TOKEN_ACCESSED',
  tenantId,
  projectId,
  tokenId,
  provider,
  contactId,  // not the actual identity, just the pseudonymous ID
  sessionId,
  agentName,
  toolName,
}
```

---

## 11. Implementation Tasks

### Phase A — Schema and Core Lookup (Sprint 1)

| #   | Task                                                                                                                                                      | Package             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | Add `projectId`, `contactId`, `authProfileId`, `grantedScopes`, `tokenStatus`, `refreshFailCount`, `refreshFailedAt` fields to `EndUserOAuthToken` schema | `packages/database` |
| 2   | Create migration script: add new fields with defaults, rebuild unique index                                                                               | `packages/database` |
| 3   | Implement `EndUserOAuthTokenRepo` with `findValidToken(tenantId, projectId, contactId, provider)` and `upsertFromConsent(...)`                            | `packages/database` |
| 4   | Implement `ConsentStateResolver` service: takes `CallerContext` + `authRequirements[]`, returns `{ pending[], satisfied[] }`                              | `apps/runtime`      |
| 5   | Integrate `ConsentStateResolver` into session bootstrap pre-flight check                                                                                  | `apps/runtime`      |
| 6   | Add preflight skip logic: if `pending.length === 0`, skip `auth_required` response                                                                        | `apps/runtime`      |

### Phase B — OAuth Callback and Token Storage (Sprint 1-2)

| #   | Task                                                                                           | Package        |
| --- | ---------------------------------------------------------------------------------------------- | -------------- |
| 7   | Implement `/oauth/user-consent` endpoint: generate signed state, redirect to provider          | `apps/runtime` |
| 8   | Implement OAuth callback handler: exchange code, upsert `EndUserOAuthToken`                    | `apps/runtime` |
| 9   | Implement AES-256-GCM encrypted state parameter with nonce (Redis SETEX for replay prevention) | `apps/runtime` |
| 10  | Wire contact identity resolution into OAuth callback (resolve contactId from session)          | `apps/runtime` |

### Phase C — Background Refresh and Revocation (Sprint 2)

| #   | Task                                                                  | Package                    |
| --- | --------------------------------------------------------------------- | -------------------------- |
| 11  | Implement `auth-token-refresh-worker` BullMQ recurring job            | `apps/runtime`             |
| 12  | Implement distributed lock for refresh (Redis SET NX PX)              | `apps/runtime`             |
| 13  | Implement on-demand refresh at tool execution time                    | `packages/connectors/base` |
| 14  | Implement revocation detection on 401/403 from providers              | `packages/connectors/base` |
| 15  | Implement refresh failure escalation (count-based status transitions) | `apps/runtime`             |

### Phase D — GDPR and Cleanup (Sprint 2-3)

| #   | Task                                                   | Package             |
| --- | ------------------------------------------------------ | ------------------- |
| 16  | Add `EndUserOAuthToken` to GDPR cascade delete handler | `apps/runtime`      |
| 17  | Implement provider revocation call on GDPR deletion    | `apps/runtime`      |
| 18  | Add TTL index for anonymous (Tier 0) tokens            | `packages/database` |
| 19  | Add contact merge handler for token consolidation      | `apps/runtime`      |
| 20  | Implement anonymized consent audit logging             | `apps/runtime`      |

### Phase D+ — Studio Test Panel Identity (Sprint 2-3)

| #   | Task                                                                                                                                                                                         | Package       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 20a | Ensure Studio test panel sets `callerContext.contactId` to the developer's user ID when creating test sessions, so preflight token lookups use the developer's identity instead of anonymous | `apps/studio` |

### Phase E — Audit, Metrics, and Testing (Sprint 3)

| #   | Task                                                                                                | Package        |
| --- | --------------------------------------------------------------------------------------------------- | -------------- |
| 22  | Add metrics: `auth_token_refresh_total`, `auth_token_revocation_total`, `auth_preflight_skip_total` | `apps/runtime` |
| 23  | E2E test: authorize → refresh browser → pre-flight skipped                                          | `apps/runtime` |
| 24  | E2E test: authorize → token expires → refresh worker refreshes → pre-flight skipped                 | `apps/runtime` |
| 25  | E2E test: authorize → revoke at provider → next session shows re-consent                            | `apps/runtime` |
| 26  | E2E test: Tier 2 user authorizes on desktop → opens on mobile → pre-flight skipped                  | `apps/runtime` |
| 27  | E2E test: GDPR deletion → tokens hard-deleted → provider revocation called                          | `apps/runtime` |
| 28  | E2E test: contact merge → tokens consolidated                                                       | `apps/runtime` |

---

## 12. Configuration

| Env Variable / Config Key                     | Default   | Description                                                   |
| --------------------------------------------- | --------- | ------------------------------------------------------------- |
| `AUTH_TOKEN_REFRESH_BUFFER_SECONDS`           | `60`      | Seconds before expiry to trigger proactive refresh            |
| `AUTH_TOKEN_PROACTIVE_REFRESH_WINDOW_MINUTES` | `10`      | How far ahead the background worker looks for expiring tokens |
| `AUTH_TOKEN_REFRESH_WORKER_INTERVAL_MS`       | `300000`  | Background worker poll interval (5 minutes)                   |
| `AUTH_TOKEN_REFRESH_LOCK_TTL_MS`              | `30000`   | Distributed lock TTL for refresh                              |
| `AUTH_TOKEN_MAX_REFRESH_FAILURES`             | `5`       | Max consecutive failures before marking expired               |
| `AUTH_TOKEN_OAUTH_STATE_TTL_SECONDS`          | `600`     | OAuth state parameter validity window (10 minutes)            |
| `AUTH_TOKEN_ANONYMOUS_TTL_SECONDS`            | `86400`   | TTL for anonymous (Tier 0) tokens (24 hours)                  |
| `AUTH_TOKEN_LAST_USED_DEBOUNCE_MS`            | `3600000` | Debounce interval for `lastUsedAt` updates (1 hour)           |

---

## 13. Sequence Diagrams

### 13.1 First-Time Consent (Pre-flight)

```
Browser          SDK/Widget       Runtime          MongoDB          Provider
  |                 |                |                |                |
  |── sdk/init ────>|                |                |                |
  |                 |── session ────>|                |                |
  |                 |                |── resolve ────>|                |
  |                 |                |   contactId    |                |
  |                 |                |<── contact ───-|                |
  |                 |                |── find token ->|                |
  |                 |                |<── null ───────|                |
  |                 |<── auth_required (pending: [gmail]) ──|         |
  |<── show preflight UI ──|        |                |                |
  |── click [Authorize Gmail] ─────>|                |                |
  |                 |                |── /user-consent|                |
  |                 |                |<── authUrl ────|                |
  |<── open popup ──|               |                |                |
  |── authorize ───────────────────────────────────────────>|         |
  |<── callback with code ──────────────────────────────────|         |
  |── callback ────>|               |                |                |
  |                 |── /callback ->|                |                |
  |                 |                |── exchange ──────────────────-->|
  |                 |                |<── tokens ─────────────────────|
  |                 |                |── upsert token>|                |
  |                 |                |<── ok ────────-|                |
  |                 |<── satisfied ──|                |                |
  |<── close popup, start session ──|                |                |
```

### 13.2 Returning User (Pre-flight Skipped)

```
Browser          SDK/Widget       Runtime          MongoDB
  |                 |                |                |
  |── sdk/init ────>|                |                |
  |                 |── session ────>|                |
  |                 |                |── resolve ────>|
  |                 |                |   contactId    |
  |                 |                |<── contact ───-|
  |                 |                |── find token ->|
  |                 |                |<── valid token |
  |                 |                |   (satisfied)  |
  |                 |<── session_started (no preflight) ──|
  |<── chat UI ─────|               |                |
```

---

## 14. Open Questions

1. **Scope downgrade:** If an agent's required scopes are _reduced_ (e.g., no longer needs `gmail.compose`), should existing tokens with broader scopes still be accepted? **Recommendation:** Yes — broader scopes are a superset and remain valid.

2. **Multi-project tokens:** Should a user who authorizes Gmail in Project A be able to use that token in Project B (same tenant)? **Recommendation:** No — tokens are project-scoped for security isolation. Each project may use different OAuth app credentials.

3. **Token portability on project clone:** When a project is cloned/duplicated, should end-user tokens be copied? **Recommendation:** No — tokens reference specific `authProfileId` (OAuth app) which may differ in the cloned project.

4. **Consent UI for inline (non-preflight) connectors:** The pre-flight skip logic only applies to `consent: preflight` connectors. For `consent: inline`, the token lookup should still happen — if a valid token exists, the tool should use it silently without prompting. **Recommendation:** Implement the same token lookup for inline consent, but instead of blocking session start, silently use the token if available.

---

## 15. Schema Migration Rollback Strategy

The index change from `{ tenantId, userId, provider }` to `{ tenantId, projectId, userId, provider }` is a breaking change. Use a two-step migration:

1. **Step 1:** Add new index (non-unique first) alongside old index. Backfill `projectId` on existing documents using a migration script that resolves each token's project from associated sessions/auth profiles.
2. **Step 2:** Once all documents have `projectId`, drop old unique index, make new index unique.

If step 2 fails, the old index still exists as fallback. This ensures zero-downtime migration.

---

## 16. Existing Schema Acknowledgment

The following already exists and does NOT need to be created:

- `EndUserOAuthToken` model with `encryptionPlugin` — in `packages/database/src/models/end-user-oauth-token.model.ts`
- `CallerContext` with `identityTier`, `channelArtifact`, `contactId` — in `packages/shared-auth/src/types/index.ts`
- `resolveWithGracePeriod` — in `packages/shared/src/services/auth-profile/grace-period.ts` (verify if grace period logic is already partially implemented before implementing Section 5.3). **IMPORTANT:** The grace period anchor in `resolveWithGracePeriod` currently uses `updatedAt` (line 40), which resets on every document save. Infrastructure Gaps Gap 1 Phase B must be completed first to add `rotationStartedAt` as the correct anchor. Do not use `resolveWithGracePeriod` for consent token validation until Gap 1 is deployed.

---

## Revision History

- **Pass 1 (2026-03-13)**: Initial implementation plan.
- **Pass 2 (2026-03-13)**: Applied 131 audit findings from 3 auditors. Added cross-plan dependencies section, fixed encryption reference ("dek-registry" to correct EncryptionService/KeyVersion path), fixed OAuth state parameter to be encrypted (not HMAC-signed) since it contains sessionId, added distributed lock for contact merge handling, fixed background refresh worker tenant isolation (per-tenant queries), added worker health monitoring metrics, added decryption error handling in on-demand refresh (distinct from invalid_grant), added schema migration rollback strategy (two-step index change), added existing schema acknowledgment, sequenced sprint to N+3.
- **Pass 4 (2026-03-13)**: Applied 20 findings from Pass 3 auditors. Fixed OAuth state encryption consistency (Task 9 "HMAC-signed" to "AES-256-GCM encrypted", "SET NX" to "SETEX"), corrected package paths for Tasks 13-14 from `packages/execution` to `packages/connectors/base`, replaced stale "dek-registry" in Section 10.1 with correct EncryptionService reference, added ConsentStateResolver service specification (Section 4A) with interface, dual-read algorithm, scope comparison, near-expiry handling, error cases, and caching strategy, added tenant isolation bypass safeguards for background refresh worker (direct driver for distinct tenantIds only, code comment requirement, no direct driver for token data), added Studio test panel identity handling task (20a).
- **Pass 6 (2026-03-13)**: Fixed P5-4 — added dependency ordering note to Section 16 warning that `resolveWithGracePeriod` uses `updatedAt` anchor (buggy); Infrastructure Gaps Gap 1 must be deployed first to add `rotationStartedAt`.
