import { mongoMigrationRegistry, type MongoMigrationManifestId } from '../migrations/registry.js';
import { SEED_TASK_CATALOG, seedTaskCatalogEntries } from '../seed/catalog.js';
import {
  CHANGE_ENVIRONMENTS,
  CHANGE_OBSERVABILITY_DIMENSIONS,
  CHANGE_RELEASE_EVIDENCE_FIELDS,
  type ChangeEnvironment,
  type ChangeManifestEntry,
  type KnownChangeSurface,
  type LegacyLedgerMapping,
  type ManifestValidationIssue,
  type ManifestValidationResult,
} from './types.js';

const ALL_ENVIRONMENTS: ChangeEnvironment[] = [...CHANGE_ENVIRONMENTS];
const DEV_ENVIRONMENTS: ChangeEnvironment[] = ['dev'];
const CHANGE_PHASE_ORDER: Record<ChangeManifestEntry['phase'], number> = {
  pre_deploy: 0,
  inline: 1,
  post_deploy: 2,
  continuous: 3,
};

type EntryMetadata = Pick<
  ChangeManifestEntry,
  | 'kind'
  | 'phase'
  | 'trigger'
  | 'blocking'
  | 'scope'
  | 'environments'
  | 'reversibility'
  | 'destructive'
> &
  Partial<Pick<ChangeManifestEntry, 'requires' | 'requiredByServices' | 'notes'>>;

const MIGRATION_LEDGER_MAPPING: LegacyLedgerMapping = {
  sourceCollection: '_migration_history',
  identifierField: 'version',
  statusField: 'status',
  checksumField: 'checksum',
  validationStatusField: 'validationStatus',
  notes:
    'Current Mongo migration ledger. Legacy version values are not globally unique, so manifest IDs remain namespaced and may disambiguate a single legacy version string.',
};

const SEED_LEDGER_MAPPING: LegacyLedgerMapping = {
  sourceCollection: '_seed_history',
  identifierField: 'taskId',
  targetField: 'targetKey',
  statusField: 'status',
  checksumField: 'checksum',
  validationStatusField: 'validationStatus',
  notes:
    'Current seed ledger. Platform-core deploy seeding and tenant bootstrap flows share domain intent but do not yet share one runtime execution path.',
};

export const LEGACY_LEDGER_MAPPINGS: readonly LegacyLedgerMapping[] = [
  MIGRATION_LEDGER_MAPPING,
  SEED_LEDGER_MAPPING,
];

export const CHANGE_RELEASE_EVIDENCE_CONTRACT = {
  refFields: [...CHANGE_RELEASE_EVIDENCE_FIELDS],
  observabilityDimensions: [...CHANGE_OBSERVABILITY_DIMENSIONS],
  notes:
    'Change-management stores references to configuration-management evidence, not raw configuration values. Release records should link config snapshot/diff refs, lower-environment validation refs, and observability trace correlation IDs.',
} as const;

function createEntry(
  entry: Omit<ChangeManifestEntry, 'evidenceFields' | 'observabilityDimensions'> &
    Partial<Pick<ChangeManifestEntry, 'evidenceFields' | 'observabilityDimensions'>>,
): ChangeManifestEntry {
  return {
    ...entry,
    sourcePaths: [...entry.sourcePaths],
    environments: [...entry.environments],
    requires: [...entry.requires],
    evidenceFields: entry.evidenceFields
      ? [...entry.evidenceFields]
      : [...CHANGE_RELEASE_EVIDENCE_FIELDS],
    observabilityDimensions: entry.observabilityDimensions
      ? [...entry.observabilityDimensions]
      : [...CHANGE_OBSERVABILITY_DIMENSIONS],
  };
}

