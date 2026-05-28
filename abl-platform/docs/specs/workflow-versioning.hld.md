# HLD: Workflow Versioning & Version-Aware Triggers

**Feature Spec**: `docs/features/sub-features/workflow-versioning.md`
**Test Spec**: `docs/testing/sub-features/workflow-versioning.md`
**Prior Design**: `docs/plans/2026-03-09-workflow-versioning-deployment-design.md` (superseded)
**Status**: IMPLEMENTED
**Author**: Runtime Team
**Date**: 2026-04-14

---

## 1. Problem Statement & Goal

The workflow system operates on a single mutable "working copy" with a broken status lifecycle. Five specific problems drive this redesign:

1. **No usable versioning**: `WorkflowVersion` model and `WorkflowVersionService` exist but are not exposed in Studio UI. Users cannot snapshot, compare, or roll back.
2. **Broken status lifecycle**: Four statuses exist (`draft`/`active`/`paused`/`archived`) but no UI or API path transitions `draft` → `active`. The Zod schema at `workflows.ts:68` excludes `draft` from updates.
3. **Inconsistent status enforcement**: Process API checks `workflow.status === 'active'` (line 145), but the internal execute endpoint and trigger fire paths skip the check entirely.
4. **Triggers are not version-aware**: `TriggerRegistration` binds to `workflowId`, not a version. `TriggerScheduler.processJob()` (line 189) always loads the Workflow working copy. Only `TriggerEngine.fireWebhookTrigger()` has partial deployment-based resolution (lines 300-352), and only for webhooks.
5. **No publish/deploy workflow**: Agents have a mature working-copy + versioned-snapshot pattern. Workflows lack this entirely.

**Goal**: Introduce a version-first workflow model where the workflow document is a thin container (metadata only), all mutable state lives on `WorkflowVersion` documents, triggers bind directly to specific versions, and the lifecycle reduces to `active`/`inactive` for published versions — eliminating fire-time resolution, enabling independent version management, and supporting gradual migration from the current model.

---

## 2. Alternatives Considered

### Option A: Fix the Status Lifecycle (Add Missing Transitions)

- **Description**: Add `draft → active` transition in the Zod schema and UI. Keep workflow-level status. Keep triggers bound to workflow ID.
- **Pros**: Minimal code change. Low risk. Fixes the immediate "stuck in draft" bug.
- **Cons**: Does NOT solve versioning (no snapshot, no rollback, no comparison). Does NOT solve trigger version-awareness (cron always fires latest working copy). Inconsistent enforcement remains in internal/trigger paths. Kicks the can on production reliability.
- **Effort**: S

### Option B: Deployment-Only Versioning (Prior Design — Superseded)

