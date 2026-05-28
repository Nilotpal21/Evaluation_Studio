/**
 * useWorkflowDetail Hook
 *
 * Fetches workflow detail and execution history.
 * Normalizes the DB-shaped step/trigger data into the UI-expected format.
 * Executions use a 5-second polling interval for live status updates.
 */

'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import type {
  WorkflowDetail,
  WorkflowStep,
  WorkflowTrigger,
  WorkflowExecution,
} from '../api/workflows';

// ── Step normalization ──────────────────────────────────────────────────────

/** Fields that live at the top level of WorkflowStep (not inside config). */
const STEP_TOP_LEVEL_KEYS = new Set(['id', 'name', 'type', 'config', 'position']);

/**
 * Normalize a raw DB step (flat fields) into the UI shape { id, name, type, config, position }.
 * If the step already has a `config` object, it's returned as-is.
 */
export function normalizeStep(raw: Record<string, unknown>, index: number): WorkflowStep {
  // Already in UI shape — has a config object
  if (raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)) {
    const orig = raw.config as Record<string, unknown>;
    // Shallow copy to avoid mutating the original object
    const config = { ...orig };
    // Ensure params is a JSON string for the StepEditor textarea
    if (config.params && typeof config.params === 'object') {
      config.params = JSON.stringify(config.params, null, 2);
    }
    return {
      id: (raw.id as string) ?? `step-${index}`,
      name: (raw.name as string) ?? '',
      type: (raw.type as string) ?? 'connector_action',
      config,
      position: (raw.position as number) ?? index,
    };
  }

  // DB shape — extract everything except top-level keys into config
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!STEP_TOP_LEVEL_KEYS.has(key) && value !== undefined && value !== null) {
      // Stringify object params for the StepEditor textarea
      if (key === 'params' && typeof value === 'object') {
        config[key] = JSON.stringify(value, null, 2);
      } else {
        config[key] = value;
      }
    }
  }

  return {
    id: (raw.id as string) ?? `step-${index}`,
    name: (raw.name as string) ?? '',
    type: (raw.type as string) ?? 'connector_action',
    config,
    position: (raw.position as number) ?? index,
  };
}

/** Normalize a raw DB trigger into the UI shape { id, triggerType, config, status }. */
function normalizeTrigger(raw: Record<string, unknown>, index: number): WorkflowTrigger {
  // Already in UI shape
  if (raw.id && raw.triggerType && raw.config) {
    return raw as unknown as WorkflowTrigger;
  }

  // DB shape may use 'strategy' or 'type' instead of 'triggerType'
  const { strategy, config: rawConfig, status, ...rest } = raw;
  return {
    id: (raw.id as string) ?? `trigger-${index}`,
    triggerType:
      ((raw.triggerType ?? strategy ?? raw.type) as WorkflowTrigger['triggerType']) ?? 'webhook',
    config: {
      ...(typeof rawConfig === 'object' && rawConfig !== null
        ? (rawConfig as Record<string, unknown>)
        : {}),
      ...rest,
    },
    status: ((status as string) ?? 'active') as WorkflowTrigger['status'],
  };
}

/** Normalize a full workflow response from the API. */
function normalizeWorkflow(raw: WorkflowDetail): WorkflowDetail {
  const anyRaw = raw as unknown as Record<string, unknown>;
  return {
    ...raw,
    // Map _id → id if needed (MongoDB returns _id)
    id: raw.id ?? (anyRaw._id as string) ?? '',
    stepCount: raw.stepCount ?? (Array.isArray(raw.steps) ? raw.steps.length : 0),
    steps: Array.isArray(raw.steps)
      ? raw.steps.map((s, i) => normalizeStep(s as unknown as Record<string, unknown>, i))
      : [],
    triggers: Array.isArray(raw.triggers)
      ? raw.triggers.map((t, i) => normalizeTrigger(t as unknown as Record<string, unknown>, i))
      : [],
  };
}

// ── Denormalization (UI shape → DB shape) ───────────────────────────────────

/**
 * Convert a UI-shaped step { id, name, type, config, position } back to the
 * flat DB shape expected by the Mongoose WorkflowStepSchema.
 * The DB schema stores config fields (connector, action, url, etc.) as
 * top-level step fields, not inside a nested `config` object.
 */
export function denormalizeStep(step: WorkflowStep): Record<string, unknown> {
  const { config, ...rest } = step;
  return { ...rest, ...(config || {}) };
}

// ── Workflow Detail ─────────────────────────────────────────────────────────

interface WorkflowDetailResponse {
  success: boolean;
  data: WorkflowDetail;
}

interface UseWorkflowDetailReturn {
  workflow: WorkflowDetail | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  mutate: ReturnType<typeof useSWR<WorkflowDetailResponse>>['mutate'];
}

export function useWorkflowDetail(
  projectId: string | null,
  workflowId: string | null,
): UseWorkflowDetailReturn {
  const key =
    projectId && workflowId
      ? `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<WorkflowDetailResponse>(key);

  const workflow = useMemo(() => (data?.data ? normalizeWorkflow(data.data) : null), [data]);

  return {
    workflow,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
    mutate,
  };
}

// ── Workflow Executions (with polling) ──────────────────────────────────────

const EXECUTION_POLL_INTERVAL_MS = 5000;

interface ExecutionsResponse {
  success: boolean;
  data: WorkflowExecution[];
}

interface UseWorkflowExecutionsReturn {
  executions: WorkflowExecution[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useWorkflowExecutions(
  projectId: string | null,
  workflowId: string | null,
): UseWorkflowExecutionsReturn {
  const key =
    projectId && workflowId
      ? `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/executions`
      : null;

  const { data, error, isLoading, mutate } = useSWR<ExecutionsResponse>(key, {
    refreshInterval: EXECUTION_POLL_INTERVAL_MS,
    keepPreviousData: true,
  });

  const executions = useMemo(() => {
    const raw = data?.data ?? [];
    return raw.map((e) => {
      const any = e as unknown as Record<string, unknown>;
      return {
        ...e,
        id: e.id ?? (any._id as string) ?? '',
      };
    });
  }, [data]);

  return {
    executions,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
