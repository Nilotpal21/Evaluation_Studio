import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  extractObject,
  extractArray,
  pipelineUrl,
  useCustomerInsights,
} from '../useCustomerInsights';
import { useNavigationStore } from '../../store/navigation-store';

// ── Mock SWR (third-party) ──────────────────────────────────────────────────

const swrReturnValues = new Map<string, { data: unknown; error: unknown }>();

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (!key) return { data: undefined, error: undefined };
    return swrReturnValues.get(key) ?? { data: undefined, error: undefined };
  },
}));

// ── extractObject tests ─────────────────────────────────────────────────────

describe('extractObject', () => {
  it('returns empty object for null/undefined', () => {
    expect(extractObject(null)).toEqual({});
    expect(extractObject(undefined)).toEqual({});
  });

  it('extracts Shape A: { success, data: { field: value } }', () => {
    const input = { success: true, data: { total_conversations: 42, avg_sentiment: 0.75 } };
    expect(extractObject(input)).toEqual({ total_conversations: 42, avg_sentiment: 0.75 });
  });

  it('extracts Shape B: ClickHouse leaked { success, data: { meta, data: [{...}] } }', () => {
    const input = {
      success: true,
      data: {
        meta: [{ name: 'total_conversations', type: 'UInt64' }],
        data: [{ total_conversations: 42 }],
        rows: 1,
      },
    };
    expect(extractObject(input)).toEqual({ total_conversations: 42 });
  });

  it('returns empty object for Shape B with empty data array', () => {
    const input = {
      success: true,
      data: { meta: [], data: [], rows: 0 },
    };
    expect(extractObject(input)).toEqual({});
  });

  it('returns the object itself if no success wrapper', () => {
    const input = { total_conversations: 42 };
    expect(extractObject(input)).toEqual({ total_conversations: 42 });
  });

  it('returns empty object for { success: true } with no data', () => {
    expect(extractObject({ success: true })).toEqual({});
  });

  it('handles { success, data: null }', () => {
    expect(extractObject({ success: true, data: null })).toEqual({});
  });
});

// ── extractArray tests ──────────────────────────────────────────────────────

describe('extractArray', () => {
  it('returns empty array for null/undefined', () => {
    expect(extractArray(null)).toEqual([]);
    expect(extractArray(undefined)).toEqual([]);
  });

  it('extracts Shape A: { success, data: [...] }', () => {
    const rows = [{ intent: 'billing', conversation_count: 10 }];
    const input = { success: true, data: rows };
    expect(extractArray(input)).toEqual(rows);
  });

  it('extracts Shape B: { success, data: { meta, data: [...] } }', () => {
    const rows = [{ intent: 'billing', conversation_count: 10 }];
    const input = {
      success: true,
      data: { meta: [], data: rows, rows: 1 },
    };
    expect(extractArray(input)).toEqual(rows);
  });

  it('returns the array itself if input is a plain array', () => {
    const rows = [{ intent: 'billing' }];
    expect(extractArray(rows)).toEqual(rows);
  });

  it('returns empty array for { success, data: {} } (non-array)', () => {
    expect(extractArray({ success: true, data: {} })).toEqual([]);
  });

  it('returns empty array for { success: true } with no data', () => {
    expect(extractArray({ success: true })).toEqual([]);
  });
});

// ── pipelineUrl tests ───────────────────────────────────────────────────────

describe('pipelineUrl', () => {
  it('builds URL with required params', () => {
    const url = pipelineUrl('proj-1', 'sentiment_analysis', 'summary');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('projectId')).toBe('proj-1');
    expect(params.get('pipelineType')).toBe('sentiment_analysis');
    expect(params.get('endpoint')).toBe('summary');
  });

  it('includes extra params when provided', () => {
    const url = pipelineUrl('proj-1', 'intent_classification', 'breakdown', {
      period: '30d',
      dimension: 'intent',
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('period')).toBe('30d');
    expect(params.get('dimension')).toBe('intent');
  });

  it('starts with the runtime proxy path', () => {
    const url = pipelineUrl('proj-1', 'sentiment_analysis', 'summary');
    expect(url.startsWith('/api/runtime/pipeline-analytics?')).toBe(true);
  });
});

// ── useCustomerInsights hook tests ──────────────────────────────────────────

