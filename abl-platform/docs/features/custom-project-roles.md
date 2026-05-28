# Feature: Custom Project Roles

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `governance`, `project lifecycle`, `enterprise`
**Package(s)**: `packages/database`, `packages/shared-auth`, `apps/runtime`, `apps/studio`
**Owner(s)**: Platform RBAC team
**Testing Guide**: `../testing/custom-project-roles.md`
**Last Updated**: 2026-04-16

---

## 1. Introduction / Overview

### Problem Statement

The platform now has the underlying custom-role infrastructure, shared permission registry, runtime enforcement, project-member APIs, and a workspace-level custom-role CRUD page. What remains fragmented is the canonical documentation and the end-user assignment story: role definitions live in one surface, project membership management lives in another, and older docs still describe outdated role names and flows. Tenant admins who need fine-grained access control need one accurate source of truth for the built-in project roles, the `custom` membership model, and the remaining gaps.

v1.0 product docs define custom role creation with per-module permission configuration (Full/Custom/View/No Access), role editing, duplication, and deletion. The canonical project role map now lives in `packages/shared-auth/src/rbac/role-permissions.ts` and includes 4 built-in project roles: `admin`, `developer`, `tester`, and `viewer`.

### Goal Statement

Provide a tenant-scoped custom role management surface (API + UI) that allows workspace admins to define roles with granular per-module permissions, assign them to project members through the `role: 'custom'` + `customRoleId` membership model, and have those permissions enforced by the runtime and Studio permission resolvers -- all without modifying the existing `RoleDefinition` data model.

### Summary

Custom Project Roles gives workspace admins a tenant-scoped CRUD surface for role definitions under `/api/workspaces/:tenantId/roles` and wires those roles into project-scoped authorization. Built-in project roles are still available through `PROJECT_ROLE_PERMISSIONS`, while custom project memberships use `ProjectMember.role === 'custom'` plus a tenant-scoped `customRoleId`. The workspace-level custom-role page is implemented in Studio today. Built-in project member management is also implemented in the Project Members UI, including a project-scoped available-members endpoint so project owners and project admins can add existing workspace members without requiring workspace-admin access. Project-member custom-role assignment in the Project Members UI is still pending and remains API-only for now.

### Canonical Project Role Model

This feature spec is the canonical source for project-scoped role names and custom-role resolution.

Built-in project roles are defined by `PROJECT_ROLE_PERMISSIONS` in `packages/shared-auth/src/rbac/role-permissions.ts`:

| Role        | Primary use                 | Typical capabilities                                                                    |
| ----------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `admin`     | Full project control        | Manage project members/settings and all project-scoped resources                        |
| `developer` | Build and operate           | Create/update agents, tools, workflows, sessions, imports, and exports                  |
| `tester`    | Verification and analysis   | Read project resources, create/read sessions, run simulations, view analytics           |
| `viewer`    | Read-only project access    | Read project resources, sessions, and exports                                           |
| `custom`    | Tenant-defined project RBAC | Permission set comes from a tenant-scoped `RoleDefinition` referenced by `customRoleId` |

Notes:

- `ProjectMember.role` is one of the built-in roles above or `'custom'`. `customRoleId` is required only when `role === 'custom'`.
- Project member add/update flows source users from existing workspace members; they do not send a new invitation email.
- Project permission resolution order is: tenant-wide project authority (`project:*`), project owner, explicit project member (built-in or `custom`), then concealed `404` for non-members.

---

## 2. Scope

### Goals

- Expose a tenant-scoped CRUD API for custom role definitions with per-module permission configuration
- Enable assignment of custom roles to project members via `ProjectMember.role === 'custom'` plus `customRoleId`
- Keep custom role resolution wired into the shared/runtime project permission evaluators that sit alongside `PROJECT_ROLE_PERMISSIONS`
- Provide a role management UI in Studio for creating, editing, duplicating, and deleting custom roles
- Enforce constraints: system roles are immutable, assigned roles cannot be deleted, role names are unique per tenant

### Non-Goals (Out of Scope)

- Modifying the `RoleDefinition` data model (no new fields such as `projectId` or `type` -- the model is tenant-scoped by design)
- Tenant-level custom roles for workspace membership (separate concern -- workspace admin roles use `TenantMember.customRoleId` which is a different management surface)
- Tool-level or agent-level custom roles (separate product area)
- SCIM/AD role sync
- Real-time permission cache invalidation (permissions propagate within the existing 60-second cache TTL)
- Adding more built-in project roles beyond `admin`, `developer`, `tester`, and `viewer`

---

## 3. User Stories

