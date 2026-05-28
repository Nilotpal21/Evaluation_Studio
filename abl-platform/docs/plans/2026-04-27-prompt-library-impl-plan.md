# LLD: Prompt Library

**Feature Spec**: `docs/features/prompt-library.md`
**HLD**: `docs/specs/prompt-library.hld.md`
**Test Spec**: `docs/testing/prompt-library.md`
**Status**: DONE
**Date**: 2026-04-27
**Completed**: 2026-04-28

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                      | Rationale                                                                                                                                                           | Alternatives Rejected                                                     |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D-1 | Two-step `findOneAndUpdate` for atomic promote                                | `MongoConnectionManager` has no session API; `MongoMemoryServer` runs standalone — transactions fail in tests. Matches `promoteAgentVersion()` pattern in codebase. | MongoDB transactions — no infrastructure path                             |
| D-2 | `resolveLibraryRef()` in separate `agent-compile/` file                       | `createVersion()` is 285 lines; CLAUDE.md forbids rewriting >200-line functions in one pass. Separate function is independently testable (INT-8).                   | Inline in `createVersion()` — too large to safely modify                  |
| D-3 | Singleton pattern with `resetX()` for services                                | Matches `getVersionService()` / `resetVersionService()` at `version-service.ts:705-716`. `resetX()` needed for test harness teardown.                               | DI constructor injection — overkill; services are never multi-instanced   |
| D-4 | Named route files for Studio proxy                                            | Explicit routes are auditable, match `human-tasks/route.ts` pattern. Each endpoint has own file with `withRouteHandler` + `proxyToRuntime`.                         | Catch-all `[...path]` — harder to enforce per-endpoint permission checks  |
| D-5 | Test LLM via mock HTTP server (stub `endpointUrl`)                            | Matches E2E harness: `provisionTenantModel(endpointUrl: mockLlmServer.url)`. Vercel AI SDK hits the mock transparently. No `vi.mock` needed.                        | `vi.mock` of Vercel AI SDK — violates CLAUDE.md platform mock prohibition |
| D-6 | RBAC via wildcard `prompt:*` for developer role                               | Developer role uses `agent:*`, `tool:*`, `workflow:*` wildcards. `VALID_CUSTOM_ROLE_PERMISSIONS` auto-derives from `PERMISSION_REGISTRY`.                           | Explicit six-permission list — unnecessary verbosity                      |
| D-7 | `nextVersionNumber` via `findOneAndUpdate $inc`                               | TOCTOU-safe monotonic counter on `PromptLibraryItem`. Application-level `max()+1` races under concurrent version creation.                                          | Application-level `max(versionNumber) + 1` — susceptible to race          |
| D-8 | Document promote two-step atomicity window                                    | HLD section 4 concern #6 documents the transient dual-active window as bounded to one request and non-observable. No code change beyond inline comments.            | Transactions — ruled out by D-1                                           |
| D-9 | Verify `ModelResolutionService` + `tenantModelId` path at implementation time | `ResolutionContext` at `model-resolution.ts:160` has no direct `tenantModelId` field. Task 2.2 must confirm correct call path before writing test service.          | Guessing the API — violates CLAUDE.md type-safety rule                    |

### Key Interfaces & Types

```typescript
// packages/database/src/models/prompt-library-item.model.ts
export type PromptLibraryItemStatus = 'active' | 'archived';

export interface IPromptLibraryItem {
  _id: string; // pl_<uuidv7>
  tenantId: string;
  projectId: string;
  name: string; // max 128, unique within tenantId+projectId
  description?: string; // max 512
  tags: string[]; // default []
  usageCount: number; // default 0, incremented by compile hook
  nextVersionNumber: number; // default 0, $inc for TOCTOU-safe assignment
  status: PromptLibraryItemStatus; // default 'active'
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// packages/database/src/models/prompt-library-version.model.ts
export type PromptLibraryVersionStatus = 'draft' | 'active' | 'archived';

export interface IPromptLibraryVersion {
  _id: string; // plv_<uuidv7>
  tenantId: string;
  projectId: string;
  promptId: string; // FK to prompt_library_items._id
  versionNumber: number; // assigned via nextVersionNumber $inc
  template: string; // max 32KB
  variables: string[]; // max 20 items, each max 64 chars
  description?: string; // max 512
  status: PromptLibraryVersionStatus;
  sourceHash: string; // sha256(template + JSON.stringify(variables.sort()))
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  publishedAt?: Date;
  publishedBy?: string;
}

// packages/compiler/src/platform/ir/schema.ts — additive extension to SystemPromptConfig
// Add after existing `sections` field:
//   libraryRef?: { promptId: string; versionId: string; resolvedHash: string; }

// apps/runtime/src/services/prompt-library/prompt-library-service.ts
export interface PromoteVersionResult {
  version: IPromptLibraryVersion;
  previousActiveVersionId?: string;
}

// packages/database/src/models/project-agent.model.ts — additive extension to IProjectAgent
// Read file before editing to confirm interface name and location.
// Add optional field after existing systemPrompt-related fields:
//   systemPromptLibraryRef?: { promptId: string; versionId: string; }

// apps/runtime/src/services/version-service.ts — additive extension to CreateVersionParams
// Add optional field at L37-47 after existing fields:
//   libraryRef?: { promptId: string; versionId: string; }

// apps/runtime/src/services/prompt-library/prompt-library-test-service.ts
export interface TestPane {
  promptVersionId: string;
  tenantModelId: string;
  output: string;
  usage: { input: number; output: number; total: number };
  latencyMs: number;
  model: string;
  provider: string;
}

export interface FailedPane {
  promptVersionId?: string;
  tenantModelId?: string;
  error: { code: string; message: string };
}

export interface TestResult {
  panes: TestPane[];
  failedPanes: FailedPane[];
}
```

### Module Boundaries

