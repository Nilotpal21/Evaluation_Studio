// apps/studio/src/hooks/useAgentPerformance.ts
/**
 * useAgentPerformance Hook
 *
 * Fetches analytics from 5 pipeline types:
 *   quality_evaluation, hallucination_detection, knowledge_gap,
 *   guardrail_analysis, context_preservation
 *
 * Uses existing endpoints:
 *   - /api/runtime/pipeline-analytics?pipelineType=X&endpoint=summary
 *   - /api/runtime/pipeline-analytics?pipelineType=X&endpoint=breakdown&dimension=agent_name
 *   - /api/runtime/pipeline-analytics?pipelineType=X&endpoint=timeseries
 *   - /api/projects/:projectId/pipeline-config/:pipelineType (via proxy)
 */

import useSWR from 'swr';
import { useNavigationStore } from '../store/navigation-store';
import { pipelineUrl, extractObject, extractArray, combineLoading } from './insights-helpers';
import { formatAgentName } from '../lib/format/agent-name';

// ── Constants ──────────────────────────────────────────────────────────────

const PIPELINE_TYPES = [
  'quality_evaluation',
  'hallucination_detection',
  'knowledge_gap',
  'guardrail_analysis',
  'context_preservation',
] as const;

type PipelineType = (typeof PIPELINE_TYPES)[number];
export type AgentPerformanceMetric =
  | 'quality'
  | 'hallucinationRate'
  | 'knowledgeGaps'
  | 'safetyScore'
  | 'contextScore';

/** Which direction is "good" for each metric. */
const METRIC_DIRECTIONS: Record<PipelineType, 'higher-better' | 'lower-better'> = {
  quality_evaluation: 'higher-better',
  hallucination_detection: 'lower-better',
  knowledge_gap: 'lower-better',
  guardrail_analysis: 'higher-better',
  context_preservation: 'higher-better',
};

/** Default flag thresholds — used when pipeline config is not available. */
const DEFAULT_THRESHOLDS: Record<PipelineType, number> = {
  quality_evaluation: 2.5,
  hallucination_detection: 0.5,
  knowledge_gap: 0.5,
  guardrail_analysis: 2.5,
  context_preservation: 2.5,
};

const AGGREGATE_RATE_THRESHOLDS = {
  hallucinationWarningPct: 5,
  hallucinationCriticalPct: 10,
  knowledgeGapWarningCount: 3,
  knowledgeGapCriticalCount: 7,
  safetyWarningPct: 90,
  safetyCriticalPct: 75,
} as const;

/**
 * Context preservation LLM outputs scores on a 0-1 scale, but the UI uses
 * the 0-5 convention (matching quality_evaluation). This helper clamps the
 * raw value to [0,1] then scales to 0-5 for display.
 */
const CONTEXT_SCORE_SCALE = 5;
function normalizeContextScore(raw: number): number {
  return Math.min(Math.max(raw, 0), 1) * CONTEXT_SCORE_SCALE;
}

/** Warning buffer: 20% above the critical threshold. */
const WARNING_BUFFER = 1.2;

// ── Types ──────────────────────────────────────────────────────────────────

export type AgentStatus = 'healthy' | 'warning' | 'critical';

export interface AgentRow {
  agentName: string;
  status: AgentStatus;
  conversations: number;
  quality: number | null;
  hallucinationRate: number | null;
  knowledgeGaps: number | null;
  safetyScore: number | null;
  contextScore: number | null;
  trend: 'up' | 'down' | 'stable' | null;
}

export interface KPISummary {
  value: number | null;
  delta: number | null;
  favorable: 'up' | 'down';
  sparkline: number[];
  status: AgentStatus;
}

export interface HealthSummary {
  healthy: number;
  warning: number;
  critical: number;
  totalAgents: number;
  totalConversations: number;
  conversationsDelta: number | null;
}

