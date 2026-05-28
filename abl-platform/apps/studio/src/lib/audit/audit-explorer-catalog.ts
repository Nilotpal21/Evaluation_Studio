export const AUDIT_EXPLORER_CATEGORIES = [
  'auth_access',
  'workspace_governance',
  'project_agent_configuration',
  'tools_modules_credentials',
  'data_protection',
  'kms',
  'connector_configuration',
  'archives_retention_git',
] as const;

export type AuditExplorerCategory = (typeof AUDIT_EXPLORER_CATEGORIES)[number];

export interface AuditExplorerCategoryDefinition {
  id: AuditExplorerCategory;
  label: string;
  values: readonly string[];
  prefixes?: readonly string[];
}

export const AUDIT_EXPLORER_CATEGORY_DEFINITIONS: readonly AuditExplorerCategoryDefinition[] = [
  {
    id: 'auth_access',
    label: 'Auth & access',
    values: [
      'auth.user.failure',
      'auth.user.failed',
      'login',
      'logout',
      'login_failed',
      'account_locked',
      'token_revoked',
      'all_tokens_revoked',
      'sso_login',
      'sso_login_failed',
      'mfa_setup_confirmed',
      'mfa_verified',
      'mfa_failed',
      'mfa_locked',
      'mfa_disabled',
      'recovery_code_used',
      'signup',
      'email_verified',
      'password_reset_requested',
      'password_reset_completed',
      'permission.denied',
      'rate_limit.hit',
      'device_auth_approved',
      'device_auth_denied',
      'device_auth_completed',
      'debug_token_created',
      'debug_token_revoked',
      'debug_access_denied',
      'identity_verified',
    ],
  },
  {
    id: 'workspace_governance',
    label: 'Workspace governance',
    values: [
      'workspace_created',
      'workspace_archived',
      'workspace_restored',
      'member_joined',
      'member_added',
      'member_role_changed',
      'member_removed',
      'member_deactivated',
      'member_locked',
      'member_reactivated',
      'member_suspended',
      'member_unlocked',
      'sessions_revoked',
      'invitation_sent',
      'invitation_accepted',
      'invitation_revoked',
      'invitation_resent',
      'organization_created',
      'workspace_linked_to_org',
      'sso_config_created',
      'sso_domain_verified',
      'sso_assertion_replay_detected',
    ],
  },
  {
    id: 'project_agent_configuration',
    label: 'Project, agent & workflow configuration',
    values: [
      'project_created',
      'project_updated',
      'project_deleted',
      'project_archived',
      'project_restored',
      'project_member_added',
      'project_member_removed',
      'project_member_role_changed',
      'agent.created',
      'agent.updated',
      'agent.promoted',
      'agent.rolled_back',
      'agent.deprecated',
      'agent.version_created',
      'agent.dsl_updated',
      'agent_added',
      'agent_updated',
      'agent_dsl_updated',
      'agent_removed',
      'workflow.created',
      'workflow.updated',
      'workflow.archived',
      'workflow.deleted',
      'workflow.version_activated',
      'workflow.version_deactivated',
      'workflow.version_created',
      'workflow.version_deleted',
      'prompt.created',
      'prompt.version_created',
      'prompt.version_promoted',
      'prompt.version_archived',
    ],
  },
  {
    id: 'tools_modules_credentials',
    label: 'Tools, modules & credentials',
    values: [
      'tool.created',
      'tool.updated',
      'tool.deleted',
      'tool_created',
      'tool_updated',
      'tool_deleted',
      'credential_created',
      'credential_updated',
      'credential_deleted',
      'model_config_created',
      'model_config_updated',
      'model_config_deleted',
      'module_enabled',
      'module_disabled',
      'module_published',
      'module_promoted',
      'module_imported',
      'module_removed',
      'module_release_archived',
      'module_delete_blocked',
      'module_upgraded',
      'service_node_created',
      'service_node_updated',
      'service_node_deleted',
      'AUTH_PROFILE_CREATED',
      'AUTH_PROFILE_UPDATED',
      'AUTH_PROFILE_DELETED',
      'AUTH_PROFILE_REVOKED',
      'AUTH_PROFILE_SECRET_ROTATED',
      'AUTH_PROFILE_SECRETS_ROTATED',
      'AUTH_PROFILE_OAUTH_COMPLETED',
      'AUTH_PROFILE_OAUTH_FAILED',
      'AUTH_PROFILE_OAUTH_REVOKED',
      'AUTH_PROFILE_CONSUMER_LINKED',
      'AUTH_PROFILE_CONSUMER_UNLINKED',
      'AUTH_PROFILE_ACCESS_DENIED',
      'AUTH_PROFILE_DECRYPTION_FAILED',
      'AUTH_PROFILE_ADMIN_VIEWED',
      'AUTH_PROFILE_SECRETS_ACCESSED',
      'AUTH_PROFILE_STATUS_CHANGED',
    ],
  },
  {
    id: 'data_protection',
    label: 'Data protection',
    values: [
      'pii.accessed',
      'gdpr_deletion_completed',
      'gdpr_deletion_failed',
      'gdpr_sla_escalated',
      'contact.gdpr_erased',
      'consent_granted',
      'consent_revoked',
    ],
    prefixes: ['pii.', 'gdpr_'],
  },
  {
    id: 'kms',
    label: 'KMS',
    values: [
      'encrypt',
      'decrypt',
      'rotate',
      'config_update',
      'external_kms_validation',
      'force_rotate',
      'batch_reencryption',
      'dek_expiry_transition',
      'dek_usage_transition',
      'dek_destruction',
    ],
    prefixes: ['kms.', 'tenant_environment_config_', 'project_config_', 'environment_config_'],
  },
  {
    id: 'connector_configuration',
    label: 'Connector configuration',
    values: [
      'connector.created',
      'connector.updated',
      'connector.deleted',
      'connector.enabled',
      'connector.disabled',
      'connector.permission_updated',
      'connector.auth_connected',
      'connector.auth_revoked',
      'search.index.created',
      'search.index.updated',
      'search.index.deleted',
      'search.source.added',
      'search.source.removed',
      'search.vocabulary.updated',
    ],
  },
  {
    id: 'archives_retention_git',
    label: 'Archives, retention & Git',
    values: [
      'archive_created',
      'archive_downloaded',
      'archive_deleted',
      'git_integration_created',
      'git_integration_updated',
      'git_integration_deleted',
      'git_pull_completed',
      'git_push_completed',
      'git_promotion_completed',
      'retention_sweep_completed',
      'retention_sweep_failed',
      'audit_export_downloaded',
    ],
  },
];

