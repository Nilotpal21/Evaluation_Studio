/**
 * EscalationResolutionHandler — handles resolution of escalated sessions.
 *
 * When a human resolves an escalation (via POST /:id/escalation/resolve),
 * this handler:
 * 1. Finds the HumanTask for the session
 * 2. Acquires a distributed lock (prevents double resolution)
 * 3. Updates HumanTask to 'completed'
 * 4. Evaluates on_human_complete conditions
 * 5. Marks the suspension as complete
 * 6. Emits escalation_resolved trace event
 *
 * Follows the DI pattern from resumption-service.ts.
 */

import { createLogger } from '@abl/compiler/platform';
import type { SuspensionStore, SuspendedExecution } from '@agent-platform/execution';
import type { LockPort } from '../execution/resumption-service.js';
import type { IHumanTask } from '@agent-platform/database/models';
import type mongoose from 'mongoose';

const log = createLogger('escalation-resolution-handler');

// =============================================================================
// TYPES
// =============================================================================

export interface EscalationResolution {
  decision: string;
  notes?: string;
  fields?: Record<string, unknown>;
  respondedBy: string;
}

export interface EscalationResolutionResult {
  success: boolean;
  action?: string;
  humanTaskId?: string;
  error?: { code: string; message: string };
}

export interface EscalationStatusResult {
  success: boolean;
  data?: {
    humanTaskId: string;
    status: string;
    priority: string;
    title: string;
    connectorTicketId?: string;
    connectorTicketUrl?: string;
    createdAt: Date;
    updatedAt: Date;
    response?: {
      respondedBy: string;
      respondedAt: Date;
      decision?: string;
      notes?: string;
    };
  };
  error?: { code: string; message: string };
}

export interface EscalationResolutionHandlerDeps {
  humanTaskModel: mongoose.Model<IHumanTask>;
  suspensionStore: SuspensionStore;
  lockManager: LockPort;
  onTraceEvent?: (
    sessionId: string,
    event: { type: string; data: Record<string, unknown> },
  ) => void;
}

// =============================================================================
// HANDLER
// =============================================================================

export class EscalationResolutionHandler {
  private readonly humanTaskModel: mongoose.Model<IHumanTask>;
  private readonly suspensionStore: SuspensionStore;
  private readonly lockManager: LockPort;
  private readonly onTraceEvent?: (
    sessionId: string,
    event: { type: string; data: Record<string, unknown> },
  ) => void;

  constructor(deps: EscalationResolutionHandlerDeps) {
    this.humanTaskModel = deps.humanTaskModel;
    this.suspensionStore = deps.suspensionStore;
    this.lockManager = deps.lockManager;
    this.onTraceEvent = deps.onTraceEvent;
  }

