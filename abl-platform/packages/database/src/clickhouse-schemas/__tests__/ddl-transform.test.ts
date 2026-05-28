import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DDLTransformOptions,
  resolveDDLTransformOptions,
  transformDDL,
} from '../ddl-transform.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function opts(overrides: Partial<DDLTransformOptions> = {}): DDLTransformOptions {
  return {
    useReplicated: false,
    useTieredStorage: false,
    database: 'abl_platform',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Engine stripping
// ---------------------------------------------------------------------------

describe('transformDDL — Replicated engine handling', () => {
  it('keeps ReplicatedMergeTree when useReplicated=true', () => {
    const ddl = `ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/db.tbl', '{replica}')`;
    const result = transformDDL(ddl, opts({ useReplicated: true }));
    expect(result).toContain('ReplicatedMergeTree(');
  });

  it('strips ReplicatedMergeTree to MergeTree() when useReplicated=false', () => {
    const ddl = `ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/db.tbl', '{replica}')`;
    const result = transformDDL(ddl, opts({ useReplicated: false }));
    expect(result).toContain('ENGINE = MergeTree()');
    expect(result).not.toContain('Replicated');
  });

  it('strips ReplicatedReplacingMergeTree and preserves version column arg', () => {
    const ddl = `ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/db.tbl', '{replica}', processed_at)`;
    const result = transformDDL(ddl, opts({ useReplicated: false }));
    expect(result).toContain('ENGINE = ReplacingMergeTree(processed_at)');
    expect(result).not.toContain('Replicated');
  });

  it('strips ReplicatedReplacingMergeTree without version arg to ReplacingMergeTree()', () => {
    const ddl = `ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/db.tbl', '{replica}')`;
    const result = transformDDL(ddl, opts({ useReplicated: false }));
    expect(result).toContain('ENGINE = ReplacingMergeTree()');
    expect(result).not.toContain('Replicated');
  });

  it('strips ReplicatedAggregatingMergeTree to AggregatingMergeTree()', () => {
    const ddl = `ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/db.tbl', '{replica}')`;
    const result = transformDDL(ddl, opts({ useReplicated: false }));
    expect(result).toContain('ENGINE = AggregatingMergeTree()');
    expect(result).not.toContain('Replicated');
  });

  it('strips ReplicatedSummingMergeTree to SummingMergeTree()', () => {
    const ddl = `ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/db.tbl', '{replica}')`;
    const result = transformDDL(ddl, opts({ useReplicated: false }));
    expect(result).toContain('ENGINE = SummingMergeTree()');
    expect(result).not.toContain('Replicated');
  });

  it('does not modify a non-Replicated ReplacingMergeTree engine', () => {
    const ddl = `ENGINE = ReplacingMergeTree(updated_at)`;
    const result = transformDDL(ddl, opts({ useReplicated: false }));
    expect(result).toContain('ENGINE = ReplacingMergeTree(updated_at)');
  });
});

// ---------------------------------------------------------------------------
// Tiered storage stripping
// ---------------------------------------------------------------------------

describe('transformDDL — tiered storage TTL stripping', () => {
  it('keeps TO VOLUME clauses when useTieredStorage=true', () => {
    const ddl = `
CREATE TABLE abl_platform.messages (
  id UUID,
  created_at DateTime
) ENGINE = MergeTree()
ORDER BY id
TTL
  toDateTime(created_at) + INTERVAL 30 DAY TO VOLUME 'warm',
  toDateTime(created_at) + INTERVAL 90 DAY TO VOLUME 'cold',
  toDateTime(created_at) + INTERVAL 365 DAY DELETE
SETTINGS
  storage_policy = 'tiered',
  index_granularity = 8192;
`;
    const result = transformDDL(ddl, opts({ useTieredStorage: true }));
    expect(result).toContain("TO VOLUME 'warm'");
    expect(result).toContain("TO VOLUME 'cold'");
    expect(result).toContain("storage_policy = 'tiered'");
  });

  it('strips TO VOLUME clauses when useTieredStorage=false', () => {
    const ddl = `
CREATE TABLE abl_platform.messages (
  id UUID,
  created_at DateTime
) ENGINE = MergeTree()
ORDER BY id
TTL
  toDateTime(created_at) + INTERVAL 30 DAY TO VOLUME 'warm',
  toDateTime(created_at) + INTERVAL 90 DAY TO VOLUME 'cold',
  toDateTime(created_at) + INTERVAL 365 DAY DELETE
SETTINGS
  storage_policy = 'tiered',
  index_granularity = 8192;
`;
    const result = transformDDL(ddl, opts({ useTieredStorage: false }));
    expect(result).not.toContain("TO VOLUME 'warm'");
    expect(result).not.toContain("TO VOLUME 'cold'");
    expect(result).not.toContain('storage_policy');
  });

  it('keeps DELETE TTL rule when tiered storage is stripped', () => {
    const ddl = `
CREATE TABLE abl_platform.logs (
  id UUID,
  ts DateTime
) ENGINE = MergeTree()
ORDER BY id
TTL
  ts + INTERVAL 3 DAY TO VOLUME 'warm',
  ts + INTERVAL 14 DAY TO VOLUME 'cold',
  ts + INTERVAL 90 DAY DELETE;
`;
    const result = transformDDL(ddl, opts({ useTieredStorage: false }));
    expect(result).toContain('DELETE');
    expect(result).not.toContain('TO VOLUME');
  });

  it('removes storage_policy setting', () => {
    const ddl = `
CREATE TABLE abl_platform.t (id UUID) ENGINE = MergeTree()
SETTINGS
  storage_policy = 'tiered',
  index_granularity = 8192;
`;
    const result = transformDDL(ddl, opts({ useTieredStorage: false }));
    expect(result).not.toContain('storage_policy');
    expect(result).toContain('index_granularity = 8192');
  });

  it('does not produce an empty TTL block when all TTL clauses are volume-only', () => {
    const ddl = `
CREATE TABLE abl_platform.t (id UUID, ts DateTime) ENGINE = MergeTree()
ORDER BY id
TTL
  ts + INTERVAL 3 DAY TO VOLUME 'warm',
  ts + INTERVAL 30 DAY TO VOLUME 'cold'
SETTINGS
  index_granularity = 8192;
`;
    const result = transformDDL(ddl, opts({ useTieredStorage: false }));
    // After stripping, the TTL block should be gone entirely (merged into SETTINGS)
    expect(result).not.toMatch(/\bTTL\s+SETTINGS/);
    expect(result).toContain('SETTINGS');
    expect(result).not.toContain('TO VOLUME');
  });
});

// ---------------------------------------------------------------------------
// Combined: both Replicated and tiered storage stripped
// ---------------------------------------------------------------------------

describe('transformDDL — strip both Replicated and tiered storage', () => {
  it('strips engine and tiered storage simultaneously', () => {
    const ddl = `
CREATE TABLE abl_platform.platform_events (
  id UUID,
  ts DateTime
) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.platform_events', '{replica}')
ORDER BY id
TTL
  toDateTime(ts) + INTERVAL 30 DAY TO VOLUME 'warm',
  toDateTime(ts) + INTERVAL 90 DAY TO VOLUME 'cold',
  toDateTime(ts) + INTERVAL 365 DAY DELETE
SETTINGS
  storage_policy = 'tiered',
  index_granularity = 8192;
`;
    const result = transformDDL(ddl, opts({ useReplicated: false, useTieredStorage: false }));
    expect(result).toContain('ENGINE = MergeTree()');
    expect(result).not.toContain('Replicated');
    expect(result).not.toContain('TO VOLUME');
    expect(result).not.toContain('storage_policy');
    expect(result).toContain('DELETE');
  });
});

// ---------------------------------------------------------------------------
// Database name replacement
// ---------------------------------------------------------------------------

describe('transformDDL — database name replacement', () => {
  it('replaces abl_platform. prefix with the configured database name', () => {
    const ddl = `CREATE TABLE abl_platform.messages (id UUID) ENGINE = MergeTree() ORDER BY id;`;
    const result = transformDDL(ddl, opts({ database: 'my_db' }));
    expect(result).toContain('my_db.messages');
    expect(result).not.toContain('abl_platform.');
  });

  it('replaces all occurrences of abl_platform. in the DDL', () => {
    const ddl = `
CREATE MATERIALIZED VIEW abl_platform.mv_sessions
TO abl_platform.sessions_dest
AS SELECT * FROM abl_platform.sessions_src;
`;
    const result = transformDDL(ddl, opts({ database: 'test_db' }));
    expect(result).not.toContain('abl_platform.');
    expect(result.match(/test_db\./g)?.length).toBe(3);
  });

  it('does not alter the database name when it already matches', () => {
    const ddl = `CREATE TABLE abl_platform.t (id UUID) ENGINE = MergeTree() ORDER BY id;`;
    const result = transformDDL(ddl, opts({ database: 'abl_platform' }));
    expect(result).toContain('abl_platform.t');
  });
});

// ---------------------------------------------------------------------------
// resolveDDLTransformOptions
// ---------------------------------------------------------------------------

describe('resolveDDLTransformOptions', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const keysToRestore = [
    'CLICKHOUSE_REPLICATED',
    'CLICKHOUSE_TIERED_STORAGE',
    'CLICKHOUSE_DATABASE',
  ];

  beforeEach(() => {
    for (const key of keysToRestore) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keysToRestore) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('defaults to non-replicated, no tiered storage, and abl_platform database', () => {
    const result = resolveDDLTransformOptions({});
    expect(result.useReplicated).toBe(false);
    expect(result.useTieredStorage).toBe(false);
    expect(result.database).toBe('abl_platform');
  });

  it('reads CLICKHOUSE_REPLICATED=true from env', () => {
    const result = resolveDDLTransformOptions({ CLICKHOUSE_REPLICATED: 'true' });
    expect(result.useReplicated).toBe(true);
  });

  it('does not enable replicated for values other than "true"', () => {
    const result = resolveDDLTransformOptions({ CLICKHOUSE_REPLICATED: '1' });
    expect(result.useReplicated).toBe(false);
  });

  it('reads CLICKHOUSE_TIERED_STORAGE=true from env', () => {
    const result = resolveDDLTransformOptions({ CLICKHOUSE_TIERED_STORAGE: 'true' });
    expect(result.useTieredStorage).toBe(true);
  });

  it('reads CLICKHOUSE_DATABASE from env', () => {
    const result = resolveDDLTransformOptions({ CLICKHOUSE_DATABASE: 'custom_db' });
    expect(result.database).toBe('custom_db');
  });

  it('reads all flags from process.env when no argument is given', () => {
    process.env.CLICKHOUSE_REPLICATED = 'true';
    process.env.CLICKHOUSE_TIERED_STORAGE = 'true';
    process.env.CLICKHOUSE_DATABASE = 'env_db';
    const result = resolveDDLTransformOptions();
    expect(result.useReplicated).toBe(true);
    expect(result.useTieredStorage).toBe(true);
    expect(result.database).toBe('env_db');
  });
});