const MONGO_MIGRATION_METADATA: Record<MongoMigrationManifestId, EntryMetadata> = {
  'mongodb.20260211_000.initial-schema-validation': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260216_001.unified-tool-schema': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'not_applicable',
    destructive: false,
    notes: 'Superseded by project_tools and retained as an inventory-only no-op.',
  },
  'mongodb.20260216_002.drop-legacy-tool-collections': {
    kind: 'schema',
    phase: 'post_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: true,
    requires: ['mongodb.20260216_001.unified-tool-schema'],
  },
  'mongodb.20260219_001.unified-credential-store': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'manual',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260225_003.enable-default-llm-features': {
    kind: 'seed_platform',
    phase: 'continuous',
    trigger: 'deploy',
    blocking: 'warn_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260227_004.fix-agent-path-schema': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260227_005.scope-agent-path-to-project': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
    requires: ['mongodb.20260227_004.fix-agent-path-schema'],
  },
  'mongodb.20260301_006.slack-external-id-team-app': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260303_007.add-tenant-id-remove-domain': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260304_008.fix-verify-token-hash-index': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260305_009.seed-workflow-permissions': {
    kind: 'seed_platform',
    phase: 'continuous',
    trigger: 'deploy',
    blocking: 'startup_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260305_010.backfill-message-contact-ids': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260306_011.rename-conversations-to-sessions': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260307_010.create-human-tasks-collection': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260307_012.drop-old-message-idempotency-index': {
    kind: 'schema',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'warn_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: true,
  },
  'mongodb.20260311_013.seed-dev-enterprise-subscription': {
    kind: 'seed_dev',
    phase: 'continuous',
    trigger: 'manual',
    blocking: 'warn_only',
    scope: 'tenant',
    environments: DEV_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260319_016.scope-channel-sessions-to-connection': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260323_017.backfill-message-project-ids': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260416_018.fix-connector-connection-uniqueness-index': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260420_019.seed-member-project-create-permission': {
    kind: 'seed_platform',
    phase: 'continuous',
    trigger: 'deploy',
    blocking: 'startup_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260423_020.refresh-token-family-generation': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260423_022.fix-workflow-name-uniqueness-index': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260423_021.enforce-refresh-token-generation-uniqueness': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
  },
  'mongodb.20260426_022.backfill-service-node-and-agent-lock-tenant-ids': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
    notes:
      'Run after the tenantId schema/index hardening for service_nodes and agent_locks is deployed so new writes are already tenant-scoped before historical rows are backfilled.',
  },
  'mongodb.20260426_023.backfill-encrypted-custom-headers-and-auth-config': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    notes:
      'Requires ENCRYPTION_MASTER_KEY and the DEK facade so historical plaintext customHeaders/authConfig values can be re-saved through encrypted model paths. Rollback is intentionally a no-op to avoid reintroducing plaintext credentials.',
  },
  'mongodb.20260426_024.drop-legacy-lock-servicenode-indexes': {
    kind: 'schema',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    notes:
      'Drops the pre-ABLP-574 unique indexes on agent_locks ({projectId, agentId, lockType}) and service_nodes ({projectId, name}). The replacement tenant-scoped indexes were already added by the model schema; without dropping the legacy indexes, cross-tenant collisions still trigger duplicate-key rejections. Rollback intentionally does NOT recreate them — they are the security gap that ABLP-574 closed.',
  },
  'mongodb.20260503_025.backfill-agent-model-config-tenant-ids': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    notes:
      'Backfills AgentModelConfig.tenantId from the parent project and replaces project-only indexes with tenant-scoped indexes. Rollback intentionally does not recreate non-tenant-scoped indexes.',
  },
  'mongodb.20260503_026.scope-project-agent-path-to-tenant': {
    kind: 'schema',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    notes:
      'Canonicalizes ProjectAgent.agentPath to projectId/name and replaces the tenant-blind {projectId, agentPath} unique index with {tenantId, projectId, agentPath}. Rollback intentionally does not recreate the tenant-blind index.',
  },
  'mongodb.20260505_027.backfill-model-config-tenant-ids': {
    kind: 'backfill',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    notes:
      'Backfills ModelConfig.tenantId from the parent project and replaces project-only indexes with tenant-scoped indexes. Rollback intentionally does not recreate non-tenant-scoped indexes.',
  },
  'mongodb.20260509_028.drop-project-agent-path-unique-index': {
    kind: 'schema',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
    requires: ['mongodb.20260503_026.scope-project-agent-path-to-tenant'],
    notes:
      'Drops legacy unique indexes on ProjectAgent.agentPath and keeps agentPath as a non-unique tenant/project lookup index. ProjectAgent identity uniqueness remains enforced by {tenantId, projectId, name}.',
  },
  'mongodb.20260509_029.seed-admin-guardrail-pii-permissions': {
    kind: 'backfill',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
    notes:
      'Backfills existing system ADMIN RoleDefinition documents with guardrail and PII pattern read/write permissions so workspace admins can manage project safety configuration after ABLP-673.',
  },
  'mongodb.20260510_030.backfill-custom-project-safety-permissions': {
    kind: 'backfill',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
    requires: ['mongodb.20260509_029.seed-admin-guardrail-pii-permissions'],
    notes:
      'Backfills active custom project RoleDefinition documents with guardrail and PII pattern permissions based on their existing read/write project authority, while leaving narrow and unreferenced custom roles untouched.',
  },
  'mongodb.20260510_031.fix-guardrail-policy-scope-unique-index': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    notes:
      'Drops the legacy tenant-wide GuardrailPolicy unique index on {tenantId, name, scope.type} after ensuring the scoped replacement on {tenantId, name, scope.type, scope.projectId, scope.agentDefId}. Without this, project import activation can fail when another project in the same tenant already has a policy such as Content Safety.',
  },
  'mongodb.20260511_029.repair-workflow-name-uniqueness-index': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
    requires: ['mongodb.20260423_022.fix-workflow-name-uniqueness-index'],
    notes:
      'Force-rebuilds the canonical partial unique workflow name index by dropping both the legacy and _active index names before recreating tenantId/projectId/name uniqueness for non-deleted workflows only.',
  },
  'mongodb.20260514_034.migrate-workflow-api-nodes-to-http-tools': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    notes:
      'Extracts legacy workflow API-node HTTP configs into project_tools, rewrites workflow_versions rows where version is draft, and syncs workflow working-copy nodes that Studio reads. Published/numbered workflow versions are left frozen. Fails closed on tool-name/config conflicts.',
  },
  'mongodb.20260511_032.reconcile-guardrail-policy-scope-unique-index': {
    kind: 'schema',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    requires: ['mongodb.20260510_031.fix-guardrail-policy-scope-unique-index'],
    requiredByServices: ['runtime', 'studio'],
    notes:
      'Idempotently re-runs GuardrailPolicy index reconciliation after rollout so stale application pods cannot leave the legacy tenant-wide unique index behind after 20260510_031.',
  },
  'mongodb.20260512_033.scope-arch-sessions-to-surface': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
    requiredByServices: ['studio'],
    notes:
      'Manual Arch session index repair for environments that can run migrations before production: drops legacy tenant/user/mode/project and surface-only uniqueness, backfills surface/thread scope fields, and creates tenant/user/mode/project/surface/agentNameKey/threadId uniqueness. Runtime force-start recovery remains the pre-production unblocker when this migration cannot run immediately.',
  },
  'mongodb.20260513_034.backfill-voice-filler-delay': {
    kind: 'backfill',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    requiredByServices: ['runtime', 'studio'],
    notes:
      'Rewrites legacy ProjectRuntimeConfig filler.voiceDelayMs:0 defaults to 500ms before runtime stops treating zero as an unset sentinel.',
  },
  'mongodb.20260508_019.auth-profile-profile-type': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260508_020.end-user-oauth-token-project-scope': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260513_021.project-tool-auth-profile-id': {
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'deploy',
    blocking: 'async_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'down',
    destructive: false,
  },
  'mongodb.20260516_035.repair-project-identity-indexes': {
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'deploy',
    blocking: 'deploy_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'forward_only',
    destructive: false,
    requiredByServices: ['runtime', 'studio', 'admin'],
    notes:
      'Drops legacy global unique indexes on projects.name and projects.slug, then ensures project slug identity is scoped to {tenantId, slug}. Rollback intentionally does not recreate the legacy global indexes because they reject valid cross-workspace projects.',
  },
};

