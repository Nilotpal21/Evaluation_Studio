export const PLATFORM_CORE_TASK_ID = 'platform-core';
export const RBAC_ALIGNMENT_TASK_ID = 'rbac-tool-permissions';
export const TARGET_DEFAULTS_TASK_ID = 'tenant-operational-defaults';
export const DEV_WORKSPACE_TASK_ID = 'dev-workspace-fixtures';
export const E2E_WORKSPACE_TASK_ID = 'e2e-workspace-fixtures';

export type SeedCatalogTaskId =
  | typeof PLATFORM_CORE_TASK_ID
  | typeof RBAC_ALIGNMENT_TASK_ID
  | typeof TARGET_DEFAULTS_TASK_ID
  | typeof DEV_WORKSPACE_TASK_ID
  | typeof E2E_WORKSPACE_TASK_ID;

export interface SeedTaskCatalogEntry {
  manifestId: string;
  taskId: SeedCatalogTaskId;
  description: string;
  sourcePaths: string[];
  notes?: string;
}

export const SEED_TASK_CATALOG: Readonly<Record<SeedCatalogTaskId, SeedTaskCatalogEntry>> = {
  [PLATFORM_CORE_TASK_ID]: {
    manifestId: 'seed.platform-core',
    taskId: PLATFORM_CORE_TASK_ID,
    description: 'Seed platform core data and database bootstrap metadata',
    sourcePaths: ['packages/database/seed-mongo.ts'],
    notes:
      'Default deploy-time seed path currently covers resource types, prompt templates, pipeline definitions, and optional ClickHouse bootstrap.',
  },
  [RBAC_ALIGNMENT_TASK_ID]: {
    manifestId: 'seed.rbac-tool-permissions',
    taskId: RBAC_ALIGNMENT_TASK_ID,
    description: 'Align tool and MCP RBAC permissions across seeded roles',
    sourcePaths: ['packages/database/seed-mongo.ts', 'scripts/rbac-tool-permissions.ts'],
  },
  [TARGET_DEFAULTS_TASK_ID]: {
    manifestId: 'seed.tenant-operational-defaults.manual',
    taskId: TARGET_DEFAULTS_TASK_ID,
    description: 'Seed tenant-scoped operational defaults for a workspace',
    sourcePaths: ['packages/database/seed-mongo.ts'],
    notes:
      'This task only runs when operators pass --tenant or --workspace-email. It is not part of the default deploy-time seed path.',
  },
  [DEV_WORKSPACE_TASK_ID]: {
    manifestId: 'seed.dev-workspace-fixtures',
    taskId: DEV_WORKSPACE_TASK_ID,
    description: 'Seed the shared local development workspace and examples',
    sourcePaths: ['packages/database/seed-mongo.ts'],
  },
  [E2E_WORKSPACE_TASK_ID]: {
    manifestId: 'seed.e2e-workspace-fixtures',
    taskId: E2E_WORKSPACE_TASK_ID,
    description: 'Seed the dedicated E2E workspace fixtures',
    sourcePaths: ['packages/database/seed-mongo.ts'],
  },
};

export const seedTaskCatalogEntries: SeedTaskCatalogEntry[] = Object.values(SEED_TASK_CATALOG);

export function resolveSeedTaskManifestId(taskId: string): string {
  const catalogEntry = SEED_TASK_CATALOG[taskId as SeedCatalogTaskId];
  return catalogEntry?.manifestId ?? `seed.${taskId}`;
}
