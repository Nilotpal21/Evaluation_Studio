# Workflow Versioning & Deployment Alignment Design

Status: Approved
Date: 2026-03-09
Audience: Runtime, Studio, Workflow Engine, Platform
Depends on: [Workflows Production Spec](./2026-03-08-workflows-studio-runtime-production-spec.md)

## Problem

Agents and project settings follow a working-copy + versioned-snapshot pattern with deployment pinning. Workflows are the odd one out: single mutable document, no versions, not referenced by deployments, and export/import captures only the current state. This makes workflows unreliable in production — there's no way to pin a tested workflow definition to a deployment, roll back to a known-good version, or reproduce a deployment across environments.

## Decisions

1. **Deployment-manifest only** — workflow versions are pinned exclusively through the deployment manifest (`workflowVersionManifest`). No independent activation outside deployments.
2. **Triggers bind to environment** — trigger registrations specify an environment. At fire time, they resolve the active deployment for that environment and use its pinned workflow version.
3. **In-flight executions run to completion** — Restate captures the definition at execution start. New deployments affect only new executions.
4. **Export includes pinned version content** — when `include_deployments=true`, version definition snapshots are included. Import recreates versions as `draft`. Deployments remain informational reference only (no automatic deployment recreation).

## 1. WorkflowVersion Model

Mirrors `AgentVersion` from `packages/database/src/models/agent-version.model.ts`.

| Field        | Type            | Notes                                                                                        |
| ------------ | --------------- | -------------------------------------------------------------------------------------------- |
| `_id`        | string (UUIDv7) | Primary key                                                                                  |
| `workflowId` | string          | References the working copy Workflow document                                                |
| `version`    | string          | Semver three-part, auto-incremented (e.g., "0.1.0", "0.1.1")                                 |
| `tenantId`   | string          | Tenant isolation                                                                             |
| `projectId`  | string          | Project isolation                                                                            |
| `definition` | object          | Frozen snapshot: steps, triggers, escalationRules, notificationRules, slaMinutes, entryAgent |
| `sourceHash` | string          | SHA-256 of canonical JSON for deduplication                                                  |
| `status`     | enum            | `draft`, `testing`, `staged`, `active`, `deprecated`                                         |
| `changelog`  | string?         | Optional user-provided notes                                                                 |
| `createdBy`  | string          | Audit: who created the version                                                               |
| `promotedAt` | Date?           | When last promoted                                                                           |
| `promotedBy` | string?         | Who promoted                                                                                 |
| `createdAt`  | Date            | Timestamp                                                                                    |
| `updatedAt`  | Date            | Timestamp                                                                                    |

**Indexes:**

- `{ workflowId: 1, version: 1, tenantId: 1 }` — unique
- `{ tenantId: 1, projectId: 1, workflowId: 1, status: 1 }` — lifecycle queries
- `{ tenantId: 1, sourceHash: 1 }` — deduplication lookups

**Lifecycle transitions** (identical to AgentVersion):

```
draft → testing → staged → active → deprecated (final)
  ↖________↙        ↖________↙
     (can revert)      (can revert)
```

**Allowed transitions** (implemented in `VALID_STATUS_TRANSITIONS`):

- `draft → testing` (standard promotion)
- `draft → staged` (skip testing — for pre-validated definitions)
- `testing → staged` (standard promotion)
- `testing → draft` (revert)
- `staged → active` (standard promotion)
- `staged → draft` (revert)
- `active → deprecated` (terminal)

## 2. Deployment Model Changes

Add one field to the existing `Deployment` schema in `packages/database/src/models/deployment.model.ts`:

```typescript
workflowVersionManifest: Record<string, string>; // workflow name → version string
```

Default: `{}` (empty — existing deployments unaffected).

Example deployment document:

```json
{
  "agentVersionManifest": { "booking_agent": "1.2.0", "supervisor": "2.3.5" },
  "workflowVersionManifest": { "order_processing": "1.0.0", "escalation_flow": "0.3.0" },
  "environment": "production",
  "status": "active"
}
```

**Create deployment behavior:**

- Validates all referenced workflow versions exist and belong to the same `(tenantId, projectId)`.
- Supports `"auto"` value — creates a version from the current working copy, same as agent auto-versioning.
- Workflow version manifest is optional. Omitting it means the deployment doesn't pin any workflow versions.

**Execution resolution order** (when a workflow is invoked):

1. If execution context has a `deploymentId` → check that deployment's `workflowVersionManifest`
2. If workflow is pinned → load `WorkflowVersion.definition`
3. If not pinned → load working copy from `Workflow` document
4. Restate captures the resolved definition durably at execution start

## 3. Trigger Environment Binding

Add one field to trigger registration:

```typescript
environment: string; // "dev" | "staging" | "production" etc.
```

**Fire-time resolution:**

