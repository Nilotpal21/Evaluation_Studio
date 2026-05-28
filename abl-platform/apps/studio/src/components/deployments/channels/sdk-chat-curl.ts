/**
 * Builds the JSON payload for the SDK API chat curl example shown in OverviewTab.
 * Extracted for testability and reuse.
 */
export function buildSdkChatExamplePayload(opts: {
  projectId: string;
  deploymentId?: string | null;
  environment?: string | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    projectId: opts.projectId,
    message: 'Hello from my backend',
    sessionId: 'optional-existing-session-id',
    metadata: {
      customerId: 'customer-123',
      source: 'backend',
    },
    interactionContext: {
      locale: 'en-US',
      timezone: 'America/New_York',
    },
  };

  if (opts.deploymentId) {
    payload.deploymentId = opts.deploymentId;
  } else if (opts.environment) {
    payload.environment = opts.environment;
  }

  return payload;
}
