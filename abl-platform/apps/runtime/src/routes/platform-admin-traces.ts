/**
 * Platform Admin — Trace Inspection Routes
 *
 * Cross-tenant trace lookup for platform administrators.
 * Answers "what happened with this trace?" without exposing tenant PII.
 *
 * Data boundary:
 * - SAFE columns: event_type, category, timestamp, span_id, parent_span_id,
 *   agent_name, duration_ms, has_error, error_type, channel, deployment_id
 * - BLOCKED columns: data (user messages/LLM content), error_message (may echo
 *   user input), metadata (custom dimensions), actor_id (end-user identity)
 *
 * Key rules:
 * - All routes require `requirePlatformAdmin()` + IP allow-list
 * - Every lookup writes an audit log with `platform-admin:trace-*` prefix
 * - ClickHouse queries never SELECT data, error_message, metadata, or actor_id
 *
 * Mount: /api/platform/admin/traces
 */

import { Router } from 'express';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { findSessionSummaryByAnyId } from '../repos/session-repo.js';

const log = createLogger('platform-admin-traces');
const router: ReturnType<typeof Router> = Router();

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Constants ────────────────────────────────────────────────────────────

const PLATFORM_EVENTS_TABLE = 'abl_platform.platform_events';
const SPATIAL_TRACE_TABLE = 'abl_platform.spatial_trace_records';
const LLM_METRICS_TABLE = 'abl_platform.llm_metrics';

/** Maximum events returned per trace lookup. */
const MAX_TRACE_EVENTS = 5000;

/** Maximum results for search. */
const MAX_SEARCH_RESULTS = 100;

/** Default lookback for search (7 days). */
const DEFAULT_SEARCH_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Safe columns for platform_events — explicitly excludes data, error_message,
 * metadata, and actor_id to prevent PII leakage.
 */
const SAFE_EVENT_COLUMNS = [
  'event_id',
  'event_type',
  'category',
  'timestamp',
  'tenant_id',
  'project_id',
  'session_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'agent_name',
  'deployment_id',
  'channel',
  'actor_type',
  'duration_ms',
  'has_error',
  'error_type',
].join(', ');

// ─── Helpers ──────────────────────────────────────────────────────────────

async function getClickHouse() {
  try {
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    return getClickHouseClient();
  } catch {
    return null;
  }
}

async function getTenantName(tenantId: string): Promise<string> {
  try {
    const { Tenant } = await import('@agent-platform/database/models');
    const tenant = await Tenant.findOne({ _id: tenantId }, { name: 1 }).lean().exec();
    return (tenant as any)?.name ?? tenantId;
  } catch {
    return tenantId;
  }
}