| Module                                                  | Responsibility                                                                         | Depends On                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/database` — two new model files               | Schema, indexes, `tenantIsolationPlugin`, model registration                           | `packages/database/mongo/plugins/tenant-isolation.plugin.ts`                                          |
| `packages/shared-auth` — `role-permissions.ts`          | `PERMISSION_REGISTRY` category + `PROJECT_ROLE_PERMISSIONS` update                     | Nothing new                                                                                           |
| `packages/compiler` — `ir/schema.ts`                    | Type-only: add optional `libraryRef` to `SystemPromptConfig`                           | Nothing new                                                                                           |
| `apps/runtime` — `services/prompt-library/`             | CRUD + lifecycle (service) + single-turn test execution (test service)                 | `PromptLibraryItem`, `PromptLibraryVersion`, `ModelResolutionService`, `audit-helpers`, Vercel AI SDK |
| `apps/runtime` — `services/agent-compile/`              | `resolveLibraryRef()` pre-compile hook; called from `VersionService.createVersion()`   | `PromptLibraryService.getVersion()`, model types                                                      |
| `apps/runtime` — `routes/prompt-library.ts`             | 13 Express route handlers; mounts at `/api/projects/:projectId/prompt-library`         | `PromptLibraryService`, `PromptLibraryTestService`, RBAC middleware                                   |
| `apps/runtime` — `server.ts`                            | Mount `promptLibraryRouter`                                                            | `routes/prompt-library.ts`                                                                            |
| `apps/studio` — `app/api/projects/[id]/prompt-library/` | Authenticated proxy routes to runtime                                                  | `proxyToRuntime()`, `withRouteHandler`                                                                |
| `apps/studio` — UI pages + components                   | List, detail, compare pages; `PromptEditor`, `PromptComparePanel`, `PromptPickerModal` | Studio proxy routes, `resourceNavDefs`                                                                |
| `apps/studio` — `IdentityEditor.tsx`                    | System Prompt Source toggle + picker integration + extract-to-library action           | `PromptPickerModal`, Studio API routes                                                                |

---

## 2. File-Level Change Map

### New Files

| File                                                                                                            | Purpose                                                                                       | LOC Est. |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- |
| `packages/database/src/models/prompt-library-item.model.ts`                                                     | `PromptLibraryItem` Mongoose model + indexes + plugin                                         | 90       |
| `packages/database/src/models/prompt-library-version.model.ts`                                                  | `PromptLibraryVersion` Mongoose model + indexes + plugin                                      | 110      |
| `apps/runtime/src/services/prompt-library/prompt-library-service.ts`                                            | CRUD + lifecycle + atomic promote service                                                     | 320      |
| `apps/runtime/src/services/prompt-library/prompt-library-test-service.ts`                                       | Single-turn test via `ModelResolutionService` + Vercel AI SDK                                 | 200      |
| `apps/runtime/src/services/agent-compile/library-ref-resolver.ts`                                               | `resolveLibraryRef()` pre-compile hook for `VersionService`                                   | 80       |
| `apps/runtime/src/routes/prompt-library.ts`                                                                     | 13 Express route handlers                                                                     | 380      |
| `apps/studio/src/app/api/projects/[id]/prompt-library/prompts/route.ts`                                         | POST create, GET list                                                                         | 40       |
| `apps/studio/src/app/api/projects/[id]/prompt-library/prompts/[promptId]/route.ts`                              | GET detail, PATCH update, DELETE                                                              | 50       |
| `apps/studio/src/app/api/projects/[id]/prompt-library/prompts/[promptId]/versions/route.ts`                     | POST create, GET list                                                                         | 40       |
| `apps/studio/src/app/api/projects/[id]/prompt-library/prompts/[promptId]/versions/[versionId]/route.ts`         | GET, PATCH                                                                                    | 40       |
| `apps/studio/src/app/api/projects/[id]/prompt-library/prompts/[promptId]/versions/[versionId]/promote/route.ts` | POST promote                                                                                  | 25       |
| `apps/studio/src/app/api/projects/[id]/prompt-library/prompts/[promptId]/versions/[versionId]/archive/route.ts` | POST archive                                                                                  | 25       |
| `apps/studio/src/app/api/projects/[id]/prompt-library/prompts/[promptId]/references/route.ts`                   | GET reverse references                                                                        | 25       |
| `apps/studio/src/app/api/projects/[id]/prompt-library/test/route.ts`                                            | POST test (timeoutMs: 65000)                                                                  | 30       |
| `apps/studio/src/components/prompt-library/PromptLibraryListPage.tsx`                                           | Library list SPA component (rendered by AppShell.tsx renderContent switch)                    | 120      |
| `apps/studio/src/components/prompt-library/PromptLibraryDetailPage.tsx`                                         | Detail/editor SPA component                                                                   | 200      |
| `apps/studio/src/components/prompt-library/PromptLibraryComparePage.tsx`                                        | Compare harness SPA component                                                                 | 160      |
| `apps/studio/src/components/prompt-library/PromptEditor.tsx`                                                    | Template editor with variable extraction + `{{var}}` highlight                                | 160      |
| `apps/studio/src/components/prompt-library/PromptComparePanel.tsx`                                              | 2–5 column compare grid (Mode A / Mode B)                                                     | 180      |
| `apps/studio/src/components/prompt-library/PromptPickerModal.tsx`                                               | Modal with project-scoped search + version dropdown                                           | 140      |
| `apps/runtime/src/__tests__/helpers/prompt-library-helpers.ts`                                                  | Shared E2E fixtures: `createPromptHelper()`, `promoteVersionHelper()`, `startMockLlmServer()` | 120      |
| `apps/runtime/src/__tests__/prompt-library-flow.e2e.test.ts`                                                    | E2E-1: full create → promote → reference → session flow                                       | 180      |
| `apps/runtime/src/__tests__/prompt-library-compare.e2e.test.ts`                                                 | E2E-2, E2E-3, E2E-4: compare modes + cross-product rejection                                  | 200      |
| `apps/runtime/src/__tests__/prompt-library-isolation.e2e.test.ts`                                               | E2E-5: cross-tenant + cross-project 404 coverage                                              | 140      |
| `apps/runtime/src/__tests__/prompt-library-rbac.e2e.test.ts`                                                    | E2E-6: developer / tester / viewer role enforcement                                           | 160      |
| `apps/runtime/src/__tests__/prompt-library.perf.test.ts`                                                        | Perf benchmarks (excluded from default CI)                                                    | 80       |
| `apps/studio/e2e/prompt-library/full-flow.spec.ts`                                                              | E2E-7: Studio Playwright create → compare → agent-pick                                        | 220      |
| `packages/database/src/models/__tests__/prompt-library-item.model.test.ts`                                      | UT-1: schema + indexes + plugin                                                               | 80       |
| `packages/database/src/models/__tests__/prompt-library-version.model.test.ts`                                   | UT-2: schema + sourceHash determinism                                                         | 80       |
| `apps/runtime/src/services/prompt-library/__tests__/lifecycle.test.ts`                                          | UT-3: lifecycle transition validation (pure function tests)                                   | 60       |
| `apps/runtime/src/services/prompt-library/__tests__/extract-variables.test.ts`                                  | UT-4: `extractVariables()` pure function                                                      | 60       |
| `apps/runtime/src/services/prompt-library/__tests__/validators.test.ts`                                         | UT-7: boundary validators                                                                     | 70       |
| `apps/runtime/src/services/prompt-library/__tests__/sanitize-variable-value.test.ts`                            | UT-8: variable value sanitiser                                                                | 50       |
| `packages/shared-auth/src/__tests__/role-permissions-prompt-library.test.ts`                                    | UT-6: `PERMISSION_REGISTRY` + role maps                                                       | 60       |
| `packages/compiler/src/__tests__/system-prompt-config-types.test.ts`                                            | UT-5: `SystemPromptConfig` type extension compile-time test                                   | 40       |
| `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts`                             | INT-1, INT-4, INT-6: promote atomicity, archived-pin, boundaries                              | 200      |
| `apps/runtime/src/services/prompt-library/__tests__/usage-count-denormalization.test.ts`                        | INT-3: `usageCount` incremented on compile (steps 1-2 only; steps 3-4 descoped — see §7)      | 80       |
| `apps/runtime/src/services/prompt-library/__tests__/prompt-library-test-service.test.ts`                        | INT-5, INT-10: variable sanitization, partial pane failure                                    | 120      |
| `apps/runtime/src/services/prompt-library/__tests__/audit-emission.test.ts`                                     | INT-7: audit log emitted post-commit, not before                                              | 80       |
| `apps/runtime/src/services/agent-compile/__tests__/library-ref-resolution.test.ts`                              | INT-8: `resolveLibraryRef()` — fetches version, sets template, custom:true                    | 100      |
| `apps/runtime/src/services/execution/__tests__/build-system-prompt-library-ref.test.ts`                         | INT-9: `buildSystemPrompt()` throws sanitized error on missing ref                            | 80       |
| `apps/runtime/src/routes/__tests__/prompt-library-references.test.ts`                                           | INT-11: reverse-reference response shape (count + agent list)                                 | 80       |
| `apps/studio/src/app/api/projects/[id]/prompt-library/__tests__/proxy.test.ts`                                  | INT-12: Studio proxy auth-context forwarding + error passthrough                              | 100      |
| `docs/sdlc-logs/prompt-library/lld.log.md`                                                                      | Audit log for this LLD phase                                                                  | —        |

### Modified Files

| File                                                                  | Change Description                                                                                | Risk |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---- |
| `packages/compiler/src/platform/core/types.ts`                        | Add 5 `prompt.*` entries to `AuditEventType` union; add `'prompt'` to `AuditLog.resourceType`     | Low  |
| `packages/compiler/src/platform/stores/audit-store.ts`                | Add `'prompt'` to `LogAuditParams.resourceType` union                                             | Low  |
| `packages/compiler/src/platform/ir/schema.ts`                         | Add optional `libraryRef` field to `SystemPromptConfig` — type-only, additive                     | Low  |
| `packages/database/src/models/index.ts`                               | Export `PromptLibraryItem`, `IPromptLibraryItem`, `PromptLibraryVersion`, `IPromptLibraryVersion` | Low  |
| `packages/shared-auth/src/rbac/role-permissions.ts`                   | Add `prompt-library` category to `PERMISSION_REGISTRY`; update built-in role maps                 | Low  |
| `packages/database/src/models/project-agent.model.ts`                 | Add optional `systemPromptLibraryRef?: { promptId; versionId }` to `IProjectAgent` — additive     | Low  |
| `apps/runtime/src/routes/versions.ts`                                 | Read `agent.systemPromptLibraryRef`; pass as `libraryRef` in `CreateVersionParams`                | Low  |
| `apps/runtime/src/services/version-service.ts`                        | Add `libraryRef?` to `CreateVersionParams`; inject into `parseResult.document` before compile     | Med  |
| `packages/database/src/cascade/cascade-delete.ts`                     | Add `PromptLibraryVersion` + `PromptLibraryItem` deletion to `deleteProject()` + `deleteTenant()` | Med  |
| `apps/runtime/src/services/audit-helpers.ts`                          | Append 5 new prompt-library audit helper functions                                                | Low  |
| `apps/runtime/src/server.ts`                                          | Add import + `app.use('/api/projects/:projectId/prompt-library', promptLibraryRouter)`            | Low  |
| `apps/studio/src/lib/permissions.ts`                                  | Add 6 `PROMPT_*` constants to `StudioPermission` object                                           | Low  |
| `apps/studio/src/lib/project-permission.ts`                           | Add 6 entries to `STUDIO_PROJECT_PERMISSION_ALIASES` for `prompt:*` permissions                   | Low  |
| `apps/studio/src/components/navigation/AppShell.tsx`                  | Add `case 'prompt-library':` block to `renderContent()` with sub-page routing                     | Low  |
| `apps/studio/src/config/navigation.ts`                                | Add `prompt-library` entry to `resourceNavDefs`                                                   | Low  |
| `apps/studio/src/store/navigation-store.ts`                           | Add `'prompt-library'` to `ProjectPage` union type                                                | Low  |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx`            | Add `prompt-library` entry to its own `resourceNavDefs` array at L113–117                         | Low  |
| `packages/i18n/locales/en/studio.json`                                | Add `"prompt_library": "Prompt Library"` under `nav.*`                                            | Low  |
| `apps/runtime/src/services/execution/prompt-builder.ts`               | Defensive guard for empty template + libraryRef (ConfigurationError, sanitized message)           | Low  |
| `apps/studio/src/components/agent-editor/sections/IdentityEditor.tsx` | Add System Prompt Source toggle, `PromptPickerModal` trigger, extract-to-library button           | Med  |

