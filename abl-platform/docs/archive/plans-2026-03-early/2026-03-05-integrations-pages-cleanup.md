# Integrations Pages Cleanup — Separation from Workflow Engine

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the separation of connections/integrations pages from the workflow engine by moving components to their own directory, fixing stale copy, fixing code standard violations, and improving the ConnectionDetailPage.

**Architecture:** Connections are a standalone resource in the Studio sidebar (under "Resources"), but the components still live nested under `components/workflows/connections/`. We move them to `components/connections/`, update all imports, fix copy that still says "use them in workflows", and flesh out the ConnectionDetailPage to match the functionality already available in ConnectionCard.

**Tech Stack:** React, Next.js 15, TypeScript, Lucide icons, SWR, clsx

---

### Task 1: Move connection components out of workflows directory

**Files:**

- Move: `apps/studio/src/components/workflows/connections/` → `apps/studio/src/components/connections/`
- Modify: `apps/studio/src/components/navigation/AppShell.tsx:63-65`

**Step 1: Move the connections directory**

```bash
mv apps/studio/src/components/workflows/connections apps/studio/src/components/connections
```

**Step 2: Update AppShell imports**

In `apps/studio/src/components/navigation/AppShell.tsx`, change lines 63-65 from:

```typescript
import { ConnectionsPage } from '../workflows/connections/ConnectionsPage';
import { ConnectionDetailPage } from '../workflows/connections/ConnectionDetailPage';
import { ConnectionCreatePage } from '../workflows/connections/ConnectionCreatePage';
```

to:

```typescript
import { ConnectionsPage } from '../connections/ConnectionsPage';
import { ConnectionDetailPage } from '../connections/ConnectionDetailPage';
import { ConnectionCreatePage } from '../connections/ConnectionCreatePage';
```

**Step 3: Verify no other imports reference the old path**

```bash
grep -r "workflows/connections" apps/studio/src/ --include="*.ts" --include="*.tsx"
```

Expected: No results (all imports should now point to `connections/`).

**Step 4: Build to verify**

```bash
cd apps/studio && pnpm build
```

Expected: Build succeeds with no import errors.

**Step 5: Commit**

```bash
npx prettier --write apps/studio/src/components/navigation/AppShell.tsx
git add apps/studio/src/components/connections/ apps/studio/src/components/navigation/AppShell.tsx
git add apps/studio/src/components/workflows/connections/  # stages the deletion
git commit -m "refactor(studio): move connections components out of workflows directory

Connections are a standalone resource in the sidebar, not a workflow
sub-feature. Move components/workflows/connections/ to components/connections/
and update AppShell imports."
```

---

### Task 2: Update copy — replace "in workflows" with "in your agents and workflows"

**Files:**

- Modify: `apps/studio/src/components/connections/ConnectionsPage.tsx:138`
- Modify: `apps/studio/src/components/connections/ConnectionCreatePage.tsx:68`

**Step 1: Update ConnectionsPage empty state description**

In `ConnectionsPage.tsx`, change line 138:

```typescript
description = 'Connect your external services and APIs to use them in workflows.';
```

to:

```typescript
description = 'Connect your external services and APIs to use them in your agents and workflows.';
```

**Step 2: Update ConnectionCreatePage description**

In `ConnectionCreatePage.tsx`, change line 68:

```typescript
description = 'Connect an external service or API to use in workflows.';
```

to:

```typescript
description = 'Connect an external service or API to use in your agents and workflows.';
```

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/connections/ConnectionsPage.tsx apps/studio/src/components/connections/ConnectionCreatePage.tsx
git add apps/studio/src/components/connections/ConnectionsPage.tsx apps/studio/src/components/connections/ConnectionCreatePage.tsx
git commit -m "fix(studio): update connections copy to reference agents and workflows

Connections are a shared resource used by both agents and workflows,
not just workflows. Update empty-state and page descriptions."
```

---

### Task 3: Fix console.error in workflow-engine-proxy.ts

**Files:**

- Modify: `apps/studio/src/lib/workflow-engine-proxy.ts:69`

**Step 1: Replace console.error with createLogger**

In `workflow-engine-proxy.ts`, add the logger import at the top (after the NextResponse import on line 11):

```typescript
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('workflow-engine-proxy');
```

Then change line 69 from:

```typescript
console.error(`[Workflow Engine Proxy] Service unreachable at ${baseUrl}${path}:`, message);
```

to:

```typescript
logger.error(`Service unreachable at ${baseUrl}${path}: ${message}`);
```

**Step 2: Build to verify**

```bash
cd apps/studio && pnpm build
```

Expected: Build succeeds. If `createLogger` is not available in the studio app context (it's a server-side utility from the compiler package), fall back to importing from a studio-local logger or just use `console.error` with a `// eslint-disable-next-line no-console` comment — but try the createLogger approach first.

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/lib/workflow-engine-proxy.ts
git add apps/studio/src/lib/workflow-engine-proxy.ts
git commit -m "fix(studio): replace console.error with logger in workflow-engine-proxy"
```

---

### Task 4: Flesh out ConnectionDetailPage with actions

**Files:**

- Modify: `apps/studio/src/components/connections/ConnectionDetailPage.tsx`

**Step 1: Update ConnectionDetailPage to include test, delete, and status badge**

Replace the entire contents of `ConnectionDetailPage.tsx` with:

```tsx
/**
 * ConnectionDetailPage Component
 *
 * Displays details for a single connection with test, delete,
 * and status management actions.
 */

