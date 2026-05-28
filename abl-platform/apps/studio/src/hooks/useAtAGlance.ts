/**
 * useAtAGlance Hook
 *
 * Fetches real analytics data from:
 *   - /analytics (session metrics, cost breakdown)
 *   - /pipeline-analytics (quality, sentiment, intent, conversations)
 *   - /insights (timeseries from raw tables, outcomes)
 *
 * Computes ROI metrics from existing data + configurable cost settings.
 */

import useSWR from 'swr';
import { useState, useCallback, useMemo } from 'react';
import { useNavigationStore } from '../store/navigation-store';
import { extractArray, extractObject, pipelineUrl, combineLoading } from './insights-helpers';
import { formatAgentName } from '../lib/format/agent-name';

// ── Types ───────────────────────────────────────────────────────────────────

export interface AtAGlanceKPI {
  totalConversations: number;
  containmentRate: number;
  qualityScore: number;
  avgSentiment: number;
  escalationRate: number;
  costSavings: number;
}

export interface DailyPoint {
  day: string;
  conversations: number;
  sentiment: number;
  quality: number;
  containment: number;
  escalation: number;
  resolved: number;
  escalated: number;
  other: number;
}

export interface BreakdownRow {
  dimension: string;
  conversations: number;
  confidence: number;
  qualityScore: number;
  avgSentiment: number;
  trend: number[];
}

export interface ROIData {
  monthlySavings: number;
  annualSavings: number;
  roiPercentage: number;
  fteEquivalent: number;
  budgetStatus: string;
  budgetRemaining: number;
}

export interface ROIConfig {
  humanCostPerConversation: number;
  humanFteCost: number;
  avgHumanHandleTime: number;
  estimatedAiCostPerConversation: number;
}

export interface ComputedROI {
  monthlySavings: number;
  annualROI: number;
  fteEquivalent: number;
  costPerResolution: number;
  totalLlmCost: number;
  isEstimatedCost: boolean;
}

export interface ConversationRow {
  session_id: string;
  session_started_at: string;
  agent_name: string;
  overall_score: number;
  helpfulness: number;
  accuracy: number;
  flagged: number;
}

// ── ROI Config helpers ─────────────────────────────────────────────────────

/** Working minutes per month: 160 hours x 60 minutes */
const WORKING_MINUTES_PER_MONTH = 160 * 60;

const DEFAULT_ROI_CONFIG: ROIConfig = {
  humanCostPerConversation: 12.0,
  humanFteCost: 4500,
  avgHumanHandleTime: 6,
  estimatedAiCostPerConversation: 0.05,
};

function roiStorageKey(projectId: string): string {
  return `roi-config-${projectId}`;
}

export function getRoiConfig(projectId: string): ROIConfig {
  if (typeof window === 'undefined') return { ...DEFAULT_ROI_CONFIG };
  try {
    const raw = localStorage.getItem(roiStorageKey(projectId));
    if (!raw) return { ...DEFAULT_ROI_CONFIG };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_ROI_CONFIG };
    const obj = parsed as Record<string, unknown>;
    return {
      humanCostPerConversation:
        typeof obj.humanCostPerConversation === 'number'
          ? obj.humanCostPerConversation
          : DEFAULT_ROI_CONFIG.humanCostPerConversation,
      humanFteCost:
        typeof obj.humanFteCost === 'number' ? obj.humanFteCost : DEFAULT_ROI_CONFIG.humanFteCost,
      avgHumanHandleTime:
        typeof obj.avgHumanHandleTime === 'number'
          ? obj.avgHumanHandleTime
          : DEFAULT_ROI_CONFIG.avgHumanHandleTime,
      estimatedAiCostPerConversation:
        typeof obj.estimatedAiCostPerConversation === 'number'
          ? obj.estimatedAiCostPerConversation
          : DEFAULT_ROI_CONFIG.estimatedAiCostPerConversation,
    };
  } catch {
    return { ...DEFAULT_ROI_CONFIG };
  }
}

export function setRoiConfig(projectId: string, config: ROIConfig): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(roiStorageKey(projectId), JSON.stringify(config));
}

// ── SWR config ──────────────────────────────────────────────────────────────

const insightsSWR = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  dedupingInterval: 30_000,
  refreshInterval: 300_000,
  errorRetryCount: 3,
};

// ── URL builders ────────────────────────────────────────────────────────────

function analyticsUrl(projectId: string, endpoint: string, range: string) {
  return `/api/runtime/analytics?projectId=${projectId}&endpoint=${endpoint}&range=${range}`;
}