async function findSessionSummaryFallback(sessionId: string): Promise<any | null> {
  try {
    return await findSessionSummaryByAnyId(sessionId);
  } catch (error: unknown) {
    log.warn('Platform-admin session summary fallback lookup failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function parseTimeRange(query: Record<string, unknown>): { from: Date; to: Date } {
  const now = new Date();
  const to = query.to ? new Date(String(query.to)) : now;
  const from = query.from
    ? new Date(String(query.from))
    : new Date(to.getTime() - DEFAULT_SEARCH_LOOKBACK_MS);
  return { from, to };
}

// ─── GET /search — Cross-Tenant Trace Search ─────────────────────────────

/**
 * Search traces across all tenants.
 *
 * Query params:
 * - from/to: time range (ISO 8601, defaults to last 7 days)
 * - tenantId: optional tenant filter
 * - hasError: 'true' to show only error traces
 * - agentName: filter by agent
 * - channel: filter by channel
 * - minDurationMs: slow trace threshold
 * - limit/offset: pagination (max 100)
 */
router.get('/search', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const client = await getClickHouse();
    if (!client) {
      res.status(503).json({ success: false, error: 'Trace store unavailable' });
      return;
    }

    const { from, to } = parseTimeRange(req.query as Record<string, unknown>);
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, MAX_SEARCH_RESULTS);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;

    // Build WHERE conditions
    const conditions: string[] = [
      'timestamp >= {from:DateTime64(3)}',
      'timestamp <= {to:DateTime64(3)}',
      "trace_id != ''",
    ];
    const params: Record<string, unknown> = { from, to, limit, offset };

    if (req.query.tenantId && typeof req.query.tenantId === 'string') {
      conditions.push('tenant_id = {tenantId:String}');
      params.tenantId = req.query.tenantId;
    }

    if (req.query.hasError === 'true') {
      conditions.push('has_error = 1');
    }

    if (req.query.agentName && typeof req.query.agentName === 'string') {
      conditions.push('agent_name = {agentName:String}');
      params.agentName = req.query.agentName;
    }

    if (req.query.channel && typeof req.query.channel === 'string') {
      conditions.push('channel = {channel:String}');
      params.channel = req.query.channel;
    }

    const havingClauses: string[] = [];
    if (req.query.minDurationMs && typeof req.query.minDurationMs === 'string') {
      havingClauses.push('total_duration_ms >= {minDurationMs:UInt32}');
      params.minDurationMs = parseInt(req.query.minDurationMs, 10);
    }

    const whereClause = conditions.join(' AND ');
    const havingClause = havingClauses.length > 0 ? `HAVING ${havingClauses.join(' AND ')}` : '';

    const query = `
      SELECT
        trace_id,
        tenant_id,
        project_id,
        any(session_id) AS session_id,
        any(agent_name) AS agent_name,
        any(channel) AS channel,
        min(timestamp) AS started_at,
        max(timestamp) AS ended_at,
        max(timestamp) - min(timestamp) AS total_duration_ms,
        count() AS event_count,
        countIf(has_error = 1) AS error_count,
        groupUniqArray(event_type) AS event_types
      FROM ${PLATFORM_EVENTS_TABLE}
      WHERE ${whereClause}
      GROUP BY trace_id, tenant_id, project_id
      ${havingClause}
      ORDER BY started_at DESC
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `;

    const resultSet = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });

    const rows = (await resultSet.json()) as any[];

    // Enrich with tenant names
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
    const tenantNames = new Map<string, string>();
    for (const id of tenantIds) {
      tenantNames.set(id, await getTenantName(id));
    }

    const traces = rows.map((row) => ({
      traceId: row.trace_id,
      tenantId: row.tenant_id,
      tenantName: tenantNames.get(row.tenant_id) ?? row.tenant_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      agentName: row.agent_name,
      channel: row.channel,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      totalDurationMs: Number(row.total_duration_ms),
      eventCount: Number(row.event_count),
      errorCount: Number(row.error_count),
      eventTypes: row.event_types,
    }));

    const adminUserId = req.tenantContext?.userId;
    writeAuditLog({
      action: 'platform-admin:trace-search',
      userId: adminUserId,
      metadata: {
        requestId,
        resultCount: traces.length,
        filters: {
          from: from.toISOString(),
          to: to.toISOString(),
          tenantId: req.query.tenantId,
          hasError: req.query.hasError,
          agentName: req.query.agentName,
        },
      },
    });

    res.json({
      success: true,
      traces,
      pagination: { limit, offset, hasMore: traces.length === limit },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Trace search failed', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to search traces' });
  }
});

// ─── GET /:traceId — Trace Detail ────────────────────────────────────────

/**
 * Get the full event timeline for a trace.
 *
 * Returns SAFE columns only — data, error_message, metadata, and actor_id
 * are never selected from ClickHouse.
 */
