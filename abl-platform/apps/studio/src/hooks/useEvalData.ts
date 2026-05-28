/**
 * Eval SWR Hooks
 *
 * Data fetching hooks for all eval entities. Follow the existing useSWR
 * pattern: key-based caching, memoized return values, refresh via mutate().
 */

import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { useCallback, useMemo } from 'react';
import { apiFetch } from '@/lib/api-client';
import { EVAL_LIST_DEFAULT_PAGE_SIZE } from '@agent-platform/database/constants/eval-limits';

// ── Fetcher ──────────────────────────────────────────────────────────

async function evalFetcher<T>(url: string): Promise<T> {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`Eval fetch failed: ${res.status}`);
  return res.json();
}

// ── Shared Types ─────────────────────────────────────────────────────

interface EvalPersona {
  id: string;
  name: string;
  description?: string;
  communicationStyle: string;
  domainKnowledge: string;
  behaviorTraits?: string[];
  goals?: string;
  constraints?: string;
  sessionVariables?: Record<string, unknown>;
  isAdversarial: boolean;
  adversarialType?: string;
  isBuiltIn: boolean;
  source: string;
  version: number;
  createdAt: string;
}

interface EvalScenario {
  id: string;
  name: string;
  description?: string;
  category: string;
  difficulty: string;
  entryAgent?: string;
  initialMessage?: string;
  expectedOutcome?: string;
  maxTurns: number;
  tags?: string[];
  expectedMilestones?: string[];
  agentPath?: string[];
  version: number;
  createdAt: string;
}

interface EvalEvaluator {
  id: string;
  name: string;
  description?: string;
  type: 'llm_judge' | 'code_scorer' | 'trajectory' | 'human_review';
  category: string;
  isBuiltIn: boolean;
  judgeModel?: string;
  judgePrompt?: string;
  temperature?: number;
  scoringRubric?: {
    scaleType: string;
    points: Array<{ value: number; label: string; criteria: string }>;
  };
  biasSettings?: {
    positionSwapEnabled: boolean;
    blindEvaluation: boolean;
    crossModelJudge: boolean;
    evidenceFirstMode: boolean;
  };
  version: number;
  createdAt: string;
}

interface EvalSet {
  id: string;
  name: string;
  description?: string;
  personaIds: string[];
  scenarioIds: string[];
  evaluatorIds: string[];
  variants: number;
  ciEnabled: boolean;
  _personaNames?: Record<string, string>;
  _scenarioNames?: Record<string, string>;
  _evaluatorNames?: Record<string, string>;
  createdAt: string;
}

interface EvalRun {
  id: string;
  name?: string;
  evalSetId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggerSource: string;
  triggeredBy?: string;
  summary?: {
    totalConversations: number;
    totalEvaluations: number;
    avgScore: number;
    durationMs: number;
    estimatedCost: number;
  };
  regressionDetected?: boolean;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

interface HeatMapCell {
  personaId: string;
  scenarioId: string;
  evaluatorId: string;
  avgScore: number;
  count: number;
  passRate: number;
  variance: number;
  minScore: number;
  maxScore: number;
}

interface ComparisonData {
  runs: Array<{ runId: string; name?: string; status: string; createdAt: string }>;
  evaluators: Array<{
    evaluatorId: string;
    scores: Array<{ runId: string; avgScore: number; count: number; passRate: number }>;
  }>;
}

interface EvalListPagination {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

type EvalListPage<T, K extends string> = {
  success: boolean;
  pagination?: EvalListPagination;
} & Record<K, T[]>;

function usePaginatedEvalList<T, K extends string>(
  projectId: string | null,
  path: string,
  itemKey: K,
) {
  const getKey = useCallback(
    (pageIndex: number, previousPageData: EvalListPage<T, K> | null) => {
      if (!projectId) return null;
      if (previousPageData && !previousPageData.pagination?.hasMore) return null;

      const params = new URLSearchParams({ limit: String(EVAL_LIST_DEFAULT_PAGE_SIZE) });
      if (pageIndex > 0) {
        const cursor = previousPageData?.pagination?.nextCursor;
        if (!cursor) return null;
        params.set('cursor', cursor);
      }

      return `/api/projects/${projectId}/evals/${path}?${params.toString()}`;
    },
    [itemKey, path, projectId],
  );

  const { data, error, isLoading, isValidating, mutate, setSize, size } = useSWRInfinite<
    EvalListPage<T, K>
  >(getKey, evalFetcher);

  const items = useMemo(() => data?.flatMap((page) => page[itemKey] ?? []) ?? [], [data, itemKey]);
  const lastPage = data?.[data.length - 1];
  const hasMore = lastPage?.pagination?.hasMore ?? false;
  const total = data?.[0]?.pagination?.total ?? items.length;
  const isLoadingMore =
    isLoading || (size > 0 && data !== undefined && typeof data[size - 1] === 'undefined');

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return Promise.resolve(data);
    return setSize((currentSize) => currentSize + 1);
  }, [data, hasMore, isLoadingMore, setSize]);