function insightsUrl(projectId: string, endpoint: string, extra?: Record<string, string>) {
  const params = new URLSearchParams({ projectId, endpoint, ...extra });
  return `/api/runtime/insights?${params.toString()}`;
}

function numericValue(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

// ── Main hook ───────────────────────────────────────────────────────────────

export function useAtAGlance({
  dateRange = '30d',
  conversationFilter = '',
  conversationPage = 0,
}: {
  dateRange?: string;
  conversationFilter?: string;
  conversationPage?: number;
}) {
  const { projectId } = useNavigationStore();
  const days = dateRange === '7d' ? '7' : dateRange === '90d' ? '90' : '30';
  const period = dateRange;

  // ROI config state — held directly in useState, persisted to localStorage on change
  const [roiConfig, setRoiConfigState] = useState<ROIConfig>(() =>
    projectId ? getRoiConfig(projectId) : { ...DEFAULT_ROI_CONFIG },
  );

  // Re-read from localStorage when projectId changes
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (projectId !== prevProjectId) {
    setPrevProjectId(projectId);
    setRoiConfigState(projectId ? getRoiConfig(projectId) : { ...DEFAULT_ROI_CONFIG });
  }

  const updateRoiConfig = useCallback(
    (config: ROIConfig) => {
      if (projectId) {
        setRoiConfig(projectId, config); // persist to localStorage
      }
      setRoiConfigState(config); // update React state directly
    },
    [projectId],
  );

  // Session metrics (conversations, containment, escalation)
  const { data: sessionData, error: sessionErr } = useSWR(
    projectId ? analyticsUrl(projectId, 'session-metrics', dateRange) : null,
    insightsSWR,
  );

  // Cost breakdown
  const { data: costData, error: costErr } = useSWR(
    projectId ? analyticsUrl(projectId, 'cost-breakdown', dateRange) : null,
    insightsSWR,
  );

  // Quality and sentiment summaries are aggregate endpoints. Do not compute KPI
  // averages from paginated conversation rows.
  const { data: qualitySummaryData, error: qualitySummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'quality_evaluation', 'summary', { period }) : null,
    insightsSWR,
  );

  const { data: sentimentSummaryData, error: sentimentSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'sentiment_analysis', 'summary', { period }) : null,
    insightsSWR,
  );

  // Agent-level aggregate rows enrich the overview breakdown without pulling
  // unbounded conversation lists.
  const { data: qualityBreakdownData, error: qualityBreakdownErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'quality_evaluation', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    insightsSWR,
  );

  const { data: sentimentBreakdownData, error: sentimentBreakdownErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'sentiment_analysis', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    insightsSWR,
  );

  // Agent breakdown — grouped by agent_name so all three pipelines share the
  // same join key and quality/sentiment maps can be reliably looked up.
  const { data: agentBreakdownData, error: agentBreakdownErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'intent_classification', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    insightsSWR,
  );

  // Timeseries from raw tables (bypasses broken MVs)
  const { data: timeseriesData, error: timeseriesErr } = useSWR(
    projectId ? insightsUrl(projectId, 'timeseries', { days }) : null,
    insightsSWR,
  );

  // Outcome totals
  const { data: outcomesData, error: outcomesErr } = useSWR(
    projectId ? insightsUrl(projectId, 'outcomes', { days }) : null,
    insightsSWR,
  );

  const conversationLimit = 25;

  const { data: conversationsData, error: conversationsErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'quality_evaluation', 'conversations', {
          period,
          filter: conversationFilter,
          limit: String(conversationLimit),
          offset: String(conversationPage * conversationLimit),
        })
      : null,
    insightsSWR,
  );

  // ── Compute KPIs ──────────────────────────────────────────────────────────

  const qualitySummary = extractObject(qualitySummaryData);
  const sentimentSummary = extractObject(sentimentSummaryData);
  const avgQuality = numericValue(
    qualitySummary.avg_overall_score ?? qualitySummary.avg_score ?? qualitySummary.overall_score,
  );
  const avgSentiment = numericValue(sentimentSummary.avg_sentiment);
  const sentimentConversationCount = numericValue(sentimentSummary.total_conversations);

  // Compute containment/escalation from conversation_outcomes (not session-metrics)
  const outcomesRaw: { outcome: string; cnt: string }[] = outcomesData?.data?.outcomes ?? [];
  const totalOutcomes = outcomesRaw.reduce((sum, o) => sum + Number(o.cnt ?? 0), 0);
  const resolvedCount = outcomesRaw
    .filter((o) => o.outcome === 'contained_resolved')
    .reduce((sum, o) => sum + Number(o.cnt ?? 0), 0);
  const escalatedCount = outcomesRaw
    .filter((o) => o.outcome.includes('escalat'))
    .reduce((sum, o) => sum + Number(o.cnt ?? 0), 0);

  const kpis: AtAGlanceKPI = {
    totalConversations: sessionData?.data?.totalSessions ?? 0,
    containmentRate: totalOutcomes > 0 ? resolvedCount / totalOutcomes : 0,
    qualityScore: avgQuality,
    avgSentiment,
    escalationRate: totalOutcomes > 0 ? escalatedCount / totalOutcomes : 0,
    costSavings: costData?.data?.estimatedSavings ?? 0,
  };

  // ── Timeseries ────────────────────────────────────────────────────────────

  const daily: DailyPoint[] = (timeseriesData?.data?.daily ?? []).map(
    (d: Record<string, unknown>) => ({
      day: String(d.day ?? ''),
      conversations: Number(d.conversations ?? 0),
      sentiment: Number(d.sentiment ?? 0),
      quality: Number(d.quality ?? 0),
      containment: Number(d.containment ?? 0),
      escalation: Number(d.escalation ?? 0),
      resolved: Number(d.resolved ?? 0),
      escalated: Number(d.escalated ?? 0),
      other: Number(d.other ?? 0),
    }),
  );

  // ── Outcomes ──────────────────────────────────────────────────────────────

  const outcomesList: { outcome: string; count: number }[] = (
    outcomesData?.data?.outcomes ?? []
  ).map((o: Record<string, unknown>) => ({
    outcome: String(o.outcome ?? 'unknown'),
    count: Number(o.cnt ?? 0),
  }));

  // ── Intent breakdown (enriched with per-intent quality/sentiment) ────────

  // Build per-agent quality/sentiment maps for the agent breakdown table.
  // Store ALL evaluated agents including score=0 so Map.has() reliably
  // distinguishes "never evaluated" (absent) from "evaluated with score 0" (present).
  const agentQualityMap = new Map<string, number>();
  for (const row of extractArray(qualityBreakdownData)) {
    const agent = String(row.agent_name || 'Unknown');
    const score = numericValue(row.avg_overall_score ?? row.avg_score ?? row.overall_score);
    agentQualityMap.set(agent, score);
  }

  const agentSentimentMap = new Map<string, number>();
  for (const row of extractArray(sentimentBreakdownData)) {
    const agent = String(row.agent_name || 'Unknown');
    const score = numericValue(row.avg_sentiment);
    agentSentimentMap.set(agent, score);
  }

  // Build breakdown rows and deduplicate by formatted name. Two different raw
  // agent slugs can format to the same display string (e.g. "loan_agent" and
  // "LoanAgent" both become "Loan Agent"). Merge by summing conversations and
  // re-averaging quality/sentiment weighted by conversation count.
  //
  // Separate sets track which formatted names already have evaluation data so
  // we can correctly handle the case where one raw slug was evaluated and its
  // case-variant was not. Map.has() on agentQualityMap distinguishes
  // "evaluated with score 0" from "never evaluated" (absent from map).
  const breakdownMap = new Map<string, BreakdownRow>();
  const qualityEvaluated = new Set<string>();
  const sentimentEvaluated = new Set<string>();

  for (const row of extractArray(agentBreakdownData)) {
    const agentLabel = String((row as Record<string, unknown>).agent_name || '');
    if (!agentLabel) continue;
    const formattedName = formatAgentName(agentLabel);
    const conversations = Number((row as Record<string, unknown>).conversation_count ?? 0);
    const confidence = Number((row as Record<string, unknown>).avg_confidence ?? 0) * 100;
    const incomingQuality = agentQualityMap.get(agentLabel);
    const incomingSentiment = agentSentimentMap.get(agentLabel);
    const hasQuality = agentQualityMap.has(agentLabel);
    const hasSentiment = agentSentimentMap.has(agentLabel);

    const existing = breakdownMap.get(formattedName);
    if (existing) {
      const total = existing.conversations + conversations;
      existing.confidence =
        total > 0
          ? (existing.confidence * existing.conversations + confidence * conversations) / total
          : 0;
      if (hasQuality) {
        existing.qualityScore = qualityEvaluated.has(formattedName)
          ? (existing.qualityScore * existing.conversations +
              (incomingQuality ?? 0) * conversations) /
            total
          : (incomingQuality ?? 0);
        qualityEvaluated.add(formattedName);
      }
      if (hasSentiment) {
        existing.avgSentiment = sentimentEvaluated.has(formattedName)
          ? (existing.avgSentiment * existing.conversations +
              (incomingSentiment ?? 0) * conversations) /
            total
          : (incomingSentiment ?? 0);
        sentimentEvaluated.add(formattedName);
      }
      existing.conversations = total;
    } else {
      if (hasQuality) qualityEvaluated.add(formattedName);
      if (hasSentiment) sentimentEvaluated.add(formattedName);
      breakdownMap.set(formattedName, {
        dimension: formattedName,
        conversations,
        confidence,
        qualityScore: incomingQuality ?? 0,
        avgSentiment: incomingSentiment ?? 0,
        trend: [],
      });
    }
  }
  const agentBreakdown: BreakdownRow[] = Array.from(breakdownMap.values());

  // ── Compute ROI ──────────────────────────────────────────────────────────

  // Sum totalCost from cost-breakdown array (each entry is { model, provider, totalCost, ... })
  const costBreakdownRows: { totalCost?: number }[] = Array.isArray(costData?.data)
    ? costData.data
    : [];
  const rawLlmCost = costBreakdownRows.reduce(
    (sum: number, row: { totalCost?: number }) => sum + Number(row.totalCost ?? 0),
    0,
  );
  const containedConversations = resolvedCount;
  const totalConversations = sessionData?.data?.totalSessions ?? 0;

  // When the cost-breakdown API returns zero, use estimated cost as fallback
  const isEstimatedCost = rawLlmCost === 0 && totalConversations > 0;
  const totalLlmCost = isEstimatedCost
    ? roiConfig.estimatedAiCostPerConversation * totalConversations
    : rawLlmCost;

  const monthlySavings = containedConversations * roiConfig.humanCostPerConversation - totalLlmCost;
  const annualROI = totalLlmCost > 0 ? (monthlySavings / totalLlmCost) * 100 : 0;
  const fteEquivalent =
    (containedConversations * roiConfig.avgHumanHandleTime) / WORKING_MINUTES_PER_MONTH;
  const costPerResolution = containedConversations > 0 ? totalLlmCost / containedConversations : 0;

  const computedROI: ComputedROI = {
    monthlySavings,
    annualROI,
    fteEquivalent,
    costPerResolution,
    totalLlmCost,
    isEstimatedCost,
  };

  // ── Conversations list ──────────────────────────────────────────────────

  const conversationsResult = conversationsData?.data;
  const conversations: ConversationRow[] = (conversationsResult?.conversations ?? []).map(
    (c: Record<string, unknown>) => ({
      session_id: String(c.session_id ?? ''),
      session_started_at: String(c.session_started_at ?? ''),
      agent_name: formatAgentName(c.agent_name?.toString().trim() || 'Unknown'),
      overall_score: Number(c.overall_score ?? 0),
      helpfulness: Number(c.helpfulness ?? 0),
      accuracy: Number(c.accuracy ?? 0),
      flagged: Number(c.flagged ?? 0),
    }),
  );
  const conversationsTotal: number = Number(conversationsResult?.total ?? 0);
  const conversationsHasMore: boolean = conversationsResult?.hasMore ?? false;

  // Primary: 5 calls that drive the above-fold KPI cards.
  // Progressive: 3 breakdowns + timeseries + conversations (tab content, independently gated).
  const isLoading = combineLoading(
    { data: sessionData, error: sessionErr },
    { data: costData, error: costErr },
    { data: qualitySummaryData, error: qualitySummaryErr },
    { data: sentimentSummaryData, error: sentimentSummaryErr },
    { data: outcomesData, error: outcomesErr },
  );
  const error =
    sessionErr ||
    costErr ||
    qualitySummaryErr ||
    sentimentSummaryErr ||
    qualityBreakdownErr ||
    sentimentBreakdownErr ||
    agentBreakdownErr ||
    timeseriesErr ||
    outcomesErr ||
    conversationsErr;

  return {
    kpis,
    daily,
    outcomesList,
    agentBreakdown,
    evaluatedCount: totalOutcomes,
    resolvedCount,
    escalatedCount,
    sentimentConversationCount,
    computedROI,
    usingEstimatedCost: rawLlmCost === 0 && totalConversations > 0,
    roiConfig,
    updateRoiConfig,
    conversations,
    conversationsTotal,
    conversationsHasMore,
    isLoading,
    error: error ? String(error) : null,
    projectId,
  };
}
