# Feature: Workspace Management v1.0 Parity

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `enterprise`, `admin operations`, `customer experience`
**Package(s)**: `apps/studio`, `packages/database`, `packages/shared-auth`
**Owner(s)**: `platform-core`
**Testing Guide**: `../testing/workspace-management-v1-parity.md`
**Last Updated**: 2026-04-14

---

## 1. Introduction / Overview

### Problem Statement

The v1.0 product docs describe a rich workspace management experience: mark a workspace as default, favorite up to 3 workspaces, search/browse with pagination, view role and member count per workspace. The current platform has a basic workspace switcher (`apps/studio/src/components/auth/UserMenu.tsx:169-242`) that lists workspaces and allows click-to-switch, but offers no search, no favorites, no default workspace designation, and no metadata beyond name and role. Users who already have a workspace cannot create a new one from the switcher -- the creation UI only surfaces during the onboarding flow when a user has zero memberships (though the underlying API endpoint has no such restriction).

### Goal Statement

Bring the platform's workspace management to v1.0 feature parity by enabling users to designate a default workspace for auto-login, pin favorite workspaces for quick access, search across workspaces, view member counts, create new workspaces from the switcher, manage workspace settings (rename, slug update, retention), and soft-delete workspaces with a 30-day grace period before permanent removal.

### Summary

This feature enhances the workspace switcher in Studio, adds a workspace settings page, and introduces user-level workspace preferences (default and favorites). The changes span the Studio frontend (switcher UI, settings page, preference controls), Studio API routes (new preferences endpoint, workspace update and delete routes, enhanced tenant listing), and the database layer (new fields on the User model for cross-tenant preferences). Workspace deletion uses the existing `status: 'archived'` enum value on the Tenant model, with a 30-day grace period before permanent cascading deletion of all tenant-scoped data.

---

## 2. Scope

### Goals

- Enable users to designate one workspace as their default for auto-login
- Enable users to pin up to 3 favorite workspaces for quick access
- Add client-side search filtering in the workspace switcher when a user has 5+ workspaces
- Display member count per workspace in the switcher
- Allow workspace creation directly from the switcher (not only during onboarding)
- Provide a workspace settings page for owners/admins to rename, update slug, and configure retention
- Implement soft-delete (archive) for workspaces with a 30-day grace period before permanent deletion

### Non-Goals (Out of Scope)

- Organization management (separate feature)
- SSO per-workspace configuration (handled by `sso-enterprise-auth` feature)
- Cross-workspace resource sharing (v2 feature)
- Request access to unlisted workspaces (deferred -- requires workspace discovery)
- Workspace data export before deletion (deferred to v2)
- Billing subscription interaction on workspace deletion (deferred -- requires billing integration)

---

## 3. User Stories

1. As a **platform user** with multiple workspaces, I want to **set one workspace as my default** so that I **land in my most-used workspace on login without manual switching**.
2. As a **power user** managing 10+ workspaces, I want to **search and favorite workspaces** so that I can **quickly access the ones I use most without scrolling through a long list**.
3. As a **workspace owner**, I want to **rename my workspace and update its slug** so that the **workspace URL and display name reflect our team's current identity**.
4. As a **platform user** with an existing workspace, I want to **create a new workspace from the switcher** so that I **do not have to navigate to the onboarding flow to create one**.
5. As a **workspace owner**, I want to **delete a workspace I no longer need** so that **unused workspaces do not clutter the list and resources are cleaned up**, with a grace period in case of accidental deletion.

---

## 4. Functional Requirements

1. **FR-1 (Default Workspace)**: The system must allow an authenticated user to designate one workspace as their default. On login, if the user has a designated default and is still an active member of that workspace, the session must be scoped to that workspace. If the default workspace is no longer accessible (deleted, archived, or membership revoked), the system must fall back to the oldest membership by `createdAt`.
2. **FR-2 (Favorite Workspaces)**: The system must allow an authenticated user to mark up to 3 workspaces as favorites. Favorites must appear at the top of the workspace list in the switcher, visually separated from non-favorites. The limit of 3 follows the v1.0 product specification and should be stored as a named constant to allow future adjustment.
3. **FR-3 (Workspace Search)**: The system must provide client-side search filtering in the workspace switcher when the user has 5 or more workspaces. The search must filter by workspace name.
4. **FR-4 (Workspace Metadata)**: The system must display the number of active members per workspace in the workspace switcher.
5. **FR-5 (Create Workspace from Switcher)**: The system must allow any authenticated user to create a new workspace directly from the workspace switcher, subject to the existing per-user limit of 10 workspaces. After creation, the system must auto-switch to the new workspace.
6. **FR-6 (Workspace Settings)**: The system must provide a workspace settings page accessible to users with the OWNER or ADMIN role. The settings page must allow editing the workspace name, slug (with uniqueness validation and confirmation), and retention days.
7. **FR-7 (Workspace Soft-Delete)**: The system must allow a workspace OWNER to archive a workspace by setting its status to `archived`. Archived workspaces must be excluded from workspace lists, login resolution, and the workspace switcher. Active sessions in an archived workspace must be terminated within 5 minutes.
8. **FR-8 (Grace Period)**: The system must retain archived workspaces for 30 days before permanent deletion. During the grace period, the OWNER must be able to restore the workspace to `active` status.
9. **FR-9 (Permanent Deletion Cascade)**: When the 30-day grace period expires, the system must permanently delete the workspace and cascade deletion to all tenant-scoped collections (see Section 12 -- Data Lifecycle for the full enumeration).
10. **FR-10 (Deletion Confirmation)**: The system must require the user to re-type the workspace name in a confirmation dialog before archiving. The dialog must display the count of projects, members, and agents that will be affected.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                               |
| -------------------------- | ------------ | ------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Workspace deletion cascades to projects                             |
| Agent lifecycle            | SECONDARY    | Agents are project-scoped; cascade flows through project deletion   |
| Customer experience        | PRIMARY      | Directly improves daily workspace navigation for multi-tenant users |
| Integrations / channels    | NONE         | No channel-specific behavior                                        |
| Observability / tracing    | NONE         | No trace events introduced (audit logging only)                     |
| Governance / controls      | SECONDARY    | Workspace deletion requires OWNER role; retention settings exposed  |
| Enterprise / compliance    | SECONDARY    | Soft-delete with grace period supports compliance recovery needs    |
| Admin / operator workflows | PRIMARY      | New workspace settings page, deletion workflow                      |

