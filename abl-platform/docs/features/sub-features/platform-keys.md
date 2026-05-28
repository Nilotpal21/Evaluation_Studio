# Feature: Platform Keys Management

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflow Triggers](workflow-triggers.md) / [Auth Profiles](../auth-profiles.md)
**Status**: BETA
**Feature Area(s)**: `governance`, `project lifecycle`, `integrations`, `enterprise`
**Package(s)**: `apps/studio`, `packages/shared-auth`, `apps/runtime`
**Owner(s)**: Runtime Team
**Testing Guide**: [../../testing/sub-features/platform-keys.md](../../testing/sub-features/platform-keys.md)
**Last Updated**: 2026-04-12

---

## 1. Introduction / Overview

### Problem Statement

The platform has two API key models serving different purposes:

1. **PublicApiKey** (`pk_` prefix, `public_api_keys` collection) — designed for browser SDK access with `{ chat, voice }` permissions. Managed via Settings > API Keys (`ApiKeysTab.tsx`) through `/api/sdk/keys`.
2. **ApiKey** (`abl_` prefix, `api_keys` collection) — designed for server-to-server access with `scopes[]`, `projectIds[]`, `createdBy`, and `revokedAt`. The Mongoose model exists in `packages/database/src/models/api-key.model.ts` and is fully wired into `resolveApiKey()` in unified auth middleware.

**Phase 1 (DONE):** The CRUD UI and Studio API routes were built, enabling users to create, list, edit, and revoke platform keys with scopes `workflow:execute` and `workflow:read`.

**Phase 2 (current):** The scope system is underbuilt. Scopes are hardcoded to two values in `platform-key-utils.ts` and the Zod schemas. There is no:

- **Scope Registry** — a versioned, first-class catalog of what programmatic operations exist, shared between Studio and Runtime.
- **Creation-time Ceiling Check** — validation that the creating user's RBAC permissions cover the scopes being granted, preventing privilege escalation (e.g., a VIEWER creating a key with `agent:execute` scope).
- **Scope-Route Enforcement** — middleware that maps scopes to runtime API routes, ensuring a key with `workflow:execute` can only access workflow execution endpoints.
- **Expanded Scope Coverage** — scopes for agents, sessions, deployments, analytics, and other runtime API surfaces beyond workflows.

Without these, platform keys are a two-scope convenience feature, not a robust programmatic access system.

### Goal Statement

Upgrade platform keys from a hardcoded 2-scope system to a production-grade, four-layer scope architecture: **Scope Registry → Scope-Route Enforcement → Creation-time Ceiling → Project/Environment Isolation**. The scope registry is the public API contract for programmatic access; scopes are distinct from RBAC permissions.

### Summary

This feature expands the existing platform keys system with:

- A **Scope Registry** in `packages/shared-auth` — the versioned, single source of truth for all platform key scopes. Each scope maps to a description, a set of runtime API routes, and a set of RBAC permissions (used only for the ceiling check).
- A **Creation-time Ceiling Check** — when a user creates a key, the system verifies their RBAC permissions cover every scope being granted. A VIEWER cannot grant `agents.write`.
- **Scope-Route Enforcement** — scopes expand to RBAC permissions at `resolveApiKey` time, so existing `requirePermission` middleware works unchanged.
- An **expanded scope catalog** covering workflows, agents, sessions, deployments, analytics, and admin operations.

Phase 1 CRUD (create, list, edit, revoke) and UI remain unchanged — this phase adds architectural depth.

---

## 2. Scope

### Goals

- G1: ~~Provide a tabbed Settings > API Keys UI with "SDK Keys" and "Platform Keys" tabs~~ (DONE — Phase 1)
- G2: ~~Enable CRUD for `ApiKey` documents via Studio API routes at `/api/keys`~~ (DONE — Phase 1)
- G3: ~~Support predefined scope selection in the create flow~~ (DONE — Phase 1)
- G4: ~~Support optional key expiration (TTL) in the create flow~~ (DONE — Phase 1)
- G5: ~~Allow multi-project scoping when creating a key~~ (DONE — Phase 1)
- G6: ~~Show scope badges per key in the list view~~ (DONE — Phase 1)
- G7: ~~Unify workflow trigger key creation to use `/api/keys`~~ (DONE — Phase 1)
- G8: Define a scope registry as a first-class, versioned catalog in `packages/shared-auth`, shared by Studio and Runtime
- G9: Enforce creation-time ceiling — the creating user's RBAC permissions must cover all granted scopes
- G10: Expand scope-to-RBAC mapping so runtime `requirePermission` middleware enforces scopes transparently
- G11: Add scopes covering agents, sessions, deployments, analytics, and tenant admin operations
- G12: Update Studio CRUD routes and UI to use the shared scope registry instead of hardcoded values

### Non-Goals (Out of Scope)

- NG1: Reverse lookup ("Used by" column showing which triggers use a key) — trigger panel already shows key status per FR-24
- NG2: Tenant-wide key listing (keys with empty `projectIds`) — future tenant-admin feature
- NG3: Environment-scoped keys — `environments[]` defaults to `[]` until deployment-versioning feature lands
- NG4: Per-key rate limiting — uses existing tenant-level rate limiting
- NG5: Arbitrary free-text scopes — only scopes from the registry are accepted
- NG6: Pagination — platform keys per project are low-cardinality (tens, not thousands)
- NG7: Auto-pausing triggers when a key is revoked — trigger panel detects revoked keys
- NG8: OAuth2 client credentials grant — the platform already has outbound OAuth2 for auth profiles; adding an inbound authorization server is a separate effort
- NG9: Key rotation workflow — revoke + recreate is the current path (GAP-005)
- NG10: IP allowlisting per key
- NG11: Webhook signing keys
- NG12: Auto-revocation of keys when workspace is archived (document as gap; check `tenant.status` in `resolveApiKey` future fix)

---

## 3. User Stories