1. As a **workspace admin**, I want to create custom roles with specific per-module permissions so that I can grant project members exactly the access they need instead of choosing between the broad built-in project roles.
2. As a **workspace admin**, I want to duplicate a built-in role and customize it so that I can start from a reasonable baseline instead of building permissions from scratch.
3. As a **workspace admin**, I want to prevent deletion of roles assigned to active project members so that users do not suddenly lose access.
4. As a **project admin**, I want to assign a custom role to a project member so that their permissions reflect the granular role definition instead of a broad built-in role.
5. As a **project member** with a custom role, I want my permissions to update within 60 seconds when an admin changes my role definition so that I do not need to log out and back in.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a tenant-scoped CRUD API for custom role definitions at `/api/workspaces/:tenantId/roles` supporting create, read (list and detail), update, and delete operations.
2. **FR-2**: The system must organize permissions by module (Agents, Tools, Versions, Deployments, Channels, Sessions, Workflows, Credentials, Lookup Data, Attachments, Environment Variables) with per-module access levels: Full (all operations), Custom (selected operations), View (read only), and No Access.
3. **FR-3**: The system must support a duplicate operation (`POST /api/workspaces/:tenantId/roles/:roleId/duplicate`) that creates an editable custom copy of any role (system or custom).
4. **FR-4**: The system must allow assigning a custom role to a project member by setting `ProjectMember.role` to `'custom'` and storing a valid tenant-scoped `customRoleId` on the same record.
5. **FR-5**: The system must resolve custom role permissions through the shared/runtime project permission path. When `ProjectMember.role === 'custom'`, the evaluator must load the referenced `RoleDefinition`, walk the parent chain via `resolveRolePermissions`, sanitize the result through the custom-role allowlist, and use those permissions instead of `PROJECT_ROLE_PERMISSIONS`.
6. **FR-6**: The system must propagate custom role permission changes to all assigned members within the cache TTL (default 60 seconds) without requiring logout or session restart. Both resolvers cache with `CACHE_TTL_MS = 60_000`: `resolveEffectivePermissions()` at `apps/runtime/src/services/permission-resolution.ts` (line 21) and `resolveStudioPermissions()` at `apps/studio/src/lib/permission-resolver.ts` (line 35).
7. **FR-7**: The system must prevent editing or deleting system roles (`isSystem === true`). When deleting a custom role, the system must clear affected `ProjectMember.customRoleId` values and reset those memberships to the safe built-in fallback role `viewer` before deleting the `RoleDefinition`.
8. **FR-8**: The system must enforce role name uniqueness within a tenant, as guaranteed by the existing unique index `{ tenantId: 1, name: 1 }` on the `role_definitions` collection (`packages/database/src/models/role-definition.model.ts`, line 53).
9. **FR-9**: The system must validate that a `customRoleId` references a valid `RoleDefinition` within the same tenant before accepting the assignment.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                     |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Custom roles assigned at the project member level affect what members can do in a project |
| Agent lifecycle            | SECONDARY    | Agent CRUD permissions controlled by role; custom roles can restrict/grant agent ops      |
| Customer experience        | NONE         | End-user (customer) experience is unaffected; this is admin-facing                        |
| Integrations / channels    | NONE         | Channel configuration permissions exist but are controlled by the role, not the feature   |
| Observability / tracing    | NONE         | No trace events emitted by role management itself                                         |
| Governance / controls      | PRIMARY      | Core governance feature -- defines who can do what within a project                       |
| Enterprise / compliance    | PRIMARY      | Custom roles are a v1.0 enterprise requirement for fine-grained access control            |
| Admin / operator workflows | PRIMARY      | Workspace admins create and manage roles; project admins assign them                      |

### Related Feature Integration Matrix

| Related Feature                | Relationship Type | Why It Matters                                                                                      | Key Touchpoints                                                                   | Current State                         |
| ------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
| Project RBAC Management Layer  | depends on        | Provides the project member CRUD API that custom roles extend with `customRoleId` assignment        | `POST/PATCH /api/projects/[id]/members`, `evaluateProjectPermission` in `rbac.ts` | Implemented (core CRUD + access)      |
| Workspace Sharing              | extends           | Custom roles are tenant-scoped; workspace sharing determines which users exist to receive roles     | `TenantMember` model, workspace member list                                       | Implemented                           |
| Permission Resolution (Shared) | shares data with  | `evaluateProjectPermission()` centralized in `shared-auth/rbac`; walks custom role permissions      | `packages/shared-auth/src/rbac/role-permissions.ts`                               | Implemented (shared-auth centralized) |
| Runtime RBAC Middleware        | configured by     | Runtime consults `customRoleId` via `resolveProjectCustomRolePermissions` when `role === 'custom'`  | `apps/runtime/src/middleware/rbac.ts`                                             | Implemented (custom role wired)       |
| Tenant Bootstrap (Seed)        | shares data with  | System roles seeded via `seedTenantBootstrapDefaults()` are the base roles that custom roles extend | `packages/database/src/seed/tenant-bootstrap.ts`                                  | Implemented                           |

---

## 6. Design Considerations (Optional)

### UI Layout

