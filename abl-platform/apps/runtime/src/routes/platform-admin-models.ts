/**
 * Platform Admin — Tenant Model Provisioning Routes
 *
 * System admins provision LLM models for tenants as part of service/pricing agreements.
 * Admin operates from a separate platform context — never inside a tenant's workspace.
 *
 * INTENTIONAL: Repo calls in this file omit tenantId because platform-admin (super-admin)
 * operates across tenants. The repo layer logs a warning when tenantId is absent so that
 * non-admin callers are flagged. See requirePlatformAdmin() middleware below.
 *
 * Key rules:
 * - All routes require `requirePlatformAdmin()` — only super-admins
 * - `targetTenantId` comes from the request body/query — admin is NOT tenant-scoped
 * - API keys stored in LLMCredential documents (encryption plugin auto-encrypts)
 * - Connections reference credentials via `credentialId` — never store keys directly
 * - API keys NEVER returned in responses
 * - Every action writes an audit log with `platform-admin:*` prefix
 *
 * Mount: /api/platform/admin/tenant-models
 */

import { Router } from 'express';
import { z } from 'zod';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { MODEL_ROUTING_TIERS } from '@agent-platform/shared-kernel/model-routing';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { invalidateModelResolutionCaches } from '../services/llm/model-cache-invalidation.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import {
  findTenantModelAdmin,
  findTenantModelWithConnectionsAdmin,
  listTenantModels,
  countTenantModels,
  createTenantModel,
  updateTenantModelAdmin,
  findTenantModelConnectionById,
  createTenantModelConnection,
  updateTenantModelConnection,
  deleteTenantModelConnection,
} from '../repos/tenant-model-repo.js';

const log = createLogger('platform-admin-models');
const router: ReturnType<typeof Router> = Router();

const MAX_FIELD_LENGTH = 256;
const MAX_NOTE_LENGTH = 1024;
const DEFAULT_TENANT_MODEL_TIER = 'balanced';

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Validation Schemas ───────────────────────────────────────────────────

const VALID_CAPABILITIES = [
  'text',
  'tools',
  'streaming',
  'vision',
  'realtime_voice',
  'embedding',
] as const;

