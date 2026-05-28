# Cross-Feature Architect Review

**Date**: 2026-04-09
**Scope**: Project RBAC LLD + Custom Project Roles spec + Workspace Management spec + User Lifecycle Management spec
**Reviewer**: Architect (Opus 4.6)
**Artifacts Reviewed**:

1. `docs/plans/2026-04-09-project-rbac-management-impl-plan.md` (LLD, 5 audit rounds complete)
2. `docs/features/custom-project-roles.md` (Feature Spec, PLANNED)
3. `docs/features/workspace-management-v1-parity.md` (Feature Spec, PLANNED)
4. `docs/features/user-lifecycle-management.md` (Feature Spec, PLANNED)

**Source Files Verified**:

- `apps/runtime/src/middleware/rbac.ts` -- `evaluateProjectPermission`, `PROJECT_ROLE_PERMISSIONS`
- `apps/runtime/src/services/permission-resolution.ts` -- `resolveEffectivePermissions`, `BUILTIN_ROLE_PERMISSIONS`
- `apps/studio/src/lib/project-access.ts` -- `requireProjectAccess`
- `apps/studio/src/lib/permission-resolver.ts` -- `resolveStudioPermissions`
- `packages/shared/src/rbac/permission-resolver.ts` -- `hasPermission`, `resolveRolePermissions`
- `packages/database/src/models/role-definition.model.ts`
- `packages/database/src/models/tenant-member.model.ts`
- `packages/database/src/models/project-member.model.ts`
- `packages/database/src/models/tenant.model.ts`
- `packages/database/src/models/user.model.ts`
- `packages/database/src/constants/system-roles.ts`
- `apps/studio/src/repos/workspace-repo.ts`
- `apps/studio/src/repos/auth-repo.ts`

---

## Verdict: CONDITIONAL PASS

The four artifacts compose into a coherent system with no fundamental architectural contradictions. The permission model is layered correctly, the data models are compatible, and the implementation order is sound. However, there are 3 CRITICAL and 7 HIGH findings that must be addressed to avoid cross-feature integration failures.

---

## Cross-Feature Findings

### [CRITICAL] CF-1: Two Divergent Permission Resolution Chains Will Conflict Under Custom Roles

- **Affects**: Custom Project Roles spec, Project RBAC LLD
- **Finding**: There are TWO separate permission resolution chains that operate at different scopes, and custom roles must be wired into BOTH -- but only one is addressed in the artifacts.

  **Chain 1 (Tenant-level, resolved on login)**: Studio's `resolveStudioPermissions()` at `apps/studio/src/lib/permission-resolver.ts:91-152` resolves the user's TENANT-level role (OWNER/ADMIN/MEMBER/VIEWER) by loading `RoleDefinition` records for the tenant and walking the parent chain. It already handles `customRoleId` correctly (line 115-116: prefers `customRoleId` over role name lookup). This feeds `user.permissions` in the JWT/session, which is consumed by `hasPermission(ctx.permissions, 'project:*')` checks.

  **Chain 2 (Project-level, resolved per request)**: The runtime's `evaluateProjectPermission()` at `apps/runtime/src/middleware/rbac.ts:203-391` resolves the user's PROJECT-level role. It loads `ProjectMember.role` (line 368) and maps it through the hardcoded `PROJECT_ROLE_PERMISSIONS` (line 369). It does NOT read `customRoleId`. The Custom Roles spec's FR-5 correctly identifies this gap.

  **The problem**: The Custom Roles spec (FR-5) says to update `evaluateProjectPermission` to consult `ProjectMember.customRoleId`, but `evaluateProjectPermission` uses `PROJECT_ROLE_PERMISSIONS` (a static map), while custom roles need to load `RoleDefinition` from the database and call `resolveRolePermissions()`. This means the runtime must import and call the same resolution logic that the tenant-level resolver uses -- but the runtime currently has its OWN `resolveEffectivePermissions()` in `apps/runtime/src/services/permission-resolution.ts:105-150` which handles tenant-level custom roles.

  The gap is: **no artifact specifies how project-level custom role resolution interacts with or reuses tenant-level resolution**. If both resolvers independently load `RoleDefinition` records and walk parent chains, they'll produce different permission sets (tenant-level SYSTEM_ROLES vs project-level PROJECT_ROLE_PERMISSIONS as fallbacks).

- **Evidence**:
  - Runtime `evaluateProjectPermission`: `apps/runtime/src/middleware/rbac.ts:368-369` -- reads `member.role`, maps through `PROJECT_ROLE_PERMISSIONS[role]`
  - Runtime `resolveEffectivePermissions`: `apps/runtime/src/services/permission-resolution.ts:105-150` -- handles tenant-level `customRoleId` with `BUILTIN_ROLE_PERMISSIONS` fallback
  - Studio `resolveStudioPermissions`: `apps/studio/src/lib/permission-resolver.ts:91-152` -- handles tenant-level `customRoleId` with `SYSTEM_ROLES` fallback
  - Custom Roles spec FR-5: "The system must resolve custom role permissions through the `evaluateProjectPermission` function"
  - `PROJECT_ROLE_PERMISSIONS` (project-level) has different permission strings than `BUILTIN_ROLE_PERMISSIONS` (tenant-level) -- `agent:*` vs `agent:read,agent:update,agent:execute`

