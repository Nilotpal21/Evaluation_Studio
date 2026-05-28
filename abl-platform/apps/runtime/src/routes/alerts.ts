/**
 * Alerts API Routes
 *
 * Mounted at /api/projects/:projectId/alerts
 *
 * GET    /                    List alert rules
 * POST   /                    Create alert rule
 * PUT    /:alertId            Update alert rule
 * DELETE /:alertId            Delete alert rule
 * GET    /:alertId/history    Get alert fire history
 * POST   /:alertId/test       Test-fire an alert
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

const log = createLogger('alerts-route');

// ─── Lazy imports ───────────────────────────────────────────────────────────

async function getAlertRuleModel() {
  const { AlertRuleModel } = await import('@agent-platform/pipeline-engine');
  return AlertRuleModel;
}

async function getClickHouse() {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

// ─── Aggregation helpers ────────────────────────────────────────────────────

const AGGREGATION_FN: Record<string, string> = {
  avg: 'avg',
  sum: 'sum',
  count: 'count',
  min: 'min',
  max: 'max',
  p95: 'quantile(0.95)',
  p99: 'quantile(0.99)',
};

const CONDITION_OP: Record<string, string> = {
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
};

// ─── SQL injection prevention ──────────────────────────────────────────────

/**
 * Validate a ClickHouse identifier (table name, column name).
 * Only allows alphanumeric characters, underscores, and dots (for qualified names like db.table).
 * Mirrors the same pattern from pipeline-engine's alert-evaluator.service.ts.
 */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER_RE.test(value) && value.length <= 128;
}

// ─── Mass assignment prevention ────────────────────────────────────────────

/** Fields that may be updated via PUT /:alertId. All other fields are rejected. */
const UPDATABLE_FIELDS = [
  'name',
  'metric',
  'sourceTable',
  'aggregation',
  'windowMinutes',
  'condition',
  'threshold',
  'channels',
  'enabled',
  'cooldownMinutes',
] as const;

/**
 * Pick only allowed fields from the request body for alert rule updates.
 * Returns undefined values for fields not present, which are stripped by $set.
 */
function pickUpdatableFields(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (field in body) {
      result[field] = body[field];
    }
  }
  return result;
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/alerts',
  tags: ['Alerts'],
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
    summary: 'List alert rules',
    description: 'Returns all alert rules for the current project.',
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

      const Model = await getAlertRuleModel();
      const rules = await Model.find({ tenantId, projectId }).lean();

      res.json({ success: true, data: rules });
    } catch (error) {
      log.error('Failed to list alert rules', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to list alert rules' });
    }
  },
);

// ─── POST / ─────────────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/',
  {
    summary: 'Create an alert rule',
    description:
      'Creates a new alert rule that triggers notifications when an analytics metric breaches a threshold.',
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
        name,
        metric,
        sourceTable,
        aggregation,
        windowMinutes,
        condition,
        threshold,
        channels,
        enabled,
        cooldownMinutes,
      } = req.body;

      if (!name || typeof name !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'name is required and must be a string' },
        });
        return;
      }

      if (!metric || typeof metric !== 'string' || !isSafeIdentifier(metric)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message:
              'metric is required and must be a valid identifier (alphanumeric, underscores, dots only)',
          },
        });
        return;
      }

      if (!sourceTable || typeof sourceTable !== 'string' || !isSafeIdentifier(sourceTable)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message:
              'sourceTable is required and must be a valid identifier (alphanumeric, underscores, dots only)',
          },
        });
        return;
      }

      const validAggregations = ['avg', 'sum', 'count', 'min', 'max', 'p95', 'p99'];
      if (!aggregation || !validAggregations.includes(aggregation)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: `aggregation is required and must be one of: ${validAggregations.join(', ')}`,
          },
        });
        return;
      }

      if (typeof windowMinutes !== 'number' || windowMinutes < 1) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'windowMinutes is required and must be a number >= 1',
          },
        });
        return;
      }

      const validConditions = ['gt', 'lt', 'gte', 'lte'];
      if (!condition || !validConditions.includes(condition)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: `condition is required and must be one of: ${validConditions.join(', ')}`,
          },
        });
        return;
      }

      if (typeof threshold !== 'number') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'threshold is required and must be a number' },
        });
        return;
      }

      if (!Array.isArray(channels) || channels.length === 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'channels is required and must be a non-empty array',
          },
        });
        return;
      }

      const Model = await getAlertRuleModel();
      const rule = await Model.create({
        tenantId,
        projectId,
        name,
        metric,
        sourceTable,
        aggregation,
        windowMinutes,
        condition,
        threshold,
        channels,
        enabled: enabled ?? true,
        cooldownMinutes: cooldownMinutes ?? 60,
        createdBy: userId,
      });

      log.info('Alert rule created', { tenantId, projectId, name, ruleId: rule._id });
      res.json({ success: true, data: rule.toObject() });
    } catch (error) {
      log.error('Failed to create alert rule', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to create alert rule' });
    }
  },
);