- Role management page accessible from workspace settings (not project settings, since roles are tenant-scoped)
- Table view: name, type badge (System / Custom), member count (across all projects), description, created by, last updated
- Create/edit form: name, description, parent role dropdown (optional), per-module permission matrix with Full/Custom/View/No Access toggles
- System roles shown with a locked icon and disabled edit controls; a "Duplicate" button creates an editable custom copy
- Delete button on custom roles shows a confirmation dialog; blocked with an error message if any project members are assigned

### Accessibility

- Permission matrix must be keyboard-navigable
- Role type badges must have appropriate ARIA labels

---

## 7. Technical Considerations (Optional)

### Resolved: `BUILTIN_ROLE_PERMISSIONS` vs `SYSTEM_ROLES` divergence

**Status: RESOLVED.** The `TENANT_ROLE_PERMISSIONS` in `packages/shared-auth/src/rbac/role-permissions.ts` is now the single source of truth, aligned with `SYSTEM_ROLES`. A sync test verifies parity. Both runtime and Studio import from `shared-auth`.

### Resolved: `evaluateProjectPermission` ignores `customRoleId`

**Status: RESOLVED.** The runtime's `evaluateProjectPermission` path now checks `member.role`. When it is `'custom'`, it calls `resolveProjectCustomRolePermissions(tenantId, customRoleId)` to load the `RoleDefinition` from MongoDB (with bounded LRU cache + TTL). The resolved permissions are sanitized through the `VALID_CUSTOM_ROLE_PERMISSIONS` allowlist. Built-in roles still resolve from `PROJECT_ROLE_PERMISSIONS`.

### Tenant-scoped model, project-level assignment

The `RoleDefinition` model has no `projectId` field -- it is tenant-scoped with a unique index on `{ tenantId, name }`. This is intentional: custom roles are defined once at the tenant level and can be assigned to members across any project within that tenant. The API routes are therefore tenant-scoped (`/api/workspaces/:tenantId/roles`), not project-scoped. Assignment happens at the project level by updating a project membership to `role: 'custom'` with a valid `customRoleId`.

### Cache behavior

Permission changes propagate within 60 seconds (the cache TTL in both resolvers). Active cache invalidation on role update is not in scope for v1 but could be added later via Redis pub/sub to call `clearPermissionCache()` / `clearStudioPermissionCache()`.

### Integration with existing auth

All role management endpoints must use `createUnifiedAuthMiddleware` / `requireAuth`. Role management operations (create, update, delete) require tenant OWNER or ADMIN permissions. Read operations require tenant membership.

---

## 8. How to Consume

### Studio UI

- **Settings > Team > Custom Roles**: List tenant-scoped custom roles and create, edit, or delete them. The current page manages custom roles only; system-role visibility and duplicate-from-system-role flows are still pending.
- **Project Settings > Members**: Built-in role management is implemented. A dedicated custom-role picker in the project members UI is still pending; today custom-role assignment is available through the project member API.

### API (Runtime)

Runtime enforces custom role permissions via the `evaluateProjectPermission` path. When a `ProjectMember` has `role: 'custom'`, the runtime loads the referenced `RoleDefinition` and resolves permissions through `resolveProjectCustomRolePermissions`. Non-members are concealed with 404 (not 403) to prevent existence leaks.

| Method | Path | Purpose                                  |
| ------ | ---- | ---------------------------------------- |
| N/A    | N/A  | Role management is not hosted in runtime |

### API (Studio) -- Custom Role CRUD

| Method | Path                                                | Purpose                                                       | Status      |
| ------ | --------------------------------------------------- | ------------------------------------------------------------- | ----------- |
| POST   | `/api/workspaces/:tenantId/roles`                   | Create a custom role definition                               | Implemented |
| GET    | `/api/workspaces/:tenantId/roles`                   | List custom roles for the tenant                              | Implemented |
| GET    | `/api/workspaces/:tenantId/roles/:roleId`           | Get role details (system or custom)                           | Implemented |
| PATCH  | `/api/workspaces/:tenantId/roles/:roleId`           | Update a custom role (name, description, permissions)         | Implemented |
| DELETE | `/api/workspaces/:tenantId/roles/:roleId`           | Delete a custom role and cascade affected members to `viewer` | Implemented |
| POST   | `/api/workspaces/:tenantId/roles/:roleId/duplicate` | Duplicate a role into a new custom role                       | Not started |

### API (Studio) -- Project Member Management

