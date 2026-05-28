import { randomUUID } from 'node:crypto';
import { setAuditHandler, type AuditActorContext } from '@agent-platform/database/mongo';
import { publishStudioAuditPipelineEvent } from './studio-audit-pipeline-writer';

interface StudioAuditTrailEntry {
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

const GLOBAL_HANDLER_KEY = '__abl_studio_audit_trail_handler_registered__' as const;

function buildStudioAuditTrailEvent(entry: StudioAuditTrailEntry): Record<string, unknown> {
  return {
    auditId: randomUUID(),
    stream: 'shared',
    schemaVersion: 2,
    timestamp: new Date(),
    source: 'mongoose-plugin',
    eventType: `${entry.collectionName}.${entry.operation}`,
    action: entry.operation,
    actorId: entry.actor?.userId ?? null,
    actorType: entry.actor?.userId ? 'user' : 'system',
    tenantId: entry.tenantId ?? null,
    projectId: null,
    resourceType: entry.collectionName,
    resourceId: entry.documentId,
    environment: null,
    traceId: null,
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
    metadataEncoding: 'object',
    retentionClass: 'crud',
    expiresAt: null,
    oldValue: entry.previousValues ?? null,
    newValue: entry.changes ?? null,
  };
}

export function ensureStudioAuditTrailHandlerRegistered(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[GLOBAL_HANDLER_KEY]) {
    return;
  }

  setAuditHandler((entry) => {
    const event = buildStudioAuditTrailEvent(entry as StudioAuditTrailEntry);
    publishStudioAuditPipelineEvent(event, (entry as StudioAuditTrailEntry).tenantId ?? null);
  });
  globalState[GLOBAL_HANDLER_KEY] = true;
}