export interface AgentPerformanceData {
  kpis: {
    quality: KPISummary;
    hallucination: KPISummary;
    knowledgeGaps: KPISummary;
    safety: KPISummary;
    context: KPISummary;
  };
  agents: AgentRow[];
  healthSummary: HealthSummary;
  dailyTrend: Array<{ day: string; avgQuality: number; flaggedCount: number }>;
  isLoading: boolean;
  error: string | null;
  projectId: string | null;
}

// ── SWR config ─────────────────────────────────────────────────────────────

const swrConfig = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  dedupingInterval: 30_000,
  refreshInterval: 300_000,
  errorRetryCount: 3,
};

// ── URL builders ───────────────────────────────────────────────────────────

function configUrl(projectId: string, pipelineType: string) {
  return `/api/projects/${projectId}/pipeline-config/${pipelineType}`;
}

// ── Health classification ──────────────────────────────────────────────────

function classifyMetric(
  value: number | null,
  pipelineType: PipelineType,
  threshold: number,
): AgentStatus {
  if (value === null || isNaN(value)) return 'healthy';
  const direction = METRIC_DIRECTIONS[pipelineType];
  const warningThreshold =
    direction === 'higher-better' ? threshold * WARNING_BUFFER : threshold / WARNING_BUFFER;

  if (direction === 'higher-better') {
    if (value <= threshold) return 'critical';
    if (value <= warningThreshold) return 'warning';
    return 'healthy';
  } else {
    if (value >= threshold) return 'critical';
    if (value >= warningThreshold) return 'warning';
    return 'healthy';
  }
}

export function classifyAgentPerformanceMetric(
  value: number | null,
  metric: AgentPerformanceMetric,
  threshold?: number,
): AgentStatus {
  if (value === null || isNaN(value)) return 'healthy';

  switch (metric) {
    case 'quality':
      return classifyMetric(
        value,
        'quality_evaluation',
        threshold ?? DEFAULT_THRESHOLDS.quality_evaluation,
      );
    case 'contextScore':
      return classifyMetric(
        value,
        'context_preservation',
        threshold ?? DEFAULT_THRESHOLDS.context_preservation,
      );
    case 'hallucinationRate':
      if (value >= AGGREGATE_RATE_THRESHOLDS.hallucinationCriticalPct) return 'critical';
      if (value >= AGGREGATE_RATE_THRESHOLDS.hallucinationWarningPct) return 'warning';
      return 'healthy';
    case 'knowledgeGaps':
      if (value > AGGREGATE_RATE_THRESHOLDS.knowledgeGapCriticalCount) return 'critical';
      if (value > AGGREGATE_RATE_THRESHOLDS.knowledgeGapWarningCount) return 'warning';
      return 'healthy';
    case 'safetyScore':
      if (value < AGGREGATE_RATE_THRESHOLDS.safetyCriticalPct) return 'critical';
      if (value < AGGREGATE_RATE_THRESHOLDS.safetyWarningPct) return 'warning';
      return 'healthy';
  }
}

function worstStatus(statuses: AgentStatus[]): AgentStatus {
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'healthy';
}

