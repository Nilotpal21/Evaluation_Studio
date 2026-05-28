/**
 * Credential Repository
 *
 * MongoDB data access layer for LLMCredential and TenantModel entities.
 */

import { ensureDb } from '@/lib/ensure-db';

// ─── Type Helpers ────────────────────────────────────────────────────────

function normalizeId(doc: any): any {
  if (!doc) return doc;
  if (Array.isArray(doc)) return doc.map(normalizeId);
  // Convert Mongoose Document to plain object if needed (preserves decrypted fields)
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  if (plain._id) {
    const { _id, ...rest } = plain;
    return { id: _id, ...rest };
  }
  return plain;
}

// ═════════════════════════════════════════════════════════════════════════
// LLM CREDENTIAL
// ═════════════════════════════════════════════════════════════════════════

export async function findLLMCredentials(where?: {
  credentialScope?: 'user' | 'tenant';
  ownerId?: string;
  tenantId?: string;
  provider?: string;
  isActive?: boolean;
}): Promise<any[]> {
  await ensureDb();
  const { LLMCredential } = await import('@agent-platform/database/models');
  const filter: any = {};
  if (where?.credentialScope) filter.credentialScope = where.credentialScope;
  if (where?.ownerId) filter.ownerId = where.ownerId;
  if (where?.tenantId) filter.tenantId = where.tenantId;
  if (where?.provider) filter.provider = where.provider;
  if (where?.isActive !== undefined) filter.isActive = where.isActive;

  // No .lean() — encryption plugin decrypts encryptedApiKey in post-find hook
  const docs = await LLMCredential.find(filter).sort({ createdAt: -1 });
  return normalizeId(docs);
}

export async function findLLMCredentialById(id: string, tenantId: string): Promise<any | null> {
  await ensureDb();
  const { LLMCredential } = await import('@agent-platform/database/models');
  // No .lean() — encryption plugin decrypts encryptedApiKey in post-find hook
  const doc = await LLMCredential.findOne({ _id: id, tenantId });
  return normalizeId(doc);
}

export async function createLLMCredential(data: {
  tenantId: string;
  credentialScope: 'user' | 'tenant';
  ownerId: string;
  provider: string;
  name: string;
  encryptedApiKey: string;
  encryptedEndpoint?: string | null;
  customHeaders?: Record<string, string> | null;
  authType?: string;
  authConfig?: any;
  isActive?: boolean;
  isDefault?: boolean;
}): Promise<any> {
  await ensureDb();
  const { LLMCredential } = await import('@agent-platform/database/models');
  const doc = await LLMCredential.create({
    tenantId: data.tenantId,
    credentialScope: data.credentialScope,
    ownerId: data.ownerId,
    provider: data.provider,
    name: data.name,
    encryptedApiKey: data.encryptedApiKey,
    encryptedEndpoint: data.encryptedEndpoint || null,
    customHeaders: data.customHeaders || null,
    authType: data.authType || 'api_key',
    authConfig: data.authConfig || {},
    isActive: data.isActive !== undefined ? data.isActive : true,
    isDefault: data.isDefault || false,
    lastUsedAt: null,
    lastValidatedAt: null,
  });
  return normalizeId(doc.toObject());
}

export async function updateLLMCredential(
  id: string,
  tenantId: string,
  data: {
    name?: string;
    encryptedApiKey?: string;
    encryptedEndpoint?: string | null;
    authType?: string;
    authConfig?: any;
    isActive?: boolean;
    isDefault?: boolean;
    customHeaders?: Record<string, string> | null;
    lastUsedAt?: Date;
    lastValidatedAt?: Date;
  },
): Promise<any> {
  await ensureDb();
  const { LLMCredential } = await import('@agent-platform/database/models');
  // Use findOne + .save() so the encryption plugin's pre-save hook fires
  // and properly encrypts any plaintext values in encryptedApiKey/encryptedEndpoint.
  const doc = await LLMCredential.findOne({ _id: id, tenantId });
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) (doc as any)[key] = value;
  }
  await doc.save();
  return normalizeId(doc.toObject());
}

