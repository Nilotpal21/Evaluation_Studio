# Project-Level RBAC with Object:Operation Permissions

**Date**: 2026-02-20
**Status**: Implemented
**Commit**: `450bc1b4` on `develop`
**Related**: [Centralized Auth Design](2026-02-22-centralized-auth-design.md) — extends this RBAC model with discriminated AuthContext types (this design covers User JWT RBAC; the centralized auth design adds SDK session ownership and API key scoping)

---

## Problem

All 9 project-scoped routes used **tenant-level** permission checks (`requirePermissionInline(req, res, 'deployment:create')` or `requirePermission('credential:write')`). These checks grant access based on tenant role alone — meaning any tenant MEMBER with `agent:update` could modify agents in ANY project within the tenant, violating project isolation.

## Solution

Replace tenant-level permission checks on project-scoped routes with **project-level** permission checks using `object:operation` format (e.g., `channel:create`, `deployment:read`, `agent:update`). Project roles (admin/developer/viewer) map to specific object:operation permissions. The existing `hasPermission()` wildcard matching from `permission-resolver.ts` is reused.

**Key principle**: project scope inherently implies tenant scope. A project belongs to a tenant — verifying the project exists within the tenant and the user is a member satisfies both.

---

## Architecture

### New Function: `requireProjectPermission(req, res, permission)`

**File**: `apps/runtime/src/middleware/rbac.ts`

Resolution order:

1. **Tenant OWNER/ADMIN bypass** — `hasPermission(ctx.permissions, 'project:*')` grants full access to all projects (workspace authority)
2. **Project existence** — `findProjectByIdAndTenant(projectId, tenantId)` returns 404 if not found (enforces tenant isolation)
3. **Project owner** — `project.ownerId === userId` grants full access to owned project
4. **Project member** — `findProjectMember(projectId, userId)` returns 403 if not a member
5. **Permission check** — `hasPermission(PROJECT_ROLE_PERMISSIONS[role], permission)` returns 403 if role lacks permission

### Project Role Permissions

```typescript
const PROJECT_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*:*'],
  developer: [
    'agent:*',
    'version:*',
    'deployment:read',
    'channel:read',
    'env_var:read',
    'session:*',
    'workflow:*',
    'channel_connection:*',
  ],
  viewer: [
    'agent:read',
    'version:read',
    'deployment:read',
    'channel:read',
    'env_var:read',
    'session:read',
    'workflow:read',
    'channel_connection:read',
  ],
};
```

Wildcards are handled by the existing `hasPermission()` function:

- `*:*` matches any permission (admin)
- `agent:*` matches `agent:read`, `agent:update`, etc. (developer)

---

## Route Changes

### Endpoint Permission Mapping