function requireEntryMetadata(manifestId: string, metadata: EntryMetadata | undefined) {
  if (!metadata) {
    throw new Error(`Missing change-management metadata for registered change: ${manifestId}`);
  }

  return metadata;
}

const mongoMigrationEntries = mongoMigrationRegistry.map((spec) => {
  const metadata = requireEntryMetadata(spec.manifestId, MONGO_MIGRATION_METADATA[spec.manifestId]);
  return createEntry({
    id: spec.manifestId,
    legacyId: spec.migration.version,
    description: spec.migration.description,
    sourcePaths: [spec.sourcePath],
    engine: 'mongodb',
    lifecycle: spec.registry === 'cli' ? 'active' : 'inventory_only',
    legacyLedger: MIGRATION_LEDGER_MAPPING,
    kind: metadata.kind,
    phase: metadata.phase,
    trigger: metadata.trigger,
    blocking: metadata.blocking,
    scope: metadata.scope,
    environments: metadata.environments,
    reversibility: metadata.reversibility,
    destructive: metadata.destructive,
    requires: metadata.requires ?? [],
    requiredByServices: metadata.requiredByServices,
    notes: metadata.notes,
  });
});

const seedManifestMetadata: Record<string, EntryMetadata> = {
  [SEED_TASK_CATALOG['platform-core'].manifestId]: {
    kind: 'seed_platform',
    phase: 'continuous',
    trigger: 'deploy',
    blocking: 'startup_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
    requiredByServices: ['runtime', 'search-ai', 'admin'],
  },
  [SEED_TASK_CATALOG['rbac-tool-permissions'].manifestId]: {
    kind: 'seed_platform',
    phase: 'continuous',
    trigger: 'deploy',
    blocking: 'startup_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
    requires: [SEED_TASK_CATALOG['platform-core'].manifestId],
    requiredByServices: ['runtime', 'admin'],
  },
  [SEED_TASK_CATALOG['tenant-operational-defaults'].manifestId]: {
    kind: 'seed_tenant',
    phase: 'continuous',
    trigger: 'manual',
    blocking: 'bootstrap_only',
    scope: 'tenant',
    environments: ALL_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
    requires: [SEED_TASK_CATALOG['platform-core'].manifestId],
    notes:
      'Default deployment seeding does not invoke this task. Tenant defaults are handled separately for explicit tenant targeting and lifecycle bootstraps.',
  },
  [SEED_TASK_CATALOG['dev-workspace-fixtures'].manifestId]: {
    kind: 'seed_dev',
    phase: 'continuous',
    trigger: 'manual',
    blocking: 'warn_only',
    scope: 'tenant',
    environments: DEV_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
    requires: [SEED_TASK_CATALOG['tenant-operational-defaults'].manifestId],
  },
  [SEED_TASK_CATALOG['e2e-workspace-fixtures'].manifestId]: {
    kind: 'seed_dev',
    phase: 'continuous',
    trigger: 'manual',
    blocking: 'warn_only',
    scope: 'tenant',
    environments: DEV_ENVIRONMENTS,
    reversibility: 'compensating',
    destructive: false,
    requires: [SEED_TASK_CATALOG['tenant-operational-defaults'].manifestId],
  },
};

