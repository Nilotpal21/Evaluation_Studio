# Workflow Version Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add soft-delete and activate/deactivate actions to the workflow version list page with guards for draft and deployed versions.

**Architecture:** Backend-first approach — add the service method, then the runtime route, then the Studio proxy, API client, and finally the UI. Each layer is independently testable.

**Tech Stack:** Express (runtime), Next.js App Router (Studio proxy), React + SWR + lucide-react (UI), Mongoose + MongoDB transactions (persistence)

**Spec:** `docs/superpowers/specs/2026-04-16-workflow-version-actions-design.md`

---

### Task 1: Add `auditWorkflowVersionDeleted` helper

**Files:**

- Modify: `apps/runtime/src/services/audit-helpers.ts` (after line ~530)

- [ ] **Step 1: Add the audit helper function**

Add after the existing `auditWorkflowVersionDeactivated` function (around line 530):

```ts
export async function auditWorkflowVersionDeleted(
  params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    workflowVersion: string;
    versionId: string;
  },
  actor: string,
): Promise<void> {
  await writeAuditLog({
    eventType: 'workflow.version_deleted',
    actor,
    actorType: 'user',
    resourceType: 'workflow_version',
    resourceId: params.versionId,
    environment: 'dev',
    action: 'workflow.version_deleted',
    metadata: {
      tenantId: params.tenantId,
      projectId: params.projectId,
      workflowId: params.workflowId,
      workflowVersion: params.workflowVersion,
    },
  });
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/services/audit-helpers.ts
git add apps/runtime/src/services/audit-helpers.ts
git commit -m "[ABLP-XXX] feat(runtime): add auditWorkflowVersionDeleted helper"
```

---

### Task 2: Add `softDeleteVersion` to `WorkflowVersionService`

**Files:**

- Modify: `apps/runtime/src/services/workflow-version-service.ts`

- [ ] **Step 1: Add `SoftDeleteVersionParams` interface**

Add after the `DeactivateVersionParams` interface (around line 64):

```ts
export interface SoftDeleteVersionParams {
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string;
  userId: string;
}
```

- [ ] **Step 2: Add `softDeleteVersion` method**

Add before the `softDeleteCascade` method (around line 720), inside the `WorkflowVersionService` class:

```ts
  // ---------------------------------------------------------------------------
  // SOFT DELETE SINGLE VERSION
  // ---------------------------------------------------------------------------

  /**
   * Soft-delete a single workflow version.
   *
   * Guards:
   *  - Draft versions cannot be deleted.
   *  - Deployed versions (deploymentId !== null) cannot be deleted.
   *
   * If the version is active, it is deactivated first (state set to inactive,
   * trigger registrations deactivated), then soft-deleted.
   */
  async softDeleteVersion(params: SoftDeleteVersionParams): Promise<void> {
    const { tenantId, projectId, workflowId, version, userId } = params;

    if (version === 'draft') {
      throw new AppError('Cannot delete the draft version', {
        code: 'DRAFT_CANNOT_DELETE',
        statusCode: 409,
      });
    }

    const { WorkflowVersion, TriggerRegistration } =
      await import('@agent-platform/database/models');

    const versionDoc = await WorkflowVersion.findOne({
      workflowId,
      version,
      tenantId,
      projectId,
      deleted: false,
    }).lean();

    if (!versionDoc) {
      throw new AppError('Version not found', { ...ErrorCodes.NOT_FOUND });
    }

    const doc = versionDoc as IWorkflowVersion;

    if (doc.deploymentId !== null && doc.deploymentId !== undefined) {
      throw new AppError('Cannot delete a deployed version', {
        code: 'VERSION_DEPLOYED',
        statusCode: 409,
      });
    }

    // If active, deactivate first: set state to inactive and deactivate triggers
    if (doc.state === 'active') {
      await WorkflowVersion.findOneAndUpdate(
        { _id: doc._id, _v: doc._v, tenantId },
        { $set: { state: 'inactive' }, $inc: { _v: 1 } },
        { new: true },
      );

      await TriggerRegistration.updateMany(
        { workflowVersionId: doc._id, tenantId },
        { $set: { status: 'inactive' } },
      );

      log.info('Workflow version deactivated before deletion', {
        workflowId,
        version,
      });
    }

    // Soft-delete the version — re-read _v since deactivation may have incremented it
    const currentDoc = doc.state === 'active'
      ? await WorkflowVersion.findOne({ _id: doc._id, tenantId, deleted: false }).lean()
      : doc;

    if (!currentDoc) {
      throw new AppError('Version not found after deactivation', { ...ErrorCodes.NOT_FOUND });
    }

    const updated = await WorkflowVersion.findOneAndUpdate(
      { _id: doc._id, _v: (currentDoc as IWorkflowVersion)._v, tenantId },
      {
        $set: { deleted: true, deletedAt: new Date() },
        $inc: { _v: 1 },
      },
      { new: true },
    );

    if (!updated) {
      throw new AppError('Concurrent modification: version changed since read', {
        ...ErrorCodes.CONFLICT,
      });
    }

    log.info('Workflow version soft-deleted', {
      workflowId,
      version,
      userId,
    });
  }
```

