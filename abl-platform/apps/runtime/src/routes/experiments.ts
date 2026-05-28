/**
 * Experiments API Routes
 *
 * Mounted at /api/projects/:projectId/experiments
 *
 * GET    /              List experiments
 * POST   /              Create experiment
 * GET    /:id           Get experiment by ID
 * DELETE /:id           Delete experiment (draft only)
 * PUT    /:id           Update experiment (draft only)
 * POST   /:id/start     Start experiment (draft -> running, validates versions)
 * POST   /:id/stop      Stop experiment (running -> stopped)
 * POST   /:id/complete  Complete experiment (running -> completed)
 * POST   /:id/results   Trigger on-demand results recompute
 * GET    /:id/results    Get experiment results from ClickHouse
 * GET    /:id/timeseries Get timeseries data for experiment
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('experiments-route');

// ─── Lazy imports ───────────────────────────────────────────────────────────

async function getExperimentModel() {
  const { ExperimentModel } = await import('@agent-platform/pipeline-engine');
  return ExperimentModel;
}

async function getClickHouse() {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

async function getAgentVersionModel() {
  const { AgentVersion } = await import('@agent-platform/database/models');
  return AgentVersion;
}

async function getProjectAgentModel() {
  const { ProjectAgent } = await import('@agent-platform/database/models');
  return ProjectAgent;
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const safetyRuleSchema = z.object({
  metric: z.string().min(1),
  operator: z.enum(['lt', 'gt', 'lte', 'gte']),
  threshold: z.number(),
  minSampleSize: z.number().int().min(1).default(100),
  comparison: z.enum(['absolute', 'relative_to_control']).default('absolute'),
});

const createExperimentSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    // version-mode fields
    controlVersion: z.string().min(1).optional(),
    experimentVersion: z.string().min(1).optional(),
    // deployment-mode fields
    assignmentMode: z.enum(['version', 'deployment']).optional(),
    controlDeploymentId: z.string().min(1).optional(),
    experimentDeploymentId: z.string().min(1).optional(),
    trafficSplit: z.number().min(0.01).max(0.99),
    successMetrics: z.array(z.string().min(1)).min(1),
    safetyRules: z.array(safetyRuleSchema).default([]),
    channels: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine(
    (data) => {
      const mode = data.assignmentMode ?? (data.controlDeploymentId ? 'deployment' : 'version');
      if (mode === 'deployment') {
        return !!data.controlDeploymentId && !!data.experimentDeploymentId;
      }
      return !!data.controlVersion && !!data.experimentVersion;
    },
    {
      message:
        'Version-mode experiments require controlVersion and experimentVersion; deployment-mode requires controlDeploymentId and experimentDeploymentId',
    },
  );

const updateExperimentSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    trafficSplit: z.number().min(0.01).max(0.99).optional(),
    successMetrics: z.array(z.string().min(1)).min(1).optional(),
    safetyRules: z.array(safetyRuleSchema).optional(),
    channels: z.array(z.string().min(1)).optional(),
  })
  .strict();

// ─── Version Validation Helper ──────────────────────────────────────────────

/**
 * Validate that a version string exists for at least one agent in the project.
 *
 * AgentVersion is keyed by (agentId, version) without tenantId.
 * We scope to tenant by first loading ProjectAgents scoped to tenantId + projectId,
 * then checking if any of their agentIds have a matching AgentVersion record.
 */
async function versionExistsForProject(
  versionString: string,
  tenantId: string,
  projectId: string,
): Promise<boolean> {
  const ProjectAgent = await getProjectAgentModel();
  const AgentVersion = await getAgentVersionModel();

  const agents = await ProjectAgent.find({ projectId, tenantId }, { _id: 1 }).lean();

  if (agents.length === 0) return false;

  const agentIds = agents.map((a: Record<string, unknown>) => a._id as string);

  const match = await AgentVersion.findOne({
    agentId: { $in: agentIds },
    version: versionString,
  }).lean();

  return match !== null;
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/experiments',
  tags: ['Experiments'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// ─── GET / ──────────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/',
  {
    summary: 'List experiments',
    description: 'Returns all experiments for the current project, optionally filtered by status.',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const rawStatus = req.query.status;
      const validStatuses = ['draft', 'running', 'stopped', 'completed'] as const;
      type ExperimentStatus = (typeof validStatuses)[number];
      const status =
        typeof rawStatus === 'string' && validStatuses.includes(rawStatus as ExperimentStatus)
          ? (rawStatus as ExperimentStatus)
          : undefined;

      const Model = await getExperimentModel();
      const filter: Record<string, unknown> = { tenantId, projectId };
      if (status) {
        filter.status = status;
      }

      const experiments = await Model.find(filter).sort({ createdAt: -1 }).lean();

      res.json({ success: true, data: experiments });
    } catch (error) {
      log.error('Failed to list experiments', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list experiments' },
      });
    }
  },
);

