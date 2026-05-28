/**
 * Workflows API Client
 *
 * Functions for workflow CRUD, execution, and approval API calls.
 * All routes are project-scoped under /api/projects/:projectId/workflows.
 */

import type { WorkflowStatus } from '@agent-platform/shared/types';
import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// ENVELOPE TYPE
// =============================================================================

/** Standard runtime response envelope: { success, data } */
interface Envelope<T> {
  success: boolean;
  data: T;
}

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  triggerType?: string;
  stepCount: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt?: string;
  /** Total triggers registered against this workflow (any status except deleted). */
  triggerCount?: number;
  /**
   * Count of `type: workflow` project tools that wrap this workflow. Used as
   * a Phase 1 proxy for "agents using this workflow" — agents consume
   * workflows exclusively through tool bindings, so `toolCount > 0` means
   * the workflow is reachable from at least one agent somewhere.
   */
  toolCount?: number;
}

export interface WorkflowToolUsage {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

export interface WorkflowUsage {
  triggerCount: number;
  toolCount: number;
  tools: WorkflowToolUsage[];
}

export interface WorkflowStep {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  position: number;
}

export interface WorkflowTrigger {
  id: string;
  /**
   * Present on TriggerRegistration documents (project-wide trigger list);
   * omitted when the trigger is normalized from a workflow doc's embedded
   * denormalized copy (parent workflow is implicit there).
   */
  workflowId?: string;
  triggerType: 'webhook' | 'cron' | 'event' | 'connector' | 'polling';
  config: Record<string, unknown>;
  status: 'active' | 'paused' | 'error' | 'deleted';
  webhookMode?: 'sync' | 'async';
  webhookDelivery?: 'poll' | 'push';
  callbackUrl?: string;
  /** Optional: trigger may be pinned to a specific WorkflowVersion */
  workflowVersionId?: string;
  /** Number of consecutive execution errors — non-zero means the trigger is unhealthy */
  consecutiveErrors?: number;
  /** ISO timestamp of the last time this trigger fired */
  lastFiredAt?: string;
}

export interface WorkflowTriggerPayload {
  workflowId: string;
  triggerType: WorkflowTrigger['triggerType'];
  config: Record<string, unknown>;
  webhookMode?: 'sync' | 'async';
  webhookDelivery?: 'poll' | 'push';
  callbackUrl?: string;
}

export type WorkflowNotificationEvent =
  | 'workflow.started'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'workflow.cancelled'
  | 'step.failed'
  | 'step.waiting_approval'
  | 'step.waiting_callback'
  | 'step.waiting_human_task';

export type WorkflowNotificationChannelType =
  | 'email'
  | 'slack'
  | 'msteams'
  | 'webhook'
  | 'websocket';

export interface WorkflowNotificationChannel {
  type: WorkflowNotificationChannelType;
  connectionId: string;
  target: string;
}

export interface WorkflowNotificationRule {
  id: string;
  name: string;
  events: WorkflowNotificationEvent[];
  channel: WorkflowNotificationChannel;
  enabled: boolean;
}

export interface WorkflowNotificationRulePayload {
  name: string;
  events: WorkflowNotificationEvent[];
  channel: WorkflowNotificationChannel;
  enabled?: boolean;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
}

export interface WorkflowDetail extends WorkflowSummary {
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
  notificationRules: WorkflowNotificationRule[];
  retryPolicy?: RetryPolicy;
  // Node-based canvas fields — returned by the runtime workflow store.
  // Present for workflows authored via the canvas; consumers looking for
  // start-node `inputVariables` should read from here.
  nodes?: WorkflowNodeSummary[];
  edges?: WorkflowEdgeSummary[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface ExecutionStepResult {
  stepId: string;
  stepName: string;
  nodeType: string;
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'cancelled'
    | 'rejected'
    | 'approved'
    | 'waiting_human_task'
    | 'waiting_approval'
    | 'waiting_delay'
    | 'waiting_callback';
  startedAt?: string;
  completedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    httpStatus?: number;
    responseBody?: unknown;
  };
  metrics?: {
    responseTimeMs?: number;
    processingTimeMs?: number;
  };
  consoleLogs?: Array<{ level: string; args: unknown[] }>;
  durationMs?: number;
  /**
   * Per-field (Start) or per-mapping (End) error detail for boundary steps.
   * On Start step: field-level input validation errors (`expression` absent).
   * On End step: per-output-mapping expression evaluation errors.
   */
  mappingErrors?: Array<{ name: string; expression?: string; error: string }>;
}

/**
 * Convert execution.context.steps (Record<stepName, stepData>) → ExecutionStepResult[].
 *
 * Single canonical implementation used by useExecutionPolling, ExecutionDebugPanel,
 * and WorkflowDebugPanel. Prefers stepId from the step data (UUID), falls back to
 * the step name key so old executions still render in the canvas overlay.
 * Falls back nodeType for legacy 'start'/'end' entries that pre-date the nodeType field.
 */
export function contextStepsToResults(
  contextSteps: Record<string, unknown>,
): ExecutionStepResult[] {
  return Object.entries(contextSteps).map(([stepName, rawData]) => {
    const data = (rawData ?? {}) as Record<string, unknown>;
    const lowerName = stepName.toLowerCase();
    const nodeType =
      typeof data.nodeType === 'string'
        ? data.nodeType
        : lowerName === 'start'
          ? 'start'
          : lowerName === 'end'
            ? 'end'
            : 'unknown';
    return {
      stepId: (typeof data.stepId === 'string' && data.stepId ? data.stepId : stepName) as string,
      stepName,
      nodeType,
      status: (typeof data.status === 'string'
        ? data.status
        : 'pending') as ExecutionStepResult['status'],
      startedAt: typeof data.startedAt === 'string' ? data.startedAt : undefined,
      completedAt: typeof data.completedAt === 'string' ? data.completedAt : undefined,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
      input: data.input ?? undefined,
      output: data.output ?? undefined,
      error: data.error as ExecutionStepResult['error'] | undefined,
      metrics: data.metrics as ExecutionStepResult['metrics'] | undefined,
      consoleLogs: data.consoleLogs as ExecutionStepResult['consoleLogs'] | undefined,
      mappingErrors: data.mappingErrors as ExecutionStepResult['mappingErrors'] | undefined,
    };
  });
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowVersionId?: string;
  workflowVersion?: string;
  projectId?: string;
  tenantId?: string;
  status:
    | 'running'
    | 'completed'
    | 'failed'
    | 'rejected'
    | 'waiting_approval'
    | 'waiting_human'
    | 'waiting_callback'
    | 'cancelled';
  startedAt: string;
  completedAt?: string;
  triggerType: string;
  /**
   * Server-side metadata recorded at fire time. For connector (app) triggers
   * includes `connectorName` (e.g. "gmail"), `triggerName`, `registrationId`.
   * For webhook/API triggers includes `apiKeyId`. Display-only — shape varies
   * by triggerType, so consumers should treat fields as optional.
   */
  triggerMetadata?: Record<string, unknown>;
  input?: Record<string, unknown>;
  error?: { code: string; message: string };
  context?: unknown;
  durationMs?: number;
  /** Resolved output variables from the end node */
  output?: Record<string, unknown>;
}

// =============================================================================
// WORKFLOWS CRUD
// =============================================================================

export async function listWorkflows(projectId: string): Promise<WorkflowSummary[]> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/workflows`);
  const json = await handleResponse<Envelope<WorkflowSummary[]>>(response);
  return json.data ?? [];
}

export async function getWorkflow(projectId: string, workflowId: string): Promise<WorkflowDetail> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
  );
  const json = await handleResponse<Envelope<WorkflowDetail>>(response);
  return json.data;
}

export type WorkflowType = 'cx_automation' | 'ex_automation' | 'internal';

export async function createWorkflow(
  projectId: string,
  payload: { name: string; type: WorkflowType; description?: string },
): Promise<WorkflowSummary> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await handleResponse<Envelope<WorkflowSummary>>(response);
  return json.data;
}

export async function updateWorkflow(
  projectId: string,
  workflowId: string,
  payload: Partial<WorkflowDetail>,
): Promise<WorkflowDetail> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  const json = await handleResponse<Envelope<WorkflowDetail>>(response);
  return json.data;
}

export async function deleteWorkflow(
  projectId: string,
  workflowId: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
    {
      method: 'DELETE',
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

/**
 * Fetch the usage rollup for a workflow — trigger count + list of tools
 * wrapping it. Used by the detail page to render the "Used by" section.
 */
export async function getWorkflowUsage(
  projectId: string,
  workflowId: string,
): Promise<WorkflowUsage> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/usage`,
  );
  // `handleResponse` returns the raw envelope (`{success, data}`) — unwrap
  // here so callers receive the usage payload directly, and defensively
  // default `tools` to `[]` in case the backend ever omits it.
  const envelope = await handleResponse<{ success: boolean; data: WorkflowUsage }>(response);
  const data = envelope.data ?? { triggerCount: 0, toolCount: 0, tools: [] };
  return {
    triggerCount: data.triggerCount ?? 0,
    toolCount: data.toolCount ?? 0,
    tools: Array.isArray(data.tools) ? data.tools : [],
  };
}

