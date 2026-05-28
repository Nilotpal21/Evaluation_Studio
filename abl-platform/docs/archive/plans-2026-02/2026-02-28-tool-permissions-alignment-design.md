# Tool Permissions Alignment Design

**Date**: 2026-02-28
**Status**: Approved
**Branch**: lambda-support

## Problem

Tool and MCP permissions are misaligned across three layers:

1. **Seed data** (`seed-mongo.ts`) defines `tool:create`/`tool:update`/`tool:manage_secrets` — but Studio routes enforce `tool:write`/`tool:delete` which don't exist in seed data.
2. **MCP has separate permissions** (`mcp:read`/`mcp:write`/`mcp:delete`) but MCP servers are just another tool type — separate permissions add complexity with no benefit.
3. **Project-level roles** (`PROJECT_ROLE_PERMISSIONS`) have no tool permissions at all — only `admin` (`*:*`) gets tool access.
4. **Built-in fallback** (`BUILTIN_ROLE_PERMISSIONS`) lacks tool permissions for OPERATOR/MEMBER/VIEWER.

## Decision

- **Coarse naming**: Use `tool:write` (covers create + update) instead of separate `tool:create`/`tool:update`.
- **Unify MCP under tool**: Remove all `mcp:*` permissions. MCP routes use `tool:read`/`tool:write`/`tool:delete`.
- **Remove `tool:manage_secrets`**: Tool secrets already use `credential:*` permissions.

## Target State

### Tool ResourceType Operations

`read`, `write`, `delete`, `execute`

### Tenant-Level Role Permissions

| Role     | Tool permissions                          |
| -------- | ----------------------------------------- |
| OWNER    | `*:*` (unchanged)                         |
| ADMIN    | `tool:*` (unchanged)                      |
| OPERATOR | `tool:read`, `tool:execute`               |
| MEMBER   | `tool:read`, `tool:write`, `tool:execute` |
| VIEWER   | `tool:read`                               |

### Project-Level Role Permissions

| Role      | Tool permissions  |
| --------- | ----------------- |
| admin     | `*:*` (unchanged) |
| developer | `tool:*`          |
| viewer    | `tool:read`       |

## Changes

### 1. `packages/database/seed-mongo.ts`

- Tool ResourceType: replace `create`/`update` with `write`, remove `manage_secrets`
- Remove entire `mcp` ResourceType entry
- SYSTEM_ROLES: remove all `mcp:*` entries, add `tool:write`/`tool:execute` to MEMBER (no `tool:delete` — only ADMIN/OWNER can delete)

### 2. `apps/studio/src/lib/permissions.ts`

- Remove `MCP_READ`, `MCP_WRITE`, `MCP_DELETE` constants

### 3. `apps/studio/src/app/api/projects/[id]/mcp-servers/**`

- Replace all `StudioPermission.MCP_*` references with `StudioPermission.TOOL_*`

### 4. `apps/runtime/src/middleware/rbac.ts`

- Add `tool:*` to `developer` in `PROJECT_ROLE_PERMISSIONS`
- Add `tool:read` to `viewer` in `PROJECT_ROLE_PERMISSIONS`

### 5. `apps/runtime/src/services/permission-resolution.ts`

- Add tool permissions to `BUILTIN_ROLE_PERMISSIONS` for ADMIN, OPERATOR, MEMBER, VIEWER

### 6. `scripts/migrate-rbac-tool-permissions.ts` (new)

- Idempotent migration for existing deployments
- Updates ResourceType `tool` operations (remove create/update/manage_secrets, add write)
- Deprecates ResourceType `mcp` (soft — sets `isDeprecated: true`, no delete)
- Updates all RoleDefinition records: remove `mcp:*`, add missing `tool:write`/`tool:execute` per role
- Dry-run mode, batch processing, follows existing migration pattern

### 7. `apps/studio/src/__tests__/route-handler-rbac.test.ts`

- Update test cases that reference `MCP_*` permissions to use `TOOL_*`
