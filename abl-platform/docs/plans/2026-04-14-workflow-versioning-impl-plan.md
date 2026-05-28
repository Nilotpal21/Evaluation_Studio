# LLD: Workflow Versioning & Version-Aware Triggers

**Feature Spec**: `docs/features/sub-features/workflow-versioning.md`
**HLD**: `docs/specs/workflow-versioning.hld.md`
**Test Spec**: `docs/testing/sub-features/workflow-versioning.md`
**Status**: DONE
**Date**: 2026-04-14

---

## 1. Design Decisions

### Decision Log

| #     | Decision                                                           | Rationale                                                                                                                                                            | Alternatives Rejected                                                                  |
| ----- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| LD-1  | Phase 2 cleanup deferred to separate future LLD                    | HLD mandates 2+ week stability; CLAUDE.md commit discipline limits scope; Phase 1 is backward-compat                                                                 | Implement both phases in one LLD (too large, no stability gate)                        |
| LD-2  | No conditional `if (phase === 1)` code paths                       | Avoids branch complexity; env var exists for documentation and future Phase 2 gating                                                                                 | Sprinkle phase checks (testing burden, branch complexity)                              |
| LD-3  | Remove `promoteVersion()` entirely                                 | FR-6 mandates removal of 5-status lifecycle; no consumers in Studio                                                                                                  | Keep as deprecated redirect (dead code, confusing)                                     |
| LD-4  | Studio UI in same LLD as Phase 4                                   | API contract coupling prevents drift; feature spec groups together                                                                                                   | Separate LLD (API contract could drift)                                                |
| LD-5  | Always source `createVersion()` from draft WorkflowVersion         | `getOrCreateDraft()` is the migration safety net; no `source` parameter needed                                                                                       | Add `source` param (unnecessary indirection)                                           |
| LD-6  | Keep fire-time deployment resolution as Phase 1 fallback           | HLD concern #10 explicitly requires it; pre-migration triggers lack `workflowVersionId`                                                                              | Remove immediately (breaks pre-migration triggers)                                     |
| LD-7  | GAP-008 in scope; GAP-001, GAP-005 deferred                        | GAP-008 breaks if not fixed (status removal); GAP-001/005 are separate packages with open design questions                                                           | Include all gaps (scope explosion)                                                     |
| LD-8  | Test rewrites alongside code changes (separate commits)            | Broken tests block CI; stale mock warning; `test()` commit type                                                                                                      | Defer to testing phase at end (CI blocked)                                             |
| LD-9  | Standalone CLI migration script                                    | Matches existing `migrate-env-to-instances.ts` pattern; supports `--dry-run` and idempotent re-runs                                                                  | Mongoose migration framework (none exists in repo)                                     |
| LD-10 | Post-save sync hook as explicit code in PATCH handler              | Mongoose middleware is implicit and harder to test; explicit code is visible and follows CLAUDE.md principles                                                        | Mongoose post-save middleware (implicit, harder to test)                               |
| LD-11 | Migration always ensures draft exists (even for existing versions) | `getOrCreateDraft()` is the single source of truth; existing published versions are unaffected                                                                       | Skip workflows with existing versions (leaves gap in draft coverage)                   |
| LD-12 | Structured error responses with error codes                        | HLD mandates `{ success, error: { code, message } }`; 7 error codes defined                                                                                          | Keep bare string errors (inconsistent with platform contract)                          |
| LD-13 | createVersion() sets initial state `"inactive"` (HLD divergence)   | Centralizes trigger registration in activate() — one place for TriggerRegistration creation. Deployment auto-mode calls createVersion() then activate() as two-step. | Set state: "active" on create per HLD (splits trigger registration across two methods) |
| LD-14 | Generic JSON diff for version comparison (Phase 1)                 | Unblocks implementation without overdesigning; structural workflow-specific diff deferred to future enhancement                                                      | Build custom structural diff (over-scoped for Phase 1)                                 |

### Key Interfaces & Types

```typescript
// Modified: packages/database/src/models/workflow-version.model.ts
export type WorkflowVersionState = 'active' | 'inactive';
// Replaces: WorkflowVersionStatus = 'draft' | 'testing' | 'staged' | 'active' | 'deprecated'

export interface IWorkflowVersionDefinition {
  nodes: unknown[];
  edges: unknown[];
  envVars: Record<string, string>;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
}

export interface IWorkflowVersionTrigger {
  id: string;
  type: string; // 'cron' | 'webhook' | 'event'
  config: Record<string, unknown>;
}

export interface IWorkflowVersion {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string; // "draft" | "v0.1.0" | ...
  state: WorkflowVersionState; // replaces `status`
  environment: string | null; // null for draft
  deploymentId: string | null;
  definition: IWorkflowVersionDefinition;
  triggers: IWorkflowVersionTrigger[]; // NEW: version owns trigger definitions
  sourceHash: string;
  changelog: string | null;
  deleted: boolean;
  publishedAt: Date | null;
  publishedBy: string | null;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// Modified: packages/database/src/models/trigger-registration.model.ts
export interface ITriggerRegistration {
  // ... existing fields ...
  workflowVersionId: string; // NEW
  workflowVersion: string; // NEW: "draft" | "v1.0"
  status: 'active' | 'paused' | 'error' | 'deleted' | 'inactive'; // EXTENDED with 'inactive'
}

// New: apps/runtime/src/services/workflow-version-service.ts
export interface ActivateVersionParams {
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string;
  activatedBy: string;
}

export interface DeactivateVersionParams {
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string;
}

export interface ResolveDefaultVersionResult {
  version: IWorkflowVersion;
  resolution: 'published' | 'draft-fallback';
}
```

### Module Boundaries