  /**
   * Handle resolution of an escalated session.
   *
   * Uses a distributed lock to prevent double resolution across pods.
   * Finds the HumanTask, updates it, evaluates on_human_complete conditions,
   * and marks the suspension as complete.
   */
  async handleResolution(
    sessionId: string,
    tenantId: string,
    projectId: string,
    resolution: EscalationResolution,
  ): Promise<EscalationResolutionResult> {
    // Acquire distributed lock — prevents concurrent resolution attempts
    const lock = await this.lockManager.acquire(`escalation-resolve:${sessionId}`, {
      keyPrefix: 'escalation',
      ttlMs: 300_000,
      retryAttempts: 5,
      retryDelayMs: 200,
    });

    if (!lock) {
      log.warn('Could not acquire escalation resolution lock', { sessionId, tenantId });
      return {
        success: false,
        error: {
          code: 'LOCK_ACQUISITION_FAILED',
          message: 'Could not acquire lock for escalation resolution',
        },
      };
    }

    try {
      // Find the HumanTask for this session (tenant-scoped)
      const humanTask = await this.humanTaskModel
        .findOne({
          'source.sessionId': sessionId,
          tenantId,
          projectId,
        })
        .sort({ createdAt: -1 });

      if (!humanTask) {
        return {
          success: false,
          error: {
            code: 'ESCALATION_NOT_FOUND',
            message: 'No escalation found for this session',
          },
        };
      }

      // Check if already resolved
      if (humanTask.status === 'completed') {
        return {
          success: false,
          humanTaskId: humanTask._id,
          error: {
            code: 'ESCALATION_ALREADY_RESOLVED',
            message: 'This escalation has already been resolved',
          },
        };
      }

      // Check if in a resolvable state
      if (humanTask.status === 'cancelled' || humanTask.status === 'expired') {
        return {
          success: false,
          humanTaskId: humanTask._id,
          error: {
            code: 'ESCALATION_NOT_RESOLVABLE',
            message: `Escalation is in ${humanTask.status} state and cannot be resolved`,
          },
        };
      }

      // Update HumanTask to completed
      await this.humanTaskModel.findOneAndUpdate(
        { _id: humanTask._id, tenantId },
        {
          $set: {
            status: 'completed' as const,
            response: {
              respondedBy: resolution.respondedBy,
              respondedAt: new Date(),
              fields: resolution.fields ?? {},
              notes: resolution.notes,
              decision: resolution.decision,
            },
          },
        },
        { new: true },
      );

      // Evaluate on_human_complete conditions
      const action = this.evaluateOnHumanComplete(humanTask, resolution);

      // Mark escalation suspension as complete
      await this.completeEscalationSuspension(sessionId);

      // Emit trace event
      this.onTraceEvent?.(sessionId, {
        type: 'escalation_resolved',
        data: {
          humanTaskId: humanTask._id,
          decision: resolution.decision,
          action,
          respondedBy: resolution.respondedBy,
          sessionId,
        },
      });

      log.info('Escalation resolved', {
        sessionId,
        humanTaskId: humanTask._id,
        action,
        tenantId,
      });

      return {
        success: true,
        action,
        humanTaskId: humanTask._id,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error('Escalation resolution failed', {
        sessionId,
        tenantId,
        error: errorMsg,
      });
      return {
        success: false,
        error: {
          code: 'RESOLUTION_FAILED',
          message: 'Failed to resolve escalation',
        },
      };
    } finally {
      await this.lockManager.release(lock);
    }
  }

  /**
   * Get the escalation status for a session.
   */
  async getStatus(
    sessionId: string,
    tenantId: string,
    projectId: string,
  ): Promise<EscalationStatusResult> {
    const humanTask = await this.humanTaskModel
      .findOne({
        'source.sessionId': sessionId,
        tenantId,
        projectId,
      })
      .sort({ createdAt: -1 })
      .lean();

    if (!humanTask) {
      return {
        success: false,
        error: {
          code: 'ESCALATION_NOT_FOUND',
          message: 'No escalation found for this session',
        },
      };
    }

    return {
      success: true,
      data: {
        humanTaskId: humanTask._id,
        status: humanTask.status,
        priority: humanTask.priority,
        title: humanTask.title,
        connectorTicketId: humanTask.connectorTicketId,
        connectorTicketUrl: humanTask.connectorTicketUrl,
        createdAt: humanTask.createdAt,
        updatedAt: humanTask.updatedAt,
        response: humanTask.response
          ? {
              respondedBy: humanTask.response.respondedBy,
              respondedAt: humanTask.response.respondedAt,
              decision: humanTask.response.decision,
              notes: humanTask.response.notes,
            }
          : undefined,
      },
    };
  }

  /**
   * Evaluate on_human_complete conditions.
   *
   * Empty array defaults to 'continue'. Iterates entries in order,
   * first match wins. If no conditions match, defaults to 'continue'.
   */
  private evaluateOnHumanComplete(humanTask: IHumanTask, resolution: EscalationResolution): string {
    // Get escalation config from the HumanTask context
    const onHumanComplete =
      (humanTask.context?.on_human_complete as Array<{ condition: string; action: string }>) ?? [];

    if (onHumanComplete.length === 0) {
      return 'continue';
    }

    // Evaluate conditions against the resolution
    for (const entry of onHumanComplete) {
      if (this.evaluateCondition(entry.condition, resolution)) {
        return entry.action;
      }
    }

    // No match — default to continue
    return 'continue';
  }

  /**
   * Simple condition evaluator for on_human_complete conditions.
   *
   * Supports:
   * - 'always' / '*' — always matches
   * - 'decision == "<value>"' — exact match on resolution decision
   * - 'decision != "<value>"' — not equal on resolution decision
   */
  private evaluateCondition(condition: string, resolution: EscalationResolution): boolean {
    const trimmed = condition.trim();

    if (trimmed === 'always' || trimmed === '*') {
      return true;
    }

    // decision == "value"
    const eqMatch = trimmed.match(/^decision\s*==\s*["'](.+?)["']$/);
    if (eqMatch) {
      return resolution.decision === eqMatch[1];
    }

    // decision != "value"
    const neqMatch = trimmed.match(/^decision\s*!=\s*["'](.+?)["']$/);
    if (neqMatch) {
      return resolution.decision !== neqMatch[1];
    }

    // Unrecognized condition — log and skip
    log.debug('Unrecognized on_human_complete condition', { condition: trimmed });
    return false;
  }

  /**
   * Find and complete the escalation suspension for a session.
   */
  private async completeEscalationSuspension(sessionId: string): Promise<void> {
    const suspensions = await this.suspensionStore.findBySession(sessionId);
    const escalationSuspension = suspensions.find(
      (s: SuspendedExecution) => s.continuation?.type === 'escalation' && s.status === 'suspended',
    );

    if (escalationSuspension) {
      await this.suspensionStore.complete(escalationSuspension.suspensionId);
      log.info('Escalation suspension completed', {
        suspensionId: escalationSuspension.suspensionId,
        sessionId,
      });
    } else {
      log.debug('No active escalation suspension found for session', { sessionId });
    }
  }
}