---

## 3. Implementation Phases

### Phase 1: Data Layer + RBAC

**Goal**: Create both Mongoose models with correct indexes and plugins, add the `libraryRef` type extension, register the 6 new permissions — all verified by unit tests and build checks.

**Tasks**:

1.1. **Create `prompt-library-item.model.ts`** in `packages/database/src/models/`:

- Read `workflow-version.model.ts` first to confirm exact import paths and schema structure
- Interface `IPromptLibraryItem` with all fields including `nextVersionNumber: number`
- Schema with `{ _id: { type: String, default: () => 'pl_' + uuidv7() } }` (import `uuidv7` from `'../mongo/base-document.js'`)
- Apply `tenantIsolationPlugin` after schema definition, before `model()` call
- Three indexes: `{ tenantId, projectId, name }` UNIQUE; `{ tenantId, projectId, status }`; `{ tenantId, projectId, tags }`
- Guard: `mongoose.models['PromptLibraryItem'] || model('PromptLibraryItem', schema)`

  1.2. **Create `prompt-library-version.model.ts`** in `packages/database/src/models/`:

- Interface `IPromptLibraryVersion` with all fields
- Schema with `{ _id: { type: String, default: () => 'plv_' + uuidv7() } }`
- Apply `tenantIsolationPlugin`
- Three indexes: `{ tenantId, projectId, promptId, versionNumber }` UNIQUE; `{ tenantId, projectId, promptId, status }`; `{ tenantId, projectId, sourceHash }`

  1.3. **Register models in `packages/database/src/models/index.ts`**:

- Add exports after WorkflowVersion exports (~L295):

  ```
  export { PromptLibraryItem, type IPromptLibraryItem } from './prompt-library-item.model.js';
  export { PromptLibraryVersion, type IPromptLibraryVersion } from './prompt-library-version.model.js';
  ```

  1.4. **Add `libraryRef` to `SystemPromptConfig`** in `packages/compiler/src/platform/ir/schema.ts`:

- Read current interface at L830–844 first; add optional field after `sections`:

  ```typescript
  libraryRef?: {
    promptId: string;
    versionId: string;
    resolvedHash: string;
  };
  ```

  1.5. **Update `packages/shared-auth/src/rbac/role-permissions.ts`**:

- Read file first to confirm exact insertion points
- Add new `PERMISSION_REGISTRY` entry before closing `] as const` (~L395):
  ```typescript
  {
    category: 'prompt-library',
    label: 'Prompt Library',
    permissions: ['prompt:create','prompt:read','prompt:update','prompt:delete','prompt:test','prompt:promote'],
  },
  ```
- Add `'prompt:*'` to `developer` role permissions (~L133)
- Add `'prompt:read'`, `'prompt:test'` to `tester` role (~L155)
- Add `'prompt:read'` to `viewer` role (~L180)
- Do NOT manually add to `VALID_CUSTOM_ROLE_PERMISSIONS` — auto-derived from registry

  1.6. **Extend audit types in `packages/compiler/src/platform/core/types.ts`** and **`packages/compiler/src/platform/stores/audit-store.ts`**:

- `AuditEventType` is a strict string union (read file to find exact location before editing). Add 5 new values:
  `'prompt.created' | 'prompt.version_created' | 'prompt.version_promoted' | 'prompt.version_archived' | 'prompt.tested'`
- `AuditLog.resourceType` (in `types.ts`) is a strict union — add `'prompt'` to it
- `LogAuditParams.resourceType` (in `audit-store.ts`) — add `'prompt'` to it
- `QueryAuditParams.resourceType` (in `audit-store.ts`) — also add `'prompt'` for type-system consistency (enables querying audit logs filtered by `resourceType: 'prompt'`)
- All files are in `packages/compiler` — run `pnpm build --filter=@abl/compiler` after editing
- These changes MUST precede task 2.5 (audit helpers) — the helpers call `writeAuditLog()` which uses these types

  1.7. **Add `systemPromptLibraryRef` to `packages/database/src/models/project-agent.model.ts`**:

- Read file to find `IProjectAgent` interface definition and confirm field order
- Append optional field to the interface (ADDITIVE ONLY — no deletions):
  ```typescript
  systemPromptLibraryRef?: { promptId: string; versionId: string };
  ```
- Add corresponding optional field to the Mongoose schema with `type: Object, required: false`
- Run `pnpm build --filter=@abl/database` immediately after to verify zero TypeScript errors

  1.8. **Update `packages/database/src/cascade/cascade-delete.ts`** to include prompt-library collections:

- **CRITICAL**: Both `deleteProject()` and `deleteTenant()` use dynamic `await import('../models/index.js')` destructuring INSIDE the function body — NOT static top-of-file imports. Read both functions before editing to confirm the exact destructuring pattern.
- In `deleteProject()`: add `PromptLibraryVersion, PromptLibraryItem` to the destructured `await import('../models/index.js')` call. Add deletions (versions before items) using the `projectTenantId` variable (resolved from the project document at ~L256 — do NOT use the outer `tenantId` parameter):
  ```typescript
  await PromptLibraryVersion.deleteMany({ tenantId: projectTenantId, projectId });
  await PromptLibraryItem.deleteMany({ tenantId: projectTenantId, projectId });
  ```
- In `deleteTenant()`: add `PromptLibraryVersion, PromptLibraryItem` to that function's destructured `await import(...)`, then add deletions before `ProjectAgent` at the "Level 1" section. Use the `counts.*` tracking pattern that `deleteTenant()` uses:

  ```typescript
  counts.PromptLibraryVersion = (await PromptLibraryVersion.deleteMany({ tenantId })).deletedCount;
  counts.PromptLibraryItem = (await PromptLibraryItem.deleteMany({ tenantId })).deletedCount;
  ```

