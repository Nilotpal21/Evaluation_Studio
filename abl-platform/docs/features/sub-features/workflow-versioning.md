# Feature: Workflow Versioning & Version-Aware Triggers

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md)
**Status**: ALPHA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `integrations`
**Package(s)**: `apps/runtime`, `apps/workflow-engine`, `apps/studio`, `packages/database`, `packages/connectors`, `packages/shared`
**Owner(s)**: Runtime Team
**Testing Guide**: [../../testing/sub-features/workflow-versioning.md](../../testing/sub-features/workflow-versioning.md)
**Last Updated**: 2026-04-16

---

## 1. Introduction / Overview

### Problem Statement

The current workflow system operates on a single mutable "working copy" with a broken status lifecycle. Specifically:

1. **No usable versioning**: The `WorkflowVersion` model and service exist on the backend, but no Studio UI exposes them. Users cannot snapshot, compare, or roll back workflow definitions.
2. **Broken status lifecycle**: Workflow definitions have four statuses (`draft`, `active`, `paused`, `archived`), but there is no UI path from `draft` to `active`. The Zod validation schema excludes `draft` from updates, so draft workflows are permanently stuck.
3. **Status enforcement is inconsistent**: The Process API checks `workflow.status === 'active'` before execution, but the internal execute endpoint and trigger fire paths skip the check entirely. A `paused` workflow can still execute via the Studio Run button or cron triggers.
4. **Triggers are not version-aware**: Trigger registrations bind to a workflow ID, not a version. Cron triggers always run the working copy. Only webhook triggers have partial version resolution via deployment manifests — and that logic is missing from the cron path entirely (`TriggerScheduler.processJob()` never does deployment lookup).
5. **No publish/deploy workflow**: Agents have a mature working-copy + versioned-snapshot pattern with deployment pinning. Workflows lack this entirely, making them unreliable for production use.

### Goal Statement

Introduce a version-first workflow model where the workflow document is a thin container, all mutable state lives on versions, and triggers bind directly to specific versions. The draft version is always active and mutable for development; published versions are frozen snapshots deployed through the existing Operate > Deployments system shared with agents.

### Summary

This sub-feature restructures the workflow lifecycle:

- **Remove workflow-level status** — the Workflow document becomes a container (name, description, metadata) with no `status`, `nodes`, `edges`, or `triggers` of its own.
- **Version-first model** — every workflow has exactly one mutable "draft" version (always active) and zero or more published versions (active or inactive). "Draft" is a version identifier, not a state.
- **Version-aware triggers** — each version owns its trigger registrations independently (one trigger per version, Option A). Activating a version registers its triggers; deactivating unregisters them.
- **Deploy via Operate > Deployments** — publishing a workflow version happens through the existing deployment system, shared with agents. No workflow-level publish UI.
- **Soft delete cascades** — deleting a workflow marks all versions as deleted and deregisters all cron/app-event triggers across all versions.
- **Default version resolution** — API calls without a version specifier resolve to the latest active published version, falling back to draft.

---

## 2. Scope

### Goals

- G1: Remove workflow-level status (`draft`/`active`/`paused`/`archived`) — the Workflow document becomes a thin container
- G2: Establish "draft" as a mutable version identifier (always one, always active) that holds the working copy's flow, triggers, and details
- G3: Support published versions with two states: `active` (triggers registered) and `inactive` (triggers deregistered)
- G4: Implement one-trigger-per-version architecture where each version owns independent trigger registrations
- G5: Integrate workflow version deployment through Operate > Deployments (shared with agents), not at workflow level
- G6: Implement soft delete that cascades to all versions and deregisters all cron/app-event triggers
- G7: Add default version resolution — latest active published version when API doesn't specify a version
- G8: Add a Versions tab in Studio for managing published versions (list, activate, deactivate, view, diff)
- G9: Implement environment-scoped event routing so app events only fire triggers matching their environment
- G10: Gradual migration preserving backward compatibility with existing workflow data

### Non-Goals (Out of Scope)

- NG1: Blue-green deployment with traffic splitting or canary rollouts between versions
- NG2: Multiple draft versions per workflow (branching)
- NG3: Visual workflow builder redesign (separate feature — workflow editor modes)
- NG4: Cross-tenant workflow version sharing or marketplace
- NG5: Workflow-level publish/deploy UI — deployment happens exclusively at Operate > Deployments
- NG6: Automated version promotion pipelines (draft > staging > production)
- NG7: Hard delete of workflows or versions (soft delete only)

---

## 3. User Stories

1. **US-1**: As a **workflow author**, I want to edit a workflow in the canvas editor knowing that my changes are saved to a draft version so that I can iterate freely without affecting any deployed versions.

2. **US-2**: As a **workflow author**, I want to test-run my draft workflow in Studio so that I can verify the flow works before deploying to any environment.

3. **US-3**: As a **project operator**, I want to deploy my workflow's current draft as a named version (e.g., "v1.0") to a specific environment through Operate > Deployments so that production uses a frozen, tested snapshot.

4. **US-4**: As a **project operator**, I want to activate or deactivate a published workflow version so that I can control which versions have live triggers without deleting anything.

5. **US-5**: As a **project operator**, I want deactivating a version to automatically deregister its cron and app-event triggers so that no ghost executions occur from dormant versions.