// ─── PUT /:alertId ──────────────────────────────────────────────────────────

openapi.route(
  'put',
  '/:alertId',
  {
    summary: 'Update an alert rule',
    description: 'Updates an existing alert rule by ID.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, alertId } = req.params;

      const updateFields = pickUpdatableFields(req.body);

      if (Object.keys(updateFields).length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'No valid fields provided for update' },
        });
        return;
      }

      // Validate metric and sourceTable if they are being updated
      if (
        'metric' in updateFields &&
        (typeof updateFields.metric !== 'string' || !isSafeIdentifier(updateFields.metric))
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'metric must be a valid identifier (alphanumeric, underscores, dots only)',
          },
        });
        return;
      }

      if (
        'sourceTable' in updateFields &&
        (typeof updateFields.sourceTable !== 'string' ||
          !isSafeIdentifier(updateFields.sourceTable))
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message:
              'sourceTable must be a valid identifier (alphanumeric, underscores, dots only)',
          },
        });
        return;
      }

      const Model = await getAlertRuleModel();
      const updated = await Model.findOneAndUpdate(
        { _id: alertId, tenantId, projectId },
        { $set: updateFields },
        { new: true },
      );

      if (!updated) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Alert rule not found' },
        });
        return;
      }

      log.info('Alert rule updated', { tenantId, projectId, alertId });
      res.json({ success: true, data: updated.toObject() });
    } catch (error) {
      log.error('Failed to update alert rule', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        alertId: req.params.alertId,
      });
      res.status(500).json({ success: false, error: 'Failed to update alert rule' });
    }
  },
);

// ─── DELETE /:alertId ───────────────────────────────────────────────────────

openapi.route(
  'delete',
  '/:alertId',
  {
    summary: 'Delete an alert rule',
    description: 'Permanently deletes an alert rule by ID.',
    response: z.object({
      success: z.boolean(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, alertId } = req.params;

      const Model = await getAlertRuleModel();
      const deleted = await Model.findOneAndDelete({ _id: alertId, tenantId, projectId });

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Alert rule not found' },
        });
        return;
      }

      log.info('Alert rule deleted', { tenantId, projectId, alertId });
      res.json({ success: true });
    } catch (error) {
      log.error('Failed to delete alert rule', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        alertId: req.params.alertId,
      });
      res.status(500).json({ success: false, error: 'Failed to delete alert rule' });
    }
  },
);

// ─── GET /:alertId/history ──────────────────────────────────────────────────

