/**
 * Human Tasks API Routes
 *
 * Project-scoped CRUD for the unified human-in-the-loop system.
 * Supports listing, assignment, claiming, and resolution of tasks
 * across all source types (workflow approvals, human tasks, escalations).
 *
 * GET    /                — List tasks with filters
 * GET    /:taskId         — Get single task with context
 * POST   /:taskId/assign  — Assign to user or team
 * POST   /:taskId/claim   — Claim for live handling
 * POST   /:taskId/resolve — Submit response and resolve upstream
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import {
  HumanTask,
  type IHumanTask,
  type HumanTaskStatus,
  type HumanTaskType,
  WorkflowExecution,
} from '@agent-platform/database/models';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import type {
  WorkflowTaskPage,
  WorkflowTaskVisibility,
} from '../services/hybrid-human-task-reader.js';

/** Validation schema for POST /:taskId/resolve body */
const resolveBodySchema = z.object({
  fields: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
  decision: z.string().min(1).optional(),
});

const log = createLogger('runtime:human-tasks');

/**
 * Canonical enum of status values the `?status=` query parameter accepts.
 * Mirrors the Mongoose `HumanTaskStatus` type. Exported for testability.
 */
export const HUMAN_TASK_STATUS_VALUES = [
  'pending',
  'assigned',
  'in_progress',
  'completed',
  'expired',
  'cancelled',
] as const;

const statusEnumSchema = z.enum(HUMAN_TASK_STATUS_VALUES);

/**
 * Zod schema for the `?status=` query parameter (test-spec UT-04 + FR-9).
 *
 * Accepts:
 *   - Absent param → `[]`
 *   - Single value `?status=pending` → `['pending']`
 *   - Comma-separated list `?status=pending,assigned,in_progress` → 3-element array
 *
 * Rejects unknown enum values with a structured 400 error — `?status=foo`
 * returns `{ success: false, error: { code: 'VALIDATION_ERROR', message } }`
 * per CLAUDE.md structured-error-response rule.
 */
const statusQuerySchema = z
  .string()
  .optional()
  .transform((raw) => {
    if (!raw) return [] as HumanTaskStatus[];
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return Array.from(new Set(parts));
  })
  .pipe(z.array(statusEnumSchema));

/**
 * Parse `?status=` — returns the validated status list OR a structured
 * error payload. Call-sites check `'error' in result` to branch.
 */
export function parseStatusList(
  raw: string | undefined,
): { statuses: HumanTaskStatus[] } | { error: { code: 'VALIDATION_ERROR'; message: string } } {
  const parsed = statusQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const invalid = parsed.error.issues.map((i) => i.message).join('; ');
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: `Invalid status value(s); allowed: ${HUMAN_TASK_STATUS_VALUES.join(', ')}. Details: ${invalid}`,
      },
    };
  }
  return { statuses: parsed.data };
}

/**
 * Hybrid workflow-mailbox reader surface (LLD §5.3). Wired from `server.ts`
 * only when `WORKFLOW_DUAL_READ_ENABLED=true`. Flag off ⇒ route falls back
 * to the direct HumanTask model query (Mongo-only).
 */
export interface WorkflowHumanTaskHybridReader {
  listWorkflowTasksPage(params: {
    tenantId: string;
    projectId: string;
    statuses: string[];
    type?: string;
    priority?: string;
    visibility: WorkflowTaskVisibility;
    limit: number;
    offset: number;
  }): Promise<WorkflowTaskPage>;
}

export interface WorkflowSourceContext {
  tenantId: string;
  projectId: string;
  /** Workflow ID from the task source — needed for approval/human-task resolution paths */
  workflowId?: string;
  /** Forwarded Authorization header from the original request */
  authHeader?: string;
}