const seedTaskEntries = seedTaskCatalogEntries.map((task) => {
  const metadata = requireEntryMetadata(task.manifestId, seedManifestMetadata[task.manifestId]);
  return createEntry({
    id: task.manifestId,
    legacyId: task.taskId,
    description: task.description,
    sourcePaths: task.sourcePaths,
    engine: 'mongodb',
    lifecycle: 'active',
    legacyLedger: SEED_LEDGER_MAPPING,
    kind: metadata.kind,
    phase: metadata.phase,
    trigger: metadata.trigger,
    blocking: metadata.blocking,
    scope: metadata.scope,
    environments: metadata.environments,
    reversibility: metadata.reversibility,
    destructive: metadata.destructive,
    requires: metadata.requires ?? [],
    requiredByServices: metadata.requiredByServices,
    notes: [task.notes, metadata.notes].filter(Boolean).join(' '),
  });
});

const manualEntries: ChangeManifestEntry[] = [
  createEntry({
    id: 'tenant-bootstrap.workspace-create',
    description: 'Bootstrap tenant defaults during workspace creation',
    sourcePaths: [
      'apps/studio/src/repos/workspace-repo.ts',
      'apps/studio/src/app/api/auth/create-workspace/route.ts',
    ],
    engine: 'mongodb',
    kind: 'seed_tenant',
    phase: 'continuous',
    trigger: 'tenant_lifecycle',
    blocking: 'bootstrap_only',
    scope: 'tenant',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'compensating',
    destructive: false,
    requires: [SEED_TASK_CATALOG['platform-core'].manifestId],
    legacyLedger: null,
    notes:
      'Workspace creation bootstraps tenant defaults at lifecycle time instead of during deploy seeding.',
  }),
  createEntry({
    id: 'tenant-bootstrap.dev-login',
    description: 'Best-effort tenant bootstrap during dev login and E2E tenant attachment',
    sourcePaths: ['apps/studio/src/app/api/auth/dev-login/route.ts'],
    engine: 'mongodb',
    kind: 'seed_tenant',
    phase: 'continuous',
    trigger: 'tenant_lifecycle',
    blocking: 'bootstrap_only',
    scope: 'tenant',
    environments: DEV_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'compensating',
    destructive: false,
    requires: [SEED_TASK_CATALOG['platform-core'].manifestId],
    legacyLedger: null,
    notes:
      'This is an environment-gated, best-effort bootstrap path and should not be treated as deploy readiness.',
  }),
  createEntry({
    id: 'tenant-bootstrap.platform-admin',
    description: 'Bootstrap tenant defaults from the platform-admin tenant management flow',
    sourcePaths: ['apps/runtime/src/routes/platform-admin-tenants.ts'],
    engine: 'mongodb',
    kind: 'seed_tenant',
    phase: 'continuous',
    trigger: 'tenant_lifecycle',
    blocking: 'bootstrap_only',
    scope: 'tenant',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'compensating',
    destructive: false,
    requires: [SEED_TASK_CATALOG['platform-core'].manifestId],
    legacyLedger: null,
  }),
  createEntry({
    id: 'clickhouse.006-json-path-index',
    description: 'Add ClickHouse json_path index SQL migration',
    sourcePaths: ['apps/search-ai/migrations/clickhouse/006_json_path_index.sql'],
    engine: 'clickhouse',
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'inventory_only',
    reversibility: 'forward_only',
    destructive: false,
    requires: [],
    legacyLedger: null,
    notes: 'Numbered SQL change file exists in-repo but is not yet owned by a tracked runner.',
  }),
  createEntry({
    id: 'clickhouse.add-custom-dimensions',
    description: 'Apply ClickHouse custom dimension schema helper',
    sourcePaths: ['packages/database/src/clickhouse-schemas/migrations/add-custom-dimensions.ts'],
    engine: 'clickhouse',
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'inventory_only',
    reversibility: 'forward_only',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'clickhouse.add-agent-name-to-messages',
    description:
      'Add agent_name LowCardinality(String) column to abl_platform.messages for per-agent analytics and feedback-target lookups (ABLP-1068; blocks ABLP-988). Idempotent ADD COLUMN IF NOT EXISTS.',
    sourcePaths: [
      'packages/database/src/clickhouse-schemas/migrations/add-agent-name-to-messages.ts',
    ],
    engine: 'clickhouse',
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'inventory_only',
    reversibility: 'forward_only',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'clickhouse.eval-retention-ttl-columns',
    description: 'Apply eval retention ClickHouse TTL columns with configured database name',
    sourcePaths: [
      'packages/database/src/clickhouse-schemas/migrations/eval-retention-ttl-columns.ts',
    ],
    engine: 'clickhouse',
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'inventory_only',
    reversibility: 'forward_only',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'clickhouse.add-cost-breakdown-to-eval-conversations',
    description:
      'Add per-model cost_by_model and customer_visible_cost columns to eval_conversations for agent token cost rollup (ABLP-945 / W1.2). Companion .sql file at packages/database/clickhouse/migrations/2026-05-11-add-cost-breakdown-to-eval-conversations.sql is human-reference only.',
    sourcePaths: [
      'packages/database/src/clickhouse-schemas/migrations/add-cost-breakdown-to-eval-conversations.ts',
    ],
    engine: 'clickhouse',
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'inventory_only',
    reversibility: 'forward_only',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'clickhouse.add-platform-events-known-source',
    description:
      'Add known_source LowCardinality column to platform_events and platform_events_by_session, rebuild the session MV (ABLP-947 W1.4-M2).',
    sourcePaths: [
      'packages/database/src/clickhouse-schemas/migrations/add-platform-events-known-source.ts',
    ],
    engine: 'clickhouse',
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'inventory_only',
    reversibility: 'forward_only',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'runtime.migrate-env-to-instances',
    description:
      'Migrate environment-variable provider credentials into tenant model and service instance records',
    sourcePaths: ['apps/runtime/src/scripts/migrate-env-to-instances.ts'],
    engine: 'script',
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'tenant',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'compensating',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'search-ai.migrate-source-document-counts',
    description: 'Recompute search source document counts from search_documents',
    sourcePaths: ['apps/search-ai/src/scripts/migrate-source-document-counts.ts'],
    engine: 'script',
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'compensating',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'search-ai.backfill-entity-instances',
    description: 'Backfill entity instances from MongoDB into ClickHouse analytics tables',
    sourcePaths: ['apps/search-ai/src/scripts/backfill-entity-instances.ts'],
    engine: 'script',
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'manual',
    blocking: 'async_required',
    scope: 'tenant',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'compensating',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'search-ai.backfill-connector-id',
    description: 'Backfill SearchDocument.connectorId from SearchSource records',
    sourcePaths: ['apps/search-ai/src/scripts/backfill-connector-id.ts'],
    engine: 'script',
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'manual',
    blocking: 'async_required',
    scope: 'tenant',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'compensating',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'search-ai.job-execution-ttl-index',
    description: 'Add TTL index for SearchAI job execution retention',
    sourcePaths: ['apps/search-ai/scripts/add-job-execution-ttl-index.ts'],
    engine: 'mongodb',
    kind: 'schema',
    phase: 'pre_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'down',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'runtime.channel-connection-index-repair',
    description: 'Repair the verifyTokenHash channel connection index during runtime startup',
    sourcePaths: ['apps/runtime/src/db/channel-connection-index-repair.ts'],
    engine: 'mongodb',
    kind: 'schema',
    phase: 'inline',
    trigger: 'deploy',
    blocking: 'startup_required',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'down',
    destructive: false,
    requires: [],
    legacyLedger: null,
    requiredByServices: ['runtime'],
    notes:
      'This is a current startup-time mutation path and should eventually move behind the deploy-owned control plane.',
  }),
  createEntry({
    id: 'scripts.migrate-pipeline-triggers',
    description: 'Migrate pipeline definitions and configs to the multi-trigger format',
    sourcePaths: ['scripts/migrate-pipeline-triggers.ts'],
    engine: 'script',
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'compensating',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'scripts.migrate-chunkStrategy-to-tokenChunkStrategy',
    description: 'Rename SearchIndex.chunkStrategy to tokenChunkStrategy',
    sourcePaths: ['scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts'],
    engine: 'mongodb',
    kind: 'backfill',
    phase: 'post_deploy',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'compensating',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'secrets.seed',
    description: 'Seed required platform secrets into AWS Secrets Manager from the manifest',
    sourcePaths: ['scripts/seed-secrets.ts'],
    engine: 'secrets_manager',
    kind: 'secret',
    phase: 'continuous',
    trigger: 'manual',
    blocking: 'manual_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'not_applicable',
    destructive: false,
    requires: [],
    legacyLedger: null,
    notes:
      'Secrets are intentionally managed outside MongoDB seed history. Change-management tracks this as a sibling operational flow, not as data ownership.',
  }),
  createEntry({
    id: 'secrets.validate-completeness',
    description:
      'Validate Secrets Manager completeness against the secrets manifest and ESO templates',
    sourcePaths: ['scripts/validate-secrets-completeness.ts'],
    engine: 'secrets_manager',
    kind: 'secret',
    phase: 'continuous',
    trigger: 'manual',
    blocking: 'warn_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'not_applicable',
    destructive: false,
    requires: [],
    legacyLedger: null,
  }),
  createEntry({
    id: 'eventstore.analytics-bridge',
    description: 'Bridge selected legacy writes into eventstore-backed analytics streams',
    sourcePaths: ['packages/eventstore/src/migration/index.ts'],
    engine: 'eventstore',
    kind: 'bridge',
    phase: 'continuous',
    trigger: 'deploy',
    blocking: 'warn_only',
    scope: 'global',
    environments: ALL_ENVIRONMENTS,
    lifecycle: 'active',
    reversibility: 'not_applicable',
    destructive: false,
    requires: [],
    legacyLedger: null,
    notes:
      'This is not a schema migration runner. It is a dual-write bridge that still needs visibility in the unified change inventory.',
  }),
];

