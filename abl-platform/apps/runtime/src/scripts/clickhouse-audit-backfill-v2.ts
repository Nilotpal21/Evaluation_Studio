/**
 * ClickHouse Audit Backfill V2
 *
 * Additive, idempotent repair planning for shared audit rows in ClickHouse.
 *
 * Usage:
 *   node dist/scripts/clickhouse-audit-backfill-v2.js [--tenant-id <id>] [--batch-size <n>] [--dry-run]
 */

import type { ClickHouseClient } from '@clickhouse/client';
import {
  decodeSharedAuditRecord,
  encodeSharedAuditEnvelopeToMongoDocument,
} from '@abl/compiler/platform/stores/shared-audit-codec.js';
import {
  ClickHouseAuditStore,
  type ClickHouseAuditRow,
} from '../services/stores/clickhouse-audit-store.js';

const WAIT_FOR_LOCAL_MUTATION_SETTING = 'SETTINGS mutations_sync = 1';

export interface ClickHouseAuditBackfillOptions {
  tenantId?: string;
  batchSize?: number;
  dryRun: boolean;
}

export interface ClickHouseAuditBackfillPatch {
  actor_type?: string;
  session_id?: string;
  project_id?: string;
  resource_type?: string;
  resource_id?: string;
  metadata?: string;
}

export interface ClickHouseAuditBackfillPlanEntry {
  eventId: string;
  tenantId: string;
  kind: string;
  patch: ClickHouseAuditBackfillPatch;
  warnings: string[];
  shouldUpdate: boolean;
}

export interface ClickHouseAuditBackfillResult {
  processed: number;
  updated: number;
  skipped: number;
  unknownRows: number;
  warnings: Array<{ eventId: string; warnings: string[] }>;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }
  return value;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed historical metadata — caller will overwrite when needed.
  }
  return null;
}

function escapeClickHouseString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

export function buildClickHouseAuditBackfillPlan(
  rows: ClickHouseAuditRow[],
): ClickHouseAuditBackfillPlanEntry[] {
  return rows.map((row) => {
    const sharedRecord = ClickHouseAuditStore.mapRowToSharedAuditRecord(row);
    const decoded = decodeSharedAuditRecord(sharedRecord);

    if (!decoded.envelope) {
      return {
        eventId: row.event_id,
        tenantId: row.tenant_id,
        kind: decoded.kind,
        patch: {},
        warnings: decoded.warnings,
        shouldUpdate: false,
      };
    }

    const desiredDocument = encodeSharedAuditEnvelopeToMongoDocument(
      row.event_id,
      decoded.envelope,
    );
    const desiredMetadataValue =
      typeof desiredDocument.metadata === 'string'
        ? desiredDocument.metadata
        : stableJsonStringify(desiredDocument.metadata ?? {});
    const currentMetadataValue = stableJsonStringify(parseJsonRecord(row.metadata) ?? {});

    const patch: ClickHouseAuditBackfillPatch = {};

    if (!row.actor_type && decoded.envelope.actorType !== 'unknown') {
      patch.actor_type = decoded.envelope.actorType;
    }
    if (!row.session_id && decoded.envelope.traceId) {
      patch.session_id = decoded.envelope.traceId;
    }
    if (!row.project_id && decoded.envelope.projectId) {
      patch.project_id = decoded.envelope.projectId;
    }
    if (!row.resource_type && decoded.envelope.resourceType) {
      patch.resource_type = decoded.envelope.resourceType;
    }
    if (!row.resource_id && decoded.envelope.resourceId) {
      patch.resource_id = decoded.envelope.resourceId;
    }
    if (currentMetadataValue !== stableJsonStringify(parseJsonRecord(desiredMetadataValue) ?? {})) {
      patch.metadata = desiredMetadataValue;
    }

    return {
      eventId: row.event_id,
      tenantId: row.tenant_id,
      kind: decoded.kind,
      patch,
      warnings: decoded.warnings,
      shouldUpdate: Object.keys(patch).length > 0,
    };
  });
}