6. **US-6**: As a **project operator**, I want to view all versions of a workflow in a Versions tab in Studio so that I can see what's deployed where, compare versions, and manage their state.

7. **US-7**: As an **external developer**, I want to invoke a workflow via the Process API without specifying a version and have it resolve to the latest active published version so that I don't need to track version numbers.

8. **US-8**: As a **project admin**, I want deleting a workflow to cascade to all versions and deregister all triggers so that no orphaned triggers fire against deleted workflows.

9. **US-9**: As a **project operator**, I want to edit the cron schedule or app-event configuration on a published active version without redeploying so that I can adjust operational parameters without changing the workflow logic.

10. **US-10**: As a **workflow author**, I want each trigger in the Triggers tab to have an on/off toggle so that I can control which triggers fire for the draft version during development.

---

## 4. Functional Requirements

1. **FR-1**: The system must store workflow definitions as thin containers with only metadata fields (name, description, projectId, tenantId, createdBy, deleted, deletedAt) plus a new `tags` field (not currently on the Workflow model — added by this feature). The Workflow document must NOT store flow (nodes/edges), triggers, envVars, inputSchema, outputSchema, or status directly.

2. **FR-2**: The system must automatically create a draft `WorkflowVersion` when a new workflow is created. The draft version must be created atomically with the Workflow container in a single API call.

3. **FR-3**: The system must enforce exactly one draft version per workflow. The draft version identifier is always the string `"draft"`.

4. **FR-4**: The draft version must always be considered active. There must be no mechanism to deactivate or delete the draft version independently of the workflow.

5. **FR-5**: The draft version must be fully mutable: flow (nodes/edges), webhook triggers, cron triggers, app-event triggers, details (name, description), envVars, and schemas.

6. **FR-6**: Published versions must have a `state` field with exactly two valid values: `active` and `inactive`. The 5-status lifecycle (`draft`/`testing`/`staged`/`active`/`deprecated`) must be removed from the workflow version model.

7. **FR-7**: Published versions must have frozen (immutable) flow (nodes/edges) and webhook trigger definitions. Changes to cron schedules, app-event configuration, and workflow details (name, description, tags) must be allowed on published versions regardless of state.

8. **FR-8**: Each version (draft or published) must own its trigger registrations independently. The `TriggerRegistration` model must include `workflowVersionId` and `workflowVersion` fields linking each trigger to its owning version.

9. **FR-9**: Activating a published version must register all its triggers: cron triggers via BullMQ `scheduleCron()`, app-event triggers via event bus subscription, webhook triggers via URL generation.

10. **FR-10**: Deactivating a published version must deregister all its triggers: cron triggers via BullMQ `unschedule()`, app-event triggers via event bus unsubscription. Webhook URLs must return 404 for deactivated versions.

11. **FR-11**: In-flight executions started before a version is deactivated must run to completion. Deactivation only affects new trigger fires.

12. **FR-12**: Workflow deletion must be a soft delete that cascades: set `deleted: true` on the Workflow document, set `deleted: true` on all versions (draft + published), and deregister all cron and app-event triggers across all versions. The cascade must use a MongoDB transaction for the document updates, with BullMQ unschedule as best-effort cleanup outside the transaction.

13. **FR-13**: The per-trigger on/off toggle (existing in `WorkflowTriggersTab.tsx`) must work for triggers on any version (draft or published active). Toggling off must call `pauseWorkflowTrigger()` (unschedules from BullMQ). Toggling on must call `resumeWorkflowTrigger()` (re-registers in BullMQ). Toggling must be blocked for triggers on inactive versions.

14. **FR-14**: API calls to execute a workflow without specifying a version must resolve to the latest active published version (sorted by `publishedAt` descending). If no active published version exists, the draft version must be used as fallback. If a version is specified (`?version=v1.0`), that exact version must be used (404 if not found or inactive).

15. **FR-15**: Publishing/deploying a workflow version must happen exclusively through Operate > Deployments. The deployment system must snapshot the draft version's flow and trigger definitions into a new frozen `WorkflowVersion`, assign the user-provided version name, and register the version's triggers.

16. **FR-16**: The deployment system's `"auto"` mode for `workflowVersionManifest` must snapshot the draft `WorkflowVersion` (not the Workflow document) into a new published version.

17. **FR-17**: App events must carry an `environment` field. At trigger fire time, the system must apply the following matching rules:

    | Event environment | Trigger environment | Result |
    | ----------------- | ------------------- | ------ |
    | `"production"`    | `"production"`      | Fire   |
    | `"production"`    | `"staging"`         | Skip   |
    | `"production"`    | `null` (draft)      | Skip   |
    | `null` (no env)   | `null` (draft)      | Fire   |
    | `null` (no env)   | `"production"`      | Skip   |

    Rule: an event fires a trigger only when both environments are equal (including both being `null`). Platform-internal events derive their environment from the originating deployment. Studio-initiated test events have `environment: null`, matching only draft triggers.

18. **FR-18**: The `TriggerScheduler.processJob()` (cron fire path) must load the workflow version's frozen flow via `workflowVersionId` on the trigger registration. It must NOT load the working copy from the Workflow document.

19. **FR-19**: The fire-time deployment-manifest resolution in `TriggerEngine.fireWebhookTrigger()` must be replaced by direct trigger-to-version binding. No deployment lookup at fire time.