// ─── POST / ─────────────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/',
  {
    summary: 'Create an experiment',
    description:
      'Creates a new A/B experiment definition with control/experiment versions and traffic split.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'experiment:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const userId = req.tenantContext!.userId ?? 'unknown';

      const parsed = createExperimentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.errors[0].message,
          },
        });
        return;
      }

      const data = parsed.data;

      const Model = await getExperimentModel();
      const experiment = await Model.create({
        tenantId,
        projectId,
        name: data.name,
        description: data.description ?? undefined,
        controlVersion: data.controlVersion,
        experimentVersion: data.experimentVersion,
        assignmentMode:
          data.assignmentMode ?? (data.controlDeploymentId ? 'deployment' : 'version'),
        controlDeploymentId: data.controlDeploymentId,
        experimentDeploymentId: data.experimentDeploymentId,
        trafficSplit: data.trafficSplit,
        successMetrics: data.successMetrics,
        safetyRules: data.safetyRules,
        channels: data.channels,
        status: 'draft',
        createdBy: userId,
      });

      log.info('Experiment created', {
        tenantId,
        projectId,
        name: data.name,
        experimentId: experiment._id,
      });
      res.status(201).json({ success: true, data: experiment.toObject() });
    } catch (error) {
      log.error('Failed to create experiment', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create experiment' },
      });
    }
  },
);

// ─── GET /:id ───────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/:id',
  {
    summary: 'Get an experiment by ID',
    description:
      'Returns a single experiment by its ID, including results, safetyRules, channels, and breachDetail.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id } = req.params;

      const Model = await getExperimentModel();
      const experiment = await Model.findOne({ _id: id, tenantId, projectId }).lean();

      if (!experiment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Experiment not found' },
        });
        return;
      }

      res.json({ success: true, data: experiment });
    } catch (error) {
      log.error('Failed to get experiment', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get experiment' },
      });
    }
  },
);

// ─── PUT /:id ───────────────────────────────────────────────────────────────

openapi.route(
  'put',
  '/:id',
  {
    summary: 'Update an experiment',
    description:
      'Updates an existing experiment by ID. Only draft experiments can be updated. Status cannot be changed via this endpoint.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'experiment:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id } = req.params;

      const parsed = updateExperimentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.errors[0].message,
          },
        });
        return;
      }

      const Model = await getExperimentModel();

      // Status guard: only draft experiments can be updated
      const existing = await Model.findOne({ _id: id, tenantId, projectId }).lean();
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Experiment not found' },
        });
        return;
      }

      const existingStatus = (existing as Record<string, unknown>).status as string;
      if (existingStatus !== 'draft') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: 'Only draft experiments can be updated',
          },
        });
        return;
      }

      // Only update allowed fields — never allow status to be set via PUT
      const allowedUpdate: Record<string, unknown> = {};
      const data = parsed.data;
      if (data.name !== undefined) allowedUpdate.name = data.name;
      if (data.description !== undefined) allowedUpdate.description = data.description;
      if (data.trafficSplit !== undefined) allowedUpdate.trafficSplit = data.trafficSplit;
      if (data.successMetrics !== undefined) allowedUpdate.successMetrics = data.successMetrics;
      if (data.safetyRules !== undefined) allowedUpdate.safetyRules = data.safetyRules;
      if (data.channels !== undefined) allowedUpdate.channels = data.channels;

      const updated = await Model.findOneAndUpdate(
        { _id: id, tenantId, projectId, status: 'draft' },
        { $set: allowedUpdate },
        { new: true },
      );

      if (!updated) {
        // Race condition: status changed between check and update
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: 'Only draft experiments can be updated',
          },
        });
        return;
      }

      log.info('Experiment updated', { tenantId, projectId, experimentId: id });
      res.json({ success: true, data: updated.toObject() });
    } catch (error) {
      log.error('Failed to update experiment', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update experiment' },
      });
    }
  },
);

