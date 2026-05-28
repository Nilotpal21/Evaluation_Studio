#!/usr/bin/env npx tsx
/**
 * Workflow Mongo ↔ ClickHouse parity-check CLI (LLD §6.4, feature-spec §10).
 *
 * Samples N random executions from Mongo, fetches the matching row from
 * `workflow_executions_latest` in CH, and diffs 10 canonical fields.
 * Exits non-zero if the drift rate exceeds `--threshold` (default 0.1%).
 *
 * Drift = any sampled execution where at least one canonical field
 * disagrees between Mongo and CH. Per-field drift counts are also
 * reported so operators can tell *where* the divergence sits.
 *
 * Usage
 * -----
 *   pnpm tsx tools/test-infra/parity-check.ts
 *   pnpm tsx tools/test-infra/parity-check.ts --sample-size 500 --threshold 0.05
 *   pnpm tsx tools/test-infra/parity-check.ts --tenant-id t1 --help
 *
 * Env vars (standard repo config — never sourced, read directly):
 *   MONGODB_URL           — Mongo connection string
 *   CLICKHOUSE_URL        — e.g. http://localhost:8123
 *   CLICKHOUSE_DATABASE   — defaults to abl_platform
 *   CLICKHOUSE_USERNAME   — defaults to default
 *   CLICKHOUSE_PASSWORD   — optional
 */

import mongoose from 'mongoose';
import { createClient, type ClickHouseClient } from '@clickhouse/client';

/** Canonical per-execution fields diffed on each pair (LLD §6.4). */
const CANONICAL_FIELDS = [
  'status',
  'workflow_version',
  'started_at',
  'completed_at',
  'duration_ms',
  'workflow_id',
  'project_id',
  'trigger_type',
  'last_event_at',
  'error_code',
] as const;
type CanonicalField = (typeof CANONICAL_FIELDS)[number];

interface ParityArgs {
  sampleSize: number;
  threshold: number;
  tenantId?: string;
  help: boolean;
}

interface MongoExecutionRow {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  workflowVersion?: string;
  status: string;
  triggerType?: string;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs?: number;
  error?: { code?: string; message?: string } | null;
  updatedAt?: Date;
}

interface ChLatestRow {
  execution_id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  workflow_version: string;
  status: string;
  trigger_type: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  last_event_at: string;
  error_code: string | null;
}

