/**
 * Canonical ProjectAgent path builder.
 *
 * Agent identity is tenant-scoped via database/runtime filters. The path is a
 * legacy locator and must not embed tenantId or the removed domain segment.
 */
export function buildProjectAgentPath(projectId: string, agentName: string): string {
  const normalizedProjectId = projectId.trim();
  const normalizedAgentName = agentName.trim();

  if (!normalizedProjectId) {
    throw new Error('projectId must be a non-empty string');
  }

  if (!normalizedAgentName) {
    throw new Error('agentName must be a non-empty string');
  }

  return `${normalizedProjectId}/${normalizedAgentName}`;
}
