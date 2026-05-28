/**
 * Project Settings Route
 *
 * Per-project execution settings (working copy + versioned snapshots).
 * Mounted at /api/projects/:projectId/settings
 *
 * GET  /                          — Get working copy (or defaults)
 * PUT  /                          — Update working copy
 * POST /versions                  — Create version from working copy
 * GET  /versions                  — List versions (paginated)
 * GET  /versions/:version         — Get version detail
 * POST /versions/:version/promote — Promote version
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
import { writeAuditLog } from '../repos/auth-repo.js';
import { findProjectSettings, upsertProjectSettings } from '../repos/project-settings-repo.js';
import { getSettingsVersionService } from '../services/settings-version-service.js';
import { PromptCatalog } from '../services/execution/prompt-catalog.js';

const log = createLogger('project-settings');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/settings',
  tags: ['Project Settings'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// SCHEMAS
// =============================================================================

const projectMemorySettingsSchema = z.object({
  dedupMaxDepth: z.number().int().min(1).max(32).nullable().optional(),
});

const projectSdkDefaultsSchema = z.object({
  hostedExchangeTokenEnvelopePolicy: z
    .enum(['inherit', 'signed', 'jwe_preferred', 'jwe_required'])
    .nullable()
    .optional(),
});

const projectSettingsResponseSchema = z.object({
  projectId: z.string(),
  enableThinking: z.boolean(),
  thinkingBudget: z.number().nullable(),
  thoughtDescription: z.string().nullable(),
  promptOverrides: z.record(z.unknown()).optional(),
  traceDimensions: z.array(z.string()).optional(),
  memory: projectMemorySettingsSchema.nullable().optional(),
  sdkDefaults: projectSdkDefaultsSchema.nullable().optional(),
});

const promptDefaultsSchema = z.record(z.string());

const projectSettingsUpdateSchema = z.object({
  enableThinking: z.boolean().optional(),
  thinkingBudget: z.number().nullable().optional(),
  thoughtDescription: z.string().nullable().optional(),
  promptOverrides: z.record(z.unknown()).optional(),
  traceDimensions: z.array(z.string()).optional(),
  memory: projectMemorySettingsSchema.nullable().optional(),
  publicApiAccess: z.record(z.unknown()).nullable().optional(),
  sdkDefaults: projectSdkDefaultsSchema.nullable().optional(),
});

const PROJECT_SETTINGS_PROMPT_DEFAULTS: Record<string, string> = {
  'tool_description.shared.thought': PromptCatalog.sharedDescriptions.thought,
  'llm_prompt.entity_extraction': PromptCatalog.llmPrompts.entity_extraction,
  'llm_prompt.correction_detection': PromptCatalog.llmPrompts.correction_detection,
  'llm_prompt.field_validation': PromptCatalog.llmPrompts.field_validation,
  'llm_prompt.field_inference': PromptCatalog.llmPrompts.field_inference,
  'escalation.digital': PromptCatalog.escalation.digital,
  'escalation.voice': PromptCatalog.escalation.voice,
  'escalation.plain': PromptCatalog.escalation.plain,
};

// =============================================================================
// WORKING COPY ROUTES
// =============================================================================

/**
 * GET / — Fetch project settings (or defaults)
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Get project settings',
    description:
      'Fetch the execution settings for a project. Returns defaults when no record exists.',
    response: z.object({
      success: z.literal(true),
      settings: projectSettingsResponseSchema,
      promptDefaults: promptDefaultsSchema,
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

      const doc = await findProjectSettings(projectId, tenantId);

      res.json({
        success: true,
        settings: {
          projectId,
          enableThinking: doc?.enableThinking ?? false,
          thinkingBudget: doc?.thinkingBudget ?? null,
          thoughtDescription: doc?.thoughtDescription ?? null,
          promptOverrides: doc?.promptOverrides ?? {},
          traceDimensions: doc?.traceDimensions ?? [],
          memory: doc?.memory ?? null,
          publicApiAccess: doc?.publicApiAccess ?? null,
          sdkDefaults: doc?.sdkDefaults ?? null,
        },
        promptDefaults: PROJECT_SETTINGS_PROMPT_DEFAULTS,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to get project settings', { error: message });
      res.status(500).json({ success: false, error: 'Failed to get project settings' });
    }
  },
);

/**
 * PUT / — Upsert project settings working copy
 */
