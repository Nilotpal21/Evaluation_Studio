# Agent Performance Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Agent Performance dashboard page in Studio, replacing the "Coming Soon" placeholder with a health-first dashboard showing per-agent metrics from 5 analytics pipelines.

**Architecture:** Pure frontend — no backend changes. SWR hook fetches from 5 existing pipeline-analytics endpoints (summary + breakdown + timeseries) and 5 pipeline-config endpoints (for thresholds). Components compute health classification client-side using existing `flagThreshold` values from pipeline configs.

**Tech Stack:** React, SWR, Recharts, Tailwind CSS, Next.js dynamic imports, existing shared components (`InsightKPICard`, `TimeSeriesChart`)

---

## File Structure

| Action     | File                                                           | Responsibility                                    |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------- |
| **Create** | `apps/studio/src/hooks/useAgentPerformance.ts`                 | SWR data fetching, merging, health classification |
| **Create** | `apps/studio/src/components/insights/AgentPerformancePage.tsx` | Page layout with all sub-components co-located    |
| **Modify** | `apps/studio/src/components/navigation/AppShell.tsx`           | Wire lazy import, replace ComingSoonPage          |

---

## Task 1: Create `useAgentPerformance` SWR Hook

**Files:**

- Create: `apps/studio/src/hooks/useAgentPerformance.ts`

This hook fetches from 11 endpoints (5 summaries + 5 breakdowns + 1 timeseries), plus 5 pipeline-config endpoints for thresholds. It merges the per-agent breakdown data, classifies health status, and returns everything the page needs.

- [ ] **Step 1: Create the hook file with types and URL builders**

```typescript
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

// ── Constants ──────────────────────────────────────────────────────────────

const PIPELINE_TYPES = [
  'quality_evaluation',
  'hallucination_detection',
  'knowledge_gap',
  'guardrail_analysis',
  'context_preservation',
] as const;

type PipelineType = (typeof PIPELINE_TYPES)[number];

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
  hallucination_detection: 0.5, // 50% flagged rate
  knowledge_gap: 0.5,
  guardrail_analysis: 2.5,
  context_preservation: 2.5,
};

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
  value: number;
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

function pipelineUrl(
  projectId: string,
  pipelineType: string,
  endpoint: string,
  extra?: Record<string, string>,
) {
  const params = new URLSearchParams({ projectId, pipelineType, endpoint, ...extra });
  return `/api/runtime/pipeline-analytics?${params.toString()}`;
}

function configUrl(projectId: string, pipelineType: string) {
  return `/api/projects/${projectId}/pipeline-config/${pipelineType}`;
}
```

- [ ] **Step 2: Add defensive extraction helpers**

Append to the same file. These handle the ClickHouse response shape variations (same pattern used in `useCustomerInsights`).

```typescript
// ── Defensive extractors ───────────────────────────────────────────────────

/**
 * Extract a single-row object from an API response.
 * Handles: { success, data: { field: val } } (clean)
 *       or { success, data: { meta, data: [{ field: val }] } } (ClickHouse leaked)
 *       or { data: { success, data: ... } } (SWR wrapper)
 */
function extractObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;

  // SWR wraps in .data
  const inner = obj.data && typeof obj.data === 'object' ? obj.data : obj;
  const innerObj = inner as Record<string, unknown>;

  // If inner has .success, unwrap again
  const payload =
    'success' in innerObj && innerObj.data && typeof innerObj.data === 'object'
      ? innerObj.data
      : innerObj;
  const payloadObj = payload as Record<string, unknown>;

  // ClickHouse leaked: { meta, data: [{...}] }
  if ('meta' in payloadObj && Array.isArray(payloadObj.data)) {
    const rows = payloadObj.data as Record<string, unknown>[];
    return rows[0] ?? {};
  }

  return payloadObj;
}

/**
 * Extract an array from an API response.
 * Handles: { success, data: [...] } (clean)
 *       or { success, data: { meta, data: [...] } } (ClickHouse leaked)
 *       or { data: { success, data: ... } } (SWR wrapper)
 */
function extractArray(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;

  // SWR wraps in .data
  const inner = obj.data && typeof obj.data === 'object' ? obj.data : obj;
  const innerObj = inner as Record<string, unknown>;

  // If inner has .success, unwrap .data
  const payload = 'success' in innerObj ? innerObj.data : innerObj;

  // Direct array
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];

  // ClickHouse leaked: { meta, data: [...] }
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.data)) return p.data as Record<string, unknown>[];
  }

  return [];
}
```