- **Update 3 existing cascade test mocks**: Per `packages/database/agents.md` learnings, when adding models to `cascade-delete.ts`, the `vi.mock('../models/index.js', ...)` factory in these test files must also include the new models: `packages/database/src/__tests__/mongo-cascade.test.ts`, `packages/database/src/__tests__/cascade-delete-auth-profile.test.ts`, `packages/database/src/__tests__/cascade-delete-modules.test.ts`. Add `PromptLibraryVersion: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) }` and same for `PromptLibraryItem` to each mock factory.

  1.9. **Write unit tests** (4 test files for Phase 1):

- `UT-1` (`prompt-library-item.model.test.ts`): schema fields, index definitions, `tenantIsolationPlugin` with `MongoMemoryServer`
- `UT-2` + INT-2 combined (`prompt-library-version.model.test.ts`): schema validation AND `computeSourceHash()` determinism — specifically: (a) variables in different order yield the SAME hash, (b) whitespace change in template yields a DIFFERENT hash, (c) variable addition yields a DIFFERENT hash. Also covers INT-2 from the test spec.
- `UT-5` (`system-prompt-config-types.test.ts`): TypeScript compile-time assertions: `SystemPromptConfig` with and without `libraryRef` both valid
- `UT-6` (`role-permissions-prompt-library.test.ts`): all 6 `prompt:*` in `VALID_CUSTOM_ROLE_PERMISSIONS`; role permission assertions

**Files Touched**:

- `packages/database/src/models/prompt-library-item.model.ts` (NEW)
- `packages/database/src/models/prompt-library-version.model.ts` (NEW)
- `packages/database/src/models/index.ts` (MODIFIED)
- `packages/database/src/models/project-agent.model.ts` (MODIFIED — add `systemPromptLibraryRef?`)
- `packages/database/src/cascade/cascade-delete.ts` (MODIFIED — cascade delete both functions)
- `packages/compiler/src/platform/core/types.ts` (MODIFIED — extend `AuditEventType` + `AuditLog.resourceType`)
- `packages/compiler/src/platform/stores/audit-store.ts` (MODIFIED — extend `LogAuditParams.resourceType`)
- `packages/compiler/src/platform/ir/schema.ts` (MODIFIED)
- `packages/shared-auth/src/rbac/role-permissions.ts` (MODIFIED)
- 4 unit test files (NEW)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/database` passes with 0 TypeScript errors
- [ ] `pnpm build --filter=@abl/compiler` passes with 0 TypeScript errors
- [ ] `pnpm build --filter=@agent-platform/shared-auth` passes with 0 TypeScript errors
- [ ] UT-1 passes: schema fields, indexes, `tenantIsolationPlugin` verified
- [ ] UT-2 passes: schema + sourceHash utility verified
- [ ] UT-5 passes: both with/without `libraryRef` compile cleanly
- [ ] UT-6 passes: all 6 permissions in allowlist; role assignments correct
- [ ] No regressions in `pnpm test --filter=@agent-platform/shared-auth`
- [ ] `IProjectAgent.systemPromptLibraryRef` field present and builds cleanly
- [ ] `cascade-delete.ts` builds cleanly with new model references
- [ ] `pnpm build --filter=@abl/compiler` passes after `AuditEventType` + `resourceType` extensions

**Test Strategy**: Unit only — `MongoMemoryServer` for model tests; pure TypeScript for type tests. No platform component mocking.

**Rollback**: Delete 2 new model files, revert 4 modified files (all additive changes). Zero behavior change to existing code.

---

### Phase 2: Runtime Service + Routes

**Goal**: Full working runtime API — CRUD, version lifecycle, atomic promote, single-turn test, audit logs, reverse-reference query. Verified by integration tests (INT-1 through INT-7, INT-10, INT-11).

**Tasks**:

2.1. **Create `apps/runtime/src/services/prompt-library/prompt-library-service.ts`**:

Key methods:

- `createPrompt(params, actor)` — creates `PromptLibraryItem`; if `initialVersion` provided, calls `createVersion()` immediately after
- `createVersion(promptId, params, actor)` — atomically increments `nextVersionNumber` via `findOneAndUpdate({_id: promptId, tenantId, projectId}, {$inc:{nextVersionNumber:1}}, {new:true})`; creates `PromptLibraryVersion` with `versionNumber = item.nextVersionNumber`; computes `sourceHash = computeSourceHash(template, variables)`
- `promoteVersion(promptId, versionId, actor)` — two-step `findOneAndUpdate`:
  1.  `{_id: versionId, promptId, status:'draft'}` → `{$set:{status:'active', publishedAt: new Date(), publishedBy: actor}}`; if `modifiedCount===0` throw `PROMPT_LIBRARY_CONCURRENT_PROMOTE` (409)
  2.  `{promptId, status:'active', _id:{$ne: versionId}}` → `{$set:{status:'archived'}}` (demote old active; no error if none)
- `archiveVersion(promptId, versionId)` — `findOneAndUpdate({_id:versionId, promptId, status:{$ne:'archived'}}, {$set:{status:'archived'}})`
- `updatePrompt(promptId, patch)` — `findOneAndUpdate` with `name`/`description`/`tags` update; reject if `name` conflicts (11000 duplicate key error → 409)
- `deletePrompt(promptId)` — check `getReferences(promptId)` first; if `count > 0` throw `PROMPT_LIBRARY_HAS_REFERENCES` (409); otherwise delete item + all versions (`deleteMany({promptId})`)
- `getActiveVersion(promptId, {tenantId, projectId})` — `findOne({promptId, status:'active', tenantId, projectId})` (indexed query used by compile hook)
- `getVersion(promptId, versionId, {tenantId, projectId})` — `findOne({_id:versionId, promptId, tenantId, projectId})`
- `incrementUsageCount(promptId)` — `updateOne({_id:promptId}, {$inc:{usageCount:1}})` (non-fatal, called post-compile)
- `getReferences(promptId, opts)` — scan `AgentVersion.find({'irContent.identity.system_prompt.libraryRef.promptId': promptId, tenantId, projectId}, {projection})`; returns `{count, agents: [{agentName, versionId, resolvedHash}]}`
- Singleton: `getPromptLibraryService()` / `resetPromptLibraryService()`

  2.2. **Create `apps/runtime/src/services/prompt-library/prompt-library-test-service.ts`**:

- **STEP 0 (required)**: Read `apps/runtime/src/services/llm/model-resolution.ts` fully — specifically `resolve()` at L726 and how existing callers (e.g., `session-llm-client.ts`) invoke it with a tenant model. If there is no direct `tenantModelId` path in `ResolutionContext`, check if `createVercelProvider(resolvedModel)` can be called directly with a `TenantModel` fetched by ID. Do NOT implement until the actual invocation pattern is confirmed.
- `executeTest(params: TestParams): Promise<TestResult>` — builds pane tasks, `Promise.all()` over up to 5 panes, per-pane `AbortController`
- `sanitizeVariableValue(val: string): string` — strips all `{{` and `}}` substrings (pure, UT-8)
- `extractVariables(template: string): string[]` — regex `/{{\s*(\w+)\s*}}/g`; deduped unique names (pure, UT-4)
- `computeSourceHash(template: string, variables: string[]): string` — `crypto.createHash('sha256').update(template + JSON.stringify([...variables].sort())).digest('hex')`
- Singleton: `getPromptLibraryTestService()` / `resetPromptLibraryTestService()`

  2.3. **Create `apps/runtime/src/routes/prompt-library.ts`**:

- Import and apply middleware: `authMiddleware`, `requireProjectScope('projectId')`, `tenantRateLimit('request')`
- Use `createOpenAPIRouter(runtimeRegistry, {...})` from `versions.ts` pattern
- **Route ordering**: register `/test` before `/:promptId` to avoid Express matching `test` as a promptId
- All Zod schemas: ID fields use `z.string().min(1)` (per CLAUDE.md), all schemas use `.strict()`
- Response envelope: `{ success: true, data: {...} }` on success; `{ success: false, error: { code, message } }` on error (no empty `{}`)
- Pagination: `limit` default 50 max 200, `offset` or cursor

  2.4. **Mount router in `apps/runtime/src/server.ts`**:

- Add import at top: `import promptLibraryRouter from './routes/prompt-library.js'`
- Add mount after last project-scoped router (~L1106): `app.use('/api/projects/:projectId/prompt-library', promptLibraryRouter)`

  2.5. **Append audit helpers to `apps/runtime/src/services/audit-helpers.ts`**:

- Read file to find the end of the last domain section before adding
- Add domain section `// === PROMPT LIBRARY AUDIT HELPERS ===`
- `auditPromptCreated(prompt: IPromptLibraryItem, actor: string)`
- `auditPromptVersionCreated(version: IPromptLibraryVersion, actor: string)`
- `auditPromptVersionPromoted(version: IPromptLibraryVersion, actor: string)`
- `auditPromptVersionArchived(version: IPromptLibraryVersion, actor: string)`
- `auditPromptTested(promptId: string, mode: string, paneCount: number, failedPaneCount: number, actor: string)`
- Each calls `writeAuditLog()` (internal wrapper)

  2.6. **Write integration tests** (Phase 2):

