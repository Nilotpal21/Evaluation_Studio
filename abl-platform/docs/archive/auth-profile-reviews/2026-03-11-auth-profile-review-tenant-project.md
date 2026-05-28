# Auth Profile Design Review: Tenant Isolation, Project Scoping, RBAC & Multi-Tenant Security

**Reviewer:** Multi-tenancy & Authorization Reviewer
**Date:** 2026-03-11
**Documents reviewed:**

- `docs/plans/2026-03-11-auth-profile-design.md`
- `docs/plans/2026-03-11-auth-profile-code-changes.md`
- `docs/plans/2026-03-11-auth-profile-connections-analysis.md`

**Codebase artifacts examined:**

- `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts`
- `packages/database/src/models/llm-credential.model.ts`
- `packages/database/src/models/end-user-oauth-token.model.ts`
- `packages/database/src/models/connector-connection.model.ts`
- `packages/database/src/models/guardrail-policy.model.ts`
- `packages/database/src/models/guardrail-provider-config.model.ts`
- `packages/database/src/models/environment-variable.model.ts`
- `packages/database/src/models/project-config-variable.model.ts`
- `packages/database/src/models/audit-log.model.ts`
- `packages/database/src/models/deletion-request.model.ts`
- `apps/studio/src/lib/route-handler.ts`
- `apps/studio/src/lib/permissions.ts`
- `apps/studio/src/repos/credential-repo.ts`
- `apps/studio/src/app/api/tenant-credentials/route.ts`
- `apps/studio/src/app/api/credentials/route.ts`
- `apps/studio/src/app/api/projects/[id]/connections/route.ts`
- `apps/studio/src/services/retention/mongo-gdpr-store.ts`
- `apps/runtime/src/services/guardrails/policy-resolver.ts`

---

## Verdict: CONDITIONAL APPROVAL

The design is architecturally sound and aligns well with existing platform patterns. However, there are **6 critical issues** and **9 high-severity findings** that must be addressed before implementation proceeds. The tenant isolation foundation is correct (tenantIsolationPlugin + explicit `findOne({_id, tenantId})` patterns), but the cross-reference validation, visibility enforcement, and GDPR cascade gaps create exploitable attack surfaces.

---

## 1. Tenant Isolation Assessment

### 1.1 What the design gets right

- **`tenantId` is required and always present** -- matches every existing model in the codebase (LLMCredential, ConnectorConnection, EnvironmentVariable, GuardrailPolicy, etc.).
- **tenantIsolationPlugin** -- the design should use this plugin. The plugin auto-injects `tenantId` into all query operations via AsyncLocalStorage, providing defense-in-depth even if application code omits the filter.
- **Unique constraint `{ tenantId, projectId, name }`** -- follows the pattern established by `EnvironmentVariable` (`{ tenantId, projectId, environment, key }`) and `LLMCredential` (`{ tenantId, credentialScope, ownerId, provider, name }`).

### 1.2 CRITICAL-01: Tenant isolation plugin must be applied

**Status:** Not explicitly stated in design.

The design shows a MongoDB schema but never mentions applying `tenantIsolationPlugin`. Every model in the codebase uses it. The implementation MUST include:

```typescript
AuthProfileSchema.plugin(tenantIsolationPlugin);
```

Without this, the auth profile model becomes the only credential model in the system without automatic tenant scoping -- a catastrophic isolation failure.

**Recommendation:** Add to design section 9 (Database Schema): "Plugins: `tenantIsolationPlugin`, `encryptionPlugin` (for `encryptedSecrets`), `auditTrailPlugin`."

### 1.3 CRITICAL-02: The `projectId: null` ambiguity for tenant-level profiles

The design uses `projectId?: string` where `null` means tenant-level. This pattern does NOT exist cleanly in the current codebase:

- **GuardrailPolicy** uses `scope.type: 'tenant' | 'project' | 'agent'` with optional `scope.projectId` -- a discriminated embedded object.
- **LLMCredential** uses `credentialScope: 'user' | 'tenant'` with `ownerId` -- no `projectId` at all.
- **ConnectorConnection** always has `projectId` (required: true) -- it is always project-scoped.
- **EnvironmentVariable** always has `projectId` (required: true) -- always project-scoped.

