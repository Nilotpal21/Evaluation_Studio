import { randomUUID } from 'node:crypto';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { createLogger } from '@abl/compiler/platform';
import type { Response } from 'express';
import { z } from 'zod';
import { runtimeRegistry } from '../openapi/registry.js';
import {
  findSDKChannelById,
  findSDKChannelByName,
  findPublicApiKey,
  type SDKChannelDoc,
} from '../repos/channel-repo.js';
import { signSdkBootstrapArtifact } from '@agent-platform/shared';
import { resolveSdkPublicApiKeyPermissions } from '../middleware/sdk-auth.js';
import { getRuntimeTenantScopedSdkBootstrapSigningSecret } from '../services/identity/sdk-secret-config.js';
import { deriveVerifiedSdkChannelArtifact } from '../services/identity/artifact-hasher.js';
import { verifySdkChannelServerSecret } from '../services/identity/sdk-channel-server-secret.js';
import {
  SDK_USER_CONTEXT_LIMITS,
  normalizeSdkUserContext,
} from '../services/identity/sdk-session-token.js';
import {
  getRuntimeSdkTokenEnvelopeDeps,
  resolveRuntimeSdkTokenEnvelopePolicy,
  wrapRuntimeSdkBootstrapToken,
} from '../services/identity/index.js';
import {
  applyRateLimitHeaders,
  checkTenantOperationRateLimit,
} from '../middleware/rate-limiter.js';

const log = createLogger('sdk-customer-sessions');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/sdk',
  tags: ['SDK'],
});

const SDK_CUSTOMER_BOOTSTRAP_TTL_SECONDS = 5 * 60;
const SDK_CUSTOMER_SESSION_REQUESTS_PER_MINUTE = 30;

const SDKCustomerSessionRequestSchema = z.object({
  tenantId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  channelId: z.string().min(1).max(128).optional(),
  channelName: z.string().min(1).max(64).optional(),
  verifiedUserId: z.string().min(1).max(SDK_USER_CONTEXT_LIMITS.maxUserIdLength),
  customAttributes: z.record(z.unknown()).optional(),
});

const SDKCustomerSessionResponseSchema = z.object({
  bootstrapToken: z
    .string()
    .describe('Single-use customer bootstrap artifact for /api/v1/sdk/init'),
  tokenEnvelope: z
    .enum(['signed', 'jwe'])
    .optional()
    .describe('Browser-visible token envelope for the bootstrapToken'),
  expiresIn: z.number().describe('Bootstrap token expiration in seconds'),
  tenantId: z.string().describe('Tenant ID'),
  projectId: z.string().describe('Project ID'),
  channelId: z.string().describe('SDK channel ID'),
});

function normalizeRequestedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

interface SDKCustomerSessionErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
  };
  issues?: string[];
  limit?: number;
  operation?: string;
  retryAfterMs?: number;
}

function sendSdkCustomerSessionError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extras: Omit<SDKCustomerSessionErrorBody, 'success' | 'error'> = {},
): void {
  res.status(status).json({
    success: false,
    error: { code, message },
    ...extras,
  } satisfies SDKCustomerSessionErrorBody);
}

function normalizeWidgetPermissions(
  permissions: Iterable<unknown>,
): Array<'session:send_message' | 'session:voice' | 'session:read'> {
  const normalized = new Set<'session:send_message' | 'session:voice' | 'session:read'>();
  let hasInteractivePermission = false;
  for (const permission of permissions) {
    if (
      permission === 'session:send_message' ||
      permission === 'session:voice' ||
      permission === 'session:read'
    ) {
      normalized.add(permission);
      if (permission === 'session:send_message' || permission === 'session:voice') {
        hasInteractivePermission = true;
      }
    }
  }

  if (hasInteractivePermission) {
    normalized.add('session:read');
  }

  return [...normalized];
}

async function resolveHostedExchangeChannel(params: {
  tenantId: string;
  projectId: string;
  providedSecret: string;
  channelId?: string;
  channelName?: string;
}): Promise<
  | { success: true; channel: SDKChannelDoc }
  | { success: false; status: number; code: string; message: string }
