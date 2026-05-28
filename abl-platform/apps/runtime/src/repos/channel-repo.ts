/**
 * Channel Repository
 *
 * MongoDB SDK channel and public API key operations.
 * Used by: routes/channels.ts, routes/sdk-init.ts, middleware/sdk-auth.ts
 */

import type { SDKChannelAuthMode } from '@agent-platform/database/models';
import { findProjectByIdAndTenant } from './project-repo.js';

// =============================================================================
// TYPES
// =============================================================================

export interface PublicApiKeyDoc {
  id: string;
  keyPrefix: string;
  keyHash: string;
  name: string;
  projectId: string;
  tenantId?: string | null;
  isActive: boolean;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  /** Allowed origins for CORS (JSON string or array) */
  allowedOrigins?: string | string[] | null;
  /** Permissions map (JSON string or object) */
  permissions?: string | Record<string, boolean> | null;
  createdAt?: Date;
  updatedAt?: Date;
  /** Extensible — Mongo docs may have additional fields */
  [key: string]: unknown;
}

export interface SDKChannelDoc {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  channelType: string;
  deploymentId: string | null;
  publicApiKeyId: string;
  config: Record<string, unknown>;
  isActive: boolean;
  environment: string | null;
  followEnvironment: boolean;
  authMode?: SDKChannelAuthMode;
  serverSecretHash?: string | null;
  serverSecretSalt?: string | null;
  serverSecretPrefix?: string | null;
  serverSecretLastRotatedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface WidgetConfigDoc {
  id: string;
  tenantId: string;
  projectId: string;
  mode?: string;
  position?: string;
  theme?: unknown;
  welcomeMessage?: string | null;
  placeholderText?: string | null;
  voiceEnabled?: boolean;
  chatEnabled?: boolean;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export class SDKChannelProjectScopeError extends Error {
  constructor(message = 'Project not found for tenant') {
    super(message);
    this.name = 'SDKChannelProjectScopeError';
  }
}

export class SDKChannelPublicApiKeyScopeError extends Error {
  constructor(message = 'Public API key not found for project') {
    super(message);
    this.name = 'SDKChannelPublicApiKeyScopeError';
  }
}

function buildLegacyPublicApiKeyTenantScope(tenantId: string): Record<string, unknown> {
  return {
    $or: [{ tenantId }, { tenantId: null }, { tenantId: { $exists: false } }],
  };
}

// =============================================================================
// PUBLIC API KEYS
// =============================================================================

export async function findPublicApiKey(where: {
  keyHash?: string;
  id?: string;
  projectId?: string;
  tenantId?: string;
  isActive?: boolean;
}): Promise<PublicApiKeyDoc | null> {
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = {};
  if (where.keyHash) filter.keyHash = where.keyHash;
  if (where.id) filter._id = where.id;
  if (where.projectId) filter.projectId = where.projectId;
  if (where.tenantId) filter.tenantId = where.tenantId;
  if (where.isActive !== undefined) filter.isActive = where.isActive;
  const doc = await PublicApiKey.findOne(filter).lean();
  return doc ? (normalizeId(doc) as PublicApiKeyDoc) : null;
}

export async function findPublicApiKeys(where: {
  projectId: string;
  tenantId?: string;
  isActive?: boolean;
}): Promise<PublicApiKeyDoc[]> {
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = {
    projectId: where.projectId,
  };
  if (where.tenantId) filter.tenantId = where.tenantId;
  if (where.isActive !== undefined) filter.isActive = where.isActive;

  const docs = await PublicApiKey.find(filter).sort({ createdAt: -1 }).lean();
  return docs.map((doc: Record<string, unknown>) => normalizeId(doc) as PublicApiKeyDoc);
}

export async function findPublicApiKeysByIds(where: {
  ids: string[];
  projectId?: string;
  tenantId?: string;
}): Promise<PublicApiKeyDoc[]> {
  const normalizedIds: string[] = [];
  for (const id of where.ids) {
    const trimmedId = id.trim();
    if (trimmedId.length > 0 && !normalizedIds.includes(trimmedId)) {
      normalizedIds.push(trimmedId);
    }
  }

  if (normalizedIds.length === 0) {
    return [];
  }

  const { PublicApiKey } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: { $in: normalizedIds } };
  if (where.projectId) filter.projectId = where.projectId;
  if (where.tenantId) filter.tenantId = where.tenantId;

  const docs = await PublicApiKey.find(filter).lean();
  const normalizedDocs: PublicApiKeyDoc[] = docs.map(
    (doc: Record<string, unknown>) => normalizeId(doc) as PublicApiKeyDoc,
  );

  if (!where.tenantId || normalizedDocs.length === normalizedIds.length) {
    return normalizedDocs;
  }

  const foundIds = normalizedDocs.map((doc) => doc.id);
  const missingIds = normalizedIds.filter((id) => !foundIds.includes(id));
  if (missingIds.length === 0) {
    return normalizedDocs;
  }

  const legacyFilter: Record<string, unknown> = {
    _id: { $in: missingIds },
    ...buildLegacyPublicApiKeyTenantScope(where.tenantId),
  };
  if (where.projectId) {
    legacyFilter.projectId = where.projectId;
  }

  const legacyDocs = await PublicApiKey.find(legacyFilter).lean();
  return [
    ...normalizedDocs,
    ...legacyDocs.map((doc: Record<string, unknown>) => normalizeId(doc) as PublicApiKeyDoc),
  ];
}

export async function createPublicApiKey(data: {
  projectId: string;
  tenantId: string;
  keyPrefix: string;
  keyHash: string;
  name: string;
  allowedOrigins?: string[] | null;
  permissions?: Record<string, boolean> | null;
  expiresAt?: Date | null;
  isActive?: boolean;
}): Promise<PublicApiKeyDoc> {
  if (!(await projectBelongsToTenant(data.projectId, data.tenantId))) {
    throw new Error('Project not found for tenant');
  }

  const { PublicApiKey } = await import('@agent-platform/database/models');
  const doc = await PublicApiKey.create({
    projectId: data.projectId,
    tenantId: data.tenantId,
    keyPrefix: data.keyPrefix,
    keyHash: data.keyHash,
    name: data.name,
    allowedOrigins: data.allowedOrigins ?? null,
    permissions: data.permissions ?? null,
    expiresAt: data.expiresAt ?? null,
    isActive: data.isActive ?? true,
  });
  return normalizeId(doc.toObject()) as PublicApiKeyDoc;
}

export async function deletePublicApiKey(
  id: string,
  projectId: string,
  tenantId?: string,
): Promise<boolean> {
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id, projectId };
  if (tenantId) {
    filter.tenantId = tenantId;
  }