1. **US-1**: As a **Studio user**, I want to see separate tabs for "SDK Keys" and "Platform Keys" in Settings > API Keys so that I can distinguish between browser SDK keys and server-to-server API keys. _(DONE — Phase 1)_

2. **US-2**: As a **Studio user**, I want to create a platform API key with `workflow:execute` scope from the Settings page so that I can generate keys for workflow trigger integration without navigating to the triggers tab. _(DONE — Phase 1)_

3. **US-3**: As a **Studio user**, I want to see scope badges (e.g., `workflow:execute`) on each platform key in the list so that I can quickly identify what each key is authorized to do. _(DONE — Phase 1)_

4. **US-4**: As a **Studio user**, I want to revoke a platform API key from the Settings page and see a warning that active triggers may be affected so that I can make informed decisions about key lifecycle. _(DONE — Phase 1)_

5. **US-5**: As a **Studio user**, I want to set an expiration date when creating a platform key so that keys automatically become inactive after a defined period for security compliance. _(DONE — Phase 1)_

6. **US-6**: As a **Studio user**, I want to edit a platform key's name and scopes after creation so that I can adjust key metadata without creating a new key. _(DONE — Phase 1)_

7. **US-7**: As a **Studio user**, I want the webhook trigger auto-key creation to use the same platform key system so that all `abl_` keys are visible and manageable from a single place in Settings. _(DONE — Phase 1)_

8. **US-8**: As a **DevOps engineer**, I want to create a platform key scoped to `agents.read` + `deployments.write` and restricted to my staging project, so my CI/CD pipeline can deploy agents without full admin access.

9. **US-9**: As a **data analyst**, I want to create a read-only platform key with `sessions.read` + `analytics.read` scopes so my external dashboard can pull conversation metrics without being able to mutate any state.

10. **US-10**: As a **workspace admin**, I want the system to prevent a VIEWER-role user from creating a key with `agents.write` scope, so that platform keys cannot be used to escalate privileges.

11. **US-11**: As a **partner integrator**, I want a platform key that can only execute workflows via the Process API, so my backend can trigger workflows without accessing any other resources.

---

## 4. Functional Requirements

### Phase 1 — CRUD & UI (DONE)

| ID    | Requirement                                                                                                                                                                                                                                                                                                             | Priority | Status |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| FR-01 | The system must display a tabbed interface in Settings > API Keys with "SDK Keys" and "Platform Keys" tabs, using the existing `<Tabs>` component.                                                                                                                                                                      | P0       | DONE   |
| FR-02 | The "SDK Keys" tab must render the existing SDK key management UI with no behavior changes.                                                                                                                                                                                                                             | P0       | DONE   |
| FR-03 | The "Platform Keys" tab must list `ApiKey` documents filtered by `{ tenantId, projectIds: { $in: [currentProjectId] }, revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }` via `GET /api/keys?projectId=...`.                                                                                   | P0       | DONE   |
| FR-04 | Each key in the Platform Keys list must display: name, `abl_` prefix (monospace), scope badges, creation date, and expiration status.                                                                                                                                                                                   | P0       | DONE   |
| FR-05 | The system must expose `POST /api/keys` to create an `ApiKey` document with fields: `name`, `scopes` (from registry), `projectIds`, optional `expiresAt`. The route must generate a raw key with `abl_` prefix, SHA-256 hash it, store `prefix` (first 8 chars), set `clientId` to `plt-<uuidv7>`, and set `createdBy`. | P0       | DONE   |
| FR-06 | The raw key must be returned exactly once in the POST response and displayed in a one-time reveal modal.                                                                                                                                                                                                                | P0       | DONE   |
| FR-07 | The create dialog must present a multi-select checkbox for scopes from the scope registry. At least one scope must be selected.                                                                                                                                                                                         | P0       | DONE   |
| FR-08 | The create dialog must include an optional expiration picker with presets: "No expiration" (default), "30 days", "90 days", "Custom date".                                                                                                                                                                              | P1       | DONE   |
| FR-09 | The create dialog must allow selecting multiple projects for `projectIds` via a dropdown. The current project is pre-selected.                                                                                                                                                                                          | P1       | DONE   |
| FR-10 | The system must expose `PATCH /api/keys/:keyId` to update a key's `name` and `scopes`. Editing `projectIds` is not allowed (returns 400).                                                                                                                                                                               | P1       | DONE   |
| FR-11 | The system must expose `DELETE /api/keys/:keyId` to soft-revoke a key by setting `revokedAt: new Date()`.                                                                                                                                                                                                               | P0       | DONE   |
| FR-12 | The revoke action must show a confirmation dialog warning about active trigger impact.                                                                                                                                                                                                                                  | P0       | DONE   |
| FR-13 | The system must expose `GET /api/keys?projectId=...` to list active `ApiKey` documents for the given project, with a 100-item safety cap.                                                                                                                                                                               | P0       | DONE   |
| FR-14 | All `/api/keys` routes must use `requireAuth` + `requireSdkProjectAccess` for authorization, and follow the `withOpenAPI` + Zod schema pattern.                                                                                                                                                                         | P0       | DONE   |
| FR-15 | The `WebhookKeyCreationModal` must use `POST /api/keys` instead of `/api/sdk/keys`.                                                                                                                                                                                                                                     | P0       | DONE   |
| FR-16 | The `WebhookQuickStart` curl snippets must display `abl_` prefix.                                                                                                                                                                                                                                                       | P0       | DONE   |

