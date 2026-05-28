import type { Migration } from './types.js';
import { migration as initialMigration } from './scripts/20260211_000_initial_schema_validation.js';
import { migration as unifiedToolSchemaMigration } from './scripts/20260216_001_unified_tool_schema.js';
import { migration as dropLegacyToolCollectionsMigration } from './scripts/20260216_002_drop_legacy_tool_collections.js';
import { migration as unifiedCredentialStoreMigration } from './scripts/20260219_001_unified_credential_store.js';
import { migration as enableDefaultLlmFeaturesMigration } from './scripts/20260225_003_enable_default_llm_features.js';
import { migration as agentPathMigration } from './scripts/20260227_004_fix_agent_path_schema.js';
import { migration as scopeAgentPathMigration } from './scripts/20260227_005_scope_agent_path_to_project.js';
import { migration as slackExternalIdMigration } from './scripts/20260301_006_slack_external_id_team_app.js';
import { migration as addTenantIdMigration } from './scripts/20260303_007_add_tenant_id_remove_domain.js';
import { migration as fixVerifyTokenHashIndex } from './scripts/20260304_008_fix_verify_token_hash_index.js';
import { migration as seedWorkflowPermissions } from './scripts/20260305_009_seed_workflow_permissions.js';
import { migration as backfillMessageContactIds } from './scripts/20260305_009_backfill_message_contact_ids.js';
import { migration as renameConversationsToSessions } from './scripts/20260306_011_rename_conversations_to_sessions.js';
import { migration as createHumanTasksCollection } from './scripts/20260307_010_create_human_tasks_collection.js';
import { migration as dropOldMessageIdempotencyIndex } from './scripts/20260307_012_drop_old_message_idempotency_index.js';
import { migration as seedDevEnterpriseSubscription } from './scripts/20260311_013_seed_dev_enterprise_subscription.js';
import { migration as scopeChannelSessionsToConnection } from './scripts/20260319_016_scope_channel_sessions_to_connection.js';
import { migration as backfillMessageProjectIds } from './scripts/20260323_017_backfill_message_project_ids.js';
import { migration as fixConnectorConnectionUniquenessIndex } from './scripts/20260416_018_fix_connector_connection_uniqueness_index.js';
import { migration as seedMemberProjectCreatePermission } from './scripts/20260420_019_seed_member_project_create_permission.js';
import { migration as refreshTokenFamilyGeneration } from './scripts/20260423_020_refresh_token_family_generation.js';
import { migration as fixWorkflowNameUniquenessIndex } from './scripts/20260423_022_fix_workflow_name_uniqueness_index.js';
import { migration as enforceRefreshTokenGenerationUniqueness } from './scripts/20260423_021_enforce_refresh_token_generation_uniqueness.js';
import { migration as backfillServiceNodeAndAgentLockTenantIds } from './scripts/20260426_022_backfill_service_node_agent_lock_tenant_ids.js';
import { migration as backfillEncryptedCustomHeadersAndAuthConfig } from './scripts/20260426_023_backfill_encrypted_custom_headers_auth_config.js';
import { migration as dropLegacyLockServicenodeIndexes } from './scripts/20260426_024_drop_legacy_lock_servicenode_indexes.js';
import { migration as backfillAgentModelConfigTenantIds } from './scripts/20260503_025_backfill_agent_model_config_tenant_ids.js';
import { migration as scopeProjectAgentPathToTenant } from './scripts/20260503_026_scope_project_agent_path_to_tenant.js';
import { migration as backfillModelConfigTenantIds } from './scripts/20260505_027_backfill_model_config_tenant_ids.js';
import { migration as dropProjectAgentPathUniqueIndex } from './scripts/20260509_028_drop_project_agent_path_unique_index.js';
import { migration as seedAdminGuardrailPiiPermissions } from './scripts/20260509_029_seed_admin_guardrail_pii_permissions.js';
import { migration as backfillCustomProjectSafetyPermissions } from './scripts/20260510_030_backfill_custom_project_safety_permissions.js';
import { migration as fixGuardrailPolicyScopeUniqueIndex } from './scripts/20260510_031_fix_guardrail_policy_scope_unique_index.js';
import { migration as repairWorkflowNameUniquenessIndex } from './scripts/20260511_029_repair_workflow_name_uniqueness_index.js';
import { migration as migrateWorkflowApiNodesToHttpTools } from './scripts/20260514_034_migrate_workflow_api_nodes_to_http_tools.js';
import { migration as reconcileGuardrailPolicyScopeUniqueIndex } from './scripts/20260511_032_reconcile_guardrail_policy_scope_unique_index.js';
import { migration as scopeArchSessionsToSurface } from './scripts/20260512_033_scope_arch_sessions_to_surface.js';
import { migration as backfillVoiceFillerDelay } from './scripts/20260513_034_backfill_voice_filler_delay.js';
import { migration as authProfileProfileType } from './scripts/20260508_019_auth_profile_profile_type.js';
import { migration as endUserOAuthTokenProjectScope } from './scripts/20260508_020_end_user_oauth_token_project_scope.js';
import { migration as projectToolAuthProfileId } from './scripts/20260513_021_project_tool_auth_profile_id.js';
import { migration as repairProjectIdentityIndexes } from './scripts/20260516_035_repair_project_identity_indexes.js';

