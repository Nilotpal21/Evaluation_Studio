/**
 * SDK Repository
 *
 * MongoDB repo for PublicApiKey, DebugToken, and WidgetConfig models.
 */

import type {
  IDebugToken,
  IPublicApiKey,
  ISDKChannel,
  IWidgetConfig,
  PublicApiKeyPermissions,
} from '@agent-platform/database/models';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';
import { ensureDb } from '@/lib/ensure-db';
import { findProjectByIdAndTenant } from '@/repos/project-repo';

type MongoDocument = {
  _id: string;
  _v?: number;
  __v?: number;
};

type PlainDocument<T extends MongoDocument> = Omit<T, '_id' | '_v' | '__v'> & {
  id: string;
};

type PublicApiKeyRecord = PlainDocument<IPublicApiKey>;
type DebugTokenRecord = PlainDocument<IDebugToken>;
type WidgetConfigRecord = PlainDocument<IWidgetConfig>;
type SDKChannelRecord = PlainDocument<ISDKChannel>;

interface PublicApiKeyWhere {
  id?: string;
  projectId?: string;
  tenantId: string;
  keyHash?: string;
  isActive?: boolean;
}

interface PublicApiKeyCreateInput {
  keyPrefix: string;
  keyHash: string;
  name: string;
  allowedOrigins?: string[] | null;
  permissions?: PublicApiKeyPermissions | null;
  expiresAt?: Date | null;
  isActive?: boolean;
}

type PublicApiKeyUpdateInput = Partial<
  Pick<
    PublicApiKeyRecord,
    'name' | 'allowedOrigins' | 'permissions' | 'lastUsedAt' | 'expiresAt' | 'isActive'
  >
>;

type DateRangeFilter = {
  gt?: Date;
  gte?: Date;
  lt?: Date;
  lte?: Date;
};

interface DebugTokenWhere {
  id?: string;
  token?: string;
  userId?: string;
  revokedAt?: Date | null;
  expiresAt?: Date | DateRangeFilter;
}

type DebugTokenSerializedArrayField = IDebugToken['sessionIds'] | string;

interface DebugTokenCreateInput {
  token: string;
  userId: string;
  /**
   * Studio debug-token routes still send JSON-stringified arrays today.
   * Accept that legacy form here so this slice can tighten the repo seam
   * without taking an unrelated behavior change.
   */
  sessionIds: DebugTokenSerializedArrayField;
  scopes: DebugTokenSerializedArrayField;
  expiresAt: Date;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
}

interface DebugTokenUpdateInput {
  sessionIds?: DebugTokenSerializedArrayField;
  scopes?: DebugTokenSerializedArrayField;
  expiresAt?: Date;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
}

type WidgetConfigUpdateInput = Partial<
  Pick<
    IWidgetConfig,
    | 'channelId'
    | 'mode'
    | 'position'
    | 'theme'
    | 'welcomeMessage'
    | 'placeholderText'
    | 'voiceEnabled'
    | 'chatEnabled'
  >
>;

interface WidgetConfigCreateInput extends Pick<
  IWidgetConfig,
  | 'channelId'
  | 'mode'
  | 'position'
  | 'theme'
  | 'welcomeMessage'
  | 'placeholderText'
  | 'voiceEnabled'
  | 'chatEnabled'
> {}

interface PublicApiKeyNormalizers {
  normalizePublicApiKeyAllowedOrigins: (value: unknown) => string[] | null;
  normalizePublicApiKeyPermissions: (value: unknown) => PublicApiKeyPermissions | null;
}

// =============================================================================
// PUBLIC API KEY
// =============================================================================

/**
 * Find many public API keys
 */
export async function findPublicApiKeys(where: PublicApiKeyWhere): Promise<PublicApiKeyRecord[]> {
  await ensureDb();
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const normalizers = await loadPublicApiKeyNormalizers();
  const docs = (await PublicApiKey.find(buildPublicApiKeyFilter(where))
    .sort({ createdAt: -1, _id: -1 })
    .lean()) as IPublicApiKey[];
  return docs
    .map((doc) => normalizePublicApiKeyDocument(doc, normalizers))
    .filter((doc): doc is PublicApiKeyRecord => doc !== null);
}

/**
 * Create a public API key
 */