// =============================================================================
// TRIGGERS
// =============================================================================

export async function listWorkflowTriggers(
  projectId: string,
  workflowId?: string,
): Promise<WorkflowTrigger[]> {
  const qs = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : '';
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers${qs}`,
  );
  // TriggerRegistration lean docs surface backend-engine field names:
  //   - `_id` → normalize to `id`
  //   - `strategy` → normalize to `triggerType` (the engine persists
  //     'strategy' as the canonical column; UI consumers everywhere
  //     expect `triggerType`)
  // Keep `triggerType` if the backend already provided it.
  type RawTrigger = WorkflowTrigger & {
    _id?: string;
    strategy?: 'webhook' | 'cron' | 'event';
  };
  const json = await handleResponse<Envelope<RawTrigger[]>>(response);
  return (json.data ?? []).map((tr) => ({
    ...tr,
    id: tr.id ?? tr._id ?? '',
    triggerType: tr.triggerType ?? tr.strategy ?? 'webhook',
    consecutiveErrors: tr.consecutiveErrors ?? 0,
    lastFiredAt: tr.lastFiredAt,
  }));
}

export async function createWorkflowTrigger(
  projectId: string,
  payload: WorkflowTriggerPayload,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

export async function pauseWorkflowTrigger(
  projectId: string,
  triggerId: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers/${encodeURIComponent(triggerId)}/pause`,
    {
      method: 'POST',
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

export async function resumeWorkflowTrigger(
  projectId: string,
  triggerId: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers/${encodeURIComponent(triggerId)}/resume`,
    {
      method: 'POST',
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

export async function fireWorkflowTrigger(
  projectId: string,
  triggerId: string,
  payload?: Record<string, unknown>,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers/${encodeURIComponent(triggerId)}/fire`,
    {
      method: 'POST',
      ...(payload !== undefined
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        : {}),
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

/**
 * Fetches the last triggerPayload this trigger received, for pre-populating
 * the Fire Now modal's JSON editor. Returns `null` when no execution history
 * exists yet — callers should fall back to an empty payload.
 */
export async function getTriggerSamplePayload(
  projectId: string,
  triggerId: string,
): Promise<Record<string, unknown> | null> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers/${encodeURIComponent(triggerId)}/sample-payload`,
  );
  const envelope =
    await handleResponse<Envelope<{ payload: Record<string, unknown> | null }>>(response);
  return envelope?.data?.payload ?? null;
}

export async function testTriggerSample(
  projectId: string,
  triggerId: string,
): Promise<{ sample: Record<string, unknown>; itemCount: number }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers/${encodeURIComponent(triggerId)}/test-sample`,
    { method: 'POST' },
  );
  const envelope =
    await handleResponse<Envelope<{ sample: Record<string, unknown>; itemCount: number }>>(
      response,
    );
  return envelope?.data ?? { sample: {}, itemCount: 0 };
}

/**
 * Run an integration node's action with provided params. Persists the output
 * on the workflow node as `config.sampleOutput` for downstream context use.
 */
export async function testNodeAction(
  projectId: string,
  workflowId: string,
  nodeId: string,
  params: Record<string, unknown>,
  connectionId?: string,
): Promise<{ output: unknown }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/test-action`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connectionId ? { params, connectionId } : { params }),
    },
  );
  const envelope = await handleResponse<Envelope<{ output: unknown }>>(response);
  return envelope?.data ?? { output: null };
}

export async function deleteWorkflowTrigger(
  projectId: string,
  triggerId: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers/${encodeURIComponent(triggerId)}`,
    {
      method: 'DELETE',
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

export async function updateWorkflowTrigger(
  projectId: string,
  triggerId: string,
  body: { config: Record<string, unknown> },
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers/${encodeURIComponent(triggerId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

// =============================================================================
// NOTIFICATIONS
// =============================================================================

export async function listWorkflowNotificationRules(
  projectId: string,
  workflowId: string,
): Promise<WorkflowNotificationRule[]> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/notifications`,
  );
  const json = await handleResponse<Envelope<WorkflowNotificationRule[]>>(response);
  return json.data ?? [];
}

export async function testWorkflowNotificationRule(
  projectId: string,
  workflowId: string,
  ruleId: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/notifications/${encodeURIComponent(ruleId)}/test`,
    { method: 'POST' },
  );
  return handleResponse<{ success: boolean }>(response);
}

export async function createWorkflowNotificationRule(
  projectId: string,
  workflowId: string,
  payload: WorkflowNotificationRulePayload,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/notifications`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

export async function updateWorkflowNotificationRule(
  projectId: string,
  workflowId: string,
  ruleId: string,
  payload: WorkflowNotificationRulePayload,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/notifications/${encodeURIComponent(ruleId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

export async function deleteWorkflowNotificationRule(
  projectId: string,
  workflowId: string,
  ruleId: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/notifications/${encodeURIComponent(ruleId)}`,
    {
      method: 'DELETE',
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

// =============================================================================
// EXECUTION
// =============================================================================

export async function executeWorkflow(
  projectId: string,
  workflowId: string,
  input?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WorkflowExecution> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/execute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: input ?? {} }),
      signal,
    },
  );
  const json = await handleResponse<{ success: boolean; executionId: string }>(response);
  return { id: json.executionId } as WorkflowExecution;
}

export async function listExecutions(
  projectId: string,
  workflowId: string,
): Promise<WorkflowExecution[]> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/executions`,
  );
  const json = await handleResponse<Envelope<WorkflowExecution[]>>(response);
  return json.data ?? [];
}

export async function getExecution(
  projectId: string,
  workflowId: string,
  executionId: string,
): Promise<WorkflowExecution> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}`,
  );
  const json = await handleResponse<Envelope<WorkflowExecution>>(response);
  return json.data;
}