router.get('/:traceId', async (req, res) => {
  const requestId = getCurrentRequestId();
  const { traceId } = req.params;
  try {
    const client = await getClickHouse();
    if (!client) {
      res.status(503).json({ success: false, error: 'Trace store unavailable' });
      return;
    }

    // Fetch events with safe columns only
    const query = `
      SELECT ${SAFE_EVENT_COLUMNS}
      FROM ${PLATFORM_EVENTS_TABLE}
      WHERE trace_id = {traceId:String}
      ORDER BY timestamp ASC
      LIMIT ${MAX_TRACE_EVENTS}
    `;

    const resultSet = await client.query({
      query,
      query_params: { traceId },
      format: 'JSONEachRow',
    });

    const events = (await resultSet.json()) as any[];

    if (events.length === 0) {
      res.status(404).json({ success: false, error: 'Trace not found' });
      return;
    }

    // Build trace summary from events
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const tenantId = firstEvent.tenant_id;
    const tenantName = await getTenantName(tenantId);

    const trace = {
      traceId,
      tenantId,
      tenantName,
      projectId: firstEvent.project_id,
      sessionId: firstEvent.session_id,
      channel: events.find((e: any) => e.channel)?.channel ?? '',
      startedAt: firstEvent.timestamp,
      endedAt: lastEvent.timestamp,
      totalDurationMs:
        new Date(lastEvent.timestamp).getTime() - new Date(firstEvent.timestamp).getTime(),
      totalEvents: events.length,
      hasErrors: events.some((e: any) => Number(e.has_error) === 1),
      errorCount: events.filter((e: any) => Number(e.has_error) === 1).length,
    };

    const timeline = events.map((e: any) => ({
      eventId: e.event_id,
      eventType: e.event_type,
      category: e.category,
      timestamp: e.timestamp,
      spanId: e.span_id,
      parentSpanId: e.parent_span_id,
      agentName: e.agent_name,
      durationMs: Number(e.duration_ms),
      hasError: Number(e.has_error) === 1,
      errorType: e.error_type,
      channel: e.channel,
      deploymentId: e.deployment_id,
      actorType: e.actor_type,
    }));

    const adminUserId = req.tenantContext?.userId;
    writeAuditLog({
      action: 'platform-admin:trace-lookup',
      userId: adminUserId,
      tenantId,
      metadata: { requestId, traceId, eventCount: events.length },
    });

    res.json({ success: true, trace, timeline });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Trace lookup failed', { error: message, requestId, traceId });
    res.status(500).json({ success: false, error: 'Failed to get trace' });
  }
});

// ─── GET /:traceId/performance — STI Performance ─────────────────────────

/**
 * Get STI path-level performance for a trace.
 *
 * Queries spatial_trace_records — all columns are safe (no PII in schema).
 */
router.get('/:traceId/performance', async (req, res) => {
  const requestId = getCurrentRequestId();
  const { traceId } = req.params;
  try {
    const client = await getClickHouse();
    if (!client) {
      res.status(503).json({ success: false, error: 'Trace store unavailable' });
      return;
    }

    const query = `
      SELECT
        sti_path,
        span_id,
        parent_span_id,
        session_id,
        agent_name,
        deployment_id,
        config_hash,
        started_at,
        ended_at,
        duration_ms,
        has_error,
        error_type,
        input_tokens,
        output_tokens,
        total_tokens,
        model_id,
        provider,
        tool_name,
        attributes
      FROM ${SPATIAL_TRACE_TABLE}
      WHERE trace_id = {traceId:String}
      ORDER BY started_at ASC
    `;

    const resultSet = await client.query({
      query,
      query_params: { traceId },
      format: 'JSONEachRow',
    });

    const rows = (await resultSet.json()) as any[];

    const paths = rows.map((r: any) => ({
      stiPath: r.sti_path,
      spanId: r.span_id,
      parentSpanId: r.parent_span_id,
      agentName: r.agent_name,
      configHash: r.config_hash,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: Number(r.duration_ms),
      hasError: Number(r.has_error) === 1,
      errorType: r.error_type,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      totalTokens: Number(r.total_tokens),
      modelId: r.model_id,
      provider: r.provider,
      toolName: r.tool_name,
      attributes: (() => {
        try {
          return r.attributes ? JSON.parse(r.attributes) : {};
        } catch {
          return {};
        }
      })(),
    }));

    // Aggregate totals
    const totals = {
      totalDurationMs: paths.reduce((sum: number, p: any) => sum + p.durationMs, 0),
      totalTokens: paths.reduce((sum: number, p: any) => sum + p.totalTokens, 0),
      totalPaths: paths.length,
      errorPaths: paths.filter((p: any) => p.hasError).length,
      modelBreakdown: Object.entries(
        paths
          .filter((p: any) => p.modelId)
          .reduce(
            (acc: Record<string, { tokens: number; count: number }>, p: any) => {
              if (!acc[p.modelId]) acc[p.modelId] = { tokens: 0, count: 0 };
              acc[p.modelId].tokens += p.totalTokens;
              acc[p.modelId].count += 1;
              return acc;
            },
            {} as Record<string, { tokens: number; count: number }>,
          ),
      ).map(([modelId, stats]) => ({ modelId, ...stats })),
    };

    const adminUserId = req.tenantContext?.userId;
    writeAuditLog({
      action: 'platform-admin:trace-performance',
      userId: adminUserId,
      metadata: { requestId, traceId, pathCount: paths.length },
    });

    res.json({ success: true, paths, totals });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Trace performance lookup failed', { error: message, requestId, traceId });
    res.status(500).json({ success: false, error: 'Failed to get trace performance' });
  }
});