// ─── POST /:id/start ────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/:id/start',
  {
    summary: 'Start an experiment',
    description:
      'Transitions a draft experiment to running. Validates versions exist and no other experiment is running.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'experiment:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id } = req.params;

      const Model = await getExperimentModel();
      const experiment = await Model.findOne({ _id: id, tenantId, projectId }).lean();

      if (!experiment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Experiment not found' },
        });
        return;
      }

      const experimentData = experiment as Record<string, unknown>;

      // Status guard: only draft experiments can be started
      if (experimentData.status !== 'draft') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: 'Only draft experiments can be started',
          },
        });
        return;
      }

      // Uniqueness guard: no other running experiment for this project
      const runningExperiment = await Model.findOne({
        tenantId,
        projectId,
        status: 'running',
      }).lean();

      if (runningExperiment) {
        res.status(409).json({
          success: false,
          error: {
            code: 'CONFLICT',
            message: 'Another experiment is already running for this project',
          },
        });
        return;
      }

      const assignmentMode = (experimentData.assignmentMode as string) ?? 'version';

      if (assignmentMode === 'deployment') {
        // Deployment-mode: validate both deployment IDs exist in the project
        const { Deployment } = await import('@agent-platform/database/models');
        const controlDeploymentId = experimentData.controlDeploymentId as string | undefined;
        const experimentDeploymentId = experimentData.experimentDeploymentId as string | undefined;

        const [controlDep, experimentDep] = await Promise.all([
          Deployment.findOne({ _id: controlDeploymentId, projectId, tenantId }).lean(),
          Deployment.findOne({ _id: experimentDeploymentId, projectId, tenantId }).lean(),
        ]);

        if (!controlDep) {
          res.status(400).json({
            success: false,
            error: {
              code: 'DEPLOYMENT_NOT_FOUND',
              message: `Control deployment "${controlDeploymentId}" not found in this project`,
            },
          });
          return;
        }

        if (!experimentDep) {
          res.status(400).json({
            success: false,
            error: {
              code: 'DEPLOYMENT_NOT_FOUND',
              message: `Experiment deployment "${experimentDeploymentId}" not found in this project`,
            },
          });
          return;
        }
      } else {
        // Version-mode: validate both version strings exist
        const controlVersion = experimentData.controlVersion as string;
        const experimentVersion = experimentData.experimentVersion as string;

        const [controlExists, experimentExists] = await Promise.all([
          versionExistsForProject(controlVersion, tenantId, projectId),
          versionExistsForProject(experimentVersion, tenantId, projectId),
        ]);

        if (!controlExists) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VERSION_NOT_FOUND',
              message: `Control version "${controlVersion}" not found for any agent in this project`,
            },
          });
          return;
        }

        if (!experimentExists) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VERSION_NOT_FOUND',
              message: `Experiment version "${experimentVersion}" not found for any agent in this project`,
            },
          });
          return;
        }
      }

      // Atomic status transition
      const updated = await Model.findOneAndUpdate(
        { _id: id, tenantId, projectId, status: 'draft' },
        { $set: { status: 'running', startedAt: new Date() } },
        { new: true },
      );

      if (!updated) {
        // Race condition: status changed between check and update
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: 'Experiment is no longer in draft status',
          },
        });
        return;
      }

      // Invalidate experiment cache so the assignment service picks up the new running experiment
      try {
        const { getExperimentService } =
          await import('../services/experiments/experiment-service-singleton.js');
        const experimentService = getExperimentService();
        if (experimentService) {
          await experimentService.invalidateCache(tenantId, projectId);
        }
      } catch (cacheErr) {
        log.warn('Failed to invalidate experiment cache after start', {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
          projectId,
          experimentId: id,
        });
      }

      log.info('Experiment started', { tenantId, projectId, experimentId: id });
      res.json({ success: true, data: updated.toObject() });
    } catch (error) {
      // Handle MongoDB unique index violation for one_running_per_project
      if (error instanceof Error && error.message.includes('E11000')) {
        res.status(409).json({
          success: false,
          error: {
            code: 'CONFLICT',
            message: 'Another experiment is already running for this project',
          },
        });
        return;
      }

      log.error('Failed to start experiment', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to start experiment' },
      });
    }
  },
);

