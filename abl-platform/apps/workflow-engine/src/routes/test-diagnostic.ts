/**
 * Test-diagnostic routes (LLD §3.6 / D-8 / test-spec §10.1-§10.3).
 *
 * Mounted ONLY when `NODE_ENV === 'test'` — `index.ts` gates the
 * dynamic import so production and dev bundles never include these
 * routes. The routes still sit behind the full auth middleware stack
 * (`createUnifiedAuthMiddleware` + `requireAuth`) — test-spec §10
 * explicitly forbids auth bypass. All Mongo queries scope by
 * `req.tenantContext.tenantId` (Core Invariant #1).
 *
 * Endpoints
 * ---------
 *  GET  /api/admin/test/workflow-outbox
 *       Returns unpublished + recent outbox rows for the caller's tenant.
 *       Supports `?entityKind=workflow_execution|human_task`,
 *       `?limit=N` (default 50, max 500), `?published=true|false`.
 *
 *  POST /api/admin/test/workflow-outbox/force-publish
 *       Body `{ eventIds: string[] }`. Drains the requested rows
 *       immediately through the poller (testing the publish path
 *       without waiting for the 1s repeatable tick).
 *
 *  GET  /api/admin/test/workflow-executions/:executionId/mongo-raw
 *       Returns the raw Mongo execution document (tenant-scoped) for
 *       INT-01/INT-02 parity tests.
 */

import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-engine:test-diagnostic');

/** Minimal model surfaces the routes consume — decoupled from Mongoose. */
export interface WorkflowOutboxReadModel {
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): {
      limit(n: number): {
        lean(): Promise<Array<Record<string, unknown>>>;
      };
    };
  };
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

export interface ExecutionReadModel {
  findOne(filter: Record<string, unknown>): {
    lean(): Promise<Record<string, unknown> | null>;
  };
}

/** A handle to the live poller — the force-publish endpoint calls drain() on it. */
export interface DrainablePoller {
  drain(jobId: string): Promise<{ published: number; failed: number }>;
}

/**
 * Structural surface of `HybridExecutionReader` — callers inject it so the
 * test route can ask for mongo-only, ch-only, or union views (LLD §5.7).
 */
export interface HybridInspector {
  mongoOnly(params: {
    tenantId: string;
    projectId: string;
    executionId: string;
  }): Promise<Record<string, unknown> | null>;
  chOnly(params: {
    tenantId: string;
    projectId: string;
    executionId: string;
  }): Promise<Record<string, unknown> | null>;
  union(params: {
    tenantId: string;
    projectId: string;
    executionId: string;
  }): Promise<Record<string, unknown> | null>;
}

export interface TestDiagnosticDeps {
  outboxModel: WorkflowOutboxReadModel;
  executionModel: ExecutionReadModel;
  /** Optional — present when `WORKFLOW_OUTBOX_ENABLED=true` and the poller started. */
  poller?: DrainablePoller;
  /** Optional — present when `WORKFLOW_DUAL_READ_ENABLED=true` (LLD §5.7). */
  hybridInspector?: HybridInspector;
  /**
   * Auth middleware — passed through so the router applies it itself.
   * The caller (`index.ts`) supplies `[unifiedAuth, requireAuth()]` so
   * these routes cannot be mounted un-authenticated by accident.
   */
  authMiddleware: RequestHandler[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function tenantFrom(req: Request): string | null {
  const ctx = (req as unknown as { tenantContext?: { tenantId?: string } }).tenantContext;
  const tenantId = ctx?.tenantId;
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : null;
}

export function createTestDiagnosticRouter(deps: TestDiagnosticDeps): Router {
  const router = Router();

  // Fail-fast guard: even though `index.ts` only mounts this router when
  // NODE_ENV=test, add a defense-in-depth check so production bundles
  // that somehow call this factory still refuse to serve the endpoints.
  if (process.env.NODE_ENV !== 'test') {
    router.use((_req, res) => {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
    return router;
  }

  router.use(...deps.authMiddleware);

  // ── GET /workflow-outbox ───────────────────────────────────────────────
  router.get('/workflow-outbox', async (req: Request, res: Response) => {
    const tenantId = tenantFrom(req);
    if (!tenantId) {
      return res
        .status(401)
        .json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Missing tenant' } });
    }

    const entityKind = (req.query.entityKind as string | undefined)?.toLowerCase();
    const publishedFlag = (req.query.published as string | undefined)?.toLowerCase();
    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

    const filter: Record<string, unknown> = { tenantId };
    if (entityKind === 'workflow_execution' || entityKind === 'human_task') {
      filter.entityKind = entityKind;
    }
    if (publishedFlag === 'true') {
      filter.publishedAt = { $ne: null };
    } else if (publishedFlag === 'false') {
      filter.publishedAt = null;
    }

    try {
      const rows = await deps.outboxModel.find(filter).sort({ occurredAt: -1 }).limit(limit).lean();
      return res.json({
        success: true,
        data: { rows, count: rows.length, limit, filter },
      });
    } catch (err) {
      log.error('workflow-outbox list failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Failed to list outbox rows' },
      });
    }
  });

  // ── POST /workflow-outbox/force-publish ────────────────────────────────
  router.post('/workflow-outbox/force-publish', async (req: Request, res: Response) => {
    const tenantId = tenantFrom(req);
    if (!tenantId) {
      return res
        .status(401)
        .json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Missing tenant' } });
    }

    if (!deps.poller) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'POLLER_UNAVAILABLE',
          message:
            'Outbox poller is not running. Set WORKFLOW_OUTBOX_ENABLED=true and ensure Redis is reachable.',
        },
      });
    }

