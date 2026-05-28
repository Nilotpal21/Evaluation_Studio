# Deprecated `tools` + `tool_versions` Collections Cleanup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all code referencing the deprecated `tools` and `tool_versions` MongoDB collections and their supporting infrastructure (models, repos, types, validation schemas, migration scripts). The `project_tools` collection is the sole replacement.

**Architecture:** The old two-collection model (`tools` for identity + `tool_versions` for versioned configs with draft/publish lifecycle) has been fully superseded by the single-document `project_tools` model (DSL content + sourceHash, no versioning). All Studio routes, components, stores, and most runtime code already use `project_tools`. The remaining references are: (1) orphaned model/repo/type definitions, (2) legacy response helpers, (3) one runtime route endpoint, (4) barrel re-exports, and (5) old validation/schemas.

**Tech Stack:** MongoDB/Mongoose, TypeScript, Vitest, pnpm monorepo (turborepo)

---

## Current State Summary

### Already migrated to `project_tools`

- All Studio CRUD routes (`/api/projects/[id]/tools/*`)
- Studio store (`tool-store.ts`) — uses `ToolWithVersion` (flat ProjectTool shape)
- Studio API client (`api/tools.ts`)
- Studio components (all use `ToolWithVersion` from store)
- Tool test service, MCP discovery service
- Stale tool check hook
- Tool import/export/duplicate routes
- Runtime tool resolution (`resolve-tool-implementations.ts`)
- Runtime tool-to-IR loading (`load-project-tools-as-ir.ts`)

### Still referencing old system (to be cleaned up)

| File                                                                                    | Issue                                                                                  |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/database/src/models/tool.model.ts`                                            | Model definition for `tools` collection                                                |
| `packages/database/src/models/tool-version.model.ts`                                    | Model definition for `tool_versions` collection                                        |
| `packages/database/src/models/index.ts`                                                 | Re-exports `Tool`, `ToolVersion`, `ITool`, `IToolVersion`, config types                |
| `packages/shared/src/repos/tool-repo.ts`                                                | Full CRUD repo for `tools` collection (502 lines)                                      |
| `packages/shared/src/repos/tool-version-repo.ts`                                        | Full CRUD repo for `tool_versions` collection (810 lines)                              |
| `packages/shared/src/repos/index.ts`                                                    | Re-exports ~36 functions from both repos                                               |
| `packages/shared/src/types/tools.ts`                                                    | Derives `NormalizedTool`, `NormalizedToolVersion`, `ApiTool*` from old interfaces      |
| `packages/shared/src/index.ts`                                                          | Re-exports old types (`NormalizedTool`, `ApiToolVersion`, etc.)                        |
| `packages/shared/src/validation/tool-validation.ts`                                     | Validates against `NormalizedToolVersion`, uses `VersionUpdateData` type               |
| `packages/shared/src/validation/tool-schemas.ts`                                        | Old Zod schemas: `CreateToolSchema`, `UpdateToolSchema`, `UpdateVersionSchema`         |
| `packages/shared/src/validation/index.ts`                                               | Re-exports old validation functions + schemas                                          |
| `packages/shared/src/utils/type-guards.ts`                                              | `isToolType()`, `isToolSource()` reference `TOOL_TYPES`, `TOOL_SOURCES` from old model |
| `apps/studio/src/lib/tool-response.ts`                                                  | Legacy section with `sanitizeTool()`, `sanitizeVersion()`, `toolResponse()`, etc.      |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts`                 | Unused import of `findToolsByServerId`                                                 |
| `apps/runtime/src/routes/versions.ts` (lines 330-401)                                   | `tool-preview` endpoint uses `loadVersionedToolsForProject` + `findToolsByProject`     |
| `packages/shared/src/__tests__/tool-repo.test.ts`                                       | Tests for old tool repo                                                                |
| `packages/shared/src/__tests__/tool-version-repo.test.ts`                               | Tests for old version repo                                                             |
| `packages/shared/src/__tests__/tool-validation.test.ts`                                 | Tests for old validation                                                               |
| `packages/database/src/migrations/scripts/20260216_001_unified_tool_schema.ts`          | Creates old collections                                                                |
| `packages/database/src/migrations/scripts/20260216_002_drop_legacy_tool_collections.ts` | Drops even-older collections                                                           |

---

## Task Breakdown

### Task 1: Rewrite the runtime `tool-preview` endpoint

The only **active caller** of old repo functions in app code. Must be rewritten to use `project_tools` before repos can be deleted.

**Files:**

- Modify: `apps/runtime/src/routes/versions.ts` (lines 325-401)

**Step 1: Read the existing tool-preview endpoint**