const provisionModelSchema = z.object({
  targetTenantId: z.string().min(1),
  displayName: z.string().min(1).max(MAX_FIELD_LENGTH),
  integrationType: z.enum(['easy', 'api']).optional(),
  modelId: z.string().optional(),
  provider: z.string().optional(),
  endpointUrl: z.string().optional(),
  providerStructure: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(200000).optional(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  supportsTools: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsStructured: z.boolean().optional(),
  capabilities: z.array(z.enum(VALID_CAPABILITIES)).optional(),
  realtimeConfig: z.record(z.unknown()).optional(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
  tier: z.enum(MODEL_ROUTING_TIERS).optional(),
  isDefault: z.boolean().optional(),
  provisioningNote: z.string().max(MAX_NOTE_LENGTH).optional(),
  // Optional initial connection — admin provides a raw API key which gets stored
  // as an LLMCredential document; the connection then references it via credentialId.
  connection: z
    .object({
      credentialName: z.string().max(MAX_FIELD_LENGTH),
      apiKey: z.string().min(1),
      authType: z.string().optional(),
      authConfig: z.record(z.unknown()).optional(),
    })
    .optional(),
});

const updateProvisionedModelSchema = z.object({
  displayName: z.string().max(MAX_FIELD_LENGTH).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(200000).optional(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  tier: z.enum(MODEL_ROUTING_TIERS).optional(),
  isDefault: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsStructured: z.boolean().optional(),
  capabilities: z.array(z.enum(VALID_CAPABILITIES)).optional(),
  realtimeConfig: z.record(z.unknown()).nullable().optional(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
  provisioningNote: z.string().max(MAX_NOTE_LENGTH).nullable().optional(),
  isActive: z.boolean().optional(),
  inferenceEnabled: z.boolean().optional(),
});

const createConnectionSchema = z.object({
  credentialName: z.string().min(1).max(MAX_FIELD_LENGTH),
  apiKey: z.string().min(1),
  authType: z.string().optional(),
  authConfig: z.record(z.unknown()).optional(),
  isPrimary: z.boolean().optional(),
});

const updateConnectionSchema = z.object({
  apiKey: z.string().optional(),
  authType: z.string().optional(),
  isActive: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create an LLMCredential document for the given tenant and return its _id.
 * The encryption plugin on LLMCredential auto-encrypts `encryptedApiKey` at save time,
 * so we pass the plaintext API key as `encryptedApiKey` and the plugin handles the rest.
 */
async function createCredentialForTenant(opts: {
  tenantId: string;
  provider: string;
  name: string;
  apiKey: string;
  authType: string;
  authConfig?: Record<string, unknown>;
}): Promise<string> {
  const { LLMCredential } = await import('@agent-platform/database/models');
  const credential = await LLMCredential.create({
    tenantId: opts.tenantId,
    credentialScope: 'tenant',
    ownerId: opts.tenantId,
    provider: opts.provider,
    name: opts.name,
    encryptedApiKey: opts.apiKey,
    authType: opts.authType,
    ...(opts.authConfig ? { authConfig: opts.authConfig } : {}),
    isActive: true,
    isDefault: false,
  });
  return credential._id;
}

// ─── Response shape helpers ───────────────────────────────────────────────

function sanitizeModel(model: any) {
  return {
    id: model.id ?? model._id,
    tenantId: model.tenantId,
    displayName: model.displayName,
    integrationType: model.integrationType,
    modelId: model.modelId,
    provider: model.provider,
    endpointUrl: model.endpointUrl,
    temperature: model.temperature,
    maxTokens: model.maxTokens,
    hyperParameters: model.hyperParameters,
    supportsTools: model.supportsTools,
    supportsStreaming: model.supportsStreaming,
    useResponsesApi: model.useResponsesApi,
    useStreaming: model.useStreaming,
    supportsVision: model.supportsVision,
    supportsStructured: model.supportsStructured,
    capabilities: model.capabilities,
    tier: model.tier,
    isDefault: model.isDefault,
    isActive: model.isActive,
    inferenceEnabled: model.inferenceEnabled,
    provisionedBy: model.provisionedBy,
    provisionedAt: model.provisionedAt,
    provisioningNote: model.provisioningNote,
    connectionsCount: Array.isArray(model.connections) ? model.connections.length : 0,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function sanitizeConnection(conn: any) {
  return {
    id: conn.id,
    credentialId: conn.credentialId ?? null,
    connectionType: conn.connectionType ?? 'http',
    isActive: conn.isActive,
    isPrimary: conn.isPrimary,
    healthStatus: conn.healthStatus ?? 'unchecked',
    createdBy: conn.createdBy ?? null,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

// ─── GET / — List provisioned models ──────────────────────────────────────

router.get('/', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const targetTenantId = req.query.targetTenantId as string | undefined;

    const where: Record<string, unknown> = { provisionedBy: { $ne: null } };
    if (targetTenantId) where.tenantId = targetTenantId;

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
    const skip = (page - 1) * limit;

    const [models, total] = await Promise.all([
      listTenantModels(where, { skip, take: limit }),
      countTenantModels(where),
    ]);

    res.json({
      success: true,
      models: models.map(sanitizeModel),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: unknown) {
    log.error('Failed to list provisioned models', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    res.status(500).json({ success: false, error: 'Failed to list provisioned models' });
  }
});

// ─── POST / — Provision model for tenant ──────────────────────────────────

router.post('/', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const parsed = provisionModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const adminUserId = req.tenantContext!.userId;
    const {
      targetTenantId,
      displayName,
      integrationType,
      modelId,
      provider,
      endpointUrl,
      providerStructure,
      temperature,
      maxTokens,
      hyperParameters,
      supportsTools,
      supportsStreaming,
      supportsVision,
      supportsStructured,
      capabilities,
      realtimeConfig,
      useResponsesApi,
      useStreaming,
      tier,
      isDefault,
      provisioningNote,
      connection,
    } = parsed.data;

    const type = integrationType || 'easy';
    if (type === 'easy' && !modelId) {
      res.status(400).json({ success: false, error: 'Easy integration requires modelId' });
      return;
    }
    if (type === 'api' && !endpointUrl) {
      res.status(400).json({ success: false, error: 'API integration requires endpointUrl' });
      return;
    }

    const targetTier = tier ?? DEFAULT_TENANT_MODEL_TIER;
    if (isDefault === true) {
      const { TenantModel } = await import('@agent-platform/database/models');
      await TenantModel.updateMany(
        { tenantId: targetTenantId, tier: targetTier, isDefault: true },
        { $set: { isDefault: false } },
      );
    }

    const now = new Date();
    const model = await createTenantModel({
      tenantId: targetTenantId,
      displayName,
      integrationType: type,
      modelId: modelId || null,
      provider: provider || null,
      endpointUrl: endpointUrl || null,
      providerStructure: providerStructure || null,
      temperature: temperature ?? 0.7,
      maxTokens: maxTokens ?? 4096,
      hyperParameters: hyperParameters ?? {},
      supportsTools: supportsTools ?? true,
      supportsStreaming: supportsStreaming ?? true,
      useResponsesApi: useResponsesApi ?? null,
      useStreaming: useStreaming ?? null,
      supportsVision: supportsVision ?? false,
      supportsStructured: supportsStructured ?? false,
      capabilities: capabilities || ['text'],
      realtimeConfig: realtimeConfig || null,
      tier: targetTier,
      isDefault: isDefault ?? false,
      createdBy: adminUserId,
      provisionedBy: adminUserId,
      provisionedAt: now,
      provisioningNote: provisioningNote || null,
    });

    // Create initial connection if provided — create an LLMCredential first,
    // then link it to the connection via credentialId.
    if (connection) {
      try {
        const credentialId = await createCredentialForTenant({
          tenantId: targetTenantId,
          provider: provider || 'unknown',
          name: connection.credentialName,
          apiKey: connection.apiKey,
          authType: connection.authType || 'api_key',
          authConfig: connection.authConfig,
        });
        await createTenantModelConnection({
          tenantModelId: model.id ?? model._id,
          tenantId: targetTenantId,
          credentialId,
          isPrimary: true,
          createdBy: adminUserId,
        });
      } catch (credErr: unknown) {
        // Model created but connection failed — still report success with warning
        const errMsg = credErr instanceof Error ? credErr.message : String(credErr);
        log.warn('Model created but initial connection failed', {
          error: errMsg,
          requestId,
        });
      }
    }

    log.info('Model provisioned for tenant', {
      modelId: model.id ?? model._id,
      targetTenantId,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:provision-model',
      userId: adminUserId,
      tenantId: targetTenantId,
      metadata: {
        modelId: model.id ?? model._id,
        displayName,
        provider,
        hasConnection: !!connection,
        requestId,
      },
    });

    invalidateModelResolutionCaches(targetTenantId);

    // Re-fetch to include connection count
    const full = await findTenantModelWithConnectionsAdmin(model.id ?? model._id);
    res.status(201).json({ success: true, model: sanitizeModel(full || model) });
  } catch (error: unknown) {
    if (
      error != null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as any).code === 11000
    ) {
      res.status(409).json({
        success: false,
        error: 'A model with this display name already exists for this tenant',
      });
      return;
    }
    log.error('Failed to provision model', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    res.status(500).json({ success: false, error: 'Failed to provision model' });
  }
});

// ─── GET /:id — Get provisioned model detail ─────────────────────────────

router.get('/:id', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const model = await findTenantModelWithConnectionsAdmin(req.params.id);
    if (!model || !model.provisionedBy) {
      res.status(404).json({ success: false, error: 'Provisioned model not found' });
      return;
    }

    // Include sanitized connections (no API keys)
    const connections = (model.connections || []).map(sanitizeConnection);

    res.json({ success: true, model: sanitizeModel(model), connections });
  } catch (error: unknown) {
    log.error('Failed to get provisioned model', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    res.status(500).json({ success: false, error: 'Failed to get provisioned model' });
  }
});

// ─── PATCH /:id — Update provisioned model ───────────────────────────────

router.patch('/:id', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const parsed = updateProvisionedModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const existing = await findTenantModelAdmin(req.params.id);
    if (!existing || !existing.provisionedBy) {
      res.status(404).json({ success: false, error: 'Provisioned model not found' });
      return;
    }

    const adminUserId = req.tenantContext!.userId;
    const data: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(parsed.data)) {
      if (val !== undefined) data[key] = val;
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }

    const targetTier =
      typeof data.tier === 'string'
        ? data.tier
        : typeof existing.tier === 'string'
          ? existing.tier
          : DEFAULT_TENANT_MODEL_TIER;
    const remainsDefault = data.isDefault !== false && existing.isDefault === true;
    if (data.isDefault === true || (data.tier !== undefined && remainsDefault)) {
      const { TenantModel } = await import('@agent-platform/database/models');
      await TenantModel.updateMany(
        {
          _id: { $ne: req.params.id },
          tenantId: existing.tenantId,
          tier: targetTier,
          isDefault: true,
        },
        { $set: { isDefault: false } },
      );
    }

    const updated = await updateTenantModelAdmin(req.params.id, data);

    log.info('Provisioned model updated', { id: req.params.id, requestId });
    writeAuditLog({
      action: 'platform-admin:update-model',
      userId: adminUserId,
      tenantId: existing.tenantId,
      metadata: { modelId: req.params.id, fields: Object.keys(data), requestId },
    });

    invalidateModelResolutionCaches(existing.tenantId);
    res.json({ success: true, model: sanitizeModel(updated) });
  } catch (error: unknown) {
    if (
      error != null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as any).code === 11000
    ) {
      res.status(409).json({ success: false, error: 'Duplicate display name for this tenant' });
      return;
    }
    log.error('Failed to update provisioned model', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    res.status(500).json({ success: false, error: 'Failed to update provisioned model' });
  }
});

// ─── POST /:id/connections — Add connection ──────────────────────────────

router.post('/:id/connections', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const parsed = createConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const model = await findTenantModelAdmin(req.params.id);
    if (!model || !model.provisionedBy) {
      res.status(404).json({ success: false, error: 'Provisioned model not found' });
      return;
    }

    const adminUserId = req.tenantContext!.userId;

    // Create an LLMCredential for this API key, then link it to the connection
    const credentialId = await createCredentialForTenant({
      tenantId: model.tenantId,
      provider: model.provider || 'unknown',
      name: parsed.data.credentialName,
      apiKey: parsed.data.apiKey,
      authType: parsed.data.authType || 'api_key',
      authConfig: parsed.data.authConfig,
    });

    const connection = await createTenantModelConnection({
      tenantModelId: req.params.id,
      tenantId: model.tenantId,
      credentialId,
      isPrimary: parsed.data.isPrimary ?? false,
      createdBy: adminUserId,
    });

    log.info('Connection added to provisioned model', { modelId: req.params.id, requestId });
    writeAuditLog({
      action: 'platform-admin:add-connection',
      userId: adminUserId,
      tenantId: model.tenantId,
      metadata: {
        modelId: req.params.id,
        connectionId: connection.id,
        credentialId,
        requestId,
      },
    });

    invalidateModelResolutionCaches(model.tenantId);
    res.status(201).json({ success: true, connection: sanitizeConnection(connection) });
  } catch (error: unknown) {
    log.error('Failed to add connection', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    res.status(500).json({ success: false, error: 'Failed to add connection' });
  }
});

// ─── PATCH /:id/connections/:connId — Update connection (rotate key) ─────

router.patch('/:id/connections/:connId', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const parsed = updateConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const model = await findTenantModelAdmin(req.params.id);
    if (!model || !model.provisionedBy) {
      res.status(404).json({ success: false, error: 'Provisioned model not found' });
      return;
    }

    const existing = await findTenantModelConnectionById(req.params.connId, model.tenantId);
    if (!existing || existing.tenantModelId !== req.params.id) {
      res.status(404).json({ success: false, error: 'Connection not found' });
      return;
    }

    const adminUserId = req.tenantContext!.userId;
    const data: Record<string, unknown> = {};

    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
    if (parsed.data.isPrimary !== undefined) data.isPrimary = parsed.data.isPrimary;

    // Key rotation: update the linked LLMCredential's encryptedApiKey.
    // The encryption plugin auto-encrypts on save.
    let hasKeyRotation = false;
    if (parsed.data.apiKey) {
      const { LLMCredential } = await import('@agent-platform/database/models');

      if (existing.credentialId) {
        // Update existing credential — use findOne + save() so encryption plugin fires
        const credential = await LLMCredential.findOne({
          _id: existing.credentialId,
          tenantId: model.tenantId,
        });
        if (credential) {
          credential.encryptedApiKey = parsed.data.apiKey;
          if (parsed.data.authType) credential.authType = parsed.data.authType;
          await credential.save();
          hasKeyRotation = true;
        } else {
          log.warn('Credential not found for key rotation, creating new credential', {
            credentialId: existing.credentialId,
            requestId,
          });
          // Credential was deleted — create a new one
          const newCredentialId = await createCredentialForTenant({
            tenantId: model.tenantId,
            provider: model.provider || 'unknown',
            name: `rotated-${req.params.connId}`,
            apiKey: parsed.data.apiKey,
            authType: parsed.data.authType || 'api_key',
          });
          data.credentialId = newCredentialId;
          hasKeyRotation = true;
        }
      } else {
        // Connection has no credential — create one
        const newCredentialId = await createCredentialForTenant({
          tenantId: model.tenantId,
          provider: model.provider || 'unknown',
          name: `admin-${req.params.connId}`,
          apiKey: parsed.data.apiKey,
          authType: parsed.data.authType || 'api_key',
        });
        data.credentialId = newCredentialId;
        hasKeyRotation = true;
      }
    } else if (parsed.data.authType !== undefined && existing.credentialId) {
      // Update authType on credential without changing the key
      const { LLMCredential } = await import('@agent-platform/database/models');
      const credential = await LLMCredential.findOne({
        _id: existing.credentialId,
        tenantId: model.tenantId,
      });
      if (credential) {
        credential.authType = parsed.data.authType;
        await credential.save();
      }
    }

    if (Object.keys(data).length > 0) {
      await updateTenantModelConnection(req.params.connId, data, model.tenantId);
    }

    // Re-fetch the updated connection
    const updated = await findTenantModelConnectionById(req.params.connId, model.tenantId);
    if (!updated) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connection not found after update' },
      });
      return;
    }

    log.info('Provisioned model connection updated', {
      modelId: req.params.id,
      connId: req.params.connId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:update-connection',
      userId: adminUserId,
      tenantId: model.tenantId,
      metadata: {
        modelId: req.params.id,
        connectionId: req.params.connId,
        fields: Object.keys(data),
        hasKeyRotation,
        requestId,
      },
    });

    invalidateModelResolutionCaches(model.tenantId);
    res.json({ success: true, connection: sanitizeConnection(updated) });
  } catch (error: unknown) {
    log.error('Failed to update connection', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    res.status(500).json({ success: false, error: 'Failed to update connection' });
  }
});

