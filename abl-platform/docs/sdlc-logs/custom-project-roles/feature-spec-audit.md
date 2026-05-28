# Feature Spec Audit: Custom Project Roles

**VERDICT**: NEEDS_REVISION

**PHASE**: FEATURE-SPEC
**ARTIFACT**: `docs/features/custom-project-roles.md`
**ROUND**: 1 of 2
**DATE**: 2026-04-09

---

## Findings

### CRITICAL (must fix before next phase)

#### F-1. [FS-1] Template completeness -- 13 of 18 template sections missing

The feature spec uses a freeform structure (Problem Statement, Scope, Existing Infrastructure, Requirements, E2E Scenarios, Dependencies, Next Steps) but the TEMPLATE.md requires 18 numbered sections. The following are entirely absent:

- Section 1: Introduction / Overview (Goal Statement, Summary)
- Section 3: User Stories (minimum 3 required by FS-4)
- Section 5: Feature Classification & Integration Matrix (lifecycle impact + related feature matrix)
- Section 6: Design Considerations
- Section 7: Technical Considerations
- Section 8: How to Consume (Studio UI, API, Admin Portal)
- Section 9: Data Model (collection definitions with fields, types, indexes)
- Section 10: Key Implementation Files
- Section 11: Configuration
- Section 12: Non-Functional Concerns (isolation, security, performance, reliability, observability, data lifecycle)
- Section 13: Delivery Plan / Work Breakdown (parent tasks with numbered subtasks)
- Section 14: Success Metrics
- Section 15: Open Questions
- Section 16: Gaps, Known Issues & Limitations
- Section 17: Testing & Validation
- Section 18: References

**Location**: Entire document
**Fix**: Rebuild the spec from TEMPLATE.md. Every section must be addressed (N/A with justification is acceptable for non-applicable sections).

---

#### F-2. [FS-6] Tenant, project, and user isolation not addressed

The spec proposes CRUD APIs under `/api/projects/:id/roles` but never addresses:

- **Tenant isolation**: The `RoleDefinition` model is tenant-scoped (indexed `{ tenantId, name }` unique), but the spec proposes project-scoped routes. How does the API ensure `tenantId` is included in every query? The model has NO `projectId` field -- so "custom project roles" that are scoped to a project cannot be distinguished from tenant-wide roles in the current data model.
- **Cross-tenant isolation**: What happens when a user from tenant A tries to access roles from tenant B's project? Must return 404 per platform invariant.
- **Cross-project isolation**: If roles are tenant-scoped but managed via project routes, can Project A see roles created via Project B's API? This is architecturally ambiguous.
- **User isolation**: FR-4 lists "created by" as a table column but the spec doesn't define who can see/manage which roles (only "Admin" is implied in E2E scenarios).

**Location**: Missing Section 12 (Non-Functional Concerns)
**Fix**: Add the full Non-Functional Concerns section. Critically, resolve the data model scoping question: either (a) add `projectId` to `RoleDefinition` and a new unique index, or (b) clarify that custom project roles are tenant-scoped roles that are _assigned_ at the project level, and document the implications (all projects in a tenant share the same custom role pool).

---

#### F-3. [FS-2] RoleDefinition model lacks `projectId` -- project-scoped routes are architecturally inconsistent

The spec proposes `POST /api/projects/:id/roles` (project-scoped CRUD) but `RoleDefinition` has no `projectId` field:

```typescript
// packages/database/src/models/role-definition.model.ts
export interface IRoleDefinition {
  _id: string;
  tenantId: string; // <-- tenant-scoped only
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  parentRoleId: string | null;
  createdBy: string;
  _v: number;
  // NO projectId field
}
```

The unique index is `{ tenantId: 1, name: 1 }` -- not project-scoped. This means:

1. Role names must be unique across the entire tenant, not per-project
2. A role created via Project A's API is visible and usable from Project B
3. Project-scoped routes create a false impression of project-level isolation

**Location**: Section "Existing Infrastructure", Section "Requirements" FR-1
**Fix**: Either (a) add `projectId` to `RoleDefinition` model schema and update the unique index to `{ tenantId, projectId, name }`, or (b) re-scope the API routes to tenant level (`/api/tenants/:tenantId/roles` or `/api/workspace/roles`) and make the project routes reference tenant roles. Document the chosen approach with rationale.

---