No existing model uses the pattern "`projectId` is optional; null means tenant-level." This is a new pattern.

**Risk:** The unique index `{ tenantId, projectId, name }` behaves differently in MongoDB when `projectId` is `null`. Two documents with `projectId: null` and the same `tenantId` + `name` may or may not conflict depending on whether MongoDB treats `null` values as equal in unique indexes (it does -- but only if the field exists and is explicitly null, not if the field is absent). If some documents omit `projectId` entirely and others set it to `null`, the uniqueness constraint breaks.

**Recommendation:**

1. Make `projectId` required on the schema with a sentinel value (e.g., `'__tenant__'`) for tenant-level profiles, OR
2. Ensure the schema always sets `projectId` to `null` (never `undefined`) via `default: null`, AND add a partial unique index: `{ tenantId, name, unique: true, partialFilterExpression: { projectId: null } }` plus `{ tenantId, projectId, name, unique: true, partialFilterExpression: { projectId: { $ne: null } } }`.
3. Follow the GuardrailPolicy pattern: use an embedded `scope` object with a discriminator `type` field.

### 1.4 HIGH-01: Tenant-level API routes lack project isolation check

The design proposes tenant-level routes:

```
GET /api/auth-profiles
POST /api/auth-profiles
```

These are NOT under `/api/projects/:pid/...` and therefore do NOT go through `requireProjectAccess()` in `withRouteHandler`. The existing credential routes (`/api/tenant-credentials/`) follow this pattern and only check `requireAuth` + `user.tenantId`.

**Current gap in existing code (pre-Auth Profile):** The `/api/tenant-credentials/` route does NOT use `withRouteHandler` -- it manually calls `requireAuth()` and checks `user.tenantId`. It also does NOT check any permissions. This is a pre-existing issue that Auth Profile must NOT replicate.

**Recommendation:** Tenant-level auth profile routes MUST:

1. Use `withRouteHandler` with appropriate permissions.
2. Require admin-level permission (see RBAC section below).
3. Never allow non-admin users to create tenant-level profiles.

---

## 2. Project Scoping Assessment

### 2.1 What the design gets right

- **Two-tier scoping model** (tenant default, project override) -- matches the GuardrailPolicy resolution pattern exactly: tenant policies are base layer, project policies override.
- **Resolution priority** (personal > shared > project > tenant) -- well-defined and predictable.

### 2.2 HIGH-02: Project-level list endpoint merging is under-specified

The design says `GET /api/projects/:pid/auth-profiles` returns "merged results" with tenant-level profiles marked `inherited: true`. The GuardrailPolicyResolver in the runtime has a well-defined merge algorithm (tenant rules first, project rules override by guardrail name). Auth Profile needs an equivalent algorithm.

**Missing specification:**

- What defines "override"? Is it connector + authType match? Name match? Category match?
- If a project has a profile named "Production OpenAI" and the tenant also has one, is the tenant one hidden or marked `overridden: true`?
- Can a project-level profile with the SAME name as a tenant profile coexist? The unique index `{ tenantId, projectId, name }` allows this (different projectId values), but the UI merge logic must handle it.

**Recommendation:** Define override semantics explicitly. Suggested: override is by `connector + authType` match (not name). Tenant profiles with a matching project-level profile should appear as `{ inherited: true, overridden: true }` in the merged list.

### 2.3 HIGH-03: Project access validation on project-level routes

The design correctly places project-level routes under `/api/projects/:pid/auth-profiles`. With `withRouteHandler({ requireProject: true })`, this will automatically:

1. Resolve `projectId` from `params.id`
2. Call `requireProjectAccess(projectId, user)` which checks the user has access to this project
3. Populate `ctx.project` with project details including `tenantId`

This is correct. However, the routes must also verify that when reading/updating/deleting a specific auth profile, the profile's `projectId` matches the route's `params.id`:

```typescript
// WRONG: allows fetching any profile by ID regardless of project
const profile = await AuthProfile.findOne({ _id: id, tenantId });

// RIGHT: scopes to both tenant and project
const profile = await AuthProfile.findOne({
  _id: id,
  tenantId,
  projectId: params.id,
});
```

