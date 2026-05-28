/**
 * ROI API Routes
 *
 * Mounted at /api/projects/:projectId/roi
 *
 * GET    /config     Get cost config
 * PUT    /config     Create or update cost config
 * GET    /summary    Get ROI summary
 * GET    /budget     Get budget status
 * POST   /simulate   Simulate containment change
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

const log = createLogger('roi-route');

// ─── Lazy imports ───────────────────────────────────────────────────────────

async function getCostConfigModel() {
  const { ProjectCostConfigModel } = await import('@agent-platform/pipeline-engine');
  return ProjectCostConfigModel;
}

async function getROICalculator() {
  const { ROICalculator } = await import('@agent-platform/pipeline-engine');
  return new ROICalculator();
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/roi',
  tags: ['ROI'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// ─── GET /config ────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/config',
  {
    summary: 'Get cost config',
    description: 'Returns the cost configuration for the current project, or null if not set.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;

      const Model = await getCostConfigModel();
      const config = await Model.findOne({ tenantId, projectId }).lean();

      res.json({ success: true, data: config ?? null });
    } catch (error) {
      log.error('Failed to get cost config', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to get cost config' });
    }
  },
);

// ─── PUT /config ────────────────────────────────────────────────────────────

openapi.route(
  'put',
  '/config',
  {
    summary: 'Create or update cost config',
    description: 'Upserts the cost configuration for the current project.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const userId = req.tenantContext!.userId ?? 'unknown';

      const {
        costPerHumanInteraction,
        costPerAIInteraction,
        fteCapacityPerDay,
        fteCostPerYear,
        monthlyBudget,
        containmentRate,
        totalConversationsPerMonth,
      } = req.body;

      const Model = await getCostConfigModel();
      const saved = await Model.findOneAndUpdate(
        { tenantId, projectId },
        {
          $set: {
            costPerHumanInteraction,
            costPerAIInteraction,
            fteCapacityPerDay,
            fteCostPerYear,
            monthlyBudget,
            containmentRate,
            totalConversationsPerMonth,
            createdBy: userId,
          },
        },
        { new: true, upsert: true },
      );

      log.info('Cost config saved', { tenantId, projectId });
      res.json({ success: true, data: saved!.toObject() });
    } catch (error) {
      log.error('Failed to save cost config', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to save cost config' });
    }
  },
);

// ─── GET /summary ───────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/summary',
  {
    summary: 'Get ROI summary',
    description:
      'Computes and returns the full ROI summary including savings, FTE equivalent, and budget status.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;

      const Model = await getCostConfigModel();
      const config = await Model.findOne({ tenantId, projectId }).lean();

      if (!config) {
        res.json({ success: true, data: null });
        return;
      }

      const calculator = await getROICalculator();
      const summary = calculator.computeSummary(config as any);

      res.json({ success: true, data: summary });
    } catch (error) {
      log.error('Failed to compute ROI summary', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to compute ROI summary' });
    }
  },
);

// ─── GET /budget ────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/budget',
  {
    summary: 'Get budget status',
    description: 'Returns the current budget status and remaining amount.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;

      const Model = await getCostConfigModel();
      const config = await Model.findOne({ tenantId, projectId }).lean();

      if (!config) {
        res.json({ success: true, data: null });
        return;
      }

      const calculator = await getROICalculator();
      const budget = calculator.computeBudgetStatus(config as any);

      res.json({ success: true, data: budget });
    } catch (error) {
      log.error('Failed to compute budget status', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to compute budget status' });
    }
  },
);

// ─── POST /simulate ─────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/simulate',
  {
    summary: 'Simulate containment change',
    description:
      'Simulates the impact of changing the containment rate on savings and FTE equivalents.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;

      const { containmentRate } = req.body;

      if (typeof containmentRate !== 'number' || containmentRate < 0 || containmentRate > 1) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'containmentRate is required and must be a number between 0 and 1',
          },
        });
        return;
      }

      const Model = await getCostConfigModel();
      const config = await Model.findOne({ tenantId, projectId }).lean();

      if (!config) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Cost config not found' },
        });
        return;
      }

      const calculator = await getROICalculator();
      const result = calculator.simulateContainmentChange(config as any, containmentRate);

      res.json({ success: true, data: result });
    } catch (error) {
      log.error('Failed to simulate containment change', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to simulate containment change' });
    }
  },
);

export default openapi.router;