| Method | Path                                         | Purpose                                     | Status      |
| ------ | -------------------------------------------- | ------------------------------------------- | ----------- |
| GET    | `/api/projects/:id/members`                  | List project members                        | Implemented |
| POST   | `/api/projects/:id/members`                  | Add a project member                        | Implemented |
| PATCH  | `/api/projects/:id/members/:memberId`        | Update member role / custom role            | Implemented |
| DELETE | `/api/projects/:id/members/:memberId`        | Remove a project member                     | Implemented |
| GET    | `/api/projects/:id/members/available`        | Active workspace members not yet in project | Implemented |
| POST   | `/api/projects/:id/members/bulk`             | Bulk add members                            | Not started |
| POST   | `/api/projects/:id/members/bulk-update-role` | Bulk update roles                           | Not started |
| POST   | `/api/projects/:id/members/bulk-remove`      | Bulk remove members                         | Not started |
| GET    | `/api/projects/:id/roles/permissions`        | Permission matrix for project roles         | Not started |

### Admin Portal

Custom role management is workspace-admin-facing via Studio, not platform-admin-facing. No admin portal endpoints needed.

### Channel / SDK / Voice / A2A / MCP Integration

This feature is not channel-aware. Custom roles affect permission enforcement at the API layer; channel integrations are unaffected as they use SDK session tokens with pre-resolved permissions.

---

## 9. Data Model

### Collections / Tables

```text
Collection: role_definitions (EXISTING -- no schema changes)
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - name: string (required)
  - description: string | null
  - isSystem: boolean (default: false)
  - permissions: string[] (e.g. ['agent:read', 'agent:update', 'tool:*'])
  - parentRoleId: string | null (references another RoleDefinition._id)
  - createdBy: string (required)
  - _v: number (default: 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { tenantId: 1, name: 1 } UNIQUE
  - { tenantId: 1 }
Plugins:
  - tenantIsolationPlugin (enforces tenantId on all queries)
  - auditTrailPlugin
Source: packages/database/src/models/role-definition.model.ts
```

```text
Collection: project_members (UPDATED -- role enum expanded, schema guards added)
Fields:
  - _id: string (UUIDv7)
  - projectId: string (required)
  - userId: string (required)
  - role: string (required -- enum: admin, developer, tester, viewer, custom)
  - customRoleId: string | null (default: null -- references RoleDefinition._id)
      Schema guard: required when role="custom", must be null otherwise
  - _v: number (default: 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { projectId: 1, userId: 1 } UNIQUE
  - { userId: 1 }
  - { customRoleId: 1 } SPARSE
Source: packages/database/src/models/project-member.model.ts
```

```text
Collection: resource_permissions (EXISTING -- no schema changes)
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required)
  - userId: string (required)
  - resourceType: string (required)
  - resourceId: string (required)
  - operations: string[] (e.g. ['read', 'update'])
  - grantedBy: string (required)
  - expiresAt: Date | null (for time-limited grants)
  - _v: number (default: 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { tenantId: 1, userId: 1, resourceType: 1, resourceId: 1 } UNIQUE
  - { tenantId: 1, userId: 1 }
  - { tenantId: 1, resourceType: 1, resourceId: 1 }
  - { userId: 1 }
Source: packages/database/src/models/resource-permission.model.ts
```

### Key Relationships

- `RoleDefinition.parentRoleId` references another `RoleDefinition._id` within the same tenant (inheritance chain)
- `ProjectMember.customRoleId` references `RoleDefinition._id` (must be in the same tenant)
- `TenantMember.customRoleId` references `RoleDefinition._id` (same tenant -- but tenant-level custom role assignment is out of scope for this feature)
- `ResourcePermission` grants are merged on top of role permissions by `mergeResourcePermissions()` in `packages/shared/src/rbac/permission-resolver.ts` (lines 169-185)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                     | Purpose                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-auth/src/rbac/role-permissions.ts`      | `PROJECT_ROLE_PERMISSIONS` (4 built-in project roles), `PERMISSION_REGISTRY`, `evaluateProjectPermission()`, `validateCustomRolePermissions()`, custom-role ceiling enforcement |
| `packages/shared-auth/src/rbac/permission-resolver.ts`   | `hasPermission()` with wildcard matching                                                                                                                                        |
| `apps/runtime/src/services/permission-resolution.ts`     | `resolveProjectCustomRolePermissions()` -- loads `RoleDefinition` from DB, bounded LRU cache with TTL, sanitizes permissions through allowlist                                  |
| `apps/studio/src/lib/permission-resolver.ts`             | `resolveStudioPermissions()` -- Studio-side permission resolution with cache                                                                                                    |
| `apps/studio/src/lib/project-access.ts`                  | `requireProjectAccess()` -- enforces explicit project membership (no tenant-wide access for non-admins). Returns 404 for non-members.                                           |
| `apps/studio/src/lib/require-project-member-or-admin.ts` | Guards for project member management routes -- requires admin role, ownership, or tenant admin                                                                                  |
| `packages/database/src/models/project-member.model.ts`   | `ProjectMember` schema with `role: 'custom'` support, `customRoleId` pre-validate/pre-update guards, sparse index on `customRoleId`                                             |
| `packages/database/src/constants/system-roles.ts`        | `SYSTEM_ROLES` definitions -- 5 tenant roles: OWNER, ADMIN, OPERATOR, MEMBER, VIEWER                                                                                            |

### Routes / Handlers

| File                                                                                            | Purpose                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/middleware/rbac.ts`                                                           | `evaluateProjectPermission` wired to consult `customRoleId` via `resolveProjectCustomRolePermissions`. Re-exports `PROJECT_ROLE_PERMISSIONS` from shared-auth. |
| `apps/studio/src/app/api/workspaces/[tenantId]/roles/route.ts`                                  | Tenant-scoped role list (GET) + create (POST)                                                                                                                  |
| `apps/studio/src/app/api/workspaces/[tenantId]/roles/[roleId]/route.ts`                         | Single role GET/PATCH/DELETE                                                                                                                                   |
| `apps/studio/src/app/api/projects/[id]/members/route.ts`                                        | Project member list (GET) + add member (POST) + caller manage-members capability flag                                                                          |
| `apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts`                             | Member update (PATCH) + remove (DELETE)                                                                                                                        |
| `apps/studio/src/app/api/projects/[id]/members/available/route.ts`                              | Project-scoped list of addable workspace members for project owners/admins                                                                                     |
| (NOT STARTED) `apps/studio/src/app/api/workspaces/[tenantId]/roles/[roleId]/duplicate/route.ts` | Role duplicate endpoint                                                                                                                                        |
| (NOT STARTED) `apps/studio/src/app/api/projects/[id]/members/bulk/route.ts`                     | Bulk add members                                                                                                                                               |