- **Recommendation**: The Custom Roles spec or HLD must specify a unified resolution architecture:
  1. Extract a shared `resolveProjectPermissions(member: ProjectMember, tenantId: string)` function that: (a) if `customRoleId` is set, loads `RoleDefinition` and walks parent chain via existing `resolveRolePermissions()`; (b) if null, falls back to `PROJECT_ROLE_PERMISSIONS[role]`.
  2. Both runtime `evaluateProjectPermission` and Studio's project-level permission checks must call this same function.
  3. Document which permission namespace custom project roles use -- `PROJECT_ROLE_PERMISSIONS` uses `agent:*`, `tool:*`, `version:*`, etc. while `SYSTEM_ROLES` uses `agent:*`, `tool:*`, `knowledge_base:*`, etc. A custom role's permission strings must align with the PROJECT namespace, not the TENANT namespace.

- **Impact if not fixed**: Custom roles will be resolved differently by the runtime vs Studio, leading to users having different effective permissions depending on which service handles the request. This is a security gap.

---

### [CRITICAL] CF-2: User Lifecycle Status Check Missing from Runtime RBAC Chain

- **Affects**: User Lifecycle Management spec, Project RBAC LLD
- **Finding**: The User Lifecycle spec (FR-2) says "The system must check `TenantMember.status` in auth middleware for every authenticated request and deny access with HTTP 403 when status is not `active`." The spec says this is in Studio auth middleware with Redis caching.

  However, the runtime has its OWN independent auth and RBAC chain. The runtime's `evaluateProjectPermission()` at `apps/runtime/src/middleware/rbac.ts:203-391` loads the project and checks membership but NEVER checks `TenantMember.status`. The runtime's `requireWriteAccess()` (line 97) calls `resolveTenantMembership()` but only checks role, not status. The runtime's `resolveEffectivePermissions()` in `permission-resolution.ts` also does not check status.

  The User Lifecycle spec says "Runtime receives tenant context from JWT and does not directly query TenantMember status (relies on auth middleware check at the Studio/gateway layer)" (Section 8). But the runtime is a SEPARATE Express server on port 3112 -- it does NOT route through Studio's middleware. If a suspended user has a valid JWT (which lasts 15 minutes per auth config), they can call runtime APIs directly for the remaining JWT lifetime.

- **Evidence**:
  - User Lifecycle spec Section 8: "Runtime receives tenant context from JWT and does not directly query TenantMember status"
  - Runtime `requireWriteAccess`: `apps/runtime/src/middleware/rbac.ts:97-153` -- checks role, not status
  - Runtime `evaluateProjectPermission`: `apps/runtime/src/middleware/rbac.ts:203-391` -- checks membership, not status
  - Runtime runs independently on port 3112 (per CLAUDE.md Quick Reference)
  - JWT lifetime is 15 minutes, and the spec calls for 30s Redis cache TTL for status checks

- **Recommendation**: The User Lifecycle spec must address runtime enforcement explicitly. Options:
  1. **Preferred**: Add a `TenantMember.status` check to the runtime's tenant context resolution (wherever `resolveTenantMembership()` is called). Cache in Redis with the same 30s TTL. This is a ~10 line change.
  2. **Alternative**: Reduce JWT lifetime to match the 30s cache TTL (impractical -- too many token refreshes).
  3. **Alternative**: Add a Redis-backed "suspended user set" that the runtime checks. More complex but avoids DB queries.
     The spec must also update Section 5 (Integration Matrix) to list the runtime as a dependency, not just Studio.

- **Impact if not fixed**: Suspended/locked users retain full runtime access for up to 15 minutes (JWT lifetime) after being suspended. In a security incident (compromised account), this is a 15-minute window of unauthorized access to agent execution, session management, and all runtime APIs.

---

### [CRITICAL] CF-3: `BUILTIN_ROLE_PERMISSIONS` vs `SYSTEM_ROLES` Divergence Is a Shared Blocker for All 4 Features