describe('useCustomerInsights', () => {
  beforeEach(() => {
    swrReturnValues.clear();
    // Set projectId directly on the zustand store
    useNavigationStore.setState({ projectId: 'proj-1' });
  });

  it('returns loading state when no data has arrived', () => {
    const { result } = renderHook(() => useCustomerInsights('30d'));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.totalConversations).toBe(0);
    expect(result.current.intentConversationCount).toBe(0);
    expect(result.current.sentimentConversationCount).toBe(0);
  });

  it('computes KPIs from intent + sentiment summaries', () => {
    const intentSummaryKey = pipelineUrl('proj-1', 'intent_classification', 'summary', {
      period: '30d',
    });
    swrReturnValues.set(intentSummaryKey, {
      data: {
        success: true,
        data: { total_conversations: 150, unique_intents: 12, avg_confidence: 0.85 },
      },
      error: undefined,
    });

    const sentimentSummaryKey = pipelineUrl('proj-1', 'sentiment_analysis', 'summary', {
      period: '30d',
    });
    swrReturnValues.set(sentimentSummaryKey, {
      data: {
        success: true,
        data: {
          total_conversations: 150,
          avg_sentiment: 0.65,
          frustrated_count: 15,
          improving_count: 80,
          declining_count: 20,
          stable_count: 50,
        },
      },
      error: undefined,
    });

    // Set remaining primary calls (breakdown + timeseries) with empty data so
    // isLoading flips false — this test is about KPI computation, not loading state.
    swrReturnValues.set(
      pipelineUrl('proj-1', 'intent_classification', 'breakdown', {
        period: '30d',
        dimension: 'intent',
      }),
      { data: { success: true, data: [] }, error: undefined },
    );
    swrReturnValues.set(
      pipelineUrl('proj-1', 'sentiment_analysis', 'timeseries', { period: '30d' }),
      { data: { success: true, data: [] }, error: undefined },
    );
    swrReturnValues.set(
      pipelineUrl('proj-1', 'intent_classification', 'timeseries', { period: '30d' }),
      { data: { success: true, data: [] }, error: undefined },
    );

    const { result } = renderHook(() => useCustomerInsights('30d'));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.totalConversations).toBe(150);
    expect(result.current.intentConversationCount).toBe(150);
    expect(result.current.sentimentConversationCount).toBe(150);
    expect(result.current.uniqueIntents).toBe(12);
    expect(result.current.avgSentiment).toBe(0.65);
    expect(result.current.frustrationRate).toBe(10); // 15/150 * 100
  });

  it('uses max of intent and sentiment totals while exposing each pipeline population', () => {
    // Simulates the real-world case where one pipeline processes more sessions
    // than the other (e.g., sentiment analyzed 27 but intent only 26).
    const intentKey = pipelineUrl('proj-1', 'intent_classification', 'summary', {
      period: '30d',
    });
    swrReturnValues.set(intentKey, {
      data: { success: true, data: { total_conversations: 26, unique_intents: 8 } },
      error: undefined,
    });

    const sentimentKey = pipelineUrl('proj-1', 'sentiment_analysis', 'summary', {
      period: '30d',
    });
    swrReturnValues.set(sentimentKey, {
      data: {
        success: true,
        data: {
          total_conversations: 27,
          avg_sentiment: 0.14,
          frustrated_count: 9,
          improving_count: 13,
          declining_count: 6,
          stable_count: 8,
        },
      },
      error: undefined,
    });

    const { result } = renderHook(() => useCustomerInsights('30d'));

    // KPI should show 27 (the higher of the two pipeline totals)
    expect(result.current.totalConversations).toBe(27);
    expect(result.current.intentConversationCount).toBe(26);
    expect(result.current.sentimentConversationCount).toBe(27);
    // Sentiment trajectory total is computed from its own counts
    expect(result.current.sentimentTrajectory.total).toBe(27); // 13+6+8
    // Frustration rate uses sentiment total as denominator
    expect(result.current.frustrationRate).toBeCloseTo(33.3, 1); // 9/27 * 100
  });

  it('computes sentiment trajectory from summary counts', () => {
    const sentimentKey = pipelineUrl('proj-1', 'sentiment_analysis', 'summary', {
      period: '7d',
    });
    swrReturnValues.set(sentimentKey, {
      data: {
        success: true,
        data: {
          total_conversations: 100,
          avg_sentiment: 0.5,
          frustrated_count: 5,
          improving_count: 40,
          declining_count: 10,
          stable_count: 50,
        },
      },
      error: undefined,
    });

    // Need intent summary to avoid loading state
    const intentKey = pipelineUrl('proj-1', 'intent_classification', 'summary', { period: '7d' });
    swrReturnValues.set(intentKey, {
      data: { success: true, data: { total_conversations: 100, unique_intents: 5 } },
      error: undefined,
    });

    const { result } = renderHook(() => useCustomerInsights('7d'));

    expect(result.current.sentimentTrajectory).toEqual({
      improving: 40,
      declining: 10,
      stable: 50,
      total: 100,
    });
  });

  it('merges intent + sentiment timeseries by day', () => {
    const intentTSKey = pipelineUrl('proj-1', 'intent_classification', 'timeseries', {
      period: '7d',
    });
    swrReturnValues.set(intentTSKey, {
      data: {
        success: true,
        data: [
          { day: '2026-04-07', conversation_count: 20, unique_intents: 5, avg_confidence: 0.8 },
          { day: '2026-04-08', conversation_count: 25, unique_intents: 6, avg_confidence: 0.85 },
        ],
      },
      error: undefined,
    });

    const sentimentTSKey = pipelineUrl('proj-1', 'sentiment_analysis', 'timeseries', {
      period: '7d',
    });
    swrReturnValues.set(sentimentTSKey, {
      data: {
        success: true,
        data: [
          { day: '2026-04-07', conversation_count: 20, avg_sentiment: 0.6, frustrated_count: 2 },
          { day: '2026-04-08', conversation_count: 25, avg_sentiment: 0.7, frustrated_count: 1 },
        ],
      },
      error: undefined,
    });

    // Need summary to avoid loading state
    const intentKey = pipelineUrl('proj-1', 'intent_classification', 'summary', { period: '7d' });
    swrReturnValues.set(intentKey, {
      data: { success: true, data: { total_conversations: 45 } },
      error: undefined,
    });

    const { result } = renderHook(() => useCustomerInsights('7d'));

    expect(result.current.dailyTrend).toHaveLength(2);
    expect(result.current.dailyTrend[0]).toEqual({
      day: '2026-04-07',
      conversations: 20,
      intentConversations: 20,
      sentimentConversations: 20,
      avgSentiment: 0.6,
      frustratedCount: 2,
      uniqueIntents: 5,
      avgConfidence: 0.8,
      resolutionRate: 0,
      partialRate: 0,
    });
  });

  it('stays loading when only intent summary has resolved (other 4 calls still pending)', () => {
    swrReturnValues.set(
      pipelineUrl('proj-1', 'intent_classification', 'summary', { period: '30d' }),
      { data: { success: true, data: { total_conversations: 100 } }, error: undefined },
    );
    // calls #2-5 deliberately absent — simulates partial resolution after a filter change
    const { result } = renderHook(() => useCustomerInsights('30d'));
    expect(result.current.isLoading).toBe(true);
  });

  it('returns null projectId when none is set', () => {
    useNavigationStore.setState({ projectId: null });
    const { result } = renderHook(() => useCustomerInsights('30d'));
    expect(result.current.projectId).toBeNull();
  });

  it('maps intent breakdown to intentDistribution and topIntents', () => {
    const breakdownKey = pipelineUrl('proj-1', 'intent_classification', 'breakdown', {
      period: '30d',
      dimension: 'intent',
    });
    swrReturnValues.set(breakdownKey, {
      data: {
        success: true,
        data: [
          { intent: 'billing', conversation_count: 50, avg_confidence: 0.9 },
          { intent: 'support', conversation_count: 30, avg_confidence: 0.8 },
        ],
      },
      error: undefined,
    });

    // Need intent summary to avoid loading state
    const intentKey = pipelineUrl('proj-1', 'intent_classification', 'summary', {
      period: '30d',
    });
    swrReturnValues.set(intentKey, {
      data: { success: true, data: { total_conversations: 80 } },
      error: undefined,
    });

    const { result } = renderHook(() => useCustomerInsights('30d'));

    expect(result.current.intentDistribution).toEqual([
      {
        intent: 'billing',
        count: 50,
        confidence: 0.9,
        resolutionRate: null,
        partialRate: null,
        evaluatedCount: 0,
      },
      {
        intent: 'support',
        count: 30,
        confidence: 0.8,
        resolutionRate: null,
        partialRate: null,
        evaluatedCount: 0,
      },
    ]);
    expect(result.current.topIntents).toEqual([
      {
        intent: 'billing',
        volume: 50,
        confidence: 0.9,
        resolutionRate: null,
        partialRate: null,
        evaluatedCount: 0,
      },
      {
        intent: 'support',
        volume: 30,
        confidence: 0.8,
        resolutionRate: null,
        partialRate: null,
        evaluatedCount: 0,
      },
    ]);
  });

  it('reports error string when any SWR call fails', () => {
    const intentKey = pipelineUrl('proj-1', 'intent_classification', 'summary', {
      period: '30d',
    });
    swrReturnValues.set(intentKey, {
      data: undefined,
      error: new Error('Network error'),
    });

    const { result } = renderHook(() => useCustomerInsights('30d'));
    expect(result.current.error).toBe('Error: Network error');
  });
});
