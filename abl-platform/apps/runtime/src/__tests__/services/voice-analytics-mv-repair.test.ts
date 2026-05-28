import type { ClickHouseClient } from '@clickhouse/client';
import { describe, expect, test } from 'vitest';
import { ensureVoiceAnalyticsMvUpToDate } from '../../services/voice-analytics-mv-repair.js';

const DATABASE = 'abl_platform';
const DEST_TABLE = 'platform_events_voice_hourly_dest';
const MV_TABLE = 'platform_events_voice_hourly';

interface TableState {
  createTableQuery: string;
  rowCount?: string;
}

interface QueryResult {
  json<T>(): Promise<T[]>;
}

class FakeClickHouseClient {
  readonly commands: string[] = [];

  constructor(private readonly tables: Record<string, TableState>) {}

  async command(params: { query: string }): Promise<void> {
    this.commands.push(params.query);
  }

  async query(params: { query: string; format: 'JSONEachRow' }): Promise<QueryResult> {
    const rows = this.getRows(params.query);

    return {
      async json<T>(): Promise<T[]> {
        return rows as T[];
      },
    };
  }

  private getRows(query: string): Array<Record<string, string>> {
    const systemTableMatch = query.match(/name = '([^']+)'/);
    if (query.includes('FROM system.tables') && systemTableMatch) {
      const tableName = systemTableMatch[1];
      const table = this.tables[tableName];

      if (!table) {
        return [];
      }

      if (query.includes('create_table_query AS createTableQuery')) {
        return [{ createTableQuery: table.createTableQuery }];
      }

      return [{ rowCount: '1' }];
    }

    if (query.includes(`FROM ${DATABASE}.${DEST_TABLE}`)) {
      return [{ rowCount: this.tables[DEST_TABLE]?.rowCount ?? '0' }];
    }

    return [];
  }
}

function asClickHouseClient(client: FakeClickHouseClient): ClickHouseClient {
  return client as unknown as ClickHouseClient;
}

function hasBackupOrRename(commands: string[]): boolean {
  return commands.some((command) => {
    const normalized = command.toLowerCase();
    return normalized.includes('rename table') || normalized.includes('_backup_');
  });
}

describe('ensureVoiceAnalyticsMvUpToDate', () => {
  test('does not rename or create backups for stale existing objects', async () => {
    const client = new FakeClickHouseClient({
      [DEST_TABLE]: { createTableQuery: 'CREATE TABLE dest', rowCount: '10' },
      [MV_TABLE]: { createTableQuery: 'CREATE MATERIALIZED VIEW old_voice_mv' },
    });

    await ensureVoiceAnalyticsMvUpToDate(asClickHouseClient(client));

    expect(client.commands).toHaveLength(0);
    expect(hasBackupOrRename(client.commands)).toBe(false);
  });

  test('creates missing objects without backup copies', async () => {
    const client = new FakeClickHouseClient({});

    await ensureVoiceAnalyticsMvUpToDate(asClickHouseClient(client));

    expect(client.commands).toHaveLength(3);
    expect(client.commands[0]).toContain(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${DEST_TABLE}`);
    expect(client.commands[1]).toContain(
      `CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.${MV_TABLE}`,
    );
    expect(client.commands[2]).toContain(`INSERT INTO ${DATABASE}.${DEST_TABLE}`);
    expect(hasBackupOrRename(client.commands)).toBe(false);
  });

  test('creates missing destination support for an existing view without backups', async () => {
    const client = new FakeClickHouseClient({
      [MV_TABLE]: {
        createTableQuery:
          "CREATE MATERIALIZED VIEW mv AS SELECT JSONHas(data, 'inboundNetworkMos'), JSONHas(data, 'avgE2eLatencyMs'), JSONHas(data, 'homerAvailable')",
      },
    });

    await ensureVoiceAnalyticsMvUpToDate(asClickHouseClient(client));

    expect(client.commands).toHaveLength(3);
    expect(client.commands[0]).toContain(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${DEST_TABLE}`);
    expect(client.commands[1]).toContain(
      `CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.${MV_TABLE}`,
    );
    expect(client.commands[2]).toContain(`INSERT INTO ${DATABASE}.${DEST_TABLE}`);
    expect(hasBackupOrRename(client.commands)).toBe(false);
  });
});
