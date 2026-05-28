/**
 * Tenant Model CRUD Route
 *
 * Manages tenant-level model definitions and their connections (credentials).
 * All routes require authenticated tenant context + OWNER or ADMIN role.
 *
 * Mount: /api/tenants/:tenantId/models
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { isTenantEncryptionReady } from '@agent-platform/shared/encryption';
import type { ConnectionHealthInput } from '../services/llm/model-health-service.js';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { getRequestAccessDeniedReporter, requirePermission } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { invalidateModelResolutionCaches } from '../services/llm/model-cache-invalidation.js';
import { syncEmbeddingModelToPipelines } from '../services/embedding-config-sync.js';
import { assertUrlSafeForSSRF, getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { MODEL_ROUTING_TIERS } from '@agent-platform/shared-kernel/model-routing';
import {
  findTenantModel,
  findTenantModelWithConnections,
  listTenantModels,
  countTenantModels,
  createTenantModel,
  updateTenantModel,
  deleteTenantModel,
  updateTenantModelInference,
  findTenantModelConnections,
  createTenantModelConnection,
  findTenantModelConnectionById,
  updateTenantModelConnection,
  deleteTenantModelConnection,
  setConnectionPrimary,
  findProjectsUsingTenantModel,
} from '../repos/tenant-model-repo.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { findCredentialById } from '../repos/llm-resolution-repo.js';

const log = createLogger('tenant-models-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/tenants/:tenantId/models',
  tags: ['Tenant Models'],
});
const router: RouterType = openapi.router;

const MAX_FIELD_LENGTH = 256;
const MAX_JSON_LENGTH = 16384;

/** Headers that must not be set via customHeaders (prevent request smuggling/spoofing). */
const BLOCKED_HEADERS = new Set([
  'host',
  'authorization',
  'cookie',
  'set-cookie',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'transfer-encoding',
  'content-length',
  'proxy-authorization',
  'proxy-connection',
]);

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const tenantModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  integrationType: z.string(),
  modelId: z.string().nullable(),
  provider: z.string().nullable(),
  endpointUrl: z.string().nullable(),
  providerStructure: z.string().nullable(),
  customEndpoint: z.string().nullable(),
  temperature: z.number(),
  maxTokens: z.number(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  supportsTools: z.boolean(),
  supportsStreaming: z.boolean(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
  supportsVision: z.boolean(),
  supportsStructured: z.boolean(),
  tier: z.enum(MODEL_ROUTING_TIERS),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  inferenceEnabled: z.boolean(),
  createdBy: z.string().nullable(),
  provisionedBy: z.string().nullable().optional(),
  provisionedAt: z.date().or(z.string()).nullable().optional(),
  provisioningNote: z.string().nullable().optional(),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()),
});

const tenantModelWithConnectionsSchema = tenantModelSchema.extend({
  _count: z
    .object({
      projectBindings: z.number(),
    })
    .optional(),
});

const connectionSchema = z.object({
  id: z.string(),
  credentialId: z.string().nullable(),
  isActive: z.boolean(),
  isPrimary: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()),
});

