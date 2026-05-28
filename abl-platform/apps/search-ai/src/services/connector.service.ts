/**
 * Connector Service
 *
 * Business logic for connector management, authentication, sync, and permissions.
 * Calls the repository layer for data access — never touches models directly.
 */

import crypto from 'crypto';
import { MicrosoftOAuthProvider } from '@agent-platform/connector-sharepoint';
import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import { createQueue, getSharedRedisClient } from '../workers/shared.js';
import {
  QUEUE_CONNECTOR_SYNC,
  type ConnectorSyncJobData,
} from '../workers/connector-sync-worker.js';
import {
  QUEUE_CONNECTOR_PERMISSION_CRAWL,
  type ConnectorPermissionCrawlJobData,
} from '../workers/connector-permission-crawl-worker.js';
import * as repo from '../repos/connector.repository.js';
import { getLazyModel } from '../db/index.js';

const logger = createLogger('connector-service');

// ─── Types / Errors ──────────────────────────────────────────────────────

export class ConnectorError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

const VALID_CONNECTOR_TYPES = ['sharepoint', 'jira', 'confluence', 'hubspot', 'salesforce'];

// ─── Redis Device Code Session ───────────────────────────────────────────

interface DeviceCodeSessionData {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: string;
  scopes: string[];
  connectorId: string;
  tenantId: string;
  authMethod?: string;
  state?: string;
}

const DEVICE_CODE_KEY_PREFIX = 'oauth:device:';

let deviceCodeRedis: RedisClient | null = null;

function getDeviceCodeRedis(): RedisClient {
  if (!deviceCodeRedis) {
    deviceCodeRedis = getSharedRedisClient();
  }
  if (!deviceCodeRedis) {
    throw new ConnectorError(
      'REDIS_UNAVAILABLE',
      'Redis not configured — device code flow requires Redis',
      503,
    );
  }
  return deviceCodeRedis;
}

/**
 * Store device code session with SET NX PX guard to prevent overwriting
 * an in-flight auth session (e.g., user clicks "Connect" twice rapidly).
 *
 * @returns true if stored, false if an in-flight session already exists
 */
