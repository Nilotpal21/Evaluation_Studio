import { refreshPersistedStudioProjectAgentDraftMetadata } from '@/lib/abl/project-agent-draft-metadata';

export interface ProjectToolDraftInvalidationInput {
  projectId: string;
  tenantId: string;
}

export async function refreshProjectAgentDraftMetadataForToolMutation(
  input: ProjectToolDraftInvalidationInput,
): Promise<void> {
  await refreshPersistedStudioProjectAgentDraftMetadata({
    projectId: input.projectId,
    tenantId: input.tenantId,
  });
}
