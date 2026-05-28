/**
 * Migration: Add per-model cost breakdown and customer-visible cost columns
 * to eval_conversations for agent-under-test token cost rollup.
 *
 *  - customer_visible_cost: cost of only customer-visible LLM calls (excludes
 *    internal extraction, guardrails, routing, etc.)
 *  - cost_by_model: JSON string mapping model ID -> cost in dollars
 *
 * DEFAULT values ensure backward compatibility with existing rows.
 *
 * Uses `resolveClickHouseDatabaseName()` so non-default ClickHouse database
 * deployments execute the migration against the configured database rather
 * than the hardcoded `abl_platform`. The companion `.sql` file at
 * `packages/database/clickhouse/migrations/2026-05-11-add-cost-breakdown-to-eval-conversations.sql`
 * remains for human reference but should not be executed directly.
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { resolveClickHouseDatabaseName } from '../database.js';

export interface CostBreakdownMigrationOptions {
  database?: string;
}

export function buildCostBreakdownMigrationQueries(
  options?: CostBreakdownMigrationOptions,
): string[] {
  const database = resolveClickHouseDatabaseName(options?.database);

  return [
    `
      ALTER TABLE ${database}.eval_conversations
        ADD COLUMN IF NOT EXISTS customer_visible_cost Float32 DEFAULT 0
    `,
    `
      ALTER TABLE ${database}.eval_conversations
        ADD COLUMN IF NOT EXISTS cost_by_model String DEFAULT '{}' CODEC(ZSTD(1))
    `,
  ];
}

export async function migrateAddCostBreakdownToEvalConversations(
  client: ClickHouseClient,
  options?: CostBreakdownMigrationOptions,
): Promise<void> {
  for (const query of buildCostBreakdownMigrationQueries(options)) {
    await client.command({ query });
  }
}
