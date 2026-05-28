/**
 * Compliance Repository
 *
 * MongoDB repository for subscription and deletion request operations.
 */

import { ensureDb } from '@/lib/ensure-db';

// ─── Subscription ────────────────────────────────────────────────────────

/**
 * Find a subscription matching the given criteria.
 * Returns the first matching subscription or null.
 */
export async function findSubscription(where: any): Promise<any | null> {
  await ensureDb();
  const { Subscription } = await import('@agent-platform/database/models');

  // Convert where clause to MongoDB filter
  const filter: any = {};
  if (where.organizationId) filter.organizationId = where.organizationId;
  if (where.tenantId) filter.tenantId = where.tenantId;
  if (where.status) filter.status = where.status;
  if (where.planTier) filter.planTier = where.planTier;

  const result = await Subscription.findOne(filter).sort({ createdAt: -1 }).lean();

  // Map MongoDB _id to id
  if (result) {
    return { ...result, id: result._id };
  }
  return null;
}

// ─── DeletionRequest ─────────────────────────────────────────────────────

/**
 * Find deletion requests matching the given criteria.
 */
export async function findDeletionRequests(where: any): Promise<any[]> {
  await ensureDb();
  const { DeletionRequest } = await import('@agent-platform/database/models');

  // Convert where clause to MongoDB filter
  const filter: any = {};
  if (where.tenantId) filter.tenantId = where.tenantId;
  if (where.requestedBy) filter.requestedBy = where.requestedBy;
  if (where.subjectId) filter.subjectId = where.subjectId;
  if (where.status) {
    if (typeof where.status === 'object' && where.status.in) {
      filter.status = { $in: where.status.in };
    } else {
      filter.status = where.status;
    }
  }

  const results = await DeletionRequest.find(filter).lean();

  // Map MongoDB _id to id
  return results.map((doc: any) => ({
    ...doc,
    id: doc._id,
  }));
}

/**
 * Update a deletion request by ID.
 */
export async function updateDeletionRequest(id: string, tenantId: string, data: any): Promise<any> {
  await ensureDb();
  const { DeletionRequest } = await import('@agent-platform/database/models');

  // Build MongoDB update document
  const updateDoc: any = {};
  if (data.status) updateDoc.status = data.status;
  if (data.escalatedAt !== undefined) updateDoc.escalatedAt = data.escalatedAt;
  if (data.completedAt !== undefined) updateDoc.completedAt = data.completedAt;
  if (data.retryCount !== undefined) {
    // Handle increment operations
    if (typeof data.retryCount === 'object' && data.retryCount.increment) {
      updateDoc.$inc = { retryCount: data.retryCount.increment };
      delete updateDoc.retryCount;
    } else {
      updateDoc.retryCount = data.retryCount;
    }
  }

  const result = await DeletionRequest.findOneAndUpdate(
    { _id: id, tenantId },
    updateDoc.$inc ? updateDoc : { $set: updateDoc },
    { new: true },
  ).lean();

  if (!result) return null;

  // Map MongoDB _id to id
  return { ...result, id: result._id };
}