**Recommendation:** Add explicit requirement: "All project-level ID-based queries MUST include `projectId` in the filter, not just `tenantId`."

---

## 3. RBAC and Permissions Assessment

### 3.1 CRITICAL-03: No AUTH_PROFILE permissions defined

The current `StudioPermission` constants in `apps/studio/src/lib/permissions.ts` include:

- `CONNECTION_READ`, `CONNECTION_WRITE`, `CONNECTION_DELETE` -- for connector connections
- `ADMIN_KMS` -- for KMS operations
- `ADMIN_ENV_VARS` -- for environment variables

Auth Profile needs its own permission set. The design does not define these.

**Recommendation:** Add to `StudioPermission`:

```typescript
AUTH_PROFILE_READ: 'auth-profile:read',
AUTH_PROFILE_WRITE: 'auth-profile:write',
AUTH_PROFILE_DELETE: 'auth-profile:delete',
AUTH_PROFILE_DECRYPT: 'auth-profile:decrypt',  // elevated: view raw secrets
```

Rationale:

- `AUTH_PROFILE_READ` -- view profile metadata, redacted secrets
- `AUTH_PROFILE_WRITE` -- create/update profiles
- `AUTH_PROFILE_DELETE` -- delete profiles (with consumer impact check)
- `AUTH_PROFILE_DECRYPT` -- access decrypted secret values (should require ADMIN role)

### 3.2 HIGH-04: Tenant-level vs project-level permission boundaries

Tenant-level routes should require elevated permissions (admin-only):

| Route                           | Permission                         |
| ------------------------------- | ---------------------------------- |
| `GET /api/auth-profiles`        | `AUTH_PROFILE_READ` + admin role   |
| `POST /api/auth-profiles`       | `AUTH_PROFILE_WRITE` + admin role  |
| `DELETE /api/auth-profiles/:id` | `AUTH_PROFILE_DELETE` + admin role |

Project-level routes should use standard project permissions:

| Route                                   | Permission           |
| --------------------------------------- | -------------------- |
| `GET /api/projects/:pid/auth-profiles`  | `AUTH_PROFILE_READ`  |
| `POST /api/projects/:pid/auth-profiles` | `AUTH_PROFILE_WRITE` |

The existing `/api/tenant-credentials/` route has NO permission check at all -- just `requireAuth`. Auth Profile must not replicate this gap.

### 3.3 HIGH-05: Personal profile visibility enforcement at the query level

The design states `visibility: 'personal'` means "only creator." This MUST be enforced at the database query level, not as a post-query filter.

**Current pattern (EndUserOAuthToken):** Uses `{ tenantId, userId, provider }` as the unique index -- the `userId` is always in the query, enforcing ownership at the DB level.

**Current pattern (LLMCredential with credentialScope: 'user'):** Uses `ownerId` in queries.

**Auth Profile risk:** If the list query fetches all profiles in a project and then filters by `visibility === 'personal' && createdBy === userId` in application code, a timing side-channel leaks the count of other users' personal profiles.

**Recommendation:** The repository layer MUST add `createdBy` to the query filter when listing personal profiles:

```typescript
// For list queries, inject visibility filter:
if (!isAdmin) {
  filter.$or = [{ visibility: 'shared' }, { visibility: 'personal', createdBy: userId }];
}
```

### 3.4 Can admins see personal profiles?

**Not specified in design.** This needs a decision:

- **Option A:** Tenant admins can see all personal profiles (for audit, troubleshooting). The list endpoint returns them with `visibility: 'personal'` marker, but secrets remain redacted.
- **Option B:** Personal profiles are strictly private. Even admins cannot see them. Admins can only see that a personal profile _exists_ (count) but not its contents.

**Recommendation:** Option A for tenant admins, with audit logging when an admin views another user's personal profile. This is consistent with the platform's compliance posture (admins need visibility for security investigations). The `AUTH_PROFILE_DECRYPT` permission should still be required to see decrypted secrets.

---

## 4. Cross-Tenant Security Risks

### 4.1 CRITICAL-04: `linkedAppProfileId` cross-tenant reference

The `oauth2_token` profile links to an `oauth2_app` profile via `linkedAppProfileId`. If this ID references a profile in a different tenant, the token refresh flow will:

