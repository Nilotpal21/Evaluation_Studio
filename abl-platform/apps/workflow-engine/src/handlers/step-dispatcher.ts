/**
 * Step Dispatcher
 *
 * Routes workflow steps to the correct executor based on step type.
 * Used by the workflow handler to execute each step in the workflow.
 */

import {
  resolveExpression,
  resolveExpressionTyped,
  resolveExpressionMap,
  type AgentSessionProjection,
} from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import { evaluateCondition, type ConditionStep } from '../executors/condition-executor.js';
import { resolveDelay, type DelayStep } from '../executors/delay-executor.js';
import {
  executeParallel,
  type ParallelStep,
  type BranchRunner,
} from '../executors/parallel-executor.js';
import {
  executeAgentInvocation,
  type AgentInvocationStep,
  type RuntimeClient,
} from '../executors/agent-invocation-executor.js';
import {
  executeToolCall,
  type ToolAsyncHttpSuccessConfig,
  type ToolCallbackConfig,
  type ToolCallStep,
  type ToolExecutionMode,
  type ToolExecutionClient,
} from '../executors/tool-call-executor.js';
import {
  executeConnectorAction,
  type ConnectorActionStep,
  type ConnectorActionDeps,
} from '../executors/connector-action-executor.js';
import { isAsyncParkingSentinel } from '@agent-platform/connectors';
import { executeHttpRequest, type HttpStep } from '../executors/http-executor.js';
import {
  buildAsyncWebhookRequest,
  type AsyncWebhookStep,
  type CallbackUrlBuilder,
} from '../executors/async-webhook-executor.js';
import { buildApprovalRequest, type ApprovalStep } from '../executors/approval-executor.js';
import { buildHumanTaskRequest, type HumanTaskStep } from '../executors/human-task-executor.js';
import { resolveLoopItems, type LoopStep } from '../executors/loop-executor.js';
import { executeTransform, type TransformStep } from '../executors/transform-executor.js';
import {
  executeFunctionStep,
  type FunctionExecutorDeps,
  type FunctionMemoryClient,
  type FunctionStep,
} from '../executors/function-executor.js';

const SENSITIVE_HEADER_KEYS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie']);

/** Redact sensitive headers for logging/debug display */
function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    result[k] = SENSITIVE_HEADER_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return result;
}

/**
 * Canvas routing metadata attached by canvas-to-steps conversion.
 * These fields are optional — only present for steps originating from the canvas editor.
 */
interface CanvasRoutingMeta {
  /** Display name from the canvas node */
  name?: string;
  /** Node IDs to execute on step success (from canvas edges) */
  onSuccessSteps?: string[];
  /** Node IDs to execute on step failure — errors, exceptions (from on_failure edge) */
  onFailureSteps?: string[];
  /** Node IDs to execute on rejection (from on_reject edge) */
  onRejectSteps?: string[];
  /** Whether this step was routed via canvas edges */
  canvasRouted?: boolean;
  /** IDs of predecessor nodes whose completion is required for this barrier node.
   *  Empty/absent = all predecessors optional. Set by MergerNodeConfig checklist.
   *  Accessed as step.requiredPredecessors on WorkflowStep (via intersection). */
  requiredPredecessors?: string[];
}

/** Base step types from executors */
type BaseWorkflowStep =
  | ConnectorActionStep
  | HttpStep
  | ToolCallStep
  | AgentInvocationStep
  | ConditionStep
  | DelayStep
  | ParallelStep
  | AsyncWebhookStep
  | ApprovalStep
  | HumanTaskStep
  | LoopStep
  | TransformStep
  | FunctionStep;

/** Union of all supported workflow step types, with optional canvas routing metadata */
export type WorkflowStep = BaseWorkflowStep & CanvasRoutingMeta;

/** Result from dispatching a step */
export interface StepDispatchResult {
  type: string;
  output: unknown;
  /** Resolved input data for the step (request details for HTTP, etc.) */
  input?: unknown;
  /** For HTTP steps: time spent in the actual fetch call (ms) */
  responseTimeMs?: number;
  /** For condition steps — which branch to execute next */
  nextSteps?: string[];
  /** For condition steps — which branch was taken ('then'/'else' for legacy, or condition id like 'if_0') */
  branchTaken?: string;
  /** For delay steps — how long to sleep (ms) */
  delayMs?: number;
  /** For async_webhook steps — the outbound request to send */
  webhookRequest?: unknown;
  /** For tool_call wait mode — execute the tool, then suspend until callback */
  toolRequest?: unknown;
  /**
   * For connector_action steps that return an {@link AsyncParkingSentinel} —
   * suspend the workflow on a Restate durable promise keyed by
   * `sys:callback:${stepId}` until the worker (workflow-docling extraction in
   * Phase 1; future async actions) POSTs the result to the callback route.
   * The action body has already enqueued the work; this block ONLY parks.
   */
  callbackRequest?: {
    callbackId: string;
    callbackTimeoutMs: number;
    /**
     * Per-step HMAC ciphertext. Source of truth for callback verification
     * on resume — the route decrypts this and runs `verifyWebhookSignature`.
     */
    encryptedCallbackSecret?: string;
  };
  /** For approval steps — the approval request payload */
  approvalRequest?: unknown;
  /** For human_task steps — the human task request payload */
  humanTaskRequest?: unknown;
  /** For loop steps with body — resolved collection for child step execution */
  loopIteration?: {
    items: unknown[];
    itemVariable: string;
    body: string[];
    bodyInDegreeMap?: Record<string, number>;
  };
  /** For function steps — captured console.log/warn/error output */
  consoleLogs?: Array<{ level: string; args: unknown[] }>;
}