export async function deleteLLMCredential(id: string, tenantId: string): Promise<void> {
  await ensureDb();
  const { LLMCredential } = await import('@agent-platform/database/models');
  await LLMCredential.findOneAndDelete({ _id: id, tenantId });
}

/**
 * Find all tenant models that have a connection referencing this credential.
 * Returns model id, displayName, and provider for impact display.
 */
export async function findModelsUsingCredential(
  credentialId: string,
  tenantId: string,
): Promise<{ modelId: string; displayName: string; provider: string | null }[]> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');
  const models = await TenantModel.find(
    { tenantId, 'connections.credentialId': credentialId },
    { _id: 1, displayName: 1, provider: 1 },
  ).lean();
  return models.map((m: any) => ({
    modelId: typeof m._id === 'object' ? m._id.toString() : m._id,
    displayName: m.displayName,
    provider: m.provider,
  }));
}

/**
 * Remove all connection subdocuments that reference this credential
 * from any tenant model in the given tenant.
 */
export async function removeConnectionsByCredential(
  credentialId: string,
  tenantId: string,
): Promise<number> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');
  const result = await TenantModel.updateMany(
    { tenantId, 'connections.credentialId': credentialId },
    { $pull: { connections: { credentialId } } },
  );
  return result.modifiedCount;
}

// ═════════════════════════════════════════════════════════════════════════
// TENANT MODEL
// ═════════════════════════════════════════════════════════════════════════

export async function findTenantModels(
  where?: {
    tenantId?: string;
    provider?: string;
    integrationType?: string;
    isActive?: boolean;
    tier?: string;
  },
  opts?: {
    orderBy?: { field: string; direction: 'asc' | 'desc' };
    include?: { connections?: boolean };
  },
): Promise<any[]> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');
  const filter: any = {};
  if (where?.tenantId) filter.tenantId = where.tenantId;
  if (where?.provider) filter.provider = where.provider;
  if (where?.integrationType) filter.integrationType = where.integrationType;
  if (where?.isActive !== undefined) filter.isActive = where.isActive;
  if (where?.tier) filter.tier = where.tier;

  let query = TenantModel.find(filter);

  if (opts?.orderBy) {
    const sortDir = opts.orderBy.direction === 'asc' ? 1 : -1;
    query = query.sort({ [opts.orderBy.field]: sortDir });
  } else {
    query = query.sort({ createdAt: -1 });
  }

  const docs = await query.lean();
  return normalizeId(docs);
}

export async function findTenantModelById(
  id: string,
  tenantId: string,
  opts?: { include?: { connections?: boolean } },
): Promise<any | null> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = await TenantModel.findOne({ _id: id, tenantId }).lean();
  return normalizeId(doc);
}

export async function createTenantModel(data: {
  tenantId: string;
  displayName: string;
  integrationType: string;
  modelId?: string | null;
  provider?: string | null;
  providerStructure?: string | null;
  requestTemplate?: any;
  responseMapping?: any;
  gatewayConfig?: any;
  temperature?: number;
  maxTokens?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  supportsStructured?: boolean;
  tier?: string;
  isDefault?: boolean;
  isActive?: boolean;
  inferenceEnabled?: boolean;
  createdBy: string;
}): Promise<any> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = await TenantModel.create({
    tenantId: data.tenantId,
    displayName: data.displayName,
    integrationType: data.integrationType,
    modelId: data.modelId || null,
    provider: data.provider || null,
    providerStructure: data.providerStructure || null,
    requestTemplate: data.requestTemplate || {},
    responseMapping: data.responseMapping || {},
    gatewayConfig: data.gatewayConfig || {},
    temperature: data.temperature !== undefined ? data.temperature : 0.7,
    maxTokens: data.maxTokens !== undefined ? data.maxTokens : 4096,
    supportsTools: data.supportsTools !== undefined ? data.supportsTools : true,
    supportsStreaming: data.supportsStreaming !== undefined ? data.supportsStreaming : true,
    supportsVision: data.supportsVision !== undefined ? data.supportsVision : false,
    supportsStructured: data.supportsStructured !== undefined ? data.supportsStructured : true,
    tier: data.tier || 'standard',
    isDefault: data.isDefault || false,
    isActive: data.isActive !== undefined ? data.isActive : true,
    inferenceEnabled: data.inferenceEnabled !== undefined ? data.inferenceEnabled : true,
    createdBy: data.createdBy,
    connections: [],
  });
  return normalizeId(doc.toObject());
}

