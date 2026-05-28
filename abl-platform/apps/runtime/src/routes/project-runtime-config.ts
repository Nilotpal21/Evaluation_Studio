/**
 * Project Runtime Config Route
 *
 * Per-project runtime configuration for entity extraction, multi-intent
 * handling, inference settings, currency conversion, and lookup tables.
 * Mounted at /api/projects/:projectId/runtime-config
 *
 * GET    / — Load project runtime config (or platform defaults)
 * PUT    / — Upsert project runtime configuration
 * DELETE / — Reset project runtime configuration to platform defaults
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import {
  formatOperationTierOverrideError,
  normalizeOperationTierOverrides,
} from '@agent-platform/shared-kernel/model-routing';
import { resolveAdvancedNluEntitlement } from '@agent-platform/project-io/import';
import { writeAuditLog } from '../repos/auth-repo.js';
import { invalidateModelResolutionCaches } from '../services/llm/model-cache-invalidation.js';
import { bumpPIIConfigEpoch } from '../services/pii/pii-epoch.js';
import { invalidateProjectPIIConfig } from '../services/pii/project-pii-config.js';
import { validateProjectRuntimeConfigWrite } from '../services/config/project-runtime-config-write-validation.js';
import {
  extractionConfigSchema,
  modelSourceSchema,
  PROJECT_RUNTIME_CONFIG_DEFAULTS,
  runtimeConfigResponseSchema,
  runtimeConfigUpdateSchema,
} from '@agent-platform/shared/validation';

export { extractionConfigSchema } from '@agent-platform/shared/validation';

const log = createLogger('project-runtime-config');

// =============================================================================
// PLATFORM DEFAULTS
// =============================================================================

export const PLATFORM_DEFAULTS = PROJECT_RUNTIME_CONFIG_DEFAULTS;

// =============================================================================
// OPENAPI ROUTER
// =============================================================================

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/runtime-config',
  tags: ['Project Runtime Config'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (error, _req, res) => {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
        issues: error.issues,
      },
    });
  },
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// HELPERS
// =============================================================================

function normalizeFillerConfig(
  filler: unknown,
): z.infer<typeof runtimeConfigResponseSchema>['filler'] {
  const input = (filler as Record<string, unknown> | undefined) ?? {};
  return {
    ...PLATFORM_DEFAULTS.filler,
    ...input,
    modelSource:
      input.modelSource === 'default'
        ? 'system'
        : ((input.modelSource as z.infer<typeof modelSourceSchema> | undefined) ??
          PLATFORM_DEFAULTS.filler.modelSource),
  } as z.infer<typeof runtimeConfigResponseSchema>['filler'];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeConfigSection(
  defaults: Record<string, unknown>,
  existing: unknown,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...defaults,
    ...(isPlainRecord(existing) ? existing : {}),
  };

  for (const [key, value] of Object.entries(incoming)) {
    const current = merged[key];
    if (isPlainRecord(current) && isPlainRecord(value)) {
      merged[key] = mergeConfigSection({}, current, value);
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

function normalizeMergedExtraction(section: Record<string, unknown>): Record<string, unknown> {
  if (section.nlu_provider !== 'advanced') {
    delete section.advanced_sidecar_url;
    delete section.advanced_sidecar_timeout_ms;
    delete section.advanced_sidecar_circuit_breaker_threshold;
  }
  return section;
}

function normalizeMergedModelBinding(section: Record<string, unknown>): Record<string, unknown> {
  if (section.modelSource !== 'tenant') {
    delete section.tenantModelId;
    delete section.tenantModelRef;
  }
  if (section.modelSource !== 'project') {
    delete section.modelId;
  }
  return section;
}

function buildFinalRuntimeConfigCandidate(
  existingDoc: Record<string, unknown> | null,
  body: z.infer<typeof runtimeConfigUpdateSchema>,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = {};

  for (const key of [
    'operationTierOverrides',
    'extraction',
    'multi_intent',
    'inference',
    'conversion',
    'pii_redaction',
    'lookup_tables',
    'compaction',
    'pipeline',
    'filler',
  ]) {
    if (existingDoc?.[key] !== undefined) {
      candidate[key] = existingDoc[key];
    }
  }

  if (body.operationTierOverrides !== undefined) {
    candidate.operationTierOverrides = body.operationTierOverrides;
  }
  if (body.extraction !== undefined) {
    candidate.extraction = normalizeMergedExtraction(
      mergeConfigSection(PLATFORM_DEFAULTS.extraction, existingDoc?.extraction, body.extraction),
    );
  }
  if (body.multi_intent !== undefined) {
    candidate.multi_intent = mergeConfigSection(
      PLATFORM_DEFAULTS.multi_intent,
      existingDoc?.multi_intent,
      body.multi_intent,
    );
  }
  if (body.inference !== undefined) {
    candidate.inference = mergeConfigSection(
      PLATFORM_DEFAULTS.inference,
      existingDoc?.inference,
      body.inference,
    );
  }
  if (body.conversion !== undefined) {
    candidate.conversion = mergeConfigSection(
      PLATFORM_DEFAULTS.conversion,
      existingDoc?.conversion,
      body.conversion,
    );
  }
  if (body.pii_redaction !== undefined) {
    candidate.pii_redaction = mergeConfigSection(
      PLATFORM_DEFAULTS.pii_redaction,
      existingDoc?.pii_redaction,
      body.pii_redaction,
    );
  }
  if (body.lookup_tables !== undefined) {
    candidate.lookup_tables = body.lookup_tables;
  }
  if (body.compaction !== undefined) {
    candidate.compaction = mergeConfigSection({}, existingDoc?.compaction, body.compaction);
  }
  if (body.pipeline !== undefined) {
    candidate.pipeline = normalizeMergedModelBinding(
      mergeConfigSection({}, existingDoc?.pipeline, body.pipeline),
    );
  }
  if (body.filler !== undefined) {
    candidate.filler = normalizeMergedModelBinding(
      mergeConfigSection(PLATFORM_DEFAULTS.filler, existingDoc?.filler, body.filler),
    );
  }

  return candidate;
}

async function tenantCanUseAdvancedNlu(tenantId: string): Promise<boolean> {
  const entitlement = await resolveAdvancedNluEntitlement(tenantId);
  return entitlement.allowed;
}

/**
 * Normalize a Mongoose document (or null) into a plain config object,
 * falling back to platform defaults for missing sections.
 */
