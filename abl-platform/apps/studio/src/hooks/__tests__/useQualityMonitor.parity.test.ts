// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useQualityMonitor } from '../useQualityMonitor';
import { pipelineUrl } from '../useCustomerInsights';
import { useNavigationStore } from '../../store/navigation-store';

const swrReturnValues = new Map<string, { data: unknown; error: unknown }>();

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (!key) return { data: undefined, error: undefined };
    return swrReturnValues.get(key) ?? { data: undefined, error: undefined };
  },
}));

function setPipelineResponse(
  projectId: string,
  pipelineType: string,
  endpoint: 'summary' | 'timeseries' | 'conversations',
  period: string,
  data: unknown,
  query: Record<string, string> = {},
) {
  const key = pipelineUrl(projectId, pipelineType, endpoint, { period, ...query });
  swrReturnValues.set(key, {
    data: { success: true, data },
    error: undefined,
  });
}

describe('useQualityMonitor parity', () => {
  beforeEach(() => {
    swrReturnValues.clear();
    useNavigationStore.setState({ projectId: 'proj-1' });
  });

  it('preserves backend quality monitor semantics through the Studio hook boundary', () => {
    const period = '30d';

    setPipelineResponse('proj-1', 'quality_evaluation', 'summary', period, {
      avg_overall_score: 4,
      total_conversations: 228,
      flagged_count: 57,
      avg_helpfulness: 3.5,
      avg_accuracy: 4.25,
      avg_professionalism: 4.5,
      avg_instruction_following: 3.75,
    });
    setPipelineResponse('proj-1', 'hallucination_detection', 'summary', period, {
      avg_score: 0.85,
      total_evaluations: 228,
      flagged_count: 39,
      avg_faithfulness: 0.85,
      avg_consistency: 0.86,
      contradiction_count: 7,
    });
    setPipelineResponse('proj-1', 'knowledge_gap', 'summary', period, {
      avg_score: 0.72,
      total_evaluations: 228,
      flagged_count: 82,
      avg_retrieval_precision: 0.3,
      avg_citation_rate: 0.18,
      gap_count: 82,
    });
    setPipelineResponse('proj-1', 'guardrail_analysis', 'summary', period, {
      avg_score: 0.9,
      total_evaluations: 228,
      flagged_count: 15,
      avg_false_positive: 0.12,
      avg_false_negative: 0.08,
      bypass_count: 4,
    });
    setPipelineResponse('proj-1', 'context_preservation', 'summary', period, {
      avg_score: 0.87,
      total_evaluations: 228,
      flagged_count: 2,
      avg_context_score: 0.87,
      duplication_count: 1,
      handoff_count: 2,
    });

    setPipelineResponse('proj-1', 'quality_evaluation', 'timeseries', period, [
      { day: '2026-05-04', avg_overall_score: 3.812 },
    ]);
    setPipelineResponse('proj-1', 'hallucination_detection', 'timeseries', period, [
      { day: '2026-05-04', avg_score: 0.9 },
    ]);

    const flaggedQuery = { filter: 'flagged:true', limit: '200' };
    setPipelineResponse(
      'proj-1',
      'quality_evaluation',
      'conversations',
      period,
      {
        conversations: [
          {
            session_id: 'sess-shared',
            session_started_at: '2026-05-04T12:00:00Z',
            agent_name: 'Mercury Bot',
            overall_score: 3,
            flag_reasons: ['quality_evaluation'],
            helpfulness: 3.2,
          },
        ],
      },
      flaggedQuery,
    );
    setPipelineResponse(
      'proj-1',
      'hallucination_detection',
      'conversations',
      period,
      {
        conversations: [
          {
            session_id: 'sess-shared',
            session_started_at: '2026-05-04T12:00:00Z',
            agent_name: 'Mercury Bot',
            overall_score: 0.2,
            flag_reasons: ['hallucination_detection'],
          },
        ],
      },
      flaggedQuery,
    );
    setPipelineResponse(
      'proj-1',
      'knowledge_gap',
      'conversations',
      period,
      {
        conversations: [
          {
            session_id: 'sess-kg',
            session_started_at: '2026-05-03T12:00:00Z',
            agent_name: 'Mercury Bot',
            overall_score: 0.45,
            flag_reasons: ['knowledge_gap'],
          },
        ],
      },
      flaggedQuery,
    );
    setPipelineResponse(
      'proj-1',
      'guardrail_analysis',
      'conversations',
      period,
      {
        conversations: [],
      },
      flaggedQuery,
    );
    setPipelineResponse(
      'proj-1',
      'context_preservation',
      'conversations',
      period,
      {
        conversations: [],
      },
      flaggedQuery,
    );

    const { result } = renderHook(() => useQualityMonitor(period));

    expect(result.current.totalEvaluated).toBe(228);
    expect(result.current.flaggedCount).toBe(195);
    expect(result.current.dimensions.find((d) => d.pipeline === 'quality_evaluation')?.score).toBe(
      0.8,
    );
    expect(
      result.current.dimensions.find((d) => d.pipeline === 'hallucination_detection')?.score,
    ).toBe(0.85);
    expect(
      result.current.dimensions
        .find((d) => d.pipeline === 'knowledge_gap')
        ?.subMetrics.find((metric) => metric.key === 'gap_detected'),
    ).toEqual({ key: 'gap_detected', kind: 'count', value: 82 });
    expect(result.current.dailyTrend[0]).toMatchObject({
      day: '2026-05-04',
      quality_evaluation: 0.7624,
      hallucination_detection: 0.9,
    });
    expect(result.current.flaggedConversations).toHaveLength(2);
    expect(result.current.flaggedConversations[0]).toMatchObject({
      sessionId: 'sess-shared',
      qualityScore: 0.2,
      flaggedDimensions: ['quality_evaluation', 'hallucination_detection'],
      helpfulness: 3.2,
    });
  });
});