export interface HumanTaskRouteDeps {
  /** Resolve workflow approvals via Restate */
  resolveApproval?: (
    executionId: string,
    stepId: string,
    decision: { approved: boolean; decidedBy: string; reason?: string },
    ctx: WorkflowSourceContext,
  ) => Promise<void>;
  /** Resolve workflow human tasks via Restate */
  resolveHumanTask?: (
    executionId: string,
    stepId: string,
    response: {
      respondedBy: string;
      respondedAt?: string;
      fields: Record<string, unknown>;
      notes?: string;
      decision?: string;
    },
    ctx: WorkflowSourceContext,
  ) => Promise<void>;
  /** Resolve agent escalations */
  resolveEscalation?: (
    sessionId: string,
    data: { respondedBy: string; message: string },
    ctx: WorkflowSourceContext,
  ) => Promise<{ success: boolean }>;
  /**
   * Factory for the hybrid `mailbox='workflow'` reader (LLD §5.3).
   *
   * Invoked per-request so the factory can be set LATE — after CH is
   * initialized in `server.ts` startup. Returns `null` until the reader
   * is wired (or when `WORKFLOW_DUAL_READ_ENABLED=false`), in which case
   * the route falls back to the direct Mongo query.
   */
  workflowHybridReader?: () => WorkflowHumanTaskHybridReader | null;
}