function normalizeConfig(
  projectId: string,
  doc: Record<string, unknown> | null,
): z.infer<typeof runtimeConfigResponseSchema> {
  if (!doc) {
    return {
      projectId,
      ...PLATFORM_DEFAULTS,
      lookup_tables: [],
    } as z.infer<typeof runtimeConfigResponseSchema>;
  }

  const overrides = doc.operationTierOverrides;
  const normalizedOverrides =
    overrides instanceof Map
      ? Object.fromEntries(overrides)
      : (overrides as Record<string, string>) || {};

  return {
    projectId,
    operationTierOverrides: normalizedOverrides,
    extraction: {
      ...PLATFORM_DEFAULTS.extraction,
      ...((doc.extraction as Record<string, unknown>) || {}),
    } as z.infer<typeof runtimeConfigResponseSchema>['extraction'],
    multi_intent: {
      ...PLATFORM_DEFAULTS.multi_intent,
      ...((doc.multi_intent as Record<string, unknown>) || {}),
    } as z.infer<typeof runtimeConfigResponseSchema>['multi_intent'],
    inference: {
      ...PLATFORM_DEFAULTS.inference,
      ...((doc.inference as Record<string, unknown>) || {}),
    } as z.infer<typeof runtimeConfigResponseSchema>['inference'],
    conversion: {
      ...PLATFORM_DEFAULTS.conversion,
      ...((doc.conversion as Record<string, unknown>) || {}),
    } as z.infer<typeof runtimeConfigResponseSchema>['conversion'],
    pii_redaction: {
      ...PLATFORM_DEFAULTS.pii_redaction,
      ...((doc.pii_redaction as Record<string, unknown>) || {}),
    } as z.infer<typeof runtimeConfigResponseSchema>['pii_redaction'],
    lookup_tables:
      (doc.lookup_tables as z.infer<typeof runtimeConfigResponseSchema>['lookup_tables']) || [],
    ...(doc.compaction
      ? {
          compaction: doc.compaction as z.infer<typeof runtimeConfigResponseSchema>['compaction'],
        }
      : {}),
    ...(doc.pipeline
      ? {
          pipeline: doc.pipeline as z.infer<typeof runtimeConfigResponseSchema>['pipeline'],
        }
      : {}),
    filler: normalizeFillerConfig(doc.filler),
  };
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET / — Fetch project runtime config (or platform defaults)
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Get project runtime config',
    description:
      'Fetch the runtime configuration for a project. Returns platform defaults if no config has been set.',
    response: z.object({
      success: z.literal(true),
      data: runtimeConfigResponseSchema,
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'runtime_config:read'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;

      const { ProjectRuntimeConfig } = await import('@agent-platform/database/models');
      const doc = await ProjectRuntimeConfig.findOne({ tenantId, projectId }).lean();

      res.json({
        success: true,
        data: normalizeConfig(projectId, doc as Record<string, unknown> | null),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to get project runtime config', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get project runtime config' },
      });
    }
  },
);

