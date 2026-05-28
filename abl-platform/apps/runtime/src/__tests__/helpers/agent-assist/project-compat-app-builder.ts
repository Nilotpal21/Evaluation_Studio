/**
 * Express app builder for project-scoped agent-assist binding route tests.
 *
 * Creates a lightweight Express app that mirrors the project CRUD route
 * handler logic with a DI repo and stub auth middleware.
 * Used by both unit tests (fake repo) and integration tests (real Mongo repo).
 */

import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import {
  type AgentAssistBindingResolver,
  AgentAssistBindingDuplicateError,
  AgentAssistBindingNotFoundError,
} from '../../../repos/agent-assist-binding-repo.js';

const IMMUTABLE_BINDING_FIELDS = ['tenantId', 'projectId', 'appId', 'environment'] as const;

function attemptedImmutableFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }
  const payload = body as Record<string, unknown>;
  return IMMUTABLE_BINDING_FIELDS.filter((field) => field in payload);
}

// ─── DI interfaces for settings and API keys ────────────────────────────

export interface SettingsStore {
  get(tenantId: string, projectId: string): Promise<{ enabled: boolean } | null>;
  upsert(
    tenantId: string,
    projectId: string,
    enabled: boolean,
    userId: string,
  ): Promise<{ enabled: boolean }>;
}

export interface ApiKeyStore {
  create(data: Record<string, unknown>): Promise<{ _id: string }>;
  revoke(id: string, tenantId: string): Promise<void>;
}

/** In-memory settings store for unit tests */
export function createInMemorySettingsStore(): SettingsStore {
  const store = new Map<string, { enabled: boolean }>();
  return {
    async get(tenantId, projectId) {
      return store.get(`${tenantId}:${projectId}`) ?? null;
    },
    async upsert(tenantId, projectId, enabled) {
      const doc = { enabled };
      store.set(`${tenantId}:${projectId}`, doc);
      return doc;
    },
  };
}

/** In-memory API key store for unit tests */
export function createInMemoryApiKeyStore(): ApiKeyStore {
  const keys = new Map<string, Record<string, unknown>>();
  let counter = 0;
  return {
    async create(data) {
      counter += 1;
      const id = `apikey-${counter}`;
      keys.set(id, { ...data, _id: id });
      return { _id: id };
    },
    async revoke(id, _tenantId) {
      const key = keys.get(id);
      if (key) {
        key.revokedAt = new Date();
      }
    },
  };
}

/**
 * Build an Express app with the given binding repo.
 * Auth is stubbed — always injects the given tenant/user/project context.
 */
