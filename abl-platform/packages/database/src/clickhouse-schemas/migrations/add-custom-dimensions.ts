/**
 * Migration: Add custom_dimensions Map column to platform_events.
 *
 * ClickHouse ALTER TABLE ... ADD COLUMN is a non-blocking online DDL.
 * Safe to run on a live cluster — no table lock required.
 */

import type { ClickHouseClient } from '@clickhouse/client';

const DATABASE = 'abl_platform';

export async function migrateAddCustomDimensions(client: ClickHouseClient): Promise<void> {
  await client.command({
    query: `
      ALTER TABLE ${DATABASE}.platform_events
        ADD COLUMN IF NOT EXISTS custom_dimensions Map(String, String)
        DEFAULT map() CODEC(ZSTD(3))
    `,
  });

  await client.command({
    query: `
      ALTER TABLE ${DATABASE}.platform_events
        ADD INDEX IF NOT EXISTS idx_custom_dims mapKeys(custom_dimensions)
        TYPE ngrambf_v1(3, 256, 2, 0) GRANULARITY 4
    `,
  });
}