### Services / Repositories

| File                                                 | Purpose                                                                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/services/project-member-service.ts` | Business logic: add/remove/update member, `assertCallerCanManageMembers`, `canActorManageMembers`, `listAvailableProjectMembers`, custom role validation, audit logging |
| `apps/studio/src/repos/project-member-repo.ts`       | ProjectMember CRUD, `findCustomRoleDefinition`, user-enriched member queries                                                                                            |
| `apps/studio/src/services/project-service.ts`        | `getUserProjectsWithCounts()` -- membership-filtered project listing                                                                                                    |
| `apps/studio/src/repos/project-repo.ts`              | Membership-based project query support                                                                                                                                  |

### UI Components

| File                                                        | Purpose                                                                                                                                         | Status                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `apps/studio/src/components/admin/CustomRolesPage.tsx`      | Workspace-level custom role list + create/edit/delete surface                                                                                   | Implemented           |
| `apps/studio/src/components/settings/ProjectMembersTab.tsx` | Built-in project member role management, project-scoped available-member picker, and manage-members UI gating; custom-role picker still pending | Partially implemented |

### Jobs / Workers / Background Processes

| File | Purpose                                      |
| ---- | -------------------------------------------- |
| N/A  | No background jobs required for this feature |

### Tests

| File                                                                     | Type        | Coverage Focus                                                                            |
| ------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/project-member-service.test.ts`               | Unit        | Business rule tests for add/remove/update member, custom role validation                  |
| `apps/studio/src/__tests__/api-routes/api-project-members.test.ts`       | Unit        | Route contract tests for member management endpoints                                      |
| `apps/studio/src/__tests__/components/project-members-tab-rbac.test.tsx` | Unit        | Project member UI regressions: manage-members gating and project-scoped candidate loading |
| `apps/studio/src/__tests__/api-routes/api-custom-roles.test.ts`          | Unit        | Custom role CRUD behavioral tests with real Zod + permission validation                   |
| `apps/studio/src/__tests__/api-routes/route-handler-rbac.test.ts`        | Unit        | RBAC integration in route handler, permission enforcement, rate limiting                  |
| `apps/studio/src/__tests__/project-access.test.ts`                       | Unit        | Project access checks: membership, owner, tenant admin paths                              |
| `apps/studio/src/__tests__/project-services.test.ts`                     | Unit        | Project listing membership filter, tenant-wide access checks                              |
| `apps/runtime/src/__tests__/auth/middleware/rbac.test.ts`                | Unit        | Custom project role resolution, tester role, non-member concealment                       |
| `apps/runtime/src/__tests__/services/permission-resolution.test.ts`      | Integration | Custom role permission resolution, cache behavior, cache invalidation                     |
| (NOT STARTED)                                                            | E2E         | Full role CRUD + assignment + permission enforcement via HTTP API                         |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                                                                                  |
| -------- | ------- | -------------------------------------------------------------------------------------------- |
| N/A      | N/A     | No new environment variables required. Cache TTL is hardcoded at 60,000ms in both resolvers. |

### Runtime Configuration

No feature flags needed. Custom roles use the existing `RoleDefinition` model and `customRoleId` field -- activation is controlled by whether the management API exists.

### DSL / Agent IR / Schema

