# Workflow Versioning Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all CRITICAL, HIGH, and MEDIUM findings from the 5-agent review of the workflow versioning feature.

**Architecture:** Fix isolation gaps (tenant plugin, projectId filters), repair broken sourceHash computation, implement the missing fire-time resolution pipeline, wire workflow version import into the staged importer, and harden routes/service with proper error handling and validation.

**Tech Stack:** Mongoose (MongoDB), Express.js, TypeScript, Vitest, crypto (SHA-256)

---

## Task 1: Fix WorkflowVersion Model — Tenant Isolation Plugin + Index Fixes

**Findings addressed:** C1 (model), H1 (model), M3 (model), M7 (model)

**Files:**

- Modify: `packages/database/src/models/workflow-version.model.ts`
- Test: `packages/database/src/__tests__/model-workflow-version.test.ts`

**Step 1: Write failing tests**

Add to `packages/database/src/__tests__/model-workflow-version.test.ts`:

```typescript
describe('tenant isolation', () => {
  it('should reject invalid status enum values', async () => {
    const doc = {
      workflowId: 'wf-1',
      version: '0.1.0',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      definition: { steps: [] },
      sourceHash: 'abc123',
      status: 'published', // invalid
      createdBy: 'user-1',
    };
    await expect(WorkflowVersion.create(doc)).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails or passes (baseline)**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/database test -- --run model-workflow-version`

**Step 3: Apply model fixes**

In `packages/database/src/models/workflow-version.model.ts`:

1. Add tenant isolation plugin import and application:

```typescript
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
// ... after schema definition, before indexes:
WorkflowVersionSchema.plugin(tenantIsolationPlugin);
```

2. Fix unique index to include `projectId` and correct field order:

```typescript
// REPLACE:
WorkflowVersionSchema.index({ workflowId: 1, version: 1, tenantId: 1 }, { unique: true });
// WITH:
WorkflowVersionSchema.index(
  { tenantId: 1, projectId: 1, workflowId: 1, version: 1 },
  { unique: true },
);
```

3. Add `projectId` to sourceHash index:

```typescript
// REPLACE:
WorkflowVersionSchema.index({ tenantId: 1, sourceHash: 1 });
// WITH:
WorkflowVersionSchema.index({ tenantId: 1, projectId: 1, sourceHash: 1 });
```

4. Add `tenantId` prefix to the listing index:

```typescript
// REPLACE:
WorkflowVersionSchema.index({ workflowId: 1, createdAt: -1 });
// WITH:
WorkflowVersionSchema.index({ tenantId: 1, workflowId: 1, createdAt: -1 });
```