1. Load the linked app profile (potentially from another tenant)
2. Use that tenant's `clientId`/`clientSecret` to refresh tokens
3. Leak the foreign tenant's OAuth app credentials to the attacker

**Validation required:** When creating or updating an `oauth2_token`, validate that the `linkedAppProfileId` resolves to a profile in the SAME tenant:

```typescript
const linkedApp = await AuthProfile.findOne({
  _id: linkedAppProfileId,
  tenantId, // CRITICAL: same tenant
  authType: 'oauth2_app',
});
if (!linkedApp) throw new Error('Linked OAuth app not found');
```

**Additionally:** The token refresh service must re-validate tenant matching at refresh time, not just at creation time. A profile could be moved or the link could be tampered with.

### 4.2 CRITICAL-05: `proxyAuthProfileId` cross-tenant reference

The `proxy.proxyAuthProfileId` addon has the same cross-tenant risk. A malicious user could set `proxyAuthProfileId` to a profile in another tenant, causing requests to authenticate against a foreign proxy using stolen credentials.

**Recommendation:** Apply the same validation as CRITICAL-04: verify `tenantId` match on all foreign-key references to other auth profiles.

### 4.3 CRITICAL-06: Consumer `authProfileId` cross-project reference

When a `ConnectorConnection` in project A stores `authProfileId`, can that ID reference an Auth Profile in project B (same tenant)?

**Answer: It depends on the profile's scope.** Tenant-level profiles (projectId: null) are intentionally accessible by all projects. Project-level profiles should only be accessible within their project.

**Missing validation:** The design does not mandate that when a consumer in project X references an `authProfileId`, the system validates:

1. The auth profile belongs to the same tenant (enforced by tenantIsolationPlugin)
2. The auth profile is either tenant-scoped OR belongs to the same project

**Recommendation:** Add a validation function used by all consumers:

```typescript
function validateAuthProfileAccess(
  authProfileId: string,
  tenantId: string,
  projectId: string,
): Promise<AuthProfile> {
  return AuthProfile.findOne({
    _id: authProfileId,
    tenantId,
    $or: [
      { projectId: null }, // tenant-level: accessible by all projects
      { projectId }, // project-level: must match
    ],
  });
}
```

### 4.4 Resolution priority -- tenant fallback risk

The resolution chain (personal > shared > project > tenant) is safe because:

1. The tenantIsolationPlugin ensures all queries are tenant-scoped
2. Project-level resolution only looks within the same project
3. Tenant-level fallback only looks at profiles with `projectId: null`

No cross-tenant escalation is possible in this chain. **This is correct.**

However, the fallback from project to tenant means a project with no auth profile will silently use the tenant default. If the tenant admin changes the tenant-level profile, all projects without overrides are affected. This is intentional and matches GuardrailPolicy behavior, but should be documented as a behavior users should understand.

---

## 5. Visibility Model Risks

### 5.1 HIGH-06: "Claiming" a shared profile by setting `createdBy`

The `createdBy` field is set on creation and should be immutable. If an API allows updating `createdBy`, a user could "claim" someone else's shared profile and make it appear as their own, or change a shared profile to personal and deny access to others.

**Recommendation:**

1. `createdBy` MUST be immutable -- set from `ctx.user.id` on creation, never accepted from request body.
2. `visibility` changes (shared <-> personal) should be restricted: only the creator or an admin can change visibility.
3. Add a server-side check: `if (body.createdBy) delete body.createdBy;` in the update handler.

### 5.2 HIGH-07: User removal does not cascade to personal Auth Profiles

When a user is removed from a project (or deactivated from the tenant), their personal Auth Profiles remain in the database. The existing GDPR store (`MongoGDPRStore`) handles user anonymization for:

- Sessions, Messages, Contacts, Audit logs, Attachments, User records

But it does NOT handle:

- LLMCredential (scoped to user)
- EndUserOAuthToken (scoped to user)
- Future: Auth Profile with `visibility: personal`

**Recommendation:** Add Auth Profile to the GDPR cascade in `MongoGDPRStore`:

```typescript
async deletePersonalAuthProfiles(
  subjectId: string,
  tenantId: string
): Promise<number> {
  const result = await AuthProfile.deleteMany({
    tenantId,
    createdBy: subjectId,
    visibility: 'personal',
  });
  return result.deletedCount;
}
```

