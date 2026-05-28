import { performance } from 'node:perf_hooks';
import type { PipelinePolicy, ToolDefinition as IRToolDefinition } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { PreTurnBlockedTool, PreTurnExecutionView, RuntimeSession } from './types.js';
import { getGatherProgress } from './types.js';
import { getSessionGuardrailCacheScopeKey, getSessionPolicy } from './session-policy.js';
import { EXECUTION_TREE_NAMESPACE } from './memory-scope-runtime.js';

const log = createLogger('pre-turn-execution-view');

function resolveSessionMemory(session: RuntimeSession): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const sessionVars = session.agentIR?.memory?.session ?? [];

  for (const sessionVar of sessionVars) {
    if (sessionVar.name in session.data.values) {
      projected[sessionVar.name] = session.data.values[sessionVar.name];
    }
  }

  return projected;
}

function resolveGrantedMemory(session: RuntimeSession): Record<string, unknown> {
  const granted = session.data.values._granted_memory;

  if (!granted || typeof granted !== 'object' || Array.isArray(granted)) {
    return {};
  }

  return { ...(granted as Record<string, unknown>) };
}

function resolveExecutionTreeMemory(session: RuntimeSession): Record<string, unknown> {
  const projection = session.data.values[EXECUTION_TREE_NAMESPACE];

  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    return {};
  }

  return structuredClone(projection as Record<string, unknown>);
}

function evaluateToolAvailability(
  session: RuntimeSession,
  tools: IRToolDefinition[],
): {
  allowedToolNames: string[];
  blocked: PreTurnBlockedTool[];
} {
  const allowedToolNames: string[] = [];
  const blocked: PreTurnBlockedTool[] = [];

  for (const tool of tools) {
    if (!tool.auth_profile_ref) {
      allowedToolNames.push(tool.name);
      continue;
    }

    if (tool.jit_auth === true) {
      allowedToolNames.push(tool.name);
      continue;
    }

    const authScope = session._activationAuthContext?.authScope;
    const connectionMode = tool.connection_mode ?? 'per_user';
    const requiresUserContext = connectionMode !== 'shared' || authScope === 'session';

    if (requiresUserContext && !session.userId) {
      blocked.push({
        name: tool.name,
        reason:
          authScope === 'session' ? 'session_scoped_auth_requires_user' : 'missing_user_context',
        detail: `Tool "${tool.name}" requires a user-scoped auth profile before it can be exposed.`,
      });
      continue;
    }

    allowedToolNames.push(tool.name);
  }

  return {
    allowedToolNames,
    blocked,
  };
}

function buildExecutionView(
  session: RuntimeSession,
  policy?: PipelinePolicy,
): PreTurnExecutionView {
  const sourceTools = session._effectiveConfig?.tools ?? session.agentIR?.tools ?? [];
  const toolAvailability = evaluateToolAvailability(session, sourceTools);

  return {
    generatedAt: Date.now(),
    memory: {
      session: resolveSessionMemory(session),
      executionTree: resolveExecutionTreeMemory(session),
      granted: resolveGrantedMemory(session),
      gather: getGatherProgress(session),
    },
    policy: policy
      ? {
          failMode: policy.settings?.failMode ?? 'open',
          disabledGuardrails: [...(policy.disabledGuardrails ?? [])],
          additionalGuardrailCount: policy.additionalGuardrails?.length ?? 0,
        }
      : undefined,
    auth: {
      hasUserContext: typeof session.userId === 'string' && session.userId.length > 0,
      hasSessionToken: typeof session.authToken === 'string' && session.authToken.length > 0,
      authScope: session._activationAuthContext?.authScope,
    },
    tools: toolAvailability,
  };
}

export function getPreTurnExecutionView(session: RuntimeSession): PreTurnExecutionView | undefined {
  const cachedPolicy =
    session._guardrailPolicyScopeKey === getSessionGuardrailCacheScopeKey(session)
      ? (session._guardrailPolicy ?? undefined)
      : undefined;
  const view = buildExecutionView(session, cachedPolicy);
  session._preTurnView = view;
  return view;
}

export function clearPreTurnExecutionView(session: RuntimeSession): void {
  delete session._preTurnView;
}

export async function preparePreTurnExecutionView(
  session: RuntimeSession,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): Promise<PreTurnExecutionView> {
  const startedAt = performance.now();
  let policy: PipelinePolicy | undefined;

  try {
    policy = await getSessionPolicy(session);
  } catch (err) {
    log.warn('Failed to resolve session policy for pre-turn shaping', {
      sessionId: session.id,
      agentName: session.agentName,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const view = buildExecutionView(session, policy);
  session._preTurnView = view;
  const latencyMs = Number((performance.now() - startedAt).toFixed(3));

  if (onTraceEvent && (view.tools.blocked.length > 0 || view.policy)) {
    onTraceEvent({
      type: 'decision',
      data: {
        type: 'pre_turn_surface',
        agentName: session.agentName,
        allowedTools: view.tools.allowedToolNames,
        blockedTools: view.tools.blocked.map((entry) => ({
          name: entry.name,
          reason: entry.reason,
        })),
        policyFailMode: view.policy?.failMode,
        additionalGuardrails: view.policy?.additionalGuardrailCount ?? 0,
        latencyMs,
      },
    });
  }

  return view;
}