/**
 * PUT / — Upsert project runtime configuration
 */
openapi.route(
  'put',
  '/',
  {
    summary: 'Update project runtime config',
    description:
      'Set runtime configuration for a project. Partial updates are supported — only provided sections are updated. Omitted sections retain their current values (or platform defaults for new configs).',
    body: runtimeConfigUpdateSchema,
    response: z.object({
      success: z.literal(true),
      data: runtimeConfigResponseSchema,
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'runtime_config:write'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;
      const userId = req.tenantContext?.userId;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'TENANT_REQUIRED', message: 'Tenant access denied' },
        });
        return;
      }

      const body = (getValidatedRequestData(res)?.body ?? req.body) as z.infer<
        typeof runtimeConfigUpdateSchema
      >;

      const { ProjectLLMConfig, ProjectRuntimeConfig } =
        await import('@agent-platform/database/models');
      const existingDoc = (await ProjectRuntimeConfig.findOne({
        tenantId,
        projectId,
      }).lean()) as Record<string, unknown> | null;
      const finalCandidate = buildFinalRuntimeConfigCandidate(existingDoc, body);

      const writeValidation = await validateProjectRuntimeConfigWrite({
        tenantId,
        projectId,
        data: finalCandidate,
      });
      if (!writeValidation.valid) {
        res.status(writeValidation.status).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: writeValidation.message,
          },
        });
        return;
      }

      const normalizedFinalConfig = writeValidation.data;
      if (
        normalizedFinalConfig.extraction?.nlu_provider === 'advanced' &&
        !(await tenantCanUseAdvancedNlu(tenantId))
      ) {
        res.status(403).json({
          success: false,
          error: {
            code: 'PLAN_FEATURE_UNAVAILABLE',
            message: 'Advanced NLU provider requires an Enterprise plan',
          },
        });
        return;
      }

      const shouldInvalidateModelResolutionCaches =
        body.operationTierOverrides !== undefined ||
        body.pipeline !== undefined ||
        body.filler !== undefined;

      // Build $set payload — only include sections that were provided
      const setPayload: Record<string, unknown> = {
        projectId,
        tenantId,
      };

      let normalizedOperationTierOverrides: Record<string, string> | undefined;
      if (body.operationTierOverrides !== undefined) {
        const validation = normalizeOperationTierOverrides(
          normalizedFinalConfig.operationTierOverrides,
        );
        if (!validation.ok) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: formatOperationTierOverrideError(validation),
            },
          });
          return;
        }
        normalizedOperationTierOverrides = validation.overrides;
        setPayload.operationTierOverrides = normalizedOperationTierOverrides;
      }
      if (body.extraction !== undefined && normalizedFinalConfig.extraction !== undefined) {
        setPayload.extraction = normalizeMergedExtraction({ ...normalizedFinalConfig.extraction });
      }
      if (body.multi_intent !== undefined && normalizedFinalConfig.multi_intent !== undefined) {
        setPayload.multi_intent = normalizedFinalConfig.multi_intent;
      }
      if (body.inference !== undefined && normalizedFinalConfig.inference !== undefined) {
        setPayload.inference = normalizedFinalConfig.inference;
      }
      if (body.conversion !== undefined && normalizedFinalConfig.conversion !== undefined) {
        setPayload.conversion = normalizedFinalConfig.conversion;
      }
      if (body.pii_redaction !== undefined && normalizedFinalConfig.pii_redaction !== undefined) {
        setPayload.pii_redaction = normalizedFinalConfig.pii_redaction;
      }
      if (body.lookup_tables !== undefined) {
        setPayload.lookup_tables = normalizedFinalConfig.lookup_tables;
      }
      if (body.compaction !== undefined && normalizedFinalConfig.compaction !== undefined) {
        setPayload.compaction = normalizedFinalConfig.compaction;
      }
      if (body.pipeline !== undefined && normalizedFinalConfig.pipeline !== undefined) {
        setPayload.pipeline = normalizeMergedModelBinding({
          ...normalizedFinalConfig.pipeline,
        } as Record<string, unknown>);
      }
      if (body.filler !== undefined && normalizedFinalConfig.filler !== undefined) {
        setPayload.filler = normalizeMergedModelBinding({
          ...normalizedFinalConfig.filler,
        } as Record<string, unknown>);
      }

      const updated = await ProjectRuntimeConfig.findOneAndUpdate(
        { tenantId, projectId },
        { $set: setPayload },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean();

      if (body.operationTierOverrides !== undefined) {
        await ProjectLLMConfig.findOneAndUpdate(
          { tenantId, projectId },
          {
            $set: {
              tenantId,
              projectId,
              operationTierOverrides: normalizedOperationTierOverrides,
            },
          },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();
      }

      if (shouldInvalidateModelResolutionCaches) {
        invalidateModelResolutionCaches(tenantId);
      }

      if (body.pii_redaction !== undefined) {
        await bumpPIIConfigEpoch(tenantId, projectId);
        invalidateProjectPIIConfig(tenantId, projectId);
      }

      log.info('Project runtime config updated', { projectId, tenantId });
      writeAuditLog({
        action: 'project-runtime-config:update',
        tenantId,
        userId,
        metadata: { projectId, sections: Object.keys(body) },
      });

      res.json({
        success: true,
        data: normalizeConfig(projectId, updated as Record<string, unknown> | null),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to update project runtime config', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update project runtime config' },
      });
    }
  },
);

