import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { getRuntimeUrl } from '@/config/runtime.server';

const log = createLogger('arch-ai:testing-ops');

const RUNTIME_TIMEOUT_MS = 30_000;
const EVAL_LIST_TOOL_PAGE_SIZE = 100;
const EVAL_LIST_TOOL_MAX_PAGES = 20;

interface TestingOpsInput {
  action: 'run_test' | 'create_eval' | 'list_evals';
  agentName?: string;
  testMessage?: string;
  evalConfig?: {
    name: string;
    description?: string;
    // Phase 1: scenarios are accepted but NOT persisted by createEvalSet —
    // scenarios live behind dedicated eval-quality validators (Phase 2).
    scenarios?: Array<{ input: string; expectedBehavior: string }>;
  };
}

interface TestingOpsResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export async function executeTestingOps(
  input: TestingOpsInput,
  ctx: ToolPermissionContext,
): Promise<TestingOpsResult> {
  const { action } = input;
  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  const perm = await checkToolPermission('testing_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  switch (action) {
    case 'run_test':
      if (!input.testMessage) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'testMessage is required' },
        };
      }
      return runTest(projectId, input.agentName, input.testMessage, tenantId, ctx.authToken);
    case 'list_evals':
      return listEvals(projectId, tenantId);
    case 'create_eval':
      if (!input.evalConfig) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'evalConfig is required' },
        };
      }
      return createEval(projectId, input.evalConfig, tenantId, user.userId);
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
      };
  }
}

async function runTest(
  projectId: string,
  agentName: string | undefined,
  testMessage: string,
  tenantId: string,
  authToken?: string,
): Promise<TestingOpsResult> {
  // TE-01: Validate agentName exists in project before calling runtime
  if (agentName) {
    const { findProjectAgent } = await import('@/repos/project-repo');
    const agent = await findProjectAgent(projectId, agentName, tenantId);
    if (!agent) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `Agent "${agentName}" not found in project. Use list agents to see available agents.`,
        },
      };
    }
  }

  const url = `${getRuntimeUrl()}/api/v1/chat`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUNTIME_TIMEOUT_MS);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        projectId,
        messages: [{ role: 'user', content: testMessage }],
        agentName,
      }),
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

    // TE-05: Normalize runtime response — the chat API may return the reply
    // under different field names depending on version and streaming mode.
    const responseText = data.response ?? data.content ?? data.message ?? data.result ?? data.text;

    // Treat HTTP 200 with no recognizable reply field as a failure. Returning
    // `success: true, response: null` would silently feed an empty string into
    // the testing-eval specialist, which then hallucinates analysis of a
    // non-existent response. Expose the keys we received so operators can
    // trace protocol drift (version skew, streaming-only responses, etc.).
    if (responseText == null || responseText === '') {
      const availableKeys = Object.keys(data ?? {}).join(', ') || '(empty body)';
      log.warn('Runtime returned 200 but no reply field', {
        projectId,
        agentName,
        availableKeys,
      });
      return {
        success: false,
        error: {
          code: 'RUNTIME_EMPTY_RESPONSE',
          message:
            `Runtime returned HTTP 200 but the body had no reply field. ` +
            `Received keys: ${availableKeys}. ` +
            `This usually means a runtime version mismatch or streaming-only mode.`,
        },
      };
    }

    return {
      success: true,
      data: {
        response: responseText,
        sessionId: data.sessionId ?? data.session_id ?? null,
        traces: data.traces ?? null,
        agentName,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Test run failed', { projectId, agentName, error: message });
    return { success: false, error: { code: 'RUNTIME_FETCH_ERROR', message } };
  }
}

async function listEvals(projectId: string, tenantId: string): Promise<TestingOpsResult> {
  const { findEvalSetsPageByProject } = await import('@/repos/eval-repo');
  const evalSets: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  let total = 0;
  let hasMore = false;

  for (let page = 0; page < EVAL_LIST_TOOL_MAX_PAGES; page += 1) {
    const result = await findEvalSetsPageByProject(projectId, tenantId, {
      cursor,
      limit: EVAL_LIST_TOOL_PAGE_SIZE,
    });
    evalSets.push(...result.items);
    total = result.pagination.total;
    hasMore = result.pagination.hasMore;
    cursor = result.pagination.nextCursor;

    if (!hasMore || !cursor) {
      break;
    }
  }

  if (hasMore) {
    log.warn('Eval set listing truncated at tool safety cap', {
      projectId,
      returned: evalSets.length,
      total,
    });
  }

  return {
    success: true,
    data: {
      evalSets: evalSets.map((s: Record<string, unknown>) => ({
        id: s.id ?? s._id,
        name: s.name,
        description: s.description ?? null,
      })),
      pagination: {
        returned: evalSets.length,
        total,
        truncated: hasMore,
      },
    },
  };
}

async function createEval(
  projectId: string,
  evalConfig: {
    name: string;
    description?: string;
    scenarios?: Array<{ input: string; expectedBehavior: string }>;
  },
  tenantId: string,
  userId: string,
): Promise<TestingOpsResult> {
  const { createEvalSet } = await import('@/repos/eval-repo');
  const scenarioCount = evalConfig.scenarios?.length ?? 0;
  const description =
    evalConfig.description ?? `Created by Arch AI with ${scenarioCount} scenario(s)`;
  const evalSet = await createEvalSet({
    tenantId,
    projectId,
    name: evalConfig.name,
    description,
    createdBy: userId,
  });
  log.info('Eval set created', { projectId, name: evalConfig.name });
  return {
    success: true,
    data: { created: true, id: evalSet.id ?? evalSet._id, name: evalSet.name },
  };
}
