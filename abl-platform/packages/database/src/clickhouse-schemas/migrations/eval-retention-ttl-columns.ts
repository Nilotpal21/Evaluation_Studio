import type { ClickHouseClient } from '@clickhouse/client';
import {
  CH_EVAL_DATA_TTL_DAYS,
  CH_PRODUCTION_SCORES_TTL_DAYS,
} from '../../constants/eval-limits.js';
import { resolveClickHouseDatabaseName } from '../database.js';

export interface EvalRetentionTtlColumnsMigrationOptions {
  database?: string;
}

export function buildEvalRetentionTtlColumnsMigrationQueries(
  options?: EvalRetentionTtlColumnsMigrationOptions,
): string[] {
  const database = resolveClickHouseDatabaseName(options?.database);

  return [
    `
      ALTER TABLE ${database}.eval_conversations
          ADD COLUMN IF NOT EXISTS known_source LowCardinality(String) DEFAULT 'eval' CODEC(ZSTD(1)),
          ADD COLUMN IF NOT EXISTS ttl_override_days UInt16 DEFAULT ${CH_EVAL_DATA_TTL_DAYS} CODEC(T64, ZSTD(1)),
          MODIFY TTL toDateTime(created_at) + toIntervalDay(ttl_override_days) DELETE
    `,
    `
      ALTER TABLE ${database}.eval_scores
          ADD COLUMN IF NOT EXISTS known_source LowCardinality(String) DEFAULT 'eval' CODEC(ZSTD(1)),
          ADD COLUMN IF NOT EXISTS ttl_override_days UInt16 DEFAULT ${CH_EVAL_DATA_TTL_DAYS} CODEC(T64, ZSTD(1)),
          MODIFY TTL toDateTime(created_at) + toIntervalDay(ttl_override_days) DELETE
    `,
    `
      ALTER TABLE ${database}.eval_production_scores
          ADD COLUMN IF NOT EXISTS ttl_override_days UInt16 DEFAULT ${CH_PRODUCTION_SCORES_TTL_DAYS} CODEC(T64, ZSTD(1)),
          MODIFY TTL toDateTime(timestamp) + toIntervalDay(ttl_override_days) DELETE
    `,
  ];
}

export async function migrateEvalRetentionTtlColumns(
  client: ClickHouseClient,
  options?: EvalRetentionTtlColumnsMigrationOptions,
): Promise<void> {
  for (const query of buildEvalRetentionTtlColumnsMigrationQueries(options)) {
    await client.command({ query });
  }
}