interface AsyncToolDispatchRequest {
  toolName: string;
  params: Record<string, unknown>;
  callbackUrl: string;
  executionMode: Extract<ToolExecutionMode, 'async_wait'>;
  callbackConfig?: ToolCallbackConfig;
  asyncHttpSuccess?: ToolAsyncHttpSuccessConfig;
}

/** Retry configuration for steps that make external calls */
export interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier?: number;
}

/** External dependencies injected into the dispatcher */
export interface StepDispatcherDeps {
  runtimeClient?: RuntimeClient;
  toolClient?: ToolExecutionClient;
  connectorDeps?: ConnectorActionDeps;
  /**
   * Per-step factory used by native connectors that need workflow context
   * (Docling's `extract_document` action — see LLD Phase 2 Task 2.3). When
   * present, the dispatcher prefers this over the set-once `connectorDeps`
   * for `connector_action` steps and invokes it with the live workflow
   * execution id + step id so the resulting `ConnectorToolExecutor` carries
   * a fully-populated `CallbackContext`. Falls back to `connectorDeps` when
   * absent (legacy non-workflow callers).
   */
  connectorDepsForStep?: (workflowExecutionId: string, stepId: string) => ConnectorActionDeps;
  callbackUrlBuilder?: CallbackUrlBuilder;
  branchRunner?: BranchRunner;
  /**
   * Optional client used by function-node `memory.workflow/project/user.*`
   * globals (Phase 4). When omitted the globals exist but every op throws
   * STORAGE_UNAVAILABLE — that signals a wiring miss rather than failing
   * silently. Threaded all the way from the workflow-engine composition
   * root: `index.ts → RestateEndpointDeps → WorkflowHandlerDeps →
   * StepDispatcherDeps → executeFunctionStep`.
   */
  memoryClient?: FunctionMemoryClient;
}

/**
 * Dispatch a workflow step to its executor.
 * Returns a StepDispatchResult with the output and any control-flow metadata.
 */
