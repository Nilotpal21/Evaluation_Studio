/** Workflow Tool Executor — workflow-as-tool pattern. */
import type { ToolExecutor, WorkflowBindingIR } from '@abl/compiler';
import { ToolExecutionError } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform';
import type { WorkflowToolVersionMetadata } from './workflow-tool-version-metadata.js';
const log = createLogger('workflow-tool-executor');
/**
 * Session metadata projected into the workflow's `agentSession` context. Built
 * once per session by the runtime (where `Session.source` is resolved) and
 * passed to the executor. Field-by-field assembly — NOT a spread of `ISession`
 * — so future Session schema additions stay invisible to workflow code unless
 * the projection is explicitly extended.
 */
export interface AgentSessionProjectionInput {
  sessionId: string;
  agentName: string;
  channel: string;
  source: 'public' | 'channel' | 'studio-debug';
  endUserId?: string;
  locale?: string;
  startedAt: string;
  lastActivityAt: string;
}

/** Shape of agentSession placed into triggerMetadata. */
export interface AgentSessionWireProjection {
  sessionId: string;
  agentName: string;
  channel: string;
  source: 'public' | 'channel' | 'studio-debug';
  endUserId: string | undefined;
  locale: string | undefined;
  startedAt: string;
  lastActivityAt: string;
}

/** Shape of agentContext placed into triggerMetadata. */
export interface AgentContextWireProjection {
  caller: { type: string; id: string };
  invocation: { tool: string; args: Record<string, unknown> };
  attachments: Array<{ id: string; mimeType: string; sizeBytes: number; name: string }>;
  messageMetadata: Record<string, unknown> | undefined;
}

/**
 * Per-call invocation metadata used to build `agentContext`. Supplied by the
 * runtime at executor construction time; the per-call `params` are mixed in
 * as `invocation.args`.
 */
export interface AgentContextProjectionInput {
  caller: { type: string; id: string };
  attachments?: Array<{ id: string; mimeType: string; sizeBytes: number; name: string }>;
  messageMetadata?: Record<string, unknown>;
}

export interface WorkflowToolExecutorConfig {
  workflowEngineUrl: string;
  authToken: string;
  projectId: string;
  tenantId: string;
  /** Trigger classification persisted on child workflow executions. */
  triggerType?: 'agent' | 'workflow';
  sessionId?: string;
  agentName?: string;
  defaultTimeoutMs?: number;
  /** Base URL for push callbacks (e.g. http://runtime:3112). When set, async executions include callbackUrl in triggerMetadata. */
  callbackBaseUrl?: string;
  /** Parent workflow callback endpoint for wait-for-completion workflow tools. */
  completionCallback?: { url: string; secret: string };
  /** Resolved workflow versions keyed by tool name (explicit pin or deployment manifest). */
  resolvedWorkflowVersions?: Record<string, WorkflowToolVersionMetadata>;
  /** Promise that resolves once deployment-derived workflow metadata has been loaded. */
  resolvedWorkflowVersionsReady?: Promise<Record<string, WorkflowToolVersionMetadata>>;
  /**
   * Session projection pushed into `triggerMetadata.agentSession` on every
   * workflow invocation. Supplied at construction time; identical for every
   * tool call on this executor (one executor per session).
   */
  agentSessionProjection?: AgentSessionProjectionInput;
  /**
   * Per-session context projection pushed into `triggerMetadata.agentContext`.
   * Per-call `params` become `invocation.args`; the rest (caller, attachments,
   * messageMetadata) are session-scoped.
   */
  agentContextProjection?: AgentContextProjectionInput;
}

/**
 * Build the wire-shape `agentSession` projection. Field-by-field — no spread
 * of the input. Returns undefined when no input is supplied (agent-less
 * trigger paths shouldn't emit a projection at all).
 */
export function buildAgentSessionProjection(
  input: AgentSessionProjectionInput | undefined,
): AgentSessionWireProjection | undefined {
  if (!input) return undefined;
  return {
    sessionId: input.sessionId,
    agentName: input.agentName,
    channel: input.channel,
    source: input.source,
    endUserId: input.endUserId,
    locale: input.locale,
    startedAt: input.startedAt,
    lastActivityAt: input.lastActivityAt,
  };
}

