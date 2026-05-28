# Auth Profile Design Review — API & Database Schema

**Reviewed:** `docs/plans/2026-03-11-auth-profile-design.md`
**Review date:** 2026-03-11
**Scope:** API endpoint completeness, schema design, validation gaps, error handling, pagination/filtering

---

## Summary

The design is thorough and production-oriented. Encryption, audit logging, GDPR cascade, OAuth two-layer model, and tenant isolation are all addressed. The issues below are genuine gaps — not stylistic preferences — that would require rework or cause production incidents if not addressed before implementation.

---

## Critical Issues

### C1 — Project-level findOne filter is wrong for tenant-scoped profiles (Confidence: 95)

**Section 8, project-level GET handler snippet**

The design specifies:

```typescript
const profile = await AuthProfile.findOne({
  _id: id,
  tenantId,
  projectId: params.id,
});
```

This will return 404 for every tenant-level Auth Profile accessed via the project route. The Consumer Reference Validation function (Section 4) correctly uses `$or: [{ projectId: null }, { projectId }]`, but the per-profile GET/PUT/DELETE handler in Section 8 uses `projectId: params.id` exclusively. A project member accessing a shared tenant-level profile by ID — a valid and explicitly supported use case described in Section 8's list endpoint ("Tenant-level profiles not overridden, marked `inherited: true`") — will get 404.

**Fix:** The handler must use the same pattern as `validateAuthProfileAccess`:

```typescript
const profile = await AuthProfile.findOne({
  _id: id,
  tenantId,
  $or: [{ projectId: null }, { projectId: params.pid }],
});
```

---

### C2 — Token refresh distributed lock key is not specified (Confidence: 92)

**Section 5, Token Refresh**

Step 3 says "Acquire distributed lock (Redis `SET NX PX`) to prevent concurrent refresh" but does not specify the lock key. A lock keyed on `profileId` alone is correct only if there is one refresh flow per token. More critically, if the lock key is not scoped to `tenantId:profileId`, two tenants whose profile IDs happen to collide will share a lock.

The platform-principles skill requires distributed locks via `SET NX PX` and requires tenant-prefixed keys.

**Fix:** Add to Section 5:

```
Lock key: auth-profile:refresh:{tenantId}:{profileId}
TTL: 30s (covers network round-trip + DB write)
```

---

### C3 — No "where used" / consumers endpoint — deletion block cannot be reliably implemented (Confidence: 90)

**Section 8, API Design; Section 10, Error Handling**

The error handling table specifies "Block deletion: N active deployments reference this profile" and "Block deletion: N active connections use this OAuth app", but there is no endpoint or internal service method defined for computing which consumers reference a given Auth Profile ID. The 15 consumer types listed in Section 4 each store `authProfileId` in a different collection. Without a `GET /api/auth-profiles/:id/consumers` endpoint, the deletion pre-check must either fan out across 15 collections in the handler (fragile, no index guarantee) or be skipped entirely.

This also directly affects the UI requirement from Section 7.1 ("linked consumers count" column in the table).

**Fix:** Add to Section 8:

```
GET  /api/auth-profiles/:id/consumers
GET  /api/projects/:pid/auth-profiles/:id/consumers
     Returns: { total: number, byType: Record<ConsumerType, { count, names[] }> }
     Used for: deletion pre-check, UI "linked consumers" badge
     Rate limit: standard read rate
```

Add an internal service method `authProfileService.getConsumerCount(profileId, tenantId)` that fans out across registered consumer collections.

---

### C4 — No token revocation endpoint defined (Confidence: 88)

**Section 8, OAuth Flows**

The OAuth flows section defines initiate, callback, and user-consent, but there is no `POST /api/projects/:pid/auth-profiles/:id/revoke` endpoint. Section 10 references "Revoke them first" as a requirement before deleting an `oauth2_app`, and the GDPR section (11) requires calling the provider's revocation endpoint when deleting personal `oauth2_token` profiles. Without a dedicated endpoint, these flows will be implemented ad-hoc inside delete handlers, making the revocation logic untestable in isolation.

**Fix:** Add to Section 8:

```
POST /api/auth-profiles/:id/revoke
POST /api/projects/:pid/auth-profiles/:id/revoke
     Body: { reason?: string }
     Behavior: calls provider revocationUrl if present, sets status: 'revoked'
     Rate limit: { limit: 10, windowMs: 60_000, scope: 'user' }
     Audit: AUTH_PROFILE_STATUS_CHANGED
```