/**
 * DELETE / — Reset project runtime configuration to platform defaults
 */
openapi.route(
  'delete',
  '/',
  {
    summary: 'Reset project runtime config',
    description:
      'Delete the project runtime configuration document. Subsequent reads and executions fall back to platform defaults.',
    response: z.object({
      success: z.literal(true),
      data: runtimeConfigResponseSchema,
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'runtime_config:write'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;
      const userId = req.tenantContext?.userId;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'TENANT_REQUIRED', message: 'Tenant access denied' },
        });
        return;
      }

      const { ProjectLLMConfig, ProjectRuntimeConfig } =
        await import('@agent-platform/database/models');
      await Promise.all([
        ProjectRuntimeConfig.deleteOne({ tenantId, projectId }),
        ProjectLLMConfig.deleteOne({ tenantId, projectId }),
      ]);
      await bumpPIIConfigEpoch(tenantId, projectId);
      invalidateModelResolutionCaches(tenantId);

      log.info('Project runtime config reset', { projectId, tenantId });
      writeAuditLog({
        action: 'project-runtime-config:reset',
        tenantId,
        userId,
        metadata: { projectId },
      });

      res.json({
        success: true,
        data: normalizeConfig(projectId, null),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to reset project runtime config', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to reset project runtime config' },
      });
    }
  },
);

export default openapi.router;