- [ ] **Step 3: Verify build**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/workflow-version-service.ts
git add apps/runtime/src/services/workflow-version-service.ts
git commit -m "[ABLP-XXX] feat(runtime): add softDeleteVersion to WorkflowVersionService"
```

---

### Task 3: Fix `listVersions` response to include missing fields

**Files:**

- Modify: `apps/runtime/src/services/workflow-version-service.ts` (lines 443-458)

- [ ] **Step 1: Update the version mapping in `listVersions`**

Replace the `versions` mapping in the `listVersions` method (lines 443-458) with:

```ts
const versions = docs.map((doc: any) => ({
  versionId: doc._id,
  id: doc._id,
  workflowId: doc.workflowId,
  tenantId: doc.tenantId,
  projectId: doc.projectId,
  version: doc.version,
  state: doc.state,
  status: doc.status,
  deploymentId: doc.deploymentId ?? null,
  environment: doc.environment ?? null,
  sourceHash: doc.sourceHash,
  changelog: doc.changelog,
  definition: doc.definition,
  createdBy: doc.createdBy,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  publishedAt: doc.publishedAt,
  publishedBy: doc.publishedBy,
  promotedAt: doc.promotedAt,
  promotedBy: doc.promotedBy,
}));
```

- [ ] **Step 2: Verify build**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/services/workflow-version-service.ts
git add apps/runtime/src/services/workflow-version-service.ts
git commit -m "[ABLP-XXX] fix(runtime): include state, deploymentId, environment in listVersions response"
```

---

### Task 4: Add `DELETE /:version` endpoint to runtime route

**Files:**

- Modify: `apps/runtime/src/routes/workflow-versions.ts`

- [ ] **Step 1: Add import for `auditWorkflowVersionDeleted`**

At the top of the file, add `auditWorkflowVersionDeleted` to the existing import from `../services/audit-helpers.js` (around line 30):

```ts
import {
  auditWorkflowVersionActivated,
  auditWorkflowVersionDeactivated,
  auditWorkflowVersionDeleted,
} from '../services/audit-helpers.js';
```

- [ ] **Step 2: Add the delete response schema**

Add near the other response schemas (around line 150):

```ts
const deleteVersionResponse = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  message: z.string().describe('Confirmation message'),
});
```

- [ ] **Step 3: Add the DELETE route**

Add after the deactivate route (around line 510), before the PATCH route:

```ts
/**
 * DELETE /api/projects/:projectId/workflows/:workflowId/versions/:version
 * Soft-delete a workflow version.
 */
openapi.route(
  'delete',
  '/:version',
  {
    summary: 'Delete workflow version',
    description:
      'Soft-delete a workflow version. Draft versions and deployed versions cannot be deleted. Active versions are deactivated first.',
    params: versionPathParams,
    response: deleteVersionResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:delete'))) return;

      const { projectId, workflowId, version } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId!;
      const svc = getWorkflowVersionService();

      await svc.softDeleteVersion({
        tenantId,
        projectId,
        workflowId,
        version,
        userId,
      });

      // Fire-and-forget audit
      auditWorkflowVersionDeleted(
        {
          tenantId,
          projectId,
          workflowId,
          workflowVersion: version,
          versionId: '', // version doc already deleted, ID not critical for audit
        },
        userId,
      ).catch((err) =>
        log.warn('audit workflow version deleted failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.json({ success: true, message: `Version ${version} deleted` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error ? ((err as { code?: string }).code ?? '') : '';

      if (code === 'DRAFT_CANNOT_DELETE') {
        res.status(409).json({
          success: false,
          error: { code: 'DRAFT_CANNOT_DELETE', message },
        });
      } else if (code === 'VERSION_DEPLOYED') {
        res.status(409).json({
          success: false,
          error: { code: 'VERSION_DEPLOYED', message },
        });
      } else if (code === 'NOT_FOUND' || message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message },
        });
      } else if (code === 'CONFLICT' || message.includes('Concurrent modification')) {
        res.status(409).json({
          success: false,
          error: { code: 'CONCURRENT_MODIFICATION', message },
        });
      } else {
        log.error('Failed to delete workflow version', { error: message });
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to delete workflow version' },
        });
      }
    }
  },
);
```