Understand the current contract. It returns an array of `{ toolId, toolName, toolType, draftOnly, publishedVersion? }`. With `project_tools`, there is no draft/published distinction — all tools are current. The simplified response becomes `{ toolId, toolName, toolType }`.

**Step 2: Rewrite the endpoint**

Replace the `loadVersionedToolsForProject` + `findToolsByProject` calls with `findProjectToolsByProject`:

```typescript
// Replace the dynamic import block (lines 364-370) with:
const { findProjectToolsByProject } = await import('@agent-platform/shared/repos');

const allToolsResult = await findProjectToolsByProject(tenantId, projectId, { limit: 500 });

const tools = allToolsResult.data.map((tool: any) => ({
  toolId: tool.id ?? tool._id,
  toolName: tool.name,
  toolType: tool.toolType,
  draftOnly: false,
}));
```

Also update the OpenAPI response schema (lines 338-354) to remove `publishedVersion` (make it permanently optional, which it already is) and set `draftOnly` to always `false`.

**Step 3: Run related tests**

Run: `cd apps/runtime && pnpm test -- --grep "tool-preview" --run 2>&1 | tail -20`

If no specific test exists, verify the build compiles: `pnpm build --filter=@agent-platform/runtime`

**Step 4: Commit**

```
fix(runtime): rewrite tool-preview endpoint to use project_tools
```

---

### Task 2: Remove unused import from MCP server route

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts` (line 19)

**Step 1: Remove unused import**

Delete `findToolsByServerId` from the import on line 19. The import block becomes:

```typescript
import {
  findMcpServerConfigById,
  updateMcpServerConfig,
  deleteMcpServerConfigWithCascade,
  findProjectToolsByProject,
} from '@agent-platform/shared/repos';
```

**Step 2: Verify build**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```
chore(studio): remove unused findToolsByServerId import
```

---

### Task 3: Delete legacy response helpers from `tool-response.ts`

**Files:**

- Modify: `apps/studio/src/lib/tool-response.ts` (delete lines 57-153)

**Step 1: Remove the entire LEGACY section**

Delete everything from the `// LEGACY (deprecated)` comment (line 57) through the end of the file (line 153). These functions (`sanitizeTool`, `sanitizeVersion`, `toolResponse`, `versionResponse`, `toolListResponse`, `versionListResponse`) are defined but **never imported** by any other file.

Also remove the unused imports of `NormalizedTool`, `NormalizedToolVersion`, `ApiTool`, `ApiToolVersion`, `ApiToolWithVersions` from `@agent-platform/shared` (lines 13-19), since only the new `sanitizeProjectTool` / `projectToolResponse` / `projectToolListResponse` functions remain.

The resulting file should only contain:

- `sanitizeProjectTool()`
- `projectToolResponse()`
- `projectToolListResponse()`

**Step 2: Verify build**

Run: `pnpm build --filter=studio`

**Step 3: Commit**

```
chore(studio): remove deprecated legacy tool response helpers
```

---

### Task 4: Delete old test files

**Files:**

- Delete: `packages/shared/src/__tests__/tool-repo.test.ts`
- Delete: `packages/shared/src/__tests__/tool-version-repo.test.ts`
- Delete: `packages/shared/src/__tests__/tool-validation.test.ts` (if it only tests old validation; read first)

**Step 1: Verify test files only test deprecated code**

Read each file. `tool-repo.test.ts` tests `findToolById`, `findToolBySlug`, `createToolWithDraft`, etc. `tool-version-repo.test.ts` tests `findDraftVersion`, `loadToolWithVersion`, `snapshotVersionRefs`, etc. These all test the old system.

For `tool-validation.test.ts`, check whether it tests `validateTypeConfig` / `normalizeConfigs` (old system, delete) or also tests functions used by `project_tools` (keep those tests, delete only old ones).

**Step 2: Delete the files**

```bash
rm packages/shared/src/__tests__/tool-repo.test.ts
rm packages/shared/src/__tests__/tool-version-repo.test.ts
# Only delete tool-validation.test.ts if it exclusively tests deprecated code
```

**Step 3: Verify tests still pass**

Run: `cd packages/shared && pnpm test --run 2>&1 | tail -20`

**Step 4: Commit**

```
chore(shared): delete tests for deprecated tool + tool_version repos
```

---

### Task 5: Delete old repo files

**Files:**

- Delete: `packages/shared/src/repos/tool-repo.ts` (502 lines)
- Delete: `packages/shared/src/repos/tool-version-repo.ts` (810 lines)
- Modify: `packages/shared/src/repos/index.ts` — remove all re-exports from both files

**Step 1: Remove re-exports from `repos/index.ts`**