// ─── POST /:id/stop ─────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/:id/stop',
  {
    summary: 'Stop an experiment',
    description: 'Transitions a running experiment to stopped with reason "manual".',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'experiment:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id } = req.params;

      const Model = await getExperimentModel();

      // Status guard: only running experiments can be stopped
      const existing = await Model.findOne({ _id: id, tenantId, projectId }).lean();
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Experiment not found' },
        });
        return;
      }

      if ((existing as Record<string, unknown>).status !== 'running') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: 'Only running experiments can be stopped',
          },
        });
        return;
      }

      // Atomic status transition
      const updated = await Model.findOneAndUpdate(
        { _id: id, tenantId, projectId, status: 'running' },
        {
          $set: {
            status: 'stopped',
            stoppedAt: new Date(),
            stoppedReason: 'manual',
          },
        },
        { new: true },
      );

      if (!updated) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: 'Experiment is no longer in running status',
          },
        });
        return;
      }

      // Invalidate experiment cache
      try {
        const { getExperimentService } =
          await import('../services/experiments/experiment-service-singleton.js');
        const experimentService = getExperimentService();
        if (experimentService) {
          await experimentService.invalidateCache(tenantId, projectId);
        }
      } catch (cacheErr) {
        log.warn('Failed to invalidate experiment cache after stop', {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
          projectId,
          experimentId: id,
        });
      }

      log.info('Experiment stopped', { tenantId, projectId, experimentId: id });
      res.json({ success: true, data: updated.toObject() });
    } catch (error) {
      log.error('Failed to stop experiment', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to stop experiment' },
      });
    }
  },
);

// ─── POST /:id/complete ─────────────────────────────────────────────────────

openapi.route(
  'post',
  '/:id/complete',
  {
    summary: 'Complete an experiment',
    description: 'Transitions a running experiment to completed.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'experiment:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id } = req.params;

      const Model = await getExperimentModel();

      // Status guard: only running experiments can be completed
      const existing = await Model.findOne({ _id: id, tenantId, projectId }).lean();
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Experiment not found' },
        });
        return;
      }

      if ((existing as Record<string, unknown>).status !== 'running') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: 'Only running experiments can be completed',
          },
        });
        return;
      }

      // Atomic status transition
      const updated = await Model.findOneAndUpdate(
        { _id: id, tenantId, projectId, status: 'running' },
        {
          $set: {
            status: 'completed',
            stoppedAt: new Date(),
            stoppedReason: 'completed',
          },
        },
        { new: true },
      );

      if (!updated) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: 'Experiment is no longer in running status',
          },
        });
        return;
      }

      // Invalidate experiment cache
      try {
        const { getExperimentService } =
          await import('../services/experiments/experiment-service-singleton.js');
        const experimentService = getExperimentService();
        if (experimentService) {
          await experimentService.invalidateCache(tenantId, projectId);
        }
      } catch (cacheErr) {
        log.warn('Failed to invalidate experiment cache after complete', {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
          projectId,
          experimentId: id,
        });
      }

      log.info('Experiment completed', { tenantId, projectId, experimentId: id });
      res.json({ success: true, data: updated.toObject() });
    } catch (error) {
      log.error('Failed to complete experiment', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to complete experiment' },
      });
    }
  },
);

// ─── DELETE /:id ────────────────────────────────────────────────────────────

openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete an experiment',
    description: 'Deletes an experiment by ID. Only draft experiments can be deleted.',
    response: z.object({
      success: z.boolean(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'experiment:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id } = req.params;

      const Model = await getExperimentModel();
      const experiment = await Model.findOne({ _id: id, tenantId, projectId }).lean();

      if (!experiment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Experiment not found' },
        });
        return;
      }

      const status = (experiment as Record<string, unknown>).status;
      if (status !== 'draft') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: 'Only draft experiments can be deleted',
          },
        });
        return;
      }

      await Model.deleteOne({ _id: id, tenantId, projectId, status: 'draft' });

      // Defensive cache invalidation — drafts aren't cached but keeps invariant clean
      try {
        const { getExperimentService } =
          await import('../services/experiments/experiment-service-singleton.js');
        const experimentSvc = getExperimentService();
        if (experimentSvc) await experimentSvc.invalidateCache(tenantId, projectId);
      } catch (cacheErr) {
        log.warn('Failed to invalidate experiment cache after delete', {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
          projectId,
        });
      }

      log.info('Experiment deleted', { tenantId, projectId, experimentId: id });
      res.json({ success: true });
    } catch (error) {
      log.error('Failed to delete experiment', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete experiment' },
      });
    }
  },
);