> {
  if (params.channelId) {
    const channel = await findSDKChannelById(params.channelId, params.projectId, params.tenantId);
    if (!channel || !channel.isActive || channel.authMode !== 'hosted_exchange') {
      return {
        success: false,
        status: 404,
        code: 'NOT_FOUND',
        message: 'SDK channel not found',
      };
    }

    const isValidSecret = await verifySdkChannelServerSecret({
      providedSecret: params.providedSecret,
      storedHash: channel.serverSecretHash,
      storedSalt: channel.serverSecretSalt,
      storedPrefix: channel.serverSecretPrefix,
    });
    if (!isValidSecret) {
      return {
        success: false,
        status: 401,
        code: 'INVALID_SDK_CHANNEL_SECRET',
        message: 'Invalid SDK channel secret',
      };
    }

    return { success: true, channel };
  }

  if (!params.channelName) {
    return {
      success: false,
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'Provide channelId or channelName',
    };
  }

  const channel = await findSDKChannelByName(params.tenantId, params.projectId, params.channelName);
  if (!channel || !channel.isActive || channel.authMode !== 'hosted_exchange') {
    return {
      success: false,
      status: 404,
      code: 'NOT_FOUND',
      message: 'SDK channel not found',
    };
  }

  const isValidSecret = await verifySdkChannelServerSecret({
    providedSecret: params.providedSecret,
    storedHash: channel.serverSecretHash,
    storedSalt: channel.serverSecretSalt,
    storedPrefix: channel.serverSecretPrefix,
  });
  if (!isValidSecret) {
    return {
      success: false,
      status: 401,
      code: 'INVALID_SDK_CHANNEL_SECRET',
      message: 'Invalid SDK channel secret',
    };
  }

  return { success: true, channel };
}