| Route File                   | Endpoint                    | Before                                                 | After                                                           |
| ---------------------------- | --------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| **channels.ts**              | POST /                      | `requireProjectOperation(req,res,'deploy')`            | `requireProjectPermission(req,res,'channel:create')`            |
|                              | GET /                       | `requireProjectOperation(req,res,'view')`              | `requireProjectPermission(req,res,'channel:read')`              |
|                              | PUT /:channelId             | `requireProjectOperation(req,res,'edit')`              | `requireProjectPermission(req,res,'channel:update')`            |
|                              | DELETE /:channelId          | `requireProjectOperation(req,res,'delete')`            | `requireProjectPermission(req,res,'channel:delete')`            |
| **deployments.ts**           | POST /                      | `requirePermissionInline(req,res,'deployment:create')` | `requireProjectPermission(req,res,'deployment:create')`         |
|                              | GET /                       | auth-only                                              | `requireProjectPermission(req,res,'deployment:read')`           |
|                              | GET /:id                    | auth-only                                              | `requireProjectPermission(req,res,'deployment:read')`           |
|                              | POST /:id/retire            | `requirePermissionInline(req,res,'deployment:retire')` | `requireProjectPermission(req,res,'deployment:retire')`         |
|                              | POST /:id/rollback          | `requirePermissionInline(req,res,'deployment:create')` | `requireProjectPermission(req,res,'deployment:create')`         |
|                              | POST /:id/promote           | `requirePermissionInline(req,res,'deployment:create')` | `requireProjectPermission(req,res,'deployment:create')`         |
| **versions.ts**              | POST /                      | `requirePermissionInline(req,res,'agent:create')`      | `requireProjectPermission(req,res,'version:create')`            |
|                              | GET /                       | auth-only                                              | `requireProjectPermission(req,res,'version:read')`              |
|                              | GET /:version               | auth-only                                              | `requireProjectPermission(req,res,'version:read')`              |
|                              | POST /:version/promote      | `requirePermissionInline(req,res,'agent:deploy')`      | `requireProjectPermission(req,res,'version:promote')`           |
|                              | GET /:version/diff/:other   | auth-only                                              | `requireProjectPermission(req,res,'version:read')`              |
| **project-agents.ts**        | GET /                       | auth-only                                              | `requireProjectPermission(req,res,'agent:read')`                |
|                              | GET /:agentName             | auth-only                                              | `requireProjectPermission(req,res,'agent:read')`                |
|                              | PUT /:agentName/dsl         | `requirePermissionInline(req,res,'agent:update')`      | `requireProjectPermission(req,res,'agent:update')`              |
| **agent-model-config.ts**    | GET /                       | auth-only                                              | `requireProjectPermission(req,res,'agent:read')`                |
|                              | PUT /                       | `requirePermissionInline(req,res,'agent:update')`      | `requireProjectPermission(req,res,'agent:update')`              |
| **environment-variables.ts** | POST /                      | `requirePermission('credential:write')` middleware     | `requireProjectPermission(req,res,'env_var:create')` inline     |
|                              | GET /                       | auth-only                                              | `requireProjectPermission(req,res,'env_var:read')`              |
|                              | GET /:id/value              | auth-only                                              | `requireProjectPermission(req,res,'env_var:read')`              |
|                              | PUT /:id                    | `requirePermission('credential:write')` middleware     | `requireProjectPermission(req,res,'env_var:update')` inline     |
|                              | DELETE /:id                 | `requirePermission('credential:write')` middleware     | `requireProjectPermission(req,res,'env_var:delete')` inline     |
|                              | POST /copy                  | `requirePermission('credential:write')` middleware     | `requireProjectPermission(req,res,'env_var:create')` inline     |
|                              | POST /validate              | auth-only                                              | `requireProjectPermission(req,res,'env_var:read')`              |
| **sessions.ts**              | POST /                      | none                                                   | `requireProjectPermission(req,res,'session:execute')`           |
|                              | GET /                       | none                                                   | `requireProjectPermission(req,res,'session:read')`              |
|                              | POST /bulk-close            | `requirePermissionInline(req,res,'agent:execute')`     | `requireProjectPermission(req,res,'session:execute')`           |
|                              | POST /cleanup-orphans       | `requirePermissionInline(req,res,'agent:execute')`     | `requireProjectPermission(req,res,'session:delete')`            |
|                              | GET /:id                    | none                                                   | `requireProjectPermission(req,res,'session:read')`              |
|                              | DELETE /:id                 | `requirePermissionInline(req,res,'agent:execute')`     | `requireProjectPermission(req,res,'session:delete')`            |
|                              | POST /:id/close             | `requirePermissionInline(req,res,'agent:execute')`     | `requireProjectPermission(req,res,'session:execute')`           |
|                              | POST /:id/reset             | `requirePermissionInline(req,res,'agent:execute')`     | `requireProjectPermission(req,res,'session:execute')`           |
|                              | GET /:id/traces             | none                                                   | `requireProjectPermission(req,res,'session:read')`              |
|                              | GET /:id/agent-spec         | none                                                   | `requireProjectPermission(req,res,'session:read')`              |
|                              | GET /:id/analysis           | none                                                   | `requireProjectPermission(req,res,'session:read')`              |
| **workflows.ts**             | POST /                      | `requirePermissionInline(req,res,'workflow:create')`   | `requireProjectPermission(req,res,'workflow:create')`           |
|                              | GET /                       | auth-only                                              | `requireProjectPermission(req,res,'workflow:read')`             |
|                              | GET /by-name                | auth-only                                              | `requireProjectPermission(req,res,'workflow:read')`             |
|                              | GET /:id                    | auth-only                                              | `requireProjectPermission(req,res,'workflow:read')`             |
|                              | PUT /:id                    | `requirePermissionInline(req,res,'workflow:update')`   | `requireProjectPermission(req,res,'workflow:update')`           |
|                              | POST /:id/archive           | `requirePermissionInline(req,res,'workflow:delete')`   | `requireProjectPermission(req,res,'workflow:delete')`           |
|                              | POST /:id/associate-session | `requirePermissionInline(req,res,'workflow:execute')`  | `requireProjectPermission(req,res,'workflow:execute')`          |
| **channel-connections.ts**   | POST /                      | `requirePermission('credential:write')` middleware     | `requireProjectPermission(req,res,'channel_connection:create')` |
|                              | GET /                       | `requirePermission('credential:read')` middleware      | `requireProjectPermission(req,res,'channel_connection:read')`   |
|                              | GET /:id                    | `requirePermission('credential:read')` middleware      | `requireProjectPermission(req,res,'channel_connection:read')`   |
|                              | PATCH /:id                  | `requirePermission('credential:write')` middleware     | `requireProjectPermission(req,res,'channel_connection:update')` |
|                              | DELETE /:id                 | `requirePermission('credential:delete')` middleware    | `requireProjectPermission(req,res,'channel_connection:delete')` |