20. **FR-20**: The Studio workflow editor must include a "Versions" tab (between Flow and Triggers) showing: version list with state/environment/date, activate/deactivate toggle, version detail view (read-only flow preview), and diff against draft or another version.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                        |
| -------------------------- | ------------ | ------------------------------------------------------------ |
| Project lifecycle          | PRIMARY      | Workflows are project-scoped; versions add deployment gates  |
| Agent lifecycle            | SECONDARY    | Agents can invoke workflows-as-tools; version resolution     |
| Customer experience        | SECONDARY    | End-users indirectly benefit from stable versioned workflows |
| Integrations / channels    | PRIMARY      | Triggers (cron, webhook, app-event) are integration points   |
| Observability / tracing    | SECONDARY    | Executions tagged with version for trace filtering           |
| Governance / controls      | PRIMARY      | Version immutability provides audit trail and rollback       |
| Enterprise / compliance    | SECONDARY    | Deployment gates enforce change control                      |
| Admin / operator workflows | PRIMARY      | Operators manage version activation and deployment           |

### Related Feature Integration Matrix

| Related Feature                                          | Relationship Type | Why It Matters                                                                                                                                                                                                      | Key Touchpoints                                             | Current State                                                             |
| -------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Deployments & Versioning](../deployments-versioning.md) | extends           | Workflow versions deploy through the shared deployment system                                                                                                                                                       | `workflowVersionManifest`, deployment routes, auto mode     | Deployment infra exists; workflow version UI missing                      |
| [Workflow Triggers](workflow-triggers.md)                | extends           | Triggers become version-aware with direct binding                                                                                                                                                                   | `TriggerRegistration`, `TriggerEngine`, `TriggerScheduler`  | Triggers bind to workflow ID, not version                                 |
| [Workflow-as-Tool](../workflow-as-tool.md)               | depends on        | Tool binding validation checks workflow status; must check version state. Workflow-as-Tool FR-8's `status: 'active'` picker filter must change to check for "at least one active published version or draft exists" | `validate-workflow-tool-binding.ts`, Studio workflow picker | Checks `workflow.status !== 'active'` — will break when status is removed |
| [Project Import/Export](../project-import-export.md)     | shares data with  | Export must include version snapshots; import recreates versions as draft                                                                                                                                           | `StagedImporter`, export templates                          | Partial — exports working copy only                                       |
| [Workflows & Human Tasks](../workflows.md)               | extends           | Parent feature — this restructures its core data model                                                                                                                                                              | `Workflow` model, execution routes                          | Working copy model, 4-status lifecycle                                    |

---

## 6. Design Considerations

### Version Model

```
Workflow (container)
  ├── _id, name, description, projectId, tenantId, createdBy
  ├── tags, metadata, deleted, deletedAt
  └── No flow, no triggers, no status

WorkflowVersion
  ├── "draft" (always one, always active, fully mutable)
  ├── "v1.0" (published, active or inactive, flow frozen)
  └── "v2.0" (published, active or inactive, flow frozen)
```

### Mutability Matrix

| Field                       | Draft               | Published (active) | Published (inactive) |
| --------------------------- | ------------------- | ------------------ | -------------------- |
| Flow (nodes, edges)         | Mutable             | Frozen             | Frozen               |
| Webhook trigger definition  | Mutable             | Frozen             | Frozen               |
| Cron schedule               | Mutable             | Mutable            | Mutable              |
| App event config            | Mutable             | Mutable            | Mutable              |
| Details (name, desc, tags)  | Mutable             | Mutable            | Mutable              |
| Per-trigger toggle (on/off) | Works               | Works              | Blocked              |
| State (active/inactive)     | N/A (always active) | Toggle             | Toggle               |

### Trigger Architecture (Option A — One Trigger Per Version)

Each version owns independent trigger registrations. No shared triggers, no routing layer. Activating a version registers its triggers in BullMQ/event-bus; deactivating unregisters them.

### Publish via Deployments

No workflow-level publish button. Publishing happens at Operate > Deployments:

1. User creates a deployment, selects environment
2. Deployment includes `workflowVersionManifest: { "workflow_name": "v1.0" }` (or `"auto"`)
3. System snapshots draft flow into a frozen `WorkflowVersion`
4. Registers the version's triggers with BullMQ/event-bus

### Publish Confirmation Dialog (at Operate > Deployments)

When deploying a workflow version, show: version name, environment, trigger summary, and warning if a previous version is active on the same environment with an option to deactivate it.

---

## 7. Technical Considerations

### Migration Strategy (Gradual, 2-Phase)

**Phase 1 (Additive):**

- Create draft `WorkflowVersion` records from existing `Workflow` documents (copy nodes, edges, envVars, schemas)
- Backfill existing `TriggerRegistration` documents with `workflowVersionId` pointing to draft version
- Workflow document retains current fields as read-only mirror during transition
- Canvas auto-save writes to draft version; post-save hook syncs denormalized copy to Workflow document

**Phase 2 (Cleanup):**

- Remove direct fields (nodes, edges, envVars, status, triggers) from Workflow document
- Remove fire-time deployment resolution from `TriggerEngine.fireWebhookTrigger()`
- Remove denormalized sync hook

### Refactoring Approach

