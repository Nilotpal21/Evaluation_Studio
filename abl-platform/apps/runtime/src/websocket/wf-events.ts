import { z } from 'zod';

// ── Client → Server ──────────────────────────────────────────────────────────

export const SubscribeExecutionMsg = z.object({
  type: z.literal('subscribe_execution'),
  projectId: z.string().min(1),
  workflowId: z.string().min(1),
  executionId: z.string().min(1),
});
export type SubscribeExecutionMsg = z.infer<typeof SubscribeExecutionMsg>;

export const UnsubscribeExecutionMsg = z.object({
  type: z.literal('unsubscribe_execution'),
  executionId: z.string().min(1),
});
export type UnsubscribeExecutionMsg = z.infer<typeof UnsubscribeExecutionMsg>;

export const WfClientMessage = z.discriminatedUnion('type', [
  SubscribeExecutionMsg,
  UnsubscribeExecutionMsg,
]);
export type WfClientMessage = z.infer<typeof WfClientMessage>;

// ── Server → Client ──────────────────────────────────────────────────────────

export interface WorkflowSnapshotMsg {
  type: 'workflow_execution_snapshot';
  execution: Record<string, unknown>;
}

export interface WorkflowStepStatusMsg {
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
  pathState?: Record<string, 'running' | 'completed'>;
  iterationPathState?: Record<string, Record<string, Record<string, 'running' | 'completed'>>>;
}

export interface WorkflowExecutionStatusMsg {
  type: 'workflow_execution_status';
  executionId: string;
  status: string;
  timestamp: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: Record<string, unknown>;
  error?: string;
  pathState?: Record<string, 'running' | 'completed'>;
  iterationPathState?: Record<string, Record<string, Record<string, 'running' | 'completed'>>>;
}

export interface ExecutionNotFoundMsg {
  type: 'execution_not_found';
  executionId: string;
}

export interface WfErrorMsg {
  type: 'error';
  code: string;
  message?: string;
}

export type WfServerMessage =
  | WorkflowSnapshotMsg
  | WorkflowStepStatusMsg
  | WorkflowExecutionStatusMsg
  | ExecutionNotFoundMsg
  | WfErrorMsg;