function parseArgs(argv: string[]): ParityArgs {
  const args: ParityArgs = { sampleSize: 1000, threshold: 0.001, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--sample-size') {
      const next = argv[++i];
      if (next) args.sampleSize = Number.parseInt(next, 10);
    } else if (arg === '--threshold') {
      const next = argv[++i];
      if (next) args.threshold = Number.parseFloat(next);
    } else if (arg === '--tenant-id') {
      args.tenantId = argv[++i];
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  pnpm tsx tools/test-infra/parity-check.ts [options]

Options:
  --sample-size <N>       Random sample size (default 1000)
  --threshold <decimal>   Drift threshold to exit non-zero (default 0.001 = 0.1%)
  --tenant-id <id>        Restrict sampling to a tenant (optional)
  --help, -h              Show this help

Exit codes:
  0  drift ≤ threshold
  1  drift > threshold
  2  invalid args or connection failure
`);
}

function normalizeMongoTimestamp(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' ? v : null;
}

function normalizeChTimestamp(v: string | null | undefined): string | null {
  // ClickHouse DateTime64(3, 'UTC') serializes as `YYYY-MM-DD HH:MM:SS.sss` —
  // convert to ISO-8601 for comparison with Mongo's Date.toISOString().
  if (!v || v === '1970-01-01 00:00:00.000') return null;
  const match = v.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/);
  if (!match) return v;
  const ms = match[3] ?? '.000';
  return `${match[1]}T${match[2]}${ms.padEnd(4, '0')}Z`;
}

function diffField(
  field: CanonicalField,
  mongo: MongoExecutionRow,
  ch: ChLatestRow,
): { match: boolean; mongoValue: unknown; chValue: unknown } {
  switch (field) {
    case 'status':
      return { match: mongo.status === ch.status, mongoValue: mongo.status, chValue: ch.status };
    case 'workflow_version':
      return {
        match: (mongo.workflowVersion ?? '') === (ch.workflow_version ?? ''),
        mongoValue: mongo.workflowVersion,
        chValue: ch.workflow_version,
      };
    case 'started_at': {
      const m = normalizeMongoTimestamp(mongo.startedAt);
      const c = normalizeChTimestamp(ch.started_at);
      return { match: m === c, mongoValue: m, chValue: c };
    }
    case 'completed_at': {
      const m = normalizeMongoTimestamp(mongo.completedAt);
      const c = normalizeChTimestamp(ch.completed_at);
      return { match: m === c, mongoValue: m, chValue: c };
    }
    case 'duration_ms': {
      const m = mongo.durationMs ?? 0;
      const c = ch.duration_ms ?? 0;
      return { match: m === c, mongoValue: m, chValue: c };
    }
    case 'workflow_id':
      return {
        match: mongo.workflowId === ch.workflow_id,
        mongoValue: mongo.workflowId,
        chValue: ch.workflow_id,
      };
    case 'project_id':
      return {
        match: mongo.projectId === ch.project_id,
        mongoValue: mongo.projectId,
        chValue: ch.project_id,
      };
    case 'trigger_type':
      return {
        match: (mongo.triggerType ?? '') === (ch.trigger_type ?? ''),
        mongoValue: mongo.triggerType,
        chValue: ch.trigger_type,
      };
    case 'last_event_at': {
      const m = normalizeMongoTimestamp(mongo.updatedAt);
      const c = normalizeChTimestamp(ch.last_event_at);
      return { match: m === c, mongoValue: m, chValue: c };
    }
    case 'error_code': {
      const m = mongo.error?.code ?? '';
      const c = ch.error_code ?? '';
      return { match: m === c, mongoValue: m, chValue: c };
    }
  }
}

async function sampleMongo(sampleSize: number, tenantId?: string): Promise<MongoExecutionRow[]> {
  const match: Record<string, unknown> = {};
  if (tenantId) match.tenantId = tenantId;
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongoose connection not ready');
  const cursor = db
    .collection('workflow_executions')
    .aggregate<MongoExecutionRow>([{ $match: match }, { $sample: { size: sampleSize } }]);
  return await cursor.toArray();
}

async function fetchCh(
  ch: ClickHouseClient,
  executionIds: string[],
): Promise<Map<string, ChLatestRow>> {
  if (executionIds.length === 0) return new Map();
  const result = await ch.query({
    query: `
      SELECT execution_id, tenant_id, project_id, workflow_id, workflow_version,
             status, trigger_type, started_at, completed_at, duration_ms,
             last_event_at, '' AS error_code
      FROM abl_platform.workflow_executions_latest FINAL
      WHERE execution_id IN {ids:Array(String)}
      SETTINGS max_execution_time = 30
    `,
    query_params: { ids: executionIds },
    format: 'JSONEachRow',
  });
  const rows = await result.json<ChLatestRow>();
  return new Map(rows.map((r) => [r.execution_id, r]));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isFinite(args.sampleSize) || args.sampleSize <= 0) {
    process.stderr.write('--sample-size must be a positive integer\n');
    process.exit(2);
  }
  if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 1) {
    process.stderr.write('--threshold must be in [0, 1]\n');
    process.exit(2);
  }

  const mongoUrl = process.env.MONGODB_URL;
  const chUrl = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
  if (!mongoUrl) {
    process.stderr.write('MONGODB_URL is required\n');
    process.exit(2);
  }

  const chClient = createClient({
    url: chUrl,
    database: process.env.CLICKHOUSE_DATABASE ?? 'abl_platform',
    username: process.env.CLICKHOUSE_USERNAME ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD,
  });

  try {
    await mongoose.connect(mongoUrl);
    process.stdout.write(
      `Sampling up to ${args.sampleSize} executions from Mongo${
        args.tenantId ? ` (tenant=${args.tenantId})` : ''
      }…\n`,
    );
    const sampled = await sampleMongo(args.sampleSize, args.tenantId);
    process.stdout.write(`Got ${sampled.length} rows\n`);

    if (sampled.length === 0) {
      process.stdout.write('No executions sampled — nothing to compare.\n');
      process.exit(0);
    }

    const chByExec = await fetchCh(
      chClient,
      sampled.map((r) => r._id),
    );
    process.stdout.write(`CH returned ${chByExec.size} matching rows\n`);

    let driftedExecutions = 0;
    const fieldDrift: Record<CanonicalField, number> = Object.fromEntries(
      CANONICAL_FIELDS.map((f) => [f, 0]),
    ) as Record<CanonicalField, number>;
    let chMissing = 0;

    for (const mongoRow of sampled) {
      const chRow = chByExec.get(mongoRow._id);
      if (!chRow) {
        driftedExecutions++;
        chMissing++;
        continue;
      }
      let anyFieldDrift = false;
      for (const field of CANONICAL_FIELDS) {
        const { match } = diffField(field, mongoRow, chRow);
        if (!match) {
          fieldDrift[field]++;
          anyFieldDrift = true;
        }
      }
      if (anyFieldDrift) driftedExecutions++;
    }

    const totalComparable = sampled.length;
    const driftRate = driftedExecutions / totalComparable;
    process.stdout.write('\n─── Parity Report ───\n');
    process.stdout.write(`Total sampled:      ${totalComparable}\n`);
    process.stdout.write(`CH missing:         ${chMissing}\n`);
    process.stdout.write(
      `Drifted executions: ${driftedExecutions} (${(driftRate * 100).toFixed(3)}%)\n`,
    );
    process.stdout.write(`Drift threshold:    ${(args.threshold * 100).toFixed(3)}%\n`);
    process.stdout.write('\nPer-field drift counts:\n');
    for (const field of CANONICAL_FIELDS) {
      process.stdout.write(`  ${field.padEnd(18)} ${fieldDrift[field]}\n`);
    }

    if (driftRate > args.threshold) {
      process.stdout.write('\nFAIL: drift exceeds threshold.\n');
      process.exit(1);
    }
    process.stdout.write('\nOK: drift within threshold.\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `Parity check failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  } finally {
    await mongoose.disconnect().catch((err) => {
      process.stderr.write(`mongo disconnect error (non-fatal): ${String(err)}\n`);
    });
    await chClient.close().catch((err) => {
      process.stderr.write(`clickhouse close error (non-fatal): ${String(err)}\n`);
    });
  }
}

main();
