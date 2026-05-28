/**
 * Human Tasks API Client
 *
 * Functions for the unified human-in-the-loop task system.
 * All routes are project-scoped under /api/projects/:projectId/human-tasks.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export type HumanTaskType = 'approval' | 'data_entry' | 'review' | 'decision' | 'escalation';
export type HumanTaskMailbox = 'workflow' | 'agent';
export type HumanTaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'expired'
  | 'cancelled';
export type HumanTaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface SelectOption {
  label: string;
  value: string;
}

export interface HumanTaskFieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface HumanTaskFieldDef {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'textarea' | 'date';
  label: string;
  required: boolean;
  options?: (string | SelectOption)[];
  validation?: HumanTaskFieldValidation;
  defaultValue?: unknown;
}

export interface HumanTaskSource {
  type: 'workflow_approval' | 'workflow_human_task' | 'agent_escalation';
  workflowId?: string;
  executionId?: string;
  stepId?: string;
  sessionId?: string;
  agentName?: string;
}

export interface HumanTaskResponse {
  respondedBy: string;
  respondedAt: string;
  fields: Record<string, unknown>;
  notes?: string;
  decision?: string;
}

export interface HumanTask {
  _id: string;
  tenantId: string;
  projectId: string;
  type: HumanTaskType;
  mailbox: HumanTaskMailbox;
  status: HumanTaskStatus;
  priority: HumanTaskPriority;
  title: string;
  description?: string;
  source: HumanTaskSource;
  /**
   * Users allowed to act on this task.
   * - `undefined` / `[]` → open pool (any project member can claim)
   * - `[u]`              → direct (only u; no claim needed)
   * - `[u1, u2, ...]`    → scoped pool (first claim wins)
   */
  assignedTo?: string[];
  assignedToTeam?: string;
  claimedBy?: string;
  claimedAt?: string;
  fields: HumanTaskFieldDef[];
  context: Record<string, unknown>;
  response?: HumanTaskResponse;
  dueAt?: string;
  /**
   * What happens if the task expires without a response.
   * 'terminate' fails the workflow; 'skip' continues on the normal path.
   */
  onTimeout?: 'terminate' | 'skip';
  slaBreachedAt?: string;
  escalationChain: string[];
  currentEscalationLevel: number;
  connectorTicketId?: string;
  connectorTicketUrl?: string;
  connectorActionName?: string;
  createdAt: string;
  updatedAt: string;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  total?: number;
  countsByType?: Record<string, number>;
  countsByMailbox?: Record<string, number>;
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

export interface ListHumanTasksParams {
  status?: HumanTaskStatus | HumanTaskStatus[];
  type?: HumanTaskType;
  mailbox?: HumanTaskMailbox;
  assignedTo?: string;
  priority?: HumanTaskPriority;
  limit?: number;
  offset?: number;
}

export async function listHumanTasks(
  projectId: string,
  params?: ListHumanTasksParams,
): Promise<Envelope<HumanTask[]>> {
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
  const url = `/api/projects/${encodeURIComponent(projectId)}/human-tasks${qs ? `?${qs}` : ''}`;
  const response = await apiFetch(url);
  return handleResponse<Envelope<HumanTask[]>>(response);
}

export async function getHumanTask(
  projectId: string,
  taskId: string,
): Promise<{ success: boolean; data: HumanTask }> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/human-tasks/${encodeURIComponent(taskId)}`;
  const response = await apiFetch(url);
  return handleResponse<{ success: boolean; data: HumanTask }>(response);
}

export async function assignTask(
  projectId: string,
  taskId: string,
  data: { assignedTo?: string | string[]; assignedToTeam?: string },
): Promise<{ success: boolean; data: HumanTask }> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/human-tasks/${encodeURIComponent(taskId)}/assign`;
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<{ success: boolean; data: HumanTask }>(response);
}

export async function claimTask(
  projectId: string,
  taskId: string,
): Promise<{ success: boolean; data: HumanTask }> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/human-tasks/${encodeURIComponent(taskId)}/claim`;
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return handleResponse<{ success: boolean; data: HumanTask }>(response);
}

export async function resolveTask(
  projectId: string,
  taskId: string,
  data: {
    fields?: Record<string, unknown>;
    notes?: string;
    decision?: string;
  },
): Promise<{ success: boolean }> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/human-tasks/${encodeURIComponent(taskId)}/resolve`;
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<{ success: boolean }>(response);
}
