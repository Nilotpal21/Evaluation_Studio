import type { WorkflowExecution } from '../../../api/workflows';

/** Raw server messages — keep independent of ws-events.ts to avoid cross-package deps */
export interface SnapshotMsg {
  type: 'workflow_execution_snapshot';
  execution: Record<string, unknown>;
}

export interface StepDeltaMsg {
  type: 'workflow_step_status';
  executionId: string;
  stepId: string;
  stepName?: string;
  stepType?: string;
  status: string;
  stepData?: Record<string, unknown>;
  contextPatch?: Record<string, unknown>;
  timestamp: string;
  durationMs?: number;
  /** Complete edge pathState snapshot from the engine. See ws-events.ts for contract. */
  pathState?: Record<string, 'running' | 'completed'>;
  /** Per-iteration body edge pathState keyed by loopNodeId → iterIndex → edgeId → status. */
  iterationPathState?: Record<string, Record<string, Record<string, 'running' | 'completed'>>>;
}

export interface ExecutionDeltaMsg {
  type: 'workflow_execution_status';
  executionId: string;
  status: string;
  timestamp: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: Record<string, unknown>;
  error?: string;
  /** Complete edge pathState snapshot from the engine. See ws-events.ts for contract. */
  pathState?: Record<string, 'running' | 'completed'>;
  /** Per-iteration body edge pathState keyed by loopNodeId → iterIndex → edgeId → status. */
  iterationPathState?: Record<string, Record<string, Record<string, 'running' | 'completed'>>>;
}

/**
 * Normalize raw snapshot doc from workflow-engine into a WorkflowExecution.
 * The snapshot carries the MongoDB document shape (with `_id` instead of `id`).
 */
export function applySnapshot(raw: Record<string, unknown>): WorkflowExecution {
  return {
    id: (raw.id as string) ?? (raw._id as string),
    workflowId: raw.workflowId as string,
    workflowVersionId: raw.workflowVersionId as string | undefined,
    workflowVersion: raw.workflowVersion as string | undefined,
    projectId: raw.projectId as string | undefined,
    tenantId: raw.tenantId as string | undefined,
    status: (raw.status as WorkflowExecution['status']) ?? 'running',
    startedAt: (raw.startedAt as string) ?? new Date().toISOString(),
    completedAt: raw.completedAt as string | undefined,
    triggerType: (raw.triggerType as string) ?? 'manual',
    triggerMetadata: raw.triggerMetadata as Record<string, unknown> | undefined,
    input: raw.input as Record<string, unknown> | undefined,
    error: raw.error as WorkflowExecution['error'] | undefined,
    context: raw.context,
    durationMs: raw.durationMs as number | undefined,
    output: raw.output as Record<string, unknown> | undefined,
  };
}

/**
 * Merge a step delta into the execution's context.steps.
 * Operates on the `stepData` field which carries the full step context.
 */
export function mergeStepDelta(
  execution: WorkflowExecution,
  delta: StepDeltaMsg,
): WorkflowExecution {
  const ctx = (execution.context as Record<string, unknown> | undefined) ?? {};
  const steps = ((ctx.steps as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const contextPatch = delta.contextPatch ?? {};

  // Prefer stepId key if it already exists in the snapshot (e.g. "start"/"end" nodes
  // are stored by stepId in MongoDB but have a capitalised display name in deltas).
  // For all other steps, use the display name so it matches the snapshot key.
  const stepKey =
    steps[delta.stepId] !== undefined ? delta.stepId : (delta.stepName ?? delta.stepId);

  const existing = (steps[stepKey] as Record<string, unknown> | undefined) ?? {};
  const updated: Record<string, unknown> = {
    ...existing,
    status: delta.status,
    ...(delta.stepData ?? {}),
  };

  return {
    ...execution,
    context: {
      ...ctx,
      ...contextPatch,
      steps: { ...steps, [stepKey]: updated },
    },
  };
}

/**
 * Merge a workflow lifecycle delta (started/completed/failed/etc.) into the execution.
 */
export function mergeExecutionDelta(
  execution: WorkflowExecution,
  delta: ExecutionDeltaMsg,
): WorkflowExecution {
  return {
    ...execution,
    status: delta.status as WorkflowExecution['status'],
    ...(delta.completedAt ? { completedAt: delta.completedAt } : {}),
    ...(delta.startedAt ? { startedAt: delta.startedAt } : {}),
    ...(delta.output ? { output: delta.output } : {}),
    ...(delta.durationMs !== undefined ? { durationMs: delta.durationMs } : {}),
    ...(delta.error ? { error: { code: 'WORKFLOW_ERROR', message: delta.error } } : {}),
  };
}