export async function dispatchStep(
  step: WorkflowStep,
  ctx: WorkflowContextData,
  deps: StepDispatcherDeps,
): Promise<StepDispatchResult> {
  switch (step.type) {
    case 'connector_action': {
      // Prefer the per-step factory so native connectors (Docling) get a
      // `CallbackContext` populated with workflowExecutionId / stepId
      // function-references. Fall back to the set-once `connectorDeps` for
      // legacy callers and tests that don't need the workflow context.
      const connectorDeps = deps.connectorDepsForStep
        ? deps.connectorDepsForStep(ctx.workflow.executionId, step.id)
        : deps.connectorDeps;
      if (!connectorDeps) {
        throw new Error('ConnectorActionDeps not configured');
      }
      const output = await executeConnectorAction(step, ctx, connectorDeps);
      // Async-parking detection: a connector action that has already enqueued
      // work (e.g. workflow-docling extraction) returns an AsyncParkingSentinel
      // instead of a real value. Convert it into a `callbackRequest` so the
      // workflow-handler suspends on a Restate durable promise until the
      // callback POST arrives.
      if (isAsyncParkingSentinel(output)) {
        return {
          type: 'connector_action',
          output: null,
          input: { action: step.action, connector: step.connector, params: step.params },
          callbackRequest: {
            callbackId: output.callbackId,
            callbackTimeoutMs: output.callbackTimeoutMs,
            ...(output.encryptedCallbackSecret
              ? { encryptedCallbackSecret: output.encryptedCallbackSecret }
              : {}),
          },
        };
      }
      return {
        type: 'connector_action',
        output,
        input: { action: step.action, connector: step.connector, params: step.params },
      };
    }

    case 'http': {
      const httpResult = await executeHttpRequest(step, ctx);
      return {
        type: 'http',
        output: {
          statusCode: httpResult.statusCode,
          body: httpResult.body,
          headers: httpResult.headers,
        },
        input: { method: step.method, url: step.url, headers: step.headers, body: step.body },
      };
    }

    case 'tool_call': {
      const executionMode = step.executionMode ?? 'sync';

      if (executionMode === 'async_wait') {
        if (!deps.toolClient) {
          throw new Error('ToolExecutionClient not configured');
        }
        if (!deps.callbackUrlBuilder) {
          throw new Error('CallbackUrlBuilder not configured');
        }

        const resolvedParams: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(step.params)) {
          resolvedParams[key] = resolveExpressionTyped(value, ctx);
        }

        return {
          type: 'tool_call',
          output: null,
          input: { toolName: step.toolName, params: step.params },
          toolRequest: {
            toolName: step.toolName,
            params: resolvedParams,
            callbackUrl: deps.callbackUrlBuilder.buildCallbackUrl(
              ctx.workflow.executionId,
              step.id,
            ),
            executionMode,
            ...(step.callbackConfig ? { callbackConfig: step.callbackConfig } : {}),
            ...(step.asyncHttpSuccess ? { asyncHttpSuccess: step.asyncHttpSuccess } : {}),
          } satisfies AsyncToolDispatchRequest,
        };
      }

      if (!deps.toolClient) {
        throw new Error('ToolExecutionClient not configured');
      }
      const output = await executeToolCall(step, ctx, deps.toolClient);
      if (!output.success) {
        return {
          type: 'tool_call',
          output: output,
          input: { toolName: step.toolName, params: step.params },
        };
      }
      if (executionMode === 'sync' && output.status !== 'completed') {
        throw new Error(`Tool "${step.toolName}" did not complete synchronously`);
      }
      if (
        executionMode === 'async_continue' &&
        !['completed', 'accepted'].includes(output.status)
      ) {
        throw new Error(`Tool "${step.toolName}" returned unsupported async status`);
      }
      return {
        type: 'tool_call',
        output: output.output,
        input: { toolName: step.toolName, params: step.params },
      };
    }

    case 'agent_invocation': {
      if (!deps.runtimeClient) {
        throw new Error('RuntimeClient not configured');
      }
      const output = await executeAgentInvocation(step, ctx, deps.runtimeClient);
      return {
        type: 'agent_invocation',
        output,
        input: { agentId: step.agentId, message: step.message },
      };
    }

    case 'condition': {
      const result = evaluateCondition(step, ctx);
      return {
        type: 'condition',
        output: {
          conditionMet: result.conditionMet,
          traces: result.traces,
          branchTaken: result.branchTaken,
          expression: result.expression ?? step.expression,
          evaluatedConditions: result.evaluatedConditions,
        },
        input: { expression: step.expression },
        nextSteps: result.nextSteps,
        branchTaken: result.branchTaken,
      };
    }

    case 'delay': {
      const result = resolveDelay(step, ctx);
      return {
        type: 'delay',
        output: { delayMs: result.durationMs },
        input: { duration: step.duration },
        delayMs: result.durationMs,
      };
    }

    case 'parallel': {
      if (!deps.branchRunner) {
        throw new Error('BranchRunner not configured for parallel execution');
      }
      const output = await executeParallel(step, deps.branchRunner);
      return { type: 'parallel', output };
    }

    case 'async_webhook': {
      if (!deps.callbackUrlBuilder) {
        throw new Error('CallbackUrlBuilder not configured');
      }
      const request = buildAsyncWebhookRequest(step, ctx, deps.callbackUrlBuilder);
      return { type: 'async_webhook', output: null, webhookRequest: request };
    }

    case 'approval': {
      const request = buildApprovalRequest(step, ctx);
      return { type: 'approval', output: null, approvalRequest: request };
    }

    case 'human_task': {
      const request = buildHumanTaskRequest(step, ctx);
      return { type: 'human_task', output: null, humanTaskRequest: request };
    }

    case 'loop': {
      const items = resolveLoopItems(step, ctx);
      const output = { iterations: items.length };
      // If the loop has body steps, signal the handler to iterate over them
      if (step.config.body && step.config.body.length > 0) {
        return {
          type: 'loop',
          output,
          loopIteration: {
            items,
            itemVariable: step.config.itemVariable,
            body: step.config.body,
            bodyInDegreeMap: step.config.bodyInDegreeMap,
          },
        };
      }
      return { type: 'loop', output };
    }

    case 'transform': {
      const output = executeTransform(step, ctx);
      return {
        type: 'transform',
        output,
        input: {
          inputExpression: step.config.inputExpression,
          outputVariable: step.config.outputVariable,
        },
      };
    }

    case 'function': {
      // Phase 4: derive the per-call actor identity from the agent session
      // when present. Workflow-author runs (cron/webhook) credit writes to
      // 'workflow-author'. Agent-triggered runs with a real endUserId credit
      // them as 'end-user' so audit logs and user-scope writes resolve to
      // the right principal.
      const agentSession = ctx.agentSession as AgentSessionProjection | undefined;
      const actor: NonNullable<FunctionExecutorDeps['actor']> = agentSession?.endUserId
        ? { kind: 'end-user', endUserId: agentSession.endUserId }
        : { kind: 'workflow-author' };
      const fnDeps: FunctionExecutorDeps = {
        runId: ctx.workflow.executionId,
        actor,
        ...(deps.memoryClient ? { memoryClient: deps.memoryClient } : {}),
      };
      const result = await executeFunctionStep(step, ctx, fnDeps);
      return {
        type: 'function',
        output: result.output,
        input: { code: step.config.code?.substring(0, 200) ?? '(no code)' },
        consoleLogs: result.logs,
        responseTimeMs: result.durationMs,
      };
    }

    default: {
      const exhaustiveCheck: never = step;
      throw new Error(`Unknown step type: ${(exhaustiveCheck as WorkflowStep).type}`);
    }
  }
}

