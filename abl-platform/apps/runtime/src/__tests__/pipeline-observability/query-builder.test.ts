import { describe, it, expect } from 'vitest';
import {
  buildPipelineDataQuery,
  QueryBuilderError,
  type BuildQueryArgs,
} from '../../services/pipeline-observability/query-builder.js';
import type { ColumnMeta } from '../../services/pipeline-observability/schema-resolver.js';

const COLUMNS: ColumnMeta[] = [
  { name: 'run_id', type: 'String', filterable: true, exportable: true },
  { name: 'session_id', type: 'String', filterable: true, exportable: true },
  { name: 'processed_at', type: 'DateTime', filterable: false, exportable: true },
  { name: 'score', type: 'Float64', filterable: true, exportable: true },
  { name: 'label', type: 'String', filterable: true, exportable: true },
  { name: 'raw', type: 'String', filterable: false, exportable: false },
];

const base: BuildQueryArgs = {
  tenantId: 'tA',
  projectId: 'pX',
  pipelineId: 'def-1',
  tableName: 'abl_platform.sentiment_scores',
  columns: COLUMNS,
  timeRange: {
    from: new Date('2026-04-12T00:00:00Z'),
    to: new Date('2026-04-13T00:00:00Z'),
  },
  filters: [],
  limit: 50,
  offset: 0,
};

describe('buildPipelineDataQuery', () => {
  it('builds a valid query with forced tenant/project isolation', () => {
    const { sql, params } = buildPipelineDataQuery(base);
    expect(sql).toContain('FROM abl_platform.sentiment_scores');
    expect(sql).toContain('tenant_id = {tenantId:String}');
    expect(sql).toContain('project_id = {projectId:String}');
    expect(sql).toContain('processed_at >= {from:DateTime64(3)}');
    expect(sql).toContain('processed_at <= {to:DateTime64(3)}');
    expect(params.tenantId).toBe('tA');
    expect(params.projectId).toBe('pX');
  });

  it('rejects non-filterable columns', () => {
    expect(() =>
      buildPipelineDataQuery({
        ...base,
        filters: [{ column: 'raw', op: '=', value: 'anything' }],
      }),
    ).toThrow(/not filterable/);
  });

  it('rejects invalid table names', () => {
    expect(() => buildPipelineDataQuery({ ...base, tableName: 'analytics; DROP TABLE' })).toThrow(
      QueryBuilderError,
    );
  });

  it('rejects table names without database prefix', () => {
    expect(() => buildPipelineDataQuery({ ...base, tableName: 'just_a_table' })).toThrow(
      QueryBuilderError,
    );
  });

  it("supports 'in' operator with array parameter", () => {
    const { sql, params } = buildPipelineDataQuery({
      ...base,
      filters: [{ column: 'label', op: 'in', value: ['pos', 'neg'] }],
    });
    expect(sql).toMatch(/label IN \{f0:Array\(String\)\}/);
    expect(params.f0).toEqual(['pos', 'neg']);
  });

  it("supports 'contains' only on String columns", () => {
    expect(() =>
      buildPipelineDataQuery({
        ...base,
        filters: [{ column: 'score', op: 'contains', value: '1' }],
      }),
    ).toThrow(/only valid on String/);
  });

  it("supports 'contains' on String columns", () => {
    const { sql, params } = buildPipelineDataQuery({
      ...base,
      filters: [{ column: 'label', op: 'contains', value: 'pos' }],
    });
    expect(sql).toContain('positionCaseInsensitive(label, {f0:String}) > 0');
    expect(params.f0).toBe('pos');
  });

  it('enforces a maximum limit of 500', () => {
    const { params } = buildPipelineDataQuery({ ...base, limit: 9999 });
    expect(params.limit).toBe(500);
  });

  it('forces limit to at least 1', () => {
    const { params } = buildPipelineDataQuery({ ...base, limit: 0 });
    expect(params.limit).toBe(1);
  });

  it('optionally includes run_id and session_id filters', () => {
    const { sql, params } = buildPipelineDataQuery({
      ...base,
      sessionId: 'sess-1',
      runId: 'run-xyz',
    });
    expect(sql).toContain('session_id = {sessionId:String}');
    expect(sql).toContain('run_id = {runId:String}');
    expect(params.sessionId).toBe('sess-1');
    expect(params.runId).toBe('run-xyz');
  });

  it('forces pipeline_id when the selected table exposes pipeline_id', () => {
    const { sql, params } = buildPipelineDataQuery({
      ...base,
      columns: [
        ...COLUMNS,
        { name: 'pipeline_id', type: 'String', filterable: false, exportable: true },
      ],
    });

    expect(sql).toContain('pipeline_id = {pipelineId:String}');
    expect(params.pipelineId).toBe('def-1');
  });

  it('only selects exportable columns', () => {
    const { sql } = buildPipelineDataQuery(base);
    expect(sql).toContain('SELECT run_id, session_id, processed_at, score, label');
    expect(sql).not.toContain('raw');
  });

  it('orders by detected time column DESC', () => {
    const { sql } = buildPipelineDataQuery(base);
    expect(sql).toContain('ORDER BY processed_at DESC');
  });

  it('prefers created_at when both created_at and processed_at are present', () => {
    const { sql } = buildPipelineDataQuery({
      ...base,
      columns: [
        { name: 'run_id', type: 'String', filterable: true, exportable: true },
        { name: 'created_at', type: 'DateTime64(3)', filterable: false, exportable: true },
        { name: 'processed_at', type: 'DateTime64(3)', filterable: false, exportable: true },
        { name: 'label', type: 'String', filterable: true, exportable: true },
      ],
    });

    expect(sql).toContain('created_at >= {from:DateTime64(3)}');
    expect(sql).toContain('created_at <= {to:DateTime64(3)}');
    expect(sql).toContain('ORDER BY created_at DESC');
  });

  it('includes SETTINGS for safety limits', () => {
    const { sql } = buildPipelineDataQuery(base);
    expect(sql).toContain('max_execution_time = 10');
    expect(sql).toContain('max_rows_to_read = 1000000');
    expect(sql).toContain('max_result_rows = 500');
  });

  it('rejects columns with invalid characters', () => {
    expect(() =>
      buildPipelineDataQuery({
        ...base,
        filters: [{ column: 'col; DROP', op: '=', value: '1' }],
      }),
    ).toThrow(QueryBuilderError);
  });

  it('handles multiple filters with distinct param slots', () => {
    const { sql, params } = buildPipelineDataQuery({
      ...base,
      filters: [
        { column: 'label', op: '=', value: 'positive' },
        { column: 'score', op: '=', value: 0.9 },
      ],
    });
    expect(sql).toContain('label = {f0:String}');
    expect(sql).toContain('score = {f1:Float64}');
    expect(params.f0).toBe('positive');
    expect(params.f1).toBe(0.9);
  });

  it('honours offset', () => {
    const { params } = buildPipelineDataQuery({ ...base, offset: 100 });
    expect(params.offset).toBe(100);
  });

  it('clamps negative offset to 0', () => {
    const { params } = buildPipelineDataQuery({ ...base, offset: -5 });
    expect(params.offset).toBe(0);
  });
});