Delete lines 11-24 (tool-repo exports) and lines 26-44 (tool-version-repo exports + type). The file should retain: `withTransaction`, `canUseTransactions`, `mcp-server-config-repo`, `project-tool-repo`, and `security-repo` exports.

**Step 2: Delete the repo files**

```bash
rm packages/shared/src/repos/tool-repo.ts
rm packages/shared/src/repos/tool-version-repo.ts
```

**Step 3: Verify build**

Run: `pnpm build --filter=@agent-platform/shared`

If compilation errors surface from other packages importing deleted functions, trace and fix each caller (should be none based on audit, but verify).

**Step 4: Commit**

```
chore(shared): delete deprecated tool-repo and tool-version-repo
```

---

### Task 6: Delete old validation files and schemas

**Files:**

- Delete or gut: `packages/shared/src/validation/tool-validation.ts`
- Delete or gut: `packages/shared/src/validation/tool-schemas.ts`
- Modify: `packages/shared/src/validation/index.ts` — remove re-exports

**Step 1: Read `tool-validation.ts` and `tool-schemas.ts`**

Determine which exports are still used. Based on audit:

- `validateTypeConfig()` — only called from old repos (now deleted). Delete.
- `normalizeConfigs()` — only called from old repos. Delete.
- `validateHttpToolEndpoint()` — check if this is used elsewhere (the Studio create route imports it from `@agent-platform/shared/validation`). **Keep if still used.**
- `DEFAULT_TIMEOUT_MS` — check callers. **Keep if used by project-tool code.**
- `CreateToolSchema`, `UpdateToolSchema`, `UpdateVersionSchema` (in `tool-schemas.ts`) — not imported by any app code. Delete.

**Step 2: Remove unused exports from `validation/index.ts`**

Remove `validateTypeConfig`, `normalizeConfigs`, `CreateToolSchema`, `UpdateToolSchema`, `UpdateVersionSchema`, `CreateToolRequest`, `UpdateToolRequest`, `UpdateVersionRequest` from the barrel exports.

Keep `validateHttpToolEndpoint` and `DEFAULT_TIMEOUT_MS` if still used.

If `tool-validation.ts` becomes empty (or only has `validateHttpToolEndpoint`), consider moving the surviving function to a general utils or the project-tool-validator, then delete the file.

If `tool-schemas.ts` becomes empty, delete it entirely.

**Step 3: Verify build**

Run: `pnpm build --filter=@agent-platform/shared`

**Step 4: Commit**

```
chore(shared): remove deprecated tool validation schemas and functions
```

---

### Task 7: Clean up shared types

**Files:**

- Modify: `packages/shared/src/types/tools.ts` — remove old type derivations
- Modify: `packages/shared/src/index.ts` — remove old type re-exports
- Modify: `packages/shared/src/utils/type-guards.ts` — update or remove old guards

**Step 1: Gut `types/tools.ts`**

Remove:

- `import type { ITool, IToolVersion } from '@agent-platform/database/models'`
- `NormalizedTool = Normalized<ITool>`
- `NormalizedToolVersion = Normalized<IToolVersion>`
- `ApiTool`, `ApiToolVersion`, `ApiToolWithVersions` type definitions
- All the type manipulation code (ToolInternalFields, VersionInternalFields, ConfigFields)

Keep only re-exports that are **still used by project_tools or other active code**:

- `ToolType` and `TOOL_TYPES` — check if project-tool code uses these or has its own `ProjectToolType`. If `ProjectToolType` from `project-tool.model.ts` is sufficient everywhere, remove. But note `ToolType` includes `'lambda'` while `ProjectToolType` does not — if anything still needs the `lambda` variant, keep.
- `ToolSource` and `TOOL_SOURCES` — check if any active code uses `ToolSource`. If only the old model used it, remove.
- Config types (`HttpToolConfig`, `McpToolConfig`, `SandboxToolConfig`, `LambdaToolConfig`) — check if anything outside the deleted repos uses them. If not, remove.

**Step 2: Update `shared/src/index.ts`**

Remove re-exports for:

- `NormalizedTool`, `NormalizedToolVersion`
- `ApiTool`, `ApiToolVersion`, `ApiToolWithVersions`
- `ToolSource` (if removed from types/tools.ts)
- Config types (if removed)

Keep:

- `IProjectTool`, `ProjectToolType` (already exported on line 225)
- Any surviving utility types

**Step 3: Update `utils/type-guards.ts`**

- `isToolType()` uses `TOOL_TYPES` from old model. If `TOOL_TYPES` is removed, either delete this guard or rewrite to use `PROJECT_TOOL_TYPES`.
- `isToolSource()` uses `TOOL_SOURCES` from old model. If `ToolSource` concept is gone, delete this guard.

