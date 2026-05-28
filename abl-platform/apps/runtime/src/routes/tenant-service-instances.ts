/**
 * Tenant Service Instance CRUD Route
 *
 * Manages tenant-level voice/external service instances with encrypted credentials.
 * Supports registry-backed voice and S2S service types.
 *
 * Mount: /api/tenants/:tenantId/service-instances
 */

import { type Request, type Response, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import {
  describeRuntimeVoiceServiceTypes,
  isRuntimeVoiceServiceType,
  isSpeechVoiceServiceType,
  RUNTIME_VOICE_SERVICE_TYPES,
} from '@agent-platform/config/constants/voice-providers';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import {
  listTenantServiceInstances,
  findTenantServiceInstance,
  createTenantServiceInstance,
  updateTenantServiceInstance,
  deleteTenantServiceInstance,
} from '../repos/tenant-model-repo.js';
import { writeAuditLog } from '../repos/auth-repo.js';

import type { VoiceServiceFactory } from '../services/voice/voice-service-factory.js';
import {
  buildSpeechCredentialInput,
  sanitizeVoiceServiceConfig,
  type VoiceServiceCredentialSnapshot,
} from '../services/voice/speech-credential-mapper.js';
import { resolveAuthProfileCredentials } from '../services/auth-profile-resolver.js';

const log = createLogger('tenant-service-instances-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/tenants/:tenantId/service-instances',
  tags: ['Service Instances'],
});
const router: RouterType = openapi.router;

const MAX_FIELD_LENGTH = 256;

type TenantContextRequest = Request & {
  tenantContext?: {
    tenantId: string;
    userId: string;
  };
};

class SpeechCredentialSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechCredentialSyncError';
  }
}

// ── Jambonz speech credential sync helpers ──────────────────────────────────

function isSpeechService(serviceType: string): boolean {
  return isSpeechVoiceServiceType(serviceType);
}

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const serviceTypeDescription = `Service type: ${describeRuntimeVoiceServiceTypes()}`;

const runtimeServiceTypeValues = [...RUNTIME_VOICE_SERVICE_TYPES] as [
  (typeof RUNTIME_VOICE_SERVICE_TYPES)[number],
  ...(typeof RUNTIME_VOICE_SERVICE_TYPES)[number][],
];

const serviceTypeEnum = z.enum(runtimeServiceTypeValues).describe(serviceTypeDescription);

const serviceInstanceSchema = z.object({
  id: z.string().describe('Service instance ID'),
  displayName: z.string().describe('Display name for the service instance'),
  serviceType: serviceTypeEnum,
  authProfileId: z.string().nullable().optional().describe('Auth profile ID for credential lookup'),
  isDefault: z.boolean().describe('Whether this is the default instance for its service type'),
  isActive: z.boolean().describe('Whether the instance is active'),
  createdAt: z.string().datetime().describe('Instance creation timestamp'),
  updatedAt: z.string().datetime().optional().describe('Last update timestamp'),
  createdBy: z.string().optional().describe('User ID who created the instance'),
  config: z
    .record(z.any())
    .optional()
    .describe('Optional non-sensitive service-specific configuration'),
});

const listServiceInstancesQuerySchema = z.object({
  serviceType: serviceTypeEnum.optional().describe('Filter by service type'),
  isActive: z.enum(['true', 'false']).optional().describe('Filter by active status'),
});

const listServiceInstancesResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  instances: z.array(serviceInstanceSchema).describe('List of service instances'),
});

const createServiceInstanceBodySchema = z
  .object({
    displayName: z
      .string()
      .min(1)
      .max(MAX_FIELD_LENGTH)
      .describe('Display name for the service instance'),
    serviceType: serviceTypeEnum,
    apiKey: z
      .string()
      .min(1)
      .optional()
      .describe('Primary credential value for the service (will be encrypted)'),
    authProfileId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('Optional auth profile ID used to resolve the primary credential'),
    config: z.record(z.any()).optional().describe('Optional service-specific configuration'),
    isDefault: z
      .boolean()
      .optional()
      .default(false)
      .describe('Set as default instance for service type'),
  })
  .refine((value) => Boolean(value.apiKey) || Boolean(value.authProfileId), {
    message: 'Either apiKey or authProfileId is required',
    path: ['apiKey'],
  });

const createServiceInstanceResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  instance: serviceInstanceSchema.omit({ createdBy: true }).describe('Created service instance'),
});

const getServiceInstanceResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  instance: serviceInstanceSchema.omit({ createdBy: true }).describe('Service instance details'),
});

const updateServiceInstanceBodySchema = z.object({
  displayName: z.string().min(1).max(MAX_FIELD_LENGTH).optional().describe('Updated display name'),
  apiKey: z
    .string()
    .min(1)
    .optional()
    .describe('Updated primary credential value (will be encrypted)'),
  authProfileId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Optional auth profile ID used to resolve the primary credential'),
  config: z.record(z.any()).optional().describe('Updated service-specific configuration'),
  isDefault: z.boolean().optional().describe('Update default status'),
  isActive: z.boolean().optional().describe('Update active status'),
});

const updateServiceInstanceResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  instance: serviceInstanceSchema.omit({ createdBy: true }).describe('Updated service instance'),
});

const deleteServiceInstanceResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  deleted: z.string().describe('ID of the deleted service instance'),
});

const speechCredentialTestStatusSchema = z.object({
  status: z.string().describe('Credential test status for this speech direction'),
  reason: z.string().optional().describe('Sanitized failure reason when available'),
});

const testServiceInstanceResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  result: z.object({
    tts: speechCredentialTestStatusSchema,
    stt: speechCredentialTestStatusSchema,
  }),
});

const paramsSchema = z.object({
  tenantId: z.string().describe('Tenant ID'),
  id: z.string().optional().describe('Service instance ID'),
});

// =============================================================================
// HELPERS
// =============================================================================

function withTenantContext(req: Request): TenantContextRequest {
  return req as TenantContextRequest;
}

function getTenantId(req: TenantContextRequest): string | null {
  const contextTenantId = req.tenantContext?.tenantId;

  // SECURITY: Always require an authenticated tenant context.
  if (!contextTenantId) return null;

  const paramTenantId = req.params.tenantId;
  if (paramTenantId && paramTenantId !== contextTenantId) return null;

  return contextTenantId;
}

function normalizeConfigPayload(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function parseConfigPayload(
  raw: unknown,
  serviceType: unknown,
  source: string,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (typeof raw === 'string') {
      try {
        return normalizeConfigPayload(JSON.parse(raw));
      } catch (error) {
        log.debug(`${source} is not valid JSON`, {
          serviceType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return undefined;
  }

  return raw as Record<string, unknown>;
}

function readAuthProfileCredentialValue(profile: {
  secrets: Record<string, unknown>;
}): string | null {
  const apiKey = profile.secrets.apiKey;
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return apiKey.trim();
  }

  const accessToken = profile.secrets.accessToken;
  if (typeof accessToken === 'string' && accessToken.trim().length > 0) {
    return accessToken.trim();
  }

  return null;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildPublicServiceInstance(
  instance: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  const serviceType = String(instance.serviceType ?? '');
  const safeConfig = sanitizeVoiceServiceConfig(serviceType, config);

  return {
    id: String(instance.id ?? instance._id),
    displayName: String(instance.displayName ?? ''),
    serviceType,
    authProfileId:
      typeof instance.authProfileId === 'string'
        ? instance.authProfileId
        : instance.authProfileId === null
          ? null
          : undefined,
    isDefault: Boolean(instance.isDefault),
    isActive: Boolean(instance.isActive),
    createdAt: normalizeTimestamp(instance.createdAt),
    updatedAt: normalizeTimestamp(instance.updatedAt),
    createdBy: typeof instance.createdBy === 'string' ? instance.createdBy : undefined,
    config: safeConfig,
  };
}

function sanitizeCredentialTestReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return undefined;
  }

  return reason
    .trim()
    .replace(
      /\b(api[_ -]?key|authorization|bearer|private[_ -]?key|token|secret)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 512);
}

function normalizeCredentialTestStatus(raw: unknown): { status: string; reason?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'not tested' };
  }

  const record = raw as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status : 'not tested';
  const reason = sanitizeCredentialTestReason(record.reason);
  return reason ? { status, reason } : { status };
}

