# Cross-Feature Security Review

**Date**: 2026-04-09
**Scope**: Project RBAC LLD + Custom Project Roles spec + Workspace Management spec + User Lifecycle Management spec
**Reviewer**: Security Engineer (Opus 4.6)
**Source Code Verified**: Yes -- all source files listed in scope were read and cross-referenced

---

## Verdict: CONDITIONAL PASS

All four artifacts demonstrate solid security awareness. Tenant isolation via `tenantIsolationPlugin`, 404-not-403 for cross-scope, centralized auth (`requireAuth` / `requireTenantAuth`), and audit logging are consistently specified. However, there are **3 CRITICAL** findings (two systemic, one per-feature) and **9 HIGH** findings that must be addressed before implementation.

---

## CRITICAL Security Findings

### S-1 [CRITICAL] No permission ceiling on custom role creation -- `*:*` escalation vector

**Artifacts**: Custom Project Roles spec (FR-2, FR-4), Project RBAC LLD (Phase 2)
**Source**: `packages/shared/src/rbac/permission-resolver.ts` lines 96-107

The Custom Project Roles spec (Section 12 -- Security & Compliance) says "Permission strings are validated against a known set of `{resourceType}:{operation}` patterns to prevent injection of arbitrary permission strings." However, it does NOT specify that custom roles cannot include `*:*` (the wildcard that grants all permissions). The `hasPermission()` function at `permission-resolver.ts:97` treats `*:*` as a universal grant.

**Attack scenario**: A tenant ADMIN with `tenant:manage_members` permission creates a custom role with `permissions: ['*:*']`, assigns it to a project member, and that member now has OWNER-equivalent permissions across all projects in the tenant. Worse, a project admin (who cannot manage custom roles) can convince a workspace admin to create a role with `*:*` -- the admin may not understand the implication.

**Fix**: The custom role CRUD API must enforce a permission ceiling:

1. Custom roles must NOT include `*:*` -- only explicit `{resource}:{operation}` pairs from an allowlist
2. Validate each permission string against `VALID_PERMISSION_STRINGS` (derived from `PROJECT_ROLE_PERMISSIONS` union)
3. Consider: the creator of a custom role should not be able to grant permissions they do not themselves possess (principle of least privilege)

### S-2 [CRITICAL] `requireProjectAccess` grants access to ALL same-tenant users -- no membership check

**Artifacts**: Project RBAC LLD (D-10, Phase 2), Custom Project Roles spec (FR-4, FR-5)
**Source**: `apps/studio/src/lib/project-access.ts` lines 52-57

The LLD correctly identifies this at D-10: `requireProjectAccess` grants access to ALL same-tenant users via the primary path at line 53-57, which does `findProjectByIdAndTenant(projectId, user.tenantId)`. If the user has a `tenantId`, the function returns success without checking `ProjectMember`. This means:

- **Any tenant member can read the project member list** (GET endpoint uses only `requireProjectAccess`)
- **The "available members" endpoint exposes the full tenant member list** to any same-tenant user, including their email, name, and avatarUrl

The LLD acknowledges this at Phase 2 ("Read-only access: Any same-tenant user who passes requireProjectAccess can list members") but this is a deliberate design choice that should be documented as a security tradeoff, not just an implementation note.

**Impact**: In multi-project tenants, a user in Project A can enumerate all members of Project B (including names and emails) even though they have no business accessing Project B's members. The "available members" endpoint (Phase 2.4) exposes the entire tenant member roster.

**Fix**:

1. For `GET /api/projects/:id/members`: Require the caller to be a project member OR tenant admin -- not just a tenant member
2. For `GET /api/projects/:id/members/available`: Already specified as admin-only (correct), but verify the service-layer check is enforced, not just `requireProjectAccess`
3. Document the tradeoff explicitly in the spec if tenant-wide visibility is intentional

### S-3 [CRITICAL] No TenantMember status check in auth middleware today -- 30s window is actually infinite

**Artifacts**: User Lifecycle Management spec (FR-2, Section 12), Project RBAC LLD
**Source**: `apps/studio/src/lib/auth.ts` lines 32-73, `apps/studio/src/repos/auth-repo.ts` lines 142-161

