// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  computeOverallHealth,
  classifyScore,
  computeDimensionStats,
  useQualityMonitor,
} from '../useQualityMonitor';
import { pipelineUrl } from '../useCustomerInsights';
import { useNavigationStore } from '../../store/navigation-store';

// ── Mock SWR (third-party) ──────────────────────────────────────────────────

const swrReturnValues = new Map<string, { data: unknown; error: unknown }>();

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (!key) return { data: undefined, error: undefined };
    return swrReturnValues.get(key) ?? { data: undefined, error: undefined };
  },
}));

// ── Helper to set summary data ──────────────────────────────────────────────

function setSummary(
  projectId: string,
  pipelineType: string,
  period: string,
  data: Record<string, unknown>,
) {
  const key = pipelineUrl(projectId, pipelineType, 'summary', { period });
  swrReturnValues.set(key, {
    data: { success: true, data },
    error: undefined,
  });
}

function setTimeseries(
  projectId: string,
  pipelineType: string,
  period: string,
  data: Record<string, unknown>[],
) {
  const key = pipelineUrl(projectId, pipelineType, 'timeseries', { period });
  swrReturnValues.set(key, {
    data: { success: true, data },
    error: undefined,
  });
}

function setConversations(projectId: string, period: string, data: Record<string, unknown>[]) {
  const key = pipelineUrl(projectId, 'quality_evaluation', 'conversations', {
    period,
    filter: 'flagged:true',
    limit: '200',
  });
  swrReturnValues.set(key, {
    data: { success: true, data },
    error: undefined,
  });
}

function setPipelineConversations(
  projectId: string,
  pipelineType: string,
  period: string,
  data: Record<string, unknown>[],
) {
  const key = pipelineUrl(projectId, pipelineType, 'conversations', {
    period,
    filter: 'flagged:true',
    limit: '200',
  });
  swrReturnValues.set(key, {
    data: { success: true, data },
    error: undefined,
  });
}

// ── Pure function tests: classifyScore ──────────────────────────────────────

describe('classifyScore', () => {
  it('returns healthy for score > 0.7', () => {
    expect(classifyScore(0.85)).toBe('healthy');
  });

  it('returns warning for score 0.5 < x <= 0.7', () => {
    expect(classifyScore(0.6)).toBe('warning');
  });

  it('returns critical for score <= 0.5', () => {
    expect(classifyScore(0.3)).toBe('critical');
  });
});

// ── Pure function tests: computeOverallHealth ───────────────────────────────