### Redundant Code Removed

Handlers that previously called `findProjectByIdAndTenant` separately no longer need to — `requireProjectPermission` handles project existence verification. This removed duplicate DB queries from:

- `deployments.ts` POST /
- `project-agents.ts` GET /, GET /:agentName, PUT /:agentName/dsl
- `agent-model-config.ts` GET /, PUT /

### Unchanged Routes (Tenant-Scoped)

These routes are mounted at `/api/...` without a `:projectId` path parameter — they operate at the **tenant level**, not the project level. `requirePermissionInline` (tenant-level) is the correct check for these:

| Route File    | Mount Path      | Permission      | Reason                             |
| ------------- | --------------- | --------------- | ---------------------------------- |
| `contacts.ts` | `/api/contacts` | `agent:execute` | Contacts are tenant-wide resources |

**Why these stay tenant-level**: Project-level RBAC applies only to routes mounted under `/api/projects/:projectId/...` where a specific project context exists.

**Previously tenant-scoped, now project-scoped**: Sessions, workflows, and channel-connections were remounted under `/api/projects/:projectId/...` to enforce project isolation (all three have a `projectId` field in their DB models).

---

## Access Matrix

### By Project Role

| Permission                  | admin | developer                    | viewer |
| --------------------------- | ----- | ---------------------------- | ------ |
| `agent:read`                | yes   | yes (`agent:*`)              | yes    |
| `agent:update`              | yes   | yes (`agent:*`)              | **no** |
| `version:create`            | yes   | yes (`version:*`)            | **no** |
| `version:read`              | yes   | yes (`version:*`)            | yes    |
| `version:promote`           | yes   | yes (`version:*`)            | **no** |
| `deployment:create`         | yes   | **no**                       | **no** |
| `deployment:read`           | yes   | yes                          | yes    |
| `deployment:retire`         | yes   | **no**                       | **no** |
| `channel:create`            | yes   | **no**                       | **no** |
| `channel:read`              | yes   | yes                          | yes    |
| `channel:update`            | yes   | **no**                       | **no** |
| `channel:delete`            | yes   | **no**                       | **no** |
| `env_var:create`            | yes   | **no**                       | **no** |
| `env_var:read`              | yes   | yes                          | yes    |
| `env_var:update`            | yes   | **no**                       | **no** |
| `env_var:delete`            | yes   | **no**                       | **no** |
| `session:read`              | yes   | yes (`session:*`)            | yes    |
| `session:execute`           | yes   | yes (`session:*`)            | **no** |
| `session:delete`            | yes   | yes (`session:*`)            | **no** |
| `workflow:create`           | yes   | yes (`workflow:*`)           | **no** |
| `workflow:read`             | yes   | yes (`workflow:*`)           | yes    |
| `workflow:update`           | yes   | yes (`workflow:*`)           | **no** |
| `workflow:delete`           | yes   | yes (`workflow:*`)           | **no** |
| `workflow:execute`          | yes   | yes (`workflow:*`)           | **no** |
| `channel_connection:create` | yes   | yes (`channel_connection:*`) | **no** |
| `channel_connection:read`   | yes   | yes (`channel_connection:*`) | yes    |
| `channel_connection:update` | yes   | yes (`channel_connection:*`) | **no** |
| `channel_connection:delete` | yes   | yes (`channel_connection:*`) | **no** |

### By Actor Type

