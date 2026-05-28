import { randomUUID } from 'node:crypto';
import { setAuditHandler, type AuditActorContext } from '@agent-platform/database/mongo';
import { writeAuditEvent } from '../audit-store-singleton.js';

interface RuntimeAuditTrailEntry {
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

let registered = false;

function buildRuntimeAuditTrailEvent(entry: RuntimeAuditTrailEntry) {
  return {
    auditId: randomUUID(),
    stream: 'shared' as const,
    schemaVersion: 2 as const,
    timestamp: new Date(),
    source: 'mongoose-plugin' as const,
    eventType: `${entry.collectionName}.${entry.operation}`,
    action: entry.operation,
    actorId: entry.actor?.userId ?? null,
    actorType: entry.actor?.userId ? ('user' as const) : ('system' as const),
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
    metadataEncoding: 'object' as const,
    retentionClass: 'crud' as const,
    expiresAt: null,
    oldValue: entry.previousValues ?? null,
    newValue: entry.changes ?? null,
  };
}

export function ensureRuntimeAuditTrailHandlerRegistered(): void {
  if (registered) {
    return;
  }

  setAuditHandler((entry) => {
    void writeAuditEvent(buildRuntimeAuditTrailEvent(entry as RuntimeAuditTrailEntry));
  });
  registered = true;
}