N/A -- custom roles do not affect agent DSL, compiler IR, or OpenAPI schema.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Every role CRUD operation must include `tenantId` from the authenticated user's context. The `tenantIsolationPlugin` on `RoleDefinition` enforces this at the query level. Cross-tenant access must return 404.        |
| Project isolation | Roles are tenant-scoped (no `projectId` on `RoleDefinition`). All projects within a tenant share the same custom role pool. This is by design -- roles are defined once and assigned per-project.                      |
| User isolation    | Role management operations (create, update, delete) require tenant OWNER or ADMIN role. Read operations require tenant membership. The `createdBy` field tracks authorship for audit but does not restrict visibility. |

### Security & Compliance

- All role management endpoints must use `createUnifiedAuthMiddleware` / `requireAuth` -- no custom JWT verification
- Role management mutations (create/update/delete) require `tenant:manage_members` or `*:*` permission
- The `auditTrailPlugin` on `RoleDefinition` provides automatic change tracking
- Permission strings are validated against a known set of `{resourceType}:{operation}` patterns to prevent injection of arbitrary permission strings
- Deleting a role cascades: set `customRoleId = null` on affected `ProjectMember` records, falling back to their built-in `role`

### Performance & Scalability

- Permission resolution is cached for 60 seconds in both the runtime (`CACHE_TTL_MS = 60_000` at `permission-resolution.ts` line 21) and Studio (`CACHE_TTL_MS = 60_000` at `permission-resolver.ts` line 35)
- Studio cache has a max size of 100 entries with LRU eviction (`CACHE_MAX_SIZE = 100` at line 36)
- Role definitions are loaded per-tenant (typically 5 system roles + a small number of custom roles); no pagination needed for the role list
- The `resolveRolePermissions()` parent-chain walk includes a cycle guard (`visited` set) to prevent infinite loops

### Reliability & Failure Modes

- If `RoleDefinition` lookup fails for a `customRoleId`, the runtime falls back to `BUILTIN_ROLE_PERMISSIONS` for the built-in `role` field (existing behavior in `resolveEffectivePermissions()` at line 124-127)
- If the Studio resolver fails, it returns empty permissions (deny by default) as implemented in the catch block at `permission-resolver.ts` line 147-151
- Role deletion with assigned members is blocked at the API layer (409 Conflict), not the database layer

### Observability

- Role CRUD operations logged via the standard `createLogger('custom-roles')` pattern
- The `auditTrailPlugin` on `RoleDefinition` records all mutations for compliance audit
- Permission resolution cache hit/miss rates can be monitored through the existing cache infrastructure

### Data Lifecycle

- Custom role definitions persist indefinitely (no TTL)
- When a custom role is deleted, all `ProjectMember` records referencing it via `customRoleId` are reset to `{ role: 'viewer', customRoleId: null }`
- System roles (`isSystem === true`) cannot be deleted and are re-seeded on tenant bootstrap via `seedTenantBootstrapDefaults()` (idempotent upserts)

---

## 13. Delivery Plan / Work Breakdown

1. **Prerequisite: Resolve `BUILTIN_ROLE_PERMISSIONS` vs `SYSTEM_ROLES` divergence**
   1.1 Audit the 7 missing permissions in `BUILTIN_ROLE_PERMISSIONS` vs `SYSTEM_ROLES`
   1.2 Align the runtime hardcoded map or document accepted differences
   1.3 Add test coverage for permission parity between the two maps

2. **API Layer: Tenant-scoped role CRUD**
   2.1 Create `POST /api/workspaces/:tenantId/roles` -- create custom role with validation
   2.2 Create `GET /api/workspaces/:tenantId/roles` -- list system + custom roles
   2.3 Create `GET /api/workspaces/:tenantId/roles/:roleId` -- get role with resolved permissions
   2.4 Create `PATCH /api/workspaces/:tenantId/roles/:roleId` -- update custom role (reject system roles)
   2.5 Create `DELETE /api/workspaces/:tenantId/roles/:roleId` -- delete custom role (reject if assigned)
   2.6 Create `POST /api/workspaces/:tenantId/roles/:roleId/duplicate` -- duplicate any role

3. **Permission Resolution Wiring**
   3.1 Update `evaluateProjectPermission` in `rbac.ts` to read `member.customRoleId` and resolve via `RoleDefinition`
   3.2 Add `customRoleId` to the project member update API (`PATCH /api/projects/:id/members/:userId`)
   3.3 Validate `customRoleId` references a valid `RoleDefinition` in the same tenant on assignment

4. **UI: Role Management Page**
   4.1 Role list view in workspace settings (table with system/custom badge, member count, actions)
   4.2 Create/edit form with per-module permission matrix (Full/Custom/View/No Access)
   4.3 Duplicate button and delete confirmation dialog with member-count guard
   4.4 Custom role dropdown in project member editor