The User Lifecycle spec proposes adding a `TenantMember.status` field checked in auth middleware with a 30s Redis cache. However, the current `getAuthenticatedUser()` function (auth.ts:32-73) does NOT check TenantMember status at all -- it only verifies the JWT, loads the user from DB, resolves tenant context, and returns permissions. There is no status check anywhere in the current auth pipeline.

This means:

- **Today**: There is no member status enforcement. The spec's "30s cache window" framing implies an existing check is being cached -- it is not. The entire status enforcement must be built from scratch.
- **After implementation**: The 30s Redis cache TTL means a locked/suspended user can still make API calls for up to 30 seconds. Combined with the fact that `revokeUserRefreshTokens()` revokes refresh tokens but does NOT revoke JWTs (which are stateless and 15-min-lived per auth config), a locked user retains access for up to **15 minutes** (JWT expiry) unless the status check is added to EVERY authenticated endpoint.

**Fix**:

1. FR-2 must be explicit: this is a new enforcement point, not a cache optimization of an existing check
2. The status check MUST be in `getAuthenticatedUser()` (affects all Studio routes) and in the runtime's auth middleware (affects all runtime API routes)
3. Specify JWT behavior: either add JWT blacklisting (Redis set of revoked JTIs) or accept the 15-minute window and document it. The spec says "JWTs are short-lived (15 minutes per auth config) and expire naturally -- no JWT revocation list is needed" but 15 minutes of continued access for a locked user is a compliance risk for enterprise customers.

---

## HIGH Security Findings

### S-4 [HIGH] Dev-login bypasses TenantMember status checks and auto-grants OWNER role

**Artifact**: User Lifecycle Management spec (FR-2, FR-13)
**Source**: `apps/studio/src/app/api/auth/dev-login/route.ts` lines 58-79, 125-279

The dev-login route (gated by `ENABLE_DEV_LOGIN=true`) creates users and auto-attaches them to tenants with OWNER role (line 66). It does not check:

1. Whether the user's TenantMember status is `active`, `suspended`, or `locked`
2. Whether the tenant is `archived` (Workspace Management spec)
3. Whether the user has been explicitly locked by an admin

While dev-login is gated by an env var, in practice `ENABLE_DEV_LOGIN=true` is set in all non-production environments including staging. A suspended user could bypass their suspension by using the dev-login endpoint if it is available.

**Fix**:

1. After the User Lifecycle feature ships, dev-login must check `TenantMember.status` before issuing tokens
2. After the Workspace Management feature ships, dev-login must check `Tenant.status !== 'archived'` before attaching users
3. Consider: add a comment/TODO in the dev-login route warning about this gap

### S-5 [HIGH] Workspace deletion cascade has no atomic boundary -- partial deletion is irrecoverable

**Artifact**: Workspace Management spec (FR-9, Section 12 -- Data Lifecycle)
**Source**: Tenant model (`packages/database/src/models/tenant.model.ts`)

The spec lists 100+ collections for cascading deletion across 12 categories. It says "The permanent deletion cascade must be wrapped in a transaction or use ordered sequential deletion to handle partial failures." However:

1. MongoDB multi-document transactions across collections have significant performance impact and a 60-second timeout limit
2. If the cascade fails halfway (e.g., after deleting projects but before deleting sessions), there is no rollback mechanism specified
3. The cascade must also clean `User.defaultTenantId` and `User.favoriteTenantIds` across ALL users -- this is a cross-collection write with no isolation guarantee

**Fix**:

1. Specify an idempotent, resumable cascade: use a `deletionState` field on the Tenant with phases (`deleting_projects`, `deleting_sessions`, ..., `complete`). The cleanup job picks up from where it left off.
2. Do NOT use MongoDB transactions for the cascade -- they will timeout. Use ordered sequential deletion with checkpointing.
3. Before permanent deletion, snapshot the `tenantId` and affected `User._id` list so that `defaultTenantId`/`favoriteTenantIds` cleanup can be retried.

### S-6 [HIGH] Account lockout as denial-of-service: attacker can lock ANY user's account

**Artifact**: User Lifecycle Management spec (FR-13, Section 7)
**Source**: `apps/studio/src/repos/auth-repo.ts` lines 110-137, `packages/config/src/schemas/auth.schema.ts` lines 55-63

FR-13 specifies: "The system must automatically set `TenantMember.status` to `locked` when the User-level temporal lock (`loginLockedUntil`) is triggered by failed login attempts." The lockout config is 5 failed attempts / 15-minute lock.

