/**
 * Connection Resolver
 *
 * Resolves channel connections from the database and decrypts credentials.
 * Used by inbound workers to map external identifiers to tenant/project context.
 */

import { isTenantEncryptionReady, decryptForTenantAuto } from '@agent-platform/shared/encryption';
import { createLogger } from '@abl/compiler/platform';
import { AppError, ErrorCodes } from '@agent-platform/shared';
import { dualReadCredentials } from '@agent-platform/shared/services/auth-profile';
import { resolveAuthProfileCredentials } from '../services/auth-profile-resolver.js';
import type { ChannelType, ResolvedConnection, ChannelCredentials } from './types.js';

const log = createLogger('connection-resolver');

function parseChannelCredentials(
  rawCredentials: string,
  connectionId: string,
): ChannelCredentials | null {
  try {
    const parsed = JSON.parse(rawCredentials) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.error('Channel credentials JSON did not decode to an object', { connectionId });
      return null;
    }
    return parsed as ChannelCredentials;
  } catch {
    return null;
  }
}

async function resolveLegacyConnectionCredentials(
  encryptedCredentials: unknown,
  tenantId: string,
  connectionId: string,
): Promise<ChannelCredentials | null> {
  if (typeof encryptedCredentials !== 'string' || encryptedCredentials.length === 0) {
    return null;
  }

  const parsedPlaintext = parseChannelCredentials(encryptedCredentials, connectionId);
  if (parsedPlaintext) {
    return parsedPlaintext;
  }

  if (!isTenantEncryptionReady()) {
    throw new AppError('Tenant DEK encryption is not initialized for channel credential decrypt', {
      ...ErrorCodes.SERVICE_UNAVAILABLE,
    });
  }

  try {
    const decrypted = await decryptForTenantAuto(encryptedCredentials, tenantId);
    const parsedDecrypted = parseChannelCredentials(decrypted, connectionId);
    if (!parsedDecrypted) {
      throw new Error('Decrypted channel credentials are not valid JSON');
    }
    return parsedDecrypted;
  } catch (err) {
    log.error('Failed to decrypt channel credentials', {
      connectionId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}

/**
 * Resolve a channel connection by type and external identifier.
 * Returns the connection with decrypted credentials.
 */
export async function resolveChannelConnection(
  channelType: ChannelType,
  externalIdentifier: string,
): Promise<ResolvedConnection | null> {
  const { ChannelConnection } = await import('@agent-platform/database/models');
  const normalizedIdentifier =
    channelType === 'email' ? externalIdentifier.toLowerCase() : externalIdentifier;

  let connection = await ChannelConnection.findOne({
    channelType,
    externalIdentifier: normalizedIdentifier,
  }).lean();

  if (!connection && channelType === 'whatsapp' && /^\d{6,20}$/.test(normalizedIdentifier)) {
    connection = await ChannelConnection.findOne({
      channelType,
      externalIdentifier: `+${normalizedIdentifier}`,
    }).lean();
  }

  if (!connection) {
    log.debug('Connection not found', { channelType, externalIdentifier });
    return null;
  }

  if (connection.status !== 'active') {
    log.debug('Connection not active', { id: connection._id, status: connection.status });
    return null;
  }

  // ── Auth Profile dual-read: try auth profile first, fall back to legacy ──
  const { credentials } = await dualReadCredentials<ChannelCredentials | null>({
    authProfileId: connection.authProfileId,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    consumer: 'ChannelConnection',
    resolve: async () => {
      const profile = await resolveAuthProfileCredentials(
        connection.authProfileId!,
        connection.tenantId,
      );
      if (!profile) {
        throw new AppError(
          `Auth profile ${connection.authProfileId} not found or expired — cannot resolve channel credentials`,
          { ...ErrorCodes.NOT_FOUND },
        );
      }
      return (profile.secrets as unknown as ChannelCredentials) ?? null;
    },
    legacyFallback: async () =>
      await resolveLegacyConnectionCredentials(
        connection.encryptedCredentials,
        connection.tenantId,
        connection._id,
      ),
  });

  let config: Record<string, unknown> = {};
  if (connection.config && typeof connection.config === 'object') {
    config = connection.config as Record<string, unknown>;
  } else if (typeof connection.config === 'string') {
    try {
      config = JSON.parse(connection.config);
    } catch {
      /* use empty */
    }
  }

  // Decrypt encryptedInboundAuthToken for voice channels (korevg router reads config.inboundAuthToken)
  if (config.encryptedInboundAuthToken && isTenantEncryptionReady()) {
    try {
      config.inboundAuthToken = await decryptForTenantAuto(
        config.encryptedInboundAuthToken as string,
        connection.tenantId,
      );
      // Only remove the encrypted form after successful decryption; on failure the
      // router will find no inboundAuthToken and reject the connection as intended.
      delete config.encryptedInboundAuthToken;
    } catch (err) {
      log.error('Failed to decrypt inboundAuthToken', {
        connectionId: connection._id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return {
    id: connection._id,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    agentId: connection.agentId,
    deploymentId: connection.deploymentId ?? null,
    environment: connection.environment ?? null,
    channelType: connection.channelType as ChannelType,
    externalIdentifier: connection.externalIdentifier,
    credentials,
    config,
    status: connection.status,
  };
}

/**
 * Resolve a channel connection by its public `connectionId` field and channel type.
 *
 * Unlike `resolveChannelConnection` (which queries by externalIdentifier) or
 * `resolveConnectionByIdInternal` (which queries by `_id`), this function
 * queries by the `connectionId` field — the public random UUID used in URL
 * paths (e.g., `ai4w_c_abc123`).
 *
 * NOTE: Intentionally no tenantId filter — this is a bootstrap lookup.
 * The connectionId uniquely identifies the connection (and thus the tenant).
 * This is analogous to `resolveConnectionByVerifyToken` which also resolves
 * tenant identity from the record itself.
 */
export async function resolveConnectionByConnectionId(
  connectionId: string,
  channelType: ChannelType,
): Promise<ResolvedConnection | null> {
  const { ChannelConnection } = await import('@agent-platform/database/models');

  const connection = await ChannelConnection.findOne({
    connectionId,
    channelType,
    status: 'active',
  }).lean();

  if (!connection) {
    log.debug('Connection not found by connectionId', { connectionId, channelType });
    return null;
  }

  // ── Auth Profile dual-read: try auth profile first, fall back to legacy ──
  const { credentials } = await dualReadCredentials<ChannelCredentials | null>({
    authProfileId: connection.authProfileId,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    consumer: 'ChannelConnection',
    resolve: async () => {
      const profile = await resolveAuthProfileCredentials(
        connection.authProfileId!,
        connection.tenantId,
      );
      if (!profile) {
        throw new AppError(
          `Auth profile ${connection.authProfileId} not found or expired — cannot resolve channel credentials`,
          { ...ErrorCodes.NOT_FOUND },
        );
      }
      return (profile.secrets as unknown as ChannelCredentials) ?? null;
    },
    legacyFallback: async () =>
      await resolveLegacyConnectionCredentials(
        connection.encryptedCredentials,
        connection.tenantId,
        connection._id,
      ),
  });

  let config: Record<string, unknown> = {};
  if (connection.config && typeof connection.config === 'object') {
    config = connection.config as Record<string, unknown>;
  } else if (typeof connection.config === 'string') {
    try {
      config = JSON.parse(connection.config);
    } catch {
      /* use empty */
    }
  }

  // Decrypt encryptedInboundAuthToken for voice channels (korevg router reads config.inboundAuthToken)
  if (config.encryptedInboundAuthToken && isTenantEncryptionReady()) {
    try {
      config.inboundAuthToken = await decryptForTenantAuto(
        config.encryptedInboundAuthToken as string,
        connection.tenantId,
      );
      delete config.encryptedInboundAuthToken;
    } catch (err) {
      log.error('Failed to decrypt inboundAuthToken', {
        connectionId: connection._id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return {
    id: connection._id,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    agentId: connection.agentId,
    deploymentId: connection.deploymentId ?? null,
    environment: connection.environment ?? null,
    channelType: connection.channelType as ChannelType,
    externalIdentifier: connection.externalIdentifier,
    credentials,
    config,
    status: connection.status,
  };
}

/**
 * Resolve a channel connection by its ID WITHOUT tenant scoping.
 *
 * WARNING: This bypasses tenant isolation. Only use for bootstrap lookups
 * where the caller has no tenant context (e.g., inbound WebSocket connections
 * where tenantId is determined from the connection itself). Analogous to
 * `resolveConnectionByVerifyToken` which also resolves tenant from the record.
 */
export async function resolveConnectionByIdUnsafe(
  connectionId: string,
): Promise<ResolvedConnection | null> {
  return resolveConnectionByIdInternal(connectionId);
}

/**
 * Resolve a channel connection by its ID, scoped to a tenant.
 */
export async function resolveConnectionById(
  connectionId: string,
  tenantId: string,
): Promise<ResolvedConnection | null> {
  return resolveConnectionByIdInternal(connectionId, tenantId);
}

async function resolveConnectionByIdInternal(
  connectionId: string,
  tenantId?: string,
): Promise<ResolvedConnection | null> {
  const { ChannelConnection } = await import('@agent-platform/database/models');

  const filter: Record<string, unknown> = { _id: connectionId };
  if (tenantId) filter.tenantId = tenantId;
  const connection = await ChannelConnection.findOne(filter).lean();

  if (!connection) return null;

  if (connection.status !== 'active') {
    log.debug('Connection not active', { id: connection._id, status: connection.status });
    return null;
  }

  // ── Auth Profile dual-read: try auth profile first, fall back to legacy ──
  const { credentials } = await dualReadCredentials<ChannelCredentials | null>({
    authProfileId: connection.authProfileId,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    consumer: 'ChannelConnection',
    resolve: async () => {
      const profile = await resolveAuthProfileCredentials(
        connection.authProfileId!,
        connection.tenantId,
      );
      if (!profile) {
        throw new AppError(
          `Auth profile ${connection.authProfileId} not found or expired — cannot resolve channel credentials`,
          { ...ErrorCodes.NOT_FOUND },
        );
      }
      return (profile.secrets as unknown as ChannelCredentials) ?? null;
    },
    legacyFallback: async () =>
      await resolveLegacyConnectionCredentials(
        connection.encryptedCredentials,
        connection.tenantId,
        connectionId,
      ),
  });

  let config: Record<string, unknown> = {};
  if (connection.config && typeof connection.config === 'object') {
    config = connection.config as Record<string, unknown>;
  } else if (typeof connection.config === 'string') {
    try {
      config = JSON.parse(connection.config);
    } catch {
      /* use empty */
    }
  }

  // Decrypt encryptedInboundAuthToken for voice channels (korevg router reads config.inboundAuthToken)
  if (config.encryptedInboundAuthToken && isTenantEncryptionReady()) {
    try {
      config.inboundAuthToken = await decryptForTenantAuto(
        config.encryptedInboundAuthToken as string,
        connection.tenantId,
      );
      // Only remove the encrypted form after successful decryption; on failure the
      // router will find no inboundAuthToken and reject the connection as intended.
      delete config.encryptedInboundAuthToken;
    } catch (err) {
      log.error('Failed to decrypt inboundAuthToken', {
        connectionId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return {
    id: connection._id,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    agentId: connection.agentId,
    deploymentId: connection.deploymentId ?? null,
    environment: connection.environment ?? null,
    channelType: connection.channelType as ChannelType,
    externalIdentifier: connection.externalIdentifier,
    credentials,
    config,
    status: connection.status,
  };
}

/**
 * Resolve a Meta (Messenger/WhatsApp) channel connection by verify_token.
 *
 * Meta's GET webhook verification does not include a page ID or connection
 * identifier — only hub.verify_token. We store a SHA-256 hash of the
 * verify_token on the connection document (indexed) so we can look it up
 * in a single query without decrypting all credentials.
 */
export async function resolveConnectionByVerifyToken(
  channelType: ChannelType,
  verifyToken: string,
): Promise<ResolvedConnection | null> {
  const { createHash } = await import('node:crypto');
  const { ChannelConnection } = await import('@agent-platform/database/models');

  const tokenHash = createHash('sha256').update(verifyToken).digest('hex');

  // NOTE: Intentionally no tenantId filter — this is a bootstrap lookup.
  // Meta's GET verification request carries only verify_token with no tenant
  // context. The verifyTokenHash uniquely identifies the connection (and thus
  // the tenant). This is analogous to API-key lookups that resolve tenant
  // identity from the key itself.
  const connection = await ChannelConnection.findOne({
    channelType,
    verifyTokenHash: tokenHash,
    status: 'active',
  }).lean();

  if (!connection) {
    log.warn('No connection found with matching verify_token', { channelType });
    return null;
  }

  // ── Auth Profile dual-read: try auth profile first, fall back to legacy ──
  const { credentials } = await dualReadCredentials<ChannelCredentials | null>({
    authProfileId: connection.authProfileId,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    consumer: 'ChannelConnection',
    resolve: async () => {
      const profile = await resolveAuthProfileCredentials(
        connection.authProfileId!,
        connection.tenantId,
      );
      if (!profile) {
        throw new AppError(
          `Auth profile ${connection.authProfileId} not found or expired — cannot resolve channel credentials`,
          { ...ErrorCodes.NOT_FOUND },
        );
      }
      return (profile.secrets as unknown as ChannelCredentials) ?? null;
    },
    legacyFallback: async () =>
      await resolveLegacyConnectionCredentials(
        connection.encryptedCredentials,
        connection.tenantId,
        connection._id,
      ),
  });

  let config: Record<string, unknown> = {};
  if (connection.config && typeof connection.config === 'object') {
    config = connection.config as Record<string, unknown>;
  } else if (typeof connection.config === 'string') {
    try {
      config = JSON.parse(connection.config);
    } catch {
      /* use empty */
    }
  }

  return {
    id: connection._id,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    agentId: connection.agentId,
    deploymentId: connection.deploymentId ?? null,
    environment: connection.environment ?? null,
    channelType: connection.channelType as ChannelType,
    externalIdentifier: connection.externalIdentifier,
    credentials,
    config,
    status: connection.status,
  };
}

/**
 * Find or create an HTTP Async channel connection for a tenant/project.
 * Used during webhook subscription to ensure a connection exists.
 */
export async function findOrCreateHttpAsyncConnection(
  tenantId: string,
  projectId: string,
  agentId?: string,
  deploymentId?: string,
): Promise<ResolvedConnection> {
  const { ChannelConnection } = await import('@agent-platform/database/models');
  const externalIdentifier = agentId
    ? `http_async:${tenantId}:${projectId}:${agentId}`
    : `http_async:${tenantId}:${projectId}`;

  const result = await ChannelConnection.findOneAndUpdate(
    { channelType: 'http_async', externalIdentifier },
    {
      $setOnInsert: {
        tenantId,
        projectId,
        agentId: agentId || null,
        channelType: 'http_async',
        externalIdentifier,
        displayName: 'HTTP Async Channel',
      },
      // Always reactivate existing connections and update deploymentId
      $set: {
        status: 'active',
        ...(deploymentId ? { deploymentId } : {}),
      },
    },
    { upsert: true, new: true },
  ).lean();

  let config: Record<string, unknown> = {};
  if (result!.config && typeof result!.config === 'object') {
    config = result!.config as Record<string, unknown>;
  }

  return {
    id: result!._id,
    tenantId: result!.tenantId,
    projectId: result!.projectId,
    agentId: result!.agentId,
    deploymentId: result!.deploymentId ?? null,
    channelType: 'http_async',
    externalIdentifier,
    credentials: null,
    config,
    status: result!.status,
  };
}
