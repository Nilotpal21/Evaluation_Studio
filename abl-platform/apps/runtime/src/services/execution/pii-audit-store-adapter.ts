/**
 * Runtime adapter for PIIAuditStore
 *
 * Connects the PIIAuditLogger (compiler module) to the runtime audit
 * pipeline so PII audit flows through Kafka before materializing into
 * ClickHouse pii_audit_log.
 */
import { randomUUID } from 'node:crypto';
import type { PIIAuditStore, PIIAuditEntry } from '@abl/compiler/platform/security/pii-audit.js';
import { createLogger } from '@abl/compiler/platform';
import type { AuditActorType, AuditSource } from '@abl/compiler/platform/core/types.js';
import type { AuditEvent } from '@abl/compiler/platform/stores/audit-pipeline.js';
import { writeAuditEvent } from '../audit-store-singleton.js';

const log = createLogger('pii-audit-store');

function resolveActorType(consumer: string): AuditActorType {
  switch (consumer) {
    case 'user':
      return 'user';
    case 'admin':
      return 'admin';
    default:
      return 'system';
  }
}

export interface RuntimePIIAuditEventInput {
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenId: string;
  piiType: string;
  consumer: string;
  action: string;
  /** Detection confidence carried over from the source PIIDetection (0..1). */
  confidence?: number;
  /** Originating recognizer name (e.g. 'core-email', 'eu-iban'). */
  recognizer?: string;
  metadata?: Record<string, unknown>;
  renderMode?: string;
  actorId?: string | null;
  actorType?: AuditActorType;
  expiresAt?: Date | null;
  timestamp?: Date;
  traceId?: string | null;
  source?: AuditSource;
}

export function buildRuntimePIIAuditEvent(input: RuntimePIIAuditEventInput): AuditEvent {
  return {
    auditId: randomUUID(),
    stream: 'pii' as const,
    schemaVersion: 2 as const,
    source: input.source ?? 'runtime-store',
    eventType: 'pii.accessed',
    action: input.action,
    actorId: input.actorId ?? input.consumer,
    actorType: input.actorType ?? resolveActorType(input.consumer),
    tenantId: input.tenantId,
    projectId: input.projectId,
    resourceType: 'pii_token',
    resourceId: input.tokenId,
    environment: null,
    traceId: input.traceId ?? null,
    ipAddress: null,
    userAgent: null,
    metadata: {
      sessionId: input.sessionId,
      tokenId: input.tokenId,
      piiType: input.piiType,
      consumer: input.consumer,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.recognizer ? { recognizer: input.recognizer } : {}),
      ...(input.renderMode ? { renderMode: input.renderMode } : {}),
      ...(input.metadata ?? {}),
    },
    metadataEncoding: 'object' as const,
    retentionClass: 'default' as const,
    expiresAt: input.expiresAt ?? null,
    timestamp: input.timestamp ?? new Date(),
    oldValue: null,
    newValue: null,
  };
}

export async function emitPIIAuditEvent(input: RuntimePIIAuditEventInput): Promise<void> {
  await writeAuditEvent(buildRuntimePIIAuditEvent(input));
}

export class RuntimePIIAuditStore implements PIIAuditStore {
  async insert(entry: PIIAuditEntry & { expireAt: Date }): Promise<void> {
    try {
      await emitPIIAuditEvent({
        tenantId: entry.tenantId,
        projectId: entry.projectId,
        sessionId: entry.sessionId,
        tokenId: entry.tokenId,
        piiType: entry.piiType,
        consumer: entry.consumer,
        action: entry.action,
        confidence: entry.confidence,
        recognizer: entry.recognizer,
        metadata: entry.metadata,
        expiresAt: entry.expireAt,
      });
    } catch (err) {
      // Fire-and-forget: log but never throw
      log.warn('pii-audit-insert-failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: entry.sessionId,
      });
    }
  }
}

/** Singleton store instance */
let storeInstance: RuntimePIIAuditStore | undefined;

export function getAuditStore(): RuntimePIIAuditStore {
  if (!storeInstance) {
    storeInstance = new RuntimePIIAuditStore();
  }
  return storeInstance;
}
