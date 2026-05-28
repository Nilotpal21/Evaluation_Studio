import { describe, expect, test } from 'vitest';

import {
  EVAL_TABLE_ALTER_DDL,
  EVAL_TABLE_DDL,
} from '@agent-platform/database/clickhouse-schemas/tables/eval';

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('initEvalTables retention DDL', () => {
  test('creates eval tables with per-row retention columns and column-driven TTL', () => {
    const createSql = EVAL_TABLE_DDL.map((table) => normalizeSql(table.ddl)).join(' ');

    expect(createSql).toContain('known_source lowcardinality(string)');
    expect(createSql).toContain('ttl_override_days uint16');
    expect(createSql).toContain('ttl todatetime(created_at) + tointervalday(ttl_override_days)');
    expect(createSql).toContain('ttl todatetime(timestamp) + tointervalday(ttl_override_days)');
  });

  test('verifies retention columns on existing tables after create statements', () => {
    const normalizedAlters = EVAL_TABLE_ALTER_DDL.map((a) => normalizeSql(a.ddl));

    expect(EVAL_TABLE_ALTER_DDL).toHaveLength(5);
    expect(normalizedAlters.some((query) => query.includes('modify ttl'))).toBe(true);
    expect(normalizedAlters.some((query) => query.startsWith('alter table'))).toBe(true);
  });
});