1. Trigger fires
2. Look up active deployment for `(projectId, environment)`
3. Check deployment's `workflowVersionManifest` for this workflow name
4. If pinned → load that WorkflowVersion definition
5. If not pinned → load working copy
6. Start Restate execution with resolved definition

**Lifecycle behavior:**

- Deployment retirement does NOT auto-deactivate triggers — the trigger resolves the next active deployment on its next fire.
- If no active deployment exists for the environment, trigger falls back to working copy.
- Pause/resume semantics unchanged.

## 4. API Endpoints

New routes under existing workflow path (mirrors `apps/runtime/src/routes/versions.ts`):

### Version CRUD

- `POST /api/projects/:projectId/workflows/:workflowId/versions` — snapshot working copy into new version
- `GET /api/projects/:projectId/workflows/:workflowId/versions` — list versions (paginated, default 50, max 200)
- `GET /api/projects/:projectId/workflows/:workflowId/versions/:version` — get version detail with full definition
- `POST /api/projects/:projectId/workflows/:workflowId/versions/:version/promote` — promote through lifecycle
- `GET /api/projects/:projectId/workflows/:workflowId/versions/:version/diff/:otherVersion` — return definitions for client-side diff

### Permissions

Reuse existing permissions:

- `workflow:update` — create versions and promote
- `workflow:read` — list and view versions

### Deployment route changes

Existing `POST /api/projects/:projectId/deployments` gains `workflowVersionManifest` as an optional field in the request body. Same validation pattern as `agentVersionManifest`.

### Trigger registration changes

Existing `POST /api/projects/:projectId/workflows/triggers` gains optional `environment` field. If omitted, defaults to resolving the working copy (backward compatible).

## 5. Execution Version Tracking

Add two fields to `WorkflowExecution` in `packages/database/src/models/workflow-execution.model.ts`:

```typescript
workflowVersion: string | null; // "1.0.0" or null if working copy was used
deploymentId: string | null; // which deployment resolved the version
```

These are metadata-only fields for audit and debugging. Restate's durable state remains the authoritative execution definition.

## 6. Export/Import Changes

### Export

| `include_deployments` | Workflow export content                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `false` (default)     | Working copy only: `workflows/{name}.workflow.json` (unchanged)                             |
| `true`                | Working copy + pinned version snapshots: `workflows/versions/{name}/{version}.version.json` |

Version file structure:

```json
{
  "version": "1.0.0",
  "source_hash": "abc123def456",
  "status": "active",
  "changelog": "Initial production release",
  "created_at": "2026-03-09T12:00:00.000Z",
  "created_by": "user_abc",
  "definition": {
    "steps": [...],
    "triggers": [...],
    "notificationRules": [...],
    "slaMinutes": 30
  }
}
```

### Lockfile

Add `workflows` section to `abl.lock` (mirrors existing `agents` section):

```json
{
  "agents": {
    "booking_agent": { "version": "1.2.0", "source_hash": "abc123", "status": "active" }
  },
  "workflows": {
    "order_processing": { "version": "1.0.0", "source_hash": "def456", "status": "active" }
  }
}
```

### Import

| Export content                         | Import behavior                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Working copy (`*.workflow.json`)       | Upsert into `Workflow` collection (unchanged)                                               |
| Version files (`*.version.json`)       | Create `WorkflowVersion` records with original version numbers, **status reset to `draft`** |
| Deployment files (`*.deployment.json`) | Stored as reference only, not applied (unchanged)                                           |

Version status resets to `draft` on import. The operator promotes through the lifecycle in the target environment. This avoids activating untested definitions.

Activation order in `StagedImporter` unchanged — workflow versions are imported alongside their parent workflow in the `workflows` layer.

## 7. File Structure (Export V2)

```
project-slug/
├── project.json
├── abl.lock
├── agents/
├── tools/
├── workflows/
│   ├── order_processing.workflow.json          # working copy
│   ├── escalation_flow.workflow.json           # working copy
│   └── versions/                               # only with include_deployments
│       ├── order_processing/
│       │   ├── 1.0.0.version.json
│       │   └── 1.1.0.version.json
│       └── escalation_flow/
│           └── 0.3.0.version.json
├── deployments/                                # reference only
│   ├── dev.deployment.json
│   └── production.deployment.json
└── ...
```

## 8. Backward Compatibility

- Existing workflows continue to work as-is (no versions, mutable working copy).
- Existing deployments without `workflowVersionManifest` default to `{}` — workflows resolve to working copy.
- Existing triggers without `environment` field resolve to working copy.
- Existing executions without `workflowVersion` / `deploymentId` are unaffected.
- No migration required for existing data. New fields are additive and optional.

## 9. What This Design Does NOT Include

- Draft/publish lifecycle for the working copy itself (separate concern in the workflows production spec Phase 6)
- Automatic deployment recreation on import
- Independent workflow activation outside deployments
- Version-level permissions (e.g., "can only promote to staged")
- Workflow version compilation/caching (unlike agents, workflows don't compile to IR)
