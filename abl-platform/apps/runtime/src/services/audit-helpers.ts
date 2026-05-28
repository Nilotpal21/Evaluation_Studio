/**
 * Audit Helper Functions
 *
 * Fire-and-forget helpers for logging structured audit events.
 * Routes all writes through AuditStore.log() with full 14-field structured records.
 * Never blocks the calling request — errors are caught and logged.
 */

import type {
  AuditEventType,
  Contact,
  WorkflowDefinition,
} from '@abl/compiler/platform/core/types';
import type { LogAuditParams } from '@abl/compiler/platform/stores/audit-store.js';
import type { IPromptLibraryItem, IPromptLibraryVersion } from '@agent-platform/database/models';
import { getAuditStore } from './audit-store-singleton.js';
import { createLogger } from '@abl/compiler/platform';
import type { ContactAuditEvent } from '../contexts/contact/infrastructure/contact-audit.js';
import { getRuntimeAuditEnvironment } from './audit-environment.js';

const log = createLogger('audit-helpers');

function currentAuditEnvironment(): LogAuditParams['environment'] {
  return getRuntimeAuditEnvironment();
}

async function writeAuditLog(params: LogAuditParams): Promise<void> {
  try {
    const store = getAuditStore();
    if (!store) return;
    await store.log({ ...params, environment: currentAuditEnvironment() });
  } catch (err) {
    log.error('Failed to write audit log', {
      action: params.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function getContactLifecycleEventType(
  action: ContactAuditEvent['action'],
): LogAuditParams['eventType'] {
  switch (action) {
    case 'contact.created':
      return 'contact.created';
    case 'contact.session_linked':
      return 'contact.linked';
    case 'contact.gdpr_erased':
      return 'contact.deleted';
    case 'contact.resolved':
    case 'contact.merged':
    case 'contact.self_merged':
    case 'contact.identity_added':
      return 'contact.updated';
  }
}

export async function emitContactLifecycleAudit(event: ContactAuditEvent): Promise<void> {
  await writeAuditLog({
    tenantId: event.tenantId,
    eventType: getContactLifecycleEventType(event.action),
    actor: 'contact-context',
    actorType: 'system',
    resourceType: 'contact',
    resourceId: event.contactId,
    environment: currentAuditEnvironment(),
    action: event.action,
    metadata: {
      tenantId: event.tenantId,
      ...(event.metadata ?? {}),
      emittedAt: event.timestamp.toISOString(),
    },
  });
}

// =============================================================================
// CONTACT AUDIT HELPERS
// =============================================================================

export async function auditContactCreated(contact: Contact, actor: string): Promise<void> {
  await writeAuditLog({
    tenantId: contact.tenantId,
    eventType: 'contact.created',
    actor,
    actorType: 'user',
    resourceType: 'contact',
    resourceId: contact.id,
    environment: currentAuditEnvironment(),
    action: 'contact.created',
    metadata: {
      tenantId: contact.tenantId,
      type: contact.type,
      identityType: contact.identityType,
    },
  });
}

export async function auditContactUpdated(
  contactId: string,
  oldValue: Record<string, unknown>,
  newValue: Record<string, unknown>,
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'contact.updated',
    actor,
    actorType: 'user',
    resourceType: 'contact',
    resourceId: contactId,
    environment: currentAuditEnvironment(),
    action: 'contact.updated',
    oldValue,
    newValue,
    metadata: { tenantId },
  });
}

export async function auditContactDeleted(
  contactId: string,
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'contact.deleted',
    actor,
    actorType: 'user',
    resourceType: 'contact',
    resourceId: contactId,
    environment: currentAuditEnvironment(),
    action: 'contact.deleted',
    metadata: { tenantId },
  });
}

export async function auditContactLinked(
  sessionId: string,
  contactId: string,
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'contact.linked',
    actor,
    actorType: 'user',
    resourceType: 'contact',
    resourceId: contactId,
    environment: currentAuditEnvironment(),
    action: 'contact.linked',
    metadata: { tenantId, sessionId },
  });
}

// =============================================================================
// WORKFLOW AUDIT HELPERS
// =============================================================================