- **Affects**: All four artifacts
- **Finding**: The Custom Roles spec correctly identifies this as GAP-002 and lists it as a prerequisite. But the other 3 features also depend on this being resolved:
  - **Runtime `BUILTIN_ROLE_PERMISSIONS`** (`permission-resolution.ts:57-92`): ADMIN has 9 permissions (e.g., `project:*`, `agent:*`, `tool:*`, `deployment:*`, `session:*`, `credential:*`, `tenant:read`, `tenant:update`, `tenant:manage_members`)
  - **Database `SYSTEM_ROLES`** (`system-roles.ts:27-45`): ADMIN has 16 permissions (adds `tenant:manage_settings`, `environment:*`, `knowledge_base:*`, `workflow:*`, `api_key:*`, `secret:*`, `proxy:*`, `module:*`, `kms:admin`)
  - **Runtime `PROJECT_ROLE_PERMISSIONS`** (`rbac.ts:405-441`): Uses completely different permission strings (`version:*`, `channel:*`, `env_var:read`, `channel_connection:*`, `lookup_data:*`, `attachment:read`) that don't exist in either of the above

  There are THREE divergent permission maps. The User Lifecycle spec's status check interacts with all of them (status must be checked before any permission resolution). The Custom Roles spec's permission matrix UI must decide which namespace to display. The Project RBAC LLD extracts `PROJECT_ROLE_PERMISSIONS` to shared -- but does not reconcile it with the other two.

- **Evidence**:
  - `BUILTIN_ROLE_PERMISSIONS`: 5 roles, ADMIN has 9 perms (permission-resolution.ts:57-92)
  - `SYSTEM_ROLES`: 5 roles, ADMIN has 16 perms (system-roles.ts:27-45)
  - `PROJECT_ROLE_PERMISSIONS`: 3 roles (no tester yet), admin has `*:*`, developer has 15 unique perms (rbac.ts:405-441)
  - Studio `resolveStudioPermissions` falls back to `SYSTEM_ROLES` (permission-resolver.ts:126-129)
  - Runtime `resolveEffectivePermissions` falls back to `BUILTIN_ROLE_PERMISSIONS` (permission-resolution.ts:126-130)

- **Recommendation**: Before implementing any of the 4 features, a reconciliation task must:
  1. Determine which permissions are TENANT-scoped vs PROJECT-scoped and document the split
  2. Align `BUILTIN_ROLE_PERMISSIONS` with `SYSTEM_ROLES` (or document accepted differences with justification)
  3. Define a canonical set of PROJECT-level permission strings that custom roles can use
  4. This is already in the Custom Roles spec's delivery plan (Task 1) but must be elevated to a standalone prerequisite shared by all 4 features

- **Impact if not fixed**: An ADMIN user in Studio sees different capabilities than the same ADMIN in Runtime. Custom roles built from the Studio permission matrix won't enforce correctly at the runtime layer. This is a correctness bug, not just a cosmetic issue.

---

### [HIGH] CF-4: Workspace Deletion Cascade Does Not Consider Custom Roles or Project Members

- **Affects**: Workspace Management spec, Custom Project Roles spec, Project RBAC LLD
- **Finding**: The Workspace Management spec (Section 12, Data Lifecycle) lists the tenant-scoped collections that must be cascaded on permanent deletion. It correctly includes `role_definitions` and `resource_permissions` in the "Membership" category. However:
  1. `project_members` is NOT in the cascade list. When a workspace is deleted, all projects within it are deleted, and all `ProjectMember` records for those projects must also be deleted. `ProjectMember` does not have a `tenantId` field (verified at `packages/database/src/models/project-member.model.ts`) -- deletion must flow through `projectId` via the project cascade, not directly by `tenantId`.
  2. The cascade must also clean up `User.favoriteTenantIds` and `User.defaultTenantId` references (the spec mentions this at the bottom of Section 12 but does not include it in the ordered cascade table).
  3. `ProjectMember.customRoleId` references will become dangling when `role_definitions` are deleted in the cascade. The deletion order matters -- project members should be deleted BEFORE role definitions to avoid dangling reference queries during the cascade.

- **Evidence**:
  - Workspace Management spec Section 12 cascade table: lists `role_definitions` but not `project_members`
  - `ProjectMember` model (`project-member.model.ts`): no `tenantId` field
  - Custom Roles spec Section 12 (Data Lifecycle): "When a custom role is deleted, all `ProjectMember` records referencing it via `customRoleId` must be updated to `null`"
  - Custom Roles spec GAP-004: "`ProjectMember` model lacks a `tenantId` field -- cross-tenant validation of `customRoleId` requires joining through the project"

- **Recommendation**: The Workspace Management spec's cascade section must:
  1. Add `project_members` to the cascade, noting it must flow through project deletion (not directly by tenantId)
  2. Specify cascade order: (a) terminate sessions, (b) delete project_members, (c) delete projects, (d) delete role_definitions, (e) delete tenant_members, (f) clean up User references
  3. Document that `ProjectMember.customRoleId` dangling references are harmless because the ProjectMember itself is deleted in the cascade

- **Impact if not fixed**: Orphaned `ProjectMember` records will accumulate after workspace deletion, causing phantom memberships that could grant access if the IDs are reused.

---

### [HIGH] CF-5: Bulk Operation Patterns Are Inconsistent Across Features