- Refactor `WorkflowVersionService` in-place — replace 5-status lifecycle with `active`/`inactive`, add `getOrCreateDraft()`, keep dedup/numbering/diffing
- Replace `convertCanvasToSteps()` source from Workflow document to draft WorkflowVersion at execution time
- Add `workflowVersionId` and `workflowVersion` fields to `TriggerRegistration` model
- Update `TriggerScheduler.processJob()` to load version by `workflowVersionId` instead of working copy

### Environment-Scoped Event Routing

Platform-internal events derive environment from the originating deployment. Studio-initiated events use `"dev"` or no environment. Draft triggers (no environment) only fire on events without environment context.

---

## 8. How to Consume

### Studio UI

- **Workflow List Page** — No status badges (workflow has no status). Shows workflow name, description, version count, last modified.
- **Workflow Detail Page — Flow tab** — Edits the draft version's flow (nodes/edges). Auto-save writes to draft `WorkflowVersion`.
- **Workflow Detail Page — Versions tab** (NEW) — Lists all versions, shows state/environment, allows activate/deactivate, view frozen flow, diff.
- **Workflow Detail Page — Triggers tab** — Shows triggers for the selected version (default: draft). Per-trigger on/off toggle (existing UI). Add/edit/delete triggers.
- **Workflow Detail Page — Monitor tab** — Execution history filterable by version.
- **Operate > Deployments** — Deploy workflow versions alongside agent versions. Supports `"auto"` mode to snapshot draft.

### API (Runtime)

| Method | Path                                                                          | Purpose                                                       |
| ------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| POST   | `/api/projects/:projectId/workflows`                                          | Create workflow + draft version atomically                    |
| GET    | `/api/projects/:projectId/workflows`                                          | List workflows (no status filter)                             |
| GET    | `/api/projects/:projectId/workflows/:workflowId`                              | Get workflow container + draft version                        |
| PATCH  | `/api/projects/:projectId/workflows/:workflowId`                              | Update workflow details (name, desc, tags)                    |
| DELETE | `/api/projects/:projectId/workflows/:workflowId`                              | Soft delete — cascade to all versions and triggers            |
| GET    | `/api/projects/:projectId/workflows/:workflowId/versions`                     | List all versions                                             |
| GET    | `/api/projects/:projectId/workflows/:workflowId/versions/:version`            | Get version detail                                            |
| PATCH  | `/api/projects/:projectId/workflows/:workflowId/versions/:version`            | Update mutable fields on a version                            |
| POST   | `/api/projects/:projectId/workflows/:workflowId/versions/:version/activate`   | Activate version + register triggers                          |
| POST   | `/api/projects/:projectId/workflows/:workflowId/versions/:version/deactivate` | Deactivate version + deregister triggers                      |
| GET    | `/api/projects/:projectId/workflows/:workflowId/versions/:v/diff/:other`      | Diff two versions                                             |
| POST   | `/api/projects/:projectId/deployments`                                        | Create deployment with `workflowVersionManifest`              |
| POST   | `/api/v1/process/:workflowId`                                                 | Execute workflow (resolves default version if none specified) |
| POST   | `/api/v1/process/:workflowId?version=v1.0`                                    | Execute specific version                                      |

### API (Studio)

| Method | Path                                                             | Purpose                                |
| ------ | ---------------------------------------------------------------- | -------------------------------------- |
| PATCH  | `/api/projects/:id/workflows/:workflowId`                        | Proxy to runtime — update details      |
| DELETE | `/api/projects/:id/workflows/:workflowId`                        | Proxy to runtime — soft delete cascade |
| GET    | `/api/projects/:id/workflows/:workflowId/versions`               | Proxy to runtime — list versions       |
| POST   | `/api/projects/:id/workflows/:workflowId/versions/:v/activate`   | Proxy to runtime — activate version    |
| POST   | `/api/projects/:id/workflows/:workflowId/versions/:v/deactivate` | Proxy to runtime — deactivate version  |

### Admin Portal

No admin-specific changes. Tenant admins manage workflows through Studio.

### Channel / SDK / Voice / A2A / MCP Integration

Workflow invocations from channels/SDK/A2A/MCP resolve to the default version (latest active published, fallback to draft). The version resolution is transparent to callers. No channel-specific changes needed.

---

## 9. Data Model

### Collections / Tables

```text
Collection: workflows (MODIFIED — thin container)
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - name: string (required)
  - description: string
  - tags: string[] (NEW — not on current model)
  - metadata: Record<string, unknown>
  - deleted: boolean (default: false)
  - deletedAt: Date (optional)
  - createdBy: string (required)
  - createdAt: Date
  - updatedAt: Date
  REMOVED: status, nodes, edges, steps, triggers, envVars, inputSchema, outputSchema, deployment
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
  - { tenantId: 1, projectId: 1, deleted: 1 }
```

