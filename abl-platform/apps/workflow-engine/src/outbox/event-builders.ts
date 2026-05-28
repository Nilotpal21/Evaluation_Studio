/**
 * Event builder helpers for the transactional outbox write path.
 *
 * These are pure functions that assemble a validated `WorkflowExecutionEvent`
 * or `HumanTaskEvent` from (a) the domain-write arguments and (b) a snapshot
 * of the owning execution/task. Separated from the decorator so the mapping
 * logic is exercised directly in unit tests without spinning up Mongo.
 *
 * Status → event_type mapping lives here too: only real state transitions
 * (running / completed / failed / cancelled / rejected / approved / expired)
 * produce outbox rows. Mid-step data patches (output-only, metrics-only,
 * context-only updates) must NOT emit events — they do not advance the state
 * machine and would multiply event volume without adding semantic info.
 */

import { uuidv7 } from '@agent-platform/database/mongo';
import type { WorkflowExecutionEvent, HumanTaskEvent } from '@abl/eventstore/schema';
import type { IHumanTask } from '@agent-platform/database/models';

/** Shape of a workflow execution row surfaced inside a Mongo transaction. */
export interface ExecutionSnapshot {
  tenantId: string;
  projectId: string;
  workflowId: string;
  workflowVersion?: string | null;
  triggerType?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationMs?: number | null;
}

/**
 * Execution status → event_type. Returns `null` when the status does not
 * correspond to a state-machine transition we want to emit (e.g. 'skipped',
 * 'pending', or any data-only patch passed through `updateStepStatus`).
 */
export function execStatusToEventType(status: string): WorkflowExecutionEvent['event_type'] | null {
  switch (status) {
    case 'running':
    case 'pending':
      return null; // createExecution handles the 'started' event separately.
    case 'completed':
      return 'workflow.execution.completed';
    case 'failed':
      return 'workflow.execution.failed';
    case 'cancelled':
    case 'rejected':
      return 'workflow.execution.cancelled';
    default:
      return null;
  }
}

/**
 * Step status → event_type. Only 'running' / 'completed' / 'failed' transition
 * the step state machine — 'skipped', output-only patches, etc. return null.
 */
export function stepStatusToEventType(status: string): WorkflowExecutionEvent['event_type'] | null {
  switch (status) {
    case 'running':
      return 'workflow.execution.step_started';
    case 'completed':
    case 'failed':
      return 'workflow.execution.step_completed';
    default:
      return null;
  }
}

/** Human-task status/outcome → event_type. `null` when the update is a no-op. */
export function taskStatusToEventType(
  status: string,
  response?: { action?: string },
): HumanTaskEvent['event_type'] | null {
  if (status === 'completed') {
    // Distinguish approved vs rejected by the response action. The outbox
    // writer never sees this distinction otherwise — status is the single
    // column in the Mongo collection.
    if (response?.action === 'approve') return 'human_task.approved';
    if (response?.action === 'reject') return 'human_task.rejected';
    // Falls through to 'approved' as the default completion for
    // non-approval human tasks (e.g. data_entry that completes).
    return 'human_task.approved';
  }
  switch (status) {
    case 'assigned':
      return 'human_task.assigned';
    case 'cancelled':
      return 'human_task.cancelled';
    case 'expired':
      return 'human_task.expired';
    case 'rejected':
      return 'human_task.rejected';
    default:
      return null;
  }
}

export interface BuildExecutionStartedArgs {
  executionId: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  workflowVersion?: string;
  triggerType: string;
  occurredAt?: Date;
}

export function buildExecutionStartedEvent(
  args: BuildExecutionStartedArgs,
): WorkflowExecutionEvent {
  const occurredAt = (args.occurredAt ?? new Date()).toISOString();
  return {
    event_id: uuidv7(),
    event_type: 'workflow.execution.started',
    event_version: '1.0.0',
    occurred_at: occurredAt,
    tenant_id: args.tenantId,
    project_id: args.projectId,
    execution_id: args.executionId,
    workflow_id: args.workflowId,
    workflow_version: args.workflowVersion ?? '0',
    status: 'running',
    trigger_type: args.triggerType,
    started_at: occurredAt,
  };
}

export interface BuildStepEventArgs {
  executionId: string;
  tenantId: string;
  projectId: string;
  stepId: string;
  stepName?: string;
  stepType?: string;
  status: 'running' | 'completed' | 'failed';
  exec: ExecutionSnapshot;
  durationMs?: number | null;
  error?: { code?: string; message?: string } | null;
  occurredAt?: Date;
}

export function buildStepEvent(args: BuildStepEventArgs): WorkflowExecutionEvent {
  const eventType =
    args.status === 'running'
      ? 'workflow.execution.step_started'
      : 'workflow.execution.step_completed';
  const occurredAt = (args.occurredAt ?? new Date()).toISOString();
  return {
    event_id: uuidv7(),
    event_type: eventType,
    event_version: '1.0.0',
    occurred_at: occurredAt,
    tenant_id: args.tenantId,
    project_id: args.projectId,
    execution_id: args.executionId,
    workflow_id: args.exec.workflowId,
    workflow_version: args.exec.workflowVersion ?? '0',
    status: args.status,
    trigger_type: args.exec.triggerType ?? 'manual',
    step_id: args.stepId,
    step_name: args.stepName ?? null,
    step_type: args.stepType ?? null,
    duration_ms: args.durationMs ?? null,
    error_code: args.error?.code ?? null,
    error_message: args.error?.message ?? null,
    started_at: args.exec.startedAt?.toISOString() ?? null,
  };
}

