/**
 * Admin Sessions Dashboard API
 *
 * Centralized monitoring and management of agent execution sessions.
 * Parallel to search-ai crawl dashboard.
 *
 * Endpoints:
 * - GET /api/admin/runtime/sessions - List all active sessions with filtering
 * - GET /api/admin/runtime/sessions/:sessionId - Get detailed session state
 * - GET /api/admin/runtime/sessions/stats - Aggregate session statistics
 *
 * Query parameters:
 * - tenantId: Filter by tenant (required)
 * - agentId: Filter by agent
 * - status: active, paused, completed, error
 * - channel: web, api, sdk, voice, email, slack, whatsapp, teams, messenger
 * - since/until: Time range filtering
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { listSessions, countSessions, findSessionById } from '../repos/session-repo.js';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('admin-sessions');

const router: RouterType = Router();

// All admin session routes require authentication + tenant admin permission.
// tenantId is derived from the authenticated user's tenant context, not from query params.
router.use(authMiddleware);
router.use(requirePermission('tenant:manage_settings'));

/**
 * GET /api/admin/runtime/sessions/stats
 *
 * Get aggregate statistics across sessions.
 * IMPORTANT: This route must be defined BEFORE /:sessionId to prevent "stats" from being matched as a session ID.
 *
 * Query parameters:
 * - tenantId (required): Filter by tenant
 * - agentId: Filter by agent
 * - since/until: Time range
 *
 * Returns:
 * - Total sessions
 * - Breakdown by status
 * - Breakdown by channel
 * - Total messages, tokens, estimated cost
 * - Average session duration
 * - Total errors, handoffs
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(403).json({ success: false, error: 'Tenant context required' });
    }
    const { agentId, since, until } = req.query;

    // Build base filter
    const filter: Record<string, unknown> = { tenantId };

    if (agentId && typeof agentId === 'string') {
      filter.currentAgent = agentId;
    }

    if (since || until) {
      const timeFilter: Record<string, Date> = {};
      if (since && typeof since === 'string') {
        timeFilter.$gte = new Date(since);
      }
      if (until && typeof until === 'string') {
        timeFilter.$lte = new Date(until);
      }
      filter.startedAt = timeFilter;
    }

    // Fetch all matching sessions with metrics
    const sessions = await listSessions(filter, {
      select: {
        status: true,
        channel: true,
        messageCount: true,
        tokenCount: true,
        estimatedCost: true,
        errorCount: true,
        handoffCount: true,
        traceEventCount: true,
        startedAt: true,
        lastActivityAt: true,
        endedAt: true,
      },
    });

    // Aggregate statistics
    const stats = {
      totalSessions: sessions.length,
      byStatus: {} as Record<string, number>,
      byChannel: {} as Record<string, number>,
      metrics: {
        totalMessages: 0,
        totalTokens: 0,
        totalEstimatedCost: 0,
        totalErrors: 0,
        totalHandoffs: 0,
        totalTraceEvents: 0,
        avgSessionDuration: 0,
      },
    };

    let totalDuration = 0;

    for (const session of sessions) {
      // Status breakdown
      stats.byStatus[session.status] = (stats.byStatus[session.status] || 0) + 1;

      // Channel breakdown
      stats.byChannel[session.channel] = (stats.byChannel[session.channel] || 0) + 1;

      // Metrics aggregation
      stats.metrics.totalMessages += session.messageCount || 0;
      stats.metrics.totalTokens += session.tokenCount || 0;
      stats.metrics.totalEstimatedCost += session.estimatedCost || 0;
      stats.metrics.totalErrors += session.errorCount || 0;
      stats.metrics.totalHandoffs += session.handoffCount || 0;
      stats.metrics.totalTraceEvents += session.traceEventCount || 0;

      // Duration calculation
      const startTime = new Date(session.startedAt).getTime();
      const endTime = session.endedAt
        ? new Date(session.endedAt).getTime()
        : new Date(session.lastActivityAt).getTime();
      totalDuration += endTime - startTime;
    }

    if (sessions.length > 0) {
      stats.metrics.avgSessionDuration = totalDuration / sessions.length;
    }

    res.status(200).json({
      success: true,
      stats: {
        ...stats,
        metrics: {
          ...stats.metrics,
          avgSessionDurationFormatted: formatDuration(stats.metrics.avgSessionDuration),
        },
      },
    });
  } catch (error: any) {
    log.error('[admin-sessions] Failed to get session stats:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/admin/runtime/sessions
 *
 * List all sessions with optional filtering.
 *
 * Query parameters:
 * - tenantId (required): Filter by tenant
 * - agentId: Filter by agent name
 * - status: Filter by session status (active, paused, completed, error)
 * - channel: Filter by channel type
 * - identityTier: Filter by identity tier (0=anonymous, 1=unverified, 2=verified)
 * - since: Filter sessions started after this timestamp (ISO 8601)
 * - until: Filter sessions started before this timestamp (ISO 8601)
 * - limit: Number of results per page (default: 50, max: 100)
 * - offset: Pagination offset (default: 0)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(403).json({ success: false, error: 'Tenant context required' });
    }
    const {
      agentId,
      status,
      channel,
      identityTier,
      since,
      until,
      limit = '50',
      offset = '0',
    } = req.query;

    // Build filter
    const filter: Record<string, unknown> = { tenantId };

    if (agentId && typeof agentId === 'string') {
      filter.currentAgent = agentId;
    }

    if (status && typeof status === 'string') {
      filter.status = status;
    }

    if (channel && typeof channel === 'string') {
      filter.channel = channel;
    }

    if (identityTier && typeof identityTier === 'string') {
      const tier = parseInt(identityTier, 10);
      if (!isNaN(tier)) {
        filter.identityTier = tier;
      }
    }

    // Time range filtering
    if (since || until) {
      const timeFilter: Record<string, Date> = {};
      if (since && typeof since === 'string') {
        timeFilter.$gte = new Date(since);
      }
      if (until && typeof until === 'string') {
        timeFilter.$lte = new Date(until);
      }
      filter.startedAt = timeFilter;
    }

    // Pagination
    const limitNum = Math.min(parseInt(String(limit), 10) || 50, 100);
    const offsetNum = parseInt(String(offset), 10) || 0;

    // Fetch sessions
    const sessions = await listSessions(filter, {
      orderBy: { lastActivityAt: 'desc' },
      skip: offsetNum,
      take: limitNum,
      select: {
        id: true,
        tenantId: true,
        projectId: true,
        currentAgent: true,
        agentVersion: true,
        channel: true,
        status: true,
        disposition: true,
        startedAt: true,
        lastActivityAt: true,
        endedAt: true,
        messageCount: true,
        tokenCount: true,
        estimatedCost: true,
        errorCount: true,
        handoffCount: true,
        traceEventCount: true,
        identityTier: true,
        verificationMethod: true,
        customerId: true,
        anonymousId: true,
        isTest: true,
      },
    });

    // Get total count for pagination
    const total = await countSessions(filter);

    // Calculate duration for active sessions
    const enrichedSessions = sessions.map((session: any) => {
      const startTime = new Date(session.startedAt).getTime();
      const endTime = session.endedAt
        ? new Date(session.endedAt).getTime()
        : new Date(session.lastActivityAt).getTime();
      const durationMs = endTime - startTime;

      return {
        ...session,
        durationMs,
        durationFormatted: formatDuration(durationMs),
      };
    });

    res.status(200).json({
      success: true,
      sessions: enrichedSessions,
      pagination: {
        total,
        limit: limitNum,
        offset: offsetNum,
        hasMore: offsetNum + limitNum < total,
      },
    });
  } catch (error: any) {
    log.error('[admin-sessions] Failed to list sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/admin/runtime/sessions/:sessionId
 *
 * Get detailed information about a specific session.
 *
 * Returns:
 * - Session metadata
 * - Current state
 * - Message count, token usage, cost
 * - Error count, handoff count
 * - Caller context (identity tier, channel)
 */
router.get('/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const tenantId = (req as any).tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(403).json({ success: false, error: 'Tenant context required' });
    }

    const session = await findSessionById(sessionId, tenantId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    // Calculate duration
    const startTime = new Date(session.startedAt).getTime();
    const endTime = session.endedAt
      ? new Date(session.endedAt).getTime()
      : new Date(session.lastActivityAt).getTime();
    const durationMs = endTime - startTime;

    res.status(200).json({
      success: true,
      session: {
        ...session,
        durationMs,
        durationFormatted: formatDuration(durationMs),
      },
    });
  } catch (error: any) {
    log.error('[admin-sessions] Failed to get session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export default router;