const listModelsQuerySchema = z.object({
  tier: z.enum(MODEL_ROUTING_TIERS).optional(),
  provider: z.string().optional(),
  integrationType: z.string().optional(),
  isActive: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

const VALID_CAPABILITIES = [
  'text',
  'tools',
  'streaming',
  'vision',
  'realtime_voice',
  'embedding',
] as const;

const createModelRequestSchema = z.object({
  displayName: z.string().max(MAX_FIELD_LENGTH),
  integrationType: z.string().optional(),
  modelId: z.string().optional(),
  provider: z.string().optional(),
  endpointUrl: z.string().optional(),
  providerStructure: z.string().optional(),
  requestTemplate: z.string().or(z.record(z.unknown())).optional(),
  responseMapping: z.string().or(z.record(z.unknown())).optional(),
  customHeaders: z.string().or(z.record(z.string())).optional(),
  customEndpoint: z.string().optional(),
  gatewayConfig: z.string().or(z.record(z.unknown())).optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  supportsTools: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsStructured: z.boolean().optional(),
  capabilities: z.array(z.enum(VALID_CAPABILITIES)).optional(),
  realtimeConfig: z.record(z.unknown()).optional(),
  tier: z.enum(MODEL_ROUTING_TIERS).optional(),
  isDefault: z.boolean().optional(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
});

const updateModelRequestSchema = z.object({
  displayName: z.string().max(MAX_FIELD_LENGTH).optional(),
  integrationType: z.string().optional(),
  modelId: z.string().optional(),
  provider: z.string().optional(),
  endpointUrl: z.string().optional(),
  providerStructure: z.string().optional(),
  requestTemplate: z.string().or(z.record(z.unknown())).optional(),
  responseMapping: z.string().or(z.record(z.unknown())).optional(),
  customHeaders: z.string().or(z.record(z.string())).optional(),
  customEndpoint: z.string().optional(),
  gatewayConfig: z.string().or(z.record(z.unknown())).optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  supportsTools: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsStructured: z.boolean().optional(),
  capabilities: z.array(z.enum(VALID_CAPABILITIES)).optional(),
  realtimeConfig: z.record(z.unknown()).nullable().optional(),
  tier: z.enum(MODEL_ROUTING_TIERS).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  inferenceEnabled: z.boolean().optional(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
});

const toggleInferenceRequestSchema = z.object({
  inferenceEnabled: z.boolean(),
});

const createConnectionRequestSchema = z.object({
  credentialId: z.string(),
  connectionType: z.enum(['http', 'websocket']).optional(),
  isPrimary: z.boolean().optional(),
});

const updateConnectionRequestSchema = z.object({
  credentialId: z.string().optional(),
  connectionType: z.enum(['http', 'websocket']).optional(),
  isActive: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
});

// =============================================================================
// TENANT ISOLATION GUARD
// =============================================================================

function requireTenantAccess(req: any, res: any): string | null {
  const contextTenantId = req.tenantContext?.tenantId;
  const paramTenantId = req.params.tenantId;

  // SECURITY: Always require an authenticated tenant context.
  // Never trust the URL param alone — it must match the auth context.
  if (!contextTenantId) {
    getRequestAccessDeniedReporter(req)({
      layer: 'require_tenant_context',
      scope: 'tenant',
      reasonCode: 'TENANT_CONTEXT_REQUIRED',
      reason: 'Tenant access denied',
      concealAsNotFound: false,
      statusCode: 403,
      resourceType: 'tenant',
      resourceId: paramTenantId,
    });
    res.status(403).json({ success: false, error: 'Tenant access denied' });
    return null;
  }

  if (paramTenantId && paramTenantId !== contextTenantId) {
    getRequestAccessDeniedReporter(req)({
      layer: 'require_tenant_context',
      scope: 'tenant',
      reasonCode: 'TENANT_SCOPE_MISMATCH',
      reason: 'Tenant not found',
      concealAsNotFound: true,
      statusCode: 404,
      tenantId: contextTenantId,
      resourceType: 'tenant',
      resourceId: paramTenantId,
      metadata: {
        authenticatedTenantId: contextTenantId,
      },
    });
    res.status(404).json({ success: false, error: 'Tenant not found' });
    return null;
  }

  return contextTenantId;
}

async function requireTenantCredential(
  tenantId: string,
  credentialId: string,
  actorUserId?: string,
): Promise<any | null> {
  return findCredentialById(credentialId, tenantId, {
    actorUserId,
  });
}

function getCredentialActorUserId(req: {
  tenantContext?: { authType?: string; userId?: string };
}): string | undefined {
  const authType = req.tenantContext?.authType;
  if (authType && authType !== 'user') {
    return undefined;
  }
  return req.tenantContext?.userId;
}

/**
 * Validate that a URL is safe for use as a model endpoint.
 * Uses the shared-kernel SSRF validator which also handles octal/decimal IP
 * encoding, userinfo bypass, and other SSRF evasion techniques.
 */
function isValidEndpointUrl(urlStr: string): boolean {
  try {
    assertUrlSafeForSSRF(urlStr, getDevSSRFOptions());
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate customHeaders JSON to block dangerous headers.
 */
function validateCustomHeaders(headers: Record<string, string>): string | null {
  for (const key of Object.keys(headers)) {
    if (BLOCKED_HEADERS.has(key.toLowerCase())) {
      return `Header '${key}' is not allowed in customHeaders`;
    }
  }
  return null;
}

function formatValidationError(error: z.ZodError): string {
  const details = error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
  return details ? `Invalid request: ${details}` : 'Invalid request';
}

// =============================================================================
// MODEL ROUTES
// =============================================================================

/**
 * GET / — List tenant models
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List tenant models',
    description:
      'List all models for the authenticated tenant with optional filtering by tier, provider, integration type, and active status. Supports pagination.',
    query: listModelsQuerySchema,
    response: z.object({
      success: z.literal(true),
      models: z.array(tenantModelSchema),
      pagination: z.object({
        page: z.number(),
        limit: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    }),
  },
  requirePermission('credential:read'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const { tier, provider, integrationType, isActive } = req.query;

      const where: Record<string, unknown> = { tenantId };
      if (tier) where.tier = String(tier);
      if (provider) where.provider = String(provider);
      if (integrationType) where.integrationType = String(integrationType);
      if (isActive !== undefined) where.isActive = isActive === 'true';

      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
      const skip = (page - 1) * limit;

      const select = {
        id: true,
        displayName: true,
        integrationType: true,
        modelId: true,
        provider: true,
        endpointUrl: true,
        providerStructure: true,
        customEndpoint: true,
        temperature: true,
        maxTokens: true,
        hyperParameters: true,
        supportsTools: true,
        supportsStreaming: true,
        useResponsesApi: true,
        useStreaming: true,
        supportsVision: true,
        supportsStructured: true,
        capabilities: true,
        realtimeConfig: true,
        tier: true,
        isDefault: true,
        isActive: true,
        inferenceEnabled: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        connections: true,
      };

      const [models, total] = await Promise.all([
        listTenantModels(where, { select, skip, take: limit }),
        countTenantModels(where),
      ]);

      // Compute _count.connections from embedded array — only count active connections
      // that have a credentialId (i.e. actually wired to a credential with an API key).
      const modelsWithCount = models.map((m: any) => {
        const { connections, ...rest } = m;
        const activeWithCredential = Array.isArray(connections)
          ? connections.filter((c: any) => c.isActive && c.credentialId)
          : [];
        return {
          ...rest,
          _count: { connections: activeWithCredential.length },
        };
      });

      res.json({
        success: true,
        models: modelsWithCount,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (err: unknown) {
      log.error('Failed to list tenant models', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'LIST_MODELS_FAILED', message: 'Failed to list tenant models' },
      });
    }
  },
);

/**
 * POST / — Add a tenant model
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create a tenant model',
    description:
      'Create a new tenant-specific model definition with custom settings. Supports both easy integration (modelId) and API integration (endpointUrl) types. Requires credential:write permission.',
    body: createModelRequestSchema,
    response: z.object({
      success: z.literal(true),
      model: tenantModelSchema,
    }),
    successStatus: 201,
  },
  requirePermission('credential:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const userId = req.tenantContext!.userId;
      const parsed = createModelRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: formatValidationError(parsed.error),
          details: parsed.error.issues,
        });
        return;
      }

      const {
        displayName,
        integrationType,
        modelId,
        provider,
        endpointUrl,
        providerStructure,
        requestTemplate,
        responseMapping,
        customHeaders,
        customEndpoint,
        gatewayConfig,
        temperature,
        maxTokens,
        hyperParameters,
        supportsTools,
        supportsStreaming,
        supportsVision,
        supportsStructured,
        capabilities,
        realtimeConfig,
        tier,
        isDefault,
        useResponsesApi,
        useStreaming,
      } = parsed.data;

      if (!displayName) {
        res.status(400).json({ success: false, error: 'Missing required field: displayName' });
        return;
      }
      if (String(displayName).length > MAX_FIELD_LENGTH) {
        res.status(400).json({
          success: false,
          error: `displayName exceeds maximum length of ${MAX_FIELD_LENGTH}`,
        });
        return;
      }

      const type = integrationType || 'easy';
      if (type === 'easy' && !modelId) {
        res.status(400).json({ success: false, error: 'Easy integration requires modelId' });
        return;
      }
      if (type === 'api' && !endpointUrl) {
        res.status(400).json({ success: false, error: 'API integration requires endpointUrl' });
        return;
      }

      // Validate JSON field lengths
      for (const [field, val] of Object.entries({
        requestTemplate,
        responseMapping,
        customHeaders,
        gatewayConfig,
      })) {
        if (val && typeof val === 'string' && val.length > MAX_JSON_LENGTH) {
          res.status(400).json({ success: false, error: `${field} exceeds maximum length` });
          return;
        }
      }

      // Validate endpoint URLs (SSRF protection)
      if (endpointUrl && !isValidEndpointUrl(endpointUrl)) {
        res.status(400).json({
          success: false,
          error: 'Invalid endpointUrl: must be a valid HTTPS URL pointing to a public host',
        });
        return;
      }
      if (customEndpoint && !isValidEndpointUrl(customEndpoint)) {
        res.status(400).json({
          success: false,
          error: 'Invalid customEndpoint: must be a valid HTTPS URL pointing to a public host',
        });
        return;
      }

      // Validate customHeaders (block dangerous headers)
      if (customHeaders && typeof customHeaders === 'object') {
        const headerError = validateCustomHeaders(customHeaders);
        if (headerError) {
          res.status(400).json({ success: false, error: headerError });
          return;
        }
      }

      const targetTier = tier || 'balanced';
      if (isDefault === true) {
        const { TenantModel } = await import('@agent-platform/database/models');
        await TenantModel.updateMany(
          { tenantId, tier: targetTier, isDefault: true },
          { $set: { isDefault: false } },
        );
      }

      const model = await createTenantModel({
        tenantId,
        displayName,
        integrationType: type,
        modelId: modelId || null,
        provider: provider || null,
        endpointUrl: endpointUrl || null,
        providerStructure: providerStructure || null,
        requestTemplate: requestTemplate || null,
        responseMapping: responseMapping || null,
        customHeaders:
          typeof customHeaders === 'object' ? JSON.stringify(customHeaders) : customHeaders || null,
        customEndpoint: customEndpoint || null,
        gatewayConfig:
          typeof gatewayConfig === 'object' ? JSON.stringify(gatewayConfig) : gatewayConfig || null,
        temperature: temperature ?? 0.7,
        maxTokens: maxTokens ?? 4096,
        hyperParameters: hyperParameters ?? {},
        supportsTools: supportsTools ?? true,
        supportsStreaming: supportsStreaming ?? true,
        supportsVision: supportsVision ?? false,
        supportsStructured: supportsStructured ?? false,
        capabilities: capabilities || ['text'],
        realtimeConfig: realtimeConfig || null,
        tier: targetTier,
        isDefault: isDefault ?? false,
        useResponsesApi: useResponsesApi ?? null,
        useStreaming: useStreaming ?? null,
        createdBy: userId,
      });

      log.info('Tenant model created', { id: model.id, displayName, tenantId, requestId });
      writeAuditLog({
        action: 'tenant-model:create',
        tenantId,
        userId,
        metadata: { modelId: model.id, displayName, requestId },
      });

      invalidateModelResolutionCaches(tenantId);

      res.status(201).json({ success: true, model });
    } catch (err: unknown) {
      const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
      if (errObj.code === 11000) {
        res.status(409).json({
          success: false,
          error: {
            code: 'DUPLICATE_MODEL',
            message: 'A model with this display name already exists for this tenant',
          },
        });
        return;
      }
      log.error('Failed to create tenant model', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'CREATE_MODEL_FAILED', message: 'Failed to create tenant model' },
      });
    }
  },
);

/**
 * GET /:id — Get model detail
 */
openapi.route(
  'get',
  '/:id',
  {
    summary: 'Get tenant model details',
    description:
      'Get detailed information about a specific tenant model, including connection count and project bindings.',
    params: z.object({
      tenantId: z.string(),
      id: z.string(),
    }),
    response: z.object({
      success: z.literal(true),
      model: tenantModelWithConnectionsSchema,
    }),
  },
  requirePermission('credential:read'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const model = await findTenantModelWithConnections(req.params.id, tenantId);

      if (!model) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      res.json({ success: true, model });
    } catch (err: unknown) {
      log.error('Failed to get tenant model', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'GET_MODEL_FAILED', message: 'Failed to get tenant model' },
      });
    }
  },
);

/**
 * PATCH /:id — Update model
 */
openapi.route(
  'patch',
  '/:id',
  {
    summary: 'Update tenant model',
    description:
      'Update tenant model configuration. Supports partial updates of display name, integration settings, model parameters, and feature flags. URL fields are validated for SSRF protection.',
    params: z.object({
      tenantId: z.string(),
      id: z.string(),
    }),
    body: updateModelRequestSchema,
    response: z.object({
      success: z.literal(true),
      model: tenantModelSchema,
    }),
  },
  requirePermission('credential:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();

    // Log ALL tenant model update requests to debug embedding sync
    log.info('PATCH /tenant-models/:id received', {
      modelId: req.params.id,
      bodyKeys: Object.keys(req.body || {}),
      body: req.body,
      requestId,
    });

    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const userId = req.tenantContext!.userId;
      const parsed = updateModelRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: formatValidationError(parsed.error),
          details: parsed.error.issues,
        });
        return;
      }
      const body = parsed.data;

      const existing = await findTenantModel(req.params.id, tenantId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      // Guard: platform-provisioned models have restricted editable fields
      const isProvisioned = !!existing.provisionedBy;
      const PROVISIONED_ALLOWED_FIELDS = [
        'temperature',
        'maxTokens',
        'hyperParameters',
        'useResponsesApi',
        'useStreaming',
        'supportsTools',
        'supportsStreaming',
        'supportsVision',
        'capabilities',
        'tier',
        'isDefault',
      ];

      if (isProvisioned) {
        const requestedFields = Object.keys(req.body).filter((k) => req.body[k] !== undefined);
        const blockedFields = requestedFields.filter(
          (f) => !PROVISIONED_ALLOWED_FIELDS.includes(f),
        );
        if (blockedFields.length > 0) {
          res.status(403).json({
            success: false,
            error: `Cannot modify fields [${blockedFields.join(', ')}] on a platform-provisioned model. Only runtime settings, feature flags, tier, and default status can be changed.`,
          });
          return;
        }
      }

      // Build update data from allowed fields
      const allowedFields = isProvisioned
        ? PROVISIONED_ALLOWED_FIELDS
        : [
            'displayName',
            'integrationType',
            'modelId',
            'provider',
            'endpointUrl',
            'providerStructure',
            'requestTemplate',
            'responseMapping',
            'customHeaders',
            'customEndpoint',
            'gatewayConfig',
            'temperature',
            'maxTokens',
            'hyperParameters',
            'supportsTools',
            'supportsStreaming',
            'supportsVision',
            'supportsStructured',
            'capabilities',
            'realtimeConfig',
            'tier',
            'isDefault',
            'isActive',
            'inferenceEnabled',
            'useResponsesApi',
            'useStreaming',
          ];

      // Validate URL fields before building update data
      if (body.endpointUrl && !isValidEndpointUrl(body.endpointUrl)) {
        res.status(400).json({
          success: false,
          error: 'Invalid endpointUrl: must be a valid HTTPS URL pointing to a public host',
        });
        return;
      }
      if (body.customEndpoint && !isValidEndpointUrl(body.customEndpoint)) {
        res.status(400).json({
          success: false,
          error: 'Invalid customEndpoint: must be a valid HTTPS URL pointing to a public host',
        });
        return;
      }
      if (body.customHeaders && typeof body.customHeaders === 'object') {
        const headerError = validateCustomHeaders(body.customHeaders);
        if (headerError) {
          res.status(400).json({ success: false, error: headerError });
          return;
        }
      }

      const data: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (body[field as keyof typeof body] !== undefined) {
          const val = body[field as keyof typeof body];
          if ((field === 'customHeaders' || field === 'gatewayConfig') && typeof val === 'object') {
            data[field] = JSON.stringify(val);
          } else {
            data[field] = val;
          }
        }
      }

      // If setting isDefault=true, unset other defaults for the same tier
      if (data.isDefault === true) {
        const tier = data.tier ?? existing.tier;
        const { TenantModel } = await import('@agent-platform/database/models');
        await TenantModel.updateMany(
          { tenantId, tier, isDefault: true, _id: { $ne: req.params.id } },
          { $set: { isDefault: false } },
        );
      }

      const updated = await updateTenantModel(req.params.id, data, tenantId);

      log.info('Tenant model updated', { id: req.params.id, tenantId, requestId });
      writeAuditLog({
        action: 'tenant-model:update',
        tenantId,
        userId,
        metadata: { modelId: req.params.id, fields: Object.keys(data), requestId },
      });

      // Invalidate cached model resolution since model config changed
      invalidateModelResolutionCaches(tenantId);

      // Log all updated fields for debugging
      log.info('Tenant model update data', {
        tenantId,
        tenantModelId: req.params.id,
        updatedFields: Object.keys(data),
        provider: data.provider,
        modelIdField: data.modelId,
        displayName: data.displayName,
      });

      // Sync embedding config to SearchAI pipelines if embedding-relevant fields changed
      const embeddingFieldsUpdated = data.provider !== undefined || data.modelId !== undefined;

      let pipelineSync:
        | {
            syncedCount?: number;
            failedCount?: number;
            errors?: Array<{ pipelineId: string; error: string }>;
          }
        | undefined;

      if (embeddingFieldsUpdated) {
        log.info('Embedding-relevant fields updated, syncing to SearchAI pipelines', {
          tenantId,
          modelId: req.params.id,
          updatedFields: Object.keys(data),
        });

        const syncResult = await syncEmbeddingModelToPipelines(tenantId, req.params.id, {
          provider: data.provider as string | undefined,
          modelId: data.modelId as string | undefined,
          dimensions: updated.dimensions as number | undefined,
        });

        pipelineSync = {
          syncedCount: syncResult.syncedCount,
          failedCount: syncResult.failedCount,
          errors: syncResult.errors.length > 0 ? syncResult.errors : undefined,
        };

        if (!syncResult.success) {
          log.warn('Pipeline sync had failures', {
            tenantId,
            modelId: req.params.id,
            failedCount: syncResult.failedCount,
            errors: syncResult.errors,
          });
        }
      }

      // Include impacted projects when disabling a model
      const isDisabling = data.isActive === false || data.inferenceEnabled === false;
      if (isDisabling) {
        const impactedProjects = await findProjectsUsingTenantModel(req.params.id, tenantId);
        res.json({ success: true, model: updated, impactedProjects, pipelineSync });
        return;
      }

      res.json({ success: true, model: updated, pipelineSync });
    } catch (err: unknown) {
      const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
      if (errObj.code === 11000) {
        res.status(409).json({
          success: false,
          error: { code: 'DUPLICATE_MODEL', message: 'Duplicate display name for this tenant' },
        });
        return;
      }
      log.error('Failed to update tenant model', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'UPDATE_MODEL_FAILED', message: 'Failed to update tenant model' },
      });
    }
  },
);