export async function createPublicApiKey(
  projectId: string,
  tenantId: string,
  data: PublicApiKeyCreateInput,
): Promise<PublicApiKeyRecord> {
  await ensureDb();
  await assertProjectBelongsToTenant(projectId, tenantId);
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const normalizers = await loadPublicApiKeyNormalizers();
  const doc = await PublicApiKey.create({
    projectId,
    tenantId,
    keyPrefix: data.keyPrefix,
    keyHash: data.keyHash,
    name: data.name,
    allowedOrigins: data.allowedOrigins ?? null,
    permissions: data.permissions ?? null,
    expiresAt: data.expiresAt ?? null,
    isActive: data.isActive ?? true,
  });
  const normalized = normalizePublicApiKeyDocument(doc.toObject() as IPublicApiKey, normalizers);
  if (!normalized) {
    throw new AppError('Failed to create PublicApiKey', {
      ...ErrorCodes.INTERNAL_ERROR,
    });
  }
  return normalized;
}

/**
 * Find public API key by ID (project-scoped).
 */
export async function findPublicApiKeyById(
  id: string,
  projectId: string,
  tenantId: string,
): Promise<PublicApiKeyRecord | null> {
  await ensureDb();
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const normalizers = await loadPublicApiKeyNormalizers();
  const doc = (await PublicApiKey.findOne({
    _id: id,
    projectId,
    tenantId,
  }).lean()) as IPublicApiKey | null;
  return normalizePublicApiKeyDocument(doc, normalizers);
}

/**
 * Update a public API key (project-scoped).
 */
export async function updatePublicApiKey(
  id: string,
  projectId: string,
  tenantId: string,
  data: PublicApiKeyUpdateInput,
): Promise<PublicApiKeyRecord> {
  await ensureDb();
  await assertProjectBelongsToTenant(projectId, tenantId);
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const normalizers = await loadPublicApiKeyNormalizers();
  const doc = (await PublicApiKey.findOneAndUpdate(
    { _id: id, projectId, tenantId },
    { $set: buildPublicApiKeyUpdate(data) },
    { new: true },
  ).lean()) as IPublicApiKey | null;
  const normalized = normalizePublicApiKeyDocument(doc, normalizers);
  if (!normalized) {
    throw new AppError('PublicApiKey not found', { ...ErrorCodes.NOT_FOUND });
  }
  return normalized;
}

// =============================================================================
// DEBUG TOKEN
// =============================================================================

/**
 * Find many debug tokens
 */
export async function findDebugTokens(where: DebugTokenWhere): Promise<DebugTokenRecord[]> {
  await ensureDb();
  const { DebugToken } = await import('@agent-platform/database/models');
  const docs = (await DebugToken.find(buildDebugTokenFilter(where)).lean()) as IDebugToken[];
  return docs
    .map((doc) => normalizeDocument(doc))
    .filter((doc): doc is DebugTokenRecord => doc !== null);
}

/**
 * Create a debug token
 */
export async function createDebugToken(data: DebugTokenCreateInput): Promise<DebugTokenRecord> {
  await ensureDb();
  const { DebugToken } = await import('@agent-platform/database/models');
  const doc = await DebugToken.create({
    token: data.token,
    userId: data.userId,
    sessionIds: data.sessionIds,
    scopes: data.scopes,
    expiresAt: data.expiresAt,
    lastUsedAt: data.lastUsedAt ?? null,
    revokedAt: data.revokedAt ?? null,
  });
  const normalized = normalizeDocument(doc.toObject() as IDebugToken);
  if (!normalized) {
    throw new AppError('Failed to create DebugToken', {
      ...ErrorCodes.INTERNAL_ERROR,
    });
  }
  return normalized;
}

/**
 * Find debug token by ID (user-scoped).
 * DebugToken model has userId, not tenantId — scope accordingly.
 */
export async function findDebugTokenById(
  id: string,
  userId: string,
): Promise<DebugTokenRecord | null> {
  await ensureDb();
  const { DebugToken } = await import('@agent-platform/database/models');
  const doc = (await DebugToken.findOne({ _id: id, userId }).lean()) as IDebugToken | null;
  return normalizeDocument(doc);
}

/**
 * Find debug token by token string
 */
export async function findDebugTokenByToken(token: string): Promise<DebugTokenRecord | null> {
  await ensureDb();
  const { DebugToken } = await import('@agent-platform/database/models');
  const doc = (await DebugToken.findOne({ token }).lean()) as IDebugToken | null;
  return normalizeDocument(doc);
}

