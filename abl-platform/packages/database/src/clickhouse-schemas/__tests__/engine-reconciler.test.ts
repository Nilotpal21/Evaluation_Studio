import { describe, expect, it } from 'vitest';
import { getDesiredEngine, extractColumnsFromDDL, normalizeEngine } from '../engine-reconciler.js';

// ---------------------------------------------------------------------------
// normalizeEngine
// ---------------------------------------------------------------------------

describe('normalizeEngine', () => {
  it('strips empty parentheses', () => {
    expect(normalizeEngine('MergeTree()')).toBe('MergeTree');
  });

  it('strips empty parentheses with whitespace', () => {
    expect(normalizeEngine('MergeTree( )')).toBe('MergeTree');
  });

  it('preserves engine name without parens', () => {
    expect(normalizeEngine('MergeTree')).toBe('MergeTree');
  });

  it('trims whitespace', () => {
    expect(normalizeEngine('  ReplacingMergeTree  ')).toBe('ReplacingMergeTree');
  });

  it('does not strip non-empty parentheses', () => {
    expect(normalizeEngine('ReplacingMergeTree(processed_at)')).toBe(
      'ReplacingMergeTree(processed_at)',
    );
  });
});

// ---------------------------------------------------------------------------
// getDesiredEngine
// ---------------------------------------------------------------------------

describe('getDesiredEngine', () => {
  it('extracts MergeTree from simple DDL', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS db.tbl (id UInt64) ENGINE = MergeTree() ORDER BY id`;
    expect(getDesiredEngine(ddl)).toBe('MergeTree');
  });

  it('extracts ReplacingMergeTree from DDL with args', () => {
    const ddl = `ENGINE = ReplacingMergeTree(processed_at)`;
    expect(getDesiredEngine(ddl)).toBe('ReplacingMergeTree');
  });

  it('extracts ReplicatedMergeTree', () => {
    const ddl = `ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/db.tbl', '{replica}')`;
    expect(getDesiredEngine(ddl)).toBe('ReplicatedMergeTree');
  });

  it('extracts engine name without parens', () => {
    const ddl = `ENGINE = MergeTree\nPARTITION BY toYYYYMM(ts)`;
    expect(getDesiredEngine(ddl)).toBe('MergeTree');
  });

  it('is case-insensitive for ENGINE keyword', () => {
    const ddl = `engine = SummingMergeTree()`;
    expect(getDesiredEngine(ddl)).toBe('SummingMergeTree');
  });

  it('returns undefined for DDL without ENGINE', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS db.tbl (id UInt64)`;
    expect(getDesiredEngine(ddl)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractColumnsFromDDL
// ---------------------------------------------------------------------------

describe('extractColumnsFromDDL', () => {
  it('extracts columns from a simple DDL', () => {
    const ddl = `
CREATE TABLE IF NOT EXISTS db.tbl (
    tenant_id String,
    session_id String,
    created_at DateTime64(3)
)
ENGINE = MergeTree()
ORDER BY (tenant_id, session_id)
`;
    expect(extractColumnsFromDDL(ddl)).toEqual(['tenant_id', 'session_id', 'created_at']);
  });

  it('skips INDEX lines', () => {
    const ddl = `
CREATE TABLE IF NOT EXISTS db.tbl (
    tenant_id String,
    message_id String,
    INDEX idx_msg message_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree()
ORDER BY tenant_id
`;
    expect(extractColumnsFromDDL(ddl)).toEqual(['tenant_id', 'message_id']);
  });

  it('skips comment lines', () => {
    const ddl = `
CREATE TABLE IF NOT EXISTS db.tbl (
    -- This is a comment
    tenant_id String,
    session_id String
)
ENGINE = MergeTree()
`;
    expect(extractColumnsFromDDL(ddl)).toEqual(['tenant_id', 'session_id']);
  });

  it('handles columns with CODEC and DEFAULT', () => {
    const ddl = `
CREATE TABLE IF NOT EXISTS db.tbl (
    tenant_id String CODEC(ZSTD(1)),
    count UInt32 DEFAULT 0 CODEC(T64, ZSTD(1)),
    name LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))
)
ENGINE = MergeTree()
`;
    expect(extractColumnsFromDDL(ddl)).toEqual(['tenant_id', 'count', 'name']);
  });

  it('handles Nullable and Array types', () => {
    const ddl = `
CREATE TABLE IF NOT EXISTS db.tbl (
    completed_at Nullable(DateTime64(3, 'UTC')),
    tags Array(String),
    nested Array(LowCardinality(String))
)
ENGINE = MergeTree()
`;
    expect(extractColumnsFromDDL(ddl)).toEqual(['completed_at', 'tags', 'nested']);
  });

  it('returns empty array for invalid DDL', () => {
    expect(extractColumnsFromDDL('not a create table')).toEqual([]);
  });

  it('handles real workflow DDL', () => {
    const ddl = `
CREATE TABLE IF NOT EXISTS abl_platform.workflow_execution_events
(
    event_id          UUID,
    event_version     LowCardinality(String),
    execution_id      String               CODEC(ZSTD(1)),
    tenant_id         LowCardinality(String),
    project_id        LowCardinality(String),
    status            LowCardinality(String),
    occurred_at       DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
    ingested_at       DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, project_id, execution_id, occurred_at)
SETTINGS index_granularity = 8192
`;
    const cols = extractColumnsFromDDL(ddl);
    expect(cols).toEqual([
      'event_id',
      'event_version',
      'execution_id',
      'tenant_id',
      'project_id',
      'status',
      'occurred_at',
      'ingested_at',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Drift detection logic (pure-function reasoning)
// ---------------------------------------------------------------------------

describe('drift detection helpers', () => {
  it('normalizeEngine treats MergeTree and MergeTree() as equivalent', () => {
    expect(normalizeEngine('MergeTree()')).toBe(normalizeEngine('MergeTree'));
  });

  it('normalizeEngine distinguishes ReplacingMergeTree from MergeTree', () => {
    expect(normalizeEngine('ReplacingMergeTree')).not.toBe(normalizeEngine('MergeTree'));
  });

  it('getDesiredEngine + normalizeEngine pipeline works for upgrade detection', () => {
    // Actual table has MergeTree, desired DDL says ReplicatedMergeTree
    const actualEngine = 'MergeTree';
    const desiredDDL = `ENGINE = ReplicatedMergeTree('/path', '{replica}')`;
    const desiredEngine = getDesiredEngine(desiredDDL);

    expect(desiredEngine).toBe('ReplicatedMergeTree');
    expect(normalizeEngine(actualEngine)).not.toBe(normalizeEngine(desiredEngine!));
  });

  it('getDesiredEngine + normalizeEngine pipeline shows no drift when engines match', () => {
    const actualEngine = 'MergeTree';
    const desiredDDL = `ENGINE = MergeTree()`;
    const desiredEngine = getDesiredEngine(desiredDDL);

    expect(normalizeEngine(actualEngine)).toBe(normalizeEngine(desiredEngine!));
  });
});