/**
 * DELETE /:id — Delete tenant model (hard delete)
 */
openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete tenant model',
    description:
      'Permanently delete a tenant model and cascade-clean any ModelConfig references. Prevents deletion if the model is platform-provisioned. Clears the provider cache after deletion.',
    params: z.object({
      tenantId: z.string(),
      id: z.string(),
    }),
    response: z.object({
      success: z.literal(true),
      deleted: z.string(),
    }),
  },
  requirePermission('credential:delete'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const userId = req.tenantContext!.userId;

      const existing = await findTenantModelWithConnections(req.params.id, tenantId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      // Guard: platform-provisioned models cannot be deleted by tenant
      if (existing.provisionedBy) {
        res.status(403).json({
          success: false,
          error: 'Cannot delete a platform-provisioned model. Contact your administrator.',
        });
        return;
      }

      // Guard: block deletion when projects still reference this model
      const impactedProjects = await findProjectsUsingTenantModel(req.params.id, tenantId);
      if (impactedProjects.length > 0) {
        res.status(409).json({
          success: false,
          error:
            'Cannot delete a model that is still used by projects. Remove it from all projects first.',
          impactedProjects,
        });
        return;
      }

      const deleted = await deleteTenantModel(req.params.id, tenantId);
      if (!deleted) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      log.info('Tenant model deleted', { id: req.params.id, tenantId, requestId });
      writeAuditLog({
        action: 'tenant-model:delete',
        tenantId,
        userId,
        metadata: { modelId: req.params.id, requestId },
      });

      // Invalidate cached providers since this model is no longer available
      invalidateModelResolutionCaches(tenantId);

      res.json({ success: true, deleted: req.params.id });
    } catch (err: unknown) {
      log.error('Failed to delete tenant model', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'DELETE_MODEL_FAILED', message: 'Failed to delete tenant model' },
      });
    }
  },
);

