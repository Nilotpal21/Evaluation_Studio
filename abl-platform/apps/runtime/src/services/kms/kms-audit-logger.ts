/**
 * KMS Audit Logger
 *
 * Fire-and-forget audit logging to the runtime audit pipeline.
 * Never throws — audit failures are logged but don't affect operations.
 *
 * Required by PCI DSS 3.6 (key management lifecycle audit trail).
 * In pipeline mode this flows through Kafka before materializing into
 * ClickHouse kms_audit_log with retention enforced by ClickHouse TTL.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { AuditActorType, Environment } from '@abl/compiler/platform/core/types.js';
import type { AuditEvent } from '@abl/compiler/platform/stores/audit-pipeline.js';
import { writeAuditEvent } from '../audit-store-singleton.js';

const log = createLogger('kms-audit');

// =============================================================================
// TYPES
// =============================================================================

export interface KMSAuditEvent {
  tenantId: string;
  operation: string;
  keyId: string;
  keyVersion?: number;
  keyPurpose?: string;
  providerType: string;
  projectId?: string;
  environment?: string;
  dekId?: string;
  actorId?: string;
  actorType?: string;
  actorIp?: string;
  success: boolean;
  errorMessage?: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// KMS AUDIT LOGGER
// =============================================================================

let auditBackendAvailable = false;
let auditRetryAfter = 0;
const AUDIT_BACKOFF_MS = 60_000;

/**
 * Set whether the runtime audit backend is available for KMS audit logging.
 * Called at server startup after ClickHouse initialization.
 */
export function setKMSAuditClickHouseAvailable(available: boolean): void {
  auditBackendAvailable = available;
  if (!available) {
    auditRetryAfter = 0;
  }
  if (available) {
    auditRetryAfter = 0;
  }
}

/**
 * Log a KMS audit event. Fire-and-forget — never throws.
 */
export function logKMSAuditEvent(event: KMSAuditEvent): void {
  if (!canWriteToAuditBackend()) {
    logFallbackAuditEvent(event);
    return;
  }

  void writeAuditEvent(toAuditEvent(event)).catch((err) => {
    auditRetryAfter = Date.now() + AUDIT_BACKOFF_MS;
    log.warn('KMS audit write failed, backing off audit pipeline writes', {
      operation: event.operation,
      keyId: event.keyId,
      error: err instanceof Error ? err.message : String(err),
      retryInMs: AUDIT_BACKOFF_MS,
    });
    logFallbackAuditEvent(event);
  });
}

/**
 * Batch log multiple events (for rotation jobs).
 */
export function logKMSAuditEvents(events: KMSAuditEvent[]): void {
  if (!canWriteToAuditBackend() || events.length === 0) {
    // Fallback for batch: log each event individually
    if (events.length > 0) {
      for (const event of events) {
        logKMSAuditEvent(event);
      }
    }
    return;
  }

  void Promise.all(events.map((event) => writeAuditEvent(toAuditEvent(event)))).catch((err) => {
    auditRetryAfter = Date.now() + AUDIT_BACKOFF_MS;
    log.warn('KMS audit batch write failed', {
      eventCount: events.length,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function canWriteToAuditBackend(): boolean {
  return auditBackendAvailable && Date.now() >= auditRetryAfter;
}

function logFallbackAuditEvent(event: KMSAuditEvent): void {
  // Fallback: emit structured audit event to application log.
  // Ensures audit trail is preserved in log aggregator (Datadog/Loki/CloudWatch)
  // even during pipeline outages. Required for SOC2 compliance.
  log.warn('KMS audit event (audit pipeline unavailable)', {
    _audit: true,
    operation: event.operation,
    keyId: event.keyId,
    keyVersion: event.keyVersion,
    tenantId: event.tenantId,
    providerType: event.providerType,
    projectId: event.projectId,
    environment: event.environment,
    dekId: event.dekId,
    actorId: event.actorId,
    actorType: event.actorType,
    success: event.success,
    errorMessage: event.errorMessage,
    latencyMs: event.latencyMs,
    metadata: event.metadata,
  });
}

function normalizeActorType(value: string | undefined): AuditActorType {
  if (value === 'user' || value === 'admin' || value === 'agent' || value === 'system') {
    return value;
  }
  return 'system';
}

function toAuditEvent(event: KMSAuditEvent): AuditEvent {
  return {
    auditId: randomUUID(),
    stream: 'kms',
    schemaVersion: 2,
    source: 'runtime-store',
    eventType: `kms.${event.operation}`,
    action: event.operation,
    actorId: event.actorId ?? 'system',
    actorType: normalizeActorType(event.actorType),
    tenantId: event.tenantId,
    projectId: event.projectId ?? null,
    resourceType: 'kms_key',
    resourceId: event.keyId,
    environment: (event.environment as Environment | undefined) ?? null,
    traceId: null,
    ipAddress: event.actorIp ?? null,
    userAgent: null,
    metadata: {
      keyVersion: event.keyVersion ?? 0,
      keyPurpose: event.keyPurpose ?? '',
      providerType: event.providerType,
      environment: event.environment ?? '',
      dekId: event.dekId ?? '',
      success: event.success,
      errorMessage: event.errorMessage ?? '',
      latencyMs: event.latencyMs,
      ...(event.metadata ?? {}),
    },
    metadataEncoding: 'object',
    retentionClass: 'indefinite',
    expiresAt: null,
    timestamp: new Date(),
    oldValue: null,
    newValue: null,
  };
}