### Phase 2 — Scope Architecture

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Priority | Status  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| FR-17 | The system must define a **Scope Registry** as a typed constant in `packages/shared-auth/src/scopes/platform-key-scopes.ts`, exported for use by both Studio and Runtime. Each scope entry must include: `scope` (dot-separated identifier), `label` (human-readable name), `description`, `category` (grouping for UI), and `requiredPermissions` (RBAC permissions needed for the ceiling check).                                                         | P0       | PLANNED |
| FR-18 | The scope registry must include scopes for at minimum these categories: **Execution** (`workflows.execute`, `workflows.read`, `chat.execute`), **Management** (`agents.read`, `agents.write`, `deployments.read`, `deployments.write`, `sessions.read`), **Analytics** (`analytics.read`), **Admin** (`tenant.read`). Each scope must map to verified RBAC permissions from `role-permissions.ts` — see the Scope-to-Permission Mapping table in Section 7. | P0       | PLANNED |
| FR-19 | The `POST /api/keys` route must perform a **creation-time ceiling check**: for each requested scope, the system must verify that the creating user's effective RBAC permissions (from `getPermissionCeiling(tenantRole)` and `hasPermission()`) cover the scope's `requiredPermissions`. If any scope exceeds the creator's ceiling, the request must be rejected with 403 and a structured error listing the denied scopes.                                | P0       | PLANNED |
| FR-20 | The `PATCH /api/keys/:keyId` route must also enforce the ceiling check when scopes are being updated. A user cannot add scopes beyond their RBAC ceiling.                                                                                                                                                                                                                                                                                                   | P0       | PLANNED |
| FR-21 | The scope registry must use **dot-separated** identifiers (`workflows.execute`, `agents.read`) to visually distinguish from colon-separated RBAC permissions (`workflow:execute`, `agent:read`). This prevents confusion between the two namespaces.                                                                                                                                                                                                        | P1       | PLANNED |
| FR-22 | Each scope in the registry must map to one or more RBAC permissions via a `requiredPermissions` array. At `resolveApiKey` time, the key's `scopes[]` must be expanded to their corresponding RBAC permissions before being set as `ctx.permissions`. This allows existing `requirePermission` middleware to enforce scopes without changes.                                                                                                                 | P0       | PLANNED |
| FR-23 | The Studio create/edit dialogs must dynamically render scope checkboxes from the shared scope registry, grouped by `category`. The current hardcoded `AVAILABLE_SCOPES` in `platform-key-utils.ts` and the Zod `z.enum()` in route schemas must be replaced with registry-driven validation.                                                                                                                                                                | P1       | PLANNED |
| FR-24 | The `resolveApiKey` implementation in `apps/runtime/src/repos/auth-repo.ts` must expand scopes to RBAC permissions using the shared scope registry. The expanded permissions must be returned as the `scopes` field in `ApiKeyRecord`, which flows to `ctx.permissions` in the unified auth middleware.                                                                                                                                                     | P0       | PLANNED |
| FR-25 | The system must expose `GET /api/keys/scopes` returning the full scope registry (scope, label, description, category) so the UI and API consumers can discover available scopes. This endpoint requires authentication but no specific role.                                                                                                                                                                                                                | P1       | PLANNED |

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                       |
| -------------------------- | ------------ | ----------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Keys are project-scoped via `projectIds`                    |
| Agent lifecycle            | SECONDARY    | Phase 2 adds `agents.read`/`agents.write` scopes            |
| Customer experience        | PRIMARY      | External developers use these keys for API access           |
| Integrations / channels    | PRIMARY      | CI/CD, analytics dashboards, partner backends consume keys  |
| Observability / tracing    | NONE         | No trace events from key management                         |
| Governance / controls      | PRIMARY      | Scope registry + ceiling check = governance over API access |
| Enterprise / compliance    | PRIMARY      | Ceiling check prevents privilege escalation via keys        |
| Admin / operator workflows | SECONDARY    | Key management in Settings                                  |

### Related Feature Integration Matrix

| Related Feature                           | Relationship Type | Why It Matters                                                                          | Key Touchpoints                                     | Current State |
| ----------------------------------------- | ----------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------- |
| [Workflow Triggers](workflow-triggers.md) | depends on        | Trigger keys are the first consumer; `WebhookKeyCreationModal` uses this feature's API  | `/api/keys`, `WebhookKeyCreationModal.tsx`          | BETA          |
| [Auth Profiles](../auth-profiles.md)      | shares data with  | Both are auth-related; platform keys use the same unified auth middleware               | `resolveApiKey()`, `createUnifiedAuthMiddleware`    | STABLE        |
| [Rate Limiting](../rate-limiting.md)      | configured by     | Platform key API calls are rate-limited at tenant level                                 | `tenantRateLimit('request')`                        | BETA          |
| Custom Roles                              | shares data with  | Ceiling check uses `getPermissionCeiling(tenantRole)` from the same RBAC system         | `packages/shared-auth/src/rbac/role-permissions.ts` | BETA          |
| RBAC / Permission System                  | depends on        | Scope-to-permission expansion means scopes flow through the same `hasPermission` checks | `requirePermission`, `evaluateProjectPermission`    | STABLE        |

---

## 6. Design Considerations

### Scope Naming: Dots vs Colons

Platform key scopes use **dot-separated** identifiers (`workflows.execute`), while RBAC permissions use **colon-separated** identifiers (`workflow:execute`). This is intentional:

- Scopes are a **public API contract** — stable, versioned, documented in OpenAPI.
- RBAC permissions are an **internal implementation detail** — can change in refactors.
- The visual distinction prevents accidental conflation in code, logs, and documentation.
- The scope-to-permission mapping is explicit and auditable: `workflows.execute → ['workflow:read', 'workflow:execute']`.

### Scope Categories (UI Grouping)

The create dialog organizes scopes by category:

```
Execution
  ☑ workflows.execute  — Execute workflows via Process API
  ☐ workflows.read     — Read workflow definitions
  ☐ chat.execute       — Send messages to agents via Chat API

Management
  ☐ agents.read        — List and inspect agent configurations
  ☐ agents.write       — Create and update agents
  ☐ deployments.read   — List deployments
  ☐ deployments.write  — Create and promote deployments
  ☐ sessions.read      — Read session history and transcripts

Analytics
  ☐ analytics.read     — Read analytics and metrics

Admin
  ☐ tenant.read        — Read workspace settings and usage
```

Scopes unavailable to the current user (ceiling check) are shown as disabled with a tooltip: "Your role does not have the required permissions for this scope."

---

## 7. Technical Considerations

### Scope-to-Permission Mapping (Verified)