  const result = await PublicApiKey.deleteOne(filter);
  return result.deletedCount > 0;
}

export async function updatePublicApiKey(
  id: string,
  projectId: string,
  data: Record<string, unknown>,
  tenantId?: string,
): Promise<PublicApiKeyDoc | null> {
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id, projectId };
  if (tenantId) filter.tenantId = tenantId;
  const doc = await PublicApiKey.findOneAndUpdate(filter, { $set: data }, { new: true }).lean();
  if (doc || !tenantId) {
    return doc ? (normalizeId(doc) as PublicApiKeyDoc) : null;
  }

  const legacyDoc = await PublicApiKey.findOneAndUpdate(
    { _id: id, projectId, ...buildLegacyPublicApiKeyTenantScope(tenantId) },
    { $set: data },
    { new: true },
  ).lean();
  return legacyDoc ? (normalizeId(legacyDoc) as PublicApiKeyDoc) : null;
}

export async function findPublicApiKeyForSdk(
  keyHash: string,
): Promise<(PublicApiKeyDoc & { project?: { tenantId?: string; name?: string } }) | null> {
  const { PublicApiKey, Project } = await import('@agent-platform/database/models');
  const key = await PublicApiKey.findOne({
    keyHash,
    isActive: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  }).lean();
  if (!key) return null;
  const project = await Project.findOne(
    { _id: (key as any).projectId },
    { tenantId: 1, name: 1 },
  ).lean();
  return { ...normalizeId(key), project: project ? normalizeId(project) : undefined } as any;
}

export async function updatePublicApiKeyLastUsed(id: string): Promise<void> {
  const { PublicApiKey } = await import('@agent-platform/database/models');
  await PublicApiKey.updateOne({ _id: id }, { $set: { lastUsedAt: new Date() } });
}

