/**
 * Namespace Repository
 *
 * MongoDB operations for variable namespaces (organizational grouping for env/config variables).
 * Used by: routes/namespaces.ts
 */

export async function createVariableNamespace(data: {
  tenantId: string;
  projectId: string;
  name: string;
  displayName: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  order?: number;
  isDefault?: boolean;
  createdBy: string;
}): Promise<any> {
  const { VariableNamespace } = await import('@agent-platform/database/models');
  const doc = await VariableNamespace.create(data);
  return doc.toObject();
}

export async function findVariableNamespaces(tenantId: string, projectId: string): Promise<any[]> {
  const { VariableNamespace } = await import('@agent-platform/database/models');
  return VariableNamespace.find({ tenantId, projectId }).sort({ order: 1 }).lean();
}

export async function findVariableNamespaceById(id: string, tenantId: string): Promise<any | null> {
  const { VariableNamespace } = await import('@agent-platform/database/models');
  return VariableNamespace.findOne({ _id: id, tenantId }).lean();
}

export async function findDefaultVariableNamespace(
  tenantId: string,
  projectId: string,
): Promise<any | null> {
  const { VariableNamespace } = await import('@agent-platform/database/models');
  return VariableNamespace.findOne({ tenantId, projectId, isDefault: true }).lean();
}

/**
 * Get the default namespace for a project, creating it if it doesn't exist.
 * This ensures every project always has a default namespace available.
 */
export async function getOrCreateDefaultNamespace(
  tenantId: string,
  projectId: string,
  createdBy: string,
): Promise<any> {
  const existing = await findDefaultVariableNamespace(tenantId, projectId);
  if (existing) return existing;

  return createVariableNamespace({
    tenantId,
    projectId,
    name: 'default',
    displayName: 'Default',
    description: 'Default variable namespace',
    isDefault: true,
    order: 0,
    createdBy,
  });
}

export async function updateVariableNamespace(
  id: string,
  tenantId: string,
  data: Partial<{
    displayName: string;
    description: string | null;
    icon: string | null;
    color: string | null;
    updatedBy: string;
  }>,
): Promise<any | null> {
  const { VariableNamespace } = await import('@agent-platform/database/models');
  const doc = await VariableNamespace.findOneAndUpdate(
    { _id: id, tenantId },
    { $set: data },
    { new: true, runValidators: true },
  ).lean();
  return doc;
}

export async function deleteVariableNamespace(id: string, tenantId: string): Promise<void> {
  const { VariableNamespace } = await import('@agent-platform/database/models');
  await VariableNamespace.deleteOne({ _id: id, tenantId });
}

export async function countVariableNamespaces(
  tenantId: string,
  projectId: string,
): Promise<number> {
  const { VariableNamespace } = await import('@agent-platform/database/models');
  return VariableNamespace.countDocuments({ tenantId, projectId });
}

export async function reorderVariableNamespaces(
  tenantId: string,
  projectId: string,
  order: Array<{ namespaceId: string; order: number }>,
): Promise<void> {
  const { VariableNamespace } = await import('@agent-platform/database/models');

  const bulkOps = order.map((item) => ({
    updateOne: {
      filter: { _id: item.namespaceId, tenantId, projectId },
      update: { $set: { order: item.order } },
    },
  }));

  if (bulkOps.length > 0) {
    await VariableNamespace.bulkWrite(bulkOps);
  }
}

export async function getVariableNamespaceMemberCounts(
  tenantId: string,
  projectId: string,
  variableNamespaceIds: string[],
): Promise<Record<string, { env: number; config: number }>> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');

  const pipeline = [
    {
      $match: {
        tenantId,
        projectId,
        namespaceId: { $in: variableNamespaceIds },
      },
    },
    {
      $group: {
        _id: { namespaceId: '$namespaceId', variableType: '$variableType' },
        count: { $sum: 1 },
      },
    },
  ];

  const results = await VariableNamespaceMembership.aggregate(pipeline);

  const counts: Record<string, { env: number; config: number }> = {};

  // Initialize all variableNamespaceIds with zero counts
  for (const nsId of variableNamespaceIds) {
    counts[nsId] = { env: 0, config: 0 };
  }

  // Fill in actual counts from aggregation
  for (const result of results) {
    const nsId = result._id.namespaceId;
    const varType = result._id.variableType as 'env' | 'config';
    if (counts[nsId]) {
      counts[nsId][varType] = result.count;
    }
  }

  return counts;
}
