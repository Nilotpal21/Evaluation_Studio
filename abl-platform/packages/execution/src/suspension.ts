/**
 * Suspension Types
 *
 * Core data model for suspended executions. A SuspendedExecution is a
 * first-class persistent entity created when execution encounters an async
 * boundary (remote agent with push notifications, async tool, human approval).
 *
 * All state is externalized — MongoDB for persistence, Redis for fast callback
 * lookup — so suspended executions survive pod restarts and can be resumed
 * on any pod.
 */

import type { SuspensionReason } from './types.js';

// =============================================================================
// SUSPENDED EXECUTION
// =============================================================================

export type SuspensionStatus =
  | 'suspended'
  | 'resuming'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

/**
 * SuspendedExecution — durable record of an execution waiting for an external
 * event. Stored in MongoDB for persistence. Redis used for fast callback-to-
 * suspension lookup.
 */
export interface SuspendedExecution {
  /** Unique suspension ID */
  suspensionId: string;

  /** Original execution ID from ExecutionCoordinator */
  executionId: string;

  /** Session ID to reload and resume */
  sessionId: string;

  /** Tenant ID (every query must include tenantId per platform invariant #1) */
  tenantId: string;

  /** Project ID (needed for LLM credential resolution on resume) */
  projectId?: string;

  /** Why was execution suspended? */
  reason: SuspensionReason;

  /** Where to resume: captures the exact continuation point */
  continuation: SuspendedContinuation;

  /** How to deliver the result when execution resumes */
  channelBinding: ChannelBinding;

  /** The callback ID registered for this suspension (for reverse lookup) */
  callbackId: string;

  /** Encrypted HMAC secret for callback authentication */
  callbackSecret: string;

  /** For fan-out: which barrier this suspension belongs to */
  barrierId?: string;

  /** Current lifecycle status */
  status: SuspensionStatus;

  /** Lifecycle timestamps */
  suspendedAt: Date;
  expiresAt: Date;
  resumedAt?: Date;
  completedAt?: Date;

  /** Resume attempt counter (for retry tracking) */
  resumeAttempts: number;

  /** Error details if resume failed */
  error?: { code: string; message: string };
}

// =============================================================================
// CONTINUATION — captures exactly WHERE execution should resume
// =============================================================================

/**
 * SuspendedContinuation — the "program counter" for suspended execution.
 * Each variant corresponds to a different async boundary type.
 */
export type SuspendedContinuation =
  | {
      type: 'tool_result';
      /** Tool name that was executing */
      toolName: string;
      /** Tool call ID from the LLM response (needed to inject tool_result into conversation) */
      toolCallId: string;
      /** Thread index in the session's threads array */
      threadIndex: number;
      /** Flow step that was executing (for scripted agents) */
      flowStep?: string;
      /** Conversation history length at suspension (for validation on resume) */
      conversationLength: number;
    }
  | {
      type: 'remote_handoff_result';
      /** Target agent name */
      targetAgent: string;
      /** Thread index of the remote thread in session.threads */
      remoteThreadIndex: number;
      /** Index of the parent thread (if return expected) */
      parentThreadIndex?: number;
      /** Whether the parent expects a return value */
      returnExpected: boolean;
      /** A2A task ID on the remote agent */
      remoteTaskId: string;
    }
  | {
      type: 'fan_out_branch';
      /** Barrier ID for this fan-out group */
      barrierId: string;
      /** Which agent this branch executes */
      branchAgent: string;
      /** Thread index of the branch in session.threads */
      threadIndex: number;
      /** The parent session's fan-out execution ID */
      parentExecutionId: string;
    }
  | {
      type: 'fan_out_remote_branch';
      /** Barrier ID for this fan-out group */
      barrierId: string;
      /** Stable branch identifier for idempotent callback handling */
      branchId: string;
      /** Which agent this branch executes */
      branchAgent: string;
      /** Thread index of the remote branch in session.threads */
      threadIndex: number;
      /** The parent session's fan-out execution ID */
      parentExecutionId: string;
    }
  | {
      type: 'fan_out_parent_resume';
      /** Barrier ID whose aggregate results will resume the parent */
      barrierId: string;
      /** Thread index of the waiting parent */
      parentThreadIndex: number;
      /** The parent session's fan-out execution ID */
      parentExecutionId: string;
    }
  | {
      type: 'human_input';
      /** Prompt shown to the human */
      prompt: string;
      /** Fields the human must provide */
      requiredFields?: string[];
      /** Thread index waiting for input */
      threadIndex: number;
      /** Flow step that triggered the human approval/input */
      flowStep?: string;
      /** Assignee (who should provide the input) */
      assignee?: string;
      /** A2A task ID (if this was triggered by an A2A request) */
      a2aTaskId?: string;
    }
  | {
      type: 'human_agent_transfer';
      /** Target routing key for the human agent */
      routingKey: string;
      /** Thread index of the waiting parent */
      threadIndex: number;
      /** Context keys to forward to the human agent */
      contextKeys?: string[];
    }
  | {
      type: 'escalation';
      /** The escalation config from the agent IR */
      escalationConfig: Record<string, unknown>;
      /** HumanTask record ID for this escalation */
      humanTaskId: string;
    };

export type FanOutContinuation = Extract<
  SuspendedContinuation,
  { type: 'fan_out_branch' | 'fan_out_remote_branch' | 'fan_out_parent_resume' }
>;

export type FanOutContinuationOwner = 'legacy' | 'remote_branch' | 'parent_resume';

export function getFanOutContinuationOwner(
  continuation: FanOutContinuation,
): FanOutContinuationOwner {
  switch (continuation.type) {
    case 'fan_out_remote_branch':
      return 'remote_branch';
    case 'fan_out_parent_resume':
      return 'parent_resume';
    case 'fan_out_branch':
    default:
      return 'legacy';
  }
}

// =============================================================================
// CHANNEL BINDING — captures HOW to deliver the result
// =============================================================================

/**
 * ChannelBinding — captures how to deliver the response when execution resumes.
 * The original channel may or may not still be available.
 */
export interface ChannelBinding {
  /** Original channel type (from ChannelType enum) */
  channelType: string;

  /** Tenant ID for the channel context */
  tenantId: string;

  /** For WebSocket channels: a unique connection identifier */
  wsConnectionId?: string;

  /** For WebSocket: the session ID to Redis Pub/Sub channel mapping */
  wsSessionId?: string;

  /** For async channels (Slack, WhatsApp, etc.): the channel connection ID */
  connectionId?: string;

  /** For A2A: the caller's push notification configuration */
  pushNotificationConfig?: {
    url: string;
    token?: string;
    authentication?: { schemes: string[] };
  };

  /** DB session ID for message persistence */
  dbSessionId?: string;

  /** Project ID — required for tenant-isolated message persistence on resume */
  projectId?: string;

  /** CallerContext for identity continuity across suspension */
  callerContext?: Record<string, unknown>;
}