export async function cancelExecution(
  projectId: string,
  workflowId: string,
  executionId: string,
): Promise<void> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}/cancel`,
    { method: 'POST' },
  );
  await handleResponse<{ success: boolean }>(response);
}

// =============================================================================
// APPROVALS
// =============================================================================

export async function approveStep(
  projectId: string,
  workflowId: string,
  executionId: string,
  stepId: string,
  decision: { approved: boolean; comment?: string },
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}/steps/${encodeURIComponent(stepId)}/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: decision.approved ? 'approve' : 'reject',
        reason: decision.comment,
      }),
    },
  );
  return handleResponse<{ success: boolean }>(response);
}

// =============================================================================
// NODE-BASED WORKFLOW CANVAS TYPES
// =============================================================================

export interface WorkflowNodeSummary {
  id: string;
  nodeType: string;
  name: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  parentId?: string;
}

export interface WorkflowEdgeSummary {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle?: string;
  label?: string;
}

export interface WorkflowDeploymentInfo {
  endpointSlug: string;
  mode: 'sync' | 'async_poll' | 'async_push';
  asyncPushConfig?: { webhookUrl: string; accessToken: string };
  timeout: number;
  deployedAt: string;
  deployedBy: string;
  deployedVersion: number;
}

export interface WorkflowCanvasDetail {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  nodes: WorkflowNodeSummary[];
  edges: WorkflowEdgeSummary[];
  envVars: Record<string, string>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  deployment?: WorkflowDeploymentInfo;
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

// =============================================================================
// NODE-BASED WORKFLOW CANVAS API
// =============================================================================

export async function getWorkflowCanvas(
  projectId: string,
  workflowId: string,
): Promise<WorkflowCanvasDetail> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
  );
  const json = await handleResponse<Envelope<WorkflowCanvasDetail>>(response);
  // Normalize _id to id (MongoDB returns _id)
  const data = json.data;
  const raw = data as unknown as { _id?: string };
  if (!data.id && raw._id) {
    data.id = raw._id;
  }
  return data;
}

// =============================================================================
// WORKFLOW VERSIONS
// =============================================================================

export type WorkflowVersionState = 'active' | 'inactive';

export interface WorkflowVersionSummary {
  id: string;
  workflowId: string;
  version: string;
  state: WorkflowVersionState;
  deploymentId?: string | null;
  environment?: string;
  sourceHash?: string;
  publishedAt?: string;
  publishedBy?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface WorkflowVersionDetail extends WorkflowVersionSummary {
  definition: {
    nodes: WorkflowNodeSummary[];
    edges: WorkflowEdgeSummary[];
    envVars?: Record<string, string>;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  };
}

export async function listVersions(
  projectId: string,
  workflowId: string,
): Promise<WorkflowVersionSummary[]> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/versions`,
  );
  // Backend returns `{ success, versions: [...] }` (not the standard
  // `{ success, data }` envelope). Handle both for resilience and
  // normalize `_id` → `id` on each row so callers get a stable shape.
  type RawVersion = WorkflowVersionSummary & { _id?: string };
  const json = (await handleResponse<{
    success: boolean;
    versions?: RawVersion[];
    data?: RawVersion[];
  }>(response)) as {
    success: boolean;
    versions?: RawVersion[];
    data?: RawVersion[];
  };
  const rows = json.versions ?? json.data ?? [];
  return rows.map((v) => ({ ...v, id: v.id ?? v._id ?? '' }));
}

