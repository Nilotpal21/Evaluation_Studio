/**
 * Tests for the db-query node's default query templates.
 *
 * Pure contract-shape tests — no service execution, no module mocks needed.
 * Verifies every allowlisted collection/table ships a session_id default query.
 *
 * Service-level allowlist enforcement (reject unknown table/collection) is
 * covered by db-query.test.ts.
 */
import { describe, test, expect } from 'vitest';
import {
  ALLOWED_MONGO_COLLECTIONS,
  ALLOWED_CLICKHOUSE_TABLES,
  ALLOWED_CLICKHOUSE_TABLE_NAMES,
  ALLOWED_MONGO_COLLECTION_NAMES,
} from '../pipeline/contracts/mongo-query-contract.js';

// ---------------------------------------------------------------------------
// Contract shape tests (no service execution)
// ---------------------------------------------------------------------------

describe('ALLOWED_MONGO_COLLECTIONS — contract shape', () => {
  test('every collection has a non-empty defaultQuery', () => {
    for (const col of ALLOWED_MONGO_COLLECTIONS) {
      expect(col.defaultQuery, `${col.name} missing defaultQuery`).toBeTruthy();
    }
  });

  test('every defaultQuery is valid JSON', () => {
    for (const col of ALLOWED_MONGO_COLLECTIONS) {
      expect(
        () => JSON.parse(col.defaultQuery),
        `${col.name} defaultQuery is not valid JSON`,
      ).not.toThrow();
    }
  });

  // session_id is now auto-injected by the executor — templates no longer include it
  test('every defaultQuery does NOT include session_id (auto-injected by service)', () => {
    for (const col of ALLOWED_MONGO_COLLECTIONS) {
      expect(col.defaultQuery).not.toContain('session_id');
    }
  });
});

describe('ALLOWED_CLICKHOUSE_TABLES — contract shape', () => {
  test('every table has a non-empty defaultQuery', () => {
    for (const tbl of ALLOWED_CLICKHOUSE_TABLES) {
      expect(tbl.defaultQuery, `${tbl.name} missing defaultQuery`).toBeTruthy();
    }
  });

  test('every defaultQuery is a SELECT statement', () => {
    for (const tbl of ALLOWED_CLICKHOUSE_TABLES) {
      expect(
        tbl.defaultQuery.trimStart().toUpperCase(),
        `${tbl.name} defaultQuery is not a SELECT`,
      ).toMatch(/^SELECT/);
    }
  });

  // session_id is auto-injected by the executor — templates no longer include it
  test('every defaultQuery does NOT include session_id (auto-injected by service)', () => {
    for (const tbl of ALLOWED_CLICKHOUSE_TABLES) {
      expect(tbl.defaultQuery).not.toContain('session_id');
    }
  });

  test('every defaultQuery references its own table in FROM', () => {
    for (const tbl of ALLOWED_CLICKHOUSE_TABLES) {
      expect(tbl.defaultQuery, `${tbl.name} defaultQuery does not reference its table`).toContain(
        tbl.name,
      );
    }
  });

  test('every defaultQuery includes parameterized tenant_id filter', () => {
    for (const tbl of ALLOWED_CLICKHOUSE_TABLES) {
      expect(tbl.defaultQuery, `${tbl.name} defaultQuery missing tenant_id filter`).toContain(
        '{tenantId:String}',
      );
    }
  });

  test('every defaultQuery includes parameterized project_id filter', () => {
    for (const tbl of ALLOWED_CLICKHOUSE_TABLES) {
      expect(tbl.defaultQuery, `${tbl.name} defaultQuery missing project_id filter`).toContain(
        '{projectId:String}',
      );
    }
  });

  test('covers exactly 9 session_id-indexed tables', () => {
    expect(ALLOWED_CLICKHOUSE_TABLES).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// Allowlist membership tests (pure constant checks, no service execution)
// ---------------------------------------------------------------------------

describe('ALLOWED_CLICKHOUSE_TABLE_NAMES — membership', () => {
  test('contains all 9 session_id-indexed tables', () => {
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toHaveLength(9);
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toContain('abl_platform.platform_events_by_session');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toContain('abl_platform.platform_events');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toContain('abl_platform.messages');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toContain('abl_platform.llm_metrics');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toContain('abl_platform.insight_results');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toContain('abl_platform.custom_pipeline_results');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toContain('abl_platform.spatial_trace_records');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toContain('abl_platform.audit_events');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).toContain('abl_platform.search_queries');
  });

  test('does not contain aggregate/rollup tables', () => {
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).not.toContain('abl_platform.llm_metrics_hourly_dest');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).not.toContain('abl_platform.llm_metrics_daily_dest');
    expect(ALLOWED_CLICKHOUSE_TABLE_NAMES).not.toContain(
      'abl_platform.platform_events_agent_hourly_dest',
    );
  });
});

describe('ALLOWED_MONGO_COLLECTION_NAMES — membership', () => {
  test('contains messages and custom_pipeline_results only', () => {
    expect(ALLOWED_MONGO_COLLECTION_NAMES).toContain('messages');
    expect(ALLOWED_MONGO_COLLECTION_NAMES).toContain('custom_pipeline_results');
    expect(ALLOWED_MONGO_COLLECTION_NAMES).toHaveLength(2);
  });
});
