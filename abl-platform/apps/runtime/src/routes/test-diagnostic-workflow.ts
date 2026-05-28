/**
 * Test-diagnostic workflow CH routes (LLD §4.4, test-spec §10.4–§10.6).
 *
 * Mounted ONLY when `NODE_ENV === 'test'`. `server.ts` gates the dynamic
 * import so production bundles never include these endpoints. Routes sit
 * behind the runtime's standard `authMiddleware` stack (unifiedAuth +
 * requireAuthWithTenant) — test-spec §10 forbids auth bypass.
 *
 * Endpoints
 * ---------
 *  GET  /api/admin/test/workflow-ch-events/:executionId
 *       Returns raw `workflow_execution_events` rows for the caller's
 *       tenant + execution id (newest first, up to 500). Cross-tenant
 *       queries return an empty list — never leak execution existence.
 *
 *  GET  /api/admin/test/human-tasks-latest/:taskId
 *       Returns the collapsed `human_tasks_latest` row (at most one) for
 *       the caller's tenant + taskId. 404 on cross-tenant or unknown.
 *
 *  POST /api/admin/test/workflow-consumer/flush
 *       Calls `consumer.flushAll()` on the live `WorkflowEventsConsumer`
 *       to force both CH buffered writers to commit immediately. Returns
 *       503 when the consumer isn't running (sink disabled).
 */

import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import type { ClickHouseClient } from '@clickhouse/client';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('runtime:test-diagnostic-workflow');

const MAX_CH_ROWS = 500;

/** Minimal surface of `WorkflowEventsConsumer` — exposed so tests can fake. */
export interface FlushableConsumer {
  flushAll(): Promise<void>;
}

export interface WorkflowTestDiagnosticDeps {
  chClient: ClickHouseClient;
  /** Present when `WORKFLOW_CH_SINK_ENABLED=true` and the consumer started. */
  consumer?: FlushableConsumer;
  /** Full auth stack — router applies itself so there's no mount-order bypass. */
  authMiddleware: RequestHandler[];
}

function tenantFrom(req: Request): string | null {
  const ctx = (req as unknown as { tenantContext?: { tenantId?: string } }).tenantContext;
  const tenantId = ctx?.tenantId;
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : null;
}

export function createWorkflowTestDiagnosticRouter(deps: WorkflowTestDiagnosticDeps): Router {
  const router = Router();

  // Defense-in-depth — mount-order or bundle accident would still 404.
  if (process.env.NODE_ENV !== 'test') {
    router.use((_req, res) => {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
    return router;
  }

  router.use(...deps.authMiddleware);

  // ── GET /workflow-ch-events/:executionId ───────────────────────────────
  router.get(
    '/workflow-ch-events/:executionId',
    async (req: Request, res: Response): Promise<void> => {
      const tenantId = tenantFrom(req);
      if (!tenantId) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHENTICATED', message: 'Missing tenant' },
        });
        return;
      }
      const { executionId } = req.params;
      if (!executionId) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'executionId is required' },
        });
        return;
      }

      try {
        const result = await deps.chClient.query({
          query: `
            SELECT *
            FROM abl_platform.workflow_execution_events
            WHERE tenant_id = {tenantId:String} AND execution_id = {executionId:String}
            ORDER BY occurred_at ASC
            LIMIT {limit:UInt32}
            SETTINGS max_execution_time = 10
          `,
          query_params: { tenantId, executionId, limit: MAX_CH_ROWS },
          format: 'JSONEachRow',
        });
        const rows = await result.json<Record<string, unknown>>();
        res.json({
          success: true,
          data: { rows, count: rows.length, executionId },
        });
      } catch (err) {
        log.error('workflow-ch-events query failed', {
          tenantId,
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL', message: 'Failed to query workflow events' },
        });
      }
    },
  );

  // ── GET /human-tasks-latest/:taskId ────────────────────────────────────
  router.get('/human-tasks-latest/:taskId', async (req: Request, res: Response): Promise<void> => {
    const tenantId = tenantFrom(req);
    if (!tenantId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Missing tenant' },
      });
      return;
    }
    const { taskId } = req.params;
    if (!taskId) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'taskId is required' },
      });
      return;
    }

    try {
      // `FINAL` forces ReplacingMergeTree collapse at read time so tests
      // observe the latest _version without having to wait for background
      // merges. Acceptable because we return at most 1 row.
      const result = await deps.chClient.query({
        query: `
            SELECT *
            FROM abl_platform.human_tasks_latest FINAL
            WHERE tenant_id = {tenantId:String} AND task_id = {taskId:String}
            LIMIT 1
            SETTINGS max_execution_time = 10
          `,
        query_params: { tenantId, taskId },
        format: 'JSONEachRow',
      });
      const rows = await result.json<Record<string, unknown>>();
      if (rows.length === 0) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Human task not found' },
        });
        return;
      }
      res.json({ success: true, data: rows[0] });
    } catch (err) {
      log.error('human-tasks-latest query failed', {
        tenantId,
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Failed to query human task' },
      });
    }
  });

  // ── POST /workflow-consumer/flush ──────────────────────────────────────
  router.post('/workflow-consumer/flush', async (req: Request, res: Response): Promise<void> => {
    const tenantId = tenantFrom(req);
    if (!tenantId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Missing tenant' },
      });
      return;
    }
    if (!deps.consumer) {
      res.status(503).json({
        success: false,
        error: {
          code: 'CONSUMER_UNAVAILABLE',
          message: 'Workflow events consumer is not running. Set WORKFLOW_CH_SINK_ENABLED=true.',
        },
      });
      return;
    }
    try {
      await deps.consumer.flushAll();
      res.json({ success: true, data: { flushed: true } });
    } catch (err) {
      log.error('workflow-consumer flush failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Flush failed' },
      });
    }
  });

  log.info('Workflow test-diagnostic routes registered', {
    route_count: 3,
    mount_base: '/api/admin/test',
  });
  return router;
}