/**
 * POST /:id/toggle-inference — Set inferenceEnabled flag
 *
 * Body: { inferenceEnabled: boolean }
 *
 * Accepts an explicit value rather than blindly toggling,
 * which prevents TOCTOU race conditions with concurrent requests.
 */
openapi.route(
  'post',
  '/:id/toggle-inference',
  {
    summary: 'Toggle model inference setting',
    description:
      'Enable or disable inference for a tenant model. Accepts an explicit boolean value to prevent TOCTOU race conditions. Clears the provider cache after update.',
    params: z.object({
      tenantId: z.string(),
      id: z.string(),
    }),
    body: toggleInferenceRequestSchema,
    response: z.object({
      success: z.literal(true),
      model: z.object({
        id: z.string(),
        inferenceEnabled: z.boolean(),
      }),
    }),
  },
  requirePermission('credential:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const userId = req.tenantContext!.userId;

      // Require an explicit value to avoid TOCTOU race
      const { inferenceEnabled } = req.body;
      if (typeof inferenceEnabled !== 'boolean') {
        res
          .status(400)
          .json({ success: false, error: 'Missing required field: inferenceEnabled (boolean)' });
        return;
      }

      // Verify model exists and belongs to tenant before updating
      const existing = await findTenantModel(req.params.id, tenantId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      // Atomic update with tenant guard
      await updateTenantModelInference(req.params.id, tenantId, inferenceEnabled);

      log.info('Tenant model inference updated', {
        id: req.params.id,
        inferenceEnabled,
        requestId,
      });
      writeAuditLog({
        action: 'tenant-model:toggle-inference',
        tenantId,
        userId,
        metadata: { modelId: req.params.id, inferenceEnabled, requestId },
      });

      // Invalidate provider + resolution caches since model availability changed
      invalidateModelResolutionCaches(tenantId);

      // Include impacted projects when disabling inference
      if (!inferenceEnabled) {
        const impactedProjects = await findProjectsUsingTenantModel(req.params.id, tenantId);
        res.json({
          success: true,
          model: { id: req.params.id, inferenceEnabled },
          impactedProjects,
        });
        return;
      }

      res.json({ success: true, model: { id: req.params.id, inferenceEnabled } });
    } catch (err: unknown) {
      log.error('Failed to update inference setting', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'UPDATE_INFERENCE_FAILED', message: 'Failed to update inference setting' },
      });
    }
  },
);

