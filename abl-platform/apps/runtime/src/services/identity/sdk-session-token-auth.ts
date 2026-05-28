import type { SDKSessionTokenPayload, SDKTokenEnvelopeMode } from '@agent-platform/shared-auth';
import {
  findPublicApiKey,
  findSDKChannelById,
  findWidgetConfig,
  updateSDKChannel,
  type SDKChannelDoc,
} from '../../repos/channel-repo.js';
import { findActiveDeployment, findDeploymentById } from '../../repos/deployment-repo.js';
import { resolveSdkPublicApiKeyPermissions } from '../../middleware/sdk-auth.js';
import { normalizeLegacySdkSessionPayload } from './sdk-session-token.js';
import { getRuntimeSdkTokenEnvelopeDeps } from './sdk-jwe-runtime-config.js';
import { verifyRuntimeSdkSessionToken } from './sdk-token-envelope-runtime.js';
import { resolveRuntimeSdkTokenEnvelopePolicy } from './sdk-token-envelope-runtime-policy.js';

const SDK_SIGNED_SESSION_TOKEN_MAX_BYTES = 4096;

export interface RuntimeSdkSessionBinding {
  deploymentId?: string;
  environment?: string;
}

export type RuntimeSdkSessionAuthResult =
  | {
      success: true;
      payload: SDKSessionTokenPayload;
      envelope: SDKTokenEnvelopeMode;
      currentBinding?: RuntimeSdkSessionBinding;
    }
  | {
      success: false;
      status: 400 | 401 | 503;
      code: string;
      error: string;
      logReason: string;
    };

type RuntimeSdkSessionAuthFailure = Extract<RuntimeSdkSessionAuthResult, { success: false }>;

function isJweShapedToken(token: string): boolean {
  return token.split('.').length === 5;
}

function getSdkSessionTokenMaxBytes(token: string): number {
  if (isJweShapedToken(token)) {
    return getRuntimeSdkTokenEnvelopeDeps().maxEncryptedSessionBytes;
  }

  return SDK_SIGNED_SESSION_TOKEN_MAX_BYTES;
}

function invalidSession(logReason: string): RuntimeSdkSessionAuthFailure {
  return {
    success: false,
    status: 401,
    code: 'INVALID_SDK_TOKEN',
    error: 'Invalid or expired SDK session token',
    logReason,
  };
}