/**
 * Build the wire-shape `agentContext` projection. The caller and per-tool
 * args are required; attachments/messageMetadata default to safe empties.
 * Top-level fields (caller, invocation wrapper) and each attachment are
 * reconstructed field-by-field — no spread — so that extras on the input
 * cannot leak into workflow scope as agentContext.* keys.
 *
 * `invocation.args` and `messageMetadata` are intentionally pass-through
 * (spread): `args` carries open-ended LLM tool-call arguments, and
 * `messageMetadata` carries channel/transport metadata that the runtime
 * forwards verbatim. The workflow-engine re-materializer keeps the same
 * pass-through shape; downstream code that touches these fields must
 * treat them as untrusted input.
 */
export function buildAgentContextProjection(
  toolName: string,
  params: Record<string, unknown>,
  input: AgentContextProjectionInput | undefined,
): AgentContextWireProjection | undefined {
  if (!input) return undefined;
  const attachments = (input.attachments ?? []).map((a) => ({
    id: a.id,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    name: a.name,
  }));
  return {
    caller: { type: input.caller.type, id: input.caller.id },
    invocation: { tool: toolName, args: { ...params } },
    attachments,
    messageMetadata: input.messageMetadata ? { ...input.messageMetadata } : undefined,
  };
}
export interface WorkflowMeta {
  name: string;
  description?: string;
  inputVariables: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'json';
    required: boolean;
    description?: string;
  }>;
  triggerMode: 'sync' | 'async';
}
export interface WorkflowExecuteResult {
  status: 'completed' | 'running' | 'failed' | 'cancelled' | 'rejected';
  executionId: string;
  output?: Record<string, unknown>;
  message?: string;
}
interface NormalizedError {
  message: string;
  upstreamCode?: string;
}
export const POLL_BACKOFF_SCHEDULE = [250, 500, 1000, 2000] as const;
const POLL_BACKOFF_CAP_MS = 2000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected']);
/** Minimal $.a.b.c resolver. Tech debt: see docs/sdlc-logs/workflow-as-tool/lld.log.md */
export function resolveJsonPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path.startsWith('$.')) return undefined;
  let current: unknown = obj;
  for (const seg of path.slice(2).split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

export function applyParamMapping(
  params: Record<string, unknown>,
  paramMapping: Record<string, string> | null | undefined,
): Record<string, unknown> {
  if (!paramMapping) return params;
  const keys = Object.keys(paramMapping);
  if (keys.length === 0) return params;
  const mapped: Record<string, unknown> = {};
  for (const key of keys) mapped[key] = resolveJsonPath(params, paramMapping[key]);
  return mapped;
}
export class WorkflowToolExecutor implements ToolExecutor {
  private readonly cfg: WorkflowToolExecutorConfig;
  private resolvedWorkflowVersionsReady?: Promise<Record<string, WorkflowToolVersionMetadata>>;
  /** Session-scoped, bounded by project tool count (<50). Released on session end. */
  private readonly bindings = new Map<string, { binding: WorkflowBindingIR; meta: WorkflowMeta }>();
  /** Session-scoped tracking of async execution IDs. Optimization for fast rejection — not a security gate. */
  private readonly asyncExecutionIds = new Set<string>();
  private static readonly MAX_ASYNC_EXECUTION_IDS = 1000;

  constructor(cfg: WorkflowToolExecutorConfig) {
    this.cfg = cfg;
    this.resolvedWorkflowVersionsReady = cfg.resolvedWorkflowVersionsReady;
  }

  private async ensureResolvedWorkflowVersions(): Promise<void> {
    const workflowVersionsReady = this.resolvedWorkflowVersionsReady;
    if (!workflowVersionsReady) {
      return;
    }

    await workflowVersionsReady;
    if (this.resolvedWorkflowVersionsReady === workflowVersionsReady) {
      this.resolvedWorkflowVersionsReady = undefined;
    }
  }

  private trackAsyncExecutionId(executionId: string): void {
    if (this.asyncExecutionIds.size >= WorkflowToolExecutor.MAX_ASYNC_EXECUTION_IDS) {
      // Evict oldest entry (first inserted) to stay bounded
      const oldest = this.asyncExecutionIds.values().next().value;
      if (oldest) this.asyncExecutionIds.delete(oldest);
    }
    this.asyncExecutionIds.add(executionId);
  }

  /** Returns the set of execution IDs from async workflow calls in this session. */
  getAsyncExecutionIds(): ReadonlySet<string> {
    return this.asyncExecutionIds;
  }

  registerBinding(toolName: string, binding: WorkflowBindingIR, meta: WorkflowMeta): void {
    this.bindings.set(toolName, { binding, meta });
  }

  private getEffectiveWorkflowVersion(
    toolName: string,
    binding: WorkflowBindingIR,
  ): WorkflowToolVersionMetadata {
    const resolved = this.cfg.resolvedWorkflowVersions?.[toolName];
    return {
      workflowId: binding.workflowId,
      ...(binding.workflowVersionId
        ? { workflowVersionId: binding.workflowVersionId }
        : resolved?.workflowVersionId
          ? { workflowVersionId: resolved.workflowVersionId }
          : {}),
      ...(binding.workflowVersion
        ? { workflowVersion: binding.workflowVersion }
        : resolved?.workflowVersion
          ? { workflowVersion: resolved.workflowVersion }
          : {}),
    };
  }

  /**
   * 3-arg ToolExecutor.execute contract. toolCallId v1 gap: no slot for toolCallId —
   * dedup relies on LLMWiringService. Follow-up will widen once SearchAI needs it.
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WorkflowExecuteResult> {
    const entry = this.bindings.get(toolName);
    if (!entry) {
      throw new ToolExecutionError({
        code: 'TOOL_EXECUTION_ERROR',
        message: `Workflow tool "${toolName}" has no registered binding. Ensure the tool is registered via registerBinding().`,
        toolName,
        toolType: 'workflow',
      });
    }

    try {
      await this.ensureResolvedWorkflowVersions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ToolExecutionError({
        code: 'TOOL_EXECUTION_ERROR',
        message: `workflow version resolution failed: ${msg}`,
        toolName,
        toolType: 'workflow',
      });
    }

    const { binding } = entry;
    const effectiveVersion = this.getEffectiveWorkflowVersion(toolName, binding);
    const bindingTimeout = typeof binding.timeoutMs === 'number' ? binding.timeoutMs : undefined;
    const effectiveTimeout = Math.min(
      ...[timeoutMs, bindingTimeout, this.cfg.defaultTimeoutMs ?? 60_000].filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value),
      ),
    );
    const payload = applyParamMapping(params, binding.paramMapping);
    const startMs = Date.now();
    const base = this.cfg.workflowEngineUrl.replace(/\/+$/, '');
    const url = `${base}/api/v1/projects/${this.cfg.projectId}/workflows/${binding.workflowId}/executions/execute`;
    const completionCallback = this.cfg.completionCallback;
    const usePushCallback =
      typeof completionCallback?.url === 'string' &&
      completionCallback.url.length > 0 &&
      typeof completionCallback.secret === 'string' &&
      completionCallback.secret.length > 0;
    const triggerType = this.cfg.triggerType ?? 'agent';

    let executionId: string;
    try {
      const callbackBase = this.cfg.callbackBaseUrl?.replace(/\/+$/, '') ?? '';
      // Build agent projections per-call (positive-list, no spread). The
      // workflow-engine re-materializes these on receipt; this is the
      // emit-side guarantee that no extra Session field leaks across the
      // boundary.
      const agentSessionWire = buildAgentSessionProjection(this.cfg.agentSessionProjection);
      const agentContextWire = buildAgentContextProjection(
        toolName,
        params,
        this.cfg.agentContextProjection,
      );
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.authToken}`,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          payload,
          triggerType,
          ...(usePushCallback
            ? {
                webhookMode: 'async',
                webhookDelivery: 'push',
              }
            : {}),
          ...(effectiveVersion.workflowVersionId
            ? { workflowVersionId: effectiveVersion.workflowVersionId }
            : {}),
          ...(effectiveVersion.workflowVersion
            ? { workflowVersion: effectiveVersion.workflowVersion }
            : {}),
          triggerMetadata: {
            source: 'agent_tool',
            sessionId: this.cfg.sessionId,
            agentName: this.cfg.agentName,
            triggerId: binding.triggerId,
            ...(usePushCallback
              ? {
                  callbackUrl: completionCallback.url,
                  callbackSecret: completionCallback.secret,
                }
              : binding.mode === 'async' && callbackBase
                ? { callbackUrl: `${callbackBase}/api/internal/workflow-callback` }
                : {}),
            ...(agentSessionWire ? { agentSession: agentSessionWire } : {}),
            ...(agentContextWire ? { agentContext: agentContextWire } : {}),
          },
        }),
      });
      if (!resp.ok) {
        const body = await safeParseBody(resp);
        const n = normalizeEngineError(resp.status, body);
        throw new ToolExecutionError({
          code: 'TOOL_NETWORK_ERROR',
          message: n.message,
          toolName,
          toolType: 'workflow',
          statusCode: resp.status,
          durationMs: Date.now() - startMs,
        });
      }
      const rb = (await resp.json()) as { success: boolean; executionId?: string };
      executionId = rb.executionId ?? '';
      if (!executionId) {
        throw new ToolExecutionError({
          code: 'TOOL_EXECUTION_ERROR',
          message: 'Engine returned success but no executionId',
          toolName,
          toolType: 'workflow',
          durationMs: Date.now() - startMs,
        });
      }
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ToolExecutionError({
        code: 'TOOL_NETWORK_ERROR',
        message: `workflow engine unreachable: ${msg}`,
        toolName,
        toolType: 'workflow',
        durationMs: Date.now() - startMs,
      });
    }

    log.info('Workflow execution started', {
      toolName,
      executionId,
      workflowId: binding.workflowId,
      workflowVersionId: effectiveVersion.workflowVersionId,
      workflowVersion: effectiveVersion.workflowVersion,
      mode: binding.mode,
    });

    if (usePushCallback || binding.mode === 'async') {
      this.trackAsyncExecutionId(executionId);
      const latencyMs = Date.now() - startMs;
      log.info('tool.workflow.async.dispatched', {
        executionId,
        workflowId: binding.workflowId,
        workflowVersionId: effectiveVersion.workflowVersionId,
        workflowVersion: effectiveVersion.workflowVersion,
        triggerId: binding.triggerId,
        mode: usePushCallback ? 'async_push' : 'async',
        latencyMs,
      });
      return {
        executionId,
        status: 'running',
        message: usePushCallback
          ? `Workflow execution started asynchronously (executionId: ${executionId}). Final result will be delivered via callback.`
          : `Workflow execution started asynchronously (executionId: ${executionId}). Use check_workflow_status to poll for results.`,
      };
    }

    return this.pollUntilTerminal(
      toolName,
      executionId,
      binding,
      effectiveVersion,
      effectiveTimeout,
      startMs,
    );
  }

  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: WorkflowExecuteResult; error?: string }>> {
    const results = await Promise.allSettled(
      calls.map((c) => this.execute(c.name, c.params, timeoutMs)),
    );
    return results.map((r, i) => ({
      name: calls[i].name,
      ...(r.status === 'fulfilled'
        ? { result: r.value }
        : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) }),
    }));
  }

  private async pollUntilTerminal(
    toolName: string,
    executionId: string,
    binding: WorkflowBindingIR,
    effectiveVersion: WorkflowToolVersionMetadata,
    timeoutMs: number,
    startMs: number,
  ): Promise<WorkflowExecuteResult> {
    const base = this.cfg.workflowEngineUrl.replace(/\/+$/, '');
    const statusUrl = `${base}/api/v1/projects/${this.cfg.projectId}/workflows/${binding.workflowId}/executions/${executionId}`;
    let pollIdx = 0;

    while (true) {
      if (Date.now() - startMs >= timeoutMs) {
        await this.cancelExecution(executionId, binding, toolName, effectiveVersion);
        const latencyMs = Date.now() - startMs;
        log.warn('tool.workflow.execute.timeout', {
          executionId,
          workflowId: binding.workflowId,
          workflowVersionId: effectiveVersion.workflowVersionId,
          workflowVersion: effectiveVersion.workflowVersion,
          triggerId: binding.triggerId,
          mode: 'sync',
          latencyMs,
        });
        throw new ToolExecutionError({
          code: 'TOOL_TIMEOUT',
          message: `workflow execution timed out after ${timeoutMs}ms`,
          toolName,
          toolType: 'workflow',
          durationMs: latencyMs,
        });
      }
      const delay =
        pollIdx < POLL_BACKOFF_SCHEDULE.length
          ? POLL_BACKOFF_SCHEDULE[pollIdx]
          : POLL_BACKOFF_CAP_MS;
      await sleep(delay);
      pollIdx++;
      log.debug('tool.workflow.execute.poll', {
        executionId,
        workflowId: binding.workflowId,
        workflowVersionId: effectiveVersion.workflowVersionId,
        workflowVersion: effectiveVersion.workflowVersion,
        triggerId: binding.triggerId,
        mode: 'sync',
        pollIndex: pollIdx,
        latencyMs: Date.now() - startMs,
      });

      let execution: Record<string, unknown>;
      try {
        const resp = await fetch(statusUrl, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.cfg.authToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) {
          const body = await safeParseBody(resp);
          const n = normalizeEngineError(resp.status, body);
          throw new ToolExecutionError({
            code: 'TOOL_NETWORK_ERROR',
            message: n.message,
            toolName,
            toolType: 'workflow',
            statusCode: resp.status,
            durationMs: Date.now() - startMs,
          });
        }
        const rb = (await resp.json()) as { success: boolean; data?: Record<string, unknown> };
        execution = rb.data ?? {};
      } catch (err) {
        if (err instanceof ToolExecutionError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new ToolExecutionError({
          code: 'TOOL_NETWORK_ERROR',
          message: `workflow engine unreachable during poll: ${msg}`,
          toolName,
          toolType: 'workflow',
          durationMs: Date.now() - startMs,
        });
      }

      const status = String(execution.status ?? '');
      if (!TERMINAL_STATUSES.has(status)) continue;
      const latencyMs = Date.now() - startMs;

      if (status === 'completed') {
        log.info('tool.workflow.execute.complete', {
          executionId,
          workflowId: binding.workflowId,
          workflowVersionId: effectiveVersion.workflowVersionId,
          workflowVersion: effectiveVersion.workflowVersion,
          triggerId: binding.triggerId,
          mode: 'sync',
          latencyMs,
        });
        return {
          status: 'completed',
          executionId,
          output: (execution.output as Record<string, unknown>) ?? undefined,
        };
      }

      log.warn('tool.workflow.execute.error', {
        executionId,
        workflowId: binding.workflowId,
        workflowVersionId: effectiveVersion.workflowVersionId,
        workflowVersion: effectiveVersion.workflowVersion,
        triggerId: binding.triggerId,
        mode: 'sync',
        terminalStatus: status,
        latencyMs,
      });
      const detail =
        typeof execution.error === 'string'
          ? execution.error
          : typeof execution.error === 'object' && execution.error !== null
            ? JSON.stringify(execution.error)
            : status;
      throw new ToolExecutionError({
        code: 'TOOL_EXECUTION_ERROR',
        message: `${status}: ${detail}`,
        toolName,
        toolType: 'workflow',
        durationMs: latencyMs,
      });
    }
  }

  private async cancelExecution(
    executionId: string,
    binding: WorkflowBindingIR,
    toolName: string,
    effectiveVersion: WorkflowToolVersionMetadata,
  ): Promise<void> {
    const base = this.cfg.workflowEngineUrl.replace(/\/+$/, '');
    const cancelUrl = `${base}/api/v1/projects/${this.cfg.projectId}/workflows/${binding.workflowId}/executions/${executionId}/cancel`;
    try {
      const resp = await fetch(cancelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.authToken}`,
        },
      });
      if (resp.status === 409) {
        log.debug('Execution already terminal, cancel unnecessary', {
          executionId,
          workflowId: binding.workflowId,
        });
        return;
      }
      if (!resp.ok) {
        log.warn('Cancel request returned non-OK status', { executionId, status: resp.status });
      } else {
        log.info('tool.workflow.execute.cancel', {
          executionId,
          workflowId: binding.workflowId,
          workflowVersionId: effectiveVersion.workflowVersionId,
          workflowVersion: effectiveVersion.workflowVersion,
          triggerId: binding.triggerId,
          mode: 'sync',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Cancel request failed', { executionId, toolName, error: msg });
    }
  }
}

/** Normalize mixed error envelope from workflow engine (flat-string or structured). */
export function normalizeEngineError(status: number, body: unknown): NormalizedError {
  if (body === null || body === undefined || typeof body !== 'object') {
    return { message: `workflow engine error: HTTP ${status}` };
  }
  const errorField = (body as Record<string, unknown>).error;

  if (typeof errorField === 'string') {
    if (status === 404) return { message: `workflow not found: ${errorField}` };
    if (status === 502)
      return {
        message: `workflow engine unavailable: ${errorField}`,
        upstreamCode: 'RESTATE_START_FAILED',
      };
    return { message: errorField };
  }

  if (typeof errorField === 'object' && errorField !== null && !Array.isArray(errorField)) {
    const s = errorField as Record<string, unknown>;
    const code = typeof s.code === 'string' ? s.code : undefined;
    const message = typeof s.message === 'string' ? s.message : String(s.message ?? '');
    if (code === 'RESTATE_START_FAILED')
      return { message: `workflow engine unavailable: ${message}`, upstreamCode: code };
    if (code) return { message: `${code}: ${message}`, upstreamCode: code };
    return { message: message || `workflow engine error: HTTP ${status}` };
  }
  return { message: `workflow engine error: HTTP ${status}` };
}
async function safeParseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return { error: `HTTP ${response.status}` };
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