/**
 * Resolve the input data for a step WITHOUT executing it.
 * Used to persist detailed input when the step starts running,
 * so the debug panel can show what's being sent before the step completes.
 *
 * Returns null if the step type doesn't have meaningful pre-resolved input.
 */
export function resolveStepInput(
  step: WorkflowStep,
  ctx: WorkflowContextData,
): Record<string, unknown> | null {
  try {
    switch (step.type) {
      case 'http': {
        const resolvedUrl = resolveExpression(step.url, ctx);
        const resolvedHeaders = step.headers ? resolveExpressionMap(step.headers, ctx) : {};
        const resolvedBody = step.body ? resolveExpressionTyped(step.body, ctx) : undefined;
        const allHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          ...resolvedHeaders,
        };
        return {
          url: resolvedUrl,
          method: step.method,
          headers: redactSensitiveHeaders(allHeaders),
          ...(resolvedBody !== undefined ? { body: resolvedBody } : {}),
          timeout: step.timeout,
        };
      }

      case 'connector_action':
        return {
          connector: step.connector,
          action: step.action,
          params: step.params ? resolveExpressionMap(step.params, ctx) : {},
          connectionId: step.connectionId,
        };

      case 'tool_call':
        return {
          toolName: step.toolName,
          params: step.params ? resolveUnknownExpressionMap(step.params, ctx) : {},
        };

      case 'agent_invocation':
        return {
          agentId: step.agentId,
          message: resolveExpression(step.message, ctx),
          sessionId: step.sessionId,
          timeout: step.timeout,
        };

      case 'condition':
        return {
          conditions: step.conditions?.map((c) => ({ id: c.id, expression: c.expression })) ?? [
            { id: 'if', expression: step.expression },
          ],
        };

      case 'delay':
        return { duration: step.duration };

      case 'transform':
        return {
          inputExpression: step.config.inputExpression,
          outputVariable: step.config.outputVariable,
        };

      case 'loop': {
        const loopInput: Record<string, unknown> = {
          collection: resolveLoopItems(step, ctx),
          itemVariable: step.config.itemVariable,
          outputField: step.config.outputField,
          bodySteps: step.config.body,
          mode: step.config.mode ?? 'sequential',
        };
        if (
          step.config.mode === 'parallel' &&
          typeof step.config.concurrencyLimit === 'number' &&
          step.config.concurrencyLimit > 0
        ) {
          loopInput.concurrencyLimit = step.config.concurrencyLimit;
        }
        return loopInput;
      }

      case 'parallel':
        return {
          branches: step.branches?.map((b) => ({
            name: b.name,
            steps: b.steps,
          })),
        };

      case 'async_webhook':
        return {
          url: resolveExpression(step.url, ctx),
          method: step.method,
        };

      case 'approval':
        return {
          message: resolveExpression(step.message, ctx),
          approvers: step.approvers,
          timeout: step.timeout,
          onTimeout: step.onTimeout,
        };

      case 'human_task':
        return {
          title: step.title,
          taskType: step.taskType,
          assignTo: step.assignTo,
        };

      case 'function': {
        const codeSnippet = step.config.code?.substring(0, 200) ?? '(no code)';
        return { code: codeSnippet };
      }

      default:
        return null;
    }
  } catch {
    // If expression resolution fails, return raw step config
    // so the debug panel at least shows something useful
    return { type: step.type, raw: true };
  }
}

function resolveUnknownExpressionMap(
  map: Record<string, unknown>,
  ctx: WorkflowContextData,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    result[key] = resolveExpressionTyped(value, ctx);
  }
  return result;
}