| Module                       | Responsibility                                                          | Depends On                                    |
| ---------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| `workflow-version.model`     | Schema, indexes, `WorkflowVersionState` type                            | mongoose, `tenantIsolationPlugin`             |
| `workflow.model`             | Thin container schema (Phase 1: retains denormalized fields)            | mongoose, `tenantIsolationPlugin`             |
| `trigger-registration.model` | Schema with `workflowVersionId`, extended status enum                   | mongoose                                      |
| `WorkflowVersionService`     | Version lifecycle (CRUD, activate, deactivate, resolve, cascade)        | All 3 models, `TriggerEngine`, BullMQ         |
| `workflow-versions` routes   | REST endpoints for version operations                                   | `WorkflowVersionService`, auth middleware     |
| `workflows` routes           | Thin container CRUD, atomic draft creation                              | `WorkflowVersionService`, workflow model      |
| `deployments` routes         | Auto-mode version snapshot from draft                                   | `WorkflowVersionService`                      |
| `process-api` routes         | Default version resolution for execution                                | `WorkflowVersionService`                      |
| `TriggerScheduler`           | Cron fire via `workflowVersionId` (with fallback)                       | `workflow-version.model`, `trigger-reg.model` |
| `TriggerEngine`              | Webhook fire via `workflowVersionId` (with fallback)                    | `workflow-version.model`, `trigger-reg.model` |
| `validate-workflow-binding`  | Tool binding — dual check (version state OR legacy status)              | `workflow-version.model`, `workflow.model`    |
| Studio proxy routes          | Next.js API proxies for version endpoints                               | Runtime API                                   |
| `WorkflowVersionsTab`        | UI: list, activate/deactivate, detail, diff                             | Studio API client                             |
| Migration script             | CLI: backfill draft versions + trigger registration `workflowVersionId` | All 3 models                                  |

---

## 2. File-Level Change Map

### New Files

| File                                                                                                           | Purpose                                         | LOC Est |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------- |
| `apps/runtime/src/scripts/migrate-workflow-versions.ts`                                                        | CLI migration: create drafts, backfill triggers | 200     |
| `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/route.ts`                               | Studio proxy: GET list versions                 | 30      |
| `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/activate/route.ts`            | Studio proxy: POST activate                     | 25      |
| `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/route.ts`                     | Studio proxy: GET single + PATCH draft          | 35      |
| `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/deactivate/route.ts`          | Studio proxy: POST deactivate                   | 25      |
| `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/diff/[otherVersion]/route.ts` | Studio proxy: GET diff                          | 25      |
| `apps/studio/src/components/workflows/tabs/WorkflowVersionsTab.tsx`                                            | Versions tab: list, toggle, detail, diff        | 350     |
| `apps/runtime/src/__tests__/workflow-version-lifecycle.test.ts`                                                | Integration tests for new lifecycle methods     | 300     |
| `apps/runtime/src/__tests__/workflow-version-resolution.test.ts`                                               | Integration tests for resolveDefaultVersion     | 150     |
| `apps/workflow-engine/src/__tests__/trigger-version-binding.test.ts`                                           | Integration tests for version-aware fire paths  | 200     |

### Modified Files

| File                                                                 | Change Description                                                           | Risk   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/workflow-version.model.ts`             | Replace 5-status with state; add triggers, environment, deleted, publishedAt | High   |
| `packages/database/src/models/workflow.model.ts`                     | Add deleted/deletedAt/tags; Phase 1 retains denormalized fields              | Medium |
| `packages/database/src/models/trigger-registration.model.ts`         | Add workflowVersionId, workflowVersion; extend status enum                   | Medium |
| `apps/runtime/src/services/workflow-version-service.ts`              | Major refactor: remove promote, add activate/deactivate/resolve/cascade      | High   |
| `apps/runtime/src/services/audit-helpers.ts`                         | Add version audit helper functions                                           | Low    |
| `packages/compiler/src/platform/core/types.ts`                       | Extend `AuditEventType` with version event types                             | Low    |
| `packages/compiler/src/platform/stores/audit-store.ts`               | Extend `resourceType` union with `workflow_version`                          | Low    |
| `apps/runtime/src/routes/workflow-versions.ts`                       | Replace promote with activate/deactivate; add PATCH mutability; Zod schemas  | High   |
| `apps/runtime/src/routes/workflows.ts`                               | Atomic draft creation; remove status; soft delete cascade                    | Medium |
| `apps/runtime/src/routes/deployments.ts`                             | Auto-mode sources from draft WorkflowVersion instead of Workflow             | Medium |
| `apps/runtime/src/routes/process-api.ts`                             | Add resolveDefaultVersion(); support ?version= param                         | Medium |
| `apps/workflow-engine/src/services/trigger-scheduler.ts`             | Load version by workflowVersionId; fallback to working copy                  | High   |
| `apps/workflow-engine/src/services/trigger-engine.ts`                | Version-first binding; keep deployment resolution as fallback                | High   |
| `apps/workflow-engine/src/routes/workflow-executions.ts`             | Version-aware execution creation; pass workflowVersion metadata              | Medium |
| `packages/shared/src/tools/validate-workflow-tool-binding.ts`        | Dual check: active version OR legacy status                                  | Medium |
| `apps/studio/src/components/workflows/WorkflowDetailPage.tsx`        | Add Versions tab; remove status buttons/display                              | Medium |
| `apps/studio/src/components/workflows/WorkflowsListPage.tsx`         | Remove status filter/badge from list                                         | Low    |
| `apps/studio/src/components/workflows/WorkflowCard.tsx`              | Remove status badge; show version count                                      | Low    |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`  | Version-aware trigger list; per-trigger toggle                               | Medium |
| `apps/studio/src/api/workflows.ts`                                   | Add version API methods; remove status types                                 | Low    |
| `apps/studio/src/components/workflows/canvas/useWorkflowSave.ts`     | Change save target to draft version endpoint                                 | Medium |
| `packages/i18n/locales/en/studio.json`                               | Add `workflows.versions.*` translation keys                                  | Low    |
| `apps/runtime/src/__tests__/workflow-version-service.test.ts`        | REWRITE: 5-status tests → active/inactive lifecycle                          | Medium |
| `apps/runtime/src/__tests__/workflow-version-routes.test.ts`         | REWRITE: promote → activate/deactivate; remove vi.mocks                      | Medium |
| `apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts` | REWRITE: deployment resolution → version binding                             | Medium |
| `packages/database/src/__tests__/model-workflow-version.test.ts`     | PARTIAL REWRITE: schema validation for new fields/state enum                 | Low    |