5. **Testing**
   5.1 E2E: role CRUD, assignment, permission enforcement, constraint enforcement
   5.2 Integration: permission resolution with custom roles, cache TTL behavior
   5.3 Unit: permission matrix validation, constraint checks

---

## 14. Success Metrics

| Metric                                    | Baseline | Target                | How Measured                                                          |
| ----------------------------------------- | -------- | --------------------- | --------------------------------------------------------------------- |
| Custom roles created per tenant           | 0        | >= 1 (active tenants) | MongoDB query: `RoleDefinition.count({ isSystem: false })` per tenant |
| Project members with custom role assigned | 0        | >= 10%                | `ProjectMember.count({ customRoleId: { $ne: null } })` / total        |
| Permission-related support tickets        | Baseline | -30%                  | Support ticket triage by category                                     |
| Role management API error rate            | N/A      | < 0.1%                | Runtime metrics / error logs                                          |

---

## 15. Open Questions

1. Should role deletion keep the current `viewer` fallback, or should a future version require explicit reassignment before deletion?
2. Should the project members UI expose custom-role assignment inline, or should assignment stay API-first until bulk member operations land?
3. Should the workspace custom-role page expose parent-role selection and duplicate-from-system-role flows, or keep the current flat permission-matrix editor until a later iteration?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                         | Severity | Status    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | `evaluateProjectPermission` in `rbac.ts` uses only `PROJECT_ROLE_PERMISSIONS[role]` and ignores `member.customRoleId`.                              | High     | Mitigated |
| GAP-002 | `BUILTIN_ROLE_PERMISSIONS` diverges from `SYSTEM_ROLES`. Custom role fallback behavior depends on which map is consulted.                           | High     | Mitigated |
| GAP-003 | Permission cache (60s TTL) means role changes are not instant. Users may see stale permissions for up to 60 seconds after a role update.            | Medium   | Open      |
| GAP-004 | `ProjectMember` model lacks a `tenantId` field -- cross-tenant validation of `customRoleId` requires joining through the project to get `tenantId`. | Medium   | Open      |
| GAP-005 | The `tester` built-in role referenced in v1.0 product docs does not exist in `PROJECT_ROLE_PERMISSIONS`.                                            | Low      | Mitigated |
| GAP-006 | Role duplicate endpoint (`POST .../duplicate`) not yet implemented.                                                                                 | Medium   | Open      |
| GAP-007 | Bulk member operations (bulk add, bulk role update, bulk remove) not yet implemented.                                                               | Medium   | Open      |
| GAP-008 | Project Members UI still lacks custom-role assignment and permission-matrix surfacing for custom roles.                                             | Medium   | Open      |
| GAP-009 | Available members endpoint (`GET /api/projects/:id/members/available`) not yet implemented.                                                         | Low      | Mitigated |
| GAP-010 | Permission matrix endpoint (`GET /api/projects/:id/roles/permissions`) not yet implemented.                                                         | Low      | Open      |
| GAP-011 | E2E tests for role CRUD, assignment, and permission enforcement not yet written. Only unit and route-contract tests exist.                          | High     | Open      |

**Mitigated details:**