  const refresh = useCallback(async () => {
    await setSize(1);
    return mutate();
  }, [mutate, setSize]);

  return {
    items,
    isLoading,
    isLoadingMore,
    isValidating,
    hasMore,
    total,
    error: error ? String(error) : null,
    refresh,
    mutate,
    loadMore,
  };
}

// ── Export types ──────────────────────────────────────────────────────

export type {
  EvalPersona,
  EvalScenario,
  EvalEvaluator,
  EvalSet,
  EvalRun,
  HeatMapCell,
  ComparisonData,
};

// ── Hooks ────────────────────────────────────────────────────────────

export function useEvalPersonas(projectId: string | null) {
  const result = usePaginatedEvalList<EvalPersona, 'personas'>(projectId, 'personas', 'personas');
  return { ...result, personas: result.items };
}

export function useEvalScenarios(projectId: string | null) {
  const result = usePaginatedEvalList<EvalScenario, 'scenarios'>(
    projectId,
    'scenarios',
    'scenarios',
  );
  return { ...result, scenarios: result.items };
}

export function useEvalEvaluators(projectId: string | null) {
  const result = usePaginatedEvalList<EvalEvaluator, 'evaluators'>(
    projectId,
    'evaluators',
    'evaluators',
  );
  return {
    ...result,
    evaluators: result.items,
    refresh: result.refresh,
    // Optimistically patch a single evaluator in the cache so the updated
    // judgeModel / other fields are visible immediately after save without
    // waiting for the re-fetch round-trip.
    updateOne: (updated: EvalEvaluator) => {
      result.mutate(
        (pages) =>
          pages?.map((page) => ({
            ...page,
            evaluators: page.evaluators.map((e) => (e.id === updated.id ? updated : e)),
          })),
        { revalidate: false },
      );
    },
  };
}

export function useEvalSets(projectId: string | null) {
  const result = usePaginatedEvalList<EvalSet, 'sets'>(projectId, 'sets', 'sets');
  return { ...result, sets: result.items };
}

export function useEvalRuns(projectId: string | null) {
  const result = usePaginatedEvalList<EvalRun, 'runs'>(projectId, 'runs', 'runs');
  return { ...result, runs: result.items };
}

export function useEvalHeatMap(projectId: string | null, runId: string | null) {
  const key = projectId && runId ? `/api/projects/${projectId}/evals/runs/${runId}/heatmap` : null;
  const { data, error, isLoading, mutate } = useSWR<{ success: boolean; cells: HeatMapCell[] }>(
    key,
    evalFetcher,
    { revalidateOnFocus: false },
  );
  const cells = useMemo(() => data?.cells ?? [], [data]);
  return { cells, isLoading, error: error ? String(error) : null, refresh: () => mutate() };
}

export function useEvalRunStatus(
  projectId: string | null,
  runId: string | null,
  isRunning: boolean,
) {
  const key = projectId && runId ? `/api/projects/${projectId}/evals/runs/${runId}/status` : null;
  const { data } = useSWR<{
    success: boolean;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
  }>(key, evalFetcher, {
    // Only poll while running; stop once terminal status is reached
    refreshInterval: (latestData) => {
      if (!isRunning) return 0;
      const st = latestData?.status;
      if (st === 'completed' || st === 'failed' || st === 'cancelled') return 0;
      return 2_000;
    },
  });
  return {
    status: data?.status ?? null,
    startedAt: data?.startedAt ?? null,
    completedAt: data?.completedAt ?? null,
  };
}

export function useEvalComparison(
  projectId: string | null,
  baselineId: string | null,
  currentId: string | null,
) {
  const key =
    projectId && baselineId && currentId
      ? `/api/projects/${projectId}/evals/runs/compare?runIds=${baselineId},${currentId}`
      : null;
  const { data, isLoading } = useSWR<{ success: boolean; comparison: ComparisonData }>(
    key,
    evalFetcher,
    { revalidateOnFocus: false },
  );
  return { comparison: data?.comparison ?? null, isLoading };
}