export interface RegisteredMongoMigrationSpec {
  manifestId: string;
  sourcePath: string;
  registry: 'cli' | 'inventory_only';
  migration: Migration;
}

export const mongoMigrationRegistry = [
  {
    manifestId: 'mongodb.20260211_000.initial-schema-validation',
    sourcePath:
      'packages/database/src/migrations/scripts/20260211_000_initial_schema_validation.ts',
    registry: 'inventory_only',
    migration: initialMigration,
  },
  {
    manifestId: 'mongodb.20260216_001.unified-tool-schema',
    sourcePath: 'packages/database/src/migrations/scripts/20260216_001_unified_tool_schema.ts',
    registry: 'inventory_only',
    migration: unifiedToolSchemaMigration,
  },
  {
    manifestId: 'mongodb.20260216_002.drop-legacy-tool-collections',
    sourcePath:
      'packages/database/src/migrations/scripts/20260216_002_drop_legacy_tool_collections.ts',
    registry: 'inventory_only',
    migration: dropLegacyToolCollectionsMigration,
  },
  {
    manifestId: 'mongodb.20260219_001.unified-credential-store',
    sourcePath: 'packages/database/src/migrations/scripts/20260219_001_unified_credential_store.ts',
    registry: 'inventory_only',
    migration: unifiedCredentialStoreMigration,
  },
  {
    manifestId: 'mongodb.20260225_003.enable-default-llm-features',
    sourcePath:
      'packages/database/src/migrations/scripts/20260225_003_enable_default_llm_features.ts',
    registry: 'inventory_only',
    migration: enableDefaultLlmFeaturesMigration,
  },
  {
    manifestId: 'mongodb.20260227_004.fix-agent-path-schema',
    sourcePath: 'packages/database/src/migrations/scripts/20260227_004_fix_agent_path_schema.ts',
    registry: 'cli',
    migration: agentPathMigration,
  },
  {
    manifestId: 'mongodb.20260227_005.scope-agent-path-to-project',
    sourcePath:
      'packages/database/src/migrations/scripts/20260227_005_scope_agent_path_to_project.ts',
    registry: 'cli',
    migration: scopeAgentPathMigration,
  },
  {
    manifestId: 'mongodb.20260301_006.slack-external-id-team-app',
    sourcePath:
      'packages/database/src/migrations/scripts/20260301_006_slack_external_id_team_app.ts',
    registry: 'cli',
    migration: slackExternalIdMigration,
  },
  {
    manifestId: 'mongodb.20260303_007.add-tenant-id-remove-domain',
    sourcePath:
      'packages/database/src/migrations/scripts/20260303_007_add_tenant_id_remove_domain.ts',
    registry: 'cli',
    migration: addTenantIdMigration,
  },
  {
    manifestId: 'mongodb.20260304_008.fix-verify-token-hash-index',
    sourcePath:
      'packages/database/src/migrations/scripts/20260304_008_fix_verify_token_hash_index.ts',
    registry: 'inventory_only',
    migration: fixVerifyTokenHashIndex,
  },
  {
    manifestId: 'mongodb.20260305_009.seed-workflow-permissions',
    sourcePath:
      'packages/database/src/migrations/scripts/20260305_009_seed_workflow_permissions.ts',
    registry: 'cli',
    migration: seedWorkflowPermissions,
  },
  {
    manifestId: 'mongodb.20260305_010.backfill-message-contact-ids',
    sourcePath:
      'packages/database/src/migrations/scripts/20260305_009_backfill_message_contact_ids.ts',
    registry: 'cli',
    migration: backfillMessageContactIds,
  },
  {
    manifestId: 'mongodb.20260306_011.rename-conversations-to-sessions',
    sourcePath:
      'packages/database/src/migrations/scripts/20260306_011_rename_conversations_to_sessions.ts',
    registry: 'inventory_only',
    migration: renameConversationsToSessions,
  },
  {
    manifestId: 'mongodb.20260307_010.create-human-tasks-collection',
    sourcePath:
      'packages/database/src/migrations/scripts/20260307_010_create_human_tasks_collection.ts',
    registry: 'inventory_only',
    migration: createHumanTasksCollection,
  },
  {
    manifestId: 'mongodb.20260307_012.drop-old-message-idempotency-index',
    sourcePath:
      'packages/database/src/migrations/scripts/20260307_012_drop_old_message_idempotency_index.ts',
    registry: 'cli',
    migration: dropOldMessageIdempotencyIndex,
  },
  {
    manifestId: 'mongodb.20260311_013.seed-dev-enterprise-subscription',
    sourcePath:
      'packages/database/src/migrations/scripts/20260311_013_seed_dev_enterprise_subscription.ts',
    registry: 'cli',
    migration: seedDevEnterpriseSubscription,
  },
  {
    manifestId: 'mongodb.20260319_016.scope-channel-sessions-to-connection',
    sourcePath:
      'packages/database/src/migrations/scripts/20260319_016_scope_channel_sessions_to_connection.ts',
    registry: 'cli',
    migration: scopeChannelSessionsToConnection,
  },
  {
    manifestId: 'mongodb.20260323_017.backfill-message-project-ids',
    sourcePath:
      'packages/database/src/migrations/scripts/20260323_017_backfill_message_project_ids.ts',
    registry: 'cli',
    migration: backfillMessageProjectIds,
  },
  {
    manifestId: 'mongodb.20260416_018.fix-connector-connection-uniqueness-index',
    sourcePath:
      'packages/database/src/migrations/scripts/20260416_018_fix_connector_connection_uniqueness_index.ts',
    registry: 'cli',
    migration: fixConnectorConnectionUniquenessIndex,
  },
  {
    manifestId: 'mongodb.20260420_019.seed-member-project-create-permission',
    sourcePath:
      'packages/database/src/migrations/scripts/20260420_019_seed_member_project_create_permission.ts',
    registry: 'cli',
    migration: seedMemberProjectCreatePermission,
  },
  {
    manifestId: 'mongodb.20260423_020.refresh-token-family-generation',
    sourcePath:
      'packages/database/src/migrations/scripts/20260423_020_refresh_token_family_generation.ts',
    registry: 'cli',
    migration: refreshTokenFamilyGeneration,
  },
  {
    manifestId: 'mongodb.20260423_022.fix-workflow-name-uniqueness-index',
    sourcePath:
      'packages/database/src/migrations/scripts/20260423_022_fix_workflow_name_uniqueness_index.ts',
    registry: 'cli',
    migration: fixWorkflowNameUniquenessIndex,
  },
  {
    manifestId: 'mongodb.20260423_021.enforce-refresh-token-generation-uniqueness',
    sourcePath:
      'packages/database/src/migrations/scripts/20260423_021_enforce_refresh_token_generation_uniqueness.ts',
    registry: 'cli',
    migration: enforceRefreshTokenGenerationUniqueness,
  },
  {
    manifestId: 'mongodb.20260426_022.backfill-service-node-and-agent-lock-tenant-ids',
    sourcePath:
      'packages/database/src/migrations/scripts/20260426_022_backfill_service_node_agent_lock_tenant_ids.ts',
    registry: 'cli',
    migration: backfillServiceNodeAndAgentLockTenantIds,
  },
  {
    manifestId: 'mongodb.20260426_023.backfill-encrypted-custom-headers-and-auth-config',
    sourcePath:
      'packages/database/src/migrations/scripts/20260426_023_backfill_encrypted_custom_headers_auth_config.ts',
    registry: 'cli',
    migration: backfillEncryptedCustomHeadersAndAuthConfig,
  },
  {
    manifestId: 'mongodb.20260426_024.drop-legacy-lock-servicenode-indexes',
    sourcePath:
      'packages/database/src/migrations/scripts/20260426_024_drop_legacy_lock_servicenode_indexes.ts',
    registry: 'cli',
    migration: dropLegacyLockServicenodeIndexes,
  },
  {
    manifestId: 'mongodb.20260503_025.backfill-agent-model-config-tenant-ids',
    sourcePath:
      'packages/database/src/migrations/scripts/20260503_025_backfill_agent_model_config_tenant_ids.ts',
    registry: 'cli',
    migration: backfillAgentModelConfigTenantIds,
  },
  {
    manifestId: 'mongodb.20260503_026.scope-project-agent-path-to-tenant',
    sourcePath:
      'packages/database/src/migrations/scripts/20260503_026_scope_project_agent_path_to_tenant.ts',
    registry: 'cli',
    migration: scopeProjectAgentPathToTenant,
  },
  {
    manifestId: 'mongodb.20260505_027.backfill-model-config-tenant-ids',
    sourcePath:
      'packages/database/src/migrations/scripts/20260505_027_backfill_model_config_tenant_ids.ts',
    registry: 'cli',
    migration: backfillModelConfigTenantIds,
  },
  {
    manifestId: 'mongodb.20260509_028.drop-project-agent-path-unique-index',
    sourcePath:
      'packages/database/src/migrations/scripts/20260509_028_drop_project_agent_path_unique_index.ts',
    registry: 'cli',
    migration: dropProjectAgentPathUniqueIndex,
  },
  {
    manifestId: 'mongodb.20260509_029.seed-admin-guardrail-pii-permissions',
    sourcePath:
      'packages/database/src/migrations/scripts/20260509_029_seed_admin_guardrail_pii_permissions.ts',
    registry: 'cli',
    migration: seedAdminGuardrailPiiPermissions,
  },
  {
    manifestId: 'mongodb.20260510_030.backfill-custom-project-safety-permissions',
    sourcePath:
      'packages/database/src/migrations/scripts/20260510_030_backfill_custom_project_safety_permissions.ts',
    registry: 'cli',
    migration: backfillCustomProjectSafetyPermissions,
  },
  {
    manifestId: 'mongodb.20260510_031.fix-guardrail-policy-scope-unique-index',
    sourcePath:
      'packages/database/src/migrations/scripts/20260510_031_fix_guardrail_policy_scope_unique_index.ts',
    registry: 'cli',
    migration: fixGuardrailPolicyScopeUniqueIndex,
  },
  {
    manifestId: 'mongodb.20260511_029.repair-workflow-name-uniqueness-index',
    sourcePath:
      'packages/database/src/migrations/scripts/20260511_029_repair_workflow_name_uniqueness_index.ts',
    registry: 'cli',
    migration: repairWorkflowNameUniquenessIndex,
  },
  {
    manifestId: 'mongodb.20260514_034.migrate-workflow-api-nodes-to-http-tools',
    sourcePath:
      'packages/database/src/migrations/scripts/20260514_034_migrate_workflow_api_nodes_to_http_tools.ts',
    registry: 'cli',
    migration: migrateWorkflowApiNodesToHttpTools,
  },
  {
    manifestId: 'mongodb.20260511_032.reconcile-guardrail-policy-scope-unique-index',
    sourcePath:
      'packages/database/src/migrations/scripts/20260511_032_reconcile_guardrail_policy_scope_unique_index.ts',
    registry: 'cli',
    migration: reconcileGuardrailPolicyScopeUniqueIndex,
  },
  {
    manifestId: 'mongodb.20260512_033.scope-arch-sessions-to-surface',
    sourcePath:
      'packages/database/src/migrations/scripts/20260512_033_scope_arch_sessions_to_surface.ts',
    registry: 'cli',
    migration: scopeArchSessionsToSurface,
  },
  {
    manifestId: 'mongodb.20260513_034.backfill-voice-filler-delay',
    sourcePath:
      'packages/database/src/migrations/scripts/20260513_034_backfill_voice_filler_delay.ts',
    registry: 'cli',
    migration: backfillVoiceFillerDelay,
  },
  {
    manifestId: 'mongodb.20260508_019.auth-profile-profile-type',
    sourcePath:
      'packages/database/src/migrations/scripts/20260508_019_auth_profile_profile_type.ts',
    registry: 'cli',
    migration: authProfileProfileType,
  },
  {
    manifestId: 'mongodb.20260508_020.end-user-oauth-token-project-scope',
    sourcePath:
      'packages/database/src/migrations/scripts/20260508_020_end_user_oauth_token_project_scope.ts',
    registry: 'cli',
    migration: endUserOAuthTokenProjectScope,
  },
  {
    manifestId: 'mongodb.20260513_021.project-tool-auth-profile-id',
    sourcePath:
      'packages/database/src/migrations/scripts/20260513_021_project_tool_auth_profile_id.ts',
    registry: 'cli',
    migration: projectToolAuthProfileId,
  },
  {
    manifestId: 'mongodb.20260516_035.repair-project-identity-indexes',
    sourcePath:
      'packages/database/src/migrations/scripts/20260516_035_repair_project_identity_indexes.ts',
    registry: 'cli',
    migration: repairProjectIdentityIndexes,
  },
] as const satisfies readonly RegisteredMongoMigrationSpec[];

export type MongoMigrationManifestId = (typeof mongoMigrationRegistry)[number]['manifestId'];

export const mongoMigrations: Migration[] = mongoMigrationRegistry
  .filter((spec) => spec.registry === 'cli')
  .map((spec) => spec.migration);

export function resolveMongoMigrationManifestId(migration: Migration): string {
  const directMatch = mongoMigrationRegistry.find((spec) => spec.migration === migration);
  if (directMatch) {
    return directMatch.manifestId;
  }

  const legacyMatch = mongoMigrationRegistry.find(
    (spec) =>
      spec.migration.version === migration.version &&
      spec.migration.description === migration.description,
  );
  if (legacyMatch) {
    return legacyMatch.manifestId;
  }

  return `mongodb.${migration.version}`;
}
