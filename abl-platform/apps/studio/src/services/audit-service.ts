/**
 * Audit Logging Service
 *
 * Records security-relevant events for compliance and debugging.
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeForwardedIp } from '@/lib/get-client-ip';
import { publishStudioAuditPipelineEvent } from '@/lib/studio-audit-pipeline-writer';
import {
  queryStudioAuditLogsFromClickHouse,
  type StudioClickHouseAuditQueryOptions,
} from '@/lib/studio-clickhouse-audit-reader';
import type { Environment, SharedAuditEnvelope } from '@abl/compiler/platform';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { deriveRetentionClass } from '@abl/compiler/platform/stores';

const log = createLogger('studio-audit-service');

interface StudioAuditContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
}

const auditContextStorage = new AsyncLocalStorage<StudioAuditContext>();

export function setCurrentAuditContext(context: StudioAuditContext): void {
  const existing = auditContextStorage.getStore() ?? {};
  auditContextStorage.enterWith({ ...existing, ...context });
}

function getCurrentRequestId(): string | undefined {
  return auditContextStorage.getStore()?.requestId;
}

function getCurrentTenantId(): string | undefined {
  return auditContextStorage.getStore()?.tenantId;
}

// =============================================================================
// TYPES
// =============================================================================

export interface AuditEvent {
  userId?: string;
  tenantId?: string;
  action: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceInvitationAcceptanceAuditEvent {
  userId: string;
  tenantId: string;
  role: string;
  membershipCreated: boolean;
  invitationId?: string;
  acceptMethod?: 'token' | 'picker' | 'auto';
  ip?: string;
  userAgent?: string;
}

// =============================================================================
// AUDIT ACTIONS
// =============================================================================

export const AuditActions = {
  // Authentication
  LOGIN: 'login',
  LOGOUT: 'logout',
  LOGIN_FAILED: 'login_failed',
  ACCOUNT_LOCKED: 'account_locked',
  TOKEN_REFRESH: 'token_refresh',
  TOKEN_REVOKED: 'token_revoked',
  ALL_TOKENS_REVOKED: 'all_tokens_revoked',

  // Device Auth
  DEVICE_AUTH_STARTED: 'device_auth_started',
  DEVICE_AUTH_APPROVED: 'device_auth_approved',
  DEVICE_AUTH_DENIED: 'device_auth_denied',
  DEVICE_AUTH_COMPLETED: 'device_auth_completed',

  // Debug
  DEBUG_TOKEN_CREATED: 'debug_token_created',
  DEBUG_TOKEN_REVOKED: 'debug_token_revoked',
  DEBUG_SUBSCRIBED: 'debug_subscribed',
  DEBUG_ACCESS_DENIED: 'debug_access_denied',
  DEBUG_TOOL_EXECUTED: 'debug_tool_executed',

  // Projects
  PROJECT_CREATED: 'project_created',
  PROJECT_UPDATED: 'project_updated',
  PROJECT_DELETED: 'project_deleted',
  PROJECT_ARCHIVED: 'project_archived',
  PROJECT_RESTORED: 'project_restored',
  PROJECT_MEMBER_ADDED: 'project_member_added',
  PROJECT_MEMBER_REMOVED: 'project_member_removed',
  PROJECT_MEMBER_ROLE_CHANGED: 'project_member_role_changed',

  // Agents
  AGENT_ADDED: 'agent_added',
  AGENT_UPDATED: 'agent_updated',
  AGENT_DSL_UPDATED: 'agent_dsl_updated',
  AGENT_REMOVED: 'agent_removed',

  // Credentials
  CREDENTIAL_CREATED: 'credential_created',
  CREDENTIAL_UPDATED: 'credential_updated',
  CREDENTIAL_DELETED: 'credential_deleted',

  // Model Configs
  MODEL_CONFIG_CREATED: 'model_config_created',
  MODEL_CONFIG_UPDATED: 'model_config_updated',
  MODEL_CONFIG_DELETED: 'model_config_deleted',

  // Service Nodes
  SERVICE_NODE_CREATED: 'service_node_created',
  SERVICE_NODE_UPDATED: 'service_node_updated',
  SERVICE_NODE_DELETED: 'service_node_deleted',

  // MFA
  MFA_SETUP_CONFIRMED: 'mfa_setup_confirmed',
  MFA_VERIFIED: 'mfa_verified',
  MFA_FAILED: 'mfa_failed',
  MFA_LOCKED: 'mfa_locked',
  MFA_DISABLED: 'mfa_disabled',
  RECOVERY_CODE_USED: 'recovery_code_used',

  // Email auth
  SIGNUP: 'signup',
  EMAIL_VERIFIED: 'email_verified',
  PASSWORD_RESET_REQUESTED: 'password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'password_reset_completed',

  // Workspace
  WORKSPACE_CREATED: 'workspace_created',
  WORKSPACE_ARCHIVED: 'workspace_archived',
  WORKSPACE_RESTORED: 'workspace_restored',

  // Members
  MEMBER_JOINED: 'member_joined',
  MEMBER_ADDED: 'member_added',
  MEMBER_ROLE_CHANGED: 'member_role_changed',
  MEMBER_REMOVED: 'member_removed',
  MEMBER_DEACTIVATED: 'member_deactivated',
  MEMBER_LOCKED: 'member_locked',
  MEMBER_REACTIVATED: 'member_reactivated',
  MEMBER_SUSPENDED: 'member_suspended',
  MEMBER_UNLOCKED: 'member_unlocked',
  SESSIONS_REVOKED: 'sessions_revoked',

  // Invitations
  INVITATION_SENT: 'invitation_sent',
  INVITATION_ACCEPTED: 'invitation_accepted',
  INVITATION_REVOKED: 'invitation_revoked',
  INVITATION_RESENT: 'invitation_resent',

  // Organizations
  ORGANIZATION_CREATED: 'organization_created',
  WORKSPACE_LINKED_TO_ORG: 'workspace_linked_to_org',

  // SSO
  SSO_LOGIN: 'sso_login',
  SSO_LOGIN_FAILED: 'sso_login_failed',
  SSO_CONFIG_CREATED: 'sso_config_created',
  SSO_DOMAIN_VERIFIED: 'sso_domain_verified',
  SSO_ASSERTION_REPLAY_DETECTED: 'sso_assertion_replay_detected',

  // Archives
  ARCHIVE_CREATED: 'archive_created',
  ARCHIVE_DOWNLOADED: 'archive_downloaded',
  ARCHIVE_DELETED: 'archive_deleted',
  AUDIT_EXPORT_DOWNLOADED: 'audit_export_downloaded',

  // Git
  GIT_INTEGRATION_CREATED: 'git_integration_created',
  GIT_INTEGRATION_UPDATED: 'git_integration_updated',
  GIT_INTEGRATION_DELETED: 'git_integration_deleted',
  GIT_PULL_COMPLETED: 'git_pull_completed',
  GIT_PUSH_COMPLETED: 'git_push_completed',
  GIT_PROMOTION_COMPLETED: 'git_promotion_completed',
  GIT_WEBHOOK_ACCEPTED: 'git_webhook_accepted',

  // Retention
  RETENTION_SWEEP_COMPLETED: 'retention_sweep_completed',
  RETENTION_SWEEP_FAILED: 'retention_sweep_failed',

  // GDPR
  GDPR_DELETION_COMPLETED: 'gdpr_deletion_completed',
  GDPR_DELETION_FAILED: 'gdpr_deletion_failed',
  GDPR_SLA_ESCALATED: 'gdpr_sla_escalated',

  // Tools
  TOOL_CREATED: 'tool_created',
  TOOL_UPDATED: 'tool_updated',
  TOOL_DELETED: 'tool_deleted',

  // Modules
  MODULE_ENABLED: 'module_enabled',
  MODULE_DISABLED: 'module_disabled',
  MODULE_PUBLISHED: 'module_published',
  MODULE_PROMOTED: 'module_promoted',
  MODULE_IMPORTED: 'module_imported',
  MODULE_REMOVED: 'module_removed',
  MODULE_RELEASE_ARCHIVED: 'module_release_archived',
  MODULE_DELETE_BLOCKED: 'module_delete_blocked',
  MODULE_UPGRADED: 'module_upgraded',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];

// =============================================================================
// METADATA SANITIZATION
// =============================================================================

const SENSITIVE_PATTERNS = [
  'password',
  'hash',
  'token',
  'secret',
  'apikey',
  'authorization',
  'cookie',
  'credential',
];

function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!metadata) return metadata;
  const sanitized = { ...metadata };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_PATTERNS.some((p) => key.toLowerCase().includes(p))) {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
}

function getMetadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getMetadataEnvironment(metadata: Record<string, unknown>): Environment | null {
  const environment = getMetadataString(metadata, 'environment');
  if (environment === 'dev' || environment === 'staging' || environment === 'production') {
    return environment;
  }
  return null;
}

function buildStudioAuditEnvelope(
  event: AuditEvent,
  userId: string | undefined,
  tenantId: string | undefined,
  metadata: Record<string, unknown>,
  timestamp?: Date,
): SharedAuditEnvelope {
  return {
    schemaVersion: 2,
    source: 'studio',
    eventType: event.action,
    action: event.action,
    actorId: userId ?? null,
    actorType: userId ? 'user' : 'system',
    tenantId: tenantId ?? null,
    projectId: getMetadataString(metadata, 'projectId'),
    resourceType: getMetadataString(metadata, 'resourceType'),
    resourceId: getMetadataString(metadata, 'resourceId'),
    environment: getMetadataEnvironment(metadata),
    traceId: getMetadataString(metadata, 'traceId'),
    ipAddress: normalizeForwardedIp(event.ip) ?? null,
    userAgent: event.userAgent ?? null,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
    metadataEncoding: 'object',
    retentionClass: deriveRetentionClass({
      source: 'studio',
      eventType: event.action,
      action: event.action,
      explicitRetentionClass: null,
    }),
    expiresAt: null,
    timestamp,
  };
}

function buildStudioAuditPipelineEvent(envelope: SharedAuditEnvelope): Record<string, unknown> {
  return {
    auditId: randomUUID(),
    stream: 'shared',
    schemaVersion: envelope.schemaVersion,
    timestamp: envelope.timestamp ?? new Date(),
    source: envelope.source,
    eventType: envelope.eventType,
    action: envelope.action,
    actorId: envelope.actorId,
    actorType: envelope.actorType,
    tenantId: envelope.tenantId,
    projectId: envelope.projectId,
    resourceType: envelope.resourceType,
    resourceId: envelope.resourceId,
    environment: envelope.environment,
    traceId: envelope.traceId,
    ipAddress: envelope.ipAddress,
    userAgent: envelope.userAgent,
    metadata: envelope.metadata,
    metadataEncoding: envelope.metadataEncoding,
    retentionClass: envelope.retentionClass,
    expiresAt: envelope.expiresAt ?? null,
    oldValue: envelope.oldValue ?? null,
    newValue: envelope.newValue ?? null,
  };
}

function createStudioServiceQueryOptions(
  scope: StudioClickHouseAuditQueryOptions['scope'],
  userId: string,
  tenantId: string,
  options: {
    limit?: number;
    offset?: number;
    action?: string;
    from?: string | null;
    to?: string | null;
  },
): StudioClickHouseAuditQueryOptions {
  return {
    scope,
    personalScopeMode: 'tenant-safe',
    userId,
    tenantId,
    action: options.action,
    from: options.from,
    to: options.to,
    limit: options.limit ?? (scope === 'workspace' ? 100 : 50),
    offset: options.offset ?? 0,
  };
}

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Log an audit event
 */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    const timestamp = new Date();
    // Auto-populate from context if not explicitly provided
    const requestId = getCurrentRequestId();

    // Merge requestId into metadata for correlation, then sanitize PII
    const rawMetadata: Record<string, unknown> = { ...event.metadata };
    if (requestId) {
      rawMetadata.requestId = requestId;
    }
    const metadata = sanitizeAuditMetadata(rawMetadata);
    const userId = event.userId || auditContextStorage.getStore()?.userId;
    const tenantId = event.tenantId || getCurrentTenantId();
    const envelope = buildStudioAuditEnvelope(
      event,
      userId || undefined,
      tenantId || undefined,
      metadata,
      timestamp,
    );

    publishStudioAuditPipelineEvent(buildStudioAuditPipelineEvent(envelope), envelope.tenantId);
  } catch (error) {
    // Don't let audit logging failures break the app
    log.error('Failed to write studio audit event', {
      action: event.action,
      userId: event.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    // M4: Fallback logging to stderr so audit events are never silently lost
    process.stderr.write(
      JSON.stringify({
        type: 'audit_fallback',
        event: { action: event.action, userId: event.userId },
        error: String(error),
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
  }
}

export async function logWorkspaceInvitationAcceptanceAudit(
  event: WorkspaceInvitationAcceptanceAuditEvent,
): Promise<void> {
  await logAuditEvent({
    userId: event.userId,
    tenantId: event.tenantId,
    action: AuditActions.INVITATION_ACCEPTED,
    ip: event.ip,
    userAgent: event.userAgent,
    metadata: {
      role: event.role,
      acceptMethod: event.acceptMethod,
      membershipCreated: event.membershipCreated,
      resourceType: 'invitation',
      resourceId: event.invitationId,
    },
  });

  if (!event.membershipCreated) {
    return;
  }

  await logAuditEvent({
    userId: event.userId,
    tenantId: event.tenantId,
    action: AuditActions.MEMBER_JOINED,
    ip: event.ip,
    userAgent: event.userAgent,
    metadata: {
      role: event.role,
      acceptMethod: event.acceptMethod,
      resourceType: 'tenant_member',
      resourceId: event.userId,
      source: 'invitation',
    },
  });
}

/**
 * Get audit logs for a user
 */
export async function getUserAuditLogs(
  userId: string,
  tenantId: string,
  options: {
    limit?: number;
    offset?: number;
    action?: string;
  } = {},
) {
  const result = await queryStudioAuditLogsFromClickHouse(
    createStudioServiceQueryOptions('personal', userId, tenantId, options),
  );

  return result.logs;
}

/**
 * Get recent audit logs (admin)
 */
export async function getRecentAuditLogs(
  tenantId: string,
  options: {
    limit?: number;
    action?: string;
    since?: Date;
  } = {},
) {
  const result = await queryStudioAuditLogsFromClickHouse(
    createStudioServiceQueryOptions('workspace', '', tenantId, {
      limit: options.limit ?? 100,
      action: options.action,
      from: options.since?.toISOString() ?? null,
      to: null,
    }),
  );

  return result.logs;
}