openapi.route(
  'post',
  '/customer-sessions',
  {
    summary: 'Mint a hosted SDK bootstrap token for a verified end user',
    description:
      'Customer backends exchange a channel-scoped server secret for a single-use bootstrapToken. ' +
      'Browsers then pass that bootstrapToken to /api/v1/sdk/init.',
    body: SDKCustomerSessionRequestSchema,
    response: SDKCustomerSessionResponseSchema,
    successStatus: 200,
  },
  async (req, res) => {
    const parsedBody = SDKCustomerSessionRequestSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      sendSdkCustomerSessionError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid SDK customer session request body',
        {
          issues: parsedBody.error.issues.map((issue) => issue.message),
        },
      );
      return;
    }

    const providedSecretHeader = req.headers['x-sdk-channel-secret'];
    const providedSecret =
      typeof providedSecretHeader === 'string' ? providedSecretHeader.trim() : '';
    if (!providedSecret) {
      sendSdkCustomerSessionError(
        res,
        401,
        'MISSING_SDK_CHANNEL_SECRET',
        'Missing X-SDK-Channel-Secret header',
      );
      return;
    }

    const tenantId = normalizeRequestedString(parsedBody.data.tenantId);
    const projectId = normalizeRequestedString(parsedBody.data.projectId);
    const channelId = normalizeRequestedString(parsedBody.data.channelId);
    const channelName = normalizeRequestedString(parsedBody.data.channelName);
    if (channelId && channelName) {
      sendSdkCustomerSessionError(
        res,
        400,
        'INVALID_REQUEST',
        'channelId cannot be combined with channelName',
      );
      return;
    }

    if (!tenantId || !projectId || (!channelId && !channelName)) {
      sendSdkCustomerSessionError(
        res,
        400,
        'INVALID_REQUEST',
        'tenantId, projectId, and exactly one of channelId or channelName are required',
      );
      return;
    }

    const rateLimitDecision = await checkTenantOperationRateLimit({
      tenantId,
      projectId,
      operation: 'request',
      overrideLimits: { requestsPerMinute: SDK_CUSTOMER_SESSION_REQUESTS_PER_MINUTE },
    });
    applyRateLimitHeaders(res, rateLimitDecision);
    if (!rateLimitDecision.allowed) {
      sendSdkCustomerSessionError(res, 429, 'RATE_LIMITED', 'Rate limit exceeded', {
        operation: 'request',
        limit: rateLimitDecision.limit,
        retryAfterMs: rateLimitDecision.resetMs,
      });
      return;
    }

    const normalizedUserContext = normalizeSdkUserContext({
      userId: parsedBody.data.verifiedUserId,
      ...(parsedBody.data.customAttributes
        ? { customAttributes: parsedBody.data.customAttributes }
        : {}),
    });
    if (!normalizedUserContext.success || !normalizedUserContext.data?.userId) {
      const userContextTooLarge =
        !normalizedUserContext.success &&
        normalizedUserContext.error.issues.some((issue) =>
          /serialized size|max serialized size|exceeds max/i.test(issue),
        );
      sendSdkCustomerSessionError(
        res,
        userContextTooLarge ? 413 : 400,
        userContextTooLarge
          ? 'SDK_TOKEN_TOO_LARGE'
          : normalizedUserContext.success
            ? 'INVALID_VERIFIED_USER'
            : normalizedUserContext.error.code,
        normalizedUserContext.success
          ? 'verifiedUserId is required'
          : userContextTooLarge
            ? 'Hosted exchange bootstrap token exceeds encrypted token size budget'
            : normalizedUserContext.error.message,
        normalizedUserContext.success ? {} : { issues: normalizedUserContext.error.issues },
      );
      return;
    }

    try {
      const resolvedChannel = await resolveHostedExchangeChannel({
        tenantId,
        projectId,
        providedSecret,
        channelId,
        channelName,
      });
      if (!resolvedChannel.success) {
        sendSdkCustomerSessionError(
          res,
          resolvedChannel.status,
          resolvedChannel.code,
          resolvedChannel.message,
        );
        return;
      }

      const channel = resolvedChannel.channel;
      const publicApiKey = await findPublicApiKey({
        id: channel.publicApiKeyId,
        projectId: channel.projectId,
        tenantId: channel.tenantId,
      });
      if (
        !publicApiKey ||
        !publicApiKey.isActive ||
        (publicApiKey.expiresAt && publicApiKey.expiresAt < new Date())
      ) {
        sendSdkCustomerSessionError(
          res,
          422,
          'INVALID_SDK_CHANNEL_BINDING',
          'Hosted exchange channel is not bound to an active public API key',
        );
        return;
      }

      const permissions = normalizeWidgetPermissions(
        resolveSdkPublicApiKeyPermissions(publicApiKey.permissions),
      );
      if (permissions.length === 0) {
        sendSdkCustomerSessionError(
          res,
          422,
          'INVALID_SDK_CHANNEL_BINDING',
          'Hosted exchange channel does not allow any browser SDK permissions',
        );
        return;
      }

      const verifiedUserId = normalizedUserContext.data.userId;
      const expiresAt = Date.now() + SDK_CUSTOMER_BOOTSTRAP_TTL_SECONDS * 1000;
      const signedBootstrapToken = signSdkBootstrapArtifact(
        {
          type: 'customer',
          tenantId: channel.tenantId,
          projectId: channel.projectId,
          channelId: channel.id,
          permissions,
          exp: expiresAt,
          verifiedUserId,
          channelArtifact: deriveVerifiedSdkChannelArtifact({
            tenantId: channel.tenantId,
            projectId: channel.projectId,
            channelId: channel.id,
            verifiedUserId,
            secretKey: providedSecret,
          }),
          jti: randomUUID(),
          userContext: normalizedUserContext.data,
        },
        getRuntimeTenantScopedSdkBootstrapSigningSecret(channel.tenantId),
      );
      const envelopePolicy = await resolveRuntimeSdkTokenEnvelopePolicy({
        tenantId: channel.tenantId,
        projectId: channel.projectId,
        channel,
        bootstrapType: 'customer',
      });

      let bootstrapToken = signedBootstrapToken;
      let tokenEnvelope: 'signed' | 'jwe' = 'signed';
      if (envelopePolicy.bootstrapMode === 'jwe') {
        if (!envelopePolicy.canIssueBootstrap) {
          sendSdkCustomerSessionError(
            res,
            503,
            'SDK_JWE_UNAVAILABLE',
            'Hosted exchange token encryption is unavailable',
          );
          return;
        }

        const wrapped = await wrapRuntimeSdkBootstrapToken(
          signedBootstrapToken,
          getRuntimeSdkTokenEnvelopeDeps(),
        );
        if (!wrapped.success) {
          sendSdkCustomerSessionError(
            res,
            wrapped.code === 'SDK_TOKEN_TOO_LARGE' ? 413 : wrapped.status,
            wrapped.code,
            wrapped.code === 'SDK_TOKEN_TOO_LARGE'
              ? 'Hosted exchange bootstrap token exceeds encrypted token size budget'
              : 'Hosted exchange token encryption is unavailable',
          );
          return;
        }
        bootstrapToken = wrapped.data;
        tokenEnvelope = 'jwe';
      }

      log.info('Hosted SDK customer bootstrap issued', {
        tenantId: channel.tenantId,
        projectId: channel.projectId,
        channelId: channel.id,
        tokenEnvelope,
      });

      res.json({
        bootstrapToken,
        tokenEnvelope,
        expiresIn: SDK_CUSTOMER_BOOTSTRAP_TTL_SECONDS,
        tenantId: channel.tenantId,
        projectId: channel.projectId,
        channelId: channel.id,
      });
    } catch (error) {
      log.error('Failed to mint hosted SDK customer bootstrap', {
        error: error instanceof Error ? error.message : String(error),
      });
      sendSdkCustomerSessionError(
        res,
        500,
        'INTERNAL_ERROR',
        'Failed to mint hosted SDK customer bootstrap',
      );
    }
  },
);

export default openapi.router;
