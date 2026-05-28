# Workflow Version Actions — Soft Delete & State Management

**Date:** 2026-04-16
**Status:** Approved

## Summary

Add soft-delete and activate/deactivate actions to the workflow version list page. The workflow is a container that holds versions. Versions have a `state` (`active` | `inactive`). Draft is a special version that is always active and immutable by the user. Deployed versions are protected from deletion and state changes.

## Business Rules

| Action     | Draft version                             | Non-deployed version         | Deployed version                               |
| ---------- | ----------------------------------------- | ---------------------------- | ---------------------------------------------- |
| Activate   | Always active, toggle disabled            | Enabled                      | Disabled (tooltip)                             |
| Deactivate | Disabled                                  | Enabled                      | Disabled (tooltip)                             |
| Delete     | Disabled (tooltip: "Cannot delete draft") | Enabled, confirmation dialog | Disabled (tooltip: "Deployed — cannot delete") |

- "Deployed" means `deploymentId !== null` on the version record.
- `archived` is a soft-delete mechanism (not a status) for both workflows and versions.

## UI Design

**Layout:** Inline icons in the Actions column — diff, toggle, and trash all in a row (no overflow menu).

**Disabled state:** Buttons are visible but disabled with reduced opacity and a tooltip explaining the constraint.

**Confirmation dialog** for delete:

- Title: "Delete version {version}?"
- Body: "This will permanently remove this version. This action cannot be undone."
- If version is currently active: additional warning — "This version is currently active and will be deactivated first."
- Buttons: Cancel (secondary) + Delete (destructive red)

## API Design

### Runtime — New endpoint

```
DELETE /api/projects/:projectId/workflows/:workflowId/versions/:version
```

- **Permission:** `workflow:delete`
- **Guards** (409 Conflict):
  1. `version === 'draft'` → `{ code: "DRAFT_CANNOT_DELETE", message: "Cannot delete the draft version" }`
  2. `deploymentId !== null` → `{ code: "VERSION_DEPLOYED", message: "Cannot delete a deployed version" }`
- **Flow:**
  1. Load version with `{ deleted: false }` → 404 if not found
  2. If `state === 'active'` → deactivate first (set `state: 'inactive'`, deactivate trigger registrations)
  3. Set `deleted: true`, `deletedAt: new Date()`, `$inc: { _v: 1 }`
  4. Emit audit event
- **Response:** `{ success: true, message: "Version {version} deleted" }`
- **Concurrency:** Optimistic locking via `_v` field (consistent with activate/deactivate)

### Studio proxy — Add DELETE handler

Add to existing file: `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/route.ts`

Thin proxy forwarding to runtime, same pattern as existing GET/PATCH handlers.

### Studio API client — New function

```ts
// apps/studio/src/api/workflows.ts
export async function deleteVersion(
  projectId: string,
  workflowId: string,
  version: string,
): Promise<void>;
```

## Service Layer

### New method: `WorkflowVersionService.softDeleteVersion`

```ts
async softDeleteVersion(params: {
  workflowId: string;
  version: string;
  tenantId: string;
  projectId: string;
  userId: string;
}): Promise<void>
```

Steps (within a transaction):

1. Load version with `{ deleted: false }` filter → 404 if not found
2. Guard: `version === 'draft'` → 409 `DRAFT_CANNOT_DELETE`
3. Guard: `deploymentId !== null` → 409 `VERSION_DEPLOYED`
4. If `state === 'active'` → deactivate (set `state: 'inactive'`, deactivate trigger registrations via `TriggerRegistration.updateMany`)
5. Update: `{ deleted: true, deletedAt: new Date(), $inc: { _v: 1 } }`
6. Emit audit event via `auditWorkflowVersionDeleted`

No changes to existing methods — `listVersions`, `getVersion`, `activate`, `deactivate` all already filter `deleted: false`.

### Audit helper — New function

```ts
// apps/runtime/src/services/audit-helpers.ts
export async function auditWorkflowVersionDeleted(
  version: { workflowId: string; version: string; tenantId: string; projectId: string },
  userId: string,
): Promise<void>;
```

Action: `workflow.version_deleted`

## Data Model — Fix `listVersions` response

The current `listVersions` service method maps to an older shape missing key fields. Add to the response mapping:

- `state` (currently missing — uses deprecated `status`)
- `deploymentId` (needed for UI disable logic)
- `environment`
- `publishedAt`
- `publishedBy`

Update `WorkflowVersionSummary` type in `apps/studio/src/api/workflows.ts` to include `deploymentId?: string | null`.

## Files Changed

| Layer   | File                                                                                       | Change                                                                                             |
| ------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Service | `apps/runtime/src/services/workflow-version-service.ts`                                    | Add `softDeleteVersion` method                                                                     |
| Service | `apps/runtime/src/services/audit-helpers.ts`                                               | Add `auditWorkflowVersionDeleted`                                                                  |
| Service | `apps/runtime/src/services/workflow-version-service.ts`                                    | Fix `listVersions` to include `state`, `deploymentId`, `environment`, `publishedAt`, `publishedBy` |
| Route   | `apps/runtime/src/routes/workflow-versions.ts`                                             | Add `DELETE /:version` endpoint                                                                    |
| Proxy   | `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/route.ts` | Add DELETE handler                                                                                 |
| Client  | `apps/studio/src/api/workflows.ts`                                                         | Add `deleteVersion` function, update `WorkflowVersionSummary` type                                 |
| UI      | `apps/studio/src/components/workflows/tabs/WorkflowVersionsTab.tsx`                        | Add trash icon, confirmation dialog, delete handler, disable logic                                 |

## Out of Scope

- Hard-delete purge job for soft-deleted versions (existing `workflow-purge-job.ts` handles whole workflows; version purge can be added later)
- Bulk delete
- Undo/restore deleted versions