// ─── DELETE /:id/connections/:connId — Remove connection ─────────────────

router.delete('/:id/connections/:connId', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const model = await findTenantModelAdmin(req.params.id);
    if (!model || !model.provisionedBy) {
      res.status(404).json({ success: false, error: 'Provisioned model not found' });
      return;
    }

    const existing = await findTenantModelConnectionById(req.params.connId, model.tenantId);
    if (!existing || existing.tenantModelId !== req.params.id) {
      res.status(404).json({ success: false, error: 'Connection not found' });
      return;
    }

    const adminUserId = req.tenantContext!.userId;

    // Also deactivate the linked credential so it cannot be reused
    if (existing.credentialId) {
      const { LLMCredential } = await import('@agent-platform/database/models');
      await LLMCredential.updateOne(
        { _id: existing.credentialId, tenantId: model.tenantId },
        { $set: { isActive: false } },
      );
    }

    await deleteTenantModelConnection(req.params.connId, model.tenantId);

    log.info('Provisioned model connection deleted', {
      modelId: req.params.id,
      connId: req.params.connId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:delete-connection',
      userId: adminUserId,
      tenantId: model.tenantId,
      metadata: { modelId: req.params.id, connectionId: req.params.connId, requestId },
    });

    invalidateModelResolutionCaches(model.tenantId);
    res.json({ success: true, deleted: req.params.connId });
  } catch (error: unknown) {
    log.error('Failed to delete connection', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    res.status(500).json({ success: false, error: 'Failed to delete connection' });
  }
});

