import { ProjectTool, VariableNamespaceMembership } from '@agent-platform/database/models';

export async function loadMembership(tenantId: string, projectId: string, variableId: string) {
  return VariableNamespaceMembership.findOne({
    tenantId,
    projectId,
    variableId,
    variableType: 'config',
  }).lean();
}

export async function loadDistinctProviders(tenantId: string) {
  return ProjectTool.distinct('toolType', { tenantId });
}

export async function loadAggregateCounts(tenantId: string) {
  return ProjectTool.aggregate([
    { $match: { tenantId } },
    { $group: { _id: '$toolType', count: { $sum: 1 } } },
  ]);
}

export async function updateTools(tenantId: string) {
  return ProjectTool.bulkWrite([
    {
      updateOne: {
        filter: { tenantId, projectId: 'project-1', name: 'tool-1' },
        update: { $set: { description: 'Updated' } },
      },
    },
  ]);
}
