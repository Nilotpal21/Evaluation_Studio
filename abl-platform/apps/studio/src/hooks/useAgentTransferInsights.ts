/**
 * useAgentTransferInsights
 *
 * Fetches KoreAgentAssist analytics data for the Queues & Agents dashboard.
 * Each metric type maps to a separate upstream analytics endpoint, proxied
 * through the Studio API with SmartAssist credentials resolved server-side.
 */

import useSWR from 'swr';
import { useNavigationStore } from '../store/navigation-store';

export type InsightDateRange = 'today' | 'yesterday' | '7d' | '30d';

function dateRangeToParams(range: InsightDateRange): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = now.toISOString();
  const start = new Date(now);

  switch (range) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'yesterday':
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      now.setDate(now.getDate() - 1);
      now.setHours(23, 59, 59, 999);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    case '7d':
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      break;
  }

  return { startDate: start.toISOString(), endDate };
}

function buildUrl(
  projectId: string,
  type: string,
  dateRange: InsightDateRange,
  extra?: Record<string, string>,
): string {
  const { startDate, endDate } = dateRangeToParams(dateRange);
  const params = new URLSearchParams({ type, startDate, endDate, ...extra });
  return `/api/projects/${projectId}/agent-transfer/insights?${params.toString()}`;
}

export interface ChatMetrics {
  totalConversations?: number;
  avgHandleTime?: number;
  abandonmentRate?: number;
  transferRate?: number;
  [key: string]: unknown;
}

export interface VoiceMetrics {
  totalCalls?: number;
  avgHandleTime?: number;
  avgWaitTime?: number;
  abandonmentRate?: number;
  [key: string]: unknown;
}

export interface QueueMetrics {
  queues?: Array<{
    name: string;
    waiting: number;
    active: number;
    completed: number;
    abandoned: number;
    avgWaitTime: number;
    avgHandleTime: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface AgentMetrics {
  agents?: Array<{
    name: string;
    status: string;
    conversations: number;
    avgHandleTime: number;
    csat?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface TransferMetrics {
  totalTransfers?: number;
  transferRate?: number;
  [key: string]: unknown;
}

export interface TopSkillsData {
  skills?: Array<{ name: string; count: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface DispositionSet {
  name: string;
  id: string;
  [key: string]: unknown;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

function useSWRInsight<T>(url: string | null) {
  const { data, error, isLoading } = useSWR<ApiResponse<T>>(url, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  return {
    data: data?.success ? (data.data ?? null) : null,
    error: error ?? (!data?.success ? data?.error : null),
    isLoading,
  };
}

export function useAgentTransferInsights(dateRange: InsightDateRange) {
  const { projectId } = useNavigationStore();

  const chat = useSWRInsight<ChatMetrics>(
    projectId ? buildUrl(projectId, 'chat', dateRange) : null,
  );
  const voice = useSWRInsight<VoiceMetrics>(
    projectId ? buildUrl(projectId, 'voice', dateRange) : null,
  );
  const queues = useSWRInsight<QueueMetrics>(
    projectId ? buildUrl(projectId, 'queues', dateRange) : null,
  );
  const agents = useSWRInsight<AgentMetrics>(
    projectId ? buildUrl(projectId, 'agents', dateRange) : null,
  );
  const transfers = useSWRInsight<TransferMetrics>(
    projectId ? buildUrl(projectId, 'transfers', dateRange) : null,
  );
  const topSkills = useSWRInsight<TopSkillsData>(
    projectId ? buildUrl(projectId, 'top_skills', dateRange) : null,
  );
  const dispositionSets = useSWRInsight<DispositionSet[]>(
    projectId ? buildUrl(projectId, 'disposition_sets', dateRange) : null,
  );

  const errorCode = (chat.error as { code?: string } | null | undefined)?.code;
  const noConnection = !chat.isLoading && errorCode === 'CONNECTION_NOT_FOUND';
  const misconfiguredConnection = !chat.isLoading && errorCode === 'MISCONFIGURED_CONNECTION';

  return {
    chat,
    voice,
    queues,
    agents,
    transfers,
    topSkills,
    dispositionSets,
    noConnection,
    misconfiguredConnection,
    isLoading:
      chat.isLoading ||
      voice.isLoading ||
      queues.isLoading ||
      agents.isLoading ||
      transfers.isLoading,
  };
}