'use client';

import { useState } from 'react';
import { ArrowLeft, Zap, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigationStore } from '../../store/navigation-store';
import { useConnections } from '../../hooks/useConnections';
import { testConnection, deleteConnection } from '../../api/connections';
import { sanitizeError } from '../../lib/sanitize-error';
import { PageHeader } from '../ui/PageHeader';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

const STATUS_BADGE_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  active: 'success',
  expired: 'warning',
  revoked: 'default',
  error: 'error',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Connected',
  expired: 'Expired',
  revoked: 'Revoked',
  error: 'Error',
};

export function ConnectionDetailPage() {
  const { projectId, subPage: connectionId, navigate } = useNavigationStore();
  const { connections, isLoading, refresh } = useConnections(projectId);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const connection = connections.find((c) => c.id === connectionId);

  const handleBack = () => {
    navigate(`/projects/${projectId}/connections`);
  };

  const handleTest = async () => {
    if (!projectId || !connectionId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection(projectId, connectionId);
      setTestResult(result);
      toast.success('Connection test passed');
    } catch (err) {
      const message = sanitizeError(err, 'Connection test failed');
      setTestResult({ success: false, message });
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!projectId || !connectionId) return;
    setDeleting(true);
    try {
      await deleteConnection(projectId, connectionId);
      toast.success('Connection deleted');
      navigate(`/projects/${projectId}/connections`);
    } catch (err) {
      const message = sanitizeError(err, 'Failed to delete connection');
      toast.error(message);
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <div className="h-4 w-24 rounded skeleton mb-4" />
          <div className="h-8 w-64 rounded skeleton mb-2" />
          <div className="h-4 w-40 rounded skeleton mb-6" />
          <div className="rounded-xl border border-border-default bg-surface-secondary p-4">
            <div className="space-y-3">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex gap-2">
                  <div className="h-4 w-32 rounded skeleton" />
                  <div className="h-4 w-48 rounded skeleton" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!connection) {
    return (
      <div className="p-8">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 text-muted hover:text-foreground text-sm transition-default mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Connections</span>
        </button>
        <div className="mt-4 text-muted">Connection not found.</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 text-muted hover:text-foreground text-sm transition-default mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Connections</span>
        </button>
        <PageHeader
          title={connection.displayName}
          description={`Connector: ${connection.connectorName}`}
          actions={
            <Badge variant={STATUS_BADGE_VARIANT[connection.status] ?? 'default'} dot>
              {STATUS_LABELS[connection.status] ?? connection.status}
            </Badge>
          }
        />

        {/* Details card */}
        <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-border-default bg-surface-secondary p-4">
            <h3 className="text-sm font-medium text-foreground mb-3">Connection Details</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="text-muted w-32">ID</dt>
                <dd className="text-foreground font-mono text-xs">{connection.id}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted w-32">Connector</dt>
                <dd className="text-foreground">{connection.connectorName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted w-32">Scope</dt>
                <dd className="text-foreground capitalize">{connection.scope}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted w-32">Created</dt>
                <dd className="text-foreground">
                  {new Date(connection.createdAt).toLocaleString()}
                </dd>
              </div>
              {connection.expiresAt && (
                <div className="flex gap-2">
                  <dt className="text-muted w-32">Expires</dt>
                  <dd className="text-foreground">
                    {new Date(connection.expiresAt).toLocaleString()}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* Test result */}
          {testResult && (
            <div
              className={
                testResult.success
                  ? 'rounded-lg bg-success-subtle text-success px-3 py-2 text-sm'
                  : 'rounded-lg bg-error-subtle text-error px-3 py-2 text-sm'
              }
            >
              {testResult.success
                ? 'Connection test passed'
                : testResult.message || 'Connection test failed'}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="secondary"
              icon={<Zap className="w-4 h-4" />}
              loading={testing}
              onClick={handleTest}
            >
              Test Connection
            </Button>
            <Button
              variant="ghost"
              icon={<Trash2 className="w-4 h-4" />}
              loading={deleting}
              onClick={handleDelete}
              className="text-error hover:text-error"
            >
              {connection.status === 'active' ? 'Revoke' : 'Delete'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Build to verify**

```bash
cd apps/studio && pnpm build
```

Expected: Build succeeds.

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/connections/ConnectionDetailPage.tsx
git add apps/studio/src/components/connections/ConnectionDetailPage.tsx
git commit -m "feat(studio): add test and delete actions to ConnectionDetailPage

The detail page was read-only metadata. Now includes test connection,
delete/revoke actions, status badge, loading skeleton, and toast feedback
matching the functionality already in ConnectionCard."
```

---

### Task 5: Rename EngineApprovalItem in useApprovals hook

**Files:**

- Modify: `apps/studio/src/hooks/useApprovals.ts:30`

**Step 1: Rename the interface**

In `useApprovals.ts`, change line 30:

```typescript
interface EngineApprovalItem {
```

to:

```typescript
interface RawApprovalItem {
```

And update the reference on line 43:

```typescript
data: EngineApprovalItem[];
```

to:

```typescript
data: RawApprovalItem[];
```

**Step 2: Commit**

```bash
npx prettier --write apps/studio/src/hooks/useApprovals.ts
git add apps/studio/src/hooks/useApprovals.ts
git commit -m "refactor(studio): rename EngineApprovalItem to RawApprovalItem

Remove stale workflow-engine naming from the approvals hook."
```
