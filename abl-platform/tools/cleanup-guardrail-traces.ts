#!/usr/bin/env npx tsx
/**
 * Cleanup guardrail trace events from ClickHouse.
 *
 * Archives/deletes trace events where:
 *   - event_type IN ('guardrail_input_blocked', 'guardrail_output_blocked')
 *   - data contains presetKey = 'sensitive_data_block'
 *   - timestamp is older than the configured TTL (default 90 days)
 *
 * Production cron is configured externally (Kubernetes CronJob / Harness pipeline).
 * This script is the executable target.
 *
 * Usage:
 *   pnpm tsx tools/cleanup-guardrail-traces.ts --dry-run
 *   pnpm tsx tools/cleanup-guardrail-traces.ts --dry-run=false
 *   pnpm tsx tools/cleanup-guardrail-traces.ts --ttl-days=60
 *   pnpm tsx tools/cleanup-guardrail-traces.ts --tenant=tenant-001
 *   pnpm tsx tools/cleanup-guardrail-traces.ts --help
 *
 * Environment:
 *   CLICKHOUSE_URL  / CLICKHOUSE_HOST  — ClickHouse HTTP endpoint
 *   CLICKHOUSE_USER                     — optional
 *   CLICKHOUSE_PASSWORD                 — optional
 *   NODE_ENV                            — dry-run defaults to true when !== 'production'
 *
 * Tests (to be implemented separately):
 *   TODO: CL-1 — dry-run returns count without deleting
 *   TODO: CL-2 — non-dry-run executes ALTER TABLE DELETE
 *   TODO: CL-3 — tenant filter is applied when --tenant is set
 *   TODO: CL-4 — graceful no-op when ClickHouse env vars are absent
 */

import { createClient, type ClickHouseClient } from '@clickhouse/client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATABASE = 'abl_platform';
const TABLE = 'trace_events';
const FULLY_QUALIFIED_TABLE = `${DATABASE}.${TABLE}`;

const GUARDRAIL_EVENT_TYPES = ['guardrail_input_blocked', 'guardrail_output_blocked'] as const;

const PRESET_KEY = 'sensitive_data_block';
const DEFAULT_TTL_DAYS = 90;

// ---------------------------------------------------------------------------
// CLI types & parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  store: 'clickhouse';
  dryRun: boolean;
  ttlDays: number;
  tenant?: string;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  pnpm tsx tools/cleanup-guardrail-traces.ts [options]

Options:
  --store=clickhouse   Target store (default: clickhouse; only supported value in v1)
  --dry-run            Print count of records that WOULD be deleted (default in non-prod)
  --dry-run=false      Actually delete records (default in prod)
  --ttl-days=<N>       Retention period in days (default: ${DEFAULT_TTL_DAYS})
  --tenant=<tenantId>  Scope to a single tenant (optional; absent = all tenants)
  --help, -h           Show this help

Environment:
  CLICKHOUSE_URL / CLICKHOUSE_HOST   ClickHouse HTTP endpoint
  CLICKHOUSE_USER                     Optional username
  CLICKHOUSE_PASSWORD                 Optional password
  NODE_ENV                            Controls dry-run default (production = false)
