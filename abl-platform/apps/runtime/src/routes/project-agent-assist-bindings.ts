/**
 * Project-Scoped Agentic Compat Binding CRUD Routes
 *
 * Endpoints for managing AgentAssistBinding documents scoped to a
 * specific project + tenant. Used by Studio to let project members
 * manage Agent Assist integration bindings.
 *
 * Mount: /api/projects/:projectId/agent-assist-bindings
 */

import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import {
  type AgentAssistBindingResolver,
  AgentAssistBindingDuplicateError,
  AgentAssistBindingNotFoundError,
  createAgentAssistBindingRepo,
} from '../repos/agent-assist-binding-repo.js';
import {
  PROJECT_BINDING_IMMUTABLE_FIELDS,
  attemptedImmutableFields,
  lookupBindingByPk,
  parsePagination,
} from '../services/agent-assist/binding-route-helpers.js';

const log = createLogger('project-agent-assist');

// ─── Merged Params Type ──────────────────────────────────────────────────
// Express mergeParams doesn't propagate parent params to TS types.
// This interface represents the merged params from the parent mount.
interface ProjectParams {
  projectId: string;
}

interface BindingParams extends ProjectParams {
  bindingId: string;
}

// ─── Validation ───────────────────────────────────────────────────────────

const createBindingSchema = z
  .object({
    environment: z.string().min(1),
    deploymentId: z.string().min(1).nullable().optional(),
    displayName: z.string().min(1).nullable().optional(),
    runtimeBaseUrl: z.string().url().nullable().optional(),
  })
  .strict();

/** Legacy create schema — accepts appId for backward compat (env-seeded bindings). */
const createBindingSchemaLegacy = z
  .object({
    appId: z.string().min(1),
    environment: z.string().min(1),
    deploymentId: z.string().min(1).nullable().optional(),
    apiKeyId: z.string().min(1).nullable().optional(),
    displayName: z.string().min(1).nullable().optional(),
    runtimeBaseUrl: z.string().url().nullable().optional(),
  })
  .strict();

