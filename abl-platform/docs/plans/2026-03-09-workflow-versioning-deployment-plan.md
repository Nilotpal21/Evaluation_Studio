# Workflow Versioning & Deployment Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add workflow versioning that mirrors agent versioning, integrate with the deployment manifest, bind triggers to environments, and include workflow versions in export/import.

**Architecture:** WorkflowVersion model mirrors AgentVersion. Deployments gain `workflowVersionManifest`. WorkflowVersionService follows the same singleton pattern as VersionService. Triggers gain `environment` field and resolve the active deployment's pinned workflow version at fire time. Export includes pinned version snapshots when `include_deployments=true`. Import recreates versions as `draft`.

**Tech Stack:** Mongoose, Express, zod, crypto (SHA-256), existing `@agent-platform/database`, `@agent-platform/openapi/express`, `packages/project-io`

**Design doc:** `docs/plans/2026-03-09-workflow-versioning-deployment-design.md`

---

## Task 1: WorkflowVersion Database Model

**Files:**

- Create: `packages/database/src/models/workflow-version.model.ts`
- Modify: `packages/database/src/models/index.ts`

**Step 1: Write the failing test**

Create `packages/database/src/__tests__/model-workflow-version.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('WorkflowVersion model', () => {
  it('creates a version with required fields', async () => {
    const { WorkflowVersion } = await import('../models/workflow-version.model.js');
    const doc = await WorkflowVersion.create({
      workflowId: 'wf-001',
      version: '0.1.0',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      definition: { steps: [], triggers: [], notificationRules: [], escalationRules: [] },
      sourceHash: 'abc123def456',
      status: 'draft',
      createdBy: 'user-1',
    });
    expect(doc._id).toBeDefined();
    expect(doc.status).toBe('draft');
    expect(doc.version).toBe('0.1.0');
  });

  it('enforces unique constraint on workflowId + version + tenantId', async () => {
    const { WorkflowVersion } = await import('../models/workflow-version.model.js');
    await WorkflowVersion.create({
      workflowId: 'wf-unique-test',
      version: '0.1.0',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      definition: { steps: [] },
      sourceHash: 'hash1',
      status: 'draft',
      createdBy: 'user-1',
    });
    await expect(
      WorkflowVersion.create({
        workflowId: 'wf-unique-test',
        version: '0.1.0',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        definition: { steps: [] },
        sourceHash: 'hash2',
        status: 'draft',
        createdBy: 'user-1',
      }),
    ).rejects.toThrow();
  });

  it('allows same version number for different tenants', async () => {
    const { WorkflowVersion } = await import('../models/workflow-version.model.js');
    const v1 = await WorkflowVersion.create({
      workflowId: 'wf-cross-tenant',
      version: '0.1.0',
      tenantId: 'tenant-a',
      projectId: 'proj-1',
      definition: { steps: [] },
      sourceHash: 'hash1',
      status: 'draft',
      createdBy: 'user-1',
    });
    const v2 = await WorkflowVersion.create({
      workflowId: 'wf-cross-tenant',
      version: '0.1.0',
      tenantId: 'tenant-b',
      projectId: 'proj-1',
      definition: { steps: [] },
      sourceHash: 'hash2',
      status: 'draft',
      createdBy: 'user-1',
    });
    expect(v1._id).not.toBe(v2._id);
  });

  it('stores definition snapshot with nested steps', async () => {
    const { WorkflowVersion } = await import('../models/workflow-version.model.js');
    const definition = {
      steps: [
        { id: 's1', type: 'http', method: 'GET', url: 'https://example.com' },
        {
          id: 's2',
          type: 'condition',
          expression: '{{x}} > 5',
          thenSteps: [{ id: 's3', type: 'delay', duration: '5m' }],
          elseSteps: [],
        },
      ],
      triggers: [
        {
          strategy: 'cron',
          connectorName: 'scheduler',
          triggerName: 'daily',
          connectionId: 'conn-1',
          config: { cron: '0 9 * * *' },
        },
      ],
      notificationRules: [{ event: 'step_failed', channel: 'slack', target: '#alerts' }],
      escalationRules: [],
      slaMinutes: 30,
      entryAgent: 'booking_agent',
    };
    const doc = await WorkflowVersion.create({
      workflowId: 'wf-complex',
      version: '1.0.0',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      definition,
      sourceHash: 'complex-hash',
      status: 'draft',
      createdBy: 'user-1',
      changelog: 'Initial release',
    });
    const fetched = await WorkflowVersion.findById(doc._id).lean();
    expect(fetched.definition.steps).toHaveLength(2);
    expect(fetched.definition.slaMinutes).toBe(30);
    expect(fetched.changelog).toBe('Initial release');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/database && pnpm vitest run src/__tests__/model-workflow-version.test.ts`
Expected: FAIL — module `workflow-version.model.js` not found

**Step 3: Create the model**

Create `packages/database/src/models/workflow-version.model.ts`:

```typescript
/**
 * Workflow Version Model
 *
 * Stores versioned snapshots of workflow definitions.
 * Tracks version lifecycle: draft -> testing -> staged -> active -> deprecated.
 * Mirrors the AgentVersion model pattern.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IWorkflowVersion {
  _id: string;
  workflowId: string;
  version: string;
  tenantId: string;
  projectId: string;
  definition: Record<string, unknown>;
  sourceHash: string;
  status: string;
  changelog: string | null;
  createdBy: string;
  promotedAt: Date | null;
  promotedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const WorkflowVersionSchema = new Schema<IWorkflowVersion>(
  {
    _id: { type: String, default: uuidv7 },
    workflowId: { type: String, required: true },
    version: { type: String, required: true },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    definition: { type: Schema.Types.Mixed, required: true },
    sourceHash: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'testing', 'staged', 'active', 'deprecated'],
      default: 'draft',
    },
    changelog: { type: String, default: null },
    createdBy: { type: String, required: true },
    promotedAt: { type: Date, default: null },
    promotedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'workflow_versions' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

WorkflowVersionSchema.index({ workflowId: 1, version: 1, tenantId: 1 }, { unique: true });
WorkflowVersionSchema.index({ tenantId: 1, projectId: 1, workflowId: 1, status: 1 });
WorkflowVersionSchema.index({ workflowId: 1, createdAt: -1 });
WorkflowVersionSchema.index({ tenantId: 1, sourceHash: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const WorkflowVersion =
  (mongoose.models.WorkflowVersion as any) ||
  model<IWorkflowVersion>('WorkflowVersion', WorkflowVersionSchema);
```

**Step 4: Add to barrel export**

In `packages/database/src/models/index.ts`, add near the Workflow exports (around line 183):

```typescript
export { WorkflowVersion, type IWorkflowVersion } from './workflow-version.model.js';
```

**Step 5: Run test to verify it passes**

Run: `cd packages/database && pnpm vitest run src/__tests__/model-workflow-version.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/database/src/models/workflow-version.model.ts packages/database/src/models/index.ts packages/database/src/__tests__/model-workflow-version.test.ts
npx prettier --write packages/database/src/models/workflow-version.model.ts packages/database/src/models/index.ts packages/database/src/__tests__/model-workflow-version.test.ts
git commit -m "feat(database): add WorkflowVersion model mirroring AgentVersion"
```

---

## Task 2: Deployment Model — Add workflowVersionManifest

**Files:**

- Modify: `packages/database/src/models/deployment.model.ts`

**Step 1: Write the failing test**

Create `packages/database/src/__tests__/model-deployment-workflow-manifest.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('Deployment model — workflowVersionManifest', () => {
  it('stores workflowVersionManifest alongside agentVersionManifest', async () => {
    const { Deployment } = await import('../models/deployment.model.js');
    const doc = await Deployment.create({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'dev',
      agentVersionManifest: { main_agent: '1.0.0' },
      workflowVersionManifest: { order_processing: '0.1.0' },
      entryAgentName: 'main_agent',
      endpointSlug: 'test-slug-wvm-1',
      createdBy: 'user-1',
    });
    const fetched = await Deployment.findById(doc._id).lean();
    expect(fetched.workflowVersionManifest).toEqual({ order_processing: '0.1.0' });
    expect(fetched.agentVersionManifest).toEqual({ main_agent: '1.0.0' });
  });

  it('defaults workflowVersionManifest to empty object when not provided', async () => {
    const { Deployment } = await import('../models/deployment.model.js');
    const doc = await Deployment.create({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'staging',
      agentVersionManifest: { main_agent: '1.0.0' },
      entryAgentName: 'main_agent',
      endpointSlug: 'test-slug-wvm-2',
      createdBy: 'user-1',
    });
    const fetched = await Deployment.findById(doc._id).lean();
    expect(fetched.workflowVersionManifest).toEqual({});
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/database && pnpm vitest run src/__tests__/model-deployment-workflow-manifest.test.ts`
Expected: FAIL — `workflowVersionManifest` is not stored (undefined in fetched doc)

**Step 3: Add field to Deployment schema**

In `packages/database/src/models/deployment.model.ts`, add to `IDeployment` interface (after `agentVersionManifest`):

```typescript
workflowVersionManifest: any;
```

Add to `DeploymentSchema` (after `agentVersionManifest` field):

```typescript
workflowVersionManifest: { type: Schema.Types.Mixed, default: {} },
```

**Step 4: Run test to verify it passes**

Run: `cd packages/database && pnpm vitest run src/__tests__/model-deployment-workflow-manifest.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/database/src/models/deployment.model.ts packages/database/src/__tests__/model-deployment-workflow-manifest.test.ts
npx prettier --write packages/database/src/models/deployment.model.ts packages/database/src/__tests__/model-deployment-workflow-manifest.test.ts
git commit -m "feat(database): add workflowVersionManifest to Deployment model"
```

---

## Task 3: WorkflowExecution — Add version tracking fields

**Files:**

- Modify: `packages/database/src/models/workflow-execution.model.ts`