**Step 4: Verify build**

Run: `pnpm build` (full monorepo — types are consumed everywhere)

Chase any compilation errors from packages that imported the deleted types.

**Step 5: Commit**

```
chore(shared): remove deprecated tool types (NormalizedTool, ApiToolVersion, etc.)
```

---

### Task 8: Delete old database model files

**Files:**

- Delete: `packages/database/src/models/tool.model.ts` (115 lines)
- Delete: `packages/database/src/models/tool-version.model.ts` (228 lines)
- Modify: `packages/database/src/models/index.ts` — remove exports (lines 250-267)

**Step 1: Remove exports from `models/index.ts`**

Delete lines 250-267 (the `Tool`, `ToolVersion`, and all associated type/constant exports). Keep the `ProjectTool` exports on lines 243-248.

**Step 2: Delete the model files**

```bash
rm packages/database/src/models/tool.model.ts
rm packages/database/src/models/tool-version.model.ts
```

**Step 3: Verify build**

Run: `pnpm build` (full monorepo)

Any remaining import of `ITool`, `IToolVersion`, `Tool`, `ToolVersion`, `TOOL_TYPES`, `TOOL_SOURCES`, `computeSlug`, or config types from `@agent-platform/database/models` will now fail. Chase and fix each.

Expected: zero failures if Tasks 3-7 were completed first.

**Step 4: Commit**

```
chore(database): delete deprecated Tool and ToolVersion mongoose models
```

---

### Task 9: Handle migration scripts

**Files:**

- Modify: `packages/database/src/migrations/scripts/20260216_001_unified_tool_schema.ts`
- Review: `packages/database/src/migrations/scripts/20260216_002_drop_legacy_tool_collections.ts`

**Step 1: Assess migration approach**

These migrations have already been executed on existing databases. They cannot be deleted outright (the migration runner tracks them by filename). Two options:

**Option A (recommended):** Replace the `up()` body with a no-op comment explaining the migration is superseded. Keep the file so the migration runner doesn't re-run or error on a missing entry.

```typescript
export async function up(_db: Db): Promise<void> {
  // No-op: tools + tool_versions collections are deprecated.
  // project_tools is the sole tool storage. See migration 003.
}
```

**Option B:** Create a new migration `20260225_003_drop_deprecated_tool_collections.ts` that drops `tools` and `tool_versions` collections. This is the data cleanup step. Only do this after all code references are removed and deployed.

**Step 2: If creating migration 003, write it**

```typescript
import type { Db } from 'mongodb';

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const names = collections.map((c) => c.name);

  if (names.includes('tools')) {
    await db.dropCollection('tools');
  }
  if (names.includes('tool_versions')) {
    await db.dropCollection('tool_versions');
  }
}
```

**Step 3: Commit**

```
chore(database): mark old tool migrations as no-op, add collection drop migration
```

---

### Task 10: Final verification

**Step 1: Full monorepo build**

Run: `pnpm build`

Expected: zero errors.

**Step 2: Full test suite**

Run: `pnpm test --run`

Expected: all tests pass. Any failure indicates a missed reference.

**Step 3: Grep for any remaining references**

```bash
# Should return zero results (excluding migration no-op comments, plan docs, changelogs)
grep -rn "tool_versions\|IToolVersion\|ToolVersion\|tool-version-repo\|tool-repo\|NormalizedToolVersion\|ApiToolVersion\|ApiToolWithVersions" \
  packages/database/src packages/shared/src apps/runtime/src apps/studio/src \
  --include="*.ts" --include="*.tsx" \
  | grep -v "node_modules" \
  | grep -v "__tests__" \
  | grep -v "migrations" \
  | grep -v ".d.ts"
```

**Step 4: Commit**

```
chore: verify clean removal of deprecated tool + tool_version collections
```

---

## Summary

| Metric          | Count                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------- |
| Files to delete | 6 (2 models, 2 repos, 2-3 test files)                                                     |
| Files to modify | ~8 (barrel exports, types, validation, 1 runtime route, 1 studio route, response helpers) |
| Lines removed   | ~2,300+                                                                                   |
| Lines added     | ~10 (rewritten tool-preview endpoint, migration no-op)                                    |
| Risk            | Low — all active callers already use `project_tools`; only orphaned definitions remain    |

## Execution Order

Tasks **must** be executed in order 1→10. Each task removes a layer of the dependency tree:

1. Rewrite the last active caller (runtime tool-preview)
2. Remove unused import (studio mcp-server route)
3. Remove legacy response helpers (studio)
4. Delete old tests
5. Delete old repos
6. Delete old validation
7. Clean up shared types
8. Delete old models (bottom of dependency tree)
9. Handle migrations
10. Final verification
