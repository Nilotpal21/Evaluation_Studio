import { ModelConfig, Project } from '@agent-platform/database/models';

export async function loadConfig(configId: string, projectId: string, tenantId: string) {
  const project = await Project.findOne({ _id: projectId, tenantId }).lean();
  if (!project) {
    return null;
  }

  return ModelConfig.findOne({ _id: configId }).lean();
}