// ─── GET /:traceId/cost — LLM Cost Breakdown ─────────────────────────────

/**
 * Get LLM cost breakdown for a trace's session.
 *
 * Queries llm_metrics — no content columns, only usage/cost metrics.
 */
router.get('/:traceId/cost', async (req, res) => {
  const requestId = getCurrentRequestId();
  const { traceId } = req.params;
  try {
    const client = await getClickHouse();
    if (!client) {
      res.status(503).json({ success: false, error: 'Trace store unavailable' });
      return;
    }

    // First resolve the session_id from the trace
    const sessionQuery = `
      SELECT DISTINCT session_id
      FROM ${PLATFORM_EVENTS_TABLE}
      WHERE trace_id = {traceId:String} AND session_id != ''
      LIMIT 1
    `;

    const sessionResult = await client.query({
      query: sessionQuery,
      query_params: { traceId },
      format: 'JSONEachRow',
    });

    const sessionRows = (await sessionResult.json()) as any[];
    if (sessionRows.length === 0) {
      res.json({
        success: true,
        calls: [],
        totals: { totalCost: 0, totalTokens: 0, callCount: 0 },
      });
      return;
    }

    const sessionId = sessionRows[0].session_id;

    // Query LLM metrics for this session
    const costQuery = `
      SELECT
        model_id,
        provider,
        operation_type,
        agent_name,
        input_tokens,
        output_tokens,
        total_tokens,
        estimated_cost,
        latency_ms,
        success,
        error_type,
        timestamp
      FROM ${LLM_METRICS_TABLE}
      WHERE session_id = {sessionId:String}
      ORDER BY timestamp ASC
    `;

    const costResult = await client.query({
      query: costQuery,
      query_params: { sessionId },
      format: 'JSONEachRow',
    });

    const rows = (await costResult.json()) as any[];

    const calls = rows.map((r: any) => ({
      modelId: r.model_id,
      provider: r.provider,
      operationType: r.operation_type,
      agentName: r.agent_name,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      totalTokens: Number(r.total_tokens),
      estimatedCost: Number(r.estimated_cost),
      latencyMs: Number(r.latency_ms),
      success: Number(r.success) === 1,
      errorType: r.error_type,
      timestamp: r.timestamp,
    }));

    const totals = {
      totalCost: calls.reduce((sum: number, c: any) => sum + c.estimatedCost, 0),
      totalTokens: calls.reduce((sum: number, c: any) => sum + c.totalTokens, 0),
      callCount: calls.length,
      byModel: Object.entries(
        calls.reduce(
          (acc: Record<string, { tokens: number; cost: number; count: number }>, c: any) => {
            const key = `${c.provider}/${c.modelId}`;
            if (!acc[key]) acc[key] = { tokens: 0, cost: 0, count: 0 };
            acc[key].tokens += c.totalTokens;
            acc[key].cost += c.estimatedCost;
            acc[key].count += 1;
            return acc;
          },
          {} as Record<string, { tokens: number; cost: number; count: number }>,
        ),
      ).map(([model, stats]) => ({ model, ...stats })),
    };

    const adminUserId = req.tenantContext?.userId;
    writeAuditLog({
      action: 'platform-admin:trace-cost',
      userId: adminUserId,
      metadata: { requestId, traceId, sessionId, callCount: calls.length },
    });

    res.json({ success: true, calls, totals });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Trace cost lookup failed', { error: message, requestId, traceId });
    res.status(500).json({ success: false, error: 'Failed to get trace cost' });
  }
});

