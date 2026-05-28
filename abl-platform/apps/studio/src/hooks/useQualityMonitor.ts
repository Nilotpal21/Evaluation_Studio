/**
 * useQualityMonitor Hook
 *
 * Fetches analytics data for the Quality Monitor page from 5 quality pipelines:
 *   quality_evaluation, hallucination_detection, knowledge_gap,
 *   guardrail_analysis, context_preservation
 *
 * Uses 15 SWR calls:
 *   1-5.  Summary per pipeline
 *   6-10. Timeseries per pipeline
 *   11-15. Flagged conversations per pipeline
 */

import useSWR from 'swr';
import { useNavigationStore } from '../store/navigation-store';
import { extractObject, extractArray, pipelineUrl, combineLoading } from './insights-helpers';

// Re-export pipelineUrl so tests can import from this module too
export { pipelineUrl };

// ── Constants ──────────────────────────────────────────────────────────────

const PIPELINE_TYPES = [
  'quality_evaluation',
  'hallucination_detection',
  'knowledge_gap',
  'guardrail_analysis',
  'context_preservation',
] as const;

type PipelineType = (typeof PIPELINE_TYPES)[number];

const WEIGHTS: Record<PipelineType, number> = {
  quality_evaluation: 0.3,
  hallucination_detection: 0.25,
  knowledge_gap: 0.15,
  guardrail_analysis: 0.2,
  context_preservation: 0.1,
};

/** Quality evaluation uses a 0-5 Likert scale; other pipelines use 0-1. */
export const QUALITY_SCORE_MAX = 5;

type SubMetricKind = 'score' | 'count';

interface SubMetricSpec {
  key: string;
  kind: SubMetricKind;
}

/** Pipeline-specific sub-metrics after summary field normalization. */
const DIMENSION_SUB_METRICS: Record<PipelineType, SubMetricSpec[]> = {
  quality_evaluation: [
    { key: 'helpfulness', kind: 'score' },
    { key: 'accuracy', kind: 'score' },
    { key: 'professionalism', kind: 'score' },
    { key: 'instruction_following', kind: 'score' },
  ],
  hallucination_detection: [
    { key: 'faithfulness_score', kind: 'score' },
    { key: 'consistency_index', kind: 'score' },
    { key: 'contradiction_detected', kind: 'count' },
  ],
  knowledge_gap: [
    { key: 'retrieval_precision', kind: 'score' },
    { key: 'citation_rate', kind: 'score' },
    { key: 'gap_detected', kind: 'count' },
  ],
  guardrail_analysis: [
    { key: 'false_positive_score', kind: 'score' },
    { key: 'false_negative_score', kind: 'score' },
    { key: 'bypass_detected', kind: 'count' },
  ],
  context_preservation: [
    { key: 'context_score', kind: 'score' },
    { key: 'duplication_detected', kind: 'count' },
    { key: 'handoff_count', kind: 'count' },
  ],
};

/**
 * Explicit mapping from API summary field names → canonical names per pipeline.
 *
 * The pipeline-analytics /summary endpoint returns different field names per pipeline
 * (e.g. `avg_faithfulness` vs canonical `faithfulness_score`). This maps them so
 * pure functions can use a single, consistent set of field names.
 */
const SUMMARY_FIELD_MAP: Record<PipelineType, Record<string, string>> = {
  quality_evaluation: {
    avg_overall_score: 'overall_score',
    avg_helpfulness: 'helpfulness',
    avg_accuracy: 'accuracy',
    avg_professionalism: 'professionalism',
    avg_instruction_following: 'instruction_following',
  },
  hallucination_detection: {
    avg_score: 'overall_score',
    total_evaluations: 'total_conversations',
    avg_faithfulness: 'faithfulness_score',
    avg_consistency: 'consistency_index',
    contradiction_count: 'contradiction_detected',
  },
  knowledge_gap: {
    avg_score: 'overall_score',
    total_evaluations: 'total_conversations',
    avg_retrieval_precision: 'retrieval_precision',
    avg_citation_rate: 'citation_rate',
    gap_count: 'gap_detected',
  },
  guardrail_analysis: {
    avg_score: 'overall_score',
    total_evaluations: 'total_conversations',
    avg_false_positive: 'false_positive_score',
    avg_false_negative: 'false_negative_score',
    bypass_count: 'bypass_detected',
  },
  context_preservation: {
    avg_score: 'overall_score',
    total_evaluations: 'total_conversations',
    avg_context_score: 'context_score',
    duplication_count: 'duplication_detected',
  },
};