```text
Collection: workflow_versions (MODIFIED — owns all mutable state)
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - workflowId: string (required, references workflows._id)
  - version: string (required — "draft" or user-provided e.g. "v1.0")
  - state: string (enum: "active", "inactive" — draft is always "active", enforced in code)
  - environment: string (optional — null for draft, required for published)
  - deploymentId: string (optional — references deployments._id, null for draft)
  - definition: object
    - nodes: unknown[]
    - edges: unknown[]
    - envVars: Record<string, string>
    - inputSchema: Record<string, unknown> | null
    - outputSchema: Record<string, unknown> | null
  - triggers: Array<{ id, type, config }> (trigger definitions owned by this version)
  - sourceHash: string (SHA-256 for deduplication)
  - changelog: string | null
  - deleted: boolean (default: false)
  - deletedAt: Date (null — set on soft delete cascade)
  - publishedAt: Date (null for draft)
  - publishedBy: string (null for draft)
  - createdBy: string (required)
  - _v: number (optimistic lock counter for concurrent activate/deactivate)
  - createdAt: Date
  - updatedAt: Date
  REMOVED: status (was 5-value enum), promotedAt, promotedBy
Indexes:
  - { tenantId: 1, projectId: 1, workflowId: 1, version: 1 } (unique)
  - { tenantId: 1, projectId: 1, workflowId: 1, state: 1, deleted: 1, publishedAt: -1 } (resolveDefaultVersion)
  - { tenantId: 1, workflowId: 1, sourceHash: 1 } (deduplication)
```

```text
Collection: trigger_registrations (MODIFIED — version-aware)
Fields (additions only):
  - workflowVersionId: string (NEW — references workflow_versions._id)
  - workflowVersion: string (NEW — "draft", "v1.0" for display/query)
  All existing fields retained (workflowId, triggerType, config, status, environment, etc.)
Indexes (additions):
  - { tenantId: 1, workflowVersionId: 1, status: 1 }
```

```text
Collection: workflow_executions (MODIFIED — version tracing)
Fields (additions only):
  - workflowVersionId: string (NEW — references workflow_versions._id, optional)
  All existing fields retained (workflowId, tenantId, status, etc.)
```

### Key Relationships

- `Workflow` 1:N `WorkflowVersion` (one draft + zero or more published)
- `WorkflowVersion` 1:N `TriggerRegistration` (version owns its triggers)
- `Deployment` references `WorkflowVersion` via `workflowVersionManifest`
- `WorkflowExecution` references `WorkflowVersion` via `workflowVersionId` (audit metadata)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/database/src/models/workflow.model.ts`                      | Workflow model — strip to thin container                          |
| `packages/database/src/models/workflow-version.model.ts`              | WorkflowVersion model — add state, environment, triggers          |
| `packages/database/src/models/trigger-registration.model.ts`          | TriggerRegistration — add workflowVersionId                       |
| `apps/runtime/src/services/workflow-version-service.ts`               | Version lifecycle — refactor to active/inactive                   |
| `apps/runtime/src/services/stores/mongo-workflow-definition-store.ts` | Workflow CRUD store — update for thin container                   |
| `packages/shared/src/tools/validate-workflow-tool-binding.ts`         | Tool binding validation — check version state not workflow status |

### Routes / Handlers

| File                                           | Purpose                                               |
| ---------------------------------------------- | ----------------------------------------------------- |
| `apps/runtime/src/routes/workflows.ts`         | Workflow CRUD — remove status, add version resolution |
| `apps/runtime/src/routes/workflow-versions.ts` | Version CRUD — add activate/deactivate endpoints      |
| `apps/runtime/src/routes/deployments.ts`       | Deployment creation — update auto mode source         |
| `apps/runtime/src/routes/process-api.ts`       | Process API — add default version resolution          |

### UI Components

| File                                                                | Purpose                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/studio/src/components/workflows/WorkflowDetailPage.tsx`       | Add Versions tab, remove status buttons              |
| `apps/studio/src/components/workflows/WorkflowsListPage.tsx`        | Remove status filter, update card display            |
| `apps/studio/src/components/workflows/WorkflowCard.tsx`             | Remove status badge, show version count              |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx` | Version-aware trigger list, existing toggle          |
| `apps/studio/src/components/workflows/tabs/WorkflowVersionsTab.tsx` | NEW — version list, activate/deactivate, diff        |
| `apps/studio/src/api/workflows.ts`                                  | API client — version endpoints, remove status types  |
| `apps/studio/src/store/workflow-canvas-store.ts`                    | Auto-save target — draft version instead of workflow |

### Jobs / Workers / Background Processes

| File                                                     | Purpose                                               |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `apps/runtime/src/services/workflow-purge-job.ts`        | Hard-delete soft-deleted workflows past retention     |
| `apps/workflow-engine/src/services/trigger-engine.ts`    | Replace fire-time resolution with version binding     |
| `apps/workflow-engine/src/services/trigger-scheduler.ts` | Load version flow instead of working copy             |
| `apps/workflow-engine/src/routes/workflow-executions.ts` | Version-aware execution creation                      |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`   | Source from version definition, not workflow document |
| `packages/connectors/src/triggers/cron-scheduler.ts`     | Version-aware cron job processing                     |
| `packages/connectors/src/triggers/webhook-handler.ts`    | Version-aware webhook handling                        |
| `packages/connectors/src/triggers/polling-scheduler.ts`  | Version-aware polling job processing                  |
| `packages/connectors/src/triggers/trigger-engine.ts`     | Connector trigger engine — passes version fields      |
| `packages/connectors/src/triggers/types.ts`              | TriggerRegistration/TriggerJobData version fields     |

### Tests

