/**
 * useWorkflows Hook
 *
 * Fetches and manages the workflow list for a project.
 * Uses SWR for dedup, stale-while-revalidate, and background refresh.
 */

'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import type { WorkflowSummary } from '../api/workflows';

interface WorkflowsResponse {
  success: boolean;
  data: WorkflowSummary[];
}

interface UseWorkflowsReturn {
  workflows: WorkflowSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Normalize a raw workflow summary — derive stepCount and triggerType if missing. */
function normalizeSummary(raw: Record<string, unknown>): WorkflowSummary {
  let stepCount = raw.stepCount as number | undefined;
  if (stepCount == null && Array.isArray(raw.steps) && raw.steps.length > 0) {
    stepCount = raw.steps.length;
  }
  if (stepCount == null && Array.isArray(raw.nodes)) {
    // Canvas-based workflows: count nodes excluding start/end
    stepCount = (raw.nodes as Array<{ type?: string }>).filter(
      (n) => n.type !== 'startNode' && n.type !== 'endNode',
    ).length;
  }
  if (stepCount == null) stepCount = 0;

  // Derive triggerType from triggers array if not already present.
  // The workflow doc's embedded `triggers[]` cache stores each entry as
  // `{id, type, config, status}` (see `workflow.model.ts`), so the field
  // is `type` — not `triggerType` (which is how standalone TriggerRegistration
  // rows are shaped). Accept both names so the card renders the right badge
  // regardless of which source shape we receive.
  let triggerType = raw.triggerType as string | undefined;
  if (!triggerType && Array.isArray(raw.triggers) && raw.triggers.length > 0) {
    const first = raw.triggers[0] as Record<string, unknown>;
    triggerType =
      (first.triggerType as string | undefined) ??
      (first.type as string | undefined) ??
      (first.strategy as string | undefined) ??
      undefined;
  }

  // Map _id → id if needed
  const id = (raw.id as string) ?? (raw._id as string) ?? '';

  // Fall back to length of embedded triggers array when the backend didn't
  // send `triggerCount` — keeps the card count correct against older list
  // responses that predate the usage enrichment.
  const triggerCount =
    typeof raw.triggerCount === 'number'
      ? raw.triggerCount
      : Array.isArray(raw.triggers)
        ? raw.triggers.length
        : undefined;
  const toolCount = typeof raw.toolCount === 'number' ? raw.toolCount : undefined;

  return {
    ...(raw as unknown as WorkflowSummary),
    id,
    stepCount,
    ...(triggerType && { triggerType }),
    ...(triggerCount !== undefined && { triggerCount }),
    ...(toolCount !== undefined && { toolCount }),
  };
}

export function useWorkflows(projectId: string | null): UseWorkflowsReturn {
  const key = projectId ? `/api/projects/${encodeURIComponent(projectId)}/workflows` : null;

  const { data, error, isLoading, mutate } = useSWR<WorkflowsResponse>(key, {
    keepPreviousData: true,
  });

  const workflows = useMemo(
    () => (data?.data ?? []).map((w) => normalizeSummary(w as unknown as Record<string, unknown>)),
    [data],
  );

  return {
    workflows,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