- [ ] **Step 4: Verify build**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/routes/workflow-versions.ts
git add apps/runtime/src/routes/workflow-versions.ts
git commit -m "[ABLP-XXX] feat(runtime): add DELETE endpoint for workflow version soft-delete"
```

---

### Task 5: Add Studio proxy DELETE handler

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/route.ts`

- [ ] **Step 1: Add DELETE handler**

Add after the existing PATCH handler:

```ts
export const DELETE = withRouteHandler(
  { requireProject: true, permissions: 'workflow:delete' as any },
  async ({ request, tenantId, params }) => {
    return proxyToRuntime(
      request,
      `/api/projects/${params.id}/workflows/${params.workflowId}/versions/${params.version}`,
      { tenantId, method: 'DELETE' },
    );
  },
);
```

- [ ] **Step 2: Verify build**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
npx prettier --write "apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/route.ts"
git add "apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/versions/[version]/route.ts"
git commit -m "[ABLP-XXX] feat(studio): add DELETE proxy for workflow version soft-delete"
```

---

### Task 6: Add `deleteVersion` to Studio API client and update types

**Files:**

- Modify: `apps/studio/src/api/workflows.ts`

- [ ] **Step 1: Add `deploymentId` to `WorkflowVersionSummary`**

Update the `WorkflowVersionSummary` interface (around line 619) to add the `deploymentId` field:

```ts
export interface WorkflowVersionSummary {
  id: string;
  workflowId: string;
  version: string;
  state: WorkflowVersionState;
  deploymentId?: string | null;
  environment?: string;
  sourceHash?: string;
  publishedAt?: string;
  publishedBy?: string;
  createdAt: string;
  updatedAt?: string;
}
```

- [ ] **Step 2: Add `deleteVersion` function**

Add after the `deactivateVersion` function (around line 716):

```ts
export async function deleteVersion(
  projectId: string,
  workflowId: string,
  version: string,
): Promise<{ success: boolean; message: string }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(version)}`,
    { method: 'DELETE' },
  );
  return handleResponse<{ success: boolean; message: string }>(response);
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/api/workflows.ts
git add apps/studio/src/api/workflows.ts
git commit -m "[ABLP-XXX] feat(studio): add deleteVersion API client and deploymentId to WorkflowVersionSummary"
```

---

### Task 7: Add delete action to `WorkflowVersionsTab` UI

**Files:**

- Modify: `apps/studio/src/components/workflows/tabs/WorkflowVersionsTab.tsx`

- [ ] **Step 1: Update imports**

Replace the lucide-react import line (line 13) with:

```ts
import {
  ToggleLeft,
  ToggleRight,
  Loader2,
  GitBranch,
  Filter,
  GitCompare,
  Trash2,
} from 'lucide-react';
```

Update the API import (line 17) to include `deleteVersion`:

```ts
import {
  activateVersion,
  deactivateVersion,
  deleteVersion,
  diffVersions,
} from '../../../api/workflows';
```

- [ ] **Step 2: Add delete state variables**

Add after the existing diff state declarations (after line 83):

```ts
// Delete state
const [deletingVersion, setDeletingVersion] = useState<string | null>(null);
const [confirmDelete, setConfirmDelete] = useState<WorkflowVersionSummary | null>(null);
```

- [ ] **Step 3: Add delete handler**

Add after the `handleDiffClick` callback (after line 188):

```ts
// Delete handler
const handleDelete = useCallback(
  async (version: WorkflowVersionSummary) => {
    if (!projectId || deletingVersion) return;

    setDeletingVersion(version.version);
    setConfirmDelete(null);
    try {
      await deleteVersion(projectId, workflow.id, version.version);
      toast.success(`Version ${version.version} deleted`);
      await refreshVersions();
    } catch (err) {
      toast.error(sanitizeError(err, `Failed to delete version ${version.version}`));
    } finally {
      setDeletingVersion(null);
    }
  },
  [projectId, workflow.id, deletingVersion, refreshVersions],
);
```

- [ ] **Step 4: Add disable logic and trash button to each row**

In the row rendering (inside the `filtered.map` callback), add these computed values after `isToggleDisabled` (after line 266):

```ts
const isDeployed = version.deploymentId !== null && version.deploymentId !== undefined;
const isDeleteDisabled = isDraft || isDeployed || deletingVersion !== null;
const isToggleDisabled = isDraft || isDeployed || mutatingVersion !== null;
const deleteTooltip = isDraft
  ? 'Cannot delete draft'
  : isDeployed
    ? 'Deployed \u2014 cannot delete'
    : 'Delete version';
const toggleTooltip = isDraft
  ? 'Draft is always active'
  : isDeployed
    ? 'Deployed \u2014 cannot change state'
    : isActive
      ? `Deactivate version ${version.version}`
      : `Activate version ${version.version}`;
```