### Related Feature Integration Matrix

| Related Feature                     | Relationship Type | Why It Matters                                                                   | Key Touchpoints                                                      | Current State                          |
| ----------------------------------- | ----------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| Authentication & Session Management | depends on        | Workspace switch issues new JWT; login must resolve default workspace            | `POST /api/auth/tenants/switch`, `findDefaultTenantMembership()`     | Working; no default-workspace support  |
| Organization Management             | shares data with  | Workspaces can belong to organizations; org-scoped workspace creation exists     | `POST /api/organizations/:orgId/workspaces`, `Tenant.organizationId` | Working                                |
| Project Lifecycle                   | emits into        | Workspace deletion must cascade to all projects within the workspace             | `Project.tenantId`, project archive/delete flows                     | Projects have `archivedAt` soft-delete |
| Member & Invitation Management      | extends           | Workspace settings page needs member count; deletion affects members/invitations | `TenantMember`, `WorkspaceInvitation`                                | Working CRUD routes exist              |

---

## 6. Design Considerations (Optional)

**Workspace Switcher UI Enhancements:**

- The current switcher is in `apps/studio/src/components/auth/UserMenu.tsx:169-242`. It renders a collapsible list with workspace avatar (first letter), name, and role badge.
- Favorites section should appear above a visual divider, with a star/pin icon toggle per workspace.
- Default workspace should be indicated with a distinct icon (home or filled star).
- Search input should appear conditionally when the user has 5+ workspaces, positioned at the top of the workspace list.
- "Create new workspace" button should appear at the bottom of the list, below all workspaces.

**Workspace Settings Page:**

- New route: `/settings/workspace`
- Slug change must show a confirmation dialog explaining that URLs will change.
- Deletion section at the bottom of settings page with prominent warning styling.

---

## 7. Technical Considerations (Optional)

### User Preferences Storage

**Decision: Add `defaultTenantId` and `favoriteTenantIds` directly to the User model.**

Rationale: These preferences are cross-tenant (a user picks a default across all their workspaces), so they do not belong in the existing `UserPreferences` collection which is scoped per `(userId, tenantId)` pair. Adding two fields to the existing User model (`packages/database/src/models/user.model.ts`) is simpler than creating a new collection, avoids an extra query on login, and keeps the data co-located with the user record.

New fields on `IUser`:

- `defaultTenantId: string | null` (default: `null`)
- `favoriteTenantIds: string[]` (default: `[]`, max length: 3, enforced via Mongoose validator)

Note: The existing `UserPreferences` model (`packages/database/src/models/user-preferences.model.ts`) stores per-user-per-tenant preferences like `pinnedProjectIds`. It is scoped to `(userId, tenantId)` and is NOT suitable for cross-tenant preferences like default workspace.

### API Endpoint Design

- `PATCH /api/auth/preferences` -- new endpoint for setting `defaultTenantId` and `favoriteTenantIds`. Must validate that the user is an active member of each referenced workspace.
- `GET /api/auth/tenants` -- enhance response to include `memberCount` per workspace. Use a batch `TenantMember.aggregate([{ $match: { tenantId: { $in: tenantIds } } }, { $group: { _id: '$tenantId', count: { $sum: 1 } } }])` to avoid N+1 queries. Also filter out workspaces with `status: 'archived'`.
- `PATCH /api/workspaces/:tenantId` -- new route wrapping `updateTenant()` from `apps/studio/src/repos/workspace-repo.ts:70-92`. Requires OWNER/ADMIN role.
- `DELETE /api/workspaces/:tenantId` -- new route for soft-delete (set `status: 'archived'`). Requires OWNER role.
- `POST /api/workspaces/:tenantId/restore` -- new route to restore an archived workspace during the grace period. Requires OWNER role.

### OpenAPI Schema Discrepancy

The `GET /api/auth/tenants` route (`apps/studio/src/app/api/auth/tenants/route.ts:14-23`) declares an OpenAPI response schema of `{ id, name, slug, role }`, but the actual service function `getUserTenants` (`apps/studio/src/services/auth-service.ts:413-429`) returns `{ tenantId, tenantName, role, orgId }`. The OpenAPI schema is incorrect -- `slug` is not returned and field names differ. This must be reconciled as part of this feature when adding `memberCount` to the response.