#### F-4. [FS-2] FR-5 references a "role type" field that does not exist in the model

> "Role type (account/tool/app) cannot be changed after creation" -- FR-5

The `RoleDefinition` model has no `type`, `roleType`, or equivalent field. The only type-like discriminator is `isSystem: boolean`. The values "account/tool/app" are not present anywhere in the codebase. This requirement is invented.

**Location**: FR-5, line 108
**Fix**: Remove or replace this constraint. If the feature genuinely needs role types (e.g., to distinguish tenant roles from project roles), add the field to the data model in Section 9 and create an FR for the schema change. Otherwise, delete this line.

---

### HIGH (should fix)

#### F-5. [FS-4] No user stories

The template requires minimum 3 user stories in "As a [persona], I want [capability] so that [benefit]" format. The spec has zero user stories.

**Location**: Missing Section 3
**Fix**: Add at least 3 user stories. Suggested:

1. As a **project admin**, I want to create custom roles with specific per-module permissions so that I can grant team members exactly the access they need instead of choosing between overly broad built-in roles.
2. As a **project admin**, I want to duplicate a built-in role and customize it so that I can start from a reasonable baseline instead of building permissions from scratch.
3. As a **workspace owner**, I want to prevent deletion of roles assigned to active members so that users don't suddenly lose access.

---

#### F-6. [FS-5] Integration matrix missing

No Feature Classification & Integration Matrix section exists. The spec doesn't document how this feature relates to:

- Project RBAC Management Layer (the LLD it depends on)
- Workspace Sharing
- Agent execution (how custom role permissions affect runtime agent access)
- Studio UI (settings pages, navigation)

**Location**: Missing Section 5
**Fix**: Add the lifecycle/platform impact table and the related feature integration matrix per TEMPLATE.md. At minimum: "depends on" Project RBAC Management, "extends" Workspace Sharing, "configured by" Studio Settings.

---

#### F-7. [FS-3] FR-3 requirement quality -- "PATCH /api/projects/:id/members/:userId" is underspecified

> "When `customRoleId` is set, it takes precedence over the built-in `role` field"

This is architecturally important but lacks specificity:

- Does this mean the runtime's `resolveEffectivePermissions()` already handles this? (Answer: yes, at line 117 of `permission-resolution.ts` -- but the spec doesn't reference this)
- Does the Studio's `resolveStudioPermissions()` handle this? (Answer: yes, at line 115 -- but only for tenant-scoped custom roles, not project-scoped ones)
- How does this interact with `PROJECT_ROLE_PERMISSIONS` in `rbac.ts`? The runtime resolves project permissions from the hardcoded map, NOT from `RoleDefinition`. A custom project role would need wiring changes.

**Location**: FR-3, lines 88-91
**Fix**: Make FR-3 testable by specifying: (a) which code paths already handle `customRoleId` precedence (cite the files), (b) which code paths need changes (specifically `requireProjectPermission` in `rbac.ts` which uses `PROJECT_ROLE_PERMISSIONS` and does NOT consult `RoleDefinition`), and (c) the expected cache invalidation behavior.

---

#### F-8. [FS-8] No delivery plan with parent tasks and numbered subtasks

The spec has no delivery plan. A flat "Next Steps" line ("Run /hld then /lld") is not a work breakdown.

**Location**: Missing Section 13
**Fix**: Add a phased delivery plan. Suggested structure:

1. Schema changes (add `projectId` if needed, add `type` field if needed)
   1.1 Model migration
   1.2 Index updates
2. API layer (CRUD routes)
   2.1 Create/Read/Update/Delete endpoints
   2.2 Duplicate endpoint
   2.3 Validation and constraints
3. Permission resolution wiring
   3.1 Runtime `requireProjectPermission` changes
   3.2 Studio resolver changes
4. UI (Role management page)
   4.1 Role list view
   4.2 Create/edit form with permission matrix
   4.3 Delete confirmation with member check
5. Testing
   5.1 E2E scenarios
   5.2 Integration tests

---

#### F-9. [FS-7] Data model section missing -- no collection definitions with indexes

The "Existing Infrastructure" section lists models but doesn't define the NEW data model changes needed. Key gaps:

- Does `RoleDefinition` need a `projectId` field? (See F-3 above)
- Does `RoleDefinition` need a `type` field? (See F-4 above)
- What new indexes are needed?
- Is the existing `{ tenantId, name }` unique constraint sufficient or does it need to change?

