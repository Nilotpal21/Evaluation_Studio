# Cross-Feature QA Review

**Date**: 2026-04-09
**Scope**: Project RBAC LLD + Custom Project Roles + Workspace Management v1.0 Parity + User Lifecycle Management
**Reviewer**: QA Architect (Opus 4.6)
**Artifacts Reviewed**:

- `docs/plans/2026-04-09-project-rbac-management-impl-plan.md` (LLD, REVIEWED)
- `docs/features/custom-project-roles.md` (Feature Spec, PLANNED)
- `docs/features/workspace-management-v1-parity.md` (Feature Spec, PLANNED)
- `docs/features/user-lifecycle-management.md` (Feature Spec, PLANNED)

---

## Verdict: CONDITIONAL PASS

The LLD for Project RBAC has strong E2E scenario coverage (18 scenarios). The three feature specs have adequate test coverage tables (10, 17, and 15 scenarios respectively). However, **zero cross-feature test scenarios exist across any of the four artifacts**, and several single-feature gaps would leave real integration bugs undetected. The conditional pass is contingent on addressing the CRITICAL and HIGH items below before implementation begins.

---

## Per-Feature Test Coverage Assessment

### 1. Project RBAC Management LLD

**E2E scenarios**: 18 scenarios covering all major paths (Scenarios 1-18 in Section 4)

**FR Coverage**: STRONG

- Listing filter by membership: Scenario 1
- Add member from tenant list: Scenario 2
- Non-tenant-member rejection: Scenario 3
- Role update + permission enforcement: Scenario 4
- Remove member: Scenario 5
- Cannot remove owner: Scenario 6
- Sole admin protection: Scenario 7
- Cross-tenant isolation: Scenario 8
- Available members: Scenario 9
- Auto-create admin on project create: Scenario 10
- Non-admin read access: Scenario 11
- Bulk add: Scenario 12
- Bulk partial failure: Scenario 13
- Bulk update/remove: Scenario 14
- Tester role: Scenario 15
- Permission matrix: Scenario 16
- Search/filter: Scenario 17
- Deletion guard (agent ownership): Scenario 18

**Missing Scenarios**:

- **M-RBAC-1** (HIGH): Concurrent add of the same user by two admins simultaneously. The `{ projectId, userId }` unique index should cause a 409 for the second request, but no scenario verifies this race condition.
- **M-RBAC-2** (MEDIUM): Bulk add exceeding the max 50 limit. Scenarios 12-13 test valid bulk but never test the Zod `.max(50)` rejection.
- **M-RBAC-3** (MEDIUM): Listing with combined `?search=bob&role=developer` filters applied simultaneously. Scenario 17 tests each in isolation.
- **M-RBAC-4** (MEDIUM): Empty project member list (project with only the auto-created owner). Scenario 10 implicitly covers this but does not assert `summary.total === 1`.
- **M-RBAC-5** (HIGH): `customRoleId` field preservation. When a member with a `customRoleId` (set by Custom Roles feature) has their built-in role changed, does `customRoleId` get cleared or preserved? No scenario tests this. This is critical for the Custom Roles integration.
- **M-RBAC-6** (MEDIUM): Unicode/special characters in search query (`?search=Rene%CC%81`). No boundary testing on the search parameter.

**Testability Issues**:

- The `tester` role's `simulate:*` and `analytics:read` permissions are enforced at runtime, not Studio. Scenario 15 acknowledges this (`"Note: simulate and analytics permissions are enforced at runtime layer, not tested here"`). This is a testability gap -- there should be a separate runtime-layer E2E test for tester role permissions.
- The `PROJECT_ROLE_PERMISSIONS` extraction from runtime to shared package (Phase 2, task 2.7) is a cross-package change that could break runtime if the import path changes. No test verifies that runtime still resolves permissions correctly after the extraction.

---

### 2. Custom Project Roles

**E2E scenarios in spec**: 10 scenarios (Section 17)

**FR Coverage**: 9/9 FRs mapped
| FR | Scenario | Covered? |
|----|----------|----------|
| FR-1 (CRUD API) | #1, #2, #8 | Yes |
| FR-2 (Module permissions) | #1, #2 | Partially -- no scenario tests Custom access level (only Full/View/No Access) |
| FR-3 (Duplicate) | #2 | Yes |
| FR-4 (Assignment) | #1, #4 | Yes |
| FR-5 (evaluateProjectPermission wiring) | #1 | Yes -- but only happy path |
| FR-6 (Cache TTL propagation) | #5 | Yes |
| FR-7 (System role immutability + deletion guard) | #3, #6 | Yes |
| FR-8 (Name uniqueness) | Not covered | **GAP** |
| FR-9 (Cross-tenant customRoleId validation) | #10 | Yes |

