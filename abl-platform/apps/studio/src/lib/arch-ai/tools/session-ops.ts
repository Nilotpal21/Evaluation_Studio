import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { ensureDb } from '@/lib/ensure-db';

const log = createLogger('arch-ai:session-ops');

const MAX_SESSIONS = 50;

interface SessionOpsInput {
  action: 'list' | 'get' | 'get_analysis';
  sessionId?: string;
  limit?: number;
  status?: string;
}

interface SessionOpsResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export async function executeSessionOps(
  input: SessionOpsInput,
  ctx: ToolPermissionContext,
): Promise<SessionOpsResult> {
  const { action } = input;

  const perm = await checkToolPermission('session_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  switch (action) {
    case 'list':
      return listSessions(projectId, input.limit ?? 10, input.status, tenantId);
    case 'get':
      if (!input.sessionId) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'sessionId is required' },
        };
      }
      return getSession(projectId, input.sessionId, tenantId);
    case 'get_analysis':
      if (!input.sessionId) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'sessionId is required' },
        };
      }
      return getSessionAnalysis(projectId, input.sessionId, tenantId);
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
      };
  }
}

async function listSessions(
  projectId: string,
  limit: number,
  status: string | undefined,
  tenantId: string,
): Promise<SessionOpsResult> {
  try {
    await ensureDb();
    const { Session, Project } = await import('@agent-platform/database/models');

    // Verify project belongs to tenant
    const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
    if (!project) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      };
    }

    const safeLimit = Math.min(Math.max(1, limit), MAX_SESSIONS);
    const filter: Record<string, unknown> = { tenantId, projectId };
    if (status) filter.status = status;

    const [sessions, total] = await Promise.all([
      Session.find(filter)
        .sort({ lastActivityAt: -1 })
        .limit(safeLimit)
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
          environment: 1,
        })
        .lean(),
      Session.countDocuments(filter),
    ]);

    // Filter out ghost sessions (0 messages, not active)
    const liveSessions = sessions.filter((s: Record<string, unknown>) => {
      const msgCount = (s.messageCount as number) || 0;
      const traceCount = (s.traceEventCount as number) || 0;
      return msgCount > 0 || traceCount > 0 || s.status === 'active';
    });

    return {
      success: true,
      data: {
        total,
        returned: liveSessions.length,
        sessions: liveSessions.map((s: Record<string, unknown>) => ({
          id: s._id,
          agentName: s.entryAgentName ?? s.currentAgent,
          status: s.status,
          channel: s.channel ?? null,
          messageCount: s.messageCount ?? 0,
          errorCount: s.errorCount ?? 0,
          traceEventCount: s.traceEventCount ?? 0,
          handoffCount: s.handoffCount ?? 0,
          disposition: s.disposition ?? null,
          startedAt: s.startedAt,
          lastActivityAt: s.lastActivityAt,
          endedAt: s.endedAt ?? null,
          environment: s.environment ?? null,
        })),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Session list failed', { projectId, error: message });
    return { success: false, error: { code: 'DB_ERROR', message } };
  }
}

async function getSession(
  projectId: string,
  sessionId: string,
  tenantId: string,
): Promise<SessionOpsResult> {
  if (!/^[\w-]{1,200}$/.test(sessionId)) {
    return {
      success: false,
      error: { code: 'INVALID_PARAM', message: 'sessionId contains invalid characters' },
    };
  }

  try {
    await ensureDb();
    const { Session } = await import('@agent-platform/database/models');

    const session = await Session.findOne({ _id: sessionId, tenantId, projectId }).lean();
    if (!session) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Session "${sessionId}" not found` },
      };
    }

    const s = session as Record<string, unknown>;
    return {
      success: true,
      data: {
        id: s._id,
        agentName: s.entryAgentName ?? s.currentAgent,
        currentAgent: s.currentAgent,
        status: s.status,
        channel: s.channel,
        messageCount: s.messageCount ?? 0,
        errorCount: s.errorCount ?? 0,
        traceEventCount: s.traceEventCount ?? 0,
        tokenCount: s.tokenCount ?? 0,
        handoffCount: s.handoffCount ?? 0,
        disposition: s.disposition ?? null,
        outcome: s.outcome ?? null,
        environment: s.environment ?? null,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        endedAt: s.endedAt ?? null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Session get failed', { projectId, sessionId, error: message });
    return { success: false, error: { code: 'DB_ERROR', message } };
  }
}

async function getSessionAnalysis(
  projectId: string,
  sessionId: string,
  tenantId: string,
): Promise<SessionOpsResult> {
  // Get session details + summary analysis from DB
  const sessionResult = await getSession(projectId, sessionId, tenantId);
  if (!sessionResult.success) return sessionResult;

  const session = sessionResult.data as Record<string, unknown>;

  const issues: string[] = [];
  if ((session.errorCount as number) > 0) {
    issues.push(`${session.errorCount} error(s) occurred during this session`);
  }
  if ((session.messageCount as number) === 0) {
    issues.push('Session has no messages — user may have abandoned immediately');
  }
  if (session.disposition === 'escalated') {
    issues.push('Session was escalated to a human agent');
  }
  if (session.disposition === 'abandoned') {
    issues.push('Session was abandoned by the user');
  }
  if (session.disposition === 'timeout') {
    issues.push('Session timed out');
  }

  return {
    success: true,
    data: {
      session,
      analysis: {
        issueCount: issues.length,
        issues,
        hasErrors: (session.errorCount as number) > 0,
        wasEscalated: session.disposition === 'escalated',
        hint:
          issues.length === 0
            ? 'No obvious issues. Use trace_diagnosis with action "deep_dive" and this sessionId for detailed trace and diagnostic inspection.'
            : 'Use trace_diagnosis with action "deep_dive" and this sessionId to inspect the trace evidence behind each issue.',
      },
    },
  };
}
