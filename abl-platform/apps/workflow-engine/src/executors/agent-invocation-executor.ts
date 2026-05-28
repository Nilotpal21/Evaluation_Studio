/**
 * Agent Invocation Step Executor
 *
 * Invokes an agent session via the Runtime's internal API.
 * Resolves expressions in the message and passes tenant/project context.
 */

import { resolveExpression, resolveExpressionTyped } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import { DEFAULT_AGENT_TIMEOUT_MS } from '../constants.js';

export interface AgentInvocationStep {
  id: string;
  type: 'agent_invocation';
  agentId: string;
  message: string;
  sessionId?: string;
  timeout?: number;
  retry?: import('../handlers/step-dispatcher.js').RetryConfig;
}

export interface AgentInvocationResult {
  sessionId: string;
  agentResponse: string;
  toolResults?: unknown[];
}

export interface RuntimeClient {
  sendMessage(input: {
    agentId: string;
    sessionId?: string;
    message: string;
    tenantId: string;
    projectId: string;
    callerContext?: { source: string; workflowExecutionId: string };
    timeout?: number;
  }): Promise<AgentInvocationResult>;
}

export async function executeAgentInvocation(
  step: AgentInvocationStep,
  ctx: WorkflowContextData,
  runtimeClient: RuntimeClient,
): Promise<AgentInvocationResult> {
  const resolvedMessage = resolveExpression(step.message, ctx);
  const resolvedSessionId = step.sessionId ? resolveExpression(step.sessionId, ctx) : undefined;
  const resolvedAgentId = resolveExpression(step.agentId, ctx);

  return runtimeClient.sendMessage({
    agentId: resolvedAgentId,
    sessionId: resolvedSessionId,
    message: resolvedMessage,
    tenantId: ctx.tenant.tenantId,
    projectId: ctx.tenant.projectId,
    callerContext: {
      source: 'workflow',
      workflowExecutionId: ctx.workflow.executionId,
    },
    timeout: step.timeout ?? DEFAULT_AGENT_TIMEOUT_MS,
  });
}
