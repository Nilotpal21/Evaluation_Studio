/**
 * SDK Init Route
 *
 * POST /api/v1/sdk/init — Exchange pk_* public API key for SDK session token
 * POST /api/v1/sdk/refresh — Refresh an existing SDK session token
 *
 * Exchanges a pk_* public API key for a short-lived SDK session token.
 * The client uses this token for WebSocket connections and API calls.
 */

import { Router, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import {
  findDeploymentById,
  findDeploymentBySlug,
  findActiveDeployment,
} from '../repos/deployment-repo.js';
import {
  findSDKChannelByName,
  findSDKChannelsByPublicApiKeyId,
  findSDKChannelById,
  findPublicApiKey,
  findWidgetConfig,
  updateSDKChannel,
  type SDKChannelDoc,
} from '../repos/channel-repo.js';
import { getConfig } from '../config/index.js';
import {
  originMatchesAllowlist,
  resolveSdkInitFromPublicKey,
  resolveSdkPublicApiKeyPermissions,
} from '../middleware/sdk-auth.js';
import {
  applyRateLimitHeaders,
  checkTenantOperationRateLimit,
  tenantRateLimit,
} from '../middleware/rate-limiter.js';
import { createLogger } from '@abl/compiler/platform';
import type {
  SDKSessionTokenPayload,
  IdentityTier,
  VerificationMethod,
  SDKTokenEnvelopeMode,
} from '@agent-platform/shared-auth';
import { signSDKSessionToken } from '@agent-platform/shared-auth';
import {
  SDK_USER_CONTEXT_LIMITS,
  issueSdkSessionPrincipalId,
  normalizeSdkUserContext,
} from '../services/identity/sdk-session-token.js';
import { getRuntimeSdkSessionSigningSecret } from '../services/identity/sdk-secret-config.js';
import { resolveSdkChannelDisplayConfig } from '../lib/sdk-channel-display-config.js';
import { consumeSdkBootstrapJti } from '../services/identity/sdk-bootstrap-replay-store.js';
import { resolveActiveDeploymentIdForEnvironment } from './sdk-channel-mutation-utils.js';
import {
  getRuntimeSdkTokenEnvelopeDeps,
  resolveRuntimeSdkTokenEnvelopePolicy,
  verifyRuntimeSdkBootstrapToken,
  verifyRuntimeSdkSessionForAuth,
  wrapRuntimeSdkSessionToken,
  type SDKTokenEnvelopePolicy,
} from '../services/identity/index.js';

const log = createLogger('sdk-init');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/sdk',
  tags: ['SDK'],
});
const router: RouterType = openapi.router;

/** SDK session token TTL: 4 hours (reduced from 24h for security) */
const SDK_TOKEN_TTL_SECONDS = 4 * 60 * 60;
const SDK_REFRESH_REAUTH_VIA_INIT = 're-authenticate via /api/v1/sdk/init';
const SDK_PUBLIC_KEY_REFRESH_CHANNEL_INVALID_ERROR = `SDK channel no longer exists or is inactive — ${SDK_REFRESH_REAUTH_VIA_INIT}`;
const SDK_PUBLIC_KEY_REFRESH_API_KEY_INVALID_ERROR = `API key revoked or expired — ${SDK_REFRESH_REAUTH_VIA_INIT}`;
const SDK_PUBLIC_KEY_REFRESH_API_KEY_BINDING_INVALID_ERROR = `Bootstrap API key is no longer bound to the SDK channel — ${SDK_REFRESH_REAUTH_VIA_INIT}`;
const SDK_PUBLIC_KEY_REFRESH_BOOTSTRAP_REFERENCE_MISSING_ERROR = `Bootstrap API key reference missing from session — ${SDK_REFRESH_REAUTH_VIA_INIT}`;
const SDK_CUSTOMER_REFRESH_CHANNEL_INVALID_ERROR = `Hosted exchange channel no longer exists, is inactive, or no longer allows hosted exchange — ${SDK_REFRESH_REAUTH_VIA_INIT}`;
const SDK_CUSTOMER_REFRESH_API_KEY_INVALID_ERROR = `Hosted exchange channel is not bound to an active public API key — ${SDK_REFRESH_REAUTH_VIA_INIT}`;
const SDK_CUSTOMER_REFRESH_PERMISSIONS_INVALID_ERROR = `Hosted exchange channel permissions changed — ${SDK_REFRESH_REAUTH_VIA_INIT}`;
const SDK_SIGNED_BOOTSTRAP_TOKEN_MAX_BYTES = 4096;
const SDK_ENCRYPTED_BOOTSTRAP_TOKEN_SCHEMA_MAX_BYTES = 16 * 1024;

// =============================================================================
// SCHEMAS
// =============================================================================

const SDKInitRequestSchema = z.object({
  deploymentSlug: z
    .string()
    .max(128)
    .optional()
    .describe(
      'Deployment slug to target (if not specified, uses the channel binding; unbound channels use the working copy)',
    ),
  channelId: z
    .string()
    .max(128)
    .optional()
    .describe('SDK channel ID (preferred over channelName for stable binding)'),
  channelName: z.string().max(64).optional().describe('SDK channel name (defaults to "default")'),
  bootstrapToken: z
    .string()
    .max(SDK_ENCRYPTED_BOOTSTRAP_TOKEN_SCHEMA_MAX_BYTES)
    .optional()
    .describe(
      'Preview/share or customer bootstrap artifact exchanged through the Runtime issuer path',
    ),
  /** User context for personalization (caller attributes only — no mocks, no gather pre-fill) */
  userContext: z
    .object({
      userId: z.string().max(SDK_USER_CONTEXT_LIMITS.maxUserIdLength).optional(),
      customAttributes: z.record(z.unknown()).optional(),
    })
    .optional(),
});