| File                                                                                 | Type        | Coverage Focus                                             |
| ------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------- |
| `apps/runtime/src/__tests__/workflow-versioning.e2e.test.ts`                         | e2e         | Full lifecycle, soft delete, version resolution, isolation |
| `apps/runtime/src/__tests__/workflow-version-triggers.e2e.test.ts`                   | e2e         | Activate/deactivate, frozen fields, missing version 404    |
| `apps/runtime/src/__tests__/workflow-version-deployment.e2e.test.ts`                 | e2e         | Deployment lifecycle, snapshot, activate, pagination       |
| `apps/runtime/src/__tests__/workflow-version-service.test.ts`                        | unit        | Service methods (rewritten for new model)                  |
| `apps/runtime/src/__tests__/workflow-version-routes.test.ts`                         | unit        | Route handlers (rewritten for new model)                   |
| `apps/runtime/src/__tests__/workflow-version-lifecycle.test.ts`                      | unit        | Version lifecycle state transitions                        |
| `apps/runtime/src/__tests__/workflow-version-resolution.test.ts`                     | unit        | Default version resolution logic                           |
| `packages/shared/src/tools/__tests__/validate-workflow-tool-binding-version.test.ts` | integration | Version-aware tool binding validation (INT-11)             |
| `packages/database/src/__tests__/model-workflow-version.test.ts`                     | unit        | Schema validation, indexes                                 |
| `apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts`                 | integration | Version-aware trigger fire                                 |
| `apps/workflow-engine/src/__tests__/trigger-environment.test.ts`                     | integration | Environment-scoped trigger matching                        |
| `apps/workflow-engine/src/__tests__/trigger-engine.test.ts`                          | unit        | Version/environment threading through jobData and register |
| `packages/connectors/src/__tests__/cron-scheduler.test.ts`                           | unit        | Version-aware cron job data and startWorkflow calls        |
| `packages/connectors/src/__tests__/polling-scheduler.test.ts`                        | unit        | Version-aware polling job data and startWorkflow calls     |
| `packages/connectors/src/__tests__/webhook-handler.test.ts`                          | unit        | Version-aware webhook startWorkflow calls                  |

### Migration Script

| File                                                    | Purpose                                                |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `apps/runtime/src/scripts/migrate-workflow-versions.ts` | Backfill draft versions and trigger registration links |

---

## 11. Configuration

### Environment Variables

| Variable                           | Default | Description                                                                |
| ---------------------------------- | ------- | -------------------------------------------------------------------------- |
| `WORKFLOW_VERSION_MIGRATION_PHASE` | `1`     | Migration phase: `1` = dual-write with backward compat, `2` = version-only |

### Runtime Configuration

- No feature flags needed — this is a structural change. Migration phase is controlled by the environment variable above.
- The deployment system's existing `workflowVersionManifest` field serves as the version selection mechanism.

### DSL / Agent IR / Schema

N/A — workflow versioning does not affect the Agent IR or compiler pipeline. Workflow-as-tool bindings use version resolution at the tool binding validation layer.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Project isolation | Every version query must include `projectId`. Cross-project version access must return 404.                 |
| Tenant isolation  | Every version query must include `tenantId`. The `tenantIsolationPlugin` on `WorkflowVersion` ensures this. |
| User isolation    | Version creation tracks `createdBy`. Deployment creation tracked by `createdBy`. RBAC gates all writes.     |

### Security & Compliance

- Frozen versions provide an immutable audit trail of what was deployed and when.
- Soft delete preserves data for compliance — no permanent data loss.
- Deployment permissions (`deployment:create`) required to publish versions — separation of development and deployment roles.
- Trigger secrets (`webhookSecret`) encrypted at rest via existing `shared-encryption` package.

### Performance & Scalability

- Version documents are append-only (published versions are frozen). No write contention.
- Draft version auto-save remains the same frequency (2-second debounce) — one additional document instead of updating workflow directly.
- Default version resolution (`resolveDefaultVersion`) adds one `findOne` query with `sort({publishedAt: -1})` — covered by compound index `{ tenantId, projectId, workflowId, state, deleted, publishedAt: -1 }` (see Section 9).
- BullMQ trigger registration/deregistration is O(1) per trigger per version activation/deactivation.

### Reliability & Failure Modes

- **Soft delete cascade**: MongoDB transaction ensures atomicity for document updates. BullMQ unschedule is best-effort outside the transaction; the `processJob()` status check acts as safety net.
- **Version activation race**: Use optimistic locking (`_v` field) on `WorkflowVersion` to prevent concurrent activate/deactivate conflicts.
- **In-flight execution safety**: Restate captures the workflow definition durably at execution start. Version deactivation does not affect running executions.
- **Migration rollback**: Phase 1 maintains backward compatibility. If issues arise, the Workflow document's denormalized fields remain usable.

### Observability

- Every `WorkflowExecution` tagged with `workflowVersion` and `workflowVersionId` for trace filtering.
- Trigger fires log `{ registrationId, workflowVersionId, workflowVersion, environment }`.
- Version state changes (activate/deactivate) emit audit events.
- Monitor tab filterable by version.

### Data Lifecycle

- Published versions are append-only; no TTL (they represent deployment history).
- Soft-deleted workflows and versions remain in the database. A future cleanup job may purge records older than a configurable retention period.
- The `sourceHash` dedup mechanism prevents duplicate versions from the same draft state.

---

## 13. Delivery Plan / Work Breakdown

