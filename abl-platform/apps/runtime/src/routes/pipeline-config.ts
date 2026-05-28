/**
 * Pipeline Configuration API Routes
 *
 * Mounted at /api/projects/:projectId/pipeline-config
 *
 * GET    /                         List all pipeline configs
 * GET    /:pipelineType            Get effective config (project > tenant fallback)
 * PUT    /:pipelineType            Create or update pipeline config
 * GET    /:pipelineType/history    Get config change history
 * PATCH  /:pipelineType/toggle     Enable or disable a pipeline (starts/stops PipelineScheduler
 *                                  for schedule-triggered builtin types)
 *
 * Pipeline Management Routes (pipelineManagementRouter)
 * Mounted at /api/projects/:projectId/pipelines
 *
 * POST   /:pipelineId/activate     Activate a user-created pipeline + start scheduler if needed
 * POST   /:pipelineId/deactivate   Deactivate a pipeline + stop scheduler if needed
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { Router } from 'express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { getRedisClient } from '../services/redis/redis-client.js';

const log = createLogger('pipeline-config-route');

// ─── Restate ingress helper ──────────────────────────────────────────────────

function getRestateIngressUrl(): string {
  return process.env.RESTATE_INGRESS_URL ?? 'http://localhost:8091';
}

async function startPipelineScheduler(
  pipelineId: string,
  tenantId: string,
  projectId: string,
  schedule: string,
  triggerId: string,
): Promise<void> {
  const key = encodeURIComponent(`${pipelineId}::${tenantId}::${projectId}`);
  const url = `${getRestateIngressUrl()}/PipelineScheduler/${key}/start/send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId, tenantId, projectId, schedule, triggerId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Restate returned ${res.status}: ${body}`);
  }
}

async function stopPipelineScheduler(
  pipelineId: string,
  tenantId: string,
  projectId: string,
): Promise<void> {
  const key = encodeURIComponent(`${pipelineId}::${tenantId}::${projectId}`);
  const url = `${getRestateIngressUrl()}/PipelineScheduler/${key}/stop/send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Restate returned ${res.status}: ${body}`);
  }
}

// Pipeline types that use a schedule trigger — only these get scheduler management.
const SCHEDULE_TRIGGERED_TYPES = new Set(['drift_detection', 'anomaly_detection']);

// Lazy import to avoid circular dependencies at startup
async function getConfigService() {
  const { PipelineConfigService } = await import('@agent-platform/pipeline-engine');
  return new PipelineConfigService();
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/pipeline-config',
  tags: ['Pipeline Config'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_PIPELINE_TYPES = new Set([
  'sentiment_analysis',
  'intent_classification',
  'quality_evaluation',
  'anomaly_detection',
  'nl_to_sql',
  'knowledge_gap',
  'hallucination_detection',
  'embedding_drift',
  'predictive_ml',
  'simulation',
  'guardrail_analysis',
  'context_preservation',
  'friction_detection',
  'drift_detection',
]);

function validatePipelineType(pipelineType: string): boolean {
  return VALID_PIPELINE_TYPES.has(pipelineType);
}

// ─── GET / ──────────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/',
  {
    summary: 'List all pipeline configs',
    description:
      'Returns a summary of all builtin pipeline types with their resolved config status for this project',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const svc = await getConfigService();
      const configs = await svc.listAllConfigs(tenantId, projectId);

      res.json({
        success: true,
        data: configs,
      });
    } catch (error) {
      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;
      log.error('Failed to list pipeline configs', {
        tenantId,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to list pipeline configs' });
    }
  },
);

// ─── GET /:pipelineType ─────────────────────────────────────────────────────

openapi.route(
  'get',
  '/:pipelineType',
  {
    summary: 'Get effective pipeline config',
    description:
      'Returns the effective config for a pipeline, resolving project > tenant > null fallback',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({ success: false, error: `Invalid pipeline type: ${pipelineType}` });
        return;
      }

      const svc = await getConfigService();
      const config = await svc.resolveConfig(tenantId, pipelineType as any, projectId);

      if (!config) {
        res.json({
          success: true,
          data: null,
        });
        return;
      }

      res.json({
        success: true,
        data: {
          pipelineType: config.pipelineType,
          version: config.version,
          enabled: config.enabled,
          config: config.config,
          projectId: config.projectId,
          lastProcessedAt: config.lastProcessedAt,
          backfillStatus: config.backfillStatus,
          activeTriggers: config.activeTriggers,
          triggerConfigs: config.triggerConfigs,
        },
      });
    } catch (error) {
      log.error('Failed to get pipeline config', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
      });
      res.status(500).json({ success: false, error: 'Failed to get pipeline config' });
    }
  },
);

// ─── PUT /:pipelineType ─────────────────────────────────────────────────────

openapi.route(
  'put',
  '/:pipelineType',
  {
    summary: 'Create or update pipeline config',
    description: 'Saves pipeline configuration for this project. Auto-increments version.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId ?? 'unknown';

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({ success: false, error: `Invalid pipeline type: ${pipelineType}` });
        return;
      }

      const configBody = req.body?.config;
      if (!configBody || typeof configBody !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Request body must include a "config" object',
        });
        return;
      }

      // Extract optional multi-trigger fields
      const activeTriggers = req.body?.activeTriggers as string[] | undefined;
      const triggerConfigs = req.body?.triggerConfigs as
        | Record<string, { samplingRate?: number; stepOverrides?: Record<string, unknown> }>
        | undefined;

      // Validate config against Zod schema at API boundary
      let validatedConfig: Record<string, unknown>;
      try {
        const { parseAndValidateConfig } = await import('@agent-platform/pipeline-engine');
        validatedConfig = parseAndValidateConfig(pipelineType, configBody);
      } catch (validationError: unknown) {
        // Zod errors have an `issues` array
        if (validationError && typeof validationError === 'object' && 'issues' in validationError) {
          res.status(400).json({
            success: false,
            error: 'Config validation failed',
            issues: (validationError as { issues: unknown[] }).issues,
          });
          return;
        }
        throw validationError;
      }

      // Validate activeTriggers against definition if provided
      if (activeTriggers && activeTriggers.length > 0) {
        try {
          const { PipelineDefinitionModel } =
            await import('@agent-platform/pipeline-engine/schemas');
          const { validateActiveTriggers } = await import('@agent-platform/pipeline-engine');
          const definition = (await PipelineDefinitionModel.findOne({
            pipelineType,
            status: 'active',
          }).lean()) as any;
          if (definition?.supportedTriggers) {
            const triggerErrors = validateActiveTriggers(activeTriggers, definition as any);
            if (triggerErrors.length > 0) {
              res.status(400).json({
                success: false,
                error: 'Invalid activeTriggers',
                issues: triggerErrors,
              });
              return;
            }
          }
        } catch {
          // Skip trigger validation if definition not found
        }
      }

      const svc = await getConfigService();
      const saved = await svc.saveConfig(
        tenantId,
        pipelineType as any,
        validatedConfig,
        userId,
        projectId,
        {
          activeTriggers,
          triggerConfigs: triggerConfigs as Record<
            string,
            {
              samplingRate?: number;
              stepOverrides?: Record<string, Record<string, unknown>>;
            }
          >,
        },
      );

      res.json({
        success: true,
        data: {
          pipelineType: saved.pipelineType,
          version: saved.version,
          enabled: saved.enabled,
          config: saved.config,
          activeTriggers: saved.activeTriggers,
          triggerConfigs: saved.triggerConfigs,
        },
      });
    } catch (error) {
      log.error('Failed to save pipeline config', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
      });
      res.status(500).json({ success: false, error: 'Failed to save pipeline config' });
    }
  },
);

// ─── GET /:pipelineType/history ─────────────────────────────────────────────

openapi.route(
  'get',
  '/:pipelineType/history',
  {
    summary: 'Get pipeline config change history',
    description: 'Returns the version history with diffs for a pipeline config',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        history: z.array(z.record(z.unknown())),
        currentVersion: z.number(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({ success: false, error: `Invalid pipeline type: ${pipelineType}` });
        return;
      }

      const svc = await getConfigService();
      const config = await svc.resolveConfig(tenantId, pipelineType as any, projectId);

      if (!config) {
        res.json({
          success: true,
          data: { history: [], currentVersion: 0 },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          history: config.configHistory ?? [],
          currentVersion: config.version,
        },
      });
    } catch (error) {
      log.error('Failed to get pipeline config history', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
      });
      res.status(500).json({ success: false, error: 'Failed to get config history' });
    }
  },
);

// ─── PATCH /:pipelineType/toggle ────────────────────────────────────────────

openapi.route(
  'patch',
  '/:pipelineType/toggle',
  {
    summary: 'Enable or disable a pipeline',
    description: 'Toggles pipeline enabled state for this project',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        enabled: z.boolean(),
        pipelineType: z.string(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const { enabled } = req.body;

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({ success: false, error: `Invalid pipeline type: ${pipelineType}` });
        return;
      }

      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          success: false,
          error: 'Request body must include "enabled" as a boolean',
        });
        return;
      }

      const { PipelineConfigModel } = await import('@agent-platform/pipeline-engine/schemas');
      const userId = req.tenantContext!.userId ?? 'unknown';

      // Seed Zod defaults only when creating a new config document for the first time.
      // Existing configs are not touched — toggle only changes enabled state.
      const existing = await PipelineConfigModel.findOne({ tenantId, pipelineType, projectId });

      let defaultConfig: Record<string, unknown> = {};
      if (!existing) {
        try {
          const { parseAndValidateConfig } = await import('@agent-platform/pipeline-engine');
          defaultConfig = parseAndValidateConfig(pipelineType, {});
        } catch {
          // Non-standard pipeline type — leave config empty.
        }
      }

      const result = await PipelineConfigModel.findOneAndUpdate(
        { tenantId, pipelineType, projectId },
        {
          $set: {
            enabled,
            updatedBy: userId,
            ...(existing ? {} : { config: defaultConfig }),
          },
          $setOnInsert: { createdBy: userId, version: 1 },
        },
        { new: true, upsert: true },
      );

      // Start or stop the PipelineScheduler for schedule-triggered builtin pipeline types.
      // Restate's durable sleep means the scheduler survives pod restarts automatically —
      // we only need to start it once (on first enable) and stop it on disable.
      if (SCHEDULE_TRIGGERED_TYPES.has(pipelineType)) {
        const { BUILTIN_DEFINITIONS } = await import('@agent-platform/pipeline-engine');
        const def = BUILTIN_DEFINITIONS.find(
          ({ definition }: { id: string; definition: Record<string, unknown> }) =>
            (definition.pipelineType as string) === pipelineType,
        );
        const scheduleTrigger = (
          (def?.definition.supportedTriggers as Array<{
            id: string;
            type: string;
            schedule?: string;
          }>) ?? []
        ).find((t) => t.type === 'schedule' && t.schedule);

        if (def && scheduleTrigger?.schedule) {
          try {
            if (enabled) {
              await startPipelineScheduler(
                def.id,
                tenantId,
                projectId,
                scheduleTrigger.schedule,
                scheduleTrigger.id,
              );
              log.info('PipelineScheduler started', { pipelineType, tenantId, projectId });
            } else {
              await stopPipelineScheduler(def.id, tenantId, projectId);
              log.info('PipelineScheduler stopped', { pipelineType, tenantId, projectId });
            }
          } catch (schedErr) {
            // Non-fatal — config is already updated. Log and continue.
            log.warn('PipelineScheduler start/stop failed (non-fatal)', {
              pipelineType,
              tenantId,
              projectId,
              enabled,
              error: schedErr instanceof Error ? schedErr.message : String(schedErr),
            });
          }
        }
      }

      log.info('Pipeline toggled', { tenantId, pipelineType, projectId, enabled });
      res.json({
        success: true,
        data: { enabled: result.enabled, pipelineType },
      });
    } catch (error) {
      log.error('Failed to toggle pipeline', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
      });
      res.status(500).json({ success: false, error: 'Failed to toggle pipeline' });
    }
  },
);

// ─── POST /:pipelineType/backfill ────────────────────────────────────────────

openapi.route(
  'post',
  '/:pipelineType/backfill',
  {
    summary: 'Trigger backfill for a pipeline',
    description:
      'Discovers unprocessed sessions and returns the count. The actual processing is triggered asynchronously.',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        unprocessedCount: z.number(),
        backfillStatus: z.string(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const lookbackDays = Number(req.body?.lookbackDays) || 30;

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({ success: false, error: `Invalid pipeline type: ${pipelineType}` });
        return;
      }

      const { BackfillService } = await import('@agent-platform/pipeline-engine');
      const backfillSvc = new BackfillService();

      // Check current status — don't start if already running
      const currentStatus = await backfillSvc.getBackfillStatus(
        tenantId,
        projectId,
        pipelineType as any,
      );
      if (currentStatus.status === 'running') {
        res.status(409).json({
          success: false,
          error: 'Backfill is already running for this pipeline',
        });
        return;
      }

      // Mark as running
      await backfillSvc.updateBackfillStatus(tenantId, projectId, pipelineType as any, 'running');

      // Find unprocessed sessions
      const sessions = await backfillSvc.findUnprocessedSessions({
        tenantId,
        projectId,
        pipelineType: pipelineType as any,
        lookbackDays,
      });

      log.info('Backfill initiated', {
        tenantId,
        projectId,
        pipelineType,
        unprocessedCount: sessions.length,
        lookbackDays,
      });

      // Mark status based on discovery
      const newStatus = sessions.length === 0 ? 'completed' : 'running';
      if (sessions.length === 0) {
        await backfillSvc.updateBackfillStatus(
          tenantId,
          projectId,
          pipelineType as any,
          'completed',
        );
      }

      res.json({
        success: true,
        data: {
          unprocessedCount: sessions.length,
          backfillStatus: newStatus,
        },
      });
    } catch (error) {
      log.error('Failed to initiate backfill', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
      });
      res.status(500).json({ success: false, error: 'Failed to initiate backfill' });
    }
  },
);

// ─── GET /:pipelineType/backfill/status ─────────────────────────────────────

openapi.route(
  'get',
  '/:pipelineType/backfill/status',
  {
    summary: 'Get backfill status for a pipeline',
    description: 'Returns current backfill status and unprocessed session count',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        status: z.string(),
        lastBackfillAt: z.string().nullable(),
        unprocessedCount: z.number(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({ success: false, error: `Invalid pipeline type: ${pipelineType}` });
        return;
      }

      const { BackfillService } = await import('@agent-platform/pipeline-engine');
      const backfillSvc = new BackfillService();
      const status = await backfillSvc.getBackfillStatus(tenantId, projectId, pipelineType as any);

      res.json({
        success: true,
        data: {
          status: status.status,
          lastBackfillAt: status.lastBackfillAt?.toISOString() ?? null,
          unprocessedCount: status.unprocessedCount,
        },
      });
    } catch (error) {
      log.error('Failed to get backfill status', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
      });
      res.status(500).json({ success: false, error: 'Failed to get backfill status' });
    }
  },
);

// ─── GET /:pipelineType/triggers ─────────────────────────────────────────────

openapi.route(
  'get',
  '/:pipelineType/triggers',
  {
    summary: 'Get trigger states for a pipeline',
    description:
      'Returns all supported triggers with their active state and sampling rates for this project',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        triggers: z.array(z.record(z.unknown())),
        defaultTriggerIds: z.array(z.string()),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({ success: false, error: `Invalid pipeline type: ${pipelineType}` });
        return;
      }

      const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
      const { resolveActiveTriggers, resolveSamplingRate } =
        await import('@agent-platform/pipeline-engine');

      const definition = (await PipelineDefinitionModel.findOne({
        pipelineType,
        status: 'active',
      }).lean()) as any;

      if (!definition?.supportedTriggers) {
        res.json({
          success: true,
          data: { triggers: [], defaultTriggerIds: [] },
        });
        return;
      }

      const svc = await getConfigService();
      const config = await svc.resolveConfig(tenantId, pipelineType as any, projectId);
      const activeTriggerIds = resolveActiveTriggers(config, definition as any);

      // .lean() returns plain objects, so strategies is a plain object (not a Map)
      const strategiesObj = (definition.strategies as any as Record<string, any>) ?? {};
      const triggers = definition.supportedTriggers.map((t: any) => {
        const strategy = strategiesObj[t.strategy];
        return {
          ...t,
          executionMode: strategy?.executionMode ?? 'batch',
          active: activeTriggerIds.includes(t.id),
          samplingRate: resolveSamplingRate(t.id, config),
        };
      });

      res.json({
        success: true,
        data: {
          triggers,
          defaultTriggerIds: definition.defaultTriggerIds ?? [],
        },
      });
    } catch (error) {
      log.error('Failed to get pipeline triggers', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
      });
      res.status(500).json({ success: false, error: 'Failed to get pipeline triggers' });
    }
  },
);

// ─── GET /:pipelineType/schema ──────────────────────────────────────────────

openapi.route(
  'get',
  '/:pipelineType/schema',
  {
    summary: 'Get config schema for a pipeline',
    description: 'Returns the embedded config schema fields from the pipeline definition',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        fields: z.array(z.record(z.unknown())),
        sharedFields: z.array(z.record(z.unknown())),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { pipelineType } = req.params;

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({ success: false, error: `Invalid pipeline type: ${pipelineType}` });
        return;
      }

      const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
      const { SHARED_CONFIG_FIELDS, resolveMetricDynamicOptionsAll } =
        await import('@agent-platform/pipeline-engine');

      const definition = (await PipelineDefinitionModel.findOne({
        pipelineType,
        status: 'active',
      }).lean()) as any;

      // Resolve `metric-tables` / `metric-columns` dynamicOptions inline so
      // Studio doesn't need a separate fetch for the static allowlist.
      const fields = resolveMetricDynamicOptionsAll(definition?.configSchema?.fields ?? []);

      res.json({
        success: true,
        data: {
          fields,
          sharedFields: SHARED_CONFIG_FIELDS,
        },
      });
    } catch (error) {
      log.error('Failed to get pipeline schema', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
      });
      res.status(500).json({ success: false, error: 'Failed to get pipeline schema' });
    }
  },
);

export default openapi.router;

// ─── Pipeline Management Router ──────────────────────────────────────────────
// Mounted at /api/projects/:projectId/pipelines
// Handles activate/deactivate for user-created pipelines.

export const pipelineManagementRouter: RouterType = Router({ mergeParams: true });

pipelineManagementRouter.use(authMiddleware);
pipelineManagementRouter.use(requireProjectScope('projectId'));
pipelineManagementRouter.use(tenantRateLimit('request'));

pipelineManagementRouter.post('/:pipelineId/activate', async (req, res) => {
  const tenantId = req.tenantContext!.tenantId;
  const params = req.params as Record<string, string>;
  const { projectId, pipelineId } = params;

  try {
    if (!(await requireProjectPermission(req, res, 'project:write'))) return;

    const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
    const { validatePipeline } = await import('@agent-platform/pipeline-engine');

    const pipeline = await PipelineDefinitionModel.findOne({
      _id: pipelineId,
      tenantId,
      projectId,
    });

    if (!pipeline) {
      res.status(404).json({ success: false, error: 'Pipeline not found' });
      return;
    }

    const validationErrors = validatePipeline(
      pipeline.toObject() as unknown as Parameters<typeof validatePipeline>[0],
    );
    if (validationErrors.length > 0) {
      res.status(400).json({
        success: false,
        error: 'Pipeline has validation errors and cannot be activated',
        details: validationErrors,
      });
      return;
    }

    // Start scheduler for schedule-triggered user-created pipelines.
    // projectId comes directly from the pipeline definition — no lookup needed.
    const triggers = pipeline.supportedTriggers ?? [];
    for (const trigger of triggers) {
      if (trigger.type === 'schedule' && trigger.schedule) {
        try {
          await startPipelineScheduler(
            pipelineId,
            tenantId,
            pipeline.projectId!,
            trigger.schedule,
            trigger.id,
          );
        } catch (schedErr) {
          log.warn('PipelineScheduler start failed on activate (non-fatal)', {
            pipelineId,
            tenantId,
            projectId,
            error: schedErr instanceof Error ? schedErr.message : String(schedErr),
          });
        }
      }
    }

    const updated = await PipelineDefinitionModel.findOneAndUpdate(
      { _id: pipelineId, tenantId, projectId },
      { $set: { status: 'active' } },
      { new: true, lean: true },
    );

    const { invalidateDefinitionCache } = await import('@agent-platform/pipeline-engine');
    await invalidateDefinitionCache(getRedisClient() ?? undefined);

    log.info('Pipeline activated', { pipelineId, tenantId, projectId });
    res.json({ success: true, data: updated });
  } catch (error) {
    log.error('Failed to activate pipeline', {
      pipelineId,
      tenantId,
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to activate pipeline' });
  }
});

pipelineManagementRouter.post('/:pipelineId/deactivate', async (req, res) => {
  const tenantId = req.tenantContext!.tenantId;
  const params = req.params as Record<string, string>;
  const { projectId, pipelineId } = params;

  try {
    if (!(await requireProjectPermission(req, res, 'project:write'))) return;

    const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');

    const pipeline = await PipelineDefinitionModel.findOne({
      _id: pipelineId,
      tenantId,
      projectId,
    });

    if (!pipeline) {
      res.status(404).json({ success: false, error: 'Pipeline not found' });
      return;
    }

    // Stop scheduler for any schedule-triggered triggers.
    const triggers = pipeline.supportedTriggers ?? [];
    for (const trigger of triggers) {
      if (trigger.type === 'schedule') {
        try {
          await stopPipelineScheduler(pipelineId, tenantId, pipeline.projectId!);
        } catch (schedErr) {
          log.warn('PipelineScheduler stop failed on deactivate (non-fatal)', {
            pipelineId,
            tenantId,
            projectId,
            error: schedErr instanceof Error ? schedErr.message : String(schedErr),
          });
        }
      }
    }

    const updated = await PipelineDefinitionModel.findOneAndUpdate(
      { _id: pipelineId, tenantId, projectId },
      { $set: { status: 'draft' } },
      { new: true, lean: true },
    );

    const { invalidateDefinitionCache } = await import('@agent-platform/pipeline-engine');
    await invalidateDefinitionCache(getRedisClient() ?? undefined);

    log.info('Pipeline deactivated', { pipelineId, tenantId, projectId });
    res.json({ success: true, data: updated });
  } catch (error) {
    log.error('Failed to deactivate pipeline', {
      pipelineId,
      tenantId,
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to deactivate pipeline' });
  }
});