---

## 3. Implementation Phases

### Phase 1: Data Model & Indexes

**Goal**: Update all three MongoDB models with new fields, indexes, and types. No behavior changes yet.

**Tasks**:

1.1. Update `workflow-version.model.ts`: Replace `WorkflowVersionStatus` with `WorkflowVersionState` (`'active' | 'inactive'`). Add `state`, `environment`, `deploymentId`, `triggers` (array), `deleted`, `publishedAt`, `publishedBy` fields to schema. Remove `status` (old 5-enum), `promotedAt`, `promotedBy`. Add indexes: `{ tenantId, projectId, workflowId, state, deleted, publishedAt: -1 }` and `{ tenantId, workflowId, sourceHash }`.

1.2. Update `workflow.model.ts`: Add `deleted: boolean` (default false), `deletedAt: Date`, `tags: string[]` fields. Add index `{ tenantId, projectId, deleted }`. Retain all existing fields for Phase 1 backward compat.

1.3. Update `trigger-registration.model.ts`: Add `workflowVersionId: string` and `workflowVersion: string` fields. Extend status enum to include `'inactive'`. Add index `{ tenantId, workflowVersionId, status }`.

1.4. Update `model-workflow-version.test.ts` (partial rewrite): Test new schema validation — `state` enum accepts `active`/`inactive`, rejects old statuses; `triggers` array stores `{ id, type, config }`; `deleted` defaults to false; `publishedAt` nullable.

1.5. Update barrel exports: Replace `WorkflowVersionStatus` with `WorkflowVersionState` in the database package barrel (`packages/database/src/models/index.ts` or equivalent). Add `IWorkflowVersionTrigger` and `IWorkflowVersionDefinition` alongside existing `WorkflowVersion` model export. Grep for downstream consumers of `WorkflowVersionStatus` and update them to `WorkflowVersionState` (expected consumers: `workflow-version-service.ts`, `workflow-versions.ts` routes).

1.6. Run `pnpm build --filter=@abl/database` and `pnpm build --filter=@abl/compiler` to verify no downstream type errors.

**Files Touched**:

- `packages/database/src/models/workflow-version.model.ts` — schema + interface + type
- `packages/database/src/models/workflow.model.ts` — schema + interface
- `packages/database/src/models/trigger-registration.model.ts` — schema + interface + enum
- `packages/database/src/__tests__/model-workflow-version.test.ts` — partial rewrite

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/database` succeeds with 0 errors
- [ ] `pnpm build --filter=@abl/compiler` succeeds with 0 errors (downstream consumer)
- [ ] `WorkflowVersionState` type exported and available
- [ ] New indexes are defined in schema (verified by schema inspection in test)
- [ ] `IWorkflowVersion` interface includes `state`, `triggers`, `deleted`, `publishedAt`, `publishedBy`, `environment`, `deploymentId`
- [ ] `ITriggerRegistration` interface includes `workflowVersionId`, `workflowVersion`
- [ ] `IWorkflow` interface includes `deleted`, `deletedAt`, `tags`
- [ ] Model tests pass: `pnpm test --filter=@abl/database`

**Test Strategy**:

- Unit: Schema validation tests for new fields (task 1.4)
- No integration tests in this phase (pure data model)

**Rollback**: Revert the model changes. Additive fields are ignored by existing code. Index additions don't break reads.

---

### Phase 2: Service Layer Refactor

**Goal**: Refactor `WorkflowVersionService` to implement the version-first lifecycle: activate, deactivate, getOrCreateDraft, resolveDefaultVersion, softDeleteCascade. Remove 5-status promote.

**Tasks**:

2.1. Add `getOrCreateDraft(workflowId, tenantId, projectId, createdBy)` method: Find `{ workflowId, version: "draft" }`; if not found, create from Workflow document fields (migration safety net). Return the draft version document.

2.2. Refactor `createVersion()`: Change snapshot source from `Workflow` document to `getOrCreateDraft()` result. Copy `definition` + `triggers` from draft. Update `nextVersion()` to prepend `v` prefix (D-2) — strip leading `v` before parsing semver parts, prepend `v` before returning; handle mixed legacy `0.x.x` and new `v0.x.x` formats in version sort. Set initial `state: "inactive"`, `publishedAt`, `publishedBy`, `environment`, `deploymentId` on the new version. NOTE: Version is created as `"inactive"` — callers must explicitly call `activate()` to register triggers. This keeps trigger registration in one place (`activate()`). Fix existing `catch (err: any)` in the retry loop to use proper type narrowing: `err instanceof Error` + `(err as { code?: number }).code === 11000` per CLAUDE.md error handling rules.

2.3. Add `activate(params: ActivateVersionParams)`: Guard: reject draft (DRAFT_ALWAYS_ACTIVE). Optimistic lock on `_v`. Set `state: "active"`. Create `TriggerRegistration` documents by iterating `version.triggers[]` and mapping: `triggerName` from `trigger.config.name || trigger.id`, `triggerType` from `trigger.type`, `cronExpression` from `trigger.config.cronExpression` (cron triggers), `webhookSecret` generated via `@agent-platform/shared-encryption` (webhook triggers), plus `workflowVersionId`, `workflowVersion`, `tenantId`, `projectId`, `workflowId`. Schedule cron via BullMQ, subscribe app-events via EventBus, generate webhook URLs. Idempotent: if already active, return 200 with no change.

2.4. Add `deactivate(params: DeactivateVersionParams)`: Guard: reject draft (DRAFT_ALWAYS_ACTIVE). Optimistic lock on `_v`. Set `state: "inactive"`. Update `TriggerRegistration` status to `"inactive"`. Unschedule cron from BullMQ, unsubscribe app-events. Idempotent: if already inactive, return 200.

2.5. Add `resolveDefaultVersion(tenantId, projectId, workflowId)`: Query `{ workflowId, state: "active", deleted: false, version: { $ne: "draft" } }` sorted by `{ publishedAt: -1 }`, limit 1. Fallback to draft. Return version doc + resolution type.

2.6. Add `softDeleteCascade(tenantId, projectId, workflowId)`: Use `withTransaction()` from `@agent-platform/shared/repos` (matches existing pattern in `platform-admin-tenants.ts`). Inside transaction: mark Workflow `deleted: true`, `deletedAt: now`; mark all WorkflowVersions `deleted: true`; mark all TriggerRegistrations `status: "deleted"`. Best-effort BullMQ unschedule outside transaction. Idempotent.

2.7. Remove `promoteVersion()` method, `VALID_STATUS_TRANSITIONS` map, `VALID_STATUSES` constant, `PromoteWorkflowVersionParams` interface.

2.8. Tighten isolation: Make `projectId` required (not optional) on `getVersion()`, `diffVersions()`. Add `deleted: false` filter to `listVersions()`, `getVersion()`, and `diffVersions()` queries to exclude soft-deleted versions.

2.9. Add audit helper functions and type extensions: (a) Extend `AuditEventType` in `packages/compiler/src/platform/core/types.ts` with `'workflow.version_activated' | 'workflow.version_deactivated' | 'workflow.deleted'`. Add `'workflow_version'` to BOTH the `LogAuditParams.resourceType` union (`packages/compiler/src/platform/stores/audit-store.ts`) AND the `AuditLog.resourceType` union (`packages/compiler/src/platform/core/types.ts:415-422`) — both must be updated or the type system rejects `'workflow_version'` in some contexts. (b) Add `auditWorkflowVersionActivated()`, `auditWorkflowVersionDeactivated()`, and `auditWorkflowDeleted()` helpers to `apps/runtime/src/services/audit-helpers.ts` following the existing pattern (see `auditWorkflowCreated`, `auditWorkflowUpdated` in that file). Each helper accepts `{ tenantId, projectId, workflowId, workflowVersion, userId }` and calls the audit store. NOTE: These helpers are called from route handlers (Phase 3 task 3.1), NOT from service methods — audit emission is a route-layer concern following existing codebase patterns.

2.10. Add mutability validation: `validateMutableFields(version, updatePayload)` — returns `{ allowed: boolean, frozenFields?: string[] }`. Draft allows all. Published active: blocks `definition.nodes`, `definition.edges`, `definition.envVars`, `definition.inputSchema`, `definition.outputSchema`, webhook trigger changes. Published inactive: same frozen fields as active — blocks `definition.nodes`, `definition.edges`, `definition.envVars`, `definition.inputSchema`, `definition.outputSchema`, webhook triggers. Allows cron schedule, app-event config, changelog, and details (name, description, tags) per FR-7 mutability matrix regardless of state.

2.11. Rewrite `workflow-version-service.test.ts`: Replace 5-status lifecycle tests with: activate/deactivate happy path, draft rejection, idempotency, optimistic lock conflict, resolveDefaultVersion chain, softDeleteCascade transaction, createVersion from draft, sourceHash dedup, mutability validation, deleted filter on list/get, audit event emission.

2.12. Write `workflow-version-lifecycle.test.ts` (integration): Real Express + MongoMemoryServer. Test activate creates TriggerRegistrations, deactivate updates to inactive, cascade delete marks all deleted, BullMQ DI test double captures schedule/unschedule calls. Include INT-12 (in-flight execution survives deactivation): start execution via service, deactivate version mid-flight, verify execution completes and version state is inactive but execution is not aborted.

**Files Touched**:

- `apps/runtime/src/services/workflow-version-service.ts` — major refactor
- `apps/runtime/src/services/audit-helpers.ts` — add version audit helpers
- `packages/compiler/src/platform/core/types.ts` — extend `AuditEventType`
- `packages/compiler/src/platform/stores/audit-store.ts` — extend `resourceType` union
- `apps/runtime/src/__tests__/workflow-version-service.test.ts` — rewrite
- `apps/runtime/src/__tests__/workflow-version-lifecycle.test.ts` — new

**Exit Criteria**:

- [ ] `promoteVersion()` removed; `activate()` and `deactivate()` work
- [ ] `getOrCreateDraft()` creates draft from Workflow if missing
- [ ] `resolveDefaultVersion()` returns latest active published, fallback to draft
- [ ] `softDeleteCascade()` marks all 3 collections deleted in transaction
- [ ] `createVersion()` snapshots from draft, prepends `v` prefix
- [ ] `validateMutableFields()` enforces frozen/mutable matrix
- [ ] Audit helper functions added to `audit-helpers.ts` (wired in Phase 3)
- [ ] `AuditEventType` extended with workflow version event types
- [ ] `pnpm build --filter=apps/runtime --filter=@abl/compiler` succeeds
- [ ] All service tests pass (rewritten + new lifecycle tests)
- [ ] `pnpm test --filter=apps/runtime` passes

**Test Strategy**:

- Unit: Service method tests with MongoMemoryServer (task 2.11)
- Integration: Real Express + MongoMemoryServer + BullMQ DI double (task 2.12)

**Rollback**: Revert service changes. Phase 1 data model remains (additive, harmless).

---

### Phase 3: Routes, Trigger Engine & Process API

**Goal**: Wire the service layer into route handlers, update trigger fire paths, add version resolution to Process API. Keep deployment-resolution fallback.

**Tasks**:

3.1. Update `workflow-versions.ts` routes: Replace `POST /:version/promote` with `POST /:version/activate` and `POST /:version/deactivate`. Add `PATCH /:version` with mutability validation (calls `validateMutableFields()`), and include post-save sync hook as explicit code in the PATCH handler per LD-10: when draft version is updated, sync `definition.nodes`, `definition.edges`, `definition.envVars` back to the Workflow document for Phase 1 backward compat. Update Zod schemas: remove `promoteVersionBody`/`promoteVersionResponse`; add `activateResponse`, `deactivateResponse`, `updateVersionBody`. Update `createVersion` handler to use refactored service (sources from draft). All error responses must use structured format `{ success: false, error: { code: "<ERROR_CODE>", message: "<details>" } }` per LD-12 — convert any bare `{ error: "string" }` patterns to the structured shape. Error codes: `DRAFT_ALWAYS_ACTIVE`, `VERSION_NOT_FOUND`, `VERSION_FROZEN`, `VERSION_INACTIVE`, `FIELD_FROZEN`, `DUPLICATE_SOURCE_HASH`, `WORKFLOW_DELETED`. Call audit helpers from route handlers (not service layer): `auditWorkflowVersionActivated()` after successful activate, `auditWorkflowVersionDeactivated()` after successful deactivate, using fire-and-forget `.catch(err => log.warn(...))` pattern matching existing `workflows.ts` audit calls. Also convert bare error strings in `workflow-executions.ts` (task 3.10) to structured format.

3.2. Update `workflows.ts` routes: `POST /` creates Workflow + draft WorkflowVersion atomically (call `getOrCreateDraft()` after Workflow creation). `DELETE /:id` calls `softDeleteCascade()` instead of archive, then calls `auditWorkflowDeleted()` with fire-and-forget `.catch(err => log.warn(...))`. `GET /:id` returns thin container + draft version data. Remove `status` from update Zod schema (Phase 1: silently ignore if sent).

3.3. Update `deployments.ts` route: Auto-mode (`"auto"` in `workflowVersionManifest`) calls `getOrCreateDraft()` then `createVersion()` sourcing from draft, then `activate()` on the new version to register triggers. The existing code at lines 497-508 loads from `Workflow.findOne()` — change to load from draft version. The `createVersion()` → `activate()` two-step keeps trigger registration in one place.

3.4. Update `process-api.ts`: Add `?version=` query param support. Access `resolveDefaultVersion()` via `getWorkflowVersionService()` dynamic import (matching the existing `await import('@agent-platform/database')` pattern at line 118 — do NOT extend `ProcessApiDeps` to keep backward compat with existing test setup). Add `deleted: { $ne: true }` to the initial `Workflow.findOne()` filter at line 119 — this replaces the status check as the primary guard against executing deleted workflows. If no version specified, call `resolveDefaultVersion()`. If version specified, load `WorkflowVersion.findOne({ workflowId, version, tenantId, projectId, state: "active", deleted: false })` — 404 if not found. Remove `workflow.status === 'active'` check. Pass version definition to execution engine.

3.5. Update `trigger-scheduler.ts` `processJob()`: Update `TriggerJobData` interface to include optional `workflowVersionId: string` field. Check `job.data.workflowVersionId` first. If present, load `WorkflowVersion.findOne({ _id: workflowVersionId })`. If absent (pre-migration job), fallback: load `TriggerRegistration` to get `workflowVersionId`; if still absent, fallback to Workflow working copy (existing behavior). Use version's `definition.nodes`/`definition.edges` for `convertCanvasToSteps()`.

3.6. Update `trigger-engine.ts` `fireWebhookTrigger()`: Load `TriggerRegistration`, read `workflowVersionId`. If present, load `WorkflowVersion` directly — skip deployment resolution. If absent, fall back to existing deployment resolution (lines 300-352). Fix bug at line 334: use `convertCanvasToSteps(def.nodes, def.edges)` instead of `def.steps`. Add `workflowVersionId` and `workflowVersion` to execution payload.

3.7. Add environment-scoped event routing (FR-17): Extract a pure `environmentsMatch(eventEnv: string | null, triggerEnv: string | null): boolean` function implementing strict equality: `eventEnv === triggerEnv` (including both-null equality). The 5-case matrix: (1) both equal non-null → true, (2) both non-null but different → false, (3) event null + trigger set → false, (4) event set + trigger null → false, (5) both null → true. Apply this predicate in `trigger-engine.ts` `fireWebhookTrigger()` before firing (skip with warning if mismatch) and in `trigger-scheduler.ts` `processJob()` before firing (skip with cron-skip warning if mismatch).

3.8. Update `trigger-engine.ts` `register()` method: When creating `TriggerRegistration`, include `workflowVersionId` and `workflowVersion` fields from the calling context. Fix the `strategy`/`triggerType` field name discrepancy: (a) Change `register()` line 112 from `strategy: registration.triggerType` to `triggerType: registration.triggerType` (matching the model schema field name). (b) Update `trigger-scheduler.ts` line 242 and `trigger-engine.ts` lines 242-243 to read `trigger.triggerType` instead of `trigger.strategy`. (c) Add a migration sub-step to Phase 5 task 5.2: rename existing `strategy` fields to `triggerType` in the `trigger_registrations` collection as part of the backfill script. This should be a preparatory `refactor()` commit before version-aware changes.

3.9. Update `trigger-engine.ts` `pause()` and `resume()` methods: Add `VERSION_INACTIVE` guard — load the owning version, reject if `state === "inactive"`.

3.10. Update `workflow-executions.ts` execute handler: Accept `workflowVersionId` and `workflowVersion` in the request payload. Tag `WorkflowExecution` document with version metadata. Convert bare error strings to structured format per LD-12.

3.11. Rewrite `workflow-version-routes.test.ts`: Replace promote-route tests with activate/deactivate/PATCH tests. Include INT-1 (atomic workflow + draft creation). Remove all `vi.mock` calls — use real Express + MongoMemoryServer per CLAUDE.md test architecture.

3.12. Rewrite `trigger-fire-resolution.test.ts`: Test version-first binding (workflowVersionId present), fallback to deployment resolution (workflowVersionId absent), bug fix (nodes/edges not steps), INT-5 (environment-scoped event routing — test `environmentsMatch()` predicate and full fire path with matching/mismatching environments), and INT-10 (deployment auto-mode snapshots draft — real Express + MongoMemoryServer integration test).

3.13. Write `workflow-version-resolution.test.ts` (integration): Test `resolveDefaultVersion` via Process API HTTP requests — latest active, fallback chain, explicit version, 404 cases.

**Files Touched**:

- `apps/runtime/src/routes/workflow-versions.ts`
- `apps/runtime/src/routes/workflows.ts`
- `apps/runtime/src/routes/deployments.ts`
- `apps/runtime/src/routes/process-api.ts`
- `apps/workflow-engine/src/services/trigger-scheduler.ts`
- `apps/workflow-engine/src/services/trigger-engine.ts`
- `apps/workflow-engine/src/routes/workflow-executions.ts`
- `apps/runtime/src/__tests__/workflow-version-routes.test.ts` — rewrite
- `apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts` — rewrite
- `apps/runtime/src/__tests__/workflow-version-resolution.test.ts` — new

**Exit Criteria**:

- [ ] `POST /versions/:v/activate` returns 200 and registers triggers
- [ ] `POST /versions/:v/deactivate` returns 200 and deregisters triggers
- [ ] `PATCH /versions/:v` enforces mutability matrix (frozen fields → 400)
- [ ] `POST /workflows` creates workflow + draft atomically
- [ ] `DELETE /workflows/:id` cascades via softDeleteCascade
- [ ] `POST /api/v1/process/:wfId` resolves default version (no `?version=`)
- [ ] `POST /api/v1/process/:wfId?version=v1.0` loads explicit version
- [ ] `processJob()` uses `workflowVersionId` when present, falls back to working copy
- [ ] `fireWebhookTrigger()` uses version binding first, deployment resolution as fallback
- [ ] `pause()`/`resume()` reject for inactive versions (VERSION_INACTIVE)
- [ ] `environmentsMatch()` predicate filters trigger fires by environment (FR-17)
- [ ] Audit helpers called from activate/deactivate/delete route handlers
- [ ] `pnpm build --filter=apps/runtime --filter=apps/workflow-engine` succeeds
- [ ] All route tests pass (rewritten without vi.mocks)
- [ ] `pnpm test --filter=apps/runtime --filter=apps/workflow-engine` passes

**Test Strategy**:

- Integration: Real Express + MongoMemoryServer for routes (tasks 3.10, 3.12)
- Integration: BullMQ/Restate DI doubles for trigger fire paths (task 3.11)

**Rollback**: Revert route/trigger changes. Service layer and models remain functional.

---

### Phase 4: Studio UI & Proxy Routes

**Goal**: Add Versions tab to Studio, create proxy routes, remove status from UI, update canvas auto-save to target draft version.

**Tasks**:

4.1. Create Studio proxy routes: `versions/route.ts` (GET list), `versions/[version]/route.ts` (GET single + PATCH update/draft), `versions/[version]/activate/route.ts` (POST), `versions/[version]/deactivate/route.ts` (POST), `versions/[version]/diff/[otherVersion]/route.ts` (GET diff). Follow existing proxy pattern (see `workflows/[workflowId]/route.ts`). The PATCH proxy is required for canvas auto-save (task 4.8).

4.2. Update `apps/studio/src/api/workflows.ts` API client: Add `listVersions()`, `activateVersion()`, `deactivateVersion()`, `getVersion()`, `diffVersions()` methods. Remove `WorkflowStatus` type and status-related API methods if any.

4.3. Create `WorkflowVersionsTab.tsx`: Version list table (name, state badge, environment, publishedAt, publishedBy). Activate/deactivate toggle per version with loading/disabled states (spinner during mutation, disable button for draft rows, disable all toggles when a mutation is in-flight). Click to expand detail view (read-only flow preview). Diff button to compare two versions. Filter by state (all/active/inactive). Use SWR for data fetching with `mutate()` cache invalidation after activate/deactivate operations (invalidate `versions-list` key on success). All user-facing strings must use the `workflows.versions` i18n namespace — keys include `tab.title`, `state.active`, `state.inactive`, `action.activate`, `action.deactivate`, `column.version`, `column.state`, `column.environment`, `column.publishedAt`, `column.publishedBy`, `empty.noVersions`, `diff.title`, `error.activateFailed`, `error.deactivateFailed`.

4.4. Update `WorkflowDetailPage.tsx`: Add Versions tab between Flow and Triggers tabs. Remove status badges/buttons from header. Conditionally show draft indicator.

4.5. Update `WorkflowsListPage.tsx`: Remove status filter dropdown. Remove status badge from cards.

4.6. Update `WorkflowCard.tsx`: Remove status badge. Add version count indicator (e.g., "3 versions").

4.7. Update `WorkflowTriggersTab.tsx`: Show triggers for the selected version context (draft by default). Disable per-trigger toggle when viewing inactive version.

4.8. Update canvas auto-save target: Update `apps/studio/src/components/workflows/canvas/useWorkflowSave.ts` to call a new `saveWorkflowVersionDraft()` API client method (added to `apps/studio/src/api/workflows.ts` in task 4.2) that targets `PATCH /versions/draft` instead of `PATCH /workflows/:id`. The `useAutoSave.ts` hook and `workflow-canvas-store.ts` remain unchanged — only the save target function changes. Phase 1: also sync to Workflow document via the post-save hook (handled server-side in the PATCH handler per LD-10).

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/route.ts` — new (GET list)
- `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/route.ts` — new (GET single + PATCH)
- `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/activate/route.ts` — new (POST)
- `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/deactivate/route.ts` — new (POST)
- `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/diff/[otherVersion]/route.ts` — new (GET)
- `apps/studio/src/api/workflows.ts`
- `apps/studio/src/components/workflows/tabs/WorkflowVersionsTab.tsx` — new
- `apps/studio/src/components/workflows/WorkflowDetailPage.tsx`
- `apps/studio/src/components/workflows/WorkflowsListPage.tsx`
- `apps/studio/src/components/workflows/WorkflowCard.tsx`
- `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`
- `apps/studio/src/components/workflows/canvas/useWorkflowSave.ts` — change save target
- `packages/i18n/locales/en/studio.json` — add `workflows.versions.*` translation keys