- **Description**: Versions pinned exclusively through deployment manifests (`workflowVersionManifest`). No independent version activation outside deployments. Triggers resolve version via deployment lookup at fire time. This was the approved design from `docs/plans/2026-03-09`.
- **Pros**: Leverages existing deployment infrastructure. Consistent with agent deployment model.
- **Cons**: Fire-time deployment lookup adds latency and a failure point on every trigger fire. No independent version lifecycle (can't activate/deactivate without redeploying). Cron path (`TriggerScheduler.processJob()`) has no deployment context — requires adding deployment resolution to a path that currently has none. Complex routing logic for environment-scoped events.
- **Effort**: M

### Option C: Version-First Model with Direct Trigger Binding (Recommended)

- **Description**: Strip workflow to a thin container (metadata only). All mutable state lives on `WorkflowVersion` documents. "Draft" is a version identifier, not a state. Published versions have `active`/`inactive` states. Each version owns its trigger registrations independently. Triggers carry `workflowVersionId` — no fire-time resolution needed. Deploy through existing Operate > Deployments system.
- **Pros**: Eliminates fire-time resolution entirely — trigger registration already knows its version. Independent version lifecycle (activate/deactivate without redeploying). Clean data model (thin container + versioned state). Aligns with the one-trigger-per-version architecture. Gradual migration possible.
- **Cons**: Larger scope than Option B. More trigger registrations (one set per active version vs shared). Migration needed for existing data. Existing tests (28 across 4 files) need rewriting.
- **Effort**: L

### Recommendation: Option C

**Rationale**: Option A is a band-aid that doesn't address the core versioning and trigger-awareness gaps. Option B (the prior design) requires complex fire-time resolution that the cron path doesn't support today, and couples version lifecycle to deployment lifecycle. Option C eliminates fire-time resolution entirely by binding triggers directly to versions at registration time — simpler, faster, and more reliable. The larger scope is justified because the structural problems (broken status, no versioning, unaware triggers) are interconnected and must be solved together.

---

## 3. Architecture

### System Context Diagram

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         Studio (Next.js)                            │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐     │
│  │ Flow Tab    │  │ Versions Tab │  │ Operate > Deployments  │     │
│  │ (edit draft)│  │ (list/toggle)│  │ (publish + deploy)     │     │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬────────────┘     │
│         │                │                       │                  │
└─────────┼────────────────┼───────────────────────┼──────────────────┘
          │ auto-save      │ activate/deactivate   │ create deployment
          ▼                ▼                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Runtime (Express)                            │
│                                                                     │
│  ┌─────────────────────┐  ┌────────────────────────────────────┐   │
│  │ WorkflowVersionSvc  │  │ Deployment Route Handler           │   │
│  │ - getOrCreateDraft() │  │ - "auto" → createVersion(draft)   │   │
│  │ - activate()        │  │ - registers triggers via svc       │   │
│  │ - deactivate()      │  └────────────────────────────────────┘   │
│  │ - resolveDefault()  │                                           │
│  │ - createVersion()   │  ┌────────────────────────────────────┐   │
│  └─────────┬───────────┘  │ Process API                        │   │
│            │              │ - resolveDefaultVersion()           │   │
│            │              │ - or explicit ?version=v1.0         │   │
│            │              └──────────────┬─────────────────────┘   │
└────────────┼─────────────────────────────┼─────────────────────────┘
             │                             │
             ▼                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         MongoDB                                     │
│                                                                     │
│  ┌──────────┐   ┌──────────────────┐   ┌─────────────────────┐    │
│  │workflows │   │workflow_versions │   │trigger_registrations│    │
│  │(thin     │   │(draft + published│   │(workflowVersionId  │    │
│  │ container│   │ all mutable state│   │ + workflowVersion) │    │
│  │ no flow) │   │ flow + triggers) │   │                    │    │
│  └──────────┘   └──────────────────┘   └──────────┬──────────┘    │
│                                                    │               │
└────────────────────────────────────────────────────┼───────────────┘
                                                     │
                    ┌────────────────────────────────┘
                    │ trigger fire
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Workflow Engine (Docker)                         │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────────┐                    │
│  │ TriggerScheduler │  │ TriggerEngine        │                    │
│  │ processJob():    │  │ fireWebhookTrigger():│                    │
│  │ load version by  │  │ load version by      │                    │
│  │ workflowVersionId│  │ workflowVersionId    │                    │
│  └────────┬─────────┘  └──────────┬───────────┘                    │
│           │                       │                                 │
│           ▼                       ▼                                 │
│  ┌──────────────────────────────────────┐                          │
│  │ canvas-to-steps → Restate execution │                          │
│  │ (uses frozen version definition)    │                          │
│  └──────────────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
        ┌───────────────────┐
        │  Redis / BullMQ   │
        │  - cron schedules │
        │  - trigger state  │
        └───────────────────┘
```

### Component Diagram

```text
WorkflowVersionService (apps/runtime)
├── getOrCreateDraft(workflowId)      → ensures draft WorkflowVersion exists
├── createVersion(params, source?)     → snapshot draft into published version
├── activate(tenantId, projectId, wfId, version)
│   ├── set state = "active"
│   ├── create TriggerRegistrations (workflowVersionId)
│   └── BullMQ.scheduleCron() / EventBus.subscribe()
├── deactivate(tenantId, projectId, wfId, version)
│   ├── set state = "inactive"
│   ├── update TriggerRegistrations → status: "inactive"
│   └── BullMQ.unschedule() / EventBus.unsubscribe()
├── resolveDefaultVersion(tenantId, projectId, wfId)
│   └── findOne({ state: "active", deleted: false }, sort: { publishedAt: -1 })
│       fallback → draft
├── listVersions(params)
├── getVersion(wfId, version, tenantId, projectId)
├── diffVersions(wfId, versionA, versionB)
└── softDeleteCascade(tenantId, projectId, wfId)
    ├── MongoDB transaction:
    │   ├── Workflow.deleted = true
    │   ├── WorkflowVersion.updateMany({ workflowId }) → deleted = true
    │   └── TriggerRegistration.updateMany({ workflowId }) → status = "deleted"
    └── Best-effort: BullMQ.unschedule() for each cron trigger
```

### Data Flow: Publish via Deployment

```text
1. User → Studio → POST /api/projects/:pid/deployments
   { workflowVersionManifest: { "order_flow": "auto" }, environment: "production" }

2. Deployment Route Handler:
   a. For "auto" entries:
      - Call WorkflowVersionService.createVersion({ source: 'draft' })
      - Returns new version (e.g., "v0.1.0") with frozen flow snapshot
   b. For explicit version entries (e.g., "v1.0"):
      - Validate version exists and matches tenantId/projectId

3. WorkflowVersionService.createVersion():
   a. Load draft: WorkflowVersion.findOne({ workflowId, version: "draft" })
   b. Compute sourceHash of draft's definition
   c. Dedup check: if sourceHash matches existing version → return that version
   d. Auto-increment version number (nextVersion())
   e. Create WorkflowVersion: { version: "v0.1.0", state: "active",
      environment: "production", definition: <frozen from draft>,
      triggers: <copied from draft>, publishedAt: now, publishedBy: userId }

4. WorkflowVersionService.activate():
   a. For each trigger definition on the version:
      - Create TriggerRegistration with workflowVersionId + environment
      - If cron: BullMQ.scheduleCron(expression, jobData: { triggerRegistrationId, workflowVersionId })
      - If app-event: EventBus.subscribe(eventType, { workflowVersionId, environment })
      - If webhook: generate URL → return to caller

5. Deployment document saved with workflowVersionManifest resolved to actual versions
```

### Data Flow: Cron Trigger Fire

```text
1. BullMQ fires cron job with jobData: { triggerRegistrationId, workflowVersionId }

2. TriggerScheduler.processJob():
   a. Load TriggerRegistration by triggerRegistrationId
   b. Guard: if trigger.status !== "active" → skip (safety net)
   c. Load WorkflowVersion by workflowVersionId
   d. Guard: if version not found or version.deleted → skip + warn
   e. convertCanvasToSteps(version.definition.nodes, version.definition.edges)
   f. Start Restate execution with frozen step definitions
   g. Restate captures definition durably — version deactivation won't affect this execution

Note on app-event trigger fire (FR-17): App-event triggers use strict equality
matching on the `environment` field: event.environment === trigger.environment,
including both-null equality. See FR-17 for the 5-case matrix. This applies to
EventBus.subscribe() registrations created during activate().
```

### Data Flow: Default Version Resolution (Process API)

```text
1. External caller → POST /api/v1/process/:workflowId
   (no ?version param)

2. Process API Route:
   a. Resolve workflow by ID + tenantId + projectId
   b. Call WorkflowVersionService.resolveDefaultVersion(tenantId, projectId, workflowId)
      → findOne: { workflowId, state: "active", deleted: false, version: { $ne: "draft" } }
                  sort: { publishedAt: -1 }, limit: 1
      → fallback: findOne { workflowId, version: "draft" }
   c. Load version definition
   d. convertCanvasToSteps → execute via Restate

3. With explicit version: POST /api/v1/process/:workflowId?version=v1.0
   a. Load WorkflowVersion by { workflowId, version: "v1.0", tenantId, projectId }
   b. Guard: if not found or state !== "active" → 404
   c. Execute with that version's definition
```

### UI Architecture: Versions Tab (FR-20)

```text
WorkflowDetailPage (existing)
├── Flow Tab (existing — edits draft version)
├── Versions Tab (NEW)
│   ├── WorkflowVersionList
│   │   ├── fetches: GET /versions (list with state, environment, publishedAt)
│   │   ├── each row: version name, state badge, environment, date, toggle button
│   │   └── toggle calls: POST /versions/:v/activate or /deactivate
│   ├── WorkflowVersionDetail (selected version)
│   │   ├── fetches: GET /versions/:v (full definition)
│   │   ├── read-only flow preview (canvas in view-only mode)
│   │   └── metadata: environment, publishedBy, trigger count
│   └── WorkflowVersionDiff (compare mode)
│       ├── fetches: GET /versions/:v/diff/:other
│       └── renders: side-by-side node/edge differences
├── Operate Tab (existing)
└── Monitor Tab (existing — filterable by version)

UX State (Zustand store or local component state):
  selectedVersion: string | null (version name for detail view)
  diffPair: [string, string] | null (pair for comparison)
  versionListFilter: "all" | "active" | "inactive"

Data flow:
  1. Tab mount → GET /versions → populate list
  2. User clicks version row → set selectedVersion → GET /versions/:v → render detail
  3. User clicks "Compare" → set diffPair → GET /versions/:v/diff/:other → render diff
  4. User toggles activate/deactivate → POST → refetch list
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | Every query on `workflow_versions` and `trigger_registrations` includes `tenantId`. The `tenantIsolationPlugin` (existing on WorkflowVersion model) auto-injects `tenantId` into all queries. Cross-tenant access returns 404 (not 403). Compound indexes prefix with `tenantId`.                                                                |
| 2   | **Data Access Pattern** | Direct Mongoose model access (existing pattern). `WorkflowVersionService` is the single service responsible for version CRUD + lifecycle. No repository abstraction layer (consistent with existing `WorkflowVersionService` pattern). MongoMemoryServer for integration tests.                                                                  |
| 3   | **API Contract**        | RESTful endpoints under `/api/projects/:projectId/workflows/:workflowId/versions/`. Responses use `{ success: true, data: {...} }` envelope. Errors use `{ success: false, error: { code, message } }`. Activate/deactivate are POST (state-changing, not idempotent PUT). Version identifier in URL path, not query param (except Process API). |
| 4   | **Security Surface**    | Auth via `createUnifiedAuthMiddleware`/`requireAuth`. RBAC: `workflow:read/write/delete`, `deployment:create`. Input validation via Zod schemas. Version names validated (alphanumeric + dots + hyphens). `webhookSecret` encrypted at rest via `shared-encryption`. No direct DB access in E2E tests.                                           |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | **Error Model**   | Version not found → 404. Activate draft → 400 `DRAFT_ALWAYS_ACTIVE`. Modify frozen field on published → 400 `FIELD_FROZEN`. Toggle trigger on inactive version → 400 `VERSION_INACTIVE`. Deactivate draft → 400 `DRAFT_ALWAYS_ACTIVE`. Duplicate version name → 409 `VERSION_EXISTS`. Optimistic lock conflict → 409 `CONCURRENT_MODIFICATION`. All errors follow structured `{ code, message }` envelope.               |
| 6   | **Failure Modes** | Cron fire with missing version → skip + warn (not retry). Webhook fire with missing version → 500 to caller. BullMQ down during activate → activation succeeds in MongoDB; trigger registration created; cron schedule fails → logged as degraded. MongoDB transaction failure during cascade delete → atomic rollback, no partial state. Restate captures definition at execution start → version deactivation is safe. |
| 7   | **Idempotency**   | Activate already-active version → 200 (idempotent, no state change). Deactivate already-inactive → 200 (idempotent). Delete already-deleted workflow → 200 (idempotent). Create version from unchanged draft → returns existing version via `sourceHash` dedup (no duplicate). Per-trigger toggle ON when already ON → 200 (no-op).                                                                                      |
| 8   | **Observability** | Every `WorkflowExecution` tagged with `workflowVersion` and `workflowVersionId`. Trigger fires log `{ registrationId, workflowVersionId, workflowVersion, environment }`. Version state changes (activate/deactivate) emit audit events via `TraceStore`. Monitor tab filterable by version. Missing version resolution → warn-level log + metric `workflow.version.resolution.miss`.                                    |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | `resolveDefaultVersion()`: p99 < 5ms (single indexed `findOne` with sort on compound index). Trigger fire: p99 < 10ms added (one `findOne` by `_id`). Auto-save: same latency as today (writes to one document instead of another). Activate/deactivate: < 500ms (MongoDB + BullMQ schedule). Cascade delete: < 2s for 10 versions (transaction + best-effort BullMQ). No caching needed at expected scale (10-50 workflows/project, 1-10 versions/workflow).                                                                                                                                                                                                                                                                                 |
| 10  | **Migration Path**     | **Phase 1 (Additive)**: CLI script `pnpm migrate:workflow-versions` batch-creates draft WorkflowVersions from existing Workflows, backfills `workflowVersionId` on TriggerRegistrations. `getOrCreateDraft()` acts as safety net. Canvas saves write to draft version; post-save hook syncs to Workflow document. Deployment-based resolution preserved as fallback. Env var `WORKFLOW_VERSION_MIGRATION_PHASE=1`. **Phase 2 (Cleanup)**: Remove denormalized fields from Workflow. Remove sync hook. Remove deployment-based fire resolution. `WORKFLOW_VERSION_MIGRATION_PHASE=2`.                                                                                                                                                          |
| 11  | **Rollback Plan**      | **Phase 1 rollback**: Stop dual-write code; Workflow document fields remain usable. `workflowVersionId` on TriggerRegistrations is additive — ignored by old code. Draft WorkflowVersions become stale but harmless. Version endpoints disabled. No data loss. **Phase 2 rollback**: (1) Re-deploy Phase 1 code with sync hook re-enabled. (2) Run backfill migration script (`pnpm migrate:workflow-rollback-phase2`) to reconstruct Workflow document fields (`nodes`, `edges`, `triggers`, `envVars`, etc.) from each workflow's current draft version. (3) Verify via monitoring that all Workflow documents are populated before enabling user traffic. Heavier lift — Phase 2 should only proceed after Phase 1 is stable for ≥2 weeks. |
| 12  | **Test Strategy**      | **9 E2E scenarios** exercising real HTTP API with full middleware chain. **12 integration scenarios** with MongoMemoryServer + BullMQ test doubles via DI. **6 unit tests** for pure functions (resolution sort, environment matching, hash stability). No mocking of platform components. 4 existing test files flagged for REWRITE. BullMQ and Restate are only external deps that may use DI test doubles. Full spec: `docs/testing/sub-features/workflow-versioning.md`.                                                                                                                                                                                                                                                                  |

---

## 5. Data Model

### Modified: `workflows` (thin container)

```text
Fields RETAINED:
  _id, tenantId, projectId, name, description, metadata,
  createdBy, createdAt, updatedAt

Fields ADDED:
  tags: string[] (searchable workflow categorization)
  deleted: boolean (default: false — soft delete flag)
  deletedAt: Date | null (timestamp of soft deletion)

Fields REMOVED (Phase 2):
  status, nodes, edges, triggers, envVars,
  inputSchema, outputSchema, deployment
  Note: `steps` is a schemaless field (accessed dynamically at runtime,
  not declared in Mongoose schema) — clean up references in Phase 2.

Fields RETAINED (Phase 1 only, read-only mirror):
  status, nodes, edges, triggers, envVars,
  inputSchema, outputSchema, deployment
  (populated by post-save sync hook from draft version)

Indexes:
  { tenantId: 1, projectId: 1, name: 1 } (unique, existing)
  { tenantId: 1, projectId: 1, deleted: 1 } (NEW — replaces { tenantId: 1, projectId: 1, status: 1 } which is removed in Phase 2 when `status` is dropped)
  { tenantId: 1, projectId: 1, status: 1 } (existing — REMOVED in Phase 2)
  { tenantId: 1, 'deployment.endpointSlug': 1 } (unique, partial, existing — REMOVED in Phase 2)
```

### Modified: `workflow_versions` (owns all mutable state)

```text
Fields RETAINED:
  _id, tenantId, projectId, workflowId, version, definition
  (nodes, edges, envVars, inputSchema, outputSchema),
  sourceHash, changelog, createdBy, _v, createdAt, updatedAt

Fields ADDED:
  state: "active" | "inactive" (replaces 5-status enum)
  environment: string | null (null for draft, set for published)
  deploymentId: string | null (references deployments._id)
  triggers: Array<{ id, type, config }> (version owns its trigger definitions)
    Note: `status` is deliberately excluded — per-trigger active/paused state
    is managed via TriggerRegistration documents, not the version's embedded
    trigger definitions. The existing Workflow.triggers has `status` but it
    is not needed on the version since registrations handle lifecycle.
  deleted: boolean (default: false)
  publishedAt: Date | null (null for draft)
  publishedBy: string | null (null for draft)

Fields REMOVED:
  status (was: draft/testing/staged/active/deprecated)
  promotedAt, promotedBy

Indexes:
  { tenantId: 1, projectId: 1, workflowId: 1, version: 1 } (unique, existing)
  { tenantId: 1, projectId: 1, workflowId: 1, state: 1, deleted: 1, publishedAt: -1 } (NEW: resolveDefaultVersion)
  { tenantId: 1, workflowId: 1, sourceHash: 1 } (NEW: deduplication — includes workflowId for scoped lookup)
```

### Modified: `trigger_registrations` (version-aware)

```text
Fields ADDED:
  workflowVersionId: string (references workflow_versions._id)
  workflowVersion: string ("draft", "v1.0" — for display/query)

All existing fields retained (workflowId, triggerType, config,
  status, environment, tenantId, projectId, etc.)

Status enum EXTENDED (per D-3):
  'active' | 'paused' | 'error' | 'deleted' | 'inactive' (NEW)
  "inactive" = version-level deactivation (set by deactivate())
  "paused"   = user-initiated per-trigger toggle (FR-13)

Indexes ADDED:
  { tenantId: 1, workflowVersionId: 1, status: 1 }
```

### Key Relationships

```text
Workflow  ──1:N──  WorkflowVersion (one draft + zero or more published)
WorkflowVersion  ──1:N──  TriggerRegistration (version owns its triggers)
Deployment  ──refs──  WorkflowVersion (via workflowVersionManifest)
WorkflowExecution  ──refs──  WorkflowVersion (via workflowVersionId for audit)
```

---

## 6. API Design

### New Endpoints

| Method | Path                                                                    | Purpose                          | Auth                             |
| ------ | ----------------------------------------------------------------------- | -------------------------------- | -------------------------------- |
| GET    | `/api/projects/:projectId/workflows/:wfId/versions`                     | List all versions                | `requireAuth` + `workflow:read`  |
| GET    | `/api/projects/:projectId/workflows/:wfId/versions/:version`            | Get version detail               | `requireAuth` + `workflow:read`  |
| PATCH  | `/api/projects/:projectId/workflows/:wfId/versions/:version`            | Update mutable fields            | `requireAuth` + `workflow:write` |
| POST   | `/api/projects/:projectId/workflows/:wfId/versions/:version/activate`   | Activate + register triggers     | `requireAuth` + `workflow:write` |
| POST   | `/api/projects/:projectId/workflows/:wfId/versions/:version/deactivate` | Deactivate + deregister triggers | `requireAuth` + `workflow:write` |
| GET    | `/api/projects/:projectId/workflows/:wfId/versions/:v/diff/:other`      | Diff two versions                | `requireAuth` + `workflow:read`  |

**PATCH `/versions/:version` request shape:**

```text
For draft version:
  { definition?: { nodes, edges, envVars, inputSchema, outputSchema }, triggers?: [...], changelog?: string }
  All fields are mutable on the draft.

For published active version:
  { triggers?: [cron expression/app-event config changes only], changelog?: string }
  Frozen fields: definition.nodes, definition.edges, definition.envVars (per D-1),
    definition.inputSchema, definition.outputSchema, webhook triggers.
  Attempts to modify frozen fields → 400 FIELD_FROZEN with { frozenFields: ["definition.nodes", ...] }

For published inactive version:
  No mutations allowed → 400 FIELD_FROZEN (all fields frozen on inactive versions)
```

### Modified Endpoints

| Method | Path                                       | Change                                                                                     |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| POST   | `/api/projects/:projectId/workflows`       | Creates Workflow + draft WorkflowVersion atomically                                        |
| GET    | `/api/projects/:projectId/workflows/:wfId` | Returns thin container + draft version. No `status` in response.                           |
| PATCH  | `/api/projects/:projectId/workflows/:wfId` | Phase 1: writes to draft version + syncs to Workflow. Phase 2: draft only.                 |
| DELETE | `/api/projects/:projectId/workflows/:wfId` | Soft delete cascade (transaction + best-effort BullMQ cleanup)                             |
| POST   | `/api/projects/:projectId/deployments`     | `"auto"` in `workflowVersionManifest` snapshots from draft version                         |
| POST   | `/api/v1/process/:workflowId`              | Adds `resolveDefaultVersion()` when no `?version=` specified                               |
| POST   | `/api/v1/process/:workflowId?version=v1.0` | Explicit version lookup — 404 if not found or inactive                                     |
| POST   | `/triggers/:registrationId/pause`          | Add `VERSION_INACTIVE` guard — reject pause for triggers whose owning version is inactive  |
| POST   | `/triggers/:registrationId/resume`         | Add `VERSION_INACTIVE` guard — reject resume for triggers whose owning version is inactive |

### Error Responses

| Code | Error Code                | When                                                                                          |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------- |
| 400  | `DRAFT_ALWAYS_ACTIVE`     | Attempt to deactivate or delete the draft version                                             |
| 400  | `FIELD_FROZEN`            | Attempt to modify frozen field (flow, webhook triggers, envVars per D-1) on published version |
| 400  | `VERSION_INACTIVE`        | Attempt to toggle trigger on inactive version                                                 |
| 404  | `WORKFLOW_NOT_FOUND`      | Workflow does not exist or is soft-deleted                                                    |
| 404  | `VERSION_NOT_FOUND`       | Version does not exist, is deleted, or is inactive (for execution)                            |
| 409  | `VERSION_EXISTS`          | Duplicate version name for this workflow                                                      |
| 409  | `CONCURRENT_MODIFICATION` | Optimistic lock conflict on activate/deactivate                                               |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Version state changes (activate/deactivate), workflow deletions, and deployment-triggered version creation emit audit events via `TraceStore`. Each event includes `tenantId`, `projectId`, `workflowId`, `workflowVersionId`, `userId`, `action`, `timestamp`.

- **Rate Limiting**: No additional rate limits needed. Activate/deactivate are low-frequency operations. Existing per-project API rate limits apply.

- **Caching**: No dedicated cache. `resolveDefaultVersion()` uses a compound index query (p99 < 5ms). If future scale requires it, add an in-memory Map with 30s TTL keyed on `{tenantId, projectId, workflowId}`, invalidated on activate/deactivate.

- **Encryption**: `webhookSecret` on trigger registrations encrypted at rest via `shared-encryption` (existing pattern). Version definitions are not encrypted (same as current Workflow document — contains flow logic, not user data).

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                    | Type           | Risk   |
| ----------------------------- | -------------- | ------ |
| MongoDB transactions          | Infrastructure | Low    |
| BullMQ cron scheduling        | Infrastructure | Medium |
| Restate durable execution     | Infrastructure | Low    |
| Deployment system (routes/UI) | Feature        | Low    |
| `tenantIsolationPlugin`       | Platform       | Low    |
| `shared-encryption`           | Platform       | Low    |

### Downstream (depends on this feature)

| Consumer                                   | Impact                                                         |
| ------------------------------------------ | -------------------------------------------------------------- |
| Workflow-as-Tool binding                   | Must update `validate-workflow-tool-binding.ts` (GAP-008)      |
| Project Import/Export                      | Must handle version-first model in export/import (GAP-005)     |
| Studio canvas auto-save                    | Must target draft version instead of Workflow document         |
| Process API callers (SDK, A2A, MCP)        | Transparent — default version resolution handles it            |
| Connector triggers (`packages/connectors`) | Must add `workflowVersionId` awareness to fire paths (GAP-001) |

---

## 9. Open Questions & Decisions Needed

1. **OQ-1 (from feature spec)**: Maximum published versions per workflow? The HLD recommends starting without a limit and adding one based on observed storage growth after 3 months of adoption data.

2. **OQ-2 (from feature spec)**: Auto-deactivate previous version on same environment during deployment? The HLD recommends showing a confirmation dialog with the option to auto-deactivate, but defaulting to manual action. The deployment route should support an optional `deactivatePrevious: true` flag.

3. **OQ-3 (new)**: During Phase 1, should `processJob()` fallback to working copy when `workflowVersionId` is absent on a trigger registration (pre-migration triggers), or should the migration script be treated as mandatory before code deploy? The HLD recommends the fallback for safety — see Migration Path in concern #10.

4. **OQ-4 (new)**: Should `resolveDefaultVersion()` fallback to draft be configurable per tenant/project? Some tenants may want API calls to fail with 404 if no published version exists rather than silently falling back to the draft (which may contain incomplete work). The HLD currently defaults to draft fallback for backward compatibility but this could be gated by a project-level setting.

### Decisions

- **D-1 (originally HLD OQ-4, promoted to decision)**: `definition.envVars` on published versions are **frozen** — envVars are nested under `definition` and therefore part of the frozen snapshot. envVars can change workflow behavior (e.g., API URLs, feature flags), so operational config changes should use a new deployment + new version. If mutable envVars are desired in the future, extract them out of `definition` into a top-level field.

- **D-2 (version naming convention)**: Published version names include a `v` prefix (e.g., `v0.1.0`). The existing `nextVersion()` implementation (which currently returns `"0.1.0"`) will be updated to prepend `v`. The `version: "draft"` literal is the sole non-prefixed value. All HLD, feature spec, and test spec examples use the `v` prefix consistently.

- **D-3 (trigger registration status enum)**: The `TriggerRegistration.status` enum will be extended from `'active' | 'paused' | 'error' | 'deleted'` to include `'inactive'`. `deactivate()` sets trigger registrations to `status: "inactive"` (not "paused") to distinguish version-level deactivation from user-initiated per-trigger pause. `"paused"` remains available for per-trigger toggle (FR-13).

---

## 10. References

- Feature spec: `docs/features/sub-features/workflow-versioning.md`
- Test spec: `docs/testing/sub-features/workflow-versioning.md`
- Prior design (superseded): `docs/plans/2026-03-09-workflow-versioning-deployment-design.md`
- Related HLD: `docs/specs/workflows-yaml-authoring-versioning.hld.md`
- Parent feature: `docs/features/workflows.md`
- Related sub-feature: `docs/features/sub-features/workflow-triggers.md`
- Related feature: `docs/features/deployments-versioning.md`