/**
 * Update a debug token by ID.
 * Accepts an optional userId for ownership scoping.
 */
export async function updateDebugToken(
  id: string,
  data: DebugTokenUpdateInput,
  userId?: string,
): Promise<DebugTokenRecord> {
  await ensureDb();
  const { DebugToken } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id };
  if (userId) {
    filter.userId = userId;
  }
  const doc = (await DebugToken.findOneAndUpdate(
    filter,
    { $set: buildDebugTokenUpdate(data) },
    { new: true },
  ).lean()) as IDebugToken | null;
  const normalized = normalizeDocument(doc);
  if (!normalized) {
    throw new AppError('DebugToken not found', { ...ErrorCodes.NOT_FOUND });
  }
  return normalized;
}

/**
 * Revoke debug tokens (updateMany)
 */
export async function revokeDebugTokens(where: DebugTokenWhere): Promise<{ count: number }> {
  await ensureDb();
  const { DebugToken } = await import('@agent-platform/database/models');
  const result = await DebugToken.updateMany(buildDebugTokenFilter(where), {
    $set: { revokedAt: new Date() },
  });
  return { count: result.modifiedCount || 0 };
}

// =============================================================================
// WIDGET CONFIG
// =============================================================================

/**
 * Find widget config by project ID
 */
export async function findWidgetConfig(
  projectId: string,
  tenantId: string,
): Promise<WidgetConfigRecord | null> {
  await ensureDb();
  const { WidgetConfig } = await import('@agent-platform/database/models');
  const doc = (await WidgetConfig.findOne({ projectId, tenantId }).lean()) as IWidgetConfig | null;
  return normalizeDocument(doc);
}

/**
 * Find active SDK channels for a tenant-scoped project.
 */
export async function findActiveSdkChannelsByProject(
  projectId: string,
  tenantId: string,
): Promise<SDKChannelRecord[]> {
  await ensureDb();
  const { SDKChannel } = await import('@agent-platform/database/models');
  const docs = (await SDKChannel.find({ projectId, tenantId, isActive: true })
    .sort({ createdAt: 1, _id: 1 })
    .lean()) as ISDKChannel[];
  return docs
    .map((doc) => normalizeDocument(doc))
    .filter((doc): doc is SDKChannelRecord => doc !== null);
}

/**
 * Find a single active SDK channel by ID within a tenant-scoped project.
 */
export async function findActiveSdkChannelById(
  channelId: string,
  projectId: string,
  tenantId: string,
): Promise<SDKChannelRecord | null> {
  await ensureDb();
  const { SDKChannel } = await import('@agent-platform/database/models');
  const doc = (await SDKChannel.findOne({
    _id: channelId,
    projectId,
    tenantId,
    isActive: true,
  }).lean()) as ISDKChannel | null;
  return normalizeDocument(doc);
}

/**
 * Find a single SDK channel by ID within a tenant, regardless of active state.
 * Used by Studio control-plane proxy routes to recover project scope without
 * reintroducing projectId in the URL contract.
 */
export async function findSdkChannelByIdForTenant(
  channelId: string,
  tenantId: string,
): Promise<SDKChannelRecord | null> {
  await ensureDb();
  const { SDKChannel } = await import('@agent-platform/database/models');
  const doc = (await SDKChannel.findOne({
    _id: channelId,
    tenantId,
  }).lean()) as ISDKChannel | null;
  return normalizeDocument(doc);
}

/**
 * Upsert widget config
 */