| Actor                        | Access Level                                               |
| ---------------------------- | ---------------------------------------------------------- |
| Tenant OWNER                 | All projects, all permissions (workspace authority)        |
| Tenant ADMIN                 | All projects, all permissions (`project:*` bypass)         |
| Project owner                | Full access to owned project (ownerId match)               |
| Project admin member         | Full access within project (`*:*`)                         |
| Project developer member     | Read all + write agents/versions                           |
| Project viewer member        | Read-only access                                           |
| Non-member (any tenant role) | **403 Forbidden** — "You are not a member of this project" |
| Unauthenticated              | **401 Unauthorized** — "Authentication required"           |

---

## Test Coverage

### Authorization Test Files (9 files, ~300+ tests)

Each file tests the full `requireProjectPermission` resolution chain with real middleware (not mocked):

| Test File                             | Route                    | Tests                                    |
| ------------------------------------- | ------------------------ | ---------------------------------------- |
| `channels-authz.test.ts`              | channels.ts              | 8 actor groups x 4 endpoints             |
| `deployments-authz.test.ts`           | deployments.ts           | 8 actor groups x 6 endpoints (48 tests)  |
| `versions-authz.test.ts`              | versions.ts              | 8 actor groups x 5 endpoints (40 tests)  |
| `project-agents-authz.test.ts`        | project-agents.ts        | 8 actor groups x 3 endpoints             |
| `agent-model-config-authz.test.ts`    | agent-model-config.ts    | 8 actor groups x 2 endpoints             |
| `environment-variables-authz.test.ts` | environment-variables.ts | 8 actor groups x 4 endpoints (32 tests)  |
| `sessions-authz.test.ts`              | sessions.ts              | 8 actor groups x 11 endpoints (88 tests) |
| `workflows-authz.test.ts`             | workflows.ts             | 8 actor groups x 7 endpoints (56 tests)  |
| `channel-connections-authz.test.ts`   | channel-connections.ts   | 8 actor groups x 5 endpoints (40 tests)  |

**Each test file covers these 8 actor groups:**

1. Tenant OWNER — workspace authority bypass
2. Tenant ADMIN — workspace authority bypass
3. Project owner — ownerId match
4. Project admin member — `*:*` wildcard
5. Project developer member — `agent:*`, `version:*`, read-only for rest
6. Project viewer member — read-only
7. Non-member — all 403
8. Unauthenticated — all 401

### Test Helper

**File**: `apps/runtime/src/__tests__/helpers/auth-context.ts`

Provides:

- `ROLE_PERMISSIONS` — tenant role permission mappings (mirrors seed-mongo.ts)
- `PROJECT_ROLE_PERMISSIONS` — project role permission mappings (mirrors rbac.ts)
- `makeTenantContext(tenantId, userId, role)` — creates test tenant context
- `injectTenantContext(ctx)` — Express middleware factory for test apps

### Updated Existing Tests

- `deployment-routes.test.ts` — added `requireProjectPermission` mock, removed redundant "project not found" test (now handled by RBAC)
- `deployment-promotion.test.ts` — added `requireProjectPermission` mock
- `version-routes.test.ts` — added `requireProjectPermission` mock, removed redundant "project not found" test

---

## Files Changed

