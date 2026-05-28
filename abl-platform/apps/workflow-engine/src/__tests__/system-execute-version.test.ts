/**
 * System Tests: POST /execute version resolution against real MongoDB.
 *
 * Closes GAP-11 — the earlier route-integration tests mocked
 * `workflowVersionModel`, so they could not catch schema-level issues
 * (soft-delete filters, unique indexes, tenant plugin behavior, UUIDv7
 * _id generation). This suite exercises the real `Workflow` and
 * `WorkflowVersion` Mongoose models backed by MongoMemoryServer,
 * through a real Express app with supertest.
 *
 * Only Restate and the Redis publisher are stubbed — the route handler,
 * Zod validation, Mongoose queries, and plugins all run for real.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  requireMongo,
} from './helpers/setup-mongo.js';
import { Workflow, WorkflowVersion } from '@agent-platform/database/models';
import { createWorkflowExecutionRouter } from '../routes/workflow-executions.js';

interface RestateStartCall {
  executionId: string;
  input: Record<string, unknown>;
}

function makeRestateStub(): {
  client: {
    startWorkflow: (executionId: string, input: Record<string, unknown>) => Promise<void>;
    cancelWorkflow: (executionId: string) => Promise<void>;
  };
  calls: RestateStartCall[];
} {
  const calls: RestateStartCall[] = [];
  return {
    client: {
      startWorkflow: async (executionId, input) => {
        calls.push({ executionId, input });
      },
      cancelWorkflow: async () => {
        /* noop */
      },
    },
    calls,
  };
}

function buildApp(
  restateClient: ReturnType<typeof makeRestateStub>['client'],
  tenantId: string,
  userId = 'user-sys-1',
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantContext = { tenantId, userId };
    next();
  });
  app.use(
    '/api/projects/:projectId/workflows/:workflowId/executions',
    createWorkflowExecutionRouter({
      executionModel: {
        find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
        findOne: async () => null,
        findOneAndUpdate: async () => null,
      } as any,
      workflowModel: Workflow as any,
      workflowVersionModel: WorkflowVersion as any,
      restateClient,
      publisher: { publish: vi.fn().mockResolvedValue(undefined) },
      humanTaskModel: { updateMany: vi.fn().mockResolvedValue(undefined) } as any,
    }),
  );
  return app;
}

// Minimal valid canvas: start → end, position required per schema.
const canvasNodes = [
  {
    id: 'start-1',
    nodeType: 'start',
    name: 'Start',
    position: { x: 0, y: 0 },
  },
  {
    id: 'end-1',
    nodeType: 'end',
    name: 'End',
    position: { x: 200, y: 0 },
    config: {
      outputMappings: [{ name: 'result', expression: '{{trigger.payload.key}}' }],
    },
  },
];
const canvasEdges = [{ id: 'edge-1', source: 'start-1', sourceHandle: 'default', target: 'end-1' }];

async function seedWorkflow(tenantId: string, projectId: string): Promise<string> {
  const doc = await Workflow.create({
    tenantId,
    projectId,
    name: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'cx_automation',
    status: 'active',
    nodes: canvasNodes,
    edges: canvasEdges,
    createdBy: 'test-user',
  });
  return doc._id as string;
}

async function seedVersion(params: {
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string;
  state?: 'active' | 'inactive';
  deleted?: boolean;
}): Promise<string> {
  const doc = await WorkflowVersion.create({
    tenantId: params.tenantId,
    projectId: params.projectId,
    workflowId: params.workflowId,
    version: params.version,
    definition: {
      nodes: canvasNodes,
      edges: canvasEdges,
    },
    sourceHash: `hash-${params.version}`,
    state: params.state,
    deleted: params.deleted ?? false,
    createdBy: 'test-user',
  });
  return doc._id as string;
}

beforeAll(async () => {
  await setupTestMongo();
}, 60_000);

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await teardownTestMongo();
});