describe('computeOverallHealth', () => {
  it('computes weighted average across all 5 dimensions', () => {
    const summaries = {
      quality_evaluation: { overall_score: 4.0, flagged_count: 2 }, // 0-5 scale → 4.0/5 = 0.8
      hallucination_detection: { overall_score: 0.85, flagged_count: 1 },
      knowledge_gap: { overall_score: 0.75, flagged_count: 0 },
      guardrail_analysis: { overall_score: 0.9, flagged_count: 0 },
      context_preservation: { overall_score: 0.7, flagged_count: 1 },
    };

    const result = computeOverallHealth(summaries);

    // Weights: quality 30%, hallucination 25%, knowledge_gap 15%, guardrail 20%, context 10%
    // Quality score: 4.0/5 = 0.8 (normalized from 0-5 to 0-1)
    // Normalized health scores:
    //   quality: 0.8, hallucination: 0.85, knowledge_gap: 0.75,
    //   guardrail: 0.9, context: 0.7
    // Weighted: (0.8*0.3 + 0.85*0.25 + 0.75*0.15 + 0.9*0.2 + 0.7*0.1) / 1.0
    //         = (0.24 + 0.2125 + 0.1125 + 0.18 + 0.07) / 1.0 = 0.815
    expect(result.score).toBeCloseTo(0.815, 2);
    expect(result.flaggedTotal).toBe(4);
  });

  it('handles missing pipelines gracefully', () => {
    const summaries = {
      quality_evaluation: { overall_score: 4.0, flagged_count: 2 }, // 4.0/5 = 0.8
    };

    const result = computeOverallHealth(summaries);

    // Only quality_evaluation present with weight 0.3
    // score = (4.0/5) * 0.3 / 0.3 = 0.8
    expect(result.score).toBeCloseTo(0.8, 2);
    expect(result.flaggedTotal).toBe(2);
  });

  it('returns critical when any dimension is critical', () => {
    const summaries = {
      quality_evaluation: { overall_score: 4.5, flagged_count: 0 }, // 4.5/5 = 0.9
      hallucination_detection: { overall_score: 0.8, flagged_count: 5 },
      knowledge_gap: { overall_score: 0.1, flagged_count: 0 },
      guardrail_analysis: { overall_score: 0.9, flagged_count: 0 },
      context_preservation: { overall_score: 0.8, flagged_count: 0 },
    };

    const result = computeOverallHealth(summaries);
    expect(result.status).toBe('critical');
  });

  it('returns warning + hasData:false when all summaries report zero evaluations', () => {
    const summaries = {
      quality_evaluation: { overall_score: 0, total_conversations: 0, flagged_count: 0 },
      hallucination_detection: { overall_score: 0, total_conversations: 0, flagged_count: 0 },
      knowledge_gap: { overall_score: 0, total_conversations: 0, flagged_count: 0 },
      guardrail_analysis: { overall_score: 0, total_conversations: 0, flagged_count: 0 },
      context_preservation: { overall_score: 0, total_conversations: 0, flagged_count: 0 },
    };

    const result = computeOverallHealth(summaries);
    expect(result.status).toBe('warning');
    expect(result.hasData).toBe(false);
    expect(result.score).toBe(0);
  });

  it('returns healthy when all dimensions are healthy', () => {
    const summaries = {
      quality_evaluation: { overall_score: 4.5, flagged_count: 0 }, // 4.5/5 = 0.9
      hallucination_detection: { overall_score: 0.85, flagged_count: 0 },
      knowledge_gap: { overall_score: 0.8, flagged_count: 0 },
      guardrail_analysis: { overall_score: 0.85, flagged_count: 0 },
      context_preservation: { overall_score: 0.8, flagged_count: 0 },
    };

    const result = computeOverallHealth(summaries);
    expect(result.status).toBe('healthy');
    expect(result.flaggedTotal).toBe(0);
  });
});

// ── Pure function tests: computeDimensionStats ──────────────────────────────