**Exit Criteria**:

- [ ] Studio proxy routes return correct data from runtime API
- [ ] Versions tab renders list of versions with state/environment/date
- [ ] Activate/deactivate buttons work and update state in UI
- [ ] Version detail view shows read-only flow preview
- [ ] Diff view shows side-by-side comparison
- [ ] Status badges/filters removed from WorkflowsListPage and WorkflowCard
- [ ] Canvas auto-save writes to draft version endpoint
- [ ] Per-trigger toggle disabled for inactive versions in TriggersTab
- [ ] SWR cache invalidated after activate/deactivate (UI updates without manual refresh)
- [ ] Loading/disabled states shown during activate/deactivate mutations
- [ ] All user-facing strings use `workflows.versions` i18n namespace (no hardcoded English)
- [ ] `pnpm build --filter=apps/studio` succeeds
- [ ] Manual verification: create workflow → edit → deploy → activate → deactivate → view versions tab

**Test Strategy**:

- Manual: Full workflow lifecycle through Studio UI
- E2E: Planned in test spec (E2E-1 through E2E-9) — implemented in Phase 5

**Rollback**: Revert Studio changes. Backend remains fully functional via API.

---

### Phase 5: Integration Fixes, Migration Script & E2E Tests

**Goal**: Fix GAP-008 (workflow-as-tool), write migration script, implement E2E tests, ensure full feature readiness.