### Existing Code Notes

- `POST /api/auth/create-workspace` (`apps/studio/src/app/api/auth/create-workspace/route.ts`) -- currently called only from the onboarding page UI, but the API has no onboarding-specific guard. Any authenticated user can call it. FR-5 can reuse this endpoint directly from the switcher.
- `createDefaultWorkspace()` in `apps/studio/src/services/workspace-service.ts:48` is exported but never imported in production code (only referenced in tests). Consider removing or repurposing for FR-5.
- `findTenantMembershipsByUserId()` in `apps/studio/src/repos/workspace-repo.ts:189-197` accepts a `select` option but ignores it in the query. Should be fixed as part of this work.
- `findDefaultTenantMembership()` in `apps/studio/src/repos/auth-repo.ts:369-380` returns the oldest membership by `createdAt` (`.sort({ createdAt: 1 })`). FR-1 must update this function to first check the user's `defaultTenantId` before falling back to oldest.
- `countTenantMembers()` already exists in `apps/studio/src/repos/workspace-repo.ts:199-203` and can be used for the member count display.
- The `Tenant` model already has `status: 'active' | 'suspended' | 'archived' | 'transferring'` (verified at `packages/database/src/models/tenant.model.ts:91-95`), so the `archived` status value already exists.

---

## 8. How to Consume

### Studio UI

- **Workspace Switcher** (`UserMenu.tsx`): "Create new workspace" button added (ABLP-339). Redirects to onboarding page. Workspace name sanitization (ABLP-343) applies to all workspace creation flows.
- **Workspace Settings** (`/api/workspaces/:tenantId/settings`): GET/PATCH routes for OWNER/ADMIN to read and update workspace name and slug with validation.
- **Member Lifecycle Actions**: Lock, suspend, deactivate, reactivate, unlock routes for workspace admins (ABLP-325, ABLP-341).
- **Login Flow**: Active workspace auth context enforced (ABLP-322). Workspace switch preserved on refresh (ABLP-244). Legacy workspace logins restored (ABLP-335).
- **NOT YET IMPLEMENTED**: Favorites section, search input, member count badges, default workspace indicator, `/settings/workspace` UI page.

### API (Runtime)

N/A -- workspace management is Studio-side only. Runtime receives the `tenantId` via JWT and does not manage workspaces.

### API (Studio)

| Method | Path                                                        | Purpose                                                   | Status      |
| ------ | ----------------------------------------------------------- | --------------------------------------------------------- | ----------- |
| GET    | `/api/auth/tenants`                                         | List user's workspaces                                    | Implemented |
| POST   | `/api/auth/tenants/switch`                                  | Switch workspace (role enum fixed to include all 5 roles) | Implemented |
| POST   | `/api/auth/create-workspace`                                | Create new workspace (reused from switcher via ABLP-339)  | Implemented |
| GET    | `/api/workspaces/:tenantId/settings`                        | Read workspace settings (OWNER/ADMIN)                     | Implemented |
| PATCH  | `/api/workspaces/:tenantId/settings`                        | Update workspace name/slug (OWNER/ADMIN)                  | Implemented |
| POST   | `/api/workspaces/:tenantId/archive`                         | Soft-delete workspace (OWNER only, cascades to projects)  | Implemented |
| POST   | `/api/workspaces/:tenantId/restore`                         | Restore archived workspace within 30-day grace period     | Implemented |
| PATCH  | `/api/workspaces/:tenantId/members/:userId`                 | Update member role with hierarchy enforcement             | Implemented |
| DELETE | `/api/workspaces/:tenantId/members/:userId`                 | Remove member with project cascade and token revocation   | Implemented |
| POST   | `/api/workspaces/:tenantId/members/:userId/lock`            | Lock member (admin-only)                                  | Implemented |
| POST   | `/api/workspaces/:tenantId/members/:userId/suspend`         | Suspend member (admin-only)                               | Implemented |
| POST   | `/api/workspaces/:tenantId/members/:userId/deactivate`      | Deactivate member (admin-only)                            | Implemented |
| POST   | `/api/workspaces/:tenantId/members/:userId/reactivate`      | Reactivate deactivated/suspended/locked member            | Implemented |
| POST   | `/api/workspaces/:tenantId/members/:userId/unlock`          | Unlock locked member                                      | Implemented |
| POST   | `/api/workspaces/:tenantId/members/:userId/revoke-sessions` | Revoke member sessions                                    | Implemented |
| PATCH  | `/api/auth/preferences`                                     | Set default workspace and favorites                       | NOT YET     |
| GET    | `/api/projects/:id/members`                                 | List project members via extracted RBAC service           | Implemented |
| POST   | `/api/projects/:id/members`                                 | Add project member with custom role support               | Implemented |
| PATCH  | `/api/projects/:id/members/:memberId`                       | Update project member role                                | Implemented |
| DELETE | `/api/projects/:id/members/:memberId`                       | Remove project member                                     | Implemented |

### Admin Portal