describe('computeDimensionStats', () => {
  it('extracts quality_evaluation sub-metrics (normalizes 0-5 to 0-1)', () => {
    const summary = {
      overall_score: 4.25, // 4.25/5 = 0.85
      flagged_count: 3,
      helpfulness: 4.5, // 4.5/5 = 0.9
      accuracy: 4.0, // 4.0/5 = 0.8
      professionalism: 4.75, // 4.75/5 = 0.95
      instruction_following: 3.75, // 3.75/5 = 0.75
      custom_dimensions: '{"empathy":4.5,"resolution_speed":3.5}',
    };

    const result = computeDimensionStats(summary, 'quality_evaluation');
    expect(result.score).toBe(0.85);
    expect(result.status).toBe('healthy');
    expect(result.flaggedCount).toBe(3);
    expect(result.subMetrics).toEqual([
      { key: 'helpfulness', kind: 'score', value: 0.9 },
      { key: 'accuracy', kind: 'score', value: 0.8 },
      { key: 'professionalism', kind: 'score', value: 0.95 },
      { key: 'instruction_following', kind: 'score', value: 0.75 },
      { key: 'empathy', kind: 'score', value: 0.9 },
      { key: 'resolution_speed', kind: 'score', value: 0.7 },
    ]);
  });

  it('does not duplicate a custom dimension key that matches a built-in metric', () => {
    const summary = {
      overall_score: 4.0,
      flagged_count: 0,
      helpfulness: 4.0,
      accuracy: 4.0,
      professionalism: 4.0,
      instruction_following: 4.0,
      custom_dimensions: '{"helpfulness":5.0,"empathy":4.5}',
    };

    const result = computeDimensionStats(summary, 'quality_evaluation');
    const helpfulnessEntries = result.subMetrics.filter((m) => m.key === 'helpfulness');
    expect(helpfulnessEntries).toHaveLength(1);
    expect(result.subMetrics.find((m) => m.key === 'empathy')).toBeDefined();
  });

  it('extracts hallucination_detection sub-metrics', () => {
    const summary = {
      overall_score: 0.85,
      flagged_count: 1,
      faithfulness_score: 0.85,
      consistency_index: 0.9,
      contradiction_detected: 3,
    };

    const result = computeDimensionStats(summary, 'hallucination_detection');
    expect(result.score).toBe(0.85);
    expect(result.status).toBe('healthy');
    expect(result.subMetrics).toHaveLength(3);
    expect(result.subMetrics[0]).toEqual({
      key: 'faithfulness_score',
      kind: 'score',
      value: 0.85,
    });
    expect(result.subMetrics[2]).toEqual({
      key: 'contradiction_detected',
      kind: 'count',
      value: 3,
    });
  });

  it('extracts guardrail_analysis sub-metrics without treating counts as scores', () => {
    const summary = {
      overall_score: 0.6,
      flagged_count: 5,
      false_positive_score: 0.1,
      false_negative_score: 0.2,
      bypass_detected: 2,
    };

    const result = computeDimensionStats(summary, 'guardrail_analysis');
    expect(result.score).toBe(0.6);
    expect(result.status).toBe('warning'); // higher-is-better, 0.5 < 0.6 <= 0.7
    expect(result.flaggedCount).toBe(5);
    expect(result.subMetrics).toHaveLength(3);
    expect(result.subMetrics.map((m) => m.key)).toEqual([
      'false_positive_score',
      'false_negative_score',
      'bypass_detected',
    ]);
    expect(result.subMetrics.find((m) => m.key === 'bypass_detected')).toEqual({
      key: 'bypass_detected',
      kind: 'count',
      value: 2,
    });
  });

  it('handles empty/null summary as no-data (warning, not critical)', () => {
    const result = computeDimensionStats({}, 'quality_evaluation');
    expect(result.score).toBe(0);
    expect(result.status).toBe('warning');
    expect(result.hasData).toBe(false);
    expect(result.subMetrics).toEqual([]);
    expect(result.flaggedCount).toBe(0);
  });

  it('handles null summary object as no-data', () => {
    const result = computeDimensionStats(
      null as unknown as Record<string, unknown>,
      'quality_evaluation',
    );
    expect(result.score).toBe(0);
    expect(result.status).toBe('warning');
    expect(result.hasData).toBe(false);
    expect(result.flaggedCount).toBe(0);
  });

  it('treats total_conversations:0 as no-data even when overall_score is present', () => {
    const result = computeDimensionStats(
      { overall_score: 0, total_conversations: 0, flagged_count: 0 },
      'quality_evaluation',
    );
    expect(result.status).toBe('warning');
    expect(result.hasData).toBe(false);
  });
});

// ── SWR orchestration tests: useQualityMonitor ──────────────────────────────