openapi.route(
  'put',
  '/',
  {
    summary: 'Update project settings',
    description: 'Update execution settings for a project (working copy).',
    body: projectSettingsUpdateSchema,
    response: z.object({
      success: z.literal(true),
      settings: projectSettingsResponseSchema,
      promptDefaults: promptDefaultsSchema,
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

      const {
        enableThinking,
        thinkingBudget,
        thoughtDescription,
        promptOverrides,
        traceDimensions,
        memory,
        publicApiAccess,
        sdkDefaults,
      } = req.body;

      if (enableThinking !== undefined && typeof enableThinking !== 'boolean') {
        res.status(400).json({ success: false, error: 'enableThinking must be a boolean' });
        return;
      }

      if (
        thinkingBudget !== undefined &&
        thinkingBudget !== null &&
        typeof thinkingBudget !== 'number'
      ) {
        res.status(400).json({ success: false, error: 'thinkingBudget must be a number or null' });
        return;
      }

      if (
        thoughtDescription !== undefined &&
        thoughtDescription !== null &&
        typeof thoughtDescription !== 'string'
      ) {
        res
          .status(400)
          .json({ success: false, error: 'thoughtDescription must be a string or null' });
        return;
      }

      // When thinking is enabled, thinkingBudget is required.
      // Check the effective state after applying this update.
      if (enableThinking === true && (thinkingBudget === undefined || thinkingBudget === null)) {
        // Check if budget already exists in the current record
        const existing = await findProjectSettings(projectId, tenantId);
        if (!existing?.thinkingBudget) {
          res.status(400).json({
            success: false,
            error: 'thinkingBudget is required when enableThinking is true',
          });
          return;
        }
      }

      if (
        promptOverrides !== undefined &&
        (typeof promptOverrides !== 'object' ||
          promptOverrides === null ||
          Array.isArray(promptOverrides))
      ) {
        res.status(400).json({ success: false, error: 'promptOverrides must be an object' });
        return;
      }

      if (traceDimensions !== undefined) {
        if (
          !Array.isArray(traceDimensions) ||
          !traceDimensions.every((k: unknown) => typeof k === 'string')
        ) {
          res
            .status(400)
            .json({ success: false, error: 'traceDimensions must be an array of strings' });
          return;
        }
        const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
        const invalidKeys = traceDimensions.filter((k: string) => !KEY_PATTERN.test(k));
        if (invalidKeys.length > 0) {
          res.status(400).json({
            success: false,
            error: `Invalid traceDimension keys: ${invalidKeys.join(', ')}`,
          });
          return;
        }
      }

      if (memory !== undefined && memory !== null) {
        const depth = memory.dedupMaxDepth;
        if (
          depth !== undefined &&
          depth !== null &&
          (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 32)
        ) {
          res.status(400).json({
            success: false,
            error: 'memory.dedupMaxDepth must be an integer between 1 and 32',
          });
          return;
        }
      }

      const updated = await upsertProjectSettings(projectId, tenantId, {
        enableThinking,
        thinkingBudget,
        thoughtDescription,
        promptOverrides,
        traceDimensions,
        memory,
        publicApiAccess,
        sdkDefaults,
      });

      log.info('Project settings updated', { projectId, tenantId });
      writeAuditLog({
        action: 'project-settings:update',
        tenantId,
        userId,
        metadata: { projectId },
      });

      res.json({
        success: true,
        settings: {
          projectId,
          enableThinking: updated?.enableThinking ?? false,
          thinkingBudget: updated?.thinkingBudget ?? null,
          thoughtDescription: updated?.thoughtDescription ?? null,
          promptOverrides: updated?.promptOverrides ?? {},
          traceDimensions: updated?.traceDimensions ?? [],
          memory: updated?.memory ?? null,
          publicApiAccess: updated?.publicApiAccess ?? null,
          sdkDefaults: updated?.sdkDefaults ?? null,
        },
        promptDefaults: PROJECT_SETTINGS_PROMPT_DEFAULTS,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to update project settings', { error: message });
      res.status(500).json({ success: false, error: 'Failed to update project settings' });
    }
  },
);

// =============================================================================
// VERSION ROUTES
// =============================================================================

/**
 * POST /versions — Create a version from the working copy
 */
openapi.route(
  'post',
  '/versions',
  {
    summary: 'Create settings version',
    description: 'Snapshot the current working copy into a new versioned record.',
    body: z.object({
      changelog: z.string().optional(),
    }),
    response: z.object({
      success: z.literal(true),
      version: z.object({
        versionId: z.string(),
        version: z.string(),
        sourceHash: z.string(),
        deduplicated: z.boolean().optional(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:create'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;
      const userId = req.tenantContext?.userId;

      if (!tenantId || !userId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const svc = getSettingsVersionService();
      const result = await svc.createVersion({
        projectId,
        tenantId,
        createdBy: userId,
        changelog: req.body.changelog,
      });

      writeAuditLog({
        action: 'project-settings-version:create',
        tenantId,
        userId,
        metadata: { projectId, version: result.version, deduplicated: result.deduplicated },
      });

      res.status(201).json({ success: true, version: result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to create settings version', { error: message });
      res.status(500).json({ success: false, error: 'Failed to create settings version' });
    }
  },
);

/**
 * GET /versions — List versions (paginated)
 */
openapi.route(
  'get',
  '/versions',
  {
    summary: 'List settings versions',
    description: 'List all versioned snapshots of project settings.',
    response: z.object({
      success: z.literal(true),
      versions: z.array(z.any()),
      total: z.number(),
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

      const skip = parseInt(req.query.skip as string) || 0;
      const limit = parseInt(req.query.limit as string) || 50;

      const svc = getSettingsVersionService();
      const { versions, total } = await svc.listVersions({
        projectId,
        tenantId,
        limit,
        offset: skip,
      });

      res.json({ success: true, versions, total });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to list settings versions', { error: message });
      res.status(500).json({ success: false, error: 'Failed to list settings versions' });
    }
  },
);

/**
 * GET /versions/:version — Get version detail
 */
openapi.route(
  'get',
  '/versions/:version',
  {
    summary: 'Get settings version',
    description: 'Get a specific version of project settings.',
    response: z.object({
      success: z.literal(true),
      version: z.any(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'model_config:read'))) return;

      const { projectId, version } = req.params;
      const tenantId = req.tenantContext?.tenantId;

      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const svc = getSettingsVersionService();
      const record = await svc.getVersion(projectId, version, tenantId);
      if (!record) {
        res.status(404).json({ success: false, error: 'Version not found' });
        return;
      }

      res.json({ success: true, version: record });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to get settings version', { error: message });
      res.status(500).json({ success: false, error: 'Failed to get settings version' });
    }
  },
);

/**
 * POST /versions/:version/promote — Promote a version
 */
openapi.route(
  'post',
  '/versions/:version/promote',
  {
    summary: 'Promote settings version',
    description: 'Promote a settings version to a new lifecycle status.',
    body: z.object({
      targetStatus: z.enum(['draft', 'testing', 'staged', 'active', 'deprecated']),
    }),
    response: z.object({
      success: z.literal(true),
      version: z.any(),
      previousStatus: z.string(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:create'))) return;

      const { projectId, version } = req.params;
      const tenantId = req.tenantContext?.tenantId;
      const userId = req.tenantContext?.userId;

      if (!tenantId || !userId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const { targetStatus } = req.body;

      const svc = getSettingsVersionService();
      const result = await svc.promoteVersion({
        projectId,
        version,
        targetStatus,
        promotedBy: userId,
        tenantId,
      });

      writeAuditLog({
        action: 'project-settings-version:promote',
        tenantId,
        userId,
        metadata: {
          projectId,
          version,
          from: result.previousStatus,
          to: targetStatus,
        },
      });

      res.json({
        success: true,
        version: result,
        previousStatus: result.previousStatus,
      });
    } catch (error: unknown) {
      const CLIENT_ERROR_MESSAGES: Record<number, string> = {
        400: 'Invalid request',
        404: 'Resource not found',
        422: 'Unprocessable request',
      };

      const statusCode =
        (error as any)?.statusCode === 400 || (error as any)?.code === 'BAD_REQUEST'
          ? 400
          : (error as any)?.statusCode === 404 || (error as any)?.code === 'NOT_FOUND'
            ? 404
            : (error as any)?.statusCode === 422 || (error as any)?.code === 'UNPROCESSABLE_ENTITY'
              ? 422
              : undefined;

      if (statusCode && CLIENT_ERROR_MESSAGES[statusCode]) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.warn('Project settings error', { statusCode, error: errorMsg });
        res.status(statusCode).json({
          success: false,
          error: {
            code: (error as any)?.code || 'ERROR',
            message: CLIENT_ERROR_MESSAGES[statusCode],
          },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to promote settings version', { error: message });
      res.status(500).json({ success: false, error: 'Failed to promote settings version' });
    }
  },
);

export default openapi.router;