**Tasks**:

5.1. Update `validate-workflow-tool-binding.ts`: Add dual check — if `WorkflowVersion` with `state: "active"` exists for the workflow, validation passes. If no active version but `workflow.status === 'active'` (legacy), validation passes. If neither, fail. Update `WorkflowDoc` interface to optionally include version info. Update `ValidateWorkflowBindingContext` to accept a `workflowVersionsRepo`.

5.2. Write migration script `migrate-workflow-versions.ts`: (a) For each Workflow: call `getOrCreateDraft()` to ensure draft version exists. (b) For each TriggerRegistration without `workflowVersionId`: set `workflowVersionId` to the draft version's `_id`, `workflowVersion: "draft"`. (c) Support `--dry-run`, `--tenant-id` filter, `--batch-size`. (d) Idempotent (safe to re-run). (e) Add `pnpm migrate:workflow-versions` script in runtime `package.json`.

5.3. Write E2E tests in `apps/runtime/src/__tests__/workflow-versioning.e2e.test.ts` (core lifecycle scenarios per test spec Section 8):

- E2E-1: Full version lifecycle (create → deploy → activate → deactivate → verify)
- E2E-3: Soft delete cascade (delete workflow → verify all versions/triggers cascade)
- E2E-4: Default version resolution via Process API (latest active, draft fallback)
- E2E-5: Cross-tenant/project isolation (404 for cross-scope access)
- E2E-9: Unauthenticated/expired auth (401/403 responses)

  5.4. Write trigger-specific E2E tests in `apps/runtime/src/__tests__/workflow-version-triggers.e2e.test.ts`:

- E2E-2: Activate/deactivate with trigger registration
- E2E-7: Cron fires version's frozen flow (not draft)
- E2E-8: Per-trigger toggle blocked on inactive version

  5.5. Write deployment E2E test in `apps/runtime/src/__tests__/workflow-version-deployment.e2e.test.ts`:

- E2E-6: Deploy workflow version via Operate > Deployments (auto-mode snapshots draft)

  5.6. Add observability: Emit `workflow.version.resolution.miss` metric when resolveDefaultVersion falls back to draft. Tag WorkflowExecution documents with `workflowVersion` and `workflowVersionId`. Log trigger fires with version metadata.

**Files Touched**:

- `packages/shared/src/tools/validate-workflow-tool-binding.ts`
- `apps/runtime/src/scripts/migrate-workflow-versions.ts` — new
- `apps/runtime/package.json` — add script entry
- `apps/runtime/src/__tests__/workflow-versioning.e2e.test.ts` — new (E2E-1, 3, 4, 5, 9)
- `apps/runtime/src/__tests__/workflow-version-triggers.e2e.test.ts` — new (E2E-2, 7, 8)
- `apps/runtime/src/__tests__/workflow-version-deployment.e2e.test.ts` — new (E2E-6)

**Exit Criteria**:

- [ ] `validate-workflow-tool-binding` passes for workflows with active version (new model)
- [ ] `validate-workflow-tool-binding` passes for workflows with `status: 'active'` (legacy)
- [ ] `validate-workflow-tool-binding` fails for deleted workflows
- [ ] Migration script runs with `--dry-run` showing expected changes
- [ ] Migration script idempotent (re-run produces no changes)
- [ ] E2E-1 through E2E-5 pass (core lifecycle scenarios)
- [ ] E2E-6 through E2E-9 pass (deployment, triggers, auth)
- [ ] `pnpm build && pnpm test` — full suite green
- [ ] `workflow.version.resolution.miss` metric emitted on draft fallback

**Test Strategy**:

- E2E: Real Express servers, real MongoDB, full auth middleware chain (tasks 5.3, 5.4)
- Integration: validate-workflow-tool-binding with MongoMemoryServer (per INT-11)

> **UI E2E (Playwright)**: `apps/studio/e2e/workflows/workflow-versioning.spec.ts` is deferred to post-implementation Playwright suite build-out. The Studio E2E infrastructure is not yet mature enough for reliable CI. Manual verification in Phase 4 covers the UI journeys until then.

