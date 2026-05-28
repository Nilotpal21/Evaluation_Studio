import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAtAGlance, getRoiConfig, setRoiConfig } from '../useAtAGlance';
import { useNavigationStore } from '../../store/navigation-store';

// ── Mock SWR (third-party) ──────────────────────────────────────────────────

const swrReturnValues = new Map<string, { data: unknown; error: unknown }>();

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (!key) return { data: undefined, error: undefined };
    return swrReturnValues.get(key) ?? { data: undefined, error: undefined };
  },
}));

// ── URL builders (mirror the private functions in useAtAGlance) ─────────────

function analyticsUrl(projectId: string, endpoint: string, range: string) {
  return `/api/runtime/analytics?projectId=${projectId}&endpoint=${endpoint}&range=${range}`;
}

function pipelineUrl(
  projectId: string,
  pipelineType: string,
  endpoint: string,
  extra?: Record<string, string>,
) {
  const params = new URLSearchParams({ projectId, pipelineType, endpoint, ...extra });
  return `/api/runtime/pipeline-analytics?${params.toString()}`;
}

function insightsUrl(projectId: string, endpoint: string, extra?: Record<string, string>) {
  const params = new URLSearchParams({ projectId, endpoint, ...extra });
  return `/api/runtime/insights?${params.toString()}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setSessionMetrics(projectId: string, range: string, data: Record<string, unknown>) {
  swrReturnValues.set(analyticsUrl(projectId, 'session-metrics', range), {
    data: { success: true, data },
    error: undefined,
  });
}

function setCostBreakdown(projectId: string, range: string, data: unknown[]) {
  swrReturnValues.set(analyticsUrl(projectId, 'cost-breakdown', range), {
    data: { success: true, data },
    error: undefined,
  });
}

function setOutcomes(
  projectId: string,
  days: string,
  outcomes: { outcome: string; cnt: string }[],
) {
  swrReturnValues.set(insightsUrl(projectId, 'outcomes', { days }), {
    data: { success: true, data: { outcomes } },
    error: undefined,
  });
}

function setPipelineSummary(
  projectId: string,
  pipelineType: string,
  period: string,
  data: Record<string, unknown>,
) {
  swrReturnValues.set(pipelineUrl(projectId, pipelineType, 'summary', { period }), {
    data: { success: true, data },
    error: undefined,
  });
}

function setPipelineBreakdown(
  projectId: string,
  pipelineType: string,
  period: string,
  rows: Record<string, unknown>[],
  dimension = 'agent_name',
) {
  swrReturnValues.set(pipelineUrl(projectId, pipelineType, 'breakdown', { period, dimension }), {
    data: { success: true, data: rows },
    error: undefined,
  });
}

function setIntentBreakdown(projectId: string, period: string, rows: Record<string, unknown>[]) {
  swrReturnValues.set(
    pipelineUrl(projectId, 'intent_classification', 'breakdown', {
      period,
      dimension: 'agent_name',
    }),
    { data: { success: true, data: rows }, error: undefined },
  );
}

function setConversationsList(
  projectId: string,
  period: string,
  filter: string,
  limit: string,
  offset: string,
  data: { conversations: Record<string, unknown>[]; total: number; hasMore: boolean },
) {
  swrReturnValues.set(
    pipelineUrl(projectId, 'quality_evaluation', 'conversations', {
      period,
      filter,
      limit,
      offset,
    }),
    { data: { success: true, data }, error: undefined },
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getRoiConfig / setRoiConfig', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns default config when localStorage is empty', () => {
    const config = getRoiConfig('proj-1');
    expect(config).toEqual({
      humanCostPerConversation: 12.0,
      humanFteCost: 4500,
      avgHumanHandleTime: 6,
      estimatedAiCostPerConversation: 0.05,
    });
  });

  it('reads config from localStorage after setRoiConfig', () => {
    setRoiConfig('proj-1', {
      humanCostPerConversation: 15,
      humanFteCost: 5000,
      avgHumanHandleTime: 8,
      estimatedAiCostPerConversation: 0.08,
    });
    const config = getRoiConfig('proj-1');
    expect(config.humanCostPerConversation).toBe(15);
    expect(config.humanFteCost).toBe(5000);
    expect(config.avgHumanHandleTime).toBe(8);
    expect(config.estimatedAiCostPerConversation).toBe(0.08);
  });

  it('returns default for invalid JSON in localStorage', () => {
    localStorage.setItem('roi-config-proj-1', 'not-json');
    const config = getRoiConfig('proj-1');
    expect(config.humanCostPerConversation).toBe(12.0);
  });
});

describe('useAtAGlance', () => {
  beforeEach(() => {
    swrReturnValues.clear();
    localStorage.clear();
    useNavigationStore.setState({ projectId: 'proj-1' });
  });

  it('returns loading state when no data has arrived', () => {
    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.kpis.totalConversations).toBe(0);
  });

  it('stays loading when only sessionData has resolved (other 4 KPI calls still pending)', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 100 });
    // costData, qualitySummaryData, sentimentSummaryData, outcomesData deliberately absent
    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.isLoading).toBe(true);
  });

  it('computes total conversations from session-metrics', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 250 });
    // Set the other 4 primary calls with empty data so isLoading flips false
    setCostBreakdown('proj-1', '30d', []);
    setPipelineSummary('proj-1', 'quality_evaluation', '30d', {});
    setPipelineSummary('proj-1', 'sentiment_analysis', '30d', {});
    setOutcomes('proj-1', '30', []);
    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.kpis.totalConversations).toBe(250);
  });

  it('computes containment rate from outcomes', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 100 });
    setOutcomes('proj-1', '30', [
      { outcome: 'contained_resolved', cnt: '70' },
      { outcome: 'escalated', cnt: '20' },
      { outcome: 'abandoned', cnt: '10' },
    ]);

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.kpis.containmentRate).toBe(0.7); // 70/100
    expect(result.current.evaluatedCount).toBe(100);
    expect(result.current.resolvedCount).toBe(70);
  });

  it('computes quality score from quality_evaluation summary', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 10 });
    setPipelineSummary('proj-1', 'quality_evaluation', '30d', { avg_overall_score: 4.125 });

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.kpis.qualityScore).toBe(4.125);
  });

  it('computes avg sentiment from sentiment_analysis summary', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 10 });
    setPipelineSummary('proj-1', 'sentiment_analysis', '30d', { avg_sentiment: 0.7 });

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.kpis.avgSentiment).toBe(0.7);
  });

  it('exposes sentimentConversationCount from sentiment summary total_conversations', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 10 });
    setPipelineSummary('proj-1', 'sentiment_analysis', '30d', {
      avg_sentiment: 0,
      total_conversations: 42,
    });

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    // sentimentConversationCount must be 42 so the UI can distinguish
    // genuine zero sentiment from "pipeline hasn't run yet"
    expect(result.current.sentimentConversationCount).toBe(42);
    // avgSentiment is 0 — genuine neutral, not absence of data
    expect(result.current.kpis.avgSentiment).toBe(0);
  });

  it('does not compute KPI averages from the paginated conversations table endpoint', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 85 });
    setPipelineSummary('proj-1', 'quality_evaluation', '30d', { avg_overall_score: 3.9 });
    setPipelineSummary('proj-1', 'sentiment_analysis', '30d', { avg_sentiment: 0.42 });
    setConversationsList('proj-1', '30d', '', '25', '0', {
      conversations: [
        {
          session_id: 'sess-low',
          session_started_at: '2026-04-01T10:00:00Z',
          agent_name: 'TestAgent',
          overall_score: 1,
          helpfulness: 1,
          accuracy: 1,
          flagged: 1,
        },
      ],
      total: 85,
      hasMore: true,
    });

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.kpis.qualityScore).toBe(3.9);
    expect(result.current.kpis.avgSentiment).toBe(0.42);
    expect(result.current.conversationsTotal).toBe(85);
  });

  it('enriches intent breakdown rows from aggregate quality and sentiment breakdowns', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 85 });
    setIntentBreakdown('proj-1', '30d', [
      { agent_name: 'Account_Info_Agent', conversation_count: 50, avg_confidence: 0.83 },
    ]);
    setPipelineBreakdown('proj-1', 'quality_evaluation', '30d', [
      { agent_name: 'Account_Info_Agent', avg_overall_score: 3.7 },
    ]);
    setPipelineBreakdown('proj-1', 'sentiment_analysis', '30d', [
      { agent_name: 'Account_Info_Agent', avg_sentiment: 0.31 },
    ]);

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));

    expect(result.current.agentBreakdown).toEqual([
      {
        dimension: 'Account Info Agent',
        conversations: 50,
        confidence: 83,
        qualityScore: 3.7,
        avgSentiment: 0.31,
        trend: [],
      },
    ]);
  });

  it('computes cost savings from cost-breakdown estimatedSavings', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 10 });
    // costSavings comes from costData?.data?.estimatedSavings
    swrReturnValues.set(analyticsUrl('proj-1', 'cost-breakdown', '30d'), {
      data: { success: true, data: { estimatedSavings: 5000 } },
      error: undefined,
    });

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.kpis.costSavings).toBe(5000);
  });

  it('computes escalation rate from outcomes', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 100 });
    setOutcomes('proj-1', '30', [
      { outcome: 'contained_resolved', cnt: '60' },
      { outcome: 'escalated', cnt: '30' },
      { outcome: 'abandoned', cnt: '10' },
    ]);

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.kpis.escalationRate).toBe(0.3);
  });

  it('ROI: computes monthly savings correctly', () => {
    // Default config: humanCostPerConversation = 12
    setSessionMetrics('proj-1', '30d', { totalSessions: 100 });
    setOutcomes('proj-1', '30', [
      { outcome: 'contained_resolved', cnt: '80' },
      { outcome: 'escalated', cnt: '20' },
    ]);
    setCostBreakdown('proj-1', '30d', [{ model: 'gpt-4', provider: 'openai', totalCost: 160 }]);

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    // monthlySavings = 80 * 12 - 160 = 960 - 160 = 800
    expect(result.current.computedROI.monthlySavings).toBe(800);
  });

  it('ROI: computes annual ROI percentage', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 100 });
    setOutcomes('proj-1', '30', [
      { outcome: 'contained_resolved', cnt: '80' },
      { outcome: 'escalated', cnt: '20' },
    ]);
    setCostBreakdown('proj-1', '30d', [{ model: 'gpt-4', provider: 'openai', totalCost: 160 }]);

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    // monthlySavings = 800, annualROI = (800*12) / (160*12) * 100 = 500
    expect(result.current.computedROI.annualROI).toBe(500);
  });

  it('ROI: computes FTE equivalent', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 100 });
    setOutcomes('proj-1', '30', [{ outcome: 'contained_resolved', cnt: '80' }]);

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    // fteEquivalent = 80 * 6 / (160 * 60) = 480 / 9600 = 0.05
    expect(result.current.computedROI.fteEquivalent).toBe(0.05);
  });

  it('ROI: computes cost per resolution', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 200 });
    setOutcomes('proj-1', '30', [
      { outcome: 'contained_resolved', cnt: '60' },
      { outcome: 'escalated', cnt: '140' },
    ]);
    setCostBreakdown('proj-1', '30d', [
      { model: 'gpt-4', provider: 'openai', totalCost: 100 },
      { model: 'gpt-3.5', provider: 'openai', totalCost: 50 },
    ]);

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    // costPerResolution = 150 / 60 = 2.5
    expect(result.current.computedROI.costPerResolution).toBe(2.5);
  });

  it('ROI: reports zero cost per resolution when there are no resolved conversations', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 200 });
    setOutcomes('proj-1', '30', [{ outcome: 'escalated', cnt: '200' }]);
    setCostBreakdown('proj-1', '30d', [{ model: 'gpt-4', provider: 'openai', totalCost: 100 }]);

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.computedROI.costPerResolution).toBe(0);
  });

  it('ROI: falls back to estimatedAiCostPerConversation when no real cost data', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 100 });
    setOutcomes('proj-1', '30', [{ outcome: 'contained_resolved', cnt: '60' }]);
    // No cost breakdown set — rawLlmCost will be 0

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    // totalLlmCost = 0.05 * 100 = 5 (estimated)
    // monthlySavings = 60 * 12 - 5 = 715
    expect(result.current.computedROI.totalLlmCost).toBe(5);
    expect(result.current.computedROI.monthlySavings).toBe(715);
    expect(result.current.usingEstimatedCost).toBe(true);
  });

  it('ROI: uses default config when localStorage is empty', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 10 });

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.roiConfig).toEqual({
      humanCostPerConversation: 12.0,
      humanFteCost: 4500,
      avgHumanHandleTime: 6,
      estimatedAiCostPerConversation: 0.05,
    });
  });

  it('returns conversation list from conversations endpoint', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 50 });
    setConversationsList('proj-1', '30d', '', '25', '0', {
      conversations: [
        {
          session_id: 'sess-1',
          session_started_at: '2026-04-01T10:00:00Z',
          agent_name: 'TestAgent',
          overall_score: 4.2,
          helpfulness: 4.0,
          accuracy: 4.5,
          flagged: 0,
        },
        {
          session_id: 'sess-2',
          session_started_at: '2026-04-02T11:00:00Z',
          agent_name: 'BillingBot',
          overall_score: 2.1,
          helpfulness: 2.0,
          accuracy: 2.5,
          flagged: 1,
        },
      ],
      total: 2,
      hasMore: false,
    });

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.conversations).toHaveLength(2);
    expect(result.current.conversations[0].agent_name).toBe('Test Agent');
    expect(result.current.conversations[1].flagged).toBe(1);
    expect(result.current.conversationsTotal).toBe(2);
    expect(result.current.conversationsHasMore).toBe(false);
  });

  it('reports error string when any SWR call fails', () => {
    const sessionKey = analyticsUrl('proj-1', 'session-metrics', '30d');
    swrReturnValues.set(sessionKey, {
      data: undefined,
      error: new Error('Network error'),
    });

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.error).toBe('Error: Network error');
  });

  it('returns null projectId when none is set', () => {
    useNavigationStore.setState({ projectId: null });
    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));
    expect(result.current.projectId).toBeNull();
  });

  it('updates ROI config via updateRoiConfig callback', () => {
    setSessionMetrics('proj-1', '30d', { totalSessions: 10 });

    const { result } = renderHook(() => useAtAGlance({ dateRange: '30d' }));

    act(() => {
      result.current.updateRoiConfig({
        humanCostPerConversation: 20,
        humanFteCost: 6000,
        avgHumanHandleTime: 10,
        estimatedAiCostPerConversation: 0.1,
      });
    });

    expect(result.current.roiConfig.humanCostPerConversation).toBe(20);
    expect(result.current.roiConfig.humanFteCost).toBe(6000);
    expect(result.current.roiConfig.avgHumanHandleTime).toBe(10);
    expect(result.current.roiConfig.estimatedAiCostPerConversation).toBe(0.1);
  });
});
