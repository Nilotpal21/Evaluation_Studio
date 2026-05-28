import crypto from 'crypto';

/**
 * Execution Model Types
 *
 * Core types for the execution runtime, execution plan, and semaphore
 * abstractions. Intentionally decoupled from runtime-specific types
 * (RuntimeSession, AgentThread) — uses generics where needed.
 *
 * NOTE: ExecutionEventBus is deferred to Phase 2. Phase 1 uses the
 * existing onTraceEvent callback with executionId in event data.
 */

// =============================================================================
// EXECUTION PLAN & RUNTIME
// =============================================================================

export interface ExecutionUnit {
  agentName: string;
  message: string;
  context?: Record<string, unknown>;
  timeout: number;
}

export interface ExecutionPlan {
  type: 'parallel' | 'sequential' | 'single';
  units: ExecutionUnit[];
  timeout: number;
  onPartialFailure: 'continue' | 'cancel-remaining' | 'fail-all';
}

export interface ExecutionUnitResult {
  agentName: string;
  status: 'completed' | 'error' | 'cancelled' | 'timeout' | 'suspended';
  response?: string;
  error?: string;
  gatheredData?: Record<string, unknown>;
  durationMs: number;
  /** Present when status === 'suspended' */
  suspensionId?: string;
  barrierId?: string;
}

/**
 * ExecutionRuntime — pluggable backend for executing agent work.
 *
 * Phase 1: InProcessExecutionRuntime (Promise.allSettled)
 * Phase 3: RestateExecutionRuntime (durable execution)
 */
export interface ExecutionRuntime {
  execute(
    plan: ExecutionPlan,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    parentSignal: AbortSignal,
  ): Promise<ExecutionUnitResult[]>;
}

// =============================================================================
// COUNTING SEMAPHORE
// =============================================================================

export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  readonly available: number;
  readonly capacity: number;
}

// =============================================================================
// EXECUTION CONFIG (for future ExecutionContext in Phase 2)
// =============================================================================

export interface ExecutionConfig {
  timeoutMs: number;
  maxIterations: number;
  traceVerbosity: 'minimal' | 'standard' | 'verbose' | 'debug';
  executionMode: 'in-process' | 'durable';
  maxConcurrentLLMCalls?: number;
  maxConcurrentToolCalls?: number;
}

// =============================================================================
// SUSPENSION & RESUMPTION
// =============================================================================

export type SuspensionReason =
  | {
      type: 'async_tool';
      toolName: string;
      toolCallId: string;
      callbackId: string;
      timeout: number;
    }
  | {
      type: 'human_approval';
      prompt: string;
      callbackId: string;
      timeout: number;
      assignee?: string;
    }
  | { type: 'human_input'; prompt: string; fields: string[]; callbackId: string; timeout: number }
  | {
      type: 'remote_handoff';
      target: string;
      remoteTaskId: string;
      callbackId: string;
      timeout: number;
    }
  | {
      type: 'fan_out_branch';
      target: string;
      barrierId: string;
      callbackId: string;
      timeout: number;
    }
  | {
      /**
       * Hardened async fan-out branch callback.
       * New producers should emit this instead of `fan_out_branch`.
       */
      type: 'fan_out_remote_branch';
      target: string;
      barrierId: string;
      branchId: string;
      callbackId: string;
      timeout: number;
    }
  | {
      /**
       * Dedicated parent resume continuation for hardened async fan-out.
       * This is internal orchestration state, not an external callback contract.
       */
      type: 'fan_out_parent_resume';
      barrierId: string;
      callbackId: string;
      timeout: number;
    }
  | { type: 'a2a_push_notification'; taskId: string; callbackId: string; timeout: number }
  | { type: 'human_agent_transfer'; target: string; callbackId: string; timeout: number }
  | { type: 'escalation'; humanTaskId: string; callbackId?: string };

export interface ResumeData {
  type:
    | 'tool_result'
    | 'remote_handoff_result'
    | 'handoff_result'
    | 'fan_out_branch_result'
    | 'fan_out_remote_branch_result'
    | 'fan_out_parent_resume'
    | 'human_input'
    | 'a2a_status_update';
  callbackId: string;
  tenantId: string;
  payload: unknown;
  receivedAt: number;
}

// =============================================================================
// EXECUTION (concurrent message lifecycle)
// =============================================================================

export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'preempted'
  | 'suspended'
  | 'resuming';

export interface Execution {
  executionId: string;
  parentExecutionId?: string;
  sessionId: string;
  tenantId: string;

  // Input
  message: string;
  attachmentIds?: string[];
  agentName: string;

  // Lifecycle
  status: ExecutionStatus;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;

  // Output (populated on completion)
  response?: string;
  tokenUsage?: { input: number; output: number };
  durationMs?: number;
  error?: { code: string; message: string };
  gatheredData?: Record<string, unknown>;

  /**
   * Opaque result data from the executor. Allows the coordinator to pass
   * through the full ExecutionResult (voiceConfig, richContent, actions, etc.)
   * without the execution package depending on runtime-specific types.
   */
  resultData?: Record<string, unknown>;

  // Cancellation
  signal?: AbortSignal;

  /** Set when status === 'suspended' — links to the SuspendedExecution record */
  suspensionId?: string;
  /** Why the execution was suspended */
  suspensionReason?: SuspensionReason;
}

export interface CreateExecutionInput {
  executionId?: string;
  sessionId: string;
  tenantId: string;
  message: string;
  agentName: string;
  parentExecutionId?: string;
  attachmentIds?: string[];
}

export function createExecution(input: CreateExecutionInput): Execution {
  return {
    executionId: input.executionId ?? `exec-${crypto.randomUUID()}`,
    parentExecutionId: input.parentExecutionId,
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    message: input.message,
    agentName: input.agentName,
    attachmentIds: input.attachmentIds,
    status: 'queued',
    queuedAt: Date.now(),
  };
}

// =============================================================================
// CLIENT RESPONSE
// =============================================================================

/** Standardized client response from an execution */
export interface ExecutionClientResponse {
  success: boolean;
  response: string;
  resultData?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** Convert an execution to a standardized client response */
export function toClientResponse(execution: {
  status?: ExecutionStatus;
  response?: string;
  error?: { code: string; message: string };
  resultData?: Record<string, unknown>;
}): ExecutionClientResponse {
  const status = execution.status;
  const failed =
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'preempted' ||
    status === 'suspended';

  // Surface the error if present — regardless of status
  const error = execution.error
    ? { code: execution.error.code, message: execution.error.message }
    : failed
      ? { code: 'EXECUTION_FAILED', message: 'Execution failed without details' }
      : undefined;

  if (failed && error) {
    return { success: false, response: '', error };
  }

  // Extract response: top-level field first, then resultData fallbacks
  const resultData = execution.resultData ?? {};
  const response =
    typeof execution.response === 'string' && execution.response
      ? execution.response
      : typeof resultData.response === 'string'
        ? resultData.response
        : typeof resultData.text === 'string'
          ? resultData.text
          : '';

  return {
    success: !failed,
    response,
    resultData: Object.keys(resultData).length > 0 ? resultData : undefined,
    error,
  };
}