**Location**: Missing Section 9
**Fix**: Add Section 9 with explicit collection definitions showing existing fields, new fields, and index changes.

---

#### F-10. [FS-3] FR-2 "live update" claim needs cache invalidation specification

> "Changes to a custom role immediately affect all members assigned to it (live update)" -- FR-2

Both `resolveEffectivePermissions()` (line 22, `CACHE_TTL_MS = 60_000`) and `resolveStudioPermissions()` (line 35, `CACHE_TTL_MS = 60_000`) cache resolved permissions for 1 minute. "Immediately" is misleading -- it will take up to 60 seconds.

**Location**: FR-2, line 84
**Fix**: Either (a) change "immediately" to "within cache TTL (default 60 seconds)" and document this as an accepted limitation, or (b) add an FR for cache invalidation on role update (call `clearPermissionCache()` / `clearStudioPermissionCache()` via a pub/sub mechanism on role change).

---

#### F-11. `BUILTIN_ROLE_PERMISSIONS` vs `SYSTEM_ROLES` divergence described but not turned into a requirement

The spec correctly identifies the divergence (line 66):

> "`BUILTIN_ROLE_PERMISSIONS` in `permission-resolution.ts:57-92` is a **subset** of `SYSTEM_ROLES`"

This is accurate. For example, ADMIN in `SYSTEM_ROLES` has 15 permissions including `tenant:manage_settings`, `knowledge_base:*`, `workflow:*`, `deployment:*`, `api_key:*`, `secret:*`, `proxy:*`, `module:*`, `kms:admin`. ADMIN in `BUILTIN_ROLE_PERMISSIONS` has only 9 permissions and is missing all of those.

But the spec says "This divergence should be resolved" without creating an FR for it. If custom roles depend on accurate fallback behavior, this divergence is a pre-condition.

**Location**: Line 66
**Fix**: Either (a) add an FR-0 or dependency requirement that this divergence must be resolved before custom roles are implemented, or (b) remove the note and handle it in the HLD as a design consideration.

---

### MEDIUM (recommended)

#### F-12. [FS-9] Testing section missing

No Section 17 (Testing & Validation) with links to testing guide or coverage expectations. The E2E scenarios listed are reasonable (7 scenarios, exceeding the minimum of 5) but they are not in the template's structured table format.

**Location**: Missing Section 17
**Fix**: Add Section 17 with the structured table and link to `../testing/custom-project-roles.md` (to be created during test spec phase).

---

#### F-13. [FS-10] Out-of-scope "Account-level (tenant) custom roles" needs clarification given data model

The out-of-scope item "Account-level (tenant) custom roles" is confusing because the `RoleDefinition` model IS tenant-scoped with no project scoping. What is being proposed as "project custom roles" is actually tenant-scoped roles used in project contexts. This needs clearer distinction.

**Location**: Lines 28-29
**Fix**: Clarify what "account-level custom roles" means vs "project custom roles" given that the underlying model is identical. Is the distinction about where the role is _managed_ (UI surface) or where it is _stored_ (data model)?

---

#### F-14. E2E scenario 6 expects 403 but platform invariant says cross-scope access returns 404

> "Cannot edit system roles -- Attempt to PATCH a system role -> 403" -- E2E scenario 6

This is correct behavior for a user who HAS access to the project and tries an operation they shouldn't perform (403 = forbidden). This is different from cross-tenant/cross-project access (which returns 404). The scenario is fine, but should specify the auth context (user is a project admin in the correct tenant/project).

**Location**: E2E Scenario 6, line 117
**Fix**: Add auth context to each E2E scenario: "Admin user in tenant T1, project P1 attempts to PATCH system role -> 403".

---

#### F-15. Missing `tester` role in current `PROJECT_ROLE_PERMISSIONS`

The spec references "4 hardcoded project-level roles (admin, developer, tester, viewer)" but the current code only has 3: `admin`, `developer`, `viewer`. The `tester` role is proposed in the Project RBAC Management LLD (Phase 1, task 1.5) but has NOT been implemented yet.

**Location**: Line 13
**Fix**: Change "4 hardcoded" to "3 hardcoded (admin, developer, viewer)" and note that the Project RBAC Management LLD plans to add `tester` as a 4th.

---

## Cross-Phase Consistency