**Rollback**: Revert integration fixes. Backend + UI remain functional. Migration script is a standalone tool.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] `WorkflowVersionState` type exported from `packages/database/src/models/workflow-version.model.ts` barrel export
- [ ] `IWorkflowVersionTrigger` interface added to `packages/database/src/models/index.ts` barrel export
- [ ] New indexes defined in schema (not as separate `createIndex` calls)
- [ ] `activate()` and `deactivate()` routes registered in `workflow-versions.ts` router
- [ ] `PATCH /:version` route registered in `workflow-versions.ts` router
- [ ] `softDeleteCascade()` called from `DELETE /workflows/:id` route handler
- [ ] `getOrCreateDraft()` called from `POST /workflows` route handler
- [ ] `resolveDefaultVersion()` called from `process-api.ts` route handler
- [ ] `workflowVersionId` populated when creating `TriggerRegistration` via `trigger-engine.ts register()`
- [ ] `TriggerSchedulerDeps` updated with `workflowVersionModel` dependency
- [ ] `TriggerEngineDeps` usage updated for version-first binding path
- [ ] Studio proxy routes registered (Next.js file-based routing — auto-registered by file existence)
- [ ] `WorkflowVersionsTab` imported and rendered in `WorkflowDetailPage.tsx` tab list
- [ ] Version API methods added to `apps/studio/src/api/workflows.ts`
- [ ] Migration script registered as `"migrate:workflow-versions"` in `apps/runtime/package.json` scripts
- [ ] `validate-workflow-tool-binding.ts` updated with `workflowVersionsRepo` in context

---

## 5. Cross-Phase Concerns

### Database Migrations

No formal migration framework. Migration is handled by:

1. **Schema changes** (Phase 1): Mongoose schema updates are applied on model load. New fields with defaults are safe. Index creation is automatic via `schema.index()`.
2. **Data backfill** (Phase 5): Standalone CLI script `pnpm migrate:workflow-versions` creates draft versions and backfills trigger registrations.
3. **BullMQ state**: Existing cron jobs in Redis retain old data format. `processJob()` fallback handles this (Phase 3 task 3.5).

### Feature Flags

No feature flags. Migration phase is controlled by:

- `WORKFLOW_VERSION_MIGRATION_PHASE=1` (env var, default `1`, documentation only in this LLD)
- Phase 2 cleanup is a separate future LLD

### Configuration Changes

| Variable                           | Default | Description                                               | Phase   |
| ---------------------------------- | ------- | --------------------------------------------------------- | ------- |
| `WORKFLOW_VERSION_MIGRATION_PHASE` | `1`     | Documents migration state; Phase 2 changes default to `2` | Phase 1 |

No other new env vars needed. Existing BullMQ, MongoDB, and Restate connections are reused.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases complete with exit criteria met
- [ ] 9 E2E tests from test spec passing (E2E-1 through E2E-9)
- [ ] 12 integration tests from test spec passing (INT-1 through INT-12)
- [ ] 6 unit tests from test spec passing (UT-1 through UT-6)
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Feature spec updated with implementation details via `/post-impl-sync`
- [ ] Testing matrix updated with actual coverage
- [ ] Migration script tested with `--dry-run` on realistic data
- [ ] Workflow-as-tool binding works for both new and legacy models (GAP-008)
- [ ] Cross-tenant isolation verified (all cross-scope access returns 404)
- [ ] Version state changes emit audit events via TraceStore
- [ ] `workflow.version.resolution.miss` metric emitted on draft fallback

---

## 7. Open Questions

None blocking. All resolved.

> **Resolved**: LQ-1 → LD-10 (explicit code in PATCH handler). LQ-2 → LD-14 (generic JSON diff for Phase 1). LQ-3 → task 4.8 (same debounce, different endpoint target — no throttling change needed). LQ-4 → LD-11 (always ensure draft exists).

### Integration Test File Consolidation

The test spec Section 8 lists 12 granular integration test files. The LLD consolidates into 4 files for reduced overhead. Mapping:

| Test Spec File                                 | LLD Equivalent                                    | Coverage     |
| ---------------------------------------------- | ------------------------------------------------- | ------------ |
| `workflow-version-activate-deactivate.test.ts` | `workflow-version-lifecycle.test.ts` (task 2.12)  | INT-2, INT-3 |
| `workflow-delete-cascade.test.ts`              | `workflow-version-lifecycle.test.ts` (task 2.12)  | INT-4        |
| `workflow-version-immutability.test.ts`        | `workflow-version-service.test.ts` (task 2.11)    | INT-6        |
| `workflow-version-isolation.test.ts`           | `workflow-version-routes.test.ts` (task 3.11)     | INT-7        |
| `trigger-environment-routing.test.ts`          | `trigger-fire-resolution.test.ts` (task 3.12)     | INT-5        |
| `trigger-version-processJob.test.ts`           | `trigger-fire-resolution.test.ts` (task 3.12)     | INT-8, INT-9 |
| `workflow-tool-binding-version.test.ts`        | standalone (Phase 5 per INT-11)                   | INT-11       |
| `workflow-version-inflight.test.ts`            | `workflow-version-lifecycle.test.ts` (task 2.12)  | INT-12       |
| `workflow-version-routes.test.ts` (atomic)     | `workflow-version-routes.test.ts` (task 3.11)     | INT-1        |
| `workflow-version-resolution.test.ts`          | `workflow-version-resolution.test.ts` (task 3.13) | INT-3        |
| `deployment-auto-mode-version.test.ts`         | `trigger-fire-resolution.test.ts` (task 3.12)     | INT-10       |

### Post-Impl-Sync Notes

Items flagged during audit for `/post-impl-sync` to fix:

- Feature spec Section 9: sourceHash index should include `workflowId` (currently `{ tenantId, sourceHash }`, should be `{ tenantId, workflowId, sourceHash }`)
- Feature spec delivery plan 3.4: mark connector trigger engines update as deferred per LD-7
- Test spec INT-6 step 4: resolve TBD to "400 (envVars frozen per D-1)"

---

## 8. References

- Feature spec: `docs/features/sub-features/workflow-versioning.md`
- HLD: `docs/specs/workflow-versioning.hld.md`
- Test spec: `docs/testing/sub-features/workflow-versioning.md`
- Prior design (superseded): `docs/plans/2026-03-09-workflow-versioning-deployment-design.md`
- Existing migration pattern: `apps/runtime/src/scripts/migrate-env-to-instances.ts`
- SDLC log: `docs/sdlc-logs/workflow-versioning/lld.log.md`