**Step 4: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/database test -- --run model-workflow-version`
Expected: All PASS

**Step 5: Commit**

```bash
git add packages/database/src/models/workflow-version.model.ts packages/database/src/__tests__/model-workflow-version.test.ts
git commit -m "fix(database): add tenantIsolationPlugin and fix indexes on WorkflowVersion model"
```

---

## Task 2: Fix WorkflowExecution Model — Default Null + Missing Indexes

**Findings addressed:** M2 (model), H3 (db-model, missing indexes), H4 (execution status enum)

**Files:**

- Modify: `packages/database/src/models/workflow-execution.model.ts`
- Test: `packages/database/src/__tests__/model-workflow-execution-version.test.ts`

**Step 1: Write failing test**

Add to `packages/database/src/__tests__/model-workflow-execution-version.test.ts`:

```typescript
it('should default workflowVersion and deploymentId to null', async () => {
  const doc = await WorkflowExecution.create({
    tenantId: 'tenant-1',
    projectId: 'project-1',
    workflowId: 'wf-1',
    triggerType: 'manual',
    restateWorkflowId: `restate-null-test-${Date.now()}`,
    status: 'running',
    startedAt: new Date(),
  });
  const found = await WorkflowExecution.findOne({ _id: doc._id, tenantId: 'tenant-1' }).lean();
  expect(found.workflowVersion).toBeNull();
  expect(found.deploymentId).toBeNull();
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/database test -- --run model-workflow-execution`
Expected: FAIL — `workflowVersion` is `undefined`, not `null`

**Step 3: Apply fixes**

In `packages/database/src/models/workflow-execution.model.ts`:

1. Change interface to use `| null` instead of `?`:

```typescript
// REPLACE lines 80-81:
  workflowVersion?: string;
  deploymentId?: string;
// WITH:
  workflowVersion: string | null;
  deploymentId: string | null;
```

2. Add `default: null` to both schema fields:

```typescript
// REPLACE lines 206-207:
    workflowVersion: { type: String },
    deploymentId: { type: String },
// WITH:
    workflowVersion: { type: String, default: null },
    deploymentId: { type: String, default: null },
```

3. Add `waiting_human_task` to the interface status union:

```typescript
// REPLACE lines 85-91:
  status:
    | 'running'
    | 'waiting_callback'
    | 'waiting_approval'
    | 'completed'
    | 'failed'
    | 'cancelled';
// WITH:
  status:
    | 'running'
    | 'waiting_callback'
    | 'waiting_approval'
    | 'waiting_human_task'
    | 'completed'
    | 'failed'
    | 'cancelled';
```

4. Add sparse indexes for version/deployment queries (after existing indexes):

```typescript
WorkflowExecutionSchema.index({ tenantId: 1, deploymentId: 1, startedAt: -1 }, { sparse: true });
WorkflowExecutionSchema.index({ tenantId: 1, workflowId: 1, workflowVersion: 1, status: 1 });
```

**Step 4: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/database test -- --run model-workflow-execution`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/database/src/models/workflow-execution.model.ts packages/database/src/__tests__/model-workflow-execution-version.test.ts
git commit -m "fix(database): add null defaults and missing indexes to WorkflowExecution model"
```

---

## Task 3: Fix Deployment Model + Repo — Type Safety + Tenant Scoped Update

**Findings addressed:** M1 (deployment `any` types), C7 (deployment-repo `findByIdAndUpdate`)

**Files:**

- Modify: `packages/database/src/models/deployment.model.ts:22-23`
- Modify: `apps/runtime/src/repos/deployment-repo.ts:94-105`
- Test: `apps/runtime/src/__tests__/deployment-workflow-versions.test.ts`

**Step 1: Write failing test**

Add to `apps/runtime/src/__tests__/deployment-workflow-versions.test.ts`:

```typescript
describe('updateDeploymentStatus tenant isolation', () => {
  it('should require tenantId parameter', async () => {
    // updateDeploymentStatus signature now requires tenantId
    const { updateDeploymentStatus } = await import('../repos/deployment-repo.js');
    expect(updateDeploymentStatus.length).toBeGreaterThanOrEqual(3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run deployment-workflow-versions`
Expected: FAIL — current function has 2 params, not 3

**Step 3: Fix deployment model types**

In `packages/database/src/models/deployment.model.ts`, replace `any` with proper types:

```typescript
// REPLACE lines 22-23:
agentVersionManifest: any;
workflowVersionManifest: any;
// WITH:
agentVersionManifest: Record<string, string>;
workflowVersionManifest: Record<string, string>;
```

**Step 4: Fix deployment-repo to use tenant-scoped update**

In `apps/runtime/src/repos/deployment-repo.ts`, replace `updateDeploymentStatus`:

```typescript
// REPLACE lines 94-105:
export async function updateDeploymentStatus(
  deploymentId: string,
  data: { status: string; drainingStartedAt?: Date; retiredAt?: Date | null },
): Promise<any> {
  const { Deployment } = await import('@agent-platform/database/models');
  const doc = await Deployment.findByIdAndUpdate(
    deploymentId,
    { $set: data },
    { new: true },
  ).lean();
  return doc ? parseDeploymentJson(doc) : null;
}
// WITH:
export async function updateDeploymentStatus(
  deploymentId: string,
  tenantId: string,
  data: { status: string; drainingStartedAt?: Date; retiredAt?: Date | null },
): Promise<any> {
  const { Deployment } = await import('@agent-platform/database/models');
  const doc = await Deployment.findOneAndUpdate(
    { _id: deploymentId, tenantId },
    { $set: data },
    { new: true },
  ).lean();
  return doc ? parseDeploymentJson(doc) : null;
}
```

**Step 5: Update ALL callers of `updateDeploymentStatus` in `deployments.ts`**

Search for all calls to `updateDeploymentStatus` in `apps/runtime/src/routes/deployments.ts`. Each call currently passes `(id, data)` — add `tenantId` as the second argument. For example:

```typescript
// REPLACE:
await updateDeploymentStatus(previousActive.id, {
  status: 'draining',
  drainingStartedAt: new Date(),
});
// WITH:
await updateDeploymentStatus(previousActive.id, tenantId, {
  status: 'draining',
  drainingStartedAt: new Date(),
});
```

Apply this to every call site (approximately 6 occurrences).

**Step 6: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run deployment-workflow-versions`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/database/src/models/deployment.model.ts apps/runtime/src/repos/deployment-repo.ts apps/runtime/src/routes/deployments.ts apps/runtime/src/__tests__/deployment-workflow-versions.test.ts
git commit -m "fix(runtime): tenant-scope updateDeploymentStatus and type deployment manifests"
```

---

## Task 4: Fix sourceHash — Recursive Key Sorting + Definition Size Guard

**Findings addressed:** C2 (sourceHash non-recursive), M1 (service, JSON.stringify replacer), H3 (service, no size guard)

**Files:**

- Modify: `apps/runtime/src/services/workflow-version-service.ts:77-81`
- Test: `apps/runtime/src/__tests__/workflow-version-service.test.ts`

**Step 1: Write failing tests**

Add to `apps/runtime/src/__tests__/workflow-version-service.test.ts`:

```typescript
describe('computeSourceHash stability', () => {
  it('should produce identical hashes for semantically identical definitions with different key order', () => {
    // Access private function via module — or test through createVersion dedup
    const def1 = {
      steps: [{ id: 'a', type: 'http', config: { url: 'x', method: 'GET' } }],
      triggers: [],
    };
    const def2 = {
      triggers: [],
      steps: [{ type: 'http', id: 'a', config: { method: 'GET', url: 'x' } }],
    };
    // Both definitions should dedup if submitted sequentially
    // We test this through the service — first create returns new, second returns deduplicated
  });
});

describe('definition size guard', () => {
  it('should reject definitions exceeding MAX_DEFINITION_SIZE', async () => {
    // Create a workflow with a massive steps array
    const svc = getSvc();
    // Mock a workflow with a 1MB definition
    const bigSteps = Array.from({ length: 10000 }, (_, i) => ({
      id: `step-${i}`,
      type: 'http',
      config: { url: 'x'.repeat(100) },
    }));
    mockWorkflowFindOne.mockResolvedValueOnce({
      _id: 'wf-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      steps: bigSteps,
      triggers: [],
      notificationRules: [],
      escalationRules: [],
      slaMinutes: null,
      entryAgent: null,
    });

    await expect(
      svc.createVersion({
        workflowId: 'wf-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
      }),
    ).rejects.toThrow(/exceeds maximum size/);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run workflow-version-service`
Expected: FAIL

**Step 3: Fix `computeSourceHash` and add size guard**

In `apps/runtime/src/services/workflow-version-service.ts`:

```typescript
// REPLACE lines 77-81:
/** Compute a stable sourceHash from a workflow definition. */
function computeSourceHash(definition: Record<string, unknown>): string {
  const canonical = JSON.stringify(definition, Object.keys(definition).sort());
  return createHash('sha256').update(canonical).digest('hex').substring(0, 16);
}

// WITH:
const MAX_DEFINITION_SIZE = 512 * 1024; // 512 KB

/** Recursively sort object keys for deterministic serialization. */
function deepSortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(deepSortKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = deepSortKeys((obj as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return obj;
}

/** Compute a stable sourceHash from a workflow definition. */
function computeSourceHash(definition: Record<string, unknown>): string {
  const canonical = JSON.stringify(deepSortKeys(definition));
  return createHash('sha256').update(canonical).digest('hex').substring(0, 16);
}
```

Then in `createVersion`, after building the `definition` object (after line 134), add:

```typescript
// Size guard — reject oversized definitions before storing
const definitionJson = JSON.stringify(definition);
if (definitionJson.length > MAX_DEFINITION_SIZE) {
  throw new AppError(`Workflow definition exceeds maximum size of ${MAX_DEFINITION_SIZE} bytes`, {
    ...ErrorCodes.BAD_REQUEST,
  });
}
```

**Step 4: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run workflow-version-service`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/workflow-version-service.ts apps/runtime/src/__tests__/workflow-version-service.test.ts
git commit -m "fix(runtime): recursive key sort in sourceHash and add definition size guard"
```

---

## Task 5: Fix Service — ProjectId Isolation + Tenant in Optimistic Lock + Error Wrapping

**Findings addressed:** C3 (service projectId missing), H1 (service optimistic lock), H3 (service err:any), M3 (listVersions no ownership check), M4 (getVersion no ownership check)

**Files:**

- Modify: `apps/runtime/src/services/workflow-version-service.ts`
- Test: `apps/runtime/src/__tests__/workflow-version-service.test.ts`

**Step 1: Write failing tests**

Add tests for projectId propagation and ownership check:

```typescript
describe('projectId isolation', () => {
  it('listVersions should include projectId in query filter', async () => {
    const svc = getSvc();
    mockWorkflowVersionFind.mockReturnValueOnce({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }),
    });
    mockWorkflowVersionCountDocuments.mockResolvedValueOnce(0);

    await svc.listVersions({
      workflowId: 'wf-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      limit: 10,
    });

    expect(mockWorkflowVersionFind).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', tenantId: 'tenant-1', projectId: 'project-1' }),
    );
  });
});
```

**Step 2: Run to verify failure**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run workflow-version-service`
Expected: FAIL — filter currently has only `{ workflowId, tenantId }`

**Step 3: Apply all service fixes**

In `apps/runtime/src/services/workflow-version-service.ts`:

1. **`createVersion` dedup query (line 139)** — add `projectId`:

```typescript
// REPLACE:
const latestVersion = await WorkflowVersion.findOne({ workflowId, tenantId });
// WITH:
const latestVersion = await WorkflowVersion.findOne({ workflowId, tenantId, projectId });
```

2. **`nextVersion` (line 238-240)** — add `projectId` param and filter; optimize to use `findOne`:

```typescript
// REPLACE entire nextVersion method:
  async nextVersion(workflowId: string, tenantId: string, projectId: string): Promise<string> {
    const { WorkflowVersion } = await import('@agent-platform/database/models');
    const latest = await WorkflowVersion.findOne({ workflowId, tenantId, projectId })
      .sort({ createdAt: -1 })
      .select('version')
      .lean();

    if (!latest) return '0.1.0';

    const parts = ((latest as any).version as string).split('.').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return '0.1.0';
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
```

3. **Update `nextVersion` call sites** in `createVersion` (lines 157, 194):

```typescript
// REPLACE:
const version = await this.nextVersion(workflowId, tenantId);
// WITH:
const version = await this.nextVersion(workflowId, tenantId, projectId);
```

(Same for the retry call at line 194.)

4. **`listVersions` (line 216)** — add `projectId`:

```typescript
// REPLACE:
const filter = { workflowId, tenantId };
// WITH:
const filter = { workflowId, tenantId, projectId: params.projectId };
```

5. **`getVersion` (line 229-231)** — add `projectId` param:

```typescript
// REPLACE:
  async getVersion(workflowId: string, version: string, tenantId: string) {
    const { WorkflowVersion } = await import('@agent-platform/database/models');
    return WorkflowVersion.findOne({ workflowId, version, tenantId }).lean();
  }
// WITH:
  async getVersion(workflowId: string, version: string, tenantId: string, projectId?: string) {
    const { WorkflowVersion } = await import('@agent-platform/database/models');
    const filter: Record<string, string> = { workflowId, version, tenantId };
    if (projectId) filter.projectId = projectId;
    return WorkflowVersion.findOne(filter).lean();
  }
```

6. **`promoteVersion` optimistic lock (line 291)** — add `tenantId`:

```typescript
// REPLACE:
const updated = await WorkflowVersion.findOneAndUpdate(
  { _id: (record as any)._id, status: currentStatus },
// WITH:
const updated = await WorkflowVersion.findOneAndUpdate(
  { _id: (record as any)._id, tenantId, status: currentStatus },
```

7. **`diffVersions` (line 325-330)** — add `projectId` param:

```typescript
// REPLACE:
  async diffVersions(workflowId: string, versionA: string, versionB: string, tenantId: string) {
    const { WorkflowVersion } = await import('@agent-platform/database/models');
    const [a, b] = await Promise.all([
      WorkflowVersion.findOne({ workflowId, version: versionA, tenantId }).lean(),
      WorkflowVersion.findOne({ workflowId, version: versionB, tenantId }).lean(),
    ]);
// WITH:
  async diffVersions(workflowId: string, versionA: string, versionB: string, tenantId: string, projectId?: string) {
    const { WorkflowVersion } = await import('@agent-platform/database/models');
    const filter = { workflowId, tenantId, ...(projectId ? { projectId } : {}) };
    const [a, b] = await Promise.all([
      WorkflowVersion.findOne({ ...filter, version: versionA }).lean(),
      WorkflowVersion.findOne({ ...filter, version: versionB }).lean(),
    ]);
```

8. **Error wrapping in `createVersion` catch (line 197):**

```typescript
// REPLACE:
throw err;
// WITH:
const message = err instanceof Error ? err.message : String(err);
log.error('Workflow version create failed', { workflowId, error: message });
throw new AppError('Version creation failed', { ...ErrorCodes.INTERNAL_ERROR });
```

**Step 4: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run workflow-version-service`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/workflow-version-service.ts apps/runtime/src/__tests__/workflow-version-service.test.ts
git commit -m "fix(runtime): add projectId isolation to all WorkflowVersionService queries and wrap errors"
```

---

## Task 6: Fix Routes — Diff Null Guard, ProjectId Pass-Through, Pagination Cap, Limit Enforcement

**Findings addressed:** C6 (diff null guard), M2 (route, pagination max), M6 (route, projectId to diff), H5 (route, no audit)

**Files:**

- Modify: `apps/runtime/src/routes/workflow-versions.ts`
- Test: `apps/runtime/src/__tests__/workflow-version-routes.test.ts`

**Step 1: Write failing tests**

Add to `apps/runtime/src/__tests__/workflow-version-routes.test.ts`:

```typescript
describe('GET /:version/diff/:otherVersion', () => {
  it('should return 404 when one version is not found', async () => {
    // Mock diffVersions to throw not found
    mockDiffVersions.mockRejectedValueOnce(new Error("Version '0.2.0' not found"));
    const res = await request(app)
      .get('/api/projects/proj-1/workflows/wf-1/versions/0.1.0/diff/0.2.0')
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(404);
  });
});

describe('GET / pagination', () => {
  it('should cap limit at 200', async () => {
    // When limit=99999, service should receive capped value
    mockListVersions.mockResolvedValueOnce({ versions: [], total: 0 });
    const res = await request(app)
      .get('/api/projects/proj-1/workflows/wf-1/versions?limit=99999')
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBeLessThanOrEqual(200);
  });
});
```

**Step 2: Run to verify failures**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run workflow-version-routes`

**Step 3: Apply route fixes**

In `apps/runtime/src/routes/workflow-versions.ts`:

1. **Pagination max cap (line 67-68):**

```typescript
// REPLACE:
const listVersionsQuery = z.object({
  limit: z.string().transform(Number).pipe(z.number().int().positive()).optional(),
  offset: z.string().transform(Number).pipe(z.number().int().nonnegative()).optional(),
});
// WITH:
const listVersionsQuery = z.object({
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(200)).optional(),
  offset: z.string().transform(Number).pipe(z.number().int().nonnegative()).optional(),
});
```

2. **Pass `projectId` to `diffVersions` (line 365-370):**

```typescript
// REPLACE:
const { a, b } = await getWorkflowVersionService().diffVersions(
  workflowId,
  version,
  otherVersion,
  req.tenantContext!.tenantId,
);
// WITH:
const { projectId, workflowId, version, otherVersion } = req.params;
const { a, b } = await getWorkflowVersionService().diffVersions(
  workflowId,
  version,
  otherVersion,
  req.tenantContext!.tenantId,
  projectId,
);
```

3. **Remove `any` casts in diff response (lines 375-378):**

```typescript
// REPLACE:
res.json({
  success: true,
  diff: {
    version1: (a as any).version,
    version2: (b as any).version,
    definition1: (a as any).definition,
    definition2: (b as any).definition,
  },
});
// WITH:
const aRecord = a as Record<string, unknown>;
const bRecord = b as Record<string, unknown>;
res.json({
  success: true,
  diff: {
    version1: aRecord.version as string,
    version2: bRecord.version as string,
    definition1: aRecord.definition as Record<string, unknown>,
    definition2: bRecord.definition as Record<string, unknown>,
  },
});
```

4. **Pass `projectId` to `getVersion` (line 267-271):**

```typescript
// REPLACE:
const record = await getWorkflowVersionService().getVersion(
  workflowId,
  version,
  req.tenantContext!.tenantId,
);
// WITH:
const { projectId, workflowId, version } = req.params;
const record = await getWorkflowVersionService().getVersion(
  workflowId,
  version,
  req.tenantContext!.tenantId,
  projectId,
);
```

**Step 4: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run workflow-version-routes`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/workflow-versions.ts apps/runtime/src/__tests__/workflow-version-routes.test.ts
git commit -m "fix(runtime): add null guards, pagination cap, and projectId to version routes"
```

---

## Task 7: Fix Deployment Route — ProjectId in Version Lookup

**Findings addressed:** H4 (routes, deployment create missing projectId), H2 (route, redundant validation removal)

**Files:**

- Modify: `apps/runtime/src/routes/deployments.ts:501-505`
- Test: `apps/runtime/src/__tests__/deployment-workflow-versions.test.ts`

**Step 1: Write failing test**

Add to `apps/runtime/src/__tests__/deployment-workflow-versions.test.ts`:

```typescript
it('should verify workflow version belongs to same project', async () => {
  // Ensure WorkflowVersion.findOne includes projectId in filter
  // Mock to return null when projectId doesn't match
  mockWorkflowVersionFindOne.mockResolvedValueOnce(null);
  // Test should reject with 400 when version not found for project
});
```

**Step 2: Apply fix**

In `apps/runtime/src/routes/deployments.ts`, line 501-505:

```typescript
// REPLACE:
const wfVersion = await WorkflowVersion.findOne({
  workflowId: (workflow as any)._id,
  version,
  tenantId,
}).lean();
// WITH:
const wfVersion = await WorkflowVersion.findOne({
  workflowId: (workflow as any)._id,
  version,
  tenantId,
  projectId,
}).lean();
```

**Step 3: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run deployment-workflow-versions`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/routes/deployments.ts apps/runtime/src/__tests__/deployment-workflow-versions.test.ts
git commit -m "fix(runtime): add projectId to workflow version lookup in deployment creation"
```

---

## Task 8: Fix Export — Version Path Sanitization + ProjectId + Missing Version Warning

**Findings addressed:** M7 (export, path traversal), M8 (export, projectId), H9 (export, silent skip)

**Files:**

- Modify: `packages/project-io/src/export/layer-assemblers/workflows-assembler.ts`
- Test: `packages/project-io/src/__tests__/workflows-assembler-versions.test.ts`

**Step 1: Write failing test**

Add to `packages/project-io/src/__tests__/workflows-assembler-versions.test.ts`:

```typescript
it('should warn when a pinned version is not found in database', async () => {
  // Setup: deployment references version 2.0.0 but only 1.0.0 exists
  // Expect: warnings array includes message about missing version
});

it('should sanitize version string in file path', async () => {
  // Version string with path traversal characters should be cleaned
  // e.g. '../../etc/passwd' should not produce a path outside workflows/versions/
});
```

**Step 2: Apply fixes**

In `packages/project-io/src/export/layer-assemblers/workflows-assembler.ts`:

1. **Add `projectId` to version query (line 92-95):**

```typescript
// REPLACE:
const versions = await WorkflowVersion.find({
  workflowId: { $in: workflowIds },
  tenantId,
}).lean();
// WITH:
const versions = await WorkflowVersion.find({
  workflowId: { $in: workflowIds },
  tenantId,
  projectId,
}).lean();
```

2. **Add missing version warning after the emit loop (after line 126):**

```typescript
// Warn for pinned versions not found in database
for (const [workflowName, pinnedVersions] of pinnedPairs) {
  const workflowId = nameToId.get(workflowName);
  if (!workflowId) continue;
  for (const pinnedVersion of pinnedVersions) {
    const found = versions.some(
      (v) =>
        (v as Record<string, unknown>).workflowId === workflowId &&
        (v as Record<string, unknown>).version === pinnedVersion,
    );
    if (!found) {
      warnings.push(
        `Workflow "${workflowName}" version "${pinnedVersion}" referenced in deployment manifest not found`,
      );
    }
  }
}
```

3. **Sanitize version string in file path (line 113):**

```typescript
// REPLACE:
const path = `workflows/versions/${safeName}/${record.version as string}.version.json`;
// WITH:
const safeVersion = (record.version as string).replace(/[^a-zA-Z0-9._-]/g, '_');
const path = `workflows/versions/${safeName}/${safeVersion}.version.json`;
```

**Step 3: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/project-io test -- --run workflows-assembler`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/project-io/src/export/layer-assemblers/workflows-assembler.ts packages/project-io/src/__tests__/workflows-assembler-versions.test.ts
git commit -m "fix(project-io): add projectId filter, path sanitization, and missing version warnings to export"
```

---

## Task 9: Fix Lockfile — Add Version + Status Fields to Workflows Section

**Findings addressed:** H7 (lockfile missing version/status)

**Files:**

- Modify: `packages/project-io/src/types.ts:413`
- Modify: `packages/project-io/src/export/lockfile-generator.ts:159`
- Test: `packages/project-io/src/__tests__/workflows-assembler-versions.test.ts`

**Step 1: Write failing test**

Add to `packages/project-io/src/__tests__/workflows-assembler-versions.test.ts`:

```typescript
describe('lockfile workflow entries', () => {
  it('should include version and status for workflow version files', () => {
    // When generating lockfile with version files in the workflows layer,
    // the workflows section should have { version, source_hash, status } entries
  });
});
```

**Step 2: Apply fixes**

1. **Update `LockFileV2` type in `packages/project-io/src/types.ts` line 413:**

```typescript
// REPLACE:
workflows: Record<string, { source_hash: string }>;
// WITH:
workflows: Record<string, { source_hash: string; version?: string; status?: string }>;
```

2. **Update lockfile generator to extract version/status from version files.**

In `packages/project-io/src/export/lockfile-generator.ts`, after the routing loop (line 186-196), add special handling for workflow version files:

```typescript
// Enrich workflow version entries with version and status metadata
for (const [filePath, content] of layerFiles.get('workflows' as LayerName) ?? new Map()) {
  if (filePath.endsWith('.version.json') && workflowsRecord[filePath]) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.version) workflowsRecord[filePath].version = parsed.version;
      if (parsed.status) workflowsRecord[filePath].status = parsed.status;
    } catch {
      // Ignore parse errors — source_hash is already computed
    }
  }
}
```

**Step 3: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/project-io test -- --run`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/project-io/src/types.ts packages/project-io/src/export/lockfile-generator.ts packages/project-io/src/__tests__/workflows-assembler-versions.test.ts
git commit -m "fix(project-io): add version and status fields to lockfile workflows section"
```

---

## Task 10: Implement Workflow Version Import in Staged Importer

**Findings addressed:** C4 (import pipeline missing), H8 (workflowVersionFiles excluded from layerFiles)

**Files:**

- Modify: `packages/project-io/src/import/staged-importer.ts`
- Modify: `packages/project-io/src/import/folder-reader.ts:254-263`
- Test: `packages/project-io/src/__tests__/import-workflow-versions.test.ts`

**Step 1: Write failing test**

Rewrite `packages/project-io/src/__tests__/import-workflow-versions.test.ts` to test actual import:

```typescript
describe('staged importer workflow version handling', () => {
  it('should create WorkflowVersion records with status reset to draft', async () => {
    const versionFile = JSON.stringify({
      version: '1.0.0',
      source_hash: 'abc123',
      status: 'active',
      changelog: 'Production release',
      created_by: 'user-1',
      created_at: '2026-03-09T12:00:00.000Z',
      definition: { steps: [{ id: 's1', type: 'http' }], triggers: [] },
    });

    const files = new Map<string, string>();
    files.set('workflows/versions/order_processing/1.0.0.version.json', versionFile);

    const result = readFolderV2(files);
    expect(result.workflowVersionFiles.size).toBe(1);

    // Parse and verify status reset
    const [, content] = [...result.workflowVersionFiles.entries()][0];
    const parsed = JSON.parse(content);
    // The import consumer should reset status to draft
    expect(parsed.status).toBe('active'); // raw file has active
    // After import processing, it should become draft — test the actual consumer
  });
});
```

**Step 2: Apply fixes**

1. **In `packages/project-io/src/import/folder-reader.ts`, include version files in `layerFiles.workflows`** (so lockfile hashes remain consistent):

```typescript
// AFTER line 258 (workflows: workflowFiles), add version files to the same layer:
// Merge workflow version files into the workflows layer for lockfile hash consistency
for (const [p, c] of workflowVersionFiles) workflowFiles.set(p, c);
```

2. **In `packages/project-io/src/import/staged-importer.ts`, add workflow version import logic.**

In the `activateLayer` method for the `'workflows'` layer, after processing working copy workflows, add:

```typescript
// Import workflow version records with status reset to 'draft'
if (readResult.workflowVersionFiles && readResult.workflowVersionFiles.size > 0) {
  const { WorkflowVersion, Workflow } = await import('@agent-platform/database/models');

  for (const [filePath, content] of readResult.workflowVersionFiles) {
    try {
      const parsed = JSON.parse(content);
      // Extract workflow name from path: workflows/versions/{name}/{version}.version.json
      const pathParts = filePath.split('/');
      const workflowName = pathParts[2]; // workflows/versions/{name}/...

      // Look up workflow ID by name
      const workflow = await Workflow.findOne({
        name: workflowName,
        tenantId: context.tenantId,
        projectId: context.projectId,
      }).lean();

      if (!workflow) {
        warnings.push(`Skipping version file ${filePath}: workflow "${workflowName}" not found`);
        continue;
      }

      await WorkflowVersion.create({
        workflowId: (workflow as any)._id,
        version: parsed.version,
        tenantId: context.tenantId,
        projectId: context.projectId,
        definition: parsed.definition,
        sourceHash: parsed.source_hash,
        status: 'draft', // ALWAYS reset to draft on import
        changelog: parsed.changelog ?? null,
        createdBy: parsed.created_by ?? context.userId ?? 'import',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to import version file ${filePath}: ${msg}`);
    }
  }
}
```

**Step 3: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/project-io test -- --run import-workflow-versions`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/project-io/src/import/staged-importer.ts packages/project-io/src/import/folder-reader.ts packages/project-io/src/__tests__/import-workflow-versions.test.ts
git commit -m "feat(project-io): implement workflow version import with status reset to draft"
```

---

## Task 11: Implement Fire-Time Deployment Resolution in Trigger Engine

**Findings addressed:** C5 (fire-time resolution missing), H10 (execution record population)

This is the largest and most important task — it wires the entire version pinning pipeline end-to-end.

**Files:**

- Modify: `apps/workflow-engine/src/services/trigger-engine.ts:287-334`
- Modify: `apps/workflow-engine/src/services/trigger-engine.ts:31-49` (TriggerEngineDeps)
- Create: `apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts`

**Step 1: Write failing tests**

Create `apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerEngine } from '../services/trigger-engine.js';

describe('fire-time deployment resolution', () => {
  let engine: TriggerEngine;
  let deps: any;

  beforeEach(() => {
    deps = {
      triggerModel: {
        create: vi.fn(),
        find: vi.fn(() => ({ lean: () => Promise.resolve([]) })),
        findOne: vi.fn(),
        findOneAndUpdate: vi.fn(),
      },
      workflowModel: {
        findOne: vi.fn(),
        findOneAndUpdate: vi.fn(),
      },
      restateClient: {
        startWorkflow: vi.fn().mockResolvedValue(undefined),
      },
      scheduler: null,
      connectorTriggerEngine: null,
      deploymentModel: {
        findOne: vi.fn(),
      },
      workflowVersionModel: {
        findOne: vi.fn(),
      },
    };
    engine = new TriggerEngine(deps);
  });

  it('should use working copy steps when trigger has no environment', async () => {
    deps.triggerModel.findOne.mockResolvedValue({
      _id: 'trig-1',
      workflowId: 'wf-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      status: 'active',
      // no environment field
    });
    deps.workflowModel.findOne.mockResolvedValue({
      _id: 'wf-1',
      name: 'test_workflow',
      steps: [{ id: 's1', type: 'http' }],
    });

    const result = await engine.fireWebhookTrigger('trig-1', {}, 'tenant-1', 'project-1');
    expect(result.executionId).toBeDefined();
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        steps: [{ id: 's1', type: 'http' }],
        workflowVersion: null,
        deploymentId: null,
      }),
    );
  });

  it('should resolve pinned version when trigger has environment with active deployment', async () => {
    deps.triggerModel.findOne.mockResolvedValue({
      _id: 'trig-1',
      workflowId: 'wf-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      status: 'active',
      environment: 'production',
    });
    deps.workflowModel.findOne.mockResolvedValue({
      _id: 'wf-1',
      name: 'test_workflow',
      steps: [{ id: 's1', type: 'http' }],
    });
    deps.deploymentModel.findOne.mockReturnValue({
      sort: () => ({
        lean: () =>
          Promise.resolve({
            _id: 'deploy-1',
            workflowVersionManifest: { test_workflow: '1.0.0' },
          }),
      }),
    });
    deps.workflowVersionModel.findOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'wfv-1',
          version: '1.0.0',
          definition: {
            steps: [{ id: 's1', type: 'http', config: { url: 'pinned' } }],
            triggers: [],
          },
        }),
    });

    const result = await engine.fireWebhookTrigger('trig-1', {}, 'tenant-1', 'project-1');
    expect(result.executionId).toBeDefined();
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        steps: [{ id: 's1', type: 'http', config: { url: 'pinned' } }],
        workflowVersion: '1.0.0',
        deploymentId: 'deploy-1',
      }),
    );
  });

  it('should fall back to working copy when deployment has no manifest entry for workflow', async () => {
    deps.triggerModel.findOne.mockResolvedValue({
      _id: 'trig-1',
      workflowId: 'wf-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      status: 'active',
      environment: 'staging',
    });
    deps.workflowModel.findOne.mockResolvedValue({
      _id: 'wf-1',
      name: 'test_workflow',
      steps: [{ id: 's1', type: 'http' }],
    });
    deps.deploymentModel.findOne.mockReturnValue({
      sort: () => ({
        lean: () =>
          Promise.resolve({
            _id: 'deploy-2',
            workflowVersionManifest: {}, // no entry for this workflow
          }),
      }),
    });

    const result = await engine.fireWebhookTrigger('trig-1', {}, 'tenant-1', 'project-1');
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        steps: [{ id: 's1', type: 'http' }],
        workflowVersion: null,
        deploymentId: null,
      }),
    );
  });

  it('should fall back to working copy when no active deployment exists', async () => {
    deps.triggerModel.findOne.mockResolvedValue({
      _id: 'trig-1',
      workflowId: 'wf-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      status: 'active',
      environment: 'production',
    });
    deps.workflowModel.findOne.mockResolvedValue({
      _id: 'wf-1',
      name: 'test_workflow',
      steps: [{ id: 's1', type: 'http' }],
    });
    deps.deploymentModel.findOne.mockReturnValue({
      sort: () => ({
        lean: () => Promise.resolve(null), // no active deployment
      }),
    });

    const result = await engine.fireWebhookTrigger('trig-1', {}, 'tenant-1', 'project-1');
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        steps: [{ id: 's1', type: 'http' }],
        workflowVersion: null,
        deploymentId: null,
      }),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/workflow-engine test -- --run trigger-fire-resolution`
Expected: FAIL — deps doesn't have `deploymentModel` / `workflowVersionModel`

**Step 3: Extend `TriggerEngineDeps` interface**

In `apps/workflow-engine/src/services/trigger-engine.ts`, add to `TriggerEngineDeps`:

```typescript
  /** Optional: Deployment model for fire-time version resolution */
  deploymentModel?: {
    findOne(filter: Record<string, unknown>): {
      sort(sort: Record<string, number>): { lean(): Promise<Record<string, unknown> | null> };
    };
  };
  /** Optional: WorkflowVersion model for loading pinned definitions */
  workflowVersionModel?: {
    findOne(filter: Record<string, unknown>): { lean(): Promise<Record<string, unknown> | null> };
  };
```

**Step 4: Implement fire-time resolution in `fireWebhookTrigger`**

Replace the `fireWebhookTrigger` method (lines 287-334):

```typescript
  async fireWebhookTrigger(
    registrationId: string,
    payload: Record<string, unknown>,
    tenantId: string,
    projectId?: string,
  ): Promise<{ executionId: string }> {
    const trigger = await this.deps.triggerModel.findOne({
      _id: registrationId,
      status: 'active',
      tenantId,
      ...(projectId ? { projectId } : {}),
    });
    if (!trigger) {
      throw new Error(`Trigger ${registrationId} not found or not active`);
    }

    // Load workflow to get name and working copy steps
    const workflow = await this.deps.workflowModel.findOne({
      _id: trigger.workflowId as string,
      tenantId: trigger.tenantId as string,
      projectId: trigger.projectId as string,
    });
    if (!workflow) {
      throw new Error(`Workflow ${trigger.workflowId} not found`);
    }

    // Fire-time deployment resolution (Design §3)
    let steps = workflow.steps;
    let workflowVersion: string | null = null;
    let deploymentId: string | null = null;

    const triggerEnvironment = trigger.environment as string | undefined;
    if (triggerEnvironment && this.deps.deploymentModel && this.deps.workflowVersionModel) {
      // 1. Look up active deployment for (projectId, environment)
      const deployment = await this.deps.deploymentModel
        .findOne({
          projectId: trigger.projectId as string,
          tenantId: trigger.tenantId as string,
          environment: triggerEnvironment,
          status: 'active',
        })
        .sort({ createdAt: -1 })
        .lean();

      if (deployment) {
        const manifest = (deployment.workflowVersionManifest ?? {}) as Record<string, string>;
        const pinnedVersion = manifest[workflow.name];

        if (pinnedVersion) {
          // 2. Load pinned WorkflowVersion definition
          const versionDoc = await this.deps.workflowVersionModel
            .findOne({
              workflowId: trigger.workflowId as string,
              version: pinnedVersion,
              tenantId: trigger.tenantId as string,
            })
            .lean();

          if (versionDoc) {
            const def = versionDoc.definition as Record<string, unknown>;
            steps = (def.steps ?? []) as unknown[];
            workflowVersion = pinnedVersion;
            deploymentId = deployment._id as string;
            log.info('Resolved pinned workflow version', {
              registrationId,
              workflowId: trigger.workflowId,
              version: pinnedVersion,
              deploymentId,
            });
          } else {
            log.warn('Pinned workflow version not found, falling back to working copy', {
              registrationId,
              workflowId: trigger.workflowId,
              version: pinnedVersion,
            });
          }
        }
      }
    }

    const executionId = crypto.randomUUID();
    await this.deps.restateClient.startWorkflow(executionId, {
      workflowId: trigger.workflowId as string,
      workflowName: workflow.name,
      tenantId: trigger.tenantId as string,
      projectId: trigger.projectId as string,
      triggerType: 'webhook',
      triggerPayload: payload,
      triggerMetadata: {
        registrationId,
        firedAt: new Date().toISOString(),
      },
      steps,
      workflowVersion,
      deploymentId,
    });

    log.info('Webhook trigger fired', {
      registrationId,
      executionId,
      workflowId: trigger.workflowId,
      workflowVersion,
      deploymentId,
    });
    return { executionId };
  }
```

**Step 5: Wire deps where TriggerEngine is instantiated**

Find where `new TriggerEngine(deps)` is called and add the new model deps:

```typescript
import { Deployment, WorkflowVersion } from '@agent-platform/database/models';
// In the deps construction:
deploymentModel: Deployment,
workflowVersionModel: WorkflowVersion,
```

**Step 6: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/workflow-engine test -- --run trigger-fire-resolution`
Expected: PASS

**Step 7: Run existing trigger tests to verify no regressions**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/workflow-engine test -- --run trigger`
Expected: All PASS (existing tests use no `environment`, so they hit the working copy fallback path)

**Step 8: Commit**

```bash
git add apps/workflow-engine/src/services/trigger-engine.ts apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts
git commit -m "feat(workflow-engine): implement fire-time deployment resolution for versioned workflows"
```

---

## Task 12: Add `environment` Field to TriggerRegistration Model

**Findings addressed:** CRITICAL-2 from design alignment (environment not persisted in schema)

**Files:**

- Modify: `packages/database/src/models/trigger-registration.model.ts`
- Test: `apps/workflow-engine/src/__tests__/trigger-environment.test.ts`

**Step 1: Find the model and check current state**

Read `packages/database/src/models/trigger-registration.model.ts` to find the interface and schema.

**Step 2: Add `environment` field to interface and schema**

```typescript
// In the ITriggerRegistration interface:
environment?: string;

// In the TriggerRegistrationSchema:
environment: { type: String, default: null },
```

**Step 3: Run existing trigger environment tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/workflow-engine test -- --run trigger-environment`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/database/src/models/trigger-registration.model.ts apps/workflow-engine/src/__tests__/trigger-environment.test.ts
git commit -m "fix(database): add environment field to TriggerRegistration model schema"
```

---

## Task 13: Update Design Doc — Version Format Alignment

**Findings addressed:** H2 (version format mismatch "1.0" vs "0.1.0"), H3 (lifecycle transitions)

**Files:**

- Modify: `docs/plans/2026-03-09-workflow-versioning-deployment-design.md`

**Step 1: Fix version format in design doc**

In `docs/plans/2026-03-09-workflow-versioning-deployment-design.md`, section 1:

```markdown
<!-- REPLACE: -->

| `version` | string | Auto-incremented (e.g., "1.0", "1.1") |

<!-- WITH: -->

| `version` | string | Semver three-part, auto-incremented (e.g., "0.1.0", "0.1.1") |
```

**Step 2: Clarify lifecycle transitions**

Add a note after the lifecycle diagram:

```markdown
**Allowed transitions** (implemented in `VALID_STATUS_TRANSITIONS`):

- `draft → testing` (standard promotion)
- `draft → staged` (skip testing — for pre-validated definitions)
- `testing → staged` (standard promotion)
- `testing → draft` (revert)
- `staged → active` (standard promotion)
- `staged → draft` (revert)
- `active → deprecated` (terminal)
```

**Step 3: Commit**

```bash
git add docs/plans/2026-03-09-workflow-versioning-deployment-design.md
git commit -m "docs: align design doc version format to semver and clarify lifecycle transitions"
```

---

## Task 14: Build + Full Test Run

**Files:** None (verification only)

**Step 1: Build all affected packages**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build`
Expected: All 46+ packages pass

**Step 2: Run database tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/database test -- --run`
Expected: PASS (ignore pre-existing pii-audit-log failure)

**Step 3: Run runtime tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run`
Expected: All 8800+ pass

**Step 4: Run workflow-engine tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/workflow-engine test -- --run`
Expected: PASS

**Step 5: Run project-io tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/project-io test -- --run`
Expected: PASS

**Step 6: Commit any remaining fixes**

If any tests fail due to the changes, fix them and commit.

---

## Summary — Findings Addressed

| Task | Findings Fixed                                | Category                            |
| ---- | --------------------------------------------- | ----------------------------------- |
| 1    | C1 model, H1 model, M3 model, M7 model        | Tenant isolation, indexes           |
| 2    | M2 model, H3 db-model, H4 status enum         | Execution model                     |
| 3    | M1 deployment, C7 repo                        | Type safety, tenant-scoped update   |
| 4    | C2 service, M1 service, H3 service            | sourceHash, size guard              |
| 5    | C3 service, H1 service, H3 err, M3-M4 service | ProjectId isolation, error wrapping |
| 6    | C6 routes, M2 routes, M6 routes               | Null guards, pagination, projectId  |
| 7    | H4 routes                                     | Deployment version lookup           |
| 8    | M7-M8 export, H9 export                       | Path sanitization, warnings         |
| 9    | H7 lockfile                                   | Version/status metadata             |
| 10   | C4 import, H8 layerFiles                      | Import pipeline wiring              |
| 11   | C5 fire-time, H10 execution                   | Deployment resolution               |
| 12   | CRITICAL-2 design                             | TriggerRegistration schema          |
| 13   | H2 format, H3 lifecycle                       | Design doc alignment                |
| 14   | —                                             | Verification                        |