- `UT-3` (`lifecycle.test.ts`): pure `validateLifecycleTransition()` tests
- `UT-4` (`extract-variables.test.ts`): `extractVariables('Hello {{name}}, {{greeting}}!')` → `['name','greeting']`
- `UT-7` (`validators.test.ts`): template at 32768 bytes passes; 32769 throws; 21 variables throws; etc.
- `UT-8` (`sanitize-variable-value.test.ts`): `sanitizeVariableValue('hello {{world}}')` → `'hello world'`
- `INT-1` (`prompt-library-service.test.ts`): concurrent promote — two draft versions, assert one wins (active), loser gets 409
- `INT-4`: archived version referenced in test endpoint → `PROMPT_LIBRARY_VERSION_ARCHIVED`
- `INT-6`: boundary conditions (template > 32KB, >20 variables, >5 panes) → 400
- `INT-5` (`prompt-library-test-service.test.ts`): variable sanitization applied before template render
- `INT-10`: partial pane failure → HTTP 200 with `failedPanes[0]` populated
- `INT-3` (`usage-count-denormalization.test.ts`): **v1 scope — steps 1-2 only**: compile A1 with libraryRef → `usageCount===1`; compile A2 with same libraryRef → `usageCount===2`. Steps 3-4 (decrement on recompile + delete) are descoped from v1 — `usageCount` is increment-only; the reverse-reference query is the authoritative source for current reference count (see §7 Open Questions).
- `INT-7` (`audit-emission.test.ts`): spy on `writeAuditLog`; verify not called when promote throws on `modifiedCount===0`
- `INT-11` (`prompt-library-references.test.ts`): create `AgentVersion` with `libraryRef`; GET `/references` → `{count:1, agents:[{agentName,...}]}`

**Files Touched**:

- `apps/runtime/src/services/prompt-library/prompt-library-service.ts` (NEW)
- `apps/runtime/src/services/prompt-library/prompt-library-test-service.ts` (NEW)
- `apps/runtime/src/routes/prompt-library.ts` (NEW)
- `apps/runtime/src/server.ts` (MODIFIED — 2 lines)
- `apps/runtime/src/services/audit-helpers.ts` (MODIFIED — append)
- 11 test files (NEW — 4 UT + 7 INT)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` passes with 0 TypeScript errors
- [ ] INT-1 passes: concurrent promote → exactly one active version, loser receives 409
- [ ] INT-4 passes: archived version reference rejected
- [ ] INT-5 passes: `{{`/`}}` stripped before render
- [ ] INT-6 passes: all boundary conditions reject correctly
- [ ] INT-7 passes: audit not emitted when DB write fails
- [ ] INT-10 passes: partial pane failure → HTTP 200 with `failedPanes`
- [ ] INT-11 passes: reverse-reference returns correct count + agent list
- [ ] `GET http://localhost:3112/api/projects/test/prompt-library/prompts` returns 401 (routes mounted, auth enforced)

**Test Strategy**: Integration — `MongoMemoryServer` + real services. No `vi.mock` of platform components.

**Rollback**: Remove `promptLibraryRouter` mount from `server.ts` (2 lines). Services unreachable. Audit helper additions are append-only.

---

### Phase 3: Compile-Time Library Ref Hook

**Goal**: Agent compile with `libraryRef` resolves the pinned version's template and records `resolvedHash`. Existing compilations without `libraryRef` unaffected.

**Tasks**:

3.1. **Create `apps/runtime/src/services/agent-compile/library-ref-resolver.ts`**:

- Read `apps/runtime/src/services/version-service.ts:307` to confirm the type name used for `allDocuments` elements — it is `AgentBasedDocument` (from `@abl/core`).

```typescript
export async function resolveLibraryRef(
  document: AgentBasedDocument, // confirmed: AgentBasedDocument from @abl/core, version-service.ts:307
  tenantId: string,
  projectId: string,
): Promise<void>;
```

- If `document.system_prompt?.libraryRef` absent → return (no-op)
- Call `getPromptLibraryService().getVersion(libraryRef.promptId, libraryRef.versionId, {tenantId, projectId})`
- Not found → throw `AppError(PROMPT_LIBRARY_NOT_FOUND)` with sanitized message
- `version.status === 'archived'` → throw `AppError(PROMPT_LIBRARY_VERSION_ARCHIVED)` with sanitized message
- Set `document.system_prompt.template = version.template`
- Set `document.system_prompt.custom = true`
- Set `document.system_prompt.libraryRef.resolvedHash = computeSourceHash(version.template, version.variables)`

  3.2. **Hook into `apps/runtime/src/services/version-service.ts`**:

`libraryRef` is NOT in the DSL and is NOT surfaced to `parseAgentBasedABL()`. It must be passed through `CreateVersionParams` and injected into the parsed document explicitly.

- Read `CreateVersionParams` at L37–L47; add optional field to the interface:
  ```typescript
  libraryRef?: { promptId: string; versionId: string };
  ```
- Read `createVersion()` at L219–L345 before editing; do not guess line numbers
- **Injection point**: after tool resolution (L305) and before the `allDocuments` array construction (L307), add:
  ```typescript
  if (params.libraryRef) {
    parseResult.document.system_prompt ??= {} as SystemPromptConfig;
    (
      parseResult.document.system_prompt as SystemPromptConfig & {
        libraryRef?: { promptId: string; versionId: string };
      }
    ).libraryRef = params.libraryRef;
  }
  ```
- Add import: `import { resolveLibraryRef } from './agent-compile/library-ref-resolver.js'`
- Insert `await resolveLibraryRef(parseResult.document, params.tenantId, params.projectId)` immediately after the injection block (before `compileABLtoIR()`)
- Insert `await getPromptLibraryService().incrementUsageCount(libraryRef.promptId).catch(...)` after `saveAgentVersion()` (non-fatal; wrap in try-catch with `log.warn`)

**Also update `apps/runtime/src/routes/versions.ts`** (POST handler that calls `createVersion()`):

- Read the POST handler to find where `createVersion(params)` is called and where the agent document is fetched
- Read `findProjectAgentForProject()` (or equivalent) return type to confirm it returns all fields — check whether any field projection excludes `systemPromptLibraryRef`. If a lean return type omits the new field, cast to `IProjectAgent` to access it
- Forward `systemPromptLibraryRef` as `libraryRef` in `CreateVersionParams`:

  ```typescript
  const versionParams: CreateVersionParams = {
    ...existingFields,
    libraryRef: (agent as IProjectAgent).systemPromptLibraryRef, // forward stored ref
  };
  ```

- **If `agent.systemPromptLibraryRef` is `undefined`** (agent has no library prompt assigned), `libraryRef` in `CreateVersionParams` is `undefined`. The injection block in `createVersion()` is guarded by `if (params.libraryRef)` and `resolveLibraryRef()` is a no-op when `document.system_prompt?.libraryRef` is absent. This is the expected path for all existing agents.

  3.3. **Update `apps/runtime/src/services/execution/prompt-builder.ts`**:

- Read file at ~L954 before editing
- If `system_prompt.libraryRef` is present AND `system_prompt.template` is empty: throw sanitized `ConfigurationError` (do NOT log `promptId`/`versionId` in user-facing message; include in server log only)

  3.4. **Write integration tests** (Phase 3):

