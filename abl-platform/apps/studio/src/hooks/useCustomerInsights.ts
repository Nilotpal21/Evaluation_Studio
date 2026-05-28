/**
 * useCustomerInsights Hook
 *
 * Fetches analytics data for the Customer Insights page from:
 *   - /pipeline-analytics (intent_classification + sentiment_analysis)
 *
 * Uses 5 SWR calls:
 *   1. intent_classification/summary   → KPI: total convos, unique intents, avg confidence
 *   2. sentiment_analysis/summary      → KPI: avg sentiment, trajectory, frustration
 *   3. intent_classification/breakdown  → Donut chart + top intents table
 *   4. sentiment_analysis/timeseries    → Trend chart (sentiment line)
 *   5. intent_classification/timeseries → Trend chart (conversations + confidence)
 */

import useSWR from 'swr';
import { useNavigationStore } from '../store/navigation-store';
import { pipelineUrl, extractObject, extractArray, combineLoading } from './insights-helpers';

// Re-export shared helpers for backward compatibility (useQualityMonitor.test.ts
// and useCustomerInsights.test.ts import from this module).
export { pipelineUrl, extractObject, extractArray, combineLoading } from './insights-helpers';

// ── Types ───────────────────────────────────────────────────────────────────

export interface IntentDistributionItem {
  intent: string;
  count: number;
  confidence: number;
  /** Resolution rate (0..1) for this intent. Null when no rows had resolution evaluated. */
  resolutionRate: number | null;
  /** Partial-resolution rate (0..1) for this intent. Null when no rows had resolution evaluated. */
  partialRate: number | null;
  /** Sessions where resolution was evaluated for this intent. */
  evaluatedCount: number;
}

export interface SentimentTrajectory {
  improving: number;
  declining: number;
  stable: number;
  total: number;
}

export interface DailyTrendPoint {
  day: string;
  /** Broadest available analyzed volume for backwards-compatible summaries. */
  conversations: number;
  /** Conversations classified by the intent pipeline on this day. */
  intentConversations: number;
  /** Conversations scored by the sentiment pipeline on this day. */
  sentimentConversations: number;
  avgSentiment: number;
  frustratedCount: number;
  uniqueIntents: number;
  avgConfidence: number;
  /** Daily resolution rate as a percentage (0..100). 0 when no sessions evaluated that day. */
  resolutionRate: number;
  /** Daily partial-resolution rate as a percentage (0..100). */
  partialRate: number;
}

export interface TopIntentRow {
  intent: string;
  volume: number;
  confidence: number;
  /** Resolution rate (0..1) for this intent. Null when no rows had resolution evaluated. */
  resolutionRate: number | null;
  /** Partial-resolution rate (0..1) for this intent. Null when no rows had resolution evaluated. */
  partialRate: number | null;
  /** Sessions where resolution was evaluated for this intent. */
  evaluatedCount: number;
}

// ── SWR config ──────────────────────────────────────────────────────────────

const insightsSWR = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  dedupingInterval: 30_000,
  refreshInterval: 300_000,
  errorRetryCount: 3,
};

// ── Main hook ───────────────────────────────────────────────────────────────