openapi.route(
  'get',
  '/:alertId/history',
  {
    summary: 'Get alert fire history',
    description:
      'Returns the evaluation and fire history for a specific alert rule, including its current status.',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        alertId: z.string(),
        name: z.string(),
        status: z.string(),
        lastEvaluatedAt: z.string().nullable(),
        lastFiredAt: z.string().nullable(),
        enabled: z.boolean(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, alertId } = req.params;

      const Model = await getAlertRuleModel();
      const rule = (await Model.findOne({ _id: alertId, tenantId, projectId }).lean()) as any;

      if (!rule) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Alert rule not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          alertId: String(rule._id),
          name: rule.name,
          status: rule.status,
          lastEvaluatedAt: rule.lastEvaluatedAt ? rule.lastEvaluatedAt.toISOString() : null,
          lastFiredAt: rule.lastFiredAt ? rule.lastFiredAt.toISOString() : null,
          enabled: rule.enabled,
        },
      });
    } catch (error) {
      log.error('Failed to get alert history', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        alertId: req.params.alertId,
      });
      res.status(500).json({ success: false, error: 'Failed to get alert history' });
    }
  },
);

// ─── POST /:alertId/test ────────────────────────────────────────────────────

openapi.route(
  'post',
  '/:alertId/test',
  {
    summary: 'Test-fire an alert',
    description:
      'Evaluates the alert rule against the current metric value in ClickHouse and returns whether it would fire.',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        currentValue: z.number().nullable(),
        threshold: z.number(),
        condition: z.string(),
        wouldFire: z.boolean(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, alertId } = req.params;

      const Model = await getAlertRuleModel();
      const rule = (await Model.findOne({ _id: alertId, tenantId, projectId }).lean()) as any;

      if (!rule) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Alert rule not found' },
        });
        return;
      }

      // Validate identifiers before interpolating into SQL to prevent injection
      if (!isSafeIdentifier(rule.metric)) {
        log.warn('Alert rule has unsafe metric identifier', {
          alertId,
          metric: rule.metric,
        });
        res.status(400).json({
          success: false,
          error: {
            code: 'UNSAFE_IDENTIFIER',
            message: 'Alert rule metric contains invalid characters',
          },
        });
        return;
      }

      if (!isSafeIdentifier(rule.sourceTable)) {
        log.warn('Alert rule has unsafe sourceTable identifier', {
          alertId,
          sourceTable: rule.sourceTable,
        });
        res.status(400).json({
          success: false,
          error: {
            code: 'UNSAFE_IDENTIFIER',
            message: 'Alert rule sourceTable contains invalid characters',
          },
        });
        return;
      }

      const aggFn = AGGREGATION_FN[rule.aggregation];
      if (!aggFn) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_AGGREGATION',
            message: 'Unsupported aggregation function',
          },
        });
        return;
      }

      const ch = await getClickHouse();

      const query = `
        SELECT ${aggFn}(${rule.metric}) AS metric_value
        FROM ${rule.sourceTable}
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND event_time >= now() - INTERVAL {windowMinutes:UInt32} MINUTE
      `;

      const result = await ch.query({
        query,
        query_params: {
          tenantId,
          projectId,
          windowMinutes: String(rule.windowMinutes),
        },
      });

      const rows = await result.json<{ metric_value: number | null }>();
      const rawRows = rows as unknown as { data: Array<{ metric_value: number | null }> };
      const currentValue = rawRows.data?.[0]?.metric_value ?? null;

      let wouldFire = false;
      if (currentValue !== null) {
        const op = CONDITION_OP[rule.condition];
        switch (op) {
          case '>':
            wouldFire = currentValue > rule.threshold;
            break;
          case '<':
            wouldFire = currentValue < rule.threshold;
            break;
          case '>=':
            wouldFire = currentValue >= rule.threshold;
            break;
          case '<=':
            wouldFire = currentValue <= rule.threshold;
            break;
        }
      }

      res.json({
        success: true,
        data: {
          currentValue,
          threshold: rule.threshold,
          condition: rule.condition,
          wouldFire,
        },
      });
    } catch (error) {
      log.error('Failed to test alert rule', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        alertId: req.params.alertId,
      });
      res.status(500).json({ success: false, error: 'Failed to test alert rule' });
    }
  },
);

export default openapi.router;