const SDKInitResponseSchema = z.object({
  token: z.string().describe('JWT session token for SDK authentication'),
  tokenEnvelope: z.enum(['signed', 'jwe']).optional().describe('SDK session token envelope'),
  tenantId: z.string().describe('Tenant ID'),
  projectId: z.string().describe('Project ID'),
  deploymentId: z.string().optional().describe('Deployment ID (if resolved)'),
  channelId: z.string().describe('SDK channel ID'),
  permissions: z.array(z.string()).describe('Array of permission strings'),
  showActivityUpdates: z
    .boolean()
    .describe('Whether customer-facing SDK activity updates should be shown'),
  expiresIn: z.number().describe('Token expiration time in seconds'),
});

const SDKRefreshRequestSchema = z.object({}).strict();

const SDKRefreshResponseSchema = z.object({
  token: z.string().describe('New JWT session token'),
  tokenEnvelope: z.enum(['signed', 'jwe']).optional().describe('SDK session token envelope'),
  tenantId: z.string().describe('Tenant ID'),
  projectId: z.string().describe('Project ID'),
  deploymentId: z.string().optional().describe('Deployment ID (if resolved)'),
  channelId: z.string().describe('SDK channel ID'),
  permissions: z.array(z.string()).describe('Array of permission strings'),
  showActivityUpdates: z
    .boolean()
    .describe('Whether customer-facing SDK activity updates should be shown'),
  expiresIn: z.number().describe('Token expiration time in seconds'),
});

const SDK_WIDGET_PERMISSIONS = ['session:send_message', 'session:voice', 'session:read'] as const;
type SDKWidgetPermission = (typeof SDK_WIDGET_PERMISSIONS)[number];

interface ResolvedSdkIssueContext {
  tenantId: string;
  projectId: string;
  deploymentId?: string;
  environment?: string;
  channelId: string;
  permissions: string[];
  showActivityUpdates: boolean;
  keyId?: string;
  bootstrapType: 'public_key' | 'studio_preview' | 'studio_share' | 'customer';
  bootstrapExpiresAt?: number;
  bootstrapUserContext?: SDKSessionTokenPayload['userContext'];
  verifiedUserId?: string;
  identityTier?: IdentityTier;
  verificationMethod?: VerificationMethod;
  channelArtifact?: string;
  tokenEnvelopePolicy?: SDKTokenEnvelopePolicy;
}

interface ResolvedChannelBinding {
  deploymentId?: string;
  environment?: string;
}

type ResolveBootstrapChannelResult =
  | { success: true; channel: SDKChannelDoc }
  | { success: false; status: number; body: Record<string, unknown> };

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function formatZodIssuePath(path: Array<string | number>): string {
  return path.map((segment) => (typeof segment === 'number' ? `[${segment}]` : segment)).join('.');
}

