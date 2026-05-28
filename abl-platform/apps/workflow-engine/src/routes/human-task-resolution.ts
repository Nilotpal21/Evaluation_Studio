/**
 * Human Task Resolution Routes
 *
 * POST /api/projects/:projectId/human-tasks/executions/:executionId/steps/:stepId/resolve
 *
 * Resolves a Restate human task durable promise with the human response.
 * Mirrors workflow-approvals.ts pattern for the human_task step type.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { syncHumanTaskOnResolve } from '../persistence/human-task-store.js';
import type { HumanTaskStoreLike } from '../persistence/human-task-store.js';
import type { MongooseModelLike } from '../persistence/execution-store.js';
import type { RestateWorkflowClient } from '../services/restate-client.js';
import { asyncHandler, requireTenantProject } from '../lib/route-helpers.js';

export type { HumanTaskStoreLike };

const log = createLogger('workflow-engine:human-task-resolution');

/** Step entry shape read from context.steps for human task resolution. */
interface HumanTaskStepEntry {
  status?: string;
  stepId?: string;
  /** Restate awakeable ID — present when the awakeable suspend path is active. */
  awakeableId?: string;
  /** Relay-race: true when this step was parked by executeWorkflow() (no awakeable). */
  parkPoint?: boolean;
  /** Relay-race: successor step IDs (on_approve / on_submit path). */
  nextStepIds?: string[];
  /** Relay-race: rejection path step IDs (on_reject edge). */
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

/** Execution document shape the resolve route reads. */
interface HumanTaskExecutionDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId?: string;
  context?: {
    steps?: Record<string, HumanTaskStepEntry>;
  };
}

/** Execution model for looking up step status */
export type HumanTaskExecutionModel = Pick<MongooseModelLike<HumanTaskExecutionDoc>, 'findOne'>;

/** Restate client for resolving human task promises, awakeables, or relay-race runs */
export type HumanTaskRestateClient = Pick<
  RestateWorkflowClient,
  'resolveHumanTask' | 'resolveAwakeable' | 'startWorkflow'
>;

