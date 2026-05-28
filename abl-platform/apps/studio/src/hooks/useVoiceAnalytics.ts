/**
 * useVoiceAnalytics Hook
 *
 * Fetches aggregated voice metrics from the materialized view endpoint.
 * Returns summary KPIs and hourly breakdown data.
 */

import useSWR from 'swr';
import { useNavigationStore } from '../store/navigation-store';

export type DateRange = '24h' | '7d' | '30d';

const HOURS_MAP: Record<DateRange, number> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
};

export interface VoiceSummary {
  total_calls: number;
  total_errors: number;
  avg_call_duration_ms: number;
  overall_avg_inbound_mos: number | null;
  overall_avg_outbound_mos: number | null;
  overall_avg_inbound_jitter_ms: number | null;
  overall_avg_latency_ms: number | null;
  overall_barge_in_rate: number | null;
  overall_dtmf_fallback_rate: number | null;
  overall_asr_score: number | null;
  total_turns: number;
  total_barge_in_count: number;
  total_dtmf_turn_count: number;
}

export interface VoiceHourlyData {
  hour: string;
  session_count: number;
  error_count: number;
  avg_call_duration_ms: number;
  avg_inbound_mos: number | null;
  avg_outbound_mos: number | null;
  avg_inbound_jitter_ms: number | null;
  avg_outbound_jitter_ms: number | null;
  avg_e2e_latency_ms: number | null;
  avg_barge_in_rate: number | null;
  avg_dtmf_fallback_rate: number | null;
  avg_asr_score: number | null;
  avg_tts_proxy_mos: number | null;
  avg_silence_percent: number | null;
  total_turns: number;
  total_barge_in_count: number;
  total_dtmf_turn_count: number;
  mos_sample_count: number;
  metric_sample_count: number;
}

export function useVoiceAnalytics(dateRange: DateRange) {
  const { projectId } = useNavigationStore();
  const hours = HOURS_MAP[dateRange];

  const {
    data: summaryResponse,
    error: summaryError,
    isLoading: loadingSummary,
  } = useSWR<{
    success: boolean;
    data: VoiceSummary;
  }>(projectId ? `/api/projects/${projectId}/voice-analytics/summary?hours=${hours}` : null);

  const {
    data: hourlyResponse,
    error: hourlyError,
    isLoading: loadingHourly,
  } = useSWR<{
    success: boolean;
    data: VoiceHourlyData[];
  }>(projectId ? `/api/projects/${projectId}/voice-analytics/hourly?hours=${hours}` : null);

  return {
    summary: summaryResponse?.data ?? null,
    hourlyData: hourlyResponse?.data || [],
    isLoading: loadingSummary || loadingHourly,
    error: summaryError || hourlyError,
  };
}
