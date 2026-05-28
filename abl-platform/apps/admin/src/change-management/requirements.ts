import {
  getChangeManifestEntry,
  resolveCurrentChangeEnvironment,
  type ChangeEnvironment,
  type ServiceChangeRequirement,
} from '@agent-platform/database';

const ADMIN_PROXY_CHANGE_IDS = ['seed.platform-core', 'seed.rbac-tool-permissions'] as const;

function assertManifestEntries(changeIds: readonly string[]): void {
  const missingChangeIds = changeIds.filter((changeId) => !getChangeManifestEntry(changeId));
  if (missingChangeIds.length > 0) {
    throw new Error(
      `Admin change requirements reference unknown manifest entries: ${missingChangeIds.join(', ')}`,
    );
  }
}

assertManifestEntries(ADMIN_PROXY_CHANGE_IDS);

export interface AdminChangeRequirementOptions {
  environment?: ChangeEnvironment;
}

export function getAdminChangeRequirement(
  options: AdminChangeRequirementOptions = {},
): ServiceChangeRequirement {
  return {
    service: 'admin',
    environment: options.environment ?? resolveCurrentChangeEnvironment(),
    enforcementMode: 'proxy_only',
    requiredChangeIds: [...ADMIN_PROXY_CHANGE_IDS],
    optionalChangeIds: [],
    notes:
      'Admin remains proxy-first in phase 1. Compatibility state is surfaced through Runtime system-health and change-management proxy routes rather than local readiness gating.',
  };
}