export async function auditWorkflowCreated(
  workflow: WorkflowDefinition,
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: workflow.tenantId,
    projectId: workflow.projectId,
    eventType: 'workflow.created',
    actor,
    actorType: 'user',
    resourceType: 'workflow_definition',
    resourceId: workflow.id,
    environment: currentAuditEnvironment(),
    action: 'workflow.created',
    metadata: {
      tenantId: workflow.tenantId,
      name: workflow.name,
      type: workflow.type,
    },
  });
}

export async function auditWorkflowUpdated(
  workflowId: string,
  oldValue: Record<string, unknown>,
  newValue: Record<string, unknown>,
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'workflow.updated',
    actor,
    actorType: 'user',
    resourceType: 'workflow_definition',
    resourceId: workflowId,
    environment: currentAuditEnvironment(),
    action: 'workflow.updated',
    oldValue,
    newValue,
    metadata: { tenantId },
  });
}

export async function auditWorkflowArchived(
  workflowId: string,
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'workflow.archived',
    actor,
    actorType: 'user',
    resourceType: 'workflow_definition',
    resourceId: workflowId,
    environment: currentAuditEnvironment(),
    action: 'workflow.archived',
    metadata: { tenantId },
  });
}

export async function auditSessionModified(
  sessionId: string,
  action: string,
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'session.modified',
    actor,
    actorType: 'user',
    resourceType: 'session',
    resourceId: sessionId,
    environment: currentAuditEnvironment(),
    action: `session.${action}`,
    metadata: { tenantId, action },
  });
}

// =============================================================================
// VERSION AUDIT HELPERS
// =============================================================================

export async function auditVersionCreated(
  params: {
    projectId: string;
    agentName: string;
    version: string;
    versionId: string;
    sourceHash: string;
  },
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    projectId: params.projectId,
    eventType: 'agent.version_created',
    actor,
    actorType: 'user',
    resourceType: 'agent',
    resourceId: params.agentName,
    environment: currentAuditEnvironment(),
    action: 'version.created',
    metadata: { tenantId, ...params },
  });
}

export async function auditVersionPromoted(
  params: {
    projectId: string;
    agentName: string;
    version: string;
    fromStatus: string;
    toStatus: string;
  },
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    projectId: params.projectId,
    eventType: 'agent.promoted',
    actor,
    actorType: 'user',
    resourceType: 'agent',
    resourceId: params.agentName,
    environment: currentAuditEnvironment(),
    action: 'version.promoted',
    metadata: { tenantId, ...params },
  });
}

export async function auditDslUpdated(
  params: { projectId: string; agentName: string; previousContentHash?: string },
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    projectId: params.projectId,
    eventType: 'agent.dsl_updated',
    actor,
    actorType: 'user',
    resourceType: 'agent',
    resourceId: params.agentName,
    environment: currentAuditEnvironment(),
    action: 'agent.dsl_updated',
    metadata: { tenantId, ...params },
  });
}

// =============================================================================
// TEST CONTEXT AUDIT HELPERS
// =============================================================================

export async function auditContextInjected(
  sessionId: string,
  actor: string,
  tenantId?: string,
  injectedKeys?: string[],
  source?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'session.context_injected',
    actor,
    actorType: 'user',
    resourceType: 'session',
    resourceId: sessionId,
    environment: currentAuditEnvironment(),
    action: 'session.context_injected',
    metadata: { tenantId, injectedKeys, source },
  });
}

export async function auditToolMockSet(
  sessionId: string,
  actor: string,
  tenantId?: string,
  mockCount?: number,
  toolNames?: string[],
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'session.tool_mock_set',
    actor,
    actorType: 'user',
    resourceType: 'session',
    resourceId: sessionId,
    environment: currentAuditEnvironment(),
    action: 'session.tool_mock_set',
    metadata: { tenantId, mockCount, toolNames },
  });
}

export async function auditTestSessionCreated(
  sessionId: string,
  actor: string,
  tenantId?: string,
  injectedKeys?: string[],
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'session.test_created',
    actor,
    actorType: 'user',
    resourceType: 'session',
    resourceId: sessionId,
    environment: currentAuditEnvironment(),
    action: 'session.test_created',
    metadata: { tenantId, injectedKeys, isTest: true },
  });
}