N/A -- workspace management is user-facing. Admin portal may gain a "view all workspaces" page in a future iteration, but that is out of scope.

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. Workspace management is a Studio-only concern. Channels and SDKs receive the `tenantId` via JWT or API key and are unaffected by workspace switching or deletion (beyond losing access when a workspace is archived).

---

## 9. Data Model

### Collections / Tables

**Modified: `users` collection**

```text
Collection: users (existing)
New Fields:
  - defaultTenantId: string | null (default: null)
  - favoriteTenantIds: string[] (default: [], max 3)
New Indexes:
  - None required (queried by _id during login)
Backward Compatibility:
  - Both fields are optional with defaults. Existing documents unaffected.
  - No migration required -- Mongoose defaults handle missing fields.
```

**Existing: `tenants` collection (no changes)**

```text
Collection: tenants (existing, unchanged)
Relevant Fields:
  - _id: string (UUIDv7)
  - name: string (required)
  - slug: string (required, unique index)
  - organizationId: string | null
  - ownerId: string (required)
  - retentionDays: number (default: 7)
  - settings: ITenantSettings | null (typed, with index signature for extensibility)
  - status: 'active' | 'suspended' | 'archived' | 'transferring' (required, default: 'active')
  - llmPolicy: ILlmPolicy | null
Existing Indexes:
  - { slug: 1 } unique
  - { organizationId: 1 }
  - { ownerId: 1 }
  - { status: 1 }
```

**Modified: `tenant_members` collection**

```text
Collection: tenant_members (modified)
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required)
  - userId: string (required)
  - role: string (required) -- 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER'
  - customRoleId: string | null
  - status: 'active' | 'suspended' | 'locked' | 'deactivated' (default: 'active')
  - _v: number (default: 1)
Indexes:
  - { tenantId: 1, userId: 1 } unique
  - { userId: 1 }
  - { userId: 1, status: 1, createdAt: 1 }
  - { customRoleId: 1 }
  - { tenantId: 1, status: 1 }
```

**New: `project_members` collection**

```text
Collection: project_members (new)
Fields:
  - _id: string (UUIDv7)
  - projectId: string (required)
  - userId: string (required)
  - role: ProjectRoleName | 'custom' (required, enum-validated)
  - customRoleId: string | null (required when role='custom', null otherwise)
  - _v: number (default: 1)
Indexes:
  - { projectId: 1, userId: 1 } unique
  - { userId: 1 }
  - { customRoleId: 1 } sparse
Mongoose Guards:
  - pre-validate enforces customRoleId/role consistency
  - pre-findOneAndUpdate enforces customRoleId/role consistency
```

**Existing: `user_preferences` collection (NOT used for this feature)**

The `UserPreferences` model is scoped per `(userId, tenantId)` and stores tenant-specific preferences like `pinnedProjectIds`. Cross-tenant preferences (default workspace, favorites) belong on the User model.

### ITenantSettings Interface (verified)

```typescript
// packages/database/src/models/tenant.model.ts:32-43
export interface ITenantSettings {
  defaultLLMProvider?: string;
  maxConcurrentSessions?: number;
  enableAuditLogging?: boolean;
  enableClickHouse?: boolean;
  allowedDomains?: string[];
  webhookUrl?: string | null;
  codeToolsEnabled?: boolean;
  [key: string]: unknown; // Index signature for extensibility
}
```

### Key Relationships

- `User.defaultTenantId` references `Tenant._id` -- no foreign key enforcement; validated at read time (membership check).
- `User.favoriteTenantIds` references `Tenant._id` array -- validated at write time (membership check).
- `TenantMember` is the join table between `User` and `Tenant`.
- Workspace deletion cascades through `tenantId` foreign key on 100+ tenant-scoped collections (see Section 12 -- Data Lifecycle).

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                     | Purpose                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/tenant.model.ts`           | Tenant model -- `status` enum includes `archived`                                                     |
| `packages/database/src/models/tenant-member.model.ts`    | TenantMember model -- membership with `status` field (`active/suspended/locked/deactivated`)          |
| `packages/database/src/models/project-member.model.ts`   | ProjectMember model -- project-level membership with custom role support and validation guards        |
| `apps/studio/src/repos/workspace-repo.ts`                | Workspace repo -- `archiveWorkspace()`, `restoreWorkspace()`, member status filtering, tenant lookups |
| `apps/studio/src/repos/project-member-repo.ts`           | Project member repo -- CRUD for project-level memberships                                             |
| `apps/studio/src/services/workspace-service.ts`          | Workspace creation, slug generation, `createDefaultWorkspace()`                                       |
| `apps/studio/src/services/project-member-service.ts`     | Extracted RBAC service for project members with permission hierarchy (ABLP-327)                       |
| `apps/studio/src/lib/workspace-name.ts`                  | Workspace name sanitization -- accent normalization, character filtering (ABLP-343)                   |
| `apps/studio/src/lib/project-access.ts`                  | `requireProjectAccess()` -- enforces explicit project membership (ABLP-327)                           |
| `apps/studio/src/lib/require-project-member-or-admin.ts` | Compatibility wrapper delegating to `requireProjectAccess()`                                          |
| `packages/shared-auth/src/middleware/unified-auth.ts`    | Unified auth -- active workspace context enforcement (ABLP-322)                                       |

### Routes / Handlers

| File                                                                                      | Purpose                                            |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/studio/src/app/api/auth/tenants/route.ts`                                           | List tenants (OpenAPI schema fixed, 5-role enum)   |
| `apps/studio/src/app/api/auth/tenants/switch/route.ts`                                    | Switch workspace (role enum fixed for all 5 roles) |
| `apps/studio/src/app/api/auth/create-workspace/route.ts`                                  | Create workspace (reused from switcher, ABLP-339)  |
| `apps/studio/src/app/api/workspaces/[tenantId]/settings/route.ts`                         | GET/PATCH workspace settings (name, slug)          |
| `apps/studio/src/app/api/workspaces/[tenantId]/archive/route.ts`                          | POST to archive workspace with project cascade     |
| `apps/studio/src/app/api/workspaces/[tenantId]/restore/route.ts`                          | POST to restore archived workspace (grace period)  |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/route.ts`                 | PATCH/DELETE for member role change and removal    |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/lock/route.ts`            | Lock member (ABLP-325)                             |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/suspend/route.ts`         | Suspend member (ABLP-325)                          |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/deactivate/route.ts`      | Deactivate member (ABLP-325)                       |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/reactivate/route.ts`      | Reactivate member (ABLP-325)                       |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/unlock/route.ts`          | Unlock member (ABLP-325)                           |
| `apps/studio/src/app/api/workspaces/[tenantId]/members/[userId]/revoke-sessions/route.ts` | Revoke member sessions                             |
| `apps/studio/src/app/api/projects/[id]/members/route.ts`                                  | Project member list and add (ABLP-327)             |
| `apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts`                       | Project member update and remove (ABLP-327)        |