/**
 * GET /:id/impact — Check downstream impact of disabling a model
 *
 * Returns the list of projects that reference this tenant model
 * via their ModelConfig entries. Used by the UI to warn admins
 * before disabling a model.
 */
openapi.route(
  'get',
  '/:id/impact',
  {
    summary: 'Check model disable impact',
    description:
      'Returns projects that would be affected if this model is disabled. Queries ModelConfig entries referencing this tenant model.',
    params: z.object({
      tenantId: z.string(),
      id: z.string(),
    }),
    response: z.object({
      success: z.literal(true),
      impactedProjects: z.array(
        z.object({
          projectId: z.string(),
          projectName: z.string(),
          tier: z.string(),
        }),
      ),
    }),
  },
  requirePermission('credential:read'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const existing = await findTenantModel(req.params.id, tenantId);
      if (!existing || existing.tenantId !== tenantId) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      const impactedProjects = await findProjectsUsingTenantModel(req.params.id, tenantId);

      res.json({ success: true, impactedProjects });
    } catch (err: unknown) {
      log.error('Failed to check model impact', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'CHECK_IMPACT_FAILED', message: 'Failed to check model impact' },
      });
    }
  },
);

// =============================================================================
// CONNECTION SUB-ROUTES
// =============================================================================

/**
 * GET /:modelId/connections — List connections
 */
