/**
 * Project LLM Config Route
 *
 * Per-project opt-in operation routing map.
 * Mounted at /api/projects/:projectId/llm-config
 *
 * GET  / — Load project LLM config (or empty disabled routing map)
 * PUT  / — Upsert project operation routing map
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
import {
  formatOperationTierOverrideError,
  normalizeOperationTierOverrides,
} from '@agent-platform/shared-kernel/model-routing';
import { writeAuditLog } from '../repos/auth-repo.js';
import { invalidateModelResolutionCaches } from '../services/llm/model-cache-invalidation.js';

const log = createLogger('project-llm-config');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/llm-config',
  tags: ['Project LLM Config'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION
// =============================================================================

const projectLLMConfigResponseSchema = z.object({
  projectId: z.string(),
  operationTierOverrides: z.record(z.string()),
});

const projectLLMConfigUpdateSchema = z.object({
  operationTierOverrides: z.record(z.string()).optional(),
});

function normalizeOverrides(
  overrides: Record<string, string> | Map<string, string> | undefined | null,
): Record<string, string> {
  return overrides instanceof Map ? Object.fromEntries(overrides) : overrides || {};
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET / — Fetch project LLM config (or empty disabled routing map)
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Get project LLM config',
    description:
      'Fetch the project operation routing map. An empty map means operation routing is disabled and model resolution uses the normal project/workspace default model chain.',
    response: z.object({
      success: z.literal(true),
      config: projectLLMConfigResponseSchema,
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'model_config:read'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;

      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const { ProjectLLMConfig, ProjectRuntimeConfig } =
        await import('@agent-platform/database/models');
      const canonical = await ProjectLLMConfig.findOne({ tenantId, projectId }).lean();
      const compatibility =
        canonical ?? (await ProjectRuntimeConfig.findOne({ tenantId, projectId }).lean());

      res.json({
        success: true,
        config: {
          projectId,
          operationTierOverrides: normalizeOverrides(compatibility?.operationTierOverrides),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to get project LLM config', { error: message });
      res.status(500).json({ success: false, error: 'Failed to get project LLM config' });
    }
  },
);

/**
 * PUT / — Upsert project operation routing map
 */
openapi.route(
  'put',
  '/',
  {
    summary: 'Update project LLM config',
    description:
      'Set the project operation routing map. Pass an empty map to disable operation routing and use the normal project/workspace default model chain.',
    body: projectLLMConfigUpdateSchema,
    response: z.object({
      success: z.literal(true),
      config: projectLLMConfigResponseSchema,
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'model_config:write'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;
      const userId = req.tenantContext?.userId;

      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const { operationTierOverrides } = req.body;

      // Build the $set payload — only include fields that are present in the request
      const setPayload: Record<string, unknown> = { projectId, tenantId };

      if (operationTierOverrides !== undefined) {
        const validation = normalizeOperationTierOverrides(operationTierOverrides);
        if (!validation.ok) {
          res.status(400).json({
            success: false,
            error: formatOperationTierOverrideError(validation),
          });
          return;
        }
        setPayload.operationTierOverrides = validation.overrides;
      }

      const { ProjectLLMConfig, ProjectRuntimeConfig } =
        await import('@agent-platform/database/models');
      const [updated, runtimeMirror] = await Promise.all([
        ProjectLLMConfig.findOneAndUpdate(
          { tenantId, projectId },
          { $set: setPayload },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean(),
        ProjectRuntimeConfig.findOneAndUpdate(
          { tenantId, projectId },
          { $set: setPayload },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean(),
      ]);

      log.info('Project LLM config updated', { projectId, tenantId });
      writeAuditLog({
        action: 'project-llm-config:update',
        tenantId,
        userId,
        metadata: {
          projectId,
          overrideCount: operationTierOverrides ? Object.keys(operationTierOverrides).length : 0,
        },
      });

      invalidateModelResolutionCaches(tenantId);

      const responseDoc = updated ?? runtimeMirror;

      res.json({
        success: true,
        config: {
          projectId,
          operationTierOverrides: normalizeOverrides(responseDoc?.operationTierOverrides),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to update project LLM config', { error: message });
      res.status(500).json({ success: false, error: 'Failed to update project LLM config' });
    }
  },
);

export default openapi.router;
