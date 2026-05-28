/**
 * Migration: Add agent_name column to abl_platform.messages.
 *
 * Idempotent — uses `ADD COLUMN IF NOT EXISTS`. Safe to re-run on every
 * schema converge pass.
 *
 * Why: per-agent analytics and feedback-target lookups need the agent
 * that produced a given message as a first-class column instead of
 * parsing the JSON metadata blob (ABLP-1068, blocks ABLP-988).
 *
 * Online DDL — ClickHouse `ALTER TABLE … ADD COLUMN` is non-blocking;
 * no table lock required. Existing rows backfill to the column default
 * (empty string).
 */

import type { ClickHouseClient } from '@clickhouse/client';

const DATABASE = 'abl_platform';

export async function migrateAddAgentNameToMessages(client: ClickHouseClient): Promise<void> {
  await client.command({
    query: `
      ALTER TABLE ${DATABASE}.messages
        ADD COLUMN IF NOT EXISTS agent_name LowCardinality(String)
        DEFAULT '' CODEC(ZSTD(1))
    `,
  });
}
