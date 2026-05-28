/**
 * Engine semver-string pin resolution — Phase 3 test.
 *
 * Verifies:
 * - POST /execute with `workflowVersion: 'v0.1.0'` (no workflowVersionId)
 *   resolves to the matching WorkflowVersion doc.
 * - POST /execute with `workflowVersion: 'v9.9.9'` (miss) returns 404
 *   WORKFLOW_VERSION_NOT_FOUND with a static error message.
 * - Soft-deleted versions are excluded from semver-string resolution.
 * - Cross-tenant isolation: semver-string pin from tenant A does not resolve
 *   a version owned by tenant B.
 *
 * Uses real MongoMemoryServer + real Express (supertest) + DI-stubbed Restate.
 * No vi.mock of internal packages.
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

// ─── Restate stub ────────────────────────────────────────────────────────────

interface RestateStartCall {
  executionId: string;
  input: Record<string, unknown>;
}

function makeRestateStub() {
  const calls: RestateStartCall[] = [];
  return {
    client: {
      startWorkflow: async (executionId: string, input: Record<string, unknown>) => {
        calls.push({ executionId, input });
      },
      cancelWorkflow: async () => {
        /* noop */
      },
    },
    calls,
  };
}

// ─── App builder ─────────────────────────────────────────────────────────────

function buildApp(
  restateClient: ReturnType<typeof makeRestateStub>['client'],
  tenantId: string,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    (req as any).tenantContext = { tenantId, userId: 'user-semver-1' };
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

// ─── Canvas fixture ──────────────────────────────────────────────────────────

const canvasNodes = [
  { id: 'start-1', nodeType: 'start', name: 'Start', position: { x: 0, y: 0 } },
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

// ─── Seed helpers ────────────────────────────────────────────────────────────

async function seedWorkflow(tenantId: string, projectId: string): Promise<string> {
  const doc = await Workflow.create({
    tenantId,
    projectId,
    name: `wf-semver-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    definition: { nodes: canvasNodes, edges: canvasEdges },
    sourceHash: `hash-${params.version}`,
    state: params.state ?? 'inactive',
    deleted: params.deleted ?? false,
    createdBy: 'test-user',
  });
  return doc._id as string;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestMongo();
}, 60_000);

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await teardownTestMongo();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /execute — semver-string pin resolution', () => {
  const tenantId = 't-semver-1';
  const projectId = 'p-semver-1';

  it('resolves matching version doc by semver string', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    const versionId = await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: 'v0.1.0',
      state: 'inactive', // state-agnostic — resolves even if inactive
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ workflowVersion: 'v0.1.0', payload: { key: 'semver-hit' } });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.workflowVersionId).toBe(versionId);
    expect(calls[0].input.workflowVersion).toBe('v0.1.0');
  });

  it('returns 404 WORKFLOW_VERSION_NOT_FOUND for semver miss', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    // Seed a version so there IS data — but not the requested one
    await seedVersion({ tenantId, projectId, workflowId, version: 'v0.1.0' });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ workflowVersion: 'v9.9.9' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
    // Error message must be static — no user input interpolated
    expect(res.body.error.message).toBe('Requested workflow version not found');
    expect(calls).toHaveLength(0);
  });

  it('excludes soft-deleted versions from semver-string resolution', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);
    await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: 'v0.2.0',
      deleted: true,
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ workflowVersion: 'v0.2.0' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('cross-tenant isolation — version from tenant B not visible to tenant A', async ({ skip }) => {
    requireMongo(skip);
    const tenantA = 't-semver-A';
    const tenantB = 't-semver-B';
    const { client: clientA, calls: callsA } = makeRestateStub();
    const appA = buildApp(clientA, tenantA);

    const workflowIdA = await seedWorkflow(tenantA, projectId);
    // Seed version 'v0.3.0' for a workflow in tenant B — should not be visible to tenant A
    const workflowIdB = await seedWorkflow(tenantB, projectId);
    await seedVersion({
      tenantId: tenantB,
      projectId,
      workflowId: workflowIdB,
      version: 'v0.3.0',
    });

    const res = await request(appA)
      .post(`/api/projects/${projectId}/workflows/${workflowIdA}/executions/execute`)
      .send({ workflowVersion: 'v0.3.0' });

    // Tenant A's workflow has no v0.3.0 → semver-string branch returns 404
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
    expect(callsA).toHaveLength(0);
  });
});

// ─── Phase 5: Default-branch semver-desc sort (Scenario 4, engine path) ─────

describe('POST /execute — default-branch semver-desc resolution', () => {
  const tenantId = 't-semver-default';
  const projectId = 'p-semver-default';

  it('picks highest-semver active version, not insertion-order or arbitrary findOne', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);

    // Seed 3 active versions — v0.9.0 is inserted LAST (would be picked
    // by findOne without sort). v0.10.0 is the highest semver.
    await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: 'v0.2.0',
      state: 'active',
    });
    const v10Id = await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: 'v0.10.0',
      state: 'active',
    });
    await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: 'v0.9.0',
      state: 'active',
    });

    // No workflowVersionId, no workflowVersion → default branch
    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ payload: {} });

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.workflowVersionId).toBe(v10Id);
    expect(calls[0].input.workflowVersion).toBe('v0.10.0');
  });

  it('picks v0.9.0 after v0.10.0 is deactivated', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);

    await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: 'v0.2.0',
      state: 'active',
    });
    await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: 'v0.10.0',
      state: 'inactive', // deactivated
    });
    const v9Id = await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: 'v0.9.0',
      state: 'active',
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ payload: {} });

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.workflowVersionId).toBe(v9Id);
    expect(calls[0].input.workflowVersion).toBe('v0.9.0');
  });

  it('falls through to draft when no active non-draft versions exist', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client, tenantId);

    const workflowId = await seedWorkflow(tenantId, projectId);

    // Only inactive versions — no active non-draft
    await seedVersion({
      tenantId,
      projectId,
      workflowId,
      version: 'v0.10.0',
      state: 'inactive',
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/workflows/${workflowId}/executions/execute`)
      .send({ payload: {} });

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    // Falls through to draft — no effectiveVersionId set
    expect(calls[0].input.workflowVersionId).toBeUndefined();
    expect(calls[0].input.workflowVersion).toBeUndefined();
  });
});