### UI Components

| File                                           | Purpose                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `apps/studio/src/components/auth/UserMenu.tsx` | Workspace switcher -- "Create workspace" button added (ABLP-339) |
| `apps/studio/src/app/onboarding/page.tsx`      | Onboarding -- uses sanitized workspace names (ABLP-343)          |

### Jobs / Workers / Background Processes

| File | Purpose                                                                     | Status  |
| ---- | --------------------------------------------------------------------------- | ------- |
| TBD  | Scheduled job to permanently delete workspaces archived for 30+ days        | NOT YET |
| TBD  | Session termination worker for archived workspaces (within 5-minute window) | NOT YET |

### Tests

| File                                                                                    | Type        | Coverage Focus                                                                       |
| --------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `apps/studio/src/__tests__/api-routes/api-workspace-lifecycle-e2e.test.ts` (1232 lines) | integration | 17 scenarios: role changes, deactivation/reactivation, archive/restore, cross-tenant |
| `apps/studio/src/__tests__/api-routes/api-soft-delete.test.ts`                          | integration | 25 scenarios: project/workspace archive/restore, grace period, permission gating     |
| `apps/studio/src/__tests__/api-routes/api-workspace-settings.test.ts` (408 lines)       | integration | 12 scenarios: settings CRUD, slug conflict, validation, role checks                  |
| `apps/studio/src/__tests__/api-routes/api-user-lifecycle.test.ts` (1399 lines)          | integration | 45 scenarios: lock/suspend/deactivate/reactivate/unlock, cross-tenant, login lockout |
| `apps/studio/src/__tests__/api-routes/api-project-members.test.ts` (350 lines)          | integration | 10 scenarios: project member CRUD, RBAC, validation, 404 mapping                     |
| `apps/studio/src/__tests__/project-member-service.test.ts` (553 lines)                  | unit        | 22 scenarios: permission hierarchy, custom roles, audit events, edge cases           |
| `apps/studio/src/__tests__/api-routes/route-handler-rbac.test.ts` (288 lines)           | integration | 14 scenarios: RBAC gate, permission resolution, rate limiting                        |
| `apps/studio/src/lib/__tests__/workspace-name.test.ts` (23 lines)                       | unit        | 4 scenarios: name sanitization, accent normalization, length limits, fallback        |

---

## 11. Configuration

### Environment Variables

No new environment variables required. The per-user workspace limit is already configurable via `auth.workspace.maxPerUser` in the runtime config (default: 10, verified at `apps/studio/src/app/api/auth/create-workspace/route.ts:89`).

### Runtime Configuration

| Setting                        | Location             | Default | Description                                           |
| ------------------------------ | -------------------- | ------- | ----------------------------------------------------- |
| `auth.workspace.maxPerUser`    | App config           | 10      | Max workspaces per user                               |
| `WORKSPACE_ARCHIVE_GRACE_DAYS` | Named constant (new) | 30      | Days before archived workspace is permanently deleted |
| `MAX_FAVORITE_WORKSPACES`      | Named constant (new) | 3       | Max favorite workspaces per user (v1.0 spec)          |
| `SWITCHER_SEARCH_THRESHOLD`    | Named constant (new) | 5       | Min workspaces to show search in switcher             |

### DSL / Agent IR / Schema

