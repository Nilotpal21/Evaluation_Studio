/**
 * Step Context Schema
 *
 * Typed, per-node-type context stored in context.steps[stepName].
 * This is the single source of truth for what gets persisted to MongoDB
 * and returned in the execution API response — no internal routing fields,
 * no sensitive config, no null outputs.
 *
 * Add a new interface + case in buildCleanStepContext to extend for new step types.
 */

import { FUNCTION_CONTEXT_IMMUTABLE_TOP_LEVEL_KEYS } from '@agent-platform/shared-kernel/types';

// ── Root context ──────────────────────────────────────────────────────────────

export interface WorkflowStepData {
  output?: unknown;
  status?: string;
  /** Step UUID (or 'start'/'end') — enables finding a step in context.steps by its UUID */
  stepId?: string;
  input?: unknown;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  nodeType?: string;
  error?: { code: string; message: string };
  metrics?: { responseTimeMs?: number; processingTimeMs?: number };
  consoleLogs?: Array<{ level: string; args: unknown[] }>;
  mappingErrors?: Array<{ name: string; expression?: string; error: string }>;
  controlFlow?: {
    type: 'delay' | 'async_webhook' | 'approval' | 'human_task';
    delayMs?: number;
    request?: unknown;
  };
}

export interface WorkflowContextData {
  [key: string]: unknown;
  trigger: {
    type: string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  workflow: {
    id: string;
    name: string;
    executionId: string;
  };
  tenant: {
    tenantId: string;
    projectId: string;
  };
  steps: Record<string, WorkflowStepData>;
}

export const CONTEXT_SYSTEM_KEYS = new Set(['trigger', 'workflow', 'tenant', 'steps']);

export function getContextVariables(ctx: WorkflowContextData): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (!CONTEXT_SYSTEM_KEYS.has(key)) variables[key] = value;
  }
  return variables;
}

// ── Context write policy ─────────────────────────────────────────────────────
export const FUNCTION_CONTEXT_STATIC_IMMUTABLE_KEYS = FUNCTION_CONTEXT_IMMUTABLE_TOP_LEVEL_KEYS;

export const CONTEXT_FULLY_IMMUTABLE_WRITE_ROOTS = ['trigger', 'workflow', 'tenant'] as const;

export const CONTEXT_MUTABLE_START_INPUT_PATH = 'steps.start.input';

function getLoopVariableBaseKeys(ctx: WorkflowContextData): string[] {
  const keys = Object.keys(getContextVariables(ctx));
  const keySet = new Set(keys);
  const bases = new Set<string>();

  for (const key of keys) {
    if (!key.endsWith('_index')) continue;
    const base = key.slice(0, -'_index'.length);
    if (base && keySet.has(base) && keySet.has(`${base}_count`)) {
      bases.add(base);
    }
  }

  return [...bases];
}

export function getFunctionContextImmutableKeys(ctx: WorkflowContextData): string[] {
  const immutableKeys = new Set<string>(FUNCTION_CONTEXT_STATIC_IMMUTABLE_KEYS);

  for (const base of getLoopVariableBaseKeys(ctx)) {
    immutableKeys.add(base);
    immutableKeys.add(`${base}_index`);
    immutableKeys.add(`${base}_count`);
  }

  return [...immutableKeys];
}

export function isFunctionContextImmutableWriteKey(ctx: WorkflowContextData, key: string): boolean {
  return getFunctionContextImmutableKeys(ctx).includes(key);
}

export function isFullyImmutableContextWriteRoot(key: string): boolean {
  return CONTEXT_FULLY_IMMUTABLE_WRITE_ROOTS.includes(
    key as (typeof CONTEXT_FULLY_IMMUTABLE_WRITE_ROOTS)[number],
  );
}

export function isMutableStartInputContextPath(path: string): boolean {
  return (
    path === CONTEXT_MUTABLE_START_INPUT_PATH ||
    path.startsWith(`${CONTEXT_MUTABLE_START_INPUT_PATH}.`)
  );
}

// ── Base ──────────────────────────────────────────────────────────────────────

export interface BaseStepContext {
  nodeType: string;
  /** Step UUID (or 'start'/'end' for boundary nodes) — enables routes to find a step in context.steps by its UUID */
  stepId?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: { code: string; message: string };
}

// ── Per-node-type shapes ──────────────────────────────────────────────────────