1. **Data model changes**
   1.1 Modify `WorkflowVersion` model: remove 5-status enum, add `state`, `environment`, `deploymentId`, `triggers`, `deleted`, `publishedAt`, `publishedBy`
   1.2 Add `workflowVersionId` and `workflowVersion` fields to `TriggerRegistration` model
   1.3 Write migration script: create draft versions from existing workflows, backfill trigger registrations
   1.4 Add new indexes

2. **Version service refactor**
   2.1 Replace `VALID_STATUS_TRANSITIONS` with `activate()`/`deactivate()` operations
   2.2 Add `getOrCreateDraft()` method
   2.3 Add `resolveDefaultVersion()` method
   2.4 Update `createVersion()` to snapshot from draft `WorkflowVersion` instead of Workflow document
   2.5 Add trigger registration/deregistration on activate/deactivate

3. **Trigger version binding**
   3.1 Update `TriggerEngine.register()` to include `workflowVersionId` on registration
   3.2 Update `TriggerScheduler.processJob()` to load version by `workflowVersionId`
   3.3 Replace fire-time deployment resolution in `TriggerEngine.fireWebhookTrigger()`
   3.4 Update connector trigger engines (cron-scheduler, webhook-handler) for version awareness
   3.5 Implement environment-scoped event routing

4. **Runtime route updates**
   4.1 Update workflow CRUD routes: strip status, create draft atomically
   4.2 Add version activate/deactivate endpoints
   4.3 Update Process API with default version resolution
   4.4 Update deployment routes: `"auto"` mode sources from draft version
   4.5 Update workflow execution route for version-aware execution

5. **Studio UI changes**
   5.1 Create `WorkflowVersionsTab` component
   5.2 Update `WorkflowDetailPage` — add Versions tab, remove status buttons
   5.3 Update `WorkflowsListPage` — remove status filter/badge
   5.4 Update `WorkflowCard` — remove status badge, show version info
   5.5 Update canvas auto-save to write to draft version
   5.6 Update `WorkflowTriggersTab` for version-aware trigger management

6. **Integration updates**
   6.1 Update `validate-workflow-tool-binding.ts` — check version state not workflow status
   6.2 Update export/import for version-first model
   6.3 Update `WorkflowExecution` model with version tracking fields

7. **Migration phase 2 (cleanup)**
   7.1 Remove denormalized fields from Workflow document
   7.2 Remove backward-compatibility sync hook
   7.3 Remove old fire-time deployment resolution code

---

## 14. Success Metrics

| Metric                         | Baseline                | Target                                 | How Measured                                            |
| ------------------------------ | ----------------------- | -------------------------------------- | ------------------------------------------------------- |
| Workflow version adoption      | 0 published versions    | >50% active workflows have >=1 version | MongoDB query on `workflow_versions`                    |
| Ghost trigger executions       | Unknown (no tracking)   | 0 per month                            | Monitor trigger fires against deleted/inactive versions |
| Version rollback time          | N/A (no rollback)       | <30 seconds                            | Time from deactivate current + activate previous        |
| Draft-to-deploy cycle time     | N/A                     | <5 minutes                             | Time from last draft save to deployment completion      |
| Status-related support tickets | Recurring (draft stuck) | 0                                      | Support ticket tracking                                 |

---

## 15. Open Questions