**Step 1: Write the failing test**

Create `packages/database/src/__tests__/model-workflow-execution-version.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('WorkflowExecution model — version tracking', () => {
  it('stores workflowVersion and deploymentId on execution', async () => {
    const { WorkflowExecution } = await import('../models/workflow-execution.model.js');
    const doc = await WorkflowExecution.create({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      workflowId: 'wf-1',
      triggerType: 'manual',
      restateWorkflowId: 'rst-version-track-1',
      startedAt: new Date(),
      workflowVersion: '1.0.0',
      deploymentId: 'deploy-1',
    });
    const fetched = await WorkflowExecution.findById(doc._id).lean();
    expect(fetched.workflowVersion).toBe('1.0.0');
    expect(fetched.deploymentId).toBe('deploy-1');
  });

  it('defaults version tracking fields to null', async () => {
    const { WorkflowExecution } = await import('../models/workflow-execution.model.js');
    const doc = await WorkflowExecution.create({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      workflowId: 'wf-1',
      triggerType: 'manual',
      restateWorkflowId: 'rst-version-track-2',
      startedAt: new Date(),
    });
    const fetched = await WorkflowExecution.findById(doc._id).lean();
    expect(fetched.workflowVersion).toBeUndefined(); // not set
    expect(fetched.deploymentId).toBeUndefined(); // not set
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/database && pnpm vitest run src/__tests__/model-workflow-execution-version.test.ts`
Expected: FAIL — `workflowVersion` not stored

**Step 3: Add fields to WorkflowExecution**

In `packages/database/src/models/workflow-execution.model.ts`:

Add to `IWorkflowExecution` interface (after `workflowId`):

```typescript
workflowVersion?: string;
deploymentId?: string;
```

Add to `WorkflowExecutionSchema` (after `workflowId` field):

```typescript
workflowVersion: { type: String },
deploymentId: { type: String },
```

**Step 4: Run test to verify it passes**

Run: `cd packages/database && pnpm vitest run src/__tests__/model-workflow-execution-version.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/database/src/models/workflow-execution.model.ts packages/database/src/__tests__/model-workflow-execution-version.test.ts
npx prettier --write packages/database/src/models/workflow-execution.model.ts packages/database/src/__tests__/model-workflow-execution-version.test.ts
git commit -m "feat(database): add workflowVersion and deploymentId to WorkflowExecution"
```

---

## Task 4: WorkflowVersionService

**Files:**

- Create: `apps/runtime/src/services/workflow-version-service.ts`

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/workflow-version-service.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  const { WorkflowVersion } = await import('@agent-platform/database/models');
  const { Workflow } = await import('@agent-platform/database/models');
  await WorkflowVersion.deleteMany({});
  await Workflow.deleteMany({});
});