**Attack scenario**: An attacker who knows any user's email address can intentionally fail 5 login attempts (which are rate-limited at 10/15min per IP -- but an attacker with 2 IPs can hit 5 failures easily) and lock that user out of ALL workspaces for 15 minutes. Combined with the new User Lifecycle feature, this lock propagates to `TenantMember.status = 'locked'` across ALL workspaces.

The spec acknowledges this in Open Question 1 but does not resolve it. The rate limit (10 attempts / 15 min per IP) allows 5 failures per IP before lockout, meaning a single IP can lock any account.

**Fix**:

1. The temporal lockout should NOT automatically propagate to `TenantMember.status = 'locked'`. Instead, treat them as separate concerns: `loginLockedUntil` prevents login; `TenantMember.status` is admin-controlled.
2. If propagation is desired, require the lockout threshold to be higher than the rate limit (e.g., 20 failures in 15 min) so rate limiting kicks in before lockout.
3. Add CAPTCHA after 3 failed attempts as a mitigation before lockout.

### S-7 [HIGH] Custom role parent chain can amplify permissions silently

**Artifact**: Custom Project Roles spec (FR-5), Permission resolver source
**Source**: `packages/shared/src/rbac/permission-resolver.ts` lines 131-163

`resolveRolePermissions()` walks the parent chain and merges permissions from all ancestors. The cycle guard prevents infinite loops, but there is no check that the parent role's permissions are a superset or subset of the child. This means:

1. A custom role with `parentRoleId` pointing to the system `admin` role inherits `*:*` (all permissions)
2. An admin creates a "read-only-auditor" custom role with `parentRoleId = admin_system_role_id` -- it silently inherits admin-level permissions
3. The UI shows only the custom role's explicit permissions, not the inherited ones, creating a false sense of restriction

**Fix**:

1. When displaying custom roles, always show the **resolved** (merged) permission set, not just the explicit permissions
2. Prevent custom roles from having a `parentRoleId` pointing to a system role with `*:*` or broader permissions than intended
3. The "duplicate" operation (FR-3) should copy permissions as explicit values, NOT set `parentRoleId` to the source role

### S-8 [HIGH] Bulk operations lack per-operation authorization -- one admin check for N mutations

**Artifact**: Project RBAC LLD (Phase 2.5), User Lifecycle Management spec (FR-7, FR-8)
**Source**: LLD Phase 2 task 2.5

Both features specify bulk operations (bulk-add-members, bulk-role-change, bulk-remove) with a single `assertCallerCanManageMembers` check at the start. However:

1. The caller's permissions might change mid-batch (e.g., they are demoted to viewer after the check but before the batch completes)
2. In the Project RBAC LLD, the 50-member batch limit is Zod-validated, but there is no rate limiting on the endpoint itself -- an attacker can send 1000 requests of 50 members each in parallel
3. The User Lifecycle spec's bulk invite accepts CSV with 100 items -- CSV parsing in memory with no streaming is safe for 100 items, but the 1MB file size limit could allow adversarial payloads (e.g., CSV with 100 rows but each cell contains 10KB of data)

**Fix**:

1. Add per-endpoint rate limiting on bulk operations (e.g., 5 bulk requests per minute per user)
2. Validate total payload size after CSV parsing, not just file size before parsing
3. For the "bulk role change" operation, re-verify authorization after every N items (e.g., every 10) to handle concurrent permission revocation
4. Specify: can a user be added to the bulk remove list if they themselves initiated the bulk remove? (Self-removal in bulk is ambiguous)

### S-9 [HIGH] `findDefaultTenantMembership` does not filter archived workspaces

**Artifact**: Workspace Management spec (FR-1, FR-7)
**Source**: `apps/studio/src/repos/auth-repo.ts` lines 369-380

`findDefaultTenantMembership()` returns the oldest TenantMember by `createdAt` without checking `Tenant.status`. After the Workspace Management feature adds workspace archiving:

1. If a user's oldest workspace is archived, login resolves to the archived workspace
2. The spec says "Archived workspaces must be excluded from... login resolution" (FR-7) but the actual code path (`findDefaultTenantMembership`) loads the Tenant record at line 376 but does not filter by status

**Fix**: FR-1 implementation must update `findDefaultTenantMembership()` to:

1. First check `User.defaultTenantId` (new field)
2. If set, verify the tenant is not `archived` AND the user is still a member
3. If not set or invalid, query `TenantMember.find({ userId }).sort({ createdAt: 1 })` joined with `Tenant.status === 'active'` -- skip archived tenants
4. Document this as a dependency in the Workspace Management spec's delivery plan

### S-10 [HIGH] `requireAdminRole` in auth.ts returns 403 not 404 -- leaks workspace existence

**Artifact**: All features using workspace-scoped admin endpoints
**Source**: `apps/studio/src/lib/auth.ts` lines 143-158

The `requireAdminRole()` function returns `{ error: 'Insufficient permissions' }, { status: 403 }` when a user is not an OWNER/ADMIN. Per the platform's core invariant (CLAUDE.md line 1: "Cross-scope access returns 404 (not 403) to avoid leaking existence"), this should return 404 for cross-tenant callers. However, `requireAdminRole` queries `TenantMember.findOne({ userId, tenantId, role: { $in: ['OWNER', 'ADMIN'] } })` -- if the user is not a member of the tenant at all, the 403 leaks that the tenantId exists.

**Fix**: Change `requireAdminRole` to first verify tenant membership (`TenantMember.findOne({ userId, tenantId })`). If no membership exists, return 404. If membership exists but role is insufficient, return 403. This is safe because the 403 only fires for users who are already members and therefore know the tenant exists.

### S-11 [HIGH] Workspace slug update enables phishing via URL hijacking

**Artifact**: Workspace Management spec (FR-6)

FR-6 allows OWNERs and ADMINs to update workspace slugs. If workspace URLs follow the pattern `app.example.com/{slug}/...`, an attacker who is an ADMIN of a workspace could change the slug to impersonate another workspace (e.g., changing `my-workspace` to `acme-corp` after the real `acme-corp` is deleted or before it is created). The spec mentions "slug uniqueness validation" but does not address:

1. Slug recycling: can a deleted workspace's slug be immediately reused?
2. Reserved slugs: are slugs like `admin`, `api`, `auth`, `settings` blocked?
3. Slug history: does the old slug redirect to the new one, or does it become immediately available?

**Fix**:

1. Maintain a `slug_history` table with a 90-day cooldown before slug reuse
2. Define a reserved slug list (at minimum: `admin`, `api`, `auth`, `settings`, `login`, `signup`, `workspace`)
3. Log slug changes as security-relevant audit events (already specified in the spec -- good)

### S-12 [HIGH] No cross-feature coordination on `revokeUserRefreshTokens` scope

**Artifacts**: User Lifecycle Management (FR-5), Workspace Management (FR-7), Custom Project Roles (FR-6)

`revokeUserRefreshTokens(userId)` at `auth-repo.ts:245-254` revokes ALL refresh tokens for a user across ALL workspaces. This is called from:

1. User Lifecycle: when `TenantMember.status` transitions away from `active` in workspace A
2. Workspace Management: (implied) when workspace is archived

The problem: revoking tokens for a user in workspace A also invalidates their sessions in workspaces B, C, D. The User Lifecycle spec acknowledges workspace-scoped status ("suspending in workspace A must NOT affect workspace B") but the token revocation is user-scoped, not tenant-scoped.

**Fix**:

1. `revokeUserRefreshTokens` must be scoped to the tenant: revoke only tokens issued for the specific tenant context (this requires storing `tenantId` on `RefreshToken` records -- check if this field exists)
2. If `RefreshToken` lacks `tenantId`, add it and backfill. Until then, document this as a known cross-workspace side effect.
3. The Custom Project Roles spec's cache invalidation (60s TTL) does not need token revocation, but the feature interaction must be documented.

---

## MEDIUM Security Findings

### S-13 [MEDIUM] Permission cache (60s) allows stale permissions after role change

**Artifacts**: Custom Project Roles (FR-6), Project RBAC LLD (Section 6)
**Source**: `apps/runtime/src/services/permission-resolution.ts` line 21, runtime `evaluateProjectPermission` at rbac.ts:368-369

Both the runtime and Studio cache resolved permissions for 60 seconds. If a custom role's permissions are modified, all users with that role continue operating with the old permissions for up to 60 seconds. This is documented and accepted in the Custom Project Roles spec (GAP-003), but the combined effect with the LLD's `memberCache` (5-second TTL in runtime) creates a scenario where:

1. A user is removed as project member (5s runtime cache)
2. Their cached permissions are still valid (60s permission cache)
3. Net effect: the user can still act on the project for up to 60 seconds after removal

**Mitigation**: Acceptable for v1 if documented. For v2, add Redis pub/sub to invalidate both caches on role/membership changes.

### S-14 [MEDIUM] CSV upload -- formula injection not addressed

**Artifact**: User Lifecycle Management spec (Section 7 -- CSV Bulk Invite)

The spec validates email format and file size but does not mention CSV formula injection. A malicious CSV like `=HYPERLINK("evil.com",email@corp.com)` in the email column would pass Zod email validation (it wouldn't -- `z.string().email()` would reject it). However, if the CSV is echoed back in error responses or downloaded as a report, formula injection payloads could execute in spreadsheet software.

**Mitigation**: Sanitize all CSV cell values by stripping leading `=`, `+`, `-`, `@`, `\t`, `\r` characters before processing.

### S-15 [MEDIUM] `ProjectMember` model lacks `tenantId` -- cross-tenant validation requires join

**Artifact**: Custom Project Roles spec (GAP-004)
**Source**: `packages/database/src/models/project-member.model.ts`

The `ProjectMember` model has `projectId` and `userId` but no `tenantId`. Validating that a `customRoleId` belongs to the same tenant as the project member requires a join through the project to get `tenantId`. This join must be explicit and tested -- if it is missed, a custom role from tenant A could be assigned to a project member in tenant B (if the attacker can craft the correct `customRoleId`).

**Mitigation**: When assigning `customRoleId` to a `ProjectMember`:

1. Load the `Project` record to get `tenantId`
2. Verify `RoleDefinition.tenantId === project.tenantId`
3. Consider adding `tenantId` to `ProjectMember` index for defense-in-depth

### S-16 [MEDIUM] Workspace deletion confirmation (re-type name) is client-side only

**Artifact**: Workspace Management spec (FR-10)

FR-10 says "The system must require the user to re-type the workspace name in a confirmation dialog before archiving." This is UI-only confirmation. The `DELETE /api/workspaces/:tenantId` endpoint has no server-side confirmation token or challenge. An attacker with a stolen OWNER JWT can call the DELETE endpoint directly.

**Mitigation**: Add a `confirmationName` field to the DELETE request body. The server verifies `body.confirmationName === workspace.name` before proceeding. This is a low-cost defense that prevents automated deletion attacks.

### S-17 [MEDIUM] Self-role-change prevention not specified in Project RBAC LLD

**Artifact**: Project RBAC LLD (Phase 2)

The LLD specifies "Cannot remove the project owner" and "Cannot remove self if sole admin" but does not specify: can a project admin change their OWN role? If yes, an admin can demote themselves to viewer, removing the last admin from the project (if the owner's auto-created admin record was somehow removed).

**Mitigation**: Add an explicit check: `callerUserId === targetUserId && newRole !== currentRole` should be blocked for self-demotion when the caller is the sole admin. The User Lifecycle spec gets this right ("Self-modification is forbidden -- cannot lock/suspend yourself").

---

## Per-Feature Security Assessment

### Project RBAC LLD

| Area             | Assessment                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth model       | SOUND. Two-layer model (route-level `requireProjectAccess` + service-level `assertCallerCanManageMembers`) is well-designed. D-10 correctly identifies gap |
| Isolation        | STRONG. Cross-tenant returns 404 (Scenario 8). `findProjectByIdAndTenant` enforces tenant scoping. Member listing requires project membership              |
| Input validation | GOOD. Zod schemas on all endpoints, max 50 items on bulk. Missing: rate limiting on bulk endpoints                                                         |
| Audit trail      | GOOD. Four distinct audit actions. Distinguishes project-level from tenant-level events                                                                    |
| Escalation guard | GOOD. D-14 deletion guard, sole-admin protection, owner-removal prevention. Missing: self-demotion guard (S-17)                                            |

### Custom Project Roles

| Area             | Assessment                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth model       | SOUND. Tenant OWNER/ADMIN required for mutations, tenant membership for reads. `createUnifiedAuthMiddleware` specified                       |
| Isolation        | STRONG. `tenantIsolationPlugin` on `RoleDefinition`, cross-tenant returns 404, `createdBy` tracking                                          |
| Input validation | GAP. No permission ceiling (S-1). `*:*` can be assigned to custom roles. Permission string injection partially addressed but needs allowlist |
| Escalation guard | GAP. No guard against creating roles more permissive than creator's own role. Parent chain amplification (S-7)                               |
| Cache behavior   | ACCEPTABLE. 60s TTL documented as GAP-003. No active invalidation in v1                                                                      |

### Workspace Management

| Area             | Assessment                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth model       | SOUND. OWNER-only for deletion, OWNER/ADMIN for settings, authenticated for preferences. Correct role hierarchy                                           |
| Isolation        | STRONG. User preferences on User model (cross-tenant by design, but validated against active memberships). Workspace deletion requires OWNER              |
| Deletion safety  | GAP. No atomic cascade (S-5). No server-side confirmation (S-16). No slug reuse cooldown (S-11). Grace period well-designed but cleanup job unspecified   |
| Session handling | GAP. "Active sessions in archived workspace terminated within 5 minutes" -- mechanism not specified. JWTs are stateless; requires active session tracking |
| Data lifecycle   | GOOD. Comprehensive cascade list. `defaultTenantId`/`favoriteTenantIds` cleanup specified. Audit log retention question identified as open                |

### User Lifecycle Management

| Area            | Assessment                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth model      | SOUND. Role hierarchy enforcement (admin cannot modify equal/higher). Self-modification forbidden. Last OWNER protection                               |
| Isolation       | STRONG. Per-workspace status independence. Bulk operation tenant verification. Cross-workspace enumeration returns 404                                 |
| Lockout model   | GAP. Auto-lock propagation creates DoS vector (S-6). Interaction between User-level lock and TenantMember status is complex and under-specified        |
| Token lifecycle | GAP. `revokeUserRefreshTokens` is user-scoped, not tenant-scoped (S-12). JWT statelessness means 15-min access window after lock                       |
| Email security  | GOOD. Fire-and-forget is acceptable for v1. Toggle scope (transactional always sent) is correct. CSV injection partially mitigated by email validation |

---

## Cross-Feature Attack Scenarios

### Attack 1: Privilege Escalation via Custom Role + Project Assignment

1. Alice is a tenant ADMIN. She creates a custom role "super-developer" with permissions `['*:*']` (S-1 -- no ceiling)
2. Alice assigns "super-developer" to Bob in Project P1 via `PATCH /api/projects/P1/members/Bob { customRoleId: superDevRoleId }`
3. Bob now has `*:*` at the project level -- equivalent to project admin
4. Bob uses his `*:*` permissions to add other members, change roles, and access all project resources

**Mitigation**: Permission ceiling (S-1 fix) blocks step 1. Even if ADMIN creates such a role, the runtime's `evaluateProjectPermission` would resolve `*:*` for Bob, which matches any permission check.

### Attack 2: Locked User Retains Access Across Features

1. Admin suspends UserA in workspace W1 (User Lifecycle)
2. `revokeUserRefreshTokens(UserA.id)` revokes ALL tokens (S-12 -- cross-workspace impact)
3. UserA's active JWT for workspace W2 is still valid for 15 minutes (S-3 -- no JWT revocation)
4. UserA is locked out of W1 AND W2, but can still make API calls in W2 for 15 minutes
5. Meanwhile, UserA's `TenantMember` in W2 is NOT affected (correct per spec), but their tokens ARE revoked (incorrect)

**Mitigation**: Scope token revocation to tenant (S-12 fix). Add JWT status check to auth middleware (S-3 fix).

### Attack 3: Workspace Slug Hijack After Deletion

1. Attacker observes that `acme-corp` workspace is archived (30-day grace period)
2. After 30 days, `acme-corp` is permanently deleted
3. Attacker creates a new workspace with slug `acme-corp` (FR-5 -- create from switcher)
4. Any bookmarks, API integrations, or shared URLs pointing to `acme-corp` now resolve to the attacker's workspace
5. Users who auto-login to their "default workspace" may be redirected if they had `acme-corp` as default

**Mitigation**: Slug reuse cooldown (S-11 fix). Clear `defaultTenantId` references during permanent deletion (specified in spec -- good).

### Attack 4: Bulk Operation Abuse for DoS

1. Attacker is a tenant ADMIN with access to bulk endpoints
2. Attacker sends 100 parallel requests to `POST /api/projects/:id/members/bulk` with 50 members each (5000 member additions)
3. Each addition triggers an audit event write, a membership check, and potentially an email notification
4. MongoDB write amplification: 5000 inserts + 5000 audit writes + 5000 email sends = system degradation

**Mitigation**: Per-endpoint rate limiting on bulk operations (S-8 fix).

---

## Recommended Security Controls

### Must-Have Before Implementation

| Control                                      | Features Affected         | Priority |
| -------------------------------------------- | ------------------------- | -------- |
| Permission ceiling on custom roles           | Custom Roles              | CRITICAL |
| Scoped token revocation (per-tenant)         | User Lifecycle, Workspace | HIGH     |
| TenantMember status check in auth middleware | All features              | CRITICAL |
| Rate limiting on bulk endpoints              | Project RBAC, User LC     | HIGH     |
| Server-side deletion confirmation            | Workspace Management      | MEDIUM   |

### Should-Have Before GA

| Control                                        | Features Affected    | Priority |
| ---------------------------------------------- | -------------------- | -------- |
| Slug reuse cooldown (90 days)                  | Workspace Management | HIGH     |
| `requireAdminRole` 404-not-403 for non-members | All admin endpoints  | HIGH     |
| Idempotent resumable cascade deletion          | Workspace Management | HIGH     |
| Self-demotion guard for sole admin             | Project RBAC         | MEDIUM   |
| CSV formula injection sanitization             | User Lifecycle       | MEDIUM   |
| Resolved permissions display in role UI        | Custom Roles         | MEDIUM   |

### Defense-in-Depth (Post-GA)

| Control                                                       | Features Affected          |
| ------------------------------------------------------------- | -------------------------- |
| Redis pub/sub for active permission cache invalidation        | All features               |
| JWT blacklisting for immediate access revocation              | User Lifecycle             |
| `tenantId` field on `ProjectMember` for query-level isolation | Project RBAC, Custom Roles |
| CAPTCHA after 3 failed login attempts                         | User Lifecycle             |

---

## Appendix: Source Files Reviewed

| File                                                    | Security-Relevant Observations                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/middleware/rbac.ts`                   | `evaluateProjectPermission` at line 368-369 reads only `member.role`, ignores `customRoleId`. `PROJECT_ROLE_PERMISSIONS` has `admin: ['*:*']` -- wildcard bypass |
| `apps/studio/src/lib/project-access.ts`                 | Primary path at line 53-57 grants access to all same-tenant users without membership check                                                                       |
| `apps/studio/src/lib/auth.ts`                           | No TenantMember status check in `getAuthenticatedUser()`. `requireAdminRole` returns 403 not 404 for non-members                                                 |
| `apps/studio/src/repos/auth-repo.ts`                    | `lockUserAccount()` exists but has no API route. `revokeUserRefreshTokens()` is user-scoped, not tenant-scoped                                                   |
| `packages/shared/src/rbac/permission-resolver.ts`       | `hasPermission()` treats `*:*` as universal grant. `resolveRolePermissions()` has cycle guard but no depth limit                                                 |
| `apps/runtime/src/services/permission-resolution.ts`    | 60s cache TTL. Supports `customRoleId` already -- but `evaluateProjectPermission` never passes it                                                                |
| `packages/database/src/models/role-definition.model.ts` | `tenantIsolationPlugin` and `auditTrailPlugin` applied. No permission string validation at model level                                                           |
| `packages/database/src/models/project-member.model.ts`  | No `tenantId` field. No tenant isolation plugin (relies on `projectId` scoping)                                                                                  |
| `packages/database/src/models/tenant-member.model.ts`   | No `status` field currently. Has `tenantIsolationPlugin`                                                                                                         |
| `packages/database/src/models/user.model.ts`            | `loginLockedUntil` and `failedLoginAttempts` exist. No `defaultTenantId` or `favoriteTenantIds` yet                                                              |
| `apps/studio/src/app/api/auth/dev-login/route.ts`       | Gated by `ENABLE_DEV_LOGIN`. Auto-creates OWNER membership. No status checks                                                                                     |
| `apps/studio/src/lib/auth-constants.ts`                 | Lockout: 5 attempts / 15 min. Rate limits: 10 login attempts / 15 min per IP                                                                                     |