function parseAllowedOrigins(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeSdkWidgetPermissions(permissions: Iterable<unknown>): SDKWidgetPermission[] {
  const normalized = new Set<SDKWidgetPermission>();
  let hasInteractivePermission = false;
  for (const permission of permissions) {
    if (
      typeof permission === 'string' &&
      SDK_WIDGET_PERMISSIONS.includes(permission as SDKWidgetPermission)
    ) {
      normalized.add(permission as SDKWidgetPermission);
      if (permission === 'session:send_message' || permission === 'session:voice') {
        hasInteractivePermission = true;
      }
    }
  }

  if (hasInteractivePermission) {
    normalized.add('session:read');
  }

  return Array.from(normalized);
}

function resolveWidgetPermissions(
  widget:
    | {
        chatEnabled?: boolean | null;
        voiceEnabled?: boolean | null;
      }
    | null
    | undefined,
): SDKWidgetPermission[] {
  return normalizeSdkWidgetPermissions([
    widget?.chatEnabled !== false ? 'session:send_message' : null,
    widget?.voiceEnabled === true ? 'session:voice' : null,
  ]);
}

async function findActiveBootstrapChannel(
  tenantId: string,
  projectId: string,
  channelId: string,
): Promise<SDKChannelDoc | null> {
  const channel = await findSDKChannelById(channelId, projectId, tenantId);
  if (!channel || !channel.isActive) {
    return null;
  }

  return channel;
}

async function resolveChannelBindingForBootstrap(params: {
  tenantId: string;
  projectId: string;
  channel: Pick<SDKChannelDoc, 'id' | 'deploymentId' | 'environment' | 'followEnvironment'>;
  deploymentSlug?: string;
}): Promise<
  | { success: true; binding: ResolvedChannelBinding }
  | { success: false; status: number; body: Record<string, unknown> }
> {
  if (params.deploymentSlug) {
    const deployment = await findDeploymentBySlug(params.deploymentSlug);
    if (!deployment || deployment.projectId !== params.projectId) {
      return { success: false, status: 404, body: { error: 'Deployment not found' } };
    }
    if (deployment.status !== 'active') {
      return { success: false, status: 410, body: { error: 'Deployment is not active' } };
    }
    return {
      success: true,
      binding: {
        deploymentId: deployment.id,
        environment: deployment.environment || undefined,
      },
    };
  }

  if (params.channel.deploymentId) {
    const deployment = await findDeploymentById(
      params.channel.deploymentId,
      params.projectId,
      params.tenantId,
    );
    if (!deployment) {
      return { success: false, status: 404, body: { error: 'Deployment not found' } };
    }
    if (deployment.status === 'retired') {
      if (!params.channel.environment || !params.channel.followEnvironment) {
        return { success: false, status: 410, body: { error: 'Deployment is retired' } };
      }

      const activeDeploymentId = await resolveActiveDeploymentIdForEnvironment({
        projectId: params.projectId,
        tenantId: params.tenantId,
        environment: params.channel.environment,
      });
      if (!activeDeploymentId) {
        return { success: false, status: 410, body: { error: 'Deployment is retired' } };
      }

      const updatedChannel = await updateSDKChannel(
        params.channel.id,
        params.projectId,
        params.tenantId,
        {
          deploymentId: activeDeploymentId,
        },
      );
      if (!updatedChannel) {
        return { success: false, status: 404, body: { error: 'Channel not found' } };
      }

      return {
        success: true,
        binding: {
          deploymentId: activeDeploymentId,
          environment: params.channel.environment,
        },
      };
    }
    return {
      success: true,
      binding: {
        deploymentId: params.channel.deploymentId,
        environment: params.channel.environment || undefined,
      },
    };
  }

  if (params.channel.environment) {
    const deployment = await findActiveDeployment(
      params.projectId,
      params.tenantId,
      params.channel.environment,
    );
    return {
      success: true,
      binding: {
        deploymentId: deployment?.id,
        environment: params.channel.environment,
      },
    };
  }

  return { success: true, binding: {} };
}

async function resolveBootstrapChannelForPublicKey(params: {
  tenantId: string;
  projectId: string;
  keyId: string;
  channelId?: string;
  channelName?: string;
}): Promise<ResolveBootstrapChannelResult> {
  const requestedChannelId = params.channelId?.trim();
  const requestedChannelName = params.channelName?.trim();

  if (requestedChannelId) {
    const channel = await findSDKChannelById(requestedChannelId, params.projectId, params.tenantId);
    if (!channel || channel.publicApiKeyId !== params.keyId) {
      return {
        success: false,
        status: 404,
        body: {
          error: 'SDK channel not found',
          message: 'No active SDK channel with that ID is bound to this public key.',
        },
      };
    }

    if (!channel.isActive) {
      return {
        success: false,
        status: 410,
        body: {
          error: 'SDK channel is inactive',
          message:
            'The requested SDK channel is inactive. Reconfigure the client or reactivate the channel.',
        },
      };
    }

    return { success: true, channel };
  }

  if (requestedChannelName) {
    const channel = await findSDKChannelByName(
      params.tenantId,
      params.projectId,
      requestedChannelName,
    );
    if (!channel || channel.publicApiKeyId !== params.keyId) {
      return {
        success: false,
        status: 404,
        body: {
          error: 'SDK channel not found',
          message: 'No active SDK channel with that name is bound to this public key.',
        },
      };
    }

    if (!channel.isActive) {
      return {
        success: false,
        status: 410,
        body: {
          error: 'SDK channel is inactive',
          message:
            'The requested SDK channel is inactive. Reconfigure the client or reactivate the channel.',
        },
      };
    }

    return { success: true, channel };
  }

  const channels = await findSDKChannelsByPublicApiKeyId(
    params.tenantId,
    params.projectId,
    params.keyId,
  );
  const activeChannels = channels.filter((channel) => channel.isActive);

  if (activeChannels.length === 0) {
    return {
      success: false,
      status: 409,
      body: {
        error: 'SDK channel not configured',
        message:
          'This public key is not bound to an active SDK channel. Create one or provide a bound channelName.',
      },
    };
  }

  if (activeChannels.length > 1) {
    return {
      success: false,
      status: 409,
      body: {
        error: 'SDK channel is ambiguous',
        message:
          'Multiple active SDK channels are bound to this public key. Provide channelName explicitly.',
      },
    };
  }

  return { success: true, channel: activeChannels[0]! };
}

async function ensureTenantScopedProject(
  projectId: string,
  tenantId: string,
): Promise<{ id: string; tenantId: string; name?: string } | null> {
  const { Project } = await import('@agent-platform/database/models');
  const project = await Project.findOne(
    { _id: projectId, tenantId },
    { _id: 1, tenantId: 1, name: 1 },
  ).lean();

  if (!project) {
    return null;
  }

  return {
    id: String((project as { _id: unknown })._id),
    tenantId: String((project as { tenantId: unknown }).tenantId),
    name:
      typeof (project as { name?: unknown }).name === 'string'
        ? ((project as { name?: string }).name ?? undefined)
        : undefined,
  };
}

function issueSdkSessionToken(payload: Omit<SDKSessionTokenPayload, 'iat' | 'exp'>): string {
  return signSDKSessionToken(payload, getRuntimeSdkSessionSigningSecret(), {
    expiresIn: SDK_TOKEN_TTL_SECONDS,
  });
}

async function issueSdkSessionTokenWithEnvelope(
  payload: Omit<SDKSessionTokenPayload, 'iat' | 'exp'>,
  envelopeMode: SDKTokenEnvelopeMode,
): Promise<
  | { success: true; token: string; tokenEnvelope: SDKTokenEnvelopeMode }
  | { success: false; status: number; body: Record<string, unknown>; logReason: string }
> {
  const signedToken = issueSdkSessionToken({
    ...payload,
    ...(envelopeMode === 'jwe' ? { tokenEnvelope: 'jwe' as const } : {}),
  });

  if (envelopeMode === 'signed') {
    return { success: true, token: signedToken, tokenEnvelope: 'signed' };
  }

  const wrapped = await wrapRuntimeSdkSessionToken(signedToken, getRuntimeSdkTokenEnvelopeDeps());
  if (!wrapped.success) {
    return {
      success: false,
      status: wrapped.code === 'SDK_TOKEN_TOO_LARGE' ? 413 : wrapped.status,
      body: {
        error: wrapped.code,
        message:
          wrapped.code === 'SDK_TOKEN_TOO_LARGE'
            ? 'SDK session token exceeds encrypted token size budget'
            : 'SDK session token encryption is unavailable',
      },
      logReason: wrapped.logReason,
    };
  }

  return { success: true, token: wrapped.data, tokenEnvelope: 'jwe' };
}

function isJweShapedSdkToken(token: string): boolean {
  return token.split('.').length === 5;
}

function getSdkBootstrapTokenMaxBytes(token: string): number {
  if (isJweShapedSdkToken(token)) {
    return getRuntimeSdkTokenEnvelopeDeps().maxEncryptedBootstrapBytes;
  }

  return SDK_SIGNED_BOOTSTRAP_TOKEN_MAX_BYTES;
}

function getSdkBootstrapTokenByteLength(token: string): number {
  return Buffer.byteLength(token, 'utf8');
}

function buildBootstrapTokenSizeValidationBody(maxBytes: number): Record<string, unknown> {
  return {
    error: 'VALIDATION_ERROR',
    message: 'Invalid SDK init request body',
    issues: [`bootstrapToken: String must contain at most ${maxBytes} byte(s)`],
  };
}

async function resolveBootstrapIssueContext(
  bootstrapToken: string,
  originHeader: string | string[] | undefined,
): Promise<
  | { success: true; data: ResolvedSdkIssueContext }
  | { success: false; status: number; body: Record<string, unknown> }
> {
  const verification = await verifyRuntimeSdkBootstrapToken(
    bootstrapToken,
    getRuntimeSdkTokenEnvelopeDeps(),
  );
  if (!verification.success) {
    return {
      success: false,
      status: 401,
      body: { error: 'Invalid or expired bootstrap token' },
    };
  }
  const artifact = verification.data;

  const project = await ensureTenantScopedProject(artifact.projectId, artifact.tenantId);
  if (!project) {
    return { success: false, status: 404, body: { error: 'Project not found' } };
  }

  const channel = await findActiveBootstrapChannel(
    artifact.tenantId,
    project.id,
    artifact.channelId,
  );
  if (!channel) {
    return { success: false, status: 404, body: { error: 'Channel not found' } };
  }

  if (verification.envelope === 'jwe' && artifact.type !== 'customer') {
    return {
      success: false,
      status: 401,
      body: { error: 'Invalid or expired bootstrap token' },
    };
  }

  let customerPermissions: string[] | null = null;
  let customerEnvelopePolicy: SDKTokenEnvelopePolicy | undefined;
  if (artifact.type === 'customer') {
    const envelopePolicy = await resolveRuntimeSdkTokenEnvelopePolicy({
      tenantId: artifact.tenantId,
      projectId: project.id,
      channel,
      bootstrapType: 'customer',
    });
    customerEnvelopePolicy = envelopePolicy;
    if (
      (verification.envelope === 'signed' && !envelopePolicy.acceptsSignedBootstrap) ||
      (verification.envelope === 'jwe' && !envelopePolicy.acceptsJweBootstrap)
    ) {
      return {
        success: false,
        status: 401,
        body: { error: 'Invalid or expired bootstrap token' },
      };
    }

    const publicApiKey = await findPublicApiKey({
      id: channel.publicApiKeyId,
      projectId: project.id,
      tenantId: artifact.tenantId,
    });
    if (
      !publicApiKey ||
      !publicApiKey.isActive ||
      (publicApiKey.expiresAt && publicApiKey.expiresAt < new Date())
    ) {
      return {
        success: false,
        status: 422,
        body: {
          error: 'Hosted exchange channel is not bound to an active public API key',
        },
      };
    }

    const channelAllowedOrigins = parseAllowedOrigins(channel.config?.allowedOrigins);
    const publicKeyAllowedOrigins = parseAllowedOrigins(publicApiKey.allowedOrigins);
    const allowedOrigins = channelAllowedOrigins ?? publicKeyAllowedOrigins;
    if (
      allowedOrigins &&
      allowedOrigins.length > 0 &&
      !originMatchesAllowlist(allowedOrigins, originHeader)
    ) {
      return {
        success: false,
        status: 403,
        body: { error: 'Origin not allowed' },
      };
    }

    const currentPermissions = normalizeSdkWidgetPermissions(
      resolveSdkPublicApiKeyPermissions(publicApiKey.permissions),
    );
    const requestedPermissions =
      artifact.permissions && artifact.permissions.length > 0
        ? normalizeSdkWidgetPermissions(artifact.permissions)
        : currentPermissions;
    const effectivePermissions = normalizeSdkWidgetPermissions(
      requestedPermissions.filter((permission) => currentPermissions.includes(permission)),
    );
    if (effectivePermissions.length === 0) {
      return {
        success: false,
        status: 403,
        body: { error: 'Hosted exchange permissions are no longer allowed for this channel' },
      };
    }
    customerPermissions = effectivePermissions;

    const replay = await consumeSdkBootstrapJti({
      jti: artifact.jti,
      tenantId: artifact.tenantId,
      projectId: project.id,
      channelId: channel.id,
      expiresAtMs: artifact.exp,
    });
    if (!replay.success) {
      if (replay.reason === 'unavailable') {
        return {
          success: false,
          status: 503,
          body: { error: 'Customer bootstrap replay protection unavailable' },
        };
      }

      return {
        success: false,
        status: 401,
        body: {
          error:
            replay.reason === 'expired'
              ? 'Invalid or expired bootstrap token'
              : 'Bootstrap token already used',
        },
      };
    }
  }

  const bindingResolution = await resolveChannelBindingForBootstrap({
    tenantId: artifact.tenantId,
    projectId: project.id,
    channel,
  });
  if (!bindingResolution.success) {
    return bindingResolution;
  }

  if (artifact.type === 'customer') {
    if (!customerPermissions) {
      return {
        success: false,
        status: 500,
        body: { error: 'Customer bootstrap permissions were not resolved' },
      };
    }

    return {
      success: true,
      data: {
        tenantId: artifact.tenantId,
        projectId: project.id,
        deploymentId: bindingResolution.binding.deploymentId,
        environment: bindingResolution.binding.environment,
        channelId: channel.id,
        permissions: customerPermissions,
        showActivityUpdates: resolveSdkChannelDisplayConfig(channel.config).showActivityUpdates,
        bootstrapType: 'customer',
        bootstrapUserContext: artifact.userContext,
        verifiedUserId: artifact.verifiedUserId,
        identityTier: 2,
        verificationMethod: 'server_secret',
        channelArtifact: artifact.channelArtifact,
        tokenEnvelopePolicy: customerEnvelopePolicy,
      },
    };
  }

  const widget = await findWidgetConfig(project.id, artifact.tenantId);
  const currentPermissions = resolveWidgetPermissions(widget);
  const requestedPermissions =
    artifact.permissions && artifact.permissions.length > 0
      ? normalizeSdkWidgetPermissions(artifact.permissions)
      : currentPermissions;
  const effectivePermissions = normalizeSdkWidgetPermissions(
    requestedPermissions.filter((permission) => currentPermissions.includes(permission)),
  );

  if (effectivePermissions.length === 0) {
    return artifact.type === 'preview'
      ? {
          success: false,
          status: 422,
          body: { error: 'Preview is not enabled for this project' },
        }
      : {
          success: false,
          status: 403,
          body: { error: 'Share link is no longer allowed for this preview' },
        };
  }

  return {
    success: true,
    data: {
      tenantId: artifact.tenantId,
      projectId: project.id,
      deploymentId: bindingResolution.binding.deploymentId,
      environment: bindingResolution.binding.environment,
      channelId: channel.id,
      permissions: effectivePermissions,
      showActivityUpdates: resolveSdkChannelDisplayConfig(channel.config).showActivityUpdates,
      bootstrapType: artifact.type === 'preview' ? 'studio_preview' : 'studio_share',
      bootstrapExpiresAt: artifact.exp,
    },
  };
}

async function resolvePreviewShareRefresh(
  payload: SDKSessionTokenPayload,
): Promise<{ success: true; binding: ResolvedChannelBinding } | { success: false; error: string }> {
  if (
    typeof payload.bootstrapExpiresAt === 'number' &&
    Number.isFinite(payload.bootstrapExpiresAt) &&
    Date.now() > payload.bootstrapExpiresAt
  ) {
    return {
      success: false,
      error: 'Bootstrap artifact expired — re-authenticate via Studio preview/share',
    };
  }

  const project = await ensureTenantScopedProject(payload.projectId, payload.tenantId);
  if (!project) {
    return {
      success: false,
      error: 'Project no longer exists — re-authenticate via Studio preview/share',
    };
  }

  const channel = await findActiveBootstrapChannel(payload.tenantId, project.id, payload.channelId);
  if (!channel) {
    return {
      success: false,
      error: 'Channel no longer exists or is inactive — re-authenticate via Studio preview/share',
    };
  }

  const currentPermissions = new Set(
    resolveWidgetPermissions(await findWidgetConfig(project.id, payload.tenantId)),
  );
  const allPermissionsStillAllowed = payload.permissions.every((permission) =>
    currentPermissions.has(permission as SDKWidgetPermission),
  );
  if (!allPermissionsStillAllowed) {
    return {
      success: false,
      error: 'Preview/share permissions changed — re-authenticate via Studio preview/share',
    };
  }

  const bindingResolution = await resolveChannelBindingForBootstrap({
    tenantId: payload.tenantId,
    projectId: project.id,
    channel,
  });
  if (!bindingResolution.success) {
    return {
      success: false,
      error: 'Channel binding is no longer valid — re-authenticate via Studio preview/share',
    };
  }

  return { success: true, binding: bindingResolution.binding };
}

async function resolvePublicKeyRefresh(
  payload: SDKSessionTokenPayload,
): Promise<{ success: true; binding: ResolvedChannelBinding } | { success: false; error: string }> {
  if (!payload.bootstrapKeyId) {
    return {
      success: false,
      error: SDK_PUBLIC_KEY_REFRESH_BOOTSTRAP_REFERENCE_MISSING_ERROR,
    };
  }

  const channel = await findSDKChannelById(payload.channelId, payload.projectId, payload.tenantId);
  if (!channel || !channel.isActive) {
    return {
      success: false,
      error: SDK_PUBLIC_KEY_REFRESH_CHANNEL_INVALID_ERROR,
    };
  }

  if (channel.publicApiKeyId !== payload.bootstrapKeyId) {
    log.warn('SDK refresh denied — bootstrap API key no longer bound to channel', {
      channelId: payload.channelId,
      bootstrapKeyId: payload.bootstrapKeyId,
      currentPublicApiKeyId: channel.publicApiKeyId ?? null,
    });
    return {
      success: false,
      error: SDK_PUBLIC_KEY_REFRESH_API_KEY_BINDING_INVALID_ERROR,
    };
  }

  // Defense-in-depth: scope the key lookup by projectId so a key ID from
  // a different project (or a stale token referencing a reassigned key)
  // cannot pass validation.
  const key = await findPublicApiKey({
    id: payload.bootstrapKeyId,
    projectId: payload.projectId,
    tenantId: payload.tenantId,
  });
  if (!key || !key.isActive || (key.expiresAt && key.expiresAt < new Date())) {
    log.warn('SDK refresh denied — public API key revoked or expired', {
      channelId: payload.channelId,
      bootstrapKeyId: payload.bootstrapKeyId,
    });
    return {
      success: false,
      error: SDK_PUBLIC_KEY_REFRESH_API_KEY_INVALID_ERROR,
    };
  }

  const bindingResolution = await resolveChannelBindingForBootstrap({
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    channel,
  });
  if (!bindingResolution.success) {
    return {
      success: false,
      error: SDK_PUBLIC_KEY_REFRESH_CHANNEL_INVALID_ERROR,
    };
  }

  return { success: true, binding: bindingResolution.binding };
}

async function resolveCustomerHostedExchangeRefresh(
  payload: SDKSessionTokenPayload,
): Promise<
  | { success: true; binding: ResolvedChannelBinding; envelopePolicy: SDKTokenEnvelopePolicy }
  | { success: false; error: string }
> {
  const channel = await findSDKChannelById(payload.channelId, payload.projectId, payload.tenantId);
  if (!channel || !channel.isActive || channel.authMode !== 'hosted_exchange') {
    return {
      success: false,
      error: SDK_CUSTOMER_REFRESH_CHANNEL_INVALID_ERROR,
    };
  }

  const key = await findPublicApiKey({
    id: channel.publicApiKeyId,
    projectId: payload.projectId,
    tenantId: payload.tenantId,
  });
  if (!key || !key.isActive || (key.expiresAt && key.expiresAt < new Date())) {
    return {
      success: false,
      error: SDK_CUSTOMER_REFRESH_API_KEY_INVALID_ERROR,
    };
  }

  const envelopePolicy = await resolveRuntimeSdkTokenEnvelopePolicy({
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    channel,
    bootstrapType: 'customer',
  });

  const currentPermissions = new Set(resolveSdkPublicApiKeyPermissions(key.permissions));
  const allPermissionsStillAllowed = payload.permissions.every((permission) =>
    currentPermissions.has(permission),
  );
  if (!allPermissionsStillAllowed) {
    log.warn('SDK refresh denied — hosted exchange permissions changed', {
      channelId: payload.channelId,
      permissions: payload.permissions,
      currentPermissions: [...currentPermissions],
    });
    return {
      success: false,
      error: SDK_CUSTOMER_REFRESH_PERMISSIONS_INVALID_ERROR,
    };
  }

  const bindingResolution = await resolveChannelBindingForBootstrap({
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    channel,
  });
  if (!bindingResolution.success) {
    return {
      success: false,
      error: SDK_CUSTOMER_REFRESH_CHANNEL_INVALID_ERROR,
    };
  }

  return { success: true, binding: bindingResolution.binding, envelopePolicy };
}

/**
 * POST /api/v1/sdk/init
 *
 * Headers: X-Public-Key: pk_xxx
 * Body: { deploymentSlug?, channelId?, channelName? }
 *
 * Exchanges a pk_* public API key for a short-lived SDK session token.
 * The token is used for WebSocket connections and API calls.
 */
openapi.route(
  'post',
  '/init',
  {
    summary: 'Exchange public API key for SDK session token',
    description:
      'Exchanges a pk_* public API key for a short-lived SDK session token. ' +
      'The client uses this token for WebSocket connections and subsequent API calls.',
    body: SDKInitRequestSchema,
    response: SDKInitResponseSchema,
    successStatus: 200,
  },
  tenantRateLimit('request', { requestsPerMinute: 30 }),
  async (req, res) => {
    const parsedBody = SDKInitRequestSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid SDK init request body',
        issues: parsedBody.error.issues.map((issue) => {
          const path = formatZodIssuePath(issue.path);
          return path ? `${path}: ${issue.message}` : issue.message;
        }),
      });
      return;
    }

    const { deploymentSlug, channelId, channelName, bootstrapToken, userContext } = parsedBody.data;
    const hasPublicKey = typeof req.headers['x-public-key'] === 'string';
    const normalizedDeploymentSlug = normalizeOptionalString(deploymentSlug);
    const normalizedChannelId = normalizeOptionalString(channelId);
    const normalizedChannelName = normalizeOptionalString(channelName);
    const normalizedBootstrapToken = normalizeOptionalString(bootstrapToken);

    if (normalizedBootstrapToken) {
      const maxBootstrapTokenBytes = getSdkBootstrapTokenMaxBytes(normalizedBootstrapToken);
      if (getSdkBootstrapTokenByteLength(normalizedBootstrapToken) > maxBootstrapTokenBytes) {
        res.status(400).json(buildBootstrapTokenSizeValidationBody(maxBootstrapTokenBytes));
        return;
      }
    }

    if (hasPublicKey && normalizedBootstrapToken) {
      res.status(400).json({
        error: 'INVALID_BOOTSTRAP_REQUEST',
        message: 'Use exactly one bootstrap method: X-Public-Key or bootstrapToken',
      });
      return;
    }

    if (!hasPublicKey && !normalizedBootstrapToken) {
      res.status(401).json({
        error: 'Missing X-Public-Key header or bootstrapToken',
      });
      return;
    }

    if (normalizedChannelId && normalizedChannelName) {
      res.status(400).json({
        error: 'INVALID_BOOTSTRAP_REQUEST',
        message: 'channelId cannot be combined with channelName',
      });
      return;
    }

    if (
      normalizedBootstrapToken &&
      (normalizedDeploymentSlug || normalizedChannelId || normalizedChannelName)
    ) {
      res.status(400).json({
        error: 'INVALID_BOOTSTRAP_REQUEST',
        message: 'bootstrapToken cannot be combined with deploymentSlug, channelId, or channelName',
      });
      return;
    }

    const normalizedUserContextResult = normalizeSdkUserContext(userContext);
    if (!normalizedUserContextResult.success) {
      res.status(400).json({
        error: normalizedUserContextResult.error.code,
        message: normalizedUserContextResult.error.message,
        issues: normalizedUserContextResult.error.issues,
      });
      return;
    }

    const normalizedUserContext = normalizedUserContextResult.data;
    const sessionPrincipalId = issueSdkSessionPrincipalId();

    try {
      let issueContext: ResolvedSdkIssueContext;

      if (normalizedBootstrapToken) {
        const bootstrapResult = await resolveBootstrapIssueContext(
          normalizedBootstrapToken,
          req.headers.origin,
        );
        if (!bootstrapResult.success) {
          res.status(bootstrapResult.status).json(bootstrapResult.body);
          return;
        }

        issueContext = bootstrapResult.data;
        if (
          issueContext.bootstrapType === 'customer' &&
          normalizedUserContext &&
          (normalizedUserContext.userId || normalizedUserContext.customAttributes)
        ) {
          res.status(400).json({
            error: 'INVALID_BOOTSTRAP_REQUEST',
            message: 'Customer bootstrap tokens cannot be combined with browser userContext',
          });
          return;
        }
      } else {
        const sdkInitResult = await resolveSdkInitFromPublicKey(req.headers);
        if (!sdkInitResult.success) {
          res.status(sdkInitResult.status).json(sdkInitResult.body);
          return;
        }
        const sdkInit = sdkInitResult.data;

        const resolvedChannel = await resolveBootstrapChannelForPublicKey({
          tenantId: sdkInit.tenantId,
          projectId: sdkInit.projectId,
          keyId: sdkInit.keyId,
          channelId: normalizedChannelId,
          channelName: normalizedChannelName,
        });
        if (!resolvedChannel.success) {
          res.status(resolvedChannel.status).json(resolvedChannel.body);
          return;
        }
        const channel = resolvedChannel.channel;

        const bindingResolution = await resolveChannelBindingForBootstrap({
          tenantId: sdkInit.tenantId,
          projectId: sdkInit.projectId,
          channel,
          deploymentSlug: normalizedDeploymentSlug,
        });
        if (!bindingResolution.success) {
          res.status(bindingResolution.status).json(bindingResolution.body);
          return;
        }

        issueContext = {
          keyId: sdkInit.keyId,
          tenantId: sdkInit.tenantId,
          projectId: sdkInit.projectId,
          deploymentId: bindingResolution.binding.deploymentId,
          environment: bindingResolution.binding.environment,
          channelId: channel.id,
          permissions: sdkInit.permissions,
          showActivityUpdates: resolveSdkChannelDisplayConfig(channel.config).showActivityUpdates,
          bootstrapType: 'public_key',
        };
      }

      const effectiveUserContext = issueContext.bootstrapUserContext ?? normalizedUserContext;
      const effectiveVerifiedUserId = issueContext.verifiedUserId;
      const identityTier = issueContext.identityTier ?? 0;
      const verificationMethod = issueContext.verificationMethod ?? 'none';
      const channelArtifact = issueContext.channelArtifact;

      const tokenEnvelopeMode = issueContext.tokenEnvelopePolicy?.sessionMode ?? 'signed';
      if (tokenEnvelopeMode === 'jwe' && !issueContext.tokenEnvelopePolicy?.canIssueSession) {
        res.status(503).json({
          error: 'SDK_JWE_UNAVAILABLE',
          message: 'SDK session token encryption is unavailable',
        });
        return;
      }

      const tokenPayload: Omit<SDKSessionTokenPayload, 'iat' | 'exp'> = {
        type: 'sdk_session',
        tenantId: issueContext.tenantId,
        projectId: issueContext.projectId,
        deploymentId: issueContext.deploymentId,
        ...(issueContext.environment ? { environment: issueContext.environment } : {}),
        channelId: issueContext.channelId,
        sessionId: sessionPrincipalId,
        sessionPrincipal: sessionPrincipalId,
        permissions: issueContext.permissions,
        ...(effectiveUserContext && { userContext: effectiveUserContext }),
        ...(effectiveVerifiedUserId && { verifiedUserId: effectiveVerifiedUserId }),
        ...(channelArtifact && { channelArtifact }),
        identityTier,
        verificationMethod,
        authScope: effectiveVerifiedUserId ? 'user' : 'session',
        bootstrapType: issueContext.bootstrapType,
        ...(issueContext.keyId ? { bootstrapKeyId: issueContext.keyId } : {}),
        ...(typeof issueContext.bootstrapExpiresAt === 'number'
          ? { bootstrapExpiresAt: issueContext.bootstrapExpiresAt }
          : {}),
      };

      const issuedToken = await issueSdkSessionTokenWithEnvelope(tokenPayload, tokenEnvelopeMode);
      if (!issuedToken.success) {
        log.warn('SDK session token envelope issuance failed', {
          tenantId: issueContext.tenantId,
          projectId: issueContext.projectId,
          channelId: issueContext.channelId,
          logReason: issuedToken.logReason,
        });
        res.status(issuedToken.status).json(issuedToken.body);
        return;
      }

      log.info('SDK session token issued', {
        tenantId: issueContext.tenantId,
        projectId: issueContext.projectId,
        channelId: issueContext.channelId,
        deploymentId: issueContext.deploymentId,
        bootstrapType: issueContext.bootstrapType,
        tokenEnvelope: issuedToken.tokenEnvelope,
        expiresIn: SDK_TOKEN_TTL_SECONDS,
      });

      res.json({
        token: issuedToken.token,
        tokenEnvelope: issuedToken.tokenEnvelope,
        tenantId: issueContext.tenantId,
        projectId: issueContext.projectId,
        deploymentId: issueContext.deploymentId,
        channelId: issueContext.channelId,
        permissions: issueContext.permissions,
        showActivityUpdates: issueContext.showActivityUpdates,
        expiresIn: SDK_TOKEN_TTL_SECONDS,
      });
    } catch (error) {
      log.error('SDK init error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// =============================================================================
// SDK TOKEN REFRESH
// =============================================================================

/**
 * POST /api/v1/sdk/refresh
 *
 * Headers: X-SDK-Token: <current-token>
 *
 * Validates the existing (not-yet-expired) token and issues a fresh one
 * with the same claims but a renewed TTL. Returns 401 if the token is
 * invalid or already expired.
 */
openapi.route(
  'post',
  '/refresh',
  {
    summary: 'Refresh SDK session token',
    description:
      'Validates the existing (not-yet-expired) token and issues a fresh one ' +
      'with the same claims but a renewed TTL. Returns 401 if the token is invalid or expired.',
    body: SDKRefreshRequestSchema,
    response: SDKRefreshResponseSchema,
    successStatus: 200,
  },
  async (req, res) => {
    const sdkToken = req.headers['x-sdk-token'] as string | undefined;
    if (!sdkToken) {
      res.status(401).json({ error: 'Missing X-SDK-Token header' });
      return;
    }

    try {
      const verifiedSession = await verifyRuntimeSdkSessionForAuth(sdkToken);
      if (!verifiedSession.success) {
        res.status(verifiedSession.status).json({
          error: verifiedSession.error,
          code: verifiedSession.code,
        });
        return;
      }
      const payload = verifiedSession.payload;

      const refreshRateLimit = await checkTenantOperationRateLimit({
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        operation: 'request',
        overrideLimits: { requestsPerMinute: 20 },
      });
      applyRateLimitHeaders(res, refreshRateLimit);
      if (!refreshRateLimit.allowed) {
        res.status(429).json({
          error: 'Rate limit exceeded',
          operation: 'request',
          limit: refreshRateLimit.limit,
          retryAfterMs: refreshRateLimit.resetMs,
        });
        return;
      }

      let refreshedBinding: ResolvedChannelBinding = {};
      let refreshedEnvelopeMode: SDKTokenEnvelopeMode = 'signed';
      if (payload.bootstrapType === 'studio_preview' || payload.bootstrapType === 'studio_share') {
        const previewShareRefresh = await resolvePreviewShareRefresh(payload);
        if (!previewShareRefresh.success) {
          res.status(401).json({ error: previewShareRefresh.error });
          return;
        }
        refreshedBinding = previewShareRefresh.binding;
      } else if (payload.bootstrapType === 'customer') {
        const customerRefresh = await resolveCustomerHostedExchangeRefresh(payload);
        if (!customerRefresh.success) {
          res.status(401).json({ error: customerRefresh.error });
          return;
        }
        refreshedBinding = customerRefresh.binding;
        refreshedEnvelopeMode = customerRefresh.envelopePolicy.sessionMode;
        if (refreshedEnvelopeMode === 'jwe' && !customerRefresh.envelopePolicy.canIssueSession) {
          res.status(503).json({
            error: 'SDK_JWE_UNAVAILABLE',
            message: 'SDK session token encryption is unavailable',
          });
          return;
        }
      } else {
        const publicKeyRefresh = await resolvePublicKeyRefresh(payload);
        if (!publicKeyRefresh.success) {
          res.status(401).json({ error: publicKeyRefresh.error });
          return;
        }
        refreshedBinding = publicKeyRefresh.binding;
      }

      const newPayload: Omit<SDKSessionTokenPayload, 'iat' | 'exp'> = {
        type: 'sdk_session',
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        deploymentId: refreshedBinding.deploymentId,
        ...(refreshedBinding.environment ? { environment: refreshedBinding.environment } : {}),
        channelId: payload.channelId,
        sessionId: payload.sessionId,
        sessionPrincipal: payload.sessionPrincipal,
        contactId: payload.contactId,
        permissions: payload.permissions,
        ...(payload.userContext && { userContext: payload.userContext }),
        ...(payload.verifiedUserId && { verifiedUserId: payload.verifiedUserId }),
        identityTier: payload.identityTier,
        verificationMethod: payload.verificationMethod,
        authScope: payload.authScope,
        channelArtifact: payload.channelArtifact,
        bootstrapType: payload.bootstrapType,
        ...(payload.bootstrapKeyId ? { bootstrapKeyId: payload.bootstrapKeyId } : {}),
        ...(typeof payload.bootstrapExpiresAt === 'number'
          ? { bootstrapExpiresAt: payload.bootstrapExpiresAt }
          : {}),
      };

      const issuedToken = await issueSdkSessionTokenWithEnvelope(newPayload, refreshedEnvelopeMode);
      if (!issuedToken.success) {
        log.warn('SDK session refresh envelope issuance failed', {
          tenantId: payload.tenantId,
          projectId: payload.projectId,
          channelId: payload.channelId,
          logReason: issuedToken.logReason,
        });
        res.status(issuedToken.status).json(issuedToken.body);
        return;
      }

      log.info('SDK session token refreshed', {
        tenantId: payload.tenantId,
        channelId: payload.channelId,
        tokenEnvelope: issuedToken.tokenEnvelope,
      });

      const channel = await findSDKChannelById(
        payload.channelId,
        payload.projectId,
        payload.tenantId,
      );
      const showActivityUpdates = resolveSdkChannelDisplayConfig(
        channel?.config,
      ).showActivityUpdates;

      res.json({
        token: issuedToken.token,
        tokenEnvelope: issuedToken.tokenEnvelope,
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        deploymentId: refreshedBinding.deploymentId,
        channelId: payload.channelId,
        permissions: payload.permissions,
        showActivityUpdates,
        expiresIn: SDK_TOKEN_TTL_SECONDS,
      });
    } catch (error) {
      log.warn('SDK token refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(401).json({ error: 'Invalid token' });
    }
  },
);

export default openapi.router;