function buildAlterAssignments(patch: ClickHouseAuditBackfillPatch): string[] {
  const assignments: string[] = [];

  if (patch.actor_type !== undefined) {
    assignments.push(`actor_type = '${escapeClickHouseString(patch.actor_type)}'`);
  }
  if (patch.session_id !== undefined) {
    assignments.push(`session_id = '${escapeClickHouseString(patch.session_id)}'`);
  }
  if (patch.project_id !== undefined) {
    assignments.push(`project_id = '${escapeClickHouseString(patch.project_id)}'`);
  }
  if (patch.resource_type !== undefined) {
    assignments.push(`resource_type = '${escapeClickHouseString(patch.resource_type)}'`);
  }
  if (patch.resource_id !== undefined) {
    assignments.push(`resource_id = '${escapeClickHouseString(patch.resource_id)}'`);
  }
  if (patch.metadata !== undefined) {
    assignments.push(`metadata = '${escapeClickHouseString(patch.metadata)}'`);
  }

  return assignments;
}

export async function runClickHouseAuditBackfill(
  options: ClickHouseAuditBackfillOptions,
  client?: ClickHouseClient,
): Promise<ClickHouseAuditBackfillResult> {
  const clickhouseClient =
    client ?? (await import('@agent-platform/database/clickhouse')).getClickHouseClient();

  const result: ClickHouseAuditBackfillResult = {
    processed: 0,
    updated: 0,
    skipped: 0,
    unknownRows: 0,
    warnings: [],
  };

  const batchSize = options.batchSize ?? 500;
  let cursorTimestamp: string | undefined;
  let cursorEventId: string | undefined;

  while (true) {
    const conditions: string[] = [];
    const queryParams: Record<string, unknown> = {
      limit: batchSize,
    };

    if (options.tenantId) {
      conditions.push(`tenant_id = {tenantId:String}`);
      queryParams.tenantId = options.tenantId;
    }

    if (cursorTimestamp && cursorEventId) {
      conditions.push(
        `(timestamp > {cursorTimestamp:DateTime} OR (timestamp = {cursorTimestamp:DateTime} AND event_id > {cursorEventId:String}))`,
      );
      queryParams.cursorTimestamp = cursorTimestamp;
      queryParams.cursorEventId = cursorEventId;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rowsResult = await clickhouseClient.query({
      query: `
        SELECT *
        FROM abl_platform.audit_events
        ${whereClause}
        ORDER BY timestamp ASC, event_id ASC
        LIMIT {limit:UInt32}
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await rowsResult.json<ClickHouseAuditRow>();
    if (rows.length === 0) {
      break;
    }

    const plan = buildClickHouseAuditBackfillPlan(rows);
    result.processed += plan.length;

    for (const entry of plan) {
      if (entry.kind === 'unknown') {
        result.unknownRows += 1;
      }
      if (entry.warnings.length > 0) {
        result.warnings.push({ eventId: entry.eventId, warnings: entry.warnings });
      }
      if (!entry.shouldUpdate) {
        result.skipped += 1;
        continue;
      }
      if (options.dryRun) {
        result.updated += 1;
        continue;
      }

      const assignments = buildAlterAssignments(entry.patch);
      if (assignments.length === 0) {
        result.skipped += 1;
        continue;
      }

      await clickhouseClient.command({
        query: `
          ALTER TABLE abl_platform.audit_events
          UPDATE ${assignments.join(', ')}
          WHERE tenant_id = '${escapeClickHouseString(entry.tenantId)}'
            AND event_id = '${escapeClickHouseString(entry.eventId)}'
          ${WAIT_FOR_LOCAL_MUTATION_SETTING}
        `,
      });
      result.updated += 1;
    }

    if (rows.length < batchSize) {
      break;
    }

    const lastRow = rows[rows.length - 1];
    cursorTimestamp = lastRow.timestamp;
    cursorEventId = lastRow.event_id;
  }

  return result;
}

function parseArgs(argv: string[]): ClickHouseAuditBackfillOptions {
  const options: ClickHouseAuditBackfillOptions = {
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tenant-id') {
      options.tenantId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--batch-size') {
      options.batchSize = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

async function main() {
  const result = await runClickHouseAuditBackfill(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`clickhouse-audit-backfill-v2 failed: ${message}\n`);
    process.exitCode = 1;
  });
}