// ─── POST /:id/revoke — Soft-revoke provisioned model ───────────────────

router.post('/:id/revoke', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const model = await findTenantModelAdmin(req.params.id);
    if (!model || !model.provisionedBy) {
      res.status(404).json({ success: false, error: 'Provisioned model not found' });
      return;
    }

    const adminUserId = req.tenantContext!.userId;
    await updateTenantModelAdmin(req.params.id, { isActive: false, inferenceEnabled: false });

    log.info('Provisioned model revoked', { id: req.params.id, requestId });
    writeAuditLog({
      action: 'platform-admin:revoke-model',
      userId: adminUserId,
      tenantId: model.tenantId,
      metadata: { modelId: req.params.id, displayName: model.displayName, requestId },
    });

    invalidateModelResolutionCaches(model.tenantId);
    res.json({ success: true, revoked: req.params.id });
  } catch (error: unknown) {
    log.error('Failed to revoke model', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    res.status(500).json({ success: false, error: 'Failed to revoke model' });
  }
});

// ─── POST /:id/connections/:connId/validate — Validate connection ────────

router.post('/:id/connections/:connId/validate', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const model = await findTenantModelAdmin(req.params.id);
    if (!model || !model.provisionedBy) {
      res.status(404).json({ success: false, error: 'Provisioned model not found' });
      return;
    }

    const connection = await findTenantModelConnectionById(req.params.connId, model.tenantId);
    if (!connection || connection.tenantModelId !== req.params.id) {
      res.status(404).json({ success: false, error: 'Connection not found' });
      return;
    }

    // Look up the credential linked to this connection. Most reads are already
    // plaintext via the Mongoose plugin, but failed plugin decryptions can leave
    // ciphertext behind, so validation must still resolve a safe plaintext value.
    const { LLMCredential } = await import('@agent-platform/database/models');
    const credential = await LLMCredential.findOne({
      _id: connection.credentialId,
      tenantId: model.tenantId,
    });
    if (!credential || !credential.encryptedApiKey) {
      res.json({
        success: true,
        valid: false,
        message: 'No API key configured for this connection',
      });
      return;
    }

    const provider = model.provider || 'unknown';
    let valid: boolean | null = null;
    let message = '';

    try {
      const { checkConnectionHealth, resolveConnectionHealthInputFromCredential } =
        await import('../services/llm/model-health-service.js');

      const healthInput = await resolveConnectionHealthInputFromCredential(
        credential,
        model.tenantId,
        provider,
        model.modelId || 'test',
      );

      if (!healthInput) {
        valid = false;
        message = 'No API key configured for this connection';
      } else {
        const result = await checkConnectionHealth(healthInput);
        valid = result.valid;
        message = result.message;
      }
    } catch (err: unknown) {
      valid = false;
      message = 'Credential could not be decrypted';
    }

    const adminUserId = req.tenantContext!.userId;
    writeAuditLog({
      action: 'platform-admin:validate-connection',
      userId: adminUserId,
      tenantId: model.tenantId,
      metadata: {
        modelId: req.params.id,
        connectionId: req.params.connId,
        valid,
        provider,
        requestId,
      },
    });

    res.json({ success: true, valid, message });
  } catch (error: unknown) {
    log.error('Failed to validate connection', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    res.status(500).json({ success: false, error: 'Failed to validate connection' });
  }
});

export default router;