export interface StartStepContext extends BaseStepContext {
  nodeType: 'start';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface AgentStepContext extends BaseStepContext {
  nodeType: 'agent_invocation';
  input?: { agentId?: string; message?: string; sessionId?: string | null; timeout?: number };
  output?: { sessionId?: string; agentResponse?: string };
}

export interface ConditionStepContext extends BaseStepContext {
  nodeType: 'condition';
  input?: { conditions?: Array<{ id: string; expression: string }> };
  output?: {
    conditionMet?: boolean;
    branchTaken?: string;
    expression?: string;
    traces?: Array<{ expression: string; resolvedValue: unknown }>;
    evaluatedConditions?: Array<{
      id: string;
      expression: string;
      result: boolean;
      traces?: Array<{ expression: string; resolvedValue: unknown }>;
    }>;
  };
}

export interface DelayStepContext extends BaseStepContext {
  nodeType: 'delay';
  input?: { duration?: string };
  /** Resolved delay in milliseconds — shown in the debug panel as the actual wait time. */
  delayMs?: number;
  output?: { delayMs?: number };
}

export interface FunctionStepContext extends BaseStepContext {
  nodeType: 'function';
  input?: { code?: string };
  output?: Record<string, unknown>;
  metrics?: { responseTimeMs?: number; processingTimeMs?: number };
  consoleLogs?: Array<{ level: string; args: unknown[] }>;
}

export interface ToolCallStepContext extends BaseStepContext {
  nodeType: 'tool_call';
  input?: { toolName?: string; params?: Record<string, unknown> };
  output?: unknown;
  /** Encrypted HMAC secret for callback-based completion when wait mode is enabled. */
  callbackSecret?: string;
  /** Restate awakeable ID — stripped at WS publish boundary. */
  awakeableId?: string;
}

export interface ConnectorActionStepContext extends BaseStepContext {
  nodeType: 'connector_action';
  /**
   * Encrypted HMAC secret for callback-based completion when the connector
   * action returns an AsyncParkingSentinel (Phase 1 + Phase 4 async parking).
   * Mirrors the field on ToolCallStepContext and AsyncWebhookStepContext.
   * Stripped at the WS publish boundary in workflow-handler.ts.
   */
  callbackSecret?: string;
  /**
   * Restate awakeable ID used for the async-parking suspension when the
   * awakeable experiment is active. The callback route resolves this via
   * the Restate built-in /restate/awakeables/:id/resolve endpoint instead
   * of the workflow.shared handler path. Stripped at the WS publish boundary.
   */
  awakeableId?: string;
  input?: {
    connector?: string;
    action?: string;
    params?: Record<string, unknown>;
    connectionId?: string;
  };
  /** Raw connector action output — shape varies by connector (Slack, GitHub, Google, etc.) */
  output?: unknown;
}

export interface HttpStepContext extends BaseStepContext {
  nodeType: 'http';
  input?: { url?: string; method?: string; headers?: Record<string, string>; timeout?: number };
  output?: { statusCode?: number; body?: unknown; headers?: Record<string, string> };
  metrics?: { responseTimeMs?: number; processingTimeMs?: number };
}

export interface HumanTaskStepContext extends BaseStepContext {
  nodeType: 'human_task' | 'approval';
  input?: { title?: string; taskType?: string; assignTo?: string[] };
  output?: { humanTaskResponse?: Record<string, unknown> };
  /** Restate awakeable ID for the approval/human_task suspension — stripped at WS publish boundary. */
  awakeableId?: string;
}

export interface EndStepContext extends BaseStepContext {
  nodeType: 'end';
  input?: unknown[];
  output?: Record<string, unknown>;
  metrics?: { processingTimeMs?: number };
  mappingErrors?: Array<{ name: string; expression?: string; error: string }>;
}

export interface ParallelStepContext extends BaseStepContext {
  nodeType: 'parallel';
  output?: unknown;
}

export interface TransformStepContext extends BaseStepContext {
  nodeType: 'transform';
  input?: { inputExpression?: string; outputVariable?: string };
  output?: Record<string, unknown>;
}

export interface AsyncWebhookStepContext extends BaseStepContext {
  nodeType: 'async_webhook';
  input?: { url?: string; method?: string };
  output?: unknown;
  /** Encrypted HMAC secret for verifying inbound callbacks — ciphertext only, never plaintext */
  callbackSecret?: string;
  /** Restate awakeable ID — stripped at WS publish boundary. */
  awakeableId?: string;
}

export interface LoopStepContext extends BaseStepContext {
  nodeType: 'loop';
  input?: {
    collection?: string;
    itemVariable?: string;
    bodySteps?: string[];
    mode?: 'sequential' | 'parallel';
    concurrencyLimit?: number;
  };
  output?: unknown;
  loopContext?: Array<{
    currentIndex: number;
    currentItem: unknown;
    steps: Record<
      string,
      {
        stepId?: unknown;
        status?: unknown;
        startedAt?: unknown;
        completedAt?: unknown;
        durationMs?: unknown;
      }
    >;
  }>;
}

export type StepContextData =
  | StartStepContext
  | AgentStepContext
  | ConditionStepContext
  | DelayStepContext
  | FunctionStepContext
  | ToolCallStepContext
  | ConnectorActionStepContext
  | HttpStepContext
  | HumanTaskStepContext
  | EndStepContext
  | ParallelStepContext
  | TransformStepContext
  | AsyncWebhookStepContext
  | LoopStepContext;

// ── Sanitizers ────────────────────────────────────────────────────────────────

/**
 * Pass-through — step outputs are intentionally stored as-is.
 * Connector action outputs (Slack, GitHub, Jira, etc.) reach the Studio debug panel
 * in full; Studio is project-scoped and authenticated, so full connector responses
 * are visible to the workflow designer by design. Credential-class fields
 * (callbackSecret, encryptedAccessToken) are stripped at the WS publish boundary in
 * workflow-handler.ts (PUBLISH_SENSITIVE_STEP_FIELDS) and wf-bridge.ts (sanitizeSnapshotDoc).
 *
 * @deprecated No callers — kept for API stability only. Remove in next major refactor.
 */
export function sanitizeStepOutput(_nodeType: string, output: unknown): unknown {
  return output;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build a clean, typed step context for a given node type.
 *
 * Strips internal fields (controlFlow, null output, sensitive connector config).
 * Call this before writing to ctx.steps so in-memory state and MongoDB are both clean.
 *
 * `base` carries the lifecycle metadata (status, timestamps, error).
 * `fields` carries the step-specific payload (input, output, metrics, etc.).
 */
export function buildCleanStepContext(
  nodeType: string,
  base: BaseStepContext,
  fields: Record<string, unknown> = {},
): StepContextData {
  const common = {
    nodeType,
    ...(base.stepId !== undefined ? { stepId: base.stepId } : {}),
    ...(base.status !== undefined ? { status: base.status } : {}),
    ...(base.startedAt !== undefined ? { startedAt: base.startedAt } : {}),
    ...(base.completedAt !== undefined ? { completedAt: base.completedAt } : {}),
    ...(base.durationMs !== undefined ? { durationMs: base.durationMs } : {}),
    ...(base.error !== undefined ? { error: base.error } : {}),
  };

  switch (nodeType) {
    case 'start': {
      const ctx: StartStepContext = { ...common, nodeType: 'start' };
      if (fields.input != null) ctx.input = fields.input as StartStepContext['input'];
      if (fields.output != null) ctx.output = fields.output as StartStepContext['output'];
      return ctx;
    }

    case 'agent_invocation': {
      const ctx: AgentStepContext = { ...common, nodeType: 'agent_invocation' };
      if (fields.input != null) ctx.input = fields.input as AgentStepContext['input'];
      if (fields.output != null) ctx.output = fields.output as AgentStepContext['output'];
      return ctx;
    }

    case 'condition': {
      const ctx: ConditionStepContext = { ...common, nodeType: 'condition' };
      if (fields.input != null) ctx.input = fields.input as ConditionStepContext['input'];
      if (fields.output != null) ctx.output = fields.output as ConditionStepContext['output'];
      return ctx;
    }

    case 'delay': {
      const ctx: DelayStepContext = { ...common, nodeType: 'delay' };
      if (fields.input != null) ctx.input = fields.input as DelayStepContext['input'];
      if (typeof fields.delayMs === 'number') {
        ctx.delayMs = fields.delayMs;
        ctx.output = { delayMs: fields.delayMs };
      }
      return ctx;
    }

    case 'function': {
      const ctx: FunctionStepContext = { ...common, nodeType: 'function' };
      if (fields.input != null) ctx.input = fields.input as FunctionStepContext['input'];
      if (fields.output != null) ctx.output = fields.output as FunctionStepContext['output'];
      if (fields.metrics != null) ctx.metrics = fields.metrics as FunctionStepContext['metrics'];
      if (Array.isArray(fields.consoleLogs))
        ctx.consoleLogs = fields.consoleLogs as FunctionStepContext['consoleLogs'];
      return ctx;
    }

    case 'tool_call': {
      const ctx: ToolCallStepContext = { ...common, nodeType: 'tool_call' };
      if (fields.input != null) ctx.input = fields.input as ToolCallStepContext['input'];
      if (fields.output != null) ctx.output = fields.output;
      if (typeof fields.callbackSecret === 'string') ctx.callbackSecret = fields.callbackSecret;
      if (typeof fields.awakeableId === 'string') ctx.awakeableId = fields.awakeableId;
      return ctx;
    }

    case 'connector_action': {
      const ctx: ConnectorActionStepContext = { ...common, nodeType: 'connector_action' };
      if (fields.input != null) ctx.input = fields.input as ConnectorActionStepContext['input'];
      if (fields.output !== undefined) ctx.output = fields.output;
      if (typeof fields.callbackSecret === 'string') ctx.callbackSecret = fields.callbackSecret;
      if (typeof fields.awakeableId === 'string') ctx.awakeableId = fields.awakeableId;
      return ctx;
    }

    case 'http': {
      const ctx: HttpStepContext = { ...common, nodeType: 'http' };
      if (fields.input != null) ctx.input = fields.input as HttpStepContext['input'];
      if (fields.output != null) ctx.output = fields.output as HttpStepContext['output'];
      if (fields.metrics != null) ctx.metrics = fields.metrics as HttpStepContext['metrics'];
      return ctx;
    }

    case 'human_task':
    case 'approval': {
      const ctx: HumanTaskStepContext = {
        ...common,
        nodeType: nodeType as 'human_task' | 'approval',
      };
      if (fields.input != null) ctx.input = fields.input as HumanTaskStepContext['input'];
      if (fields.output != null) ctx.output = fields.output as HumanTaskStepContext['output'];
      if (typeof fields.awakeableId === 'string') ctx.awakeableId = fields.awakeableId;
      // controlFlow stripped — internal routing only
      return ctx;
    }

    case 'parallel': {
      const ctx: ParallelStepContext = { ...common, nodeType: 'parallel' };
      if (fields.output != null) ctx.output = fields.output;
      return ctx;
    }

    case 'transform': {
      const ctx: TransformStepContext = { ...common, nodeType: 'transform' };
      if (fields.input != null) ctx.input = fields.input as TransformStepContext['input'];
      if (fields.output != null) ctx.output = fields.output as TransformStepContext['output'];
      return ctx;
    }

    case 'async_webhook': {
      const ctx: AsyncWebhookStepContext = { ...common, nodeType: 'async_webhook' };
      if (fields.input != null) ctx.input = fields.input as AsyncWebhookStepContext['input'];
      if (fields.output != null) ctx.output = fields.output;
      if (typeof fields.callbackSecret === 'string') ctx.callbackSecret = fields.callbackSecret;
      if (typeof fields.awakeableId === 'string') ctx.awakeableId = fields.awakeableId;
      return ctx;
    }

    case 'end': {
      const ctx: EndStepContext = { ...common, nodeType: 'end' };
      if (Array.isArray(fields.input)) ctx.input = fields.input as EndStepContext['input'];
      if (fields.output != null) ctx.output = fields.output as EndStepContext['output'];
      if (fields.metrics != null) ctx.metrics = fields.metrics as EndStepContext['metrics'];
      if (Array.isArray(fields.mappingErrors)) {
        ctx.mappingErrors = fields.mappingErrors as EndStepContext['mappingErrors'];
      }
      return ctx;
    }

    case 'loop': {
      const ctx: LoopStepContext = { ...common, nodeType: 'loop' };
      if (fields.input != null) ctx.input = fields.input as LoopStepContext['input'];
      if (fields.output != null) ctx.output = fields.output;
      if (fields.loopContext != null) {
        ctx.loopContext = fields.loopContext as LoopStepContext['loopContext'];
      }
      return ctx;
    }

    default:
      return { ...common, nodeType } as StepContextData;
  }
}