// =============================================================================
// SUBSCRIPTION AUDIT HELPERS
// =============================================================================

export async function auditSubscriptionCreated(
  params: { subscriptionId: string; callbackUrl: string; projectId: string; events: string[] },
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    projectId: params.projectId,
    eventType: 'channel.configured' as any,
    actor,
    actorType: 'user',
    resourceType: 'agent' as const,
    resourceId: params.subscriptionId,
    environment: currentAuditEnvironment(),
    action: 'subscription.created',
    metadata: { tenantId, ...params },
  });
}

export async function auditSubscriptionUpdated(
  params: { subscriptionId: string; changes: Record<string, unknown> },
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'channel.configured' as any,
    actor,
    actorType: 'user',
    resourceType: 'agent' as const,
    resourceId: params.subscriptionId,
    environment: currentAuditEnvironment(),
    action: 'subscription.updated',
    metadata: { tenantId, ...params },
  });
}

export async function auditSubscriptionDeleted(
  params: { subscriptionId: string },
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    eventType: 'channel.configured' as any,
    actor,
    actorType: 'user',
    resourceType: 'agent' as const,
    resourceId: params.subscriptionId,
    environment: currentAuditEnvironment(),
    action: 'subscription.deleted',
    metadata: { tenantId, ...params },
  });
}
// =============================================================================
// WORKFLOW VERSION AUDIT HELPERS
// =============================================================================

export async function auditWorkflowVersionCreated(
  params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    workflowVersion: string;
    versionId: string;
    sourceHash: string;
  },
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: params.tenantId,
    projectId: params.projectId,
    eventType: 'workflow.version_created',
    actor,
    actorType: 'user',
    resourceType: 'workflow_version',
    resourceId: params.versionId,
    environment: currentAuditEnvironment(),
    action: 'workflow.version_created',
    metadata: {
      tenantId: params.tenantId,
      projectId: params.projectId,
      workflowId: params.workflowId,
      workflowVersion: params.workflowVersion,
      sourceHash: params.sourceHash,
    },
  });
}

export async function auditWorkflowVersionActivated(
  params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    workflowVersion: string;
    versionId: string;
  },
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: params.tenantId,
    projectId: params.projectId,
    eventType: 'workflow.version_activated',
    actor,
    actorType: 'user',
    resourceType: 'workflow_version',
    resourceId: params.versionId,
    environment: currentAuditEnvironment(),
    action: 'workflow.version_activated',
    metadata: {
      tenantId: params.tenantId,
      projectId: params.projectId,
      workflowId: params.workflowId,
      workflowVersion: params.workflowVersion,
    },
  });
}

export async function auditWorkflowVersionDeactivated(
  params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    workflowVersion: string;
    versionId: string;
  },
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: params.tenantId,
    projectId: params.projectId,
    eventType: 'workflow.version_deactivated',
    actor,
    actorType: 'user',
    resourceType: 'workflow_version',
    resourceId: params.versionId,
    environment: currentAuditEnvironment(),
    action: 'workflow.version_deactivated',
    metadata: {
      tenantId: params.tenantId,
      projectId: params.projectId,
      workflowId: params.workflowId,
      workflowVersion: params.workflowVersion,
    },
  });
}

export async function auditWorkflowVersionDeleted(
  params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    workflowVersion: string;
    versionId: string;
  },
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: params.tenantId,
    projectId: params.projectId,
    eventType: 'workflow.version_deleted',
    actor,
    actorType: 'user',
    resourceType: 'workflow_version',
    resourceId: params.versionId,
    environment: currentAuditEnvironment(),
    action: 'workflow.version_deleted',
    metadata: {
      tenantId: params.tenantId,
      projectId: params.projectId,
      workflowId: params.workflowId,
      workflowVersion: params.workflowVersion,
    },
  });
}

export async function auditWorkflowDeleted(
  params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
  },
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: params.tenantId,
    projectId: params.projectId,
    eventType: 'workflow.deleted',
    actor,
    actorType: 'user',
    resourceType: 'workflow_definition',
    resourceId: params.workflowId,
    environment: currentAuditEnvironment(),
    action: 'workflow.deleted',
    metadata: {
      tenantId: params.tenantId,
      projectId: params.projectId,
    },
  });
}