- `INT-8` (`library-ref-resolution.test.ts`): construct document with `libraryRef`; call `resolveLibraryRef()`; assert `template` set, `custom===true`, `resolvedHash` set. Test archived version error path.
- `INT-9` (`build-system-prompt-library-ref.test.ts`): call `buildSystemPrompt()` with `libraryRef` set but empty template; assert sanitized error thrown; raw data NOT in user-facing message

**Files Touched**:

- `apps/runtime/src/services/agent-compile/library-ref-resolver.ts` (NEW)
- `apps/runtime/src/services/version-service.ts` (MODIFIED — `libraryRef?` in params + injection + import + usage increment)
- `apps/runtime/src/routes/versions.ts` (MODIFIED — forward `systemPromptLibraryRef` from agent into `CreateVersionParams`)
- `apps/runtime/src/services/execution/prompt-builder.ts` (MODIFIED — ~5 lines: defensive guard)
- 2 integration test files (NEW)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` passes with 0 TypeScript errors
- [ ] INT-8 passes: `resolveLibraryRef()` sets template + custom:true + resolvedHash; archived → error
- [ ] INT-9 passes: `buildSystemPrompt()` with empty template + libraryRef → sanitized error
- [ ] Existing `version-service` tests still pass (no regression in `createVersion()`)

**Test Strategy**: Integration — real `MongoMemoryServer`, real `PromptLibraryService`. No `vi.mock`.

**Rollback**: Remove 3 lines from `version-service.ts`, delete `library-ref-resolver.ts`, remove `prompt-builder.ts` guard.

---

### Phase 4: Studio Proxy Routes

**Goal**: Studio can reach all 13 runtime endpoints via authenticated Next.js API route handlers.

**Tasks**:

4.0. **Update Studio permission files** (two separate files — read each before editing):

**Part A — `apps/studio/src/lib/permissions.ts`** (NOT `project-permission.ts`):

- This file contains the `StudioPermission` object with string constants (e.g., `TOOL_READ = 'tool:read'`)
- Read to confirm exact property naming style
- Add 6 entries to the `StudioPermission` object:
  ```typescript
  PROMPT_CREATE: 'prompt:create',
  PROMPT_READ: 'prompt:read',
  PROMPT_UPDATE: 'prompt:update',
  PROMPT_DELETE: 'prompt:delete',
  PROMPT_TEST: 'prompt:test',
  PROMPT_PROMOTE: 'prompt:promote',
  ```

**Part B — `apps/studio/src/lib/project-permission.ts`** (the alias map):

- This file contains `STUDIO_PROJECT_PERMISSION_ALIASES` mapping Studio permission keys to runtime permission strings
- Read file to confirm existing key pattern — the current map uses string literal keys (`'tool:read'`, `'connection:read'`, etc.), NOT computed property names. Follow the same pattern:
  ```typescript
  'prompt:create': ['prompt:create'],
  'prompt:read': ['prompt:read'],
  'prompt:update': ['prompt:update'],
  'prompt:delete': ['prompt:delete'],
  'prompt:test': ['prompt:test'],
  'prompt:promote': ['prompt:promote'],
  ```
- Run `pnpm build --filter=@abl/studio` after both changes to verify zero TypeScript errors

  4.1. **Read `apps/studio/src/lib/route-handler.ts` fully** before implementing proxy routes. Verify:

- Exact `withRouteHandler` options shape (`permissions` field is typed as `StudioPermission | StudioPermission[]` — after task 4.0, use `StudioPermission.PROMPT_CREATE` etc., NO `as any` casts)
- How `params.id` vs `params.projectId` is surfaced
- How `tenantId` is resolved

  4.2. **Create 8 Studio proxy route files** under `apps/studio/src/app/api/projects/[id]/prompt-library/`:

Template for POST with body (import `StudioPermission` from `@/lib/permissions`):

```typescript
import { withRouteHandler } from '@/lib/route-handler';
import { proxyToRuntime } from '@/lib/runtime-proxy';
import { StudioPermission } from '@/lib/permissions';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_CREATE },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    return proxyToRuntime(request, `/api/projects/${params.id}/prompt-library/prompts`, {
      tenantId,
      body,
    });
  },
);
```

Template for GET with query params:

```typescript
export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_READ },
  async ({ request, tenantId, params }) => {
    const search = new URL(request.url).search;
    return proxyToRuntime(request, `/api/projects/${params.id}/prompt-library/prompts${search}`, {
      tenantId,
    });
  },
);
```

Test route uses `timeoutMs: 65000` (LLM calls exceed default 30s).

4.3. **Write INT-12** (`apps/studio/src/app/api/projects/[id]/prompt-library/__tests__/proxy.test.ts`):

- Verify: Authorization header forwarded; X-Tenant-Id forwarded; 401 from runtime propagated; 400 from runtime propagated; POST body forwarded correctly

**Files Touched**:

- `apps/studio/src/lib/permissions.ts` (MODIFIED — add 6 `PROMPT_*` constants to `StudioPermission`)
- `apps/studio/src/lib/project-permission.ts` (MODIFIED — add 6 alias entries)
- 8 new Studio proxy route files (NEW)
- 1 integration test file (NEW)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/studio` passes with 0 TypeScript errors
- [ ] INT-12 passes: auth context forwarded, error codes propagated, body forwarded

**Test Strategy**: Integration — stub HTTP runtime responses; use `NextRequest`/`NextResponse` test utilities.

**Rollback**: Delete 8 route files. No behavior impact (UI pages not yet created).

---

### Phase 5: Studio UI — Library Surface

**Goal**: Navigable Prompt Library list, detail, and compare pages in Studio. All UI uses semantic design tokens.

**Tasks**:

5.1. **Wire `AppShell.tsx` SPA routing** — Studio is a SPA; pages are NOT Next.js App Router routes. Read `apps/studio/src/components/navigation/AppShell.tsx` `renderContent()` function (currently ~L556-680). Existing resource pages (tools, connections, etc.) are all `case` blocks that import and render React components.

- Read `renderContent()` to find the exact `case 'tools':` block pattern for sub-page routing (list/detail distinction via `subPage` null-check)
- Add a `case 'prompt-library':` block:
  - `subPage === null` → `<PromptLibraryListPage />`
  - `subPage` with tab === 'compare' → `<PromptLibraryComparePage promptId={subPage} />`
  - else → `<PromptLibraryDetailPage promptId={subPage} />`
- Import all 3 page components at the top of `AppShell.tsx`

  5.2. **Update navigation** (4 files — read each before editing):

- `apps/studio/src/store/navigation-store.ts`: add `'prompt-library'` to `ProjectPage` union type
- `apps/studio/src/config/navigation.ts`: add entry to `resourceNavDefs` array
- `apps/studio/src/components/navigation/ProjectSidebar.tsx`: **this file has its OWN independent `const resourceNavDefs` array** at L113–117 — it is NOT the same array as `navigation.ts`. Both must be updated separately. **NOTE**: `navigation.ts` has 4 entries (including `module-dependencies`); `ProjectSidebar.tsx` has only 3 (no `module-dependencies`) — they are intentionally different. Add `prompt-library` to BOTH without assuming they are mirrors. Verify `BookMarked` icon exists in `lucide-react` by checking existing imports; if not, use `Library` or `BookOpen`.
- `packages/i18n/locales/en/studio.json`: read file to confirm exact `nav` key nesting; add `"prompt_library": "Prompt Library"` under the `nav` object (alongside existing `tools`, `knowledge_bases`, `integrations` keys).

  5.3. **Define i18n key namespace in `packages/i18n/locales/en/studio.json`** (before creating any UI components):