    try {
      const result = await deps.poller.drain(`force-publish:${tenantId}:${Date.now()}`);
      return res.json({ success: true, data: result });
    } catch (err) {
      log.error('workflow-outbox force-publish failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Force-publish failed' },
      });
    }
  });

  // ── GET /workflow-executions/:id/mongo-raw ─────────────────────────────
  router.get('/workflow-executions/:executionId/mongo-raw', async (req: Request, res: Response) => {
    const tenantId = tenantFrom(req);
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Missing tenant' },
      });
    }
    const { executionId } = req.params;
    if (!executionId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'executionId is required' },
      });
    }

    try {
      // Cross-tenant isolation — return 404 rather than leak existence.
      const doc = await deps.executionModel.findOne({ _id: executionId, tenantId }).lean();
      if (!doc) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Execution not found' },
        });
      }
      return res.json({ success: true, data: doc });
    } catch (err) {
      log.error('workflow-executions mongo-raw failed', {
        tenantId,
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Failed to load execution' },
      });
    }
  });

  // ── GET /workflow-executions/:id/hybrid ────────────────────────────────
  //
  // LLD §5.7 — returns the same execution under all three read modes so
  // parity tests (INT-07, E2E-02) can assert Mongo/CH/union equivalence.
  router.get('/workflow-executions/:executionId/hybrid', async (req: Request, res: Response) => {
    const tenantId = tenantFrom(req);
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Missing tenant' },
      });
    }
    if (!deps.hybridInspector) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'HYBRID_READER_UNAVAILABLE',
          message: 'Hybrid execution reader is not wired. Set WORKFLOW_DUAL_READ_ENABLED=true.',
        },
      });
    }
    const { executionId } = req.params;
    const mode = (req.query.mode as string | undefined) ?? 'union';
    if (!executionId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'executionId is required' },
      });
    }
    const projectId =
      (req.query.projectId as string | undefined) ??
      (req as unknown as { tenantContext?: { projectId?: string } }).tenantContext?.projectId ??
      '';
    if (!projectId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'projectId is required (query param or tenantContext)',
        },
      });
    }
    try {
      const baseArgs = { tenantId, projectId, executionId };
      const result =
        mode === 'mongo-only'
          ? await deps.hybridInspector.mongoOnly(baseArgs)
          : mode === 'ch-only'
            ? await deps.hybridInspector.chOnly(baseArgs)
            : mode === 'union'
              ? await deps.hybridInspector.union(baseArgs)
              : undefined;
      if (result === undefined) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: `Unsupported mode: ${mode}. Use mongo-only | ch-only | union.`,
          },
        });
      }
      if (result === null) {
        return res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      }
      return res.json({ success: true, data: result, mode });
    } catch (err) {
      log.error('workflow-executions hybrid inspection failed', {
        tenantId,
        executionId,
        mode,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Failed to inspect hybrid execution' },
      });
    }
  });

  log.info('Test-diagnostic routes registered', {
    route_count: 4,
    mount_base: '/api/admin/test',
  });
  return router;
}
