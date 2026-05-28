# LLD: External Agent Registry

**Feature Spec**: `docs/features/external-agent-registry.md`
**HLD**: `docs/specs/external-agent-registry.hld.md`
**Test Spec**: `docs/testing/external-agent-registry.md`
**Status**: DONE
**Date**: 2026-04-28

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                                           | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Alternatives Rejected                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Repo lives at `packages/shared/src/repos/external-agent-config-repo.ts`                                                            | Existing convention: models in `packages/database/src/models/`, repos in `packages/shared/src/repos/`. All other repos (mcp-server-config-repo, project-tool-repo) follow this separation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `packages/database/src/repositories/` (directory does not exist)                                                                 |
| D-2 | Auth injection done in `handleHandoff()` post-lookup via `enrichWithRegistryAuth()`, not in `resolveRemoteFromHandoff()`           | `lookupAgentForSession` has ~20 synchronous call sites in routing-executor.ts. Making `resolveRemoteFromHandoff` async cascades all of them. `handleHandoff` is already `async` — single await added there. `enrichWithRegistryAuth` is a private method on `RoutingExecutor` that receives an injectable `lookupExternalAgent` for testability. **HLD divergence**: The HLD (Sections 3 data flow, 4 concern #2 data access pattern, 3 sequence diagram, concerns #10-#11 migration/rollback) references `resolveRemoteFromHandoff()` as the integration point. These HLD sections were updated during post-impl-sync to reflect `enrichWithRegistryAuth()` in `handleHandoff()`. | Making `resolveRemoteFromHandoff` async (cascading refactor, out of scope); pre-loading into session (incorrect lifecycle)       |
| D-8 | `header` is the canonical field name for the auth header override (not `headerName`)                                               | Matches `OutboundAuthConfig.header` at `packages/a2a/src/infrastructure/authenticated-client-factory.ts:57` and `AgentRegistryEntry.remote.auth.header`. All Zod schemas, DB plaintext JSON, and API contracts use `header`. Note: test spec and feature spec previously used `headerName` — corrected to `header` during post-impl-sync.                                                                                                                                                                                                                                                                                                                                          | `headerName` (used in feature spec and test spec — these are stale; post-impl-sync corrects them)                                |
| D-9 | `handleFanOut` remote path (line 3052) deferred to a future feature iteration for auth enrichment                                  | `handleFanOut` at line 4239 has its own `lookupAgentForSession` call (line 4337) and `createClientForAgent` call (line 3052) bypassing `handleHandoff`. This path handles concurrent fan-out to remote agents. This LLD enriches only the sequential `handleHandoff` path. Fan-out with authenticated external registry agents requires a separate future iteration (out of scope for this LLD).                                                                                                                                                                                                                                                                                   | Enriching both paths in this LLD (fan-out remote auth is unnecessary complexity for the initial external-agent-registry rollout) |
| D-3 | Both MCPServerConfig AND ExternalAgentConfig added to cascade-delete in same commit                                                | Same file, same function. Leaving MCPServerConfig missing is a data integrity bug. Adding both together is minimal incremental change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fix only ExternalAgentConfig (leaves known data leak unfixed)                                                                    |
| D-4 | External agents merged into `availableAgents[]` in `CompletionContext`                                                             | `CompletionContext` at `packages/language-service/src/types.ts` defines `availableAgents: Array<{name:string}>` as intentionally generic. ABL handoffs target by name regardless of agent locality.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | New `availableExternalAgents` field (interface change, broader blast radius)                                                     |
| D-5 | `discoverAgent()` wrapped in exported `testExternalAgentConnection()` function in the repo module (not called directly from route) | Route handlers must not assemble DI deps for `discoverAgent` (needs `tracing`, `validator`, `createClient`). Test-connection is multi-step logic: SSRF-check + discover + patch. Repo module-level functions delegate encryption to the model plugin.                                                                                                                                                                                                                                                                                                                                                                                                                              | Direct `discoverAgent` call in route (couples route to DI wiring)                                                                |
| D-6 | `SsrfEndpointValidator` constructed inline per route-handler class, not shared singleton                                           | Matches `server.ts:1576` pattern where validator is constructed inline. Validators are stateless and cheap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Shared singleton passed via DI (unnecessary complexity for stateless class)                                                      |
| D-7 | Permissions registered in `PERMISSION_REGISTRY` AND `PROJECT_ROLE_PERMISSIONS`                                                     | `requireProjectPermission` reads permissions via `hasPermission` which checks `PROJECT_ROLE_PERMISSIONS`. `PERMISSION_REGISTRY` feeds the custom-role permission picker in Studio. Both must be updated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Permissions as bare strings without registration (would not appear in Studio role editor)                                        |

### Key Interfaces & Types

```typescript
// packages/database/src/models/external-agent-config.model.ts
export interface IExternalAgentConfig {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  displayName: string | null;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  encryptedAuthConfig: string | null; // Mongoose String; encryptionPlugin encrypts whole field
  // plaintext JSON: { value: string, header?: string }
  // Field name is `header` (NOT `headerName`). Matches OutboundAuthConfig.header.
  lastDiscoveredCard: object | null;
  lastConnectionStatus: 'connected' | 'failed' | null;
  lastConnectionAt: Date | null;
  lastConnectionLatencyMs: number | null;
  lastConnectionError: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// packages/shared/src/repos/external-agent-config-repo.ts (module-level functions, not a class)
export interface ExternalAgentLookupResult {
  endpoint: string;
  protocol: string;
  authType: string;
  encryptedAuthConfig: string | null; // already decrypted by encryptionPlugin on read
}

export type LookupExternalAgent = (
  tenantId: string,
  projectId: string,
  name: string,
) => Promise<ExternalAgentLookupResult | null>;

// apps/runtime/src/routes/external-agents.ts
export interface ExternalAgentConfigView {
  id: string;
  name: string;
  displayName: string | null;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  authConfigured: boolean; // derived from encryptedAuthConfig !== null; NEVER expose raw
  lastDiscoveredCard: object | null;
  lastConnectionStatus: 'connected' | 'failed' | null;
  lastConnectionAt: string | null;
  lastConnectionLatencyMs: number | null;
  lastConnectionError: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### Module Boundaries

| Module                               | Responsibility                                                                                                                 | Depends On                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `packages/database` — model          | Schema, indexes, plugins, uuidv7 `_id`, Mongoose model export                                                                  | `encryptionPlugin`, `tenantIsolationPlugin`, `uuidv7`                                                    |
| `packages/shared` — repo             | Module-level CRUD functions (`findExternalAgentConfigByName`, etc.), `testExternalAgentConnection`, `LookupExternalAgent` type | database model, `discoverAgent` from `@agent-platform/a2a`                                               |
| `packages/shared-auth` — permissions | `external_agent:*` permissions in `PERMISSION_REGISTRY` + `PROJECT_ROLE_PERMISSIONS`                                           | none (string literals)                                                                                   |
| `packages/database` — cascade        | `deleteProject` + `deleteTenant` extended with ExternalAgentConfig + MCPServerConfig                                           | database model                                                                                           |
| `apps/runtime` — routes              | CRUD routes + test-connection, SSRF validation, credential masking, card discovery                                             | repo, `requireProjectPermission`, `discoverAgent`, `SsrfEndpointValidator`                               |
| `apps/runtime` — server.ts           | Mount `externalAgentRouter` at `/api/projects/:projectId/external-agents`                                                      | routes file                                                                                              |
| `apps/runtime` — routing-executor    | Auth injection via `enrichWithRegistryAuth()` in `handleHandoff()`, injectable `LookupExternalAgent`                           | `findExternalAgentConfigByName` function ref (optional 3rd constructor param), `AgentRegistryEntry` type |
| `apps/runtime` — test harness        | `allowPrivateEndpoints?: boolean` option in `RuntimeHarnessOptions`                                                            | server.ts, SsrfEndpointValidator                                                                         |
| `apps/studio` — proxy routes         | 3 Next.js route files proxying all 6 ops to Runtime via `proxyToRuntime`                                                       | `runtime-proxy.ts`, Next.js `withRouteHandler`                                                           |
| `apps/studio` — UI components        | List page, registration modal, edit panel, skills display                                                                      | Studio design system, fetch API                                                                          |
| `apps/studio` — ABLEditor            | Merge external agents into `availableAgents` in completion context                                                             | `loadAgentsForContext()`, `getCompletions()` from `@abl/language-service`                                |

---

## 2. File-Level Change Map

### New Files

| File                                                                                       | Purpose                                                                                | LOC Est. |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------- |
| `packages/database/src/models/external-agent-config.model.ts`                              | Mongoose model, schema, plugins, indexes                                               | ~80      |
| `packages/shared/src/repos/external-agent-config-repo.ts`                                  | Module-level CRUD functions + `testExternalAgentConnection`                            | ~200     |
| `apps/runtime/src/routes/external-agents.ts`                                               | 6 route handlers (CRUD + test-connection)                                              | ~280     |
| `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`                           | 8 E2E test scenarios                                                                   | ~350     |
| `apps/runtime/src/__tests__/external-agents-integration.test.ts`                           | INT-1–INT-5, INT-7 integration scenarios                                               | ~300     |
| `apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts`                    | INT-6, INT-8, UT-3 (DI-based unit + resolution tests)                                  | ~200     |
| `packages/database/src/models/__tests__/external-agent-config.test.ts`                     | UT-1 (model schema, encryption plugin, indexes)                                        | ~100     |
| `packages/database/src/__tests__/cascade-delete-modules.test.ts`                           | Cascade delete coverage (ExternalAgentConfig + MCPServerConfig added to existing file) | ~60      |
| `apps/studio/src/__tests__/external-agents-api.test.ts`                                    | Studio proxy path construction (FR-7)                                                  | ~80      |
| `apps/studio/src/app/api/projects/[id]/external-agents/route.ts`                           | Studio proxy: POST create + GET list                                                   | ~50      |
| `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/route.ts`                 | Studio proxy: GET single + PATCH + DELETE                                              | ~60      |
| `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/test-connection/route.ts` | Studio proxy: POST test-connection                                                     | ~30      |
| `apps/studio/src/api/external-agents.ts`                                                   | API client module (follows tools.ts apiFetch pattern)                                  | ~60      |
| `apps/studio/src/components/external-agents/ExternalAgentsPage.tsx`                        | List page with status badges + test-connection action                                  | ~250     |
| `apps/studio/src/components/external-agents/RegisterExternalAgentModal.tsx`                | Registration form modal                                                                | ~200     |
| `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx`                    | Edit panel with skills display                                                         | ~200     |

### Modified Files

| File                                                        | Change Description                                                                                                      | Risk   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/index.ts`                     | Export `ExternalAgentConfig` + `IExternalAgentConfig`                                                                   | Low    |
| `packages/database/src/cascade/cascade-delete.ts`           | Add ExternalAgentConfig + MCPServerConfig to `deleteProject` + `deleteTenant`                                           | Low    |
| `packages/shared/src/repos/index.ts`                        | Export all `external-agent-config-repo` functions + `LookupExternalAgent` type                                          | Low    |
| `packages/shared-auth/src/rbac/role-permissions.ts`         | Add `external_agent:*` to `PROJECT_ROLE_PERMISSIONS` + `PERMISSION_REGISTRY`                                            | Low    |
| `apps/runtime/src/server.ts`                                | Import + mount `externalAgentRouter`                                                                                    | Low    |
| `apps/runtime/src/services/execution/routing-executor.ts`   | Inject `lookupExternalAgent` constructor param + enrich in `handleHandoff`                                              | Medium |
| `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` | Add `allowPrivateEndpoints?: boolean` to `RuntimeHarnessOptions`; add `ALLOW_SSRF_PRIVATE_RANGES` to `MANAGED_ENV_KEYS` | Low    |
| `apps/studio/src/components/abl/ABLEditor.tsx`              | Extend `loadAgentsForContext()` with external agents fetch                                                              | Low    |
| `packages/i18n/locales/en/studio.json`                      | Add `externalAgents` i18n namespace keys                                                                                | Low    |

---

## 3. Implementation Phases

### Phase 1: Data Layer — Model, Repo, Permissions, Cascade Delete

**Goal**: Establish the database foundation, CRUD repository, permission registration, and cascade delete. No routes yet.

**Tasks**:

1.1. Create `packages/database/src/models/external-agent-config.model.ts`:

- Interface `IExternalAgentConfig` with all fields from HLD Section 5
- `ExternalAgentConfigSchema` with `{ timestamps: true, collection: 'external_agent_configs' }`
- `_id: { type: String, default: uuidv7 }`
- All fields as Mongoose `{ type: String/Date/Number, default: null/value }` — NO nested subdocuments
- `encryptedAuthConfig: { type: String, default: null }` — Mongoose String (plugin encrypts whole field)
- `lastConnectionStatus: { type: String, enum: ['connected', 'failed'], default: null }` — no 'untested'
- Apply `schema.plugin(tenantIsolationPlugin)` first
- Apply `schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['encryptedAuthConfig'], scope: 'project', scopeFields: { tenantId: 'tenantId', projectId: 'projectId' } })`
- Index: `schema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true })`
- Index: `schema.index({ tenantId: 1, projectId: 1 })`
- Model export with `(mongoose.models.ExternalAgentConfig as any) || model<IExternalAgentConfig>('ExternalAgentConfig', ExternalAgentConfigSchema)`

  1.2. Export from `packages/database/src/models/index.ts`:

- Add `export { ExternalAgentConfig, type IExternalAgentConfig } from './external-agent-config.model.js';`
- Place after the existing MCPServerConfig export (search for `MCPServerConfig` to find insertion point)

  1.3. Add `external_agent:*` permissions to `packages/shared-auth/src/rbac/role-permissions.ts`:

- In `PROJECT_ROLE_PERMISSIONS`: add `'external_agent:*'` to `developer`; add `'external_agent:read'` to `viewer` and `tester`
- In `PERMISSION_REGISTRY` (around line 232): `permissions` is `readonly string[]` — add:
  ```typescript
  {
    category: 'external_agents',
    label: 'External Agents',
    permissions: [
      'external_agent:create',
      'external_agent:read',
      'external_agent:update',
      'external_agent:delete',
    ] as const,
  }
  ```
- Exact format verified against existing entries such as `{ category: 'tools', label: 'Tools', permissions: ['tool:read', ...] }`

  1.4. Create `packages/shared/src/repos/external-agent-config-repo.ts` (module-level function pattern, not a class):

- Pattern: exactly follows `packages/shared/src/repos/mcp-server-config-repo.ts` (module-level exported async functions, dynamic model import inside each function, `normalizeDocument()` utility)
- Each function: `const { ExternalAgentConfig } = await import('@agent-platform/database/models');`
- Exported functions:
  - `createExternalAgentConfig(data: CreateExternalAgentInput): Promise<IExternalAgentConfig>`
  - `findExternalAgentConfigById(id: string, tenantId: string, projectId: string): Promise<IExternalAgentConfig | null>` — query `{ _id: id, tenantId, projectId }`
  - `findExternalAgentConfigsByProject(tenantId: string, projectId: string): Promise<IExternalAgentConfig[]>` — query `{ tenantId, projectId }`
  - `findExternalAgentConfigByName(tenantId: string, projectId: string, name: string): Promise<ExternalAgentLookupResult | null>` — projects only `{ endpoint, protocol, authType, encryptedAuthConfig }` — this is the `LookupExternalAgent` implementation
  - `updateExternalAgentConfig(id: string, tenantId: string, projectId: string, patch: UpdateExternalAgentInput): Promise<IExternalAgentConfig | null>` — use `findOne({ _id, tenantId, projectId })` → `doc.set(patch)` → `doc.save()` (NOT `findOneAndUpdate`) so `encryptionPlugin` pre-save hook fires
  - `deleteExternalAgentConfig(id: string, tenantId: string, projectId: string): Promise<boolean>`
  - `patchExternalAgentConnectionStatus(id: string, tenantId: string, projectId: string, status: ConnectionStatusPatch): Promise<IExternalAgentConfig | null>` — same findOne+set+save pattern
- `testExternalAgentConnection(endpoint: string, tenantId: string, allowPrivate: boolean): Promise<ConnectionTestResult>` — exported standalone async function (not a class):
  - Construct `SsrfEndpointValidator` inline
  - Call `discoverAgent({ endpoint, tenantId, allowPrivate }, { tracing: noopTracing, validator, createClient: createA2AClient })` with `AbortSignal.timeout(5000)` in deps
  - `ConnectionTestResult: { reachable: boolean; agentCard?: AgentCard; error?: string; latencyMs: number }`
- Export `LookupExternalAgent` type: `type LookupExternalAgent = (tenantId: string, projectId: string, name: string) => Promise<ExternalAgentLookupResult | null>;`
- The `LookupExternalAgent` implementation is `findExternalAgentConfigByName` — pass as a direct function reference (no class instantiation, no `.bind()`)

  1.5. Export from `packages/shared/src/repos/index.ts`:

- Add exports for all functions from `external-agent-config-repo.ts` plus `LookupExternalAgent` and `ExternalAgentLookupResult` types

  1.6. Extend `packages/database/src/cascade/cascade-delete.ts`:

- In `deleteProject()` dynamic import block (lines 226–258): add `ExternalAgentConfig` and `MCPServerConfig` to the destructured import
- After the existing `AuthProfile.deleteMany` call (around line 387), add:
  ```typescript
  counts.ExternalAgentConfig = (await ExternalAgentConfig.deleteMany({ projectId })).deletedCount;
  counts.MCPServerConfig = (await MCPServerConfig.deleteMany({ projectId })).deletedCount;
  ```
- Repeat the `MCPServerConfig` pattern in `deleteTenant()` — add both models to the tenant-scoped deleteMany calls with `{ tenantId }`

**Files Touched**:

- `packages/database/src/models/external-agent-config.model.ts` — NEW
- `packages/database/src/models/index.ts` — add export
- `packages/database/src/cascade/cascade-delete.ts` — add ExternalAgentConfig + MCPServerConfig
- `packages/shared/src/repos/external-agent-config-repo.ts` — NEW
- `packages/shared/src/repos/index.ts` — add exports
- `packages/shared-auth/src/rbac/role-permissions.ts` — add permissions

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 TypeScript errors
- [ ] `pnpm build --filter=@agent-platform/shared` succeeds with 0 TypeScript errors
- [ ] `pnpm build --filter=@agent-platform/shared-auth` succeeds with 0 TypeScript errors
- [ ] `ExternalAgentConfig` is exported from `packages/database/src/models/index.ts`
- [ ] `findExternalAgentConfigByName`, `createExternalAgentConfig`, `testExternalAgentConnection`, and `LookupExternalAgent` are exported from `packages/shared/src/repos/index.ts`
- [ ] `external_agent:create`, `external_agent:read`, `external_agent:update`, `external_agent:delete` appear in `PERMISSION_REGISTRY`
- [ ] `external_agent:*` appears in `PROJECT_ROLE_PERMISSIONS.developer`
- [ ] `external_agent:read` appears in `PROJECT_ROLE_PERMISSIONS.viewer` and `PROJECT_ROLE_PERMISSIONS.tester`

**Test Strategy**:

- Unit: `findExternalAgentConfigByName()` with MongoMemoryServer — verify `encryptionPlugin` decrypts `encryptedAuthConfig` on read
- Unit: `testExternalAgentConnection()` with mock `discoverAgent` — verify success/failure result shapes

**Rollback**: Delete new model file and repo file, revert index.ts exports, revert cascade-delete.ts and role-permissions.ts changes.

---

### Phase 2: Runtime API Routes

**Goal**: CRUD routes + test-connection route on the runtime, including SSRF validation, credential masking, and agent card discovery.

**Tasks**:

2.1. Create `apps/runtime/src/routes/external-agents.ts`:

- Router setup: `Router({ mergeParams: true })`
- Middleware chain: `router.use(authMiddleware)` + `router.use(requireProjectScope('projectId'))` + `router.use(tenantRateLimit('request'))`
- Import `{ findExternalAgentConfigById, findExternalAgentConfigsByProject, createExternalAgentConfig, updateExternalAgentConfig, deleteExternalAgentConfig, patchExternalAgentConnectionStatus, testExternalAgentConnection }` from `@agent-platform/shared/repos`
- Import `SsrfEndpointValidator` from `@agent-platform/a2a`
- Zod schemas: `createExternalAgentBody`, `updateExternalAgentBody`, `projectIdParam`, `agentIdParam`
  - `name`: `z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Name must be a valid ABL identifier')`
  - `endpoint`: `z.string().url()`
  - `protocol`: `z.enum(['a2a', 'rest'])`
  - `authType`: `z.enum(['none', 'bearer', 'api_key'])`
  - `authConfig`: `z.object({ value: z.string().min(1), header: z.string().optional() }).optional().nullable()`
- Helper `maskResponse(doc: IExternalAgentConfig): ExternalAgentConfigView` — strips `encryptedAuthConfig`, adds `authConfigured: doc.encryptedAuthConfig !== null`
- **POST /**: `requireProjectPermission(req, res, 'external_agent:create')` → Zod validate → SSRF validate endpoint via `getDevSSRFOptions()` → `createExternalAgentConfig()` → `testExternalAgentConnection()` (non-blocking, catch error, `patchExternalAgentConnectionStatus()`) → return 201 with masked response
- **GET /**: `requireProjectPermission(req, res, 'external_agent:read')` → `findByProjectId()` → return 200 with masked array
- **GET /:id**: `requireProjectPermission(req, res, 'external_agent:read')` → `findById()` → 404 if null → return 200 with masked response
- **PATCH /:id**: `requireProjectPermission(req, res, 'external_agent:update')` → Zod validate → if endpoint changed, SSRF re-validate → if `authConfig === null` clear `encryptedAuthConfig` → `update()` → return 200 with masked response
- **DELETE /:id**: `requireProjectPermission(req, res, 'external_agent:delete')` → `delete()` → return 204
- **POST /:id/test-connection**: `requireProjectPermission(req, res, 'external_agent:update')` → `findExternalAgentConfigById()` → `testExternalAgentConnection()` → `patchExternalAgentConnectionStatus()` → return 200 with masked response
- Error handling: duplicate key (code 11000) → `{ success: false, error: { code: 'DUPLICATE_NAME', ... }, status: 409 }`; SSRF thrown → `{ success: false, error: { code: 'SSRF_REJECTED', ... }, status: 400 }`; not found → 404

  2.2. Register router in `apps/runtime/src/server.ts`:

- Add import: `import externalAgentRouter from './routes/external-agents.js';`
- Add mount after `promptLibraryRouter`: `app.use('/api/projects/:projectId/external-agents', externalAgentRouter);`
- Place import near the `promptLibraryRouter` import (alphabetical or grouped by feature area)

**Files Touched**:

- `apps/runtime/src/routes/external-agents.ts` — NEW
- `apps/runtime/src/server.ts` — add import + mount

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 TypeScript errors
- [ ] `POST /api/projects/:id/external-agents` returns 201 with `authConfigured: false` when `authConfig` absent
- [ ] `POST /api/projects/:id/external-agents` with private IP endpoint returns 400 `{code: 'SSRF_REJECTED'}`
- [ ] `POST /api/projects/:id/external-agents` with duplicate `name` returns 409 `{code: 'DUPLICATE_NAME'}`
- [ ] `GET /api/projects/:id/external-agents/:agentId` response never contains `encryptedAuthConfig` field
- [ ] `DELETE /api/projects/:id/external-agents/:agentId` returns 204

**Test Strategy**:

- Integration: INT-1 through INT-5 from test spec (permissions, SSRF, duplicate name, masking, card fetch)
- Use `startRuntimeServerHarness()` for full middleware chain; SSRF-rejection test in a harness WITHOUT `allowPrivateEndpoints`

**Rollback**: Remove route file, revert server.ts import + mount.

---

### Phase 3: Runtime Auth Injection in `handleHandoff`

**Goal**: Enrich the `AgentRegistryEntry` with decrypted registry credentials inside the async `handleHandoff` path before `createClientForAgent` is called. Keep `resolveRemoteFromHandoff` synchronous.

**Tasks**:

3.1. Add `lookupExternalAgent?: LookupExternalAgent` as an injectable constructor parameter to `RoutingExecutor` (or as an optional field set via `setLookupExternalAgent(fn)`):

- This enables UT-3 (inject a fake lookup function without `vi.mock`)
- Default production wiring: import `findExternalAgentConfigByName` from `@agent-platform/shared/repos` and pass as the 3rd constructor argument

  3.2. In `apps/runtime/src/services/execution/routing-executor.ts`, inside `handleHandoff()` at the point after line 872 (`const targetAgentInfo = lookupAgentForSession(...)`):

- Add a helper method `private async enrichWithRegistryAuth(entry: AgentRegistryEntry, session: RuntimeSession, targetAgent: string): Promise<AgentRegistryEntry>`:
  - If `entry.location !== 'remote'` OR `entry.remote?.auth?.value` is already set: return entry unchanged
  - Call `await this.lookupExternalAgent?.(session.tenantId, session.projectId, targetAgent)`
  - If null: return entry unchanged (fall back to inline, emit `{registryHit: false}` trace event)
  - If found: build enriched entry:
    - Use registry `endpoint` (overrides inline)
    - If `authType === 'none'`: `auth = undefined`
    - If `authType === 'bearer' | 'api_key'`: parse `JSON.parse(encryptedAuthConfig)` → `{ value, header? }`, build `auth = { type: authType, value, header }`
  - Emit `TraceEvent: { type: 'remote_agent_registry_lookup', agentName: targetAgent, registryHit: true, endpoint: registry.endpoint, authType: registry.authType }` — NEVER include `value`
- After `const targetAgentInfo = lookupAgentForSession(...)`:
  - Change to: `let enrichedAgentInfo = targetAgentInfo;`
  - If `targetAgentInfo?.location === 'remote'`: `enrichedAgentInfo = await this.enrichWithRegistryAuth(targetAgentInfo, session, targetAgent);`
- Replace all uses of `targetAgentInfo` in `handleHandoff` with `enrichedAgentInfo`

  3.3. Wire `lookupExternalAgent` in production:

- `RoutingExecutor` is constructed in exactly ONE production location: `apps/runtime/src/services/runtime-executor.ts:912` as `new RoutingExecutor(this as unknown as ExecutorContext, this.llmWiring)`
- Make `lookupExternalAgent` an **optional third constructor parameter** (default `undefined`) so all existing test construction sites (`escalation-transfer-wiring.test.ts:84`, `agent-switch-event.test.ts:262/316/383/494/526`, `scripted-mode-handoff-fix.unit.test.ts:253/277/299/323`) compile unmodified
- In `runtime-executor.ts:912`: inject `findExternalAgentConfigByName` (a direct function reference imported from `@agent-platform/shared/repos`) — no class instantiation, no `.bind()` needed
- Add constructor: `constructor(private ctx: ExecutorContext, private llmWiring: LLMWiringService, private lookupExternalAgent?: LookupExternalAgent)`

  3.3b. Call-site audit — all `createClientForAgent` and `lookupAgentForSession` paths in `routing-executor.ts`:

| Call site (line)                                                      | Path                                                               | Covered by Phase 3 enrichment?                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `lookupAgentForSession` at 872                                        | `handleHandoff` (main entry point)                                 | YES — enrichment runs before line 1062 dispatch              |
| `createClientForAgent` at 1898                                        | `handleRemoteHandoff` (receives `agentInfo` from `handleHandoff`)  | YES — agentInfo is enriched before dispatch                  |
| `createClientForAgent` at 2071                                        | `handleStreamingRemoteHandoff` (called from `handleRemoteHandoff`) | YES — agentInfo flows from `handleHandoff`                   |
| `createClientForAgent` at 2156                                        | `handleStreamingRemoteHandoff` (second call)                       | YES — same agentInfo                                         |
| `createClientForAgent` at 2381                                        | `handleAsyncRemoteHandoff` (called from `handleRemoteHandoff`)     | YES — same agentInfo                                         |
| `lookupAgentForSession` at 3286                                       | `handleDelegate`                                                   | NO remote dispatch in delegate path — verify before Phase 3  |
| `lookupAgentForSession` at 4337/4390 + `createClientForAgent` at 3052 | `handleFanOut` — OWN lookup path bypassing `handleHandoff`         | **NOT COVERED** — deferred to Phase 2 per D-9                |
| `lookupAgentForSession` at 1530/2557/2571/2794/2964                   | IR resolution / task dispatchers                                   | No `createClientForAgent` call; read-only use — not affected |

**Phase 1 scope**: Phase 3 enrichment covers the sequential HANDOFF TO: path (`handleHandoff` → `handleRemoteHandoff`). Fan-out authenticated external agents require Phase 2 work. `handleDelegate` does not call `createClientForAgent` directly and is not in scope.

3.4. Add catch in `enrichWithRegistryAuth` for credential decryption failures — **hard-fail, do NOT silently downgrade to unauthenticated**:

```typescript
// If encryptedAuthConfig is present but unparseable, throw a sanitized error
// to prevent silent unauthenticated requests to auth-required endpoints.
let authPayload: { value: string; header?: string } | null = null;
if (registryEntry.encryptedAuthConfig) {
  try {
    authPayload = JSON.parse(registryEntry.encryptedAuthConfig);
  } catch (err) {
    log.error('Failed to parse decrypted external agent credentials', {
      agentName: targetAgent,
      error: err instanceof Error ? err.message : String(err),
    });
    // Hard-fail: throw an error that handleHandoff's catch path will surface
    // as a sanitized failure message ("Remote handoff to X failed: credential error")
    throw new Error(`Remote handoff to "${targetAgent}" failed: credential configuration error`);
  }
}
```

The thrown error propagates to `handleHandoff`'s existing error-handling path which calls `handleHandoffFailure` with a sanitized message. The user sees a generic handoff failure; the raw error is in server logs. **Never fall through to an unauthenticated request when a registry entry exists but credentials are broken** — this would silently bypass authentication configured by the operator.

**Files Touched**:

- `apps/runtime/src/services/execution/routing-executor.ts` — inject `lookupExternalAgent`, add `enrichWithRegistryAuth`, modify `handleHandoff`
- `apps/runtime/src/server.ts` — wire `findExternalAgentConfigByName` (direct function ref) to RoutingExecutor constructor

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 TypeScript errors
- [ ] Unit test UT-3: construct `RoutingExecutor` with injected fake `LookupExternalAgent` returning `{ endpoint: 'https://remote.example.com', authType: 'bearer', encryptedAuthConfig: '{"value":"tok"}' }` → `enrichWithRegistryAuth` produces entry with `remote.auth.value === 'tok'`
- [ ] Unit test UT-3: injected `LookupExternalAgent` returning `null` → `enrichWithRegistryAuth` returns entry unchanged from inline IR
- [ ] Unit test UT-3: `authType: 'none'` → `enrichWithRegistryAuth` produces entry with `remote.auth === undefined`
- [ ] Unit test UT-3: `JSON.parse(encryptedAuthConfig)` throws → `enrichWithRegistryAuth` throws a sanitized error (NOT silent downgrade)
- [ ] TraceEvent emitted with `{registryHit: true, authType: 'bearer'}` and NO `value` field
- [ ] Existing test files (`escalation-transfer-wiring.test.ts`, `agent-switch-event.test.ts`, `scripted-mode-handoff-fix.unit.test.ts`) compile and pass unchanged — optional 3rd param defaults to `undefined`

**Test Strategy**:

- Unit tests (UT-3): inject fake `LookupExternalAgent` directly into `RoutingExecutor` constructor — tests `enrichWithRegistryAuth` logic without any DB or process isolation. Note: test spec refers to `resolveRemoteFromHandoff` in UT-3 description — the implementation target is `enrichWithRegistryAuth` on `RoutingExecutor`. The test file must reflect this.
- E2E tests (E2E-2, E2E-3, E2E-7): full runtime + in-process A2A stub — verify bearer/api_key/none auth flows end-to-end

**Rollback**: Revert routing-executor.ts changes. The `lookupExternalAgent` defaults to `undefined` → `enrichWithRegistryAuth` no-ops → behavior identical to pre-feature.

---

### Phase 4: Test Infrastructure — Harness + A2A Stub Extension

**Goal**: Extend `RuntimeHarnessOptions` with `allowPrivateEndpoints` and prepare the A2A stub for auth-header verification.

**Tasks**:

4.1. Extend `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`:

- Add `allowPrivateEndpoints?: boolean` to `RuntimeHarnessOptions` interface
- Thread the option via the **`ALLOW_SSRF_PRIVATE_RANGES`** env var (verified: `packages/shared-kernel/src/security/ssrf-validator.ts:441`): add `'ALLOW_SSRF_PRIVATE_RANGES'` to `MANAGED_ENV_KEYS` and set `process.env.ALLOW_SSRF_PRIVATE_RANGES = options.allowPrivateEndpoints ? 'true' : undefined` in the env-setup section
- The route calls `getDevSSRFOptions()` from `@agent-platform/shared-kernel/security` (exported at `packages/shared-kernel/src/security/index.ts:10`). It reads `ALLOW_SSRF_PRIVATE_RANGES`. This is the same mechanism used by `routing-executor.ts`, `tenant-models.ts`, and `proxy-config.ts`.
- **Implementation note for Phase 2**: The `external-agents.ts` route imports `getDevSSRFOptions` from `@agent-platform/shared-kernel/security` and uses it as:
  ```typescript
  import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
  // In each handler where SSRF check is needed:
  const { allowLocalhost, allowPrivateRanges } = getDevSSRFOptions();
  const ssrfValidator = new SsrfEndpointValidator();
  ssrfValidator.validate(endpoint, (allowLocalhost || allowPrivateRanges) ?? false);
  ```
- `shouldAllowPrivateRemoteEndpoints()` at `routing-executor.ts:650` is module-private (no `export`) — it cannot be imported by the route file. Use `getDevSSRFOptions()` directly.

  4.2. Extend `apps/runtime/src/__tests__/helpers/mock-a2a-remote-agent.ts`:

- Add support for recording received `Authorization` and custom headers (for E2E-2/E2E-3 auth injection verification)
- Add `getReceivedHeaders(): Record<string, string>` accessor to verify that the runtime passed the correct auth header
- Add option to return configurable agent card content (for skills display test)
- Add option to return a 401 response (for connection failure test scenarios)

**Files Touched**:

- `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` — add `allowPrivateEndpoints`
- `apps/runtime/src/__tests__/helpers/mock-a2a-remote-agent.ts` — add header recording + configurable responses

**Exit Criteria**:

- [ ] `startRuntimeServerHarness({ allowPrivateEndpoints: true })` compiles (TypeScript)
- [ ] E2E-4 (test-connection with in-process stub) passes: stub at 127.0.0.1 is reachable when `allowPrivateEndpoints: true`
- [ ] INT-4 (SSRF rejection): harness started WITHOUT `allowPrivateEndpoints` → `POST /external-agents` with `endpoint: 'http://127.0.0.1:9999'` returns 400

**Test Strategy**:

- Verify harness option by running INT-4 in a describe block using a harness WITHOUT `allowPrivateEndpoints`
- Verify auth header injection in E2E-2/E2E-3 by reading `stub.getReceivedHeaders()['authorization']`

**Rollback**: Revert harness and mock changes. Tests that use `allowPrivateEndpoints: true` will fail (expected — Phase 4 is test infra only).

---

### Phase 5: Studio Proxy Routes

**Goal**: Thin Next.js proxy routes that forward all 6 external-agent operations to the runtime.

**Tasks**:

5.1. Create `apps/studio/src/app/api/projects/[id]/external-agents/route.ts`:

- Pattern: exactly follows `apps/studio/src/app/api/projects/[id]/human-tasks/route.ts` using `withRouteHandler`
- Import `withRouteHandler` from `@/lib/route-handler`, `proxyToRuntime` from `@/lib/runtime-proxy`

```typescript
export const GET = withRouteHandler(
  { requireProject: true, permissions: 'external_agent:read' as any },
  async ({ request, tenantId, params }) =>
    proxyToRuntime(request, `/api/projects/${params.id}/external-agents`, { tenantId }),
);
export const POST = withRouteHandler(
  { requireProject: true, permissions: 'external_agent:create' as any },
  async ({ request, tenantId, params }) =>
    proxyToRuntime(request, `/api/projects/${params.id}/external-agents`, {
      tenantId,
      method: 'POST',
      body: await request.json(),
    }),
);
```

5.2. Create `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/route.ts`:

```typescript
export const GET = withRouteHandler(
  { requireProject: true, permissions: 'external_agent:read' as any },
  async ({ request, tenantId, params }) =>
    proxyToRuntime(request, `/api/projects/${params.id}/external-agents/${params.agentId}`, {
      tenantId,
    }),
);
export const PATCH = withRouteHandler(
  { requireProject: true, permissions: 'external_agent:update' as any },
  async ({ request, tenantId, params }) =>
    proxyToRuntime(request, `/api/projects/${params.id}/external-agents/${params.agentId}`, {
      tenantId,
      method: 'PATCH',
      body: await request.json(),
    }),
);
export const DELETE = withRouteHandler(
  { requireProject: true, permissions: 'external_agent:delete' as any },
  async ({ request, tenantId, params }) =>
    proxyToRuntime(request, `/api/projects/${params.id}/external-agents/${params.agentId}`, {
      tenantId,
      method: 'DELETE',
    }),
);
```

5.3. Create `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/test-connection/route.ts`:

```typescript
export const POST = withRouteHandler(
  { requireProject: true, permissions: 'external_agent:update' as any },
  async ({ request, tenantId, params }) =>
    proxyToRuntime(
      request,
      `/api/projects/${params.id}/external-agents/${params.agentId}/test-connection`,
      {
        tenantId,
        method: 'POST',
      },
    ),
);
```

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/external-agents/route.ts` — NEW
- `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/route.ts` — NEW
- `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/test-connection/route.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 TypeScript errors
- [ ] `GET /api/projects/[id]/external-agents` proxies correctly (returns same response as runtime)
- [ ] Studio proxy preserves Authorization header and forwards to runtime

**Test Strategy**:

- Manual verification in running Studio: create an external agent via the Studio API, verify it proxies to runtime and returns 201
- Studio unit test: `apps/studio/src/__tests__/external-agents-api.test.ts` — mock `proxyToRuntime` and verify path construction for each method

**Rollback**: Delete the 3 new route files.

---

### Phase 6: Studio UI Components

**Goal**: List page, registration modal, and edit panel with skills display.

**i18n requirement**: All user-visible strings must use translation keys from the `externalAgents` namespace in `packages/i18n/locales/en/studio.json`. Each component uses `useTranslations('externalAgents')`. This includes column headers, button labels, form field labels, status badge labels (`Connected`, `Failed`, `Not tested`), advisory warning messages, toast messages, and completion detail labels. Never use hardcoded English strings in JSX. Create an `apps/studio/src/api/external-agents.ts` client module (following `apps/studio/src/api/tools.ts` pattern with `apiFetch`) for all API calls; all three components import from it. Include loading/disabled states: all async buttons (Register, Save, Test Connection, Delete) must be disabled during in-flight requests; use `mutate()` from SWR to invalidate caches after mutations.

**Tasks**:

6.1. Create `apps/studio/src/components/external-agents/ExternalAgentsPage.tsx`:

- Fetch `GET /api/projects/${projectId}/external-agents` on mount
- Table columns: Name, Protocol badge, Connection Status badge (connected=success token, failed=error token, null=neutral), Latency (ms), Last Verified, Actions
- Status badge: use semantic design tokens (no hardcoded Tailwind palette colors per CLAUDE.md)
- "Register Agent" button opens `RegisterExternalAgentModal`
- "Test Connection" per-row action: POST to `/api/projects/${projectId}/external-agents/${id}/test-connection`, refresh row
- Row click opens `ExternalAgentEditPanel` in a side panel

  6.2. Create `apps/studio/src/components/external-agents/RegisterExternalAgentModal.tsx`:

- Form fields: Name (text), Display Name (optional text), Endpoint URL (text), Protocol (select: A2A/REST), Auth Type (select: None/Bearer Token/API Key)
- Conditional auth fields: Bearer → token textarea; API Key → key textarea + optional header name
- Submit: POST `/api/projects/${projectId}/external-agents`; on success show toast + append to list; on error show field-level or banner error
- Close on success or Cancel button

  6.3. Create `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx`:

- Pre-fills all editable fields (name shown but read-only — `name` is immutable)
- Auth credential field: shows `authConfigured: true/false` badge; new value input clears and replaces
- Skills section (read-only): rendered from `lastDiscoveredCard?.skills[]` if present — shows skill id, name, description
- Connection status section: `lastConnectionStatus`, `lastConnectionAt`, `lastConnectionLatencyMs`, `lastConnectionError`
- Save: PATCH `/api/projects/${projectId}/external-agents/${id}`
- "Test Connection" button: POST test-connection, refresh panel content
- Delete: DELETE with confirmation dialog

  6.4. Wire `ExternalAgentsPage` into Studio project navigation:

- Add route in Studio project pages: e.g., `apps/studio/src/app/projects/[projectId]/external-agents/page.tsx`
- Add navigation link in project sidebar (wherever MCP Servers or Integrations section is)

**Files Touched**:

- `apps/studio/src/components/external-agents/ExternalAgentsPage.tsx` — NEW
- `apps/studio/src/components/external-agents/RegisterExternalAgentModal.tsx` — NEW
- `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx` — NEW
- `apps/studio/src/app/projects/[projectId]/external-agents/page.tsx` — NEW (page wrapper)
- Studio navigation/sidebar file (exact path TBD — check existing nav structure)

**Exit Criteria**:

- [ ] Before creating page files: run `ls apps/studio/src/app/` to confirm the correct route group (`(projects)`, `(dashboard)`, or other); update page path accordingly
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 TypeScript errors
- [ ] No hardcoded Tailwind palette colors (`bg-blue-500`, etc.) — only semantic tokens
- [ ] "Register Agent" form submits and new agent appears in list
- [ ] Status badge renders correctly for `connected`, `failed`, and `null` states

**Test Strategy**:

- Manual browser testing: create an agent, verify it appears in list with correct status badge
- E2E-1 from test spec covers end-to-end CRUD lifecycle

**Rollback**: Delete new component files and page file, revert sidebar/nav change.

---

### Phase 7: Agent Editor Autocomplete + Advisory Warning

**Goal**: Surface registered external agents as HANDOFF TO: completion targets; show advisory warning for unregistered remote targets.

**Tasks**:

7.1. Extend `loadAgentsForContext()` in `apps/studio/src/components/abl/ABLEditor.tsx`:

- Add a separate `loadExternalAgentsForContext()` function following the same caching pattern (`externalAgentCacheRef`, `CACHE_TTL_MS`)
- Fetch from `GET /api/projects/${projectId}/external-agents`
- Map result to `Array<{ name: string; type?: 'external' }>` — add optional `type` field for display distinction
- In `handleEditorMount` completion provider, call both `loadAgentsForContext()` and `loadExternalAgentsForContext()`, merge into `context.availableAgents`
- External agent names appear in completions alongside local agents; `detail` field shows `(external A2A)` or `(external REST)` to distinguish

  7.2. Add advisory warning in the ABL editor:

- After the completion provider registration, add a marker/diagnostic: for each `HANDOFF TO:` line with `LOCATION: remote`, check if the target name is in the external agents list
- If not found: show an advisory (`Warning` severity, not `Error`) with message: `"Agent '{name}' is registered as LOCATION: remote but has no entry in the External Agent Registry. Register it in Project Settings > External Agents."`
- This is non-blocking — the file saves and compiles regardless

**Files Touched**:

- `apps/studio/src/components/abl/ABLEditor.tsx` — extend `loadAgentsForContext`, add advisory diagnostic

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 TypeScript errors
- [ ] Typing `HANDOFF TO:` in an agent editor triggers completions that include external agent names
- [ ] An external agent name shows `(external A2A)` in the completion detail
- [ ] A `HANDOFF TO: unregistered_remote_agent` line with `LOCATION: remote` shows an advisory warning marker

**Test Strategy**:

- Manual: create an external agent, open agent editor, verify autocomplete
- E2E-6: advisory warning scenario (see test spec)

**Rollback**: Revert `ABLEditor.tsx` changes (additive only, safe to revert).

---

## 4. Wiring Checklist

**Phase 1 (Data Layer)**:

- [ ] `ExternalAgentConfig` model exported from `packages/database/src/models/index.ts`
- [ ] `findExternalAgentConfigByName` + other repo functions exported from `packages/shared/src/repos/index.ts`
- [ ] `testExternalAgentConnection` exported from `packages/shared/src/repos/index.ts`
- [ ] `external_agent:*` permissions in `PERMISSION_REGISTRY` (VALID_CUSTOM_ROLE_PERMISSIONS derives from this)
- [ ] `external_agent:*` in `PROJECT_ROLE_PERMISSIONS.developer`, `external_agent:read` in `viewer` + `tester`
- [ ] `ExternalAgentConfig` in `deleteProject()` dynamic import AND `deleteMany` call
- [ ] `MCPServerConfig` in `deleteProject()` dynamic import AND `deleteMany` call (gap fix)

**Phase 2 (Runtime Routes)**:

- [ ] `externalAgentRouter` imported in `apps/runtime/src/server.ts`
- [ ] `externalAgentRouter` mounted at `app.use('/api/projects/:projectId/external-agents', ...)`
- [ ] Route is mounted BEFORE any catch-all or parameterized wildcard routes

**Phase 3 (Auth Injection)**:

- [ ] `LookupExternalAgent` injectable parameter added to `RoutingExecutor` constructor
- [ ] `findExternalAgentConfigByName` wired to `RoutingExecutor` at `runtime-executor.ts:912`
- [ ] `enrichWithRegistryAuth` called in `handleHandoff` after `lookupAgentForSession`
- [ ] `TraceEvent` emitted with `registryHit` boolean and NO `auth.value`

**Phase 4 (Test Infrastructure)**:

- [ ] `allowPrivateEndpoints?: boolean` added to `RuntimeHarnessOptions`
- [ ] SSRF allow-private env var threaded through harness env injection
- [ ] `mock-a2a-remote-agent.ts` records auth headers
- [ ] `mock-a2a-remote-agent.ts` supports configurable failure response

**Phase 5 (Studio Proxy)**:

- [ ] 3 Studio route files created for all 6 operations
- [ ] All proxy routes forward Authorization header to runtime

**Phase 6 (Studio UI)**:

- [ ] `ExternalAgentsPage` reachable from project navigation
- [ ] Studio page route (`/[id]/external-agents/page.tsx`) created
- [ ] Navigation link added in project sidebar

**Phase 7 (Autocomplete)**:

- [ ] External agent names included in `availableAgents` passed to `getCompletions()`
- [ ] Advisory warning fires for unregistered remote HANDOFF targets

---

## 5. Cross-Phase Concerns

### Database Migrations

No migration scripts required. The `external_agent_configs` collection is created on first write (MongoDB creates collections lazily). The unique index `{tenantId, projectId, name}` is created by Mongoose `autoIndex` (enabled in production and test harness).

### Feature Flags

No feature flag needed. The registry lookup in `handleHandoff` (Phase 3) no-ops when `this.lookupExternalAgent` is not wired (returns `undefined`), and when the collection is empty (returns `null`), leaving existing behavior unchanged.

### Configuration Changes

No new environment variables in production. `ENCRYPTION_MASTER_KEY` is already required at startup. `ALLOW_SSRF_PRIVATE_RANGES` is read by `getDevSSRFOptions()` from `@agent-platform/shared-kernel/security` (already exists); it enables private endpoint access in dev/test environments.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 7 implementation phases complete with exit criteria met
- [ ] E2E tests E2E-1 through E2E-8 passing (`apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`)
- [ ] Integration tests INT-1–INT-5, INT-7 passing (`apps/runtime/src/__tests__/external-agents-integration.test.ts`)
- [ ] INT-6, INT-8, UT-3 passing (`apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts`)
- [ ] UT-1 (model tests) passing (`packages/database/src/models/__tests__/external-agent-config.test.ts`)
- [ ] Studio proxy tests passing (`apps/studio/src/__tests__/external-agents-api.test.ts`)
- [ ] `pnpm build` passes with 0 TypeScript errors
- [ ] `pnpm test` (full suite) passes with no regressions in existing A2A tests (`routing-executor.test.ts`, `agent-lookup.test.ts`)
- [ ] No `encryptedAuthConfig` field ever appears in any API response (verified by E2E-1 masking assertion)
- [ ] SSRF rejection for private IPs tested by INT-4
- [ ] Cross-tenant access returns 404 (INT-7)
- [ ] Cascade delete removes external agent configs on project delete (INT-8 implied; covered in unit)
- [ ] Studio External Agents page renders without console errors
- [ ] `HANDOFF TO:` autocomplete includes registered external agent names
- [x] Feature spec updated (post-impl-sync) with `ENCRYPTION_MASTER_KEY` correction and `headerName` → `header` fix

---

## 7. Open Questions

1. ~~**RoutingExecutor construction site**~~ **RESOLVED**: Production construction site is `apps/runtime/src/services/runtime-executor.ts:912`. `lookupExternalAgent` is an optional 3rd constructor parameter (default `undefined`). Only this one production site needs updating.

2. ~~**Studio navigation wiring**~~ **RESOLVED**: Page path is `apps/studio/src/app/projects/[projectId]/external-agents/page.tsx` (verified: Studio uses `projects/[projectId]` route structure). The sidebar/nav component file must be identified at implementation time by reading `apps/studio/src/app/projects/[projectId]/` directory structure before Phase 6.

3. ~~**SSRF allow-private mechanism**~~ **RESOLVED**: The route imports `getDevSSRFOptions` from `@agent-platform/shared-kernel/security` (exported from `packages/shared-kernel/src/security/index.ts`). `getDevSSRFOptions()` reads `ALLOW_SSRF_PRIVATE_RANGES` env var. The test harness `allowPrivateEndpoints` option injects `ALLOW_SSRF_PRIVATE_RANGES=true` into `MANAGED_ENV_KEYS`. `shouldAllowPrivateRemoteEndpoints()` at `routing-executor.ts:650` is module-private and must NOT be imported — use `getDevSSRFOptions()` directly in the route. Pattern verified against `tenant-models.ts:23` and `proxy-config.ts:24`.