function normalizeSummary(raw: Record<string, unknown>, pipeline: string): Record<string, unknown> {
  if (!raw || Object.keys(raw).length === 0) return raw;

  const out: Record<string, unknown> = { ...raw };
  const fieldMap = SUMMARY_FIELD_MAP[pipeline as PipelineType];
  if (fieldMap) {
    for (const [apiName, canonicalName] of Object.entries(fieldMap)) {
      if (apiName in raw && !(canonicalName in raw)) {
        out[canonicalName] = raw[apiName];
      }
    }
  }

  return out;
}

const PIPELINE_LABELS: Record<PipelineType, string> = {
  quality_evaluation: 'Quality Evaluation',
  hallucination_detection: 'Hallucination Detection',
  knowledge_gap: 'Knowledge Gap',
  guardrail_analysis: 'Guardrail Analysis',
  context_preservation: 'Context Preservation',
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface SubMetric {
  key: string;
  value: number;
  kind: SubMetricKind;
}

export interface DimensionStats {
  pipeline: string;
  label: string;
  score: number;
  status: 'healthy' | 'warning' | 'critical';
  /** False when the pipeline has zero evaluations — UI should render "no data" instead of a red critical state. */
  hasData: boolean;
  subMetrics: SubMetric[];
  flaggedCount: number;
  sparkline: number[];
}

export interface DailyQualityPoint {
  day: string;
  quality_evaluation: number;
  hallucination_detection: number;
  knowledge_gap: number;
  guardrail_analysis: number;
  context_preservation: number;
}

export interface ConversationRow {
  sessionId: string;
  date: string;
  agentName: string;
  qualityScore: number;
  flaggedDimensions: string[];
  helpfulness: number;
  rubricScores: Record<string, number>;
  customDimensions: Record<string, number>;
}

export interface QualityMonitorData {
  overallQualityScore: number;
  totalEvaluated: number;
  flaggedCount: number;
  flaggedRate: number;
  dimensions: DimensionStats[];
  dailyTrend: DailyQualityPoint[];
  flaggedConversations: ConversationRow[];
  isLoading: boolean;
  error: string | null;
  projectId: string | null;
  dateRange: string;
}

// ── SWR config ─────────────────────────────────────────────────────────────

const swrConfig = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  dedupingInterval: 30_000,
  refreshInterval: 300_000,
  errorRetryCount: 3,
};

// ── Pure functions (exported for testability) ──────────────────────────────

/**
 * Classify a normalized health score where higher is better.
 */
export function classifyScore(value: number): 'healthy' | 'warning' | 'critical' {
  if (value > 0.7) return 'healthy';
  if (value > 0.5) return 'warning';
  return 'critical';
}

function normalizeScore(value: unknown, pipeline: string): number {
  const rawScore = Number(value ?? 0);
  const scale = pipeline === 'quality_evaluation' ? QUALITY_SCORE_MAX : 1;
  return Math.min(Math.max(rawScore / scale, 0), 1);
}

/**
 * Compute the overall health score as a weighted average across 5 dimensions.
 * Returns { score, status, flaggedTotal }.
 */
export function computeOverallHealth(summaries: Record<string, Record<string, unknown>>): {
  score: number;
  status: 'healthy' | 'warning' | 'critical';
  flaggedTotal: number;
  hasData: boolean;
} {
  let weightedSum = 0;
  let totalWeight = 0;
  let flaggedTotal = 0;
  let hasData = false;

  // A pipeline's summary counts as "having data" when it both reports a score
  // AND either omits total_conversations (legacy fixtures / older APIs) or
  // reports a positive count.
  const summaryHasData = (summary: Record<string, unknown> | undefined) =>
    !!summary &&
    'overall_score' in summary &&
    (!('total_conversations' in summary) || Number(summary.total_conversations) > 0);

  for (const pt of PIPELINE_TYPES) {
    const summary = summaries[pt];
    if (!summaryHasData(summary)) continue;

    const weight = WEIGHTS[pt];
    const score = normalizeScore(summary!.overall_score, pt);

    weightedSum += score * weight;
    totalWeight += weight;
    hasData = true;

    flaggedTotal += Number(summary!.flagged_count ?? 0);
  }

  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // No evaluations yet → present as warning (neutral "no data"), never red critical.
  if (!hasData) {
    return { score: 0, status: 'warning', flaggedTotal, hasData };
  }

  // Determine overall status: if any dimension with data is critical, overall is critical
  let hasCritical = false;
  let hasWarning = false;
  for (const pt of PIPELINE_TYPES) {
    const summary = summaries[pt];
    if (!summaryHasData(summary)) continue;
    const dimScore = normalizeScore(summary!.overall_score, pt);
    const dimStatus = classifyScore(dimScore);
    if (dimStatus === 'critical') hasCritical = true;
    if (dimStatus === 'warning') hasWarning = true;
  }

  const status = hasCritical ? 'critical' : hasWarning ? 'warning' : classifyScore(score);

  return { score, status, flaggedTotal, hasData };
}

