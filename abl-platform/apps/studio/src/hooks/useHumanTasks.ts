/**
 * useHumanTasks Hook
 *
 * SWR hook for fetching human tasks with 5s polling for live updates.
 * Provides task list, counts by type, and filter state.
 */

'use client';

import useSWR from 'swr';
import type {
  HumanTask,
  HumanTaskType,
  HumanTaskMailbox,
  HumanTaskStatus,
  HumanTaskPriority,
  ListHumanTasksParams,
} from '../api/human-tasks';

const POLL_INTERVAL_MS = 5000;

interface HumanTasksResponse {
  success: boolean;
  data: HumanTask[];
  total: number;
  countsByType?: Record<string, number>;
  countsByMailbox?: Record<string, number>;
}

export interface UseHumanTasksParams {
  /**
   * Status filter. Accepts a single value, an array of values, or
   * `undefined` to omit the filter (show all statuses). When an array
   * is provided the caller joins with commas to match the server's
   * multi-value contract — feature-spec FR-9 / LLD §5.6.
   */
  status?: HumanTaskStatus | HumanTaskStatus[];
  type?: HumanTaskType;
  mailbox?: HumanTaskMailbox;
  assignedTo?: string;
  priority?: HumanTaskPriority;
  limit?: number;
  offset?: number;
}

export interface UseHumanTasksReturn {
  tasks: HumanTask[];
  total: number;
  countsByType: Record<string, number>;
  countsByMailbox: Record<string, number>;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useHumanTasks(
  projectId: string | null,
  params?: UseHumanTasksParams,
): UseHumanTasksReturn {
  const search = new URLSearchParams();
  if (params?.status) {
    search.set('status', Array.isArray(params.status) ? params.status.join(',') : params.status);
  }
  if (params?.type) search.set('type', params.type);
  if (params?.mailbox) search.set('mailbox', params.mailbox);
  if (params?.assignedTo) search.set('assignedTo', params.assignedTo);
  if (params?.priority) search.set('priority', params.priority);
  if (params?.limit) search.set('limit', String(params.limit));
  if (params?.offset) search.set('offset', String(params.offset));

  const qs = search.toString();
  const key = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/human-tasks${qs ? `?${qs}` : ''}`
    : null;

  const { data, error, isLoading, mutate } = useSWR<HumanTasksResponse>(key, {
    refreshInterval: POLL_INTERVAL_MS,
  });

  return {
    tasks: data?.data ?? [],
    total: data?.total ?? 0,
    countsByType: data?.countsByType ?? {},
    countsByMailbox: data?.countsByMailbox ?? {},
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}

// ── Single task hook ────────────────────────────────────────────────

interface HumanTaskDetailResponse {
  success: boolean;
  data: HumanTask;
}

export interface UseHumanTaskReturn {
  task: HumanTask | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useHumanTask(projectId: string | null, taskId: string | null): UseHumanTaskReturn {
  const key =
    projectId && taskId
      ? `/api/projects/${encodeURIComponent(projectId)}/human-tasks/${encodeURIComponent(taskId)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<HumanTaskDetailResponse>(key);

  return {
    task: data?.data ?? null,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