- **GAP-001**: Runtime now checks `member.customRoleId` via `resolveProjectCustomRolePermissions` when `role === 'custom'`. Centralized `evaluateProjectPermission` in `shared-auth`.
- **GAP-002**: `TENANT_ROLE_PERMISSIONS` in `shared-auth/rbac/role-permissions.ts` is the single source of truth, aligned with `SYSTEM_ROLES`. A sync test verifies parity.
- **GAP-005**: `tester` role added to `PROJECT_ROLE_PERMISSIONS` in `shared-auth/rbac/role-permissions.ts` with simulate + analytics + read permissions. Tests cover tester boundaries.
- **GAP-009**: Studio now serves `GET /api/projects/:id/members/available` through the project-scoped member-management service, allowing project owners and project admins to add existing workspace members without calling the workspace-admin members API.

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                           | Coverage Type | Status     | Test File / Note                                                                                                      |
| --- | ---------------------------------------------------------------------------------- | ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Create custom role with specific permissions, assign to member, verify enforcement | E2E           | NOT TESTED | E2E test not yet written. Unit coverage in `api-custom-roles.test.ts` and `project-member-service.test.ts`            |
| 2   | Duplicate system role into custom role, modify permissions, assign                 | E2E           | NOT TESTED | Duplicate endpoint not yet implemented                                                                                |
| 3   | Cannot delete role assigned to active members                                      | Unit          | PARTIAL    | `api-custom-roles.test.ts` tests delete-blocked-by-members via in-memory DB mock                                      |
| 4   | Permission inheritance via parentRoleId                                            | Integration   | NOT TESTED | No dedicated test for parent chain resolution                                                                         |
| 5   | Permission update propagates within cache TTL                                      | Unit          | PARTIAL    | `permission-resolution.test.ts` tests cache + `clearPermissionCache` + refresh for project custom roles               |
| 6   | Cannot edit system roles                                                           | Unit          | PARTIAL    | `api-custom-roles.test.ts` tests system role immutability via in-memory DB mock                                       |
| 7   | Cross-tenant role isolation                                                        | Unit          | PARTIAL    | `api-custom-roles.test.ts` tests tenant mismatch returns 404                                                          |
| 8   | Custom role in permission matrix display                                           | E2E           | NOT TESTED | Permission matrix endpoint not yet implemented                                                                        |
| 9   | Clearing customRoleId falls back to built-in role                                  | Unit          | PARTIAL    | `rbac.test.ts` tests built-in role fallback. `permission-resolution.test.ts` tests stale custom role fallback         |
| 10  | Invalid customRoleId rejected on assignment                                        | Unit          | TESTED     | `project-member-service.test.ts` tests custom role validation (requires existing role definition in same tenant)      |
| 11  | Project access requires explicit membership                                        | Unit          | TESTED     | `project-access.test.ts` verifies non-admin non-member gets 404                                                       |
| 12  | Project listing filtered by membership                                             | Unit          | TESTED     | `project-services.test.ts` verifies membership-filtered listing                                                       |
| 13  | Tester role permission boundaries                                                  | Unit          | TESTED     | `rbac.test.ts` tests tester role allow (analytics:read) and deny (agent:create) paths                                 |
| 14  | Custom role permission resolution at runtime                                       | Unit          | TESTED     | `rbac.test.ts` tests custom project role resolution through shared evaluator                                          |
| 15  | Non-member concealment (404 not 403)                                               | Unit          | TESTED     | `rbac.test.ts` and `project-access.test.ts` verify 404 response for non-members                                       |
| 16  | Project member CRUD route contracts                                                | Unit          | TESTED     | `api-project-members.test.ts` covers list/add/update/remove plus the project-scoped `/members/available` route        |
| 17  | Route handler RBAC permission enforcement                                          | Unit          | TESTED     | `route-handler-rbac.test.ts` covers permission checks, wildcard matching, rate limiting                               |
| 18  | Project member UI only shows manage controls to authorized actors                  | Unit          | TESTED     | `project-members-tab-rbac.test.tsx` covers hidden controls for read-only members and project-scoped candidate loading |

### Testing Notes

Unit and route-contract tests provide good coverage of business rules and API contracts. **E2E tests are the critical gap** -- no tests exercise the full middleware chain (auth + project access + member service) via real HTTP API calls. Integration tests for the runtime permission resolution pipeline exist but only cover the cache layer with real MongoDB, not the full HTTP flow.

> Full testing details: `../testing/custom-project-roles.md`

---

## 18. References

- Design docs: `docs/plans/2026-04-09-project-rbac-management-impl-plan.md` (Project RBAC Management LLD -- dependency)
- v1.0 product docs: Role Management -- https://docs.kore.ai/agent-platform/administration/role-management
- Source: `packages/database/src/models/role-definition.model.ts` (RoleDefinition model)
- Source: `packages/database/src/models/project-member.model.ts` (ProjectMember model with role="custom" + customRoleId guards)
- Source: `packages/database/src/models/tenant-member.model.ts` (TenantMember model with customRoleId)
- Source: `packages/database/src/constants/system-roles.ts` (SYSTEM_ROLES definitions)
- Source: `packages/database/src/seed/tenant-bootstrap.ts` (seedTenantBootstrapDefaults)
- Source: `packages/shared-auth/src/rbac/role-permissions.ts` (PROJECT_ROLE_PERMISSIONS, evaluateProjectPermission, PERMISSION_REGISTRY, validateCustomRolePermissions)
- Source: `packages/shared-auth/src/rbac/permission-resolver.ts` (hasPermission with wildcard matching)
- Source: `apps/runtime/src/services/permission-resolution.ts` (resolveProjectCustomRolePermissions, bounded LRU cache)
- Source: `apps/runtime/src/middleware/rbac.ts` (custom role wiring, re-exports PROJECT_ROLE_PERMISSIONS)
- Source: `apps/studio/src/lib/permission-resolver.ts` (Studio permission resolver)
- Source: `apps/studio/src/lib/project-access.ts` (requireProjectAccess with explicit membership enforcement)
- Source: `apps/studio/src/services/project-member-service.ts` (member management business logic)
- Source: `apps/studio/src/repos/project-member-repo.ts` (ProjectMember CRUD, custom role lookup)
- Source: `apps/studio/src/app/api/workspaces/[tenantId]/roles/route.ts` (custom role CRUD API)
- Source: `apps/studio/src/app/api/projects/[id]/members/route.ts` (project member list + add)
- Source: `apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts` (member update + remove)
- Audit: `docs/sdlc-logs/custom-project-roles/feature-spec-audit.md`
- Journal: `docs/sdlc-logs/custom-project-roles/journal.md`