describe('useQualityMonitor', () => {
  beforeEach(() => {
    swrReturnValues.clear();
    useNavigationStore.setState({ projectId: 'proj-1' });
  });

  it('returns loading state when no data has arrived', () => {
    const { result } = renderHook(() => useQualityMonitor('30d'));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.overallQualityScore).toBe(0);
  });

  it('computes KPIs from all 5 summaries', () => {
    setSummary('proj-1', 'quality_evaluation', '30d', {
      overall_score: 4.0, // 0-5 scale → 4.0/5 = 0.8
      total_conversations: 100,
      flagged_count: 5,
    });
    setSummary('proj-1', 'hallucination_detection', '30d', {
      overall_score: 0.2,
      total_conversations: 100,
      flagged_count: 3,
    });
    setSummary('proj-1', 'knowledge_gap', '30d', {
      overall_score: 0.15,
      total_conversations: 90,
      flagged_count: 2,
    });
    setSummary('proj-1', 'guardrail_analysis', '30d', {
      overall_score: 0.85,
      total_conversations: 100,
      flagged_count: 1,
    });
    setSummary('proj-1', 'context_preservation', '30d', {
      overall_score: 0.75,
      total_conversations: 95,
      flagged_count: 0,
    });

    const { result } = renderHook(() => useQualityMonitor('30d'));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.totalEvaluated).toBe(100);
    expect(result.current.flaggedCount).toBe(11);
    expect(result.current.overallQualityScore).toBeGreaterThan(0);
    expect(result.current.dimensions).toHaveLength(5);
  });

  it('computes issue count from all summaries and flaggedRate from quality denominator', () => {
    setSummary('proj-1', 'quality_evaluation', '7d', {
      overall_score: 3.5, // 0-5 scale → 3.5/5 = 0.7
      total_conversations: 200,
      flagged_count: 20,
    });
    setSummary('proj-1', 'hallucination_detection', '7d', {
      overall_score: 0.3,
      total_conversations: 200,
      flagged_count: 10,
    });
    setSummary('proj-1', 'knowledge_gap', '7d', {
      overall_score: 0.2,
      total_conversations: 200,
      flagged_count: 5,
    });
    setSummary('proj-1', 'guardrail_analysis', '7d', {
      overall_score: 0.8,
      total_conversations: 200,
      flagged_count: 0,
    });
    setSummary('proj-1', 'context_preservation', '7d', {
      overall_score: 0.6,
      total_conversations: 200,
      flagged_count: 5,
    });

    const { result } = renderHook(() => useQualityMonitor('7d'));

    // flaggedCount = all dimension issue flags = 40, flaggedRate keeps the
    // quality_evaluation denominator so it remains a conversation-rate KPI.
    // flaggedRate = 20/200 * 100 = 10
    expect(result.current.flaggedCount).toBe(40);
    expect(result.current.flaggedRate).toBe(10);
  });

  it('merges daily trends from 5 timeseries', () => {
    // Set at least one summary to avoid loading state
    setSummary('proj-1', 'quality_evaluation', '7d', {
      overall_score: 0.8,
      total_conversations: 100,
      flagged_count: 0,
    });

    setTimeseries('proj-1', 'quality_evaluation', '7d', [
      { day: '2026-04-07', avg_overall_score: 4.0 },
      { day: '2026-04-08', avg_overall_score: 4.25 },
    ]);
    setTimeseries('proj-1', 'hallucination_detection', '7d', [
      { day: '2026-04-07', avg_score: 0.85 },
      { day: '2026-04-08', avg_score: 0.8 },
    ]);

    const { result } = renderHook(() => useQualityMonitor('7d'));

    expect(result.current.dailyTrend).toHaveLength(2);
    expect(result.current.dailyTrend[0].quality_evaluation).toBe(0.8);
    expect(result.current.dailyTrend[0].hallucination_detection).toBe(0.85);
    expect(result.current.dailyTrend[1].quality_evaluation).toBe(0.85);
  });

  it('returns flagged conversations list (legacy array shape)', () => {
    setSummary('proj-1', 'quality_evaluation', '30d', {
      overall_score: 0.7,
      total_conversations: 50,
      flagged_count: 3,
    });

    setConversations('proj-1', '30d', [
      {
        session_id: 'sess-1',
        day: '2026-04-08',
        agent_name: 'Support Bot',
        overall_score: 0.3,
        flagged_dimensions: ['hallucination_detection', 'knowledge_gap'],
        helpfulness: 0.2,
      },
      {
        session_id: 'sess-2',
        day: '2026-04-07',
        agent_name: 'Sales Bot',
        overall_score: 0.4,
        flagged_dimensions: ['quality_evaluation'],
        helpfulness: 0.1,
      },
    ]);

    const { result } = renderHook(() => useQualityMonitor('30d'));

    expect(result.current.flaggedConversations).toHaveLength(2);
    expect(result.current.flaggedConversations[0]).toEqual({
      sessionId: 'sess-1',
      date: '2026-04-08',
      agentName: 'Support Bot',
      qualityScore: 0.3 / 5, // normalized from 0-5 to 0-1
      flaggedDimensions: ['hallucination_detection', 'knowledge_gap'],
      helpfulness: 0.2,
      rubricScores: { helpfulness: 0.2 },
      customDimensions: {},
    });
  });

  it('returns flagged conversations from { conversations: [...] } wrapper shape', () => {
    setSummary('proj-1', 'quality_evaluation', '30d', {
      overall_score: 0.7,
      total_conversations: 50,
      flagged_count: 2,
    });

    // Real API returns { data: { conversations: [...] } } shape
    const key = pipelineUrl('proj-1', 'quality_evaluation', 'conversations', {
      period: '30d',
      filter: 'flagged:true',
      limit: '200',
    });
    swrReturnValues.set(key, {
      data: {
        success: true,
        data: {
          conversations: [
            {
              session_id: 'sess-10',
              session_started_at: '2026-04-09T08:00:00Z',
              agent_name: 'Billing_Bot',
              overall_score: 0.25,
              flag_reasons: ['hallucination_detection'],
              helpfulness: 0.3,
            },
          ],
        },
      },
      error: undefined,
    });

    const { result } = renderHook(() => useQualityMonitor('30d'));

    expect(result.current.flaggedConversations).toHaveLength(1);
    expect(result.current.flaggedConversations[0]).toEqual({
      sessionId: 'sess-10',
      date: '2026-04-09T08:00:00Z',
      agentName: 'Billing_Bot',
      qualityScore: 0.25 / 5, // normalized from 0-5 to 0-1
      flaggedDimensions: ['hallucination_detection'],
      helpfulness: 0.3,
      rubricScores: { helpfulness: 0.3 },
      customDimensions: {},
    });
  });

  it('reads flag_reasons field for flagged dimensions', () => {
    setSummary('proj-1', 'quality_evaluation', '30d', {
      overall_score: 0.7,
      total_conversations: 50,
      flagged_count: 1,
    });

    setConversations('proj-1', '30d', [
      {
        session_id: 'sess-fr',
        day: '2026-04-08',
        agent_name: 'Agent A',
        overall_score: 0.2,
        flag_reasons: ['knowledge_gap', 'guardrail_analysis'],
        helpfulness: 0.5,
      },
    ]);

    const { result } = renderHook(() => useQualityMonitor('30d'));

    expect(result.current.flaggedConversations[0].flaggedDimensions).toEqual([
      'knowledge_gap',
      'guardrail_analysis',
    ]);
  });

  it('reads helpfulness field for the helpfulness column', () => {
    setSummary('proj-1', 'quality_evaluation', '30d', {
      overall_score: 0.7,
      total_conversations: 50,
      flagged_count: 1,
    });

    setConversations('proj-1', '30d', [
      {
        session_id: 'sess-hp',
        day: '2026-04-08',
        agent_name: 'Agent B',
        overall_score: 0.3,
        flagged_dimensions: ['quality_evaluation'],
        helpfulness: 4.2,
      },
    ]);

    const { result } = renderHook(() => useQualityMonitor('30d'));
    expect(result.current.flaggedConversations[0].helpfulness).toBe(4.2);
  });

  it('parses custom rubric scores from custom_dimensions', () => {
    setSummary('proj-1', 'quality_evaluation', '30d', {
      overall_score: 0.7,
      total_conversations: 50,
      flagged_count: 1,
    });

    setConversations('proj-1', '30d', [
      {
        session_id: 'sess-custom',
        day: '2026-04-08',
        agent_name: 'Agent C',
        overall_score: 1.964,
        flagged_dimensions: ['quality_evaluation'],
        helpfulness: 0,
        accuracy: 0,
        professionalism: 0,
        instruction_following: 0,
        custom_dimensions: '{"empathy":4,"resolution_speed":3.5}',
      },
    ]);

    const { result } = renderHook(() => useQualityMonitor('30d'));
    expect(result.current.flaggedConversations[0].customDimensions).toEqual({
      empathy: 4,
      resolution_speed: 3.5,
    });
    expect(result.current.flaggedConversations[0].rubricScores).toEqual({
      empathy: 4,
      resolution_speed: 3.5,
    });
  });

  it('merges flagged conversations across all quality dimensions by session', () => {
    setSummary('proj-1', 'quality_evaluation', '30d', {
      overall_score: 4.0,
      total_conversations: 50,
      flagged_count: 1,
    });

    setPipelineConversations('proj-1', 'quality_evaluation', '30d', [
      {
        session_id: 'sess-shared',
        session_started_at: '2026-04-09T08:00:00Z',
        agent_name: 'Billing Bot',
        overall_score: 3.0,
        flag_reasons: ['quality_evaluation'],
        helpfulness: 3.2,
      },
    ]);
    setPipelineConversations('proj-1', 'hallucination_detection', '30d', [
      {
        session_id: 'sess-shared',
        session_started_at: '2026-04-09T08:00:00Z',
        agent_name: 'Billing Bot',
        overall_score: 0.4,
        flag_reasons: ['hallucination'],
      },
    ]);
    setPipelineConversations('proj-1', 'knowledge_gap', '30d', [
      {
        session_id: 'sess-kg',
        session_started_at: '2026-04-08T08:00:00Z',
        agent_name: 'Support Bot',
        overall_score: 0.45,
        flag_reasons: ['knowledge_gap'],
      },
    ]);

    const { result } = renderHook(() => useQualityMonitor('30d'));

    expect(result.current.flaggedConversations).toHaveLength(2);
    const shared = result.current.flaggedConversations.find(
      (row) => row.sessionId === 'sess-shared',
    );
    expect(shared?.qualityScore).toBe(0.4);
    expect(shared?.flaggedDimensions).toEqual(['quality_evaluation', 'hallucination']);
  });

  it('stays loading when only 1 of 5 summaries has resolved', () => {
    // Only quality_evaluation summary present — other 4 pipelines still in-flight
    setSummary('proj-1', 'quality_evaluation', '30d', {
      overall_score: 4.0,
      total_conversations: 50,
      flagged_count: 2,
    });

    const { result } = renderHook(() => useQualityMonitor('30d'));

    // All 5 summaries are primary — loading stays true until all arrive
    expect(result.current.isLoading).toBe(true);
    // Hook still computes partial data in the background (dimensions for missing
    // pipelines default to 0 score until their summaries resolve)
    const halDim = result.current.dimensions.find((d) => d.pipeline === 'hallucination_detection');
    expect(halDim?.score).toBe(0);
  });

  it('reports error on SWR failure', () => {
    const key = pipelineUrl('proj-1', 'quality_evaluation', 'summary', { period: '30d' });
    swrReturnValues.set(key, {
      data: undefined,
      error: new Error('Network error'),
    });

    const { result } = renderHook(() => useQualityMonitor('30d'));
    expect(result.current.error).toBe('Error: Network error');
  });

  it('returns null projectId when none is set', () => {
    useNavigationStore.setState({ projectId: null });
    const { result } = renderHook(() => useQualityMonitor('30d'));
    expect(result.current.projectId).toBeNull();
  });

  it('normalizes API field names (avg_overall_score, avg_score, total_evaluations)', () => {
    // Real API returns avg_overall_score for quality, avg_score for others
    setSummary('proj-1', 'quality_evaluation', '30d', {
      avg_overall_score: 3.5,
      total_conversations: 30,
      flagged_count: 5,
      avg_helpfulness: 3.8,
      avg_accuracy: 3.2,
      avg_professionalism: 4.0,
      avg_instruction_following: 3.5,
      custom_dimensions: '{"empathy":4.2}',
    });
    setSummary('proj-1', 'hallucination_detection', '30d', {
      avg_score: 0.2,
      total_evaluations: 30,
      flagged_count: 6,
      avg_faithfulness: 0.88,
      avg_consistency: 0.9,
      contradiction_count: 3,
    });
    setSummary('proj-1', 'knowledge_gap', '30d', {
      avg_score: 0.15,
      total_evaluations: 30,
      flagged_count: 8,
      avg_retrieval_precision: 0.75,
      avg_citation_rate: 0.7,
      gap_count: 5,
    });
    setSummary('proj-1', 'guardrail_analysis', '30d', {
      avg_score: 0.82,
      total_evaluations: 30,
      flagged_count: 5,
      avg_false_positive: 0.08,
      avg_false_negative: 0.06,
      bypass_count: 2,
    });
    setSummary('proj-1', 'context_preservation', '30d', {
      avg_score: 0.78,
      total_evaluations: 30,
      flagged_count: 4,
      avg_context_score: 0.75,
      duplication_count: 3,
      handoff_count: 12,
    });

    const { result } = renderHook(() => useQualityMonitor('30d'));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.overallQualityScore).toBeGreaterThan(0);
    expect(result.current.totalEvaluated).toBe(30);
    expect(result.current.flaggedCount).toBe(28);

    // Quality dimension scores normalized from 0-5 to 0-1
    const qualDim = result.current.dimensions.find((d) => d.pipeline === 'quality_evaluation');
    expect(qualDim?.score).toBe(0.7); // 3.5/5 = 0.7
    expect(qualDim?.subMetrics.find((m) => m.key === 'helpfulness')?.value).toBe(0.76); // 3.8/5
    expect(qualDim?.subMetrics.find((m) => m.key === 'empathy')?.value).toBeCloseTo(0.84); // 4.2/5

    // Hallucination dimension should have normalized score
    const halDim = result.current.dimensions.find((d) => d.pipeline === 'hallucination_detection');
    expect(halDim?.score).toBe(0.2);
    expect(halDim?.subMetrics.find((m) => m.key === 'faithfulness_score')?.value).toBe(0.88);
  });
});
