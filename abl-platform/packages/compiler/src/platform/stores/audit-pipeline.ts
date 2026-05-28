import type { AuditLog, Environment } from '../core/types.js';
import type { AuditSummary, QueryAuditParams } from './audit-store.js';
import {
  createSharedAuditEnvelopeFromAuditLog,
  toAuditLog,
  type SharedAuditEnvelope,
} from './shared-audit-codec.js';

export type AuditStream =
  | 'shared'
  | 'kms'
  | 'pii'
  | 'connector'
  | 'crawl'
  | 'arch'
  | 'arch_payload'
  | 'omnichannel';

export interface AuditEvent extends Omit<SharedAuditEnvelope, 'timestamp'> {
  auditId: string;
  stream: AuditStream;
  timestamp: Date;
}

export interface AuditRoutingDecision {
  stream: AuditStream;
  topic: string;
  table: string;
}

export interface AuditTransportResilienceStatus {
  walEnabled: boolean;
  walBufferedEvents: number;
  spooledMessages: number;
  failedWalWrites: number;
  recoveryRuns: number;
  recoveredMessages: number;
  failedRecoveryMessages: number;
  lastSpooledAt: Date | null;
  lastWalErrorAt: Date | null;
  lastWalError: string | null;
  lastRecoveredAt: Date | null;
  lastRecoveryErrorAt: Date | null;
  lastRecoveryError: string | null;
}

export interface AuditTransportStatus {
  healthy: boolean;
  started: boolean;
  bufferedMessages: number;
  inFlightProducerDrains: number;
  inFlightMaterializations: number;
  publishedMessages: number;
  materializedMessages: number;
  failedProducerDrains: number;
  failedMaterializations: number;
  lastProducedAt: Date | null;
  lastMaterializedAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  resilience?: AuditTransportResilienceStatus | null;
}

export interface AuditEmitter {
  emit(event: AuditEvent): void;
  emitBatch(events: AuditEvent[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  getStatus?(): AuditTransportStatus | null;
}

export interface AuditTransport {
  publish(event: AuditEvent): void;
  publishBatch(events: AuditEvent[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  isHealthy(): boolean;
  getStatus(): AuditTransportStatus;
}

export interface AuditMaterializer {
  handle(event: AuditEvent): Promise<void>;
  handleBatch(events: AuditEvent[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
  writeBatch(events: AuditEvent[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AuditReader {
  query(params: QueryAuditParams): Promise<{ logs: AuditLog[]; total: number }>;
  getSummary(
    scope: string,
    environment: Environment,
    startTime: Date,
    endTime: Date,
  ): Promise<AuditSummary>;
  getByTraceId(scope: string, traceId: string): Promise<AuditLog[]>;
  close(): Promise<void>;
}

export interface AuditPolicyResolver {
  resolve(event: AuditEvent): AuditRoutingDecision;
}

export function createAuditEventFromAuditLog(
  auditLog: AuditLog,
  stream: AuditStream = 'shared',
): AuditEvent {
  return {
    auditId: auditLog.id,
    stream,
    ...createSharedAuditEnvelopeFromAuditLog(auditLog, {
      source: auditLog.source ?? 'runtime-store',
      metadataEncoding: auditLog.metadataEncoding ?? 'object',
      retentionClass: auditLog.retentionClass,
      expiresAt: auditLog.expiresAt ?? null,
    }),
    timestamp: auditLog.timestamp,
  };
}

export function toAuditLogFromAuditEvent(event: AuditEvent): AuditLog {
  const { auditId, stream: _stream, ...envelope } = event;
  return toAuditLog(envelope, auditId);
}