export async function getOrCreateDefaultPublicApiKey(
  projectId: string,
  tenantId: string,
): Promise<PublicApiKeyDoc> {
  await assertProjectBelongsToTenant(projectId, tenantId);

  const { PublicApiKey } = await import('@agent-platform/database/models');
  // Find an existing active key for this project
  const existing = await PublicApiKey.findOne({ projectId, tenantId, isActive: true }).lean();
  if (existing) return normalizeId(existing) as PublicApiKeyDoc;

  // TODO(web-sdk-channel-parity): Remove this legacy fallback after
  // backfill-public-api-key-tenant-id.ts has run and all public_api_keys
  // records have been backfilled with tenantId.
  const anyKey = await PublicApiKey.findOne({ projectId, isActive: true }).lean();
  if (anyKey) return normalizeId(anyKey) as PublicApiKeyDoc;

  // Auto-create a default public API key
  const { randomBytes, createHash } = await import('crypto');
  const rawKey = `pk_${randomBytes(24).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const doc = await PublicApiKey.create({
    projectId,
    tenantId,
    keyPrefix: rawKey.slice(0, 11),
    keyHash,
    name: 'Default SDK Key',
    isActive: true,
  });
  return normalizeId(doc.toObject()) as PublicApiKeyDoc;
}

export async function findActivePublicApiKey(
  keyHash: string,
  projectId: string,
): Promise<PublicApiKeyDoc | null> {
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const doc = await PublicApiKey.findOne({
    keyHash,
    projectId,
    isActive: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  }).lean();
  return doc ? (normalizeId(doc) as PublicApiKeyDoc) : null;
}

// =============================================================================
// SDK CHANNELS
// =============================================================================

export async function createSDKChannel(data: {
  tenantId: string;
  projectId: string;
  name: string;
  channelType: string;
  deploymentId?: string | null;
  publicApiKeyId: string;
  config?: string;
  environment?: string | null;
  followEnvironment?: boolean;
  isActive?: boolean;
  authMode?: SDKChannelAuthMode;
  serverSecretHash?: string | null;
  serverSecretSalt?: string | null;
  serverSecretPrefix?: string | null;
  serverSecretLastRotatedAt?: Date | null;
}): Promise<SDKChannelDoc> {
  await assertProjectBelongsToTenant(data.projectId, data.tenantId);
  await assertPublicApiKeyBelongsToProject(data.publicApiKeyId, data.projectId);

  const { SDKChannel } = await import('@agent-platform/database/models');
  const doc = await SDKChannel.create({
    tenantId: data.tenantId,
    projectId: data.projectId,
    name: data.name,
    channelType: data.channelType,
    deploymentId: data.deploymentId || null,
    publicApiKeyId: data.publicApiKeyId,
    config: data.config ? JSON.parse(data.config) : {},
    environment: data.environment ?? null,
    followEnvironment: data.followEnvironment ?? true,
    isActive: data.isActive ?? true,
    ...(data.authMode !== undefined ? { authMode: data.authMode } : {}),
    ...(data.serverSecretHash !== undefined ? { serverSecretHash: data.serverSecretHash } : {}),
    ...(data.serverSecretSalt !== undefined ? { serverSecretSalt: data.serverSecretSalt } : {}),
    ...(data.serverSecretPrefix !== undefined
      ? { serverSecretPrefix: data.serverSecretPrefix }
      : {}),
    ...(data.serverSecretLastRotatedAt !== undefined
      ? { serverSecretLastRotatedAt: data.serverSecretLastRotatedAt }
      : {}),
  });
  return parseChannelDoc(doc.toObject());
}

export async function findSDKChannels(where: {
  projectId: string;
  tenantId: string;
}): Promise<SDKChannelDoc[]> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const docs = await SDKChannel.find(where).sort({ createdAt: -1 }).lean();
  return docs.map(parseChannelDoc);
}

export async function findSDKChannelsByTenant(tenantId: string): Promise<SDKChannelDoc[]> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const docs = await SDKChannel.find({ tenantId }).sort({ createdAt: -1 }).lean();
  return docs.map(parseChannelDoc);
}

export async function findSDKChannelByIdForTenant(
  id: string,
  tenantId: string,
): Promise<SDKChannelDoc | null> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const doc = await SDKChannel.findOne({ _id: id, tenantId }).lean();
  return doc ? parseChannelDoc(doc) : null;
}

export async function findSDKChannelById(
  id: string,
  projectId: string,
  tenantId: string,
): Promise<SDKChannelDoc | null> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const doc = await SDKChannel.findOne({ _id: id, projectId, tenantId }).lean();
  return doc ? parseChannelDoc(doc) : null;
}

export async function findSDKChannelByName(
  tenantId: string,
  projectId: string,
  name: string,
): Promise<SDKChannelDoc | null> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const doc = await SDKChannel.findOne({ tenantId, projectId, name }).lean();
  return doc ? parseChannelDoc(doc) : null;
}

export async function findSDKChannelsByPublicApiKeyId(
  tenantId: string,
  projectId: string,
  publicApiKeyId: string,
): Promise<SDKChannelDoc[]> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const docs = await SDKChannel.find({ tenantId, projectId, publicApiKeyId })
    .sort({ createdAt: -1 })
    .lean();
  return docs.map(parseChannelDoc);
}

export async function updateSDKChannel(
  id: string,
  projectId: string,
  tenantId: string,
  data: Record<string, unknown>,
): Promise<SDKChannelDoc | null> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  // for secretKey updates and re-encrypts plaintext safely.
  const doc = await SDKChannel.findOne({ _id: id, projectId, tenantId });
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'authProfileId') {
      continue;
    }
    doc.set(key, key === 'config' ? normalizeConfigUpdateValue(value) : value);
  }
  await doc.save();
  return parseChannelDoc(doc.toObject());
}

export async function deleteSDKChannel(
  id: string,
  projectId: string,
  tenantId: string,
): Promise<boolean> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const result = await SDKChannel.deleteOne({ _id: id, projectId, tenantId });
  return result.deletedCount > 0;
}

// =============================================================================
// BULK OPERATIONS
// =============================================================================

export async function bulkUpdateChannelDeployment(
  tenantId: string,
  projectId: string,
  environment: string,
  newDeploymentId: string,
): Promise<number> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const result = await SDKChannel.updateMany(
    { tenantId, projectId, environment, followEnvironment: true, isActive: true },
    { $set: { deploymentId: newDeploymentId } },
  );
  return result.modifiedCount;
}

// =============================================================================
// WIDGET CONFIG
// =============================================================================

export async function findWidgetConfig(
  projectId: string,
  tenantId: string,
): Promise<WidgetConfigDoc | null> {
  const { WidgetConfig } = await import('@agent-platform/database/models');
  const doc = await WidgetConfig.findOne({ projectId, tenantId }).lean();
  return doc ? (normalizeId(doc) as WidgetConfigDoc) : null;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Normalize Mongo _id → id */
function normalizeId<T extends Record<string, unknown>>(doc: T): T & { id: string } {
  const result = { ...doc } as any;
  if (result._id && !result.id) result.id = String(result._id);
  return result;
}

/** Parse a raw SDK channel document into SDKChannelDoc */
function parseChannelDoc(doc: any): SDKChannelDoc {
  const result = normalizeId(doc);
  delete result.authProfileId;
  if (typeof result.config === 'string') {
    try {
      result.config = JSON.parse(result.config);
    } catch {
      /* keep as-is */
    }
  }
  return result as SDKChannelDoc;
}

function normalizeConfigUpdateValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function projectBelongsToTenant(projectId: string, tenantId: string): Promise<boolean> {
  return !!(await findProjectByIdAndTenant(projectId, tenantId));
}

async function assertProjectBelongsToTenant(projectId: string, tenantId: string): Promise<void> {
  if (!(await projectBelongsToTenant(projectId, tenantId))) {
    throw new SDKChannelProjectScopeError();
  }
}

async function assertPublicApiKeyBelongsToProject(
  publicApiKeyId: string,
  projectId: string,
): Promise<void> {
  const { PublicApiKey } = await import('@agent-platform/database/models');
  const key = await PublicApiKey.findOne({ _id: publicApiKeyId, projectId }, { _id: 1 }).lean();
  if (!key) {
    throw new SDKChannelPublicApiKeyScopeError();
  }
}
