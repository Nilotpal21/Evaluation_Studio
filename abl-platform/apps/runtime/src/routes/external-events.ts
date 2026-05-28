/**
 * External Events API Routes
 *
 * Mounted at /api/projects/:projectId/external-events
 *
 * POST  /            Ingest a single external event
 * POST  /batch       Batch ingest external events (max 100)
 * GET   /            List external events with optional filters
 * GET   /correlate   Correlate external events with metric timeseries
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

const log = createLogger('external-events-route');

// ─── Lazy ClickHouse access ────────────────────────────────────────────────

async function getClickHouse() {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/external-events',
  tags: ['External Events'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_EVENT_TYPES = new Set([
  'deployment',
  'incident',
  'crm_update',
  'benchmark',
  'product_release',
  'outage',
  'custom',
]);

function isValidEventType(eventType: string): boolean {
  return VALID_EVENT_TYPES.has(eventType);
}

const MAX_BATCH_SIZE = 100;

// ─── POST / ─────────────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/',
  {
    summary: 'Ingest external event',
    description: 'Inserts a single external event into ClickHouse for correlation with analytics',
    response: z.object({
      success: z.boolean(),
      data: z.object({ eventId: z.string() }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const { eventType, title, description, properties, timestamp, durationMinutes, severity } =
        req.body ?? {};

      if (!eventType || typeof eventType !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_FIELD', message: 'eventType is required' },
        });
        return;
      }

      if (!isValidEventType(eventType)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_EVENT_TYPE',
            message: `Invalid eventType: ${eventType}. Must be one of: ${[...VALID_EVENT_TYPES].join(', ')}`,
          },
        });
        return;
      }

      if (!title || typeof title !== 'string') {
        res
          .status(400)
          .json({ success: false, error: { code: 'MISSING_FIELD', message: 'title is required' } });
        return;
      }

      const eventId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const eventTimestamp = timestamp
        ? new Date(timestamp).toISOString()
        : new Date().toISOString();

      const ch = await getClickHouse();
      await ch.insert({
        table: 'abl_platform.external_events',
        values: [
          {
            tenant_id: tenantId,
            project_id: projectId,
            event_type: eventType,
            event_id: eventId,
            title,
            description: description ?? '',
            properties: properties ? JSON.stringify(properties) : '{}',
            timestamp: eventTimestamp,
            duration_minutes: durationMinutes ?? null,
            severity: severity ?? null,
          },
        ],
        format: 'JSONEachRow',
      });

      log.info('External event ingested', { tenantId, projectId, eventId, eventType });
      res.json({ success: true, data: { eventId } });
    } catch (error) {
      log.error('Failed to ingest external event', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Failed to ingest external event' },
      });
    }
  },
);

// ─── POST /batch ────────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/batch',
  {
    summary: 'Batch ingest external events',
    description: 'Inserts up to 100 external events in a single batch',
    response: z.object({
      success: z.boolean(),
      data: z.object({ inserted: z.number() }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const { events } = req.body ?? {};

      if (!Array.isArray(events)) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_FIELD', message: 'events array is required' },
        });
        return;
      }

      if (events.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'EMPTY_BATCH', message: 'events array must not be empty' },
        });
        return;
      }

      if (events.length > MAX_BATCH_SIZE) {
        res.status(400).json({
          success: false,
          error: {
            code: 'BATCH_TOO_LARGE',
            message: `Batch size ${events.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
          },
        });
        return;
      }

      // Validate all events before inserting
      for (let i = 0; i < events.length; i++) {
        const evt = events[i];
        if (!evt.eventType || !isValidEventType(evt.eventType)) {
          res.status(400).json({
            success: false,
            error: {
              code: 'INVALID_EVENT_TYPE',
              message: `Event at index ${i} has invalid eventType: ${evt.eventType ?? '(missing)'}`,
            },
          });
          return;
        }
        if (!evt.title || typeof evt.title !== 'string') {
          res.status(400).json({
            success: false,
            error: { code: 'MISSING_FIELD', message: `Event at index ${i} is missing title` },
          });
          return;
        }
      }

      const rows = events.map((evt: Record<string, unknown>) => ({
        tenant_id: tenantId,
        project_id: projectId,
        event_type: evt.eventType as string,
        event_id: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: evt.title as string,
        description: (evt.description as string) ?? '',
        properties: evt.properties ? JSON.stringify(evt.properties) : '{}',
        timestamp: evt.timestamp
          ? new Date(evt.timestamp as string).toISOString()
          : new Date().toISOString(),
        duration_minutes: (evt.durationMinutes as number) ?? null,
        severity: (evt.severity as string) ?? null,
      }));

      const ch = await getClickHouse();
      await ch.insert({
        table: 'abl_platform.external_events',
        values: rows,
        format: 'JSONEachRow',
      });

      log.info('External events batch ingested', {
        tenantId,
        projectId,
        count: rows.length,
      });
      res.json({ success: true, data: { inserted: rows.length } });
    } catch (error) {
      log.error('Failed to batch ingest external events', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Failed to batch ingest external events' },
      });
    }
  },
);

// ─── GET / ──────────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/',
  {
    summary: 'List external events',
    description: 'Returns external events for a project with optional event type filter',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const eventType = req.query.eventType as string | undefined;
      const days = Number(req.query.days) || 90;

      let query = `
        SELECT
          event_type,
          event_id,
          title,
          description,
          properties,
          timestamp,
          duration_minutes,
          severity
        FROM abl_platform.external_events
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND timestamp >= now() - INTERVAL ${days} DAY
      `;

      const queryParams: Record<string, string> = { tenantId, projectId };

      if (eventType && isValidEventType(eventType)) {
        query += `  AND event_type = {eventType:String}\n`;
        queryParams.eventType = eventType;
      }

      query += `ORDER BY timestamp DESC\nLIMIT 200\nSETTINGS max_execution_time = 10`;

      const ch = await getClickHouse();
      const result = await ch.query({ query, query_params: queryParams });
      const data = (await result.json()) as unknown as Record<string, unknown>[];

      res.json({ success: true, data });
    } catch (error) {
      log.error('Failed to list external events', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Failed to list external events' },
      });
    }
  },
);

// ─── GET /correlate ─────────────────────────────────────────────────────────

/** Maps metric aliases to MV table and aggregation columns for timeseries queries. */
const METRIC_MAP: Record<string, { table: string; numerator: string; denominator: string | null }> =
  {
    avg_sentiment: {
      table: 'abl_platform.mv_daily_sentiment',
      numerator: 'total_sentiment',
      denominator: 'conversation_count',
    },
    avg_quality: {
      table: 'abl_platform.mv_daily_quality_scores',
      numerator: 'total_score',
      denominator: 'conversation_count',
    },
    conversation_count: {
      table: 'abl_platform.mv_daily_sentiment',
      numerator: 'conversation_count',
      denominator: null,
    },
  };

