/**
 * Approval Step Executor
 *
 * Emits an approval request and waits for a human decision.
 * The actual durable wait is handled by Restate's ctx.promise() in the workflow handler.
 * This executor builds the approval request payload and timeout.
 */

import { resolveExpression } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from '../constants.js';

export interface ApprovalStep {
  id: string;
  type: 'approval';
  /** Message to show in the approval request */
  message: string;
  /** Approvers — user IDs or group names */
  approvers: string[];
  /** Approval timeout in ms. Defaults to 72 hours. */
  timeout?: number;
  /** Action on timeout. Defaults to 'reject'. */
  onTimeout?: 'approve' | 'reject' | 'escalate';
}

export interface ApprovalRequest {
  approvalId: string;
  executionId: string;
  stepId: string;
  message: string;
  approvers: string[];
  tenantId: string;
  projectId: string;
  timeoutMs?: number;
  onTimeout?: 'approve' | 'reject' | 'escalate';
}

export interface ApprovalDecision {
  approved: boolean;
  decidedBy: string;
  reason?: string;
  decidedAt: string;
}

/**
 * Build an approval request payload from the step definition.
 * Does NOT send the request — the handler publishes it and waits on Restate promise.
 */
export function buildApprovalRequest(
  step: ApprovalStep,
  ctx: WorkflowContextData,
): ApprovalRequest {
  const resolvedMessage = resolveExpression(step.message, ctx);
  const resolvedApprovers = step.approvers.map((a) => resolveExpression(a, ctx));

  return {
    approvalId: `${ctx.workflow.executionId}:${step.id}`,
    executionId: ctx.workflow.executionId,
    stepId: step.id,
    message: resolvedMessage,
    approvers: resolvedApprovers,
    tenantId: ctx.tenant.tenantId,
    projectId: ctx.tenant.projectId,
    timeoutMs: step.timeout,
    onTimeout: step.timeout != null ? (step.onTimeout ?? 'reject') : undefined,
  };
}

/**
 * Create a timeout decision based on the step's onTimeout configuration.
 */
export function buildTimeoutDecision(step: ApprovalStep): ApprovalDecision {
  const action = step.onTimeout ?? 'reject';
  return {
    approved: action === 'approve',
    decidedBy: 'system:timeout',
    reason: `Approval timed out — auto-${action}`,
    decidedAt: new Date().toISOString(),
  };
}