N/A -- workspace management is not configurable in the DSL or Agent IR.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User isolation    | User preferences (`defaultTenantId`, `favoriteTenantIds`) are scoped to the authenticated `userId`. A user cannot read or modify another user's preferences. Cross-user access returns 404.                                                                                         |
| Tenant isolation  | Workspace settings (`PATCH /api/workspaces/:tenantId`) and deletion (`DELETE /api/workspaces/:tenantId`) require the caller to be a verified member of the workspace AND have the required role (OWNER or ADMIN for settings, OWNER for deletion). Cross-tenant access returns 404. |
| Role-based access | OWNER: all operations (settings, delete, restore). ADMIN: settings only (name, slug, retention). MEMBER: read-only (switcher list, metadata).                                                                                                                                       |

### Security & Compliance

- All workspace management endpoints require authentication via `requireAuth` (unified auth middleware).
- Workspace deletion is audit-logged via `logAuditEvent` with `AuditActions.WORKSPACE_DELETED`.
- Slug changes are audit-logged (URL changes are security-relevant).
- The 30-day grace period supports compliance recovery (accidental deletion, regulatory hold).
- No PII is introduced -- workspace names and slugs are not PII.

### Performance & Scalability

- `GET /api/auth/tenants` with `memberCount`: Use a single aggregation pipeline with `$group` instead of N+1 `countDocuments` queries. Users rarely have more than 50 workspaces, so the query is bounded.
- Client-side search filtering (no server-side search needed) -- the full workspace list is already fetched for the switcher.
- Workspace creation is rate-limited (existing: `authConfig.rateLimits.createWorkspace`).
- Grace period cleanup job should run on a daily schedule, not in real-time, to avoid burst load.

### Reliability & Failure Modes

- If `defaultTenantId` references a workspace that no longer exists or where the user is no longer a member, the system falls back to the oldest membership. No error is shown to the user.
- If a favorite workspace is archived, it is silently removed from the favorites list on the next preferences read.
- Workspace archive is idempotent -- archiving an already-archived workspace is a no-op.
- The permanent deletion cascade must be wrapped in a transaction or use ordered sequential deletion to handle partial failures.

### Observability

- Audit events: `WORKSPACE_CREATED` (existing), `WORKSPACE_UPDATED` (new), `WORKSPACE_ARCHIVED` (new), `WORKSPACE_RESTORED` (new), `WORKSPACE_PERMANENTLY_DELETED` (new).
- No new trace events -- workspace management is not part of the agent execution pipeline.
- Log via `createLogger('workspace')` for all new routes.

### Data Lifecycle

**Soft-delete (archive)**: Sets `Tenant.status` to `'archived'`. All data is retained but the workspace is hidden from users.

**Permanent deletion cascade** (after 30-day grace period): The following tenant-scoped collections must be deleted when `tenantId` matches the archived workspace. This is a representative list of the major collections (100+ models have `tenantId: required`):

| Category           | Collections                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Core               | `projects`, `project_settings`, `project_agents`, `project_tools`, `project_llm_configs`         |
| Sessions           | `sessions`, `session_states`, `session_files`, `session_oauth_artifacts`, `messages`             |
| Search / Knowledge | `search_indexes`, `search_sources`, `search_documents`, `search_chunks`, `knowledge_bases`       |
| Connectors         | `connector_configs`, `connector_connections`, `connector_schemas`, `connector_discoveries`       |
| Deployments        | `deployments`, `deployment_module_snapshots`, `deployment_variable_snapshots`                    |
| Security           | `llm_credentials`, `api_keys`, `dek_registries`, `tenant_kms_configs`, `tool_secrets`            |
| Membership         | `tenant_members`, `workspace_invitations`, `role_definitions`, `resource_permissions`            |
| Observability      | `llm_usage_metrics`, `audit_logs` (retain per compliance policy), `pii_audit_logs`               |
| Workflows          | `workflows`, `workflow_versions`, `workflow_executions`                                          |
| Evaluation         | `eval_sets`, `eval_runs`, `eval_scenarios`, `eval_evaluators`, `eval_human_reviews`              |
| Config             | `environment_variables`, `project_config_variables`, `variable_namespaces`, `guardrail_policies` |
| User Preferences   | `user_preferences` (delete all documents where `tenantId` matches)                               |

**Important**: `User.defaultTenantId` and `User.favoriteTenantIds` must be cleaned up when a workspace is permanently deleted -- remove the `tenantId` from all users who reference it.

---

## 13. Delivery Plan / Work Breakdown

1. **User preferences infrastructure**
   1.1 Add `defaultTenantId: string | null` and `favoriteTenantIds: string[]` to User model (`packages/database/src/models/user.model.ts`)
   1.2 Create `PATCH /api/auth/preferences` endpoint with membership validation
   1.3 Update `findDefaultTenantMembership()` in `auth-repo.ts` to check `defaultTenantId` before falling back to oldest
   1.4 Update login/token-refresh flow to respect `defaultTenantId`
2. **Workspace switcher enhancements**
   2.1 Add `memberCount` to `GET /api/auth/tenants` response (batch aggregation query)
   2.2 Fix OpenAPI schema to match actual response shape; reconcile field names
   2.3 Add client-side search input in switcher (conditional on 5+ workspaces)
   2.4 Add favorites section with visual divider and toggle controls
   2.5 Add default workspace indicator (home icon)
   2.6 Add "Create new workspace" button at bottom of switcher
   2.7 Fix `findTenantMembershipsByUserId()` to use the `select` option