async function storeDeviceCodeSession(
  connectorId: string,
  session: DeviceCodeSessionData,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    const redis = getDeviceCodeRedis();
    const key = `${DEVICE_CODE_KEY_PREFIX}${connectorId}`;
    const ttlMs = ttlSeconds * 1000;

    // SET NX PX: only set if key does not exist, with TTL in milliseconds.
    // Prevents overwriting an in-flight auth session for the same connector.
    const result = await redis.set(key, JSON.stringify(session), 'PX', ttlMs, 'NX');

    if (result === null) {
      // Key already exists — in-flight session for this connector
      logger.warn('Device code session already in-flight, not overwriting', {
        connectorId,
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.error('Redis error storing device code session', {
      connectorId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ConnectorError(
      'REDIS_UNAVAILABLE',
      'Failed to store OAuth session state. Please try again.',
      503,
    );
  }
}

async function getDeviceCodeSession(connectorId: string): Promise<DeviceCodeSessionData | null> {
  try {
    const redis = getDeviceCodeRedis();
    const data = await redis.get(`${DEVICE_CODE_KEY_PREFIX}${connectorId}`);
    if (!data) return null;
    return JSON.parse(data) as DeviceCodeSessionData;
  } catch (error) {
    logger.error('Redis error reading device code session', {
      connectorId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ConnectorError(
      'REDIS_UNAVAILABLE',
      'Failed to read OAuth session state. Please try again.',
      503,
    );
  }
}

async function deleteDeviceCodeSession(connectorId: string): Promise<void> {
  try {
    const redis = getDeviceCodeRedis();
    await redis.del(`${DEVICE_CODE_KEY_PREFIX}${connectorId}`);
  } catch (error) {
    logger.error('Redis error deleting device code session', {
      connectorId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ConnectorError(
      'REDIS_UNAVAILABLE',
      'Failed to clean up OAuth session state. Please try again.',
      503,
    );
  }
}

// ─── OAuth Helpers ───────────────────────────────────────────────────────

function getConnectorRedirectUri(): string {
  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) {
    throw new ConnectorError(
      'MISSING_FRONTEND_URL',
      'FRONTEND_URL environment variable is required for OAuth connector authentication. Set it to the public base URL (e.g., https://agents-dev.kore.ai).',
    );
  }
  return `${frontendUrl}/api/connectors/auth/callback`;
}

interface SharePointOAuthConfig {
  clientId: string;
  azureTenantId: string;
  authMethod: string;
  clientSecret?: string;
  redirectUri: string;
}

function resolveSharePointOAuthConfig(connector: any): SharePointOAuthConfig {
  const connConfig = connector.connectionConfig as {
    clientId?: string;
    tenantId?: string;
    authMethod?: string;
    clientSecret?: string;
  };

  const clientId = connConfig?.clientId || process.env.SHAREPOINT_CLIENT_ID;
  const azureTenantId = connConfig?.tenantId || process.env.SHAREPOINT_TENANT_ID;
  const authMethod = connConfig?.authMethod || 'device_code';

  if (!clientId) {
    throw new ConnectorError(
      'MISSING_CLIENT_ID',
      'SharePoint OAuth requires a client ID. Set SHAREPOINT_CLIENT_ID environment variable or provide clientId in connectionConfig.',
    );
  }

  if (!azureTenantId) {
    throw new ConnectorError(
      'MISSING_TENANT_ID',
      'SharePoint OAuth requires a tenant ID (Azure AD Directory ID). Set SHAREPOINT_TENANT_ID environment variable or provide tenantId in connectionConfig.',
    );
  }

  // Only require redirectUri for flows that need it (not client_credentials)
  const redirectUri = authMethod === 'client_credentials' ? '' : getConnectorRedirectUri();

  return {
    clientId,
    azureTenantId,
    authMethod,
    clientSecret: connConfig?.clientSecret,
    redirectUri,
  };
}

function resolveScopes(authMethod: string, permissionMode: string): string[] {
  if (authMethod === 'client_credentials') {
    return ['https://graph.microsoft.com/.default'];
  }
  if (permissionMode === 'enabled') {
    return ['Sites.Read.All', 'Files.Read.All', 'GroupMember.Read.All', 'offline_access'];
  }
  // disabled or any other value — read-only without permission scopes
  return ['Sites.Read.All', 'Files.Read.All', 'offline_access'];
}

/**
 * Upsert an OAuth token: finds existing by filter, updates or creates.
 * Uses findOne + save so the Mongoose encryption plugin pre-save hook fires.
 */
async function upsertOAuthToken(
  tenantId: string,
  filter: Record<string, unknown>,
  tokenData: Record<string, unknown>,
): Promise<any> {
  let oauthToken = await repo.findOAuthTokenByFilter(tenantId, filter);
  if (oauthToken) {
    for (const [k, v] of Object.entries(tokenData)) (oauthToken as any).set(k, v);
    // Clear revokedAt — re-authentication supersedes a prior revocation
    (oauthToken as any).set('revokedAt', null);
    await (oauthToken as any).save();
  } else {
    oauthToken = await repo.createOAuthToken({ ...filter, tenantId, ...tokenData });
  }
  return oauthToken;
}

// ─── CRUD ────────────────────────────────────────────────────────────────

export async function listConnectors(
  indexId: string,
  tenantId: string,
  options?: {
    search?: string;
    status?: string[];
    type?: string[];
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
    groupBy?: string;
    page?: number;
    limit?: number;
  },
) {
  const index = await repo.findIndexByIdAndTenant(indexId, tenantId);
  if (!index) {
    throw new ConnectorError('NOT_FOUND', 'Index not found', 404);
  }

  const sources = await repo.findSourcesByIndex(indexId, tenantId);
  const sourceIds = sources.map((s: any) => s._id);
  let connectors = await repo.findConnectorsBySourceIds(tenantId, sourceIds);

  // Apply search filter
  if (options?.search) {
    const searchLower = options.search.toLowerCase();
    connectors = connectors.filter((c: any) => {
      const name = (
        c.connectionConfig?.displayName ??
        c.connectionConfig?.siteName ??
        c.connectorType ??
        ''
      ).toLowerCase();
      return name.includes(searchLower);
    });
  }

  // Apply status filter
  if (options?.status && options.status.length > 0) {
    connectors = connectors.filter((c: any) => {
      const status = c.syncState?.status ?? 'pending';
      return options.status!.includes(status);
    });
  }

  // Apply type filter
  if (options?.type && options.type.length > 0) {
    connectors = connectors.filter((c: any) => options.type!.includes(c.connectorType));
  }

  // Compute aggregates before pagination
  const aggregates = computeAggregates(connectors, sources);

  // Apply sorting
  const sortBy = options?.sortBy ?? 'name';
  const sortDir = options?.sortDir ?? 'asc';
  const sortMul = sortDir === 'asc' ? 1 : -1;
  connectors.sort((a: any, b: any) => {
    let aVal: string | number = '';
    let bVal: string | number = '';
    switch (sortBy) {
      case 'name':
        aVal = (
          a.connectionConfig?.displayName ??
          a.connectionConfig?.siteName ??
          ''
        ).toLowerCase();
        bVal = (
          b.connectionConfig?.displayName ??
          b.connectionConfig?.siteName ??
          ''
        ).toLowerCase();
        break;
      case 'status':
        aVal = a.syncState?.status ?? '';
        bVal = b.syncState?.status ?? '';
        break;
      case 'lastSync':
        aVal = a.syncState?.lastFullSyncAt ? new Date(a.syncState.lastFullSyncAt).getTime() : 0;
        bVal = b.syncState?.lastFullSyncAt ? new Date(b.syncState.lastFullSyncAt).getTime() : 0;
        break;
      case 'documentCount':
        aVal = a.syncState?.documentCount ?? 0;
        bVal = b.syncState?.documentCount ?? 0;
        break;
    }
    if (aVal < bVal) return -1 * sortMul;
    if (aVal > bVal) return 1 * sortMul;
    return 0;
  });

  const total = connectors.length;
  const page = options?.page ?? 1;
  const limit = Math.min(options?.limit ?? 50, 100);
  const start = (page - 1) * limit;
  const paginated = connectors.slice(start, start + limit);

  return { connectors: paginated, total, page, limit, aggregates };
}

function computeAggregates(connectors: any[], sources: any[]) {
  let totalDocs = 0;
  let totalSizeBytes = 0;
  const sourceCountByType: Record<string, number> = {};
  const sourceCountByStatus: Record<string, number> = {};
  let tokensExpiringCount = 0;

  for (const c of connectors) {
    totalDocs += c.syncState?.documentCount ?? 0;
    totalSizeBytes += c.syncState?.totalSizeBytes ?? 0;

    const type = c.connectorType ?? 'unknown';
    sourceCountByType[type] = (sourceCountByType[type] ?? 0) + 1;

    const status = c.syncState?.status ?? 'pending';
    sourceCountByStatus[status] = (sourceCountByStatus[status] ?? 0) + 1;
  }

  return { totalDocs, totalSizeBytes, sourceCountByType, sourceCountByStatus, tokensExpiringCount };
}

export async function createConnector(
  indexId: string,
  tenantId: string,
  body: {
    name: string;
    connectorType: string;
    connectionConfig?: Record<string, unknown>;
    filterConfig?: Record<string, unknown>;
  },
) {
  const { name, connectorType, connectionConfig, filterConfig } = body;

  const index = await repo.findIndexByIdAndTenant(indexId, tenantId);
  if (!index) {
    throw new ConnectorError('NOT_FOUND', 'Index not found', 404);
  }

  if (!name || !connectorType) {
    throw new ConnectorError('VALIDATION_ERROR', 'name and connectorType are required');
  }

  if (!VALID_CONNECTOR_TYPES.includes(connectorType)) {
    throw new ConnectorError(
      'INVALID_CONNECTOR_TYPE',
      `Invalid connectorType. Must be one of: ${VALID_CONNECTOR_TYPES.join(', ')}`,
    );
  }

  // Check for duplicate connector of the same type on the same index
  const existingSources = await repo.findSourcesByIndex(indexId, tenantId);
  const existingSourceIds = existingSources.map((s: any) => s._id);
  if (existingSourceIds.length > 0) {
    const existingConnector = await repo.findConnectorByTypeAndSources(
      tenantId,
      existingSourceIds,
      connectorType,
    );
    if (existingConnector) {
      // Update connectionConfig if the caller provided new credentials (e.g. switching auth method)
      if (connectionConfig && Object.keys(connectionConfig).length > 0) {
        const doc = await repo.findConnectorByIdAndTenant((existingConnector as any)._id, tenantId);
        if (doc) {
          (doc as any).connectionConfig = { ...(doc as any).connectionConfig, ...connectionConfig };
          await (doc as any).save();
          const existingSource = existingSources.find(
            (s: any) => s._id === existingConnector.sourceId,
          );
          return { connector: (doc as any).toObject(), source: existingSource, existing: true };
        }
      }
      const existingSource = existingSources.find((s: any) => s._id === existingConnector.sourceId);
      return { connector: existingConnector, source: existingSource, existing: true };
    }
  }

  // Resolve connection config defaults for SharePoint
  let resolvedConnectionConfig = connectionConfig || {};
  if (connectorType === 'sharepoint' && !(resolvedConnectionConfig as any).clientId) {
    const defaultClientId = process.env.SHAREPOINT_CLIENT_ID;
    if (defaultClientId) {
      resolvedConnectionConfig = {
        ...resolvedConnectionConfig,
        clientId: defaultClientId,
      };
    }
  }

  // Validate SharePoint config
  if (
    connectorType === 'sharepoint' &&
    (connectionConfig as any)?.tenantUrl &&
    !(connectionConfig as any)?.clientId
  ) {
    throw new ConnectorError(
      'INVALID_CONFIG',
      'SharePoint connectionConfig requires clientId when tenantUrl is provided',
    );
  }

  const source = await repo.createSource({
    tenantId,
    indexId,
    name,
    sourceType: connectorType,
    sourceConfig: resolvedConnectionConfig as Record<string, unknown>,
    status: 'pending',
  });

  const connector = await repo.createConnector({
    tenantId,
    indexId,
    sourceId: (source as any)._id,
    connectorType,
    connectionConfig: resolvedConnectionConfig,
    filterConfig: filterConfig || {
      mode: 'include',
      siteUrls: [],
      libraryNames: [],
      contentTypes: [],
      modifiedSince: null,
    },
    syncState: {
      lastFullSyncAt: null,
      lastDeltaSyncAt: null,
      deltaToken: null,
      checkpointData: null,
      totalDocuments: 0,
      processedDocuments: 0,
      failedDocuments: 0,
    },
    permissionConfig: {
      mode:
        (resolvedConnectionConfig as any)?.permissionAwareSearch === true ? 'enabled' : 'disabled',
      crawlSchedule: null,
      lastCrawlAt: null,
    },
    errorState: {
      consecutiveFailures: 0,
      lastErrorAt: null,
      lastErrorMessage: null,
      isPaused: false,
      pausedAt: null,
      pauseReason: null,
    },
  });

  return { connector, source, existing: false };
}

export async function getConnector(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const source = await repo.findSourceByIdAndTenant(connector.sourceId, tenantId);
  return { connector, source };
}

export async function updateConnector(
  connectorId: string,
  tenantId: string,
  body: {
    connectionConfig?: Record<string, unknown>;
    filterConfig?: Record<string, unknown>;
    permissionConfig?: Record<string, unknown>;
  },
) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const { connectionConfig, filterConfig, permissionConfig } = body;
  const doc = connector as any;

  if (connectionConfig) {
    doc.connectionConfig = { ...doc.connectionConfig, ...connectionConfig };
  }
  if (filterConfig) {
    const oldScope = doc.filterConfig?.scope;
    const newScope = filterConfig.scope;
    doc.filterConfig = { ...doc.filterConfig, ...filterConfig };
    logger.info('updateConnector filterConfig merge', {
      connectorId,
      oldSiteMode: oldScope?.siteMode,
      oldSiteIds: oldScope?.siteIds?.length,
      newSiteMode: (newScope as any)?.siteMode,
      newSiteIds: (newScope as any)?.siteIds?.length,
      resultSiteMode: doc.filterConfig?.scope?.siteMode,
      resultSiteIds: doc.filterConfig?.scope?.siteIds?.length,
    });
  }
  if (permissionConfig) {
    doc.permissionConfig = { ...doc.permissionConfig, ...permissionConfig };
  }

  await doc.save();

  // Write a config version for history tracking
  const changedFields: string[] = [];
  if (connectionConfig) changedFields.push('connectionConfig');
  if (filterConfig) changedFields.push('filterConfig');
  if (permissionConfig) changedFields.push('permissionConfig');

  try {
    const { createVersion } = await import('./connector-config-version.service.js');
    await createVersion({
      connectorId,
      tenantId,
      configSnapshot: {
        connectionConfig: doc.connectionConfig,
        filterConfig: doc.filterConfig,
        permissionConfig: doc.permissionConfig,
      },
      changedFields,
      changedBy: 'user',
      changeSource: 'user',
      summary: `Updated ${changedFields.join(', ')}`,
    });
  } catch {
    // Don't fail the update if versioning fails
  }

  return { connector: doc.toObject() };
}

export async function deleteConnector(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  if ((connector as any).oauthTokenId) {
    await repo.revokeOAuthToken((connector as any).oauthTokenId, tenantId);
  }

  const sourceId = connector.sourceId;

  // Look up the source to get indexId for document/chunk cleanup
  const source = await repo.findSourceByIdAndTenant(sourceId, tenantId);
  const indexId = source?.indexId ?? null;

  // Delete documents, chunks, and vector store entries before removing the source
  if (indexId) {
    const SearchDocument = getLazyModel('SearchDocument');
    const documentCount = await SearchDocument.countDocuments({ sourceId, tenantId });

    const { deleteSourceDocuments, cleanupFieldsForSource, cleanupAllFieldsAndVocab } =
      await import('./document-cleanup.service.js');
    const cleanupResult = await deleteSourceDocuments(sourceId, tenantId, indexId);

    if (!cleanupResult.success) {
      logger.warn('Some documents failed to delete during connector removal', {
        connectorId,
        sourceId,
        failures: cleanupResult.failures.length,
      });
    }

    // Update SearchIndex counters
    const SearchIndex = getLazyModel('SearchIndex');
    await SearchIndex.findOneAndUpdate(
      { _id: indexId, tenantId },
      {
        $inc: {
          sourceCount: -1,
          documentCount: -documentCount,
          chunkCount: -cleanupResult.chunkCount,
        },
      },
    );

    // Update KnowledgeBase counters
    const KnowledgeBase = getLazyModel('KnowledgeBase');
    await KnowledgeBase.findOneAndUpdate(
      { searchIndexId: indexId, tenantId },
      { $inc: { documentCount: -documentCount } },
    );

    // Clean up field mappings and vocabulary
    try {
      const updatedIndex = await SearchIndex.findOne({ _id: indexId, tenantId })
        .select('documentCount')
        .lean();
      const remainingDocs = (updatedIndex as any)?.documentCount ?? 0;

      if (remainingDocs <= 0) {
        await cleanupAllFieldsAndVocab(tenantId, indexId);
      } else {
        await cleanupFieldsForSource(tenantId, indexId, connectorId);
      }
    } catch (fieldErr: unknown) {
      logger.warn('Field/vocab cleanup failed after connector deletion', {
        error: fieldErr instanceof Error ? fieldErr.message : String(fieldErr),
        connectorId,
        sourceId,
        indexId,
      });
    }
  }

  await repo.deleteSourceByIdAndTenant(sourceId, tenantId);
  await repo.deleteConnectorByIdAndTenant(connectorId, tenantId);
  await deleteDeviceCodeSession(connectorId);

  return { deleted: true, connectorId };
}

// ─── Authentication ──────────────────────────────────────────────────────

export async function initiateAuth(connectorId: string, tenantId: string, userId: string) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  if ((connector as any).connectorType !== 'sharepoint') {
    throw new ConnectorError(
      'UNSUPPORTED_CONNECTOR',
      'OAuth authentication only supported for SharePoint connectors',
    );
  }

  const config = resolveSharePointOAuthConfig(connector);
  const { clientId, azureTenantId, authMethod } = config;
  const oauthProvider = new MicrosoftOAuthProvider({
    clientId,
    tenantId: azureTenantId,
  });
  const scopes = resolveScopes(authMethod, (connector as any).permissionConfig.mode);

  // Always clear any previous session. The user explicitly called initiateAuth,
  // so they want a fresh session — whether the old one expired, is pending, or
  // used a different auth method. Double-click protection belongs in the UI.
  await deleteDeviceCodeSession(connectorId);

  // Device Code Flow
  if (authMethod === 'device_code') {
    const deviceCodeResponse = await oauthProvider.requestDeviceCode(scopes);

    const stored = await storeDeviceCodeSession(
      connectorId,
      {
        deviceCode: deviceCodeResponse.deviceCode,
        userCode: deviceCodeResponse.userCode,
        verificationUri: deviceCodeResponse.verificationUri,
        interval: deviceCodeResponse.interval,
        expiresAt: new Date(Date.now() + deviceCodeResponse.expiresIn * 1000).toISOString(),
        scopes,
        connectorId,
        tenantId,
      },
      deviceCodeResponse.expiresIn,
    );
    if (!stored) {
      throw new ConnectorError(
        'AUTH_IN_PROGRESS',
        'An authentication session is already in progress for this connector. Please wait for it to complete or expire.',
        409,
      );
    }

    return {
      authMethod: 'device_code',
      sessionId: connectorId,
      userCode: deviceCodeResponse.userCode,
      verificationUri: deviceCodeResponse.verificationUri,
      expiresAt: new Date(Date.now() + deviceCodeResponse.expiresIn * 1000).toISOString(),
      message: `Visit ${deviceCodeResponse.verificationUri} and enter code: ${deviceCodeResponse.userCode}`,
    };
  }

  // Authorization Code Flow
  if (authMethod === 'authorization_code') {
    const { redirectUri } = config;
    const state = `${connectorId}:${crypto.randomBytes(16).toString('hex')}`;
    const authorizationUrl = oauthProvider.getAuthorizationUrl({
      scopes,
      redirectUri,
      state,
    });

    const stored = await storeDeviceCodeSession(
      connectorId,
      {
        deviceCode: '',
        userCode: '',
        verificationUri: authorizationUrl,
        interval: 0,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        scopes,
        connectorId,
        tenantId,
        authMethod: 'authorization_code',
        state,
      },
      600,
    );
    if (!stored) {
      throw new ConnectorError(
        'AUTH_IN_PROGRESS',
        'An authentication session is already in progress for this connector. Please wait for it to complete or expire.',
        409,
      );
    }

    return {
      authMethod: 'authorization_code',
      authorizationUrl,
      state,
      redirectUri,
      message: 'Redirect the user to the authorizationUrl to complete sign-in.',
    };
  }

  // Client Credentials Flow
  if (authMethod === 'client_credentials') {
    const { clientSecret } = config;
    if (!clientSecret) {
      throw new ConnectorError(
        'MISSING_CLIENT_SECRET',
        'Client Credentials flow requires a clientSecret in connectionConfig.',
      );
    }

    const tokens = await oauthProvider.acquireClientCredentialsToken(scopes, clientSecret);

    const oauthToken = await upsertOAuthToken(
      tenantId,
      {
        userId: 'app-only',
        provider: 'microsoft_sharepoint',
      },
      {
        providerUserId: 'app-only',
        encryptedAccessToken: tokens.accessToken,
        encryptedRefreshToken: '',
        scope: tokens.scope || scopes.join(' '),
        expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
        consentedAt: new Date(),
      },
    );

    (connector as any).oauthTokenId = oauthToken._id;
    await (connector as any).save();

    return {
      authMethod: 'client_credentials',
      status: 'completed',
      connectorId,
      message: 'App-only authentication completed successfully.',
    };
  }

  throw new ConnectorError(
    'UNSUPPORTED_AUTH_METHOD',
    `Unsupported auth method: ${authMethod}. Supported: device_code, authorization_code, client_credentials.`,
  );
}

export async function getAuthStatus(connectorId: string, tenantId: string, userId: string) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  // Already authenticated?
  if ((connector as any).oauthTokenId) {
    const token = await repo.findOAuthToken((connector as any).oauthTokenId, tenantId);
    if (token && !(token as any).revokedAt) {
      await deleteDeviceCodeSession(connectorId);
      return { status: 'completed', connectorId };
    }
  }

  // Check for active session
  const session = await getDeviceCodeSession(connectorId);
  if (!session) {
    return {
      status: 'error',
      message: 'No pending authentication. Please initiate auth first.',
    };
  }

  // Check expiry
  if (new Date() >= new Date(session.expiresAt)) {
    await deleteDeviceCodeSession(connectorId);
    return { status: 'expired' };
  }

  // Auth code flow — just check if callback completed
  if (session.authMethod === 'authorization_code') {
    return { status: 'pending', authMethod: 'authorization_code' };
  }

  // Device code flow — try to exchange
  const connConfig = (connector as any).connectionConfig as {
    clientId?: string;
    tenantId?: string;
  };
  const clientId = connConfig?.clientId || process.env.SHAREPOINT_CLIENT_ID;
  const azureTenantId = connConfig?.tenantId || process.env.SHAREPOINT_TENANT_ID;

  if (!clientId || !azureTenantId) {
    return {
      status: 'error',
      message: 'Missing SharePoint client ID or tenant ID configuration',
    };
  }

  const oauthProvider = new MicrosoftOAuthProvider({
    clientId,
    tenantId: azureTenantId,
  });

  try {
    const tokens = await oauthProvider.exchangeDeviceCode(session.deviceCode);

    const tokenFilter = {
      userId: userId || 'system',
      provider: 'microsoft_sharepoint' as const,
    };
    const tokenData = {
      providerUserId: tokens.providerUserId || 'unknown',
      encryptedAccessToken: tokens.accessToken,
      encryptedRefreshToken: tokens.refreshToken || '',
      scope: tokens.scope || session.scopes.join(' '),
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      consentedAt: new Date(),
    };

    const oauthToken = await upsertOAuthToken(tenantId, tokenFilter, tokenData);
    (connector as any).oauthTokenId = oauthToken._id;
    await (connector as any).save();
    await deleteDeviceCodeSession(connectorId);

    return { status: 'completed', connectorId };
  } catch (error: unknown) {
    const errCode = (error as any)?.code;
    const errMessage = error instanceof Error ? error.message : String(error);

    if (errCode === 'authorization_pending') {
      return { status: 'pending' };
    }
    if (errCode === 'slow_down') {
      return { status: 'pending', message: 'Polling too fast, slowing down' };
    }
    if (errCode === 'access_denied') {
      await deleteDeviceCodeSession(connectorId);
      return {
        status: 'error',
        message: 'Authorization was denied by the user',
      };
    }

    logger.error('Token exchange error', { connectorId, error: errMessage });
    return { status: 'error', message: errMessage };
  }
}

export async function authCallback(
  connectorId: string,
  tenantId: string,
  userId: string,
  code: string,
  state: string,
) {
  if (!code || !state) {
    throw new ConnectorError('MISSING_PARAMS', 'Both code and state are required.');
  }

  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  // Validate CSRF state
  const session = await getDeviceCodeSession(connectorId);
  if (!session || session.state !== state) {
    throw new ConnectorError('INVALID_STATE', 'Invalid or expired state parameter.');
  }

  const config = resolveSharePointOAuthConfig(connector);
  const { clientId, azureTenantId, clientSecret, redirectUri } = config;

  const oauthProvider = new MicrosoftOAuthProvider({
    clientId,
    tenantId: azureTenantId,
  });
  const tokens = await oauthProvider.exchangeAuthorizationCode({
    code,
    redirectUri,
    clientSecret: clientSecret || '',
  });

  const oauthToken = await upsertOAuthToken(
    tenantId,
    {
      userId: userId || 'system',
      provider: 'microsoft_sharepoint' as const,
    },
    {
      providerUserId: tokens.providerUserId || 'unknown',
      encryptedAccessToken: tokens.accessToken,
      encryptedRefreshToken: tokens.refreshToken || '',
      scope: tokens.scope || session.scopes.join(' '),
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      consentedAt: new Date(),
    },
  );

  (connector as any).oauthTokenId = oauthToken._id;
  await (connector as any).save();
  await deleteDeviceCodeSession(connectorId);

  return { status: 'completed', connectorId };
}

export async function revokeAuth(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  if (!(connector as any).oauthTokenId) {
    throw new ConnectorError('NOT_AUTHENTICATED', 'Connector not authenticated');
  }

  await repo.revokeOAuthToken((connector as any).oauthTokenId, tenantId);
  (connector as any).oauthTokenId = null;
  await (connector as any).save();

  return { revoked: true };
}

// ─── Filters ─────────────────────────────────────────────────────────────

export async function validateFilters(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const filterConfig = (connector as any).filterConfig ?? {};
  const errors: string[] = [];

  // Validate standard filters
  if (filterConfig.standard) {
    const std = filterConfig.standard;
    if (std.contentCategories && !Array.isArray(std.contentCategories)) {
      errors.push('standard.contentCategories must be an array');
    }
    if (std.fileExtensions) {
      if (!['allowlist', 'denylist'].includes(std.fileExtensions.mode)) {
        errors.push('standard.fileExtensions.mode must be "allowlist" or "denylist"');
      }
      if (!Array.isArray(std.fileExtensions.extensions)) {
        errors.push('standard.fileExtensions.extensions must be an array');
      }
    }
    if (
      std.minFileSizeBytes !== null &&
      std.maxFileSizeBytes !== null &&
      std.minFileSizeBytes !== undefined &&
      std.maxFileSizeBytes !== undefined &&
      std.minFileSizeBytes > std.maxFileSizeBytes
    ) {
      errors.push('standard.minFileSizeBytes must be <= maxFileSizeBytes');
    }
  }

  // Validate advanced filters
  if (filterConfig.advancedFilters?.enabled) {
    const adv = filterConfig.advancedFilters;
    if (!['AND', 'OR'].includes(adv.rootOperator)) {
      errors.push('advancedFilters.rootOperator must be "AND" or "OR"');
    }
    const totalConditions =
      (adv.conditions?.length ?? 0) +
      (adv.groups ?? []).reduce((sum: number, g: any) => sum + (g.conditions?.length ?? 0), 0);
    if (totalConditions > 50) {
      errors.push('Too many advanced filter conditions (max 50)');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, config: filterConfig };
}

// ─── Filter Templates & Preview ──────────────────────────────────────────

export async function getFilterTemplates(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const { getTemplatesForConnector } = await import('@agent-platform/connectors-base');
  return getTemplatesForConnector(connector.connectorType);
}

export async function applyFilterTemplate(
  connectorId: string,
  tenantId: string,
  templateId: string,
  merge: boolean,
) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const { getTemplateById, resolveRelativeDate } = await import('@agent-platform/connectors-base');
  const template = getTemplateById(templateId);
  if (!template) {
    throw new ConnectorError('INVALID_TEMPLATE', `Template '${templateId}' not found`, 400);
  }

  // Check connector type compatibility
  if (
    template.connectorTypes.length > 0 &&
    !template.connectorTypes.includes(connector.connectorType)
  ) {
    throw new ConnectorError(
      'INCOMPATIBLE_TEMPLATE',
      `Template '${templateId}' is not compatible with connector type '${connector.connectorType}'`,
      400,
    );
  }

  // Build update from template
  const update: Record<string, any> = {};

  if (template.filters.contentCategories) {
    update['filterConfig.standard.contentCategories'] = template.filters.contentCategories;
  }
  if (template.filters.fileExtensions) {
    update['filterConfig.standard.fileExtensions'] = template.filters.fileExtensions;
  }
  if (template.filters.maxFileSizeBytes) {
    update['filterConfig.standard.maxFileSizeBytes'] = template.filters.maxFileSizeBytes;
  }
  if (template.filters.modifiedAfter) {
    const resolved = resolveRelativeDate(template.filters.modifiedAfter);
    if (resolved) {
      update['filterConfig.standard.modifiedAfter'] = resolved;
    }
  }
  if (template.filters.folderPaths) {
    update['filterConfig.scope.folderPaths'] = template.filters.folderPaths;
  }

  // Increment filter version
  update['filterConfig.version'] = (connector.filterConfig?.version ?? 0) + 1;

  const updated = await getLazyModel('ConnectorConfig').findOneAndUpdate(
    { _id: connectorId, tenantId },
    { $set: update },
    { new: true },
  );

  return {
    applied: templateId,
    templateName: template.name,
    filterConfig: updated?.filterConfig,
  };
}

export async function previewFilters(
  connectorId: string,
  tenantId: string,
  proposedFilterConfig?: any,
) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  // Use proposed config or current config (default to empty if none configured yet)
  const filterConfig = proposedFilterConfig || (connector as any).filterConfig || {};

  // Validate the proposed config — don't fail preview if validation throws
  let validation: { valid: boolean; errors?: string[] } = { valid: true };
  try {
    validation = await validateFilters(connectorId, tenantId);
  } catch {
    validation = { valid: true, errors: [] };
  }

  // Estimate impact using discovery data if available
  const ConnectorDiscovery = getLazyModel('ConnectorDiscovery');
  const discovery = await ConnectorDiscovery.findOne({
    tenantId,
    connectorId,
    status: 'completed',
  })
    .sort({ completedAt: -1 })
    .lean();

  let estimatedDocuments: number | null = null;
  let estimatedSites: number | null = null;
  let discoveryAge: string | null = null;

  if (discovery) {
    const ageMs = Date.now() - new Date((discovery as any).completedAt).getTime();
    discoveryAge = ageMs < 86400000 ? 'fresh' : 'stale';

    // Estimate from discovery profiles
    const profiles = (discovery as any).profiles ?? [];
    const totalDocs = profiles.reduce((sum: number, p: any) => sum + (p.totalDocuments ?? 0), 0);
    estimatedDocuments = totalDocs;
    estimatedSites = (discovery as any).resources?.length ?? null;
  }

  return {
    validation,
    currentFilterConfig: connector.filterConfig,
    proposedFilterConfig: proposedFilterConfig ? filterConfig : null,
    estimate: {
      totalDocumentsInSource: estimatedDocuments,
      totalSitesInSource: estimatedSites,
      discoveryDataAge: discoveryAge,
      note: estimatedDocuments
        ? 'Estimate based on discovery data. Actual count may vary.'
        : 'No discovery data available. Run discovery first for accurate estimates.',
    },
  };
}

// ─── Sync ────────────────────────────────────────────────────────────────

export async function startSync(connectorId: string, tenantId: string, syncType: string = 'full') {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  if (!(connector as any).oauthTokenId) {
    throw new ConnectorError(
      'NOT_AUTHENTICATED',
      'Connector not authenticated. Run auth flow first.',
    );
  }

  const oauthToken = await repo.findOAuthToken((connector as any).oauthTokenId, tenantId);
  if (!oauthToken || (oauthToken as any).revokedAt) {
    throw new ConnectorError('TOKEN_INVALID', 'OAuth token revoked or invalid');
  }

  if ((connector as any).syncState.syncInProgress) {
    throw new ConnectorError('SYNC_IN_PROGRESS', 'Sync already in progress');
  }

  // Reset paused state if user explicitly starts a new sync
  if ((connector as any).errorState.isPaused) {
    (connector as any).errorState.isPaused = false;
    (connector as any).errorState.pauseReason = null;
    await (connector as any).save();
  }

  if (!['full', 'delta'].includes(syncType)) {
    throw new ConnectorError('INVALID_SYNC_TYPE', 'syncType must be "full" or "delta"');
  }

  if (syncType === 'delta') {
    const tokenCount = await repo.countDeltaTokens(connectorId, tenantId);
    if (tokenCount === 0) {
      throw new ConnectorError(
        'DELTA_REQUIRES_FULL',
        'Delta sync requires a previous full sync to establish delta tokens',
      );
    }
  }

  const syncQueue = createQueue(QUEUE_CONNECTOR_SYNC);
  const job = await syncQueue.add(
    `${syncType}-sync`,
    { connectorId, tenantId, syncType } as ConnectorSyncJobData,
    {
      jobId: `${connectorId}-${syncType}-${Date.now()}`,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    },
  );

  return {
    syncType,
    message: `${syncType === 'full' ? 'Full' : 'Delta'} sync job queued`,
    jobId: job.id,
    queuedAt: new Date(),
  };
}

/**
 * Stop sync with hybrid cancellation signal (Redis + DB).
 * Immediately publishes Redis signal for <5s latency, plus DB flag for 30s fallback.
 */
export async function stopSync(connectorId: string, tenantId: string, redis: any, reason?: string) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  if ((connector as any).errorState.isPaused) {
    throw new ConnectorError('ALREADY_STOPPED', 'Connector already stopped');
  }

  const jobId = (connector as any).syncState.currentJobId;
  if (!jobId) {
    throw new ConnectorError('NO_ACTIVE_SYNC', 'No active sync to stop');
  }

  // 1. Update DB (fallback path for cancellation checker)
  const doc = connector as any;
  doc.errorState.isPaused = true;
  doc.errorState.pausedAt = new Date();
  doc.errorState.pauseReason = reason || 'Manual stop';
  doc.syncState.syncInProgress = false;
  doc.syncState.currentJobId = null;
  await doc.save();

  // 2. Publish Redis signal (fast path <5s)
  const redisClient = redis ?? getSharedRedisClient();
  if (redisClient) {
    const channel = `connector-sync:${jobId}:cancel`;
    await redisClient.publish(channel, JSON.stringify({ stopped: true, timestamp: new Date() }));
  }

  return { stopped: true, reason: doc.errorState.pauseReason };
}

export async function pauseSync(
  connectorId: string,
  tenantId: string,
  redis: any,
  reason?: string,
) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  if ((connector as any).errorState.isPaused) {
    throw new ConnectorError('ALREADY_PAUSED', 'Connector already paused');
  }

  const doc = connector as any;

  // 1. Update DB (fallback path for cancellation checker)
  doc.errorState.isPaused = true;
  doc.errorState.pausedAt = new Date();
  doc.errorState.pauseReason = reason || 'Manual pause';
  await doc.save();

  // 2. Publish Redis cancel signal to stop in-flight sync (same pattern as stopSync)
  const jobId = doc.syncState.currentJobId;
  if (jobId) {
    const redisClient = redis ?? getSharedRedisClient();
    if (redisClient) {
      const channel = `connector-sync:${jobId}:cancel`;
      await redisClient.publish(channel, JSON.stringify({ paused: true, timestamp: new Date() }));
    }
  }

  return { paused: true, reason: doc.errorState.pauseReason };
}

export async function resumeSync(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  if (!(connector as any).errorState.isPaused) {
    throw new ConnectorError('NOT_PAUSED', 'Connector not paused');
  }

  const doc = connector as any;
  doc.errorState.isPaused = false;
  doc.errorState.pausedAt = null;
  doc.errorState.pauseReason = null;
  await doc.save();

  const syncQueue = createQueue(QUEUE_CONNECTOR_SYNC);
  const job = await syncQueue.add('resume-sync', {
    connectorId,
    tenantId,
    syncType: 'full',
    resumeFromCheckpoint: true,
  });

  return {
    resumed: true,
    jobId: job.id,
    message: 'Sync will resume from last checkpoint',
  };
}

export async function restartSync(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  await repo.deleteSyncCheckpoints(connectorId, tenantId);

  const doc = connector as any;
  doc.syncState.processedDocuments = 0;
  doc.syncState.failedDocuments = 0;
  doc.syncState.lastSyncError = null;
  doc.errorState.isPaused = false;
  doc.errorState.pausedAt = null;
  doc.errorState.pauseReason = null;
  await doc.save();

  const syncQueue = createQueue(QUEUE_CONNECTOR_SYNC);
  const job = await syncQueue.add('restart-sync', {
    connectorId,
    tenantId,
    syncType: 'full',
    resumeFromCheckpoint: false,
  });

  return {
    restarted: true,
    jobId: job.id,
    message: 'Checkpoint deleted. Starting fresh full sync.',
  };
}

export async function getSyncStatus(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const doc = connector as any;
  let status = 'idle';
  if (doc.errorState.isPaused) {
    status = 'paused';
  } else if (doc.syncState.syncInProgress) {
    status = 'syncing';
  } else if (doc.syncState.lastFullSyncAt && !doc.syncState.lastDeltaSyncAt) {
    status = 'syncing';
  }

  const { totalDocuments, processedDocuments } = doc.syncState;
  const progressPercentage =
    totalDocuments > 0 ? Math.round((processedDocuments / totalDocuments) * 100) : 0;

  const isActive = doc.syncState.syncInProgress === true;
  const syncType = doc.syncState.syncType ?? null;
  const sizeTotal = doc.syncState.sizeTotal ?? null;

  // Compute ETA from sync duration and progress
  let etaSeconds: number | null = null;
  if (
    isActive &&
    processedDocuments > 0 &&
    totalDocuments > processedDocuments &&
    doc.syncState.syncStartedAt
  ) {
    const elapsedMs = Date.now() - new Date(doc.syncState.syncStartedAt).getTime();
    const remainingDocs = totalDocuments - processedDocuments;
    etaSeconds = Math.round((elapsedMs / processedDocuments) * (remainingDocs / 1000));
  }

  return {
    status,
    syncType,
    isActive,
    syncState: doc.syncState,
    errorState: doc.errorState,
    progress: {
      docsProcessed: processedDocuments,
      docsTotal: totalDocuments,
      sizeProcessed: null as number | null,
      sizeTotal,
      percentage: progressPercentage,
      etaSeconds,
      currentDocument: null as { name: string; sourceSite: string } | null,
    },
    perSiteProgress: [] as Array<{
      siteName: string;
      percentage: number;
      docsProcessed: number;
      docsTotal: number;
    }>,
  };
}

// ─── Delta Sync ──────────────────────────────────────────────────────────

export async function triggerDeltaSync(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const doc = connector as any;
  if (doc.errorState.isPaused) {
    throw new ConnectorError('PAUSED', 'Connector is paused');
  }

  if (!doc.syncState.lastFullSyncAt) {
    throw new ConnectorError(
      'FULL_SYNC_REQUIRED',
      'Connector must complete full sync before delta sync',
    );
  }

  const tokenCount = await repo.countDeltaTokens(connectorId, tenantId);
  if (tokenCount === 0) {
    throw new ConnectorError('NO_DELTA_TOKENS', 'No delta tokens found');
  }

  await repo.updateConnectorDeltaSyncTimestamp(connectorId, tenantId);

  return {
    message: 'Delta sync triggered',
    connector: {
      id: connectorId,
      lastDeltaSyncAt: new Date(),
      tokenCount,
    },
  };
}

export async function listDeltaTokens(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const tokens = await repo.findDeltaTokens(connectorId, tenantId);
  const now = new Date();
  const tokensWithStatus = tokens.map((token) => {
    const hoursSinceSync = (now.getTime() - token.lastSyncAt.getTime()) / (1000 * 60 * 60);
    const isStale = hoursSinceSync > 1;

    return {
      driveId: token.driveId,
      lastSyncAt: token.lastSyncAt,
      itemsProcessedSinceToken: token.itemsProcessedSinceToken,
      hoursSinceSync: Math.round(hoursSinceSync * 10) / 10,
      isStale,
      createdAt: token.createdAt,
    };
  });

  return {
    connectorId,
    totalTokens: tokens.length,
    staleTokens: tokensWithStatus.filter((t) => t.isStale).length,
    tokens: tokensWithStatus,
  };
}

export async function resetDeltaToken(connectorId: string, tenantId: string, driveId: string) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const deletedCount = await repo.deleteDeltaToken(connectorId, tenantId, driveId);
  if (deletedCount === 0) {
    throw new ConnectorError('TOKEN_NOT_FOUND', 'Delta token not found for this drive', 404);
  }

  return {
    message: 'Delta token reset',
    drive: {
      driveId,
      note: 'Next sync for this drive will be a full sync',
    },
  };
}

