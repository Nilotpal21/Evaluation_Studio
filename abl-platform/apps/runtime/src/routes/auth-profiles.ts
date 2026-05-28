/**
 * Auth Profile CRUD API Routes
 *
 * POST   /                Create auth profile (auth-profile:create)
 * GET    /by-name/:name   Resolve by name (auth-profile:read)
 * GET    /:id             Get by ID (auth-profile:read)
 * DELETE /:id             Delete (auth-profile:delete)
 *
 * All routes are tenant-scoped via req.tenantContext.tenantId.
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import {
  AUTH_PROFILE_USAGE_MODES,
  getAuthProfileUsageModeValidationError,
  resolveAuthProfileUsageMode,
} from '@agent-platform/shared/validation';
import { getAuthProfileMigrationState } from '@agent-platform/shared/services/auth-profile';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requirePermissionInline } from '../middleware/rbac.js';
import { createLogger } from '@abl/compiler/platform';
import { buildAuthProfileConsumerDependencyFilter } from './auth-profile-route-utils.js';

const log = createLogger('auth-profiles-route');

/**
 * Bare route definitions — no auth/rate-limit middleware attached.
 * Exported for test use where middleware is injected externally.
 */
export const authProfileRoutes: RouterType = Router();

/**
 * Production-ready router with auth + rate limiting.
 * Default export — used by server.ts mount.
 */
export const router: RouterType = Router();
router.use(authMiddleware);
router.use(tenantRateLimit('request'));
router.use(authProfileRoutes);

// =============================================================================
// SCHEMAS
// =============================================================================

const AUTH_TYPES = [
  'none',
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_token',
  'oauth2_client_credentials',
  'basic',
  'custom_header',
  'aws_iam',
  'azure_ad',
  'mtls',
  'ssh_key',
  'digest',
  'kerberos',
  'saml',
  'hawk',
  'ws_security',
] as const;

const CreateAuthProfileSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    authType: z.enum(AUTH_TYPES),
    scope: z.enum(['tenant', 'project']).default('tenant'),
    usageMode: z.enum(AUTH_PROFILE_USAGE_MODES).optional(),
    environment: z.string().max(100).nullable().optional(),
    visibility: z.enum(['shared', 'personal']).default('shared'),
    config: z.record(z.unknown()).default({}),
    secrets: z.record(z.unknown()).default({}),
    connector: z.string().max(255).optional(),
    category: z.string().max(255).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    linkedAppProfileId: z.string().min(1).optional(),
    projectId: z.string().min(1).nullable().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.authType === 'oauth2_token' && !data.linkedAppProfileId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'oauth2_token profiles must reference linkedAppProfileId',
        path: ['linkedAppProfileId'],
      });
    }

    if (data.authType !== 'oauth2_token' && data.linkedAppProfileId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'linkedAppProfileId is only valid for oauth2_token profiles.',
        path: ['linkedAppProfileId'],
      });
    }

    const usageModeError = getAuthProfileUsageModeValidationError(data.authType, data.usageMode);
    if (usageModeError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: usageModeError,
        path: ['usageMode'],
      });
    }
  });

const OAUTH_SSRF_URL_FIELDS = [
  'authorizationUrl',
  'tokenUrl',
  'refreshUrl',
  'revocationUrl',
  'deviceAuthorizationUrl',
  'tokenIntrospectionUrl',
  'setupGuideUrl',
  'docsUrl',
] as const;

const WORKSPACE_ONLY_ROUTE_MESSAGE =
  'This runtime route only supports workspace-level shared auth profiles. Use project-scoped APIs for project or personal profiles.';