Every scope maps to RBAC permissions that exist in `packages/shared-auth/src/rbac/role-permissions.ts`. The `requiredPermissions` array is used for both the creation-time ceiling check AND the runtime scope expansion (they are the same set — a scope grants exactly the permissions required to use it).

| Scope               | Category   | requiredPermissions (verified against role-permissions.ts) | Minimum Tenant Role                                                                                                         |
| ------------------- | ---------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `workflows.execute` | execution  | `['workflow:read', 'workflow:execute']`                    | OPERATOR (L66-67)                                                                                                           |
| `workflows.read`    | execution  | `['workflow:read']`                                        | VIEWER (L104)                                                                                                               |
| `chat.execute`      | execution  | `['agent:execute', 'session:send_message']`                | OWNER only (`session:send_message` not in any standard tenant role; OWNER matches via `*:*`)                                |
| `agents.read`       | management | `['agent:read']`                                           | VIEWER (L100)                                                                                                               |
| `agents.write`      | management | `['agent:read', 'agent:create', 'agent:update']`           | ADMIN (L44, via `agent:*`; MEMBER lacks `agent:create`)                                                                     |
| `deployments.read`  | management | `['deployment:read']`                                      | VIEWER (L105)                                                                                                               |
| `deployments.write` | management | `['deployment:read', 'deployment:create']`                 | OPERATOR (L69-70)                                                                                                           |
| `sessions.read`     | management | `['session:read']`                                         | OWNER only (`session:read` not in any standard tenant role; exists in project roles L172)                                   |
| `analytics.read`    | analytics  | `['analytics:read']`                                       | OWNER only (`analytics:read` not in any standard tenant role; exists in project tester L163 and custom role allowlist L313) |
| `tenant.read`       | admin      | `['tenant:read']`                                          | VIEWER (L98)                                                                                                                |

**Notes:**