---

## Important Issues

### I1 — Unique constraint does not account for `visibility: personal` (Confidence: 87)

**Section 9, Unique Constraints**

The partial unique index for project-level profiles is:

```
{ tenantId, projectId, name, environment }
UNIQUE, partialFilterExpression: { projectId: { $ne: null } }
```

This means two different users cannot create personal profiles with the same name in the same project and environment, even though personal profiles are private to their creator. User A's "My OpenAI Key" and User B's "My OpenAI Key" in the same project will conflict at the DB level.

**Fix:** Use three partial unique indexes:

```
// Tenant-level shared
{ tenantId, name, environment }
  UNIQUE, partialFilterExpression: { projectId: null, visibility: 'shared' }

// Project-level shared
{ tenantId, projectId, name, environment }
  UNIQUE, partialFilterExpression: { projectId: { $ne: null }, visibility: 'shared' }

// Personal (per user, per scope)
{ tenantId, projectId, createdBy, name, environment }
  UNIQUE, partialFilterExpression: { visibility: 'personal' }
```

---

### I2 — List endpoint pagination is entirely unspecified (Confidence: 86)

**Section 8, List Endpoint Enrichment**

The list endpoint describes filtering and inheritance merging but says nothing about pagination. Without pagination the handler loads all matching documents into memory and the response payload is unbounded.

**Fix:** Add to Section 8:

```
Query params: ?page=1&limit=50 (offset) or ?cursor=<opaque>&limit=50 (cursor)
Default limit: 50
Max limit: 200
Response shape: { data: AuthProfileSummary[], total: number, nextCursor?: string }
List view (AuthProfileSummary): omits config, encryptedSecrets, previousEncryptedSecrets, addon details
Detail view (full GET /:id): includes config, addons; secrets always redacted unless AUTH_PROFILE_DECRYPT
```

---

### I3 — Sorting is unspecified for list endpoint (Confidence: 83)

The UI table shows "last used" as a column, suggesting sort-by-lastUsedAt is expected. Without a defined sort, MongoDB does not guarantee stable order after updates.

**Fix:** Add:

```
Query params: ?sortBy=name|createdAt|lastUsedAt|status&sortDir=asc|desc
Default: sortBy=name, sortDir=asc
```

Ensure indexes support the sort fields (e.g., `{ tenantId, projectId, lastUsedAt }`).

---

### I4 — No clone/duplicate endpoint (Confidence: 82)

Users frequently clone Auth Profiles to create staging variants. Without a clone endpoint, users must re-enter all credentials manually — including those that are write-only (encrypted on creation, never returned).

**Fix:** Add to Section 8:

```
POST /api/auth-profiles/:id/clone
POST /api/projects/:pid/auth-profiles/:id/clone
     Body: { name: string, environment?: string, projectId?: string }
     Behavior: copies config + encryptedSecrets (re-encrypted with same DEK), sets new name/env
     Permission: AUTH_PROFILE_WRITE
     Audit: AUTH_PROFILE_CREATED (with sourceProfileId in metadata)
```

---

### I5 — Cross-field validation for scope/projectId not specified (Confidence: 85)

Section 9 validation rules only cover authType-specific required fields. Missing cross-field rules:

| Condition                                               | Error                                                     |
| ------------------------------------------------------- | --------------------------------------------------------- |
| POST to tenant route with `projectId` set               | 400: `projectId must not be set on tenant-level profiles` |
| POST to project route with `projectId` ≠ `:pid`         | 400: `projectId must match project in URL`                |
| `scope: 'project'` but `projectId: null`                | 400: `scope=project requires projectId`                   |
| `visibility: 'personal'` on tenant-level route          | 400 or coerce to `shared` — must be explicit              |
| `linkedAppProfileId` set on non-`oauth2_token` authType | 400: `linkedAppProfileId is only valid for oauth2_token`  |

---

### I6 — Document size ceiling not addressed for SAML/mTLS/Kerberos (Confidence: 83)

X.509 certificate chains can be 4–16 KB each; SAML metadata can exceed 64 KB; keytab is binary and arbitrarily large. No maximum stated for any secret field.

**Fix:** Add to Section 9 validation rules:

```
encryptedSecrets (raw, before encryption): max 64 KB
Individual certificate fields: max 16 KB each
keytab: max 256 KB
SAML idpCertificate: max 32 KB
Error code: AUTH_PROFILE_SECRETS_TOO_LARGE
```

---