// ─── Permissions ─────────────────────────────────────────────────────────

export async function startPermissionCrawl(
  connectorId: string,
  tenantId: string,
  mode: string = 'simplified',
) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  if (!['full', 'simplified', 'disabled'].includes(mode)) {
    throw new ConnectorError('INVALID_MODE', 'mode must be "full", "simplified", or "disabled"');
  }

  if (mode === 'disabled') {
    throw new ConnectorError('INVALID_MODE', 'Cannot crawl with mode "disabled"');
  }

  const doc = connector as any;
  if (doc.permissionConfig.crawlInProgress) {
    throw new ConnectorError('CRAWL_IN_PROGRESS', 'Permission crawl already in progress');
  }

  if (!doc.oauthTokenId) {
    throw new ConnectorError(
      'NOT_AUTHENTICATED',
      'Connector not authenticated. Run auth flow first.',
    );
  }

  const crawlQueue = createQueue(QUEUE_CONNECTOR_PERMISSION_CRAWL);
  const job = await crawlQueue.add(
    'permission-crawl',
    { connectorId, tenantId, mode } as ConnectorPermissionCrawlJobData,
    {
      jobId: `${connectorId}-permission-crawl-${Date.now()}`,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    },
  );

  return {
    mode,
    message: `Permission crawl job queued (mode: ${mode})`,
    jobId: job.id,
    queuedAt: new Date(),
  };
}

