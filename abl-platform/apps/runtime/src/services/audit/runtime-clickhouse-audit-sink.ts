import type { ClickHouseClient } from '@clickhouse/client';
import { createLogger } from '@abl/compiler/platform';
import type {
  AuditEvent,
  AuditPolicyResolver,
  AuditSink,
} from '@abl/compiler/platform/stores/audit-pipeline.js';
import {
  BufferedClickHouseWriter,
  toClickHouseDateTime,
  toClickHouseDateTimeSec,
} from '@agent-platform/database/clickhouse';
import { ClickHouseAuditStore } from '../stores/clickhouse-audit-store.js';

const log = createLogger('runtime-clickhouse-audit-sink');

const KMS_AUDIT_TABLE = 'abl_platform.kms_audit_log';
const PII_AUDIT_TABLE = 'abl_platform.pii_audit_log';
const CONNECTOR_AUDIT_TABLE = 'abl_platform.connector_audit_log';
const CRAWL_AUDIT_TABLE = 'abl_platform.crawl_audit_events';
const ARCH_AUDIT_TABLE = 'abl_platform.arch_audit_log';
const ARCH_AUDIT_PAYLOADS_TABLE = 'abl_platform.arch_audit_payloads';
const OMNICHANNEL_AUDIT_TABLE = 'abl_platform.omnichannel_audit_log';

interface KMSAuditRow {
  tenant_id: string;
  timestamp: string;
  event_id: string;
  operation: string;
  key_id: string;
  key_version: number;
  key_purpose: string;
  provider_type: string;
  project_id: string;
  environment: string;
  epoch: string;
  actor_id: string;
  actor_type: string;
  actor_ip: string;
  success: number;
  error_message: string;
  latency_ms: number;
  metadata: string;
}

interface PIIAuditRow {
  tenant_id: string;
  project_id: string;
  timestamp: string;
  event_id: string;
  session_id: string;
  token_id: string;
  pii_type: string;
  consumer: string;
  render_mode: string;
  action: string;
  trace_id: string;
  metadata: string;
  expire_at: string;
}

interface ConnectorAuditRow {
  tenant_id: string;
  timestamp: string;
  event_id: string;
  connector_id: string;
  actor: string;
  actor_type: string;
  event: string;
  category: string;
  metadata: string;
}

interface CrawlAuditRow {
  tenant_id: string;
  timestamp: string;
  event_id: string;
  crawl_job_id: string;
  user_id: string;
  event_type: string;
  description: string;
  changes_before: string;
  changes_after: string;
  context: string;
  severity: string;
  metadata: string;
}

interface ArchAuditRow {
  tenant_id: string;
  user_id: string;
  session_id: string;
  project_id: string;
  timestamp: string;
  event_id: string;
  category: string;
  severity: string;
  summary: string;
  detail: string;
  specialist: string;
  phase: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  metadata: string;
  turn_id: string;
  parent_event_id: string;
  phase_label: string;
  retry_of: string;
  retry_index: number;
  nesting_depth: number;
  span_kind: string;
}

interface ArchAuditPayloadRow {
  tenant_id: string;
  session_id: string;
  event_id: string;
  timestamp: string;
  payload_type: 'prompt' | 'response' | 'tool_input' | 'tool_output';
  content: string;
  content_size_bytes: number;
}