### I7 — Bulk operations in UI but not in API (Confidence: 84)

Section 7.1 lists "Bulk actions: revoke, delete" as UI capabilities. Section 8 defines no bulk endpoints.

**Fix:** Add to Section 8:

```
POST /api/auth-profiles/bulk-delete
POST /api/projects/:pid/auth-profiles/bulk-delete
     Body: { ids: string[] }
     Max batch: 100 ids
     Behavior: pre-check each for active consumers; if any blocked, return 409 with details

POST /api/auth-profiles/bulk-revoke
POST /api/projects/:pid/auth-profiles/bulk-revoke
     Body: { ids: string[], reason?: string }
     Max batch: 100 ids
```

---

### I8 — Status-based index missing tenantId — cross-tenant job risk (Confidence: 81)

```
{ status, expiresAt, authType }  // cleanup expired + batch refresh
```

This index has no `tenantId`. A background refresh job using this index will iterate across all tenants in a single query.

**Fix:** Change to `{ tenantId, status, expiresAt, authType }`. Background refresh job must be per-tenant or include `tenantId` in every query.

---

### I9 — Error codes inconsistent (Confidence: 80)

The error handling table uses human-readable strings but no machine-readable error codes. Platform error envelope requires `{ code, message }`.

**Fix:** Add structured error code table:

| Code                                | HTTP | Scenario                                   |
| ----------------------------------- | ---- | ------------------------------------------ |
| `AUTH_PROFILE_NOT_FOUND`            | 404  | Profile not found or wrong scope           |
| `AUTH_PROFILE_DUPLICATE_NAME`       | 409  | Duplicate name in scope                    |
| `AUTH_PROFILE_HAS_CONSUMERS`        | 409  | Delete blocked by active consumers         |
| `AUTH_PROFILE_LINKED_APP_INVALID`   | 422  | linkedAppProfileId cross-tenant/wrong type |
| `AUTH_PROFILE_INCOMPATIBLE_TYPE`    | 422  | Wrong authType for consumer                |
| `AUTH_PROFILE_SECRETS_TOO_LARGE`    | 422  | Encrypted secrets exceed size limit        |
| `AUTH_PROFILE_TOKEN_REFRESH_FAILED` | 502  | Provider refresh endpoint error            |
| `AUTH_PROFILE_VALIDATION_FAILED`    | 422  | Test-credentials check failed              |

---

### I10 — user-consent OAuth endpoint has no rate limit (Confidence: 81)

The other two OAuth endpoints have explicit rate limits; user-consent does not.

**Fix:** Add:

```
POST /api/projects/:pid/auth-profiles/oauth/user-consent
     Rate limit: { limit: 10, windowMs: 60_000, scope: 'session' }
```

---

## Minor Issues

### M1 — No PATCH endpoint — full PUT forces re-submission of encrypted secrets

`PUT` as the sole update verb requires the client to send the full document. For secrets, this means either re-sending the secret or having the API silently preserve existing `encryptedSecrets` when the field is absent — which is implicit behavior that must be documented. Recommend either PATCH support or explicit documentation that "if `secrets` is omitted from PUT, existing encrypted secrets are preserved."

### M2 — `scope` field is derived but stored — write path must enforce derivation

Section 1 describes `scope` as "derived from `projectId` presence," yet the MongoDB document stores `scope` as a field. The Mongoose schema pre-save hook must enforce `scope = projectId ? 'project' : 'tenant'` and never accept `scope` from the request body.

---

## What the Design Gets Right

- **Tenant isolation pattern**: `validateAuthProfileAccess` correctly uses `$or [{ projectId: null }, { projectId }]` with `tenantId` in all queries
- **Encryption**: AES-256-GCM via existing `encryptionPlugin`, `encryptionKeyVersion` for rotation, `previousEncryptedSecrets` with grace period
- **Audit trail**: 9 distinct audit events covering every credential-touching operation
- **Two-layer OAuth model**: `oauth2_app` / `oauth2_token` split with `linkedAppProfileId` validation on create, update, AND refresh
- **GDPR cascade**: Personal profile deletion, shared profile anonymization, revocation-on-project-removal
- **Unique constraints**: Partial unique indexes using `partialFilterExpression: { projectId: null }` — correct MongoDB pattern (subject to I1 for personal profiles)
- **Deploy-time validation**: Section 12 specifying deployments must validate all referenced Auth Profiles exist and are `active`
- **DSL portability**: Name-based `auth: profile-name` references resolved post-import