export async function getPermissionStatus(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const doc = connector as any;
  const status = doc.permissionConfig.crawlInProgress ? 'crawling' : 'idle';

  return {
    status,
    mode: doc.permissionConfig.mode,
    crawlInProgress: doc.permissionConfig.crawlInProgress,
    currentJobId: doc.permissionConfig.currentJobId,
    lastCrawlAt: doc.permissionConfig.lastCrawlAt,
    documentsProcessed: doc.permissionConfig.documentsProcessed,
    averageAccuracy: doc.permissionConfig.averageAccuracy,
    lastCrawlError: doc.permissionConfig.lastCrawlError,
  };
}

export async function updatePermissionMode(connectorId: string, tenantId: string, mode: string) {
  if (!['full', 'simplified', 'disabled'].includes(mode)) {
    throw new ConnectorError('INVALID_MODE', 'mode must be "full", "simplified", or "disabled"');
  }

  const connector = await repo.updateConnectorPermissionMode(connectorId, tenantId, mode);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  return {
    mode,
    message: `Permission mode updated to "${mode}"`,
    permissionConfig: (connector as any).permissionConfig,
  };
}

export async function triggerPermissionRecrawl(connectorId: string, tenantId: string) {
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const doc = connector as any;
  if (doc.permissionConfig.mode === 'disabled') {
    throw new ConnectorError('MODE_DISABLED', 'Permission mode is disabled for this connector');
  }

  if (doc.permissionConfig.crawlInProgress) {
    throw new ConnectorError('CRAWL_IN_PROGRESS', 'Permission crawl already in progress');
  }

  const { triggerManualRecrawl, createPermissionRecrawlQueue } =
    await import('../workers/permission-recrawl-worker.js');

  const recrawlQueue = createPermissionRecrawlQueue();
  const jobId = await triggerManualRecrawl(recrawlQueue, connectorId, tenantId);

  return {
    message: 'Permission recrawl job queued',
    jobId,
    queuedAt: new Date(),
  };
}