/**
 * Extract sub-metrics from a summary for a specific pipeline dimension.
 */
export function computeDimensionStats(
  summary: Record<string, unknown>,
  pipeline: string,
): {
  score: number;
  subMetrics: SubMetric[];
  flaggedCount: number;
  status: 'healthy' | 'warning' | 'critical';
  hasData: boolean;
} {
  if (!summary || Object.keys(summary).length === 0) {
    // No summary payload at all → neutral "no data" rather than red critical.
    return { score: 0, subMetrics: [], flaggedCount: 0, status: 'warning', hasData: false };
  }

  // When the API explicitly reports zero evaluations, treat as "no data" instead of critical.
  if ('total_conversations' in summary && Number(summary.total_conversations) === 0) {
    return { score: 0, subMetrics: [], flaggedCount: 0, status: 'warning', hasData: false };
  }

  const score = normalizeScore(summary.overall_score, pipeline);
  const status = classifyScore(score);
  const flaggedCount = Number(summary.flagged_count ?? 0);

  const subMetricKeys = DIMENSION_SUB_METRICS[pipeline as PipelineType] ?? [];
  const subMetrics: SubMetric[] = subMetricKeys.map((metric) => ({
    key: metric.key,
    kind: metric.kind,
    value:
      metric.kind === 'score'
        ? normalizeScore(summary[metric.key], pipeline)
        : Number(summary[metric.key] ?? 0),
  }));
  if (pipeline === 'quality_evaluation') {
    const knownKeys = new Set(subMetrics.map((metric) => metric.key));
    const customDimensions = parseNumericRecord(summary.custom_dimensions);
    for (const [key, value] of Object.entries(customDimensions).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (!knownKeys.has(key)) {
        subMetrics.push({ key, kind: 'score', value: normalizeScore(value, pipeline) });
      }
    }
  }

  return { score, subMetrics, flaggedCount, status, hasData: true };
}

function extractConversationRows(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const wrapped = obj.data as Record<string, unknown> | undefined;
  if (wrapped?.conversations && Array.isArray(wrapped.conversations)) {
    return wrapped.conversations as Record<string, unknown>[];
  }
  return extractArray(raw);
}

function getPipelineRowHealthScore(row: Record<string, unknown>, pipeline: PipelineType): number {
  return normalizeScore(row.overall_score ?? row.quality_score, pipeline);
}

function getFlagReasons(row: Record<string, unknown>, pipeline: PipelineType): string[] {
  if (Array.isArray(row.flag_reasons) && row.flag_reasons.length > 0) {
    return (row.flag_reasons as string[]).filter(Boolean);
  }
  if (Array.isArray(row.flagged_dimensions) && row.flagged_dimensions.length > 0) {
    return (row.flagged_dimensions as string[]).filter(Boolean);
  }
  return [pipeline];
}

function parseNumericRecord(raw: unknown): Record<string, number> {
  let value = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const parsed: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    const score = Number(candidate);
    if (key && Number.isFinite(score)) {
      parsed[key] = score;
    }
  }
  return parsed;
}

function getQualityRubricScores(row: Record<string, unknown>): {
  rubricScores: Record<string, number>;
  customDimensions: Record<string, number>;
} {
  const standardFields = [
    'helpfulness',
    'accuracy',
    'professionalism',
    'instruction_following',
  ] as const;
  const rubricScores: Record<string, number> = {};

  for (const field of standardFields) {
    const score = Number(row[field]);
    if (Number.isFinite(score) && score > 0) {
      rubricScores[field] = score;
    }
  }

  const customDimensions = parseNumericRecord(row.custom_dimensions);
  return {
    rubricScores: { ...rubricScores, ...customDimensions },
    customDimensions,
  };
}

// ── Main hook ──────────────────────────────────────────────────────────────

