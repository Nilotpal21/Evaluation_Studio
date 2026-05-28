# LLD: Project RBAC Management Layer

**Feature Spec**: N/A (building on existing RBAC design doc)
**HLD**: `docs/archive/plans-2026-02/2026-02-20-project-level-rbac-design.md`
**Test Spec**: Included below (E2E + integration scenarios)
**Status**: IN PROGRESS (Phases 0-2 implemented, Phases 3-4 pending)
**Date**: 2026-04-09
**Last Updated**: 2026-04-14

---

## 0. Problem Statement

The project RBAC **enforcement** layer is fully built (`ProjectMember` model, `requireProjectPermission` middleware, role-permission mapping). But the **management** layer is missing:

1. **Project listing shows all tenant projects** — `getUserProjectsWithCounts()` queries `{ tenantId }` without filtering by `ProjectMember`. Every tenant member sees every project.
2. **No project member CRUD API** — No `/api/projects/:id/members` endpoints exist.
3. **No project member management UI** — `ProjectMembersTab.tsx` is a hardcoded stub.
4. **Project creation doesn't auto-create a ProjectMember** — relies solely on `project.ownerId === userId` in the RBAC chain.

**Constraint**: Project members must come from the existing tenant member list only — no external email invites.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                              | Rationale                                                                                                                                                                                  | Alternatives Rejected                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| D-1  | Filter project listing by `ProjectMember` + owner + tenant admin                                      | Tenant admins/owners need full visibility; regular members should only see projects they belong to                                                                                         | Show all and rely on per-operation RBAC (current — users see projects they can't use) |
| D-2  | Auto-create `ProjectMember(role=admin)` on project creation                                           | Creator gets admin membership record, making access uniform and queryable. `ownerId` remains as fallback but membership is canonical                                                       | Keep relying on `ownerId` only (not queryable in listing filter)                      |
| D-3  | Project member API lives in Studio (Next.js), not Runtime (Express)                                   | Studio owns project CRUD, workspace management, and member management. Runtime owns execution-time RBAC enforcement only                                                                   | Put member API in runtime (breaks ownership boundary)                                 |
| D-4  | Source members from tenant member list only                                                           | Simpler UX, no invitation flow needed, aligns with user requirement                                                                                                                        | Email-based invitations (over-engineered for current needs)                           |
| D-5  | Project roles: `admin`, `developer`, `viewer` (existing)                                              | Already defined in `PROJECT_ROLE_PERMISSIONS`. No new roles needed                                                                                                                         | Adding `owner` as a project role (redundant with `ownerId`)                           |
| D-6  | Permission to manage members: project `admin` + project owner + tenant OWNER/ADMIN                    | Aligns with existing permission hierarchy                                                                                                                                                  | Allow `developer` role to add members (too permissive)                                |
| D-7  | Workspace creation from switcher is out of scope                                                      | Separate concern — focus this plan on project RBAC only                                                                                                                                    | Bundle workspace creation (scope creep)                                               |
| D-8  | Membership-filtered listing uses direct `Project.find()` — NOT `findProjects()`                       | `findProjects()` OR mapper silently drops `_id.$in` conditions; only supports `ownerId` and `tenantId` in OR branches                                                                      | Extend `findProjects()` (risky — changes semantics for all callers)                   |
| D-9  | Phase 0 backfill for existing project owners                                                          | Without backfill, membership-filtered listing would hide all existing owned projects that lack a `ProjectMember` record                                                                    | Rely on `ownerId` fallback only (fragile — two divergent access paths forever)        |
| D-10 | Service-layer `assertCallerCanManageMembers` with explicit `ProjectMember` lookup                     | `requireProjectAccess` grants access to ALL same-tenant users (tenant-scoped query on line 53-57) — it does NOT check membership role. Member management needs explicit admin/owner check. | Modify `requireProjectAccess` to add role checking (breaks existing callers)          |
| D-11 | Non-members get 404 from `requireProjectAccess`, insufficient-role members get 403 from service layer | Separates "can you see this project?" (route-level) from "can you manage members?" (service-level). The two-layer model matches existing patterns.                                         | Single combined check (harder to reuse, different error semantics)                    |
| D-12 | Add `tester` role to `PROJECT_ROLE_PERMISSIONS` (view + simulate + analytics)                         | v1.0 docs define 5 app-level roles including App Tester; current 3 roles have no testing-focused role                                                                                      | Keep 3 roles only (misaligned with product spec)                                      |
| D-13 | Bulk member operations: batch add, bulk role change, bulk remove                                      | v1.0 supports multi-select bulk operations and batch invitations; single-operation-only is insufficient for workspaces with many users                                                     | Single ops only (poor UX at scale)                                                    |
| D-14 | Deletion guard: cannot remove user who owns agents in the project                                     | v1.0: "cannot delete users who own active tools"; prevents orphaning agents/tools                                                                                                          | Allow removal with agent orphaning (data integrity risk)                              |
| D-15 | Search/filter on member list + summary counts                                                         | v1.0 has search by name, summary counts (total/by-role); essential for workspaces with 20+ members                                                                                         | Basic list only (poor discoverability at scale)                                       |
| D-16 | Permission matrix display: read-only view of what each role grants                                    | v1.0 shows detailed permission tables per role; users need to understand what a role means before assigning it                                                                             | No visibility (users assign roles blindly)                                            |
| D-17 | Default role when adding members is `developer`                                                       | v1.0 allows configuring a default role; `developer` is the most common assignment and safest non-admin default                                                                             | Require explicit role on every add (more clicks)                                      |

### Key Interfaces & Types

```typescript
// ─── API Request/Response Types ─────────────────────────────────────

// POST /api/projects/[id]/members
interface AddProjectMemberRequest {
  userId: string; // Must be an existing tenant member
  role: 'admin' | 'developer' | 'tester' | 'viewer';
}

// PATCH /api/projects/[id]/members/[userId]
interface UpdateProjectMemberRoleRequest {
  role: 'admin' | 'developer' | 'tester' | 'viewer';
}

// GET /api/projects/[id]/members response item
interface ProjectMemberResponse {
  id: string; // ProjectMember._id
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: 'admin' | 'developer' | 'tester' | 'viewer';
  isOwner: boolean; // true if userId === project.ownerId
  joinedAt: string; // ISO date
}

// POST /api/projects/[id]/members/bulk
interface BulkAddProjectMembersRequest {
  members: Array<{
    userId: string;
    role: 'admin' | 'developer' | 'tester' | 'viewer';
  }>;
}

interface BulkOperationResult {
  succeeded: Array<{ userId: string; role: string }>;
  failed: Array<{ userId: string; error: string }>;
}

// POST /api/projects/[id]/members/bulk-update-role
interface BulkUpdateRoleRequest {
  userIds: string[];
  role: 'admin' | 'developer' | 'tester' | 'viewer';
}

// POST /api/projects/[id]/members/bulk-remove
interface BulkRemoveMembersRequest {
  userIds: string[];
}

// GET /api/projects/[id]/members/available response item
interface AvailableTenantMemberResponse {
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  tenantRole: string; // Their workspace role (informational)
}

// GET /api/projects/[id]/members response envelope (updated)
interface ProjectMembersListResponse {
  success: true;
  members: ProjectMemberResponse[];
  summary: {
    total: number;
    byRole: Record<string, number>; // { admin: 2, developer: 5, tester: 1, viewer: 3 }
  };
}

// GET /api/projects/[id]/roles/permissions — permission matrix
interface RolePermissionMatrixResponse {
  roles: Array<{
    role: string;
    label: string;
    description: string;
    permissions: Array<{
      module: string; // e.g., "Agents", "Tools", "Deployments"
      access: 'full' | 'read' | 'none';
    }>;
  }>;
}
```

### Module Boundaries

| Module                                             | Responsibility                                        | Depends On                                              |
| -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `studio/repos/project-member-repo.ts`              | ProjectMember CRUD (MongoDB)                          | `@agent-platform/database/models`                       |
| `studio/services/project-member-service.ts`        | Business logic: validation, tenant-member gate, audit | `project-member-repo`, `workspace-repo`, `project-repo` |
| `studio/app/api/projects/[id]/members/`            | HTTP API routes (Next.js)                             | `project-member-service`, `lib/auth`                    |
| `studio/components/settings/ProjectMembersTab.tsx` | UI: list, add, remove, change role                    | API client functions                                    |
| `studio/services/project-service.ts`               | Modified: filtered listing                            | `project-member-repo` (new dep)                         |
| `studio/app/api/projects/route.ts`                 | Modified: passes user role context                    | `project-service`                                       |

---

## 2. File-Level Change Map

### New Files

| File                                                                      | Purpose                                                        | LOC Estimate |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------ |
| `apps/studio/src/repos/project-member-repo.ts`                            | ProjectMember CRUD + direct membership-filtered project query  | ~150         |
| `apps/studio/src/services/project-member-service.ts`                      | Business logic: add/remove/update member + auth guards + audit | ~220         |
| `apps/studio/src/app/api/projects/[id]/members/route.ts`                  | GET (list) + POST (add) project members                        | ~180         |
| `apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts`         | PATCH (role) + DELETE (remove) project member                  | ~150         |
| `apps/studio/src/app/api/projects/[id]/members/available/route.ts`        | GET tenant members not yet in project                          | ~100         |
| `apps/studio/src/app/api/projects/[id]/members/bulk/route.ts`             | POST bulk-add                                                  | ~80          |
| `apps/studio/src/app/api/projects/[id]/members/bulk-update-role/route.ts` | POST bulk role update                                          | ~80          |
| `apps/studio/src/app/api/projects/[id]/members/bulk-remove/route.ts`      | POST bulk remove                                               | ~80          |
| `apps/studio/src/app/api/projects/[id]/roles/permissions/route.ts`        | GET permission matrix for project roles                        | ~80          |
| `apps/studio/src/api/project-members.ts`                                  | Frontend API client for all member endpoints                   | ~150         |
| `apps/studio/src/components/settings/PermissionMatrixPanel.tsx`           | Read-only permission matrix display component                  | ~100         |

### Modified Files

| File                                                        | Change Description                                                                                                                 | Risk     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `apps/studio/src/services/project-service.ts`               | `getUserProjectsWithCounts` — add membership filter via direct query; auto-create member in `createProject`                        | **High** |
| `apps/studio/src/app/api/projects/route.ts`                 | Pass `user.permissions` to listing service                                                                                         | Med      |
| `apps/studio/src/components/settings/ProjectMembersTab.tsx` | Replace stub with real member list + add/remove/role UI                                                                            | Med      |
| `apps/studio/src/services/audit-service.ts`                 | Add `PROJECT_MEMBER_ADDED`, `PROJECT_MEMBER_REMOVED`, `PROJECT_MEMBER_ROLE_CHANGED`, `PROJECT_MEMBER_BULK_ADDED` to `AuditActions` | Low      |
| `apps/runtime/src/middleware/rbac.ts`                       | Remove `PROJECT_ROLE_PERMISSIONS` (moved to shared), import from `@agent-platform/shared/rbac`                                     | Med      |
| `packages/shared/src/rbac/permission-resolver.ts`           | Export `PROJECT_ROLE_PERMISSIONS` constant (extracted from runtime) + add `tester` role                                            | Med      |
| `packages/i18n/locales/en/studio.json`                      | Add i18n keys under `settings.members.*` for new UI + permission matrix + bulk ops                                                 | Low      |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 0: Backfill — Create ProjectMember Records for Existing Project Owners

**Goal**: Ensure every existing project has at least one `ProjectMember(role=admin)` record for its owner, so the listing filter in Phase 1 doesn't hide owned projects.

**Tasks**:

0.1. Create a one-time backfill function as `backfillOwnerProjectMembers()` in `apps/studio/src/repos/project-member-repo.ts` (co-located with other ProjectMember operations). Expose it for CLI/script invocation but do NOT call it at startup:

```js
// For each project, upsert a ProjectMember for the owner and log created IDs
const projects = await Project.find({}, { _id: 1, ownerId: 1 }).lean();
const createdIds: string[] = [];
for (const p of projects) {
  const result = await ProjectMember.updateOne(
    { projectId: p._id, userId: p.ownerId },
    { $setOnInsert: { role: 'admin', _v: 1 } },
    { upsert: true }
  );
  if (result.upsertedId) {
    createdIds.push(String(result.upsertedId));
  }
}
log.info('Backfill complete', { totalProjects: projects.length, created: createdIds.length });
return createdIds; // For rollback — delete only these IDs
```

0.2. Run the backfill in dev environment and verify: every project's owner now has a `ProjectMember` record.

**Exit Criteria**:

- [ ] Every existing project has a `ProjectMember` record for its `ownerId` with `role=admin`
- [ ] No duplicate key errors (upsert handles existing records)
- [ ] Backfill is idempotent — safe to run multiple times

**Rollback**: The backfill script MUST log all created `ProjectMember._id` values to stdout. To rollback, delete only those IDs: `ProjectMember.deleteMany({ _id: { $in: loggedIds } })`. Do NOT use a blanket `deleteMany({ role: 'admin' })` — that would destroy legitimately created admin records.

---

### Phase 1: Data Layer — Project Member Repository + Listing Filter

**Goal**: Create the Studio-side `ProjectMember` repo and fix the project listing to filter by membership.

**Tasks**:

1.1. Create `apps/studio/src/repos/project-member-repo.ts` with these functions (follow `project-repo.ts` pattern: `ensureDb()`, dynamic imports, `normalizeId`):

- `findProjectMembers(projectId: string): Promise<ProjectMemberWithUser[]>` — list members with user info (manual join via `User.find({ _id: { $in: userIds } })`)
- `findProjectMember(projectId: string, userId: string): Promise<ProjectMember | null>`
- `createProjectMember(data: { projectId, userId, role }): Promise<ProjectMember>`
- `updateProjectMemberRole(projectId: string, userId: string, role: string): Promise<ProjectMember>`
- `deleteProjectMember(projectId: string, userId: string): Promise<void>`
- `findProjectIdsForUser(userId: string): Promise<string[]>` — uses `ProjectMember.distinct('projectId', { userId })`
- `countProjectMembers(projectId: string): Promise<number>`
- `countProjectAdmins(projectId: string): Promise<number>` — counts members with `role=admin`
- `findUserAccessibleProjects(tenantId: string, userId: string, opts?: { orderBy?, include? }): Promise<Project[]>` — **direct MongoDB query** bypassing `findProjects()`:
  ```js
  // CRITICAL: Do NOT use findProjects() — its OR mapper doesn't support _id.$in
  const memberProjectIds = await ProjectMember.distinct('projectId', { userId });
  return Project.find({
    tenantId,
    $or: [{ ownerId: userId }, { _id: { $in: memberProjectIds } }],
  })
    .sort({ updatedAt: -1 })
    .lean();
  ```
- Use `const log = createLogger('project-member-repo');` for logging

  1.2. Modify `apps/studio/src/services/project-service.ts` — change `getUserProjectsWithCounts()` signature:

- **New signature**: `getUserProjectsWithCounts(userId: string, tenantId?: string, options?: { permissions?: string[] })`
- If `hasPermission(options.permissions, 'project:*')` (tenant OWNER/ADMIN — import `hasPermission` from `@/lib/permission-resolver`): return all projects via existing `findProjects({ tenantId })` (current behavior, no regression)
- Otherwise: call `findUserAccessibleProjects(tenantId, userId)` from `project-member-repo.ts` — this bypasses `findProjects()` entirely, using a direct `Project.find()` with `$or: [{ ownerId }, { _id: { $in: memberProjectIds } }]`
- **CRITICAL**: Enrich results with `_count.agents` — the route handler at `projects/route.ts:96` maps `p._count.agents` and will crash without it:

  ```js
  // After findUserAccessibleProjects returns bare Project docs:
  const { ProjectAgent } = await import('@agent-platform/database/models');
  for (const project of results) {
    const agentCount = await ProjectAgent.countDocuments({ projectId: project.id });
    project._count = { agents: agentCount };
  }
  ```

  This mirrors the existing enrichment logic in `findProjects()` (project-repo.ts:102-108).

  1.3. Modify `apps/studio/src/app/api/projects/route.ts` line 84 — pass permissions:

- Change: `getUserProjectsWithCounts(user.id, parsedQuery.data.tenantId)`
- To: `getUserProjectsWithCounts(user.id, parsedQuery.data.tenantId, { permissions: user.permissions })`

  1.4. Auto-create `ProjectMember(role=admin)` when a project is created:

- In `project-service.ts` `createProject()`, after `createProjectRepo(...)`, call `createProjectMember({ projectId: project.id, userId: input.ownerId, role: 'admin' })` from `project-member-repo`.
- This ensures the creator shows up in member queries. The `ownerId` RBAC bypass in runtime remains as a safety net.

  1.5. Add `tester` role to `apps/runtime/src/middleware/rbac.ts` — add to `PROJECT_ROLE_PERMISSIONS`:

```typescript
tester: [
  'agent:read',
  'tool:read',
  'version:read',
  'deployment:read',
  'channel:read',
  'env_var:read',
  'session:read',
  'session:create',     // Can run simulations
  'workflow:read',
  'channel_connection:read',
  'credential:read',
  'lookup_data:read',
  'attachment:read',
  'simulate:*',         // Full simulate access
  'analytics:read',     // View analytics
],
```

This maps to v1.0's "App Tester" role: view-only for observing, testing agents, and analytics. Key difference from `viewer`: can create sessions (simulate) and read analytics.

1.6. Add audit actions to `apps/studio/src/services/audit-service.ts`:

- Add to `AuditActions`: `PROJECT_MEMBER_ADDED: 'project_member_added'`, `PROJECT_MEMBER_REMOVED: 'project_member_removed'`, `PROJECT_MEMBER_ROLE_CHANGED: 'project_member_role_changed'`, `PROJECT_MEMBER_BULK_ADDED: 'project_member_bulk_added'`
- These are distinct from existing tenant-level `MEMBER_REMOVED` / `MEMBER_ROLE_CHANGED` to avoid audit log ambiguity.

  1.7. Add `findProjectAgentsByUser(projectId: string, userId: string): Promise<any[]>` to `project-member-repo.ts`:

- Queries `ProjectAgent.find({ projectId, ownerId: userId })` — used by the deletion guard (D-14) to check if a user owns agents before removal.
- Note: `ownerId` is nullable on `ProjectAgent`. Agents with `ownerId: null` do not block any member's removal.

**Files Touched**:

- `apps/studio/src/repos/project-member-repo.ts` — **new**
- `apps/studio/src/services/project-service.ts` — modify `getUserProjectsWithCounts()` signature + `createProject()`
- `apps/studio/src/app/api/projects/route.ts` — pass permissions to service
- `apps/runtime/src/middleware/rbac.ts` — add `tester` role to `PROJECT_ROLE_PERMISSIONS`
- `apps/studio/src/services/audit-service.ts` — add 4 audit action constants

**Exit Criteria**:

- [ ] `findProjectMembers` returns members with user info (name, email, avatar)
- [ ] `findProjectIdsForUser` returns correct project IDs for a given user
- [ ] `findUserAccessibleProjects` uses direct MongoDB query (NOT `findProjects()`)
- [ ] `getUserProjectsWithCounts` for a tenant OWNER returns all projects (no regression)
- [ ] `getUserProjectsWithCounts` for a regular user returns only projects where they are owner or member
- [ ] New projects auto-create a `ProjectMember(role=admin)` for the creator
- [ ] Existing test in `apps/studio/src/__tests__/project-services.test.ts` updated for new signature
- [ ] `tester` role added to `PROJECT_ROLE_PERMISSIONS` with simulate + analytics + read permissions
- [ ] `findProjectAgentsByUser` returns agents owned by a specific user in a project
- [ ] `pnpm build --filter=apps/studio --filter=apps/runtime` succeeds with 0 errors

**Test Strategy**:

- Unit: Pure function tests for filter logic (permission check branching)
- Integration: Verify listing returns correct projects based on membership (via HTTP API)

**Rollback**: Revert the modified files. No schema changes — `ProjectMember` model already exists.

---

### Phase 2: API Layer — Project Member CRUD + Bulk Endpoints

**Goal**: Expose project member management via REST API with proper authorization, including bulk operations and permission matrix.

**Authorization model** (D-10, D-11):

- Routes use `requireTenantAuth` + `requireProjectAccess` for basic auth + project existence verification
- **Important**: `requireProjectAccess` (in `lib/project-access.ts`) grants access to ALL same-tenant users via its primary tenant-scoped lookup path (`findProjectByIdAndTenant(projectId, user.tenantId)`). It does NOT check `ProjectMember` role — it only verifies the project exists within the caller's tenant. Cross-tenant requests get 404.
- **Service layer** performs the actual authorization check via `assertCallerCanManageMembers`:
  - Explicitly looks up the caller's `ProjectMember` record (if any)
  - Grants manage access if caller is: project `admin` (via ProjectMember), project owner (`project.ownerId === caller.userId`), or tenant OWNER/ADMIN (`hasPermission(permissions, 'project:*')`)
  - Returns **403** if the caller is a same-tenant user without the required role
- **Read-only access** (GET member list): Any same-tenant user who passes `requireProjectAccess` can list members. This is consistent with the existing tenant-scoped visibility model.
- **Write access** (add/remove/update role): Requires the explicit `assertCallerCanManageMembers` check.

**Tasks**:

2.1. Create `apps/studio/src/services/project-member-service.ts` with business logic:

- Use `const log = createLogger('project-member-service');` for logging
- `assertCallerCanManageMembers(project, callerUserId, callerTenantId, callerPermissions)`:
  - **Explicitly** looks up caller's `ProjectMember` record via `findProjectMember(project.id, callerUserId)` — do NOT rely on `requireProjectAccess` for role checking (it only verifies tenant membership, not project role)
  - Returns true if ANY of: (a) caller has `project:*` tenant permission (import `hasPermission` from `@/lib/permission-resolver`), (b) caller is project owner (`project.ownerId === callerUserId`), (c) caller's ProjectMember role is `admin`
  - Throws 403 `FORBIDDEN` with `ErrorCode.FORBIDDEN` if not authorized
- `addProjectMember(projectId, callerUserId, callerTenantId, callerPermissions, targetUserId, role)`:
  - Verify project exists in caller's tenant via `findProjectByIdAndTenant`
  - Call `assertCallerCanManageMembers`
  - Verify target user is a tenant member: `findTenantMember(callerTenantId, targetUserId)` — returns 400 if not
  - Verify target is not already a project member — returns 409 with `ErrorCode.NAME_CONFLICT` (reuse existing code)
  - Create `ProjectMember` record
  - Audit log: `logAuditEvent({ action: AuditActions.PROJECT_MEMBER_ADDED, metadata: { projectId, targetUserId, role } })`
- `removeProjectMember(projectId, callerUserId, callerTenantId, callerPermissions, targetUserId)`:
  - Same auth checks via `assertCallerCanManageMembers`
  - Cannot remove the project owner (they have implicit access via `ownerId`) — returns 400
  - Cannot remove self if sole admin (`countProjectAdmins === 1 && caller is that admin`) — returns 400
  - **Deletion guard (D-14)**: Check `findProjectAgentsByUser(projectId, targetUserId)` — if user owns agents in this project, return 400: `"Cannot remove member who owns agents in this project. Reassign or delete their agents first."`
  - Delete `ProjectMember` record
  - Audit log: `AuditActions.PROJECT_MEMBER_REMOVED`
- `updateProjectMemberRole(projectId, callerUserId, callerTenantId, callerPermissions, targetUserId, newRole)`:
  - Same auth checks
  - Cannot demote sole admin (if target is the only admin and new role is not admin) — returns 400
  - Update role
  - Audit log: `AuditActions.PROJECT_MEMBER_ROLE_CHANGED`
- `getAvailableTenantMembers(projectId, tenantId)`:
  - Get all tenant members via `findTenantMembers(tenantId, { includeUser: true })`
  - Get project member userIds via `findProjectMembers(projectId)`
  - Return the set difference

    2.2. Create `apps/studio/src/app/api/projects/[id]/members/route.ts`:

- Use `withOpenAPI` wrapper (matches existing project routes pattern)
- Zod schemas for request/response validation
- `GET /api/projects/:id/members` — list project members
  - Auth: `requireTenantAuth` + `requireProjectAccess` (any project member or tenant admin can read)
  - Returns: `{ success: true, members: ProjectMemberResponse[] }`
- `POST /api/projects/:id/members` — add a member
  - Auth: `requireTenantAuth` + `requireProjectAccess` + service-level admin check
  - Body validated with `addMemberSchema`: `{ userId: z.string().min(1), role: z.enum(['admin','developer','tester','viewer']) }`
  - Returns: `{ success: true, member: ProjectMemberResponse }` (201)

    2.3. Create `apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts`:

- `PATCH /api/projects/:id/members/:userId` — update role
  - Auth: same as POST
  - Body validated with `updateRoleSchema`: `{ role: z.enum(['admin','developer','tester','viewer']) }`
  - Returns: `{ success: true, member: ProjectMemberResponse }`
- `DELETE /api/projects/:id/members/:userId` — remove member
  - Auth: same as POST
  - Returns: `{ success: true }` (200)

    2.4. Create `apps/studio/src/app/api/projects/[id]/members/available/route.ts`:

- `GET /api/projects/:id/members/available` — list tenant members not in project
  - Auth: `requireTenantAuth` + `requireProjectAccess` + service-level admin check
  - Returns: `{ success: true, members: AvailableTenantMemberResponse[] }`

    2.5. Add bulk operations to `project-member-service.ts`:

- `bulkAddProjectMembers(projectId, callerUserId, callerTenantId, callerPermissions, members: Array<{userId, role}>)`:
  - Auth: `assertCallerCanManageMembers`
  - For each member: validate tenant membership, check not already member, create ProjectMember
  - Partial success pattern: return `{ succeeded: [...], failed: [...] }` — individual failures don't abort the batch
  - Audit log: `AuditActions.PROJECT_MEMBER_BULK_ADDED` with metadata listing all added userIds
  - Max batch size: 50 members per request (Zod validation)
- `bulkUpdateMemberRoles(projectId, callerUserId, callerTenantId, callerPermissions, userIds: string[], role: string)`:
  - Auth: `assertCallerCanManageMembers`
  - Validate sole-admin protection for each user being changed (skip those who are sole admin being demoted)
  - Returns `{ succeeded, failed }` partial success pattern
- `bulkRemoveMembers(projectId, callerUserId, callerTenantId, callerPermissions, userIds: string[])`:
  - Auth: `assertCallerCanManageMembers`
  - Skip owner, skip sole-admin, skip users who own agents (D-14 deletion guard)
  - Returns `{ succeeded, failed }` partial success pattern

    2.6. Create bulk operation route files (one POST handler per file — consistent with codebase pattern of single-method route files):

- `apps/studio/src/app/api/projects/[id]/members/bulk/route.ts`:
  - `POST /api/projects/:id/members/bulk` — bulk add members
  - Body: `{ members: [{ userId: z.string().min(1), role: z.enum([...]) }], maxItems: 50 }`
  - Returns: `{ success: true, result: BulkOperationResult }` (200 — partial success allowed)
- `apps/studio/src/app/api/projects/[id]/members/bulk-update-role/route.ts`:
  - `POST /api/projects/:id/members/bulk-update-role` — bulk update roles
  - Body: `{ userIds: z.array(z.string().min(1)).max(50), role: z.enum([...]) }`
  - Returns: `{ success: true, result: BulkOperationResult }`
- `apps/studio/src/app/api/projects/[id]/members/bulk-remove/route.ts`:
  - `POST /api/projects/:id/members/bulk-remove` — bulk remove members
  - Body: `{ userIds: z.array(z.string().min(1)).max(50) }`
  - Returns: `{ success: true, result: BulkOperationResult }`

    2.7. Create `apps/studio/src/app/api/projects/[id]/roles/permissions/route.ts`:

- `GET /api/projects/:id/roles/permissions` — return the permission matrix for all project roles
  - Auth: `requireTenantAuth` + `requireProjectAccess` (any member can view)
  - Returns `RolePermissionMatrixResponse` — maps `PROJECT_ROLE_PERMISSIONS` into a human-readable module-based matrix
  - The response is derived from `PROJECT_ROLE_PERMISSIONS`. This constant must be extracted from `apps/runtime/src/middleware/rbac.ts` into `@agent-platform/shared/rbac` (where `hasPermission` already lives) so both Studio and Runtime can import it. Studio must NEVER import directly from the runtime app. Transform permission strings into module/access pairs:

    ```js
    // e.g., 'agent:*' → { module: 'Agents', access: 'full' }
    // e.g., 'agent:read' → { module: 'Agents', access: 'read' }
    // Missing module → { module: 'X', access: 'none' }
    ```

    2.8. Update `GET /api/projects/:id/members` response to include summary counts (D-15):

- Response becomes: `{ success: true, members: [...], summary: { total: N, byRole: { admin: X, developer: Y, tester: Z, viewer: W } } }`
- Support optional query param `?search=<name>` for server-side name filtering
- Support optional query param `?role=<role>` for role filtering

**Files Touched**:

- `apps/studio/src/services/project-member-service.ts` — **new**
- `apps/studio/src/app/api/projects/[id]/members/route.ts` — **new**
- `apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts` — **new**
- `apps/studio/src/app/api/projects/[id]/members/available/route.ts` — **new**
- `apps/studio/src/app/api/projects/[id]/members/bulk/route.ts` — **new**
- `apps/studio/src/app/api/projects/[id]/roles/permissions/route.ts` — **new**

**Exit Criteria**:

- [ ] `POST /api/projects/:id/members` creates a member and returns 201
- [ ] `POST /api/projects/:id/members` returns 404 for non-member callers (no existence leak)
- [ ] `POST /api/projects/:id/members` returns 403 for member callers without admin role
- [ ] `POST /api/projects/:id/members` returns 400 if target user is not a tenant member
- [ ] `POST /api/projects/:id/members` returns 409 if target is already a member
- [ ] `DELETE /api/projects/:id/members/:userId` removes the member
- [ ] `DELETE` returns 400 when trying to remove the project owner
- [ ] `DELETE` returns 400 when trying to remove the sole admin
- [ ] `DELETE` returns 400 when trying to remove a member who owns agents (D-14)
- [ ] `PATCH /api/projects/:id/members/:userId` updates the role
- [ ] `PATCH` returns 400 when demoting the sole admin
- [ ] `GET /api/projects/:id/members` returns members with user info + summary counts
- [ ] `GET /api/projects/:id/members?search=bob` filters by name
- [ ] `GET /api/projects/:id/members?role=admin` filters by role
- [ ] `GET /api/projects/:id/members/available` returns tenant members not in the project
- [ ] `POST /api/projects/:id/members/bulk` adds multiple members (partial success pattern)
- [ ] `POST /api/projects/:id/members/bulk-update-role` updates roles for multiple users
- [ ] `POST /api/projects/:id/members/bulk-remove` removes multiple members (skipping owners/sole-admins/agent-owners)
- [ ] Bulk endpoints enforce max 50 items per request
- [ ] `GET /api/projects/:id/roles/permissions` returns the permission matrix
- [ ] All endpoints return 404 for projects in other tenants (no existence leak)
- [ ] All request bodies validated via Zod `.safeParse()`
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors

**Test Strategy**:

- Integration: All CRUD + bulk operations via HTTP API with auth context
- Negative: non-member (404), insufficient role (403), cross-tenant (404), invalid user (400), bulk partial failures

**Rollback**: Delete the 6 new files + the service file. No existing files modified.

---

### Phase 3: UI Layer — Project Members Tab

**Goal**: Replace the stub `ProjectMembersTab` with a functional member management UI.

**Tasks**:

3.1. Create `apps/studio/src/api/project-members.ts` — frontend API client:

- Import `apiFetch` and `handleResponse` from `@/lib/api-client` (match existing pattern in `api/projects.ts`)
- `fetchProjectMembers(projectId, opts?: { search?, role? }): Promise<ProjectMembersListResponse>`
- `addProjectMember(projectId, userId, role): Promise<ProjectMemberResponse>`
- `updateProjectMemberRole(projectId, userId, role): Promise<ProjectMemberResponse>`
- `removeProjectMember(projectId, userId): Promise<void>`
- `fetchAvailableTenantMembers(projectId): Promise<AvailableTenantMemberResponse[]>`
- `bulkAddProjectMembers(projectId, members: Array<{userId, role}>): Promise<BulkOperationResult>`
- `bulkUpdateMemberRoles(projectId, userIds: string[], role: string): Promise<BulkOperationResult>`
- `bulkRemoveMembers(projectId, userIds: string[]): Promise<BulkOperationResult>`
- `fetchRolePermissionMatrix(projectId): Promise<RolePermissionMatrixResponse>`

  3.2. Rewrite `apps/studio/src/components/settings/ProjectMembersTab.tsx`:

- Continue using `useTranslations('settings')` from `next-intl` (matches existing settings tabs)
- **Summary bar** (D-15): Display total count + per-role counts at the top (e.g., "12 members — 2 Admin, 5 Developer, 1 Tester, 4 Viewer")
- **Search & filter**: Search input that filters by name/email (query param `?search=`). Role filter dropdown (All / Admin / Developer / Tester / Viewer).
- **Member list**: Fetch members on mount via `fetchProjectMembers`. Re-fetch after every mutation (add/remove/role change) to keep list current.
- **Role badge**: Show role with existing `Badge` component (admin=info, developer=warning, tester=secondary, viewer=default)
- **Owner indicator**: Show "Owner" badge for `isOwner === true` members
- **Multi-select**: Checkbox on each row. When 2+ rows selected, show bulk action bar at bottom: "Change role" dropdown + "Remove" button. Matches v1.0 pattern.
- **Add member**: Button opens a dropdown/modal that shows available tenant members (from `/available` endpoint), with role selector (default: `developer` per D-17). "Add another member" button for batch adds. Only visible to project admins/owner.
- **Change role**: Dropdown on each member row to change role (admin only). Disabled for the project owner.
- **Remove member**: Remove button on each member row (admin only). Disabled for the project owner. Confirmation dialog before removal. Shows warning if member owns agents (D-14).
- **Self-awareness**: Current user cannot remove themselves if they are the sole admin.
- **Loading states**: Spinner while initial load. Mutation buttons disabled during async operations (add/remove/role change) with inline spinner on active button.
- **Error states**: Inline error message on API failure. Toast for success feedback. Bulk operation results show succeeded/failed breakdown.

  3.3. Create `apps/studio/src/components/settings/PermissionMatrixPanel.tsx`:

- Fetches `fetchRolePermissionMatrix(projectId)` on mount
- Displays a table: rows = permission modules (Agents, Tools, Deployments, etc.), columns = roles (Admin, Developer, Tester, Viewer)
- Each cell shows access level: "Full" / "Read" / "None" with appropriate color coding
- Read-only — informational panel, no editing (custom roles are a separate feature)
- Collapsible/expandable panel below the member list in the Members tab
- Shows a "View permissions" toggle button to expand/collapse

  3.4. Add i18n keys to `packages/i18n/locales/en/studio.json` under `settings.members.*`:

- `add_member` — "Add Member"
- `add_another` — "Add another member"
- `add_member_description` — "Select a workspace member to add to this project"
- `select_role` — "Select role"
- `default_role` — "Default: Developer"
- `available_title` — "Available Members"
- `no_available` — "All workspace members are already in this project"
- `remove_success` — "Member removed"
- `add_success` — "Member added"
- `bulk_add_success` — "{count} members added"
- `bulk_remove_success` — "{count} members removed"
- `bulk_role_updated` — "Role updated for {count} members"
- `bulk_partial_failure` — "{succeeded} succeeded, {failed} failed"
- `role_updated` — "Role updated"
- `sole_admin_error` — "Cannot demote or remove the only admin"
- `owner_cannot_remove` — "Cannot remove the project owner"
- `owns_agents_error` — "Cannot remove member who owns agents. Reassign their agents first."
- `owner_badge` — "Owner"
- `search_placeholder` — "Search members..."
- `filter_by_role` — "Filter by role"
- `summary_total` — "{count} members"
- `selected_count` — "{count} selected"
- `bulk_actions` — "Bulk Actions"
- `permission_matrix` — "Permission Matrix"
- `view_permissions` — "View role permissions"
- `access_full` — "Full"
- `access_read` — "Read"
- `access_none` — "None"
- `roles.admin` — "Admin"
- `roles.developer` — "Developer"
- `roles.tester` — "Tester"
- `roles.viewer` — "Viewer"

**Files Touched**:

- `apps/studio/src/api/project-members.ts` — **new**
- `apps/studio/src/components/settings/ProjectMembersTab.tsx` — **rewrite**
- `apps/studio/src/components/settings/PermissionMatrixPanel.tsx` — **new**
- `packages/i18n/locales/en/studio.json` — add keys under `settings.members.*`

**Exit Criteria**:

- [ ] Members tab shows real project members fetched from the API
- [ ] Summary bar shows total count + per-role breakdown
- [ ] Search input filters members by name/email
- [ ] Role filter dropdown filters by selected role
- [ ] Admin users see "Add member" button; non-admins do not
- [ ] Add member flow: shows available tenant members, default role is `developer`, "Add another" button for batch
- [ ] Role change: dropdown works (4 roles: admin/developer/tester/viewer), updates via PATCH, reflects immediately
- [ ] Remove member: confirmation dialog with agent-ownership warning, removes via DELETE, removes from list
- [ ] Multi-select: checkboxes on rows, bulk action bar appears with "Change role" + "Remove" when 2+ selected
- [ ] Bulk operations show succeeded/failed breakdown in toast
- [ ] Owner badge displays correctly
- [ ] Permission matrix panel: expandable panel showing role-permission table
- [ ] Loading spinner on initial load; mutation buttons disabled during async ops
- [ ] Error messages display on API failure
- [ ] All new strings use i18n keys (no hardcoded English)
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors

**Test Strategy**:

- Component: Verify render states (loading, empty, populated, error, search, filter, multi-select, bulk) — no API mocking needed if using a test API client adapter

**Rollback**: Revert `ProjectMembersTab.tsx` to the stub version. Delete the API client and PermissionMatrixPanel files. Revert i18n additions.

---

### Phase 4: E2E Tests

**Goal**: Comprehensive E2E tests verifying the full project RBAC management flow via HTTP API.

**Tasks**:

4.1. Create E2E test file `apps/studio/src/__tests__/e2e/project-member-rbac.e2e.test.ts`

**Files Touched**:

- `apps/studio/src/__tests__/e2e/project-member-rbac.e2e.test.ts` — **new**

**Exit Criteria**:

- [ ] All 18 E2E test scenarios below pass
- [ ] Tests use real HTTP API calls — no `vi.mock`, no direct DB access
- [ ] Tests create their own test users, tenants, and projects via API
- [ ] `pnpm test --filter=apps/studio` passes

**Rollback**: Delete the test file.

---

## 4. E2E Test Scenarios

All tests interact via HTTP API only. No mocks. No direct DB access.

### Scenario 1: Project Listing Respects Membership

```
GIVEN tenant T1 with users Alice (OWNER), Bob (MEMBER), Carol (MEMBER)
  AND project P1 owned by Alice
  AND project P2 owned by Alice, with Bob added as developer
  AND project P3 owned by Alice (no members added)
WHEN Bob calls GET /api/projects
THEN Bob sees P2 only (member) — NOT P1 or P3
WHEN Alice calls GET /api/projects
THEN Alice sees P1, P2, P3 (tenant OWNER sees all)
WHEN Carol calls GET /api/projects
THEN Carol sees 0 projects (no membership, not owner)
```

### Scenario 2: Add Member from Tenant Member List

```
GIVEN tenant T1 with users Alice (OWNER) and Bob (MEMBER)
  AND project P1 owned by Alice
WHEN Alice calls POST /api/projects/P1/members { userId: Bob.id, role: "developer" }
THEN response is 201 with member { userId: Bob.id, role: "developer", isOwner: false }
WHEN Alice calls GET /api/projects/P1/members
THEN response contains Alice (admin, isOwner=true) and Bob (developer, isOwner=false)
WHEN Bob calls GET /api/projects
THEN Bob now sees P1 in the list
```

### Scenario 3: Non-Tenant-Member Cannot Be Added

```
GIVEN tenant T1 with user Alice (OWNER)
  AND tenant T2 with user Dave (OWNER)
  AND project P1 in T1 owned by Alice
WHEN Alice calls POST /api/projects/P1/members { userId: Dave.id, role: "developer" }
THEN response is 400 — Dave is not a member of T1
```

### Scenario 4: Role Update and Permission Enforcement

```
GIVEN tenant T1 with users Alice (OWNER), Bob (MEMBER), Carol (MEMBER)
  AND project P1 owned by Alice, Bob is developer
WHEN Alice calls PATCH /api/projects/P1/members/Bob { role: "viewer" }
THEN response is 200 with updated role "viewer"
WHEN Bob calls POST /api/projects/P1/members { userId: Carol.id, role: "viewer" }
THEN response is 403 — viewer cannot manage members
```

### Scenario 5: Remove Member

```
GIVEN tenant T1 with users Alice (OWNER), Bob (developer in P1), Carol (admin in P1)
WHEN Carol calls DELETE /api/projects/P1/members/Bob
THEN response is 200 — Bob removed
WHEN Bob calls GET /api/projects
THEN Bob no longer sees P1
```

### Scenario 6: Cannot Remove Project Owner

```
GIVEN tenant T1 with users Alice (OWNER of P1), Bob (admin in P1)
WHEN Bob calls DELETE /api/projects/P1/members/Alice
THEN response is 400 — cannot remove project owner
```

### Scenario 7: Sole Admin Protection

```
GIVEN tenant T1 with users Alice (OWNER), Bob (MEMBER), Carol (MEMBER)
  AND project P1 owned by Alice
  AND Bob added as admin, Carol added as developer
WHEN Alice removes herself from P1 (she is owner, so this is blocked by owner-removal rule)
THEN response is 400 — cannot remove project owner
WHEN Alice demotes Bob to viewer via PATCH
  AND Bob is now the only non-owner admin? No — Alice is also admin via auto-create
  — Actually: Alice (admin, owner) + Bob (admin) → demote Bob to viewer → Alice remains sole admin
THEN response is 200 — Bob demoted (Alice is still admin, so Bob is not the sole admin)
WHEN Bob (now viewer) tries to demote Alice via PATCH
THEN response is 403 — viewer cannot manage members

— Sole admin protection test (separate setup):
GIVEN project P2 owned by Alice, Bob added as admin
  AND Alice removes her own ProjectMember record (leaving Bob as sole admin)
WHEN Carol (developer in P2) calls PATCH to demote Bob to viewer
THEN response is 403 — developer cannot manage members
WHEN Alice (owner) calls PATCH /api/projects/P2/members/Bob { role: "viewer" }
THEN response is 400 — cannot demote the sole admin
```

### Scenario 8: Cross-Tenant Isolation

```
GIVEN tenant T1 with user Alice, project P1
  AND tenant T2 with user Eve
WHEN Eve calls GET /api/projects/P1/members (with T2 auth context)
THEN response is 404 — project not found (no existence leak)
WHEN Eve calls POST /api/projects/P1/members { userId: Eve.id, role: "admin" }
THEN response is 404
```

### Scenario 9: Available Members Endpoint

```
GIVEN tenant T1 with users Alice, Bob, Carol, Dave
  AND project P1 with Alice (owner/admin) and Bob (developer)
WHEN Alice calls GET /api/projects/P1/members/available
THEN response contains Carol and Dave (not Alice, not Bob)
WHEN Alice adds Carol to P1
  AND Alice calls GET /api/projects/P1/members/available
THEN response contains Dave only
```

### Scenario 10: Project Creation Auto-Creates Admin Membership

```
GIVEN tenant T1 with user Alice (OWNER)
WHEN Alice calls POST /api/projects { name: "New Project" }
THEN project is created
WHEN Alice calls GET /api/projects/:id/members
THEN response contains Alice with role "admin" and isOwner=true
```

### Scenario 11: Non-Admin Member Can Read Members List

```
GIVEN tenant T1 with users Alice (OWNER), Bob (MEMBER)
  AND project P1 owned by Alice, Bob added as viewer
WHEN Bob calls GET /api/projects/P1/members
THEN response is 200 with Alice and Bob in the list
WHEN Bob calls POST /api/projects/P1/members { userId: anyId, role: "viewer" }
THEN response is 403 — viewer cannot manage members
WHEN Bob calls GET /api/projects/P1/members/available
THEN response is 403 — viewer cannot access available members list
```

### Scenario 12: Bulk Add Members

```
GIVEN tenant T1 with users Alice (OWNER), Bob, Carol, Dave, Eve (all MEMBER)
  AND project P1 owned by Alice
WHEN Alice calls POST /api/projects/P1/members/bulk { members: [
    { userId: Bob.id, role: "developer" },
    { userId: Carol.id, role: "tester" },
    { userId: Dave.id, role: "viewer" }
  ]}
THEN response is 200 with succeeded: 3 items, failed: 0 items
WHEN Alice calls GET /api/projects/P1/members
THEN response contains Alice (admin), Bob (developer), Carol (tester), Dave (viewer)
  AND summary.total === 4
  AND summary.byRole === { admin: 1, developer: 1, tester: 1, viewer: 1 }
```

### Scenario 13: Bulk Add with Partial Failure

```
GIVEN tenant T1 with Alice (OWNER), Bob (MEMBER already in P1), Carol (MEMBER)
  AND tenant T2 with user Dave
WHEN Alice calls POST /api/projects/P1/members/bulk { members: [
    { userId: Bob.id, role: "developer" },   — already a member
    { userId: Carol.id, role: "tester" },     — valid
    { userId: Dave.id, role: "viewer" }       — not in tenant T1
  ]}
THEN response is 200 with succeeded: [Carol], failed: [Bob (already member), Dave (not tenant member)]
```

### Scenario 14: Bulk Role Update and Bulk Remove

```
GIVEN project P1 with Alice (admin/owner), Bob (developer), Carol (developer), Dave (viewer)
WHEN Alice calls POST /api/projects/P1/members/bulk-update-role { userIds: [Bob.id, Carol.id], role: "tester" }
THEN response succeeded: [Bob, Carol], both are now tester
WHEN Alice calls POST /api/projects/P1/members/bulk-remove { userIds: [Bob.id, Carol.id, Dave.id] }
THEN response succeeded: [Bob, Carol, Dave], all removed
```

### Scenario 15: Tester Role Permissions

```
GIVEN tenant T1 with Alice (OWNER), Bob (MEMBER)
  AND project P1 owned by Alice, Bob added as tester
WHEN Bob calls GET /api/projects/P1/members
THEN response is 200 — tester can read members list
WHEN Bob calls POST /api/projects/P1/members { userId: anyId, role: "viewer" }
THEN response is 403 — tester cannot manage members
— Note: simulate and analytics permissions are enforced at runtime layer, not tested here
```

### Scenario 16: Permission Matrix Endpoint

```
GIVEN tenant T1 with Alice (OWNER), project P1
WHEN Alice calls GET /api/projects/P1/roles/permissions
THEN response contains 4 roles (admin, developer, tester, viewer)
  AND admin has full access to all modules
  AND developer has full access to Agents/Tools, read for Deployments
  AND tester has read + simulate + analytics
  AND viewer has read-only across all modules
```

### Scenario 17: Member Search and Role Filter

```
GIVEN project P1 with Alice (admin), Bob (developer), Carol (tester), Dave (viewer)
WHEN Alice calls GET /api/projects/P1/members?search=bob
THEN response contains only Bob
WHEN Alice calls GET /api/projects/P1/members?role=developer
THEN response contains only Bob
  AND summary still reflects total counts (all members, not just filtered)
```

### Scenario 18: Deletion Guard — Cannot Remove Member Who Owns Agents

```
GIVEN project P1 with Alice (admin/owner), Bob (developer)
  AND Bob has created an agent "bot-1" in P1 (Bob is createdBy)
WHEN Alice calls DELETE /api/projects/P1/members/Bob
THEN response is 400 — "Cannot remove member who owns agents in this project"
WHEN Bob's agent "bot-1" is deleted or reassigned
  AND Alice calls DELETE /api/projects/P1/members/Bob
THEN response is 200 — Bob removed
```

---

## 5. Wiring Checklist

- [ ] `project-member-repo.ts` imports `ProjectMember`, `User`, `Project` from `@agent-platform/database/models` via dynamic imports
- [ ] `project-member-repo.ts` uses `ensureDb()`, `normalizeId`/`normalizeIds` pattern (matching `project-repo.ts`)
- [ ] `project-member-repo.ts` uses `createLogger('project-member-repo')` for logging
- [ ] `project-member-service.ts` imports from `project-member-repo`, `workspace-repo`, and `project-repo`
- [ ] `project-member-service.ts` uses `createLogger('project-member-service')` for logging
- [ ] `project-member-service.ts` imports `hasPermission` from `@/lib/permission-resolver` (which re-exports from `@agent-platform/shared/rbac`)
- [ ] New API route files created in correct Next.js directory structure (`[id]` and `[userId]` dynamic segments)
- [ ] All API routes use `withOpenAPI` wrapper with Zod schemas for request/response
- [ ] All API routes use `requireTenantAuth` + `requireProjectAccess` for auth
- [ ] `project-service.ts` imports `findUserAccessibleProjects`, `createProjectMember` from `project-member-repo`
- [ ] `project-service.ts` imports `hasPermission` from `@/lib/permission-resolver` (which re-exports from `@agent-platform/shared/rbac`)
- [ ] Frontend API client `project-members.ts` uses `apiFetch` + `handleResponse` from `@/lib/api-client`
- [ ] `ProjectMembersTab.tsx` imports from `@/api/project-members`
- [ ] Audit actions added to `audit-service.ts`: `PROJECT_MEMBER_ADDED`, `PROJECT_MEMBER_REMOVED`, `PROJECT_MEMBER_ROLE_CHANGED`, `PROJECT_MEMBER_BULK_ADDED` (distinct from tenant-level actions)
- [ ] `tester` role added to `PROJECT_ROLE_PERMISSIONS` in `apps/runtime/src/middleware/rbac.ts`
- [ ] Bulk route files at `projects/[id]/members/bulk/route.ts`, `bulk-update-role/route.ts`, `bulk-remove/route.ts` — correct Next.js directory structure
- [ ] Permission matrix route at `projects/[id]/roles/permissions/route.ts`
- [ ] `PROJECT_ROLE_PERMISSIONS` extracted from `apps/runtime/src/middleware/rbac.ts` to `@agent-platform/shared/rbac` (shared package)
- [ ] `PermissionMatrixPanel.tsx` imports `PROJECT_ROLE_PERMISSIONS` from `@agent-platform/shared/rbac` and renders table
- [ ] Bulk endpoints enforce max 50 items via Zod `.max(50)` on arrays
- [ ] `findProjectAgentsByUser` queries `ProjectAgent.find({ projectId, ownerId: userId })` for deletion guard (NOT `createdBy` — field doesn't exist)
- [ ] Member list GET response includes `summary` field with `total` and `byRole` counts
- [ ] Member list GET supports `?search=` and `?role=` query params
- [ ] i18n keys added under `settings.members.*` in `packages/i18n/locales/en/studio.json` (including bulk ops, search, permission matrix)
- [ ] No new models needed — `ProjectMember` already exists and is already in `models/index.ts`
- [ ] Phase 0 backfill function `backfillOwnerProjectMembers()` in `project-member-repo.ts` creates records for all existing project owners

---

## 6. Cross-Phase Concerns

### Database Migrations

None. The `ProjectMember` model and its indexes already exist. No schema changes.

### Feature Flags

None. This completes an existing feature — the RBAC middleware already enforces project membership. Adding the management layer makes it functional.

### Configuration Changes

None. No new env vars or config keys.

### Runtime Cache Invalidation

The runtime's `memberCache` in `apps/runtime/src/repos/project-repo.ts` has a 5-second TTL. When Studio adds/removes a member, the runtime will pick up the change within 5 seconds. No explicit cache invalidation needed — the TTL is short enough.

**Known limitation**: A recently removed member may retain runtime access for up to 5 seconds due to `memberCache` TTL. Acceptable for current scale.

---

## 7. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases (0-4) complete with exit criteria met
- [ ] All 18 E2E test scenarios pass
- [ ] Project listing respects membership for non-admin users
- [ ] Tenant OWNER/ADMIN can still see and manage all projects
- [ ] Project owner always has full access (via `ownerId` RBAC fallback)
- [ ] 4 project roles function correctly: admin (full), developer (broad r/w), tester (view + simulate + analytics), viewer (read-only)
- [ ] Member management API enforces authorization (project admin or tenant admin only)
- [ ] Members can only be added from the tenant member list
- [ ] Bulk operations (add/update-role/remove) work with partial-success pattern
- [ ] Search and role filter work on member list
- [ ] Summary counts display correctly (total + per-role)
- [ ] Permission matrix displays role-permission mapping
- [ ] Deletion guard prevents removing members who own agents
- [ ] Cross-tenant requests return 404 (no project existence leak)
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Runtime RBAC enforcement continues to work with new `tester` role

---

## 8. Open Questions

1. **Pagination for project members list?** — Current design returns all members with search/filter. For MVP this is fine (projects rarely have 100+ members), but may need cursor-based pagination later.
2. **Custom project roles** — v1.0 supports custom role creation with per-module permissions. The `customRoleId` field exists on `ProjectMember` but is unused. Addressed in separate spec: `docs/features/custom-project-roles.md`
3. **Workspace management v1.0 parity** — Default workspace, favorites, search, create from switcher, request access. Addressed in separate spec: `docs/features/workspace-management-v1-parity.md`

---

## 9. Post-Implementation Notes (2026-04-14)

### Phase Completion Status

| Phase   | Description                                      | Status      | Commits                                                        |
| ------- | ------------------------------------------------ | ----------- | -------------------------------------------------------------- |
| Phase 0 | Backfill owner ProjectMember records             | DONE        | Included in ABLP-254 slices                                    |
| Phase 1 | Data layer, repo, listing filter, tester role    | DONE        | ABLP-254 slices 1-6, ABLP-327 (extract RBAC service)           |
| Phase 2 | API layer: member CRUD + authorization           | PARTIAL     | ABLP-327 (core CRUD done, bulk/available/matrix endpoints TBD) |
| Phase 3 | UI layer: members tab rewrite, permission matrix | NOT STARTED | --                                                             |
| Phase 4 | E2E tests                                        | NOT STARTED | --                                                             |

### Deviations from Plan

1. **Route parameter renamed**: Member routes use `[memberId]` instead of `[userId]` as the dynamic segment (e.g., `/api/projects/[id]/members/[memberId]/route.ts`). This avoids ambiguity with the user auth context.
2. **Service extraction**: The project member management logic was extracted into a standalone `ProjectMemberService` class (`project-member-service.ts`) rather than being inlined in route handlers. This was driven by [ABLP-327] to improve testability.
3. **Project access hardened beyond plan**: `requireProjectAccess` was updated to enforce explicit membership -- non-admin tenant members without a `ProjectMember` record now get 404 (previously they could see all same-tenant projects). This was a security improvement from ABLP-327.
4. **Permission centralization**: `PROJECT_ROLE_PERMISSIONS` moved to `packages/shared-auth` (not `packages/shared` as originally planned). The shared-auth package is the correct home since it co-locates with other auth/RBAC primitives.
5. **Custom role CRUD API**: The workspace-scoped role CRUD endpoints (`/api/workspaces/[tenantId]/roles/`) were implemented ahead of the LLD schedule as part of ABLP-254, because they were needed for the custom role resolution pipeline.
6. **Bulk endpoints deferred**: Bulk add, bulk role update, and bulk remove endpoints are not yet implemented. These are lower priority than the core CRUD + custom role resolution pipeline.
7. **User lifecycle management** — Status tracking (active/inactive/locked), auto-lock, unlock, notifications, bulk import. Addressed in separate spec: `docs/features/user-lifecycle-management.md`