// ─── POST /:id/results ─────────────────────────────────────────────────────

openapi.route(
  'post',
  '/:id/results',
  {
    summary: 'Trigger on-demand results recompute',
    description:
      'Triggers a synchronous recomputation of experiment results and returns the updated results.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'experiment:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id } = req.params;

      const Model = await getExperimentModel();
      const experiment = await Model.findOne({ _id: id, tenantId, projectId }).lean();

      if (!experiment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Experiment not found' },
        });
        return;
      }

      const experimentData = experiment as Record<string, unknown>;

      // Compute results via ClickHouse queries + statistical tests
      const { ExperimentResultsService } = await import('@agent-platform/pipeline-engine');
      const resultsService = new ExperimentResultsService();
      const results = await resultsService.computeExperimentResults(id, tenantId, {
        successMetrics: (experimentData.successMetrics as string[]) ?? [],
      });

      // Persist results on the experiment document
      await Model.findOneAndUpdate(
        { _id: id, tenantId, projectId },
        {
          $set: {
            results,
            lastResultsAt: new Date(),
          },
        },
      );

      log.info('Experiment results computed on-demand', {
        tenantId,
        projectId,
        experimentId: id,
        controlSampleSize: results.controlSampleSize,
        experimentSampleSize: results.experimentSampleSize,
      });

      res.json({
        success: true,
        data: { results },
      });
    } catch (error) {
      log.error('Failed to compute experiment results', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to compute experiment results' },
      });
    }
  },
);

// ─── GET /:id/results ───────────────────────────────────────────────────────

openapi.route(
  'get',
  '/:id/results',
  {
    summary: 'Get experiment results',
    description:
      'Returns assignment counts per group from ClickHouse for the specified experiment.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id } = req.params;

      const Model = await getExperimentModel();
      const experiment = await Model.findOne({ _id: id, tenantId, projectId }).lean();

      if (!experiment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Experiment not found' },
        });
        return;
      }

      const experimentData = experiment as Record<string, unknown>;
      const ch = await getClickHouse();

      const query = `
        SELECT
          experiment_group,
          count() AS session_count
        FROM abl_platform.experiment_assignments
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND experiment_id = {experimentId:String}
        GROUP BY experiment_group
        SETTINGS max_execution_time = 15
      `;

      const result = await ch.query({
        query,
        query_params: { tenantId, projectId, experimentId: String(experimentData._id) },
      });
      const { data: rows } = (await result.json()) as { data: Record<string, unknown>[] };

      res.json({
        success: true,
        data: {
          experimentId: String(experimentData._id),
          name: experimentData.name,
          status: experimentData.status,
          groups: rows,
        },
      });
    } catch (error) {
      log.error('Failed to get experiment results', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get experiment results' },
      });
    }
  },
);

// ─── GET /:id/timeseries ────────────────────────────────────────────────────

openapi.route(
  'get',
  '/:id/timeseries',
  {
    summary: 'Get experiment timeseries',
    description:
      'Returns daily assignment counts grouped by experiment group for charting purposes.',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id } = req.params;

      const Model = await getExperimentModel();
      const experiment = await Model.findOne({ _id: id, tenantId, projectId }).lean();

      if (!experiment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Experiment not found' },
        });
        return;
      }

      const experimentData = experiment as Record<string, unknown>;
      const ch = await getClickHouse();

      const query = `
        SELECT
          toDate(assigned_at) AS day,
          experiment_group,
          count() AS session_count
        FROM abl_platform.experiment_assignments
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND experiment_id = {experimentId:String}
        GROUP BY day, experiment_group
        ORDER BY day ASC
        SETTINGS max_execution_time = 15
      `;

      const result = await ch.query({
        query,
        query_params: { tenantId, projectId, experimentId: String(experimentData._id) },
      });
      const { data: rows } = (await result.json()) as { data: Record<string, unknown>[] };

      res.json({ success: true, data: rows });
    } catch (error) {
      log.error('Failed to get experiment timeseries', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get experiment timeseries' },
      });
    }
  },
);

export default openapi.router;