export const CHANGE_MANIFEST: ChangeManifestEntry[] = [
  ...mongoMigrationEntries,
  ...seedTaskEntries,
  ...manualEntries,
];

export const KNOWN_CHANGE_SURFACES: KnownChangeSurface[] = [
  ...mongoMigrationRegistry.map((spec) => ({
    surfaceKey: spec.manifestId,
    path: spec.sourcePath,
    disposition: 'registered' as const,
    expectedManifestId: spec.manifestId,
    notes:
      spec.registry === 'cli'
        ? 'Current Mongo migration registry surface.'
        : 'Inventory-only Mongo migration script retained outside the live CLI registry.',
  })),
  ...seedTaskCatalogEntries.map((task) => ({
    surfaceKey: task.manifestId,
    path: task.sourcePaths[0]!,
    disposition: 'registered' as const,
    expectedManifestId: task.manifestId,
    notes: task.notes,
  })),
  {
    surfaceKey: 'seed.rbac-tool-permissions.script',
    path: 'scripts/rbac-tool-permissions.ts',
    disposition: 'registered',
    expectedManifestId: 'seed.rbac-tool-permissions',
  },
  {
    surfaceKey: 'tenant-bootstrap.workspace-create.repo',
    path: 'apps/studio/src/repos/workspace-repo.ts',
    disposition: 'registered',
    expectedManifestId: 'tenant-bootstrap.workspace-create',
  },
  {
    surfaceKey: 'tenant-bootstrap.workspace-create.route',
    path: 'apps/studio/src/app/api/auth/create-workspace/route.ts',
    disposition: 'registered',
    expectedManifestId: 'tenant-bootstrap.workspace-create',
  },
  {
    surfaceKey: 'tenant-bootstrap.dev-login',
    path: 'apps/studio/src/app/api/auth/dev-login/route.ts',
    disposition: 'registered',
    expectedManifestId: 'tenant-bootstrap.dev-login',
  },
  {
    surfaceKey: 'tenant-bootstrap.platform-admin',
    path: 'apps/runtime/src/routes/platform-admin-tenants.ts',
    disposition: 'registered',
    expectedManifestId: 'tenant-bootstrap.platform-admin',
  },
  {
    surfaceKey: 'clickhouse.006-json-path-index',
    path: 'apps/search-ai/migrations/clickhouse/006_json_path_index.sql',
    disposition: 'registered',
    expectedManifestId: 'clickhouse.006-json-path-index',
  },
  {
    surfaceKey: 'clickhouse.add-custom-dimensions',
    path: 'packages/database/src/clickhouse-schemas/migrations/add-custom-dimensions.ts',
    disposition: 'registered',
    expectedManifestId: 'clickhouse.add-custom-dimensions',
  },
  {
    surfaceKey: 'clickhouse.eval-retention-ttl-columns',
    path: 'packages/database/src/clickhouse-schemas/migrations/eval-retention-ttl-columns.ts',
    disposition: 'registered',
    expectedManifestId: 'clickhouse.eval-retention-ttl-columns',
  },
  {
    surfaceKey: 'clickhouse.add-cost-breakdown-to-eval-conversations',
    path: 'packages/database/src/clickhouse-schemas/migrations/add-cost-breakdown-to-eval-conversations.ts',
    disposition: 'registered',
    expectedManifestId: 'clickhouse.add-cost-breakdown-to-eval-conversations',
  },
  {
    surfaceKey: 'clickhouse.add-platform-events-known-source',
    path: 'packages/database/src/clickhouse-schemas/migrations/add-platform-events-known-source.ts',
    disposition: 'registered',
    expectedManifestId: 'clickhouse.add-platform-events-known-source',
  },
  {
    surfaceKey: 'runtime.migrate-env-to-instances',
    path: 'apps/runtime/src/scripts/migrate-env-to-instances.ts',
    disposition: 'registered',
    expectedManifestId: 'runtime.migrate-env-to-instances',
  },
  {
    surfaceKey: 'search-ai.migrate-source-document-counts',
    path: 'apps/search-ai/src/scripts/migrate-source-document-counts.ts',
    disposition: 'registered',
    expectedManifestId: 'search-ai.migrate-source-document-counts',
  },
  {
    surfaceKey: 'search-ai.backfill-entity-instances',
    path: 'apps/search-ai/src/scripts/backfill-entity-instances.ts',
    disposition: 'registered',
    expectedManifestId: 'search-ai.backfill-entity-instances',
  },
  {
    surfaceKey: 'search-ai.backfill-connector-id',
    path: 'apps/search-ai/src/scripts/backfill-connector-id.ts',
    disposition: 'registered',
    expectedManifestId: 'search-ai.backfill-connector-id',
  },
  {
    surfaceKey: 'search-ai.job-execution-ttl-index',
    path: 'apps/search-ai/scripts/add-job-execution-ttl-index.ts',
    disposition: 'registered',
    expectedManifestId: 'search-ai.job-execution-ttl-index',
  },
  {
    surfaceKey: 'runtime.channel-connection-index-repair',
    path: 'apps/runtime/src/db/channel-connection-index-repair.ts',
    disposition: 'registered',
    expectedManifestId: 'runtime.channel-connection-index-repair',
  },
  {
    surfaceKey: 'scripts.migrate-pipeline-triggers',
    path: 'scripts/migrate-pipeline-triggers.ts',
    disposition: 'registered',
    expectedManifestId: 'scripts.migrate-pipeline-triggers',
  },
  {
    surfaceKey: 'scripts.migrate-chunkStrategy-to-tokenChunkStrategy',
    path: 'scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts',
    disposition: 'registered',
    expectedManifestId: 'scripts.migrate-chunkStrategy-to-tokenChunkStrategy',
  },
  {
    surfaceKey: 'secrets.seed',
    path: 'scripts/seed-secrets.ts',
    disposition: 'registered',
    expectedManifestId: 'secrets.seed',
  },
  {
    surfaceKey: 'secrets.validate-completeness',
    path: 'scripts/validate-secrets-completeness.ts',
    disposition: 'registered',
    expectedManifestId: 'secrets.validate-completeness',
  },
  {
    surfaceKey: 'eventstore.analytics-bridge',
    path: 'packages/eventstore/src/migration/index.ts',
    disposition: 'registered',
    expectedManifestId: 'eventstore.analytics-bridge',
  },
  {
    surfaceKey: 'scripts.migrate-abl',
    path: 'scripts/migrate-abl.ts',
    disposition: 'non_release_coupled',
    notes: 'Codebase migration utility for .abl source files, not shared runtime state.',
  },
  {
    surfaceKey: 'scripts.migrate-test-mode',
    path: 'scripts/migrate-test-mode.ts',
    disposition: 'non_release_coupled',
    notes: 'Test-only DSL cleanup helper.',
  },
  {
    surfaceKey: 'scripts.migrate-test-dsl',
    path: 'scripts/migrate-test-dsl.ts',
    disposition: 'non_release_coupled',
    notes: 'Test-only DSL migration helper.',
  },
  {
    surfaceKey: 'packages.database.cleanup.remove-dual-read',
    path: 'packages/database/src/migrations/cleanup/remove-dual-read.ts',
    disposition: 'non_release_coupled',
    notes: 'Static analysis/reporting helper for later cleanup work, not a rollout mutation.',
  },
];