export function useCustomerInsights(dateRange: string = '30d') {
  const { projectId } = useNavigationStore();
  const period = dateRange;

  // 1. Intent summary
  const { data: intentSummaryData, error: intentSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'intent_classification', 'summary', { period }) : null,
    insightsSWR,
  );

  // 2. Sentiment summary
  const { data: sentimentSummaryData, error: sentimentSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'sentiment_analysis', 'summary', { period }) : null,
    insightsSWR,
  );

  // 3. Intent breakdown by intent (for donut + table)
  const { data: intentBreakdownData, error: intentBreakdownErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'intent_classification', 'breakdown', {
          period,
          dimension: 'intent',
        })
      : null,
    insightsSWR,
  );

  // 4. Sentiment timeseries
  const { data: sentimentTimeseriesData, error: sentimentTimeseriesErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'sentiment_analysis', 'timeseries', { period }) : null,
    insightsSWR,
  );

  // 5. Intent timeseries
  const { data: intentTimeseriesData, error: intentTimeseriesErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'intent_classification', 'timeseries', { period }) : null,
    insightsSWR,
  );

  // ── Compute KPIs ──────────────────────────────────────────────────────────

  const intentSummary = extractObject(intentSummaryData);
  const sentimentSummary = extractObject(sentimentSummaryData);

  const intentTotal = Number(intentSummary.total_conversations ?? 0);
  const sentimentTotal = Number(sentimentSummary.total_conversations ?? 0);
  // Use the higher count as the broad analyzed-session total, but expose each
  // pipeline population separately so the UI does not imply one denominator.
  const totalConversations = Math.max(intentTotal, sentimentTotal);
  const intentConversationCount = intentTotal;
  const sentimentConversationCount = sentimentTotal;
  const uniqueIntents = Number(intentSummary.unique_intents ?? 0);
  const avgSentiment = Number(sentimentSummary.avg_sentiment ?? 0);
  const frustratedCount = Number(sentimentSummary.frustrated_count ?? 0);
  const frustrationRate = sentimentTotal > 0 ? (frustratedCount / sentimentTotal) * 100 : 0;

  // Intent resolution KPIs — null when no sessions have been evaluated
  const evaluatedCount = Number(intentSummary.evaluated_count ?? 0);
  const resolutionRate =
    intentSummary.resolution_rate != null && evaluatedCount > 0
      ? Number(intentSummary.resolution_rate) * 100
      : null;
  const partialRate =
    intentSummary.partial_rate != null && evaluatedCount > 0
      ? Number(intentSummary.partial_rate) * 100
      : null;

  // ── Intent distribution (donut chart + table) ─────────────────────────────

  const intentBreakdownRows = extractArray(intentBreakdownData);

  const intentDistribution: IntentDistributionItem[] = intentBreakdownRows.map(
    (row: Record<string, unknown>) => {
      const evaluated = Number(row.evaluated_count ?? 0);
      const rate =
        row.resolution_rate != null && evaluated > 0 ? Number(row.resolution_rate) : null;
      const partial = row.partial_rate != null && evaluated > 0 ? Number(row.partial_rate) : null;
      return {
        intent: String(row.intent ?? 'unknown'),
        count: Number(row.conversation_count ?? 0),
        confidence: Number(row.avg_confidence ?? 0),
        resolutionRate: rate,
        partialRate: partial,
        evaluatedCount: evaluated,
      };
    },
  );

  // ── Sentiment trajectory ──────────────────────────────────────────────────

  const improving = Number(sentimentSummary.improving_count ?? 0);
  const declining = Number(sentimentSummary.declining_count ?? 0);
  const stable = Number(sentimentSummary.stable_count ?? 0);
  const trajectoryTotal = improving + declining + stable;

  const sentimentTrajectory: SentimentTrajectory = {
    improving,
    declining,
    stable,
    total: trajectoryTotal,
  };

  // ── Daily trend (merge sentiment + intent timeseries by day) ──────────────

  const sentimentDays = extractArray(sentimentTimeseriesData);
  const intentDays = extractArray(intentTimeseriesData);

  // Build map keyed by day
  const dayMap = new Map<string, DailyTrendPoint>();

  for (const row of intentDays) {
    const day = String(row.day ?? '');
    const dayEvaluated = Number(row.evaluated_count ?? 0);
    const intentConversations = Number(row.conversation_count ?? 0);
    dayMap.set(day, {
      day,
      conversations: intentConversations,
      intentConversations,
      sentimentConversations: 0,
      avgSentiment: 0,
      frustratedCount: 0,
      uniqueIntents: Number(row.unique_intents ?? 0),
      avgConfidence: Number(row.avg_confidence ?? 0),
      resolutionRate:
        row.resolution_rate != null && dayEvaluated > 0 ? Number(row.resolution_rate) * 100 : 0,
      partialRate:
        row.partial_rate != null && dayEvaluated > 0 ? Number(row.partial_rate) * 100 : 0,
    });
  }

  for (const row of sentimentDays) {
    const day = String(row.day ?? '');
    const existing = dayMap.get(day);
    const sentimentConversations = Number(row.conversation_count ?? 0);
    if (existing) {
      existing.conversations = Math.max(existing.intentConversations, sentimentConversations);
      existing.sentimentConversations = sentimentConversations;
      existing.avgSentiment = Number(row.avg_sentiment ?? 0);
      existing.frustratedCount = Number(row.frustrated_count ?? 0);
    } else {
      dayMap.set(day, {
        day,
        conversations: sentimentConversations,
        intentConversations: 0,
        sentimentConversations,
        avgSentiment: Number(row.avg_sentiment ?? 0),
        frustratedCount: Number(row.frustrated_count ?? 0),
        uniqueIntents: 0,
        avgConfidence: 0,
        resolutionRate: 0,
        partialRate: 0,
      });
    }
  }

  const dailyTrend: DailyTrendPoint[] = Array.from(dayMap.values()).sort((a, b) =>
    a.day.localeCompare(b.day),
  );

  // ── Top intents table ─────────────────────────────────────────────────────

  const topIntents: TopIntentRow[] = intentDistribution.map((item) => ({
    intent: item.intent,
    volume: item.count,
    confidence: item.confidence,
    resolutionRate: item.resolutionRate,
    partialRate: item.partialRate,
    evaluatedCount: item.evaluatedCount,
  }));

  // ── Loading / Error ───────────────────────────────────────────────────────

  const isLoading = combineLoading(
    { data: intentSummaryData, error: intentSummaryErr },
    { data: sentimentSummaryData, error: sentimentSummaryErr },
    { data: intentBreakdownData, error: intentBreakdownErr },
    { data: sentimentTimeseriesData, error: sentimentTimeseriesErr },
    { data: intentTimeseriesData, error: intentTimeseriesErr },
  );
  const error =
    intentSummaryErr ||
    sentimentSummaryErr ||
    intentBreakdownErr ||
    sentimentTimeseriesErr ||
    intentTimeseriesErr;

  return {
    totalConversations,
    intentConversationCount,
    sentimentConversationCount,
    uniqueIntents,
    avgSentiment,
    frustrationRate,
    resolutionRate,
    partialRate,
    evaluatedCount,
    intentDistribution,
    sentimentTrajectory,
    dailyTrend,
    topIntents,
    isLoading,
    error: error ? String(error) : null,
    projectId,
  };
}
