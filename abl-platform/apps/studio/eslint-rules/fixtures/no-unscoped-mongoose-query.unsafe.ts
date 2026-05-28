import { ProjectTool, VariableNamespaceMembership } from '@agent-platform/database/models';

export async function loadMembership(projectId: string, variableId: string) {
  return VariableNamespaceMembership.findOne({
    projectId,
    variableId,
    variableType: 'config',
  }).lean();
}

export async function loadDistinctProviders() {
  return ProjectTool.distinct('toolType', { projectId: 'project-1' });
}

export async function loadAggregateCounts() {
  return ProjectTool.aggregate([
    { $match: { projectId: 'project-1' } },
    { $group: { _id: '$toolType', count: { $sum: 1 } } },
  ]);
}

export async function updateTools() {
  return ProjectTool.bulkWrite([
    {
      updateOne: {
        filter: { projectId: 'project-1', name: 'tool-1' },
        update: { $set: { description: 'Updated' } },
      },
    },
  ]);
}

export async function countEverything() {
  return ProjectTool.estimatedDocumentCount();
}
