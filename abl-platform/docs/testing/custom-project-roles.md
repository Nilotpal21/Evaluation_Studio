# Test Spec: Custom Project Roles

**Feature**: Custom project role definitions, assignment via `customRoleId`, permission enforcement
**Feature Spec**: [docs/features/custom-project-roles.md](../features/custom-project-roles.md)
**LLD**: [docs/plans/2026-04-09-project-rbac-management-impl-plan.md](../plans/2026-04-09-project-rbac-management-impl-plan.md)
**Owner**: Platform RBAC team
**Status**: IN PROGRESS
**Last Updated**: 2026-04-16

---

## Coverage Matrix

| FR   | Description                                                         | Unit | Integration | E2E | Status              |
| ---- | ------------------------------------------------------------------- | ---- | ----------- | --- | ------------------- |
| FR-1 | Tenant-scoped CRUD API for custom role definitions                  | Y    | N           | N   | PARTIAL (unit)      |
| FR-2 | Per-module permission organization (Full/Custom/View/No Access)     | Y    | N           | N   | PARTIAL (unit)      |
| FR-3 | Role duplicate operation                                            | N    | N           | N   | NOT IMPLEMENTED     |
| FR-4 | Assign custom role to project member via customRoleId               | Y    | N           | N   | PARTIAL (unit + UI) |
| FR-5 | Custom role permission resolution through evaluateProjectPermission | Y    | Y           | N   | PARTIAL             |
| FR-6 | Permission change propagation within cache TTL                      | N    | Y           | N   | PARTIAL             |
| FR-7 | System role immutability + deletion guard for assigned custom roles | Y    | N           | N   | PARTIAL (unit)      |
| FR-8 | Role name uniqueness per tenant                                     | Y    | N           | N   | PARTIAL (unit)      |
| FR-9 | customRoleId validation on assignment                               | Y    | N           | N   | PARTIAL (unit)      |

---

## E2E Test Scenarios (Minimum 5) -- All NOT YET IMPLEMENTED

### E2E-1: Full Custom Role Lifecycle -- Create, Assign, Enforce

**Preconditions**: Tenant T1 with OWNER (Alice), MEMBER (Bob). Project P1 owned by Alice. Bob added as `developer`.

**Steps**:

1. `POST /api/workspaces/:tenantId/roles` as Alice -- create custom role "qa-engineer" with `['agent:read', 'session:read', 'session:create', 'analytics:read']`
2. Verify 201 response with role definition
3. `PATCH /api/projects/:id/members/:memberId` -- assign Bob `role: 'custom'`, `customRoleId: <role-id>`
4. Verify Bob's runtime permission check grants `session:create` but denies `agent:update`

**Expected Result**: Custom role is created, assigned, and its permissions are enforced at runtime.

**Status**: NOT TESTED

### E2E-2: Cross-Tenant Role Isolation

**Preconditions**: Tenant T1 with Alice (OWNER), custom role R1. Tenant T2 with Eve (OWNER).

**Steps**:

1. `GET /api/workspaces/:t2TenantId/roles/:r1Id` as Eve -- expect 404
2. `PATCH /api/workspaces/:t2TenantId/roles/:r1Id` as Eve -- expect 404
3. `DELETE /api/workspaces/:t2TenantId/roles/:r1Id` as Eve -- expect 404

**Expected Result**: No cross-tenant access. Responses return 404 (no existence leak).

**Status**: NOT TESTED

### E2E-3: System Role Immutability and Deletion Guard

**Preconditions**: Tenant T1 with OWNER (Alice). System roles seeded. Custom role R1 assigned to Bob in P1.

**Steps**:

1. `PATCH /api/workspaces/:tenantId/roles/:systemRoleId` as Alice -- expect 403/400 (system role)
2. `DELETE /api/workspaces/:tenantId/roles/:systemRoleId` as Alice -- expect 403/400
3. `DELETE /api/workspaces/:tenantId/roles/:r1Id` as Alice -- expect 409 (members assigned)

**Expected Result**: System roles cannot be modified. Custom roles with assigned members cannot be deleted.

**Status**: NOT TESTED

### E2E-4: Project Member CRUD with Explicit Access Enforcement

**Preconditions**: Tenant T1 with OWNER (Alice), MEMBER (Bob), MEMBER (Carol). Project P1 owned by Alice.

**Steps**:

1. `POST /api/projects/:id/members` as Alice -- add Bob as `developer` -- expect 201
2. `GET /api/projects/:id/members` as Bob -- expect 200 (member can read list)
3. `POST /api/projects/:id/members` as Bob -- try to add Carol -- expect 403 (developer cannot manage)
4. `GET /api/projects/:id` as Carol -- expect 404 (Carol is not a member, no existence leak)
5. `PATCH /api/projects/:id/members/:bobMemberId` as Alice -- change Bob to `admin` -- expect 200
6. `POST /api/projects/:id/members` as Bob -- now add Carol -- expect 201 (admin can manage)
7. `DELETE /api/projects/:id/members/:carolMemberId` as Bob -- remove Carol -- expect 200

**Expected Result**: Only project admins, owners, and tenant admins can manage members. Non-members get 404.

**Status**: NOT TESTED

### E2E-5: Tester Role Permission Boundaries

