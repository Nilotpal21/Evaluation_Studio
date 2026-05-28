import type { AgentIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { LLMWiringService } from './llm-wiring.js';
import { buildDelegateAuthContext, extendDelegateAuthContext } from './auth-profile-delegate.js';
import { buildFanOutAuthContext } from './auth-profile-fanout.js';
import {
  getActiveThread,
  syncThreadToSession,
  type ActivationAuthContext,
  type AgentThread,
  type RuntimeSession,
} from './types.js';
import { initializeActivatedAgentMemory } from './memory-integration.js';

const log = createLogger('agent-activation-context');

export type ActivationMode = 'handoff' | 'delegate' | 'fan_out';

export interface ActivateAgentExecutionParams {
  session: RuntimeSession;
  targetAgentName: string;
  targetIR: AgentIR;
  targetThread: AgentThread;
  authMode: ActivationMode;
  llmWiring: Pick<LLMWiringService, 'wireLLMClient' | 'wireToolExecutor'>;
  childSessionId?: string;
  authContext?: ActivationAuthContext;
  wireLLMClient?: boolean;
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
}

export function deriveActivationAuthContext(session: RuntimeSession): ActivationAuthContext {
  const activeThread = session.threads[session.activeThreadIndex];
  const existing = activeThread?.activationAuthContext ?? session._activationAuthContext;

  return {
    tenantId: existing?.tenantId ?? session.tenantId,
    projectId: existing?.projectId ?? session.projectId,
    userId: existing?.userId ?? session.userId,
    authToken: existing?.authToken ?? session.authToken,
    callerContext: existing?.callerContext
      ? { ...existing.callerContext }
      : session.callerContext
        ? { ...session.callerContext }
        : undefined,
    authScope: existing?.authScope ?? session.callerContext?.authScope,
    ...(existing?.delegatedBy ? { delegatedBy: [...existing.delegatedBy] } : {}),
    ...(existing?.branchAgentName ? { branchAgentName: existing.branchAgentName } : {}),
    ...(existing?.branchCredentialCache
      ? { branchCredentialCache: existing.branchCredentialCache }
      : {}),
  };
}

export function resolveTargetActivationAuthContext(params: {
  session: RuntimeSession;
  authMode: ActivationMode;
  targetAgentName: string;
  authContext?: ActivationAuthContext;
}): ActivationAuthContext {
  if (params.authContext) {
    return cloneActivationAuthContext(params.authContext);
  }

  const baseContext = deriveActivationAuthContext(params.session);

  switch (params.authMode) {
    case 'delegate':
      return baseContext.delegatedBy
        ? extendDelegateAuthContext(baseContext, params.session.id)
        : buildDelegateAuthContext({
            authContext: baseContext,
            delegatingSessionId: params.session.id,
          });

    case 'fan_out':
      return buildFanOutAuthContext({
        agentName: params.targetAgentName,
        authContext: baseContext,
      });

    case 'handoff':
    default:
      return baseContext;
  }
}

export function agentNeedsLLMWiring(agentIR: AgentIR): boolean {
  if (!agentIR.flow) {
    return true;
  }

  return Object.values(agentIR.flow.definitions ?? {}).some((step) => step.reasoning_zone != null);
}

export async function activateAgentExecutionContext(
  params: ActivateAgentExecutionParams,
): Promise<ActivationAuthContext> {
  const {
    session,
    targetAgentName,
    targetIR,
    targetThread,
    authMode,
    llmWiring,
    childSessionId,
    wireLLMClient = true,
    onTraceEvent,
  } = params;

  captureCurrentThreadAuthContext(session, targetThread);

  const authContext = resolveTargetActivationAuthContext({
    session,
    authMode,
    targetAgentName,
    authContext: params.authContext,
  });

  const targetThreadIndex = session.threads.indexOf(targetThread);
  if (targetThreadIndex < 0) {
    throw new Error(`Target thread for ${targetAgentName} is not attached to the session`);
  }
  const previousThread = getActiveThread(session);

  clearAgentScopedSessionState(session);

  targetThread.agentName = targetAgentName;
  targetThread.agentIR = targetIR;
  targetThread.activationAuthContext = cloneActivationAuthContext(authContext);
  session.activeThreadIndex = targetThreadIndex;
  session._guardrailPolicy = undefined;
  session._guardrailPolicyEpoch = undefined;
  session._guardrailPolicyScopeKey = undefined;

  syncThreadToSession(session);
  session._activationAuthContext = cloneActivationAuthContext(authContext);

  if (session.agentIR && session._projectRuntimeConfig) {
    session.agentIR.project_runtime_config = session._projectRuntimeConfig;
  }

  session.state.activeAgent = {
    name: targetAgentName,
    mode: targetIR.flow ? 'scripted' : 'reasoning',
    ir: targetIR,
  };

  await initializeActivatedAgentMemory(session, targetIR, onTraceEvent);

  llmWiring.wireToolExecutor?.(
    session,
    session.compilationOutput,
    authContext.authToken,
    authContext.tenantId,
    authContext.projectId,
  );

  if (previousThread && previousThread !== targetThread && session.llmClient) {
    previousThread.llmClient = session.llmClient;
  }

  session.llmClient = undefined;
  targetThread.llmClient = undefined;

  if (wireLLMClient) {
    await llmWiring.wireLLMClient?.(
      session,
      targetIR,
      authContext.tenantId,
      authContext.projectId,
      authContext.userId,
    );
    targetThread.llmClient = session.llmClient;
  }

  onTraceEvent?.({
    type: 'agent_activation',
    data: {
      agentName: targetAgentName,
      threadIndex: targetThreadIndex,
      authMode,
      mode: targetIR.flow ? 'scripted' : 'reasoning',
      delegatedDepth: authContext.delegatedBy?.length ?? 0,
      hasBranchCredentialCache: !!authContext.branchCredentialCache,
      ...(childSessionId ? { childSessionId } : {}),
    },
  });

  log.debug('Activated agent execution context', {
    sessionId: session.id,
    agentName: targetAgentName,
    authMode,
    threadIndex: targetThreadIndex,
    childSessionId,
    authScope: authContext.authScope,
    delegatedDepth: authContext.delegatedBy?.length ?? 0,
    hasBranchCredentialCache: !!authContext.branchCredentialCache,
  });

  return authContext;
}

function captureCurrentThreadAuthContext(session: RuntimeSession, targetThread: AgentThread): void {
  const currentThread = getActiveThread(session);
  if (!currentThread || currentThread === targetThread) {
    return;
  }

  if (!currentThread.activationAuthContext) {
    currentThread.activationAuthContext = deriveActivationAuthContext(session);
  }
}

function clearAgentScopedSessionState(session: RuntimeSession): void {
  session._effectiveConfig = undefined;
  session._activeProfileNames = undefined;
  session.resolvedEnableThinking = undefined;
  session.resolvedThinkingBudget = undefined;
  session.resolvedThoughtDescription = undefined;
  session.resolvedCompactionThreshold = undefined;
  session.resolvedModelId = undefined;
}

function cloneActivationAuthContext(context: ActivationAuthContext): ActivationAuthContext {
  return {
    ...context,
    ...(context.callerContext ? { callerContext: { ...context.callerContext } } : {}),
    ...(context.delegatedBy ? { delegatedBy: [...context.delegatedBy] } : {}),
  };
}
