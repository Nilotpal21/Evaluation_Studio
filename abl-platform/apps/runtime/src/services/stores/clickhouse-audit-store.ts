/**
 * ClickHouse Audit Store
 *
 * Implements AuditStore for ClickHouse backend.
 * No encryption — all columns are plaintext for compliance querying.
 * Uses BufferedWriter for batched inserts (10K rows / 5s flush).
 */

import type { ClickHouseClient } from '@clickhouse/client';
import type { AuditLog, Environment } from '@abl/compiler/platform/core/types';
import {
  AuditStore,
  type AuditStoreConfig,
  type AlertConfig,
  type QueryAuditParams,
  type AuditSummary,
} from '@abl/compiler/platform/stores/audit-store.js';
import {
  ClickHouseAuditReader as SharedClickHouseAuditReader,
  decodeClickHouseAuditRow,
  formatClickHouseAuditTimestamp,
  mapClickHouseAuditRowToSharedAuditRecord,
} from '@abl/compiler/platform/stores/clickhouse-audit-reader.js';
import type {
  AuditEvent,
  AuditReader,
  AuditSink,
} from '@abl/compiler/platform/stores/audit-pipeline.js';
import { toAuditLogFromAuditEvent } from '@abl/compiler/platform/stores/audit-pipeline.js';
import {
  createSharedAuditEnvelopeFromAuditLog,
  encodeSharedAuditEnvelopeToMongoDocument,
  type SharedAuditRecord,
} from '@abl/compiler/platform/stores/shared-audit-codec.js';
import { createLogger } from '@abl/compiler/platform';
import { BufferedClickHouseWriter } from '@agent-platform/database/clickhouse';

const log = createLogger('clickhouse-audit-store');

export interface ClickHouseAuditRow {
  tenant_id: string;
  timestamp: string;
  action: string;
  event_id: string;
  actor_id: string;
  actor_type: string;
  actor_ip: string;
  actor_user_agent: string;
  resource_type: string;
  resource_id: string;
  session_id: string;
  project_id: string;
  old_value: string;
  new_value: string;
  metadata: string;
  success: number;
  failure_reason: string;
}

export interface ClickHouseAuditStoreOptions {
  client: ClickHouseClient;
  /** @deprecated Audit logs use per-record tenantId from auditLog.tenantId */
  tenantId?: string;
  canonicalWriterEnabled?: boolean;
}

export class ClickHouseAuditStore extends AuditStore implements AuditSink, AuditReader {
  private client: ClickHouseClient;
  private tenantId: string;
  private canonicalWriterEnabled: boolean;
  private writer: BufferedClickHouseWriter<ClickHouseAuditRow>;
  private reader: SharedClickHouseAuditReader;

  constructor(
    config: AuditStoreConfig,
    options: ClickHouseAuditStoreOptions,
    alertConfig?: AlertConfig,
  ) {
    super(config, alertConfig);
    this.client = options.client;
    this.tenantId = options.tenantId ?? '';
    this.canonicalWriterEnabled = options.canonicalWriterEnabled ?? false;
    this.writer = new BufferedClickHouseWriter(this.client, {
      table: 'abl_platform.audit_events',
      onError: (err, ctx) => {
        log.error('ClickHouse audit writer flush error', {
          error: err instanceof Error ? err.message : String(err),
          context: ctx,
        });
      },
    });
    this.reader = new SharedClickHouseAuditReader(this.client, {
      tenantId: this.tenantId,
      requireTenantId: true,
      tableName: 'abl_platform.audit_events',
    });
  }

  private buildLegacyRow(auditLog: AuditLog): ClickHouseAuditRow {
    return {
      tenant_id: auditLog.tenantId || this.tenantId,
      timestamp: formatClickHouseAuditTimestamp(auditLog.timestamp),
      action: auditLog.action,
      event_id: auditLog.id,
      actor_id: auditLog.actor,
      actor_type: auditLog.actorType,
      actor_ip: auditLog.ipAddress || '',
      actor_user_agent: '',
      resource_type: auditLog.resourceType,
      resource_id: auditLog.resourceId,
      session_id: '',
      project_id: auditLog.projectId || '',
      old_value: auditLog.oldValue ? JSON.stringify(auditLog.oldValue) : '',
      new_value: auditLog.newValue ? JSON.stringify(auditLog.newValue) : '',
      metadata: JSON.stringify(auditLog.metadata || {}),
      success: 1,
      failure_reason: '',
    };
  }