function normalizeSdkWidgetPermissions(values: unknown[]): string[] {
  const normalized = new Set<string>();
  let hasInteractivePermission = false;

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    if (
      value === 'session:send_message' ||
      value === 'session:voice' ||
      value === 'attachment:read' ||
      value === 'attachment:write' ||
      value === 'attachment:delete'
    ) {
      normalized.add(value);
      hasInteractivePermission = true;
    } else if (value === 'session:read') {
      normalized.add(value);
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
): string[] {
  return normalizeSdkWidgetPermissions([
    widget?.chatEnabled !== false ? 'session:send_message' : null,
    widget?.voiceEnabled === true ? 'session:voice' : null,
  ]);
}

function hasAllPermissions(payloadPermissions: string[], currentPermissions: string[]): boolean {
  const current = new Set(currentPermissions);
  return payloadPermissions.every((permission) => current.has(permission));
}

function getDeploymentId(deployment: { id?: unknown; _id?: unknown } | null): string | undefined {
  if (!deployment) {
    return undefined;
  }
  if (typeof deployment.id === 'string' && deployment.id.trim().length > 0) {
    return deployment.id;
  }
  if (typeof deployment._id === 'string' && deployment._id.trim().length > 0) {
    return deployment._id;
  }
  return undefined;
}

async function resolveCurrentSdkChannelBinding(
  channel: Pick<
    SDKChannelDoc,
    'id' | 'projectId' | 'tenantId' | 'deploymentId' | 'environment' | 'followEnvironment'
  >,
): Promise<RuntimeSdkSessionBinding | null> {
  if (channel.deploymentId) {
    const deployment = await findDeploymentById(
      channel.deploymentId,
      channel.projectId,
      channel.tenantId,
    );
    if (!deployment) {
      return null;
    }

    if (deployment.status === 'retired') {
      if (!channel.environment || !channel.followEnvironment) {
        return null;
      }

      const activeDeployment = await findActiveDeployment(
        channel.projectId,
        channel.tenantId,
        channel.environment,
      );
      const activeDeploymentId = getDeploymentId(activeDeployment);
      if (!activeDeploymentId) {
        return null;
      }

      const updatedChannel = await updateSDKChannel(
        channel.id,
        channel.projectId,
        channel.tenantId,
        {
          deploymentId: activeDeploymentId,
        },
      );
      if (!updatedChannel) {
        return null;
      }

      return {
        deploymentId: activeDeploymentId,
        environment: channel.environment,
      };
    }

    return {
      deploymentId: channel.deploymentId,
      environment: channel.environment || undefined,
    };
  }

  if (channel.environment) {
    const deployment = await findActiveDeployment(
      channel.projectId,
      channel.tenantId,
      channel.environment,
    );
    return {
      deploymentId: getDeploymentId(deployment),
      environment: channel.environment,
    };
  }

  return {};
}

async function reauthorizePublicKeySession(
  payload: SDKSessionTokenPayload,
): Promise<RuntimeSdkSessionBinding | RuntimeSdkSessionAuthFailure> {
  if (!payload.bootstrapKeyId) {
    return invalidSession('sdk_session_public_key_reference_missing');
  }

  const channel = await findSDKChannelById(payload.channelId, payload.projectId, payload.tenantId);
  if (!channel || !channel.isActive) {
    return invalidSession('sdk_session_channel_invalid');
  }
  if (channel.publicApiKeyId !== payload.bootstrapKeyId) {
    return invalidSession('sdk_session_public_key_binding_invalid');
  }

  const key = await findPublicApiKey({
    id: payload.bootstrapKeyId,
    projectId: payload.projectId,
    tenantId: payload.tenantId,
  });
  if (!key || !key.isActive || (key.expiresAt && key.expiresAt < new Date())) {
    return invalidSession('sdk_session_public_key_invalid');
  }

  if (!hasAllPermissions(payload.permissions, resolveSdkPublicApiKeyPermissions(key.permissions))) {
    return invalidSession('sdk_session_public_key_permissions_changed');
  }

  return (
    (await resolveCurrentSdkChannelBinding(channel)) ??
    invalidSession('sdk_session_channel_binding_invalid')
  );
}

async function reauthorizePreviewShareSession(
  payload: SDKSessionTokenPayload,
): Promise<RuntimeSdkSessionBinding | RuntimeSdkSessionAuthFailure> {
  if (
    typeof payload.bootstrapExpiresAt === 'number' &&
    Number.isFinite(payload.bootstrapExpiresAt) &&
    Date.now() > payload.bootstrapExpiresAt
  ) {
    return invalidSession('sdk_session_bootstrap_artifact_expired');
  }

  const channel = await findSDKChannelById(payload.channelId, payload.projectId, payload.tenantId);
  if (!channel || !channel.isActive) {
    return invalidSession('sdk_session_channel_invalid');
  }

  const widgetPermissions = resolveWidgetPermissions(
    await findWidgetConfig(payload.projectId, payload.tenantId),
  );
  if (!hasAllPermissions(payload.permissions, widgetPermissions)) {
    return invalidSession('sdk_session_widget_permissions_changed');
  }

  return (
    (await resolveCurrentSdkChannelBinding(channel)) ??
    invalidSession('sdk_session_channel_binding_invalid')
  );
}

async function reauthorizeCustomerSession(input: {
  payload: SDKSessionTokenPayload;
  envelope: SDKTokenEnvelopeMode;
}): Promise<RuntimeSdkSessionBinding | RuntimeSdkSessionAuthFailure> {
  const { payload, envelope } = input;
  const channel = await findSDKChannelById(payload.channelId, payload.projectId, payload.tenantId);
  if (!channel || !channel.isActive || channel.authMode !== 'hosted_exchange') {
    return invalidSession('sdk_session_customer_channel_invalid');
  }

  const key = await findPublicApiKey({
    id: channel.publicApiKeyId,
    projectId: payload.projectId,
    tenantId: payload.tenantId,
  });
  if (!key || !key.isActive || (key.expiresAt && key.expiresAt < new Date())) {
    return invalidSession('sdk_session_customer_public_key_invalid');
  }

  if (!hasAllPermissions(payload.permissions, resolveSdkPublicApiKeyPermissions(key.permissions))) {
    return invalidSession('sdk_session_customer_permissions_changed');
  }

  const envelopePolicy = await resolveRuntimeSdkTokenEnvelopePolicy({
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    channel,
    bootstrapType: 'customer',
  });
  if (
    (envelope === 'signed' && !envelopePolicy.acceptsSignedSession) ||
    (envelope === 'jwe' && !envelopePolicy.acceptsJweSession)
  ) {
    return invalidSession('sdk_session_envelope_rejected_by_policy');
  }

  return (
    (await resolveCurrentSdkChannelBinding(channel)) ??
    invalidSession('sdk_session_channel_binding_invalid')
  );
}

function isAuthFailure(
  value: RuntimeSdkSessionBinding | RuntimeSdkSessionAuthFailure,
): value is RuntimeSdkSessionAuthFailure {
  return 'success' in value && value.success === false;
}

export async function verifyRuntimeSdkSessionForAuth(
  token: string,
): Promise<RuntimeSdkSessionAuthResult> {
  const maxBytes = getSdkSessionTokenMaxBytes(token);
  if (Buffer.byteLength(token, 'utf8') > maxBytes) {
    return {
      success: false,
      status: 400,
      code: 'SDK_TOKEN_TOO_LARGE',
      error: `SDK session token exceeds configured size budget (${maxBytes} bytes)`,
      logReason: 'sdk_session_token_too_large',
    };
  }

  const verified = await verifyRuntimeSdkSessionToken(token, getRuntimeSdkTokenEnvelopeDeps());
  if (!verified.success) {
    return {
      success: false,
      status: verified.status,
      code: verified.code,
      error:
        verified.code === 'EXPIRED_SDK_TOKEN'
          ? 'Token expired - re-authenticate via /api/v1/sdk/init'
          : verified.code === 'SDK_TOKEN_TOO_LARGE'
            ? 'SDK session token exceeds configured size budget'
            : 'Invalid or expired SDK session token',
      logReason: verified.logReason,
    };
  }

  const payload = normalizeLegacySdkSessionPayload(verified.data, token);
  return authorizeRuntimeSdkSessionPayloadForAuth(payload, verified.envelope);
}

export async function authorizeRuntimeSdkSessionPayloadForAuth(
  payload: SDKSessionTokenPayload,
  envelope: SDKTokenEnvelopeMode,
): Promise<RuntimeSdkSessionAuthResult> {
  if (payload.type !== 'sdk_session') {
    return invalidSession('sdk_session_wrong_token_type');
  }

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return {
      success: false,
      status: 401,
      code: 'EXPIRED_SDK_TOKEN',
      error: 'Token expired - re-authenticate via /api/v1/sdk/init',
      logReason: 'sdk_session_expired',
    };
  }

  let currentBinding: RuntimeSdkSessionBinding | undefined;
  if (payload.bootstrapType === 'public_key') {
    const result = await reauthorizePublicKeySession(payload);
    if (isAuthFailure(result)) return result;
    currentBinding = result;
  } else if (
    payload.bootstrapType === 'studio_preview' ||
    payload.bootstrapType === 'studio_share'
  ) {
    const result = await reauthorizePreviewShareSession(payload);
    if (isAuthFailure(result)) return result;
    currentBinding = result;
  } else if (payload.bootstrapType === 'customer') {
    const result = await reauthorizeCustomerSession({ payload, envelope });
    if (isAuthFailure(result)) return result;
    currentBinding = result;
  } else {
    return invalidSession('sdk_session_bootstrap_type_missing');
  }

  return {
    success: true,
    payload,
    envelope,
    currentBinding,
  };
}