- **Affects**: Project RBAC LLD, User Lifecycle Management spec
- **Finding**: Both features define bulk operations with partial success patterns, but the response shapes and constraints differ:

  | Aspect                | Project RBAC LLD                                             | User Lifecycle Spec                                      |
  | --------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
  | Max batch size        | 50 (Zod `.max(50)`)                                          | 100 (FR-7)                                               |
  | Response shape        | `{ succeeded: [{userId, role}], failed: [{userId, error}] }` | `{ succeeded: [...], failed: [{email/userId, reason}] }` |
  | Error field           | `error: string`                                              | `reason: string`                                         |
  | Endpoint pattern      | `POST /projects/:id/members/bulk`                            | `POST /workspaces/:tenantId/members/bulk-invite`         |
  | Bulk role change path | `POST .../bulk-update-role`                                  | `PATCH .../members/bulk`                                 |
  | Bulk remove method    | `POST .../bulk-remove`                                       | `DELETE .../members/bulk`                                |

  The HTTP method inconsistency is the most concerning: Project RBAC uses POST for all bulk ops (idiomatic for operations that return partial results), while User Lifecycle uses PATCH for role change and DELETE for remove. DELETE with a request body is discouraged by RFC 7231 and may be dropped by some proxies.

- **Evidence**:
  - Project RBAC LLD Phase 2: Tasks 2.5-2.6 define POST for all bulk endpoints
  - User Lifecycle spec Section 8 API table: `PATCH .../members/bulk` for role change, `DELETE .../members/bulk` for remove
  - Project RBAC LLD: max 50, User Lifecycle spec: max 100

