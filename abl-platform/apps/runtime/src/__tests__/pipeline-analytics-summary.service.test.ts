import { describe, expect, it } from 'vitest';
import { buildSummaryQuery } from '../services/pipeline-analytics-summary.service';

describe('buildSummaryQuery', () => {
  it('includes guardrail flagged_rate_pct for Agent Performance safety score', () => {
    const query = buildSummaryQuery(
      'guardrail_analysis',
      'abl_platform.guardrail_evaluations',
      'session_started_at',
    );

    expect(query).toContain(
      'countIf((flagged = 1 OR false_positive_score > 0.5 OR false_negative_score > 0.5 OR bypass_detected = 1)) AS flagged_count',
    );
    expect(query).toContain(
      'round(countIf((flagged = 1 OR false_positive_score > 0.5 OR false_negative_score > 0.5 OR bypass_detected = 1)) / nullif(count(), 0) * 100, 1) AS flagged_rate_pct',
    );
    expect(query).toContain('FROM abl_platform.guardrail_evaluations FINAL');
    // pipelineSourcePredicate now accepts both `source = 'batch'` and legacy
    // rows with an empty source — assert on the OR-shaped clause emitted by
    // pipeline-analytics-helpers.
    expect(query).toContain("AND (source = 'batch' OR source = '')");
  });

  it('uses offsetDays to build a true previous-period summary window', () => {
    const query = buildSummaryQuery(
      'quality_evaluation',
      'abl_platform.quality_evaluations',
      'session_started_at',
      7,
    );

    expect(query).toContain('session_started_at >= now() - INTERVAL {windowStartDays:UInt32} DAY');
    expect(query).toContain('session_started_at < now() - INTERVAL {offsetDays:UInt32} DAY');
  });
});