function isKerberosBuildEnabled(): boolean {
  const value = process.env.ENABLE_KERBEROS;
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

async function validateOAuthUrlsForSSRF(
  authType: (typeof AUTH_TYPES)[number],
  config: Record<string, unknown>,
): Promise<{ field: string; reason: string } | null> {
  if (authType !== 'oauth2_app' && authType !== 'oauth2_client_credentials') {
    return null;
  }

  const { validateUrlForSSRF } = await import('@agent-platform/shared/security');

  for (const field of OAUTH_SSRF_URL_FIELDS) {
    const value = config[field];
    if (typeof value !== 'string') {
      continue;
    }

    const check = validateUrlForSSRF(value, {});
    if (!check.safe) {
      return { field, reason: check.reason ?? 'URL blocked by SSRF protection' };
    }
  }

  return null;
}

async function validateAuthProfilePayload(
  authType: (typeof AUTH_TYPES)[number],
  config: Record<string, unknown>,
  secrets: Record<string, unknown>,
): Promise<string | null> {
  const { getMaterializedAuthProfileValidationErrors } =
    await import('@agent-platform/shared/validation');
  const validationErrors = getMaterializedAuthProfileValidationErrors(authType, config, secrets);
  return validationErrors.length > 0 ? validationErrors.join('; ') : null;
}

interface ConsumerDependency {
  type: string;
  count: number;
}

function buildDeletedAuthProfileName(name: string, profileId: string): string {
  const suffix = `__deleted__${profileId}`;
  const maxBaseLength = Math.max(1, 255 - suffix.length);
  return `${name.slice(0, maxBaseLength)}${suffix}`;
}

async function getAuthProfileConsumerDependencies(
  profileId: string,
  tenantId: string,
): Promise<ConsumerDependency[]> {
  const {
    AuthProfile,
    ChannelConnection,
    TenantModel,
    ConnectorConfig,
    ConnectorConnection,
    MCPServerConfig,
    ServiceNode,
    TenantGuardrailProviderConfig,
    GuardrailPolicy,
    GitIntegration,
    WebhookSubscription,
    WebhookSubscriptionConnector,
    ModelConfig,
    TenantServiceInstance,
    OrgProxyConfig,
    ArchWorkspaceConfig,
    TriggerRegistration,
    EndUserOAuthToken,
  } = await import('@agent-platform/database/models');
  const { buildActiveAuthProfileOAuthGrantFilter } =
    await import('../services/oauth-grant-service.js');

  const consumerChecks: Array<{
    type: string;
    model: { countDocuments: (filter: Record<string, unknown>) => Promise<number> };
    field?: string;
    filter?: Record<string, unknown>;
    directFilter?: Record<string, unknown>;
  }> = [
    {
      type: 'AuthProfile',
      model: AuthProfile as any,
      field: 'linkedAppProfileId',
      filter: { status: 'active' },
    },
    {
      type: 'EndUserOAuthToken',
      model: EndUserOAuthToken as any,
      directFilter: buildActiveAuthProfileOAuthGrantFilter({ profileId, tenantId }),
    },
    { type: 'ChannelConnection', model: ChannelConnection as any },
    { type: 'TenantModel', model: TenantModel as any, field: 'connections.authProfileId' },
    { type: 'ConnectorConfig', model: ConnectorConfig as any },
    { type: 'ConnectorConnection', model: ConnectorConnection as any },
    { type: 'MCPServerConfig', model: MCPServerConfig as any },
    { type: 'ServiceNode', model: ServiceNode as any },
    { type: 'GuardrailProviderConfig', model: TenantGuardrailProviderConfig as any },
    { type: 'GuardrailPolicy', model: GuardrailPolicy as any },
    { type: 'GitIntegration', model: GitIntegration as any },
    { type: 'WebhookSubscription', model: WebhookSubscription as any },
    { type: 'WebhookSubscriptionConnector', model: WebhookSubscriptionConnector as any },
    { type: 'ModelConfig', model: ModelConfig as any },
    { type: 'TenantServiceInstance', model: TenantServiceInstance as any },
    { type: 'OrgProxyConfig', model: OrgProxyConfig as any },
    { type: 'ArchWorkspaceConfig', model: ArchWorkspaceConfig as any },
    { type: 'TriggerRegistration', model: TriggerRegistration as any },
  ];

  const counts = await Promise.all(
    consumerChecks.map(async ({ type, model, field, filter, directFilter }) => {
      const countFilter =
        directFilter ??
        buildAuthProfileConsumerDependencyFilter({
          type,
          profileId,
          tenantId,
          field,
          filter,
        });
      const count = await model.countDocuments(countFilter);
      return { type, count };
    }),
  );

  return counts.filter((entry) => entry.count > 0);
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST / — Create auth profile
 */
authProfileRoutes.post('/', async (req, res) => {
  if (!requirePermissionInline(req, res, 'auth-profile:create')) return;

  const parsed = CreateAuthProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    });
    return;
  }

  const { tenantId } = req.tenantContext!;
  const { name, authType, scope, usageMode, environment, visibility, config, secrets, ...rest } =
    parsed.data;

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { normalizeOAuth2AppConfig } = await import('@agent-platform/shared/validation');
    const normalizedConfig = authType === 'oauth2_app' ? normalizeOAuth2AppConfig(config) : config;
    const resolvedUsageMode = resolveAuthProfileUsageMode(authType, usageMode);

    if (scope !== 'tenant' || visibility !== 'shared' || rest.projectId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: WORKSPACE_ONLY_ROUTE_MESSAGE,
        },
      });
      return;
    }

    if (authType === 'oauth2_token') {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message:
            'oauth2_token profiles are system-managed and cannot be created manually. Use the OAuth authorize/callback flow instead.',
        },
      });
      return;
    }

    if (authType === 'kerberos' && !isKerberosBuildEnabled()) {
      res.status(400).json({
        success: false,
        error: {
          code: 'AUTH_KERBEROS_NOT_BUILT',
          message: 'Kerberos support is not enabled in this build.',
        },
      });
      return;
    }

    const payloadError = await validateAuthProfilePayload(authType, normalizedConfig, secrets);
    if (payloadError) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: payloadError },
      });
      return;
    }

    const ssrfViolation = await validateOAuthUrlsForSSRF(authType, normalizedConfig);
    if (ssrfViolation) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `URL field '${ssrfViolation.field}' blocked by SSRF protection`,
        },
      });
      return;
    }

    if (rest.linkedAppProfileId) {
      const { validateLinkedAppProfile, AuthProfileError } =
        await import('@agent-platform/shared/services/auth-profile');

      try {
        await validateLinkedAppProfile({
          linkedAppProfileId: rest.linkedAppProfileId,
          tenantId,
          requiredScope: 'tenant',
          requiredVisibility: 'shared',
          requiredProjectId: null,
        });
      } catch (err) {
        if (err instanceof AuthProfileError) {
          res.status(err.statusCode).json({
            success: false,
            error: { code: err.code, message: err.message },
          });
          return;
        }
        throw err;
      }
    }

    const { getCurrentAuthProfileKeyVersion } =
      await import('../services/auth-profile/auth-profile-key-version.js');

    const profile = await (AuthProfile as any).create({
      name,
      tenantId,
      authType,
      usageMode: resolvedUsageMode,
      scope,
      environment: environment ?? null,
      visibility,
      config: normalizedConfig,
      encryptedSecrets: JSON.stringify(secrets),
      encryptionKeyVersion: getCurrentAuthProfileKeyVersion(),
      createdBy: req.tenantContext!.userId,
      status: 'active',
      projectId: null,
      linkedAppProfileId: rest.linkedAppProfileId,
      connector: rest.connector,
      category: rest.category,
      tags: rest.tags,
      expiresAt: rest.expiresAt ? new Date(rest.expiresAt) : null,
    });

    log.info('Auth profile created', {
      profileId: profile._id,
      name,
      tenantId,
      authType,
    });

    res.status(201).json({
      success: true,
      data: {
        id: profile._id,
        name: profile.name,
        tenantId: profile.tenantId,
        authType: profile.authType,
        usageMode: profile.usageMode ?? resolvedUsageMode,
        scope: profile.scope,
        environment: profile.environment,
        visibility: profile.visibility,
        status: profile.status,
        createdAt: profile.createdAt,
      },
    });
  } catch (err) {
    // Duplicate key error (unique index on name + tenantId + environment)
    if ((err as any)?.code === 11000) {
      res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE',
          message: `Auth profile "${name}" already exists for this tenant/environment`,
        },
      });
      return;
    }

    log.error('Failed to create auth profile', {
      error: err instanceof Error ? err.message : String(err),
      tenantId,
      name,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create auth profile' },
    });
  }
});