function getIllegalCombinationIssues(entry: ChangeManifestEntry): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = [];

  if (
    entry.kind === 'seed_dev' &&
    entry.environments.some((environment) => environment !== 'dev')
  ) {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      message: 'seed_dev entries may only target the dev environment.',
    });
  }

  if (entry.trigger === 'tenant_lifecycle' && entry.scope !== 'tenant') {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      message: 'tenant_lifecycle entries must be tenant-scoped.',
    });
  }

  if (entry.kind === 'seed_tenant' && entry.scope !== 'tenant') {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      message: 'seed_tenant entries must be tenant-scoped.',
    });
  }

  if (entry.kind === 'seed_tenant' && entry.trigger === 'deploy') {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      message: 'seed_tenant entries cannot be deploy-triggered shared-state mutations.',
    });
  }

  if (
    entry.phase === 'pre_deploy' &&
    entry.trigger !== 'deploy' &&
    entry.blocking !== 'manual_only'
  ) {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      message: 'pre_deploy entries must be deploy-triggered unless explicitly manual-only.',
    });
  }

  if (entry.phase === 'pre_deploy' && entry.trigger === 'deploy' && entry.destructive) {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      message:
        'destructive deploy-triggered migrations must run post_deploy or be marked manual-only.',
    });
  }

  if (
    entry.phase === 'post_deploy' &&
    entry.trigger === 'deploy' &&
    entry.blocking === 'deploy_required' &&
    (!entry.requiredByServices || entry.requiredByServices.length === 0)
  ) {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      message:
        'deploy-blocking post_deploy migrations must declare requiredByServices for rollout verification.',
    });
  }

  if (
    entry.trigger === 'tenant_lifecycle' &&
    (entry.blocking === 'deploy_required' || entry.blocking === 'startup_required')
  ) {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      message: 'tenant lifecycle entries cannot block global deploy or startup readiness.',
    });
  }

  if (entry.sourcePaths.length === 0) {
    issues.push({
      code: 'invalid_entry',
      severity: 'error',
      changeId: entry.id,
      message: 'Manifest entries must declare at least one source path.',
    });
  }

  return issues;
}