export async function getVersion(
  projectId: string,
  workflowId: string,
  version: string,
): Promise<WorkflowVersionDetail> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(version)}`,
  );
  // Backend returns `{ success, version: {...} }` (not the standard
  // `{ success, data }` envelope — matches `listVersions` quirk above).
  // Normalize `_id` → `id` so callers get a stable shape.
  type RawVersion = WorkflowVersionDetail & { _id?: string };
  const json = (await handleResponse<{
    success: boolean;
    version?: RawVersion;
    data?: RawVersion;
  }>(response)) as {
    success: boolean;
    version?: RawVersion;
    data?: RawVersion;
  };
  const row = json.version ?? json.data;
  if (!row) {
    throw new Error('Workflow version response missing `version` field');
  }
  return { ...row, id: row.id ?? row._id ?? '' };
}

export async function activateVersion(
  projectId: string,
  workflowId: string,
  version: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(version)}/activate`,
    { method: 'POST' },
  );
  return handleResponse<{ success: boolean }>(response);
}

export async function deactivateVersion(
  projectId: string,
  workflowId: string,
  version: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(version)}/deactivate`,
    { method: 'POST' },
  );
  return handleResponse<{ success: boolean }>(response);
}

export async function deleteVersion(
  projectId: string,
  workflowId: string,
  version: string,
): Promise<{ success: boolean; message: string }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(version)}`,
    { method: 'DELETE' },
  );
  return handleResponse<{ success: boolean; message: string }>(response);
}

