import {
  getChangeManifestEntry,
  resolveChangeEnforcementMode,
  resolveCurrentChangeEnvironment,
  type ChangeEnforcementMode,
  type ChangeEnvironment,
  type ServiceChangeRequirement,
} from '@agent-platform/database';

const SEARCH_AI_REQUIRED_CHANGE_IDS = ['seed.platform-core'] as const;
const SEARCH_AI_OPTIONAL_CHANGE_IDS = [] as const;

function assertManifestEntries(changeIds: readonly string[]): void {
  const missingChangeIds = changeIds.filter((changeId) => !getChangeManifestEntry(changeId));
  if (missingChangeIds.length > 0) {
    throw new Error(
      `SearchAI change requirements reference unknown manifest entries: ${missingChangeIds.join(', ')}`,
    );
  }
}

assertManifestEntries([...SEARCH_AI_REQUIRED_CHANGE_IDS, ...SEARCH_AI_OPTIONAL_CHANGE_IDS]);

export interface SearchAiChangeRequirementOptions {
  environment?: ChangeEnvironment;
  enforcementMode?: ChangeEnforcementMode;
}

export function getSearchAiChangeRequirement(
  options: SearchAiChangeRequirementOptions = {},
): ServiceChangeRequirement {
  return {
    service: 'search-ai',
    environment: options.environment ?? resolveCurrentChangeEnvironment(),
    enforcementMode: options.enforcementMode ?? resolveChangeEnforcementMode(),
    requiredChangeIds: [...SEARCH_AI_REQUIRED_CHANGE_IDS],
    optionalChangeIds: [...SEARCH_AI_OPTIONAL_CHANGE_IDS],
    notes:
      'SearchAI phase-1 readiness gates only the deploy-owned platform-core seed until ClickHouse/script cutover lands in later phases.',
  };
}