// ─── Jobs ────────────────────────────────────────────────────────────────

export async function getJobStatus(jobId: string) {
  const syncQueue = createQueue(QUEUE_CONNECTOR_SYNC);
  let job = await syncQueue.getJob(jobId);

  if (!job) {
    const crawlQueue = createQueue(QUEUE_CONNECTOR_PERMISSION_CRAWL);
    job = await crawlQueue.getJob(jobId);
  }

  if (!job) {
    throw new ConnectorError('NOT_FOUND', 'Job not found', 404);
  }

  const state = await job.getState();

  return {
    jobId: job.id,
    state,
    progress: job.progress,
    data: job.data,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    failedReason: job.failedReason,
    returnvalue: job.returnvalue,
  };
}

// ─── Name Uniqueness Check ──────────────────────────────────────────────

export async function checkConnectorName(
  indexId: string,
  tenantId: string,
  name: string,
): Promise<{ available: boolean; suggestion?: string }> {
  const sources = await repo.findSourcesByIndex(indexId, tenantId);
  const existingNames = new Set(sources.map((s: { name?: string }) => s.name?.toLowerCase()));

  if (!existingNames.has(name.toLowerCase())) {
    return { available: true };
  }

  // Generate suggestion by appending " (N)"
  let suffix = 2;
  let suggestion = `${name} (${suffix})`;
  while (existingNames.has(suggestion.toLowerCase())) {
    suffix++;
    suggestion = `${name} (${suffix})`;
  }

  return { available: false, suggestion };
}