export async function updateTenantModel(
  id: string,
  tenantId: string,
  data: {
    displayName?: string;
    modelId?: string | null;
    provider?: string | null;
    providerStructure?: string | null;
    requestTemplate?: any;
    responseMapping?: any;
    gatewayConfig?: any;
    temperature?: number;
    maxTokens?: number;
    supportsTools?: boolean;
    supportsStreaming?: boolean;
    supportsVision?: boolean;
    supportsStructured?: boolean;
    tier?: string;
    isDefault?: boolean;
    isActive?: boolean;
    inferenceEnabled?: boolean;
  },
): Promise<any> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = await TenantModel.findOneAndUpdate(
    { _id: id, tenantId },
    { $set: data },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

export async function deleteTenantModel(id: string, tenantId: string): Promise<void> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');
  await TenantModel.findOneAndDelete({ _id: id, tenantId });
}

// ─── Tenant Model Connection Operations ──────────────────────────────────

export async function addTenantModelConnection(
  tenantModelId: string,
  tenantId: string,
  connection: {
    credentialId: string;
    connectionType?: string;
    isActive?: boolean;
    isPrimary?: boolean;
    createdBy: string;
  },
): Promise<any> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');
  const { uuidv7 } = await import('@agent-platform/database/mongo');

  const now = new Date();
  const connectionId = uuidv7();

  await TenantModel.updateOne(
    { _id: tenantModelId, tenantId },
    {
      $push: {
        connections: {
          id: connectionId,
          credentialId: connection.credentialId,
          connectionType: connection.connectionType || 'http',
          isActive: connection.isActive !== undefined ? connection.isActive : true,
          isPrimary: connection.isPrimary || false,
          createdBy: connection.createdBy,
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  );

  const updated = await TenantModel.findOne({ _id: tenantModelId, tenantId }).lean();
  const addedConnection = updated?.connections?.find((c: any) => c.id === connectionId);
  return addedConnection ? normalizeId(addedConnection) : null;
}

export async function updateTenantModelConnection(
  tenantModelId: string,
  tenantId: string,
  connectionId: string,
  data: {
    credentialId?: string;
    isActive?: boolean;
    isPrimary?: boolean;
  },
): Promise<any> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');

  const updateFields: any = { 'connections.$.updatedAt': new Date() };
  if (data.credentialId !== undefined) {
    updateFields['connections.$.credentialId'] = data.credentialId;
  }
  if (data.isActive !== undefined) {
    updateFields['connections.$.isActive'] = data.isActive;
  }
  if (data.isPrimary !== undefined) {
    updateFields['connections.$.isPrimary'] = data.isPrimary;
  }

  await TenantModel.updateOne(
    { _id: tenantModelId, tenantId, 'connections.id': connectionId },
    { $set: updateFields },
  );

  const updated = await TenantModel.findOne({ _id: tenantModelId, tenantId }).lean();
  const connection = updated?.connections?.find((c: any) => c.id === connectionId);
  return connection ? normalizeId(connection) : null;
}

export async function deleteTenantModelConnection(
  tenantModelId: string,
  tenantId: string,
  connectionId: string,
): Promise<void> {
  await ensureDb();
  const { TenantModel } = await import('@agent-platform/database/models');
  await TenantModel.updateOne(
    { _id: tenantModelId, tenantId },
    { $pull: { connections: { id: connectionId } } },
  );
}
