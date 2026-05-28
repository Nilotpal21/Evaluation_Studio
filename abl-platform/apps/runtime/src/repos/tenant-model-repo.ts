/**
 * Tenant Model Repository
 *
 * MongoDB tenant model, model connection, and service instance operations.
 * Used by: routes/tenant-models.ts, routes/tenant-service-instances.ts,
 *          services/llm/model-resolution.ts, services/llm/session-llm-client.ts
 */

import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform';

const repoLog = createLogger('tenant-model-repo');

interface TenantScopedConnectionLookupOptions {
  select?: Record<string, boolean>;
  tenantId: string;
}

interface CreateTenantModelConnectionInput {
  tenantModelId: string;
  tenantId: string;
  credentialId: string;
  connectionType?: string;
  isActive?: boolean;
  isPrimary?: boolean;
  createdBy?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Normalize _id → id on lean Mongoose documents */
function normalizeId<T extends Record<string, any>>(doc: T | null): T | null {
  if (!doc) return null;
  if (doc._id != null && doc.id == null) {
    (doc as any).id = typeof doc._id === 'object' ? doc._id.toString() : doc._id;
  }
  return doc;
}

function normalizeIds<T extends Record<string, any>>(docs: T[]): T[] {
  return docs.map((d) => normalizeId(d)!);
}

function requireTenantScope(tenantId: string | undefined): string {
  if (!tenantId) {
    throw new Error('tenantId is required for tenant-scoped queries');
  }
  return tenantId;
}

// ─── Tenant Models ────────────────────────────────────────────────────────

export async function findTenantModel(id: string, tenantId: string): Promise<any | null> {
  const scopedTenantId = requireTenantScope(tenantId);
  const { TenantModel } = await import('@agent-platform/database/models');
  return normalizeId(await TenantModel.findOne({ _id: id, tenantId: scopedTenantId }).lean());
}

export async function findTenantModelWithConnections(
  id: string,
  tenantId: string,
): Promise<any | null> {
  const scopedTenantId = requireTenantScope(tenantId);
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = normalizeId(await TenantModel.findOne({ _id: id, tenantId: scopedTenantId }).lean());
  if (!doc) return null;
  // Connections are embedded subdocuments — already included in the document
  return { ...doc, _count: { projectBindings: 0 } };
}

export async function findTenantModelAdmin(id: string): Promise<any | null> {
  const { TenantModel } = await import('@agent-platform/database/models');
  return normalizeId(await TenantModel.findOne({ _id: id }).lean());
}

export async function findTenantModelWithConnectionsAdmin(id: string): Promise<any | null> {
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = normalizeId(await TenantModel.findOne({ _id: id }).lean());
  if (!doc) return null;
  return { ...doc, _count: { projectBindings: 0 } };
}

export async function listTenantModels(
  where: Record<string, unknown>,
  opts?: { select?: Record<string, boolean>; skip?: number; take?: number },
): Promise<any[]> {
  const { TenantModel } = await import('@agent-platform/database/models');
  let query = TenantModel.find(where);
  if (opts?.select) {
    const projection: Record<string, 1> = {};
    for (const k of Object.keys(opts.select)) projection[k] = 1;
    query = query.select(projection);
  }
  query = query.sort({ createdAt: -1 });
  if (opts?.skip) query = query.skip(opts.skip);
  if (opts?.take) query = query.limit(opts.take);
  return normalizeIds(await query.lean());
}

export async function countTenantModels(where: Record<string, unknown>): Promise<number> {
  const { TenantModel } = await import('@agent-platform/database/models');
  return TenantModel.countDocuments(where);
}

export async function createTenantModel(data: Record<string, unknown>): Promise<any> {
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = await TenantModel.create(data);
  return normalizeId(doc.toObject());
}

export async function updateTenantModel(
  id: string,
  data: Record<string, unknown>,
  tenantId: string,
): Promise<any> {
  const scopedTenantId = requireTenantScope(tenantId);
  const { TenantModel } = await import('@agent-platform/database/models');
  return normalizeId(
    await TenantModel.findOneAndUpdate(
      { _id: id, tenantId: scopedTenantId },
      { $set: data },
      { new: true },
    ).lean(),
  );
}

export async function updateTenantModelAdmin(
  id: string,
  data: Record<string, unknown>,
): Promise<any> {
  const { TenantModel } = await import('@agent-platform/database/models');
  return normalizeId(
    await TenantModel.findOneAndUpdate({ _id: id }, { $set: data }, { new: true }).lean(),
  );
}

export async function deleteTenantModel(id: string, tenantId: string): Promise<boolean> {
  const { TenantModel } = await import('@agent-platform/database/models');
  const result = await TenantModel.deleteOne({ _id: id, tenantId });
  return result.deletedCount > 0;
}

export async function updateTenantModelInference(
  id: string,
  tenantId: string,
  inferenceEnabled: boolean,
): Promise<void> {
  const { TenantModel } = await import('@agent-platform/database/models');
  await TenantModel.updateOne({ _id: id, tenantId }, { $set: { inferenceEnabled } });
}

// ─── Tenant Model Connections ─────────────────────────────────────────────

export async function findTenantModelConnections(
  tenantModelId: string,
  opts: TenantScopedConnectionLookupOptions,
): Promise<any[]> {
  const scopedTenantId = requireTenantScope(opts.tenantId);
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = await TenantModel.findOne(
    { _id: tenantModelId, tenantId: scopedTenantId },
    { connections: 1 },
  ).lean();
  const connections = doc?.connections ?? [];
  if (opts.select) {
    const keys = Object.keys(opts.select);
    return connections.map((c: any) => {
      const picked: Record<string, unknown> = {};
      for (const k of keys) picked[k] = c[k];
      return picked;
    });
  }
  // Sort by createdAt descending to match expected behavior
  return [...connections].sort(
    (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export async function createTenantModelConnection(
  data: CreateTenantModelConnectionInput,
): Promise<any> {
  const scopedTenantId = requireTenantScope(data.tenantId);
  const { TenantModel } = await import('@agent-platform/database/models');
  const { uuidv7 } = await import('@agent-platform/database/mongo');
  const now = new Date();
  const connectionData = {
    id: uuidv7(),
    credentialId: data.credentialId,
    connectionType: data.connectionType || 'http',
    isActive: data.isActive ?? true,
    isPrimary: data.isPrimary ?? false,
    createdBy: data.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  const updated = await TenantModel.findOneAndUpdate(
    { _id: data.tenantModelId, tenantId: scopedTenantId },
    { $push: { connections: connectionData } },
    { new: true },
  ).lean();
  if (!updated)
    throw new AppError(`TenantModel ${data.tenantModelId} not found`, { ...ErrorCodes.NOT_FOUND });
  // Return the newly pushed connection (last element)
  return updated.connections[updated.connections.length - 1];
}

export async function findTenantModelConnectionById(
  id: string,
  tenantId: string,
): Promise<any | null> {
  const scopedTenantId = requireTenantScope(tenantId);
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = await TenantModel.findOne(
    { 'connections.id': id, tenantId: scopedTenantId },
    { 'connections.$': 1 },
  ).lean();
  const conn = doc?.connections?.[0] ?? null;
  if (!conn || !doc) return null;
  // Attach parent model ID so route-level ownership checks can verify
  const modelId =
    typeof doc._id === 'object' ? (doc._id as { toString(): string }).toString() : doc._id;
  return { ...conn, tenantModelId: modelId };
}

export async function updateTenantModelConnection(
  id: string,
  data: Record<string, unknown>,
  tenantId: string,
): Promise<any> {
  const scopedTenantId = requireTenantScope(tenantId);
  const { TenantModel } = await import('@agent-platform/database/models');
  // Build $set with positional operator for each field
  const setFields: Record<string, unknown> = { 'connections.$.updatedAt': new Date() };
  for (const [k, v] of Object.entries(data)) {
    setFields[`connections.$.${k}`] = v;
  }
  const updated = await TenantModel.findOneAndUpdate(
    { 'connections.id': id, tenantId: scopedTenantId },
    { $set: setFields },
    { new: true },
  ).lean();
  return updated?.connections?.find((c: any) => c.id === id) ?? null;
}

export async function deleteTenantModelConnection(id: string, tenantId: string): Promise<void> {
  const scopedTenantId = requireTenantScope(tenantId);
  const { TenantModel } = await import('@agent-platform/database/models');
  await TenantModel.updateOne(
    { 'connections.id': id, tenantId: scopedTenantId },
    { $pull: { connections: { id } } },
  );
}

export async function setConnectionPrimary(
  tenantModelId: string,
  connectionId: string,
  tenantId: string,
): Promise<void> {
  const scopedTenantId = requireTenantScope(tenantId);
  const { TenantModel } = await import('@agent-platform/database/models');
  // Load the document, toggle isPrimary on connections, and save
  const doc = await TenantModel.findOne({ _id: tenantModelId, tenantId: scopedTenantId });
  if (!doc)
    throw new AppError(`TenantModel ${tenantModelId} not found`, { ...ErrorCodes.NOT_FOUND });
  for (const conn of doc.connections) {
    (conn as any).isPrimary = conn.id === connectionId;
  }
  await doc.save();
}

// ─── Impact Analysis ──────────────────────────────────────────────────────

export async function findProjectsUsingTenantModel(
  tenantModelId: string,
  tenantId: string,
): Promise<{ projectId: string; projectName: string; tier: string }[]> {
  const { ModelConfig } = await import('@agent-platform/database/models');
  const { Project } = await import('@agent-platform/database/models');

  // Find all model configs that reference this tenant model within the tenant scope.
  const configs = await ModelConfig.find(
    { tenantId, tenantModelId },
    { projectId: 1, tier: 1 },
  ).lean();

  if (configs.length === 0) return [];

  // Get unique project IDs
  const projectIds = [...new Set(configs.map((c: any) => c.projectId))];

  // Fetch projects (filtered by tenantId for isolation)
  const projects = await Project.find(
    { _id: { $in: projectIds }, tenantId },
    { _id: 1, name: 1 },
  ).lean();

  const projectMap = new Map(projects.map((p: any) => [p._id, p.name]));

  // Build results — only include projects belonging to this tenant
  const results: { projectId: string; projectName: string; tier: string }[] = [];
  for (const config of configs) {
    const name = projectMap.get((config as any).projectId);
    if (name != null) {
      results.push({
        projectId: (config as any).projectId,
        projectName: name as string,
        tier: (config as any).tier ?? 'unknown',
      });
    }
  }

  return results;
}

// ─── Tenant Service Instances ─────────────────────────────────────────────

export async function findTenantServiceInstance(id: string, tenantId: string): Promise<any | null> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped queries');
  const { TenantServiceInstance } = await import('@agent-platform/database/models');
  return normalizeId(await TenantServiceInstance.findOne({ _id: id, tenantId }).lean());
}

export async function listTenantServiceInstances(
  where: Record<string, unknown>,
  opts?: { select?: Record<string, boolean> },
): Promise<any[]> {
  const { TenantServiceInstance } = await import('@agent-platform/database/models');
  let query = TenantServiceInstance.find(where);
  if (opts?.select) {
    const projection: Record<string, 1> = {};
    for (const k of Object.keys(opts.select)) projection[k] = 1;
    query = query.select(projection);
  }
  return normalizeIds(await query.sort({ createdAt: -1 }).lean());
}

export async function createTenantServiceInstance(data: Record<string, unknown>): Promise<any> {
  const { TenantServiceInstance } = await import('@agent-platform/database/models');
  const doc = new TenantServiceInstance(data);
  await doc.save();
  return normalizeId(doc.toObject());
}

export async function updateTenantServiceInstance(
  id: string,
  data: Record<string, unknown>,
  tenantId: string,
): Promise<any> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped queries');
  const { TenantServiceInstance } = await import('@agent-platform/database/models');
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  const filter: Record<string, unknown> = { _id: id, tenantId };
  const doc = await TenantServiceInstance.findOne(filter);
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalizeId(doc.toObject());
}

export async function deleteTenantServiceInstance(id: string, tenantId: string): Promise<void> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped queries');
  const { TenantServiceInstance } = await import('@agent-platform/database/models');
  await TenantServiceInstance.deleteOne({ _id: id, tenantId });
}

// ─── LLM Credentials ─────────────────────────────────────────────────────

export async function findLLMCredential(id: string, tenantId: string): Promise<any | null> {
  const { LLMCredential } = await import('@agent-platform/database/models');
  const scopedTenantId = requireTenantScope(tenantId);
  // NOTE: No .lean() — the encryption plugin's post-find hook needs the full Mongoose document
  // to decrypt encryptedApiKey. With .lean() the hook is skipped and encrypted blobs are returned.
  const doc = await LLMCredential.findOne({ _id: id, tenantId: scopedTenantId });
  return doc ? normalizeId(doc.toObject()) : null;
}

// ─── Tenant (for LLM policy) ─────────────────────────────────────────────
// CROSS-TENANT: Tenant is a top-level entity lookup. No tenantId filter needed.

export async function findTenant(id: string): Promise<any | null> {
  const { Tenant } = await import('@agent-platform/database/models');
  return normalizeId(await Tenant.findOne({ _id: id }).lean());
}