Also: when a user is removed from a project, revoke (not delete) their personal profiles in that project. The profiles may be needed for audit trail, so set `status: 'revoked'` rather than hard-deleting.

### 5.3 Tenant admin with tenant-level personal profile

If a tenant admin creates a tenant-level profile with `visibility: 'personal'`, who can use it?

- `scope: 'tenant'` means it is available across all projects
- `visibility: 'personal'` means only the creator can see/use it
- The creator is a tenant admin

This is a valid use case (admin's personal API key available across projects). The resolution logic correctly handles this: at step 1 (personal oauth2_token for user), it would match this profile when the admin is the active user.

**No issue here**, but it should be explicitly documented.

---

## 6. Data Residency and Compliance Assessment

### 6.1 Encrypted secrets co-location

The design stores `encryptedSecrets` as a single AES-256-GCM blob in the same MongoDB collection as other profile metadata. This matches the existing pattern:

- `LLMCredential`: `encryptedApiKey`, `encryptedEndpoint` in same collection
- `EnvironmentVariable`: `encryptedValue` in same collection
- `ConnectorConnection`: `encryptedCredentials` in same collection

The platform does not currently have separate secret storage (e.g., HashiCorp Vault). All encrypted values are in MongoDB with the `encryptionPlugin`.

**Assessment:** Acceptable for current architecture. If data residency requirements change (e.g., secrets must be in a separate region), the Auth Profile's single `encryptedSecrets` blob makes migration easier than the current scattered fields.

### 6.2 HIGH-08: Audit logging for credential operations

The existing credential routes log audit events:

```typescript
await logAuditEvent({
  userId: user.id,
  action: AuditActions.CREDENTIAL_CREATED,
  metadata: { credentialId, provider, scope },
});
```

Auth Profile must emit audit events for ALL credential-touching operations:

| Operation       | Audit Action                    | Metadata                                     |
| --------------- | ------------------------------- | -------------------------------------------- |
| Create profile  | `AUTH_PROFILE_CREATED`          | `{ profileId, authType, scope, visibility }` |
| Update profile  | `AUTH_PROFILE_UPDATED`          | `{ profileId, changedFields[] }`             |
| Delete profile  | `AUTH_PROFILE_DELETED`          | `{ profileId, authType, consumerCount }`     |
| Decrypt secrets | `AUTH_PROFILE_SECRETS_ACCESSED` | `{ profileId, accessedBy, purpose }`         |
| Token refresh   | `AUTH_PROFILE_TOKEN_REFRESHED`  | `{ profileId, connector, success }`          |
| Validate/test   | `AUTH_PROFILE_VALIDATED`        | `{ profileId, result }`                      |
| Status change   | `AUTH_PROFILE_STATUS_CHANGED`   | `{ profileId, from, to }`                    |
| Link consumer   | `AUTH_PROFILE_LINKED`           | `{ profileId, consumerType, consumerId }`    |

**Critical:** The `AUTH_PROFILE_SECRETS_ACCESSED` event is essential for security compliance. Any time the `encryptedSecrets` blob is decrypted (for runtime use, validation, or admin viewing), an audit entry must be created.

### 6.3 HIGH-09: Right to erasure cascade

The `MongoGDPRStore` does not currently cascade to LLMCredential or EndUserOAuthToken. Auth Profile consolidates these, so the GDPR implementation MUST include Auth Profile from day one.

**Cascade requirements:**

1. **User deletion:** Delete or anonymize all personal Auth Profiles where `createdBy === subjectId`.
2. **Shared profiles:** Do NOT delete shared profiles created by the deleted user. Instead, reassign `createdBy` to a system account or anonymize the `createdBy` field.
3. **Token revocation:** When deleting personal `oauth2_token` profiles, call the provider's revocation endpoint (if `revocationUrl` is configured in the linked `oauth2_app`) to ensure tokens are invalidated upstream.
4. **Audit trail:** Log the erasure in the audit log with the anonymized subject ID (SHA-256 hash, matching the existing pattern in `anonymizeAuditEntries`).

### 6.4 Data residency

The platform does not currently have explicit data residency requirements (no per-tenant region routing). Auth Profile does not change this. If data residency is added later, Auth Profile should be one of the first models to support it due to the sensitivity of stored credentials.

---

## 7. Additional Findings

### 7.1 Index design review

The proposed indexes are mostly correct but have gaps:

**Missing index for personal profile resolution:**

```
{ tenantId, projectId, connector, visibility, createdBy }
```

This is needed for the resolution priority chain: "Find personal oauth2_token for this user, connector, in this project."

**Missing index for token refresh cleanup:**

```
{ status, expiresAt, authType }
```

For batch jobs that find expired tokens to refresh or revoke.

**The `{ linkedAppProfileId }` index** is correct and necessary for cascade checks ("cannot delete oauth2_app with active tokens").

### 7.2 `encryptionPlugin` vs manual encryption

The existing `ConnectorConnection` model explicitly does NOT use `encryptionPlugin`:

```typescript
// NOTE: No encryptionPlugin — encryptedCredentials is managed by ConnectionService
// which uses findOneAndUpdate with pre-encrypted values
```

Auth Profile should use `encryptionPlugin` for automatic encryption/decryption, matching the `LLMCredential` and `EnvironmentVariable` patterns. The design's single `encryptedSecrets` blob (pre-encrypted JSON) suggests manual encryption.

**Recommendation:** Choose one approach and document it. If using manual encryption (pre-encrypted JSON blob), do NOT apply `encryptionPlugin` to the `encryptedSecrets` field (double encryption). If using `encryptionPlugin`, store individual fields rather than a blob.

### 7.3 Rate limiting on OAuth callback

The OAuth callback endpoint (`/api/projects/:pid/auth-profiles/oauth/callback`) should have rate limiting to prevent OAuth code brute-forcing. Use `withRouteHandler`'s `rateLimit` option:

```typescript
rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' }
```

### 7.4 The `config` field is typed as `Record<string, unknown>`

This allows arbitrary data in the non-sensitive config. While flexible, it means validation must happen at the application layer. The design includes a validation rules table (section 9) which is good, but:

- Validation must be enforced server-side (not just client-side)
- A Zod discriminated union schema based on `authType` should validate `config` contents on create/update

---

## 8. Summary of Required Actions

### Critical (must fix before implementation)

| ID          | Finding                                                                       | Risk                                |
| ----------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| CRITICAL-01 | Apply `tenantIsolationPlugin` to AuthProfile schema                           | Total tenant isolation failure      |
| CRITICAL-02 | Clarify `projectId: null` vs absent behavior; ensure unique index correctness | Duplicate profiles, data corruption |
| CRITICAL-03 | Define `AUTH_PROFILE_*` permissions in `StudioPermission`                     | No RBAC on credential operations    |
| CRITICAL-04 | Validate `linkedAppProfileId` tenant match on create AND refresh              | Cross-tenant credential theft       |
| CRITICAL-05 | Validate `proxyAuthProfileId` tenant match                                    | Cross-tenant proxy credential theft |
| CRITICAL-06 | Validate consumer `authProfileId` tenant + project scope                      | Cross-project credential access     |

### High (must fix before GA)

| ID      | Finding                                                             | Risk                              |
| ------- | ------------------------------------------------------------------- | --------------------------------- |
| HIGH-01 | Tenant-level routes must use `withRouteHandler` + admin permissions | Unauthenticated credential access |
| HIGH-02 | Define override semantics for project/tenant merge                  | Ambiguous profile resolution      |
| HIGH-03 | Project-level ID queries must include `projectId` in filter         | Cross-project profile access      |
| HIGH-04 | Define tenant vs project permission boundaries                      | Privilege escalation              |
| HIGH-05 | Enforce personal visibility at DB query level                       | PII leakage via timing            |
| HIGH-06 | Make `createdBy` immutable; restrict `visibility` changes           | Profile ownership hijacking       |
| HIGH-07 | Cascade user removal to personal Auth Profiles                      | Orphaned credentials              |
| HIGH-08 | Full audit logging for all credential operations                    | Compliance gap                    |
| HIGH-09 | GDPR erasure cascade for Auth Profiles                              | Right to erasure violation        |