3. **Workspace settings page**
   3.1 Create `PATCH /api/workspaces/:tenantId` route wrapping `updateTenant()`
   3.2 Build `/settings/workspace` UI page with name, slug, retention fields
   3.3 Implement slug uniqueness validation with confirmation dialog
   3.4 Wire OWNER/ADMIN role check
4. **Workspace deletion**
   4.1 Create `DELETE /api/workspaces/:tenantId` route (soft-delete to `archived`)
   4.2 Create `POST /api/workspaces/:tenantId/restore` route
   4.3 Build confirmation dialog (re-type workspace name, impact summary)
   4.4 Filter archived workspaces from `GET /api/auth/tenants` and login resolution
   4.5 Implement session termination for archived workspaces (within 5 minutes)
   4.6 Implement scheduled cleanup job for permanent deletion after 30-day grace period
   4.7 Implement cascading deletion across all tenant-scoped collections
   4.8 Clean up `User.defaultTenantId` and `User.favoriteTenantIds` references

---

## 14. Success Metrics

| Metric                            | Baseline            | Target                | How Measured                             |
| --------------------------------- | ------------------- | --------------------- | ---------------------------------------- |
| Workspace switch time             | 2+ clicks + scroll  | 1 click (favorites)   | UX audit / user session recordings       |
| Users setting a default workspace | 0 (feature absent)  | 40% of multi-WS users | `User.defaultTenantId IS NOT NULL` query |
| Workspace creation from switcher  | 0 (onboarding only) | 50% of new workspaces | Audit events with source = switcher      |
| Accidental deletion recovery      | N/A                 | 100% within 30 days   | `WORKSPACE_RESTORED` audit events        |

---

## 15. Open Questions

1. **Billing interaction**: How should workspace deletion interact with active billing subscriptions? Should archiving pause billing, or should billing be resolved before archiving is allowed? (Deferred until billing integration is implemented.)
2. **Archived workspace visibility**: Should workspace owners see archived workspaces in a separate "Archived" section during the 30-day grace period, or should they only be accessible via a direct restore URL/admin action?
3. **Workspace-level API keys**: When a workspace is archived, should workspace-scoped API keys be immediately revoked or remain active during the grace period? Immediate revocation is safer but may break integrations.
4. **Organization backlink cleanup**: When a workspace within an organization is deleted, should the organization's workspace count be decremented? What if it was the last workspace in the org?
5. **Audit log retention on permanent deletion**: Should audit logs (`audit_logs` collection) for a deleted workspace be retained permanently for compliance, or deleted with the workspace?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                           | Severity | Status    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | `GET /api/auth/tenants` OpenAPI schema (`{ id, name, slug, role }`) does not match actual response (`{ tenantId, tenantName, role, orgId }`). `slug` is not returned. | Medium   | Mitigated |
| GAP-002 | `findTenantMembershipsByUserId()` accepts a `select` option but ignores it in the query                                                                               | Low      | Mitigated |
| GAP-003 | `createDefaultWorkspace()` in workspace-service is exported but unused in production code                                                                             | Low      | Mitigated |
| GAP-004 | No scheduled job infrastructure exists for the 30-day grace period cleanup -- must be built or adapted from existing BullMQ flows                                     | Medium   | Open      |
| GAP-005 | Session termination on workspace archive requires integration with the runtime's session management -- exact mechanism TBD                                            | Medium   | Partial   |
| GAP-006 | `PATCH /api/auth/preferences` endpoint for default workspace and favorites not yet implemented (FR-1, FR-2)                                                           | Medium   | Open      |
| GAP-007 | Client-side search filtering in workspace switcher not yet implemented (FR-3)                                                                                         | Low      | Open      |
| GAP-008 | Member count per workspace not yet displayed in switcher (FR-4). `countTenantMembers()` exists in repo but not wired to `GET /api/auth/tenants` response              | Low      | Open      |
| GAP-009 | Workspace settings UI page (`/settings/workspace`) not yet implemented -- API routes exist but no frontend page                                                       | Medium   | Open      |
| GAP-010 | Deletion confirmation dialog (re-type workspace name, impact summary) not yet implemented (FR-10)                                                                     | Low      | Open      |
| GAP-011 | Permanent deletion cascade job for expired archived workspaces not yet implemented (FR-9)                                                                             | Medium   | Open      |
| GAP-012 | All E2E/integration tests use `vi.mock` for internal modules -- no real HTTP E2E tests exist yet                                                                      | High     | Open      |

**Mitigated details:**