// ─── GET /sessions/:sessionId/summary — Session Metadata ─────────────────

/**
 * Get session metadata without conversation content.
 *
 * Returns operational metadata only — no messages, no context variables.
 */
router.get('/sessions/:sessionId/summary', async (req, res) => {
  const requestId = getCurrentRequestId();
  const { sessionId } = req.params;
  try {
    const { findSessionById } = await import('../repos/session-repo.js');
    let tenantId: string | null = null;
    let session: any | null = null;

    // Preferred path: use ClickHouse to resolve tenant for runtime session ids.
    const client = await getClickHouse();
    if (client) {
      try {
        const tenantQuery = `
          SELECT DISTINCT tenant_id, project_id
          FROM ${PLATFORM_EVENTS_TABLE}
          WHERE session_id = {sessionId:String}
          LIMIT 1
        `;

        const tenantResult = await client.query({
          query: tenantQuery,
          query_params: { sessionId },
          format: 'JSONEachRow',
        });

        const tenantRows = (await tenantResult.json()) as any[];
        const candidateTenantId =
          tenantRows.length > 0 && typeof tenantRows[0].tenant_id === 'string'
            ? tenantRows[0].tenant_id
            : null;
        if (candidateTenantId) {
          tenantId = candidateTenantId;
          session = await findSessionById(sessionId, candidateTenantId);
        }
      } catch (error: unknown) {
        log.warn('ClickHouse lookup failed for platform-admin session summary; falling back', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!session) {
      session = await findSessionSummaryFallback(sessionId);
      tenantId = typeof session?.tenantId === 'string' ? session.tenantId : null;
    }

    if (!session || !tenantId) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    const tenantName = await getTenantName(tenantId);

    // Return operational metadata only — no messages, no context
    const startTime = new Date((session as any).startedAt).getTime();
    const endTime = (session as any).endedAt
      ? new Date((session as any).endedAt).getTime()
      : new Date((session as any).lastActivityAt).getTime();
    const durationMs = endTime - startTime;

    const summary = {
      sessionId,
      tenantId,
      tenantName,
      projectId: (session as any).projectId,
      status: (session as any).status,
      disposition: (session as any).disposition,
      channel: (session as any).channel,
      currentAgent: (session as any).currentAgent,
      agentVersion: (session as any).agentVersion,
      startedAt: (session as any).startedAt,
      lastActivityAt: (session as any).lastActivityAt,
      endedAt: (session as any).endedAt,
      durationMs,
      messageCount: (session as any).messageCount ?? 0,
      tokenCount: (session as any).tokenCount ?? 0,
      estimatedCost: (session as any).estimatedCost ?? 0,
      errorCount: (session as any).errorCount ?? 0,
      handoffCount: (session as any).handoffCount ?? 0,
      traceEventCount: (session as any).traceEventCount ?? 0,
      identityTier: (session as any).identityTier,
      isTest: (session as any).isTest ?? false,
    };

    const adminUserId = req.tenantContext?.userId;
    writeAuditLog({
      action: 'platform-admin:session-summary',
      userId: adminUserId,
      tenantId,
      metadata: { requestId, sessionId },
    });

    res.json({ success: true, summary });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Session summary lookup failed', { error: message, requestId, sessionId });
    res.status(500).json({ success: false, error: 'Failed to get session summary' });
  }
});

export default router;
