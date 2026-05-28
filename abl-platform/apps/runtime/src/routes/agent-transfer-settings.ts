/**
 * Agent Transfer Settings Routes
 *
 * GET /api/v1/agent-transfer/settings — Retrieve agent transfer settings
 * PUT /api/v1/agent-transfer/settings — Update agent transfer settings
 *
 * Called by Studio proxy routes. Uses authenticated tenant context plus the
 * X-Project-Id header for scoping. Settings are stored in the project
 * settings document under the `agentTransfer` key.
 */

import { type Request, type Response, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { createLogger } from '@abl/compiler/platform';
import {
  ProjectAgentTransferSettingsSchema,
  normalizeProjectAgentTransferSettings,
  type ProjectAgentTransferSettings,
} from '@agent-platform/agent-transfer';
import { z } from 'zod';
import { isDatabaseAvailable } from '../db/index.js';
import { findProjectSettings } from '../repos/project-settings-repo.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { runtimeRegistry } from '../openapi/registry.js';

const log = createLogger('agent-transfer-settings');
const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/agent-transfer/settings',
  tags: ['Agent Transfer Settings'],
  wrapAsyncHandlers: true,
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

const DISALLOWED_KEYS_ISSUE = 'disallowed_keys';

const agentTransferSettingsSchema = ProjectAgentTransferSettingsSchema.superRefine((value, ctx) => {
  if (hasDisallowedKeys(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: DISALLOWED_KEYS_ISSUE,
    });
  }
}).describe('Project-scoped agent transfer settings payload');

const agentTransferSettingsResponseSchema = z.object({
  success: z.literal(true),
  data: ProjectAgentTransferSettingsSchema.nullable(),
});

function hasDisallowedKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasDisallowedKeys(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  const hasOwn = Object.prototype.hasOwnProperty;
  if (
    hasOwn.call(value, '__proto__') ||
    hasOwn.call(value, 'constructor') ||
    hasOwn.call(value, 'prototype')
  ) {
    return true;
  }

  return Object.values(value).some((nested) => hasDisallowedKeys(nested));
}

function getProjectIdHeader(req: Request): string | undefined {
  const headerProjectId = req.headers['x-project-id'];
  return Array.isArray(headerProjectId) ? headerProjectId[0] : headerProjectId;
}

async function requireAgentTransferProjectAccess(
  req: Request,
  res: Response,
  permission: 'connection:read' | 'connection:write',
): Promise<{ tenantId: string; projectId: string } | null> {
  const projectId = getProjectIdHeader(req);
  if (!(await requireProjectPermission(req, res, permission, projectId))) {
    return null;
  }

  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId) {
    res.status(403).json({
      success: false,
      error: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Tenant context is required' },
    });
    return null;
  }

  if (!projectId) {
    res.status(400).json({
      success: false,
      error: { code: 'MISSING_PROJECT', message: 'X-Project-Id header is required' },
    });
    return null;
  }

  if (!isDatabaseAvailable()) {
    res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database not available' },
    });
    return null;
  }

  return { tenantId, projectId };
}

function parseAgentTransferSettingsBody(
  body: unknown,
): { success: true; data: ProjectAgentTransferSettings } | { success: false; message: string } {
  const result = agentTransferSettingsSchema.safeParse(body);
  if (result.success) {
    return {
      success: true,
      data: normalizeProjectAgentTransferSettings(result.data) ?? result.data,
    };
  }

  const hasDisallowedKeyIssue = result.error.issues.some(
    (issue) => issue.message === DISALLOWED_KEYS_ISSUE,
  );
  return {
    success: false,
    message: hasDisallowedKeyIssue
      ? 'Request body contains disallowed keys'
      : 'Request body must be a JSON object',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function preserveLifecycleOwnedSessionTtl(
  existing: Record<string, unknown> | null | undefined,
  next: ProjectAgentTransferSettings,
): Record<string, unknown> {
  const existingSession = isRecord(existing?.session) ? existing.session : null;
  const existingTtl = isRecord(existingSession?.ttl) ? existingSession.ttl : null;
  if (!existingTtl) {
    return next;
  }

  const nextSession = isRecord(next.session) ? next.session : null;
  if (nextSession && Object.prototype.hasOwnProperty.call(nextSession, 'ttl')) {
    return next;
  }

  return {
    ...next,
    session: {
      ...(nextSession ?? {}),
      ttl: existingTtl,
    },
  };
}

/**
 * GET /api/v1/agent-transfer/settings
 *
 * Retrieve agent transfer settings for the project identified by X-Project-Id.
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Get agent transfer settings',
    description:
      'Retrieve project-scoped agent transfer settings. The X-Project-Id header determines the project scope.',
    response: agentTransferSettingsResponseSchema,
  },
  async (req: Request, res: Response) => {
    const scopedAccess = await requireAgentTransferProjectAccess(req, res, 'connection:read');
    if (!scopedAccess) {
      return;
    }

    const { tenantId, projectId } = scopedAccess;

    try {
      const settings = await findProjectSettings(projectId, tenantId);
      const agentTransfer = normalizeProjectAgentTransferSettings(
        isRecord(settings?.agentTransfer) ? settings.agentTransfer : null,
      );

      return res.status(200).json({ success: true, data: agentTransfer });
    } catch (err) {
      log.error('Failed to retrieve agent transfer settings', {
        projectId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve agent transfer settings' },
      });
    }
  },
);

/**
 * PUT /api/v1/agent-transfer/settings
 *
 * Update agent transfer settings for the project identified by X-Project-Id.
 * Uses $set on the agentTransfer sub-document directly.
 */
openapi.route(
  'put',
  '/',
  {
    summary: 'Update agent transfer settings',
    description:
      'Update project-scoped agent transfer settings. The X-Project-Id header determines the project scope.',
    body: agentTransferSettingsSchema,
    response: z.object({
      success: z.literal(true),
      data: z.record(z.unknown()),
    }),
  },
  async (req: Request, res: Response) => {
    const scopedAccess = await requireAgentTransferProjectAccess(req, res, 'connection:write');
    if (!scopedAccess) {
      return;
    }

    const bodyResult = parseAgentTransferSettingsBody(req.body);
    if ('message' in bodyResult) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: bodyResult.message },
      });
    }

    const { tenantId, projectId } = scopedAccess;
    const body = bodyResult.data;

    try {
      const { ProjectSettings } = await import('@agent-platform/database/models');
      const existingSettings = await findProjectSettings(projectId, tenantId);
      const existingAgentTransfer = isRecord(existingSettings?.agentTransfer)
        ? existingSettings.agentTransfer
        : null;
      const nextAgentTransfer =
        normalizeProjectAgentTransferSettings(
          preserveLifecycleOwnedSessionTtl(existingAgentTransfer, body),
        ) ?? body;

      await ProjectSettings.findOneAndUpdate(
        { projectId, tenantId },
        { $set: { projectId, tenantId, agentTransfer: nextAgentTransfer } },
        { upsert: true, setDefaultsOnInsert: true },
      );
      log.info('Agent transfer settings updated', { projectId, tenantId });
      return res.status(200).json({ success: true, data: nextAgentTransfer });
    } catch (err) {
      log.error('Failed to update agent transfer settings', {
        projectId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update agent transfer settings' },
      });
    }
  },
);

export default router;
