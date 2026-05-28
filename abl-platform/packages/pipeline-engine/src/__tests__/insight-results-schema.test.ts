import { describe, test, expect } from 'vitest';
import { TABLES } from '@agent-platform/database/clickhouse-schemas/init';

describe('insight_results ClickHouse table', () => {
  const table = TABLES.find((t) => t.name === 'insight_results');

  test('table definition exists in TABLES array', () => {
    expect(table).toBeDefined();
  });

  test('DDL contains required columns', () => {
    const ddl = table!.ddl;
    const requiredColumns = [
      'tenant_id',
      'project_id',
      'insight_type',
      'granularity',
      'session_id',
      'message_id',
      'span_id',
      'agent_name',
      'score',
      'status',
      'dimensions',
      'pipeline_id',
      'run_id',
      'evaluated_at',
      'event_timestamp',
      'expires_at',
    ];
    for (const col of requiredColumns) {
      expect(ddl).toContain(col);
    }
  });

  test('DDL uses MergeTree engine', () => {
    expect(table!.ddl).toMatch(/MergeTree/);
  });

  test('DDL partitions by tenant_id and month', () => {
    expect(table!.ddl).toMatch(/PARTITION BY.*tenant_id.*toYYYYMM/s);
  });

  test('DDL orders by tenant, project, insight_type, granularity, evaluated_at', () => {
    expect(table!.ddl).toMatch(
      /ORDER BY.*tenant_id.*project_id.*insight_type.*granularity.*evaluated_at/s,
    );
  });

  test('DDL includes TTL on expires_at', () => {
    expect(table!.ddl).toMatch(/TTL.*expires_at/s);
  });
});

describe('custom_pipeline_results ClickHouse table', () => {
  const table = TABLES.find((t) => t.name === 'custom_pipeline_results');

  test('table definition exists in TABLES array', () => {
    expect(table).toBeDefined();
  });

  test('DDL contains shared custom pipeline result columns', () => {
    const ddl = table!.ddl;
    const requiredColumns = [
      'tenant_id',
      'project_id',
      'pipeline_id',
      'pipeline_name',
      'pipeline_kind',
      'run_id',
      'session_id',
      'store_step_id',
      'source_step_id',
      'source_step_status',
      'trigger_id',
      'execution_mode',
      'source',
      'score_name',
      'score_path',
      'score_value',
      'output_json',
      'created_at',
    ];
    for (const col of requiredColumns) {
      expect(ddl).toContain(col);
    }
  });

  test('DDL indexes pipeline name and run identifiers for manual inspection', () => {
    const ddl = table!.ddl;
    expect(ddl).toContain('idx_pipeline_name');
    expect(ddl).toContain('idx_pipeline_id');
    expect(ddl).toContain('idx_run_id');
  });
});
