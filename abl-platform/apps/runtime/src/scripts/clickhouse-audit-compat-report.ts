/**
 * ClickHouse Audit Compatibility Report
 *
 * Dry-run inventory for historical shared audit rows in ClickHouse.
 *
 * Usage:
 *   node dist/scripts/clickhouse-audit-compat-report.js [--tenant-id <id>] [--batch-size <n>] [--json]
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { decodeSharedAuditRecord } from '@abl/compiler/platform/stores/shared-audit-codec.js';
import {
  ClickHouseAuditStore,
  type ClickHouseAuditRow,
} from '../services/stores/clickhouse-audit-store.js';
import { buildClickHouseAuditBackfillPlan } from './clickhouse-audit-backfill-v2.js';

export interface ClickHouseAuditCompatReportOptions {
  tenantId?: string;
  batchSize?: number;
}

export interface ClickHouseAuditCompatSummary {
  processed: number;
  canonicalRows: number;
  legacyRows: number;
  pluginRows: number;
  unknownRows: number;
  missingTraceSessionLinkRows: number;
  backfillCandidates: number;
  warnings: Array<{ eventId: string; warnings: string[] }>;
}

export function buildClickHouseAuditCompatSummary(
  rows: ClickHouseAuditRow[],
): ClickHouseAuditCompatSummary {
  const plan = buildClickHouseAuditBackfillPlan(rows);

  const summary: ClickHouseAuditCompatSummary = {
    processed: rows.length,
    canonicalRows: 0,
    legacyRows: 0,
    pluginRows: 0,
    unknownRows: 0,
    missingTraceSessionLinkRows: 0,
    backfillCandidates: 0,
    warnings: [],
  };

  rows.forEach((row, index) => {
    const decoded = decodeSharedAuditRecord(ClickHouseAuditStore.mapRowToSharedAuditRecord(row));
    if (decoded.kind === 'canonical-v2') {
      summary.canonicalRows += 1;
    } else if (
      decoded.kind === 'legacy-string-metadata' ||
      decoded.kind === 'legacy-object-metadata'
    ) {
      summary.legacyRows += 1;
    } else if (decoded.kind === 'mongoose-plugin') {
      summary.pluginRows += 1;
    } else {
      summary.unknownRows += 1;
    }

    if (!row.session_id && decoded.envelope?.traceId) {
      summary.missingTraceSessionLinkRows += 1;
    }

    if (plan[index]?.shouldUpdate) {
      summary.backfillCandidates += 1;
    }
    if (plan[index]?.warnings.length) {
      summary.warnings.push({
        eventId: row.event_id,
        warnings: plan[index].warnings,
      });
    }
  });

  return summary;
}

export async function runClickHouseAuditCompatReport(
  options: ClickHouseAuditCompatReportOptions,
  client?: ClickHouseClient,
): Promise<ClickHouseAuditCompatSummary> {
  const clickhouseClient =
    client ?? (await import('@agent-platform/database/clickhouse')).getClickHouseClient();

  const filter = options.tenantId ? `WHERE tenant_id = {tenantId:String}` : '';
  const result = await clickhouseClient.query({
    query: `
      SELECT *
      FROM abl_platform.audit_events
      ${filter}
      ORDER BY timestamp ASC, event_id ASC
      LIMIT {limit:UInt32}
    `,
    query_params: {
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      limit: options.batchSize ?? 500,
    },
    format: 'JSONEachRow',
  });

  const rows = await result.json<ClickHouseAuditRow>();
  return buildClickHouseAuditCompatSummary(rows);
}

function parseArgs(argv: string[]): ClickHouseAuditCompatReportOptions & { json: boolean } {
  const options: ClickHouseAuditCompatReportOptions & { json: boolean } = {
    json: false,
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
    if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runClickHouseAuditCompatReport(args);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Processed: ${summary.processed}`,
      `Canonical rows: ${summary.canonicalRows}`,
      `Legacy rows: ${summary.legacyRows}`,
      `Plugin rows: ${summary.pluginRows}`,
      `Unknown rows: ${summary.unknownRows}`,
      `Missing trace/session linkage: ${summary.missingTraceSessionLinkRows}`,
      `Backfill candidates: ${summary.backfillCandidates}`,
    ].join('\n') + '\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`clickhouse-audit-compat-report failed: ${message}\n`);
    process.exitCode = 1;
  });
}
