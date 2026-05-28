import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVoiceAnalytics, type DateRange } from '../useVoiceAnalytics';
import { useNavigationStore } from '../../store/navigation-store';

// ── Mock SWR ───────────────────────────────────────────────────────────────

const swrReturnValues = new Map<string, { data: unknown; error: unknown; isLoading: boolean }>();

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (!key) return { data: undefined, error: undefined, isLoading: false };
    return swrReturnValues.get(key) ?? { data: undefined, error: undefined, isLoading: true };
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const HOURS_MAP: Record<DateRange, number> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
};

function summaryUrl(projectId: string, dateRange: DateRange) {
  return `/api/projects/${projectId}/voice-analytics/summary?hours=${HOURS_MAP[dateRange]}`;
}

function hourlyUrl(projectId: string, dateRange: DateRange) {
  return `/api/projects/${projectId}/voice-analytics/hourly?hours=${HOURS_MAP[dateRange]}`;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useVoiceAnalytics', () => {
  beforeEach(() => {
    swrReturnValues.clear();
    useNavigationStore.setState({ projectId: 'proj-1' });
  });

  it('returns loading state when no data has arrived', () => {
    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.summary).toBeNull();
    expect(result.current.hourlyData).toEqual([]);
  });

  it('returns null summary when projectId is not set', () => {
    useNavigationStore.setState({ projectId: null });
    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.summary).toBeNull();
    expect(result.current.hourlyData).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('computes total calls from summary response', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: { total_calls: 150, total_errors: 3 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.summary?.total_calls).toBe(150);
    expect(result.current.summary?.total_errors).toBe(3);
  });

  it('computes avg MOS from summary response', () => {
    swrReturnValues.set(summaryUrl('proj-1', '30d'), {
      data: {
        success: true,
        data: {
          total_calls: 100,
          overall_avg_inbound_mos: 3.8,
          overall_avg_outbound_mos: 4.1,
        },
      },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '30d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('30d'));
    expect(result.current.summary?.overall_avg_inbound_mos).toBe(3.8);
    expect(result.current.summary?.overall_avg_outbound_mos).toBe(4.1);
  });

  it('computes ASR quality score from summary', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: { total_calls: 50, overall_asr_score: 87.5 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.summary?.overall_asr_score).toBe(87.5);
  });

  it('computes E2E latency from summary', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: { total_calls: 50, overall_avg_latency_ms: 1200 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.summary?.overall_avg_latency_ms).toBe(1200);
  });

  it('computes barge-in rate from summary', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: { total_calls: 50, overall_barge_in_rate: 12.5 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.summary?.overall_barge_in_rate).toBe(12.5);
  });

  it('computes DTMF fallback rate from summary', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: { total_calls: 50, overall_dtmf_fallback_rate: 5.3 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.summary?.overall_dtmf_fallback_rate).toBe(5.3);
  });

  it('returns hourly data array from hourly endpoint', () => {
    const hourlyRows = [
      {
        hour: '2026-04-09T10:00:00',
        session_count: 12,
        avg_inbound_mos: 3.9,
        avg_e2e_latency_ms: 980,
        avg_asr_score: 90,
        avg_barge_in_rate: 8.0,
        avg_dtmf_fallback_rate: 2.0,
      },
      {
        hour: '2026-04-09T11:00:00',
        session_count: 15,
        avg_inbound_mos: 4.1,
        avg_e2e_latency_ms: 850,
        avg_asr_score: 92,
        avg_barge_in_rate: 6.0,
        avg_dtmf_fallback_rate: 1.5,
      },
    ];

    swrReturnValues.set(summaryUrl('proj-1', '24h'), {
      data: { success: true, data: { total_calls: 27 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '24h'), {
      data: { success: true, data: hourlyRows },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('24h'));
    expect(result.current.hourlyData).toHaveLength(2);
    expect(result.current.hourlyData[0].session_count).toBe(12);
    expect(result.current.hourlyData[1].avg_inbound_mos).toBe(4.1);
  });

  it('handles empty summary response gracefully', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: undefined },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    // Hook returns summaryResponse?.data ?? null — when data is undefined, summary is null
    expect(result.current.summary).toBeNull();
  });

  it('handles empty hourly response gracefully', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: { total_calls: 0 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.hourlyData).toEqual([]);
  });

  it('reports error from summary SWR failure', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: undefined,
      error: new Error('Network error'),
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: undefined,
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe('Network error');
  });

  it('reports error from hourly SWR failure', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: { total_calls: 10 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: undefined,
      error: new Error('Hourly fetch failed'),
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe('Hourly fetch failed');
  });

  it('uses correct hours for 24h date range', () => {
    // 24h → 24 hours
    swrReturnValues.set(summaryUrl('proj-1', '24h'), {
      data: { success: true, data: { total_calls: 5 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '24h'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('24h'));
    expect(result.current.summary?.total_calls).toBe(5);
  });

  it('uses correct hours for 30d date range', () => {
    // 30d → 720 hours
    swrReturnValues.set(summaryUrl('proj-1', '30d'), {
      data: { success: true, data: { total_calls: 500 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '30d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('30d'));
    expect(result.current.summary?.total_calls).toBe(500);
  });

  it('returns not loading when both endpoints respond', () => {
    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: { total_calls: 10 } },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.isLoading).toBe(false);
  });

  it('returns full summary with all KPI fields', () => {
    const fullSummary = {
      total_calls: 200,
      total_errors: 5,
      avg_call_duration_ms: 45000,
      overall_avg_inbound_mos: 3.9,
      overall_avg_outbound_mos: 4.0,
      overall_avg_inbound_jitter_ms: 12.5,
      overall_avg_latency_ms: 1100,
      overall_barge_in_rate: 8.2,
      overall_dtmf_fallback_rate: 3.1,
      overall_asr_score: 88.5,
      total_turns: 1500,
      total_barge_in_count: 16,
      total_dtmf_turn_count: 6,
    };

    swrReturnValues.set(summaryUrl('proj-1', '7d'), {
      data: { success: true, data: fullSummary },
      error: undefined,
      isLoading: false,
    });
    swrReturnValues.set(hourlyUrl('proj-1', '7d'), {
      data: { success: true, data: [] },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useVoiceAnalytics('7d'));
    expect(result.current.summary).toEqual(fullSummary);
  });
});