function detectCycles(entries: ChangeManifestEntry[]): ManifestValidationIssue[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const issues: ManifestValidationIssue[] = [];
  const seenCycles = new Set<string>();

  function visit(changeId: string, stack: string[]): void {
    if (visiting.has(changeId)) {
      const cycleStart = stack.indexOf(changeId);
      const cycle = [...stack.slice(cycleStart), changeId];
      const signature = cycle.join('>');
      if (!seenCycles.has(signature)) {
        seenCycles.add(signature);
        issues.push({
          code: 'cyclic_dependency',
          severity: 'error',
          changeId,
          relatedChangeIds: cycle,
          message: `Cyclic dependency detected: ${cycle.join(' -> ')}`,
        });
      }
      return;
    }

    if (visited.has(changeId)) {
      return;
    }

    visited.add(changeId);
    visiting.add(changeId);

    const entry = byId.get(changeId);
    if (entry) {
      for (const dependencyId of entry.requires) {
        if (byId.has(dependencyId)) {
          visit(dependencyId, [...stack, changeId]);
        }
      }
    }

    visiting.delete(changeId);
  }

  for (const entry of entries) {
    visit(entry.id, []);
  }

  return issues;
}

function getDependencyInvariantIssues(
  entry: ChangeManifestEntry,
  dependency: ChangeManifestEntry,
): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = [];

  if (
    entry.trigger === 'deploy' &&
    dependency.trigger === 'deploy' &&
    CHANGE_PHASE_ORDER[dependency.phase] > CHANGE_PHASE_ORDER[entry.phase]
  ) {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      dependencyId: dependency.id,
      message: `${entry.id} cannot require later-phase change ${dependency.id}.`,
    });
  }

  if (
    entry.engine === 'mongodb' &&
    dependency.engine === 'mongodb' &&
    entry.lifecycle === 'active' &&
    dependency.lifecycle === 'active' &&
    entry.trigger === 'deploy' &&
    dependency.trigger === 'deploy' &&
    entry.phase === dependency.phase &&
    entry.legacyId &&
    dependency.legacyId &&
    dependency.legacyId.localeCompare(entry.legacyId) > 0
  ) {
    issues.push({
      code: 'illegal_combination',
      severity: 'error',
      changeId: entry.id,
      dependencyId: dependency.id,
      message: `${entry.id} cannot run before same-phase MongoDB dependency ${dependency.id}.`,
    });
  }

  return issues;
}