- [ ] **Step 3: Add health classification functions**

Append to the same file:

```typescript
// ── Health classification ──────────────────────────────────────────────────

function classifyMetric(
  value: number | null,
  pipelineType: PipelineType,
  threshold: number,
): AgentStatus {
  if (value === null || isNaN(value)) return 'healthy'; // no data = not a problem
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

function worstStatus(statuses: AgentStatus[]): AgentStatus {
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'healthy';
}

function getThreshold(configData: unknown, pipelineType: PipelineType): number {
  const obj = extractObject(configData);
  const config = obj.config as Record<string, unknown> | undefined;
  const threshold = config?.flagThreshold;
  return typeof threshold === 'number' ? threshold : DEFAULT_THRESHOLDS[pipelineType];
}
```

- [ ] **Step 4: Add the main hook function**

Append to the same file:

```typescript
// ── Main hook ──────────────────────────────────────────────────────────────

export function useAgentPerformance(
  dateRange: '7d' | '30d' | '90d' = '7d',
  compareEnabled = false,
): AgentPerformanceData {
  const { projectId } = useNavigationStore();
  const period = dateRange;
  const days = dateRange === '7d' ? '7' : dateRange === '90d' ? '90' : '30';

  // ── Summary calls (5) ─────────────────────────────────────────────────
  const { data: qualSummary } = useSWR(
    projectId ? pipelineUrl(projectId, 'quality_evaluation', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: halSummary } = useSWR(
    projectId ? pipelineUrl(projectId, 'hallucination_detection', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: kgSummary } = useSWR(
    projectId ? pipelineUrl(projectId, 'knowledge_gap', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: grSummary } = useSWR(
    projectId ? pipelineUrl(projectId, 'guardrail_analysis', 'summary', { period }) : null,
    swrConfig,
  );
  const { data: ctxSummary } = useSWR(
    projectId ? pipelineUrl(projectId, 'context_preservation', 'summary', { period }) : null,
    swrConfig,
  );

  // ── Breakdown calls (5, dimension=agent_name) ─────────────────────────
  const { data: qualBreakdown } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'quality_evaluation', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    swrConfig,
  );
  const { data: halBreakdown } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'hallucination_detection', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    swrConfig,
  );
  const { data: kgBreakdown } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'knowledge_gap', 'breakdown', { period, dimension: 'agent_name' })
      : null,
    swrConfig,
  );
  const { data: grBreakdown } = useSWR(
    projectId
      ? pipelineUrl(projectId, 'guardrail_analysis', 'breakdown', {
          period,
          dimension: 'agent_name',
        })
      : null,
    swrConfig,
  );
  const { data: ctxBreakdown } = useSWR(
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

  // ── Comparison period (only when toggle is on) ────────────────────────
  const compPeriod = compareEnabled
    ? dateRange === '7d'
      ? '14d'
      : dateRange === '30d'
        ? '60d'
        : '180d'
    : null;

  const { data: qualSummaryPrev } = useSWR(
    projectId && compPeriod
      ? pipelineUrl(projectId, 'quality_evaluation', 'summary', { period: compPeriod })
      : null,
    swrConfig,
  );
  const { data: halSummaryPrev } = useSWR(
    projectId && compPeriod
      ? pipelineUrl(projectId, 'hallucination_detection', 'summary', { period: compPeriod })
      : null,
    swrConfig,
  );
  const { data: kgSummaryPrev } = useSWR(
    projectId && compPeriod
      ? pipelineUrl(projectId, 'knowledge_gap', 'summary', { period: compPeriod })
      : null,
    swrConfig,
  );
  const { data: grSummaryPrev } = useSWR(
    projectId && compPeriod
      ? pipelineUrl(projectId, 'guardrail_analysis', 'summary', { period: compPeriod })
      : null,
    swrConfig,
  );
  const { data: ctxSummaryPrev } = useSWR(
    projectId && compPeriod
      ? pipelineUrl(projectId, 'context_preservation', 'summary', { period: compPeriod })
      : null,
    swrConfig,
  );

  // ── Loading / error state ─────────────────────────────────────────────
  const isLoading =
    !qualSummary ||
    !halSummary ||
    !kgSummary ||
    !grSummary ||
    !ctxSummary ||
    !qualBreakdown ||
    !halBreakdown ||
    !kgBreakdown ||
    !grBreakdown ||
    !ctxBreakdown;

  const error = null; // SWR retries automatically; surface errors via empty state

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
  const qualityVal = Number(qs.avg_overall_score ?? 0);
  const halRate = Number(hs.flagged_rate_pct ?? 0);
  const kgGaps = Number(ks.gap_count ?? ks.flagged_count ?? 0);
  const safetyVal = 100 - Number(gs.flagged_rate_pct ?? 0);
  const contextVal = Number(cs.avg_score ?? 0);

  function computeDelta(
    current: number,
    prevObj: Record<string, unknown> | null,
    key: string,
  ): number | null {
    if (!prevObj || !compareEnabled) return null;
    const prev = Number(prevObj[key] ?? 0);
    return current - prev;
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
      status: classifyMetric(qualityVal, 'quality_evaluation', thresholds.quality_evaluation),
    },
    hallucination: {
      value: halRate,
      delta: computeDelta(halRate, hsPrev, 'flagged_rate_pct'),
      favorable: 'down',
      sparkline: [],
      status: classifyMetric(
        halRate,
        'hallucination_detection',
        thresholds.hallucination_detection,
      ),
    },
    knowledgeGaps: {
      value: kgGaps,
      delta: computeDelta(kgGaps, ksPrev, 'gap_count'),
      favorable: 'down',
      sparkline: [],
      status: classifyMetric(kgGaps, 'knowledge_gap', thresholds.knowledge_gap),
    },
    safety: {
      value: safetyVal,
      delta: computeDelta(safetyVal, gsPrev, 'flagged_rate_pct'),
      favorable: 'up',
      sparkline: [],
      status: classifyMetric(safetyVal, 'guardrail_analysis', thresholds.guardrail_analysis),
    },
    context: {
      value: contextVal,
      delta: computeDelta(contextVal, csPrev, 'avg_score'),
      favorable: 'up',
      sparkline: [],
      status: classifyMetric(contextVal, 'context_preservation', thresholds.context_preservation),
    },
  };

  // ── Merge per-agent breakdown ─────────────────────────────────────────
  const qualRows = extractArray(qualBreakdown);
  const halRows = extractArray(halBreakdown);
  const kgRows = extractArray(kgBreakdown);
  const grRows = extractArray(grBreakdown);
  const ctxRows = extractArray(ctxBreakdown);

  const agentMap = new Map<string, AgentRow>();

  function ensureAgent(name: string): AgentRow {
    if (!agentMap.has(name)) {
      agentMap.set(name, {
        agentName: name,
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
    return agentMap.get(name)!;
  }

  for (const r of qualRows) {
    const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
    agent.quality = Number(r.avg_overall_score ?? 0);
    agent.conversations = Math.max(agent.conversations, Number(r.conversation_count ?? 0));
  }
  for (const r of halRows) {
    const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
    const count = Number(r.conversation_count ?? 0);
    const flagged = Number(r.flagged_count ?? 0);
    agent.hallucinationRate = count > 0 ? (flagged / count) * 100 : 0;
    agent.conversations = Math.max(agent.conversations, count);
  }
  for (const r of kgRows) {
    const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
    agent.knowledgeGaps = Number(r.flagged_count ?? 0);
    agent.conversations = Math.max(agent.conversations, Number(r.conversation_count ?? 0));
  }
  for (const r of grRows) {
    const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
    const count = Number(r.conversation_count ?? 0);
    const flagged = Number(r.flagged_count ?? 0);
    agent.safetyScore = count > 0 ? ((count - flagged) / count) * 100 : 100;
    agent.conversations = Math.max(agent.conversations, count);
  }
  for (const r of ctxRows) {
    const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
    agent.contextScore = Number(r.avg_overall_score ?? 0);
    agent.conversations = Math.max(agent.conversations, Number(r.conversation_count ?? 0));
  }

  // Classify each agent
  for (const agent of agentMap.values()) {
    const statuses: AgentStatus[] = [
      classifyMetric(agent.quality, 'quality_evaluation', thresholds.quality_evaluation),
      classifyMetric(
        agent.hallucinationRate,
        'hallucination_detection',
        thresholds.hallucination_detection,
      ),
      classifyMetric(agent.knowledgeGaps, 'knowledge_gap', thresholds.knowledge_gap),
      classifyMetric(agent.safetyScore, 'guardrail_analysis', thresholds.guardrail_analysis),
      classifyMetric(agent.contextScore, 'context_preservation', thresholds.context_preservation),
    ];
    agent.status = worstStatus(statuses);
  }

  const agents = Array.from(agentMap.values());

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

  return { kpis, agents, healthSummary, dailyTrend, isLoading, error };
}
```

