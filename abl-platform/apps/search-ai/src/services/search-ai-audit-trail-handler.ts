import { randomUUID } from 'node:crypto';
import { setAuditHandler, type AuditActorContext } from '@agent-platform/database/mongo';
import {
  buildSearchAIAuditPipelineEvent,
  publishSearchAIAuditPipelineEvent,
} from './search-ai-audit-pipeline-writer.js';

interface SearchAIAuditTrailEntry {
  source: 'mongoose-plugin';
  schemaVersion: 1;
  collectionName: string;
  documentId: string;
  operation: string;
  actor?: AuditActorContext;
  changes?: Record<string, unknown>;
  previousValues?: Record<string, unknown>;
  tenantId?: string;
}

const GLOBAL_HANDLER_KEY = '__abl_search_ai_audit_trail_handler_registered__' as const;

function buildSearchAIAuditTrailEvent(entry: SearchAIAuditTrailEntry): Record<string, unknown> {
  return buildSearchAIAuditPipelineEvent({
    eventType: `${entry.collectionName}.${entry.operation}`,
    action: entry.operation,
    actorId: entry.actor?.userId ?? null,
    actorType: entry.actor?.userId ? 'user' : 'system',
    tenantId: entry.tenantId ?? null,
    projectId: null,
    resourceType: entry.collectionName,
    resourceId: entry.documentId,
    ipAddress: entry.actor?.ip ?? null,
    userAgent: entry.actor?.userAgent ?? null,
    metadata: {
      collectionName: entry.collectionName,
      documentId: entry.documentId,
      operation: entry.operation,
      email: entry.actor?.email ?? null,
      changes: entry.changes ?? null,
      previousValues: entry.previousValues ?? null,
    },
    retentionClass: 'crud',
    expiresAt: null,
    oldValue: entry.previousValues ?? null,
    newValue: entry.changes ?? null,
  });
}

export function ensureSearchAIAuditTrailHandlerRegistered(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[GLOBAL_HANDLER_KEY]) {
    return;
  }

  setAuditHandler((entry) => {
    const auditEntry = entry as SearchAIAuditTrailEntry;
    const event = buildSearchAIAuditTrailEvent(auditEntry);
    publishSearchAIAuditPipelineEvent(event, auditEntry.tenantId ?? null);
  });
  globalState[GLOBAL_HANDLER_KEY] = true;
}
