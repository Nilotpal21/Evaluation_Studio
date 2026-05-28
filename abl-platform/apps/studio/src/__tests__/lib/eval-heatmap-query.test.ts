// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildEvalHeatmapQuery } from '../../lib/eval-heatmap-query';

const PARAMS = {
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  runId: 'run-1',
};

describe('buildEvalHeatmapQuery', () => {
  it('reads from eval_scores, not the materialized view', () => {
    const { query } = buildEvalHeatmapQuery(PARAMS);
    expect(query).toContain('eval_scores');
    expect(query).not.toContain('mv_eval_heatmap_dest');
  });

  it('deduplicates variant rows with argMax(score, created_at)', () => {
    const { query } = buildEvalHeatmapQuery(PARAMS);
    expect(query).toMatch(/argMax\s*\(\s*score\s*,\s*created_at\s*\)/);
  });

  it('groups the inner subquery by variant_index to deduplicate before aggregating', () => {
    const { query } = buildEvalHeatmapQuery(PARAMS);
    expect(query).toMatch(/GROUP BY\s+persona_id,\s*scenario_id,\s*evaluator_id,\s*variant_index/);
  });

  it('computes outer aggregates (avg, count, variance, min, max) per (persona, scenario, evaluator)', () => {
    const { query } = buildEvalHeatmapQuery(PARAMS);
    expect(query).toMatch(/avg\s*\(\s*score\s*\)\s+AS\s+avgScore/);
    expect(query).toMatch(/count\s*\(\s*\)\s+AS\s+count/);
    expect(query).toMatch(/varSamp\s*\(\s*score\s*\)/);
    expect(query).toMatch(/min\s*\(\s*score\s*\)\s+AS\s+minScore/);
    expect(query).toMatch(/max\s*\(\s*score\s*\)\s+AS\s+maxScore/);
    expect(query).toMatch(/GROUP BY\s+personaId,\s*scenarioId,\s*evaluatorId/);
  });

  it('scopes the WHERE clause with all three tenant+project+run params', () => {
    const { query } = buildEvalHeatmapQuery(PARAMS);
    expect(query).toContain('{tenantId: String}');
    expect(query).toContain('{projectId: String}');
    expect(query).toContain('{runId: String}');
  });

  it('passes params through to query_params unchanged', () => {
    const { query_params } = buildEvalHeatmapQuery(PARAMS);
    expect(query_params).toEqual(PARAMS);
  });

  it('uses JSONEachRow format', () => {
    const { format } = buildEvalHeatmapQuery(PARAMS);
    expect(format).toBe('JSONEachRow');
  });
});