/** Minimal persistence interface for relay-race human task resolution. */
export interface HumanTaskPersistence {
  resolveParkedStep(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
    expectedStatus: string,
    result: {
      fields?: Record<string, unknown>;
      respondedBy?: string;
      notes?: string;
      decision?: string;
      completedAt?: string;
    },
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

export interface HumanTaskResolutionRouteDeps {
  executionModel: HumanTaskExecutionModel;
  restateClient: HumanTaskRestateClient;
  humanTaskStore: HumanTaskStoreLike;
  /** Optional — wired for relay-race path. */
  persistence?: HumanTaskPersistence;
}

export function createHumanTaskResolutionRouter(deps: HumanTaskResolutionRouteDeps): Router {
  const router = Router({ mergeParams: true });

  /**
   * POST /executions/:executionId/steps/:stepId/resolve
   *
   * Body: { respondedBy, fields, notes?, decision? }
   */
  router.post(
    '/executions/:executionId/steps/:stepId/resolve',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['executionId', 'stepId'] });
      if (!ctx) return;
      const { tenantId, projectId, executionId, stepId } = ctx;
      const tenantContext = (req as Request & { tenantContext?: { userId?: string } })
        .tenantContext;
      const { fields, notes, decision, respondedAt } = req.body ?? {};

      // SECURITY: Derive responder identity from authenticated context, not request body.
      // This prevents identity spoofing in the audit trail.
      const authenticatedUserId = tenantContext?.userId;
      if (!authenticatedUserId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const respondedBy = authenticatedUserId;
      if (req.body?.respondedBy && req.body.respondedBy !== authenticatedUserId) {
        log.warn('Ignoring client-supplied respondedBy — using authenticated identity', {
          executionId,
          stepId,
          clientRespondedBy: req.body.respondedBy,
          authenticatedUserId,
        });
      }

      // Load execution with tenant + project scoping
      const execution = await deps.executionModel.findOne({
        _id: executionId,
        tenantId,
        projectId,
      });

      if (!execution) {
        return res.status(404).json({ success: false, error: 'Execution not found' });
      }

      const step = Object.values(execution.context?.steps ?? {}).find((s) => s.stepId === stepId);
      if (!step) {
        return res.status(404).json({ success: false, error: 'Step not found' });
      }

      if (step.status !== 'waiting_human_task') {
        return res.status(409).json({
          success: false,
          error: `Step is in '${step.status}' status, not waiting for human task`,
        });
      }

      // Resolve the suspension — tri-path for backward compatibility.
      //
      // Path A (relay-race): step.parkPoint === true
      //   Write response to MongoDB, then trigger next relay leg. No Restate primitives.
      //
      // Path B (awakeable): step.awakeableId is set
      //   Resolve via /restate/awakeables/:id/resolve (bypasses 1.6.2 bug).
      //
      // Path C (legacy): neither parkPoint nor awakeableId
      //   Resolve via resolveHumanTask shared handler (oldest path).
      try {
        if (step.parkPoint && deps.persistence) {
          const contextSteps = execution.context?.steps ?? {};
          const stepKey = Object.keys(contextSteps).find((k) => contextSteps[k]?.stepId === stepId);
          if (!stepKey) {
            return res.status(404).json({ success: false, error: 'Step key not found in context' });
          }

          const resolved = await deps.persistence.resolveParkedStep(
            executionId,
            execution.tenantId,
            execution.projectId,
            stepKey,
            'waiting_human_task', // F-2 fix: unified status string matches extractSuspensionSignal
            {
              fields: fields ?? {},
              respondedBy,
              notes,
              decision,
              completedAt: new Date().toISOString(),
            },
          );
          if (!resolved) {
            return res.status(409).json({
              success: false,
              error: 'Step is no longer waiting for human task',
            });
          }

          // Use reject path when decision indicates rejection — NO fallback to nextStepIds.
          // Matches Restate path: rejection with no on_reject edge terminates as rejected.
          // Normalise 'reject' and 'rejected' — Studio sends past-tense from inbox
          const isRejection = decision === 'reject' || decision === 'rejected';
          const nextStepIds: string[] = isRejection
            ? (step.rejectStepIds ?? [])
            : (step.nextStepIds ?? []);
          if (nextStepIds.length > 0) {
            // F-3: resolveParkedStep (MongoDB) and startWorkflow (Restate) are not
            // atomic — a crash between them leaves the step resolved with no continuation
            // leg. Retry up to 3 times with backoff; structured error on final failure
            // gives ops the context needed to trigger recovery manually.
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
              log.error('human_task.continuation_trigger_failed', {
                executionId,
                tenantId: execution.tenantId,
                projectId: execution.projectId,
                stepId,
                nextStepIds,
                error: startErr instanceof Error ? startErr.message : String(startErr),
                recovery: 'POST relay-race resume endpoint with startFromStepIds to unblock',
              });
              return res.status(503).json({ success: false, error: 'Workflow engine unavailable' });
            }
          } else if (isRejection && deps.persistence?.updateExecutionStatus) {
            // No on_reject edge — terminate as rejected, matching Restate path behaviour.
            await deps.persistence.updateExecutionStatus(
              executionId,
              execution.tenantId,
              execution.projectId,
              'rejected',
              { completedAt: new Date() },
            );
          }
          log.info('Relay-race human task resolved — next leg triggered', {
            executionId,
            stepId,
            nextStepIds,
          });
        } else {
          const payload = { respondedBy, respondedAt, fields: fields ?? {}, notes, decision };
          if (step.awakeableId) {
            await deps.restateClient.resolveAwakeable(step.awakeableId, payload);
          } else {
            await deps.restateClient.resolveHumanTask(executionId, stepId, payload);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to resolve human task', {
          executionId,
          stepId,
          parkPoint: step.parkPoint,
          awakeableId: step.awakeableId,
          error: msg,
        });
        return res.status(503).json({ success: false, error: 'Workflow engine unavailable' });
      }

      log.info('Human task resolved', { executionId, stepId, respondedBy });

      // Sync MongoDB HumanTask record so the inbox reflects the resolution.
      // Restate has already accepted the resolution — the canonical workflow
      // state is safe. A failure here only affects the inbox view, so we
      // swallow and log rather than surface a 5xx to the caller.
      await syncHumanTaskOnResolve(deps.humanTaskStore, {
        tenantId,
        projectId,
        sourceType: 'workflow_human_task',
        executionId,
        stepId,
        respondedBy,
        respondedAt: respondedAt ? new Date(respondedAt) : new Date(),
        fields: fields ?? {},
        notes,
        decision,
      });

      return res.json({ success: true, executionId, stepId });
    }),
  );

  return router;
}