export function getChangeManifestForEnvironment(
  environment: ChangeEnvironment,
  entries: ChangeManifestEntry[] = CHANGE_MANIFEST,
): ChangeManifestEntry[] {
  return entries.filter((entry) => entry.environments.includes(environment));
}

export function getChangeManifestEntry(
  changeId: string,
  entries: ChangeManifestEntry[] = CHANGE_MANIFEST,
): ChangeManifestEntry | undefined {
  return entries.find((entry) => entry.id === changeId);
}

export function validateChangeManifest(
  entries: ChangeManifestEntry[] = CHANGE_MANIFEST,
  knownSurfaces: KnownChangeSurface[] = KNOWN_CHANGE_SURFACES,
): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = [];
  const byId = new Map<string, ChangeManifestEntry>();

  for (const entry of entries) {
    if (byId.has(entry.id)) {
      issues.push({
        code: 'duplicate_change_id',
        severity: 'error',
        changeId: entry.id,
        message: `Duplicate change id detected: ${entry.id}`,
      });
      continue;
    }

    byId.set(entry.id, entry);
    issues.push(...getIllegalCombinationIssues(entry));
  }

  for (const entry of entries) {
    for (const dependencyId of entry.requires) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        issues.push({
          code: 'missing_dependency',
          severity: 'error',
          changeId: entry.id,
          dependencyId,
          message: `${entry.id} depends on missing change ${dependencyId}`,
        });
        continue;
      }

      issues.push(...getDependencyInvariantIssues(entry, dependency));
    }
  }

  issues.push(...detectCycles(entries));

  for (const surface of knownSurfaces) {
    if (surface.disposition !== 'registered') {
      continue;
    }

    const expectedEntry = surface.expectedManifestId ? byId.get(surface.expectedManifestId) : null;
    if (!expectedEntry || !expectedEntry.sourcePaths.includes(surface.path)) {
      issues.push({
        code: 'missing_registered_surface',
        severity: 'error',
        surfaceKey: surface.surfaceKey,
        path: surface.path,
        changeId: surface.expectedManifestId,
        message: `Known registered surface ${surface.surfaceKey} is not mapped to the manifest.`,
      });
    }
  }

  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    issues,
  };
}