interface OmnichannelAuditRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  timestamp: string;
  event_id: string;
  event_type: string;
  description: string;
  data: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getMetadata(event: AuditEvent): Record<string, unknown> {
  return isRecord(event.metadata) ? event.metadata : {};
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function asBooleanNumber(value: unknown, fallback: number): number {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number') {
    return value > 0 ? 1 : 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'success' || normalized === '1') {
      return 1;
    }
    if (
      normalized === 'false' ||
      normalized === 'failure' ||
      normalized === 'failed' ||
      normalized === '0'
    ) {
      return 0;
    }
  }
  return fallback;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function resolveExpireAt(event: AuditEvent, metadata: Record<string, unknown>): Date {
  if (event.expiresAt instanceof Date) {
    return event.expiresAt;
  }

  const metadataExpireAt = metadata.expireAt;
  if (metadataExpireAt instanceof Date && !Number.isNaN(metadataExpireAt.getTime())) {
    return metadataExpireAt;
  }
  if (typeof metadataExpireAt === 'string') {
    const parsed = new Date(metadataExpireAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date(event.timestamp.getTime() + 90 * 24 * 60 * 60 * 1000);
}

function buildKmsAuditRow(event: AuditEvent): KMSAuditRow {
  const metadata = getMetadata(event);
  return {
    tenant_id: event.tenantId ?? 'unscoped',
    timestamp: toClickHouseDateTime(event.timestamp),
    event_id: event.auditId,
    operation: event.action,
    key_id: event.resourceId ?? asString(metadata.keyId),
    key_version: asNumber(metadata.keyVersion, 0),
    key_purpose: asString(metadata.keyPurpose),
    provider_type: asString(metadata.providerType),
    project_id: event.projectId ?? '',
    environment: event.environment ?? asString(metadata.environment),
    epoch: asString(metadata.dekId),
    actor_id: event.actorId ?? '',
    actor_type: event.actorType,
    actor_ip: event.ipAddress ?? '',
    success: asBooleanNumber(metadata.success, 1),
    error_message: asString(metadata.errorMessage),
    latency_ms: asNumber(metadata.latencyMs, 0),
    metadata: stringifyJson(metadata),
  };
}

function buildPiiAuditRow(event: AuditEvent): PIIAuditRow {
  const metadata = getMetadata(event);
  return {
    tenant_id: event.tenantId ?? 'unscoped',
    project_id: event.projectId ?? '',
    timestamp: toClickHouseDateTime(event.timestamp),
    event_id: event.auditId,
    session_id: asString(metadata.sessionId),
    token_id: event.resourceId ?? asString(metadata.tokenId),
    pii_type: asString(metadata.piiType),
    consumer: asString(metadata.consumer),
    render_mode: asString(metadata.renderMode),
    action: event.action,
    trace_id: event.traceId ?? '',
    metadata: stringifyJson(metadata),
    expire_at: toClickHouseDateTime(resolveExpireAt(event, metadata)),
  };
}

function buildConnectorAuditRow(event: AuditEvent): ConnectorAuditRow {
  const metadata = getMetadata(event);
  return {
    tenant_id: event.tenantId ?? 'unscoped',
    timestamp: toClickHouseDateTime(event.timestamp),
    event_id: event.auditId,
    connector_id: event.resourceId ?? asString(metadata.connectorId),
    actor: event.actorId ?? asString(metadata.actor, 'system'),
    actor_type: event.actorType,
    event: event.eventType,
    category: asString(metadata.category),
    metadata: stringifyJson(metadata),
  };
}

function buildCrawlAuditRow(event: AuditEvent): CrawlAuditRow {
  const metadata = getMetadata(event);
  const changes = asOptionalRecord(metadata.changes);
  return {
    tenant_id: event.tenantId ?? 'unscoped',
    timestamp: toClickHouseDateTime(event.timestamp),
    event_id: event.auditId,
    crawl_job_id: event.resourceId ?? asString(metadata.crawlJobId),
    user_id: event.actorId ?? asString(metadata.userId),
    event_type: event.eventType,
    description: asString(metadata.description),
    changes_before: stringifyJson(changes?.before ?? null),
    changes_after: stringifyJson(changes?.after ?? null),
    context: stringifyJson(asOptionalRecord(metadata.context) ?? {}),
    severity: asString(metadata.severity, 'info'),
    metadata: stringifyJson(metadata),
  };
}

function buildArchAuditRow(event: AuditEvent): ArchAuditRow {
  const metadata = getMetadata(event);
  const tokens = asOptionalRecord(metadata.tokens);
  return {
    tenant_id: event.tenantId ?? 'unscoped',
    user_id: event.actorId ?? '',
    session_id: event.resourceId ?? asString(metadata.sessionId),
    project_id: event.projectId ?? '',
    timestamp: toClickHouseDateTime(event.timestamp),
    event_id: event.auditId,
    category: asString(metadata.category),
    severity: asString(metadata.severity, 'info'),
    summary: asString(metadata.summary),
    detail: stringifyJson(asOptionalRecord(metadata.detail) ?? {}),
    specialist: asString(metadata.specialist),
    phase: asString(metadata.phase),
    duration_ms: asNumber(metadata.durationMs, 0),
    input_tokens: asNumber(tokens?.input, 0),
    output_tokens: asNumber(tokens?.output, 0),
    total_tokens: asNumber(tokens?.total, 0),
    estimated_cost: asNumber(tokens?.estimatedCost, 0),
    metadata: stringifyJson(metadata),
    turn_id: asString(metadata.turnId),
    parent_event_id: asString(metadata.parentEventId),
    phase_label: asString(metadata.phaseLabel),
    retry_of: asString(metadata.retryOf),
    retry_index: asNumber(metadata.retryIndex, 0),
    nesting_depth: asNumber(metadata.nestingDepth, 255),
    span_kind: asString(metadata.spanKind),
  };
}

function buildArchAuditPayloadRow(event: AuditEvent): ArchAuditPayloadRow {
  const metadata = getMetadata(event);
  return {
    tenant_id: event.tenantId ?? 'unscoped',
    session_id: asString(metadata.sessionId),
    event_id: asString(metadata.eventId),
    timestamp: toClickHouseDateTime(event.timestamp),
    payload_type: asArchPayloadType(metadata.payloadType),
    content: asString(metadata.content),
    content_size_bytes: asNumber(metadata.contentSizeBytes, 0),
  };
}

function asArchPayloadType(value: unknown): ArchAuditPayloadRow['payload_type'] {
  if (
    value === 'prompt' ||
    value === 'response' ||
    value === 'tool_input' ||
    value === 'tool_output'
  ) {
    return value;
  }
  throw new Error(`Invalid arch audit payload type: ${String(value)}`);
}

function buildOmnichannelAuditRow(event: AuditEvent): OmnichannelAuditRow {
  const metadata = getMetadata(event);
  return {
    tenant_id: event.tenantId ?? 'unscoped',
    project_id: event.projectId ?? '',
    session_id: event.resourceId ?? asString(metadata.sessionId),
    timestamp: toClickHouseDateTime(event.timestamp),
    event_id: event.auditId,
    event_type: event.eventType,
    description: asString(metadata.description, event.action),
    data: stringifyJson(asOptionalRecord(metadata.data) ?? {}),
  };
}

export interface RuntimeClickHouseAuditSinkOptions {
  client: ClickHouseClient;
  policyResolver: AuditPolicyResolver;
  sharedSink: ClickHouseAuditStore;
}

export class RuntimeClickHouseAuditSink implements AuditSink {
  private readonly kmsWriter: BufferedClickHouseWriter<KMSAuditRow>;
  private readonly piiWriter: BufferedClickHouseWriter<PIIAuditRow>;
  private readonly connectorWriter: BufferedClickHouseWriter<ConnectorAuditRow>;
  private readonly crawlWriter: BufferedClickHouseWriter<CrawlAuditRow>;
  private readonly archWriter: BufferedClickHouseWriter<ArchAuditRow>;
  private readonly archPayloadWriter: BufferedClickHouseWriter<ArchAuditPayloadRow>;
  private readonly omnichannelWriter: BufferedClickHouseWriter<OmnichannelAuditRow>;

  constructor(private readonly options: RuntimeClickHouseAuditSinkOptions) {
    this.kmsWriter = this.createWriter<KMSAuditRow>(KMS_AUDIT_TABLE);
    this.piiWriter = this.createWriter<PIIAuditRow>(PII_AUDIT_TABLE);
    this.connectorWriter = this.createWriter<ConnectorAuditRow>(CONNECTOR_AUDIT_TABLE);
    this.crawlWriter = this.createWriter<CrawlAuditRow>(CRAWL_AUDIT_TABLE);
    this.archWriter = this.createWriter<ArchAuditRow>(ARCH_AUDIT_TABLE);
    this.archPayloadWriter = this.createWriter<ArchAuditPayloadRow>(ARCH_AUDIT_PAYLOADS_TABLE);
    this.omnichannelWriter = this.createWriter<OmnichannelAuditRow>(OMNICHANNEL_AUDIT_TABLE);
  }

  async write(event: AuditEvent): Promise<void> {
    await this.writeBatch([event]);
  }

  async writeBatch(events: AuditEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const sharedEvents: AuditEvent[] = [];
    const kmsRows: KMSAuditRow[] = [];
    const piiRows: PIIAuditRow[] = [];
    const connectorRows: ConnectorAuditRow[] = [];
    const crawlRows: CrawlAuditRow[] = [];
    const archRows: ArchAuditRow[] = [];
    const archPayloadRows: ArchAuditPayloadRow[] = [];
    const omnichannelRows: OmnichannelAuditRow[] = [];

    for (const event of events) {
      const routing = this.options.policyResolver.resolve(event);
      switch (routing.stream) {
        case 'shared':
          sharedEvents.push(event);
          break;
        case 'kms':
          kmsRows.push(buildKmsAuditRow(event));
          break;
        case 'pii':
          piiRows.push(buildPiiAuditRow(event));
          break;
        case 'connector':
          connectorRows.push(buildConnectorAuditRow(event));
          break;
        case 'crawl':
          crawlRows.push(buildCrawlAuditRow(event));
          break;
        case 'arch':
          archRows.push(buildArchAuditRow(event));
          break;
        case 'arch_payload':
          archPayloadRows.push(buildArchAuditPayloadRow(event));
          break;
        case 'omnichannel':
          omnichannelRows.push(buildOmnichannelAuditRow(event));
          break;
      }
    }

    if (sharedEvents.length > 0) {
      await this.options.sharedSink.writeBatch(sharedEvents);
    }
    await this.persistRows(this.kmsWriter, kmsRows, 'KMS audit sink batch flush failed');
    await this.persistRows(this.piiWriter, piiRows, 'PII audit sink batch flush failed');
    await this.persistRows(
      this.connectorWriter,
      connectorRows,
      'Connector audit sink batch flush failed',
    );
    await this.persistRows(this.crawlWriter, crawlRows, 'Crawl audit sink batch flush failed');
    await this.persistRows(this.archWriter, archRows, 'Arch audit sink batch flush failed');
    await this.persistRows(
      this.archPayloadWriter,
      archPayloadRows,
      'Arch payload audit sink batch flush failed',
    );
    await this.persistRows(
      this.omnichannelWriter,
      omnichannelRows,
      'Omnichannel audit sink batch flush failed',
    );
  }

  async flush(): Promise<void> {
    await this.options.sharedSink.flush();
    await this.kmsWriter.flush();
    await this.piiWriter.flush();
    await this.connectorWriter.flush();
    await this.crawlWriter.flush();
    await this.archWriter.flush();
    await this.archPayloadWriter.flush();
    await this.omnichannelWriter.flush();
  }

  async close(): Promise<void> {
    await this.options.sharedSink.flush();
    await this.kmsWriter.close();
    await this.piiWriter.close();
    await this.connectorWriter.close();
    await this.crawlWriter.close();
    await this.archWriter.close();
    await this.archPayloadWriter.close();
    await this.omnichannelWriter.close();
  }

  private createWriter<T extends object>(table: string): BufferedClickHouseWriter<T> {
    return new BufferedClickHouseWriter<T>(this.options.client, {
      table,
      onError: (err, ctx) => {
        log.error('Runtime audit sink flush error', {
          table,
          error: err instanceof Error ? err.message : String(err),
          context: ctx,
        });
      },
    });
  }

  private async persistRows<T extends object>(
    writer: BufferedClickHouseWriter<T>,
    rows: T[],
    errorMessage: string,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      writer.insert(row);
    }

    try {
      await writer.flush();
    } catch (err) {
      log.error(errorMessage, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