describe('POST /execute — version resolution against real MongoDB', () => {
  const tenantId = 't-sys-1';
  const projectId = 'p-sys-1';

  it('explicit pin hit — runs the pinned version and annotates execution with resolved IDs', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    const versionId = await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: '1.4.2',
      state: 'inactive',
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ workflowVersionId: versionId, payload: { key: 'hello' } });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(calls).toHaveLength(1);
    const [{ input }] = calls;
    expect(input.workflowVersionId).toBe(versionId);
    expect(input.workflowVersion).toBe('1.4.2');
    expect(input.triggerPayload).toEqual({ key: 'hello' });
    // Steps and output mappings come from the version's definition
    expect(Array.isArray(input.steps)).toBe(true);
    expect(input.outputMappings).toEqual([
      { name: 'result', expression: '{{trigger.payload.key}}' },
    ]);
  });

  it('explicit pin miss — returns 404 WORKFLOW_VERSION_NOT_FOUND and never calls Restate', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    // Pin a valid UUID that does not correspond to any version.
    const missingVersionId = '00000000-0000-4000-8000-000000000abc';

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ workflowVersionId: missingVersionId });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('explicit pin with soft-deleted version — returns 404 (deleted versions are excluded)', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    const versionId = await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: '0.9.0',
      state: 'inactive',
      deleted: true, // soft-deleted
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ workflowVersionId: versionId });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('cross-workflow pin — versionId belongs to a different workflow, returns 404', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowA = await seedWorkflow(tenantId, projectId);
    const workflowB = await seedWorkflow(tenantId, projectId);
    const versionOfB = await seedVersion({
      tenantId,
      projectId,
      workflowId: workflowB,
      version: '1.0.0',
      state: 'active',
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowA}/executions/execute`)
      .send({ workflowVersionId: versionOfB });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('no workflowVersionId + active version exists — engine picks active automatically', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    const activeId = await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: '2.0.0',
      state: 'active',
    });
    // Seed a second inactive version to verify the active filter works.
    await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: '1.0.0',
      state: 'inactive',
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ payload: {} });

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.workflowVersionId).toBe(activeId);
    expect(calls[0].input.workflowVersion).toBe('2.0.0');
  });

  it('no workflowVersionId + no active version — falls back to the workflow draft', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    // No WorkflowVersion docs seeded.

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ payload: {} });

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.workflowVersionId).toBeUndefined();
    expect(calls[0].input.workflowVersion).toBeUndefined();
    // Steps still come from the draft's canvas (via convertCanvasToSteps).
    expect(Array.isArray(calls[0].input.steps)).toBe(true);
  });

  it('no workflowVersionId + only inactive versions — also falls back to draft', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: '1.0.0',
      state: 'inactive',
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ payload: {} });

    expect(res.status).toBe(202);
    expect(calls[0].input.workflowVersionId).toBeUndefined();
    expect(calls[0].input.workflowVersion).toBeUndefined();
  });

  it('no workflowVersionId + soft-deleted active version — falls back to draft (deleted filter)', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    // An active-but-soft-deleted version must NOT be used.
    await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: '2.5.0',
      state: 'active',
      deleted: true,
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ payload: {} });

    expect(res.status).toBe(202);
    expect(calls[0].input.workflowVersionId).toBeUndefined();
    expect(calls[0].input.workflowVersion).toBeUndefined();
  });
});

// ─── KEYSTONE E2E-4: Runtime↔Engine parity (Scenario 5) ────────────────────
// Both runtime's resolveDefaultVersion() and engine's default branch must
// resolve to the SAME version for identical multi-active-version fixtures.
// This is the single most important test in the versioning suite.

describe('KEYSTONE: runtime↔engine default-version parity', () => {
  const tenantId = 't-parity-1';
  const projectId = 'p-parity-1';

  it('runtime query + semver sort and engine default-branch agree on highest-semver active version', async ({
    skip,
  }) => {
    requireMongo(skip);

    // ── Shared fixture: 3 active versions with v0.9.0 inserted last ────
    const workflowId = await seedWorkflow(tenantId, projectId);
    await seedVersion({ tenantId, projectId, workflowId, version: 'v0.2.0', state: 'active' });
    await seedVersion({ tenantId, projectId, workflowId, version: 'v0.10.0', state: 'active' });
    await seedVersion({ tenantId, projectId, workflowId, version: 'v0.9.0', state: 'active' });

    // ── Engine path: hit the HTTP endpoint (default branch) ────────────
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);
    const engineRes = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ payload: {} });
    expect(engineRes.status).toBe(202);
    const engineVersion = calls[0].input.workflowVersion;

    // ── Runtime path: replicate resolveDefaultVersion() query ──────────
    // Same Mongoose filter + compareSemverDesc sort as runtime's
    // workflow-version-service.ts:resolveDefaultVersion().
    const { compareSemverDesc } = await import('../lib/semver-compare.js');
    const candidates = await WorkflowVersion.find({
      workflowId,
      tenantId,
      projectId,
      state: 'active',
      deleted: false,
      version: { $ne: 'draft' },
    }).lean();
    candidates.sort((a: { version: string }, b: { version: string }) =>
      compareSemverDesc(a.version, b.version),
    );
    const runtimeVersion = candidates[0]?.version;

    // ── Parity assertion ───────────────────────────────────────────────
    expect(engineVersion).toBe('v0.10.0');
    expect(runtimeVersion).toBe('v0.10.0');
    expect(engineVersion).toBe(runtimeVersion);
  });
});
