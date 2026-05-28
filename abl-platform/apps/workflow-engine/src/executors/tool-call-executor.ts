/**
 * Tool Call Step Executor
 *
 * Invokes a registered tool via the Runtime's internal tool execution API.
 * Resolves expressions in tool parameters.
 */

import { resolveExpressionTyped } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import { DEFAULT_STEP_TIMEOUT_MS } from '../constants.js';

export type ToolExecutionMode = 'sync' | 'async_continue' | 'async_wait';

export interface ToolCallbackConfig {
  enabled: boolean;
  location: 'body' | 'query' | 'header';
  callbackUrlKey: string;
  callbackSecretKey: string;
}

export interface ToolAsyncHttpSuccessConfig {
  acceptedStatusCodes?: number[];
  acceptedBodyPath?: string;
  acceptedBodyEquals?: string;
}

export interface ToolCallStep {
  id: string;
  type: 'tool_call';
  toolName: string;
  params: Record<string, unknown>;
  executionMode?: ToolExecutionMode;
  callbackConfig?: ToolCallbackConfig;
  asyncHttpSuccess?: ToolAsyncHttpSuccessConfig;
  timeout?: number;
  retry?: import('../handlers/step-dispatcher.js').RetryConfig;
}

export type ToolCallResult =
  | { success: true; status: 'completed'; output: unknown }
  | { success: true; status: 'accepted'; output: unknown }
  | { success: false; status: 'failed'; error: { code: string; message: string } };

export interface ToolExecutionClient {
  executeTool(input: {
    toolName: string;
    params: Record<string, unknown>;
    tenantId: string;
    projectId: string;
    actorUserId?: string;
    executionMode?: ToolExecutionMode;
    callback?: { url: string; secret: string };
    callbackConfig?: ToolCallbackConfig;
    asyncHttpSuccess?: ToolAsyncHttpSuccessConfig;
    timeout?: number;
  }): Promise<ToolCallResult>;
}

export async function executeToolCall(
  step: ToolCallStep,
  ctx: WorkflowContextData,
  toolClient: ToolExecutionClient,
): Promise<ToolCallResult> {
  const resolvedParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step.params)) {
    resolvedParams[key] = resolveExpressionTyped(value, ctx);
  }

  const triggerMetadata =
    ctx.trigger.metadata && typeof ctx.trigger.metadata === 'object' ? ctx.trigger.metadata : {};
  const actorUserId =
    typeof triggerMetadata.userId === 'string'
      ? triggerMetadata.userId
      : typeof triggerMetadata.triggeredBy === 'string'
        ? triggerMetadata.triggeredBy
        : undefined;

  return toolClient.executeTool({
    toolName: step.toolName,
    params: resolvedParams,
    tenantId: ctx.tenant.tenantId,
    projectId: ctx.tenant.projectId,
    actorUserId,
    executionMode: step.executionMode ?? 'sync',
    ...(step.callbackConfig ? { callbackConfig: step.callbackConfig } : {}),
    ...(step.asyncHttpSuccess ? { asyncHttpSuccess: step.asyncHttpSuccess } : {}),
    timeout: step.timeout ?? DEFAULT_STEP_TIMEOUT_MS,
  });
}
