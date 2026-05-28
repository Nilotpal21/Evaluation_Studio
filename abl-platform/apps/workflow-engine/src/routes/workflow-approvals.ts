/**
 * Workflow Approval Routes
 *
 * POST /api/projects/:projectId/workflows/:workflowId/executions/:executionId/steps/:stepId/approve
 *
 * Resolves a Restate approval promise with approve/reject decision.
 * Used by the approval step executor — it pauses execution until
 * a human approves or rejects.
 *
 * GET /api/projects/:projectId/approvals
 *
 * Lists all pending approvals across workflows for the tenant/project.
 * Powers the "Inbox" feed in the Studio UI.
 * Supports pagination via `limit` (default 50, max 100) and `offset` (default 0).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { syncHumanTaskOnResolve } from '../persistence/human-task-store.js';
import type { HumanTaskStoreLike } from '../persistence/human-task-store.js';
import type { MongooseModelLike } from '../persistence/execution-store.js';
import type { RestateWorkflowClient } from '../services/restate-client.js';
import { asyncHandler, requireTenantProject } from '../lib/route-helpers.js';

const log = createLogger('workflow-engine:approvals');

// =============================================================================
// INTERFACES
// =============================================================================

/** Step entry shape read from context.steps for the approval inbox. */
interface ApprovalStepEntry {
  nodeType?: string;
  status?: string;
  /** UUID assigned in BaseStepContext — used to match route :stepId param */
  stepId?: string;
  startedAt?: string;
  /** Step input — used as config in the inbox display */
  input?: Record<string, unknown>;
  /** Restate awakeable ID — present when the awakeable suspend path is active. */
  awakeableId?: string;
  /** Relay-race: true when this step was parked by executeWorkflow() (no awakeable). */
  parkPoint?: boolean;
  /** Relay-race: approve-path step IDs stored at park time. */
  nextStepIds?: string[];
  /** Relay-race: reject-path step IDs stored at park time. */
  rejectStepIds?: string[];
  /** Relay-race: which parallel branch this step belongs to. */
  branchId?: string;
  /** Phase 4: join step ID for barrier check when this branch resumes. */
  joinStepId?: string;
  /** Phase 4: barrier total for the resumed branch leg. */
  barrierTotal?: number;
  /** Phase 5: failure strategy carried to resumed branch leg. */
  failureStrategy?: 'fail_fast' | 'wait_all' | 'ignore_errors';
}

/**
 * Execution document shape exposed to the approval listing + single-approve
 * routes.
 */
interface ApprovalExecutionDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  status: string;
  context?: {
    steps?: Record<string, ApprovalStepEntry>;
  };
  startedAt?: Date;
}

/** Mongoose-like model for WorkflowExecution */
export type ApprovalExecutionModel = Pick<MongooseModelLike<ApprovalExecutionDoc>, 'findOne'>;

/** Restate client for resolving approval promises, awakeables, or relay-race runs */
export type ApprovalRestateClient = Pick<
  RestateWorkflowClient,
  'resolveApproval' | 'resolveAwakeable' | 'startWorkflow'
>;

/** Minimal persistence interface for relay-race approval resolution. */
export interface ApprovalPersistence {
  resolveParkedStep(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
    expectedStatus: string,
    result: { decision?: string; respondedBy?: string; notes?: string; completedAt?: string },
  ): Promise<boolean>;
  /** Terminates the execution when rejection has no on_reject edge — matches Restate path. */
  updateExecutionStatus?(
    executionId: string,
    tenantId: string,
    projectId: string,
    status: string,
    data?: { completedAt?: Date },
  ): Promise<void>;
}

export interface ApprovalRouteDeps {
  executionModel: ApprovalExecutionModel;
  restateClient: ApprovalRestateClient;
  humanTaskStore: HumanTaskStoreLike;
  /** Optional — wired for relay-race path. */
  persistence?: ApprovalPersistence;
}