export function buildProjectCompatApp(
  repo: AgentAssistBindingResolver,
  options?: {
    tenantId?: string;
    userId?: string;
    settingsStore?: SettingsStore;
    apiKeyStore?: ApiKeyStore;
  },
): express.Express {
  const app = express();
  app.use(express.json());

  const tenantId = options?.tenantId ?? 'T1';
  const userId = options?.userId ?? 'user-1';
  const settingsStore = options?.settingsStore ?? createInMemorySettingsStore();
  const apiKeyStore = options?.apiKeyStore ?? createInMemoryApiKeyStore();

  // Stub auth + tenant context
  const stubAuth = (req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { tenantContext?: Record<string, unknown> }).tenantContext = {
      tenantId,
      userId,
      role: 'ADMIN',
      authType: 'jwt',
      permissions: ['project:manage'],
    };
    next();
  };

  app.use(stubAuth);

  // ─── GET /settings ─────────────────────────────────────────────────────
  app.get('/projects/:projectId/bindings/settings', async (req, res) => {
    try {
      const { projectId } = req.params;
      const doc = await settingsStore.get(tenantId, projectId);
      res.json({
        success: true,
        data: { enabled: doc ? doc.enabled === true : true },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // ─── PUT /settings ─────────────────────────────────────────────────────
  app.put('/projects/:projectId/bindings/settings', async (req, res) => {
    try {
      const { projectId } = req.params;
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid settings data' },
        });
        return;
      }
      const doc = await settingsStore.upsert(tenantId, projectId, enabled, userId);
      res.json({ success: true, data: { enabled: doc.enabled } });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // ─── List ─────────────────────────────────────────────────────────────
  app.get('/projects/:projectId/bindings', async (req, res) => {
    try {
      const { projectId } = req.params;
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
      const skip = (page - 1) * limit;

      const result = await repo.list({ tenantId }, { offset: skip, limit, projectId });

      res.json({
        success: true,
        data: {
          items: result.items,
          pagination: { page, limit, total: result.total },
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // ─── Create ───────────────────────────────────────────────────────────
  app.post('/projects/:projectId/bindings', async (req, res) => {
    try {
      const { projectId } = req.params;
      // Mirror the dual-schema logic: if no appId, auto-inject projectId as appId
      const resolvedAppId = req.body.appId ?? projectId;
      const { appId: _ignore, ...rest } = req.body;
      const binding = await repo.create(
        { tenantId, actor: userId },
        { ...rest, appId: resolvedAppId, projectId },
      );
      res.status(201).json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingDuplicateError) {
        res.status(409).json({
          success: false,
          error: { code: 'BINDING_DUPLICATE', message: 'Duplicate binding' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // ─── Get ──────────────────────────────────────────────────────────────
  app.get('/projects/:projectId/bindings/:bindingId', async (req, res) => {
    try {
      const { projectId, bindingId } = req.params;
      const lookupByPk = repo['findByIdForTenant'].bind(repo);
      const binding = await lookupByPk({ tenantId }, bindingId);
      if (!binding || binding.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // ─── Update ───────────────────────────────────────────────────────────
  app.patch('/projects/:projectId/bindings/:bindingId', async (req, res) => {
    try {
      const { projectId, bindingId } = req.params;
      const lookupByPk = repo['findByIdForTenant'].bind(repo);
      const existing = await lookupByPk({ tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }

      const immutableFields = attemptedImmutableFields(req.body);
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

      const { status, ...updateFields } = req.body;
      let binding = existing;

      if (status !== undefined && status !== existing.status) {
        binding = await repo.setStatus({ tenantId, actor: userId }, bindingId, status);
      }

      if (Object.keys(updateFields).length > 0) {
        binding = await repo.update({ tenantId, actor: userId }, bindingId, updateFields);
      }

      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // ─── Disable ──────────────────────────────────────────────────────────
  app.post('/projects/:projectId/bindings/:bindingId/disable', async (req, res) => {
    try {
      const { projectId, bindingId } = req.params;
      const lookupByPk = repo['findByIdForTenant'].bind(repo);
      const existing = await lookupByPk({ tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }

      const binding = await repo.setStatus({ tenantId, actor: userId }, bindingId, 'disabled');
      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // ─── Enable ───────────────────────────────────────────────────────────
  app.post('/projects/:projectId/bindings/:bindingId/enable', async (req, res) => {
    try {
      const { projectId, bindingId } = req.params;
      const lookupByPk = repo['findByIdForTenant'].bind(repo);
      const existing = await lookupByPk({ tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }

      const binding = await repo.setStatus({ tenantId, actor: userId }, bindingId, 'active');
      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // ─── Generate API Key ──────────────────────────────────────────────────
  app.post('/projects/:projectId/bindings/:bindingId/generate-api-key', async (req, res) => {
    try {
      const { projectId, bindingId } = req.params;
      const lookupByPk = repo['findByIdForTenant'].bind(repo);
      const existing = await lookupByPk({ tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }

      // Revoke old key if exists (rotation)
      if (existing.apiKeyId) {
        await apiKeyStore.revoke(existing.apiKeyId, tenantId);
      }

      // Generate new key
      const rawKeyHex = crypto.randomBytes(32).toString('hex');
      const rawKey = `abl_${rawKeyHex}`;
      const prefix = rawKey.substring(0, 8);

      const apiKeyDoc = await apiKeyStore.create({
        tenantId,
        prefix,
        scopes: ['session:send_message'],
        projectIds: [projectId],
        createdBy: userId,
      });

      // Update binding with new apiKeyId
      await repo.update({ tenantId, actor: userId }, bindingId, {
        apiKeyId: apiKeyDoc._id,
      });

      res.status(201).json({
        success: true,
        data: { rawKey, prefix, apiKeyId: apiKeyDoc._id },
      });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // ─── Delete ───────────────────────────────────────────────────────────
  app.delete('/projects/:projectId/bindings/:bindingId', async (req, res) => {
    try {
      const { projectId, bindingId } = req.params;
      const lookupByPk = repo['findByIdForTenant'].bind(repo);
      const existing = await lookupByPk({ tenantId }, bindingId);
      if (!existing || existing.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }

      if (existing.apiKeyId) {
        await apiKeyStore.revoke(existing.apiKeyId, tenantId);
      }
      await repo.remove({ tenantId, actor: userId }, bindingId);
      res.json({ success: true, data: { deleted: true } });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  return app;
}