- Read the file to confirm the exact nesting structure of existing namespaces
- Add a top-level `prompt_library` namespace covering all user-visible strings. Key categories required:
  - `nav.prompt_library` — sidebar label (`"Prompt Library"`)
  - `prompt_library.list.*` — list page: empty state, column headers (`name`, `tags`, `usage_count`, `status`), `new_prompt` button
  - `prompt_library.detail.*` — detail page: tabs (`template`, `versions`, `references`), action buttons (`promote`, `archive`, `save_draft`)
  - `prompt_library.compare.*` — compare page: mode labels (`compare_models`, `compare_versions`), `run_test` button, result column headers
  - `prompt_library.picker.*` — picker modal: title, `search_placeholder`, `select_version`, `confirm`, `cancel`
  - `prompt_library.errors.*` — `not_found`, `version_archived`, `concurrent_promote` user-facing messages
- Run `pnpm build --filter=@abl/i18n` (or whatever build target covers the i18n package) to verify JSON validity

  5.4. **Create `PromptEditor.tsx`** in `apps/studio/src/components/prompt-library/`:

- Read an existing editor component (e.g., `WorkflowEditor.tsx` or a markdown editor) for the monospace textarea + styling pattern
- Calls `extractVariables(template)` on change; passes derived names via `onVariablesChange`
- Semantic tokens only — no hardcoded Tailwind palette colors

  5.5. **Create `PromptComparePanel.tsx`**: 2–5 column grid; each column: label, response text, latency badge, token count; failed panes with error message; "Copy" button per column

  5.6. **Create `PromptPickerModal.tsx`**: modal with search + paginated list + version dropdown (active + draft versions only); returns `{promptId, versionId, promptName, versionNumber}` to caller

  5.7. **Create `PromptLibraryListPage.tsx`** component: fetch from proxy API; table with name/tags/status/usage; filter by tag/status; "New Prompt" button; pagination

  5.8. **Create `PromptLibraryDetailPage.tsx`** component: Template / Versions / References tabs; `PromptEditor` with draft version; version list with lifecycle actions; reference list

  5.9. **Create `PromptLibraryComparePage.tsx`** component: Mode selector; variable inputs; user message textarea; "Run Test" → POST to test endpoint → `PromptComparePanel`

**Files Touched**:

- `apps/studio/src/components/navigation/AppShell.tsx` (MODIFIED — add `case 'prompt-library':` to `renderContent()`)
- 3 navigation files (MODIFIED — `navigation-store.ts`, `navigation.ts`, `ProjectSidebar.tsx`)
- `packages/i18n/locales/en/studio.json` (MODIFIED — add `nav.prompt_library` + `prompt_library.*` namespace)
- 6 component files (NEW — 3 widget components + 3 page components)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/studio` passes with 0 TypeScript errors
- [ ] "Prompt Library" appears in Studio left sidebar under Resources
- [ ] Clicking sidebar entry renders list page (may be empty)
- [ ] Create prompt via UI succeeds; prompt appears in list
- [ ] Compare page renders Mode A + Mode B; "Run Test" returns results
- [ ] Design token lint passes (no hardcoded palette colors)

**Test Strategy**: Dev server + browser verification. E2E-7 (Phase 6) covers golden path.

**Rollback**: Remove `case 'prompt-library':` from `renderContent()` + remove navigation entries. New component files unreachable.

---

### Phase 6: Agent Integration + E2E Tests

**Goal**: IdentityEditor library picker wired. All E2E tests passing. Performance and security validated.

**Tasks**:

6.1. **Modify `apps/studio/src/components/agent-editor/sections/IdentityEditor.tsx`**:

- Read the current file fully before editing
- Add "System Prompt Source" section: `'inline'` (existing) / `'from-library'` toggle
- Library mode: show prompt name + version; "Change" button → `PromptPickerModal`; "Clear" button
- On picker confirm: write `libraryRef = {promptId, versionId}` to working copy; clear inline template; mark dirty
- "Extract to Library" action: modal pre-filled with current inline template; on success → switch to library mode

  6.2. **Write E2E runtime tests** (4 test files):

- `prompt-library-helpers.ts`: `createPromptHelper()`, `promoteVersionHelper()`, `startMockLlmServer()` (real `http.createServer`)
- E2E-1 (`prompt-library-flow.e2e.test.ts`): create → promote → attach to agent (PATCH working copy with `libraryRef`) → compile → verify IR has `custom:true` + resolved template → create session → assert response
- E2E-2/3/4 (`prompt-library-compare.e2e.test.ts`): Mode A (1×3 models → 3 panes); Mode B (2 versions×1 model → 2 panes); cross-product (2×2 → 400)
- E2E-5 (`prompt-library-isolation.e2e.test.ts`): 2 tenants + 2 projects; all 13 endpoints return 404 on cross-scope access
- E2E-6 (`prompt-library-rbac.e2e.test.ts`): developer/tester/viewer; tester blocked on promote; viewer blocked on test

  6.3. **Write Studio Playwright E2E** (`full-flow.spec.ts`): `loginViaDevApi()` → create prompt via UI → save draft → run compare Mode A → select in IdentityEditor → verify `libraryRef` in working copy

  6.4. **Performance** (`prompt-library.perf.test.ts`): test endpoint overhead ≤500ms (mock LLM responds in 10ms); reverse-reference query with 1000 agent versions ≤200ms. Excluded from CI (`--tier=perf`).

  6.5. **Security**: run `./tools/run-semgrep.sh` on `routes/prompt-library.ts` and `services/prompt-library/`; verify template content rendered as text (not `innerHTML`) in Studio; verify `{{{{}}}}` nested edge case sanitized

**Files Touched**:

- `apps/studio/src/components/agent-editor/sections/IdentityEditor.tsx` (MODIFIED)
- 6 new E2E test files in `apps/runtime/src/__tests__/`
- 1 new Studio Playwright test file
- 1 perf test file

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/studio` passes with 0 TypeScript errors
- [ ] E2E-1 passes: full compile → session flow
- [ ] E2E-2, E2E-3 pass: correct pane counts
- [ ] E2E-4 passes: cross-product → 400
- [ ] E2E-5 passes: all 13 endpoints return 404 on cross-scope
- [ ] E2E-6 passes: tester blocked on promote; viewer blocked on test
- [ ] E2E-7 (Playwright) passes: Studio UI golden path
- [ ] `pnpm test --filter=@abl/runtime` has 0 new failures

**Test Strategy**: E2E — `startRuntimeServerHarness()` + `bootstrapProject()` + `provisionTenantModel(endpointUrl: mockLlmServer.url)`. HTTP-only. No `vi.mock`, no direct DB queries.

**Rollback**: Delete new test files; revert `IdentityEditor.tsx` changes. Phases 1–5 unaffected.

---

## 4. Wiring Checklist

- [ ] **`PromptLibraryItem` + `PromptLibraryVersion` exported from `packages/database/src/models/index.ts`** (Phase 1)
- [ ] **`IProjectAgent.systemPromptLibraryRef?` field added** to `project-agent.model.ts` (Phase 1)
- [ ] **`cascade-delete.ts` deletes `PromptLibraryVersion` + `PromptLibraryItem`** in both `deleteProject()` and `deleteTenant()` (Phase 1)
- [ ] **`promptLibraryRouter` imported and mounted in `apps/runtime/src/server.ts`** at `/api/projects/:projectId/prompt-library` (Phase 2)
- [ ] **`resolveLibraryRef()` called in `VersionService.createVersion()`** after tool resolution (L305), before `allDocuments` construction (L307) (Phase 3)
- [ ] **`CreateVersionParams.libraryRef?` added** and forwarded from `versions.ts` via `agent.systemPromptLibraryRef` (Phase 3)
- [ ] **`incrementUsageCount()` called post-persist in `createVersion()`** wrapped in try-catch (non-fatal) (Phase 3)
- [ ] **`buildSystemPrompt()` defensive guard active** for empty template + libraryRef (Phase 3)
- [ ] **`AuditEventType` extended** with 5 `prompt.*` entries in `packages/compiler/src/platform/core/types.ts` (Phase 1)
- [ ] **`StudioPermission` constants added** to `permissions.ts` (6 `PROMPT_*` entries) and **`STUDIO_PROJECT_PERMISSION_ALIASES` updated** in `project-permission.ts` (Phase 4)
- [ ] **All 8 Studio proxy route files created** covering all 13 runtime endpoints (Phase 4)
- [ ] **`case 'prompt-library':` block added to `AppShell.tsx` `renderContent()`** with sub-page routing (Phase 5)
- [ ] **`'prompt-library'` in `navigation-store.ts` `ProjectPage` union** (Phase 5)
- [ ] **`'prompt-library'` in `navigation.ts` `resourceNavDefs`** (Phase 5)
- [ ] **`'prompt-library'` in `ProjectSidebar.tsx` independent `resourceNavDefs`** at L113–117 (Phase 5)
- [ ] **`nav.prompt_library` + `prompt_library.*` i18n namespace added** to `packages/i18n/locales/en/studio.json` (Phase 5)
- [ ] **`PromptPickerModal` imported + rendered in `IdentityEditor.tsx`** wired to working-copy `libraryRef` (Phase 6)
- [ ] **All 5 audit helpers called at correct service points** (Phase 2)
- [ ] **`resetPromptLibraryService()` + `resetPromptLibraryTestService()` called in test harness teardown** (Phase 2)