- `chat.execute` maps to `agent:execute` + `session:send_message` because the Chat API requires executing an agent within a session context. There is no `chat:execute` RBAC permission.
- `agents.write` maps to `agent:read` + `agent:create` + `agent:update` (not `agent:write`, which doesn't exist in RBAC). Note: `agent:create` is only in ADMIN (L44 via `agent:*`), not MEMBER — so MEMBER cannot grant `agents.write` scope. This is correct: creating agents is an admin-level operation.
- `deployments.write` maps to `deployment:read` + `deployment:create` (not `deployment:write`, which doesn't exist in RBAC).
- `analytics.read` appears only in `VALID_CUSTOM_ROLE_PERMISSIONS` (L313) and project tester role (L163), not in any tenant role. Only OWNER (via `*:*` wildcard) passes the ceiling check. This is a consequence of GAP-012 (tenant-only ceiling).
- `chat.execute` and `sessions.read` are similarly OWNER-gated because `session:send_message` and `session:read` are not in any standard tenant role. These three scopes will become more broadly available when GAP-012 is addressed (project-level ceiling refinement).

### Four-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: SCOPE REGISTRY                                            │
│  packages/shared-auth/src/scopes/platform-key-scopes.ts             │
│                                                                     │
│  PLATFORM_KEY_SCOPES = {                                            │
│    'workflows.execute': {                                           │
│      label: 'Execute Workflows',                                    │
│      description: 'Execute workflows via Process API',              │
│      category: 'execution',                                         │
│      requiredPermissions: ['workflow:read', 'workflow:execute'],     │
│    },                                                               │
│    ...                                                              │
│  }                                                                  │
│                                                                     │
│  Consumers: Studio (creation UI, validation), Runtime (expansion)   │
└──────────────────┬──────────────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────────────┐
│  Layer 2: SCOPE-ROUTE ENFORCEMENT                                   │
│  apps/runtime/src/repos/auth-repo.ts (resolveApiKey)                │
│                                                                     │
│  On resolve: expand key.scopes → RBAC permissions                   │
│    ['workflows.execute'] → ['workflow:read', 'workflow:execute']     │
│                                                                     │
│  Set as ctx.permissions → existing requirePermission() works        │
│  No per-route changes needed.                                       │
└──────────────────┬──────────────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────────────┐
│  Layer 3: CREATION-TIME CEILING                                     │
│  apps/studio/src/app/api/keys/route.ts (POST handler)               │
│  apps/studio/src/app/api/keys/[keyId]/route.ts (PATCH handler)      │
│                                                                     │
│  Before creating/updating a key:                                    │
│    creatorCeiling = getPermissionCeiling(user.tenantRole)           │
│    for each scope in requestedScopes:                               │
│      for each perm in scope.requiredPermissions:                    │
│        if !hasPermission(creatorCeiling, perm): REJECT 403         │
│                                                                     │
│  ONLY RBAC touchpoint — scopes and RBAC are otherwise independent.  │
└──────────────────┬──────────────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────────────┐
│  Layer 4: PROJECT/ENVIRONMENT ISOLATION                              │
│  Existing — no changes needed                                       │
│                                                                     │
│  key.projectIds[] restricts to specific projects                    │
│  key.environments[] restricts to specific environments (future)     │
│  Enforced in runtime RBAC middleware (projectScope, envScope check)  │
└─────────────────────────────────────────────────────────────────────┘
```

### Studio Changes (Phase 2)

- Replace hardcoded `AVAILABLE_SCOPES` in `platform-key-utils.ts` with import from `packages/shared-auth`
- Replace hardcoded `z.enum(['workflow:execute', 'workflow:read'])` in Zod schemas with registry-driven validation
- Add ceiling check to POST and PATCH handlers
- Update `PlatformKeysTab` to render scopes grouped by category from the registry

### Runtime Changes (Phase 2)

- Update `resolveApiKey` in `auth-repo.ts` to expand scopes → RBAC permissions using the scope registry
- No route-level changes — existing `requirePermission` middleware handles enforcement

### Backwards Compatibility

Existing keys store colon-separated scopes (`workflow:execute`, `workflow:read`) in their `scopes[]` field. These currently pass through to `ctx.permissions` verbatim, which works because runtime routes check `hasPermission(ctx.permissions, 'workflow:execute')`.

After Phase 2, the `resolveApiKey` expansion function uses this algorithm:

1. For each scope in `key.scopes[]`:
   a. **If it's a dot-separated registry key** (e.g., `workflows.execute`): expand via the registry's `requiredPermissions` array → `['workflow:read', 'workflow:execute']`
   b. **If it's a colon-separated string** (e.g., `workflow:execute`): pass through as-is (it's already an RBAC permission)
   c. **If neither matches**: log a warning and skip (fail-closed — unknown scopes grant no permissions)
2. Deduplicate the combined permission set.
3. Return as `scopes` in `ApiKeyRecord`.

This ensures:

- Existing keys with `workflow:execute` continue to work unchanged (case b).
- New keys with `workflows.execute` get the expanded permission set (case a).
- No database migration needed — both formats coexist in the same `scopes[]` field.
- Over time, as keys are rotated/recreated, the codebase naturally migrates to dot-separated scopes.

---

## 8. How to Consume

### Studio UI

- **Settings > API Keys > Platform Keys tab**: List, create, edit, and revoke platform API keys scoped to the current project. Scopes are grouped by category in the create/edit dialogs. Scopes beyond the user's RBAC ceiling are shown as disabled.
- **Workflow Triggers > Webhook panel**: `WebhookKeyCreationModal` uses the same `/api/keys` route to create keys with `workflows.execute` scope. Created keys are visible in both the triggers panel and the Platform Keys tab.

### API (Runtime)

Platform keys are consumed by runtime routes via `Authorization: Bearer abl_...`. The unified auth middleware resolves the key, expands scopes to RBAC permissions, and sets `ctx.permissions`. Routes enforce access via existing `requirePermission()`.

| Method | Path                            | Scope Required      | Purpose                  |
| ------ | ------------------------------- | ------------------- | ------------------------ |
| POST   | `/api/v1/process/:workflowId`   | `workflows.execute` | Execute workflow via API |
| POST   | `/api/v1/chat/agent`            | `chat.execute`      | Send chat message        |
| GET    | `/api/projects/:id/agents`      | `agents.read`       | List agents              |
| POST   | `/api/projects/:id/agents`      | `agents.write`      | Create/update agent      |
| GET    | `/api/projects/:id/sessions`    | `sessions.read`     | List sessions            |
| GET    | `/api/projects/:id/deployments` | `deployments.read`  | List deployments         |
| POST   | `/api/projects/:id/deployments` | `deployments.write` | Create deployment        |
| GET    | `/api/projects/:id/analytics`   | `analytics.read`    | Read analytics           |
| GET    | `/api/tenants/:id/usage`        | `tenant.read`       | Read tenant usage        |

### API (Studio)

| Method | Path                             | Auth                                   | Purpose                                    |
| ------ | -------------------------------- | -------------------------------------- | ------------------------------------------ |
| GET    | `/api/keys?projectId=:projectId` | JWT + `requireSdkProjectAccess(read)`  | List active platform keys for project      |
| POST   | `/api/keys`                      | JWT + `requireSdkProjectAccess(write)` | Create platform key (returns raw key once) |
| PATCH  | `/api/keys/:keyId`               | JWT + `requireSdkProjectAccess(write)` | Update key name and/or scopes              |
| DELETE | `/api/keys/:keyId`               | JWT + `requireSdkProjectAccess(write)` | Soft-revoke key (sets `revokedAt`)         |
| GET    | `/api/keys/scopes`               | JWT (any authenticated user)           | List available scopes from registry        |

### Admin Portal

N/A — tenant-wide key management is out of scope (NG2).

### Channel / SDK / Voice / A2A / MCP Integration

Platform keys are channel-agnostic. Any system that can send `Authorization: Bearer abl_...` can use a platform key. This feature manages the key lifecycle and scope system; consumption happens via runtime auth middleware.

---

## 9. Data Model

### Collections / Tables

**Existing — No Schema Changes Required:**

```text
Collection: api_keys (existing, managed by packages/database/src/models/api-key.model.ts)
Fields:
  - _id: string (UUIDv7, default)
  - tenantId: string (required, indexed)
  - name: string (required)
  - clientId: string (required, unique per tenant)
  - keyHash: string (SHA-256 hex, unique index)
  - prefix: string (first 8 chars of raw key, e.g., "abl_a1b2")
  - scopes: string[] (e.g., ["workflows.execute", "workflows.read"])
  - projectIds: string[] (project IDs this key can access)
  - environments: string[] (default: [])
  - expiresAt: Date | null
  - lastUsedAt: Date | null
  - createdBy: string (required, authenticated user's ID)
  - revokedAt: Date | null
  - _v: number (default: 1)
  - createdAt: Date (auto, timestamps)
  - updatedAt: Date (auto, timestamps)
Plugins: tenantIsolationPlugin, auditTrailPlugin
Indexes:
  - { keyHash: 1 } (unique)
  - { tenantId: 1, clientId: 1 } (unique)
  - { tenantId: 1 }
  - { prefix: 1 }
```

No new collections, no schema migrations. Scope strings change from colon-separated (`workflow:execute`) to dot-separated (`workflows.execute`) for new keys. The `resolveApiKey` expansion handles both formats for backwards compatibility.

### Key Relationships

- `ApiKey.projectIds[]` contains the projects this key can access
- `ApiKey.createdBy` links to the user who created the key
- `ApiKey.tenantId` enforced by `tenantIsolationPlugin`
- `ApiKey.scopes[]` references entries in the scope registry (`PLATFORM_KEY_SCOPES`)
- `TriggerRegistration.config.apiKeyId` (from workflow-triggers spec) links back to `ApiKey._id`

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                     | Purpose                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/database/src/models/api-key.model.ts`          | Existing `ApiKey` Mongoose model (no changes)                          |
| `packages/shared-auth/src/scopes/platform-key-scopes.ts` | **NEW** — Scope registry: scope definitions, categories, RBAC mappings |
| `packages/shared-auth/src/scopes/scope-validation.ts`    | **NEW** — Scope validation, ceiling check, scope expansion utilities   |
| `packages/shared-auth/src/scopes/index.ts`               | **NEW** — Public exports for scope registry                            |
| `apps/studio/src/app/api/keys/platform-key-utils.ts`     | Modify — replace hardcoded `AVAILABLE_SCOPES` with registry import     |

### Routes / Handlers

| File                                            | Purpose                                                         |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `apps/studio/src/app/api/keys/route.ts`         | Modify — add ceiling check to POST, replace hardcoded Zod enum  |
| `apps/studio/src/app/api/keys/[keyId]/route.ts` | Modify — add ceiling check to PATCH, replace hardcoded Zod enum |
| `apps/studio/src/app/api/keys/scopes/route.ts`  | **NEW** — GET /api/keys/scopes (returns scope registry)         |

### Runtime Integration

| File                                            | Purpose                                                       |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `apps/runtime/src/repos/auth-repo.ts`           | Modify — expand scopes to RBAC permissions in `resolveApiKey` |
| `apps/search-ai/src/middleware/auth.ts`         | Modify — expand scopes in SearchAI's `resolveApiKey`          |
| `apps/search-ai-runtime/src/middleware/auth.ts` | Modify — expand scopes in SearchAI-Runtime's `resolveApiKey`  |
| `apps/workflow-engine/src/index.ts`             | Modify — expand scopes in Workflow Engine's `resolveApiKey`   |

### UI Components

| File                                                      | Purpose                                                  |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `apps/studio/src/components/settings/PlatformKeysTab.tsx` | Modify — render scopes grouped by category from registry |

### Tests

| File                                                             | Type        | Coverage Focus                                                                           |
| ---------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/platform-keys-api.test.ts`            | integration | Phase 1 INT-1 through INT-10 (DONE) + Phase 2 ceiling check, registry validation         |
| `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts`        | e2e         | Phase 1 E2E-1 through E2E-10 (DONE) + Phase 2 ceiling enforcement, scope expansion       |
| `apps/studio/src/__tests__/platform-keys-unit.test.ts`           | unit        | Phase 1 UT-1 through UT-4 (DONE) + Phase 2 scope expansion, ceiling check pure functions |
| `packages/shared-auth/src/__tests__/platform-key-scopes.test.ts` | unit        | **NEW** — Scope registry validation, expansion, ceiling check                            |

---

## 11. Configuration

### Environment Variables

No new environment variables.

### Runtime Configuration

- **Scope Registry**: Defined as a typed constant in `packages/shared-auth/src/scopes/platform-key-scopes.ts`. Adding a new scope requires a code change — this is intentional (scopes are a versioned API contract, not a dynamic configuration).
- **Expiration presets**: Hardcoded as `[null, 30, 90, 'custom']` days.

### DSL / Agent IR / Schema

N/A — this is a platform infrastructure feature with no DSL or IR involvement.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | `GET /api/keys` filters by `{ projectIds: { $in: [projectId] } }`. Keys for other projects are invisible. Cross-project access returns empty list, not 403.                                                                                                     |
| Tenant isolation  | All queries include `tenantId`. The `ApiKey` model uses `tenantIsolationPlugin`. Cross-tenant access returns 404.                                                                                                                                               |
| User isolation    | Keys are created with `createdBy: userId`. All users with project write access can see and manage keys for that project. The ceiling check adds per-user restriction on scope granting — a VIEWER cannot create a key with scopes beyond their own permissions. |

### Security & Compliance

- **Key hashing**: Raw keys are SHA-256 hashed before storage. Only the hash is persisted; raw key returned once.
- **Scope validation**: Only scopes from the registry are accepted. Zod schema is generated from registry keys.
- **Ceiling check**: Prevents privilege escalation — key scopes cannot exceed the creator's RBAC permissions. This is the critical security addition in Phase 2.
- **No raw key retrieval**: After creation, the raw key cannot be retrieved.
- **Scope expansion**: At runtime, scopes expand to RBAC permissions. A key with `agents.read` scope gets only `['agent:read']` — never more.

### Performance & Scalability

- **Scope expansion**: In-memory map lookup at `resolveApiKey` time. No DB queries, sub-microsecond.
- **Ceiling check**: In-memory `hasPermission` check against `getPermissionCeiling()`. No DB queries.
- **Registry endpoint**: Returns a static constant. Sub-1ms.

### Reliability & Failure Modes

- **Unknown scope in DB**: If a key has a scope that no longer exists in the registry (removed in a future version), `resolveApiKey` should log a warning and skip the unknown scope. Fail-open for expansion, fail-closed for enforcement (unknown scopes grant no permissions).
- **Backwards compatibility**: Keys created with colon-separated scopes (`workflow:execute`) are handled by a migration mapping in the expansion function.

### Observability

- **Logging**: `createLogger('platform-keys')` for route handlers. Ceiling check rejections logged at WARN level with the denied scopes and user role.
- **Audit trail**: `auditTrailPlugin` on the `ApiKey` model.
- **No trace events**: Key management is a settings operation.

### Data Lifecycle

- **No TTL index**: Expired keys remain in collection (they fail auth at runtime). Cleanup via manual revocation.
- **Revoked keys**: Preserved indefinitely for audit trail.
- **Scope migration**: Existing keys with colon-separated scopes (`workflow:execute`) remain valid. The expansion function handles both formats.

---

## 13. Delivery Plan / Work Breakdown

### Phase 1 — CRUD & UI (DONE)

1. **Studio API Routes (`/api/keys`)**
   1.1. ~~GET (list) and POST (create) handlers~~ (DONE)
   1.2. ~~PATCH (edit) and DELETE (revoke) handlers~~ (DONE)
   1.3. ~~Key generation: `abl_` prefix, SHA-256 hash, `plt-<uuid>` clientId~~ (DONE)

2. **Settings UI — Tabbed Layout**
   2.1. ~~`ApiKeysTab.tsx` with Tabs component~~ (DONE)
   2.2. ~~`PlatformKeysTab.tsx` with list view~~ (DONE)

3. **Platform Keys — Create/Edit/Revoke Flows**
   3.1. ~~Create dialog, reveal modal, edit dialog, revoke confirmation~~ (DONE)

4. **Workflow Triggers UI Update**
   4.1. ~~Switch `WebhookKeyCreationModal` to `/api/keys`~~ (DONE)

5. **Phase 1 Testing**
   5.1. ~~Integration + E2E + Unit tests~~ (DONE)

### Phase 2 — Scope Architecture

6. **Scope Registry (`packages/shared-auth`)**
   6.1. Create `packages/shared-auth/src/scopes/platform-key-scopes.ts` with `PLATFORM_KEY_SCOPES` constant
   6.2. Create `packages/shared-auth/src/scopes/scope-validation.ts` with `validateScopes()`, `expandScopesToPermissions()`, `checkScopeCeiling()` utilities
   6.3. Create `packages/shared-auth/src/scopes/index.ts` with public exports
   6.4. Unit tests for all scope utilities in `packages/shared-auth/src/__tests__/platform-key-scopes.test.ts`
   6.5. Create `packages/shared-auth/agents.md` with learnings about the scope registry pattern

7. **Studio Route Updates**
   7.1. Replace hardcoded `AVAILABLE_SCOPES` and Zod `z.enum()` with registry-driven validation
   7.2. Add ceiling check to POST handler (reject 403 if creator lacks required permissions)
   7.3. Add ceiling check to PATCH handler (same logic)
   7.4. Create `GET /api/keys/scopes` endpoint returning the scope registry
   7.5. Update `platform-key-utils.ts` to import from shared-auth instead of local constant

8. **Runtime Scope Expansion**
   8.1. Update `resolveApiKey` in `apps/runtime/src/repos/auth-repo.ts` to expand scopes → RBAC permissions
   8.2. Update SearchAI, SearchAI-Runtime, and Workflow Engine `resolveApiKey` callbacks
   8.3. Add backwards compatibility for colon-separated legacy scopes

9. **UI Updates**
   9.1. Update `PlatformKeysTab.tsx` to render scope checkboxes grouped by category
   9.2. Disable scopes that exceed the current user's ceiling (with tooltip)
   9.3. Fetch available scopes from `/api/keys/scopes` on dialog open

10. **Phase 2 Testing**
    10.1. E2E: Ceiling check enforcement (VIEWER blocked from granting `agents.write`)
    10.2. E2E: Scope expansion verified end-to-end (create key → use at runtime → verify permissions)
    10.3. Integration: Registry-driven validation rejects unknown scopes
    10.4. Integration: Backwards compatibility for legacy colon-separated scopes
    10.5. Unit: `expandScopesToPermissions()`, `checkScopeCeiling()`, registry completeness

---

## 14. Success Metrics

| Metric                                 | Baseline                 | Target                                              | How Measured                                             |
| -------------------------------------- | ------------------------ | --------------------------------------------------- | -------------------------------------------------------- |
| Platform keys created via Settings UI  | 0                        | 10+ keys/week                                       | Count `ApiKey` docs with `clientId` starting with `plt-` |
| Scope categories used beyond workflows | 0                        | 3+ categories (agents, sessions, analytics)         | Distinct scope prefixes in `ApiKey.scopes[]`             |
| Ceiling check rejections               | N/A                      | < 5% of creation attempts                           | WARN logs from ceiling check                             |
| Platform keys authenticated at runtime | (workflow triggers only) | 50+ authentications/day across multiple scope types | `lastUsedAt` updates in `api_keys`                       |

---

## 15. Open Questions

1. ~~Should there be a "Regenerate" action that revokes the old key and creates a new one with the same name/scopes/projects in a single operation?~~ (Deferred — GAP-005)
2. ~~When new scope categories are added, should the scope list be fetched from a configuration endpoint rather than hardcoded?~~ **RESOLVED: Phase 2 adds `GET /api/keys/scopes` endpoint AND keeps the registry as a code constant. The endpoint serves the registry; the constant is the source of truth.**
3. Should the Platform Keys tab show revoked keys in a separate "Revoked" section (for audit visibility), or keep them fully hidden?
4. Should scope expansion in `resolveApiKey` be cached per key (since scopes don't change at runtime), or is the in-memory map lookup fast enough to not warrant caching?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                    | Severity | Status                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GAP-001 | No "Used by" reverse lookup from key to triggers/consumers                                                                                                                     | Low      | Open — deferred to follow-up                                                                                                                                                   |
| GAP-002 | No tenant-wide key listing for admin users                                                                                                                                     | Medium   | Open — separate tenant-admin feature                                                                                                                                           |
| GAP-003 | No environment-scoped keys                                                                                                                                                     | Low      | Open — blocked by deployment-versioning feature                                                                                                                                |
| GAP-004 | Expired keys remain in collection without TTL index cleanup                                                                                                                    | Low      | Open — manual revocation is current cleanup path                                                                                                                               |
| GAP-005 | No key rotation workflow (revoke + recreate with same config)                                                                                                                  | Low      | Open — see Open Question #1                                                                                                                                                    |
| GAP-006 | No `{ tenantId: 1, projectIds: 1, revokedAt: 1 }` compound index for optimal list query                                                                                        | Low      | Open — acceptable for low cardinality                                                                                                                                          |
| GAP-007 | Error response format uses `{ error: 'string' }` instead of `{ success, error: { code, message } }`                                                                            | Low      | Deferred — matches existing SDK keys pattern                                                                                                                                   |
| GAP-008 | No rate limiting on POST /api/keys                                                                                                                                             | Medium   | Deferred — to platform-level rate limiting                                                                                                                                     |
| GAP-009 | UI doesn't check `res.ok` before showing success toast                                                                                                                         | Low      | Deferred — matches existing component patterns                                                                                                                                 |
| GAP-010 | Keys not auto-revoked/suspended when workspace is archived                                                                                                                     | Medium   | Open — keys authenticate but most routes fail at project access level. Future fix: check `tenant.status` in `resolveApiKey`.                                                   |
| GAP-011 | Legacy keys with colon-separated scopes (`workflow:execute`) need backwards-compatible expansion                                                                               | Medium   | Planned — Phase 2 expansion function handles both formats (see Backwards Compatibility in Section 7)                                                                           |
| GAP-012 | Ceiling check only considers tenant-level roles, not project-level roles. A VIEWER tenant member with project ADMIN role is denied scopes that their project role would allow. | Medium   | Accepted — tenant ceiling is a safe default; project-level refinement deferred. Tenant ADMIN/OWNER covers all scopes; project-level ceiling is an optimization for edge cases. |

---

## 17. Testing & Validation

### Required Test Coverage

#### Phase 1 (DONE)

| #   | Scenario                                                                      | Coverage Type | Status  | Test File / Note    |
| --- | ----------------------------------------------------------------------------- | ------------- | ------- | ------------------- |
| 1   | Create platform key via POST /api/keys, verify `abl_` prefix and SHA-256 hash | integration   | PASSING | INT-1, INT-3        |
| 2   | List platform keys filtered by projectId, revoked, expired                    | integration   | PASSING | INT-2               |
| 3   | Edit key name and scopes via PATCH, verify projectIds immutable               | integration   | PASSING | INT-3               |
| 4   | Revoke key via DELETE, verify soft-delete and list exclusion                  | integration   | PASSING | INT-4               |
| 5   | Cross-tenant key access returns 404                                           | e2e           | PASSING | E2E-3               |
| 6   | Cross-project key access returns empty list                                   | e2e           | PASSING | E2E-4               |
| 7   | Full create-list-edit-revoke flow via HTTP with JWT auth                      | e2e           | PASSING | E2E-1, E2E-2, E2E-6 |
| 8   | Scope validation rejects unknown scopes with 400                              | e2e           | PASSING | E2E-5               |
| 9   | Expired key excluded from list                                                | e2e           | PASSING | E2E-7               |
| 10  | WebhookKeyCreationModal creates `ApiKey` via `/api/keys`                      | e2e           | PASSING | E2E-9               |

#### Phase 2 (PLANNED)

| #   | Scenario                                                                                          | Coverage Type | Status  | Test File / Note                |
| --- | ------------------------------------------------------------------------------------------------- | ------------- | ------- | ------------------------------- |
| 11  | Scope registry validation: all scopes have label, description, category, requiredPermissions      | unit          | PLANNED | `platform-key-scopes.test.ts`   |
| 12  | `expandScopesToPermissions()` correctly maps scopes to RBAC permissions                           | unit          | PLANNED | `platform-key-scopes.test.ts`   |
| 13  | `checkScopeCeiling()` rejects scopes beyond creator's role permissions                            | unit          | PLANNED | `platform-key-scopes.test.ts`   |
| 14  | Backwards compatibility: colon-separated legacy scopes expand correctly                           | unit          | PLANNED | `platform-key-scopes.test.ts`   |
| 15  | Unknown scopes expand to empty permissions (fail-closed)                                          | unit          | PLANNED | `platform-key-scopes.test.ts`   |
| 16  | POST /api/keys with ceiling violation returns 403 with denied scope details                       | e2e           | PLANNED | `platform-keys-api.e2e.test.ts` |
| 17  | VIEWER cannot create key with `agents.write` scope (ceiling enforcement)                          | e2e           | PLANNED | `platform-keys-api.e2e.test.ts` |
| 18  | ADMIN can create key with all non-admin scopes                                                    | e2e           | PLANNED | `platform-keys-api.e2e.test.ts` |
| 19  | PATCH with ceiling violation on new scopes returns 403                                            | e2e           | PLANNED | `platform-keys-api.e2e.test.ts` |
| 20  | GET /api/keys/scopes returns full registry                                                        | integration   | PLANNED | `platform-keys-api.test.ts`     |
| 21  | Registry-driven Zod validation rejects unknown scopes                                             | integration   | PLANNED | `platform-keys-api.test.ts`     |
| 22  | Runtime scope expansion: key with `agents.read` scope can access GET /agents but not POST /agents | e2e           | PLANNED | Cross-system test               |
| 23  | Legacy key with `workflow:execute` still authenticates after expansion migration                  | e2e           | PLANNED | Backwards compat test           |

### Testing Notes

Phase 1 tests exercise real HTTP endpoints with auth middleware. No mocking of `ApiKey` model or `requireSdkProjectAccess`. Phase 2 tests must additionally verify:

- Ceiling check against real RBAC role resolution (not mocked roles)
- Scope expansion in runtime's `resolveApiKey` (cross-system E2E if feasible)
- Backwards compatibility with existing keys

> Full testing details: [../../testing/sub-features/platform-keys.md](../../testing/sub-features/platform-keys.md)

---

## 18. References

- Parent feature spec: [Workflow Triggers](workflow-triggers.md) (FR-01, FR-19, FR-21-24)
- ApiKey model: `packages/database/src/models/api-key.model.ts`
- Existing SDK keys route: `apps/studio/src/app/api/sdk/keys/route.ts`
- Existing Studio CRUD: `apps/studio/src/app/api/keys/route.ts`, `apps/studio/src/app/api/keys/[keyId]/route.ts`
- Scope utilities: `apps/studio/src/app/api/keys/platform-key-utils.ts`
- RBAC permissions: `packages/shared-auth/src/rbac/role-permissions.ts`
- Permission ceiling: `getPermissionCeiling()` in `packages/shared-auth/src/rbac/role-permissions.ts:432`
- Runtime auth: `apps/runtime/src/repos/auth-repo.ts` (`resolveApiKey`)
- Unified auth middleware: `packages/shared-auth/src/middleware/unified-auth.ts`
- HLD: `docs/specs/platform-keys.hld.md`
- Test spec: `docs/testing/sub-features/platform-keys.md`