function getThreshold(configData: unknown, pipelineType: PipelineType): number {
  const obj = extractObject(configData);
  const config = obj.config as Record<string, unknown> | undefined;
  const threshold = config?.flagThreshold;
  if (typeof threshold !== 'number') return DEFAULT_THRESHOLDS[pipelineType];
  if (pipelineType === 'context_preservation' && threshold <= 1) {
    return threshold * CONTEXT_SCORE_SCALE;
  }
  return threshold;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFlaggedRatePct(summary: Record<string, unknown>): number | null {
  const explicitRate = asNumber(summary.flagged_rate_pct);
  if (explicitRate !== null) return explicitRate;

  const flagged = asNumber(summary.flagged_count);
  const total = asNumber(summary.total_evaluations ?? summary.total_conversations);
  if (flagged === null || total === null || total <= 0) return null;
  return (flagged / total) * 100;
}

// ── Main hook ──────────────────────────────────────────────────────────────

export function useAgentPerformance(
  dateRange: '7d' | '30d' | '90d' = '7d',
  compareEnabled = false,
): AgentPerformanceData {
  const { projectId } = useNavigationStore();
  const period = dateRange;

  // ── Summary calls (5) ─────────────────────────────────────────────────
  const { data: qualSummary, error: qualSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'quality_evaluation', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: halSummary, error: halSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'hallucination_detection', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: kgSummary, error: kgSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'knowledge_gap', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: grSummary, error: grSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'guardrail_analysis', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: ctxSummary, error: ctxSummaryErr } = useSWR(
    projectId ? pipelineUrl(projectId, 'context_preservation', 'summary', { period }) : null,
    swrConfig,
  );

  // ── Breakdown calls (5, dimension=agent_name) ─────────────────────────
  const { data: qualBreakdown, error: qualBreakdownErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'quality_evaluation', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    swrConfig,
  );
  const { data: halBreakdown, error: halBreakdownErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'hallucination_detection', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    swrConfig,
  );
  const { data: kgBreakdown, error: kgBreakdownErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'knowledge_gap', 'breakdown', { period, dimension: 'agent_name' })
      : null,
    swrConfig,
  );
  const { data: grBreakdown, error: grBreakdownErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'guardrail_analysis', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    swrConfig,
  );
  const { data: ctxBreakdown, error: ctxBreakdownErr } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'context_preservation', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    swrConfig,
  );

  // ── Timeseries (quality only — it has an MV) ──────────────────────────
  const { data: qualTimeseries } = useSWR(
    projectId ? pipelineUrl(projectId, 'quality_evaluation', 'timeseries', { period }) : null,
    swrConfig,
  );

  // ── Pipeline configs (for thresholds) ─────────────────────────────────
  const { data: qualConfig } = useSWR(
    projectId ? configUrl(projectId, 'quality_evaluation') : null,
    swrConfig,
  );
  const { data: halConfig } = useSWR(
    projectId ? configUrl(projectId, 'hallucination_detection') : null,
    swrConfig,
  );
  const { data: kgConfig } = useSWR(
    projectId ? configUrl(projectId, 'knowledge_gap') : null,
    swrConfig,
  );
  const { data: grConfig } = useSWR(
    projectId ? configUrl(projectId, 'guardrail_analysis') : null,
    swrConfig,
  );
  const { data: ctxConfig } = useSWR(
    projectId ? configUrl(projectId, 'context_preservation') : null,
    swrConfig,
  );

  // ── Previous-period comparison (only when toggle is on) ────────────────
  const currentWindowDays = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90;
  const prevParams = compareEnabled ? { period, offsetDays: String(currentWindowDays) } : null;

  const { data: qualSummaryPrev } = useSWR(
    projectId && prevParams
      ? pipelineUrl(projectId, 'quality_evaluation', 'summary', prevParams)
      : null,
    swrConfig,
  );
  const { data: halSummaryPrev } = useSWR(
    projectId && prevParams
      ? pipelineUrl(projectId, 'hallucination_detection', 'summary', prevParams)
      : null,
    swrConfig,
  );
  const { data: kgSummaryPrev } = useSWR(
    projectId && prevParams ? pipelineUrl(projectId, 'knowledge_gap', 'summary', prevParams) : null,
    swrConfig,
  );
  const { data: grSummaryPrev } = useSWR(
    projectId && prevParams
      ? pipelineUrl(projectId, 'guardrail_analysis', 'summary', prevParams)
      : null,
    swrConfig,
  );
  const { data: ctxSummaryPrev } = useSWR(
    projectId && prevParams
      ? pipelineUrl(projectId, 'context_preservation', 'summary', prevParams)
      : null,
    swrConfig,
  );

  // ── Loading / error state ─────────────────────────────────────────────
  // Primary: 5 summaries (KPI cards) + 5 breakdowns (agent comparison table).
  // Progressive: qualTimeseries (trend chart + sparkline), pipeline configs
  // (threshold values, not filter-dependent), prev-period comparisons (conditional feature).
  const isLoading = combineLoading(
    { data: qualSummary, error: qualSummaryErr },
    { data: halSummary, error: halSummaryErr },
    { data: kgSummary, error: kgSummaryErr },
    { data: grSummary, error: grSummaryErr },
    { data: ctxSummary, error: ctxSummaryErr },
    { data: qualBreakdown, error: qualBreakdownErr },
    { data: halBreakdown, error: halBreakdownErr },
    { data: kgBreakdown, error: kgBreakdownErr },
    { data: grBreakdown, error: grBreakdownErr },
    { data: ctxBreakdown, error: ctxBreakdownErr },
  );

  const error =
    qualSummaryErr ??
    halSummaryErr ??
    kgSummaryErr ??
    grSummaryErr ??
    ctxSummaryErr ??
    qualBreakdownErr ??
    halBreakdownErr ??
    kgBreakdownErr ??
    grBreakdownErr ??
    ctxBreakdownErr ??
    null;

  // ── Extract thresholds ────────────────────────────────────────────────
  const thresholds: Record<PipelineType, number> = {
    quality_evaluation: getThreshold(qualConfig, 'quality_evaluation'),
    hallucination_detection: getThreshold(halConfig, 'hallucination_detection'),
    knowledge_gap: getThreshold(kgConfig, 'knowledge_gap'),
    guardrail_analysis: getThreshold(grConfig, 'guardrail_analysis'),
    context_preservation: getThreshold(ctxConfig, 'context_preservation'),
  };

  // ── Extract summaries ─────────────────────────────────────────────────
  const qs = extractObject(qualSummary);
  const hs = extractObject(halSummary);
  const ks = extractObject(kgSummary);
  const gs = extractObject(grSummary);
  const cs = extractObject(ctxSummary);

  const qsPrev = compareEnabled ? extractObject(qualSummaryPrev) : null;
  const hsPrev = compareEnabled ? extractObject(halSummaryPrev) : null;
  const ksPrev = compareEnabled ? extractObject(kgSummaryPrev) : null;
  const gsPrev = compareEnabled ? extractObject(grSummaryPrev) : null;
  const csPrev = compareEnabled ? extractObject(ctxSummaryPrev) : null;

  // ── Build KPIs ────────────────────────────────────────────────────────
  const qualityVal = asNumber(qs.avg_overall_score);
  const halRate = asNumber(hs.flagged_rate_pct);
  const kgGaps = asNumber(ks.gap_count ?? ks.flagged_count);
  const guardrailFlaggedRate = getFlaggedRatePct(gs);
  const safetyVal = guardrailFlaggedRate === null ? null : 100 - guardrailFlaggedRate;
  const contextRaw = asNumber(cs.avg_score);
  const contextVal = contextRaw === null ? null : normalizeContextScore(contextRaw);

  function computeDelta(
    current: number | null,
    prevObj: Record<string, unknown> | null,
    key: string,
    scale = 1,
  ): number | null {
    if (current === null || !prevObj || !compareEnabled) return null;
    const raw = asNumber(prevObj[key]);
    if (raw === null) return null;
    const prev = scale !== 1 ? normalizeContextScore(raw) : raw;
    return current - prev;
  }

  function computeSafetyDelta(current: number | null, prevObj: Record<string, unknown> | null) {
    if (current === null || !prevObj || !compareEnabled) return null;
    const prevFlaggedRate = getFlaggedRatePct(prevObj);
    if (prevFlaggedRate === null) return null;
    return current - (100 - prevFlaggedRate);
  }

  // ── Timeseries ────────────────────────────────────────────────────────
  const tsRows = extractArray(qualTimeseries);
  const dailyTrend = tsRows.map((r) => ({
    day: String(r.day ?? ''),
    avgQuality: Number(r.avg_overall_score ?? 0),
    flaggedCount: Number(r.flagged_count ?? 0),
  }));
  const qualitySparkline = dailyTrend.map((d) => d.avgQuality);

  const kpis: AgentPerformanceData['kpis'] = {
    quality: {
      value: qualityVal,
      delta: computeDelta(qualityVal, qsPrev, 'avg_overall_score'),
      favorable: 'up',
      sparkline: qualitySparkline,
      status: classifyAgentPerformanceMetric(qualityVal, 'quality', thresholds.quality_evaluation),
    },
    hallucination: {
      value: halRate,
      delta: computeDelta(halRate, hsPrev, 'flagged_rate_pct'),
      favorable: 'down',
      sparkline: [],
      status: classifyAgentPerformanceMetric(halRate, 'hallucinationRate'),
    },
    knowledgeGaps: {
      value: kgGaps,
      delta: computeDelta(kgGaps, ksPrev, 'gap_count'),
      favorable: 'down',
      sparkline: [],
      status: classifyAgentPerformanceMetric(kgGaps, 'knowledgeGaps'),
    },
    safety: {
      value: safetyVal,
      delta: computeSafetyDelta(safetyVal, gsPrev),
      favorable: 'up',
      sparkline: [],
      status: classifyAgentPerformanceMetric(safetyVal, 'safetyScore'),
    },
    context: {
      value: contextVal,
      delta: computeDelta(contextVal, csPrev, 'avg_score', CONTEXT_SCORE_SCALE),
      favorable: 'up',
      sparkline: [],
      status: classifyAgentPerformanceMetric(
        contextVal,
        'contextScore',
        thresholds.context_preservation,
      ),
    },
  };

  // ── Merge per-agent breakdown ─────────────────────────────────────────
  const qualRows = extractArray(qualBreakdown);
  const halRows = extractArray(halBreakdown);
  const kgRows = extractArray(kgBreakdown);
  const grRows = extractArray(grBreakdown);
  const ctxRows = extractArray(ctxBreakdown);

  const agentMap = new Map<string, AgentRow>();
  // Raw accumulators per formatted name for metrics that must merge across
  // case-variant raw slugs (e.g. Apple_Care_Supervisor / apple_care_supervisor).
  const qualityConvMap = new Map<string, number>();
  const halFlaggedMap = new Map<string, number>();
  const halCountMap = new Map<string, number>();
  const kgGapsMap = new Map<string, number>();
  const safetyFlaggedMap = new Map<string, number>();
  const safetyCountMap = new Map<string, number>();
  const ctxConvMap = new Map<string, number>();

  function ensureAgent(name: string): AgentRow | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const safeName = formatAgentName(trimmed);
    if (!agentMap.has(safeName)) {
      agentMap.set(safeName, {
        agentName: safeName,
        status: 'healthy',
        conversations: 0,
        quality: null,
        hallucinationRate: null,
        knowledgeGaps: null,
        safetyScore: null,
        contextScore: null,
        trend: null,
      });
    }
    // Safe assertion: we just set it above if it didn't exist
    return agentMap.get(safeName)!;
  }

  for (const r of qualRows) {
    const agent = ensureAgent(String(r.agent_name ?? ''));
    if (!agent) continue;
    const count = Number(r.conversation_count ?? 0);
    const score = Number(r.avg_overall_score ?? 0);
    const prevCount = qualityConvMap.get(agent.agentName) ?? 0;
    const total = prevCount + count;
    agent.quality =
      prevCount > 0 && agent.quality !== null
        ? (agent.quality * prevCount + score * count) / total
        : score;
    qualityConvMap.set(agent.agentName, total);
    agent.conversations = Math.max(agent.conversations, count);
  }
  for (const r of halRows) {
    const agent = ensureAgent(String(r.agent_name ?? ''));
    if (!agent) continue;
    const count = Number(r.conversation_count ?? 0);
    const flagged = Number(r.flagged_count ?? 0);
    halFlaggedMap.set(agent.agentName, (halFlaggedMap.get(agent.agentName) ?? 0) + flagged);
    halCountMap.set(agent.agentName, (halCountMap.get(agent.agentName) ?? 0) + count);
    const totalCount = halCountMap.get(agent.agentName)!;
    const totalFlagged = halFlaggedMap.get(agent.agentName)!;
    agent.hallucinationRate = totalCount > 0 ? (totalFlagged / totalCount) * 100 : 0;
    agent.conversations = Math.max(agent.conversations, count);
  }
  for (const r of kgRows) {
    const agent = ensureAgent(String(r.agent_name ?? ''));
    if (!agent) continue;
    const gaps = Number(r.gap_count ?? r.flagged_count ?? 0);
    kgGapsMap.set(agent.agentName, (kgGapsMap.get(agent.agentName) ?? 0) + gaps);
    agent.knowledgeGaps = kgGapsMap.get(agent.agentName)!;
    agent.conversations = Math.max(agent.conversations, Number(r.conversation_count ?? 0));
  }
  for (const r of grRows) {
    const agent = ensureAgent(String(r.agent_name ?? ''));
    if (!agent) continue;
    const count = Number(r.conversation_count ?? 0);
    const flagged = Number(r.flagged_count ?? 0);
    safetyFlaggedMap.set(agent.agentName, (safetyFlaggedMap.get(agent.agentName) ?? 0) + flagged);
    safetyCountMap.set(agent.agentName, (safetyCountMap.get(agent.agentName) ?? 0) + count);
    const totalCount = safetyCountMap.get(agent.agentName)!;
    const totalFlagged = safetyFlaggedMap.get(agent.agentName)!;
    agent.safetyScore = totalCount > 0 ? ((totalCount - totalFlagged) / totalCount) * 100 : null;
    agent.conversations = Math.max(agent.conversations, count);
  }
  for (const r of ctxRows) {
    const agent = ensureAgent(String(r.agent_name ?? ''));
    if (!agent) continue;
    const count = Number(r.conversation_count ?? 0);
    const score = Number(r.avg_overall_score ?? 0);
    const prevCount = ctxConvMap.get(agent.agentName) ?? 0;
    const total = prevCount + count;
    const mergedScore =
      prevCount > 0 && agent.contextScore !== null
        ? (normalizeContextScore(score) * count + agent.contextScore * prevCount) / total
        : normalizeContextScore(score);
    ctxConvMap.set(agent.agentName, total);
    agent.contextScore = mergedScore;
    agent.conversations = Math.max(agent.conversations, count);
  }

  // Classify each agent
  for (const agent of agentMap.values()) {
    const statuses: AgentStatus[] = [
      classifyAgentPerformanceMetric(agent.quality, 'quality', thresholds.quality_evaluation),
      classifyAgentPerformanceMetric(agent.hallucinationRate, 'hallucinationRate'),
      classifyAgentPerformanceMetric(agent.knowledgeGaps, 'knowledgeGaps'),
      classifyAgentPerformanceMetric(agent.safetyScore, 'safetyScore'),
      classifyAgentPerformanceMetric(
        agent.contextScore,
        'contextScore',
        thresholds.context_preservation,
      ),
    ];
    agent.status = worstStatus(statuses);
  }

  const agents = Array.from(agentMap.values()).filter(
    (a) => a.conversations > 0 || a.quality !== null || a.contextScore !== null,
  );

  // ── Health summary ────────────────────────────────────────────────────
  const healthSummary: HealthSummary = {
    healthy: agents.filter((a) => a.status === 'healthy').length,
    warning: agents.filter((a) => a.status === 'warning').length,
    critical: agents.filter((a) => a.status === 'critical').length,
    totalAgents: agents.length,
    totalConversations: Number(qs.total_conversations ?? 0),
    conversationsDelta: computeDelta(
      Number(qs.total_conversations ?? 0),
      qsPrev,
      'total_conversations',
    ),
  };

  return {
    kpis,
    agents,
    healthSummary,
    dailyTrend,
    isLoading,
    error: error ? String(error) : null,
    projectId,
  };
}