export async function upsertWidgetConfig(
  projectId: string,
  tenantId: string,
  data: { update: WidgetConfigUpdateInput; create: WidgetConfigCreateInput },
): Promise<WidgetConfigRecord> {
  await ensureDb();
  await assertProjectBelongsToTenant(projectId, tenantId);
  const { WidgetConfig } = await import('@agent-platform/database/models');
  const createData = {
    tenantId,
    projectId,
    ...data.create,
  };
  const insertOnlyFields = Object.fromEntries(
    Object.entries(createData).filter(([key]) => !(key in data.update)),
  );
  const doc = (await WidgetConfig.findOneAndUpdate(
    { projectId, tenantId },
    {
      $set: { ...data.update },
      $setOnInsert: insertOnlyFields,
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  ).lean()) as IWidgetConfig | null;
  const normalized = normalizeDocument(doc);
  if (!normalized) {
    throw new AppError('Failed to upsert WidgetConfig', {
      ...ErrorCodes.INTERNAL_ERROR,
    });
  }
  return normalized;
}

// =============================================================================
// HELPERS
// =============================================================================

function normalizeDocument<T extends MongoDocument>(doc: T | null): PlainDocument<T> | null {
  if (!doc) {
    return null;
  }

  const { _id, _v: _ignoredVersion, __v: _ignoredAltVersion, ...rest } = doc;
  return {
    ...(rest as Omit<T, '_id' | '_v' | '__v'>),
    id: _id,
  };
}

async function loadPublicApiKeyNormalizers(): Promise<PublicApiKeyNormalizers> {
  const { normalizePublicApiKeyAllowedOrigins, normalizePublicApiKeyPermissions } =
    await import('@agent-platform/database/models');
  return {
    normalizePublicApiKeyAllowedOrigins,
    normalizePublicApiKeyPermissions,
  };
}

function normalizePublicApiKeyDocument(
  doc: IPublicApiKey | null,
  normalizers: PublicApiKeyNormalizers,
): PublicApiKeyRecord | null {
  const normalized = normalizeDocument(doc);
  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    allowedOrigins: normalizers.normalizePublicApiKeyAllowedOrigins(normalized.allowedOrigins),
    permissions: normalizers.normalizePublicApiKeyPermissions(normalized.permissions),
  };
}

function buildPublicApiKeyFilter(where: PublicApiKeyWhere): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (where.id) {
    filter._id = where.id;
  }
  if (where.projectId) {
    filter.projectId = where.projectId;
  }
  if (where.tenantId) {
    filter.tenantId = where.tenantId;
  }
  if (where.keyHash) {
    filter.keyHash = where.keyHash;
  }
  if (where.isActive !== undefined) {
    filter.isActive = where.isActive;
  }
  return filter;
}

function buildPublicApiKeyUpdate(data: PublicApiKeyUpdateInput): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  if (data.name !== undefined) {
    update.name = data.name;
  }
  if (data.allowedOrigins !== undefined) {
    update.allowedOrigins = data.allowedOrigins;
  }
  if (data.permissions !== undefined) {
    update.permissions = data.permissions;
  }
  if (data.lastUsedAt !== undefined) {
    update.lastUsedAt = data.lastUsedAt;
  }
  if (data.expiresAt !== undefined) {
    update.expiresAt = data.expiresAt;
  }
  if (data.isActive !== undefined) {
    update.isActive = data.isActive;
  }
  return update;
}

function buildDateRangeQuery(value: Date | DateRangeFilter): Date | Record<string, Date> {
  if (value instanceof Date) {
    return value;
  }

  const query: Record<string, Date> = {};
  if (value.gt) {
    query.$gt = value.gt;
  }
  if (value.gte) {
    query.$gte = value.gte;
  }
  if (value.lt) {
    query.$lt = value.lt;
  }
  if (value.lte) {
    query.$lte = value.lte;
  }
  return query;
}

function buildDebugTokenFilter(where: DebugTokenWhere): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (where.id) {
    filter._id = where.id;
  }
  if (where.token) {
    filter.token = where.token;
  }
  if (where.userId) {
    filter.userId = where.userId;
  }
  if (where.revokedAt !== undefined) {
    filter.revokedAt = where.revokedAt;
  }
  if (where.expiresAt !== undefined) {
    filter.expiresAt = buildDateRangeQuery(where.expiresAt);
  }
  return filter;
}

function buildDebugTokenUpdate(data: DebugTokenUpdateInput): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  if (data.sessionIds !== undefined) {
    update.sessionIds = data.sessionIds;
  }
  if (data.scopes !== undefined) {
    update.scopes = data.scopes;
  }
  if (data.expiresAt !== undefined) {
    update.expiresAt = data.expiresAt;
  }
  if (data.lastUsedAt !== undefined) {
    update.lastUsedAt = data.lastUsedAt;
  }
  if (data.revokedAt !== undefined) {
    update.revokedAt = data.revokedAt;
  }
  return update;
}

async function assertProjectBelongsToTenant(projectId: string, tenantId: string): Promise<void> {
  const project = await findProjectByIdAndTenant(projectId, tenantId);
  if (!project) {
    throw new AppError('Project not found', { ...ErrorCodes.NOT_FOUND });
  }
}