export async function diffVersions(
  projectId: string,
  workflowId: string,
  version: string,
  otherVersion: string,
): Promise<Record<string, unknown>> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(version)}/diff/${encodeURIComponent(otherVersion)}`,
  );
  return handleResponse<Record<string, unknown>>(response);
}

export async function saveWorkflowVersionDraft(
  projectId: string,
  workflowId: string,
  payload: {
    name?: string;
    description?: string;
    nodes: WorkflowNodeSummary[];
    edges: WorkflowEdgeSummary[];
    envVars?: Record<string, string>;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  },
): Promise<WorkflowVersionDetail> {
  // The PATCH handler expects definition fields nested under `definition`
  const body: Record<string, unknown> = {
    definition: {
      nodes: payload.nodes,
      edges: payload.edges,
      envVars: payload.envVars,
      inputSchema: payload.inputSchema,
      outputSchema: payload.outputSchema,
    },
  };

  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/versions/draft`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  type RawVersion = WorkflowVersionDetail & { _id?: string };
  const json = (await handleResponse<{
    success: boolean;
    version?: RawVersion;
    data?: RawVersion;
  }>(response)) as {
    success: boolean;
    version?: RawVersion;
    data?: RawVersion;
  };
  const row = json.version ?? json.data;
  if (!row) {
    throw new Error('Workflow version response missing `version` field');
  }
  return { ...row, id: row.id ?? row._id ?? '' };
}

// =============================================================================
// NODE-BASED WORKFLOW CANVAS CREATE
// =============================================================================

export async function createWorkflowCanvas(
  projectId: string,
  payload: { name: string; description?: string },
): Promise<WorkflowCanvasDetail> {
  // Create with a default Start node
  const startNode: WorkflowNodeSummary = {
    id: 'start-node',
    nodeType: 'start',
    name: 'Start',
    position: { x: 400, y: 50 },
    config: { inputVariables: [] },
  };
  const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: payload.name,
      description: payload.description,
      nodes: [startNode],
      edges: [],
      status: 'draft',
    }),
  });
  const json = await handleResponse<Envelope<WorkflowCanvasDetail>>(response);
  const data = json.data;
  const raw = data as unknown as { _id?: string };
  if (!data.id && raw._id) {
    data.id = raw._id;
  }
  return data;
}
