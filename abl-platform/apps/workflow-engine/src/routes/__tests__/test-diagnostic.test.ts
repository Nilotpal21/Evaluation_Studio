/**
 * Unit tests for `routes/test-diagnostic.ts`.
 *
 * Uses supertest against the real Express router with a fake auth
 * middleware that injects `tenantContext`. No vi.mock of internal
 * packages — the router's model dependencies are injected via
 * constructor and satisfied with hand-rolled fakes.
 *
 * Scope:
 *   1. Auth — 401 when `tenantContext.tenantId` missing.
 *   2. Tenant isolation — the forwarded filter always has the caller's
 *      tenantId; unknown executionId returns 404.
 *   3. Query param coercion — `limit` is capped at 500; `published=true`
 *      maps to `{publishedAt:{$ne:null}}`.
 *   4. Force-publish — 503 when the poller is not wired; 200 with the
 *      drain() result when it is.
 *   5. NODE_ENV guard — the router returns 404 for every request when
 *      NODE_ENV is not `test`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import {
  createTestDiagnosticRouter,
  type ExecutionReadModel,
  type WorkflowOutboxReadModel,
  type DrainablePoller,
} from '../test-diagnostic.js';

function makeModels(
  opts: {
    outboxRows?: Array<Record<string, unknown>>;
    executionDoc?: Record<string, unknown> | null;
  } = {},
) {
  const outboxFilters: Array<Record<string, unknown>> = [];
  const outboxModel: WorkflowOutboxReadModel = {
    find: vi.fn((filter) => {
      outboxFilters.push(filter);
      return {
        sort: () => ({
          limit: () => ({
            lean: async () => opts.outboxRows ?? [],
          }),
        }),
      };
    }),
    findOne: vi.fn(async () => null),
  };

  const executionFilters: Array<Record<string, unknown>> = [];
  const executionModel: ExecutionReadModel = {
    findOne: vi.fn((filter) => {
      executionFilters.push(filter);
      return { lean: async () => opts.executionDoc ?? null };
    }),
  };

  return { outboxModel, executionModel, outboxFilters, executionFilters };
}

function makeApp(opts: {
  outboxRows?: Array<Record<string, unknown>>;
  executionDoc?: Record<string, unknown> | null;
  tenantId?: string | null;
  poller?: DrainablePoller;
}) {
  const models = makeModels({
    outboxRows: opts.outboxRows,
    executionDoc: opts.executionDoc,
  });

  const tenantId = opts.tenantId === undefined ? 'tenant-1' : opts.tenantId;
  const fakeAuth = (req: Request, _res: Response, next: NextFunction) => {
    if (tenantId !== null) {
      (req as unknown as { tenantContext: { tenantId: string; userId: string } }).tenantContext = {
        tenantId,
        userId: 'user-1',
      };
    }
    next();
  };

  const router = createTestDiagnosticRouter({
    outboxModel: models.outboxModel,
    executionModel: models.executionModel,
    poller: opts.poller,
    authMiddleware: [fakeAuth],
  });

  const app = express();
  app.use(express.json());
  app.use('/api/admin/test', router);
  return { app, models };
}

const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe('GET /workflow-outbox', () => {
  it('returns outbox rows with the filter scoped to the caller tenant', async () => {
    const { app, models } = makeApp({ outboxRows: [{ _id: 'evt-1' }] });
    const res = await request(app).get('/api/admin/test/workflow-outbox');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: expect.objectContaining({
        rows: [{ _id: 'evt-1' }],
        count: 1,
        limit: 50,
      }),
    });
    expect(models.outboxFilters[0]).toEqual({ tenantId: 'tenant-1' });
  });

  it('returns 401 when tenantContext is missing', async () => {
    const { app } = makeApp({ tenantId: null });
    const res = await request(app).get('/api/admin/test/workflow-outbox');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('caps limit at 500 and narrows by entityKind + published=true', async () => {
    const { app, models } = makeApp({ outboxRows: [] });
    const res = await request(app).get(
      '/api/admin/test/workflow-outbox?limit=9999&entityKind=human_task&published=true',
    );
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(500);
    expect(models.outboxFilters[0]).toEqual({
      tenantId: 'tenant-1',
      entityKind: 'human_task',
      publishedAt: { $ne: null },
    });
  });

  it('filters on published=false correctly', async () => {
    const { app, models } = makeApp({ outboxRows: [] });
    await request(app).get('/api/admin/test/workflow-outbox?published=false');
    expect(models.outboxFilters[0]).toEqual({
      tenantId: 'tenant-1',
      publishedAt: null,
    });
  });
});

describe('POST /workflow-outbox/force-publish', () => {
  it('returns 503 when no poller is wired (WORKFLOW_OUTBOX_ENABLED=false)', async () => {
    const { app } = makeApp({});
    const res = await request(app).post('/api/admin/test/workflow-outbox/force-publish');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('POLLER_UNAVAILABLE');
  });

  it('forwards to poller.drain and returns its result when wired', async () => {
    const poller: DrainablePoller = {
      drain: vi.fn(async () => ({ published: 3, failed: 1 })),
    };
    const { app } = makeApp({ poller });
    const res = await request(app).post('/api/admin/test/workflow-outbox/force-publish');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { published: 3, failed: 1 } });
    expect(poller.drain).toHaveBeenCalledOnce();
  });
});

describe('GET /workflow-executions/:executionId/mongo-raw', () => {
  it('returns the raw Mongo doc when scoped to the caller tenant', async () => {
    const { app, models } = makeApp({
      executionDoc: { _id: 'exec-1', tenantId: 'tenant-1', status: 'running' },
    });
    const res = await request(app).get('/api/admin/test/workflow-executions/exec-1/mongo-raw');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ _id: 'exec-1' });
    expect(models.executionFilters[0]).toEqual({ _id: 'exec-1', tenantId: 'tenant-1' });
  });

  it('returns 404 (not 403) for cross-tenant access — leak-proof isolation', async () => {
    const { app } = makeApp({ executionDoc: null });
    const res = await request(app).get(
      '/api/admin/test/workflow-executions/other-tenant-exec/mongo-raw',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('NODE_ENV guard', () => {
  it('returns 404 for every endpoint when NODE_ENV is not "test"', async () => {
    process.env.NODE_ENV = 'production';
    const { app } = makeApp({ outboxRows: [{ _id: 'evt-x' }] });
    const res = await request(app).get('/api/admin/test/workflow-outbox');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
