import { refreshPersistedStudioProjectAgentDraftMetadata } from '@/lib/abl/project-agent-draft-metadata';

export interface ProjectConfigDraftInvalidationInput {
  projectId: string;
  tenantId: string;
}

export async function refreshProjectAgentDraftMetadataForConfigMutation(
  input: ProjectConfigDraftInvalidationInput,
): Promise<void> {
  await refreshPersistedStudioProjectAgentDraftMetadata({
    projectId: input.projectId,
    tenantId: input.tenantId,
  });
}
