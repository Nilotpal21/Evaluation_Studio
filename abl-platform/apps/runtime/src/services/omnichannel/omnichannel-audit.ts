import { randomUUID } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { AuditEvent } from '@abl/compiler/platform/stores/audit-pipeline.js';
import {
  appendInMemoryAuditTestEvent,
  isInMemoryAuditTestBackendEnabled,
  resetInMemoryAuditTestBackend,
} from '@abl/compiler/platform/stores';
import { getClickHouseClient, parseClickHouseTimestamp } from '@agent-platform/database/clickhouse';
import { getRuntimeAuditEnvironment } from '../audit-environment.js';
import { writeAuditEvent } from '../audit-store-singleton.js';
import type { OmnichannelAuditEventType, OmnichannelAuditParams } from './types.js';

const log = createLogger('omnichannel-audit');

/** Omnichannel audit is intentionally operational-only and not a durable compliance store. */
export const OMNICHANNEL_AUDIT_CLASSIFICATION = 'operational_only' as const;

/** Maximum number of audit entries kept in memory */
const AUDIT_BUFFER_MAX_SIZE = 1000;

const OMNICHANNEL_AUDIT_TABLE = 'abl_platform.omnichannel_audit_log';
const OMNICHANNEL_AUDIT_RESOURCE_TYPE = 'omnichannel_session';
const OMNICHANNEL_AUDIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface OmnichannelAuditClickHouseRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  timestamp: string;
  event_id: string;
  event_type: string;
  description: string;
  data: string;
}

/** A stored audit entry with all context for querying */
export interface OmnichannelAuditEntry {
  eventType: OmnichannelAuditEventType;
  description: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

const auditBuffer: OmnichannelAuditEntry[] = [];

const EVENT_DESCRIPTIONS: Record<OmnichannelAuditEventType, string> = {
  omnichannel_recall_requested: 'Cross-channel recall requested',
  omnichannel_recall_returned: 'Cross-channel recall results returned',
  session_linked_to_contact: 'Session linked to contact identity',
  identity_verified: 'Contact identity verified',
  live_session_discovered: 'Live session discovered for contact',
  live_session_joined: 'Participant joined live session',
  transcript_item_persisted: 'Transcript item persisted to message store',
  typed_input_interrupted_tts: 'Typed input interrupted TTS playback',
  live_session_detached: 'Participant detached from live session',
  consent_granted: 'Contact granted omnichannel capability consent',
  consent_revoked: 'Contact revoked omnichannel capability consent',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function rememberAuditEntry(entry: OmnichannelAuditEntry): void {
  auditBuffer.push(entry);

  while (auditBuffer.length > AUDIT_BUFFER_MAX_SIZE) {
    auditBuffer.shift();
  }
}

function buildAuditEntry(
  params: OmnichannelAuditParams,
  timestamp: Date,
  description: string,
): OmnichannelAuditEntry {
  return {
    eventType: params.eventType,
    description,
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    timestamp: timestamp.toISOString(),
    ...(params.data ? { data: params.data } : {}),
  };
}

function buildOmnichannelAuditEvent(
  params: OmnichannelAuditParams,
  timestamp: Date,
  description: string,
): AuditEvent {
  return {
    auditId: randomUUID(),
    schemaVersion: 2,
    stream: 'omnichannel',
    source: 'runtime-store',
    eventType: params.eventType,
    action: params.eventType,
    actorId: 'system',
    actorType: 'system',
    tenantId: params.tenantId,
    projectId: params.projectId,
    resourceType: OMNICHANNEL_AUDIT_RESOURCE_TYPE,
    resourceId: params.sessionId,
    environment: getRuntimeAuditEnvironment(),
    traceId: null,
    ipAddress: null,
    userAgent: null,
    metadata: {
      description,
      sessionId: params.sessionId,
      classification: OMNICHANNEL_AUDIT_CLASSIFICATION,
      ...(params.data ? { data: params.data } : {}),
    },
    metadataEncoding: 'object',
    retentionClass: 'default',
    expiresAt: null,
    timestamp,
    oldValue: null,
    newValue: null,
  };
}

export function clearAuditBufferForTesting(): void {
  auditBuffer.length = 0;
  resetInMemoryAuditTestBackend();
}

async function queryInMemoryAuditEvents(
  tenantId: string,
  projectId: string,
  maxEntries = 50,
): Promise<OmnichannelAuditEntry[]> {
  const now = Date.now();
  const cutoff = now - OMNICHANNEL_AUDIT_LOOKBACK_MS;

  return auditBuffer
    .filter((entry) => {
      const entryTime = new Date(entry.timestamp).getTime();
      return entry.tenantId === tenantId && entry.projectId === projectId && entryTime > cutoff;
    })
    .slice(-maxEntries)
    .reverse();
}

function mapClickHouseRowToEntry(row: OmnichannelAuditClickHouseRow): OmnichannelAuditEntry {
  return {
    eventType: row.event_type as OmnichannelAuditEventType,
    description: row.description,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    timestamp: parseClickHouseTimestamp(row.timestamp).toISOString(),
    ...(parseJsonRecord(row.data) ? { data: parseJsonRecord(row.data) } : {}),
  };
}

export async function queryAuditEvents(
  tenantId: string,
  projectId: string,
  maxEntries = 50,
): Promise<OmnichannelAuditEntry[]> {
  if (isInMemoryAuditTestBackendEnabled()) {
    return queryInMemoryAuditEvents(tenantId, projectId, maxEntries);
  }

  try {
    const result = await getClickHouseClient().query({
      query: `
        SELECT tenant_id, project_id, session_id, timestamp, event_id, event_type, description, data
        FROM ${OMNICHANNEL_AUDIT_TABLE}
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
        ORDER BY timestamp DESC
        LIMIT {limit:UInt32}
        SETTINGS max_execution_time = 15
      `,
      query_params: {
        tenantId,
        projectId,
        limit: maxEntries,
      },
      format: 'JSONEachRow',
    });

    const rows = await result.json<OmnichannelAuditClickHouseRow>();
    return rows.map(mapClickHouseRowToEntry);
  } catch {
    return queryInMemoryAuditEvents(tenantId, projectId, maxEntries);
  }
}

async function emitOmnichannelAuditInternal(params: OmnichannelAuditParams): Promise<void> {
  const description = EVENT_DESCRIPTIONS[params.eventType] ?? params.eventType;
  const timestamp = new Date();
  const entry = buildAuditEntry(params, timestamp, description);
  const event = buildOmnichannelAuditEvent(params, timestamp, description);

  log.info(description, {
    eventType: params.eventType,
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    timestamp: entry.timestamp,
    ...(params.data ? { data: params.data } : {}),
  });

  rememberAuditEntry(entry);

  if (isInMemoryAuditTestBackendEnabled()) {
    appendInMemoryAuditTestEvent({ ...event });
    return;
  }

  await writeAuditEvent(event);
}

export function emitOmnichannelAudit(params: OmnichannelAuditParams): void {
  void emitOmnichannelAuditInternal(params).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to emit omnichannel audit event', {
      eventType: params.eventType,
      error: message,
    });
  });
}