Note: Also remove the existing `isToggleDisabled` line (line 266) since it's replaced above.

- [ ] **Step 5: Add trash icon button in the actions cell**

After the existing toggle button (after line 354), inside the `inline-flex items-center gap-1` div, add:

```tsx
<button
  className={clsx(
    'p-1 transition-fast inline-flex items-center rounded hover:bg-background-muted',
    isDeleteDisabled && 'opacity-50 pointer-events-none',
  )}
  aria-label={deleteTooltip}
  title={deleteTooltip}
  onClick={() => setConfirmDelete(version)}
  disabled={isDeleteDisabled}
>
  {deletingVersion === version.version ? (
    <Loader2 className="w-5 h-5 text-muted animate-spin" />
  ) : (
    <Trash2 className="w-5 h-5 text-destructive" />
  )}
</button>
```

- [ ] **Step 6: Update toggle button to use new tooltip**

Replace the toggle button's `aria-label` (lines 339-343) with:

```tsx
                        aria-label={toggleTooltip}
                        title={toggleTooltip}
```

- [ ] **Step 7: Add confirmation dialog**

Add after the existing diff dialog (after line 390), before the closing `</div>`:

```tsx
{
  /* Delete confirmation dialog */
}
<Dialog
  open={confirmDelete !== null}
  onClose={() => setConfirmDelete(null)}
  title={`Delete version ${confirmDelete?.version}?`}
  maxWidth="sm"
>
  <div className="space-y-4">
    <p className="text-sm text-muted">
      This will permanently remove this version. This action cannot be undone.
    </p>
    {confirmDelete?.state === 'active' && (
      <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm text-warning">
        This version is currently active and will be deactivated first.
      </div>
    )}
    <div className="flex justify-end gap-2">
      <button
        className="px-4 py-2 text-sm rounded-md border border-default hover:bg-background-muted transition-fast"
        onClick={() => setConfirmDelete(null)}
      >
        Cancel
      </button>
      <button
        className="px-4 py-2 text-sm rounded-md bg-destructive text-white hover:bg-destructive/90 transition-fast"
        onClick={() => confirmDelete && handleDelete(confirmDelete)}
        disabled={deletingVersion !== null}
      >
        {deletingVersion ? 'Deleting\u2026' : 'Delete'}
      </button>
    </div>
  </div>
</Dialog>;
```

- [ ] **Step 8: Verify build**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds with no errors.

- [ ] **Step 9: Commit**

```bash
npx prettier --write apps/studio/src/components/workflows/tabs/WorkflowVersionsTab.tsx
git add apps/studio/src/components/workflows/tabs/WorkflowVersionsTab.tsx
git commit -m "[ABLP-XXX] feat(studio): add delete action to workflow version list with confirmation dialog"
```

---

### Task 8: Manual smoke test

- [ ] **Step 1: Restart dev servers**

Kill existing processes and restart:

```bash
pkill -f "turbo dev:workflows" 2>/dev/null; pkill -f "tsx.*src/index.ts" 2>/dev/null; pkill -f "tsx watch" 2>/dev/null; pkill -f "next dev" 2>/dev/null
sleep 3
pnpm dev:workflows
```

- [ ] **Step 2: Test DELETE endpoint directly**

Create a test workflow and publish a version, then test the delete:

```bash
# List versions for a workflow
curl -s 'http://localhost:3112/api/projects/<PROJECT_ID>/workflows/<WORKFLOW_ID>/versions' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'X-Tenant-Id: tenant-dev-001' | python3 -m json.tool

# Try deleting draft (should return 409)
curl -s -X DELETE 'http://localhost:3112/api/projects/<PROJECT_ID>/workflows/<WORKFLOW_ID>/versions/draft' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'X-Tenant-Id: tenant-dev-001'

# Delete a non-deployed published version (should return 200)
curl -s -X DELETE 'http://localhost:3112/api/projects/<PROJECT_ID>/workflows/<WORKFLOW_ID>/versions/v1' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'X-Tenant-Id: tenant-dev-001'
```

- [ ] **Step 3: Test in browser**

1. Open `http://localhost:5173` and navigate to a workflow's Versions tab
2. Verify draft row shows disabled trash icon with tooltip "Cannot delete draft"
3. Verify non-deployed version shows enabled red trash icon
4. Click trash on a version — confirm dialog appears
5. Click Delete — version disappears from list, toast shows success
6. Verify the version no longer appears in the list (SWR refresh)