const CATEGORY_BY_ID = new Map(
  AUDIT_EXPLORER_CATEGORY_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getAuditExplorerCategoryDefinition(
  category: AuditExplorerCategory,
): AuditExplorerCategoryDefinition {
  return CATEGORY_BY_ID.get(category) ?? AUDIT_EXPLORER_CATEGORY_DEFINITIONS[0];
}

export function getAuditExplorerCategoryValues(categories: readonly AuditExplorerCategory[]) {
  const values = new Set<string>();
  const prefixes = new Set<string>();

  for (const category of categories) {
    const definition = getAuditExplorerCategoryDefinition(category);
    definition.values.forEach((value) => values.add(value));
    definition.prefixes?.forEach((prefix) => prefixes.add(prefix));
  }

  return {
    values: [...values],
    prefixes: [...prefixes],
  };
}

export function getComplianceAuditExplorerValues() {
  return getAuditExplorerCategoryValues(AUDIT_EXPLORER_CATEGORIES);
}

export function resolveAuditExplorerCategory(action: string, eventType?: string | null): string {
  const candidates = [eventType, action].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );

  for (const definition of AUDIT_EXPLORER_CATEGORY_DEFINITIONS) {
    if (
      candidates.some(
        (candidate) =>
          definition.values.includes(candidate) ||
          definition.prefixes?.some((prefix) => candidate.startsWith(prefix)),
      )
    ) {
      return definition.id;
    }
  }

  return 'uncategorized';
}

export function getAuditExplorerCategoryLabel(category: string): string {
  return CATEGORY_BY_ID.get(category as AuditExplorerCategory)?.label ?? 'Uncategorized';
}

export function resolveAuditExplorerCategoryLabel(
  action: string,
  eventType?: string | null,
): string {
  return getAuditExplorerCategoryLabel(resolveAuditExplorerCategory(action, eventType));
}