- **Recommendation**: Standardize bulk operation patterns before implementation:
  1. Use POST for all bulk operations (both features) -- POST with a request body returning partial results is the correct semantic
  2. Standardize error field name: pick either `error` or `reason` (recommend `reason` as it's more descriptive)
  3. Standardize max batch size: 50 is safer for initial implementation; 100 can be the ceiling
  4. Document the pattern in a shared convention guide (e.g., `docs/guides/bulk-operation-patterns.md`)

- **Impact if not fixed**: API consumers (SDK, Studio frontend, third-party integrations) must handle two different response shapes and HTTP conventions for conceptually identical operations. This increases frontend complexity and creates confusion.

---

### [HIGH] CF-6: Permission Resolution Cache Keys Will Collide Under Custom Roles

- **Affects**: Custom Project Roles spec, Project RBAC LLD
- **Finding**: Both the runtime's `resolveEffectivePermissions()` and Studio's `resolveStudioPermissions()` cache by `{tenantId}:{userId}` (verified at `permission-resolution.ts:31` and `permission-resolver.ts:64`). This cache key is TENANT-scoped -- it caches the user's tenant-level permissions.

  When custom project roles are introduced, a user may have DIFFERENT permissions in different projects within the same tenant (e.g., admin in Project A via a custom role, viewer in Project B via built-in role). The tenant-level cache will return the SAME permission set regardless of which project is being accessed.

  The Custom Roles spec's FR-6 says "permissions propagate within the cache TTL (default 60 seconds)" but doesn't address that the cache key doesn't include `projectId`. If `evaluateProjectPermission` is updated to call `resolveRolePermissions()` for custom roles (as FR-5 requires), it needs its own project-scoped cache -- not the existing tenant-scoped cache.

- **Evidence**:
  - Runtime cache key: `${tenantId}:${userId}` at `permission-resolution.ts:31`
  - Studio cache key: `${tenantId}:${userId}` at `permission-resolver.ts:64`
  - `evaluateProjectPermission` is called per-request with `projectId` context (rbac.ts:203)
  - ProjectMember has per-project `customRoleId` (project-member.model.ts:18)

- **Recommendation**: The Custom Roles spec must specify that project-level permission resolution uses a SEPARATE cache with a key of `{tenantId}:{userId}:{projectId}`, or that `evaluateProjectPermission` bypasses the tenant-level cache entirely and loads `RoleDefinition` on each project permission check (with its own short-TTL cache). This is an architectural decision that must be made before implementation.

- **Impact if not fixed**: A user with custom admin role in Project A and viewer role in Project B will get the SAME cached permissions for both projects, resulting in either over-granting (viewer sees admin permissions) or under-granting (admin gets viewer permissions) depending on which project was accessed first within the cache TTL.

---

### [HIGH] CF-7: `requireProjectAccess` Behavior Mismatch Between LLD and Code

- **Affects**: Project RBAC LLD
- **Finding**: The Project RBAC LLD (D-10) states: "`requireProjectAccess` grants access to ALL same-tenant users (tenant-scoped query on line 53-57)." This was flagged in the R4 audit. Reading the actual code at `apps/studio/src/lib/project-access.ts:41-88`:
  - **Primary path** (line 53-57): If the user has a `tenantId`, it does `findProjectByIdAndTenant(projectId, user.tenantId)`. If the project exists in the tenant, access is granted. This is a tenant-scoped lookup, NOT a membership check.
  - **Fallback path** (line 61-81): If no tenantId, checks `ProjectMember` for direct membership, then loads the project.

  The LLD is CORRECT that the primary path grants access to all same-tenant users. However, the LLD's D-10 says "Service-layer `assertCallerCanManageMembers` with explicit `ProjectMember` lookup" is the actual authorization gate. This is architecturally sound -- but the User Lifecycle feature adds `TenantMember.status` checks that must happen BEFORE `requireProjectAccess`. If a suspended user still has a valid session, `requireProjectAccess` will pass (tenant-scoped lookup succeeds), and they'll reach the service layer.

  The User Lifecycle spec puts status checks in "auth middleware" -- but `requireProjectAccess` runs AFTER auth middleware (it's called by individual route handlers, not by middleware). The status check must be wired into the auth middleware that runs BEFORE route handlers.

- **Evidence**:
  - `requireProjectAccess` at `apps/studio/src/lib/project-access.ts:53-57`: tenant-scoped lookup, no status check
  - User Lifecycle spec FR-2: "auth middleware... deny access with HTTP 403"
  - Studio route handlers call `requireProjectAccess` after `requireTenantAuth` (visible in LLD Phase 2 tasks)

- **Recommendation**: The User Lifecycle spec should explicitly clarify that the status check is in `requireTenantAuth` (or the Studio auth middleware that populates `user` context), not in `requireProjectAccess`. Document the full middleware chain:
  1. `requireTenantAuth` -- validates JWT, resolves tenant context, checks `TenantMember.status` (NEW)
  2. `requireProjectAccess` -- verifies project exists in tenant (unchanged)
  3. Service layer -- business logic authorization (unchanged)

- **Impact if not fixed**: If status check is placed in the wrong middleware, suspended users may pass through some routes but not others, creating an inconsistent enforcement surface.

---

### [HIGH] CF-8: `revokeUserRefreshTokens` Is User-Global, Not Workspace-Scoped

- **Affects**: User Lifecycle Management spec
- **Finding**: FR-5 says "The system must revoke all refresh tokens for a user via `revokeUserRefreshTokens()` when their TenantMember status transitions away from `active`." The function at `auth-repo.ts:245-254` is:

  ```typescript
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } });
  ```

  This revokes ALL refresh tokens for the user across ALL workspaces, not just the workspace where they were suspended. The spec (Section 12, "Cross-workspace independence") says "Suspending/locking a TenantMember in workspace A must NOT affect the same user's TenantMember in workspace B." But revoking all refresh tokens DOES affect workspace B -- the user will be logged out of all workspaces.

- **Evidence**:
  - `revokeUserRefreshTokens` at `auth-repo.ts:245-254`: filters by `userId` only, no `tenantId`
  - User Lifecycle spec Section 12: "Each TenantMember record has independent status"
  - RefreshToken model: likely has no `tenantId` field (auth tokens are user-scoped, not tenant-scoped)

- **Recommendation**: Either:
  1. **Accept the trade-off**: Document that suspending a user in one workspace logs them out of all workspaces (simpler, security-conservative). Update Section 12 to acknowledge this known cross-workspace side effect.
  2. **Add workspace-scoped tokens**: Add `tenantId` to RefreshToken and filter revocation by workspace. This is a larger schema change.
     Option 1 is recommended for v1 -- it's security-conservative and avoids schema changes. But it must be documented explicitly rather than contradicting the cross-workspace independence claim.

- **Impact if not fixed**: Users suspended in one workspace lose access to ALL workspaces until they re-authenticate. This contradicts the spec's cross-workspace independence claim and will generate support tickets.

---

### [HIGH] CF-9: Project RBAC LLD Plans to Move `PROJECT_ROLE_PERMISSIONS` to Shared, But Custom Roles Spec Does Not Consume It

- **Affects**: Project RBAC LLD, Custom Project Roles spec
- **Finding**: The LLD (Phase 2, Task 2.7) specifies extracting `PROJECT_ROLE_PERMISSIONS` from `apps/runtime/src/middleware/rbac.ts` to `@agent-platform/shared/rbac`. The Custom Roles spec says it will update `evaluateProjectPermission` to consult `customRoleId` and fall back to `PROJECT_ROLE_PERMISSIONS` only when `customRoleId` is null (FR-5). But the Custom Roles spec does not reference the shared location -- it still points to `rbac.ts` lines 405-441.

  More importantly, the Custom Roles spec's delivery plan (Task 3.1) says "Update `evaluateProjectPermission` in `rbac.ts`" -- but after Project RBAC ships, `PROJECT_ROLE_PERMISSIONS` will have been moved to the shared package. The Custom Roles implementation will need to import from `@agent-platform/shared/rbac`, not modify `rbac.ts`.

- **Evidence**:
  - LLD Phase 1, Task 1.5: "Add `tester` role to `PROJECT_ROLE_PERMISSIONS`"
  - LLD Phase 2, Task 2.7: "This constant must be extracted from `apps/runtime/src/middleware/rbac.ts` into `@agent-platform/shared/rbac`"
  - LLD Modified Files table: `packages/shared/src/rbac/permission-resolver.ts` -- "Export `PROJECT_ROLE_PERMISSIONS` constant (extracted from runtime)"
  - Custom Roles spec FR-5: "resolve custom role permissions through the `evaluateProjectPermission` function in `apps/runtime/src/middleware/rbac.ts`"
  - Custom Roles spec GAP-001: "`evaluateProjectPermission` in `rbac.ts` (line 369) uses only `PROJECT_ROLE_PERMISSIONS[role]`"

- **Recommendation**: The Custom Roles spec should be updated to reference the shared location that will exist after Project RBAC ships. FR-5 should say "which reads `PROJECT_ROLE_PERMISSIONS` from `@agent-platform/shared/rbac`" rather than referencing `rbac.ts` lines 405-441.

- **Impact if not fixed**: Implementation confusion and potential import errors. The Custom Roles implementer will look at the wrong file and may accidentally create a duplicate constant.

---

### [HIGH] CF-10: `ITenantSettings` Modifications Needed by Both User Lifecycle and Workspace Management

- **Affects**: User Lifecycle Management spec, Workspace Management spec
- **Finding**: Both features add fields to `ITenantSettings`:
  - **User Lifecycle** (Section 9): `defaultRole: string`, `inviteExpiryDays: number`, `emailNotifications: boolean`
  - **Workspace Management**: No new settings fields (but consumes `ITenantSettings` via the settings page)

  The `ITenantSettings` interface at `packages/database/src/models/tenant.model.ts:32-43` has an index signature `[key: string]: unknown` which allows both features to add fields without conflicts. However:
  1. Neither feature spec adds these as typed fields in the `ITenantSettings` interface -- they would be stored via the index signature only, losing type safety.
  2. The Workspace Management spec's settings page (FR-6) exposes "workspace name, slug, and retention days" but does NOT include the User Lifecycle's new settings (default role, invite expiry, email notifications). If both ship, the workspace settings page will be incomplete.

- **Evidence**:
  - `ITenantSettings` at `tenant.model.ts:32-43`: 7 typed fields + index signature
  - User Lifecycle spec Section 7 (Settings Storage): "New settings fields should be added to the `ITenantSettings` interface"
  - Workspace Management spec FR-6: "settings page must allow editing the workspace name, slug, and retention"

- **Recommendation**:
  1. Both features should explicitly add their new fields to the `ITenantSettings` interface in their delivery plans
  2. The Workspace Management spec's settings page should have a provision for rendering additional settings sections contributed by other features (or explicitly note that User Lifecycle settings live in a separate admin page at `/admin/settings`)
  3. Consider whether these should be on the SAME page or different pages -- currently User Lifecycle puts settings at `/admin/settings` while Workspace Management puts them at `/settings/workspace`

- **Impact if not fixed**: Two separate settings pages for the same workspace, with different sets of controls. Users won't know which page has which settings.

---

### [MEDIUM] CF-11: `tester` Role Exists Only in Project RBAC, Not Addressed by Custom Roles

- **Affects**: Project RBAC LLD, Custom Project Roles spec
- **Finding**: The LLD (D-12) adds a `tester` role to `PROJECT_ROLE_PERMISSIONS`. The Custom Roles spec (Open Question 1) asks "Should the `tester` built-in role be implemented before or after custom roles?" but does not resolve this. The Custom Roles spec GAP-005 notes the `tester` role doesn't exist yet.

  If Project RBAC ships first (recommended order), the `tester` role will exist in `PROJECT_ROLE_PERMISSIONS`. Custom roles can then be built on top. This is fine IF the `tester` role is also seeded as a system `RoleDefinition` (with `isSystem: true`) during tenant bootstrap -- otherwise, the `tester` role exists in the static map but not in the `role_definitions` collection, making it invisible to the custom roles management UI (which lists system + custom roles from the DB).

- **Evidence**:
  - LLD D-12: Adds `tester` to `PROJECT_ROLE_PERMISSIONS`
  - Custom Roles spec Section 8: "GET /api/workspaces/:tenantId/roles -- List all roles (system + custom)"
  - `seedTenantBootstrapDefaults()` seeds only the 5 `SYSTEM_ROLES` (OWNER, ADMIN, OPERATOR, MEMBER, VIEWER) -- no `tester`
  - Custom Roles spec Open Question 1: unresolved

- **Recommendation**: When the `tester` role is added to `PROJECT_ROLE_PERMISSIONS`, it should also be added to `SYSTEM_ROLES` in `packages/database/src/constants/system-roles.ts` and the bootstrap seed, so it appears in the custom roles management UI as a system role. This should be a subtask in LLD Phase 1.

- **Impact if not fixed**: The tester role works at the runtime layer but is invisible in the custom roles management UI. Admins won't be able to see what permissions the tester role has or use it as a base for duplication.

---

### [MEDIUM] CF-12: No Event System for Cross-Feature Notifications

- **Affects**: All four artifacts
- **Finding**: None of the four features emit domain events that other features can subscribe to. Examples of cross-feature interactions that would benefit from events:
  1. When a project member is added (Project RBAC), the User Lifecycle's member count should update
  2. When a tenant member is suspended (User Lifecycle), project member access should be revoked
  3. When a workspace is archived (Workspace Management), custom roles in that workspace become irrelevant
  4. When a custom role's permissions change (Custom Roles), project permission caches should be invalidated

  Currently, each feature handles its own concerns in-process. This works for v1 but creates tight coupling as features multiply.

- **Recommendation**: Not a blocker for v1, but note as a future architectural concern. Consider introducing a lightweight in-process event bus (e.g., `EventEmitter` with typed events) when features 3+ are shipping simultaneously. For now, document the cross-feature interactions in each feature's integration matrix.

- **Impact if not fixed**: Cross-feature consistency relies on developers remembering to update all affected systems manually. As the feature count grows, this becomes error-prone.

---

## Architectural Coherence Assessment

The four features form a **well-layered governance stack** with clear separation of concerns:

1. **Project RBAC** (Layer 1 -- Foundation): Provides the management surface for project-level membership. This is the base layer that all other features build on. The LLD is thorough, with 5 audit rounds and 18 E2E scenarios. Code-grounded throughout.

2. **Custom Project Roles** (Layer 2 -- Extends RBAC): Activates the dormant `customRoleId` field to provide fine-grained permission control beyond the 3 built-in roles. Correctly scoped to the `RoleDefinition` model (tenant-scoped, project-assigned). The spec has improved significantly since the R1 audit (which found 13/18 template sections missing) -- it now covers all sections with verified code references.

3. **User Lifecycle Management** (Layer 3 -- Status Control): Adds a status dimension to tenant membership. Architecturally clean -- status is workspace-scoped, not user-scoped. The biggest concern is the runtime enforcement gap (CF-2). The spec has also improved since R1 (which found 10/18 sections missing).

4. **Workspace Management** (Layer 4 -- Container Management): Manages the workspace itself. Architecturally independent from the other 3 features except for the deletion cascade. The spec is well-grounded with correct references to existing code (Tenant model status enum, workspace-repo functions, auth-repo functions).

**Overall assessment**: The data models are compatible (no field collisions), the API patterns are mostly consistent (with the bulk operation divergence noted in CF-5), and the permission resolution chain can be extended without breaking changes. The three CRITICAL findings (CF-1, CF-2, CF-3) are all about the **permission resolution architecture** and should be addressed in a shared prerequisite task before any of the 4 features ships.

---

## Recommended Implementation Order

```
Phase 0 (PREREQUISITE -- shared):
  P0.1: Reconcile BUILTIN_ROLE_PERMISSIONS vs SYSTEM_ROLES vs PROJECT_ROLE_PERMISSIONS (CF-3)
  P0.2: Document tenant-level vs project-level permission namespaces
  P0.3: Design unified custom role resolution architecture (CF-1, CF-6)

Phase 1: Project RBAC Management [no dependencies except P0]
  - Ships the management layer: member CRUD, listing filter, tester role, bulk ops
  - Extracts PROJECT_ROLE_PERMISSIONS to shared package
  - Enables all subsequent features

Phase 2: Custom Project Roles [depends on Phase 1]
  - Activates customRoleId on ProjectMember
  - Wires resolveRolePermissions into evaluateProjectPermission
  - Requires PROJECT_ROLE_PERMISSIONS to be in shared (from Phase 1)
  - Requires resolved permission namespace (from P0)

Phase 3: User Lifecycle Management [depends on Phase 1 for member list, independent of Phase 2]
  - Adds TenantMember.status field and auth middleware check
  - MUST include runtime enforcement (CF-2) -- not just Studio
  - Can ship in parallel with Phase 2 if P0 is complete

Phase 4: Workspace Management [independent, can ship in parallel with Phases 2-3]
  - User preferences on User model (no model conflicts)
  - Workspace settings page (no conflicts with other features)
  - Deletion cascade must account for ProjectMember and RoleDefinition (CF-4)
```

**Circular dependencies**: None. Each feature builds on the previous but does not depend on features later in the chain.

**Must ship together**: None strictly, but Phase 1 (Project RBAC) must ship before Phase 2 (Custom Roles). Phases 3 and 4 can ship independently.

---

## Race Conditions & Edge Cases

### RC-1: Suspend User While Bulk-Adding Them to Projects

**Scenario**: Admin A suspends TenantMember for user X in Workspace W. Simultaneously, Admin B is running a bulk-add that includes user X to Project P in Workspace W.

**What happens**: The bulk-add checks tenant membership (user X is still a member), creates the ProjectMember, then Admin A's suspend takes effect. User X now has an active ProjectMember but a suspended TenantMember.

**Risk**: LOW. The TenantMember.status check in auth middleware (FR-2) will deny API access regardless of ProjectMember state. The ProjectMember record is harmless -- it just means X will have membership if/when reactivated.

**Recommendation**: No code change needed. Document as expected behavior.

### RC-2: Delete Custom Role While User Is Actively Using It

**Scenario**: Admin deletes custom role R. User U, who has R assigned via `ProjectMember.customRoleId`, is in the middle of an API call that hasn't resolved permissions yet.

**What happens**: Custom Roles spec says deletion cascades `customRoleId = null` on all affected ProjectMember records. If the permission resolution query runs between the RoleDefinition deletion and the ProjectMember cascade update, `resolveRolePermissions()` will return `[]` (role not found), and the fallback to `PROJECT_ROLE_PERMISSIONS[role]` will apply.

**Risk**: LOW. The fallback behavior is already implemented in `resolveEffectivePermissions()` (permission-resolution.ts:124-127). Worst case: user gets built-in role permissions for one request cycle.

**Recommendation**: The Custom Roles spec should specify that the cascade (`customRoleId = null`) and the RoleDefinition deletion happen in a transaction (or at minimum, the cascade runs first).

### RC-3: Archive Workspace While Custom Role CRUD Is In Progress

**Scenario**: Owner archives workspace W. Simultaneously, admin is creating a custom role in W.

**What happens**: The role creation may succeed (writes to `role_definitions`), then the workspace is archived. The role is now in an archived workspace.

**Risk**: VERY LOW. The role is tenant-scoped and will be cleaned up in the 30-day permanent deletion cascade. It has no effect while the workspace is archived.

### RC-4: Two Admins Simultaneously Change the Same User's Status

**Scenario**: Admin A locks user X while Admin B suspends user X.

**What happens**: User Lifecycle spec says "Status change operations use `findOneAndUpdate()` with the current status as a filter condition." So one will succeed and the other will fail (no matching document for the expected current status).

**Risk**: NONE if implemented as specified. The optimistic concurrency pattern is correct.

### RC-5: User's Failed Login Lock Crosses Workspace Boundaries

**Scenario**: User X fails login 5 times. `loginLockedUntil` is set globally. User Lifecycle spec says this should set `TenantMember.status = 'locked'` across ALL workspaces.

**What happens**: User X is locked in all workspaces. Admin in Workspace A manually unlocks X. User X can access Workspace A but remains locked in Workspace B (per spec: manual unlock is per-workspace).

**Risk**: MEDIUM. The User-level `loginLockedUntil` may still be active when the admin unlocks in one workspace. On next login attempt, `loginLockedUntil` is checked first (auth-repo.ts, login route). If it hasn't expired, the login fails even though the admin manually unlocked the member.

**Recommendation**: The User Lifecycle spec should clarify: does manual unlock clear `loginLockedUntil` on the User model? If yes, it affects all workspaces (contradicting per-workspace independence). If no, the user is still locked at the User level and can't log in to any workspace. This is Open Question 4 in the spec but should be resolved before implementation. Recommended resolution: manual unlock in ANY workspace clears `loginLockedUntil` on the User model (security-permissive but prevents the deadlock scenario where a user is unlocked in their workspace but can't log in).

---

## Summary of Required Actions Before Implementation

| #     | Action                                                | Severity | Blocks      |
| ----- | ----------------------------------------------------- | -------- | ----------- |
| CF-1  | Design unified custom role resolution architecture    | CRITICAL | Phase 2     |
| CF-2  | Add TenantMember.status check to runtime RBAC         | CRITICAL | Phase 3     |
| CF-3  | Reconcile 3 divergent permission maps                 | CRITICAL | All phases  |
| CF-4  | Add project_members to workspace deletion cascade     | HIGH     | Phase 4     |
| CF-5  | Standardize bulk operation patterns                   | HIGH     | Phases 1, 3 |
| CF-6  | Design project-scoped permission cache key            | HIGH     | Phase 2     |
| CF-7  | Clarify requireProjectAccess + status check ordering  | HIGH     | Phase 3     |
| CF-8  | Document cross-workspace refresh token revocation     | HIGH     | Phase 3     |
| CF-9  | Update Custom Roles spec to reference shared location | HIGH     | Phase 2     |
| CF-10 | Coordinate ITenantSettings and settings page          | HIGH     | Phases 3, 4 |
| CF-11 | Seed tester role as system RoleDefinition             | MEDIUM   | Phase 1     |
| CF-12 | Note event-driven architecture as future concern      | MEDIUM   | None        |
| RC-5  | Resolve manual unlock vs loginLockedUntil interaction | HIGH     | Phase 3     |