`);
}

function parseCliArgs(argv: string[]): CliOptions | 'help' {
  const isProd = process.env.NODE_ENV === 'production';
  const opts: CliOptions = {
    store: 'clickhouse',
    dryRun: !isProd,
    ttlDays: DEFAULT_TTL_DAYS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      return 'help';
    }

    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }

    if (arg === '--dry-run=false') {
      opts.dryRun = false;
      continue;
    }

    if (arg === '--dry-run=true') {
      opts.dryRun = true;
      continue;
    }

    if (arg.startsWith('--store=')) {
      const value = arg.slice('--store='.length);
      if (value !== 'clickhouse') {
        throw new Error(`Unsupported store: ${value}. Only 'clickhouse' is supported in v1.`);
      }
      opts.store = value;
      continue;
    }

    if (arg.startsWith('--ttl-days=')) {
      const raw = arg.slice('--ttl-days='.length);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--ttl-days must be a positive integer (got '${raw}')`);
      }
      opts.ttlDays = parsed;
      continue;
    }

    if (arg.startsWith('--tenant=')) {
      const value = arg.slice('--tenant='.length).trim();
      if (value.length === 0) {
        throw new Error('--tenant requires a non-empty value');
      }
      opts.tenant = value;
      continue;
    }

    if (arg === '--tenant') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--tenant requires a non-empty value');
      }
      opts.tenant = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}. Use --help for usage.`);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// ClickHouse helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether ClickHouse connection info is configured via environment.
 * When neither CLICKHOUSE_URL nor CLICKHOUSE_HOST is set, ClickHouse is
 * considered unavailable (typical in local dev).
 */
function isClickHouseConfigured(): boolean {
  return Boolean(process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST);
}

function createClickHouseClient(): ClickHouseClient {
  const url = process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST || 'http://localhost:8123';
  const username = process.env.CLICKHOUSE_USER;
  const password = process.env.CLICKHOUSE_PASSWORD;

  return createClient({
    url,
    ...(username !== undefined && { username }),
    ...(password !== undefined && { password }),
    request_timeout: 120_000,
  });
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

function buildWhereClause(
  ttlDays: number,
  tenant?: string,
): { clause: string; params: Record<string, string | number> } {
  const conditions: string[] = [
    `event_type IN ({types:Array(String)})`,
    `JSONExtractString(data, 'presetKey') = {presetKey:String}`,
    `timestamp < now() - INTERVAL {ttlDays:UInt32} DAY`,
  ];

  const params: Record<string, string | number> = {
    presetKey: PRESET_KEY,
    ttlDays,
  };

  if (tenant) {
    conditions.push(`tenant_id = {tenantId:String}`);
    params.tenantId = tenant;
  }

  return {
    clause: conditions.join('\n  AND '),
    params,
  };
}

function buildCountQuery(
  ttlDays: number,
  tenant?: string,
): { query: string; params: Record<string, unknown> } {
  const { clause, params } = buildWhereClause(ttlDays, tenant);
  return {
    query: `SELECT count() AS cnt FROM ${FULLY_QUALIFIED_TABLE}\nWHERE ${clause}`,
    params: {
      ...params,
      types: [...GUARDRAIL_EVENT_TYPES],
    },
  };
}

function buildDeleteQuery(
  ttlDays: number,
  tenant?: string,
): { query: string; params: Record<string, unknown> } {
  const { clause, params } = buildWhereClause(ttlDays, tenant);
  return {
    query: `ALTER TABLE ${FULLY_QUALIFIED_TABLE} DELETE\nWHERE ${clause}`,
    params: {
      ...params,
      types: [...GUARDRAIL_EVENT_TYPES],
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed === 'help') {
    printHelp();
    return;
  }

  const opts = parsed;

  // --- Check ClickHouse availability ---
  if (!isClickHouseConfigured()) {
    console.warn(
      '[cleanup-guardrail-traces] CLICKHOUSE_URL / CLICKHOUSE_HOST not set — skipping cleanup (no-op).',
    );
    return;
  }

  const client = createClickHouseClient();

  try {
    // Verify connectivity before proceeding
    const ping = await client.ping();
    if (!ping.success) {
      console.warn('[cleanup-guardrail-traces] ClickHouse ping failed — skipping cleanup (no-op).');
      return;
    }

    const tenantLabel = opts.tenant ? ` for tenant=${opts.tenant}` : ' across all tenants';

    if (opts.dryRun) {
      // Dry-run: count matching records
      const { query, params } = buildCountQuery(opts.ttlDays, opts.tenant);
      const result = await client.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ cnt: string }>();
      const count = rows.length > 0 ? rows[0].cnt : '0';

      console.log(
        `[cleanup-guardrail-traces] [DRY-RUN] Would delete ${count} records older than ${opts.ttlDays} days${tenantLabel}.`,
      );
    } else {
      // Count first for reporting, then delete
      const { query: countQuery, params: countParams } = buildCountQuery(opts.ttlDays, opts.tenant);
      const countResult = await client.query({
        query: countQuery,
        query_params: countParams,
        format: 'JSONEachRow',
      });
      const countRows = await countResult.json<{ cnt: string }>();
      const count = countRows.length > 0 ? countRows[0].cnt : '0';

      // Execute deletion
      const { query: deleteQuery, params: deleteParams } = buildDeleteQuery(
        opts.ttlDays,
        opts.tenant,
      );
      await client.command({
        query: deleteQuery,
        query_params: deleteParams,
      });

      console.log(
        `[cleanup-guardrail-traces] Deleted ${count} records older than ${opts.ttlDays} days${tenantLabel}.`,
      );
    }
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[cleanup-guardrail-traces] Failed: ${message}`);
  process.exit(1);
});