export function useQualityMonitor(dateRange: string = '30d'): QualityMonitorData {
  const { projectId } = useNavigationStore();
  const period = dateRange;

  // ── Summary calls (5) ────────────────────────────────────────────────
  const { data: qualSummaryData, error: qualSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'quality_evaluation', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: halSummaryData, error: halSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'hallucination_detection', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: kgSummaryData, error: kgSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'knowledge_gap', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: grSummaryData, error: grSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'guardrail_analysis', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: ctxSummaryData, error: ctxSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'context_preservation', 'summary', { period }) : null,
    swrConfig,
  );

  // ── Timeseries calls (5) ─────────────────────────────────────────────
  const { data: qualTSData } = useSWR(
    projectId ? pipelineUrl(projectId, 'quality_evaluation', 'timeseries', { period }) : null,
    swrConfig,
  );
  const { data: halTSData } = useSWR(
    projectId ? pipelineUrl(projectId, 'hallucination_detection', 'timeseries', { period }) : null,
    swrConfig,
  );
  const { data: kgTSData } = useSWR(
    projectId ? pipelineUrl(projectId, 'knowledge_gap', 'timeseries', { period }) : null,
    swrConfig,
  );
  const { data: grTSData } = useSWR(
    projectId ? pipelineUrl(projectId, 'guardrail_analysis', 'timeseries', { period }) : null,
    swrConfig,
  );
  const { data: ctxTSData } = useSWR(
    projectId ? pipelineUrl(projectId, 'context_preservation', 'timeseries', { period }) : null,
    swrConfig,
  );

  // ── Flagged conversations calls ──────────────────────────────────────
  const { data: qualFlaggedConvData } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'quality_evaluation', 'conversations', {
          period,
          filter: 'flagged:true',
          limit: '200',
        })
      : null,
    swrConfig,
  );
  const { data: halFlaggedConvData } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'hallucination_detection', 'conversations', {
          period,
          filter: 'flagged:true',
          limit: '200',
        })
      : null,
    swrConfig,
  );
  const { data: kgFlaggedConvData } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'knowledge_gap', 'conversations', {
          period,
          filter: 'flagged:true',
          limit: '200',
        })
      : null,
    swrConfig,
  );
  const { data: grFlaggedConvData } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'guardrail_analysis', 'conversations', {
          period,
          filter: 'flagged:true',
          limit: '200',
        })
      : null,
    swrConfig,
  );
  const { data: ctxFlaggedConvData } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'context_preservation', 'conversations', {
          period,
          filter: 'flagged:true',
          limit: '200',
        })
      : null,
    swrConfig,
  );

  // ── Extract & normalize summaries ─────────────────────────────────────
  const qualSummary = normalizeSummary(extractObject(qualSummaryData), 'quality_evaluation');
  const halSummary = normalizeSummary(extractObject(halSummaryData), 'hallucination_detection');
  const kgSummary = normalizeSummary(extractObject(kgSummaryData), 'knowledge_gap');
  const grSummary = normalizeSummary(extractObject(grSummaryData), 'guardrail_analysis');
  const ctxSummary = normalizeSummary(extractObject(ctxSummaryData), 'context_preservation');

  const summaries: Record<string, Record<string, unknown>> = {
    quality_evaluation: qualSummary,
    hallucination_detection: halSummary,
    knowledge_gap: kgSummary,
    guardrail_analysis: grSummary,
    context_preservation: ctxSummary,
  };

  // ── Compute overall health ───────────────────────────────────────────
  const health = computeOverallHealth(summaries);

  // ── Total evaluated (use quality_evaluation count, consistent with other dashboards)
  const totalEvaluated = Number(summaries.quality_evaluation?.total_conversations ?? 0);

  // ── Flagged rate — use quality_evaluation count (matches totalEvaluated denominator) ──
  const qualityFlaggedCount = Number(summaries.quality_evaluation?.flagged_count ?? 0);
  const flaggedRate = totalEvaluated > 0 ? (qualityFlaggedCount / totalEvaluated) * 100 : 0;

  // ── Dimension stats ──────────────────────────────────────────────────
  const tsDataMap: Record<PipelineType, Record<string, unknown>[]> = {
    quality_evaluation: extractArray(qualTSData),
    hallucination_detection: extractArray(halTSData),
    knowledge_gap: extractArray(kgTSData),
    guardrail_analysis: extractArray(grTSData),
    context_preservation: extractArray(ctxTSData),
  };

  const dimensions: DimensionStats[] = PIPELINE_TYPES.map((pt) => {
    const dimStats = computeDimensionStats(summaries[pt], pt);
    const tsRows = tsDataMap[pt];
    const sparkline = tsRows.map((row) =>
      normalizeScore(row.overall_score ?? row.avg_overall_score ?? row.avg_score, pt),
    );

    return {
      pipeline: pt,
      label: PIPELINE_LABELS[pt],
      score: dimStats.score,
      status: dimStats.status,
      hasData: dimStats.hasData,
      subMetrics: dimStats.subMetrics,
      flaggedCount: dimStats.flaggedCount,
      sparkline,
    };
  });

  // ── Daily trend (merge 5 timeseries by day) ──────────────────────────
  const dayMap = new Map<string, DailyQualityPoint>();

  for (const pt of PIPELINE_TYPES) {
    const rows = tsDataMap[pt];
    for (const row of rows) {
      const day = String(row.day ?? '');
      if (!day) continue;
      if (!dayMap.has(day)) {
        dayMap.set(day, {
          day,
          quality_evaluation: 0,
          hallucination_detection: 0,
          knowledge_gap: 0,
          guardrail_analysis: 0,
          context_preservation: 0,
        });
      }
      const point = dayMap.get(day);
      if (point) {
        point[pt] = normalizeScore(row.overall_score ?? row.avg_overall_score ?? row.avg_score, pt);
      }
    }
  }

  const dailyTrend: DailyQualityPoint[] = Array.from(dayMap.values()).sort((a, b) =>
    a.day.localeCompare(b.day),
  );

  // ── Flagged conversations ────────────────────────────────────────────
  const flaggedDataByPipeline: Record<PipelineType, unknown> = {
    quality_evaluation: qualFlaggedConvData,
    hallucination_detection: halFlaggedConvData,
    knowledge_gap: kgFlaggedConvData,
    guardrail_analysis: grFlaggedConvData,
    context_preservation: ctxFlaggedConvData,
  };
  const conversationMap = new Map<string, ConversationRow>();
  for (const pt of PIPELINE_TYPES) {
    const rows = extractConversationRows(flaggedDataByPipeline[pt]);
    for (const row of rows) {
      const sessionId = String(row.session_id ?? '');
      if (!sessionId) continue;

      const existing = conversationMap.get(sessionId);
      const healthScore = getPipelineRowHealthScore(row, pt);
      const flagReasons = getFlagReasons(row, pt);
      const helpfulness = Number(row.helpfulness ?? 0);
      const { rubricScores, customDimensions } =
        pt === 'quality_evaluation'
          ? getQualityRubricScores(row)
          : { rubricScores: {}, customDimensions: {} };

      if (!existing) {
        conversationMap.set(sessionId, {
          sessionId,
          date: String(row.session_started_at ?? row.day ?? row.date ?? ''),
          agentName: String((row.agent_name as string)?.trim() || 'Unknown'),
          qualityScore: healthScore,
          flaggedDimensions: flagReasons,
          helpfulness,
          rubricScores,
          customDimensions,
        });
        continue;
      }

      existing.qualityScore = Math.min(existing.qualityScore, healthScore);
      existing.flaggedDimensions = Array.from(
        new Set([...existing.flaggedDimensions, ...flagReasons]),
      );
      if (!existing.date) {
        existing.date = String(row.session_started_at ?? row.day ?? row.date ?? '');
      }
      if (existing.agentName === 'Unknown' && row.agent_name) {
        existing.agentName = String((row.agent_name as string).trim() || 'Unknown');
      }
      if (existing.helpfulness <= 0 && helpfulness > 0) {
        existing.helpfulness = helpfulness;
      }
      existing.rubricScores = { ...existing.rubricScores, ...rubricScores };
      existing.customDimensions = { ...existing.customDimensions, ...customDimensions };
    }
  }
  const flaggedConversations: ConversationRow[] = Array.from(conversationMap.values()).sort(
    (a, b) => b.date.localeCompare(a.date),
  );

  // ── Loading / Error ──────────────────────────────────────────────────
  // Primary: 5 summaries — drive all KPI cards and dimension scores.
  // Progressive: timeseries (sparklines + trend chart), conversations (flagged table).
  const isLoading = combineLoading(
    { data: qualSummaryData, error: qualSummaryErr },
    { data: halSummaryData, error: halSummaryErr },
    { data: kgSummaryData, error: kgSummaryErr },
    { data: grSummaryData, error: grSummaryErr },
    { data: ctxSummaryData, error: ctxSummaryErr },
  );
  const error =
    qualSummaryErr ?? halSummaryErr ?? kgSummaryErr ?? grSummaryErr ?? ctxSummaryErr ?? null;

  return {
    overallQualityScore: health.score,
    totalEvaluated,
    flaggedCount: health.flaggedTotal,
    flaggedRate,
    dimensions,
    dailyTrend,
    flaggedConversations,
    isLoading,
    error: error ? String(error) : null,
    projectId,
    dateRange,
  };
}
