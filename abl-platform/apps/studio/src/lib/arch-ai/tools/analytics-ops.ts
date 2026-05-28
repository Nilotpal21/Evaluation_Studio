import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { ensureDb } from '@/lib/ensure-db';

const log = createLogger('arch-ai:analytics-ops');

const SESSION_FETCH_LIMIT = 200;

interface AnalyticsOpsInput {
  action: 'metrics' | 'intents' | 'quality_scores' | 'anomalies';
  timeRange?: '1h' | '24h' | '7d' | '30d';
  agentName?: string;
}

const TIME_RANGE_MS: Record<NonNullable<AnalyticsOpsInput['timeRange']>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface AnalyticsOpsResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export async function executeAnalyticsOps(
  input: AnalyticsOpsInput,
  ctx: ToolPermissionContext,
): Promise<AnalyticsOpsResult> {
  const { action } = input;

  const perm = await checkToolPermission('analytics_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  switch (action) {
    case 'metrics':
      return getMetrics(projectId, input.agentName, tenantId, input.timeRange);
    case 'anomalies':
      return getAnomalies(projectId, input.agentName, tenantId, input.timeRange);
    case 'intents':
    case 'quality_scores':
      return {
        success: true,
        data: {
          available: false,
          message: `${action} requires a dedicated analytics pipeline that is not yet configured. Use session_ops to list sessions, then analyze individual sessions with the analyze tool.`,
        },
      };
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
      };
  }
}

/** Query sessions directly from DB for aggregate analytics. */
async function fetchSessionsFromDb(
  projectId: string,
  tenantId: string,
  timeRange?: AnalyticsOpsInput['timeRange'],
): Promise<Array<Record<string, unknown>> | null> {
  try {
    await ensureDb();
    const { Session, Project } = await import('@agent-platform/database/models');

    const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
    if (!project) return null;

    const filter: Record<string, unknown> = { tenantId, projectId };
    if (timeRange) {
      const since = new Date(Date.now() - TIME_RANGE_MS[timeRange]);
      filter.lastActivityAt = { $gte: since };
    }

    const sessions = await Session.find(filter)
      .sort({ lastActivityAt: -1 })
      .limit(SESSION_FETCH_LIMIT)
      .select({
        _id: 1,
        currentAgent: 1,
        entryAgentName: 1,
        channel: 1,
        status: 1,
        messageCount: 1,
        errorCount: 1,
        traceEventCount: 1,
        tokenCount: 1,
        handoffCount: 1,
        disposition: 1,
        startedAt: 1,
        lastActivityAt: 1,
        endedAt: 1,
      })
      .lean();

    return sessions as Array<Record<string, unknown>>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Session DB fetch for analytics failed', { projectId, error: message });
    return null;
  }
}

async function getMetrics(
  projectId: string,
  agentName: string | undefined,
  tenantId: string,
  timeRange: AnalyticsOpsInput['timeRange'] | undefined,
): Promise<AnalyticsOpsResult> {
  const sessions = await fetchSessionsFromDb(projectId, tenantId, timeRange);
  if (!sessions) {
    return {
      success: false,
      error: { code: 'ANALYTICS_FETCH_ERROR', message: 'Could not fetch sessions from database' },
    };
  }

  const filtered = agentName
    ? sessions.filter((s) => s.entryAgentName === agentName || s.currentAgent === agentName)
    : sessions;

  const totalSessions = filtered.length;
  const totalMessages = filtered.reduce((sum, s) => sum + (Number(s.messageCount) || 0), 0);
  const totalErrors = filtered.reduce((sum, s) => sum + (Number(s.errorCount) || 0), 0);
  const totalTraces = filtered.reduce((sum, s) => sum + (Number(s.traceEventCount) || 0), 0);
  const activeSessions = filtered.filter((s) => s.status === 'active').length;

  const agentBreakdown: Record<string, number> = {};
  for (const s of filtered) {
    const name = (s.entryAgentName ?? s.currentAgent ?? 'unknown') as string;
    agentBreakdown[name] = (agentBreakdown[name] ?? 0) + 1;
  }

  return {
    success: true,
    data: {
      totalSessions,
      activeSessions,
      completedSessions: totalSessions - activeSessions,
      totalMessages,
      totalErrors,
      errorRate: totalSessions > 0 ? totalErrors / totalSessions : 0,
      totalTraceEvents: totalTraces,
      agentBreakdown,
      source: 'session_aggregate',
    },
  };
}

async function getAnomalies(
  projectId: string,
  agentName: string | undefined,
  tenantId: string,
  timeRange: AnalyticsOpsInput['timeRange'] | undefined,
): Promise<AnalyticsOpsResult> {
  const sessions = await fetchSessionsFromDb(projectId, tenantId, timeRange);
  if (!sessions) {
    return {
      success: false,
      error: { code: 'ANALYTICS_FETCH_ERROR', message: 'Could not fetch sessions from database' },
    };
  }

  const filtered = agentName
    ? sessions.filter((s) => s.entryAgentName === agentName || s.currentAgent === agentName)
    : sessions;

  const anomalies: Array<{ sessionId: string; type: string; detail: string }> = [];

  for (const s of filtered) {
    const errorCount = Number(s.errorCount) || 0;
    const msgCount = Number(s.messageCount) || 0;
    const sessionAgentName = (s.entryAgentName ?? s.currentAgent) as string;

    if (errorCount > 0) {
      anomalies.push({
        sessionId: s._id as string,
        type: 'errors',
        detail: `${errorCount} error(s) in session with ${msgCount} messages (agent: ${sessionAgentName})`,
      });
    }

    if (msgCount === 0 && s.status !== 'active') {
      anomalies.push({
        sessionId: s._id as string,
        type: 'empty_session',
        detail: `Session ended with 0 messages (agent: ${sessionAgentName})`,
      });
    }

    if (s.disposition === 'escalated') {
      anomalies.push({
        sessionId: s._id as string,
        type: 'escalation',
        detail: `Session was escalated to human support (agent: ${sessionAgentName})`,
      });
    }
  }

  return {
    success: true,
    data: {
      anomalyCount: anomalies.length,
      anomalies: anomalies.slice(0, 20),
      sessionsAnalyzed: filtered.length,
      source: 'session_aggregate',
    },
  };
}
