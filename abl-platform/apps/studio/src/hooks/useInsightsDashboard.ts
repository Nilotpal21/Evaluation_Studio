/**
 * useInsightsDashboard Hook
 *
 * Fetches executive KPI data from existing analytics endpoints via SWR.
 * Combines session-metrics, cost-breakdown, and event-counts into a
 * unified InsightsDashboardData shape for the dashboard page.
 */

import useSWR from 'swr';
import { useNavigationStore } from '../store/navigation-store';

// =============================================================================
// TYPES
// =============================================================================

export interface InsightsSummary {
  totalConversations: number;
  containmentRate: number;
  estimatedCostSavings: number;
  avgCSAT: number | null;
  escalationRate: number;
  avgCostPerConversation: number;
  tokenSpendToday: number;
}

export interface DailyTrend {
  date: string;
  conversations: number;
  containment: number;
  cost: number;
}

export interface AgentCostRow {
  agentName: string;
  conversations: number;
  cost: number;
  containmentRate: number;
}

export interface InsightsDashboardData {
  summary: InsightsSummary;
  trends: DailyTrend[];
  costBreakdown: AgentCostRow[];
}

// =============================================================================
// HOOK
// =============================================================================

export function useInsightsDashboard(dateRange: string = '30d') {
  const { projectId } = useNavigationStore();
  const baseUrl = projectId ? `/api/runtime/analytics` : null;

  // Uses the global SWR fetcher (swrFetcher) which injects auth headers via apiFetch
  const {
    data: metricsData,
    error: metricsError,
    isLoading: metricsLoading,
  } = useSWR(
    baseUrl
      ? `${baseUrl}?projectId=${projectId}&endpoint=session-metrics&range=${dateRange}`
      : null,
    {
      revalidateOnFocus: false,
    },
  );

  const {
    data: costData,
    error: costError,
    isLoading: costLoading,
  } = useSWR(
    baseUrl ? `${baseUrl}?projectId=${projectId}&endpoint=cost-breakdown&range=${dateRange}` : null,
    {
      revalidateOnFocus: false,
    },
  );

  // Build summary from available data, with safe defaults
  const summary: InsightsSummary = {
    totalConversations: metricsData?.data?.totalSessions ?? 0,
    containmentRate: metricsData?.data?.containmentRate ?? 0,
    estimatedCostSavings: costData?.data?.estimatedSavings ?? 0,
    avgCSAT: metricsData?.data?.avgCSAT ?? null,
    escalationRate: metricsData?.data?.escalationRate ?? 0,
    avgCostPerConversation: costData?.data?.avgCostPerConversation ?? 0,
    tokenSpendToday: costData?.data?.tokenSpendToday ?? 0,
  };

  const trends: DailyTrend[] = metricsData?.data?.daily ?? [];
  const costBreakdown: AgentCostRow[] = costData?.data?.byAgent ?? [];

  const error = metricsError || costError;

  return {
    summary,
    trends,
    costBreakdown,
    isLoading: metricsLoading || costLoading,
    error: error ? String(error) : null,
    projectId,
  };
}
