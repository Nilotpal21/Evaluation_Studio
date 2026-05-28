import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { getRuntimeUrl } from '@/config/runtime.server';

const log = createLogger('arch-ai:analyze');

const RUNTIME_PROXY_TIMEOUT_MS = 10_000;

const ANALYSIS_TOOL_MAP: Record<string, string> = {
  explain: 'kore_explain_dsl',
  suggest: 'kore_suggest_improvements',
  test: 'kore_test_agent',
};

interface AnalyzeInput {
  action: 'explain' | 'suggest' | 'test' | 'query_traces';
  agentName?: string;
  sessionId?: string;
  traceTypes?: string[];
  limit?: number;
}

interface AnalyzeResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export async function executeAnalyze(
  input: AnalyzeInput,
  ctx: ToolPermissionContext,
): Promise<AnalyzeResult> {
  const { action } = input;
  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  const perm = await checkToolPermission('analyze', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (action === 'query_traces') {
    if (!input.sessionId) {
      return { success: false, error: { code: 'MISSING_PARAM', message: 'sessionId is required' } };
    }
    return queryTraces(
      projectId,
      input.sessionId,
      input.traceTypes,
      input.limit ?? 50,
      tenantId,
      ctx.authToken,
    );
  }

  if (!input.agentName) {
    return { success: false, error: { code: 'MISSING_PARAM', message: 'agentName is required' } };
  }
  return executeAnalysisTool(action, projectId, input.agentName, tenantId);
}

async function executeAnalysisTool(
  action: string,
  projectId: string,
  agentName: string,
  tenantId: string,
): Promise<AnalyzeResult> {
  const { findProjectAgent } = await import('@/repos/project-repo');
  const agent = await findProjectAgent(projectId, agentName, tenantId);

  if (!agent) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: `Agent "${agentName}" not found in project` },
    };
  }

  if (!agent.dslContent) {
    return {
      success: false,
      error: { code: 'NO_DSL', message: `Agent "${agentName}" has no DSL content` },
    };
  }

  const toolName = ANALYSIS_TOOL_MAP[action];

  try {
    const response = await fetch('/api/abl/analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: toolName, dsl: agent.dslContent }),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: { code: 'ANALYSIS_ERROR', message: text },
      };
    }

    const result = await response.json();
    return { success: true, data: result.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Analysis tool failed', { action, agentName, error: message });
    return {
      success: false,
      error: { code: 'ANALYSIS_FETCH_ERROR', message },
    };
  }
}

async function queryTraces(
  projectId: string,
  sessionId: string,
  traceTypes: string[] | undefined,
  limit: number,
  tenantId: string,
  authToken?: string,
): Promise<AnalyzeResult> {
  if (!sessionId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'sessionId is required' },
    };
  }

  if (!/^[\w-]{1,200}$/.test(sessionId)) {
    return {
      success: false,
      error: { code: 'INVALID_PARAM', message: 'sessionId contains invalid characters' },
    };
  }

  // Verify session ownership before proxying to runtime
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (db && mongoose.Types.ObjectId.isValid(sessionId)) {
      const session = await db.collection('sessions').findOne({
        _id: new mongoose.Types.ObjectId(sessionId),
        projectId,
        tenantId,
      });
      if (!session) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: 'Session not found in project' },
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Session ownership check failed, proceeding with caution', {
      sessionId,
      projectId,
      error: message,
    });
  }

  const queryParams = new URLSearchParams();
  if (traceTypes?.length) queryParams.set('types', traceTypes.join(','));
  if (limit) queryParams.set('limit', String(limit));

  const url = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/traces?${queryParams.toString()}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUNTIME_PROXY_TIMEOUT_MS);

    const headers: Record<string, string> = { 'x-tenant-id': tenantId };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: 'RUNTIME_ERROR',
          message: `Runtime returned ${response.status}: ${response.statusText}`,
        },
      };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Trace query failed', { projectId, sessionId, error: message });
    return { success: false, error: { code: 'RUNTIME_FETCH_ERROR', message } };
  }
}