| File                                                             | Change                                                                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/middleware/rbac.ts`                            | Added `requireProjectPermission()` + `PROJECT_ROLE_PERMISSIONS` with session/workflow/channel_connection permissions                               |
| `apps/runtime/src/routes/channels.ts`                            | Replaced `requireProjectOperation` with `requireProjectPermission`                                                                                 |
| `apps/runtime/src/routes/deployments.ts`                         | Replaced `requirePermissionInline` with `requireProjectPermission`, added to GET endpoints                                                         |
| `apps/runtime/src/routes/versions.ts`                            | Replaced `requirePermissionInline` with `requireProjectPermission`, added to GET endpoints                                                         |
| `apps/runtime/src/routes/project-agents.ts`                      | Replaced `requirePermissionInline` with `requireProjectPermission`, added to GET endpoints                                                         |
| `apps/runtime/src/routes/agent-model-config.ts`                  | Replaced `requirePermissionInline` with `requireProjectPermission`, added to GET endpoint                                                          |
| `apps/runtime/src/routes/environment-variables.ts`               | Replaced `requirePermission` middleware with inline `requireProjectPermission`                                                                     |
| `apps/runtime/src/routes/sessions.ts`                            | Remounted at `/api/projects/:projectId/sessions`, replaced `requirePermissionInline` with `requireProjectPermission`, added session:\* permissions |
| `apps/runtime/src/routes/workflows.ts`                           | Remounted at `/api/projects/:projectId/workflows`, replaced `requirePermissionInline` with `requireProjectPermission`                              |
| `apps/runtime/src/routes/channel-connections.ts`                 | Remounted at `/api/projects/:projectId/channel-connections`, replaced `requirePermission` middleware with inline `requireProjectPermission`        |
| `apps/runtime/src/server.ts`                                     | Updated mount paths for sessions, workflows, channel-connections                                                                                   |
| `apps/studio/src/middleware.ts`                                  | Updated runtime proxy: removed `/api/sessions` prefix, added project sub-paths                                                                     |
| `apps/studio/src/app/api/runtime/sessions/route.ts`              | Extract projectId from query, forward to project-scoped runtime URL                                                                                |
| `apps/studio/src/app/api/runtime/sessions/[id]/route.ts`         | Extract projectId from query, forward to project-scoped runtime URL                                                                                |
| `apps/studio/src/app/api/runtime/sessions/bulk-close/route.ts`   | Extract projectId from body, forward to project-scoped runtime URL                                                                                 |
| `apps/studio/src/app/api/runtime/sessions/[id]/close/route.ts`   | Extract projectId from query, forward to project-scoped runtime URL                                                                                |
| `apps/studio/src/hooks/useSessionDetail.ts`                      | Added `projectId` parameter, updated SWR key and traces fallback URL                                                                               |
| `apps/studio/src/components/session/SessionDetailPage.tsx`       | Pass `projectId` to `useSessionDetail`                                                                                                             |
| `apps/studio/src/components/chat/SessionSidebar.tsx`             | Added `projectId` to delete URL                                                                                                                    |
| `apps/studio/src/api/channel-connections.ts`                     | Updated URL construction to project-scoped paths, added `projectId` to function signatures                                                         |
| `apps/studio/src/components/deployments/channels/*.tsx`          | Updated channel-connection API call sites with `projectId` parameter                                                                               |
| `apps/runtime/src/__tests__/helpers/auth-context.ts`             | Updated `PROJECT_ROLE_PERMISSIONS` with session/workflow/channel_connection permissions                                                            |
| `apps/runtime/src/__tests__/channels-authz.test.ts`              | Rewritten for project-level RBAC                                                                                                                   |
| `apps/runtime/src/__tests__/deployments-authz.test.ts`           | Rewritten for project-level RBAC                                                                                                                   |
| `apps/runtime/src/__tests__/versions-authz.test.ts`              | Rewritten for project-level RBAC                                                                                                                   |
| `apps/runtime/src/__tests__/project-agents-authz.test.ts`        | Rewritten for project-level RBAC                                                                                                                   |
| `apps/runtime/src/__tests__/agent-model-config-authz.test.ts`    | Rewritten for project-level RBAC                                                                                                                   |
| `apps/runtime/src/__tests__/environment-variables-authz.test.ts` | New authz test file                                                                                                                                |
| `apps/runtime/src/__tests__/sessions-authz.test.ts`              | Rewritten for project-level RBAC                                                                                                                   |
| `apps/runtime/src/__tests__/workflows-authz.test.ts`             | Rewritten for project-level RBAC                                                                                                                   |
| `apps/runtime/src/__tests__/channel-connections-authz.test.ts`   | Rewritten for project-level RBAC                                                                                                                   |
| `apps/runtime/src/__tests__/deployment-routes.test.ts`           | Updated mock + removed redundant test                                                                                                              |
| `apps/runtime/src/__tests__/deployment-promotion.test.ts`        | Updated mock                                                                                                                                       |
| `apps/runtime/src/__tests__/version-routes.test.ts`              | Updated mock + removed redundant test                                                                                                              |

---

## Dependencies (unchanged, reused)

| File                                                 | Purpose                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `packages/shared/src/rbac/permission-resolver.ts`    | `hasPermission()` with wildcard matching                   |
| `packages/shared/src/middleware/permission-guard.ts` | `requireProjectScope()` for API key scoping (still needed) |
| `apps/runtime/src/repos/project-repo.ts`             | `findProjectByIdAndTenant()`, `findProjectMember()`        |

---

## Verification

```bash
pnpm build                        # Clean TypeScript compilation
pnpm --filter runtime test        # 200 files pass, 4818 tests pass
```

One pre-existing failure (`repos-session.test.ts` — MongoDB idempotency key) is unrelated.