export interface BuildExecutionTerminalArgs {
  executionId: string;
  tenantId: string;
  projectId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'rejected';
  exec: ExecutionSnapshot;
  errorCode?: string | null;
  errorMessage?: string | null;
  occurredAt?: Date;
}

export function buildExecutionTerminalEvent(
  args: BuildExecutionTerminalArgs,
): WorkflowExecutionEvent {
  const eventType = execStatusToEventType(args.status);
  if (!eventType) {
    throw new Error(`buildExecutionTerminalEvent: non-terminal status "${args.status}"`);
  }
  const occurredAt = args.occurredAt ?? new Date();
  return {
    event_id: uuidv7(),
    event_type: eventType,
    event_version: '1.0.0',
    occurred_at: occurredAt.toISOString(),
    tenant_id: args.tenantId,
    project_id: args.projectId,
    execution_id: args.executionId,
    workflow_id: args.exec.workflowId,
    workflow_version: args.exec.workflowVersion ?? '0',
    status: args.status,
    trigger_type: args.exec.triggerType ?? 'manual',
    started_at: args.exec.startedAt?.toISOString() ?? null,
    completed_at: occurredAt.toISOString(),
    duration_ms: args.exec.startedAt
      ? Math.max(0, occurredAt.getTime() - args.exec.startedAt.getTime())
      : null,
    error_code: args.errorCode ?? null,
    error_message: args.errorMessage ?? null,
  };
}

export interface BuildHumanTaskCreatedArgs {
  task: Pick<
    IHumanTask,
    '_id' | 'tenantId' | 'projectId' | 'status' | 'priority' | 'assignedTo'
  > & {
    source?: { workflowId?: string; executionId?: string; stepId?: string };
    context?: Record<string, unknown>;
    dueAt?: Date | null;
    createdAt?: Date | null;
  };
  exec: ExecutionSnapshot;
  occurredAt?: Date;
}

export function buildHumanTaskCreatedEvent(args: BuildHumanTaskCreatedArgs): HumanTaskEvent {
  const createdAt = (args.task.createdAt ?? args.occurredAt ?? new Date()).toISOString();
  const occurredAt = (args.occurredAt ?? new Date()).toISOString();
  const approvers = (args.task.context?.approvers as string[] | undefined) ?? [];
  return {
    event_id: uuidv7(),
    event_type: 'human_task.created',
    event_version: '1.0.0',
    occurred_at: occurredAt,
    tenant_id: args.task.tenantId,
    project_id: args.task.projectId,
    task_id: String(args.task._id),
    execution_id: args.task.source?.executionId ?? '',
    workflow_id: args.task.source?.workflowId ?? args.exec.workflowId,
    workflow_version: args.exec.workflowVersion ?? '0',
    mailbox: 'workflow',
    status: args.task.status,
    assignees: args.task.assignedTo ?? [],
    approvers,
    created_at: createdAt,
  };
}

export interface BuildHumanTaskTransitionArgs {
  taskId: string;
  tenantId: string;
  projectId: string;
  status: string;
  response?: { action?: string; by?: string; at?: Date };
  task: Pick<IHumanTask, 'status' | 'assignedTo' | 'claimedBy'> & {
    source?: { workflowId?: string; executionId?: string; stepId?: string };
    context?: Record<string, unknown>;
    createdAt?: Date | null;
  };
  exec: ExecutionSnapshot;
  occurredAt?: Date;
}

export function buildHumanTaskTransitionEvent(
  args: BuildHumanTaskTransitionArgs,
): HumanTaskEvent | null {
  const eventType = taskStatusToEventType(args.status, args.response);
  if (!eventType) return null;
  const occurredAt = (args.occurredAt ?? new Date()).toISOString();
  const decidedAt = (args.response?.at ?? new Date()).toISOString();
  const approvers = (args.task.context?.approvers as string[] | undefined) ?? [];
  return {
    event_id: uuidv7(),
    event_type: eventType,
    event_version: '1.0.0',
    occurred_at: occurredAt,
    tenant_id: args.tenantId,
    project_id: args.projectId,
    task_id: args.taskId,
    execution_id: args.task.source?.executionId ?? '',
    workflow_id: args.task.source?.workflowId ?? args.exec.workflowId,
    workflow_version: args.exec.workflowVersion ?? '0',
    mailbox: 'workflow',
    status: args.status,
    assignees: args.task.assignedTo ?? [],
    approvers,
    outcome: args.response?.action ?? null,
    outcome_by: args.response?.by ?? args.task.claimedBy ?? null,
    decided_at: args.response?.at ? decidedAt : null,
    created_at: args.task.createdAt?.toISOString() ?? null,
  };
}
