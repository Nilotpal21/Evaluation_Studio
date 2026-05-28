import type { EvalKnownSource } from '@agent-platform/database';

export interface EvalRuntimeAgentChatBodyParams {
  projectId: string;
  message: string;
  sessionId?: string;
  entryAgent?: string;
  sessionVariables?: Record<string, unknown>;
  knownSource?: EvalKnownSource;
  /** When set, becomes `callerContext.workflowExecutionId` for run traceability. */
  runId?: string;
}

export function buildEvalRuntimeAgentChatBody(
  params: EvalRuntimeAgentChatBodyParams,
): Record<string, unknown> {
  const testContext: Record<string, unknown> = { skipOnStart: false };
  const knownSource = params.knownSource === 'synthetic' ? 'synthetic' : 'eval';

  if (
    !params.sessionId &&
    params.sessionVariables &&
    Object.keys(params.sessionVariables).length > 0
  ) {
    testContext.sessionVariables = params.sessionVariables;
  }

  const body: Record<string, unknown> = {
    projectId: params.projectId,
    message: params.message,
    testContext,
    // Tag eval-generated sessions so billing/analytics can distinguish them
    knownSource,
  };

  if (params.sessionId) {
    body.sessionId = params.sessionId;
  }

  if (params.entryAgent && !params.sessionId) {
    body.agentId = params.entryAgent;
  }

  if (params.runId) {
    body.callerContext = { source: 'pipeline-engine', workflowExecutionId: params.runId };
  }

  return body;
}

export function isEvalRuntimeSessionEnded(data: Record<string, unknown>): boolean {
  const action = normalizeRuntimeAction(data.action);
  if (action) {
    return action === 'complete' || action === 'escalate';
  }

  return Boolean(data.sessionEnded);
}

function normalizeRuntimeAction(action: unknown): string | undefined {
  if (typeof action === 'string') {
    return action;
  }

  if (action && typeof action === 'object') {
    const type = (action as Record<string, unknown>).type;
    return typeof type === 'string' ? type : undefined;
  }

  return undefined;
}