openapi.route(
  'get',
  '/correlate',
  {
    summary: 'Correlate external events with metric timeseries',
    description:
      'Returns external events alongside daily metric values for visual overlay and correlation analysis',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        events: z.array(z.record(z.unknown())),
        timeseries: z.array(z.record(z.unknown())),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const metric = req.query.metric as string | undefined;
      const eventType = req.query.eventType as string | undefined;
      const days = Number(req.query.days) || 30;
      const windowHours = Number(req.query.windowHours) || 24;

      if (!metric || !METRIC_MAP[metric]) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_METRIC',
            message: `metric is required and must be one of: ${Object.keys(METRIC_MAP).join(', ')}`,
          },
        });
        return;
      }

      if (!eventType || !isValidEventType(eventType)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_EVENT_TYPE',
            message: `eventType is required and must be one of: ${[...VALID_EVENT_TYPES].join(', ')}`,
          },
        });
        return;
      }

      const ch = await getClickHouse();

      // Fetch events
      const eventsQuery = `
        SELECT
          event_type,
          event_id,
          title,
          description,
          timestamp,
          duration_minutes,
          severity
        FROM abl_platform.external_events
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND event_type = {eventType:String}
          AND timestamp >= now() - INTERVAL ${days} DAY
        ORDER BY timestamp DESC
        LIMIT 200
        SETTINGS max_execution_time = 10
      `;

      const eventsResult = await ch.query({
        query: eventsQuery,
        query_params: { tenantId, projectId, eventType },
      });
      const events = (await eventsResult.json()) as unknown as Record<string, unknown>[];

      // Fetch timeseries from the materialized view, aggregating per date
      const { table, numerator, denominator } = METRIC_MAP[metric];
      const valueExpr = denominator
        ? `round(sum(${numerator}) / sum(${denominator}), 4)`
        : `sum(${numerator})`;

      const tsQuery = `
        SELECT
          date,
          ${valueExpr} AS value,
          sum(conversation_count) AS conversation_count
        FROM ${table}
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND date >= today() - INTERVAL ${days} DAY
        GROUP BY date
        ORDER BY date ASC
        SETTINGS max_execution_time = 10
      `;

      const tsResult = await ch.query({
        query: tsQuery,
        query_params: { tenantId, projectId },
      });
      const timeseries = (await tsResult.json()) as unknown as Record<string, unknown>[];

      res.json({
        success: true,
        data: { events, timeseries, windowHours },
      });
    } catch (error) {
      log.error('Failed to correlate external events', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Failed to correlate external events' },
      });
    }
  },
);

export default openapi.router;