**Preconditions**: Tenant T1 with OWNER (Alice), MEMBER (Bob). Project P1 owned by Alice. Bob added as `tester`.

**Steps**:

1. Verify Bob can read agents, sessions, analytics (tester read permissions)
2. Verify Bob can create sessions (simulate access)
3. Verify Bob cannot create agents, update tools, or manage deployments (tester is read + simulate only)
4. Verify Bob cannot manage project members (tester is not admin)

**Expected Result**: Tester role grants read + simulate + analytics but not write access to most resources.

**Status**: NOT TESTED

### E2E-6: Project Listing Filtered by Membership

**Preconditions**: Tenant T1 with OWNER (Alice), MEMBER (Bob), MEMBER (Carol). Three projects: P1 (Alice owns), P2 (Alice owns, Bob is member), P3 (Alice owns).

**Steps**:

1. `GET /api/projects` as Alice -- expect [P1, P2, P3] (tenant OWNER sees all)
2. `GET /api/projects` as Bob -- expect [P2] only (member of P2)
3. `GET /api/projects` as Carol -- expect [] (no membership)

**Expected Result**: Regular members see only projects where they have explicit membership. Tenant admins/owners see all.

**Status**: NOT TESTED

---

## Integration Test Scenarios (Minimum 5)

### INT-1: Custom Role Permission Resolution with Cache

**Test File**: `apps/runtime/src/__tests__/services/permission-resolution.test.ts`

Tests `resolveProjectCustomRolePermissions` with real MongoDB: creates a `RoleDefinition`, resolves permissions, verifies cache returns same result, invalidates cache via `clearPermissionCache`, and verifies refreshed permissions after DB update.

**Status**: TESTED

### INT-2: evaluateProjectPermission with Custom Role

**Test File**: `apps/runtime/src/__tests__/auth/middleware/rbac.test.ts`

Tests that when a `ProjectMember` has `role: 'custom'` and `customRoleId`, the runtime calls `resolveProjectCustomRolePermissions` and grants/denies based on the resolved permission list.

**Status**: TESTED (unit-level with mock DB)

### INT-3: Stale Custom Role Fallback

**Test File**: `apps/runtime/src/__tests__/services/permission-resolution.test.ts`

Tests that when a `customRoleId` references a non-existent `RoleDefinition` (deleted), the resolver returns empty permissions (deny-by-default) rather than crashing.

**Status**: TESTED

### INT-4: Project Member Service Business Rules

**Test File**: `apps/studio/src/__tests__/project-member-service.test.ts`

Tests `assertCallerCanManageMembers`, `canActorManageMembers`, `listAvailableProjectMembers`, `addProjectMember`, `updateProjectMember`, and `removeProjectMember` business rules: tenant admin bypass, owner bypass, admin role check, available-member filtering, custom role validation, audit logging.

**Status**: TESTED (unit-level with mock repos)

### INT-5: Custom Role CRUD API Contracts

**Test File**: `apps/studio/src/__tests__/api-routes/api-custom-roles.test.ts`

Tests create, list, get, update, delete custom roles with real Zod validation and real `validateCustomRolePermissions`. Uses in-memory DB mock for persistence.

**Status**: TESTED (unit-level with mock DB)

---

## Unit Test Files

| Test File                                                                | Tests | Focus                                                                 |
| ------------------------------------------------------------------------ | ----- | --------------------------------------------------------------------- |
| `apps/studio/src/__tests__/project-member-service.test.ts`               | ~15   | Member service business rules, custom role validation                 |
| `apps/studio/src/__tests__/api-routes/api-project-members.test.ts`       | ~20   | Route contracts for member management endpoints                       |
| `apps/studio/src/__tests__/components/project-members-tab-rbac.test.tsx` | ~2    | UI regressions for manage-members gating and available-member loading |
| `apps/studio/src/__tests__/api-routes/api-custom-roles.test.ts`          | ~25   | Custom role CRUD with real Zod + permission validation                |
| `apps/studio/src/__tests__/api-routes/route-handler-rbac.test.ts`        | ~10   | Permission enforcement, wildcard matching, rate limiting              |
| `apps/studio/src/__tests__/project-access.test.ts`                       | ~10   | Explicit membership enforcement, 404 concealment                      |
| `apps/studio/src/__tests__/project-services.test.ts`                     | ~15   | Membership-filtered listing, tenant-wide access checks                |
| `apps/runtime/src/__tests__/auth/middleware/rbac.test.ts`                | ~20   | Custom role resolution, tester role, non-member concealment           |
| `apps/runtime/src/__tests__/services/permission-resolution.test.ts`      | ~10   | Permission resolution, cache behavior, cache invalidation             |

---

## Critical Gaps

1. **No E2E tests** -- All 6 E2E scenarios above are not yet implemented. This is the primary gap blocking BETA promotion.
2. **No integration tests with real HTTP servers** -- Current "integration" tests use mock repos or mock DB. True integration tests with `supertest` or real HTTP calls are missing.
3. **No test for role duplicate endpoint** -- The endpoint itself is not yet implemented.
4. **No test for bulk operations** -- Bulk add, bulk update, bulk remove endpoints are not yet implemented.
5. **Custom-role assignment UI remains untested** -- Built-in project member management now has UI regression coverage, but assigning `role: 'custom'` plus `customRoleId` still lacks Project Members UI coverage.
