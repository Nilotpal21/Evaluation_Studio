import { refreshPersistedStudioProjectAgentDraftMetadata } from '@/lib/abl/project-agent-draft-metadata';

export interface ProjectMcpDraftInvalidationInput {
  projectId: string;
  tenantId: string;
}

export async function refreshProjectAgentDraftMetadataForMcpServerMutation(
  input: ProjectMcpDraftInvalidationInput,
): Promise<void> {
  await refreshPersistedStudioProjectAgentDraftMetadata({
    projectId: input.projectId,
    tenantId: input.tenantId,
  });
}