const updateBindingSchema = z
  .object({
    deploymentId: z.string().min(1).nullable().optional(),
    apiKeyId: z.string().min(1).nullable().optional(),
    displayName: z.string().min(1).nullable().optional(),
    runtimeBaseUrl: z.string().url().nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

const settingsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

// ─── API Key Constants ───────────────────────────────────────────────────

const API_KEY_PREFIX_LENGTH = 8;
const API_KEY_RAW_BYTES = 32;
const API_KEY_SCOPE = 'session:send_message';

// ─── Factory ──────────────────────────────────────────────────────────────

export interface ProjectAgentAssistBindingsDeps {
  repo?: AgentAssistBindingResolver;
}

export function createProjectAgentAssistBindingsRouter(
  deps?: ProjectAgentAssistBindingsDeps,
): ReturnType<typeof Router> {
  const router: ReturnType<typeof Router> = Router({ mergeParams: true });
  const repo = deps?.repo ?? createAgentAssistBindingRepo();

  // ─── Middleware ────────────────────────────────────────────────────────
  router.use(authMiddleware);
  router.use(requireProjectScope('projectId'));
  router.use(tenantRateLimit('request'));

  // ─── GET / — List bindings for project ────────────────────────────────

  router.get('/', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId } = req.params as unknown as ProjectParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:read'))) return;

      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const result = await repo.list({ tenantId }, { offset: skip, limit, projectId });

      res.json({
        success: true,
        data: {
          items: result.items,
          pagination: {
            page,
            limit,
            total: result.total,
            totalPages: Math.ceil(result.total / limit),
          },
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to list project agentic compat bindings', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list bindings' },
      });
    }
  });

  // ─── GET /settings — Get project agent assist settings ─────────────────

  router.get('/settings', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId } = req.params as unknown as ProjectParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:read'))) return;

      const { ProjectAgentAssistSettings } = await import('@agent-platform/database/models');
      const doc = await ProjectAgentAssistSettings.findOne({
        tenantId,
        projectId,
      }).lean();

      res.json({
        success: true,
        data: { enabled: doc ? (doc as Record<string, unknown>).enabled === true : true },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to get project agent assist settings', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get settings' },
      });
    }
  });

  // ─── PUT /settings — Update project agent assist settings ─────────────

  router.put('/settings', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId } = req.params as unknown as ProjectParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:manage'))) return;

      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid settings data' },
        });
        return;
      }

      const userId = req.tenantContext?.userId ?? 'unknown';
      const { ProjectAgentAssistSettings } = await import('@agent-platform/database/models');

      const doc = await ProjectAgentAssistSettings.findOneAndUpdate(
        { tenantId, projectId },
        { $set: { enabled: parsed.data.enabled }, $setOnInsert: { createdBy: userId } },
        { new: true, upsert: true },
      ).lean();

      log.info('Project agent assist settings updated', {
        tenantId,
        projectId,
        enabled: parsed.data.enabled,
        userId,
        requestId,
      });
      writeAuditLog({
        action: 'project:agent-assist-settings-update',
        userId,
        tenantId,
        metadata: { projectId, enabled: parsed.data.enabled, requestId },
      });

      res.json({
        success: true,
        data: { enabled: (doc as Record<string, unknown>).enabled === true },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to update project agent assist settings', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update settings' },
      });
    }
  });

  // ─── POST / — Create binding ──────────────────────────────────────────

  router.post('/', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId } = req.params as unknown as ProjectParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:manage'))) return;

      // Try new schema first (no appId), fall back to legacy (with appId)
      let parsedData: {
        environment: string;
        deploymentId?: string | null;
        displayName?: string | null;
        runtimeBaseUrl?: string | null;
        apiKeyId?: string | null;
      };
      let resolvedAppId: string;

      const newParsed = createBindingSchema.safeParse(req.body);
      if (newParsed.success) {
        parsedData = newParsed.data;
        resolvedAppId = projectId; // Auto-set appId = projectId
      } else {
        // Fall back to legacy schema for backward compat
        const legacyParsed = createBindingSchemaLegacy.safeParse(req.body);
        if (!legacyParsed.success) {
          res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Invalid binding data' },
            details: legacyParsed.error.issues,
          });
          return;
        }
        parsedData = legacyParsed.data;
        resolvedAppId = legacyParsed.data.appId;
      }

      const userId = req.tenantContext?.userId ?? 'unknown';
      const binding = await repo.create(
        { tenantId, actor: userId },
        {
          ...parsedData,
          appId: resolvedAppId,
          projectId,
        },
      );

      log.info('Project agentic compat binding created', {
        bindingId: binding._id,
        tenantId,
        projectId,
        appId: resolvedAppId,
        userId,
        requestId,
      });
      writeAuditLog({
        action: 'project:compat-binding-create',
        userId,
        tenantId,
        metadata: { bindingId: binding._id, projectId, appId: resolvedAppId, requestId },
      });

      res.status(201).json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingDuplicateError) {
        res.status(409).json({
          success: false,
          error: {
            code: 'BINDING_DUPLICATE',
            message: 'An Agent Assist connection already exists for this project + environment.',
          },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to create project agentic compat binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create binding' },
      });
    }
  });

  // ─── GET /:bindingId — Get binding ────────────────────────────────────

  router.get('/:bindingId', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId, bindingId } = req.params as unknown as BindingParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:manage'))) return;

      const binding = await lookupBindingByPk(repo, { tenantId }, bindingId);

      if (!binding || binding.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }

      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to get project agentic compat binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get binding' },
      });
    }
  });

  // ─── PATCH /:bindingId — Update binding ───────────────────────────────

  router.patch('/:bindingId', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId, bindingId } = req.params as unknown as BindingParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:manage'))) return;

      const immutableFields = attemptedImmutableFields(req.body, PROJECT_BINDING_IMMUTABLE_FIELDS);
      if (immutableFields.length > 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'IMMUTABLE_FIELD_CHANGE',
            message: `Immutable binding fields cannot be changed: ${immutableFields.join(', ')}`,
          },
        });
        return;
      }

      const parsed = updateBindingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid update data' },
          details: parsed.error.issues,
        });
        return;
      }

      // Verify the binding belongs to this project
      const existing = await lookupBindingByPk(repo, { tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }

      const userId = req.tenantContext?.userId ?? 'unknown';
      const { status, ...updateFields } = parsed.data;

      // Handle status change via setStatus if provided
      let binding = existing;
      if (status !== undefined && status !== existing.status) {
        binding = await repo.setStatus({ tenantId, actor: userId }, bindingId, status);
      }

      // Handle field updates if any non-status fields provided
      if (Object.keys(updateFields).length > 0) {
        binding = await repo.update({ tenantId, actor: userId }, bindingId, updateFields);
      }

      log.info('Project agentic compat binding updated', {
        bindingId,
        tenantId,
        projectId,
        userId,
        requestId,
      });
      writeAuditLog({
        action: 'project:compat-binding-update',
        userId,
        tenantId,
        metadata: { bindingId, projectId, updates: Object.keys(parsed.data), requestId },
      });

      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to update project agentic compat binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update binding' },
      });
    }
  });

  // ─── POST /:bindingId/disable — Disable binding ──────────────────────

  router.post('/:bindingId/disable', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId, bindingId } = req.params as unknown as BindingParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:manage'))) return;

      // Verify binding belongs to this project
      const existing = await lookupBindingByPk(repo, { tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }

      const userId = req.tenantContext?.userId ?? 'unknown';
      const binding = await repo.setStatus({ tenantId, actor: userId }, bindingId, 'disabled');

      log.info('Project agentic compat binding disabled', {
        bindingId,
        tenantId,
        projectId,
        userId,
        requestId,
      });
      writeAuditLog({
        action: 'project:compat-binding-disable',
        userId,
        tenantId,
        metadata: { bindingId, projectId, requestId },
      });

      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to disable project agentic compat binding', {
        error: message,
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to disable binding' },
      });
    }
  });

  // ─── POST /:bindingId/enable — Enable binding ────────────────────────

  router.post('/:bindingId/enable', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId, bindingId } = req.params as unknown as BindingParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:manage'))) return;

      // Verify binding belongs to this project
      const existing = await lookupBindingByPk(repo, { tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }

      const userId = req.tenantContext?.userId ?? 'unknown';
      const binding = await repo.setStatus({ tenantId, actor: userId }, bindingId, 'active');

      log.info('Project agentic compat binding enabled', {
        bindingId,
        tenantId,
        projectId,
        userId,
        requestId,
      });
      writeAuditLog({
        action: 'project:compat-binding-enable',
        userId,
        tenantId,
        metadata: { bindingId, projectId, requestId },
      });

      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to enable project agentic compat binding', {
        error: message,
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to enable binding' },
      });
    }
  });

  // ─── POST /:bindingId/generate-api-key — Mint or rotate API key ───────

  router.post('/:bindingId/generate-api-key', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId, bindingId } = req.params as unknown as BindingParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:manage'))) return;

      // Verify binding belongs to this project
      const existing = await lookupBindingByPk(repo, { tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }

      const userId = req.tenantContext?.userId ?? 'unknown';
      const { ApiKey } = await import('@agent-platform/database/models');

      // If binding already has an apiKeyId, revoke the old key first (rotate)
      if (existing.apiKeyId) {
        await ApiKey.findOneAndUpdate(
          { _id: existing.apiKeyId, tenantId },
          { $set: { revokedAt: new Date() } },
        );
        log.info('Revoked old API key during rotation', {
          oldApiKeyId: existing.apiKeyId,
          bindingId,
          tenantId,
          requestId,
        });
        writeAuditLog({
          action: 'project:compat-binding-api-key-revoke',
          userId,
          tenantId,
          metadata: { bindingId, projectId, oldApiKeyId: existing.apiKeyId, requestId },
        });
      }

      // Generate new key
      const rawKeyHex = crypto.randomBytes(API_KEY_RAW_BYTES).toString('hex');
      const rawKey = `abl_${rawKeyHex}`;
      const prefix = rawKey.substring(0, API_KEY_PREFIX_LENGTH);
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const clientId = `aa-${bindingId}-${Date.now()}`;
      const keyName = `Agent Assist – ${existing.displayName ?? existing.appId}`;

      const apiKeyDoc = await ApiKey.create({
        tenantId,
        name: keyName,
        clientId,
        keyHash,
        prefix,
        scopes: [API_KEY_SCOPE],
        projectIds: [projectId],
        environments: [],
        createdBy: userId,
      });

      // Update binding with new apiKeyId + prefix (the prefix is the only
      // user-recognizable piece the UI can display, since the full key is
      // shown exactly once).
      await repo.update({ tenantId, actor: userId }, bindingId, {
        apiKeyId: (apiKeyDoc as Record<string, unknown>)._id as string,
        apiKeyPrefix: prefix,
      });

      log.info('Generated API key for agentic compat binding', {
        apiKeyId: (apiKeyDoc as Record<string, unknown>)._id,
        bindingId,
        tenantId,
        projectId,
        userId,
        requestId,
      });
      writeAuditLog({
        action: 'project:compat-binding-api-key-generate',
        userId,
        tenantId,
        metadata: {
          bindingId,
          projectId,
          apiKeyId: (apiKeyDoc as Record<string, unknown>)._id,
          isRotation: Boolean(existing.apiKeyId),
          requestId,
        },
      });

      // Return plaintext key ONCE — never stored, never logged
      res.status(201).json({
        success: true,
        data: {
          rawKey,
          prefix,
          apiKeyId: (apiKeyDoc as Record<string, unknown>)._id as string,
        },
      });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to generate API key for binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to generate API key' },
      });
    }
  });

  // ─── DELETE /:bindingId — Delete binding ──────────────────────────────

  router.delete('/:bindingId', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId, bindingId } = req.params as unknown as BindingParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:manage'))) return;

      // Verify binding belongs to this project
      const existing = await lookupBindingByPk(repo, { tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }

      const userId = req.tenantContext?.userId ?? 'unknown';
      const { ApiKey } = await import('@agent-platform/database/models');
      if (existing.apiKeyId) {
        await ApiKey.findOneAndUpdate(
          { _id: existing.apiKeyId, tenantId },
          { $set: { revokedAt: new Date() } },
        );
      }
      await repo.remove({ tenantId, actor: userId }, bindingId);

      log.info('Project agentic compat binding deleted', {
        bindingId,
        tenantId,
        projectId,
        userId,
        requestId,
      });
      writeAuditLog({
        action: 'project:compat-binding-delete',
        userId,
        tenantId,
        metadata: { bindingId, projectId, requestId },
      });

      res.json({ success: true, data: { deleted: true } });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to delete project agentic compat binding', {
        error: message,
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete binding' },
      });
    }
  });

  return router;
}

const defaultRouter: ReturnType<typeof Router> = createProjectAgentAssistBindingsRouter();
export default defaultRouter;