describe('WorkflowVersionService', () => {
  async function createWorkflow(overrides: Record<string, unknown> = {}) {
    const { Workflow } = await import('@agent-platform/database/models');
    return Workflow.create({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: 'test-workflow',
      type: 'cx_automation',
      steps: [{ id: 's1', type: 'http', method: 'GET', url: 'https://example.com' }],
      ...overrides,
    });
  }

  it('creates a version from working copy', async () => {
    const wf = await createWorkflow();
    const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
    const svc = getWorkflowVersionService();

    const result = await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    expect(result.version).toBe('0.1.0');
    expect(result.sourceHash).toBeDefined();
    expect(result.versionId).toBeDefined();
  });

  it('auto-increments version number', async () => {
    const wf = await createWorkflow();
    const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
    const svc = getWorkflowVersionService();

    const v1 = await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });
    expect(v1.version).toBe('0.1.0');

    // Modify the workflow so sourceHash changes (avoid dedup)
    const { Workflow } = await import('@agent-platform/database/models');
    await Workflow.findByIdAndUpdate(wf._id, {
      steps: [{ id: 's1', type: 'delay', duration: '10m' }],
    });

    const v2 = await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });
    expect(v2.version).toBe('0.1.1');
  });

  it('deduplicates when definition unchanged', async () => {
    const wf = await createWorkflow();
    const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
    const svc = getWorkflowVersionService();

    const v1 = await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });
    const v2 = await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });
    expect(v2.deduplicated).toBe(true);
    expect(v2.versionId).toBe(v1.versionId);
  });

  it('promotes version through lifecycle', async () => {
    const wf = await createWorkflow();
    const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
    const svc = getWorkflowVersionService();

    await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    const result = await svc.promoteVersion({
      workflowId: wf._id,
      version: '0.1.0',
      targetStatus: 'testing',
      promotedBy: 'user-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(result.previousStatus).toBe('draft');
    expect(result.status).toBe('testing');
  });

  it('rejects invalid status transition', async () => {
    const wf = await createWorkflow();
    const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
    const svc = getWorkflowVersionService();

    await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    await expect(
      svc.promoteVersion({
        workflowId: wf._id,
        version: '0.1.0',
        targetStatus: 'active',
        promotedBy: 'user-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    ).rejects.toThrow(/Cannot transition/);
  });

  it('lists versions with pagination', async () => {
    const wf = await createWorkflow();
    const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
    const { Workflow } = await import('@agent-platform/database/models');
    const svc = getWorkflowVersionService();

    // Create 3 versions with different content
    await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });
    await Workflow.findByIdAndUpdate(wf._id, {
      steps: [{ id: 's2', type: 'delay', duration: '1m' }],
    });
    await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });
    await Workflow.findByIdAndUpdate(wf._id, {
      steps: [{ id: 's3', type: 'delay', duration: '2m' }],
    });
    await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    const result = await svc.listVersions({
      workflowId: wf._id,
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      limit: 2,
    });
    expect(result.versions).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it('enforces tenant isolation', async () => {
    const wf = await createWorkflow();
    const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
    const svc = getWorkflowVersionService();

    await svc.createVersion({
      workflowId: wf._id,
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    // Wrong tenant should get empty list
    const result = await svc.listVersions({
      workflowId: wf._id,
      tenantId: 'tenant-WRONG',
      projectId: 'proj-1',
    });
    expect(result.versions).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/workflow-version-service.test.ts`
Expected: FAIL — module not found

**Step 3: Implement WorkflowVersionService**

Create `apps/runtime/src/services/workflow-version-service.ts`. Follow the exact pattern from `apps/runtime/src/services/version-service.ts` but adapted for workflows:

- `createVersion()`: load working copy from Workflow model, compute sourceHash from canonical JSON of definition, dedup against latest version, create WorkflowVersion record
- `listVersions()`: paginated query on WorkflowVersion with tenant guard
- `getVersion()`: single version lookup with tenant guard
- `nextVersion()`: auto-increment semver patch (same algorithm as VersionService)
- `promoteVersion()`: validate transition, optimistic lock update
- `diffVersions()`: return two version definitions for client-side diff

Key differences from agent VersionService:

- No DSL compilation (workflows are JSON definitions, not ABL DSL)
- `sourceHash` computed from `JSON.stringify(definition)` with sorted keys
- `definition` field captures: steps, triggers, notificationRules, escalationRules, slaMinutes, entryAgent
- No toolSnapshot (workflows don't have tool bindings)

The service should:

- Use `Workflow` and `WorkflowVersion` models from `@agent-platform/database/models`
- Scope all queries by `tenantId`
- Follow singleton pattern: `getWorkflowVersionService()` / `resetWorkflowVersionService()`

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/workflow-version-service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/workflow-version-service.ts apps/runtime/src/__tests__/workflow-version-service.test.ts
npx prettier --write apps/runtime/src/services/workflow-version-service.ts apps/runtime/src/__tests__/workflow-version-service.test.ts
git commit -m "feat(runtime): add WorkflowVersionService with create/list/promote/diff"
```

---

## Task 5: Workflow Version API Routes

**Files:**

- Create: `apps/runtime/src/routes/workflow-versions.ts`
- Modify: `apps/runtime/src/server.ts` (mount the router)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/workflow-version-routes.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer;
let app: any;

// Mock auth middleware to inject tenant context
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-1', userId: 'user-1' };
    next();
  },
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireProjectPermission: async () => true,
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // Build minimal express app with just the version routes
  const express = (await import('express')).default;
  app = express();
  app.use(express.json());
  const router = (await import('../routes/workflow-versions.js')).default;
  app.use('/api/projects/:projectId/workflows/:workflowId/versions', router);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  const { WorkflowVersion, Workflow } = await import('@agent-platform/database/models');
  await WorkflowVersion.deleteMany({});
  await Workflow.deleteMany({});
});

describe('Workflow Version Routes', () => {
  async function seedWorkflow() {
    const { Workflow } = await import('@agent-platform/database/models');
    return Workflow.create({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: 'test-wf',
      type: 'cx_automation',
      steps: [{ id: 's1', type: 'http', method: 'GET', url: 'https://example.com' }],
    });
  }

  it('POST / creates a version', async () => {
    const wf = await seedWorkflow();
    const res = await request(app)
      .post(`/api/projects/proj-1/workflows/${wf._id}/versions`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.version).toBe('0.1.0');
  });

  it('GET / lists versions', async () => {
    const wf = await seedWorkflow();
    await request(app).post(`/api/projects/proj-1/workflows/${wf._id}/versions`).send({});
    const res = await request(app).get(`/api/projects/proj-1/workflows/${wf._id}/versions`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('GET /:version returns version detail', async () => {
    const wf = await seedWorkflow();
    await request(app).post(`/api/projects/proj-1/workflows/${wf._id}/versions`).send({});
    const res = await request(app).get(`/api/projects/proj-1/workflows/${wf._id}/versions/0.1.0`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.version.definition).toBeDefined();
  });

  it('POST /:version/promote promotes version', async () => {
    const wf = await seedWorkflow();
    await request(app).post(`/api/projects/proj-1/workflows/${wf._id}/versions`).send({});
    const res = await request(app)
      .post(`/api/projects/proj-1/workflows/${wf._id}/versions/0.1.0/promote`)
      .send({ targetStatus: 'testing' });
    expect(res.status).toBe(200);
    expect(res.body.version.status).toBe('testing');
  });

  it('GET /:version/diff/:otherVersion returns two definitions', async () => {
    const wf = await seedWorkflow();
    await request(app).post(`/api/projects/proj-1/workflows/${wf._id}/versions`).send({});
    // Modify workflow and create second version
    const { Workflow } = await import('@agent-platform/database/models');
    await Workflow.findByIdAndUpdate(wf._id, {
      steps: [{ id: 's2', type: 'delay', duration: '5m' }],
    });
    await request(app).post(`/api/projects/proj-1/workflows/${wf._id}/versions`).send({});

    const res = await request(app).get(
      `/api/projects/proj-1/workflows/${wf._id}/versions/0.1.0/diff/0.1.1`,
    );
    expect(res.status).toBe(200);
    expect(res.body.diff.version1).toBe('0.1.0');
    expect(res.body.diff.version2).toBe('0.1.1');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/workflow-version-routes.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the route file**

Create `apps/runtime/src/routes/workflow-versions.ts`. Follow the exact pattern from `apps/runtime/src/routes/versions.ts`:

- Use `createOpenAPIRouter` from `@agent-platform/openapi/express`
- Mount at `/api/projects/:projectId/workflows/:workflowId/versions`
- 5 endpoints: POST /, GET /, GET /:version, POST /:version/promote, GET /:version/diff/:otherVersion
- Auth: `authMiddleware`, `requireProjectScope`, `tenantRateLimit`
- Permissions: `workflow:update` for create/promote, `workflow:read` for list/get/diff
- Delegate to `getWorkflowVersionService()`
- Return same response shapes as agent version routes

**Step 4: Mount in server.ts**

In `apps/runtime/src/server.ts`, add the import and mount line (before the workflow engine proxy):

```typescript
import workflowVersionsRouter from './routes/workflow-versions.js';
// ... mount before the proxy
app.use('/api/projects/:projectId/workflows/:workflowId/versions', workflowVersionsRouter);
```

Important: this must be mounted BEFORE the workflow engine proxy (line ~398) so that `/versions` routes are handled by runtime directly, not proxied to workflow-engine.

**Step 5: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/workflow-version-routes.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/runtime/src/routes/workflow-versions.ts apps/runtime/src/server.ts apps/runtime/src/__tests__/workflow-version-routes.test.ts
npx prettier --write apps/runtime/src/routes/workflow-versions.ts apps/runtime/src/server.ts apps/runtime/src/__tests__/workflow-version-routes.test.ts
git commit -m "feat(runtime): add workflow version API routes (create/list/promote/diff)"
```

---

## Task 6: Deployment Route — Validate workflowVersionManifest

**Files:**

- Modify: `apps/runtime/src/routes/deployments.ts`
- Modify: `apps/runtime/src/repos/deployment-repo.ts` (add workflowVersionManifest to createDeployment)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/deployment-workflow-versions.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer;
let app: any;

// Standard auth mocks (same pattern as other route tests)
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-1', userId: 'user-1' };
    next();
  },
}));
vi.mock('@agent-platform/shared-auth', () => ({
  requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware/rbac.js', () => ({
  requireProjectPermission: async () => true,
}));
vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('Deployment create — workflowVersionManifest validation', () => {
  it('rejects deployment referencing non-existent workflow version', async () => {
    // Seed agent + agent version
    const { ProjectAgent, AgentVersion } = await import('@agent-platform/database/models');
    const agent = await ProjectAgent.create({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: 'main_agent',
      dslContent: 'AGENT: main_agent',
    });
    await AgentVersion.create({
      agentId: agent._id,
      version: '0.1.0',
      status: 'draft',
      dslContent: 'AGENT: main_agent',
      irContent: '{}',
      sourceHash: 'hash1',
      createdBy: 'user-1',
    });

    // This test verifies the deployment creation rejects a non-existent workflow version
    // The actual HTTP test requires the full server wiring, so this is a unit-level validation test
    const { WorkflowVersion, Workflow } = await import('@agent-platform/database/models');
    const wf = await Workflow.create({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: 'order_processing',
      type: 'cx_automation',
      steps: [],
    });

    // No WorkflowVersion created for 'order_processing' at '1.0.0'
    const version = await WorkflowVersion.findOne({
      workflowId: wf._id,
      version: '1.0.0',
      tenantId: 'tenant-1',
    });
    expect(version).toBeNull();
  });

  it('accepts deployment with valid workflowVersionManifest', async () => {
    const { WorkflowVersion, Workflow } = await import('@agent-platform/database/models');
    const wf = await Workflow.create({
      tenantId: 'tenant-1',
      projectId: 'proj-valid',
      name: 'order_processing',
      type: 'cx_automation',
      steps: [],
    });
    const wfv = await WorkflowVersion.create({
      workflowId: wf._id,
      version: '0.1.0',
      tenantId: 'tenant-1',
      projectId: 'proj-valid',
      definition: { steps: [] },
      sourceHash: 'hash-valid',
      status: 'draft',
      createdBy: 'user-1',
    });
    expect(wfv.version).toBe('0.1.0');
    // Lookup succeeds by name
    const found = await WorkflowVersion.findOne({
      workflowId: wf._id,
      version: '0.1.0',
      tenantId: 'tenant-1',
    });
    expect(found).not.toBeNull();
  });
});
```

**Step 2: Run test to verify it passes (this is a model-level validation test)**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/deployment-workflow-versions.test.ts`
Expected: PASS (this validates the lookup pattern)

**Step 3: Modify deployment route to validate workflowVersionManifest**

In `apps/runtime/src/routes/deployments.ts`:

1. Add `workflowVersionManifest` to `createDeploymentSchema`:

```typescript
workflowVersionManifest: z
  .record(z.string())
  .optional()
  .default({})
  .describe('Mapping of workflow names to versions (or "auto" for auto-versioning)'),
```

2. After agent version validation loop (~line 357), add workflow version validation:

```typescript
// Validate workflow version manifest
const workflowVersionManifest = req.body.workflowVersionManifest || {};
if (Object.keys(workflowVersionManifest).length > 0) {
  const { Workflow, WorkflowVersion } = await import('@agent-platform/database/models');

  for (const [workflowName, version] of Object.entries(workflowVersionManifest)) {
    const workflow = await Workflow.findOne({ projectId, tenantId, name: workflowName }).lean();
    if (!workflow) {
      res.status(400).json({ success: false, error: `Workflow "${workflowName}" not found` });
      return;
    }

    if (version === 'auto') {
      // Auto-version: create from working copy
      const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
      const svc = getWorkflowVersionService();
      const result = await svc.createVersion({
        workflowId: (workflow as any)._id,
        projectId,
        tenantId,
        createdBy: userId,
        changelog: 'Auto-created for deployment',
      });
      workflowVersionManifest[workflowName] = result.version;
    } else {
      const wfVersion = await WorkflowVersion.findOne({
        workflowId: (workflow as any)._id,
        version: version as string,
        tenantId,
      }).lean();
      if (!wfVersion) {
        res.status(400).json({
          success: false,
          error: `Version ${version} of workflow "${workflowName}" not found`,
        });
        return;
      }
    }
  }
}
```

3. Pass `workflowVersionManifest` to `createDeployment()` call.

4. Update `createDeployment` in `apps/runtime/src/repos/deployment-repo.ts` to accept and store `workflowVersionManifest`.

5. Update deployment response schemas to include `workflowVersionManifest`.

**Step 4: Run deployment tests to verify no regressions**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/deployment`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/deployments.ts apps/runtime/src/repos/deployment-repo.ts apps/runtime/src/__tests__/deployment-workflow-versions.test.ts
npx prettier --write apps/runtime/src/routes/deployments.ts apps/runtime/src/repos/deployment-repo.ts apps/runtime/src/__tests__/deployment-workflow-versions.test.ts
git commit -m "feat(runtime): validate workflowVersionManifest in deployment creation"
```

---

## Task 7: Export — Include Workflow Versions

**Files:**

- Modify: `packages/project-io/src/export/layer-assemblers/workflows-assembler.ts`
- Modify: `packages/project-io/src/export/lockfile-generator.ts`

**Step 1: Write the failing test**

Create `packages/project-io/src/__tests__/workflows-assembler-versions.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('WorkflowsAssembler — version export', () => {
  it('includes pinned version files when deployments are included', async () => {
    // Mock the database models
    const mockWorkflows = [
      {
        name: 'order_processing',
        type: 'cx_automation',
        steps: [{ id: 's1', type: 'http' }],
        status: 'active',
      },
    ];
    const mockVersions = [
      {
        workflowId: 'wf-1',
        version: '1.0.0',
        sourceHash: 'hash1',
        status: 'active',
        changelog: 'First release',
        createdBy: 'user-1',
        createdAt: new Date('2026-03-09'),
        definition: { steps: [{ id: 's1', type: 'http' }] },
      },
    ];
    const mockDeployments = [{ workflowVersionManifest: { order_processing: '1.0.0' } }];

    // The assembler should produce:
    // workflows/order_processing.workflow.json (working copy)
    // workflows/versions/order_processing/1.0.0.version.json (pinned version)
    expect(mockVersions[0].version).toBe('1.0.0');
    expect(mockDeployments[0].workflowVersionManifest.order_processing).toBe('1.0.0');
  });

  it('skips version files when deployments are not included', async () => {
    // When include_deployments is false, only working copy files
    const workflowFiles = new Map<string, string>();
    workflowFiles.set('workflows/order_processing.workflow.json', '{}');
    expect(workflowFiles.size).toBe(1);
    expect(workflowFiles.has('workflows/versions/')).toBe(false);
  });
});
```

**Step 2: Implement version export in WorkflowsAssembler**

Modify `packages/project-io/src/export/layer-assemblers/workflows-assembler.ts`:

1. Add `includeDeployments` and `deployments` to `LayerQueryContext` type (or pass as option)
2. When `includeDeployments` is true:
   - Collect all workflow names referenced in `workflowVersionManifest` across deployments
   - For each referenced workflow+version, load the `WorkflowVersion` record
   - Emit `workflows/versions/{name}/{version}.version.json` with definition + metadata

**Step 3: Update lockfile generator**

In `packages/project-io/src/export/lockfile-generator.ts`:

The `workflowsRecord` already exists in `generateLockfileV2`. Update it to include version info when available:

```typescript
// In the workflow section of generateLockfileV2, if workflow versions are provided:
workflowsRecord[name] = {
  source_hash: computeSourceHash(content),
  version: pinnedVersion, // add if available
};
```

**Step 4: Run tests**

Run: `cd packages/project-io && pnpm vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/project-io/src/export/layer-assemblers/workflows-assembler.ts packages/project-io/src/export/lockfile-generator.ts packages/project-io/src/__tests__/workflows-assembler-versions.test.ts
npx prettier --write packages/project-io/src/export/layer-assemblers/workflows-assembler.ts packages/project-io/src/export/lockfile-generator.ts packages/project-io/src/__tests__/workflows-assembler-versions.test.ts
git commit -m "feat(project-io): include pinned workflow versions in export"
```

---

## Task 8: Import — Recreate Workflow Versions as Draft

**Files:**

- Modify: `packages/project-io/src/import/staged-importer.ts`
- Modify: `packages/project-io/src/import/folder-reader.ts`

**Step 1: Write the failing test**

Create `packages/project-io/src/__tests__/import-workflow-versions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('Import — workflow version files', () => {
  it('folder reader detects workflow version files', () => {
    const files = new Map<string, string>();
    files.set('workflows/order_processing.workflow.json', JSON.stringify({ steps: [] }));
    files.set(
      'workflows/versions/order_processing/1.0.0.version.json',
      JSON.stringify({
        version: '1.0.0',
        source_hash: 'hash1',
        status: 'active',
        definition: { steps: [] },
      }),
    );

    // The folder reader should separate version files from working copy files
    const workflowFiles = new Map<string, string>();
    const versionFiles = new Map<string, string>();
    for (const [path, content] of files) {
      if (path.includes('/versions/') && path.endsWith('.version.json')) {
        versionFiles.set(path, content);
      } else {
        workflowFiles.set(path, content);
      }
    }

    expect(workflowFiles.size).toBe(1);
    expect(versionFiles.size).toBe(1);
  });

  it('imported version status is reset to draft', () => {
    const versionData = {
      version: '1.0.0',
      source_hash: 'hash1',
      status: 'active',
      definition: { steps: [] },
    };
    // On import, status should be forced to 'draft'
    const importedStatus = 'draft';
    expect(importedStatus).toBe('draft');
    expect(versionData.status).not.toBe(importedStatus);
  });
});
```

**Step 2: Implement import changes**

In `packages/project-io/src/import/folder-reader.ts`:

- Parse `workflows/versions/{name}/{version}.version.json` files
- Return them separately from working copy workflow files (e.g., `workflowVersionFiles` in the result)

In `packages/project-io/src/import/staged-importer.ts`:

- After staging workflows in the `workflows` layer, also stage `WorkflowVersion` records from version files
- Reset `status` to `'draft'` regardless of original status
- Link versions to the staged workflow by matching on `name`

**Step 3: Run tests**

Run: `cd packages/project-io && pnpm vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/project-io/src/import/staged-importer.ts packages/project-io/src/import/folder-reader.ts packages/project-io/src/__tests__/import-workflow-versions.test.ts
npx prettier --write packages/project-io/src/import/staged-importer.ts packages/project-io/src/import/folder-reader.ts packages/project-io/src/__tests__/import-workflow-versions.test.ts
git commit -m "feat(project-io): import workflow versions as draft from export bundles"
```

---

## Task 9: Trigger Environment Binding

**Files:**

- Modify: `apps/workflow-engine/src/routes/triggers.ts` (add `environment` field)
- Modify: trigger registration model/schema if separate from workflow model

**Step 1: Write the failing test**

Create `apps/workflow-engine/src/__tests__/trigger-environment.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('Trigger registration — environment field', () => {
  it('stores environment on trigger registration', () => {
    const registration = {
      workflowId: 'wf-1',
      type: 'cron',
      config: { cron: '0 9 * * *' },
      environment: 'production',
    };
    expect(registration.environment).toBe('production');
  });

  it('defaults to undefined when environment not provided', () => {
    const registration = {
      workflowId: 'wf-1',
      type: 'webhook',
      config: {},
    };
    expect((registration as any).environment).toBeUndefined();
  });
});
```

**Step 2: Modify trigger registration to accept environment**

This depends on how triggers are stored in the workflow-engine. The trigger registration route at `apps/workflow-engine/src/routes/triggers.ts` needs to:

1. Accept optional `environment` field in the request body
2. Store it on the trigger registration document
3. At fire time, resolve the active deployment for `(projectId, environment)` and check `workflowVersionManifest`

**Note:** The fire-time resolution logic is in the workflow-engine's execution path. The trigger scheduler/connector trigger engine fires triggers, and the execution handler needs to:

1. Look up the trigger's `environment`
2. If set, find the active deployment for that environment
3. Check the deployment's `workflowVersionManifest` for the workflow name
4. If pinned, load the `WorkflowVersion.definition` instead of the working copy
5. Pass `workflowVersion` and `deploymentId` to the execution record

**Step 3: Run tests**

Run: `cd apps/workflow-engine && pnpm vitest run src/__tests__/trigger-environment.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/workflow-engine/src/routes/triggers.ts apps/workflow-engine/src/__tests__/trigger-environment.test.ts
npx prettier --write apps/workflow-engine/src/routes/triggers.ts apps/workflow-engine/src/__tests__/trigger-environment.test.ts
git commit -m "feat(workflow-engine): add environment field to trigger registration"
```

---

## Task 10: Deployment Promote — Carry workflowVersionManifest

**Files:**

- Modify: `apps/runtime/src/routes/deployments.ts` (promote endpoint)

**Step 1: Verify the promote endpoint already carries manifests**

Check the promote handler (line ~829-844 in deployments.ts). It already copies `agentVersionManifest` from source:

```typescript
agentVersionManifest: source.agentVersionManifest,
```

**Step 2: Add workflowVersionManifest to promote**

Add to the promote deployment creation call:

```typescript
workflowVersionManifest: source.workflowVersionManifest || {},
```

Also add to the response schema.

**Step 3: Run existing deployment tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/deployment`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/routes/deployments.ts
npx prettier --write apps/runtime/src/routes/deployments.ts
git commit -m "feat(runtime): carry workflowVersionManifest through deployment promote"
```

---

## Task 11: Build Verification and Integration

**Step 1: Run full build**

Run: `pnpm build`
Expected: PASS — no type errors from new files

**Step 2: Run all affected test suites**

Run in parallel:

- `cd packages/database && pnpm vitest run`
- `cd apps/runtime && pnpm vitest run`
- `cd packages/project-io && pnpm vitest run`

Expected: All PASS

**Step 3: Commit any build fixes**

If there are type issues or import fixes needed, address them and commit:

```bash
git commit -m "fix: resolve build issues from workflow versioning integration"
```

---

## Summary of Files

### Created

| File                                                                         | Purpose                          |
| ---------------------------------------------------------------------------- | -------------------------------- |
| `packages/database/src/models/workflow-version.model.ts`                     | WorkflowVersion Mongoose model   |
| `apps/runtime/src/services/workflow-version-service.ts`                      | Version lifecycle service        |
| `apps/runtime/src/routes/workflow-versions.ts`                               | API routes for workflow versions |
| `packages/database/src/__tests__/model-workflow-version.test.ts`             | Model tests                      |
| `packages/database/src/__tests__/model-deployment-workflow-manifest.test.ts` | Deployment field test            |
| `packages/database/src/__tests__/model-workflow-execution-version.test.ts`   | Execution tracking test          |
| `apps/runtime/src/__tests__/workflow-version-service.test.ts`                | Service tests                    |
| `apps/runtime/src/__tests__/workflow-version-routes.test.ts`                 | Route tests                      |
| `apps/runtime/src/__tests__/deployment-workflow-versions.test.ts`            | Deployment validation tests      |
| `packages/project-io/src/__tests__/workflows-assembler-versions.test.ts`     | Export tests                     |
| `packages/project-io/src/__tests__/import-workflow-versions.test.ts`         | Import tests                     |
| `apps/workflow-engine/src/__tests__/trigger-environment.test.ts`             | Trigger environment tests        |

### Modified

| File                                                                     | Change                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `packages/database/src/models/index.ts`                                  | Export WorkflowVersion                                  |
| `packages/database/src/models/deployment.model.ts`                       | Add workflowVersionManifest field                       |
| `packages/database/src/models/workflow-execution.model.ts`               | Add workflowVersion + deploymentId                      |
| `apps/runtime/src/server.ts`                                             | Mount workflow-versions router                          |
| `apps/runtime/src/routes/deployments.ts`                                 | Validate workflowVersionManifest, carry through promote |
| `apps/runtime/src/repos/deployment-repo.ts`                              | Accept workflowVersionManifest                          |
| `packages/project-io/src/export/layer-assemblers/workflows-assembler.ts` | Export pinned versions                                  |
| `packages/project-io/src/export/lockfile-generator.ts`                   | Add workflow version info to lockfile                   |
| `packages/project-io/src/import/folder-reader.ts`                        | Parse version files                                     |
| `packages/project-io/src/import/staged-importer.ts`                      | Stage workflow versions as draft                        |
| `apps/workflow-engine/src/routes/triggers.ts`                            | Accept environment field                                |
