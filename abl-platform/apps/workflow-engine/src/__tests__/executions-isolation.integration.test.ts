/**
 * INT-6 — Workflow Execution Tenant/Project Isolation
 *
 * Verifies that the execution routes enforce tenant+project scoping:
 * - Creating an execution under (tenantA, projA)
 * - GET under (tenantB, projA) → 404
 * - GET under (tenantA, projB) → 404
 *
 * Uses DI deps pattern matching existing workflow-executions-routes.test.ts.
 * Real in-memory data store — no mocks of platform components.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createWorkflowExecutionRouter,
  type WorkflowExecutionRouteDeps,
} from '../routes/workflow-executions.js';

// ─── In-memory execution store ─────────────────────────────────────────────

interface ExecutionDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  status: string;
  startedAt: Date;
  nodeExecutions: unknown[];
  [key: string]: unknown;
}

function createInMemoryExecutionModel() {
  const store: ExecutionDoc[] = [];

  return {
    /** Insert a doc into the store (test helper, not part of Mongoose interface) */
    _insert(doc: ExecutionDoc): void {
      store.push(doc);
    },
    _clear(): void {
      store.length = 0;
    },

    find(filter: Record<string, unknown>) {
      const results = store.filter((doc) =>
        Object.entries(filter).every((entry) => doc[entry[0] as keyof ExecutionDoc] === entry[1]),
      );
      return {
        sort(_sort: Record<string, unknown>) {
          return {
            limit(n: number) {
              return {
                async lean() {
                  return results.slice(0, n);
                },
              };
            },
          };
        },
      };
    },

    async findOne(filter: Record<string, unknown>): Promise<ExecutionDoc | null> {
      return (
        store.find((doc) =>
          Object.entries(filter).every((entry) => doc[entry[0] as keyof ExecutionDoc] === entry[1]),
        ) ?? null
      );
    },

    async findOneAndUpdate(
      filter: Record<string, unknown>,
      _update: Record<string, unknown>,
      _options?: Record<string, unknown>,
    ): Promise<ExecutionDoc | null> {
      const doc = store.find((d) =>
        Object.entries(filter).every((entry) => d[entry[0] as keyof ExecutionDoc] === entry[1]),
      );
      return doc ?? null;
    },
  };
}

// ─── App factory ───────────────────────────────────────────────────────────

function createApp(deps: WorkflowExecutionRouteDeps, tenantId: string, projectId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantContext = { tenantId, userId: 'user-1' };
    next();
  });
  app.use(
    '/api/projects/:projectId/workflows/:workflowId/executions',
    createWorkflowExecutionRouter(deps),
  );
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('INT-6: Workflow Execution Tenant/Project Isolation', () => {
  const TENANT_A = 'tenant-aaa';
  const TENANT_B = 'tenant-bbb';
  const PROJECT_A = 'proj-aaa';
  const PROJECT_B = 'proj-bbb';
  const WORKFLOW_ID = 'wf-001';
  const EXECUTION_ID = 'exec-001';

  let execModel: ReturnType<typeof createInMemoryExecutionModel>;

  const baseDeps = (): WorkflowExecutionRouteDeps => ({
    executionModel: execModel as any,
    workflowModel: {
      async findOne() {
        return { _id: WORKFLOW_ID, name: 'test-flow', steps: [] };
      },
    },
    restateClient: {
      async startWorkflow() {},
      async cancelWorkflow() {},
    },
    publisher: {
      async publish() {},
    },
  });

  beforeEach(() => {
    execModel = createInMemoryExecutionModel();
    // Seed one execution under (tenantA, projA)
    execModel._insert({
      _id: EXECUTION_ID,
      tenantId: TENANT_A,
      projectId: PROJECT_A,
      workflowId: WORKFLOW_ID,
      status: 'completed',
      startedAt: new Date(),
      nodeExecutions: [],
    });
  });

  it('owner tenant+project can GET the execution', async () => {
    const app = createApp(baseDeps(), TENANT_A, PROJECT_A);
    const res = await request(app).get(
      `/api/projects/${PROJECT_A}/workflows/${WORKFLOW_ID}/executions/${EXECUTION_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('different tenant returns 404', async () => {
    const app = createApp(baseDeps(), TENANT_B, PROJECT_A);
    const res = await request(app).get(
      `/api/projects/${PROJECT_A}/workflows/${WORKFLOW_ID}/executions/${EXECUTION_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toEqual({
      code: 'EXECUTION_NOT_FOUND',
      message: 'Execution not found',
    });
  });

  it('different project returns 404', async () => {
    const app = createApp(baseDeps(), TENANT_A, PROJECT_B);
    const res = await request(app).get(
      `/api/projects/${PROJECT_B}/workflows/${WORKFLOW_ID}/executions/${EXECUTION_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toEqual({
      code: 'EXECUTION_NOT_FOUND',
      message: 'Execution not found',
    });
  });

  it('list endpoint scopes by tenant+project', async () => {
    const appA = createApp(baseDeps(), TENANT_A, PROJECT_A);
    const resA = await request(appA).get(
      `/api/projects/${PROJECT_A}/workflows/${WORKFLOW_ID}/executions`,
    );
    expect(resA.status).toBe(200);
    expect(resA.body.data).toHaveLength(1);

    // Different tenant sees empty list
    const appB = createApp(baseDeps(), TENANT_B, PROJECT_A);
    const resB = await request(appB).get(
      `/api/projects/${PROJECT_A}/workflows/${WORKFLOW_ID}/executions`,
    );
    expect(resB.status).toBe(200);
    expect(resB.body.data).toHaveLength(0);
  });
});