openapi.route(
  'get',
  '/:modelId/connections',
  {
    summary: 'List model connections',
    description:
      'List all credential connections for a specific tenant model. Returns connection metadata without sensitive values.',
    params: z.object({
      tenantId: z.string(),
      modelId: z.string(),
    }),
    response: z.object({
      success: z.literal(true),
      connections: z.array(connectionSchema),
    }),
  },
  requirePermission('credential:read'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      // Verify model belongs to tenant (DB-level filter)
      const model = await findTenantModel(req.params.modelId, tenantId);
      if (!model) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      const connections = await findTenantModelConnections(req.params.modelId, {
        tenantId,
        select: {
          id: true,
          credentialId: true,
          connectionType: true,
          isActive: true,
          isPrimary: true,
          lastHealthCheck: true,
          healthStatus: true,
          healthMessage: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.json({ success: true, connections });
    } catch (err: unknown) {
      log.error('Failed to list connections', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'LIST_CONNECTIONS_FAILED', message: 'Failed to list connections' },
      });
    }
  },
);

/**
 * POST /:modelId/connections — Add connection
 */
openapi.route(
  'post',
  '/:modelId/connections',
  {
    summary: 'Create model connection',
    description:
      'Create a new credential connection for a tenant model. Supports API key encryption and primary connection designation. Clears the provider cache after creation.',
    params: z.object({
      tenantId: z.string(),
      modelId: z.string(),
    }),
    body: createConnectionRequestSchema,
    response: z.object({
      success: z.literal(true),
      connection: connectionSchema,
    }),
    successStatus: 201,
  },
  requirePermission('credential:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const userId = req.tenantContext!.userId;

      // Validate request body
      const parsed = createConnectionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        return;
      }

      // Verify model belongs to tenant (DB-level filter)
      const model = await findTenantModel(req.params.modelId, tenantId);
      if (!model) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      // Guard: platform-provisioned model connections managed by admin only
      if (model.provisionedBy) {
        res.status(403).json({
          success: false,
          error:
            'Cannot modify connections on a platform-provisioned model. Contact your administrator.',
        });
        return;
      }

      const { credentialId, isPrimary: requestedPrimary } = parsed.data;
      const credential = await requireTenantCredential(
        tenantId,
        credentialId,
        getCredentialActorUserId(req),
      );
      if (!credential) {
        res.status(404).json({ success: false, error: 'Credential not found' });
        return;
      }

      // Auto-promote to primary when this is the first connection on the model
      const existingConnections = model.connections || [];
      const hasPrimary = existingConnections.some((c: any) => c.isActive && c.isPrimary);
      const isPrimary = requestedPrimary ?? (existingConnections.length === 0 || !hasPrimary);

      const connectionData = {
        tenantModelId: req.params.modelId,
        tenantId,
        credentialId,
        connectionType: req.body.connectionType || 'http',
        isPrimary: isPrimary ?? false,
        createdBy: userId,
      };

      // If setting as primary, first un-primary existing connections atomically
      if (isPrimary) {
        // Create the connection first, then set it as primary
        const created = await createTenantModelConnection({ ...connectionData, isPrimary: false });
        await setConnectionPrimary(req.params.modelId, created.id, tenantId);
        // Re-fetch to get the updated isPrimary flag
        const connection = await findTenantModelConnectionById(created.id, tenantId);
        log.info('Connection created', {
          id: created.id,
          modelId: req.params.modelId,
          tenantId,
          requestId,
        });
        writeAuditLog({
          action: 'tenant-model-connection:create',
          tenantId,
          userId,
          metadata: { connectionId: created.id, modelId: req.params.modelId, requestId },
        });

        invalidateModelResolutionCaches(tenantId);

        res.status(201).json({
          success: true,
          connection: {
            id: connection.id,
            credentialId: connection.credentialId,
            isActive: connection.isActive,
            isPrimary: connection.isPrimary,
            createdAt: connection.createdAt,
          },
        });
        return;
      }

      const connection = await createTenantModelConnection(connectionData);

      log.info('Connection created', {
        id: connection.id,
        modelId: req.params.modelId,
        tenantId,
        requestId,
      });
      writeAuditLog({
        action: 'tenant-model-connection:create',
        tenantId,
        userId,
        metadata: { connectionId: connection.id, modelId: req.params.modelId, requestId },
      });

      // Invalidate cached LLM providers so new credential is picked up
      invalidateModelResolutionCaches(tenantId);

      res.status(201).json({
        success: true,
        connection: {
          id: connection.id,
          credentialId: connection.credentialId,
          isActive: connection.isActive,
          isPrimary: connection.isPrimary,
          createdAt: connection.createdAt,
        },
      });
    } catch (err: unknown) {
      const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
      if (errObj.code === 11000) {
        res.status(409).json({
          success: false,
          error: {
            code: 'DUPLICATE_CONNECTION',
            message: 'Connection name already exists for this model',
          },
        });
        return;
      }
      log.error('Failed to create connection', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'CREATE_CONNECTION_FAILED', message: 'Failed to create connection' },
      });
    }
  },
);