function normalizeCredentialTestResult(raw: unknown): {
  tts: { status: string; reason?: string };
  stt: { status: string; reason?: string };
} {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  return {
    tts: normalizeCredentialTestStatus(record.tts),
    stt: normalizeCredentialTestStatus(record.stt),
  };
}

async function resolveAuthProfilePrimaryCredential(
  authProfileId: string,
  tenantId: string,
): Promise<string> {
  const profile = await resolveAuthProfileCredentials(authProfileId, tenantId);
  if (!profile) {
    throw new Error(`Auth profile ${authProfileId} is not available for voice credentials`);
  }

  const apiKey = readAuthProfileCredentialValue(profile);
  if (!apiKey) {
    throw new Error(`Auth profile ${authProfileId} has no usable API key or bearer token`);
  }

  return apiKey;
}

function serializeConfigPayload(config: Record<string, unknown> | undefined): string | null {
  if (!config || Object.keys(config).length === 0) {
    return null;
  }
  return JSON.stringify(config);
}

async function resolveStoredSpeechCredentialSnapshot(
  instance: Record<string, unknown>,
  tenantId: string,
): Promise<VoiceServiceCredentialSnapshot> {
  const authProfileId =
    typeof instance.authProfileId === 'string' && instance.authProfileId.length > 0
      ? instance.authProfileId
      : null;
  const decryptionFailed = Boolean(instance._decryptionFailed);
  const apiKey = authProfileId
    ? await resolveAuthProfilePrimaryCredential(authProfileId, tenantId)
    : await resolveTenantPlaintextValue(
        (instance.encryptedApiKey as string | null | undefined) ?? null,
        tenantId,
        { decryptionFailed },
      );

  if (!apiKey) {
    throw new Error('Stored speech credential is missing its primary credential value');
  }

  const config = await resolveStoredServiceConfig(instance, tenantId, decryptionFailed);

  return { apiKey, config };
}

async function resolveStoredServiceConfig(
  instance: Record<string, unknown>,
  tenantId: string,
  decryptionFailed = Boolean(instance._decryptionFailed),
): Promise<Record<string, unknown> | undefined> {
  const rawConfig = instance.encryptedConfig;

  if (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    return rawConfig as Record<string, unknown>;
  }

  if (typeof rawConfig !== 'string') {
    return undefined;
  }

  const decryptedConfig = await resolveTenantPlaintextValue(rawConfig, tenantId, {
    decryptionFailed,
  });
  return decryptedConfig
    ? parseConfigPayload(decryptedConfig, instance.serviceType, 'Stored service config')
    : undefined;
}

function getStoredSpeechCredentialSid(instance: Record<string, unknown>): string | null {
  return typeof instance.jambonzSpeechCredentialSid === 'string' &&
    instance.jambonzSpeechCredentialSid.trim().length > 0
    ? instance.jambonzSpeechCredentialSid.trim()
    : null;
}

