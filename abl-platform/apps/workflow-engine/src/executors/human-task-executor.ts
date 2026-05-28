/**
 * Human Task Step Executor
 *
 * Emits a human task request and waits for a human response.
 * The actual durable wait is handled by Restate's ctx.promise() in the workflow handler.
 * This executor builds the request payload and timeout behavior.
 */

import { resolveExpression, resolveExpressionTyped } from '../context/expression-resolver.js';
import { getContextVariables, type WorkflowContextData } from '../context/step-context-schema.js';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from '../constants.js';

export interface SelectOption {
  label: string;
  value: string;
}

export interface HumanTaskFieldDef {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'textarea' | 'date';
  label: string;
  required: boolean;
  /** Static select options (key-value pairs or plain strings) */
  options?: (string | SelectOption)[];
  /** Dynamic select options — a {{expression}} resolved at runtime from workflow context */
  optionsExpression?: string;
  validation?: Record<string, unknown>;
  defaultValue?: unknown;
}

export interface HumanTaskStep {
  id: string;
  type: 'human_task';
  /** Task type determines the inbox rendering */
  taskType: 'approval' | 'data_entry' | 'review' | 'decision';
  /** Title shown in the inbox */
  title: string;
  /** Description shown to the human agent */
  description?: string;
  /** Priority of the task */
  priority?: 'low' | 'medium' | 'high' | 'critical';
  /** Form field definitions for data collection */
  fields?: HumanTaskFieldDef[];
  /** User IDs or team names to assign to */
  assignTo?: string[];
  /** Task timeout in ms. Defaults to 72 hours. */
  timeout?: number;
  /** Action on timeout. Defaults to 'expire'. */
  onTimeout?: 'expire' | 'escalate' | 'auto_complete' | 'skip';
}

export interface HumanTaskRequest {
  taskId: string;
  executionId: string;
  stepId: string;
  taskType: 'approval' | 'data_entry' | 'review' | 'decision';
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  fields: HumanTaskFieldDef[];
  assignTo: string[];
  tenantId: string;
  projectId: string;
  timeoutMs?: number;
  onTimeout?: 'expire' | 'escalate' | 'auto_complete' | 'skip';
  context: Record<string, unknown>;
}

export interface HumanTaskResponse {
  respondedBy: string;
  respondedAt: string;
  fields: Record<string, unknown>;
  notes?: string;
  decision?: string;
}

/**
 * Build a human task request payload from the step definition.
 * Does NOT create the task — the handler creates it in MongoDB and waits on Restate promise.
 */
export function buildHumanTaskRequest(
  step: HumanTaskStep,
  ctx: WorkflowContextData,
): HumanTaskRequest {
  const resolvedTitle = resolveExpression(step.title, ctx) || step.id || 'Task';
  const resolvedDescription = step.description ? resolveExpression(step.description, ctx) : '';
  const rawAssignTo = Array.isArray(step.assignTo)
    ? step.assignTo
    : step.assignTo
      ? [step.assignTo]
      : [];
  const resolvedAssignTo = rawAssignTo.map((a) => resolveExpression(a, ctx));

  // Resolve dynamic options expressions for select fields
  const resolvedFields = (step.fields ?? []).map((field) => {
    if (field.type === 'select' && field.optionsExpression) {
      const resolved = resolveExpressionTyped(field.optionsExpression, ctx);
      const dynamicOptions = Array.isArray(resolved)
        ? resolved.map((item) =>
            typeof item === 'object' && item !== null && 'label' in item && 'value' in item
              ? (item as SelectOption)
              : String(item),
          )
        : [];
      return { ...field, options: dynamicOptions, optionsExpression: undefined };
    }
    return field;
  });

  return {
    taskId: `${ctx.workflow.executionId}:${step.id}`,
    executionId: ctx.workflow.executionId,
    stepId: step.id,
    taskType: step.taskType,
    title: resolvedTitle,
    description: resolvedDescription,
    priority: step.priority ?? 'medium',
    fields: resolvedFields,
    assignTo: resolvedAssignTo,
    tenantId: ctx.tenant.tenantId,
    projectId: ctx.tenant.projectId,
    timeoutMs: step.timeout,
    onTimeout: step.timeout != null ? (step.onTimeout ?? 'expire') : undefined,
    context: {
      workflowName: ctx.workflow.name,
      workflowId: ctx.workflow.id,
      variables: getContextVariables(ctx),
    },
  };
}

/**
 * Create a timeout response based on the step's onTimeout configuration.
 */
export function buildTimeoutResponse(step: HumanTaskStep): HumanTaskResponse {
  const action = step.onTimeout ?? 'expire';
  const decision =
    action === 'auto_complete' ? 'completed' : action === 'skip' ? 'skipped' : 'expired';
  return {
    respondedBy: 'system:timeout',
    respondedAt: new Date().toISOString(),
    fields: {},
    notes: `Human task timed out — auto-${action}`,
    decision,
  };
}
