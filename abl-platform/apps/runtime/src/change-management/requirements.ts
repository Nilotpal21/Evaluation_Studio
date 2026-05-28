import {
  getChangeManifestEntry,
  resolveChangeEnforcementMode,
  resolveCurrentChangeEnvironment,
  type ChangeEnforcementMode,
  type ChangeEnvironment,
  type ServiceChangeRequirement,
} from '@agent-platform/database';

const RUNTIME_REQUIRED_CHANGE_IDS = ['seed.platform-core', 'seed.rbac-tool-permissions'] as const;
const RUNTIME_OPTIONAL_CHANGE_IDS = [] as const;

function assertManifestEntries(changeIds: readonly string[]): void {
  const missingChangeIds = changeIds.filter((changeId) => !getChangeManifestEntry(changeId));
  if (missingChangeIds.length > 0) {
    throw new Error(
      `Runtime change requirements reference unknown manifest entries: ${missingChangeIds.join(', ')}`,
    );
  }
}

assertManifestEntries([...RUNTIME_REQUIRED_CHANGE_IDS, ...RUNTIME_OPTIONAL_CHANGE_IDS]);

export interface RuntimeChangeRequirementOptions {
  environment?: ChangeEnvironment;
  enforcementMode?: ChangeEnforcementMode;
}

export function getRuntimeChangeRequirement(
  options: RuntimeChangeRequirementOptions = {},
): ServiceChangeRequirement {
  return {
    service: 'runtime',
    environment: options.environment ?? resolveCurrentChangeEnvironment(),
    enforcementMode: options.enforcementMode ?? resolveChangeEnforcementMode(),
    requiredChangeIds: [...RUNTIME_REQUIRED_CHANGE_IDS],
    optionalChangeIds: [...RUNTIME_OPTIONAL_CHANGE_IDS],
    notes:
      'Phase 3 gates only deploy-tracked platform-core and RBAC change IDs. Startup mutation paths remain outside readiness enforcement until Phase 4 removes or reclassifies them.',
  };
}