export function createApprovalRouter(deps: ApprovalRouteDeps): Router {
  const router = Router({ mergeParams: true });

  /**
   * POST /:workflowId/executions/:executionId/steps/:stepId/approve
   *
   * Approve or reject a step.
   * Body: { decision: 'approve' | 'reject', reason?: string }
   */
  router.post(
    '/:workflowId/executions/:executionId/steps/:stepId/approve',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, {
        requireParams: ['workflowId', 'executionId', 'stepId'],
      });
      if (!ctx) return;
      const { tenantId, projectId, workflowId, executionId, stepId } = ctx;
      const userId = (req as Request & { tenantContext?: { userId?: string } }).tenantContext
        ?.userId;
      const { decision, reason } = req.body ?? {};

      if (!decision || !['approve', 'reject'].includes(decision)) {
        return res.status(400).json({
          success: false,
          error: "Body must include 'decision' with value 'approve' or 'reject'",
        });
      }

      // Load execution with tenant + project scoping
      const execution = await deps.executionModel.findOne({
        _id: executionId,
        tenantId,
        projectId,
        workflowId,
      });

      if (!execution) {
        return res.status(404).json({ success: false, error: 'Execution not found' });
      }

      // Find the step by UUID in context.steps values
      const contextSteps = execution.context?.steps ?? {};
      const step = Object.values(contextSteps).find((s) => s.stepId === stepId);
      if (!step) {
        return res.status(404).json({ success: false, error: 'Step not found' });
      }

      if (step.status !== 'waiting_approval') {
        return res.status(409).json({
          success: false,
          error: `Step is in '${step.status}' status, not waiting for approval`,
        });
      }

      // Resolve the suspension — tri-path for backward compatibility.
      //
      // Path A (relay-race): step.parkPoint === true
      //   Write decision to MongoDB, then trigger next relay leg. No Restate primitives.
      //
      // Path B (awakeable): step.awakeableId is set
      //   Resolve via /restate/awakeables/:id/resolve (bypasses 1.6.2 bug).
      //
      // Path C (legacy): neither parkPoint nor awakeableId
      //   Resolve via resolveApproval shared handler (oldest path).
      try {
        const decisionPayload = {
          approved: decision === 'approve',
          decidedBy: userId ?? 'unknown',
          reason,
        };

        if (step.parkPoint && deps.persistence) {
          // Find the context.steps key for this stepId
          const stepKey = Object.keys(contextSteps).find((k) => contextSteps[k]?.stepId === stepId);
          if (!stepKey) {
            return res.status(404).json({ success: false, error: 'Step key not found in context' });
          }

          const resolved = await deps.persistence.resolveParkedStep(
            executionId,
            execution.tenantId,
            execution.projectId,
            stepKey,
            'waiting_approval',
            {
              decision,
              respondedBy: userId ?? 'unknown',
              notes: reason,
              completedAt: new Date().toISOString(),
            },
          );
          if (!resolved) {
            return res.status(409).json({
              success: false,
              error: 'Step is no longer waiting for approval',
            });
          }

          // Pick the correct successor path based on the decision:
          //   approve → nextStepIds (on_approve edge)
          //   reject  → rejectStepIds (on_reject edge only — NO fallback to nextStepIds)
          //
          // Matching Restate handler behaviour: rejection with no on_reject edge
          // terminates the workflow as rejected rather than following the approve path.
          // Normalise 'reject' (approval route) and 'rejected' (human-task route / Studio)
          const isRejection = decision === 'reject' || decision === 'rejected';
          const nextStepIds: string[] = isRejection
            ? (step.rejectStepIds ?? [])
            : (step.nextStepIds ?? []);
          if (nextStepIds.length > 0) {
            // F-3: resolveParkedStep (MongoDB) and startWorkflow (Restate) are not
            // atomic — a crash between them leaves the step resolved with no continuation
            // leg. Retry the startWorkflow call up to 3 times with backoff to narrow
            // the crash window. If all attempts fail, log a structured error with enough
            // context for ops to manually trigger recovery via the relay-race resume endpoint.
            let startErr: unknown;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await deps.restateClient.startWorkflow(executionId, {
                  tenantId: execution.tenantId,
                  projectId: execution.projectId,
                  startFromStepIds: nextStepIds,
                  branchId: step.branchId,
                  resumeStepId: stepId,
                  joinStepId: step.joinStepId,
                  barrierTotal: step.barrierTotal,
                  failureStrategy: step.failureStrategy,
                });
                startErr = undefined;
                break;
              } catch (e) {
                startErr = e;
                if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
              }
            }
            if (startErr) {
              log.error('approval.continuation_trigger_failed', {
                executionId,
                tenantId: execution.tenantId,
                projectId: execution.projectId,
                stepId,
                nextStepIds,
                error: startErr instanceof Error ? startErr.message : String(startErr),
                recovery: 'POST relay-race resume endpoint with startFromStepIds to unblock',
              });
              return res.status(503).json({
                success: false,
                error: { code: 'RESTATE_UNAVAILABLE', message: 'Workflow engine unavailable' },
              });
            }
          } else if (isRejection && deps.persistence?.updateExecutionStatus) {
            // No on_reject edge — terminate execution as rejected, matching Restate path behaviour.
            await deps.persistence.updateExecutionStatus(
              executionId,
              execution.tenantId,
              execution.projectId,
              'rejected',
              { completedAt: new Date() },
            );
            log.info('Relay-race approval rejected — no on_reject edge, execution terminated', {
              executionId,
              stepId,
            });
          }
          log.info('Relay-race approval resolved — next leg triggered', {
            executionId,
            stepId,
            decision,
            nextStepIds,
          });
        } else if (step.awakeableId) {
          await deps.restateClient.resolveAwakeable(step.awakeableId, decisionPayload);
        } else {
          await deps.restateClient.resolveApproval(executionId, stepId, decisionPayload);
        }
      } catch (err: unknown) {
        log.error('Failed to resolve approval', {
          executionId,
          stepId,
          parkPoint: step.parkPoint,
          awakeableId: step.awakeableId,
          error: err instanceof Error ? err.message : String(err),
        });
        return res.status(503).json({
          success: false,
          error: { code: 'RESTATE_UNAVAILABLE', message: 'Workflow engine unavailable' },
        });
      }

      // For relay-race (Path A), MongoDB was already updated above.
      // For Paths B/C, the Restate handler updates context.steps on resume.

      // Sync the mirrored HumanTask record so the inbox reflects the decision.
      // Best-effort: Restate has already accepted resolution, so a sync
      // failure only affects the inbox view — we log and continue.
      await syncHumanTaskOnResolve(deps.humanTaskStore, {
        tenantId,
        projectId,
        sourceType: 'workflow_approval',
        executionId,
        stepId,
        respondedBy: userId ?? 'unknown',
        respondedAt: new Date(),
        fields: {},
        notes: reason,
        decision,
      });

      return res.json({ success: true, decision });
    }),
  );

  return router;
}
