import { describe, expect, test } from 'vitest';
import {
  ANALYTICS_MVS,
  ANALYTICS_MV_DDL,
  ANALYTICS_TABLE_DDL,
} from '@agent-platform/database/clickhouse-schemas/tables/analytics';

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('Analytics tables DDL', () => {
  test('all materialized views use CREATE MATERIALIZED VIEW IF NOT EXISTS (idempotent)', () => {
    const normalizedMvDdl = ANALYTICS_MV_DDL.map((v) => normalizeSql(v.ddl));

    expect(ANALYTICS_MV_DDL).toHaveLength(ANALYTICS_MVS.length);
    for (const ddl of normalizedMvDdl) {
      expect(ddl).toMatch(/^create materialized view if not exists/);
    }
  });

  test('all base tables use CREATE TABLE IF NOT EXISTS (idempotent)', () => {
    const normalizedTableDdl = ANALYTICS_TABLE_DDL.map((t) => normalizeSql(t.ddl));

    for (const ddl of normalizedTableDdl) {
      expect(ddl).toMatch(/^create table if not exists/);
    }
  });

  test('materialized view names match ANALYTICS_MVS array', () => {
    for (const viewName of ANALYTICS_MVS) {
      const matchingView = ANALYTICS_MV_DDL.find((v) => v.name === viewName);
      expect(matchingView).toBeDefined();
      const ddl = normalizeSql(matchingView!.ddl);
      expect(ddl).toContain(`abl_platform.${viewName}`);
    }
  });
});
