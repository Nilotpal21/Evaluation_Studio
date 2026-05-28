/**
 * Service Node Repository
 *
 * MongoDB repository for service node operations.
 */

import { ensureDb } from '@/lib/ensure-db';

interface ServiceNodeWhere {
  tenantId: string;
  projectId?: string | { in?: string[] };
  name?: string;
  isActive?: boolean;
}

function buildServiceNodeFilter(where: ServiceNodeWhere): Record<string, unknown> | null {
  if (!where.tenantId) {
    throw new Error('ServiceNode queries require tenantId');
  }

  const filter: Record<string, unknown> = { tenantId: where.tenantId };

  if (typeof where.projectId === 'string') {
    filter.projectId = where.projectId;
  } else if (where.projectId && Array.isArray(where.projectId.in)) {
    if (where.projectId.in.length === 0) {
      return null;
    }
    filter.projectId = { $in: where.projectId.in };
  }

  if (where.name) filter.name = where.name;
  if (where.isActive !== undefined) filter.isActive = where.isActive;

  return filter;
}

// ─── ServiceNode ─────────────────────────────────────────────────────────

/**
 * Find service nodes matching the given criteria.
 */
export async function findServiceNodes(where: ServiceNodeWhere): Promise<any[]> {
  await ensureDb();
  const { ServiceNode } = await import('@agent-platform/database/models');
  const filter = buildServiceNodeFilter(where);
  if (!filter) {
    return [];
  }

  // buildServiceNodeFilter throws if tenantId is missing and seeds it as the
  // first key in the returned object — lint can't see through the helper.
  // eslint-disable-next-line studio-tenant/no-unscoped-mongoose-query
  const results = await ServiceNode.find(filter).sort({ createdAt: -1 }).lean();

  // Map MongoDB _id to id
  return results.map((doc: any) => ({
    ...doc,
    id: doc._id,
  }));
}

/**
 * Create a new service node.
 */
export async function createServiceNode(data: any): Promise<any> {
  await ensureDb();
  const { ServiceNode } = await import('@agent-platform/database/models');

  if (!data.tenantId) {
    throw new Error('ServiceNode writes require tenantId');
  }

  // Build MongoDB document
  const doc: any = {
    tenantId: data.tenantId,
    projectId: data.projectId,
    name: data.name,
    displayName: data.displayName,
    description: data.description || null,
    endpoint: data.endpoint,
    method: data.method,
    authType: data.authType,
    authConfig: data.authConfig ? JSON.parse(data.authConfig) : null,
    inputSchema:
      typeof data.inputSchema === 'string' ? JSON.parse(data.inputSchema) : data.inputSchema,
    outputSchema: data.outputSchema
      ? typeof data.outputSchema === 'string'
        ? JSON.parse(data.outputSchema)
        : data.outputSchema
      : null,
    timeoutMs: data.timeoutMs,
    retryCount: data.retryCount,
    retryDelayMs: data.retryDelayMs,
    rateLimitPerMinute: data.rateLimitPerMinute || null,
    rateLimitPerHour: data.rateLimitPerHour || null,
    circuitBreakerThreshold: data.circuitBreakerThreshold,
    circuitBreakerResetMs: data.circuitBreakerResetMs,
    isActive: data.isActive !== undefined ? data.isActive : true,
  };

  const result = await ServiceNode.create(doc);
  const lean = result.toObject();

  // Map MongoDB _id to id
  return { ...lean, id: lean._id };
}

/**
 * Find a service node by ID, optionally scoped to a projectId.
 */
export async function findServiceNodeById(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<any | null> {
  await ensureDb();
  const { ServiceNode } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) filter.projectId = projectId;
  const result = await ServiceNode.findOne(filter).lean();

  if (!result) return null;

  // Map MongoDB _id to id
  return { ...result, id: result._id };
}

/**
 * Update a service node by ID, scoped to projectId for defense-in-depth.
 */
export async function updateServiceNode(
  id: string,
  tenantId: string,
  projectId: string,
  data: any,
): Promise<any> {
  await ensureDb();
  const { ServiceNode } = await import('@agent-platform/database/models');

  // Build MongoDB update document
  const updateDoc: any = {};
  if (data.displayName) updateDoc.displayName = data.displayName;
  if (data.description !== undefined) updateDoc.description = data.description;
  if (data.endpoint) updateDoc.endpoint = data.endpoint;
  if (data.method) updateDoc.method = data.method;
  if (data.authType) updateDoc.authType = data.authType;
  if (data.authConfig !== undefined) {
    updateDoc.authConfig = data.authConfig ? JSON.parse(data.authConfig) : null;
  }
  if (data.inputSchema) {
    updateDoc.inputSchema =
      typeof data.inputSchema === 'string' ? JSON.parse(data.inputSchema) : data.inputSchema;
  }
  if (data.outputSchema !== undefined) {
    updateDoc.outputSchema = data.outputSchema
      ? typeof data.outputSchema === 'string'
        ? JSON.parse(data.outputSchema)
        : data.outputSchema
      : null;
  }
  if (data.timeoutMs) updateDoc.timeoutMs = data.timeoutMs;
  if (data.retryCount !== undefined) updateDoc.retryCount = data.retryCount;
  if (data.retryDelayMs) updateDoc.retryDelayMs = data.retryDelayMs;
  if (data.rateLimitPerMinute !== undefined) updateDoc.rateLimitPerMinute = data.rateLimitPerMinute;
  if (data.rateLimitPerHour !== undefined) updateDoc.rateLimitPerHour = data.rateLimitPerHour;
  if (data.circuitBreakerThreshold)
    updateDoc.circuitBreakerThreshold = data.circuitBreakerThreshold;
  if (data.circuitBreakerResetMs) updateDoc.circuitBreakerResetMs = data.circuitBreakerResetMs;
  if (data.isActive !== undefined) updateDoc.isActive = data.isActive;

  const result = await ServiceNode.findOneAndUpdate(
    { _id: id, tenantId, projectId },
    { $set: updateDoc },
    { new: true },
  ).lean();

  if (!result) return null;

  // Map MongoDB _id to id
  return { ...result, id: result._id };
}

/**
 * Delete a service node by ID, scoped to projectId for defense-in-depth.
 */
export async function deleteServiceNode(
  id: string,
  tenantId: string,
  projectId: string,
): Promise<any> {
  await ensureDb();
  const { ServiceNode } = await import('@agent-platform/database/models');
  const result = await ServiceNode.findOneAndDelete({ _id: id, tenantId, projectId }).lean();

  if (!result) return null;

  // Map MongoDB _id to id
  return { ...result, id: result._id };
}