async function restoreSpeechCredentialAfterReplacementFailure(params: {
  instanceId: string;
  serviceType: string;
  tenantId: string;
  snapshot: VoiceServiceCredentialSnapshot;
}): Promise<string | null> {
  const { getJambonzProvisioningService } =
    await import('../services/voice/jambonz-provisioning.service.js');
  const jambonz = getJambonzProvisioningService();

  try {
    const restoredSid = await jambonz.createSpeechCredential(
      buildSpeechCredentialInput(params.serviceType, params.snapshot, params.tenantId),
    );
    await updateTenantServiceInstance(
      params.instanceId,
      { jambonzSpeechCredentialSid: restoredSid },
      params.tenantId,
    );
    return restoredSid;
  } catch (error) {
    log.error('Failed to restore previous speech credential after replacement failure', {
      instanceId: params.instanceId,
      serviceType: params.serviceType,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function replaceSpeechCredentialInGateway(params: {
  instanceId: string;
  serviceType: string;
  tenantId: string;
  nextSnapshot: VoiceServiceCredentialSnapshot;
  currentSnapshot?: VoiceServiceCredentialSnapshot;
  existingJambonzSpeechCredentialSid?: string | null;
}): Promise<string> {
  const { getJambonzProvisioningService } =
    await import('../services/voice/jambonz-provisioning.service.js');
  const jambonz = getJambonzProvisioningService();

  const existingSid = params.existingJambonzSpeechCredentialSid?.trim() || null;
  if (!existingSid) {
    try {
      return await jambonz.createSpeechCredential(
        buildSpeechCredentialInput(params.serviceType, params.nextSnapshot, params.tenantId),
      );
    } catch (error) {
      throw new SpeechCredentialSyncError(
        error instanceof Error ? error.message : 'Failed to create speech credential',
      );
    }
  }

  try {
    await jambonz.deleteSpeechCredential(existingSid);
    return await jambonz.createSpeechCredential(
      buildSpeechCredentialInput(params.serviceType, params.nextSnapshot, params.tenantId),
    );
  } catch (error) {
    if (params.currentSnapshot) {
      const restoredSid = await restoreSpeechCredentialAfterReplacementFailure({
        instanceId: params.instanceId,
        serviceType: params.serviceType,
        tenantId: params.tenantId,
        snapshot: params.currentSnapshot,
      });
      if (restoredSid) {
        log.warn('Restored previous speech credential after replacement failure', {
          instanceId: params.instanceId,
          serviceType: params.serviceType,
          restoredSid,
        });
      }
    }

    throw new SpeechCredentialSyncError(
      error instanceof Error ? error.message : 'Failed to replace speech credential',
    );
  }
}

async function compensateServiceInstanceUpdateFailure(params: {
  instanceId: string;
  serviceType: string;
  tenantId: string;
  replacementSid: string;
  previousSnapshot: VoiceServiceCredentialSnapshot;
  hadPreviousSid: boolean;
}): Promise<void> {
  const { getJambonzProvisioningService } =
    await import('../services/voice/jambonz-provisioning.service.js');
  const jambonz = getJambonzProvisioningService();

  try {
    await jambonz.deleteSpeechCredential(params.replacementSid);
  } catch (error) {
    log.warn('Failed to delete replacement speech credential after service update failure', {
      instanceId: params.instanceId,
      sid: params.replacementSid,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (params.hadPreviousSid) {
    await restoreSpeechCredentialAfterReplacementFailure({
      instanceId: params.instanceId,
      serviceType: params.serviceType,
      tenantId: params.tenantId,
      snapshot: params.previousSnapshot,
    });
  }
}

async function recreateSpeechCredential(params: {
  instanceId: string;
  serviceType: string;
  tenantId: string;
  snapshot: VoiceServiceCredentialSnapshot;
}): Promise<string> {
  const { getJambonzProvisioningService } =
    await import('../services/voice/jambonz-provisioning.service.js');
  const jambonz = getJambonzProvisioningService();

  const newSid = await replaceSpeechCredentialInGateway({
    instanceId: params.instanceId,
    serviceType: params.serviceType,
    tenantId: params.tenantId,
    nextSnapshot: params.snapshot,
  });

  try {
    await updateTenantServiceInstance(
      params.instanceId,
      { jambonzSpeechCredentialSid: newSid },
      params.tenantId,
    );
  } catch (error) {
    try {
      await jambonz.deleteSpeechCredential(newSid);
    } catch (deleteError) {
      log.warn('Failed to delete unused replacement speech credential after persistence failure', {
        instanceId: params.instanceId,
        sid: newSid,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    }
    throw error;
  }

  return newSid;
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET / — List service instances
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List service instances',
    description:
      'List all service instances for the authenticated tenant with optional filtering by service type and active status.',
    params: z.object({ tenantId: z.string().describe('Tenant ID') }),
    query: listServiceInstancesQuerySchema,
    response: listServiceInstancesResponseSchema,
  },
  requirePermission('credential:read'),
  async (req: Request, res: Response) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantRequest = withTenantContext(req);
      const tenantId = getTenantId(tenantRequest);
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const { serviceType, isActive } = req.query;

      const where: Record<string, unknown> = { tenantId };
      if (serviceType) where.serviceType = String(serviceType);
      if (isActive !== undefined) where.isActive = isActive === 'true';

      const instances = await listTenantServiceInstances(where, {
        select: {
          id: true,
          displayName: true,
          serviceType: true,
          authProfileId: true,
          isDefault: true,
          isActive: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Enrich instances with non-sensitive config fields (e.g. model).
      // encryptedConfig is excluded from the select above to avoid leaking API keys,
      // but fields like 'model' are needed by the UI. Read via Mongoose (no .lean())
      // so the encryption plugin auto-decrypts.
      let configMap = new Map<string, Record<string, unknown>>();
      try {
        const { TenantServiceInstance } = await import('@agent-platform/database/models');
        const ids = instances.map((i: any) => i._id || i.id);
        if (ids.length > 0) {
          const docs = await TenantServiceInstance.find({ _id: { $in: ids }, tenantId });
          for (const doc of docs) {
            const parsed = parseConfigPayload(
              doc.encryptedConfig,
              doc.serviceType,
              'Tenant service instance config',
            );
            if (parsed) configMap.set(String(doc._id), parsed);
          }
        }
      } catch (enrichErr) {
        // Non-critical — instances still returned without config
        log.debug('Failed to enrich instances with config', {
          error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
        });
      }

      res.json({
        success: true,
        instances: instances.map((instance) =>
          buildPublicServiceInstance(
            instance as Record<string, unknown>,
            configMap.get(String((instance as { _id?: string; id?: string })._id ?? instance.id)),
          ),
        ),
      });
    } catch (error: any) {
      log.error('Failed to list service instances', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to list service instances' });
    }
  },
);

/**
 * POST / — Create service instance
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create service instance',
    description:
      'Create a new service instance with encrypted credentials. Requires credential:write permission.',
    params: z.object({ tenantId: z.string().describe('Tenant ID') }),
    body: createServiceInstanceBodySchema,
    response: createServiceInstanceResponseSchema,
    successStatus: 201,
  },
  requirePermission('credential:write'),
  async (req: Request, res: Response) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantRequest = withTenantContext(req);
      const tenantId = getTenantId(tenantRequest);
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const userId = tenantRequest.tenantContext!.userId;

      const { displayName, serviceType, apiKey, authProfileId, config, isDefault } = req.body;
      const normalizedConfig = normalizeConfigPayload(config);

      if (!displayName || !serviceType || (!apiKey && !authProfileId)) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: displayName, serviceType, and apiKey or authProfileId',
        });
        return;
      }

      if (String(displayName).length > MAX_FIELD_LENGTH) {
        res.status(400).json({
          success: false,
          error: `displayName exceeds maximum length of ${MAX_FIELD_LENGTH}`,
        });
        return;
      }

      if (!isRuntimeVoiceServiceType(serviceType)) {
        res.status(400).json({
          success: false,
          error: `Invalid serviceType. Must be one of: ${describeRuntimeVoiceServiceTypes()}`,
        });
        return;
      }

      // Plugin encrypts encryptedApiKey and encryptedConfig transparently in pre-save hook
      const instance = await createTenantServiceInstance({
        tenantId,
        displayName,
        serviceType,
        encryptedApiKey: authProfileId ? '' : apiKey,
        authProfileId: authProfileId ?? null,
        encryptedConfig: serializeConfigPayload(normalizedConfig),
        isDefault: isDefault ?? false,
        createdBy: userId,
      });

      log.info('Service instance created', { id: instance.id, serviceType, tenantId, requestId });
      writeAuditLog({
        action: 'service-instance:create',
        tenantId,
        userId,
        metadata: { instanceId: instance.id, serviceType, displayName, requestId },
      });

      // Sync speech credential to Jambonz
      if (isSpeechService(serviceType)) {
        try {
          const jambonzSpeechCredentialSid = await recreateSpeechCredential({
            instanceId: instance.id,
            serviceType,
            tenantId,
            snapshot: {
              apiKey: authProfileId
                ? await resolveAuthProfilePrimaryCredential(authProfileId, tenantId)
                : (apiKey as string),
              config: normalizedConfig,
            },
          });
          log.info('Speech credential synced to Jambonz', {
            instanceId: instance.id,
            jambonzSpeechCredentialSid,
            serviceType,
          });
        } catch (jambonzErr: any) {
          log.warn('Failed to sync speech credential to Jambonz', {
            error: jambonzErr?.message,
            serviceType,
            instanceId: instance.id,
          });
        }
      }

      res.status(201).json({
        success: true,
        instance: buildPublicServiceInstance(instance, normalizedConfig),
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        res.status(409).json({
          success: false,
          error: 'Service instance with this name already exists for this tenant and service type',
        });
        return;
      }
      log.error('Failed to create service instance', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to create service instance' });
    }
  },
);

/**
 * GET /:id — Get service instance detail
 */
openapi.route(
  'get',
  '/:id',
  {
    summary: 'Get service instance',
    description:
      'Get full details of a service instance by ID. Requires credential:read permission.',
    params: z.object({
      tenantId: z.string().describe('Tenant ID'),
      id: z.string().describe('Service instance ID'),
    }),
    response: getServiceInstanceResponseSchema,
  },
  requirePermission('credential:read'),
  async (req: Request, res: Response) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantRequest = withTenantContext(req);
      const tenantId = getTenantId(tenantRequest);
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const instance = await findTenantServiceInstance(req.params.id, tenantId);

      if (!instance) {
        res.status(404).json({ success: false, error: 'Service instance not found' });
        return;
      }

      res.json({
        success: true,
        instance: buildPublicServiceInstance(
          instance as Record<string, unknown>,
          parseConfigPayload(
            instance.encryptedConfig,
            instance.serviceType,
            'Tenant service config',
          ),
        ),
      });
    } catch (error: any) {
      log.error('Failed to get service instance', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to get service instance' });
    }
  },
);

/**
 * PATCH /:id — Update service instance
 */
openapi.route(
  'patch',
  '/:id',
  {
    summary: 'Update service instance',
    description:
      'Update a service instance with partial fields. Encrypts credentials automatically. Requires credential:write permission.',
    params: z.object({
      tenantId: z.string().describe('Tenant ID'),
      id: z.string().describe('Service instance ID'),
    }),
    body: updateServiceInstanceBodySchema,
    response: updateServiceInstanceResponseSchema,
  },
  requirePermission('credential:write'),
  async (req: Request, res: Response) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantRequest = withTenantContext(req);
      const tenantId = getTenantId(tenantRequest);
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const userId = tenantRequest.tenantContext!.userId;

      const existing = await findTenantServiceInstance(req.params.id, tenantId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Service instance not found' });
        return;
      }
      const normalizedConfig = normalizeConfigPayload(req.body.config);
      let mergedConfig: Record<string, unknown> | undefined;

      if (req.body.authProfileId === null && existing.authProfileId && !req.body.apiKey) {
        res.status(400).json({
          success: false,
          error: 'apiKey is required when clearing authProfileId on a service instance',
        });
        return;
      }

      const data: Record<string, unknown> = {};

      if (req.body.displayName !== undefined) data.displayName = req.body.displayName;
      if (req.body.isDefault !== undefined) data.isDefault = req.body.isDefault;
      if (req.body.isActive !== undefined) data.isActive = req.body.isActive;

      // Plugin encrypts encryptedApiKey and encryptedConfig transparently in pre-save hook
      if (req.body.apiKey) {
        data.encryptedApiKey = req.body.apiKey;
        data.authProfileId = null;
      }

      if (req.body.authProfileId !== undefined) {
        data.authProfileId = req.body.authProfileId ?? null;
        if (req.body.authProfileId) {
          data.encryptedApiKey = '';
        }
      }

      if (req.body.config !== undefined) {
        const existingConfig = await resolveStoredServiceConfig(existing, tenantId);
        mergedConfig = {
          ...(existingConfig ?? {}),
          ...(normalizedConfig ?? {}),
        };
        data.encryptedConfig = serializeConfigPayload(mergedConfig);
      }

      let replacementSpeechCredentialSid: string | null = null;
      let currentSpeechSnapshot: VoiceServiceCredentialSnapshot | null = null;
      const existingSpeechCredentialSid = getStoredSpeechCredentialSid(existing);

      // Sync speech credential changes before persisting the new secret/config.
      // Jambonz uses a stable tenant label, so replacement must delete the old
      // gateway credential first and compensate if create or DB persistence fails.
      if (
        isSpeechService(existing.serviceType) &&
        (req.body.apiKey || req.body.config !== undefined || req.body.authProfileId !== undefined)
      ) {
        currentSpeechSnapshot = await resolveStoredSpeechCredentialSnapshot(existing, tenantId);
        const updatedConfig =
          req.body.config !== undefined ? mergedConfig : currentSpeechSnapshot.config;
        const updatedApiKey = req.body.authProfileId
          ? await resolveAuthProfilePrimaryCredential(req.body.authProfileId, tenantId)
          : (req.body.apiKey ?? currentSpeechSnapshot.apiKey);

        replacementSpeechCredentialSid = await replaceSpeechCredentialInGateway({
          instanceId: req.params.id,
          serviceType: existing.serviceType,
          tenantId,
          nextSnapshot: {
            apiKey: updatedApiKey,
            config: updatedConfig,
          },
          currentSnapshot: currentSpeechSnapshot,
          existingJambonzSpeechCredentialSid: existingSpeechCredentialSid,
        });
        data.jambonzSpeechCredentialSid = replacementSpeechCredentialSid;
      }

      let updated: Record<string, unknown>;
      try {
        const persisted = await updateTenantServiceInstance(req.params.id, data, tenantId);
        if (!persisted) {
          throw new Error('Service instance not found during update');
        }
        updated = persisted;
      } catch (error) {
        if (replacementSpeechCredentialSid && currentSpeechSnapshot) {
          await compensateServiceInstanceUpdateFailure({
            instanceId: req.params.id,
            serviceType: existing.serviceType,
            tenantId,
            replacementSid: replacementSpeechCredentialSid,
            previousSnapshot: currentSpeechSnapshot,
            hadPreviousSid: Boolean(existingSpeechCredentialSid),
          });
        }
        throw error;
      }

      log.info('Service instance updated', { id: req.params.id, tenantId, requestId });
      writeAuditLog({
        action: 'service-instance:update',
        tenantId,
        userId,
        metadata: { instanceId: req.params.id, fields: Object.keys(data), requestId },
      });

      if (replacementSpeechCredentialSid) {
        log.info('Speech credential re-created in Jambonz after service update', {
          instanceId: req.params.id,
          newSid: replacementSpeechCredentialSid,
          serviceType: existing.serviceType,
        });
      }

      // Invalidate cached voice service so updated credentials take effect immediately
      const voiceFactory = req.app.locals.voiceServiceFactory as VoiceServiceFactory | undefined;
      if (voiceFactory) {
        voiceFactory.invalidate(tenantId, existing.serviceType);
      }

      const responseConfig =
        req.body.config !== undefined
          ? mergedConfig
          : await resolveStoredServiceConfig(existing, tenantId);

      res.json({
        success: true,
        instance: buildPublicServiceInstance(updated, responseConfig),
      });
    } catch (error: any) {
      if (error instanceof SpeechCredentialSyncError) {
        log.warn('Failed to sync speech credential update to Jambonz', {
          error: error.message,
          requestId,
        });
        res.status(502).json({
          success: false,
          error: 'Failed to sync speech credential to voice gateway',
        });
        return;
      }
      if (error?.code === 11000) {
        res
          .status(409)
          .json({ success: false, error: 'Duplicate name for this tenant and service type' });
        return;
      }
      log.error('Failed to update service instance', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to update service instance' });
    }
  },
);

/**
 * POST /:id/test — Test synced speech credential in KoreVG/Jambonz
 */
openapi.route(
  'post',
  '/:id/test',
  {
    summary: 'Test service instance speech credential',
    description:
      'Runs the voice gateway speech credential test for a saved service instance. Requires credential:write permission because the gateway records test results.',
    params: z.object({
      tenantId: z.string().describe('Tenant ID'),
      id: z.string().describe('Service instance ID'),
    }),
    response: testServiceInstanceResponseSchema,
  },
  requirePermission('credential:write'),
  async (req: Request, res: Response) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantRequest = withTenantContext(req);
      const tenantId = getTenantId(tenantRequest);
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const existing = await findTenantServiceInstance(req.params.id, tenantId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Service instance not found' });
        return;
      }

      if (!isSpeechService(existing.serviceType)) {
        res.status(400).json({
          success: false,
          error: 'Credential testing is only available for speech service instances',
        });
        return;
      }

      const jambonzSid =
        typeof existing.jambonzSpeechCredentialSid === 'string' &&
        existing.jambonzSpeechCredentialSid.trim().length > 0
          ? existing.jambonzSpeechCredentialSid.trim()
          : null;

      if (!jambonzSid) {
        res.status(409).json({
          success: false,
          error:
            'Speech credential has not been synced to the voice gateway. Save credentials and try again.',
        });
        return;
      }

      const { getJambonzProvisioningService } =
        await import('../services/voice/jambonz-provisioning.service.js');
      const jambonz = getJambonzProvisioningService();
      const result = normalizeCredentialTestResult(await jambonz.testSpeechCredential(jambonzSid));

      writeAuditLog({
        action: 'service-instance:test',
        tenantId,
        userId: tenantRequest.tenantContext!.userId,
        metadata: {
          instanceId: req.params.id,
          serviceType: existing.serviceType,
          requestId,
        },
      });

      res.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to test service instance credential', {
        error: message,
        requestId,
      });
      res.status(502).json({
        success: false,
        error: 'Failed to test speech credential through the voice gateway',
      });
    }
  },
);

/**
 * DELETE /:id — Delete service instance (hard delete)
 */
openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete service instance',
    description: 'Permanently delete a service instance. Requires credential:delete permission.',
    params: z.object({
      tenantId: z.string().describe('Tenant ID'),
      id: z.string().describe('Service instance ID'),
    }),
    response: deleteServiceInstanceResponseSchema,
  },
  requirePermission('credential:delete'),
  async (req: Request, res: Response) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantRequest = withTenantContext(req);
      const tenantId = getTenantId(tenantRequest);
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const userId = tenantRequest.tenantContext!.userId;

      const existing = await findTenantServiceInstance(req.params.id, tenantId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Service instance not found' });
        return;
      }

      await deleteTenantServiceInstance(req.params.id, tenantId);

      // Delete speech credential from Jambonz
      if (isSpeechService(existing.serviceType)) {
        const jambonzSid = (existing as any).jambonzSpeechCredentialSid as string | null;
        if (jambonzSid) {
          try {
            const { getJambonzProvisioningService } =
              await import('../services/voice/jambonz-provisioning.service.js');
            const jambonz = getJambonzProvisioningService();
            await jambonz.deleteSpeechCredential(jambonzSid);
            log.info('Speech credential deleted from Jambonz', { jambonzSid });
          } catch (jambonzErr: any) {
            log.warn('Failed to delete speech credential from Jambonz', {
              error: jambonzErr?.message,
            });
          }
        }
      }

      log.info('Service instance deleted', { id: req.params.id, tenantId, requestId });
      writeAuditLog({
        action: 'service-instance:delete',
        tenantId,
        userId,
        metadata: { instanceId: req.params.id, serviceType: existing.serviceType, requestId },
      });

      // Invalidate cached voice service so deletion takes effect immediately
      const voiceFactory = req.app.locals.voiceServiceFactory as VoiceServiceFactory | undefined;
      if (voiceFactory) {
        voiceFactory.invalidate(tenantId, existing.serviceType);
      }

      res.json({ success: true, deleted: req.params.id });
    } catch (error: any) {
      log.error('Failed to delete service instance', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to delete service instance' });
    }
  },
);

export default openapi.router;