export async function auditWorkflowExecuted(
  params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    executionId: string;
    mode: 'sync' | 'async' | 'async_push';
    workflowVersion?: string;
    workflowVersionId?: string;
    apiKeyId?: string;
  },
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: params.tenantId,
    projectId: params.projectId,
    // `workflow.executed` is not in the canonical AuditEventType union yet;
    // cast follows the same pattern used for channel.configured above until
    // the union can be extended in a compiler-scoped commit.
    eventType: 'workflow.executed' as AuditEventType,
    actor,
    // API-key-authed workflow executions are machine principals → 'system';
    // user-authed (e.g. preview) executions keep 'user'.
    actorType: params.apiKeyId ? 'system' : 'user',
    resourceType: 'workflow_definition',
    resourceId: params.workflowId,
    environment: currentAuditEnvironment(),
    action: 'workflow.executed',
    metadata: {
      tenantId: params.tenantId,
      projectId: params.projectId,
      executionId: params.executionId,
      mode: params.mode,
      workflowVersion: params.workflowVersion ?? null,
      workflowVersionId: params.workflowVersionId ?? null,
      apiKeyId: params.apiKeyId ?? null,
    },
  });
}

// =============================================================================
// AGENT VERSION AUDIT HELPERS (legacy)
// =============================================================================

export async function auditVersionDeprecated(
  params: { projectId: string; agentName: string; version: string; deprecatedBy: string },
  actor: string,
  tenantId?: string,
): Promise<void> {
  await writeAuditLog({
    tenantId,
    projectId: params.projectId,
    eventType: 'agent.deprecated',
    actor,
    actorType: 'user',
    resourceType: 'agent',
    resourceId: params.agentName,
    environment: currentAuditEnvironment(),
    action: 'version.deprecated',
    metadata: { tenantId, ...params },
  });
}

// =============================================================================
// PROMPT LIBRARY AUDIT HELPERS
// =============================================================================

export async function auditPromptCreated(prompt: IPromptLibraryItem, actor: string): Promise<void> {
  await writeAuditLog({
    tenantId: prompt.tenantId,
    projectId: prompt.projectId,
    eventType: 'prompt.created',
    actor,
    actorType: 'user',
    resourceType: 'prompt',
    resourceId: String(prompt._id),
    environment: 'dev',
    action: 'prompt.created',
    metadata: {
      tenantId: prompt.tenantId,
      projectId: prompt.projectId,
      name: prompt.name,
    },
  });
}

export async function auditPromptVersionCreated(
  version: IPromptLibraryVersion,
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: version.tenantId,
    projectId: version.projectId,
    eventType: 'prompt.version_created',
    actor,
    actorType: 'user',
    resourceType: 'prompt',
    resourceId: version.promptId,
    environment: 'dev',
    action: 'prompt.version_created',
    metadata: {
      tenantId: version.tenantId,
      projectId: version.projectId,
      versionNumber: version.versionNumber,
      sourceHash: version.sourceHash,
    },
  });
}

export async function auditPromptVersionPromoted(
  version: IPromptLibraryVersion,
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: version.tenantId,
    projectId: version.projectId,
    eventType: 'prompt.version_promoted',
    actor,
    actorType: 'user',
    resourceType: 'prompt',
    resourceId: version.promptId,
    environment: 'dev',
    action: 'prompt.version_promoted',
    metadata: {
      tenantId: version.tenantId,
      projectId: version.projectId,
      versionNumber: version.versionNumber,
      status: version.status,
    },
  });
}

export async function auditPromptVersionArchived(
  version: IPromptLibraryVersion,
  actor: string,
): Promise<void> {
  await writeAuditLog({
    tenantId: version.tenantId,
    projectId: version.projectId,
    eventType: 'prompt.version_archived',
    actor,
    actorType: 'user',
    resourceType: 'prompt',
    resourceId: version.promptId,
    environment: 'dev',
    action: 'prompt.version_archived',
    metadata: {
      tenantId: version.tenantId,
      projectId: version.projectId,
      versionNumber: version.versionNumber,
      status: version.status,
    },
  });
}