- [ ] **Step 5: Run TypeScript check**

Run: `pnpm build --filter=studio 2>&1 | head -30`
Expected: Build succeeds (hook is not imported yet, so no consumers to break)

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/hooks/useAgentPerformance.ts
git add apps/studio/src/hooks/useAgentPerformance.ts
git commit -m "[ABLP-XXX] feat(studio): add useAgentPerformance SWR hook

Fetches from 5 pipeline-analytics endpoints (summary + breakdown) and
pipeline-config (thresholds). Merges per-agent data and classifies health
status as healthy/warning/critical using existing flagThreshold configs."
```

---

## Task 2: Create `AgentPerformancePage` Component

**Files:**

- Create: `apps/studio/src/components/insights/AgentPerformancePage.tsx`

Single-file component with co-located sub-components: HealthBanner, MetricSparklineRow, AgentTable, QualityTrendSection.

- [ ] **Step 1: Create the page file with imports and types**

```typescript
// apps/studio/src/components/insights/AgentPerformancePage.tsx
'use client';

import { useState, useMemo } from 'react';
import { Search, ArrowUpDown, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { PageHeader } from '../ui/PageHeader';
import { Skeleton } from '../ui/Skeleton';
import { DropdownMenu, DropdownMenuItem } from '../ui/DropdownMenu';
import { InsightKPICard } from './shared/InsightKPICard';
import { TimeSeriesChart } from './shared/TimeSeriesChart';
import {
  useAgentPerformance,
  type AgentRow,
  type AgentStatus,
  type KPISummary,
} from '../../hooks/useAgentPerformance';

type DateRange = '7d' | '30d' | '90d';
type SortKey =
  | 'status'
  | 'conversations'
  | 'quality'
  | 'hallucinationRate'
  | 'knowledgeGaps'
  | 'safetyScore'
  | 'contextScore';
type StatusFilter = 'all' | 'critical' | 'warning';

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

const STATUS_PRIORITY: Record<AgentStatus, number> = {
  critical: 0,
  warning: 1,
  healthy: 2,
};

const STATUS_COLORS: Record<AgentStatus, { bg: string; text: string; border: string }> = {
  critical: { bg: 'bg-error/10', text: 'text-error', border: 'border-l-error' },
  warning: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-l-warning' },
  healthy: { bg: '', text: 'text-success', border: 'border-l-transparent' },
};

const BANNER_GRADIENTS: Record<AgentStatus, string> = {
  healthy: 'from-emerald-950/50 to-emerald-900/30',
  warning: 'from-amber-950/50 to-amber-900/30',
  critical: 'from-red-950/50 to-red-900/30',
};
```

- [ ] **Step 2: Add the HealthBanner sub-component**

Append to the same file:

```typescript
// ── HealthBanner ───────────────────────────────────────────────────────────

function HealthBanner({
  healthy,
  warning,
  critical,
  totalAgents,
  totalConversations,
  conversationsDelta,
}: {
  healthy: number;
  warning: number;
  critical: number;
  totalAgents: number;
  totalConversations: number;
  conversationsDelta: number | null;
}) {
  const overallStatus: AgentStatus = critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'healthy';
  const gradient = BANNER_GRADIENTS[overallStatus];

  return (
    <div className={clsx('rounded-xl p-4 bg-gradient-to-br border border-default', gradient)}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Agent Health</h3>
          <p className="text-xs text-muted mt-0.5">
            {totalAgents} agent{totalAgents !== 1 ? 's' : ''} &middot;{' '}
            {totalConversations.toLocaleString()} conversations
            {conversationsDelta !== null && conversationsDelta !== 0 && (
              <span className={conversationsDelta > 0 ? 'text-success' : 'text-error'}>
                {' '}({conversationsDelta > 0 ? '+' : ''}{conversationsDelta.toLocaleString()} vs prev)
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-4 text-xs font-medium">
          {critical > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-error" />
              <span className="text-error">{critical} Critical</span>
            </span>
          )}
          {warning > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-warning" />
              <span className="text-warning">{warning} Warning</span>
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span className="text-success">{healthy} Healthy</span>
          </span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the AgentTable sub-component**

Append to the same file:

```typescript
// ── AgentTable ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

function StatusBadge({ status }: { status: AgentStatus }) {
  const labels: Record<AgentStatus, string> = { critical: 'Critical', warning: 'Warning', healthy: 'Healthy' };
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium',
        STATUS_COLORS[status].bg,
        STATUS_COLORS[status].text,
      )}
    >
      {labels[status]}
    </span>
  );
}

function metricCellColor(value: number | null, thresholdStatus: AgentStatus): string {
  if (value === null) return 'text-muted';
  return STATUS_COLORS[thresholdStatus].text;
}

function AgentTable({
  agents,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  healthSummary,
}: {
  agents: AgentRow[];
  search: string;
  onSearchChange: (v: string) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (v: StatusFilter) => void;
  healthSummary: { healthy: number; warning: number; critical: number; totalAgents: number };
}) {
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showAll, setShowAll] = useState(false);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'status' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    let rows = agents;
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((a) => a.agentName.toLowerCase().includes(q));
    }
    if (statusFilter !== 'all') {
      rows = rows.filter((a) => a.status === statusFilter);
    }
    return rows;
  }, [agents, search, statusFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortKey === 'status') {
        const diff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
        return sortDir === 'asc' ? diff : -diff;
      }
      const aVal = a[sortKey] ?? -Infinity;
      const bVal = b[sortKey] ?? -Infinity;
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  }, [filtered, sortKey, sortDir]);

  const visible = showAll ? sorted : sorted.slice(0, PAGE_SIZE);

  const columns: { key: SortKey; label: string }[] = [
    { key: 'status', label: 'Status' },
    { key: 'conversations', label: 'Convos' },
    { key: 'quality', label: 'Quality' },
    { key: 'hallucinationRate', label: 'Halluc.' },
    { key: 'knowledgeGaps', label: 'K.Gaps' },
    { key: 'safetyScore', label: 'Safety' },
    { key: 'contextScore', label: 'Context' },
  ];

  return (
    <div className="bg-background-elevated rounded-xl border border-default">
      {/* Toolbar */}
      <div className="flex items-center gap-3 p-3 border-b border-default flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
          <input
            type="text"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-background border border-default rounded-md text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex gap-1.5">
          {healthSummary.critical > 0 && (
            <button
              onClick={() => onStatusFilterChange(statusFilter === 'critical' ? 'all' : 'critical')}
              className={clsx(
                'px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors',
                statusFilter === 'critical' ? 'bg-error/20 text-error' : 'bg-background text-muted hover:text-foreground',
              )}
            >
              Critical ({healthSummary.critical})
            </button>
          )}
          {healthSummary.warning > 0 && (
            <button
              onClick={() => onStatusFilterChange(statusFilter === 'warning' ? 'all' : 'warning')}
              className={clsx(
                'px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors',
                statusFilter === 'warning' ? 'bg-warning/20 text-warning' : 'bg-background text-muted hover:text-foreground',
              )}
            >
              Warning ({healthSummary.warning})
            </button>
          )}
          <button
            onClick={() => onStatusFilterChange('all')}
            className={clsx(
              'px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors',
              statusFilter === 'all' ? 'bg-primary/20 text-primary' : 'bg-background text-muted hover:text-foreground',
            )}
          >
            All ({healthSummary.totalAgents})
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-[10px] text-muted uppercase tracking-wider">
              <th className="px-4 py-2.5 text-left font-medium">Agent</th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2.5 text-center font-medium cursor-pointer hover:text-foreground transition-colors select-none"
                  onClick={() => handleSort(col.key)}
                >
                  <span className="inline-flex items-center gap-0.5">
                    {col.label}
                    {sortKey === col.key && (
                      <ArrowUpDown className="w-2.5 h-2.5" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((agent) => (
              <tr
                key={agent.agentName}
                className={clsx(
                  'border-t border-default text-xs transition-colors',
                  agent.status === 'critical' && 'bg-error/5',
                  agent.status === 'warning' && 'bg-warning/5',
                )}
              >
                <td className={clsx('px-4 py-2.5 font-medium text-foreground border-l-2', STATUS_COLORS[agent.status].border)}>
                  {agent.agentName}
                </td>
                <td className="px-3 py-2.5 text-center"><StatusBadge status={agent.status} /></td>
                <td className="px-3 py-2.5 text-center text-muted">{agent.conversations.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-center font-medium">
                  <span className={agent.quality !== null ? STATUS_COLORS[classifyMetricForCell(agent.quality, 'quality')].text : 'text-muted'}>
                    {agent.quality !== null ? agent.quality.toFixed(1) : '—'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-center font-medium">
                  <span className={agent.hallucinationRate !== null ? STATUS_COLORS[classifyMetricForCell(agent.hallucinationRate, 'hallucination')].text : 'text-muted'}>
                    {agent.hallucinationRate !== null ? `${agent.hallucinationRate.toFixed(1)}%` : '—'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-center font-medium">
                  <span className={agent.knowledgeGaps !== null ? STATUS_COLORS[classifyMetricForCell(agent.knowledgeGaps, 'gaps')].text : 'text-muted'}>
                    {agent.knowledgeGaps !== null ? agent.knowledgeGaps : '—'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-center font-medium">
                  <span className={agent.safetyScore !== null ? STATUS_COLORS[classifyMetricForCell(agent.safetyScore, 'safety')].text : 'text-muted'}>
                    {agent.safetyScore !== null ? `${agent.safetyScore.toFixed(0)}%` : '—'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-center font-medium">
                  <span className={agent.contextScore !== null ? STATUS_COLORS[classifyMetricForCell(agent.contextScore, 'context')].text : 'text-muted'}>
                    {agent.contextScore !== null ? agent.contextScore.toFixed(1) : '—'}
                  </span>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted">
                  No agents found{search ? ' matching your search' : ' in the selected period'}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {sorted.length > PAGE_SIZE && !showAll && (
        <div className="px-4 py-2.5 border-t border-default text-center">
          <button
            onClick={() => setShowAll(true)}
            className="text-xs text-primary hover:text-primary/80 font-medium"
          >
            Show all {sorted.length} agents
          </button>
        </div>
      )}
    </div>
  );
}

/** Simple cell-level classification using hardcoded thresholds for coloring. */
function classifyMetricForCell(value: number, metric: string): AgentStatus {
  switch (metric) {
    case 'quality':
      return value >= 3.5 ? 'healthy' : value >= 2.5 ? 'warning' : 'critical';
    case 'hallucination':
      return value <= 5 ? 'healthy' : value <= 10 ? 'warning' : 'critical';
    case 'gaps':
      return value <= 3 ? 'healthy' : value <= 7 ? 'warning' : 'critical';
    case 'safety':
      return value >= 90 ? 'healthy' : value >= 75 ? 'warning' : 'critical';
    case 'context':
      return value >= 3.5 ? 'healthy' : value >= 2.5 ? 'warning' : 'critical';
    default:
      return 'healthy';
  }
}
```

- [ ] **Step 4: Add the main page component**

Append to the same file:

```typescript
// ── Main page ──────────────────────────────────────────────────────────────

export function AgentPerformancePage() {
  const [dateRange, setDateRange] = useState<DateRange>('7d');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const { kpis, agents, healthSummary, dailyTrend, isLoading } = useAgentPerformance(
    dateRange,
    compareEnabled,
  );

  const trendMetrics = [
    { key: 'avgQuality', label: 'Avg Quality', color: '#4ade80' },
    { key: 'flaggedCount', label: 'Flagged', color: '#f87171', type: 'area' as const },
  ];

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <div className="grid grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  // Empty state: no data at all
  if (healthSummary.totalAgents === 0 && healthSummary.totalConversations === 0) {
    return (
      <div className="p-6">
        <PageHeader title="Agent Performance" />
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-lg font-medium text-foreground mb-2">No agent performance data yet</p>
          <p className="text-sm text-muted max-w-md">
            Enable analytics pipelines in Settings to start tracking agent quality, hallucination
            rates, knowledge gaps, and more.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <PageHeader title="Agent Performance" />
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCompareEnabled(!compareEnabled)}
            className={clsx(
              'px-3 py-1.5 text-xs rounded-md border transition-colors',
              compareEnabled
                ? 'bg-primary/10 border-primary text-primary'
                : 'border-default text-muted hover:text-foreground',
            )}
          >
            ⇄ Compare
          </button>
          <DropdownMenu
            trigger={
              <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-default text-muted hover:text-foreground transition-colors">
                {DATE_RANGE_LABELS[dateRange]}
                <ChevronDown className="w-3 h-3" />
              </button>
            }
          >
            {(['7d', '30d', '90d'] as DateRange[]).map((range) => (
              <DropdownMenuItem key={range} onClick={() => setDateRange(range)}>
                {DATE_RANGE_LABELS[range]}
              </DropdownMenuItem>
            ))}
          </DropdownMenu>
        </div>
      </div>

      {/* Health Banner */}
      <HealthBanner
        healthy={healthSummary.healthy}
        warning={healthSummary.warning}
        critical={healthSummary.critical}
        totalAgents={healthSummary.totalAgents}
        totalConversations={healthSummary.totalConversations}
        conversationsDelta={compareEnabled ? healthSummary.conversationsDelta : null}
      />

      {/* KPI Sparklines */}
      <div className="grid grid-cols-5 gap-3">
        <InsightKPICard
          title="Quality"
          value={kpis.quality.value.toFixed(1)}
          subtitle="avg score (0-5)"
          trend={kpis.quality.delta !== null ? { value: kpis.quality.delta * 20, period: 'vs prev', favorable: 'up' } : undefined}
          sparkline={kpis.quality.sparkline}
          status={kpis.quality.status}
        />
        <InsightKPICard
          title="Hallucination Rate"
          value={`${kpis.hallucination.value.toFixed(1)}%`}
          subtitle="flagged rate"
          trend={kpis.hallucination.delta !== null ? { value: kpis.hallucination.delta, period: 'vs prev', favorable: 'down' } : undefined}
          status={kpis.hallucination.status}
        />
        <InsightKPICard
          title="Knowledge Gaps"
          value={Math.round(kpis.knowledgeGaps.value)}
          subtitle="gaps detected"
          trend={kpis.knowledgeGaps.delta !== null ? { value: kpis.knowledgeGaps.delta, period: 'vs prev', favorable: 'down' } : undefined}
          status={kpis.knowledgeGaps.status}
        />
        <InsightKPICard
          title="Safety Score"
          value={`${kpis.safety.value.toFixed(0)}%`}
          subtitle="guardrail pass rate"
          trend={kpis.safety.delta !== null ? { value: kpis.safety.delta, period: 'vs prev', favorable: 'up' } : undefined}
          status={kpis.safety.status}
        />
        <InsightKPICard
          title="Context Score"
          value={kpis.context.value.toFixed(1)}
          subtitle="avg score (0-5)"
          trend={kpis.context.delta !== null ? { value: kpis.context.delta * 20, period: 'vs prev', favorable: 'up' } : undefined}
          status={kpis.context.status}
        />
      </div>

      {/* Agent Table */}
      <AgentTable
        agents={agents}
        search={search}
        onSearchChange={setSearch}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        healthSummary={healthSummary}
      />

      {/* Quality Trend Chart */}
      {dailyTrend.length > 0 && (
        <div className="bg-background-elevated rounded-xl border border-default p-4">
          <h3 className="text-sm font-semibold text-foreground mb-3">Quality Trend</h3>
          <TimeSeriesChart data={dailyTrend} metrics={trendMetrics} dateKey="day" height={250} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run TypeScript check**

Run: `pnpm build --filter=studio 2>&1 | head -40`
Expected: Build succeeds (page is not wired into AppShell yet)

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/components/insights/AgentPerformancePage.tsx
git add apps/studio/src/components/insights/AgentPerformancePage.tsx
git commit -m "[ABLP-XXX] feat(studio): add AgentPerformancePage component

Health-first dashboard with HealthBanner, KPI sparklines (5 metrics),
sortable/filterable agent table with status badges, and quality trend chart.
Uses threshold-based health classification (healthy/warning/critical)."
```

---

## Task 3: Wire into AppShell

**Files:**

- Modify: `apps/studio/src/components/navigation/AppShell.tsx:569-575`

- [ ] **Step 1: Add the lazy import**

At the top of `AppShell.tsx`, near the other dynamic imports (search for `const.*= dynamic`), add:

```typescript
const AgentPerformancePage = dynamic(
  () =>
    import('../insights/AgentPerformancePage').then((m) => ({
      default: m.AgentPerformancePage,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
    ),
  },
);
```

Verify that `dynamic` from `next/dynamic` and `Skeleton` are already imported in this file (they should be — used by other lazy pages).

- [ ] **Step 2: Replace the ComingSoonPage case**

Change lines 569-575 from:

```typescript
      case 'agent-performance':
        return (
          <ComingSoonPage
            titleKey="agent_performance_title"
            descriptionKey="agent_performance_description"
          />
        );
```

To:

```typescript
      case 'agent-performance':
        return <AgentPerformancePage />;
```

- [ ] **Step 3: Run TypeScript check**

Run: `pnpm build --filter=studio 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write apps/studio/src/components/navigation/AppShell.tsx
git add apps/studio/src/components/navigation/AppShell.tsx
git commit -m "[ABLP-XXX] feat(studio): wire AgentPerformancePage into AppShell

Replace ComingSoonPage placeholder with lazy-loaded AgentPerformancePage
for the agent-performance nav item."
```

---

## Task 4: Visual Verification

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev --filter=studio`
Navigate to: `http://localhost:5173` → select a project → Insights → Agent Performance

- [ ] **Step 2: Verify empty state**

With a project that has no pipeline data:

- Page should show "No agent performance data yet" empty state
- No console errors

- [ ] **Step 3: Verify with data**

With a project that has pipeline data (or after seeding test data):

- Health Banner shows agent count by status
- 5 KPI cards show values with sparklines (quality card should have sparkline from timeseries)
- Agent table shows rows sorted worst-first
- Status filter chips work (click Critical to filter)
- Search filters by agent name
- Column sorting works (click any header)
- Quality Trend chart renders below the table

- [ ] **Step 4: Verify responsive behavior**

- At narrow widths, KPI grid should wrap
- Table should scroll horizontally if needed
- Health banner content wraps gracefully

- [ ] **Step 5: Verify date range + compare toggle**

- Switch between 7d/30d/90d — data refreshes
- Toggle Compare on — trend arrows appear in KPI cards
- Toggle Compare off — trend arrows disappear

---

## Notes for Implementer

1. **BEFORE using any existing component/function/type, READ its source file to verify the actual signature.** Never guess prop names or parameter types. Key files to read first:
   - `apps/studio/src/components/insights/shared/InsightKPICard.tsx` — verify `InsightKPICardProps`
   - `apps/studio/src/components/insights/shared/TimeSeriesChart.tsx` — verify `TimeSeriesChartProps`
   - `apps/studio/src/components/ui/PageHeader.tsx` — verify props
   - `apps/studio/src/components/ui/DropdownMenu.tsx` — verify export names
   - `apps/studio/src/components/ui/Skeleton.tsx` — verify export

2. **Run `npx prettier --write <files>` on ALL changed files before committing.** lint-staged WILL silently revert your work if files aren't formatted.

3. **Run `pnpm build --filter=studio` after every file change** to catch type errors immediately.

4. **NEVER mock platform components** in tests. If code isn't testable without mocks, refactor the code.

5. **The pipeline-config endpoint is proxied through `apps/studio/src/proxy.ts`**, not through a dedicated Next.js API route. The URL pattern `/api/projects/:projectId/pipeline-config/:pipelineType` is matched by the generic proxy regex. SWR's global fetcher (which uses `apiFetch`) handles auth headers automatically.

6. **ClickHouse response shape gotcha**: The `extractObject()` and `extractArray()` helpers handle the known issue where runtime endpoints sometimes leak the raw ClickHouse `.json()` format (`{ meta, data: [...] }`) instead of a clean object. Always use these helpers, never access `.data` directly.

7. **The JIRA ticket key `ABLP-XXX` in commit messages is a placeholder.** Replace with the actual ticket key provided by the user before committing.