1. **OQ-1**: Should there be a maximum number of published versions per workflow? Storage grows linearly with version count.
2. **OQ-2**: Should the publish confirmation dialog at Operate > Deployments offer to auto-deactivate the previous version on the same environment, or require explicit action?
3. ~~**OQ-3**~~: Closed — answered by FR-11: in-flight executions run to completion; deactivation only affects new trigger fires. The missing `workflowVersionId` on `WorkflowExecution` is tracked in GAP-003.
4. **OQ-4**: Should connector triggers (Nango/Activepieces-based) also become version-aware, or only the core trigger types (cron, webhook, app-event)?
5. **OQ-5**: During migration Phase 1, should the canvas auto-save dual-write to both the draft version and the Workflow document, or only write to the draft version with a sync hook?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                  | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------ | -------- | --------- |
| GAP-001 | Connector trigger engines (`packages/connectors`) have no version awareness                                  | High     | Mitigated |
| GAP-002 | No UI for version comparison (diff endpoint exists but not wired to WorkflowVersionsTab)                     | Medium   | Mitigated |
| GAP-003 | `WorkflowExecution` model lacks `workflowVersionId` field for execution-to-version tracing                   | Medium   | Mitigated |
| GAP-004 | Environment-scoped event routing — jobData now includes environment for cron/polling triggers                | High     | Mitigated |
| GAP-005 | Export/import does not handle the version-first model — only exports working copy                            | Medium   | Mitigated |
| GAP-006 | No purge policy for soft-deleted workflows — storage grows indefinitely                                      | Low      | Mitigated |
| GAP-007 | Version name collision prevention at deployment time relies on unique index — no user-friendly error message | Low      | Mitigated |
| GAP-008 | Workflow-as-Tool binding validation uses version-aware dual check (version-first + legacy fallback)          | High     | Mitigated |
| GAP-009 | Activation is not atomic — partial trigger creation can leave inconsistent state (no transaction wrapping)   | Medium   | Mitigated |
| GAP-010 | WorkflowVersionsTab missing loading/error states (pagination still pending)                                  | Low      | Mitigated |
| GAP-011 | Cron fires version's frozen flow, not working copy (processJob version resolution)                           | Medium   | Mitigated |
| GAP-012 | Per-trigger toggle with VERSION_INACTIVE guard (pause/resume blocked when owning version inactive)           | Medium   | Mitigated |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                       | Coverage Type | Status   | Test File / Note                                        |
| --- | -------------------------------------------------------------- | ------------- | -------- | ------------------------------------------------------- |
| 1   | Create workflow creates draft version atomically               | e2e           | TESTED   | workflow-versioning.e2e.test.ts (E2E-1)                 |
| 2   | Activate/deactivate with trigger registration                  | e2e           | TESTED   | workflow-version-triggers.e2e.test.ts (E2E-2)           |
| 3   | Version create from draft (publish)                            | e2e           | TESTED   | workflow-versioning.e2e.test.ts (E2E-3)                 |
| 4   | Soft delete cascades to all versions and triggers              | e2e           | TESTED   | workflow-versioning.e2e.test.ts (E2E-4)                 |
| 5   | Default version resolution                                     | e2e           | TESTED   | workflow-versioning.e2e.test.ts (E2E-5)                 |
| 6   | Deployment lifecycle (snapshot, activate, frozen)              | e2e           | TESTED   | workflow-version-deployment.e2e.test.ts (E2E-6)         |
| 7   | Published version frozen flow (PATCH returns 400)              | e2e           | TESTED   | workflow-version-triggers.e2e.test.ts (E2E-7 partial)   |
| 8   | Activate/deactivate non-existent version returns 404           | e2e           | TESTED   | workflow-version-triggers.e2e.test.ts (E2E-8 partial)   |
| 9   | Cross-tenant version access returns 404                        | e2e           | TESTED   | workflow-versioning.e2e.test.ts (E2E-9)                 |
| 10  | Unauthenticated access returns 401                             | e2e           | TESTED   | workflow-versioning.e2e.test.ts                         |
| 11  | PATCH draft version fields                                     | e2e           | TESTED   | workflow-versioning.e2e.test.ts                         |
| 12  | Version diff between two versions                              | e2e           | TESTED   | workflow-versioning.e2e.test.ts                         |
| 13  | Deduplication (same hash prevents duplicate)                   | e2e           | TESTED   | workflow-versioning.e2e.test.ts                         |
| 14  | Multiple versions can be active simultaneously                 | e2e           | TESTED   | workflow-version-triggers.e2e.test.ts (E2E-2b)          |
| 15  | Version-aware tool binding validation (version-first + legacy) | integration   | TESTED   | validate-workflow-tool-binding-version.test.ts (INT-11) |
| 16  | Cron fires version's frozen flow, not working copy             | integration   | TESTED   | trigger-version-frozen-flow.test.ts (GAP-011, 3 tests)  |
| 17  | Per-trigger toggle on/off (VERSION_INACTIVE guard)             | integration   | TESTED   | trigger-version-frozen-flow.test.ts (GAP-012, 5 tests)  |
| 18  | In-flight executions survive version deactivation              | integration   | DEFERRED | Needs execution harness (INT-12)                        |
| 19  | Connector cron scheduler threads version fields through BullMQ | unit          | TESTED   | cron-scheduler.test.ts (4 tests)                        |
| 20  | Connector webhook handler threads workflowVersionId            | unit          | TESTED   | webhook-handler.test.ts (2 tests)                       |
| 21  | Connector polling scheduler threads version fields             | unit          | TESTED   | polling-scheduler.test.ts (4 tests)                     |
| 22  | Workflow-engine register() threads version/env into jobData    | unit          | TESTED   | trigger-engine.test.ts (4 tests)                        |
| 23  | Execution store persists workflowVersionId                     | unit          | TESTED   | trigger-engine.test.ts (via register persistence tests) |

### Testing Notes

Implementation includes 3 E2E test files with 16 tests covering E2E-1 through E2E-11 scenarios (including soft-delete E2E-10, E2E-11), 1 integration test file (INT-11) with 8 tests for version-aware tool binding validation, 26 route integration tests (createVersion, activate, deactivate, softDelete, validateMutableFields, listVersions, getVersion, resolveDefaultVersion), 23 service unit tests, and 14 unit tests across 4 files verifying version/environment field threading through connector triggers (cron, webhook, polling) and workflow-engine jobData. Deferred scenarios: E2E-7 full cron frozen flow (needs BullMQ infra), E2E-8 per-trigger toggle (needs trigger CRUD), INT-7 processJob path, INT-12 in-flight execution.

> Full testing details: [../../testing/sub-features/workflow-versioning.md](../../testing/sub-features/workflow-versioning.md)

---

## 18. References

- Design docs: `docs/plans/2026-03-09-workflow-versioning-deployment-design.md` (prior versioning design — superseded by this spec)
- Design docs: `docs/specs/workflows-yaml-authoring-versioning.hld.md` (YAML authoring + versioning HLD — partially overlapping)
- Parent feature: `docs/features/workflows.md`
- Related sub-feature: `docs/features/sub-features/workflow-triggers.md`
- Related feature: `docs/features/deployments-versioning.md`
- Testing guide: `docs/testing/sub-features/workflow-versioning.md`