**Missing Scenarios**:

- **M-CR-1** (CRITICAL): FR-8 -- role name uniqueness within a tenant. No scenario attempts to create two custom roles with the same name and verifies the unique index error (409 or similar).
- **M-CR-2** (HIGH): Custom role with `parentRoleId` set -- permission inheritance through the parent chain. Scenario #4 tests "Permission inheritance via parentRoleId" as integration, but no E2E scenario exercises the full API flow: create parent role, create child role with `parentRoleId`, assign child to member, verify member gets parent + child permissions.
- **M-CR-3** (HIGH): Custom role cycle detection. If role A has `parentRoleId = B` and role B is updated to have `parentRoleId = A`, the `resolveRolePermissions()` cycle guard must prevent infinite loops. No scenario tests this.
- **M-CR-4** (MEDIUM): `evaluateProjectPermission` fallback behavior. When `customRoleId` references a deleted or invalid role, the runtime should fall back to `PROJECT_ROLE_PERMISSIONS` for the built-in `role` field. Scenario #9 tests clearing `customRoleId` to null, but not the case where `customRoleId` points to a nonexistent role.
- **M-CR-5** (MEDIUM): List roles endpoint returns both system and custom roles sorted consistently. No scenario asserts ordering.
- **M-CR-6** (HIGH): Custom role deletion cascade. The spec says deletion sets `customRoleId = null` on affected `ProjectMember` records. No E2E scenario verifies this cascade behavior: create role, assign to member, force-delete role (after unassigning? or should it cascade?), verify member's `customRoleId` is null and they fall back to built-in role.
- **M-CR-7** (MEDIUM): Role definition update with empty permissions array (`permissions: []`). Should the system allow a role with zero permissions? No boundary test.

**Testability Issues**:

- FR-6 (cache propagation within 60s) is inherently hard to test in E2E without time manipulation. Scenario #5 says "wait <= 60s, verify member's next API call uses new perms" -- this is an integration test, not a true E2E test. The test either needs to wait the full TTL (making the test slow) or the cache needs a test-mode override (which is acceptable infrastructure).
- The `evaluateProjectPermission` wiring lives in runtime (`apps/runtime/src/middleware/rbac.ts`). But custom role CRUD lives in Studio. Testing permission enforcement after custom role assignment requires the runtime to be running and aware of the custom role in the database. This cross-service boundary is the hardest part to test in E2E.

---

### 3. Workspace Management v1.0 Parity

**E2E scenarios in spec**: 12 E2E + 5 integration = 17 total (Section 17)

**FR Coverage**: 10/10 FRs mapped
| FR | Scenario | Covered? |
|----|----------|----------|
| FR-1 (Default workspace) | #1, #2 | Yes |
| FR-2 (Favorites) | #3, #4 | Yes |
| FR-3 (Search) | #6 | Yes |
| FR-4 (Member count) | #7 | Yes |
| FR-5 (Create from switcher) | #5 | Yes |
| FR-6 (Settings page) | #8, #9 | Yes |
| FR-7 (Soft-delete) | #10 | Yes |
| FR-8 (Grace period) | #11 | Yes |
| FR-9 (Permanent deletion cascade) | #15 | Integration only |
| FR-10 (Deletion confirmation) | Not covered | **GAP** -- UI-layer concern, but API should validate confirmation token |

**Missing Scenarios**:

- **M-WS-1** (CRITICAL): FR-9 permanent deletion cascade E2E. Scenario #15 is integration-only. No E2E scenario verifies that after the 30-day grace period, calling the cleanup job permanently deletes all tenant-scoped data (projects, agents, sessions, etc.). This is the highest-risk operation in the entire feature.
- **M-WS-2** (HIGH): Setting `defaultTenantId` to an archived workspace. The spec says "If the default workspace is no longer accessible, fall back to oldest." No scenario tests: (1) set workspace as default, (2) archive it, (3) login, (4) verify session scoped to fallback workspace.
- **M-WS-3** (HIGH): Favorite workspace archival cleanup. The spec says "If a favorite workspace is archived, it is silently removed from the favorites list on the next preferences read." No scenario tests this.
- **M-WS-4** (HIGH): Slug uniqueness on update. Scenario #17 is integration-only. An E2E scenario should attempt to update a workspace slug to one that already exists and verify 409 Conflict.
- **M-WS-5** (MEDIUM): Create workspace exceeding per-user limit (default 10). No scenario attempts creation at the boundary.
- **M-WS-6** (MEDIUM): `PATCH /api/workspaces/:tenantId` with ADMIN role (should be allowed for name/slug/retention but not deletion). Scenario #9 tests MEMBER getting 403, but no scenario tests the ADMIN happy path.
- **M-WS-7** (HIGH): Restore after grace period expiry. What happens when `POST /api/workspaces/:tenantId/restore` is called after 30 days? The spec does not define this -- it should be tested (expected: 404 or 410 Gone).
- **M-WS-8** (MEDIUM): Session termination within 5 minutes of archival (FR-7). No E2E scenario verifies that active sessions in an archived workspace are terminated. This is listed as GAP-005 in the spec.
- **M-WS-9** (MEDIUM): Concurrent archive and restore. Two admins simultaneously: one archives, one restores. What state does the workspace end up in?

**Testability Issues**:

- FR-9 (permanent deletion cascade) is extremely difficult to test in E2E because it requires either a 30-day wait or a test-mode override of the `WORKSPACE_ARCHIVE_GRACE_DAYS` constant. The test infrastructure must provide a mechanism to trigger the cleanup job with a shorter grace period.
- FR-7's "session termination within 5 minutes" requires integration with the runtime's session management. No mechanism is specified for how the Studio cleanup triggers runtime session termination.
- The member count aggregation (`$group` pipeline) needs test data with members in multiple workspaces to verify the batch aggregation correctness.

---

### 4. User Lifecycle Management

**E2E scenarios in spec**: 8 E2E + 7 integration = 15 total (Section 17)

**FR Coverage**: 13/13 FRs mapped
| FR | Scenario | Covered? |
|----|----------|----------|
| FR-1 (Status field) | Implicit in all status tests | Yes |
| FR-2 (Auth middleware check) | #1, #2 | Yes |
| FR-3 (Status transition APIs) | #1, #2 | Yes -- but missing lock/unlock E2E |
| FR-4 (Last OWNER protection) | #9 | Integration only |
| FR-5 (Refresh token revocation) | #10 | Integration only |
| FR-6 (Dashboard summary) | #3 | Yes |
| FR-7 (Bulk invite) | #4 | Yes |
| FR-8 (Bulk role change/remove) | #5 | Yes |
| FR-9 (Search/filter/pagination) | #6 | Yes |
| FR-10 (Email notifications) | #7 | Yes |
| FR-11 (Email toggle) | #14 | Integration only |
| FR-12 (Configurable settings) | #8 | Yes |
| FR-13 (Auto-lock on failed login) | Not covered | **GAP** |

**Missing Scenarios**:

- **M-UL-1** (CRITICAL): FR-13 -- auto-lock on failed login attempts. No E2E or integration scenario tests the interaction between `incrementFailedLoginAttempts()` setting `loginLockedUntil` and the system automatically setting `TenantMember.status = 'locked'` across all workspaces. This is the most complex interaction in the entire feature.
- **M-UL-2** (CRITICAL): FR-4 last OWNER protection as E2E. Scenario #9 is integration-only. This is a data integrity guard and must have an E2E scenario: attempt to suspend the sole OWNER via API, verify 400 response.
- **M-UL-3** (HIGH): Lock/unlock E2E scenario. FR-3 includes lock and unlock, but the E2E scenarios (#1, #2) only cover suspend/activate. No E2E scenario covers: admin locks member, member gets 403, admin unlocks, member can access again.
- **M-UL-4** (HIGH): Role hierarchy enforcement. FR-3 says "admins must not be able to modify members with equal or higher roles." No scenario tests: ADMIN attempts to suspend another ADMIN (should fail) or ADMIN attempts to suspend OWNER (should fail).
- **M-UL-5** (HIGH): Self-modification prevention. Scenario #15 is integration-only. An E2E scenario should verify: admin cannot suspend/lock themselves via the API.
- **M-UL-6** (HIGH): CSV bulk invite with malicious content. No scenario tests: CSV with script injection in email field (`=cmd|'/C calc'!A0`), extremely long email strings, or embedded newlines. The spec mentions "email validation via Zod `z.string().email()`" but no scenario verifies rejection of these edge cases.
- **M-UL-7** (MEDIUM): Pagination boundary. No scenario tests page navigation: request page 3 of 5, verify correct offset. No scenario tests `pageSize > 100` rejection.
- **M-UL-8** (MEDIUM): `lastActiveAt` update throttling. The spec says "throttled to once per minute." No scenario verifies that two requests within 1 second do not both trigger a DB write.
- **M-UL-9** (MEDIUM): Redis cache miss path. When Redis is unavailable, does the auth middleware fall back to MongoDB? No scenario tests cache failure resilience.
- **M-UL-10** (HIGH): Concurrent status transitions. FR mentions `findOneAndUpdate()` with current status as filter. No scenario tests two concurrent suspend requests on the same member -- one should succeed, one should fail gracefully.

**Testability Issues**:

- FR-2 (auth middleware status check with Redis cache) requires Redis in the test environment. The Studio E2E test pattern (`integration-auth-profiles.e2e.test.ts`) uses MongoMemoryServer + Redis binary detection. The user lifecycle E2E tests must follow this pattern.
- FR-10 (email notifications) via `ConsoleEmailService` stdout capture is sound but fragile. The test must capture stdout/stderr before the API call and parse it after. This is workable but should be documented as a test utility.
- FR-13 (auto-lock on failed login) requires simulating 5 failed login attempts, which means the login endpoint must be exercised. If the login endpoint rate-limits or has CAPTCHA, this may require test-mode overrides.

---

## Cross-Feature Test Scenarios (NEW -- not in any spec)

These are the highest-value missing scenarios. They test interactions between features that no single feature spec would cover.

### X-1: Project RBAC + Custom Roles -- Custom role assigned, permission enforcement (CRITICAL)

```
GIVEN tenant T1, project P1, custom role "qa-lead" with permissions [agent:read, session:*, simulate:*]
  AND user Bob is a project member with role "developer" and customRoleId = "qa-lead"
WHEN Bob calls a runtime endpoint requiring "deployment:read" permission
THEN request is DENIED -- "qa-lead" custom role does not include deployment:read
  (even though "developer" built-in role does)
```

**Why critical**: This tests that `evaluateProjectPermission` correctly gives `customRoleId` precedence over built-in `role`. If the runtime falls back to built-in role, Bob would get developer permissions instead of the restricted custom role.

### X-2: Project RBAC + User Lifecycle -- Suspended user cannot access project members API (HIGH)

```
GIVEN tenant T1, user Alice (ADMIN), user Bob (MEMBER, project member of P1)
WHEN Alice suspends Bob via POST /api/workspaces/:tenantId/members/:bobId/suspend
  AND Bob calls GET /api/projects/P1/members
THEN Bob receives 403 with code MEMBER_SUSPENDED
```

**Why**: Verifies that TenantMember status check in auth middleware fires before Studio project access check.

### X-3: Custom Roles + User Lifecycle -- Suspended user's custom role preserved after reactivation (HIGH)

```
GIVEN user Bob has custom role "qa-lead" on project P1
WHEN admin suspends Bob (TenantMember.status = 'suspended')
  AND admin activates Bob (TenantMember.status = 'active')
WHEN Bob accesses P1
THEN Bob's custom role is still "qa-lead" -- suspension does NOT clear customRoleId on ProjectMember
```

**Why**: Suspension modifies TenantMember, not ProjectMember. But if the implementation accidentally cascades, users lose their custom role assignments.

### X-4: Workspace Management + Project RBAC -- Workspace deletion cascades to project members (CRITICAL)

```
GIVEN tenant T1 with project P1, Bob is a project member of P1
WHEN workspace T1 is archived (DELETE /api/workspaces/:tenantId)
  AND 30-day grace period passes, permanent deletion runs
THEN project_members collection has NO records with projectId in [projects of T1]
  AND role_definitions collection has NO records with tenantId = T1
```

**Why**: The cascade deletion enumeration in the workspace spec lists `tenant_members` and `role_definitions` but does NOT list `project_members`. This is a data leak gap.

### X-5: Workspace Management + User Lifecycle -- Archive workspace while bulk operations in progress (HIGH)

```
GIVEN tenant T1, admin Alice starts bulk invite of 50 users
  AND concurrently, owner Bob archives workspace T1
WHEN the bulk invite is partially complete (30/50 processed)
THEN remaining 20 invitations should fail gracefully (workspace archived)
  AND the 30 already-invited members should see the workspace as archived
  AND partial success response includes the failure reason for remaining 20
```

**Why**: Tests that workspace archival is checked within bulk operation loops, not just at the beginning.

### X-6: All Four Features -- Full lifecycle scenario (CRITICAL)

```
GIVEN tenant T1 with workspace settings: defaultRole=MEMBER, inviteExpiryDays=14
  AND custom role "auditor" created with permissions [session:read, analytics:read]
  AND project P1 with user Bob added as developer

Phase 1: Custom role assignment
WHEN admin assigns customRoleId="auditor" to Bob on P1
THEN Bob's effective permissions are from "auditor" role, not "developer"

Phase 2: User suspension
WHEN admin suspends Bob
THEN Bob cannot access P1 (403 MEMBER_SUSPENDED)
  AND Bob's customRoleId on ProjectMember is preserved

Phase 3: Workspace archival
WHEN owner archives workspace T1
THEN Bob (still suspended) cannot see T1 in workspace list
  AND P1 is not accessible to anyone

Phase 4: Workspace restoration
WHEN owner restores workspace T1 within grace period
THEN Bob is still suspended (status preserved through archive/restore)
  AND Bob's customRoleId is still "auditor" on P1

Phase 5: User reactivation
WHEN admin activates Bob
THEN Bob can access P1 with "auditor" custom role permissions
```

**Why**: This is the ultimate integration test. It verifies that no feature's implementation corrupts another feature's state through the full lifecycle.

### X-7: Project RBAC + User Lifecycle -- Bulk remove skips suspended members correctly (MEDIUM)

```
GIVEN project P1 with members: Bob (developer, active), Carol (developer, suspended), Dave (viewer, locked)
WHEN admin calls POST /api/projects/P1/members/bulk-remove { userIds: [Bob, Carol, Dave] }
THEN all three are removed from ProjectMember (suspension/lock is TenantMember-level, not ProjectMember-level)
```

**Why**: Clarifies that ProjectMember removal is independent of TenantMember status. A common implementation mistake would be to skip suspended/locked users.

### X-8: Custom Roles + Workspace Management -- Role definitions cleaned up on workspace deletion (HIGH)

```
GIVEN tenant T1 with 3 custom roles and 2 system roles
WHEN workspace T1 is permanently deleted (after 30-day grace)
THEN role_definitions with tenantId=T1 are all deleted (custom and system)
  AND users who had T1 custom roles in their defaultTenantId/favoriteTenantIds references are cleaned up
```

**Why**: The workspace spec lists `role_definitions` in the cascade but does not verify custom role references are also cleaned from User model preferences.

### X-9: User Lifecycle + Workspace Management -- Default workspace pointing to archived workspace (HIGH)

```
GIVEN user Bob has defaultTenantId = T1 and favoriteTenantIds = [T1, T2, T3]
WHEN T1 is archived
THEN on Bob's next login, session scopes to T2 (next available, not archived)
  AND GET /api/auth/tenants excludes T1 from the list
  AND T1 is silently removed from favoriteTenantIds on next preferences read
```

**Why**: Tests the interaction between workspace archival and user preferences cleanup.

### X-10: Project RBAC + Custom Roles + User Lifecycle -- Permission matrix includes custom roles (MEDIUM)

```
GIVEN tenant T1 with custom role "qa-lead" and project P1
WHEN user calls GET /api/projects/P1/roles/permissions
THEN response includes built-in roles (admin, developer, tester, viewer)
  BUT does NOT include "qa-lead" (custom roles are tenant-scoped, not shown in project permission matrix)
  -- OR if the API is extended to show custom roles, they appear with their resolved permissions
```

**Why**: The permission matrix endpoint in the LLD only maps `PROJECT_ROLE_PERMISSIONS`. Custom roles are resolved differently (via `RoleDefinition` + `resolveRolePermissions`). The expected behavior must be specified and tested.

---

## Shared Test Infrastructure Needs

### Test Fixtures

All four features share the same base test data. A common fixture factory should be created:

```
SharedFixture:
  - Tenant T1 (active) with settings: { defaultRole: 'MEMBER', inviteExpiryDays: 7, emailNotifications: true }
  - Tenant T2 (active, for cross-tenant isolation tests)
  - User Alice: OWNER of T1
  - User Bob: ADMIN of T1
  - User Carol: MEMBER of T1
  - User Dave: MEMBER of T1
  - User Eve: OWNER of T2 (cross-tenant)
  - Project P1 in T1: owned by Alice
  - Project P2 in T1: owned by Bob
  - ProjectMember: Alice->P1 (admin), Bob->P1 (developer), Carol->P1 (viewer)
  - System roles seeded (5 roles: OWNER, ADMIN, OPERATOR, MEMBER, VIEWER)
  - Custom role "qa-lead" in T1 with specific permissions
```

### Infrastructure Requirements

| Component                   | Required By                                  | Notes                                                        |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| MongoMemoryServer           | All 4 features                               | Already used in `integration-auth-profiles.e2e.test.ts`      |
| Redis binary                | User Lifecycle (cache), Custom Roles (cache) | Pattern exists in E2E test -- binary detection with fallback |
| ConsoleEmailService capture | User Lifecycle (FR-10)                       | stdout-based email verification                              |
| Dev login endpoint          | All 4 features                               | `POST /api/auth/dev-login` for test user authentication      |
| BullMQ test infrastructure  | Workspace Mgmt (cleanup job)                 | May need to trigger scheduled job manually in tests          |

### Parallelization Strategy

Tests CAN be parallelized by tenant isolation:

- Each test suite creates its own tenant (T1, T2)
- Tenant-scoped operations are isolated by design
- BUT: User model changes (defaultTenantId, favoriteTenantIds) are cross-tenant -- Workspace Management tests that modify User records could interfere with User Lifecycle tests if they share the same user

**Recommendation**: Each test suite should create its own users. Do NOT share User records across test files.

---

## Regression Risk Map

### Existing Tests at Risk

| Existing Test File                                                     | Risk Level | Why                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/project-access.test.ts`                     | HIGH       | Tests `requireProjectAccess` which is unchanged but called differently after membership filtering. The test currently mocks `findProjectByIdAndTenant` -- if the behavior changes (tenant-scoped lookup now also checks membership), the mocks diverge. |
| `apps/studio/src/__tests__/api-routes/api-project-list-routes.test.ts` | HIGH       | Tests project listing. Phase 1 changes `getUserProjectsWithCounts` signature to accept permissions. Existing callers will break if the signature change is not backward-compatible.                                                                     |
| `apps/runtime/src/__tests__/cross-project-isolation.test.ts`           | MEDIUM     | Tests runtime-side project isolation. Adding `tester` role to `PROJECT_ROLE_PERMISSIONS` should not affect existing tests but may change permission resolution paths.                                                                                   |
| `apps/studio/src/__tests__/auth-services.test.ts`                      | HIGH       | Tests `findDefaultTenantMembership`. Workspace Management changes this function to check `defaultTenantId` first. Existing test may not account for the new User model field.                                                                           |
| `apps/studio/src/__tests__/api-routes/route-handler-rbac.test.ts`      | MEDIUM     | Tests RBAC in route handlers. If `PROJECT_ROLE_PERMISSIONS` is extracted from runtime to shared, imports in test mocks may break.                                                                                                                       |

### Highest-Risk Code Changes

1. **`project-service.ts` -- `getUserProjectsWithCounts` signature change** (Project RBAC Phase 1): This function is called by the project listing route. Changing its signature from `(userId, tenantId)` to `(userId, tenantId, { permissions })` risks breaking the route handler if the permissions are not passed correctly. The route handler at `projects/route.ts:84` must be updated simultaneously.

2. **`rbac.ts` -- `evaluateProjectPermission` customRoleId wiring** (Custom Roles FR-5): This is the single highest-risk change across all 4 features. Every runtime API call flows through this function. A bug here means either (a) custom roles are ignored (no effect) or (b) all permission checks break (total outage). The existing 3-role permission map must continue to work unchanged when `customRoleId` is null.

3. **Auth middleware status check** (User Lifecycle FR-2): Adding a MongoDB query (even with Redis cache) to every authenticated request is a latency-sensitive change. If the Redis cache fails and the code does not handle the fallback gracefully, every request could block on a MongoDB query or worse, fail open (allowing suspended users access).

4. **`PROJECT_ROLE_PERMISSIONS` extraction to shared package** (Project RBAC Phase 2): Moving this constant from `apps/runtime/src/middleware/rbac.ts` to `packages/shared/src/rbac/` changes the import path for the runtime. If the runtime import is not updated atomically, the build breaks.

---

## Test Implementation Priority (Recommended Order)

### Phase 1: Foundation (Week 1)

1. **Project RBAC E2E** (18 scenarios from LLD Section 4) -- these are the most well-specified and ready to implement
2. **Shared test fixture factory** -- create the common tenant/user/project/member setup used by all features
3. **Missing M-RBAC-1 through M-RBAC-6** scenarios added to the Project RBAC suite

### Phase 2: Custom Roles + Cross-Feature (Week 2)

4. **Custom Project Roles E2E** (10 scenarios from spec + M-CR-1 through M-CR-7)
5. **Cross-feature X-1** (Custom role + RBAC permission enforcement) -- depends on both RBAC and Custom Roles being implemented
6. **Cross-feature X-4** (Workspace deletion cascade includes project_members)

### Phase 3: User Lifecycle (Week 3)

7. **User Lifecycle E2E** (8 E2E + 7 integration from spec + M-UL-1 through M-UL-10)
8. **Cross-feature X-2, X-3** (Suspended user + RBAC, custom role preservation)
9. **Cross-feature X-7** (Bulk remove + suspended members)

### Phase 4: Workspace Management + Integration (Week 4)

10. **Workspace Management E2E** (12 E2E + 5 integration from spec + M-WS-1 through M-WS-9)
11. **Cross-feature X-5, X-6, X-8, X-9, X-10** (remaining cross-feature scenarios)

### Phase 5: Full Integration (Week 5)

12. **Cross-feature X-6** (Full lifecycle scenario spanning all 4 features)
13. **Regression verification** -- run full existing test suite to catch breakage
14. **Performance testing** -- auth middleware latency with Redis cache, bulk operation throughput

---

## Data Gaps Requiring Clarification Before Implementation

| #    | Gap                                                                                                                                                                                                                                                                        | Affects                       | Severity     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------ |
| DG-1 | `project_members` NOT listed in workspace deletion cascade (Section 12 of workspace spec)                                                                                                                                                                                  | Workspace Mgmt + Project RBAC | CRITICAL     |
| DG-2 | `customRoleId` behavior on built-in role change undefined                                                                                                                                                                                                                  | Project RBAC + Custom Roles   | HIGH         |
| DG-3 | TenantMember `status` field does not exist yet -- the model needs modification before ANY User Lifecycle testing                                                                                                                                                           | User Lifecycle                | Prerequisite |
| DG-4 | `PROJECT_ROLE_PERMISSIONS` extraction path -- LLD says extract to `@agent-platform/shared/rbac` but prior audit found Studio imports from `@/lib/permission-resolver` which re-exports from `@agent-platform/shared/rbac`. The extraction must maintain both import paths. | Project RBAC + Custom Roles   | HIGH         |
| DG-5 | FR-13 (auto-lock) interaction with cross-workspace status is unspecified for the test scenario: if user is locked globally but admin in workspace B has previously unlocked them in workspace B, does the next global lock re-lock workspace B?                            | User Lifecycle                | HIGH         |
| DG-6 | Workspace archive + session termination mechanism undefined (GAP-005 in workspace spec). Without this, E2E testing of FR-7's 5-minute requirement is impossible.                                                                                                           | Workspace Mgmt                | HIGH         |

---

## Summary of Finding Counts

| Category                  | CRITICAL          | HIGH                        | MEDIUM        |
| ------------------------- | ----------------- | --------------------------- | ------------- |
| Project RBAC LLD          | 0                 | 2                           | 4             |
| Custom Project Roles      | 1                 | 3                           | 3             |
| Workspace Management      | 1                 | 4                           | 4             |
| User Lifecycle Management | 2                 | 4                           | 4             |
| Cross-Feature Scenarios   | 3 (X-1, X-4, X-6) | 5 (X-2, X-3, X-5, X-8, X-9) | 2 (X-7, X-10) |
| Data Gaps                 | 1 (DG-1)          | 4 (DG-2, DG-4, DG-5, DG-6)  | 0             |
| **Total**                 | **8**             | **22**                      | **17**        |