/**
 * PATCH /:modelId/connections/:connId — Update connection
 */
openapi.route(
  'patch',
  '/:modelId/connections/:connId',
  {
    summary: 'Update model connection',
    description:
      'Update a model connection. Supports updating connection name, credential ID, auth configuration, and primary status. API keys are re-encrypted if updated. Clears the provider cache if credential-related fields change.',
    params: z.object({
      tenantId: z.string(),
      modelId: z.string(),
      connId: z.string(),
    }),
    body: updateConnectionRequestSchema,
    response: z.object({
      success: z.literal(true),
      connection: connectionSchema,
    }),
  },
  requirePermission('credential:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const userId = req.tenantContext!.userId;

      // Verify model + connection belong to tenant (DB-level filter)
      const model = await findTenantModel(req.params.modelId, tenantId);
      if (!model) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      // Guard: platform-provisioned model connections managed by admin only
      if (model.provisionedBy) {
        res.status(403).json({
          success: false,
          error:
            'Cannot modify connections on a platform-provisioned model. Contact your administrator.',
        });
        return;
      }

      const existing = await findTenantModelConnectionById(req.params.connId, tenantId);
      if (!existing || existing.tenantModelId !== req.params.modelId) {
        res.status(404).json({ success: false, error: 'Connection not found' });
        return;
      }

      if (existing.credentialId) {
        const existingCredential = await requireTenantCredential(
          tenantId,
          existing.credentialId,
          getCredentialActorUserId(req),
        );
        if (!existingCredential) {
          res.status(404).json({ success: false, error: 'Credential not found' });
          return;
        }
      }

      const data: Record<string, unknown> = {};
      if (req.body.credentialId !== undefined) {
        const credential = await requireTenantCredential(
          tenantId,
          req.body.credentialId,
          getCredentialActorUserId(req),
        );
        if (!credential) {
          res.status(404).json({ success: false, error: 'Credential not found' });
          return;
        }
        data.credentialId = req.body.credentialId;
      }
      if (req.body.isActive !== undefined) data.isActive = req.body.isActive;

      const settingPrimary = !!req.body.isPrimary;

      // If setting as primary, atomically un-primary others first
      if (settingPrimary) {
        await setConnectionPrimary(req.params.modelId, req.params.connId, tenantId);
      }

      // Apply remaining updates (if any fields besides isPrimary)
      let updated: any;
      if (Object.keys(data).length > 0) {
        updated = await updateTenantModelConnection(req.params.connId, data, tenantId);
      } else {
        updated = await findTenantModelConnectionById(req.params.connId, tenantId);
      }

      log.info('Connection updated', {
        id: req.params.connId,
        modelId: req.params.modelId,
        requestId,
      });
      writeAuditLog({
        action: 'tenant-model-connection:update',
        tenantId,
        userId,
        metadata: {
          connectionId: req.params.connId,
          modelId: req.params.modelId,
          fields: [...Object.keys(data), ...(settingPrimary ? ['isPrimary'] : [])],
          requestId,
        },
      });

      // Invalidate cached LLM providers if credential-related fields changed
      if (data.credentialId || settingPrimary || data.isActive !== undefined) {
        invalidateModelResolutionCaches(tenantId);
      }

      res.json({
        success: true,
        connection: {
          id: updated.id,
          credentialId: updated.credentialId,
          isActive: updated.isActive,
          isPrimary: updated.isPrimary,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (err: unknown) {
      log.error('Failed to update connection', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'UPDATE_CONNECTION_FAILED', message: 'Failed to update connection' },
      });
    }
  },
);

/**
 * DELETE /:modelId/connections/:connId — Remove connection
 */
openapi.route(
  'delete',
  '/:modelId/connections/:connId',
  {
    summary: 'Delete model connection',
    description:
      'Permanently delete a model connection. This action cannot be undone. Clears the provider cache after deletion.',
    params: z.object({
      tenantId: z.string(),
      modelId: z.string(),
      connId: z.string(),
    }),
    response: z.object({
      success: z.literal(true),
      deleted: z.string(),
    }),
  },
  requirePermission('credential:delete'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const userId = req.tenantContext!.userId;

      const model = await findTenantModel(req.params.modelId, tenantId);
      if (!model) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      // Guard: platform-provisioned model connections managed by admin only
      if (model.provisionedBy) {
        res.status(403).json({
          success: false,
          error:
            'Cannot modify connections on a platform-provisioned model. Contact your administrator.',
        });
        return;
      }

      const existing = await findTenantModelConnectionById(req.params.connId, tenantId);
      if (!existing || existing.tenantModelId !== req.params.modelId) {
        res.status(404).json({ success: false, error: 'Connection not found' });
        return;
      }

      if (existing.credentialId) {
        const existingCredential = await requireTenantCredential(
          tenantId,
          existing.credentialId,
          getCredentialActorUserId(req),
        );
        if (!existingCredential) {
          res.status(404).json({ success: false, error: 'Credential not found' });
          return;
        }
      }

      await deleteTenantModelConnection(req.params.connId, tenantId);

      log.info('Connection deleted', {
        id: req.params.connId,
        modelId: req.params.modelId,
        requestId,
      });
      writeAuditLog({
        action: 'tenant-model-connection:delete',
        tenantId,
        userId,
        metadata: { connectionId: req.params.connId, modelId: req.params.modelId, requestId },
      });

      // Invalidate cached LLM providers
      invalidateModelResolutionCaches(tenantId);

      res.json({ success: true, deleted: req.params.connId });
    } catch (err: unknown) {
      log.error('Failed to delete connection', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'DELETE_CONNECTION_FAILED', message: 'Failed to delete connection' },
      });
    }
  },
);

