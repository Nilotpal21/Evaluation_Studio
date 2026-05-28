interface AuthProfileConsumerDependencyFilterParams {
  type: string;
  profileId: string;
  tenantId: string;
  field?: string;
  filter?: Record<string, unknown>;
}

export function buildAuthProfileConsumerDependencyFilter(
  params: AuthProfileConsumerDependencyFilterParams,
): Record<string, unknown> {
  const match: Record<string, unknown> = {
    [params.field ?? 'authProfileId']: params.profileId,
    ...(params.filter ?? {}),
  };

  // ServiceNode is isolated through project ownership and does not persist tenantId.
  if (params.type !== 'ServiceNode') {
    match.tenantId = params.tenantId;
  }

  return match;
}