// ─── Admin Email Generation ─────────────────────────────────────────────

export async function generateAdminEmail(
  indexId: string,
  tenantId: string,
  type: 'app_registration_setup',
): Promise<{ subject: string; body: string; mailto: string }> {
  const redirectUri = getConnectorRedirectUri();

  const subject = 'Action Required: Azure App Registration for SharePoint Connector';
  const body = [
    'Hi,',
    '',
    'We need an Azure App Registration created for our SharePoint connector integration.',
    'Please follow these steps:',
    '',
    '1. Go to Azure Portal > Azure Active Directory > App registrations > New registration',
    '2. Name: "ABL Platform SharePoint Connector"',
    '3. Supported account types: "Accounts in this organizational directory only"',
    `4. Redirect URI (Web): ${redirectUri}`,
    '',
    '5. Under API permissions, add the following Microsoft Graph permissions:',
    '   - Sites.Read.All (Application)',
    '   - Files.Read.All (Application)',
    '   - GroupMember.Read.All (Application)',
    '   - offline_access (Delegated)',
    '',
    '6. Under Certificates & secrets, create a new client secret',
    '7. Grant admin consent for all permissions',
    '',
    'After setup, please provide:',
    '- Application (client) ID',
    '- Directory (tenant) ID',
    '- Client secret value',
    '',
    'Thank you!',
  ].join('\n');

  const encodedSubject = encodeURIComponent(subject);
  const encodedBody = encodeURIComponent(body);
  const mailto = `mailto:?subject=${encodedSubject}&body=${encodedBody}`;

  return { subject, body, mailto };
}