---

## 5. Cross-Phase Concerns

### Configuration (Environment Variables)

| Variable                                  | Default | Phase | Where Used                                                    |
| ----------------------------------------- | ------- | ----- | ------------------------------------------------------------- |
| `PROMPT_LIBRARY_TEST_TIMEOUT_MS`          | `60000` | 2     | `PromptLibraryTestService` per-pane `AbortController` timeout |
| `PROMPT_LIBRARY_TEST_MAX_PARALLEL`        | `5`     | 2     | Max panes per test request                                    |
| `PROMPT_LIBRARY_TEMPLATE_MAX_BYTES`       | `32768` | 2     | Template size boundary guard                                  |
| `PROMPT_LIBRARY_VARIABLE_VALUE_MAX_BYTES` | `4096`  | 2     | Variable value size at test endpoint                          |
| `PROMPT_LIBRARY_MAX_VERSIONS_PER_PROMPT`  | `200`   | 2     | Hard version count limit                                      |

### Schema Changes

All additive — zero data migration required:

- `prompt_library_items`: new collection, created on first insert
- `prompt_library_versions`: new collection, created on first insert
- `SystemPromptConfig.libraryRef`: optional field; existing `AgentVersion` documents unaffected
- `PromptLibraryItem.nextVersionNumber`: internal counter, default 0

### Feature Flags

None in v1. RBAC gates access. If soft-launch needed: add `requireFeature('prompt-library')` as one-line middleware addition to `server.ts` router mount.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases complete with exit criteria met
- [ ] E2E-1 through E2E-6 (runtime) passing
- [ ] E2E-7 (Studio Playwright) passing
- [ ] INT-1 through INT-12 (all integration tests) passing
- [ ] UT-1 through UT-8 (all unit tests) passing
- [ ] `pnpm build && pnpm test` baseline green (no regressions)
- [ ] Semgrep clean on new runtime routes + services
- [ ] Design token lint clean (no hardcoded palette colors)
- [ ] `docs/features/prompt-library.md` status updated to `ALPHA`
- [ ] `docs/testing/README.md` row updated to `12 INT + 7 E2E (ACTIVE)`
- [ ] `docs/features/prompt-library.md` §17 status column updated to `TESTED`
- [ ] `/post-impl-sync prompt-library` run to sync all SDLC artifacts

---

## 7. Open Questions

1. **`ModelResolutionService.resolve()` + `tenantModelId`**: `ResolutionContext` at `model-resolution.ts:160` has no direct `tenantModelId` field. Task 2.2 must read the full file to confirm the correct invocation pattern. If no direct path exists, `PromptLibraryTestService` may need to fetch the `TenantModel` by ID first and pass the resolved model directly to `createVercelProvider()`.

2. **`withRouteHandler` permissions type**: The `permissions` field in Studio proxy routes currently uses `'human_task:read' as any` per the oracle. Verify whether `withRouteHandler` validates permissions at runtime. Read `apps/studio/src/lib/route-handler.ts` fully before implementing Phase 4.

3. **`ProjectSidebar.tsx` icon**: `BookMarked` from `lucide-react` suggested for Prompt Library. Verify it exists by checking `apps/studio/package.json` lucide version and existing sidebar imports. Fallback: `Library` or `BookOpen`.

4. **Studio API route param — RESOLVED**: All Studio API routes live under `app/api/projects/[id]/` and use `params.id`. All LLD proxy route paths correctly use `[id]`. The test spec's `[projectId]` reference was a stale path — corrected in this LLD.

5. **`usageCount` decrement — DESCOPED v1**: The test spec INT-3 steps 3-4 (decrement `usageCount` when agent is recompiled without `libraryRef`, or when agent is deleted) are descoped from v1. Implementing decrement requires tracking "did the previous compiled version use a library ref" during recompile, and hooking into the agent delete path — significant complexity not justified for a denormalized counter. In v1, `usageCount` is increment-only. The authoritative source for current reference count is the reverse-reference query (`getReferences(promptId)` → `count`). INT-3 test only covers steps 1-2. Decrement implementation is a v1.5 backlog item.

6. **Storybook stories — DEFERRED**: Feature spec §13 task 4.6 mentions Storybook stories for new components. Studio has an existing Storybook setup. Creating stories for `PromptEditor`, `PromptComparePanel`, and `PromptPickerModal` is deferred to post-implementation as a separate task, not blocking the LLD phases.

---

## 8. Post-Implementation Notes

Deviations from plan discovered during implementation (all logged in `docs/sdlc-logs/prompt-library/implementation.log.md`):

- **Phase 3 (Compile-time hook)**: `AgentBasedDocument.systemPromptLibraryRef` injected dynamically via `as unknown as` cast — adding it to `@abl/core` package would have required a cross-package change. Two-step pattern: (1) inject + `resolveLibraryRef()` pre-compile sets `document.systemPrompt`; (2) post-process IR after `compileABLtoIR()` to copy `libraryRef` metadata into `ir.identity.system_prompt.libraryRef`.
- **Phase 5 (Studio UI)**: `sanitizeError()` requires 2 args (with fallback string); `project-pages.ts` had exhaustive type assertion for `ProjectPage` — both required additive changes. Studio pages are SPA-routed via `AppShell.tsx` `case 'prompt-library'` (not Next.js file-system pages as originally planned).
- **Phase 6 (Agent integration)**: Test endpoint API uses `panes: [{ promptVersionId, tenantModelId }]` flat array (not `mode`/`tenantModelIds`/`promptVersionIds` as originally described in the test spec — spec was written before implementation). Test spec updated with deviation note.
- **Promote idempotency** (Round 2 fix): Promoting an already-active version returns `200` (idempotent) instead of `409`. Resolves a usability gap not in the original LLD.
- **`usageCount` decrement**: Descoped from v1 per §7 oracle note. Increment-only in v1; authoritative count via reverse-reference query.

---

## 9. References

- Feature spec: `docs/features/prompt-library.md`
- HLD: `docs/specs/prompt-library.hld.md`
- Test spec: `docs/testing/prompt-library.md`
- SDLC logs: `docs/sdlc-logs/prompt-library/`
- Pattern references:
  - `apps/runtime/src/services/version-service.ts:219-345` — `createVersion()` pipeline (injection point for libraryRef hook)
  - `apps/runtime/src/services/version-service.ts:705-716` — singleton pattern with `resetX()`
  - `packages/database/src/models/workflow-version.model.ts` — `tenantIsolationPlugin` + index pattern
  - `packages/database/src/models/index.ts:290-295` — model export pattern
  - `packages/shared-auth/src/rbac/role-permissions.ts:228-419` — `PERMISSION_REGISTRY` + auto-derived allowlist
  - `apps/runtime/src/routes/versions.ts:1-100` — router middleware chain
  - `apps/runtime/src/services/audit-helpers.ts:17-32` — `writeAuditLog()` wrapper pattern
  - `apps/studio/src/app/api/projects/[id]/human-tasks/route.ts` — Studio proxy route pattern
  - `apps/studio/src/lib/runtime-proxy.ts:39-65` — `proxyToRuntime()` signature
  - `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts:832-946` — E2E harness
  - `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts:301-325` — `bootstrapProject()` + `provisionTenantModel()`