  private buildCanonicalRow(auditLog: AuditLog): ClickHouseAuditRow {
    const envelope = createSharedAuditEnvelopeFromAuditLog(auditLog, {
      source: auditLog.source ?? 'runtime-store',
      metadataEncoding: auditLog.metadataEncoding ?? 'object',
      retentionClass: auditLog.retentionClass,
      expiresAt: auditLog.expiresAt ?? null,
    });
    const encodedDocument = encodeSharedAuditEnvelopeToMongoDocument(auditLog.id, envelope);
    const metadataString =
      typeof encodedDocument.metadata === 'string'
        ? encodedDocument.metadata
        : JSON.stringify(encodedDocument.metadata ?? {});

    return {
      tenant_id: envelope.tenantId ?? this.tenantId,
      timestamp: formatClickHouseAuditTimestamp(envelope.timestamp ?? auditLog.timestamp),
      action: envelope.action,
      event_id: auditLog.id,
      actor_id: envelope.actorId ?? 'system',
      actor_type: envelope.actorType,
      actor_ip: envelope.ipAddress ?? '',
      actor_user_agent: envelope.userAgent ?? '',
      resource_type: envelope.resourceType ?? '',
      resource_id: envelope.resourceId ?? '',
      session_id: envelope.traceId ?? '',
      project_id: envelope.projectId ?? '',
      old_value: envelope.oldValue ? JSON.stringify(envelope.oldValue) : '',
      new_value: envelope.newValue ? JSON.stringify(envelope.newValue) : '',
      metadata: metadataString,
      success: 1,
      failure_reason: '',
    };
  }

  private buildCanonicalRowFromAuditEvent(event: AuditEvent): ClickHouseAuditRow {
    return this.buildCanonicalRow(toAuditLogFromAuditEvent(event));
  }

  private async persistRows(
    rows: ClickHouseAuditRow[],
    errorMessage: string,
    suppressErrors: boolean,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      this.writer.insert(row);
    }

    try {
      await this.writer.flush();
    } catch (err) {
      log.error(errorMessage, {
        error: err instanceof Error ? err.message : String(err),
      });

      if (!suppressErrors) {
        throw err;
      }
    }
  }

  protected async append(auditLog: AuditLog): Promise<void> {
    const row = this.canonicalWriterEnabled
      ? this.buildCanonicalRow(auditLog)
      : this.buildLegacyRow(auditLog);

    await this.persistRows([row], 'ClickHouse audit immediate flush failed', true);
  }

  async write(event: AuditEvent): Promise<void> {
    await this.persistRows(
      [this.buildCanonicalRowFromAuditEvent(event)],
      'ClickHouse audit sink flush failed',
      false,
    );
  }

  async writeBatch(events: AuditEvent[]): Promise<void> {
    await this.persistRows(
      events.map((event) => this.buildCanonicalRowFromAuditEvent(event)),
      'ClickHouse audit sink batch flush failed',
      false,
    );
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  static mapRowToSharedAuditRecord(row: ClickHouseAuditRow): SharedAuditRecord {
    return mapClickHouseAuditRowToSharedAuditRecord(row);
  }

  static decodeRow(row: ClickHouseAuditRow): AuditLog {
    return decodeClickHouseAuditRow(row);
  }

  async query(params: QueryAuditParams): Promise<{ logs: AuditLog[]; total: number }> {
    return this.reader.query(params);
  }

  async getSummary(
    scope: string,
    environment: Environment,
    startTime: Date,
    endTime: Date,
  ): Promise<AuditSummary> {
    return this.reader.getSummary(scope, environment, startTime, endTime);
  }

  async getByTraceId(scope: string, traceId: string): Promise<AuditLog[]> {
    return this.reader.getByTraceId(scope, traceId);
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}
