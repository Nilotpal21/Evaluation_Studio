export const HELIX_REPO_NATIVE_TOOLS = [
  'helix_find_symbol',
  'helix_find_references',
  'helix_get_route_info',
  'helix_get_schema_info',
  'helix_get_impacted_tests',
] as const;

export const HELIX_DELIVERY_NATIVE_TOOLS = ['studio_video_evidence', 'jira_update'] as const;

export function withHelixRepoNativeTools(tools: string[]): string[] {
  return [...new Set([...tools, ...HELIX_REPO_NATIVE_TOOLS])];
}

export function withHelixDeliveryNativeTools(tools: string[]): string[] {
  return [...new Set([...tools, ...HELIX_DELIVERY_NATIVE_TOOLS])];
}