- GAP-001: OpenAPI schema on `GET /api/auth/tenants` now uses `workspaceRoleSchema` with all 5 roles. Field names still differ from originally planned but are consistent with actual contract.
- GAP-002: `findTenantMembershipsByUserId()` now applies `select` projection when provided.
- GAP-003: `createDefaultWorkspace()` is now used by the onboarding page via `buildDefaultWorkspaceName()`.
- GAP-005: Workspace archive revokes all member tokens immediately (via `revokeAllUserTokens`), which effectively terminates active sessions. Not a background worker, but an inline cascade.

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                    | Coverage Type | Status           | Test File / Note                                                              |
| --- | ----------------------------------------------------------- | ------------- | ---------------- | ----------------------------------------------------------------------------- |
| 1   | Set default workspace, login resolves to it                 | e2e           | NOT TESTED       | FR-1 not yet implemented (GAP-006)                                            |
| 2   | Default falls back to oldest when workspace archived        | e2e           | NOT TESTED       | FR-1 not yet implemented (GAP-006)                                            |
| 3   | Favorite 3 workspaces, appear at top of list                | e2e           | NOT TESTED       | FR-2 not yet implemented (GAP-006)                                            |
| 4   | Try to favorite 4th workspace, fails                        | e2e           | NOT TESTED       | FR-2 not yet implemented (GAP-006)                                            |
| 5   | Create workspace from switcher, auto-switch                 | e2e           | NOT TESTED       | UI button added (ABLP-339), no E2E test                                       |
| 6   | Workspace search filters correctly                          | e2e           | NOT TESTED       | FR-3 not yet implemented (GAP-007)                                            |
| 7   | Member count displayed per workspace                        | e2e           | NOT TESTED       | FR-4 not yet implemented (GAP-008)                                            |
| 8   | OWNER renames workspace, name updates                       | integration   | COVERED (mocked) | `api-workspace-settings.test.ts` -- tests route handler with mocked DB        |
| 9   | MEMBER attempts settings edit, gets 404 (concealment)       | integration   | COVERED (mocked) | `api-workspace-settings.test.ts` -- tests non-admin rejection                 |
| 10  | OWNER archives workspace, members lose access               | integration   | COVERED (mocked) | `api-soft-delete.test.ts`, `api-workspace-lifecycle-e2e.test.ts`              |
| 11  | OWNER restores archived workspace within grace period       | integration   | COVERED (mocked) | `api-soft-delete.test.ts` -- tests grace period and cascade restore           |
| 12  | Non-OWNER attempts archive, gets 404                        | integration   | COVERED (mocked) | `api-soft-delete.test.ts` -- admin and member rejection                       |
| 13  | Preferences scoped to userId (cross-user isolation)         | integration   | NOT TESTED       | FR-1/FR-2 not yet implemented (GAP-006)                                       |
| 14  | Workspace settings require tenant membership                | integration   | COVERED (mocked) | `api-workspace-settings.test.ts`                                              |
| 15  | Cascade delete removes all tenant-scoped data               | integration   | NOT TESTED       | Permanent deletion not yet implemented (GAP-011)                              |
| 16  | Archived workspace excluded from login resolution           | integration   | COVERED (mocked) | `findTenantMember` filters by tenant status                                   |
| 17  | Slug uniqueness validation on update                        | integration   | COVERED (mocked) | `api-workspace-settings.test.ts` -- slug conflict test                        |
| 18  | Member lock/suspend/deactivate/reactivate/unlock lifecycle  | integration   | COVERED (mocked) | `api-user-lifecycle.test.ts` -- 45 scenarios                                  |
| 19  | Role hierarchy enforcement (cannot escalate above own role) | integration   | COVERED (mocked) | `api-workspace-lifecycle-e2e.test.ts`                                         |
| 20  | Cross-tenant isolation (eve cannot access alpha workspace)  | integration   | COVERED (mocked) | `api-workspace-lifecycle-e2e.test.ts`                                         |
| 21  | Project member RBAC (add/update/remove with custom roles)   | unit          | COVERED          | `project-member-service.test.ts` -- 22 scenarios, pure function tests         |
| 22  | Workspace name sanitization                                 | unit          | COVERED          | `workspace-name.test.ts` -- accent normalization, character filtering, limits |
| 23  | Grace period expired returns 410                            | integration   | COVERED (mocked) | `api-soft-delete.test.ts`                                                     |

### Testing Notes

**Current state**: All existing tests use `vi.mock` for internal modules (`@/lib/auth`, `@/repos/*`, `@/services/*`). These validate route handler logic but do NOT exercise real middleware chains or database operations. No real HTTP E2E tests exist yet.

**What counts as covered**: The "COVERED (mocked)" status means the scenario is tested at the route handler level with mocked dependencies. Per the CLAUDE.md test architecture rules, these do NOT count toward real E2E or integration coverage. They validate handler logic and error paths but cannot catch auth gaps, serialization bugs, or database-level issues.

**Priority for real E2E tests**: Member lifecycle (lock/suspend/deactivate flow), workspace archive/restore with project cascade, and cross-tenant isolation should be the first real HTTP E2E tests.

> Full testing details: `../testing/workspace-management-v1-parity.md`

---

## 18. References

- v1.0 Product Docs: https://docs.kore.ai/agent-platform/administration/overview
- LLD (workspace sharing subset): `docs/plans/2026-03-23-workspace-sharing-impl-plan.md` (APPROVED)
- Related feature docs: `docs/features/sso-enterprise-auth.md` (SSO per-workspace config -- out of scope)
- Implementation tickets:
  - ABLP-322: Enforce active workspace auth context
  - ABLP-325: Lifecycle lock and suspend flows
  - ABLP-327: Extract project member RBAC service, enforce explicit project access
  - ABLP-335: Restore legacy workspace logins
  - ABLP-339: Expose create workspace from user menu
  - ABLP-341: Portal workspace member actions
  - ABLP-343: Sanitize default workspace names
  - ABLP-244: Preserve switched workspace on refresh
  - ABLP-277: Earlier workspace management work (settings, lifecycle, soft delete, custom roles)