// ─── Bulk Actions ────────────────────────────────────────────────────────

const BULK_CONCURRENCY = 5;

export async function executeBulkAction(
  indexId: string,
  tenantId: string,
  action: string,
  sourceIds: string[],
  params?: Record<string, unknown>,
): Promise<{
  results: Array<{ sourceId: string; success: boolean; error?: string }>;
  successCount: number;
  failureCount: number;
}> {
  const results: Array<{ sourceId: string; success: boolean; error?: string }> = [];

  // Process in batches of BULK_CONCURRENCY
  for (let i = 0; i < sourceIds.length; i += BULK_CONCURRENCY) {
    const batch = sourceIds.slice(i, i + BULK_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map((sourceId) => executeSingleAction(indexId, tenantId, action, sourceId, params)),
    );

    for (let j = 0; j < batch.length; j++) {
      const result = batchResults[j];
      if (result.status === 'fulfilled') {
        results.push({ sourceId: batch[j], success: true });
      } else {
        const errorMsg =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        results.push({ sourceId: batch[j], success: false, error: errorMsg });
      }
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  return { results, successCount, failureCount };
}

async function executeSingleAction(
  indexId: string,
  tenantId: string,
  action: string,
  sourceId: string,
  _params?: Record<string, unknown>,
): Promise<void> {
  // Find connector by sourceId
  const ConnectorConfigModel = getLazyModel('ConnectorConfig');
  const connector = await ConnectorConfigModel.findOne({ sourceId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', `Connector for source ${sourceId} not found`, 404);
  }
  const connectorId = (connector as Record<string, unknown>)._id as string;

  switch (action) {
    case 'pause':
      await pauseSync(connectorId, tenantId, 'bulk_action');
      break;
    case 'resume':
      await resumeSync(connectorId, tenantId);
      break;
    case 'sync_now':
      await startSync(connectorId, tenantId, 'full');
      break;
    case 'delete':
      await deleteConnector(connectorId, tenantId);
      break;
    case 're_auth':
    case 'apply_schedule':
    case 'export_configs':
      // These actions require additional implementation; return 501 for now
      throw new ConnectorError(
        'NOT_IMPLEMENTED',
        `Bulk action "${action}" is not yet implemented`,
        501,
      );
    default:
      throw new ConnectorError('INVALID_ACTION', `Unknown action: ${action}`, 400);
  }
}

/**
 * Clone an existing connector's configuration into a new draft connector.
 * Auth tokens and sync history are NEVER cloned.
 */
export async function cloneConnector(
  indexId: string,
  sourceConnectorId: string,
  tenantId: string,
  securityDecision?: string,
): Promise<{
  connectorId: string;
  name: string;
  status: 'draft';
  permissionMode: string;
  clonedFrom: string;
  isCrossTenant: boolean;
}> {
  const { connector: sourceConnector } = await getConnector(sourceConnectorId, tenantId);
  if (!sourceConnector) {
    throw new ConnectorError('NOT_FOUND', 'Source connector not found', 404);
  }

  const sourceConfig = (sourceConnector.connectionConfig ?? {}) as Record<string, unknown>;
  const sourceTenantId = (sourceConfig.tenantId as string) ?? tenantId;
  const isCrossTenant = sourceTenantId !== tenantId;

  let permissionMode = (sourceConfig.permissionMode as string) ?? 'public_access';
  if (securityDecision === 'disable_permissions') {
    permissionMode = 'disabled';
  }

  const clonedConnectionConfig: Record<string, unknown> = {
    displayName: `${String(sourceConfig.displayName ?? sourceConnector.connectorType)} (clone)`,
    permissionMode,
    syncSchedule: sourceConfig.syncSchedule ?? null,
    clonedFrom: sourceConnectorId,
  };

  // For cross-tenant clones, clear site selections
  if (!isCrossTenant) {
    clonedConnectionConfig.siteUrl = sourceConfig.siteUrl;
    clonedConnectionConfig.siteId = sourceConfig.siteId;
  }

  const clonedFilterConfig = { ...(sourceConnector.filterConfig ?? {}) } as Record<string, unknown>;

  const result = await createConnector(indexId, tenantId, {
    name: `${String(sourceConfig.displayName ?? sourceConnector.connectorType)} (clone)`,
    connectorType: sourceConnector.connectorType,
    connectionConfig: clonedConnectionConfig,
    filterConfig: clonedFilterConfig,
  });

  const connectorId = (result.connector as Record<string, unknown>)._id as string;

  logger.info('Connector cloned', {
    sourceConnectorId,
    newConnectorId: connectorId,
    isCrossTenant,
    tenantId,
  });

  return {
    connectorId,
    name: clonedConnectionConfig.displayName as string,
    status: 'draft',
    permissionMode,
    clonedFrom: sourceConnectorId,
    isCrossTenant,
  };
}