- [XP-1] Backward traceability: The spec correctly references the Project RBAC Management LLD as a dependency. However, it does not trace back to a product requirements document or v1.0 spec beyond the URL in the header.
- [XP-2] Forward compatibility: FAIL -- The spec cannot enable an HLD because the fundamental data model question (tenant-scoped vs project-scoped roles) is unresolved. An HLD cannot design APIs or data access patterns without knowing the scoping model.
- [XP-3] Scope lock: The dependency on Project RBAC Management Layer is correctly stated as a pre-requisite.
- [XP-4] Terminology consistency: "custom project roles" is used but the data model is tenant-scoped. The term "project role" implies project-level scoping that doesn't exist in the model. The LLD uses "project member roles" (built-in) which is different.
- [XP-5] Package agents.md:
  - `packages/database/agents.md`: Read. No RBAC-specific learnings.
  - `apps/runtime/agents.md`: Read. Contains RBAC E2E testing pattern (two-step: tenant membership via API + project membership via model insert) -- this is relevant for test spec.
  - `apps/studio/agents.md`: Read. Contains Studio import path patterns relevant for permission resolver wiring.
  - Prior audit memory (`audit_project_rbac_management_lld_r4.md`): The LLD R4 audit found that Studio imports `hasPermission` from `@agent-platform/shared/rbac` (not `shared-auth/rbac`). This is relevant if the custom roles feature spec proposes Studio-side permission changes.

## Verified

- [x] `RoleDefinition` model exists with claimed fields (`tenantId`, `name`, `isSystem`, `permissions[]`, `parentRoleId`, `createdBy`) -- verified at `packages/database/src/models/role-definition.model.ts`
- [x] `ResourcePermission` model exists with claimed fields (`tenantId`, `userId`, `resourceType`, `resourceId`, `operations[]`, `grantedBy`, `expiresAt`) -- verified at `packages/database/src/models/resource-permission.model.ts`
- [x] `customRoleId` field exists on `ProjectMember` (line 18, default null) -- verified
- [x] `customRoleId` field exists on `TenantMember` (line 19, default null) -- verified
- [x] `resolveRolePermissions()` exists with parent-chain walking and cycle guard -- verified at `packages/shared/src/rbac/permission-resolver.ts:131-163`
- [x] `mergeResourcePermissions()` exists and filters expired grants -- verified at `packages/shared/src/rbac/permission-resolver.ts:169-185`
- [x] `resolveEffectivePermissions()` exists and checks `customRoleId` -- verified at `apps/runtime/src/services/permission-resolution.ts:105-150`
- [x] `resolveStudioPermissions()` exists and checks `customRoleId` -- verified at `apps/studio/src/lib/permission-resolver.ts:91-152`
- [x] `BUILTIN_ROLE_PERMISSIONS` exists at `permission-resolution.ts:57-92` -- verified, and confirmed it is a subset of `SYSTEM_ROLES`
- [x] `PROJECT_ROLE_PERMISSIONS` exists at `rbac.ts:405-441` -- verified, has `admin`, `developer`, `viewer` (NOT `tester`)
- [x] `seedTenantBootstrapDefaults()` exists and seeds `SYSTEM_ROLES` -- verified at `packages/database/src/seed/tenant-bootstrap.ts:36-61`
- [x] `customRoleId` is always null in production -- confirmed (no management surface exists to set it)
- [x] `BUILTIN_ROLE_PERMISSIONS` vs `SYSTEM_ROLES` divergence is real -- ADMIN has 9 perms in builtin vs 15 in SYSTEM_ROLES
- [x] E2E scenarios count: 7 scenarios provided (exceeds minimum 5)

## Summary

The feature spec accurately identifies the problem and correctly documents the existing infrastructure. However, it is structurally incomplete relative to the TEMPLATE.md requirements, and has one fundamental architectural issue: the `RoleDefinition` model is tenant-scoped but the spec proposes project-scoped APIs without addressing the scoping mismatch. This must be resolved before an HLD can be written.

## Notes for Next Round

Focus areas for re-audit after fixes:

- Resolution of the tenant-scoped vs project-scoped data model question (F-3)
- Template completeness -- all 18 sections addressed (F-1)
- Non-functional concerns, especially isolation (F-2)
- Removal of invented "role type" field (F-4)
- Cache invalidation specification for "live update" (F-10)
- Correction of "4 hardcoded" to "3 hardcoded" roles (F-15)