/**
 * GET /by-name/:name — Resolve auth profile by name
 */
authProfileRoutes.get('/by-name/:name', async (req, res) => {
  if (!requirePermissionInline(req, res, 'auth-profile:read')) return;

  const { tenantId } = req.tenantContext!;
  const { name } = req.params;
  const environment = (req.query.environment as string) || undefined;

  if (typeof req.query.projectId === 'string' && req.query.projectId.length > 0) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: WORKSPACE_ONLY_ROUTE_MESSAGE,
      },
    });
    return;
  }

  try {
    const { resolveByName } = await import('../services/auth-profile-resolver.js');
    const result = await resolveByName(name, tenantId, environment);

    if (!result) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Auth profile "${name}" not found` },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        profileId: result.profileId,
        authType: result.authType,
        config: result.config,
        // Secrets are intentionally excluded from the REST response
        hasSecrets: Object.keys(result.secrets).length > 0,
      },
    });
  } catch (err) {
    log.error('Failed to resolve auth profile by name', {
      error: err instanceof Error ? err.message : String(err),
      name,
      tenantId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve auth profile' },
    });
  }
});

/**
 * GET /:id — Get auth profile by ID
 */
authProfileRoutes.get('/:id', async (req, res) => {
  if (!requirePermissionInline(req, res, 'auth-profile:read')) return;

  const { tenantId } = req.tenantContext!;
  const { id } = req.params;

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');
    const profile = await (AuthProfile as any).findOne({
      _id: id,
      tenantId,
      projectId: null,
      scope: 'tenant',
      visibility: 'shared',
    });

    if (!profile) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Auth profile not found' },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        id: profile._id,
        name: profile.name,
        tenantId: profile.tenantId,
        authType: profile.authType,
        usageMode: resolveAuthProfileUsageMode(profile.authType, profile.usageMode),
        scope: profile.scope,
        environment: profile.environment,
        visibility: profile.visibility,
        config: profile.config,
        status: profile.status,
        connector: profile.connector,
        category: profile.category,
        tags: profile.tags,
        migration: getAuthProfileMigrationState(profile),
        expiresAt: profile.expiresAt,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
    });
  } catch (err) {
    log.error('Failed to get auth profile', {
      error: err instanceof Error ? err.message : String(err),
      id,
      tenantId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get auth profile' },
    });
  }
});

/**
 * DELETE /:id — Delete auth profile
 */
authProfileRoutes.delete('/:id', async (req, res) => {
  if (!requirePermissionInline(req, res, 'auth-profile:delete')) return;

  const { tenantId } = req.tenantContext!;
  const { id } = req.params;

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { DistributedLockManager } = await import('@agent-platform/shared');
    const { getRedisClient } = await import('../services/redis/redis-client.js');

    const existingProfile = await (AuthProfile as any).findOne({
      _id: id,
      tenantId,
      projectId: null,
      scope: 'tenant',
      visibility: 'shared',
    });

    if (!existingProfile || existingProfile.status !== 'active') {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Auth profile not found' },
      });
      return;
    }

    const migration = getAuthProfileMigrationState(existingProfile);
    if (migration) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: migration.message,
        },
      });
      return;
    }

    const redis = getRedisClient();
    if (!redis) {
      res.status(503).json({
        success: false,
        error: {
          code: 'PROFILE_DELETE_UNAVAILABLE',
          message: 'Auth profile deletion is unavailable while Redis is offline.',
        },
      });
      return;
    }

    const lockManager = new DistributedLockManager(redis as any);
    const lock = await lockManager.acquire(`${tenantId}:${id}`, {
      keyPrefix: 'auth-profile:op-lock',
      ttlMs: 30_000,
    });

    if (!lock) {
      res.status(409).json({
        success: false,
        error: {
          code: 'PROFILE_BUSY',
          message: 'Auth profile is busy with another operation. Retry the delete shortly.',
        },
      });
      return;
    }

    try {
      const existing = await (AuthProfile as any).findOne({
        _id: id,
        tenantId,
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        status: 'active',
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Auth profile not found' },
        });
        return;
      }

      const consumers = await getAuthProfileConsumerDependencies(id, tenantId);
      if (consumers.length > 0) {
        res.status(409).json({
          success: false,
          error: {
            code: 'PROFILE_IN_USE',
            message: `Cannot delete auth profile — it is referenced by ${consumers.map((consumer) => `${consumer.count} ${consumer.type}`).join(', ')}`,
            consumers,
          },
        });
        return;
      }

      const revokedAt = new Date();
      const tombstoneName = buildDeletedAuthProfileName(existing.name, id);
      const deleted = await (AuthProfile as any).findOneAndUpdate(
        {
          _id: id,
          tenantId,
          projectId: null,
          scope: 'tenant',
          visibility: 'shared',
          status: 'active',
          updatedAt: existing.updatedAt,
        },
        {
          $set: {
            status: 'revoked',
            expiresAt: revokedAt,
            name: tombstoneName,
            encryptedSecrets: JSON.stringify({}),
          },
          $unset: {
            previousEncryptedSecrets: 1,
            linkedAppProfileId: 1,
            lastValidatedAt: 1,
            lastUsedAt: 1,
          },
        },
        {
          new: true,
        },
      );

      if (!deleted) {
        res.status(409).json({
          success: false,
          error: {
            code: 'PROFILE_BUSY',
            message: 'Auth profile changed during delete. Retry the operation.',
          },
        });
        return;
      }

      const { getAuthProfileCache } = await import('../services/auth-profile-resolver.js');
      getAuthProfileCache().invalidate(tenantId, id);

      log.info('Auth profile revoked and tombstoned for delete', { profileId: id, tenantId });
      res.json({ success: true });
    } finally {
      await lockManager.release(lock).catch((releaseErr: unknown) => {
        log.warn('Failed to release auth profile delete lock', {
          profileId: id,
          tenantId,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      });
    }
  } catch (err) {
    log.error('Failed to delete auth profile', {
      error: err instanceof Error ? err.message : String(err),
      id,
      tenantId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete auth profile' },
    });
  }
});

export default router;
