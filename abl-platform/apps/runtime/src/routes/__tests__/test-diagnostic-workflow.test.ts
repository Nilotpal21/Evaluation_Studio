/**
 * Unit tests for `routes/test-diagnostic-workflow.ts` (LLD §4.4).
 *
 * Uses supertest against the real Express router with a fake auth
 * middleware that injects `tenantContext`. No `vi.mock` of internal
 * packages — CH client and consumer are injected via deps and satisfied
 * with hand-rolled fakes.
 *
 * Scope:
 *   1. Auth — 401 when `tenantContext.tenantId` is missing.
 *   2. Query shape — requests include `tenantId`/`executionId`/`taskId`
 *      in `query_params`; never leak cross-tenant data.
 *   3. 404 on empty CH result for `/human-tasks-latest/:taskId`.
 *   4. 503 when consumer isn't wired; 200 when it is.
 *   5. `NODE_ENV !== 'test'` ⇒ 404 for every route (defense-in-depth).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import {
  createWorkflowTestDiagnosticRouter,
  type FlushableConsumer,
} from '../test-diagnostic-workflow.js';

interface FakeChQueryParams {
  query: string;
  query_params?: Record<string, unknown>;
  format?: string;
}

function makeCh(rowsByTable: Record<string, Array<Record<string, unknown>>>) {
  const calls: FakeChQueryParams[] = [];
  const client = {
    query: vi.fn(async (params: FakeChQueryParams) => {
      calls.push(params);
      const table = params.query.includes('workflow_execution_events')
        ? 'workflow_execution_events'
        : params.query.includes('human_tasks_latest')
          ? 'human_tasks_latest'
          : 'unknown';
      const rows = rowsByTable[table] ?? [];
      return { json: async () => rows };
    }),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
  };
  return { client, calls };
}

function makeApp(opts: {
  tenantId?: string | null;
  rowsByTable?: Record<string, Array<Record<string, unknown>>>;
  consumer?: FlushableConsumer;
}) {
  const tenantId = opts.tenantId === undefined ? 'tenant-1' : opts.tenantId;
  const { client, calls } = makeCh(opts.rowsByTable ?? {});

  const fakeAuth = (req: Request, _res: Response, next: NextFunction) => {
    if (tenantId !== null) {
      (req as unknown as { tenantContext: { tenantId: string; userId: string } }).tenantContext = {
        tenantId,
        userId: 'user-1',
      };
    }
    next();
  };

  const router = createWorkflowTestDiagnosticRouter({
    chClient: client as never,
    consumer: opts.consumer,
    authMiddleware: [fakeAuth],
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/test', router);
  return { app, client, calls };
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('GET /workflow-ch-events/:executionId', () => {
  it('401 when tenantContext is missing', async () => {
    const { app } = makeApp({ tenantId: null });
    const res = await request(app).get('/api/admin/test/workflow-ch-events/exec-1');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('forwards tenantId + executionId to CH query_params', async () => {
    const { app, calls } = makeApp({
      rowsByTable: {
        workflow_execution_events: [{ event_id: 'e1', tenant_id: 'tenant-1' }],
      },
    });
    const res = await request(app).get('/api/admin/test/workflow-ch-events/exec-1');
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(calls[0]?.query_params).toMatchObject({ tenantId: 'tenant-1', executionId: 'exec-1' });
  });

  it('returns empty rows when the execution does not exist for this tenant', async () => {
    const { app } = makeApp({ rowsByTable: { workflow_execution_events: [] } });
    const res = await request(app).get('/api/admin/test/workflow-ch-events/exec-unknown');
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([]);
  });
});

describe('GET /human-tasks-latest/:taskId', () => {
  it('404 when no row matches', async () => {
    const { app } = makeApp({ rowsByTable: { human_tasks_latest: [] } });
    const res = await request(app).get('/api/admin/test/human-tasks-latest/task-x');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns the single collapsed row when found', async () => {
    const { app } = makeApp({
      rowsByTable: {
        human_tasks_latest: [{ task_id: 'task-1', status: 'approved', tenant_id: 'tenant-1' }],
      },
    });
    const res = await request(app).get('/api/admin/test/human-tasks-latest/task-1');
    expect(res.status).toBe(200);
    expect(res.body.data.task_id).toBe('task-1');
  });
});

describe('POST /workflow-consumer/flush', () => {
  it('503 when consumer is not wired', async () => {
    const { app } = makeApp({});
    const res = await request(app).post('/api/admin/test/workflow-consumer/flush');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CONSUMER_UNAVAILABLE');
  });

  it('200 and invokes flushAll when consumer is wired', async () => {
    const consumer: FlushableConsumer = {
      flushAll: vi.fn(async () => undefined),
    };
    const { app } = makeApp({ consumer });
    const res = await request(app).post('/api/admin/test/workflow-consumer/flush');
    expect(res.status).toBe(200);
    expect(res.body.data.flushed).toBe(true);
    expect(consumer.flushAll).toHaveBeenCalledTimes(1);
  });
});

describe('NODE_ENV guard', () => {
  it('returns 404 for every route when NODE_ENV is not "test"', async () => {
    process.env.NODE_ENV = 'production';
    const { app } = makeApp({});
    const r1 = await request(app).get('/api/admin/test/workflow-ch-events/exec-1');
    const r2 = await request(app).get('/api/admin/test/human-tasks-latest/task-1');
    const r3 = await request(app).post('/api/admin/test/workflow-consumer/flush');
    for (const r of [r1, r2, r3]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('NOT_FOUND');
    }
  });
});