export function createHumanTaskRouter(deps: HumanTaskRouteDeps): Router {
  const router = Router({ mergeParams: true });

  // Auth middleware — populates req.tenantContext for downstream permission checks
  router.use(authMiddleware);

  // GET / — List human tasks with filters
  router.get('/', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'human_task:read'))) return;

    const tenantId = (req as any).tenantContext?.tenantId;
    const { projectId } = req.params;

    if (!tenantId || !projectId) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    const {
      status,
      type,
      mailbox,
      assignedTo,
      priority,
      limit: limitStr,
      offset: offsetStr,
    } = req.query as Record<string, string>;

    const visibilityFilter: Record<string, unknown> = { tenantId, projectId };
    let visibility: WorkflowTaskVisibility = { kind: 'all' };
    if (assignedTo) {
      // Mongo equality against an array field matches element membership, so
      // `{ assignedTo: 'userA' }` matches `assignedTo: ['userA', 'userB']`.
      visibility = { kind: 'user_only', userId: assignedTo };
      visibilityFilter.$or = [{ assignedTo }, { claimedBy: assignedTo }];
    } else {
      // Default inbox scoping. A task is visible to the current non-admin user when:
      //   - they are in the `assignedTo` list (direct or scoped pool), or
      //   - they claimed it, or
      //   - it is an open pool (assignedTo missing / null / empty array).
      // Admin/owner sees every task in the project.
      const userId = (req as any).tenantContext?.userId;
      const role = (req as any).tenantContext?.role;
      const roleLower = typeof role === 'string' ? role.toLowerCase() : '';
      const isAdmin = roleLower === 'admin' || roleLower === 'owner';
      if (userId && !isAdmin) {
        visibility = { kind: 'user_or_open_pool', userId };
        visibilityFilter.$or = [
          { assignedTo: userId },
          { claimedBy: userId },
          { assignedTo: { $exists: false } },
          { assignedTo: null },
          { assignedTo: { $size: 0 } },
        ];
      }
    }

    const filter: Record<string, unknown> = { ...visibilityFilter };
    // `status` accepts either a single value or a comma-separated list
    // (e.g. `status=pending,assigned,in_progress`) — the Studio Inbox
    // default filter per feature-spec FR-9 + LLD §5.6.
    //
    // Invalid enum values (`?status=foo`) return 400 with a structured
    // error per CLAUDE.md + test-spec UT-04.
    const parsedStatus = parseStatusList(status);
    if ('error' in parsedStatus) {
      return res.status(400).json({ success: false, error: parsedStatus.error });
    }
    const statusValues = parsedStatus.statuses;
    if (statusValues.length === 1) {
      filter.status = statusValues[0];
    } else if (statusValues.length > 1) {
      filter.status = { $in: statusValues };
    }
    if (type) filter.type = type;
    if (mailbox) filter.mailbox = mailbox;
    if (priority) filter.priority = priority;

    const limit = Math.min(parseInt(limitStr || '50', 10), 100);
    const offset = parseInt(offsetStr || '0', 10);

    try {
      // Hybrid reader only takes the `mailbox='workflow'` path — other
      // mailboxes must remain Mongo-only per HLD §5.3 errata E-5.
      const resolvedHybrid =
        deps.workflowHybridReader && mailbox === 'workflow' ? deps.workflowHybridReader() : null;
      let tasks: unknown[];
      let total: number;
      if (resolvedHybrid) {
        const page = await resolvedHybrid.listWorkflowTasksPage({
          tenantId,
          projectId,
          statuses: statusValues,
          type,
          priority,
          visibility,
          limit,
          offset,
        });
        tasks = page.rows;
        total = page.total;
      } else {
        [tasks, total] = await Promise.all([
          HumanTask.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
          HumanTask.countDocuments(filter),
        ]);
      }

      // Count by type for filter tabs (scoped to active mailbox when filtered)
      const activeMatch: Record<string, unknown> = {
        ...visibilityFilter,
        status: { $in: ['pending', 'assigned', 'in_progress'] },
      };
      if (mailbox) activeMatch.mailbox = mailbox;

      const counts = await HumanTask.aggregate([
        { $match: activeMatch },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]);
      const countsByType: Record<string, number> = {};
      for (const c of counts) {
        countsByType[c._id] = c.count;
      }

      // Count by mailbox for top-level tabs with the same visibility scope.
      const mailboxMatch: Record<string, unknown> = {
        ...visibilityFilter,
        status: { $in: ['pending', 'assigned', 'in_progress'] },
      };
      const mailboxCounts = await HumanTask.aggregate([
        { $match: mailboxMatch },
        { $group: { _id: '$mailbox', count: { $sum: 1 } } },
      ]);
      const countsByMailbox: Record<string, number> = {};
      for (const c of mailboxCounts) {
        if (c._id) countsByMailbox[c._id] = c.count;
      }

      return res.json({
        success: true,
        data: tasks,
        total,
        countsByType,
        countsByMailbox,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to list human tasks', { error: msg });
      return res.status(500).json({ success: false, error: 'Failed to list human tasks' });
    }
  });

  // GET /:taskId — Get single task
  router.get('/:taskId', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'human_task:read'))) return;

    const tenantId = (req as any).tenantContext?.tenantId;
    const { projectId, taskId } = req.params;

    if (!tenantId || !projectId) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    try {
      const task = await HumanTask.findOne({ _id: taskId, tenantId, projectId }).lean();
      if (!task) {
        return res.status(404).json({ success: false, error: 'Task not found' });
      }
      return res.json({ success: true, data: task });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to get human task', { taskId, error: msg });
      return res.status(500).json({ success: false, error: 'Failed to get human task' });
    }
  });

  // POST /:taskId/assign — Assign to user or team
  router.post('/:taskId/assign', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'human_task:assign'))) return;

    const tenantId = (req as any).tenantContext?.tenantId;
    const { projectId, taskId } = req.params;
    const { assignedTo, assignedToTeam } = req.body ?? {};

    if (!tenantId || !projectId) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    // Accept either a single userId or an array of userIds on the wire;
    // always persist as an array to match the schema.
    const assignedToArray: string[] | undefined =
      typeof assignedTo === 'string' && assignedTo.length > 0
        ? [assignedTo]
        : Array.isArray(assignedTo)
          ? assignedTo.filter((x): x is string => typeof x === 'string' && x.length > 0)
          : undefined;

    if ((!assignedToArray || assignedToArray.length === 0) && !assignedToTeam) {
      return res
        .status(400)
        .json({ success: false, error: 'assignedTo or assignedToTeam is required' });
    }

    try {
      const update: Record<string, unknown> = { status: 'assigned' as HumanTaskStatus };
      if (assignedToArray && assignedToArray.length > 0) update.assignedTo = assignedToArray;
      if (assignedToTeam) update.assignedToTeam = assignedToTeam;

      const task = await HumanTask.findOneAndUpdate(
        { _id: taskId, tenantId, projectId, status: { $in: ['pending', 'assigned'] } },
        { $set: update },
        { new: true },
      ).lean();

      if (!task) {
        return res
          .status(404)
          .json({ success: false, error: 'Task not found or already in progress' });
      }
      return res.json({ success: true, data: task });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to assign human task', { taskId, error: msg });
      return res.status(500).json({ success: false, error: 'Failed to assign task' });
    }
  });

  // POST /:taskId/claim — Claim for live handling
  router.post('/:taskId/claim', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'human_task:claim'))) return;

    const tenantId = (req as any).tenantContext?.tenantId;
    const userId = (req as any).tenantContext?.userId;
    const role = (req as any).tenantContext?.role;
    const roleLower = typeof role === 'string' ? role.toLowerCase() : '';
    const isAdmin = roleLower === 'admin' || roleLower === 'owner';
    const { projectId, taskId } = req.params;

    if (!tenantId || !projectId || !userId) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    try {
      // Claim is allowed when the caller is in the assignee list (scoped pool
      // membership), the task is an open pool (no assignees configured), or the
      // caller is an admin/owner. The atomic `findOneAndUpdate` enforces this in
      // the query so two racers cannot both acquire the claim.
      const baseFilter: Record<string, unknown> = {
        _id: taskId,
        tenantId,
        projectId,
        status: { $in: ['pending', 'assigned'] },
      };
      const authFilter: Record<string, unknown> = isAdmin
        ? baseFilter
        : {
            ...baseFilter,
            $or: [
              { assignedTo: userId },
              { assignedTo: { $exists: false } },
              { assignedTo: null },
              { assignedTo: { $size: 0 } },
            ],
          };

      const task = await HumanTask.findOneAndUpdate(
        authFilter,
        {
          $set: {
            status: 'in_progress' as HumanTaskStatus,
            claimedBy: userId,
            claimedAt: new Date(),
          },
        },
        { new: true },
      ).lean();

      if (!task) {
        return res.status(404).json({ success: false, error: 'Task not found or already claimed' });
      }

      // Fire-and-forget: update execution step input to reflect the claim
      // Non-critical — respond immediately, sync in background.
      // Workflow executions store step state in `context.steps[stepKey]` keyed
      // by step name (with `stepId` injected as the UUID). The legacy
      // `nodeExecutions[]` array no longer exists on the schema, so the update
      // must locate the step by scanning `context.steps` values for a matching
      // `stepId` and write to its dot-notation path.
      const source = task.source as { executionId?: string; stepId?: string } | undefined;
      if (source?.executionId && source?.stepId) {
        const stepIdToFind = source.stepId;
        const executionIdToUpdate = source.executionId;
        void (async () => {
          try {
            const exec = (await WorkflowExecution.findOne(
              { _id: executionIdToUpdate, tenantId, projectId },
              { 'context.steps': 1 },
            ).lean()) as { context?: { steps?: Record<string, { stepId?: string }> } } | null;
            const steps = exec?.context?.steps;
            if (!steps) return;
            const stepKey = Object.keys(steps).find((k) => steps[k]?.stepId === stepIdToFind);
            if (!stepKey) return;
            await WorkflowExecution.updateOne(
              { _id: executionIdToUpdate, tenantId, projectId },
              { $set: { [`context.steps.${stepKey}.input.assignTo`]: userId } },
            );
          } catch (updateErr: unknown) {
            log.warn('Failed to update execution step input on claim', {
              taskId,
              executionId: executionIdToUpdate,
              stepId: stepIdToFind,
              error: updateErr instanceof Error ? updateErr.message : String(updateErr),
            });
          }
        })();
      }

      return res.json({ success: true, data: task });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to claim human task', { taskId, error: msg });
      return res.status(500).json({ success: false, error: 'Failed to claim task' });
    }
  });

  // POST /:taskId/resolve — Submit response and resolve upstream
  router.post('/:taskId/resolve', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'human_task:resolve'))) return;

    const tenantId = (req as any).tenantContext?.tenantId;
    const respondedBy = (req as any).tenantContext?.userId;
    const { projectId, taskId } = req.params;

    if (!tenantId || !projectId || !respondedBy) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    const parsed = resolveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }
    const { fields, notes, decision } = parsed.data;

    try {
      // Load the task
      const task = (await HumanTask.findOne({
        _id: taskId,
        tenantId,
        projectId,
        status: { $in: ['pending', 'assigned', 'in_progress'] },
      }).lean()) as IHumanTask | null;

      if (!task) {
        return res
          .status(404)
          .json({ success: false, error: 'Task not found or already resolved' });
      }

      // Validate required fields
      const missingFields = (task.fields ?? [])
        .filter((f) => f.required && (fields == null || fields[f.name] == null))
        .map((f) => f.name);
      if (missingFields.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Missing required fields: ${missingFields.join(', ')}`,
        });
      }

      // Build the response record
      const respondedAt = new Date();
      const responseRecord = {
        respondedBy,
        respondedAt,
        fields: fields ?? {},
        notes,
        decision,
      };

      // Dispatch to upstream source FIRST (workflow engine / Restate).
      // If the upstream call fails, the task must NOT be marked completed —
      // otherwise the inbox shows "resolved" but the workflow stays stuck.
      const source = task.source;
      const workflowId =
        source.type === 'workflow_approval' || source.type === 'workflow_human_task'
          ? source.workflowId
          : undefined;
      const sourceCtx: WorkflowSourceContext = {
        tenantId: task.tenantId,
        projectId: task.projectId,
        workflowId,
        authHeader: req.headers.authorization,
      };

      try {
        if (source.type === 'workflow_approval' && deps.resolveApproval) {
          await deps.resolveApproval(
            source.executionId,
            source.stepId,
            {
              approved: decision === 'approved',
              decidedBy: respondedBy,
              reason: notes,
            },
            sourceCtx,
          );
        } else if (source.type === 'workflow_human_task' && deps.resolveHumanTask) {
          await deps.resolveHumanTask(
            source.executionId,
            source.stepId,
            {
              respondedBy,
              respondedAt: respondedAt.toISOString(),
              fields: fields ?? {},
              notes,
              decision,
            },
            sourceCtx,
          );
        } else if (source.type === 'agent_escalation' && deps.resolveEscalation) {
          await deps.resolveEscalation(
            source.sessionId,
            {
              respondedBy,
              message: notes ?? decision ?? 'Resolved via inbox',
            },
            sourceCtx,
          );
        }
      } catch (upstreamErr) {
        const msg = upstreamErr instanceof Error ? upstreamErr.message : String(upstreamErr);
        log.error('Failed to resolve upstream source — task NOT marked completed', {
          taskId,
          sourceType: source.type,
          error: msg,
        });
        return res.status(502).json({
          success: false,
          error: {
            code: 'UPSTREAM_DISPATCH_FAILED',
            message: 'Failed to resolve task with workflow engine. Please retry.',
          },
        });
      }

      // Upstream accepted — now mark the task completed in MongoDB.
      // Defense-in-depth: include `projectId` in the filter even though
      // the prior loadBy filter already confirmed (_id, tenantId, projectId).
      // CLAUDE.md Core Invariant #1: every project-scoped route query
      // MUST scope by `projectId`, so a future refactor that pulls this
      // update into a shared service can't silently become a cross-
      // project write vector.
      await HumanTask.findOneAndUpdate(
        { _id: taskId, tenantId, projectId },
        { $set: { status: 'completed' as HumanTaskStatus, response: responseRecord } },
      );

      return res.json({ success: true, data: { taskId, status: 'completed' } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to resolve human task', { taskId, error: msg });
      return res.status(500).json({ success: false, error: 'Failed to resolve task' });
    }
  });

  return router;
}
