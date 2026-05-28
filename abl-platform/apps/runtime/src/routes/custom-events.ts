/**
 * Custom Events API Routes
 *
 * Mounted at /api/projects/:projectId/custom-events
 *
 * POST   /emit            Record a custom business event
 * GET    /summary         Event counts by name
 * GET    /timeseries      Daily event volume for a specific event
 * GET    /conversion      Conversion rate between paired events
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { randomUUID } from 'crypto';

const log = createLogger('custom-events-route');

// ─── Lazy ClickHouse access ─────────────────────────────────────────────────

async function getClickHouse() {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/custom-events',
  tags: ['Custom Events'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// ─── POST /emit ─────────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/emit',
  {
    summary: 'Record a custom business event',
    description:
      'Inserts a custom event into the analytics pipeline for later aggregation and conversion tracking.',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        eventId: z.string(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const { eventName, sessionId, properties } = req.body;

      if (!eventName || typeof eventName !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'eventName is required and must be a string' },
        });
        return;
      }

      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'sessionId is required and must be a string' },
        });
        return;
      }

      const eventId = randomUUID();
      const ch = await getClickHouse();

      await ch.insert({
        table: 'abl_platform.custom_events',
        values: [
          {
            event_id: eventId,
            tenant_id: tenantId,
            project_id: projectId,
            session_id: sessionId,
            event_name: eventName,
            properties: JSON.stringify(properties ?? {}),
            timestamp: new Date().toISOString(),
          },
        ],
        format: 'JSONEachRow',
      });

      log.info('Custom event recorded', { tenantId, projectId, eventName, sessionId, eventId });
      res.json({ success: true, data: { eventId } });
    } catch (error) {
      log.error('Failed to record custom event', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to record custom event' });
    }
  },
);

// ─── GET /summary ───────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/summary',
  {
    summary: 'Event counts by name',
    description:
      'Returns aggregated counts for each custom event name, including unique sessions and first/last seen timestamps.',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const days = Number(req.query.days) || 30;

      const ch = await getClickHouse();

      const query = `
        SELECT
          event_name,
          count() AS event_count,
          uniqExact(session_id) AS unique_sessions,
          min(timestamp) AS first_seen,
          max(timestamp) AS last_seen
        FROM abl_platform.custom_events
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND timestamp >= now() - INTERVAL ${days} DAY
        GROUP BY event_name
        ORDER BY event_count DESC
        SETTINGS max_execution_time = 10
      `;

      const result = await ch.query({
        query,
        query_params: { tenantId, projectId },
      });
      const data = (await result.json()) as unknown as Record<string, unknown>[];

      res.json({ success: true, data });
    } catch (error) {
      log.error('Failed to query custom event summary', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to query custom event summary' });
    }
  },
);

// ─── GET /timeseries ────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/timeseries',
  {
    summary: 'Daily event volume for a specific event',
    description:
      'Returns daily event counts and unique session counts for a given event name over a time window.',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const eventName = req.query.eventName as string;
      const days = Number(req.query.days) || 30;

      if (!eventName) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'eventName query parameter is required' },
        });
        return;
      }

      const ch = await getClickHouse();

      const query = `
        SELECT
          toDate(timestamp) AS day,
          count() AS event_count,
          uniqExact(session_id) AS unique_sessions
        FROM abl_platform.custom_events
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND event_name = {eventName:String}
          AND timestamp >= now() - INTERVAL ${days} DAY
        GROUP BY day
        ORDER BY day ASC
        SETTINGS max_execution_time = 10
      `;

      const result = await ch.query({
        query,
        query_params: { tenantId, projectId, eventName },
      });
      const data = (await result.json()) as unknown as Record<string, unknown>[];

      res.json({ success: true, data });
    } catch (error) {
      log.error('Failed to query custom event timeseries', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to query custom event timeseries' });
    }
  },
);

// ─── GET /conversion ────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/conversion',
  {
    summary: 'Conversion rate between paired events',
    description:
      'Computes the session-level conversion rate from an offer event to an accept event within the given time window.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const offerEvent = req.query.offerEvent as string;
      const acceptEvent = req.query.acceptEvent as string;
      const days = Number(req.query.days) || 30;

      if (!offerEvent || !acceptEvent) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'offerEvent and acceptEvent query parameters are required',
          },
        });
        return;
      }

      const ch = await getClickHouse();

      const query = `
        SELECT
          countDistinctIf(session_id, event_name = {offerEvent:String}) AS offer_sessions,
          countDistinctIf(session_id, event_name = {acceptEvent:String}) AS accept_sessions,
          if(offer_sessions > 0, round(accept_sessions / offer_sessions, 4), 0) AS conversion_rate
        FROM abl_platform.custom_events
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND timestamp >= now() - INTERVAL ${days} DAY
        SETTINGS max_execution_time = 10
      `;

      const result = await ch.query({
        query,
        query_params: { tenantId, projectId, offerEvent, acceptEvent },
      });
      const rows = (await result.json()) as unknown as Record<string, unknown>[];
      const data = rows[0] ?? { offer_sessions: 0, accept_sessions: 0, conversion_rate: 0 };

      res.json({ success: true, data });
    } catch (error) {
      log.error('Failed to query conversion rate', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to query conversion rate' });
    }
  },
);

export default openapi.router;