/**
 * POST /:modelId/connections/:connId/validate — Validate credential
 *
 * Requires credential:write permission (not just read) since this decrypts
 * and sends the key to an external service. Uses provider-specific
 * lightweight checks (models list, not inference) to minimize cost.
 */
openapi.route(
  'post',
  '/:modelId/connections/:connId/validate',
  {
    summary: 'Validate model connection',
    description:
      'Validate a model connection by testing the credential with the provider API. Decrypts the API key and performs a lightweight check (models list endpoint, not inference) to minimize cost. Supports Anthropic and OpenAI providers.',
    params: z.object({
      tenantId: z.string(),
      modelId: z.string(),
      connId: z.string(),
    }),
    response: z.object({
      success: z.literal(true),
      valid: z.boolean().nullable(),
      message: z.string(),
    }),
  },
  requirePermission('credential:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      // Encryption must be available to decrypt the stored credential
      if (!isTenantEncryptionReady()) {
        res.status(503).json({
          success: false,
          error: 'Tenant DEK encryption is not initialized. Cannot validate credentials.',
        });
        return;
      }

      const tenantId = requireTenantAccess(req, res);
      if (!tenantId) return;

      const model = await findTenantModel(req.params.modelId, tenantId);
      if (!model) {
        res.status(404).json({ success: false, error: 'Tenant model not found' });
        return;
      }

      // Block tenant-side validate on platform-provisioned models
      if (model.provisionedBy) {
        res.status(403).json({
          success: false,
          error:
            'Cannot validate connections on a platform-provisioned model. Contact your administrator.',
        });
        return;
      }

      const connection = await findTenantModelConnectionById(req.params.connId, tenantId);
      if (!connection || connection.tenantModelId !== req.params.modelId) {
        res.status(404).json({ success: false, error: 'Connection not found' });
        return;
      }

      // Look up the credential linked to this connection
      const credential = await requireTenantCredential(
        tenantId,
        connection.credentialId,
        getCredentialActorUserId(req),
      );
      if (!credential || !credential.encryptedApiKey) {
        res.json({
          success: true,
          valid: false,
          message: 'No API key configured for this connection',
        });
        return;
      }

      const provider = model.provider || 'unknown';
      const {
        checkConnectionHealth,
        resolveConnectionHealthInputFromCredential,
        updateConnectionHealthStatus,
      } = await import('../services/llm/model-health-service.js');

      let healthInput: ConnectionHealthInput | null = null;
      try {
        healthInput = await resolveConnectionHealthInputFromCredential(
          credential,
          tenantId,
          provider,
          model.modelId || 'test',
        );
        if (healthInput && !healthInput.endpoint) {
          healthInput.endpoint = model.customEndpoint || model.endpointUrl || undefined;
        }
      } catch (decryptErr) {
        res.json({
          success: true,
          valid: false,
          message: 'Credential could not be decrypted',
        });
        return;
      }

      if (!healthInput) {
        res.json({
          success: true,
          valid: false,
          message: 'No API key configured for this connection',
        });
        return;
      }

      const result = await checkConnectionHealth(healthInput);

      const userId = req.tenantContext!.userId;
      writeAuditLog({
        action: 'tenant-model-connection:validate',
        tenantId,
        userId,
        metadata: {
          connectionId: req.params.connId,
          modelId: req.params.modelId,
          valid: result.valid,
          provider,
          requestId,
        },
      });

      await updateConnectionHealthStatus(req.params.modelId, req.params.connId, tenantId, result);

      res.json({ success: true, valid: result.valid, message: result.message });
    } catch (err: unknown) {
      log.error('Failed to validate connection', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'VALIDATE_CONNECTION_FAILED', message: 'Failed to validate connection' },
      });
    }
  },
);

export default openapi.router;
