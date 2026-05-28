import { describe, expect, test, vi } from 'vitest';

import {
  buildEvalRetentionTtlColumnsMigrationQueries,
  migrateEvalRetentionTtlColumns,
} from '../clickhouse-schemas/migrations/eval-retention-ttl-columns.js';

function createMockClickHouseClient() {
  return {
    command: vi.fn().mockResolvedValue(undefined),
  };
}

describe('eval retention TTL ClickHouse migration', () => {
  test('targets a non-default database name', async () => {
    const client = createMockClickHouseClient();

    await migrateEvalRetentionTtlColumns(client, { database: 'abl_platform_test' });

    const queries = client.command.mock.calls.map(([params]) => params.query);

    expect(queries).toHaveLength(3);
    expect(queries.every((query) => query.includes('abl_platform_test.'))).toBe(true);
    expect(queries.some((query) => query.includes('abl_platform.eval_conversations'))).toBe(false);
    expect(queries.join('\n')).toContain('MODIFY TTL');
  });

  test('rejects unsafe database identifiers before building ALTER statements', () => {
    expect(() =>
      buildEvalRetentionTtlColumnsMigrationQueries({ database: 'abl_platform;DROP' }),
    ).toThrow('Invalid ClickHouse database identifier');
  });
});
