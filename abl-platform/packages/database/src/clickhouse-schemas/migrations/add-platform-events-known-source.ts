/**
 * Migration: Add known_source column to platform_events and its session-ordered copy.
 *
 * Existing rows default to production. The materialized view must be recreated because
 * ClickHouse view SELECT lists do not update when a target/source column is added.
 */

import type { ClickHouseClient } from '@clickhouse/client';

const DATABASE = 'abl_platform';

export async function migrateAddPlatformEventsKnownSource(client: ClickHouseClient): Promise<void> {
  await client.command({
    query: `
      ALTER TABLE ${DATABASE}.platform_events
        ADD COLUMN IF NOT EXISTS known_source LowCardinality(String)
        DEFAULT 'production' CODEC(ZSTD(1))
    `,
  });

  await client.command({
    query: `
      ALTER TABLE ${DATABASE}.platform_events_by_session
        ADD COLUMN IF NOT EXISTS known_source LowCardinality(String)
        DEFAULT 'production' CODEC(ZSTD(1))
    `,
  });

  await client.command({
    query: `DROP VIEW IF EXISTS ${DATABASE}.platform_events_by_session_mv`,
  });

  await client.command({
    query: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.platform_events_by_session_mv
      TO ${DATABASE}.platform_events_by_session
      AS SELECT
          tenant_id,
          project_id,
          event_id,
          event_type,
          category,
          timestamp,
          session_id,
          trace_id,
          span_id,
          parent_span_id,
          agent_name,
          deployment_id,
          known_source,
          channel,
          actor_id,
          actor_type,
          duration_ms,
          has_error,
          error_message,
          error_type,
          data,
          metadata,
          custom_dimensions,
          _enc
      FROM ${DATABASE}.platform_events
      WHERE session_id != ''
    `,
  });
}
