/**
 * Workflow Handler
 *
 * Core workflow execution logic. Processes steps sequentially, tracks state,
 * and reports status changes. Designed to be called from a Restate workflow
 * context but testable independently via dependency injection.
 *
 * The Restate-specific wiring (ctx.run, ctx.promise, ctx.sleep) lives in
 * the Restate service definition (see restate-service.ts). This module
 * contains the pure execution logic.
 */

import { randomBytes } from 'node:crypto';
import { resolveExpressionTyped, type MemoryProjection } from '../context/expression-resolver.js';
import {
  buildCleanStepContext,
  getContextVariables,
  isFullyImmutableContextWriteRoot,
  isFunctionContextImmutableWriteKey,
  isMutableStartInputContextPath,
  type WorkflowContextData,
  type WorkflowStepData,
} from '../context/step-context-schema.js';
import { materializeAgentContext, materializeAgentSession } from '../context/agent-projection.js';
import { DEFAULT_CALLBACK_TIMEOUT_MS, MAX_WORKFLOW_STEPS } from '../constants.js';
import {
  extractStepError,
  WorkflowStepError,
  StepErrorCode,
  type StepError,
} from '../errors/step-errors.js';
import { createLogger } from '@abl/compiler/platform';
import { scrubTraceEvent } from '@abl/compiler';
import {
  decrementParked,
  incrementParked,
  recordEnvelopeBytes,
  recordExtractionRateLimited,
  recordExtractionWaitMs,
} from '../observability/extraction-metrics.js';

const log = createLogger('workflow-engine:handler');
import {
  buildTimeoutDecision,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalStep,
} from '../executors/approval-executor.js';
import {
  buildTimeoutResponse,
  type HumanTaskRequest,
  type HumanTaskResponse,
  type HumanTaskStep,
} from '../executors/human-task-executor.js';
import {
  getAsyncWebhookTimeout,
  type AsyncWebhookRequest,
  type AsyncWebhookStep,
} from '../executors/async-webhook-executor.js';
import type { LoopStep } from '../executors/loop-executor.js';
import type { BranchRunner, ParallelBranch } from '../executors/parallel-executor.js';
import {
  executeDag,
  getDagSkippedStepIds,
  WorkflowTerminatedError,
  type StepOutcome,
} from '../executors/dag-executor.js';
import {
  dispatchStep,
  resolveStepInput,
  type WorkflowStep,
  type StepDispatcherDeps,
  type StepDispatchResult,
  type RetryConfig,
} from './step-dispatcher.js';
import type {
  EdgeDescriptor,
  OutputMapping,
  OutputMappingsByEndNodeId,
  StartInputVariable,
} from './canvas-to-steps.js';
import { validateAndCoerceInput, type FieldError } from '../validation/start-input-validator.js';
import {
  resolveOutputMappings,
  type OutputMappingError,
} from '../validation/output-mapping-validator.js';
import {
  assertUrlSafeForFetch,
  safeFetch,
} from '@agent-platform/shared-kernel/security/safe-fetch';
import * as restate from '@restatedev/restate-sdk';

export type { OutputMapping, StartInputVariable };

/** Input to start a workflow execution */
export interface WorkflowExecutionInput {
  workflowId: string;
  workflowVersionId?: string;
  workflowVersion?: string;
  workflowName: string;
  tenantId: string;
  projectId: string;
  triggerType: string;
  triggerPayload: Record<string, unknown>;
  triggerMetadata?: Record<string, unknown>;
  steps: WorkflowStep[];
  /** Map from node name → node ID for name-based step references */
  nameToIdMap?: Record<string, string>;
  /** Output variable mappings from the end node */
  outputMappings?: OutputMapping[];
  /** Output mappings grouped by source top-level end node ID. */
  outputMappingsByEndNodeId?: OutputMappingsByEndNodeId;
  /**
   * Input variables declared on the canvas start node. The handler validates
   * and coerces `triggerPayload` against these at workflow start. Forwarded
   * from every fire path (execute route, trigger-engine, trigger-scheduler)
   * via `buildWorkflowExecutionPayload`.
   */
  startInputVariables?: StartInputVariable[];
  /** Pre-computed in-degree map from canvas-to-steps conversion. Absent = sequential fallback. */
  inDegreeMap?: Record<string, number>;
  /** Edge descriptor map for backend-authoritative edge pathState computation. */
  edgeMap?: Record<string, EdgeDescriptor[]>;
  /** Webhook execution metadata — set by trigger engine for webhook-fired runs */
  webhookMode?: 'sync' | 'async';
  webhookDelivery?: 'poll' | 'push';
}

/** Result of a completed workflow execution */
interface WorkflowExecutionResult {
  status: 'completed' | 'failed' | 'rejected' | 'cancelled';
  context: WorkflowContextData;
  error?: { code: string; message: string };
  /** Resolved output variables from the end node */
  output?: Record<string, unknown>;
  startTime?: string;
  endTime?: string;
}

interface AsyncToolWaitRequest {
  toolName: string;
  params: Record<string, unknown>;
  callbackUrl: string;
  executionMode: 'async_wait';
  callbackConfig?: import('../executors/tool-call-executor.js').ToolCallbackConfig;
  asyncHttpSuccess?: import('../executors/tool-call-executor.js').ToolAsyncHttpSuccessConfig;
}

interface AsyncToolCallbackPayload {
  executionId?: string;
  status?: string;
  output?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

/** Persistence interface — implemented by ExecutionStore (Task 4.8) */
export interface ExecutionPersistence {
  createExecution(input: {
    executionId: string;
    tenantId: string;
    projectId: string;
    workflowId: string;
    workflowVersionId?: string;
    workflowVersion?: string;
    status: string;
    triggerType: string;
    triggerPayload: Record<string, unknown>;
    triggerMetadata?: Record<string, unknown>;
    steps: Array<{
      stepId: string;
      name: string;
      type: string;
      status: string;
      /** Loop step config — mode and concurrencyLimit stored in the initial context.steps entry */
      loopConfig?: { mode?: 'sequential' | 'parallel'; concurrencyLimit?: number };
    }>;
    webhookMode?: 'sync' | 'async';
    webhookDelivery?: 'poll' | 'push';
    /** Relay-race: full execution input snapshot for leg cold-start. */
    inputSnapshot?: unknown;
  }): Promise<void>;

  // ─── Relay-race methods (Phase 1) ───────────────────────────────────────────

  /**
   * Lightweight cancellation check — projects only {status, cancelledAt} so the
   * full inputSnapshot (potentially MBs) is never fetched on every step boundary
   * (I-2/I-4). Use this for step-boundary and loop-body cancellation checks;
   * reserve getExecutionForLeg for leg cold-start where context is needed.
   */
  getExecutionCancellationStatus?(
    executionId: string,
    tenantId: string,
    projectId: string,
  ): Promise<{ status: string; cancelledAt?: Date } | null>;

  getExecutionForLeg?(
    executionId: string,
    tenantId: string,
    projectId: string,
  ): Promise<{
    status: string;
    inputSnapshot: unknown;
    context: Record<string, unknown>;
    cancelledAt?: Date;
  } | null>;

  atomicBarrierIncrement?(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
  ): Promise<number>;

  /**
   * Atomically increment barrierFailCount on a join step.
   * Returns the new fail count. Used by wait_all / ignore_errors branches
   * to track how many branches failed without stopping the other branches.
   */
  atomicBarrierFailIncrement?(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
  ): Promise<number>;

  initStepBarrier?(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
    barrierTotal: number,
  ): Promise<void>;

  parkStep?(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
    parkData: {
      status: string;
      parkPoint: true;
      branchId?: string;
      callbackSecret?: string;
      /** Successor step IDs (approve / callback path). */
      nextStepIds?: string[];
      /** Rejection path step IDs — approval on_reject edge. */
      rejectStepIds?: string[];
      /** Phase 4: join step ID carried to the resumed leg for barrier check. */
      joinStepId?: string;
      /** Phase 4: barrier total carried to the resumed leg. */
      barrierTotal?: number;
      /** Phase 5: failure strategy carried to resumed legs for correct branch failure handling. */
      failureStrategy?: 'fail_fast' | 'wait_all' | 'ignore_errors';
    },
  ): Promise<void>;

  atomicBarrierFailIncrement?(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
  ): Promise<number>;

  // ── Phase 6 — Loop data methods ────────────────────────────────────────
  storeLoopData?(
    executionId: string,
    tenantId: string,
    projectId: string,
    loopKey: string,
    data: {
      items: unknown[];
      itemVariable: string;
      bodyStepIds: string[];
      bodyInDegreeMap?: Record<string, number>;
      joinStepId?: string;
      totalIterations: number;
      concurrencyLimit: number;
      ignoreErrors: boolean;
    },
  ): Promise<void>;

  readLoopData?(
    executionId: string,
    tenantId: string,
    projectId: string,
    loopKey: string,
  ): Promise<{
    items: unknown[];
    itemVariable: string;
    bodyStepIds: string[];
    bodyInDegreeMap?: Record<string, number>;
    joinStepId?: string;
    totalIterations: number;
    concurrencyLimit: number;
    ignoreErrors: boolean;
    nextDispatchIndex: number;
  } | null>;

  resolveParkedStep?(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
    expectedStatus: string,
    result: {
      completedAt?: string;
      output?: unknown;
      decision?: string;
      fields?: Record<string, unknown>;
      respondedBy?: string;
      notes?: string;
    },
  ): Promise<boolean>;

  incrementLegCounter?(executionId: string, tenantId: string, projectId: string): Promise<number>;

  updateStepStatus(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepId: string,
    status: string,
    data?: {
      /** Key in context.steps to write — enables per-step dot-notation $set */
      stepKey?: string;
      /** Step data to write at context.steps[stepKey] */
      stepData?: WorkflowStepData;
      /**
       * Full workflow context — context.steps is the single source of truth
       * for step display data. Individual step fields are no longer mirrored
       * in nodeExecutions; callers should pass context on every transition.
       */
      context?: WorkflowContextData;
      /** Plaintext HMAC secret for async webhook callback verification */
      callbackSecret?: string;
      // Legacy params accepted but ignored — context.steps is the source of truth
      nodeType?: string;
      output?: unknown;
      durationMs?: number;
      error?: unknown;
      input?: unknown;
      metrics?: { responseTimeMs?: number; processingTimeMs?: number };
      consoleLogs?: Array<{ level: string; args: unknown[] }>;
      mappingErrors?: Array<{ name: string; expression?: string; error: string }>;
    },
  ): Promise<void>;

  updateExecutionStatus(
    executionId: string,
    tenantId: string,
    projectId: string,
    status: string,
    data?: {
      context?: WorkflowContextData;
      error?: unknown;
      completedAt?: Date;
      output?: Record<string, unknown>;
      startTime?: string;
      endTime?: string;
    },
  ): Promise<void>;
}

/** Event publisher interface — for Redis Pub/Sub or similar */
export interface StatusPublisher {
  publish(channel: string, message: string): Promise<void>;
}

/**
 * Factory for building connector deps.
 *
 * Called once per workflow execution to build legacy `connectorDeps` (no
 * workflow context — used by non-step callers and by tests) and may be called
 * a second time per-step with the live workflow context so the resulting
 * `ConnectorToolExecutor` carries `workflowExecutionId` / `stepId` / optional
 * `callbackContext`. The per-step path is what lets the
 * `extract_document` action construct an `AsyncParkingSentinel` whose
 * callbackId is `stepId`.
 */
export type ConnectorDepsFactory = (
  tenantId: string,
  projectId: string,
  workflowExecutionId?: string,
  stepId?: string,
  callbackContext?: import('@agent-platform/connectors').CallbackContext,
) => import('../executors/connector-action-executor.js').ConnectorActionDeps;

/** Minimal interface for Restate context operations needed by the handler.
 * Mirrors the subset of restate.WorkflowContext used for durable execution:
 * sleep, run (durable side-effects), and durable promises.
 */
/** A Restate promise that supports durable timeout via .orTimeout(). */
export interface RestatePromiseHandle<T> extends Promise<T> {
  orTimeout(millis: number): RestatePromiseHandle<T>;
}

export interface RestateWorkflowCtx {
  sleep(duration: number): RestatePromiseHandle<void>;
  /** Durable side-effect — Restate guarantees exactly-once execution across retries */
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  promise<T>(name: string): DurablePromiseHandle<T>;
  /**
   * Create a Restate awakeable — a durable promise resolved via the built-in
   * /restate/awakeables/:id/resolve ingress endpoint (no shared-handler dispatch).
   * Used as an alternative to ctx.promise() to bypass the 1.6.2 re-dispatch bug.
   */
  awakeable<T>(): { id: string; promise: RestatePromiseHandle<T> };
}

/** Mirrors restate DurablePromise — a thenable that suspends on await,
 * plus peek (non-blocking), resolve (signal), and get() for RestatePromise. */
export interface DurablePromiseHandle<T> extends Promise<T> {
  peek(): Promise<T | undefined>;
  resolve(value?: T): Promise<void>;
  /** Get a RestatePromise variant that supports .orTimeout() */
  get(): RestatePromiseHandle<T>;
}

/** Dependencies for the workflow handler */
/** Store for creating HumanTask records during workflow execution */
export interface HumanTaskStore {
  createTask(
    params: import('../persistence/human-task-store.js').CreateHumanTaskParams,
  ): Promise<{ _id: string }>;
  findBySource(
    tenantId: string,
    projectId: string,
    sourceType: string,
    sourceFilter: Record<string, unknown>,
  ): Promise<{ _id: string; projectId: string } | null>;
  updateTaskStatus(
    taskId: string,
    tenantId: string,
    projectId: string,
    status: string,
    extra?: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * Surface required to load a memory projection at workflow start. Phase 4
 * introduces `RuntimeMemoryClient` which implements this interface; Phase 3
 * defines the surface so `buildWorkflowContext` can be called with or without
 * a real client. When no loader is supplied, the projection defaults to empty
 * scopes and `user: undefined`.
 */
export interface MemoryProjectionLoader {
  loadProjection(req: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    endUserId?: string;
  }): Promise<MemoryProjection>;
}

export interface WorkflowHandlerDeps {
  persistence: ExecutionPersistence;
  publisher: StatusPublisher;
  dispatcherDeps: StepDispatcherDeps;
  connectorDepsFactory?: ConnectorDepsFactory;
  humanTaskStore?: HumanTaskStore;
  callbackQueue?: {
    add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  };
  /** Encrypts a plaintext secret for per-tenant storage — used to persist callbackSecret */
  encryptSecret?: (plaintext: string, tenantId: string) => Promise<string>;
  /** Decrypts a tenant-scoped secret — used to recover plainCallbackSecret from ciphertext during Restate replay */
  decryptSecret?: (ciphertext: string, tenantId: string) => Promise<string>;
  /**
   * Optional. When supplied, `buildWorkflowContext` calls
   * `loadProjection({...})` to populate `context.memory`. On loader failure
   * the workflow run fails fast (no swallowed errors). When omitted, the
   * memory projection defaults to empty scopes — function-node memory ops
   * will throw STORAGE_UNAVAILABLE in Phase 4 (signals a wiring miss).
   */
  memoryClient?: MemoryProjectionLoader;
  /**
   * Optional. Receives extraction audit events emitted by the connector_action
   * suspension block (Phase 4 task 4.7b). Defaults to a structured-log sink at
   * the engine boot site; tests inject an array-collector sink.
   */
  extractionAuditEmitter?: import('../services/extraction-audit-events.js').ExtractionAuditEmitter;
  /**
   * Relay-race: triggers a new relay run via the Restate ingress.
   * Injected by restate-endpoint.ts from the RestateWorkflowClient.
   * Used for parallel fan-out (each branch is a separate run), barrier-triggered
   * join steps, and delay timer scheduling.
   * Optional — absent in the legacy runWorkflow() path.
   */
  startWorkflow?: (
    executionId: string,
    input: WorkflowRunInput,
    options?: { delayMs?: number },
  ) => Promise<void>;
}

/**
 * Build the initial workflow context from execution input.
 * Populates `steps.start` with the trigger payload so it's accessible
 * as `context.steps.start.input` in expressions.
 *
 * When `coerced` is provided (post-Start-phase validation), it is used for
 * `steps.start.output` so downstream expressions can read the typed value from
 * `{{context.steps.start.output.amount}}` (e.g. `100` not `"100"`). Trigger
 * input is not duplicated at the context root.
 */
export function buildWorkflowContext(
  input: WorkflowExecutionInput,
  executionId: string,
  coerced?: Record<string, unknown>,
): WorkflowContextData {
  const startOutput = { ...(coerced ?? input.triggerPayload ?? {}) };
  // Re-project agent metadata defensively — the inbound `triggerMetadata` is
  // untrusted (older runtime versions, malformed JSON). materializeX returns
  // undefined for missing/invalid input, which is the correct shape for an
  // agent-less webhook/cron run.
  const agentSession = materializeAgentSession(input.triggerMetadata?.agentSession);
  const agentContext = materializeAgentContext(input.triggerMetadata?.agentContext);
  return {
    trigger: {
      type: input.triggerType,
      payload: input.triggerPayload,
      metadata: input.triggerMetadata,
    },
    workflow: {
      id: input.workflowId,
      name: input.workflowName,
      executionId,
    },
    tenant: {
      tenantId: input.tenantId,
      projectId: input.projectId,
    },
    steps: {
      // Populate start node so {{context.steps.start.input}} works.
      // `input` is ALWAYS the raw trigger payload — that is the canonical
      // record of what the caller sent. `output` is the coerced variable map
      // when validation ran, falling back to the raw payload for legacy
      // callers. The delta between input and output is the coercion story
      // visible in the Debug Flow Log.
      start: buildCleanStepContext(
        'start',
        {
          nodeType: 'start',
          stepId: 'start',
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        { input: input.triggerPayload, output: startOutput },
      ),
    },
    ...(agentSession ? { agentSession } : {}),
    ...(agentContext ? { agentContext } : {}),
  };
}

/**
 * Default empty memory projection. Used when no memory client is wired —
 * `memory.workflow.foo` resolves to undefined, agent-less runs see clean
 * scopes, and Phase-4 function-node writes throw STORAGE_UNAVAILABLE
 * (the empty default is a read-side fallback, not a write-side one).
 */
export function emptyMemoryProjection(): MemoryProjection {
  return { workflow: {}, project: {}, user: undefined };
}

/**
 * Load a memory projection if `memoryClient` is supplied; otherwise return
 * the empty default. Failures from the loader propagate — workflow runs that
 * cannot read memory must fail fast rather than silently using a stale or
 * empty projection.
 */
export async function loadMemoryProjection(
  input: WorkflowExecutionInput,
  memoryClient?: MemoryProjectionLoader,
): Promise<MemoryProjection> {
  if (!memoryClient) return emptyMemoryProjection();
  const endUserId =
    typeof input.triggerMetadata?.agentSession === 'object' &&
    input.triggerMetadata.agentSession !== null
      ? (input.triggerMetadata.agentSession as Record<string, unknown>).endUserId
      : undefined;
  return memoryClient.loadProjection({
    tenantId: input.tenantId,
    projectId: input.projectId,
    workflowId: input.workflowId,
    ...(typeof endUserId === 'string' ? { endUserId } : {}),
  });
}

/**
 * Set step data in context keyed by node name, injecting stepId so routes
 * can find a step by its UUID via Object.values(context.steps).
 */
function setStepContext(
  ctx: WorkflowContextData,
  step: WorkflowStep,
  data: WorkflowStepData,
): void {
  ctx.steps[step.name ?? step.id] = { ...data, stepId: step.id } as WorkflowStepData;
}

/**
 * Get the existing step context data by node name (falling back to UUID).
 */
function getStepContext(
  ctx: WorkflowContextData,
  step: WorkflowStep,
): WorkflowStepData | undefined {
  return ctx.steps[step.name ?? step.id];
}

/**
 * Returns { stepKey, stepData } for updateStepStatus calls.
 * setStepContext MUST be called before this so getStepContext returns the latest data.
 */
function stepPersistArgs(
  ctx: WorkflowContextData,
  step: WorkflowStep,
): { stepKey: string; stepData: WorkflowStepData } {
  return { stepKey: step.name ?? step.id, stepData: getStepContext(ctx, step)! };
}

function normalizeTemplatePath(value: string): string {
  const trimmed = value.trim();
  const match = /^\{\{\s*(.+?)\s*\}\}$/.exec(trimmed);
  if (match) return match[1].trim();

  const embeddedMatch = /\{\{\s*(.+?)\s*\}\}/.exec(trimmed);
  return embeddedMatch ? embeddedMatch[1].trim() : trimmed;
}

function setNestedOutputValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter((part) => part.length > 0);
  if (parts.length === 0) return;

  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return;

    const current = cursor[part];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1];
  if (leaf === '__proto__' || leaf === 'constructor' || leaf === 'prototype') return;
  cursor[leaf] = value;
}

// Write path policy for loop outputs and transforms:
//   ALLOWED  - context.<any non-system key>     e.g. context.results, vars.x
//   ALLOWED  - context.steps.start.input.*      feed data back into the start step's input
//   BLOCKED  - context.steps (root replacement, or any path inside steps other than start.input)
//   BLOCKED  - context.trigger / workflow / tenant at any depth
//   BLOCKED  - loop iteration variables (same policy as function node writes)
function setContextVariablePath(ctx: WorkflowContextData, path: string, value: unknown): void {
  const rootKey = path.split('.')[0];
  if (!rootKey) {
    throw new WorkflowStepError(
      StepErrorCode.SCRIPT_ERROR,
      `Cannot write immutable context property: ${path}`,
    );
  }
  if (isFullyImmutableContextWriteRoot(rootKey)) {
    throw new WorkflowStepError(
      StepErrorCode.SCRIPT_ERROR,
      `Cannot write immutable context property: ${rootKey}`,
    );
  }
  if (rootKey === 'steps') {
    // Only context.steps.start.input.* is writable; everything else is immutable
    if (!isMutableStartInputContextPath(path)) {
      throw new WorkflowStepError(
        StepErrorCode.SCRIPT_ERROR,
        `Cannot write immutable context property: ${path}`,
      );
    }
  }
  // Block loop iteration variables — same policy as function node writes
  if (isFunctionContextImmutableWriteKey(ctx, rootKey)) {
    throw new WorkflowStepError(
      StepErrorCode.SCRIPT_ERROR,
      `Cannot write immutable context property: ${rootKey}`,
    );
  }
  setNestedOutputValue(ctx as Record<string, unknown>, path, value);
}

function applyLoopOutputField(
  ctx: WorkflowContextData,
  loopOutput: Record<string, unknown>,
  outputField: string | undefined,
  mappedOutputs: Array<Record<string, unknown> | null>,
): void {
  if (!outputField || outputField.trim().length === 0) return;

  const normalized = normalizeTemplatePath(outputField);
  if (normalized.length === 0) return;

  if (normalized.startsWith('context.vars.')) {
    setContextVariablePath(ctx, normalized.slice('context.'.length), mappedOutputs);
    return;
  }

  if (normalized.startsWith('vars.')) {
    setContextVariablePath(ctx, normalized, mappedOutputs);
    return;
  }

  if (normalized.startsWith('context.')) {
    const path = normalized.slice('context.'.length);
    setContextVariablePath(ctx, path, mappedOutputs);
    return;
  }

  if (!normalized.includes('.')) {
    loopOutput[normalized] = mappedOutputs;
  }
}

function collectLoopIterationDebugSteps(
  parentCtx: WorkflowContextData,
  iterationCtx: WorkflowContextData,
): Record<string, Record<string, unknown>> {
  const steps: Record<string, Record<string, unknown>> = {};
  for (const [stepKey, stepCtx] of Object.entries(iterationCtx.steps)) {
    if (parentCtx.steps[stepKey]) continue;
    const publicStep = sanitizePublishedStepData(stepCtx as Record<string, unknown> | undefined);
    if (publicStep) steps[stepKey] = publicStep;
  }
  return steps;
}

function collectLoopIterationMetricSteps(
  parentCtx: WorkflowContextData,
  iterationCtx: WorkflowContextData,
): Record<string, Record<string, unknown>> {
  const steps: Record<string, Record<string, unknown>> = {};
  for (const [stepKey, stepCtx] of Object.entries(iterationCtx.steps)) {
    if (parentCtx.steps[stepKey]) continue;
    const stepRecord = stepCtx as Record<string, unknown>;
    const output = stepRecord.output as Record<string, unknown> | undefined;
    const branchTaken =
      output && typeof output.branchTaken === 'string' ? output.branchTaken : undefined;
    steps[stepKey] = {
      stepId: stepRecord.stepId,
      status: stepRecord.status,
      ...(stepRecord.startedAt !== undefined ? { startedAt: stepRecord.startedAt } : {}),
      ...(stepRecord.completedAt !== undefined ? { completedAt: stepRecord.completedAt } : {}),
      ...(stepRecord.durationMs !== undefined ? { durationMs: stepRecord.durationMs } : {}),
      ...(branchTaken !== undefined ? { output: { branchTaken } } : {}),
    };
  }
  return steps;
}

function syncParentStepsIntoLoopIteration(
  parentCtx: WorkflowContextData,
  iterationCtx: WorkflowContextData,
  iterationOwnedStepKeys: Set<string>,
): void {
  for (const [stepKey, stepCtx] of Object.entries(parentCtx.steps)) {
    if (iterationOwnedStepKeys.has(stepKey)) continue;
    iterationCtx.steps[stepKey] = stepCtx;
  }
}

function promoteFunctionWritesToParentContext(
  parentCtx: WorkflowContextData,
  output: unknown,
): void {
  if (output == null || typeof output !== 'object' || Array.isArray(output)) return;

  const writes = output as Record<string, unknown>;
  for (const [key, value] of Object.entries(writes)) {
    if (isFunctionContextImmutableWriteKey(parentCtx, key)) {
      throw new WorkflowStepError(
        StepErrorCode.SCRIPT_ERROR,
        `Cannot promote immutable context property from function output: ${key}`,
      );
    }
    (parentCtx as Record<string, unknown>)[key] = value;
  }
}

function getLoopBodyStepIds(body: string[], bodyInDegreeMap?: Record<string, number>): string[] {
  return [...new Set([...body, ...Object.keys(bodyInDegreeMap ?? {})])];
}

function getStepConfiguredSuccessors(step: WorkflowStep): string[] {
  const genericStep = step as WorkflowStep & {
    thenSteps?: string[];
    elseSteps?: string[];
    conditions?: Array<{ targetSteps?: string[] }>;
    branches?: Array<{ steps?: string[] }>;
  };
  return [
    ...(step.onSuccessSteps ?? []),
    ...(step.onFailureSteps ?? []),
    ...(step.onRejectSteps ?? []),
    ...(genericStep.thenSteps ?? []),
    ...(genericStep.elseSteps ?? []),
    ...(genericStep.conditions ?? []).flatMap((condition) => condition.targetSteps ?? []),
    ...(genericStep.branches ?? []).flatMap((branch) => branch.steps ?? []),
  ];
}

function getAllLoopBodyStepIds(steps: WorkflowStep[]): Set<string> {
  const stepIndex = new Map(steps.map((step) => [step.id, step]));
  const loopBodyStepIds = new Set<string>();
  const visitBodyStep = (stepId: string): void => {
    if (loopBodyStepIds.has(stepId)) return;
    loopBodyStepIds.add(stepId);
    const step = stepIndex.get(stepId);
    if (!step) return;
    for (const successorId of getStepConfiguredSuccessors(step)) {
      visitBodyStep(successorId);
    }
    if (step.type === 'loop') {
      const loopStep = step as LoopStep;
      for (const nestedBodyStepId of getLoopBodyStepIds(
        loopStep.config.body ?? [],
        loopStep.config.bodyInDegreeMap,
      )) {
        visitBodyStep(nestedBodyStepId);
      }
    }
  };

  for (const step of steps) {
    if (step.type !== 'loop') continue;
    const loopStep = step as LoopStep;
    for (const stepId of getLoopBodyStepIds(
      loopStep.config.body ?? [],
      loopStep.config.bodyInDegreeMap,
    )) {
      visitBodyStep(stepId);
    }
  }
  return loopBodyStepIds;
}

function cloneContextForLoopIteration(
  ctx: WorkflowContextData,
  itemVariable: string,
  item: unknown,
  index: number,
  count: number,
): WorkflowContextData {
  return {
    ...getContextVariables(ctx),
    trigger: ctx.trigger,
    workflow: ctx.workflow,
    tenant: ctx.tenant,
    steps: { ...ctx.steps },
    [itemVariable]: item,
    [`${itemVariable}_index`]: index,
    [`${itemVariable}_count`]: count,
  };
}

function createLoopScopedDeps(
  deps: WorkflowHandlerDeps,
  branchRunner: BranchRunner,
  onStepStatusUpdate: (
    stepId: string,
    status: string,
    data: Parameters<ExecutionPersistence['updateStepStatus']>[5],
  ) => Promise<void>,
): WorkflowHandlerDeps {
  return {
    ...deps,
    persistence: {
      createExecution: async () => {},
      updateStepStatus: async (_executionId, _tenantId, _projectId, stepId, status, data) => {
        await onStepStatusUpdate(stepId, status, data);
      },
      updateExecutionStatus: async () => {},
    },
    publisher: {
      publish: async () => {},
    },
    dispatcherDeps: {
      ...deps.dispatcherDeps,
      branchRunner,
    },
  };
}

// Fields stripped from stepData before publishing to Redis pub/sub.
// Fields that must not cross the service boundary to Studio WebSocket clients.
// Keep in sync with STEP_SENSITIVE_FIELDS in workflow-executions.ts (REST API)
// and SNAPSHOT_STEP_SENSITIVE_FIELDS in wf-bridge.ts (WS snapshot).
//
// Credentials: callbackSecret (HMAC signing key), awakeableId (Restate handle).
// Orchestration internals: parkPoint, nextStepIds, rejectStepIds, joinStepId,
//   barrierTotal, barrierCount, branchId, failureStrategy.
//
// Connector action output (step.output) is intentionally NOT stripped — Studio
// is project-scoped and authenticated, so full connector API responses are
// visible to the workflow designer for debugging. This is the accepted policy
// (data-flow-audit F-1, docs/sdlc-logs/ws-relocation/data-flow-audit.md).
const PUBLISH_SENSITIVE_STEP_FIELDS = new Set([
  'callbackSecret',
  'awakeableId',
  'parkPoint',
  'nextStepIds',
  'rejectStepIds',
  'joinStepId',
  'barrierTotal',
  'barrierCount',
  'barrierFailCount',
  'branchId',
  'failureStrategy',
]);

/**
 * Strip engine-internal and credential fields from step data before publishing
 * to the Redis status channel. controlFlow is routing metadata; sensitive fields
 * are credentials that must not reach Studio WS clients.
 */
function sanitizePublishedStepData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) return {};
  const { controlFlow: _cf, ...rest } = data;
  void _cf;
  if (PUBLISH_SENSITIVE_STEP_FIELDS.size === 0) return rest;
  return Object.fromEntries(
    Object.entries(rest).filter(([k]) => !PUBLISH_SENSITIVE_STEP_FIELDS.has(k)),
  );
}

const EDGE_ACTIVE_STATUSES = new Set([
  'running',
  'waiting_approval',
  'waiting_human_task',
  'waiting_delay',
  'waiting_callback',
]);
const EDGE_TERMINAL_STATUSES = new Set(['completed', 'failed', 'rejected', 'skipped', 'cancelled']);
const FAILURE_HANDLES = new Set(['on_failure', 'on_timeout']);
const REJECT_HANDLES = new Set(['on_reject', 'on_decline']);

/**
 * Compute outer edge pathState from ctx.steps (skips loop body edges tagged with loopId).
 * Optionally merges `extraStatuses` for steps not yet in outer ctx.steps.
 */
function computePathState(
  ctxSteps: Record<string, unknown>,
  edgeMap: Record<string, EdgeDescriptor[]>,
  extraStatuses?: Map<string, string>,
): Record<string, 'running' | 'completed'> {
  const statusById = new Map<string, string>(extraStatuses);
  // branchTaken per step ID — populated for condition nodes from their output
  const branchTakenById = new Map<string, string>();
  for (const stepData of Object.values(ctxSteps)) {
    const sd = stepData as Record<string, unknown> | null | undefined;
    if (sd && typeof sd.stepId === 'string' && typeof sd.status === 'string') {
      statusById.set(sd.stepId, sd.status);
      const output = sd.output as Record<string, unknown> | undefined;
      if (output && typeof output.branchTaken === 'string') {
        branchTakenById.set(sd.stepId, output.branchTaken);
      }
    }
  }
  const pathState: Record<string, 'running' | 'completed'> = {};
  for (const [sourceId, edges] of Object.entries(edgeMap)) {
    const branchTaken = branchTakenById.get(sourceId);
    const sourceStatus = statusById.get(edges[0]?.sourceRuntimeId ?? sourceId);
    if (!sourceStatus || !EDGE_TERMINAL_STATUSES.has(sourceStatus)) continue;
    for (const edge of edges) {
      if (edge.loopId) continue; // body edges are computed per-iteration
      // For condition nodes: only the taken branch edge should be highlighted.
      if (branchTaken !== undefined && edge.sourceHandle !== branchTaken) continue;
      if (sourceStatus === 'failed' && !FAILURE_HANDLES.has(edge.sourceHandle ?? '')) continue;
      if (sourceStatus === 'rejected' && !REJECT_HANDLES.has(edge.sourceHandle ?? '')) continue;
      if (
        (sourceStatus === 'completed' || sourceStatus === 'skipped') &&
        edge.sourceHandle !== undefined &&
        edge.sourceHandle !== 'on_success' &&
        edge.sourceHandle !== 'on_approve' &&
        !(edge.sourceNodeType === 'loop' && edge.sourceHandle === 'on_complete')
      ) {
        continue;
      }
      const tStatus = statusById.get(edge.targetRuntimeId ?? edge.target);
      if (!tStatus) continue;
      if (EDGE_ACTIVE_STATUSES.has(tStatus)) pathState[edge.edgeId] = 'running';
      else if (EDGE_TERMINAL_STATUSES.has(tStatus)) pathState[edge.edgeId] = 'completed';
    }
  }
  return pathState;
}

/**
 * Compute body edge pathState per iteration for a single loop node.
 * Returns { [iterationIndex]: { [edgeId]: 'running'|'completed' } }.
 * Uses string keys for iteration index since JSON serializes number keys as strings.
 */
function computeIterationPathState(
  loopStepId: string,
  iterationExecutions: Array<{
    currentIndex: number;
    steps: Record<string, Record<string, unknown>>;
  }>,
  edgeMap: Record<string, EdgeDescriptor[]>,
): Record<string, Record<string, 'running' | 'completed'>> {
  const result: Record<string, Record<string, 'running' | 'completed'>> = {};
  for (const iter of iterationExecutions) {
    const stepStatuses = new Map<string, string>();
    // branchTaken per step ID — populated for condition nodes from their output
    const stepBranchTaken = new Map<string, string>();
    for (const sd of Object.values(iter.steps)) {
      if (typeof sd.stepId === 'string' && typeof sd.status === 'string') {
        stepStatuses.set(sd.stepId, sd.status);
        const output = sd.output as Record<string, unknown> | undefined;
        if (output && typeof output.branchTaken === 'string') {
          stepBranchTaken.set(sd.stepId, output.branchTaken);
        }
      }
    }
    const iterPathState: Record<string, 'running' | 'completed'> = {};
    for (const [sourceId, edges] of Object.entries(edgeMap)) {
      const branchTaken = stepBranchTaken.get(sourceId);
      for (const edge of edges) {
        if (edge.loopId !== loopStepId) continue;
        const sourceStatus = stepStatuses.get(edge.sourceRuntimeId ?? sourceId);
        const isSyntheticLoopStartSource = edge.sourceNodeType === 'loop_start';
        if (
          !isSyntheticLoopStartSource &&
          (!sourceStatus || !EDGE_TERMINAL_STATUSES.has(sourceStatus))
        ) {
          continue;
        }
        // For condition nodes: only the taken branch edge should be highlighted.
        // If branchTaken is unavailable, fail closed instead of marking every
        // condition target whose step happens to have a terminal status.
        if (edge.sourceNodeType === 'condition') {
          if (branchTaken === undefined || edge.sourceHandle !== branchTaken) continue;
        }
        const tStatus = stepStatuses.get(edge.targetRuntimeId ?? edge.target);
        if (!tStatus) continue;
        if (EDGE_ACTIVE_STATUSES.has(tStatus)) iterPathState[edge.edgeId] = 'running';
        else if (EDGE_TERMINAL_STATUSES.has(tStatus)) iterPathState[edge.edgeId] = 'completed';
      }
    }
    if (Object.keys(iterPathState).length > 0) {
      result[String(iter.currentIndex)] = iterPathState;
    }
  }
  return result;
}

function computeAllIterationPathState(
  ctxSteps: Record<string, unknown>,
  edgeMap: Record<string, EdgeDescriptor[]>,
): Record<string, Record<string, Record<string, 'running' | 'completed'>>> {
  const loopIds = new Set<string>();
  for (const edges of Object.values(edgeMap)) {
    for (const edge of edges) {
      if (edge.loopId) loopIds.add(edge.loopId);
    }
  }

  const result: Record<string, Record<string, Record<string, 'running' | 'completed'>>> = {};
  for (const loopId of loopIds) {
    const loopStepData = Object.values(ctxSteps).find((stepData) => {
      const sd = stepData as Record<string, unknown> | null | undefined;
      return sd && sd.stepId === loopId;
    }) as Record<string, unknown> | undefined;
    const loopContext = loopStepData?.loopContext;
    if (!Array.isArray(loopContext)) continue;

    const iterations = loopContext.flatMap((entry) => {
      const iter = entry as Record<string, unknown> | null | undefined;
      if (!iter || typeof iter.currentIndex !== 'number' || typeof iter.steps !== 'object') {
        return [];
      }
      return [
        {
          currentIndex: iter.currentIndex,
          steps: iter.steps as Record<string, Record<string, unknown>>,
        },
      ];
    });

    const iterPathState = computeIterationPathState(loopId, iterations, edgeMap);
    if (Object.keys(iterPathState).length > 0) {
      result[loopId] = iterPathState;
    }
  }

  return result;
}

function mergeIterationPathStates(
  base: Record<string, Record<string, Record<string, 'running' | 'completed'>>>,
  override: unknown,
): Record<string, Record<string, Record<string, 'running' | 'completed'>>> {
  if (!override || typeof override !== 'object') return base;

  const merged = { ...base };
  for (const [loopId, iterMap] of Object.entries(
    override as Record<string, Record<string, Record<string, 'running' | 'completed'>>>,
  )) {
    merged[loopId] = { ...(merged[loopId] ?? {}), ...iterMap };
  }
  return merged;
}

/**
 * Rebuild step context via buildCleanStepContext, merging existing base fields
 * with provided overrides. Strips controlFlow and sanitizes type-specific fields.
 * Pass `output` explicitly to override; omit to carry forward existing output.
 */
function rebuildStepContext(
  stepType: string,
  existing: WorkflowStepData | undefined,
  overrides: {
    status?: string;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    error?: { code: string; message: string };
    output?: unknown;
    metrics?: { responseTimeMs?: number; processingTimeMs?: number };
    consoleLogs?: Array<{ level: string; args: unknown[] }>;
    callbackSecret?: string;
    awakeableId?: string;
    loopContext?: unknown;
    /** Resolved delay for delay steps — persisted on DelayStepContext.delayMs */
    delayMs?: number;
  } = {},
): WorkflowStepData {
  const fields: Record<string, unknown> = {};
  if (existing?.input != null) fields.input = existing.input;
  const output = 'output' in overrides ? overrides.output : existing?.output;
  if (output != null) fields.output = output;
  const metrics = overrides.metrics ?? existing?.metrics;
  if (metrics != null) fields.metrics = metrics;
  const consoleLogs = overrides.consoleLogs ?? existing?.consoleLogs;
  if (consoleLogs != null) fields.consoleLogs = consoleLogs;
  if (existing?.mappingErrors != null) fields.mappingErrors = existing.mappingErrors;
  const callbackSecret =
    overrides.callbackSecret ??
    (existing as { callbackSecret?: string } | undefined)?.callbackSecret;
  if (callbackSecret !== undefined) fields.callbackSecret = callbackSecret;
  const awakeableId =
    overrides.awakeableId ?? (existing as { awakeableId?: string } | undefined)?.awakeableId;
  if (awakeableId !== undefined) fields.awakeableId = awakeableId;
  const delayMs = overrides.delayMs ?? (existing as { delayMs?: number } | undefined)?.delayMs;
  if (delayMs !== undefined) fields.delayMs = delayMs;
  const loopContext =
    'loopContext' in overrides
      ? overrides.loopContext
      : (existing as { loopContext?: unknown } | undefined)?.loopContext;
  if (loopContext !== undefined) fields.loopContext = loopContext;

  return buildCleanStepContext(
    stepType,
    {
      nodeType: stepType,
      stepId: existing?.stepId,
      status: overrides.status ?? existing?.status,
      startedAt: overrides.startedAt ?? existing?.startedAt,
      completedAt: overrides.completedAt ?? existing?.completedAt,
      durationMs: overrides.durationMs ?? existing?.durationMs,
      error: overrides.error ?? existing?.error,
    },
    fields,
  ) as WorkflowStepData;
}

/**
 * Execute a single step and update the workflow context.
 * Returns the dispatch result for the handler to act on (e.g., sleep for delay).
 */
export async function executeWorkflowStep(
  step: WorkflowStep,
  ctx: WorkflowContextData,
  deps: WorkflowHandlerDeps,
  executionId: string,
  restateCtx?: RestateWorkflowCtx,
): Promise<StepDispatchResult> {
  const startTime = Date.now();

  // Resolve detailed input BEFORE dispatching — persisted immediately so the
  // debug panel shows what's being sent while the step is still running.
  const resolvedInput = resolveStepInput(step, ctx);

  setStepContext(
    ctx,
    step,
    buildCleanStepContext(
      step.type,
      { nodeType: step.type, status: 'running', startedAt: new Date().toISOString() },
      resolvedInput ? { input: resolvedInput } : {},
    ),
  );

  // Mark step as running — write per-step snapshot so live polling sees the running step
  await deps.persistence.updateStepStatus(
    executionId,
    ctx.tenant.tenantId,
    ctx.tenant.projectId,
    step.id,
    'running',
    stepPersistArgs(ctx, step),
  );

  await deps.publisher.publish(
    `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
    JSON.stringify({
      type: 'step.started',
      executionId,
      stepId: step.id,
      stepName: step.name ?? step.id,
      stepType: step.type,
      status: 'running',
      timestamp: new Date().toISOString(),
      stepData: sanitizePublishedStepData(
        getStepContext(ctx, step) as Record<string, unknown> | undefined,
      ),
    }),
  );

  try {
    // Apply per-step timeout if configured. HTTP steps handle their own
    // timeout internally via AbortSignal, so skip for those.
    const stepTimeout = (step as unknown as Record<string, unknown>).timeout as number | undefined;
    let result: StepDispatchResult;
    if (stepTimeout && step.type !== 'http') {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          dispatchWithRetry(step, ctx, deps.dispatcherDeps, restateCtx),
          new Promise<never>((_resolve, reject) => {
            timerId = setTimeout(
              () =>
                reject(
                  new WorkflowStepError(
                    StepErrorCode.STEP_TIMEOUT,
                    `Step timed out after ${stepTimeout}ms`,
                  ),
                ),
              stepTimeout,
            );
          }),
        ]);
      } finally {
        if (timerId !== undefined) clearTimeout(timerId);
      }
    } else {
      result = await dispatchWithRetry(step, ctx, deps.dispatcherDeps, restateCtx);
    }
    const durationMs = Date.now() - startTime;
    const needsSuspension =
      result.delayMs !== undefined ||
      result.approvalRequest !== undefined ||
      result.webhookRequest !== undefined ||
      result.toolRequest !== undefined ||
      result.humanTaskRequest !== undefined ||
      // callbackRequest = connector_action async parking (ADI, Docling).
      // Must be included so the step stays 'running' until executeWorkflow overwrites
      // with 'waiting_callback' — without this, Studio shows a 'completed' flash
      // before the step transitions to the correct waiting state.
      result.callbackRequest !== undefined;
    const defersCompletion = result.loopIteration !== undefined;

    // Suspension and loop-body steps stay in 'running' — runWorkflow transitions
    // them to completed after durable waits or nested loop execution finishes.
    if (!needsSuspension && !defersCompletion) {
      // Compute granular metrics when available (HTTP steps provide responseTimeMs)
      const metrics =
        result.responseTimeMs !== undefined
          ? {
              responseTimeMs: result.responseTimeMs,
              processingTimeMs: durationMs - result.responseTimeMs,
            }
          : undefined;

      const runningCtx = getStepContext(ctx, step);
      setStepContext(
        ctx,
        step,
        rebuildStepContext(step.type, runningCtx, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          durationMs,
          output: result.output ?? undefined,
          ...(metrics ? { metrics } : {}),
          ...(result.consoleLogs ? { consoleLogs: result.consoleLogs } : {}),
        }),
      );

      // Rehydrate root context variables from step output for steps that write
      // to context.
      // During Restate replay, ctx.run() returns the journaled result without
      // re-executing the step callback, so in-memory context mutations from
      // function-executor/transform-executor are lost. Re-apply them here.
      if (step.type === 'transform' && result.output != null && typeof result.output === 'object') {
        const transformOut = result.output as { outputVariable?: string; value?: unknown };
        if (transformOut.outputVariable) {
          setContextVariablePath(ctx, transformOut.outputVariable, transformOut.value);
        }
      } else if (
        step.type === 'function' &&
        result.output != null &&
        typeof result.output === 'object'
      ) {
        promoteFunctionWritesToParentContext(ctx, result.output);
      }

      // Do NOT overwrite `input` here — it was already persisted as the
      // EXPRESSION-RESOLVED input when the step transitioned to 'running'
      // (see resolveStepInput call above). The dispatcher's `result.input`
      // carries the raw step config (with unresolved {{...}} templates),
      // which would replace the nice resolved values shown in the debug panel.
      await deps.persistence.updateStepStatus(
        executionId,
        ctx.tenant.tenantId,
        ctx.tenant.projectId,
        step.id,
        'completed',
        {
          ...stepPersistArgs(ctx, step),
          ...(step.type === 'function' || step.type === 'transform' ? { context: ctx } : {}),
        },
      );

      await deps.publisher.publish(
        `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
        JSON.stringify({
          type: 'step.completed',
          executionId,
          stepId: step.id,
          stepName: step.name ?? step.id,
          stepType: step.type,
          status: 'completed',
          timestamp: new Date().toISOString(),
          stepData: sanitizePublishedStepData(
            getStepContext(ctx, step) as Record<string, unknown> | undefined,
          ),
          durationMs,
        }),
      );
    } else {
      // Record dispatch output in context but leave status as 'running'
      setStepContext(
        ctx,
        step,
        rebuildStepContext(step.type, getStepContext(ctx, step), {
          status: 'running',
          durationMs,
          ...(result.output != null ? { output: result.output } : {}),
        }),
      );
    }

    return result;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const stepError: StepError = extractStepError(err);

    setStepContext(
      ctx,
      step,
      rebuildStepContext(step.type, getStepContext(ctx, step), {
        status: 'failed',
        completedAt: new Date().toISOString(),
        durationMs,
        error: stepError,
      }),
    );

    // Input was already persisted when step was marked as 'running' — don't overwrite.
    await deps.persistence.updateStepStatus(
      executionId,
      ctx.tenant.tenantId,
      ctx.tenant.projectId,
      step.id,
      'failed',
      stepPersistArgs(ctx, step),
    );

    await deps.publisher.publish(
      `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
      JSON.stringify({
        type: 'step.failed',
        executionId,
        stepId: step.id,
        stepName: step.name ?? step.id,
        stepType: step.type,
        status: 'failed',
        timestamp: new Date().toISOString(),
        stepData: sanitizePublishedStepData(
          getStepContext(ctx, step) as Record<string, unknown> | undefined,
        ),
        error: stepError.message,
        errorCode: stepError.code,
        httpStatus: stepError.httpStatus,
      }),
    );

    throw err;
  }
}

/**
 * Build a step lookup map from step ID → step object.
 * Used for O(1) step resolution when following condition branches.
 */
function buildStepIndex(steps: WorkflowStep[]): Map<string, WorkflowStep> {
  const index = new Map<string, WorkflowStep>();
  if (!Array.isArray(steps)) return index;
  for (const step of steps) {
    index.set(step.id, step);
  }
  return index;
}

/**
 * Run a full workflow execution. Uses a step queue to support conditional
 * branching — condition steps redirect execution to their thenSteps/elseSteps
 * instead of falling through to the next sequential step.
 *
 * Control flow signals in StepDispatchResult:
 * - `nextSteps`: Condition branches — replace the remaining queue with these step IDs
 * - `delayMs`: Delay steps — the Restate caller should ctx.sleep() for this duration
 * - `webhookRequest`: Async webhook — the Restate caller sends HTTP + waits on durable promise
 * - `approvalRequest`: Approval — the Restate caller waits on approval durable promise
 *
 * The handler records these signals in the step output so the Restate service
 * layer can act on them.
 */

/** Build a standard failure output with _status=1 and _reason */
function buildFailureOutput(reason: string): Record<string, unknown> {
  return { _status: 1, _reason: reason };
}

function formatOutputMappingFailureMessage(
  mappingErrors: OutputMappingError[],
  totalMappings: number,
  label: string,
): string {
  const details = mappingErrors.map((error) => `${error.name}: ${error.error}`).join('; ');
  return `${mappingErrors.length} of ${totalMappings} ${label} mapping${
    totalMappings === 1 ? '' : 's'
  } failed${details ? `: ${details}` : ''}`;
}

/**
 * Find-or-create a HumanTask mirror. Idempotent — calls `buildTask()` only
 * when no existing mirror is present, so repeat invocations (e.g. Restate
 * replay) do not produce duplicate inbox entries.
 *
 * Best-effort: the mirror is a MongoDB-side view of the Restate durable
 * promise, so a mirror failure here must never fail the workflow step (the
 * promise itself is the source of truth). Any error is logged at `warn`
 * level and swallowed. Before this helper existed, the `human_task` path
 * used `log.error` and the `approval` path used `log.warn` for the same
 * failure class — the unified `warn` is the correct level.
 */
async function ensureHumanTaskMirror(
  humanTaskStore: HumanTaskStore | undefined,
  params: {
    tenantId: string;
    projectId: string;
    sourceType: string;
    executionId: string;
    stepId: string;
  },
  buildTask: () => import('../persistence/human-task-store.js').CreateHumanTaskParams,
): Promise<void> {
  if (!humanTaskStore) return;
  try {
    const existing = await humanTaskStore.findBySource(
      params.tenantId,
      params.projectId,
      params.sourceType,
      { executionId: params.executionId, stepId: params.stepId },
    );
    if (existing) return;
    await humanTaskStore.createTask(buildTask());
  } catch (err) {
    log.warn('Failed to create HumanTask mirror', {
      sourceType: params.sourceType,
      executionId: params.executionId,
      stepId: params.stepId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Update an existing HumanTask mirror when a workflow_human_task times out.
 * Both the `skip` and `expire` branches share the same shape — only the
 * target task status, decision string, and user-facing notes differ.
 */
async function finalizeHumanTaskOnTimeout(
  humanTaskStore: HumanTaskStore | undefined,
  params: { tenantId: string; projectId: string; executionId: string; stepId: string },
  opts: {
    status: 'cancelled' | 'expired';
    decision: 'skipped' | 'expired';
    notes: string;
    logLabel: string;
  },
): Promise<void> {
  if (!humanTaskStore) return;
  try {
    const ht = await humanTaskStore.findBySource(
      params.tenantId,
      params.projectId,
      'workflow_human_task',
      { executionId: params.executionId, stepId: params.stepId },
    );
    if (!ht) return;
    await humanTaskStore.updateTaskStatus(ht._id, params.tenantId, ht.projectId, opts.status, {
      response: {
        respondedBy: 'system:timeout',
        respondedAt: new Date(),
        fields: {},
        notes: opts.notes,
        decision: opts.decision,
      },
    });
  } catch (err) {
    log.warn(opts.logLabel, {
      executionId: params.executionId,
      stepId: params.stepId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runWorkflow(
  input: WorkflowExecutionInput,
  executionId: string,
  deps: WorkflowHandlerDeps,
  restateCtx?: RestateWorkflowCtx,
): Promise<WorkflowExecutionResult> {
  const startTime = new Date().toISOString();

  // ── Start phase: validate + coerce trigger payload against declared inputs ──
  // Runs BEFORE buildWorkflowContext so the returned coerced map seeds root
  // context variables.
  // Validation is a pure CPU op over the declared shape — no I/O, no throws.
  const startValidationStartMs = Date.now();
  const startValidation = validateAndCoerceInput(input.startInputVariables, input.triggerPayload);
  const startValidationDurationMs = Date.now() - startValidationStartMs;

  // Build the workflow context. If validation succeeded, pass the coerced map
  // through so root context fields carry typed values and
  // ctx.steps.start.output shows the post-coercion shape. If validation failed,
  // build with raw payload (the fail path still needs a context for the error
  // result record).
  const ctx = buildWorkflowContext(
    input,
    executionId,
    startValidation.ok ? startValidation.coerced : undefined,
  );

  // Memory projection load — fail fast on storage error. We do this BEFORE
  // step dispatch so expressions like {{memory.workflow.lastCursor}} resolve
  // identically across the entire run regardless of which step references
  // them. Defaults to empty scopes when no memoryClient is wired.
  try {
    ctx.memory = await loadMemoryProjection(input, deps.memoryClient);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('memory projection load failed', {
      executionId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      workflowId: input.workflowId,
      error: message,
    });
    return {
      status: 'failed',
      context: ctx,
      error: { code: 'MEMORY_PROJECTION_FAILED', message },
      output: buildFailureOutput(message),
    };
  }

  const hasNoExecutableSteps = !Array.isArray(input.steps) || input.steps.length === 0;
  // A Start → End graph (no intermediate executable nodes) is a valid no-op
  // workflow — the dispatch loop short-circuits and the End phase still runs
  // any declared output mappings. Detect via edgeMap: canvas-to-steps stamps
  // sourceRuntimeId='start' / targetRuntimeId='end' on the direct connection.
  const hasDirectStartToEndEdge =
    !!input.edgeMap &&
    Object.values(input.edgeMap).some((edges) =>
      edges.some((e) => e.sourceRuntimeId === 'start' && e.targetRuntimeId === 'end'),
    );
  if (hasNoExecutableSteps && !hasDirectStartToEndEdge) {
    const reason =
      'Workflow has no complete Start → End path. Connect all nodes and add an End node before running.';
    const failOutput = buildFailureOutput(reason);
    const completedAt = new Date();
    await deps.persistence.createExecution({
      executionId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      workflowVersion: input.workflowVersion,
      status: 'failed',
      triggerType: input.triggerType,
      triggerPayload: input.triggerPayload,
      triggerMetadata: input.triggerMetadata,
      steps: [
        { stepId: 'start', name: 'Start', type: 'start', status: 'failed' },
        { stepId: 'end', name: 'End', type: 'end', status: 'failed' },
      ],
      webhookMode: input.webhookMode,
      webhookDelivery: input.webhookDelivery,
    });
    await deps.persistence.updateExecutionStatus(
      executionId,
      input.tenantId,
      input.projectId,
      'failed',
      {
        context: ctx,
        error: { code: 'NO_STEPS', message: reason },
        output: failOutput,
        completedAt,
      },
    );
    await deps.publisher.publish(
      `workflow:${input.tenantId}:execution:${executionId}:status`,
      JSON.stringify({
        type: 'workflow.failed',
        executionId,
        error: reason,
        timestamp: completedAt.toISOString(),
      }),
    );
    return {
      status: 'failed',
      context: ctx,
      error: { code: 'NO_STEPS', message: reason },
      output: failOutput,
    };
  }

  const stepIndex = buildStepIndex(input.steps);
  const callbackUrl =
    typeof input.triggerMetadata?.callbackUrl === 'string'
      ? input.triggerMetadata.callbackUrl
      : undefined;
  if (callbackUrl) {
    await assertUrlSafeForFetch(callbackUrl);
  }

  // Create per-execution dispatcher deps, merging in connector deps if factory provided.
  // For each step dispatch, the dispatcher invokes `connectorDepsForStep`
  // (Phase 2 wiring) with the live workflow context so native connectors —
  // Docling's `extract_document` action in particular — receive a populated
  // `CallbackContext`. The legacy `connectorDeps` set-once path is preserved
  // as a fallback for tests and non-workflow callers.
  const executionDispatcherDeps: StepDispatcherDeps = { ...deps.dispatcherDeps };
  if (deps.connectorDepsFactory) {
    if (!executionDispatcherDeps.connectorDeps) {
      executionDispatcherDeps.connectorDeps = deps.connectorDepsFactory(
        input.tenantId,
        input.projectId,
      );
    }
    if (!executionDispatcherDeps.connectorDepsForStep) {
      const factory = deps.connectorDepsFactory;
      executionDispatcherDeps.connectorDepsForStep = (workflowExecutionId, stepId) =>
        factory(input.tenantId, input.projectId, workflowExecutionId, stepId);
    }
  }

  // Wrap the publisher to inject complete edge path snapshots on every step event.
  // The snapshots are derived from ctx.steps at publish time so the socket always
  // carries the full outer and per-iteration path state without runtime-side caching.
  const edgeDescriptorMap = input.edgeMap ?? {};
  const hasEdgeMap = Object.keys(edgeDescriptorMap).length > 0;
  const pathAwarePublisher: StatusPublisher = {
    publish: async (channel: string, message: string): Promise<void> => {
      if (hasEdgeMap) {
        try {
          const parsed = JSON.parse(message) as Record<string, unknown>;
          const msgType = parsed.type as string | undefined;
          if (msgType?.startsWith('step.')) {
            parsed.pathState = computePathState(ctx.steps, edgeDescriptorMap);
            parsed.iterationPathState = mergeIterationPathStates(
              computeAllIterationPathState(ctx.steps, edgeDescriptorMap),
              parsed.iterationPathState,
            );
            return deps.publisher.publish(channel, JSON.stringify(parsed));
          }
        } catch {
          // parse failure — fall through to original publish
        }
      }
      return deps.publisher.publish(channel, message);
    },
  };

  // Build execution-scoped handler deps with the merged dispatcher deps.
  // Declared before branchRunner so the closure can capture it.
  const executionDeps: WorkflowHandlerDeps = {
    ...deps,
    dispatcherDeps: executionDispatcherDeps,
    publisher: pathAwarePublisher,
  };

  /**
   * Execute a chain of step IDs, following conditional branches to completion.
   * Mirrors the top-level queue logic but scoped to a sub-chain (branch or loop body).
   */
  async function executeStepChain(
    stepIds: string[],
    chainCtx: WorkflowContextData = ctx,
    chainDeps: WorkflowHandlerDeps = executionDeps,
    beforeStep?: (step: WorkflowStep) => void,
  ): Promise<Record<string, unknown>> {
    const outputs: Record<string, unknown> = {};
    const queue = [...stepIds];
    const maxIterations = MAX_WORKFLOW_STEPS * 2; // Allow routing but cap total iterations
    let iterations = 0;
    while (queue.length > 0) {
      if (++iterations > maxIterations) {
        throw new WorkflowStepError(
          StepErrorCode.STEP_TIMEOUT,
          `Step chain exceeded maximum iterations (${maxIterations}), possible cycle detected`,
        );
      }
      const sid = queue.shift()!;
      const s = stepIndex.get(sid);
      if (!s) continue; // Skip end/start nodes not in step index
      beforeStep?.(s);

      const onFailureSteps = s.onFailureSteps;
      const onSuccessSteps = s.onSuccessSteps;

      let r: StepDispatchResult;
      try {
        r = await executeWorkflowStep(s, chainCtx, chainDeps, executionId, restateCtx);
      } catch (stepErr) {
        if (onFailureSteps && onFailureSteps.length > 0) {
          queue.length = 0;
          for (const nextId of onFailureSteps) queue.push(nextId);
          continue;
        }
        throw stepErr;
      }

      outputs[sid] = r.output ?? null;
      // Follow condition branches or explicit success routing
      if (r.nextSteps && r.nextSteps.length > 0) {
        queue.length = 0;
        for (const nextId of r.nextSteps) queue.push(nextId);
      } else if (onSuccessSteps && onSuccessSteps.length > 0) {
        queue.length = 0;
        for (const nextId of onSuccessSteps) queue.push(nextId);
      }
    }
    return outputs;
  }

  // Wire branchRunner for parallel step execution.
  const branchRunner: BranchRunner = async (branch: ParallelBranch): Promise<unknown> => {
    return executeStepChain(branch.steps);
  };
  executionDispatcherDeps.branchRunner = branchRunner;

  /**
   * Execute a single step through its full lifecycle including suspension handling.
   * Returns a StepOutcome describing what happened so the queue loop can route.
   *
   * This is a nested function that closes over runWorkflow locals: ctx, executionDeps,
   * executionId, deps, input, stepIndex, executeStepChain, markStepCompleted, etc.
   * The _ctx, _executionDeps, _executionId parameters match the executeDag callback
   * signature used in Phase 3b but are unused — closure variables are used throughout.
   */
  async function executeStepWithSuspension(
    step: WorkflowStep,
    _ctx: WorkflowContextData,
    _executionDeps: WorkflowHandlerDeps,
    _executionId: string,
    restateCtx?: RestateWorkflowCtx,
    options?: { nonFatalStepFailures?: boolean },
  ): Promise<StepOutcome> {
    const ctx = _ctx;
    const deps = _executionDeps;
    const executionId = _executionId;
    const onFailureSteps = step.onFailureSteps;
    const onRejectSteps = step.onRejectSteps;
    const onSuccessSteps = step.onSuccessSteps;

    // ── Required predecessor check ──────────────────────────────────────────
    // All predecessors have settled (DAG barrier guarantees this). Verify that
    // every required predecessor completed successfully. If any was skipped
    // (branch not taken) or failed (routed via on_failure), fail this step and
    // route via on_failure if configured — otherwise fail the workflow.
    for (const predId of step.requiredPredecessors ?? []) {
      const predStep = stepIndex.get(predId);
      const predKey = predStep?.name ?? predId;
      const predStatus = ctx.steps[predKey]?.status;
      const predSkipped = predStatus === 'skipped' || getDagSkippedStepIds(ctx).has(predId);
      if (predSkipped || predStatus === 'failed') {
        const isFailed = predStatus === 'failed';
        const errorCode = isFailed ? 'REQUIRED_PREDECESSOR_FAILED' : 'REQUIRED_PREDECESSOR_SKIPPED';
        const errorMsg = isFailed
          ? `Required predecessor "${predKey}" failed`
          : `Required predecessor "${predKey}" was skipped (branch not taken)`;
        const failedAt = new Date().toISOString();
        // Use buildCleanStepContext directly — this step never started, so getStepContext
        // returns undefined and rebuildStepContext would produce stepId: undefined.
        // startedAt === completedAt because the step was intercepted before execution.
        setStepContext(
          ctx,
          step,
          buildCleanStepContext(
            step.type,
            {
              nodeType: step.type,
              stepId: step.id,
              status: 'failed',
              startedAt: failedAt,
              completedAt: failedAt,
              durationMs: 0,
              error: { code: errorCode, message: errorMsg },
            },
            {},
          ) as WorkflowStepData,
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'failed',
          stepPersistArgs(ctx, step),
        );
        {
          const { controlFlow: _cf, ...failedStepData } = (getStepContext(ctx, step) ??
            {}) as Record<string, unknown>;
          void _cf;
          await deps.publisher.publish(
            `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
            JSON.stringify({
              type: 'step.failed',
              executionId,
              stepId: step.id,
              stepName: step.name ?? step.id,
              stepType: step.type,
              status: 'failed',
              timestamp: failedAt,
              stepData: failedStepData,
              error: errorMsg,
              errorCode,
            }),
          );
        }
        log.warn('workflow-handler: required predecessor not completed', {
          stepId: step.id,
          stepName: step.name,
          predId,
          predKey,
          predStatus,
          errorCode,
        });
        if (onFailureSteps && onFailureSteps.length > 0) {
          return { status: 'completed', activatedSuccessors: onFailureSteps };
        }
        throw new WorkflowStepError(StepErrorCode.STEP_FAILED, errorMsg);
      }
    }

    let result: StepDispatchResult;
    try {
      result = await executeWorkflowStep(step, ctx, deps, executionId, restateCtx);
    } catch (stepErr) {
      if (stepErr instanceof CancellationError) throw stepErr;
      // If this step has on_failure routing, redirect execution instead of failing the workflow
      if (onFailureSteps && onFailureSteps.length > 0) {
        return { status: 'completed', activatedSuccessors: onFailureSteps };
      }
      if (options?.nonFatalStepFailures) {
        return { status: 'failed' };
      }
      throw stepErr;
    }

    // ── Loop iteration: execute body steps for each item ──────────────
    if (result.loopIteration) {
      const { items, itemVariable, body, bodyInDegreeMap } = result.loopIteration;
      const loopStep = step as LoopStep;
      const outputField =
        typeof loopStep.config.outputField === 'string' && loopStep.config.outputField.length > 0
          ? loopStep.config.outputField
          : undefined;
      const onError =
        loopStep.config.onError === 'terminate' || loopStep.config.onError === 'remove_failed'
          ? loopStep.config.onError
          : 'continue';
      const staggerMs =
        typeof loopStep.config.stagger === 'number' && loopStep.config.stagger > 0
          ? Math.floor(loopStep.config.stagger)
          : 0;
      type LoopIterationOutput = {
        index: number;
        currentItem: unknown;
        output: Record<string, unknown> | null;
        mappingErrors?: OutputMappingError[];
      };
      type LoopIterationDebugExecution = {
        currentIndex: number;
        currentItem: unknown;
        steps: Record<string, Record<string, unknown>>;
      };
      type LoopIterationMetricsExecution = {
        currentIndex: number;
        currentItem: unknown;
        steps: Record<string, Record<string, unknown>>;
      };
      const buildIterationOutput = (
        item: unknown,
        index: number,
        output: Record<string, unknown> | null,
        mappingErrors?: OutputMappingError[],
      ): LoopIterationOutput => {
        return {
          index,
          currentItem: item,
          output,
          ...(mappingErrors && mappingErrors.length > 0 ? { mappingErrors } : {}),
        };
      };
      const buildIterationDebugExecution = (
        item: unknown,
        index: number,
        iterationCtx: WorkflowContextData,
      ): LoopIterationDebugExecution => ({
        currentIndex: index,
        currentItem: item,
        steps: collectLoopIterationDebugSteps(ctx, iterationCtx),
      });
      const buildIterationMetricsExecution = (
        item: unknown,
        index: number,
        iterationCtx: WorkflowContextData,
      ): LoopIterationMetricsExecution => ({
        currentIndex: index,
        currentItem: item,
        steps: collectLoopIterationMetricSteps(ctx, iterationCtx),
      });
      const resolveLoopIterationOutput = (
        iterationCtx: WorkflowContextData,
      ): { output: Record<string, unknown> | null; mappingErrors: OutputMappingError[] } => {
        const mappings = loopStep.config.bodyOutputMappings ?? [];
        if (mappings.length === 0) return { output: null, mappingErrors: [] };

        const { output, mappingErrors } = resolveOutputMappings(mappings, iterationCtx);
        const hasResolvedField = Object.values(output).some((value) => value !== null);
        return { output: hasResolvedField ? output : null, mappingErrors };
      };
      const getFailedLoopBodyStep = (
        iterationCtx: WorkflowContextData,
      ): { stepName: string; error?: { code: string; message: string } } | undefined => {
        for (const bodyStepId of getLoopBodyStepIds(body, bodyInDegreeMap)) {
          const bodyStep = stepIndex.get(bodyStepId);
          const stepName = bodyStep?.name ?? bodyStepId;
          const stepData = iterationCtx.steps[stepName];
          if (stepData?.status !== 'failed') continue;
          return { stepName, error: stepData.error };
        }
        return undefined;
      };
      const partialIterationOutputs: Array<LoopIterationOutput | undefined> = [];
      const partialIterationExecutions: Array<LoopIterationDebugExecution | undefined> = [];
      const partialIterationMetricExecutions: Array<LoopIterationMetricsExecution | undefined> = [];
      const failedIterationIndexes = new Set<number>();
      let loopProgressFlush: Promise<void> = Promise.resolve();
      let loopTerminal = false;
      let loopOutputFieldFailureLogged = false;
      const filterHandledIterationOutputs = (
        iterationOutputs: LoopIterationOutput[],
      ): LoopIterationOutput[] => {
        if (onError !== 'remove_failed') return iterationOutputs;
        return iterationOutputs.filter(
          (iterationOutput) => !failedIterationIndexes.has(iterationOutput.index),
        );
      };
      const persistLoopProgress = async (): Promise<void> => {
        if (loopTerminal) return;
        const allIterationOutputs = partialIterationOutputs.filter(
          (output): output is LoopIterationOutput => output !== undefined,
        );
        const iterationOutputs = filterHandledIterationOutputs(allIterationOutputs);
        const iterationExecutions = partialIterationExecutions.filter(
          (execution): execution is LoopIterationDebugExecution => execution !== undefined,
        );
        const iterationMetricExecutions = partialIterationMetricExecutions.filter(
          (execution): execution is LoopIterationMetricsExecution => execution !== undefined,
        );
        const loopOutput = {
          ...(result.output as Record<string, unknown>),
          iterationOutputs,
        };
        try {
          applyLoopOutputField(
            ctx,
            loopOutput,
            outputField,
            iterationOutputs.map((iterationOutput) => iterationOutput.output),
          );
        } catch (outputFieldErr) {
          if (!loopOutputFieldFailureLogged) {
            loopOutputFieldFailureLogged = true;
            log.warn('Loop failed while applying outputField during failure handling', {
              executionId,
              stepId: step.id,
              outputField,
              error:
                outputFieldErr instanceof Error ? outputFieldErr.message : String(outputFieldErr),
            });
          }
        }
        setStepContext(
          ctx,
          step,
          rebuildStepContext(step.type, getStepContext(ctx, step), {
            status: 'running',
            output: loopOutput,
            ...(iterationMetricExecutions.length > 0
              ? { loopContext: iterationMetricExecutions }
              : {}),
          }),
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'running',
          { ...stepPersistArgs(ctx, step), context: ctx },
        );
        const socketStepData = {
          ...(sanitizePublishedStepData(
            getStepContext(ctx, step) as Record<string, unknown> | undefined,
          ) ?? {}),
          ...(iterationExecutions.length > 0 ? { loopContext: iterationExecutions } : {}),
        };
        // Build per-iteration body edge pathState. Outer edge pathState is
        // maintained incrementally by the path-aware publisher.
        let loopProgressIterationPathState:
          | Record<string, Record<string, Record<string, 'running' | 'completed'>>>
          | undefined;
        if (hasEdgeMap) {
          const iterPS = computeIterationPathState(step.id, iterationExecutions, edgeDescriptorMap);
          if (Object.keys(iterPS).length > 0) {
            loopProgressIterationPathState = { [step.id]: iterPS };
          }
        }
        await executionDeps.publisher.publish(
          `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
          JSON.stringify({
            type: 'step.started',
            executionId,
            stepId: step.id,
            stepName: step.name ?? step.id,
            stepType: step.type,
            status: 'running',
            timestamp: new Date().toISOString(),
            stepData: socketStepData,
            contextPatch: getContextVariables(ctx),
            ...(loopProgressIterationPathState
              ? { iterationPathState: loopProgressIterationPathState }
              : {}),
          }),
        );
      };
      const scheduleLoopProgress = async (): Promise<void> => {
        loopProgressFlush = loopProgressFlush.then(persistLoopProgress, persistLoopProgress);
        await loopProgressFlush;
      };
      const recordFailedLoopIteration = (item: unknown, index: number): LoopIterationOutput => {
        failedIterationIndexes.add(index);
        const output = partialIterationOutputs[index] ?? buildIterationOutput(item, index, null);
        partialIterationOutputs[index] = output;
        return output;
      };
      const executeLoopIteration = async (
        item: unknown,
        index: number,
      ): Promise<{ output: LoopIterationOutput; iterationCtx: WorkflowContextData }> => {
        const iterationCtx = cloneContextForLoopIteration(
          ctx,
          itemVariable,
          item,
          index,
          items.length,
        );
        const iterationOwnedStepKeys = new Set<string>();
        const refreshParentSteps = (): void => {
          syncParentStepsIntoLoopIteration(ctx, iterationCtx, iterationOwnedStepKeys);
        };
        const rememberIterationStepKeys = (): void => {
          for (const stepKey of Object.keys(collectLoopIterationDebugSteps(ctx, iterationCtx))) {
            iterationOwnedStepKeys.add(stepKey);
          }
        };
        let loopScopedDeps: WorkflowHandlerDeps;
        const finalizeIterationOutput = async (): Promise<LoopIterationOutput> => {
          rememberIterationStepKeys();
          const iterationOutput = resolveLoopIterationOutput(iterationCtx);
          const output = buildIterationOutput(
            item,
            index,
            iterationOutput.output,
            iterationOutput.mappingErrors,
          );
          partialIterationOutputs[index] = output;
          partialIterationExecutions[index] = buildIterationDebugExecution(
            item,
            index,
            iterationCtx,
          );
          partialIterationMetricExecutions[index] = buildIterationMetricsExecution(
            item,
            index,
            iterationCtx,
          );
          await scheduleLoopProgress();
          return output;
        };
        loopScopedDeps = createLoopScopedDeps(
          executionDeps,
          (branch) =>
            executeStepChain(branch.steps, iterationCtx, loopScopedDeps, () => {
              refreshParentSteps();
            }),
          async (updatedStepId, updatedStatus) => {
            const updatedStep = stepIndex.get(updatedStepId);
            if (updatedStatus === 'completed' && updatedStep?.type === 'function') {
              promoteFunctionWritesToParentContext(
                ctx,
                getStepContext(iterationCtx, updatedStep)?.output,
              );
            }
            rememberIterationStepKeys();
            partialIterationOutputs[index] = buildIterationOutput(item, index, null);
            partialIterationExecutions[index] = buildIterationDebugExecution(
              item,
              index,
              iterationCtx,
            );
            partialIterationMetricExecutions[index] = buildIterationMetricsExecution(
              item,
              index,
              iterationCtx,
            );
            await scheduleLoopProgress();
          },
        );
        // Use DAG executor when bodyInDegreeMap is present — supports branching + fan-in.
        // Fall back to linear chain for bodies without a computed degree map.
        try {
          if (bodyInDegreeMap && Object.keys(bodyInDegreeMap).length > 0) {
            const rootBodyStepIds = Object.entries(bodyInDegreeMap)
              .filter(([, deg]) => deg === 0)
              .map(([id]) => id);
            await executeDag({
              stepIndex,
              inDegreeMap: bodyInDegreeMap,
              rootStepIds: rootBodyStepIds,
              executeStep: (s) =>
                executeStepWithSuspension(
                  s,
                  (() => {
                    refreshParentSteps();
                    return iterationCtx;
                  })(),
                  loopScopedDeps,
                  executionId,
                  restateCtx,
                  { nonFatalStepFailures: true },
                ),
              ctx: iterationCtx,
            });
            const failedBodyStep = getFailedLoopBodyStep(iterationCtx);
            if (failedBodyStep) {
              throw new WorkflowStepError(
                StepErrorCode.STEP_FAILED,
                failedBodyStep.error?.message
                  ? `Loop body step "${failedBodyStep.stepName}" failed: ${failedBodyStep.error.message}`
                  : `Loop body step "${failedBodyStep.stepName}" failed`,
              );
            }
          } else {
            await executeStepChain(body, iterationCtx, loopScopedDeps, () => {
              refreshParentSteps();
            });
          }
        } catch (iterationErr) {
          await finalizeIterationOutput();
          throw iterationErr;
        }
        const output = await finalizeIterationOutput();
        if ((output.mappingErrors?.length ?? 0) > 0) {
          throw new WorkflowStepError(
            StepErrorCode.VALIDATION_ERROR,
            formatOutputMappingFailureMessage(
              output.mappingErrors!,
              output.mappingErrors!.length,
              'loop output',
            ),
          );
        }
        return {
          output,
          iterationCtx,
        };
      };
      const executeStaggeredLoopIteration = async (
        item: unknown,
        index: number,
        batchOffset: number,
      ): Promise<{ output: LoopIterationOutput; iterationCtx: WorkflowContextData }> => {
        if (staggerMs > 0 && batchOffset > 0) {
          const delayMs = batchOffset * staggerMs;
          if (restateCtx) {
            await raceCancel(restateCtx, restateCtx.sleep(delayMs));
          } else {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        return executeLoopIteration(item, index);
      };
      const markLoopFailed = async (err: unknown): Promise<void> => {
        loopTerminal = true;
        const stepError = extractStepError(err);
        const iterationOutputs = partialIterationOutputs.filter(
          (output): output is LoopIterationOutput => output !== undefined,
        );
        const iterationExecutions = partialIterationExecutions.filter(
          (execution): execution is LoopIterationDebugExecution => execution !== undefined,
        );
        const iterationMetricExecutions = partialIterationMetricExecutions.filter(
          (execution): execution is LoopIterationMetricsExecution => execution !== undefined,
        );
        const loopOutput = {
          ...(result.output as Record<string, unknown>),
          iterationOutputs,
        };
        try {
          applyLoopOutputField(
            ctx,
            loopOutput,
            outputField,
            iterationOutputs.map((iterationOutput) => iterationOutput.output),
          );
        } catch (outputFieldErr) {
          if (!loopOutputFieldFailureLogged) {
            loopOutputFieldFailureLogged = true;
            log.warn('Loop outputField write failed while marking loop failed', {
              executionId,
              stepId: step.id,
              outputField,
              error:
                outputFieldErr instanceof Error ? outputFieldErr.message : String(outputFieldErr),
            });
          }
        }
        setStepContext(
          ctx,
          step,
          rebuildStepContext(step.type, getStepContext(ctx, step), {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: stepError,
            output: loopOutput,
            ...(iterationMetricExecutions.length > 0
              ? { loopContext: iterationMetricExecutions }
              : {}),
          }),
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'failed',
          { ...stepPersistArgs(ctx, step), context: ctx },
        );
        const socketStepData = {
          ...(sanitizePublishedStepData(
            getStepContext(ctx, step) as Record<string, unknown> | undefined,
          ) ?? {}),
          ...(iterationExecutions.length > 0 ? { loopContext: iterationExecutions } : {}),
        };
        await executionDeps.publisher.publish(
          `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
          JSON.stringify({
            type: 'step.failed',
            executionId,
            stepId: step.id,
            stepName: step.name ?? step.id,
            stepType: step.type,
            status: 'failed',
            timestamp: new Date().toISOString(),
            stepData: socketStepData,
            contextPatch: getContextVariables(ctx),
            error: stepError.message,
            errorCode: stepError.code,
            httpStatus: stepError.httpStatus,
          }),
        );
      };

      const iterationResults: LoopIterationOutput[] = [];

      try {
        if (loopStep.config.mode === 'parallel') {
          const concurrencyLimit =
            typeof loopStep.config.concurrencyLimit === 'number' &&
            loopStep.config.concurrencyLimit > 0
              ? Math.floor(loopStep.config.concurrencyLimit)
              : items.length;
          for (let start = 0; start < items.length; start += concurrencyLimit) {
            const batch = items.slice(start, start + concurrencyLimit);
            const batchResults = await Promise.allSettled(
              batch.map((item, offset) =>
                executeStaggeredLoopIteration(item, start + offset, offset),
              ),
            );
            let firstBatchError: unknown;
            for (const [offset, batchResult] of batchResults.entries()) {
              if (batchResult.status === 'fulfilled') {
                iterationResults.push(batchResult.value.output);
              } else if (firstBatchError === undefined) {
                firstBatchError = batchResult.reason;
                if (onError !== 'terminate') {
                  iterationResults.push(recordFailedLoopIteration(batch[offset], start + offset));
                }
              } else if (onError !== 'terminate') {
                iterationResults.push(recordFailedLoopIteration(batch[offset], start + offset));
              }
            }
            if (firstBatchError !== undefined && onError === 'terminate') throw firstBatchError;
            if (firstBatchError !== undefined) await scheduleLoopProgress();
          }
        } else {
          for (let i = 0; i < items.length; i++) {
            try {
              const iterationResult = await executeLoopIteration(items[i], i);
              iterationResults.push(iterationResult.output);
            } catch (iterationErr) {
              if (onError === 'terminate') throw iterationErr;
              iterationResults.push(recordFailedLoopIteration(items[i], i));
              await scheduleLoopProgress();
            }
          }
        }
      } catch (loopErr) {
        if (loopErr instanceof CancellationError) throw loopErr;
        await markLoopFailed(loopErr);
        if (onFailureSteps && onFailureSteps.length > 0) {
          return { status: 'completed', activatedSuccessors: onFailureSteps };
        }
        if (options?.nonFatalStepFailures) {
          return { status: 'failed' };
        }
        throw loopErr;
      }

      const iterationOutputs = filterHandledIterationOutputs(iterationResults);
      const loopOutput = {
        ...(result.output as Record<string, unknown>),
        iterationOutputs,
      };
      loopTerminal = true;
      try {
        applyLoopOutputField(
          ctx,
          loopOutput,
          outputField,
          iterationOutputs.map((iterationOutput) => iterationOutput.output),
        );
      } catch (loopErr) {
        if (loopErr instanceof CancellationError) throw loopErr;
        await markLoopFailed(loopErr);
        if (onFailureSteps && onFailureSteps.length > 0) {
          return { status: 'completed', activatedSuccessors: onFailureSteps };
        }
        if (options?.nonFatalStepFailures) {
          return { status: 'failed' };
        }
        throw loopErr;
      }
      setStepContext(
        ctx,
        step,
        rebuildStepContext(step.type, getStepContext(ctx, step), {
          output: loopOutput,
        }),
      );
      setStepContext(
        ctx,
        step,
        rebuildStepContext(step.type, getStepContext(ctx, step), {
          status: 'completed',
          completedAt: new Date().toISOString(),
        }),
      );
      await deps.persistence.updateStepStatus(
        executionId,
        ctx.tenant.tenantId,
        ctx.tenant.projectId,
        step.id,
        'completed',
        stepPersistArgs(ctx, step),
      );
      const finalIterationExecutions = partialIterationExecutions.filter(
        (execution): execution is LoopIterationDebugExecution => execution !== undefined,
      );
      const finalSocketStepData = {
        ...(sanitizePublishedStepData(
          getStepContext(ctx, step) as Record<string, unknown> | undefined,
        ) ?? {}),
        ...(finalIterationExecutions.length > 0 ? { loopContext: finalIterationExecutions } : {}),
      };
      // Build final per-iteration body edge pathState. Outer edge pathState is
      // maintained incrementally by the path-aware publisher.
      let finalLoopIterationPathState:
        | Record<string, Record<string, Record<string, 'running' | 'completed'>>>
        | undefined;
      if (hasEdgeMap) {
        const iterPS = computeIterationPathState(
          step.id,
          finalIterationExecutions,
          edgeDescriptorMap,
        );
        if (Object.keys(iterPS).length > 0) {
          finalLoopIterationPathState = { [step.id]: iterPS };
        }
      }
      await executionDeps.publisher.publish(
        `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
        JSON.stringify({
          type: 'step.completed',
          executionId,
          stepId: step.id,
          stepName: step.name ?? step.id,
          stepType: step.type,
          status: 'completed',
          timestamp: new Date().toISOString(),
          stepData: finalSocketStepData,
          contextPatch: getContextVariables(ctx),
          ...(finalLoopIterationPathState
            ? { iterationPathState: finalLoopIterationPathState }
            : {}),
        }),
      );
      // Canvas-routed loops carry onSuccessSteps — return completed so the DAG
      // executor can increment barriers on join nodes. Legacy sequential loops
      // (onSuccessSteps undefined) return terminal_no_successors so the queue
      // advances to the next step as before.
      if (onSuccessSteps && onSuccessSteps.length > 0) {
        return { status: 'completed', activatedSuccessors: onSuccessSteps };
      }
      return { status: 'terminal_no_successors' };
    }

    // Handle control flow based on step result.
    // Canvas-routed steps have onSuccessSteps set (possibly empty array).
    // If present, execution follows edges exclusively — no edges means stop.
    // Steps without onSuccessSteps (e.g., direct step arrays) use linear queue.
    let activatedSuccessors: string[];
    if (result.nextSteps && result.nextSteps.length > 0) {
      // Condition step: replace remaining queue with the chosen branch
      activatedSuccessors = result.nextSteps;
    } else if (result.nextSteps && result.nextSteps.length === 0 && step.canvasRouted === true) {
      // Canvas condition step where the chosen branch has no connected path.
      // e.g., IF branch is true but IF handle has no edge — fail the workflow.
      const branch = result.branchTaken ?? 'unknown';
      throw new WorkflowStepError(
        StepErrorCode.STEP_FAILED,
        `Condition '${step.name || step.id}' evaluated to '${branch}' branch, but no path is defined for it`,
      );
    } else if (onSuccessSteps && onSuccessSteps.length > 0) {
      // Step succeeded and has explicit on_success routing from canvas edges
      activatedSuccessors = onSuccessSteps;
    } else if (onSuccessSteps !== undefined && onSuccessSteps.length === 0) {
      // Canvas-routed step with no outgoing edges — fail the workflow
      throw new WorkflowStepError(
        StepErrorCode.STEP_FAILED,
        `Node '${step.name || step.id}' has no outgoing path defined`,
      );
    } else {
      activatedSuccessors = [];
    }

    // ── Suspension: delay ───────────────────────────────────────────────
    if (result.delayMs !== undefined) {
      // Always record delayMs so the debug panel can show wait time
      // regardless of whether Restate is in use.
      setStepContext(
        ctx,
        step,
        rebuildStepContext(step.type, getStepContext(ctx, step), {
          status: restateCtx ? 'waiting_delay' : 'running',
          delayMs: result.delayMs,
        }),
      );
      if (restateCtx) {
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'waiting_delay',
          stepPersistArgs(ctx, step),
        );
        await raceCancel(restateCtx, restateCtx.sleep(result.delayMs));
      }
      // Mark step completed after the wait resolves
      await markStepCompleted(step, ctx, deps, executionId);
    }

    // ── Suspension: approval ────────────────────────────────────────────
    if (result.approvalRequest !== undefined) {
      const approvalReq = result.approvalRequest as ApprovalRequest;
      const approvalStep = step as ApprovalStep;
      if (restateCtx) {
        const { id: approvalAwakeableId, promise: approvalAwakeablePromise } =
          restateCtx.awakeable<ApprovalDecision>();
        setStepContext(
          ctx,
          step,
          rebuildStepContext(step.type, getStepContext(ctx, step), {
            status: 'waiting_approval',
            awakeableId: approvalAwakeableId,
          }),
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'waiting_approval',
          stepPersistArgs(ctx, step),
        );
        {
          const { controlFlow: _cf, ...waitingApprovalData } = (getStepContext(ctx, step) ??
            {}) as Record<string, unknown>;
          void _cf;
          await deps.publisher.publish(
            `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
            JSON.stringify({
              type: 'step.waiting_approval',
              executionId,
              stepId: step.id,
              stepName: step.name ?? step.id,
              stepType: step.type,
              status: 'waiting_approval',
              timestamp: new Date().toISOString(),
              stepData: waitingApprovalData,
            }),
          );
        }

        // B3: Mirror approval as a unified HumanTask record (idempotent)
        await ensureHumanTaskMirror(
          deps.humanTaskStore,
          {
            tenantId: ctx.tenant.tenantId,
            projectId: ctx.tenant.projectId,
            sourceType: 'workflow_approval',
            executionId,
            stepId: step.id,
          },
          () => {
            // Normalize the engine's approval onTimeout vocabulary
            // ('approve'|'reject'|'escalate') to the UI-facing
            // ('terminate'|'skip') shape that the inbox surfaces.
            const approvalOnTimeout =
              approvalReq.timeoutMs != null
                ? approvalReq.onTimeout === 'approve'
                  ? ('skip' as const)
                  : ('terminate' as const)
                : undefined;
            return {
              tenantId: ctx.tenant.tenantId,
              projectId: ctx.tenant.projectId,
              type: 'approval',
              mailbox: 'workflow',
              priority: 'medium',
              title: approvalReq.message,
              source: {
                type: 'workflow_approval',
                workflowId: input.workflowId,
                executionId,
                stepId: step.id,
              },
              // All configured approvers are visible assignees. Length 1 ⇒
              // direct; length ≥ 2 ⇒ scoped pool (first claim wins); empty ⇒
              // open pool.
              assignedTo: approvalReq.approvers.length > 0 ? approvalReq.approvers : undefined,
              fields: [],
              context: {
                workflowName: input.workflowName,
                approvers: approvalReq.approvers,
              },
              dueAt:
                approvalReq.timeoutMs != null
                  ? new Date(Date.now() + approvalReq.timeoutMs)
                  : undefined,
              onTimeout: approvalOnTimeout,
            };
          },
        );

        // Race approval awakeable against cancellation and (optional) timeout
        const timeoutMs = approvalReq.timeoutMs;
        let decision: ApprovalDecision;
        try {
          const raw = await raceCancel(
            restateCtx,
            timeoutMs != null
              ? raceTimeout(restateCtx, approvalAwakeablePromise, timeoutMs)
              : approvalAwakeablePromise,
          );
          decision = raw as ApprovalDecision;
        } catch (err) {
          if (err instanceof TimeoutError) {
            decision = buildTimeoutDecision(approvalStep);
          } else {
            throw err;
          }
        }

        {
          const approvalCtx = getStepContext(ctx, step);
          setStepContext(
            ctx,
            step,
            rebuildStepContext(step.type, approvalCtx, {
              status: 'rejected',
              output: {
                ...((approvalCtx?.output as Record<string, unknown>) ?? {}),
                approvalDecision: decision,
              },
            }),
          );
        }

        if (!decision.approved) {
          // Update step status to 'rejected' (not generic 'failed')
          await deps.persistence.updateStepStatus(
            executionId,
            ctx.tenant.tenantId,
            ctx.tenant.projectId,
            step.id,
            'rejected',
            stepPersistArgs(ctx, step),
          );

          await deps.publisher.publish(
            `workflow:${input.tenantId}:execution:${executionId}:status`,
            JSON.stringify({
              type: 'workflow.rejected',
              executionId,
              stepId: step.id,
              decidedBy: decision.decidedBy,
              reason: decision.reason,
              timestamp: new Date().toISOString(),
            }),
          );

          // Route via on_reject edge; fall back to on_failure only if no reject edge exists
          const approvalRejectRouting =
            onRejectSteps && onRejectSteps.length > 0 ? onRejectSteps : null;
          if (approvalRejectRouting) {
            return { status: 'completed', activatedSuccessors: approvalRejectRouting };
          }

          // No on_reject routing — terminate workflow as rejected
          const approvalRejectReason = `Approval rejected by ${decision.decidedBy}: ${decision.reason || 'no reason'}`;
          const approvalRejectOutput = buildFailureOutput(approvalRejectReason);
          await deps.persistence.updateExecutionStatus(
            executionId,
            input.tenantId,
            input.projectId,
            'rejected',
            { context: ctx, output: approvalRejectOutput },
          );
          return {
            status: 'workflow_terminated',
            result: {
              status: 'rejected',
              context: ctx,
              error: { code: 'APPROVAL_REJECTED', message: approvalRejectReason },
              output: approvalRejectOutput,
            },
          };
        }

        // Approval accepted — update step status
        setStepContext(
          ctx,
          step,
          rebuildStepContext(step.type, getStepContext(ctx, step), { status: 'approved' }),
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'approved',
          stepPersistArgs(ctx, step),
        );
      }
      await markStepCompleted(step, ctx, deps, executionId);
    }

    // ── Suspension: human_task ──────────────────────────────────────────
    if (result.humanTaskRequest !== undefined) {
      const taskReq = result.humanTaskRequest as HumanTaskRequest;
      const humanTaskStep = step as unknown as HumanTaskStep;
      if (restateCtx) {
        const { id: humanTaskAwakeableId, promise: humanTaskAwakeablePromise } =
          restateCtx.awakeable<HumanTaskResponse>();
        setStepContext(
          ctx,
          step,
          rebuildStepContext(step.type, getStepContext(ctx, step), {
            status: 'waiting_human_task',
            awakeableId: humanTaskAwakeableId,
          }),
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'waiting_human_task',
          stepPersistArgs(ctx, step),
        );

        // Create HumanTask record in MongoDB (idempotent — skip if already exists for this step)
        await ensureHumanTaskMirror(
          deps.humanTaskStore,
          {
            tenantId: taskReq.tenantId,
            projectId: taskReq.projectId,
            sourceType: 'workflow_human_task',
            executionId,
            stepId: step.id,
          },
          () => {
            // Normalize the engine's human_task onTimeout vocabulary
            // ('expire'|'escalate'|'auto_complete'|'skip') to the UI-facing
            // ('terminate'|'skip') shape that the inbox surfaces.
            const humanOnTimeout =
              taskReq.timeoutMs != null
                ? taskReq.onTimeout === 'skip'
                  ? ('skip' as const)
                  : ('terminate' as const)
                : undefined;
            return {
              tenantId: taskReq.tenantId,
              projectId: taskReq.projectId,
              type: taskReq.taskType as 'approval' | 'data_entry' | 'review' | 'decision',
              mailbox: 'workflow',
              priority: taskReq.priority as 'low' | 'medium' | 'high' | 'critical',
              title: taskReq.title,
              description: taskReq.description,
              source: {
                type: 'workflow_human_task',
                workflowId: input.workflowId,
                executionId,
                stepId: step.id,
              },
              // Store the full specific-assignee list on the task:
              // - empty (no assignTo or only 'everyone') → open pool
              // - length 1 → direct assignment (no claim needed)
              // - length ≥ 2 → scoped pool (first-claim-wins)
              assignedTo: (() => {
                const specific = taskReq.assignTo?.filter((a) => a !== 'everyone') ?? [];
                return specific.length > 0 ? specific : undefined;
              })(),
              fields: taskReq.fields,
              context: taskReq.context,
              dueAt:
                taskReq.timeoutMs != null ? new Date(Date.now() + taskReq.timeoutMs) : undefined,
              onTimeout: humanOnTimeout,
            };
          },
        );

        {
          const { controlFlow: _cf, ...waitingHtData } = (getStepContext(ctx, step) ??
            {}) as Record<string, unknown>;
          void _cf;
          await deps.publisher.publish(
            `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
            JSON.stringify({
              type: 'step.waiting_human_task',
              executionId,
              stepId: step.id,
              stepName: step.name ?? step.id,
              stepType: step.type,
              status: 'waiting_human_task',
              timestamp: new Date().toISOString(),
              stepData: waitingHtData,
            }),
          );
        }

        // Race human task awakeable against cancellation and (optional) timeout
        const timeoutMs = taskReq.timeoutMs;
        log.info('Human task suspension', {
          executionId,
          stepId: step.id,
          timeoutMs,
          hasTimeout: timeoutMs != null,
          onTimeout: taskReq.onTimeout,
        });
        let response: HumanTaskResponse;
        try {
          const raw = await raceCancel(
            restateCtx,
            timeoutMs != null
              ? raceTimeout(restateCtx, humanTaskAwakeablePromise, timeoutMs)
              : humanTaskAwakeablePromise,
          );
          response = raw as HumanTaskResponse;
        } catch (err) {
          if (err instanceof TimeoutError) {
            log.info('Human task timed out', { executionId, stepId: step.id, timeoutMs });
            response = buildTimeoutResponse(humanTaskStep);
          } else {
            throw err;
          }
        }

        {
          const htCtx = getStepContext(ctx, step);
          setStepContext(
            ctx,
            step,
            rebuildStepContext(step.type, htCtx, {
              output: {
                ...((htCtx?.output as Record<string, unknown>) ?? {}),
                humanTaskResponse: response,
              },
            }),
          );
        }

        // Handle skip (task timed out with "skip this step" configured)
        if (response.decision === 'skipped') {
          setStepContext(
            ctx,
            step,
            rebuildStepContext(step.type, getStepContext(ctx, step), { status: 'skipped' }),
          );
          await deps.persistence.updateStepStatus(
            executionId,
            ctx.tenant.tenantId,
            ctx.tenant.projectId,
            step.id,
            'skipped',
            stepPersistArgs(ctx, step),
          );

          // Update HumanTask record to cancelled
          await finalizeHumanTaskOnTimeout(
            deps.humanTaskStore,
            {
              tenantId: ctx.tenant.tenantId,
              projectId: ctx.tenant.projectId,
              executionId,
              stepId: step.id,
            },
            {
              status: 'cancelled',
              decision: 'skipped',
              notes: 'Timed out — step skipped',
              logLabel: 'Failed to update HumanTask on skip timeout',
            },
          );

          {
            const { controlFlow: _cf, ...skippedStepData } = (getStepContext(ctx, step) ??
              {}) as Record<string, unknown>;
            void _cf;
            await deps.publisher.publish(
              `workflow:${input.tenantId}:execution:${executionId}:status`,
              JSON.stringify({
                type: 'step.skipped',
                executionId,
                stepId: step.id,
                stepName: step.name ?? step.id,
                stepType: step.type,
                status: 'skipped',
                timestamp: new Date().toISOString(),
                stepData: skippedStepData,
                reason: 'Human task timed out — skipped',
              }),
            );
          }
          // Continue to the next step via success edge (onSuccessSteps already queued)
          if (activatedSuccessors.length > 0) {
            return { status: 'completed', activatedSuccessors };
          }
          return { status: 'terminal_no_successors' };
        }

        // Handle expiry / terminate (task timed out — fail the workflow)
        if (response.decision === 'expired') {
          setStepContext(
            ctx,
            step,
            rebuildStepContext(step.type, getStepContext(ctx, step), { status: 'failed' }),
          );
          await deps.persistence.updateStepStatus(
            executionId,
            ctx.tenant.tenantId,
            ctx.tenant.projectId,
            step.id,
            'failed',
            stepPersistArgs(ctx, step),
          );

          // Update HumanTask record to expired
          await finalizeHumanTaskOnTimeout(
            deps.humanTaskStore,
            {
              tenantId: ctx.tenant.tenantId,
              projectId: ctx.tenant.projectId,
              executionId,
              stepId: step.id,
            },
            {
              status: 'expired',
              decision: 'expired',
              notes: 'Timed out — workflow terminated',
              logLabel: 'Failed to update HumanTask on expire timeout',
            },
          );

          const htExpiredReason = `Human task expired: ${taskReq.title}`;
          const htExpiredOutput = buildFailureOutput(htExpiredReason);
          await deps.persistence.updateExecutionStatus(
            executionId,
            input.tenantId,
            input.projectId,
            'failed',
            { context: ctx, output: htExpiredOutput },
          );
          await deps.publisher.publish(
            `workflow:${input.tenantId}:execution:${executionId}:status`,
            JSON.stringify({
              type: 'workflow.failed',
              executionId,
              stepId: step.id,
              reason: htExpiredReason,
              timestamp: new Date().toISOString(),
            }),
          );
          return {
            status: 'workflow_terminated',
            result: {
              status: 'failed',
              context: ctx,
              error: {
                code: 'HUMAN_TASK_EXPIRED',
                message: htExpiredReason,
              },
              output: htExpiredOutput,
            },
          };
        }

        // Handle rejection — route to on_reject edge if available
        if (response.decision === 'rejected') {
          setStepContext(
            ctx,
            step,
            rebuildStepContext(step.type, getStepContext(ctx, step), { status: 'rejected' }),
          );
          await deps.persistence.updateStepStatus(
            executionId,
            ctx.tenant.tenantId,
            ctx.tenant.projectId,
            step.id,
            'rejected',
            stepPersistArgs(ctx, step),
          );

          {
            const { controlFlow: _cf, ...rejectedStepData } = (getStepContext(ctx, step) ??
              {}) as Record<string, unknown>;
            void _cf;
            await deps.publisher.publish(
              `workflow:${input.tenantId}:execution:${executionId}:status`,
              JSON.stringify({
                type: 'step.rejected',
                executionId,
                stepId: step.id,
                stepName: step.name ?? step.id,
                stepType: step.type,
                status: 'rejected',
                timestamp: new Date().toISOString(),
                stepData: rejectedStepData,
                decidedBy: response.respondedBy,
                reason: response.notes,
              }),
            );
          }

          // Route via on_reject edge; fall back to on_failure only if no reject edge exists
          const rejectRouting = onRejectSteps && onRejectSteps.length > 0 ? onRejectSteps : null;
          if (rejectRouting) {
            return { status: 'completed', activatedSuccessors: rejectRouting };
          }

          // No on_reject routing — terminate workflow as rejected
          const htRejectReason = `Rejected by ${response.respondedBy}: ${response.notes || 'no reason'}`;
          const htRejectOutput = buildFailureOutput(htRejectReason);
          await deps.persistence.updateExecutionStatus(
            executionId,
            input.tenantId,
            input.projectId,
            'rejected',
            { context: ctx, output: htRejectOutput },
          );
          return {
            status: 'workflow_terminated',
            result: {
              status: 'rejected',
              context: ctx,
              error: {
                code: 'APPROVAL_REJECTED',
                message: htRejectReason,
              },
              output: htRejectOutput,
            },
          };
        }

        // Task completed successfully
        setStepContext(
          ctx,
          step,
          rebuildStepContext(step.type, getStepContext(ctx, step), { status: 'completed' }),
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'completed',
          stepPersistArgs(ctx, step),
        );
      }
      await markStepCompleted(step, ctx, deps, executionId);
    }

    // ── Suspension: async webhook ───────────────────────────────────────
    if (result.webhookRequest !== undefined) {
      const webhookReq = result.webhookRequest as AsyncWebhookRequest;
      if (restateCtx) {
        const asyncStep = step as AsyncWebhookStep;
        const webhookRetry = asyncStep.retry;
        const maxAttempts = webhookRetry?.maxAttempts ?? 1;
        const baseDelayMs = webhookRetry?.delayMs ?? 1000;
        const backoffMultiplier = webhookRetry?.backoffMultiplier ?? 2;

        // Generate and immediately encrypt the per-step HMAC secret inside the
        // ctx.run lambda so Restate journals only the ciphertext — not the
        // plaintext. On replay the journaled ciphertext is returned directly and
        // decrypted outside the lambda to recover the plaintext for header injection.
        const encryptedCallbackSecret = deps.encryptSecret
          ? await restateCtx.run('gen-callback-secret', async () => {
              const plain = randomBytes(32).toString('hex');
              return deps.encryptSecret!(plain, ctx.tenant.tenantId);
            })
          : undefined;
        const plainCallbackSecret =
          encryptedCallbackSecret && deps.decryptSecret
            ? await deps.decryptSecret(encryptedCallbackSecret, ctx.tenant.tenantId)
            : undefined;

        let lastWebhookErr: Error | undefined;
        let webhookDelay = baseDelayMs;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const runName =
            maxAttempts > 1
              ? `send-webhook:${step.id}:attempt:${attempt}`
              : `send-webhook:${step.id}`;
          try {
            await restateCtx.run(runName, async () => {
              const outboundHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
                ...webhookReq.headers,
              };
              if (plainCallbackSecret) {
                outboundHeaders['x-callback-secret'] = plainCallbackSecret;
              }
              const resp = await fetch(webhookReq.url, {
                method: webhookReq.method,
                headers: outboundHeaders,
                body: JSON.stringify(webhookReq.body),
              });
              if (!resp.ok) {
                throw new Error(`Webhook request failed: ${resp.status} ${resp.statusText}`);
              }
              return { status: resp.status };
            });
            lastWebhookErr = undefined;
            break;
          } catch (err) {
            lastWebhookErr = err instanceof Error ? err : new Error(String(err));
            if (attempt < maxAttempts) {
              await restateCtx.sleep(webhookDelay);
              webhookDelay = Math.round(webhookDelay * backoffMultiplier);
            }
          }
        }
        if (lastWebhookErr) throw lastWebhookErr;

        const { id: webhookAwakeableId, promise: webhookAwakeablePromise } =
          restateCtx.awakeable<unknown>();
        setStepContext(
          ctx,
          step,
          rebuildStepContext(step.type, getStepContext(ctx, step), {
            status: 'waiting_callback',
            awakeableId: webhookAwakeableId,
            ...(encryptedCallbackSecret ? { callbackSecret: encryptedCallbackSecret } : {}),
          }),
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'waiting_callback',
          stepPersistArgs(ctx, step),
        );
        {
          const waitingCbData = sanitizePublishedStepData(
            getStepContext(ctx, step) as Record<string, unknown> | undefined,
          );
          await deps.publisher.publish(
            `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
            JSON.stringify({
              type: 'step.waiting_callback',
              executionId,
              stepId: step.id,
              stepName: step.name ?? step.id,
              stepType: step.type,
              status: 'waiting_callback',
              timestamp: new Date().toISOString(),
              stepData: waitingCbData,
            }),
          );
        }

        const callbackTimeoutMs = getAsyncWebhookTimeout(asyncStep);
        let callbackPayload: unknown;
        try {
          callbackPayload = await raceCancel(
            restateCtx,
            raceTimeout(restateCtx, webhookAwakeablePromise, callbackTimeoutMs),
          );
        } catch (err) {
          if (err instanceof TimeoutError) {
            const timeoutError = {
              code: StepErrorCode.STEP_TIMEOUT,
              message: `Async webhook callback timed out after ${callbackTimeoutMs}ms`,
            };
            setStepContext(
              ctx,
              step,
              rebuildStepContext(step.type, getStepContext(ctx, step), {
                status: 'failed',
                completedAt: new Date().toISOString(),
                error: timeoutError,
              }),
            );
            await deps.persistence.updateStepStatus(
              executionId,
              ctx.tenant.tenantId,
              ctx.tenant.projectId,
              step.id,
              'failed',
              stepPersistArgs(ctx, step),
            );
            throw new WorkflowStepError(timeoutError.code, timeoutError.message);
          }
          throw err;
        }
        {
          const webhookCtx = getStepContext(ctx, step);
          setStepContext(
            ctx,
            step,
            rebuildStepContext(step.type, webhookCtx, {
              output: {
                ...((webhookCtx?.output as Record<string, unknown>) ?? {}),
                callbackPayload,
              },
            }),
          );
        }
      }
      await markStepCompleted(step, ctx, deps, executionId);
    }

    // ── Suspension: tool wait-for-completion ────────────────────────────
    if (result.toolRequest !== undefined) {
      const toolReq = result.toolRequest as AsyncToolWaitRequest;
      if (!restateCtx) {
        throw new Error('Tool wait-for-completion requires Restate context');
      }
      if (!deps.dispatcherDeps.toolClient) {
        throw new Error('ToolExecutionClient not configured');
      }
      if (!deps.encryptSecret) {
        throw new Error('Tool wait-for-completion requires callback secret encryption');
      }
      if (!deps.decryptSecret) {
        throw new Error('Tool wait-for-completion requires callback secret decryption');
      }

      const toolStep = step as import('../executors/tool-call-executor.js').ToolCallStep;
      // Encrypt inside ctx.run so Restate journals only ciphertext; decrypt outside for plaintext use.
      const encryptedCallbackSecret = await restateCtx.run(
        `gen-tool-callback-secret:${step.id}`,
        async () => {
          const plain = randomBytes(32).toString('hex');
          return deps.encryptSecret!(plain, ctx.tenant.tenantId);
        },
      );
      const plainCallbackSecret = await deps.decryptSecret(
        encryptedCallbackSecret,
        ctx.tenant.tenantId,
      );
      const toolRetry = toolStep.retry;
      const maxAttempts = toolRetry?.maxAttempts ?? 1;
      const baseDelayMs = toolRetry?.delayMs ?? 1000;
      const backoffMultiplier = toolRetry?.backoffMultiplier ?? 2;
      let lastToolErr: Error | undefined;
      let toolDelay = baseDelayMs;
      let toolResult:
        | Awaited<ReturnType<typeof deps.dispatcherDeps.toolClient.executeTool>>
        | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const runName =
          maxAttempts > 1
            ? `execute-async-tool:${step.id}:attempt:${attempt}`
            : `execute-async-tool:${step.id}`;
        try {
          toolResult = await restateCtx.run(runName, async () =>
            deps.dispatcherDeps.toolClient!.executeTool({
              toolName: toolReq.toolName,
              params: toolReq.params,
              tenantId: ctx.tenant.tenantId,
              projectId: ctx.tenant.projectId,
              executionMode: toolReq.executionMode,
              timeout: toolStep.timeout,
              ...(typeof input.triggerMetadata?.userId === 'string'
                ? { actorUserId: input.triggerMetadata.userId }
                : typeof input.triggerMetadata?.triggeredBy === 'string'
                  ? { actorUserId: input.triggerMetadata.triggeredBy }
                  : {}),
              callback: {
                url: toolReq.callbackUrl,
                secret: plainCallbackSecret,
              },
              ...(toolReq.callbackConfig ? { callbackConfig: toolReq.callbackConfig } : {}),
              ...(toolReq.asyncHttpSuccess ? { asyncHttpSuccess: toolReq.asyncHttpSuccess } : {}),
            }),
          );
          lastToolErr = undefined;
          break;
        } catch (err) {
          lastToolErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxAttempts) {
            await restateCtx.sleep(toolDelay);
            toolDelay = Math.round(toolDelay * backoffMultiplier);
          }
        }
      }
      if (lastToolErr) throw lastToolErr;
      if (!toolResult?.success) {
        throw new Error(toolResult?.error.message ?? 'Async tool execution failed');
      }
      const httpAsyncWaitAccepted =
        toolReq.callbackConfig !== undefined &&
        (toolResult.status === 'accepted' || toolResult.status === 'completed');
      if (!httpAsyncWaitAccepted && toolResult.status !== 'accepted') {
        throw new Error(`Tool "${toolReq.toolName}" did not enter async wait mode`);
      }
      if (httpAsyncWaitAccepted && toolResult.status === 'completed') {
        log.warn('Async tool returned completed inline — server may have skipped async mode', {
          toolName: toolReq.toolName,
          stepId: step.id,
        });
      }

      const { id: toolAwakeableId, promise: toolAwakeablePromise } =
        restateCtx.awakeable<unknown>();
      setStepContext(
        ctx,
        step,
        rebuildStepContext(step.type, getStepContext(ctx, step), {
          status: 'waiting_callback',
          output: toolResult.output,
          callbackSecret: encryptedCallbackSecret,
          awakeableId: toolAwakeableId,
        }),
      );
      await deps.persistence.updateStepStatus(
        executionId,
        ctx.tenant.tenantId,
        ctx.tenant.projectId,
        step.id,
        'waiting_callback',
        stepPersistArgs(ctx, step),
      );
      await deps.publisher.publish(
        `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
        JSON.stringify({
          type: 'step.waiting_callback',
          executionId,
          stepId: step.id,
          stepName: step.name ?? step.id,
          stepType: step.type,
          status: 'waiting_callback',
          timestamp: new Date().toISOString(),
          stepData: sanitizePublishedStepData(
            getStepContext(ctx, step) as Record<string, unknown> | undefined,
          ),
        }),
      );

      const callbackTimeoutMs = toolStep.timeout ?? DEFAULT_CALLBACK_TIMEOUT_MS;
      let callbackPayload: unknown;
      try {
        callbackPayload = await raceCancel(
          restateCtx,
          raceTimeout(restateCtx, toolAwakeablePromise, callbackTimeoutMs),
        );
      } catch (err) {
        if (err instanceof TimeoutError) {
          const timeoutError = {
            code: StepErrorCode.STEP_TIMEOUT,
            message: `Tool callback timed out after ${callbackTimeoutMs}ms`,
          };
          setStepContext(
            ctx,
            step,
            rebuildStepContext(step.type, getStepContext(ctx, step), {
              status: 'failed',
              completedAt: new Date().toISOString(),
              error: timeoutError,
            }),
          );
          await deps.persistence.updateStepStatus(
            executionId,
            ctx.tenant.tenantId,
            ctx.tenant.projectId,
            step.id,
            'failed',
            stepPersistArgs(ctx, step),
          );
          throw new WorkflowStepError(timeoutError.code, timeoutError.message);
        }
        throw err;
      }

      const payload =
        callbackPayload && typeof callbackPayload === 'object'
          ? (callbackPayload as AsyncToolCallbackPayload)
          : {};
      const callbackStatus = typeof payload.status === 'string' ? payload.status : 'completed';
      const isHttpAsyncWait = toolReq.callbackConfig !== undefined;
      const normalizedOutput = {
        executionId: payload.executionId,
        status: callbackStatus,
        ...(payload.output !== undefined ? { output: payload.output } : {}),
        ...(payload.error ? { error: payload.error } : {}),
      };

      if (callbackStatus !== 'completed') {
        const callbackErrorCode =
          typeof payload.error?.code === 'string' &&
          Object.values(StepErrorCode).includes(
            payload.error.code as (typeof StepErrorCode)[keyof typeof StepErrorCode],
          )
            ? (payload.error.code as (typeof StepErrorCode)[keyof typeof StepErrorCode])
            : StepErrorCode.STEP_FAILED;
        const callbackError = {
          code: callbackErrorCode,
          message:
            typeof payload.error?.message === 'string'
              ? payload.error.message
              : `Async tool completed with non-success status "${callbackStatus}"`,
        };
        setStepContext(
          ctx,
          step,
          rebuildStepContext(step.type, getStepContext(ctx, step), {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: callbackError,
            output: normalizedOutput,
          }),
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'failed',
          stepPersistArgs(ctx, step),
        );
        throw new WorkflowStepError(callbackError.code, callbackError.message);
      }

      setStepContext(
        ctx,
        step,
        rebuildStepContext(step.type, getStepContext(ctx, step), {
          output: isHttpAsyncWait ? payload.output : normalizedOutput,
        }),
      );
      await markStepCompleted(step, ctx, deps, executionId);
    }

    // ── Suspension: connector async parking (workflow-docling extraction, …) ──
    //
    // The action body has enqueued external work (e.g. a BullMQ workflow-docling
    // job) and returned an AsyncParkingSentinel. We persist the encrypted
    // callback secret on the step record (canonical source of truth for HMAC
    // verification on resume), publish `step.waiting_callback`, then park on
    // `restateCtx.promise<unknown>(`sys:callback:${step.id}`).get()` until the
    // worker POSTs the result. On TimeoutError we surface `STEP_TIMEOUT`.
    if (result.callbackRequest !== undefined && restateCtx) {
      const callbackReq = result.callbackRequest;
      const parkStartMs = Date.now();
      incrementParked(ctx.tenant.tenantId);
      // Snapshot the connector + action + source URL up-front so the audit
      // emitter has stable identity across the timeout / success / failure
      // exit paths. `step` is the WorkflowStep union — only connector_action
      // steps carry `connector` / `action` (other suspension types like
      // approval / human_task come through here but the audit envelope is
      // extraction-shaped; emit only when both fields are present).
      const connectorStep =
        step.type === 'connector_action'
          ? (step as unknown as {
              connector?: string;
              action?: string;
              params?: Record<string, unknown>;
            })
          : null;
      const auditConnector = connectorStep?.connector ?? '';
      const auditAction = connectorStep?.action ?? '';
      const auditSourceUrl =
        typeof connectorStep?.params?.fileUrl === 'string'
          ? (connectorStep.params.fileUrl as string)
          : typeof connectorStep?.params?.sourceUrl === 'string'
            ? (connectorStep.params.sourceUrl as string)
            : '';
      const auditEmitter = deps.extractionAuditEmitter;
      const emitAudit = (status: string, sizeBytes: number): void => {
        if (!auditEmitter || !auditConnector || !auditAction) return;
        auditEmitter.emit({
          actor: 'system:workflow',
          tenantId: ctx.tenant.tenantId,
          projectId: ctx.tenant.projectId,
          connector: auditConnector,
          action: auditAction,
          sourceUrl: auditSourceUrl,
          sizeBytes,
          durationMs: Date.now() - parkStartMs,
          status,
        });
      };
      // Create the awakeable before persisting so its ID lands in Mongo with
      // the waiting_callback status. The callback route reads awakeableId from
      // the step record and resolves via /restate/awakeables/:id/resolve
      // (built-in Restate endpoint) instead of the workflow.shared handler path,
      // bypassing the 1.6.2 suspended-run re-dispatch bug.
      const { id: awakeableId, promise: awakeablePromise } = restateCtx.awakeable<unknown>();
      setStepContext(
        ctx,
        step,
        rebuildStepContext(step.type, getStepContext(ctx, step), {
          status: 'waiting_callback',
          awakeableId,
          ...(callbackReq.encryptedCallbackSecret
            ? { callbackSecret: callbackReq.encryptedCallbackSecret }
            : {}),
        }),
      );
      await deps.persistence.updateStepStatus(
        executionId,
        ctx.tenant.tenantId,
        ctx.tenant.projectId,
        step.id,
        'waiting_callback',
        stepPersistArgs(ctx, step),
      );
      {
        const waitingCbData = sanitizePublishedStepData(
          getStepContext(ctx, step) as Record<string, unknown> | undefined,
        );
        await deps.publisher.publish(
          `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
          JSON.stringify({
            type: 'step.waiting_callback',
            executionId,
            stepId: step.id,
            stepName: step.name ?? step.id,
            stepType: step.type,
            status: 'waiting_callback',
            timestamp: new Date().toISOString(),
            stepData: waitingCbData,
          }),
        );
      }

      let callbackPayload: unknown;
      try {
        callbackPayload = await raceCancel(
          restateCtx,
          raceTimeout(restateCtx, awakeablePromise, callbackReq.callbackTimeoutMs),
        );
      } catch (err) {
        decrementParked(ctx.tenant.tenantId);
        if (err instanceof TimeoutError) {
          recordExtractionWaitMs(Date.now() - parkStartMs, {
            tenant: ctx.tenant.tenantId,
            status: 'timeout',
          });
          emitAudit('STEP_TIMEOUT', 0);
          const timeoutError = {
            code: StepErrorCode.STEP_TIMEOUT,
            message: `Connector async callback timed out after ${callbackReq.callbackTimeoutMs}ms`,
          };
          setStepContext(
            ctx,
            step,
            rebuildStepContext(step.type, getStepContext(ctx, step), {
              status: 'failed',
              completedAt: new Date().toISOString(),
              error: timeoutError,
            }),
          );
          await deps.persistence.updateStepStatus(
            executionId,
            ctx.tenant.tenantId,
            ctx.tenant.projectId,
            step.id,
            'failed',
            stepPersistArgs(ctx, step),
          );
          throw new WorkflowStepError(timeoutError.code, timeoutError.message);
        }
        throw err;
      }
      decrementParked(ctx.tenant.tenantId);

      const rawCallbackOutput =
        callbackPayload && typeof callbackPayload === 'object'
          ? (callbackPayload as Record<string, unknown>)
          : { value: callbackPayload };
      // PII / secret redaction before the output reaches step context, the
      // status publisher, or the persisted step row. Extraction envelopes
      // commonly carry user-supplied document content; treating the whole
      // callback payload as a trace event lets shared scrubbing logic strip
      // API keys, bearer tokens, and PII patterns without per-call-site
      // configuration (Phase 4 task 4.7).
      const callbackOutput = scrubTraceEvent(rawCallbackOutput);
      const callbackStatus =
        typeof callbackOutput.status === 'string' ? (callbackOutput.status as string) : 'success';
      recordExtractionWaitMs(Date.now() - parkStartMs, {
        tenant: ctx.tenant.tenantId,
        status: callbackStatus,
      });
      const auditSizeBytes =
        callbackStatus === 'success'
          ? Buffer.byteLength(JSON.stringify(callbackOutput), 'utf8')
          : 0;
      // Engine-side envelope-size histogram (HLD §4.2 / Round-7 add). The
      // search-ai worker emits a log-line mirror; this OTel histogram is the
      // durable surface used by the dashboard panel + alerting.
      if (callbackStatus === 'success' && auditConnector) {
        recordEnvelopeBytes(auditSizeBytes, { provider: auditConnector });
      }
      if (callbackStatus === 'failed') {
        const errorObj = callbackOutput.error as { code?: unknown; message?: unknown } | undefined;
        // Only accept error codes that are part of the canonical StepErrorCode
        // enum; arbitrary worker-side classifications (e.g. EXTRACTION_TOO_LARGE)
        // fall back to STEP_FAILED at the engine surface so the workflow's
        // public error envelope stays well-typed.
        const rawCode = typeof errorObj?.code === 'string' ? errorObj.code : '';
        // HLD §4.2 — count rate-limit rejections per-tenant. The raw error
        // code (before normalization to StepErrorCode) is what the worker
        // surfaced; `RATE_LIMITED` is the connector-body classification.
        if (rawCode === 'RATE_LIMITED' && auditConnector) {
          recordExtractionRateLimited({
            tenant: ctx.tenant.tenantId,
            provider: auditConnector,
          });
        }
        const code = Object.values(StepErrorCode).includes(
          rawCode as (typeof StepErrorCode)[keyof typeof StepErrorCode],
        )
          ? (rawCode as (typeof StepErrorCode)[keyof typeof StepErrorCode])
          : StepErrorCode.STEP_FAILED;
        const message =
          typeof errorObj?.message === 'string' ? errorObj.message : 'Callback reported failure';
        const callbackError = { code, message };
        setStepContext(
          ctx,
          step,
          rebuildStepContext(step.type, getStepContext(ctx, step), {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: callbackError,
            output: callbackOutput,
          }),
        );
        await deps.persistence.updateStepStatus(
          executionId,
          ctx.tenant.tenantId,
          ctx.tenant.projectId,
          step.id,
          'failed',
          stepPersistArgs(ctx, step),
        );
        emitAudit(code, 0);
        throw new WorkflowStepError(code, message);
      }

      setStepContext(
        ctx,
        step,
        rebuildStepContext(step.type, getStepContext(ctx, step), {
          output: callbackOutput,
        }),
      );
      emitAudit('success', auditSizeBytes);
      await markStepCompleted(step, ctx, deps, executionId);
    }

    // Check for cancellation between non-suspension steps
    if (restateCtx && !hasSuspension(result)) {
      const cancelled = await restateCtx.promise<boolean>('sys:cancel').peek();
      if (cancelled) {
        throw new CancellationError();
      }
    }

    if (activatedSuccessors.length > 0) {
      return { status: 'completed', activatedSuccessors };
    }
    return { status: 'terminal_no_successors' };
  }

  // Create initial execution record with Start and End boundary entries in
  // context.steps. Both start as `pending` and transition through updateStepStatus
  // calls along with every other step.
  const loopBodyStepIds = getAllLoopBodyStepIds(input.steps);
  const stepRecords: Array<{
    stepId: string;
    name: string;
    type: string;
    status: string;
    loopConfig?: { mode?: 'sequential' | 'parallel'; concurrencyLimit?: number };
  }> = [
    {
      stepId: 'start',
      name: 'Start',
      type: 'start',
      status: startValidation.ok ? 'completed' : 'pending',
    },
    ...input.steps
      .filter((s) => !loopBodyStepIds.has(s.id))
      .map((s) => ({
        stepId: s.id,
        name: s.name || s.type,
        type: s.type,
        status: 'pending',
        ...(s.type === 'loop'
          ? {
              loopConfig: {
                mode: (s as unknown as { config?: { mode?: string } }).config?.mode as
                  | 'sequential'
                  | 'parallel'
                  | undefined,
                concurrencyLimit: (s as unknown as { config?: { concurrencyLimit?: number } })
                  .config?.concurrencyLimit,
              },
            }
          : {}),
      })),
    { stepId: 'end', name: 'End', type: 'end', status: 'pending' },
  ];
  await deps.persistence.createExecution({
    executionId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    workflowId: input.workflowId,
    workflowVersionId: input.workflowVersionId,
    workflowVersion: input.workflowVersion,
    status: 'running',
    triggerType: input.triggerType,
    triggerPayload: input.triggerPayload,
    triggerMetadata: input.triggerMetadata,
    steps: stepRecords,
    webhookMode: input.webhookMode,
    webhookDelivery: input.webhookDelivery,
    // Relay-race: snapshot the full execution input so every leg can
    // reconstruct the DAG without relying on Restate's journal.
    inputSnapshot: input,
  });

  // Emit Start step.started — downstream consumers (SSE, Studio debug panel)
  // see the boundary step lifecycle in natural order.
  await executionDeps.publisher.publish(
    `workflow:${input.tenantId}:execution:${executionId}:status`,
    JSON.stringify({
      type: 'step.started',
      executionId,
      stepId: 'start',
      stepName: 'Start',
      stepType: 'start',
      status: 'running',
      timestamp: startTime,
    }),
  );

  if (!startValidation.ok) {
    // Validation failed — persist the Start step as failed with per-field
    // errors in mappingErrors, emit step.failed + workflow.failed, and return
    // a failed result. The step queue never runs and no other steps transition.
    const fieldErrors: FieldError[] = startValidation.errors;
    const errorMessage = `${fieldErrors.length} input field${
      fieldErrors.length === 1 ? '' : 's'
    } failed validation`;
    const startError = { code: 'INPUT_VALIDATION_FAILED', message: errorMessage };
    ctx.steps.start = buildCleanStepContext(
      'start',
      {
        nodeType: 'start',
        stepId: 'start',
        status: 'failed',
        completedAt: new Date().toISOString(),
        durationMs: startValidationDurationMs,
        error: startError,
      },
      {
        nodeType: 'start',
        input: input.triggerPayload,
        metrics: { processingTimeMs: startValidationDurationMs },
        mappingErrors: fieldErrors.map((e) => ({
          name: e.name,
          error: `${e.reason}${e.expected ? ` (expected ${e.expected}` : ''}${
            e.got ? `, got ${e.got})` : e.expected ? ')' : ''
          }`,
        })),
      },
    );
    await deps.persistence.updateStepStatus(
      executionId,
      input.tenantId,
      input.projectId,
      'start',
      'failed',
      { stepKey: 'start', stepData: ctx.steps.start as WorkflowStepData },
    );
    await executionDeps.publisher.publish(
      `workflow:${input.tenantId}:execution:${executionId}:status`,
      JSON.stringify({
        type: 'step.failed',
        executionId,
        stepId: 'start',
        stepName: 'Start',
        stepType: 'start',
        status: 'failed',
        timestamp: new Date().toISOString(),
        stepData: sanitizePublishedStepData(ctx.steps.start as Record<string, unknown> | undefined),
        error: errorMessage,
        errorCode: startError.code,
      }),
    );

    const failOutput = buildFailureOutput(errorMessage);
    const completedAt = new Date();
    await deps.persistence.updateExecutionStatus(
      executionId,
      input.tenantId,
      input.projectId,
      'failed',
      {
        context: ctx,
        error: { code: 'WORKFLOW_FAILED', message: errorMessage },
        output: failOutput,
        completedAt,
      },
    );
    await executionDeps.publisher.publish(
      `workflow:${input.tenantId}:execution:${executionId}:status`,
      JSON.stringify({
        type: 'workflow.failed',
        executionId,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      }),
    );

    return {
      status: 'failed',
      context: ctx,
      error: { code: 'WORKFLOW_FAILED', message: errorMessage },
      output: failOutput,
      startTime,
      endTime: completedAt.toISOString(),
    };
  }

  // Validation succeeded — mark Start as completed with typed output + metrics.
  ctx.steps.start = buildCleanStepContext(
    'start',
    {
      nodeType: 'start',
      stepId: 'start',
      status: 'completed',
      completedAt: new Date().toISOString(),
      durationMs: startValidationDurationMs,
    },
    {
      input: input.triggerPayload,
      output: { ...startValidation.coerced },
      metrics: { processingTimeMs: startValidationDurationMs },
    },
  );
  await deps.persistence.updateStepStatus(
    executionId,
    input.tenantId,
    input.projectId,
    'start',
    'completed',
    { stepKey: 'start', stepData: ctx.steps.start as WorkflowStepData },
  );
  await executionDeps.publisher.publish(
    `workflow:${input.tenantId}:execution:${executionId}:status`,
    JSON.stringify({
      type: 'step.completed',
      executionId,
      stepId: 'start',
      stepName: 'Start',
      stepType: 'start',
      status: 'completed',
      timestamp: new Date().toISOString(),
      stepData: sanitizePublishedStepData(ctx.steps.start as Record<string, unknown> | undefined),
      durationMs: startValidationDurationMs,
    }),
  );

  await executionDeps.publisher.publish(
    `workflow:${input.tenantId}:execution:${executionId}:status`,
    JSON.stringify({ type: 'workflow.started', executionId, timestamp: new Date().toISOString() }),
  );

  try {
    const reachedEndNodeIds = new Set<string>();
    const noteReachedEndIds = (outcome: StepOutcome): void => {
      if (outcome.status !== 'completed') return;
      for (const nextId of outcome.activatedSuccessors) {
        if (input.outputMappingsByEndNodeId?.[nextId]) {
          reachedEndNodeIds.add(nextId);
        }
      }
    };

    // Dispatch steps.
    // Canvas parallel workflows supply input.inDegreeMap → use the DAG executor for
    // fan-out/fan-in. Legacy sequential workflows omit it → use the queue loop.
    if (input.inDegreeMap && Object.keys(input.inDegreeMap).length > 0) {
      const rootStepIds = Object.entries(input.inDegreeMap)
        .filter(([id, deg]) => deg === 0 && !loopBodyStepIds.has(id))
        .map(([id]) => id);
      await executeDag({
        stepIndex,
        inDegreeMap: input.inDegreeMap,
        rootStepIds,
        executeStep: async (step) => {
          const outcome = await executeStepWithSuspension(
            step,
            ctx,
            executionDeps,
            executionId,
            restateCtx,
            {
              nonFatalStepFailures: true,
            },
          );
          noteReachedEndIds(outcome);
          return outcome;
        },
        ctx,
      });

      // Skip-propagated DAG nodes are intentionally internal state. They should
      // not be added to context.steps because skipped branches were not traversed.
    } else {
      // Legacy sequential queue — processes all input steps in order.
      // Steps without explicit routing keep the queue as-is; routed steps
      // replace the queue with their activated successors.
      const queue: string[] = input.steps
        .filter((s) => !loopBodyStepIds.has(s.id))
        .map((s) => s.id);
      const maxIterations = MAX_WORKFLOW_STEPS * 2;
      let iterations = 0;
      while (queue.length > 0) {
        if (++iterations > maxIterations) {
          throw new WorkflowStepError(
            StepErrorCode.STEP_TIMEOUT,
            `Workflow exceeded maximum iterations (${maxIterations}), possible cycle detected`,
          );
        }
        const stepId = queue.shift()!;
        const step = stepIndex.get(stepId);
        if (!step) continue;

        let outcome: StepOutcome;
        try {
          outcome = await executeStepWithSuspension(
            step,
            ctx,
            executionDeps,
            executionId,
            restateCtx,
          );
          noteReachedEndIds(outcome);
        } catch (stepErr) {
          if (stepErr instanceof CancellationError) throw stepErr;
          const skippedAt = new Date().toISOString();
          for (const remainingId of queue) {
            const skippedStep = stepIndex.get(remainingId);
            if (skippedStep) {
              setStepContext(
                ctx,
                skippedStep,
                rebuildStepContext(skippedStep.type, getStepContext(ctx, skippedStep), {
                  status: 'skipped',
                  completedAt: skippedAt,
                }),
              );
              await deps.persistence.updateStepStatus(
                executionId,
                ctx.tenant.tenantId,
                ctx.tenant.projectId,
                skippedStep.id,
                'skipped',
                {
                  stepKey: skippedStep.name ?? skippedStep.id,
                  stepData: getStepContext(ctx, skippedStep)!,
                },
              );
            }
          }
          throw stepErr;
        }

        switch (outcome.status) {
          case 'completed':
            queue.length = 0;
            for (const nextId of outcome.activatedSuccessors) {
              if (!loopBodyStepIds.has(nextId)) queue.push(nextId);
            }
            break;
          case 'terminal_no_successors':
            break;
          case 'workflow_terminated':
            return outcome.result as WorkflowExecutionResult;
          case 'failed':
            throw new WorkflowStepError(
              StepErrorCode.STEP_FAILED,
              'Step failed with no failure routing',
            );
        }
      }
    }

    // ── End phase: first-class lifecycle for the End boundary step ───────
    // Transitions `pending → running → completed|failed` like every other
    // step. Every declared output mapping is evaluated; failures are
    // accumulated (no short-circuit) into mappingErrors[]. Any mapping
    // failure fails the workflow (HLD D-17).
    const endMappings =
      reachedEndNodeIds.size > 0 && input.outputMappingsByEndNodeId
        ? [...reachedEndNodeIds].flatMap(
            (endNodeId) => input.outputMappingsByEndNodeId?.[endNodeId] ?? [],
          )
        : (input.outputMappings ?? []);
    const endStartedAtMs = Date.now();
    const endRunningData = buildCleanStepContext(
      'end',
      {
        nodeType: 'end',
        stepId: 'end',
        status: 'running',
        startedAt: new Date().toISOString(),
      },
      { input: endMappings },
    );
    ctx.steps.end = endRunningData;
    await deps.persistence.updateStepStatus(
      executionId,
      input.tenantId,
      input.projectId,
      'end',
      'running',
      { stepKey: 'end', stepData: endRunningData as WorkflowStepData },
    );
    await executionDeps.publisher.publish(
      `workflow:${input.tenantId}:execution:${executionId}:status`,
      JSON.stringify({
        type: 'step.started',
        executionId,
        stepId: 'end',
        stepName: 'End',
        stepType: 'end',
        status: 'running',
        timestamp: new Date().toISOString(),
        stepData: sanitizePublishedStepData(ctx.steps.end as Record<string, unknown> | undefined),
      }),
    );

    const {
      output: mappedEndOutput,
      mappingErrors: endMappingErrors,
    }: { output: Record<string, unknown>; mappingErrors: OutputMappingError[] } =
      resolveOutputMappings(endMappings, ctx);
    const resolvedOutput: Record<string, unknown> = { _status: 0, ...mappedEndOutput };
    const endDurationMs = Date.now() - endStartedAtMs;
    const endTime = new Date().toISOString();

    if (endMappingErrors.length > 0) {
      // Any failing mapping → End step fails → workflow fails (HLD D-17).
      // Persist structured per-mapping detail on the End step; the existing
      // top-level catch builds the {_status:1,_reason} workflow-level output.
      const endError = {
        code: 'OUTPUT_MAPPING_FAILED',
        message: formatOutputMappingFailureMessage(endMappingErrors, endMappings.length, 'output'),
      };
      // Mirror the End record into ctx.steps so it is visible in the
      // context snapshot persisted on the execution record (same place the
      // user-authored {{steps.<name>.output.*}} expressions read from).
      // Without this, downstream consumers of ctx.steps (debug UIs, trace
      // inspectors) see every user step but not End.
      ctx.steps.end = buildCleanStepContext(
        'end',
        {
          nodeType: 'end',
          stepId: 'end',
          status: 'failed',
          startedAt: new Date(endStartedAtMs).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: endDurationMs,
          error: endError,
        },
        {
          input: endMappings,
          output: resolvedOutput,
          metrics: { processingTimeMs: endDurationMs },
          mappingErrors: endMappingErrors,
        },
      );
      await deps.persistence.updateStepStatus(
        executionId,
        input.tenantId,
        input.projectId,
        'end',
        'failed',
        { stepKey: 'end', stepData: ctx.steps.end as WorkflowStepData },
      );
      await executionDeps.publisher.publish(
        `workflow:${input.tenantId}:execution:${executionId}:status`,
        JSON.stringify({
          type: 'step.failed',
          executionId,
          stepId: 'end',
          stepName: 'End',
          stepType: 'end',
          status: 'failed',
          timestamp: new Date().toISOString(),
          stepData: sanitizePublishedStepData(ctx.steps.end as Record<string, unknown> | undefined),
          error: endError.message,
          errorCode: endError.code,
        }),
      );
      throw new WorkflowStepError(StepErrorCode.STEP_FAILED, endError.message);
    }

    // End mapping evaluation succeeded — transition End to completed with
    // {input, output, metrics, durationMs}. Also mirror the End record into
    // ctx.steps so the context snapshot persisted on the execution record
    // exposes End alongside every user step (consistent with Start).
    ctx.steps.end = buildCleanStepContext(
      'end',
      {
        nodeType: 'end',
        stepId: 'end',
        status: 'completed',
        startedAt: new Date(endStartedAtMs).toISOString(),
        completedAt: endTime,
        durationMs: endDurationMs,
      },
      {
        input: endMappings,
        output: resolvedOutput,
        metrics: { processingTimeMs: endDurationMs },
      },
    );
    await deps.persistence.updateStepStatus(
      executionId,
      input.tenantId,
      input.projectId,
      'end',
      'completed',
      { stepKey: 'end', stepData: ctx.steps.end as WorkflowStepData },
    );
    await executionDeps.publisher.publish(
      `workflow:${input.tenantId}:execution:${executionId}:status`,
      JSON.stringify({
        type: 'step.completed',
        executionId,
        stepId: 'end',
        stepName: 'End',
        stepType: 'end',
        status: 'completed',
        timestamp: new Date().toISOString(),
        stepData: sanitizePublishedStepData(ctx.steps.end as Record<string, unknown> | undefined),
        durationMs: endDurationMs,
      }),
    );

    // Mark workflow as completed
    await deps.persistence.updateExecutionStatus(
      executionId,
      input.tenantId,
      input.projectId,
      'completed',
      {
        context: ctx,
        completedAt: new Date(),
        output: resolvedOutput,
        startTime,
        endTime,
      },
    );

    await executionDeps.publisher.publish(
      `workflow:${input.tenantId}:execution:${executionId}:status`,
      JSON.stringify({
        type: 'workflow.completed',
        executionId,
        timestamp: endTime,
        completedAt: endTime,
        durationMs: new Date(endTime).getTime() - new Date(startTime).getTime(),
        output: resolvedOutput,
      }),
    );

    // Enqueue callback delivery if callbackUrl is configured. The bearer
    // token rides as `encryptedAccessToken` — the /execute route encrypts
    // it before startWorkflow, so this frame never sees plaintext, and
    // Redis-backed job buffers never hold the token.
    if (deps.callbackQueue && callbackUrl) {
      const encryptedAccessToken = input.triggerMetadata?.encryptedAccessToken;
      const encryptedCallbackSecret = input.triggerMetadata?.encryptedCallbackSecret;
      await deps.callbackQueue.add('callback', {
        executionId,
        tenantId: input.tenantId,
        callbackUrl,
        ...(typeof encryptedAccessToken === 'string' && encryptedAccessToken.length > 0
          ? { encryptedAccessToken }
          : {}),
        ...(typeof encryptedCallbackSecret === 'string' && encryptedCallbackSecret.length > 0
          ? { encryptedCallbackSecret }
          : {}),
        source: input.triggerMetadata?.source as string | undefined,
        payload: {
          traceId: executionId,
          status: 'completed',
          output: resolvedOutput,
          startTime,
          endTime,
          executionId,
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: input.triggerMetadata?.sessionId as string | undefined,
          workflowId: input.workflowId,
          workflowName: input.workflowName,
          source: input.triggerMetadata?.source as string | undefined,
        },
      });
    }

    return {
      status: 'completed',
      context: ctx,
      output: resolvedOutput,
      startTime,
      endTime,
    };
  } catch (err) {
    if (err instanceof WorkflowTerminatedError) {
      return err.result as WorkflowExecutionResult;
    }
    const isCancelled = err instanceof CancellationError;
    const errorCode = isCancelled ? 'WORKFLOW_CANCELLED' : 'WORKFLOW_FAILED';
    const errorMessage = err instanceof Error ? err.message : String(err);
    const failOutput = buildFailureOutput(errorMessage);

    const finalStatus = isCancelled ? 'cancelled' : 'failed';
    if (finalStatus === 'failed') {
      const failedAt = new Date().toISOString();
      for (const [stepKey, stepData] of Object.entries(ctx.steps)) {
        if (stepData.status !== 'running') continue;
        ctx.steps[stepKey] = {
          ...stepData,
          status: 'failed',
          completedAt: stepData.completedAt ?? failedAt,
          error: { code: errorCode, message: errorMessage },
        };
      }
    }
    await deps.persistence.updateExecutionStatus(
      executionId,
      input.tenantId,
      input.projectId,
      finalStatus,
      {
        context: ctx,
        error: { code: errorCode, message: errorMessage },
        output: failOutput,
        completedAt: new Date(),
      },
    );

    // For user-initiated cancellation the HTTP cancel route already published
    // the workflow.cancelled event and enqueued the callback. Only publish here
    // for non-cancel terminal states (failures) to avoid duplicate events.
    if (!isCancelled) {
      await executionDeps.publisher.publish(
        `workflow:${input.tenantId}:execution:${executionId}:status`,
        JSON.stringify({
          type: 'workflow.failed',
          executionId,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        }),
      );

      // Enqueue callback delivery if callbackUrl is configured. Same
      // encrypted-bearer contract as the success path above — see note there.
      if (deps.callbackQueue && callbackUrl) {
        const encryptedAccessToken = input.triggerMetadata?.encryptedAccessToken;
        const encryptedCallbackSecret = input.triggerMetadata?.encryptedCallbackSecret;
        await deps.callbackQueue.add('callback', {
          executionId,
          tenantId: input.tenantId,
          callbackUrl,
          ...(typeof encryptedAccessToken === 'string' && encryptedAccessToken.length > 0
            ? { encryptedAccessToken }
            : {}),
          ...(typeof encryptedCallbackSecret === 'string' && encryptedCallbackSecret.length > 0
            ? { encryptedCallbackSecret }
            : {}),
          source: input.triggerMetadata?.source as string | undefined,
          payload: {
            traceId: executionId,
            status: 'failed',
            error: { code: errorCode, message: errorMessage },
            output: failOutput,
            executionId,
            tenantId: input.tenantId,
            projectId: input.projectId,
            sessionId: input.triggerMetadata?.sessionId as string | undefined,
            workflowId: input.workflowId,
            workflowName: input.workflowName,
            source: input.triggerMetadata?.source as string | undefined,
          },
        });
      }
    }

    return {
      status: finalStatus,
      context: ctx,
      error: { code: errorCode, message: errorMessage },
      output: failOutput,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mark a step as completed in both context and persistence after its durable wait resolves. */
async function markStepCompleted(
  step: WorkflowStep,
  ctx: WorkflowContextData,
  deps: WorkflowHandlerDeps,
  executionId: string,
): Promise<void> {
  setStepContext(
    ctx,
    step,
    rebuildStepContext(step.type, getStepContext(ctx, step), {
      status: 'completed',
      completedAt: new Date().toISOString(),
    }),
  );
  await deps.persistence.updateStepStatus(
    executionId,
    ctx.tenant.tenantId,
    ctx.tenant.projectId,
    step.id,
    'completed',
    stepPersistArgs(ctx, step),
  );
  await deps.publisher.publish(
    `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
    JSON.stringify({
      type: 'step.completed',
      executionId,
      stepId: step.id,
      stepName: step.name ?? step.id,
      stepType: step.type,
      status: 'completed',
      timestamp: new Date().toISOString(),
      stepData: sanitizePublishedStepData(
        getStepContext(ctx, step) as Record<string, unknown> | undefined,
      ),
    }),
  );
}

/** Check whether a dispatch result requires durable suspension. */
function hasSuspension(result: StepDispatchResult): boolean {
  return (
    result.delayMs !== undefined ||
    result.approvalRequest !== undefined ||
    result.webhookRequest !== undefined ||
    result.toolRequest !== undefined ||
    result.humanTaskRequest !== undefined ||
    result.callbackRequest !== undefined
  );
}

/** Step types that make external calls and are eligible for retry via dispatchWithRetry.
 * async_webhook is excluded — its side effect (outbound fetch) happens in runWorkflow,
 * not in dispatchStep, and has its own retry logic at the fetch site.
 */
const RETRYABLE_STEP_TYPES: ReadonlySet<WorkflowStep['type']> = new Set([
  'http',
  'connector_action',
  'tool_call',
  'agent_invocation',
]);

/** Extract retry config from a step, defaulting to single attempt (no retry). */
function getRetryConfig(step: WorkflowStep): {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
} {
  const retry =
    RETRYABLE_STEP_TYPES.has(step.type) && 'retry' in step
      ? (step as { retry?: RetryConfig }).retry
      : undefined;
  return {
    maxAttempts: retry?.maxAttempts ?? 1,
    delayMs: retry?.delayMs ?? 1000,
    backoffMultiplier: retry?.backoffMultiplier ?? 2,
  };
}

/**
 * Result wrapper for ctx.run() — errors inside ctx.run() that are NOT
 * Restate TerminalError cause Restate to retry the entire invocation
 * infinitely. We catch errors inside ctx.run(), return them as data,
 * then re-throw outside so our own error handling (step failed → workflow
 * failed) works normally without triggering Restate retries.
 */
type DurableResult =
  | { ok: true; data: StepDispatchResult }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        httpStatus?: number;
        responseBody?: unknown;
        request?: { url: string; method: string };
      };
    };

/**
 * Dispatch a step with retry and Restate idempotency.
 *
 * - Wraps dispatchStep in restateCtx.run() for exactly-once execution (C1).
 * - Retries on failure with exponential backoff using the step's retry config (C2).
 * - Each retry attempt gets a unique ctx.run name so Restate tracks them independently.
 * - Steps without retry config execute once (backward compatible).
 *
 * CRITICAL: Errors inside ctx.run() are caught and returned as data to
 * prevent Restate from retrying the workflow handler. Only TerminalError
 * stops Restate retries; our WorkflowStepError extends Error, so Restate
 * would retry infinitely if we let it propagate inside ctx.run().
 */
async function dispatchWithRetry(
  step: WorkflowStep,
  ctx: WorkflowContextData,
  deps: StepDispatcherDeps,
  restateCtx?: RestateWorkflowCtx,
): Promise<StepDispatchResult> {
  const retry = getRetryConfig(step);
  let lastError: Error | undefined;
  let delay = retry.delayMs;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      const runName =
        retry.maxAttempts > 1 ? `step:${step.id}:attempt:${attempt}` : `step:${step.id}`;

      if (restateCtx) {
        // Wrap in ctx.run() for durable execution. Catch errors inside
        // so they don't trigger Restate's infinite retry mechanism.
        const result: DurableResult = await restateCtx.run(runName, async () => {
          try {
            const data = await dispatchStep(step, ctx, deps);
            return { ok: true as const, data };
          } catch (err) {
            const stepErr = extractStepError(err);
            return { ok: false as const, error: stepErr };
          }
        });

        if (result.ok) {
          return result.data;
        }
        // Reconstruct the error outside ctx.run() so our handler
        // logic (failure routing, persistence) works normally.
        throw new WorkflowStepError(
          (result.error.code as StepErrorCode) || StepErrorCode.STEP_FAILED,
          result.error.message,
          {
            httpStatus: result.error.httpStatus,
            responseBody: result.error.responseBody,
            request: result.error.request,
          },
        );
      } else {
        return await dispatchStep(step, ctx, deps);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retry.maxAttempts) {
        if (restateCtx) {
          await restateCtx.sleep(delay);
        } else {
          await new Promise<void>((r) => setTimeout(r, delay));
        }
        delay = Math.round(delay * retry.backoffMultiplier);
      }
    }
  }

  throw lastError!;
}

/** Sentinel error for cancellation — distinguished from system failures. */
export class CancellationError extends Error {
  constructor() {
    super('Workflow cancelled');
    this.name = 'CancellationError';
  }
}

/** Sentinel error for approval/callback timeout. */
export class TimeoutError extends Error {
  constructor(public readonly durationMs: number) {
    super(`Timed out after ${durationMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a durable promise against the cancellation signal.
 * If sys:cancel resolves before the main promise, throws CancellationError.
 *
 * Both promises are durable (Restate tracks both in the journal and replays
 * deterministically), so Promise.race is safe here — the winner is recorded
 * and the same branch is taken on replay.
 */
async function raceCancel<T>(restateCtx: RestateWorkflowCtx, main: Promise<T>): Promise<T> {
  // Eager check: already cancelled before we even start waiting?
  const alreadyCancelled = await restateCtx.promise<boolean>('sys:cancel').peek();
  if (alreadyCancelled) {
    throw new CancellationError();
  }

  const CANCEL_SIGNAL = Symbol('cancel');
  const cancelRace = restateCtx
    .promise<boolean>('sys:cancel')
    .get()
    .then(() => CANCEL_SIGNAL as typeof CANCEL_SIGNAL);

  const result = await Promise.race([cancelRace, main]);
  if (result === CANCEL_SIGNAL) {
    throw new CancellationError();
  }
  return result as Awaited<T>;
}

/**
 * Race a durable promise against a timeout.
 * Uses the Restate SDK's built-in `.orTimeout()` which properly cleans up
 * when the main promise resolves first — no orphaned sleep promises.
 *
 * The SDK throws its own TimeoutError; we catch and re-throw our local
 * TimeoutError so callers can handle it uniformly.
 */
async function raceTimeout<T>(
  _restateCtx: RestateWorkflowCtx,
  main: RestatePromiseHandle<T>,
  timeoutMs: number,
): Promise<T> {
  try {
    return await main.orTimeout(timeoutMs);
  } catch (err) {
    // The Restate SDK throws its own TimeoutError — convert to ours
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new TimeoutError(timeoutMs);
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RELAY-RACE EXECUTION MODEL — Phase 2
//
// Each relay leg is a short, exclusive Restate object-handler invocation.
// The leg reads the DAG + step states from MongoDB (cold-start), executes
// one slice of the workflow, persists results, and returns cleanly.
// No Restate suspension ever happens — the re-dispatch bug has no surface.
// ═══════════════════════════════════════════════════════════════════════════

/** Service name for the relay-race object (alongside the legacy workflow-runner). */
export const WORKFLOW_EXECUTOR_SERVICE_NAME = 'workflow-executor';

/**
 * Input for a relay leg invocation.
 * tenantId/projectId are carried explicitly for MongoDB isolation —
 * they are derived from the inputSnapshot at the call site, not trusted
 * from an untrusted external caller.
 */
export interface WorkflowRunInput {
  tenantId: string;
  projectId: string;
  /** Step IDs to begin executing in this leg. */
  startFromStepIds: string[];
  /** Which parallel branch this leg belongs to (for fan-in barrier). */
  branchId?: string;
  /**
   * Step that was parked externally and has now received its result.
   * The result is already written to MongoDB before this leg is triggered;
   * this field is informational for logging only.
   */
  resumeStepId?: string;
  /**
   * Phase 4 — Parallel fan-in: the step ID that all branches must complete
   * before proceeding. Set by the parallel fan-out leg on each branch leg.
   * When a branch leg's queue empties, it increments the barrier on this step.
   * The last branch (barrierCount === barrierTotal) triggers the join step leg.
   */
  joinStepId?: string;
  /** Phase 4 — Total number of branches (stored on MongoDB barrier, also carried here for fallback). */
  barrierTotal?: number;
  /**
   * Phase 5 — Parallel failure strategy carried from the parallel step.
   * 'fail_fast' (default): any branch failure immediately fails the workflow.
   * 'wait_all': all branches run to completion; workflow fails if any branch failed.
   * 'ignore_errors': all branches run to completion; workflow never fails due to branch errors.
   */
  failureStrategy?: 'fail_fast' | 'wait_all' | 'ignore_errors';
  /**
   * Phase 5 — Set to true when this leg was triggered by a failed branch whose
   * failureStrategy is wait_all or ignore_errors. The join step leg checks this
   * to decide whether to propagate the failure.
   */
  hasBranchFailure?: boolean;

  /**
   * Step-timeout trigger — set when this leg is scheduled by a delayed
   * startWorkflow call to enforce a human-step (approval/data-entry) timeout.
   * Restate fires exactly after timeoutMs, matching develop-branch orTimeout().
   * The leg checks if the step is still parked; if so, resolves it with the
   * timeout decision. If already resolved, no-ops (race condition guard).
   */
  stepTimeoutFor?: {
    stepKey: string;
    stepId: string;
    expectedStatus: string;
    onTimeout: 'terminate' | 'skip';
    /**
     * Decision value to write to resolveParkedStep:
     *   'expired'  → step failed  (onTimeout=terminate)
     *   'skipped'  → step skipped (onTimeout=skip / auto_complete)
     *   'approved' → step completed (onTimeout=approve — auto-approve path)
     */
    timeoutDecision: 'expired' | 'skipped' | 'approved';
    nextStepIds: string[];
  };

  // ── Phase 6 — Loop iteration fields ───────────────────────────────────
  /** MongoDB key for this loop. When set, this is a loop iteration leg. */
  loopBarrierKey?: string;
  /** Item index (0-based) this iteration leg processes. */
  loopItemIndex?: number;
  /** Rolling-window: dispatch this index after this iteration completes. */
  loopNextIndexToDispatch?: number;
  /** Total items in the loop collection. */
  loopTotalIterations?: number;
  /** Step to trigger when ALL iterations complete. */
  loopJoinStepId?: string;
  /** Ignore individual iteration failures. */
  loopIgnoreErrors?: boolean;
}

/**
 * Suspension signals extracted from a StepDispatchResult.
 * If any field is truthy the step needs an external wait — the leg
 * parks in MongoDB and returns without calling Restate primitives.
 */
function extractSuspensionSignal(result: StepDispatchResult): {
  needsPark: boolean;
  parkStatus: string;
} {
  if (result.approvalRequest !== undefined) {
    return { needsPark: true, parkStatus: 'waiting_approval' };
  }
  if (result.humanTaskRequest !== undefined) {
    // F-2 fix: use 'waiting_human_task' to match the legacy path status and route guard.
    return { needsPark: true, parkStatus: 'waiting_human_task' };
  }
  if (result.webhookRequest !== undefined || result.toolRequest !== undefined) {
    return { needsPark: true, parkStatus: 'waiting_callback' };
  }
  if (result.callbackRequest !== undefined) {
    return { needsPark: true, parkStatus: 'waiting_callback' };
  }
  if (result.delayMs !== undefined) {
    // Delay: park and schedule delayed leg via Restate send-with-delay (Phase 3).
    return { needsPark: true, parkStatus: 'running' };
  }
  return { needsPark: false, parkStatus: '' };
}

/**
 * Relay-race leg executor.
 *
 * Called from the `workflow-executor` Restate object's `runWorkflow` exclusive
 * handler. Each invocation:
 *   1. Reads execution state + DAG from MongoDB (cold-start, no Restate journal).
 *   2. Executes one sequential slice of the workflow using ObjectContext.run()
 *      for exactly-once durable step execution within the leg.
 *   3. Persists each step result to MongoDB immediately.
 *   4. On suspension signal: writes parkPoint to MongoDB and returns cleanly.
 *   5. On normal completion: continues to successor steps or finalises.
 *
 * Parallel fan-out/fan-in (Phase 4), delay timers (Phase 3), and loop
 * rolling windows (Phase 5) are handled in later phases. In Phase 2,
 * a step that returns a suspension signal or fan-out causes the leg to
 * write a park marker and return — the next leg is triggered by the
 * callback/approval/human-task route (Phase 3) or by the delay scheduler.
 */
export async function executeWorkflow(
  restateCtx: restate.ObjectContext,
  input: WorkflowRunInput,
  deps: WorkflowHandlerDeps,
): Promise<void> {
  const executionId = restateCtx.key;
  const { tenantId, projectId } = input;
  const legLog = log.child
    ? log.child({ executionId, branchId: input.branchId })
    : createLogger('workflow-engine:relay-leg');

  // ── 0. Load execution — cancellation guard + cold-start context ────────
  if (!deps.persistence.getExecutionForLeg) {
    legLog.error('executeWorkflow: getExecutionForLeg not wired — persistence not upgraded');
    return;
  }
  const execState = await deps.persistence.getExecutionForLeg(executionId, tenantId, projectId);
  if (!execState) {
    legLog.warn('executeWorkflow: execution not found', { executionId });
    return;
  }
  if (['cancelled', 'completed', 'failed', 'rejected'].includes(execState.status)) {
    legLog.info('executeWorkflow: execution already terminal — discarding leg', {
      status: execState.status,
    });
    return;
  }

  // ── 0b. Step-timeout trigger — Restate-native exact timer (no sweeper lag) ─
  // When a human step (approval/data-entry) parks with a timeout, a delayed
  // startWorkflow fires here after exactly timeoutMs ms — matching the
  // develop-branch orTimeout() behaviour. If the step was resolved before the
  // timer fires, resolveParkedStep returns false (no-op, race guard).
  if (input.stepTimeoutFor && deps.persistence.resolveParkedStep) {
    const { stepKey, stepId, expectedStatus, onTimeout, timeoutDecision, nextStepIds } =
      input.stepTimeoutFor;
    const completedAt = new Date().toISOString();
    const resolved = await deps.persistence.resolveParkedStep(
      executionId,
      tenantId,
      projectId,
      stepKey,
      expectedStatus,
      { decision: timeoutDecision, completedAt },
    );

    if (!resolved) {
      legLog.info('executeWorkflow: step-timeout no-op — step already resolved', {
        stepKey,
        stepId,
      });
      return;
    }

    legLog.info('executeWorkflow: step-timeout enforced', { stepKey, stepId, onTimeout });

    if (onTimeout === 'skip' && nextStepIds.length > 0 && deps.startWorkflow) {
      // Skip: continue on the success path (matches develop-branch 'skipped' routing)
      await deps.startWorkflow(executionId, {
        tenantId,
        projectId,
        startFromStepIds: nextStepIds,
        resumeStepId: stepId,
      });
    } else if (onTimeout !== 'skip') {
      // Terminate: step=failed, execution=failed — no edge routing (matches develop-branch)
      await deps.persistence.updateExecutionStatus(executionId, tenantId, projectId, 'failed', {
        completedAt: new Date(),
      });
    }
    return;
  }

  // ── 1. Reconstruct DAG from inputSnapshot ──────────────────────────────
  const workflowInput = execState.inputSnapshot as WorkflowExecutionInput | undefined;
  if (!workflowInput?.steps || !Array.isArray(workflowInput.steps)) {
    legLog.error('executeWorkflow: inputSnapshot missing or invalid', { executionId });
    await deps.persistence.updateExecutionStatus(executionId, tenantId, projectId, 'failed', {
      error: { code: 'RELAY_SNAPSHOT_MISSING', message: 'inputSnapshot absent on execution' },
      completedAt: new Date(),
    });
    return;
  }

  // ── 2. Rebuild WorkflowContextData from MongoDB step outputs ───────────
  // buildWorkflowContext initialises the context with start step output;
  // we then overlay every completed step from MongoDB so variable
  // resolution works correctly for all successor steps in this leg.
  const wfCtx = buildWorkflowContext(workflowInput, executionId);
  const mongoSteps = (execState.context.steps ?? {}) as Record<string, unknown>;
  for (const [key, stepData] of Object.entries(mongoSteps)) {
    // I-11: basic shape guard — only overlay entries that carry a string status.
    // Corrupted documents (missing status, wrong type) are silently skipped so
    // expression resolution sees the default empty-context rather than bad data.
    if (
      stepData &&
      typeof stepData === 'object' &&
      typeof (stepData as Record<string, unknown>).status === 'string'
    ) {
      wfCtx.steps[key] = stepData as WorkflowStepData;
    }
  }

  // ── 3. Build step index ────────────────────────────────────────────────
  const stepIdx = new Map<string, WorkflowStep>();
  for (const s of workflowInput.steps) {
    stepIdx.set(s.id, s);
  }

  // ── 3b. Merge connectorDepsFactory into dispatcher deps ───────────────
  // RCA: runWorkflow() merges connectorDepsFactory into executionDispatcherDeps
  // at lines ~1615-1626. executeWorkflow() was missing this merge, causing
  // "ConnectorActionDeps not configured" for ADI/Docling connector_action steps.
  // Fix: replicate the same merge here so connector steps get their callback
  // context (enqueueADIPollJob, callbackUrlBuilder, encryptSecret, etc.).
  const execDispatcherDeps: StepDispatcherDeps = { ...deps.dispatcherDeps };
  if (deps.connectorDepsFactory) {
    if (!execDispatcherDeps.connectorDeps) {
      execDispatcherDeps.connectorDeps = deps.connectorDepsFactory(tenantId, projectId);
    }
    if (!execDispatcherDeps.connectorDepsForStep) {
      const factory = deps.connectorDepsFactory;
      execDispatcherDeps.connectorDepsForStep = (execId, stepId) =>
        factory(tenantId, projectId, execId, stepId);
    }
  }
  const execDeps: WorkflowHandlerDeps = { ...deps, dispatcherDeps: execDispatcherDeps };

  // ── 4. Minimal Restate context for synchronous step execution ─────────
  // ObjectContext.run() has the same signature as WorkflowContext.run() —
  // it journals exactly-once durable results. The suspension methods
  // (sleep, promise, awakeable) are intentionally absent; any step that
  // returns a suspension signal is handled by parking below, never by
  // calling those methods directly.
  const minimalCtx = {
    run: restateCtx.run.bind(restateCtx),
  } as unknown as RestateWorkflowCtx;

  // ── Phase 7: Sequence-stamped publisher ────────────────────────────────
  // Wraps deps.publisher so every event published from executeWorkflow() carries a
  // monotonically increasing seq number. Studio can use seq to re-order events
  // that arrive out of sequence across concurrent parallel-branch legs.
  // seqPublish: stamps every executeWorkflow-level event with a monotonic sequence
  // number so Studio can re-order concurrent parallel-branch events correctly.
  // I-2 note: incrementLegCounter is intentionally outside ctx.run(). On Restate
  // retry the counter increments again (wastes a seq value) and the event re-publishes
  // to Redis with a higher seq. Studio deduplicates by event type+step content; the
  // extra seq gap is cosmetic. Wrapping in ctx.run() would require passing restateCtx
  // into every seqPublish call — deferred to a future cleanup pass.
  // P-10: only increment the MongoDB leg counter for significant events (park /
  // terminal) — not for every step-running event. A 10-step workflow previously
  // fired 10+ findOneAndUpdate writes; now only park+terminal events do.
  const COUNTER_WORTHY_TYPES = new Set([
    'step.waiting_callback',
    'step.waiting_approval',
    'step.waiting_human_task',
    'step.completed',
    'step.failed',
    'execution.completed',
    'execution.failed',
  ]);
  const seqPublish = async (channel: string, jsonMsg: string): Promise<void> => {
    let seq = 0;
    if (deps.persistence.incrementLegCounter) {
      try {
        const parsed = JSON.parse(jsonMsg) as Record<string, unknown>;
        if (COUNTER_WORTHY_TYPES.has(String(parsed.type ?? ''))) {
          seq = await deps.persistence.incrementLegCounter(executionId, tenantId, projectId);
        }
      } catch {
        // JSON parse failed — fall through with seq=0; publish handled below.
      }
    }
    // I-6: swallow all publisher errors so a Redis hiccup never crashes the leg.
    try {
      const parsed = JSON.parse(jsonMsg) as Record<string, unknown>;
      await deps.publisher.publish(channel, JSON.stringify({ ...parsed, seq }));
    } catch {
      try {
        await deps.publisher.publish(channel, jsonMsg);
      } catch (publishErr) {
        legLog.warn('seqPublish: publish failed — status event dropped', {
          channel,
          error: publishErr instanceof Error ? publishErr.message : String(publishErr),
        });
      }
    }
  };

  // ── 4c. Load memory projection (GAP-1 fix) ───────────────────────────────
  // runWorkflow() loads this before step dispatch so {{memory.*}} expressions
  // resolve. executeWorkflow was missing this — any step using memory expressions
  // returned undefined.
  if (deps.memoryClient) {
    try {
      wfCtx.memory = await loadMemoryProjection(workflowInput, deps.memoryClient);
    } catch (err) {
      // I-8: degraded-mode fallback — a transient runtime unavailability must not
      // permanently fail the workflow. Proceed with empty memory projection so
      // steps that don't use {{memory.*}} expressions continue normally; steps
      // that do will get undefined values and can handle that via their own logic.
      legLog.warn('executeWorkflow: memory projection load failed — continuing with empty memory', {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 5a. Phase 6 — Loop iteration leg (runs before the normal step queue) ──
  // When loopBarrierKey is set, this leg processes one loop item.
  // It reads the item from MongoDB loop data, builds a mini-context with
  // the item variable, and executes the body steps.
  if (input.loopBarrierKey !== undefined && input.loopItemIndex !== undefined) {
    const loopKey = input.loopBarrierKey;
    const itemIndex = input.loopItemIndex;

    const loopData = deps.persistence.readLoopData
      ? await deps.persistence.readLoopData(executionId, tenantId, projectId, loopKey)
      : null;

    if (!loopData) {
      legLog.error('executeWorkflow: loop data missing for iteration leg', { loopKey, itemIndex });
    } else {
      const rawItem = loopData.items[itemIndex];
      // H-8 fix: wrap primitives so expression resolution ({{itemVariable.field}})
      // returns undefined gracefully instead of silently producing empty strings.
      const item = rawItem !== null && typeof rawItem === 'object' ? rawItem : { value: rawItem };
      const { itemVariable, bodyStepIds, bodyInDegreeMap } = loopData;

      // Build an iteration context: full workflow context + item variable
      const iterCtx = { ...wfCtx };
      iterCtx.steps = { ...wfCtx.steps };
      iterCtx.steps[itemVariable] = item as WorkflowStepData;

      // Execute each body step for this iteration
      let iterFailed = false;
      let iterError: string | undefined;

      for (const bodyStepId of bodyStepIds) {
        const bodyStep = stepIdx.get(bodyStepId);
        if (!bodyStep) continue;

        // I-9: unique step key per iteration so parallel iterations of the same
        // body step don't overwrite each other in MongoDB, and so retry legs can
        // detect already-completed steps and skip re-execution.
        const bodyStepName = bodyStep.name ?? bodyStep.id;
        const iterStepKey = `${loopKey}:i${itemIndex}:${bodyStepName}`;

        // I-9: skip body steps already completed on a prior attempt of this leg.
        // iterCtx.steps was built from mongoSteps at cold-start — if the previous
        // run persisted this step before crashing, it appears here as 'completed'.
        if ((iterCtx.steps[iterStepKey] as WorkflowStepData | undefined)?.status === 'completed') {
          legLog.info('executeWorkflow: loop body step already completed — skipping', {
            loopKey,
            itemIndex,
            bodyStepId,
            iterStepKey,
          });
          continue;
        }

        // Cancellation check per body step — lightweight projection, no inputSnapshot (I-4).
        // .bind() preserves `this` so this.model is defined when the method runs.
        const cancelCheckFn = (deps.persistence.getExecutionCancellationStatus ??
          deps.persistence.getExecutionForLeg)!.bind(deps.persistence);
        const cancelCheck = await cancelCheckFn(executionId, tenantId, projectId);
        if (cancelCheck?.status === 'cancelled') {
          legLog.info('executeWorkflow: loop iteration cancelled', {
            loopKey,
            itemIndex,
            bodyStepId,
          });
          return;
        }

        try {
          await executeWorkflowStep(bodyStep, iterCtx, execDeps, executionId, minimalCtx);

          // I-9: persist the completed body step result to MongoDB immediately so a
          // leg retry can skip re-executing it. Use iterStepKey (iteration-scoped) to
          // avoid collisions between parallel iterations of the same body step.
          const completedData = iterCtx.steps[bodyStepName] as WorkflowStepData | undefined;
          if (completedData && deps.persistence.updateStepStatus) {
            await deps.persistence.updateStepStatus(
              executionId,
              tenantId,
              projectId,
              bodyStepId,
              completedData.status ?? 'completed',
              { stepKey: iterStepKey, stepData: completedData },
            );
          }
        } catch (err) {
          iterError = err instanceof Error ? err.message : String(err);
          iterFailed = true;
          legLog.error('executeWorkflow: loop body step failed', {
            loopKey,
            itemIndex,
            bodyStepId,
            error: iterError,
          });
          if (!loopData.ignoreErrors) break; // terminate on error unless ignoreErrors
        }
      }

      // Dispatch next iteration in rolling window (if more remain)
      const nextIndex = input.loopNextIndexToDispatch ?? itemIndex + loopData.concurrencyLimit;
      // G-5 fix: ignoreErrors iterations must still dispatch next index — only skip for fail_fast.
      // G-6 fix: wrap in ctx.run() so Restate retries don't double-dispatch the next iteration.
      if (
        (!iterFailed || loopData.ignoreErrors) &&
        nextIndex < loopData.totalIterations &&
        deps.startWorkflow
      ) {
        await restateCtx.run(`loop-next:${loopKey}:${itemIndex}`, async () => {
          await deps.startWorkflow!(executionId, {
            tenantId,
            projectId,
            startFromStepIds: [],
            loopBarrierKey: loopKey,
            loopItemIndex: nextIndex,
            loopNextIndexToDispatch: nextIndex + loopData!.concurrencyLimit,
            loopTotalIterations: loopData!.totalIterations,
            loopJoinStepId: loopData!.joinStepId,
            loopIgnoreErrors: loopData!.ignoreErrors,
          });
        });
      }

      // Increment loop barrier — journaled via ctx.run() to prevent double-counting on retry.
      if (deps.persistence.atomicBarrierIncrement) {
        const newCount = await restateCtx.run(`loop-barrier:${loopKey}:${itemIndex}`, async () =>
          deps.persistence.atomicBarrierIncrement!(executionId, tenantId, projectId, loopKey),
        );

        legLog.info('executeWorkflow: loop iteration done', {
          loopKey,
          itemIndex,
          newCount,
          total: loopData.totalIterations,
          iterFailed,
        });

        if (newCount >= loopData.totalIterations) {
          // Last iteration — trigger join step
          legLog.info('executeWorkflow: all loop iterations done — triggering join', {
            joinStepId: loopData.joinStepId,
          });
          // H-4b fix: journal the loop join trigger so retry doesn't double-dispatch.
          if (loopData.joinStepId && deps.startWorkflow) {
            await restateCtx.run(`loop-join:${loopKey}`, async () => {
              await deps.startWorkflow!(executionId, {
                tenantId,
                projectId,
                startFromStepIds: [loopData!.joinStepId!],
              });
            });
          }
        }
      }
    }
    return; // Iteration leg always returns after its one item
  }

  // ── 5. Execute sequential step queue ──────────────────────────────────
  const queue = [...input.startFromStepIds];
  // GAP-9: track which end node IDs were reached (for outputMappingsByEndNodeId selection)
  const reachedEndStepIds = new Set<string>();

  while (queue.length > 0) {
    const stepId = queue.shift()!;
    const step = stepIdx.get(stepId);
    if (!step) {
      // End node canvas UUIDs may appear in nextStepIds — the relay-race step index
      // uses the actual End node UUID now, so this only fires for truly unexpected IDs.
      legLog.debug('executeWorkflow: step not found in index — likely legacy end-node routing', {
        stepId,
      });
      continue;
    }

    // Cancellation check at each step boundary — lightweight projection, no inputSnapshot (I-2).
    // .bind() preserves `this` so this.model is defined when the method runs.
    const cancelBoundaryFn = (deps.persistence.getExecutionCancellationStatus ??
      deps.persistence.getExecutionForLeg)!.bind(deps.persistence);
    const freshState = await cancelBoundaryFn(executionId, tenantId, projectId);
    if (freshState?.status === 'cancelled') {
      legLog.info('executeWorkflow: cancelled — stopping at step boundary', { stepId });
      return;
    }

    legLog.info('executeWorkflow: executing step', { stepId, stepType: step.type });

    // ── Phase 4: Parallel fan-out ───────────────────────────────────────
    // Parallel steps are intercepted before executeWorkflowStep() because
    // they fan-out into independent relay legs — one per branch — rather than
    // running branches concurrently in the same handler (which is impossible
    // across legs). The barrier is initialised in MongoDB before any branch leg
    // is triggered so no branch can beat the init write.
    if (step.type === 'parallel') {
      const parallelStep =
        step as unknown as import('../executors/parallel-executor.js').ParallelStep;
      const branches = parallelStep.branches ?? [];
      const joinStepIds: string[] = step.onSuccessSteps ?? [];
      const joinStepId = joinStepIds[0]; // parallel always has one join point

      if (branches.length === 0) {
        legLog.warn('executeWorkflow: parallel step has no branches — skipping', { stepId });
        queue.push(...joinStepIds);
        continue;
      }

      // Initialise the barrier on the join step before any branch is triggered.
      // I-4 fix: invalid joinStepId (dots/dollars) is a permanent failure — TerminalError.
      if (joinStepId && deps.persistence.initStepBarrier) {
        try {
          await deps.persistence.initStepBarrier(
            executionId,
            tenantId,
            projectId,
            joinStepId,
            branches.length,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new restate.TerminalError(`Parallel barrier init failed: ${msg}`);
        }
      }

      // Mark parallel step itself as running then completed (it's just coordination).
      await deps.persistence.updateStepStatus(
        executionId,
        tenantId,
        projectId,
        step.id,
        'running',
        {
          stepKey: step.name ?? step.id,
          stepData: buildCleanStepContext(
            'parallel' as unknown as WorkflowStep['type'],
            {
              nodeType: 'parallel',
              stepId: step.id,
              status: 'running',
              startedAt: new Date().toISOString(),
            },
            {},
          ) as WorkflowStepData,
        },
      );
      await deps.persistence.updateStepStatus(
        executionId,
        tenantId,
        projectId,
        step.id,
        'completed',
        {
          stepKey: step.name ?? step.id,
          stepData: buildCleanStepContext(
            'parallel' as unknown as WorkflowStep['type'],
            {
              nodeType: 'parallel',
              stepId: step.id,
              status: 'completed',
              completedAt: new Date().toISOString(),
            },
            { output: { branches: branches.map((b) => b.name) } },
          ) as WorkflowStepData,
        },
      );

      const failureStrategy = parallelStep.failureStrategy ?? 'fail_fast';

      // Fan-out: one leg per branch, carrying branchId, joinStepId, and failureStrategy.
      // G-6 fix: each startWorkflow call is wrapped in ctx.run() so Restate retries of the
      // fan-out leg do not double-dispatch branch legs (Restate journals the result and
      // replays it without re-executing the function on retry).
      if (deps.startWorkflow) {
        for (const branch of branches) {
          const branchId = `${step.id}:${branch.name}`;
          await restateCtx.run(`parallel-fanout:${step.id}:${branch.name}`, async () => {
            await deps.startWorkflow!(executionId, {
              tenantId,
              projectId,
              startFromStepIds: branch.steps,
              branchId,
              joinStepId,
              barrierTotal: branches.length,
              failureStrategy,
            });
          });
          legLog.info('executeWorkflow: parallel fan-out — branch leg triggered', {
            branchId,
            steps: branch.steps,
            joinStepId,
            failureStrategy,
          });
        }
      } else {
        // startWorkflow not wired — fall back to sequential execution (legacy mode).
        legLog.warn(
          'executeWorkflow: startWorkflow not wired — running parallel branches sequentially',
          {
            stepId,
          },
        );
        for (const branch of branches) {
          queue.push(...branch.steps);
        }
        if (joinStepId) queue.push(joinStepId);
      }

      // The parallel step's legs will handle the join. This leg exits.
      return;
    }

    let stepResult: StepDispatchResult;
    try {
      // executeWorkflowStep handles: input resolution, running→completed
      // MongoDB writes, publisher events, and dispatchWithRetry (which wraps
      // the step executor in restateCtx.run() for exactly-once durability).
      stepResult = await executeWorkflowStep(step, wfCtx, execDeps, executionId, minimalCtx);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      legLog.error('executeWorkflow: step threw', { stepId, error: errMsg });

      // GAP-4 fix: check on_failure / on_reject routing before failing the workflow.
      // Mirrors runWorkflow's executeStepWithSuspension failure routing behavior.
      const onFailureSteps = step.onFailureSteps;
      if (onFailureSteps && onFailureSteps.length > 0) {
        legLog.info('executeWorkflow: step failed — routing via on_failure edges', {
          stepId,
          onFailureSteps,
        });
        queue.push(...onFailureSteps);
        continue;
      }

      // Phase 5 — Failure strategy:
      // fail_fast (default): fail the whole workflow immediately.
      // wait_all / ignore_errors: mark branch as failed, still increment the
      // barrier so the join step can fire and decide the final outcome.
      const isInBranch =
        input.joinStepId !== undefined &&
        (input.failureStrategy === 'wait_all' || input.failureStrategy === 'ignore_errors');

      if (isInBranch && input.joinStepId && deps.persistence.atomicBarrierIncrement) {
        legLog.warn(
          'executeWorkflow: branch step failed — failureStrategy is not fail_fast, incrementing barrier',
          {
            stepId,
            failureStrategy: input.failureStrategy,
            joinStepId: input.joinStepId,
            error: errMsg,
          },
        );

        // H-4c fix: wrap all barrier ops in ctx.run() to prevent double-counting on retry.
        if (deps.persistence.atomicBarrierFailIncrement) {
          await restateCtx.run(
            `barrier-fail-inc-err:${input.joinStepId}:${input.branchId ?? 'root'}`,
            async () =>
              deps.persistence.atomicBarrierFailIncrement!(
                executionId,
                tenantId,
                projectId,
                input.joinStepId!,
              ),
          );
        }

        // Increment the main barrier — this branch is "done" (failed).
        const newCount = await restateCtx.run(
          `barrier-inc-err:${input.joinStepId}:${input.branchId ?? 'root'}`,
          async () =>
            deps.persistence.atomicBarrierIncrement!(
              executionId,
              tenantId,
              projectId,
              input.joinStepId!,
            ),
        );
        const execForBarrier = await deps.persistence.getExecutionForLeg!(
          executionId,
          tenantId,
          projectId,
        );
        const joinCtx = (
          execForBarrier?.context.steps as Record<string, Record<string, unknown>>
        )?.[input.joinStepId];
        const barrierTotal =
          (joinCtx?.barrierTotal as number | undefined) ?? input.barrierTotal ?? 0;

        if (newCount >= barrierTotal && deps.startWorkflow) {
          await restateCtx.run(`barrier-join-err:${input.joinStepId}`, async () =>
            deps.startWorkflow!(executionId, {
              tenantId,
              projectId,
              startFromStepIds: [input.joinStepId!],
              hasBranchFailure: true,
              failureStrategy: input.failureStrategy,
            }),
          );
        }
        return; // branch leg done (failed but handled)
      }

      // fail_fast (or non-branch): fail the whole workflow.
      // GAP-13 fix: mark any in-progress steps as failed before updating execution status.
      const failedAt = new Date().toISOString();
      for (const [stepKey, stepData] of Object.entries(wfCtx.steps)) {
        if ((stepData as WorkflowStepData).status === 'running') {
          wfCtx.steps[stepKey] = {
            ...(stepData as WorkflowStepData),
            status: 'failed',
            completedAt: failedAt,
            error: { code: 'STEP_FAILED', message: errMsg },
          } as WorkflowStepData;
        }
      }
      const failCompletedAt = new Date();
      await deps.persistence.updateExecutionStatus(executionId, tenantId, projectId, 'failed', {
        error: { code: 'STEP_FAILED', message: errMsg },
        context: wfCtx,
        completedAt: failCompletedAt,
      });
      await seqPublish(
        `workflow:${tenantId}:execution:${executionId}:status`,
        JSON.stringify({
          type: 'workflow.failed',
          executionId,
          error: errMsg,
          timestamp: failCompletedAt.toISOString(),
        }),
      );
      // GAP-11 fix: enqueue failure callback delivery
      const failCallbackUrl =
        typeof workflowInput.triggerMetadata?.callbackUrl === 'string'
          ? workflowInput.triggerMetadata.callbackUrl
          : undefined;
      if (deps.callbackQueue && failCallbackUrl) {
        const encAT = workflowInput.triggerMetadata?.encryptedAccessToken;
        await deps.callbackQueue.add('callback', {
          executionId,
          tenantId,
          callbackUrl: failCallbackUrl,
          ...(typeof encAT === 'string' && encAT.length > 0 ? { encryptedAccessToken: encAT } : {}),
          payload: {
            traceId: executionId,
            status: 'failed',
            error: { code: 'STEP_FAILED', message: errMsg },
            executionId,
            tenantId,
            projectId,
            workflowId: workflowInput.workflowId,
            workflowName: workflowInput.workflowName,
          },
        });
      }
      return;
    }

    // ── Phase 7: Delay step — Restate send-with-delay (no MongoDB park) ──
    // For delay steps, we do NOT park in MongoDB (no external event needed).
    // Instead, use Restate's built-in delayed-send so the relay leg re-fires
    // after the delay without holding any handler in memory.
    if (stepResult.delayMs !== undefined && deps.startWorkflow) {
      const delayMs = stepResult.delayMs;
      const successorsAfterDelay: string[] =
        stepResult.nextSteps && stepResult.nextSteps.length > 0
          ? stepResult.nextSteps
          : (step.onSuccessSteps ?? []);

      // Mark delay step completed in MongoDB immediately.
      await deps.persistence.updateStepStatus(
        executionId,
        tenantId,
        projectId,
        step.id,
        'completed',
        {
          stepKey: step.name ?? step.id,
          stepData: buildCleanStepContext(
            step.type,
            {
              nodeType: step.type,
              stepId: step.id,
              status: 'completed',
              completedAt: new Date().toISOString(),
            },
            { output: { delayMs } },
          ) as WorkflowStepData,
        },
      );

      // Schedule the next leg via Restate delayed send.
      await deps.startWorkflow(
        executionId,
        {
          tenantId,
          projectId,
          startFromStepIds: successorsAfterDelay,
          branchId: input.branchId,
          joinStepId: input.joinStepId,
          barrierTotal: input.barrierTotal,
          failureStrategy: input.failureStrategy,
        },
        { delayMs },
      );
      legLog.info('executeWorkflow: delay step — scheduled next leg via Restate send-with-delay', {
        stepId,
        delayMs,
        successorsAfterDelay,
      });
      return;
    }

    // ── Suspension signal: park and return cleanly ─────────────────────
    const { needsPark, parkStatus } = extractSuspensionSignal(stepResult);
    if (needsPark) {
      legLog.info('executeWorkflow: step needs external wait — parking', {
        stepId,
        parkStatus,
      });

      // ── Create Studio inbox record (human task mirror) ───────────────
      // The legacy runWorkflow path calls ensureHumanTaskMirror() here.
      // executeWorkflow must do the same so the approval/human-task inbox is populated.
      if (stepResult.approvalRequest !== undefined && deps.humanTaskStore) {
        const approvalReq =
          stepResult.approvalRequest as import('../executors/approval-executor.js').ApprovalRequest;
        await ensureHumanTaskMirror(
          deps.humanTaskStore,
          { tenantId, projectId, sourceType: 'workflow_approval', executionId, stepId: step.id },
          () => ({
            tenantId,
            projectId,
            type: 'approval' as const,
            mailbox: 'workflow',
            priority: 'medium',
            title: approvalReq.message,
            source: {
              type: 'workflow_approval',
              workflowId: workflowInput.workflowId,
              executionId,
              stepId: step.id,
            },
            assignedTo: approvalReq.approvers?.length > 0 ? approvalReq.approvers : undefined,
            fields: [],
            context: { workflowName: workflowInput.workflowName, approvers: approvalReq.approvers },
            dueAt:
              approvalReq.timeoutMs != null
                ? new Date(Date.now() + approvalReq.timeoutMs)
                : undefined,
            onTimeout:
              approvalReq.timeoutMs != null
                ? approvalReq.onTimeout === 'approve'
                  ? ('skip' as const)
                  : ('terminate' as const)
                : undefined,
          }),
        );
      }

      if (stepResult.humanTaskRequest !== undefined && deps.humanTaskStore) {
        const taskReq = stepResult.humanTaskRequest as HumanTaskRequest;
        const humanOnTimeout =
          taskReq.timeoutMs != null
            ? taskReq.onTimeout === 'skip'
              ? ('skip' as const)
              : ('terminate' as const)
            : undefined;
        await ensureHumanTaskMirror(
          deps.humanTaskStore,
          { tenantId, projectId, sourceType: 'workflow_human_task', executionId, stepId: step.id },
          () => ({
            tenantId: taskReq.tenantId,
            projectId: taskReq.projectId,
            type: taskReq.taskType as 'approval' | 'data_entry' | 'review' | 'decision',
            mailbox: 'workflow' as const,
            priority: (taskReq.priority as 'low' | 'medium' | 'high' | 'critical') ?? 'medium',
            title: taskReq.title,
            description: taskReq.description,
            source: {
              type: 'workflow_human_task' as const,
              workflowId: workflowInput.workflowId,
              executionId,
              stepId: step.id,
            },
            assignedTo: (() => {
              const specific = taskReq.assignTo?.filter((a) => a !== 'everyone') ?? [];
              return specific.length > 0 ? specific : undefined;
            })(),
            fields: taskReq.fields,
            context: taskReq.context,
            dueAt: taskReq.timeoutMs != null ? new Date(Date.now() + taskReq.timeoutMs) : undefined,
            onTimeout: humanOnTimeout,
          }),
        );
      }

      if (deps.persistence.parkStep) {
        // Write callbackSecret if present (from callbackRequest — encrypted).
        // SECURITY: only ciphertext is stored — plaintext never crosses this boundary.
        const encryptedSecret = (
          stepResult.callbackRequest as { encryptedCallbackSecret?: string } | undefined
        )?.encryptedCallbackSecret;

        // Store successor step IDs so the callback/approval route can call
        // startWorkflow() directly without re-reading the full DAG definition.
        // Approval steps have two paths: onSuccessSteps (on_approve) and
        // onRejectSteps (on_reject). Both are stored so the approval route
        // can pick the correct path based on the decision.
        const nextStepIds: string[] = step.onSuccessSteps ?? [];
        const rejectStepIds: string[] =
          (step as unknown as { onRejectSteps?: string[] }).onRejectSteps ?? [];

        await deps.persistence.parkStep(executionId, tenantId, projectId, step.name ?? step.id, {
          status: parkStatus,
          parkPoint: true,
          nextStepIds,
          ...(rejectStepIds.length > 0 ? { rejectStepIds } : {}),
          ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
          ...(input.joinStepId !== undefined ? { joinStepId: input.joinStepId } : {}),
          ...(input.barrierTotal !== undefined ? { barrierTotal: input.barrierTotal } : {}),
          // Phase 5: carry failureStrategy so resumed leg continues with correct strategy
          ...(input.failureStrategy !== undefined
            ? { failureStrategy: input.failureStrategy }
            : {}),
          ...(encryptedSecret !== undefined ? { callbackSecret: encryptedSecret } : {}),
        });

        // Schedule a Restate-native exact timeout for human steps that have a
        // configured dueAt. This fires after exactly timeoutMs ms — matching
        // develop-branch orTimeout() — with zero sweeper polling lag.
        const humanTimeoutMs =
          (stepResult.approvalRequest as { timeoutMs?: number } | undefined)?.timeoutMs ??
          (stepResult.humanTaskRequest as { timeoutMs?: number } | undefined)?.timeoutMs;
        const humanOnTimeoutConfig =
          (stepResult.approvalRequest as { onTimeout?: string } | undefined)?.onTimeout ??
          (stepResult.humanTaskRequest as { onTimeout?: string } | undefined)?.onTimeout;

        if (humanTimeoutMs != null && humanTimeoutMs > 0 && deps.startWorkflow) {
          // Derive the decision value to write when the timeout fires — matches develop:
          //   'approve'       → 'approved'  (step completed, routes to success path)
          //   'skip'/'auto_complete' → 'skipped' (step skipped, routes to success path)
          //   everything else → 'expired'   (step failed, execution failed, no routing)
          const cfg = humanOnTimeoutConfig ?? '';
          const timeoutDecision: 'expired' | 'skipped' | 'approved' =
            cfg === 'approve'
              ? 'approved'
              : cfg === 'skip' || cfg === 'auto_complete'
                ? 'skipped'
                : 'expired';
          const onTimeoutNormalized: 'terminate' | 'skip' =
            timeoutDecision !== 'expired' ? 'skip' : 'terminate';
          await deps.startWorkflow(
            executionId,
            {
              tenantId,
              projectId,
              startFromStepIds: [],
              stepTimeoutFor: {
                stepKey: step.name ?? step.id,
                stepId: step.id,
                expectedStatus: parkStatus,
                onTimeout: onTimeoutNormalized,
                timeoutDecision,
                nextStepIds,
              },
            },
            { delayMs: humanTimeoutMs },
          );
          legLog.info('executeWorkflow: human-step timeout scheduled via Restate', {
            stepId: step.id,
            humanTimeoutMs,
            onTimeout: onTimeoutNormalized,
          });
        }

        // GAP-6 fix: publish step.waiting_* so Studio canvas shows the correct
        // waiting state instead of leaving the step stuck at "running".
        await seqPublish(
          `workflow:${tenantId}:execution:${executionId}:status`,
          JSON.stringify({
            type: parkStatus.startsWith('waiting_') ? `step.${parkStatus}` : 'step.running',
            executionId,
            stepId: step.id,
            stepName: step.name ?? step.id,
            stepType: step.type,
            status: parkStatus,
            timestamp: new Date().toISOString(),
          }),
        );
      }
      // Leg returns cleanly. The external event (approval/callback/ADI) will
      // trigger the next leg via startWorkflow() — Phase 3 wires this in the routes.
      return;
    }

    // ── Sequential: enqueue successor steps ───────────────────────────
    // Condition steps return nextSteps (the taken branch). All others use
    // onSuccessSteps from the step definition (computed from canvas edges).
    // The end node (id='end') is not a WorkflowStep — it's handled below
    // after the queue empties (same pattern as the legacy runWorkflow path).
    const successors: string[] =
      stepResult.nextSteps && stepResult.nextSteps.length > 0
        ? stepResult.nextSteps
        : (step.onSuccessSteps ?? []);

    // ── Phase 6: Loop iteration fan-out ───────────────────────────────
    // loopIteration is returned when the loop step dispatcher resolves the
    // collection. The body steps are NOT yet executed — we fan-out iteration
    // legs here (rolling window) instead of executing them inline.
    if (stepResult.loopIteration && deps.startWorkflow && deps.persistence.storeLoopData) {
      const { items, itemVariable, body: bodyStepIds, bodyInDegreeMap } = stepResult.loopIteration;
      const loopStep = step as unknown as import('../executors/loop-executor.js').LoopStep;
      const concurrencyLimit =
        loopStep.config.mode === 'parallel' ? (loopStep.config.concurrencyLimit ?? 10) : 1;
      const ignoreErrors = loopStep.config.onError === 'continue';
      const joinStepId = step.onSuccessSteps?.[0];
      const loopKey = `loop:${step.id}`; // step.id validated by safeStepKey inside initStepBarrier/storeLoopData
      const total = items.length;

      if (total === 0) {
        // Empty collection — skip loop, continue to successors
        queue.push(...(step.onSuccessSteps ?? []));
      } else {
        // Store loop data in MongoDB (items + config) so iteration legs can read them.
        // I-4 fix: catch permanent validation errors (size cap) and re-throw as
        // restate.TerminalError so Restate stops retrying instead of looping forever.
        try {
          await deps.persistence.storeLoopData(executionId, tenantId, projectId, loopKey, {
            items,
            itemVariable,
            bodyStepIds,
            bodyInDegreeMap,
            joinStepId,
            totalIterations: total,
            concurrencyLimit,
            ignoreErrors,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new restate.TerminalError(`Loop data validation failed: ${msg}`);
        }

        // Initialise the loop barrier (total iterations).
        // I-4 fix: same TerminalError pattern — invalid step key is a permanent failure.
        if (deps.persistence.initStepBarrier) {
          try {
            await deps.persistence.initStepBarrier(
              executionId,
              tenantId,
              projectId,
              loopKey,
              total,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new restate.TerminalError(`Loop barrier init failed: ${msg}`);
          }
        }

        // Mark loop step itself completed.
        await deps.persistence.updateStepStatus(
          executionId,
          tenantId,
          projectId,
          step.id,
          'completed',
          {
            stepKey: step.name ?? step.id,
            stepData: buildCleanStepContext(
              step.type,
              {
                nodeType: step.type,
                stepId: step.id,
                status: 'completed',
                completedAt: new Date().toISOString(),
              },
              { output: { iterations: total } },
            ) as WorkflowStepData,
          },
        );

        // Dispatch first batch (rolling window: min(concurrencyLimit, total) legs).
        // H-4a fix: each startWorkflow wrapped in ctx.run() so Restate retries of the
        // fan-out leg do not double-dispatch the initial iteration batch.
        // P-8: cap initial fan-out to MAX_LOOP_INITIAL_BATCH regardless of concurrencyLimit
        // so 100 active workflows × cap don't flood Restate ingress concurrently.
        const MAX_LOOP_INITIAL_BATCH = 5;
        const firstBatch = Math.min(concurrencyLimit, total, MAX_LOOP_INITIAL_BATCH);
        for (let i = 0; i < firstBatch; i++) {
          await restateCtx.run(`loop-init:${loopKey}:${i}`, async () => {
            await deps.startWorkflow!(executionId, {
              tenantId,
              projectId,
              startFromStepIds: [],
              loopBarrierKey: loopKey,
              loopItemIndex: i,
              loopNextIndexToDispatch: i + concurrencyLimit,
              loopTotalIterations: total,
              loopJoinStepId: joinStepId,
              loopIgnoreErrors: ignoreErrors,
            });
          });
        }
        legLog.info('executeWorkflow: loop fan-out', {
          stepId,
          total,
          concurrencyLimit,
          firstBatch,
          joinStepId,
        });
        return; // Leg done — iteration legs will drive the rest
      }
    }

    // GAP-9: if any successor is not in stepIdx, it's a boundary node (end) — track it
    for (const sid of successors) {
      if (!stepIdx.has(sid)) reachedEndStepIds.add(sid);
    }
    queue.push(...successors);
  }

  // ── Phase 4: Parallel fan-in barrier check ─────────────────────────────
  // If this leg was executing a branch (input.joinStepId is set), it needs
  // to atomically increment the barrier on the join step. Only the LAST branch
  // to complete (barrierCount === barrierTotal) triggers the join step leg.
  if (input.joinStepId && deps.persistence.atomicBarrierIncrement && deps.startWorkflow) {
    const joinStepId = input.joinStepId;
    // G-6 fix: journal the barrier increment so Restate retry doesn't double-count.
    const newCount = await restateCtx.run(
      `parallel-barrier:${joinStepId}:${input.branchId ?? 'root'}`,
      async () =>
        deps.persistence.atomicBarrierIncrement!(executionId, tenantId, projectId, joinStepId),
    );

    // Read barrierTotal from MongoDB (set by initStepBarrier at fan-out time).
    const execForBarrier = await deps.persistence.getExecutionForLeg!(
      executionId,
      tenantId,
      projectId,
    );
    const joinCtx = (execForBarrier?.context.steps as Record<string, Record<string, unknown>>)?.[
      joinStepId
    ];
    const barrierTotal = (joinCtx?.barrierTotal as number | undefined) ?? input.barrierTotal ?? 0;

    legLog.info('executeWorkflow: branch complete — barrier progress', {
      branchId: input.branchId,
      joinStepId,
      newCount,
      barrierTotal,
    });

    if (newCount >= barrierTotal) {
      // This is the last branch — check for failures before triggering join.
      const barrierFailCount = (joinCtx?.barrierFailCount as number | undefined) ?? 0;
      const failureStrategy = input.failureStrategy ?? 'fail_fast';
      const anyBranchFailed = barrierFailCount > 0 || input.hasBranchFailure;

      if (anyBranchFailed && failureStrategy === 'wait_all') {
        // wait_all: all branches ran but some failed — fail the workflow now.
        legLog.error(
          'executeWorkflow: all branches done, some failed (wait_all) — failing workflow',
          {
            joinStepId,
            barrierFailCount,
          },
        );
        await deps.persistence.updateExecutionStatus(executionId, tenantId, projectId, 'failed', {
          error: {
            code: 'PARALLEL_BRANCH_FAILED',
            message: `${barrierFailCount} parallel branch(es) failed`,
          },
          completedAt: new Date(),
        });
        await seqPublish(
          `workflow:${tenantId}:execution:${executionId}:status`,
          JSON.stringify({
            type: 'workflow.failed',
            executionId,
            error: `${barrierFailCount} parallel branch(es) failed`,
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }

      // ignore_errors or no failures — trigger join step leg.
      // G-6 fix: journal the join-step trigger to prevent double-dispatch on retry.
      legLog.info('executeWorkflow: all branches done — triggering join step', {
        joinStepId,
        anyBranchFailed,
        failureStrategy,
      });
      await restateCtx.run(`parallel-join:${joinStepId}`, async () => {
        await deps.startWorkflow!(executionId, {
          tenantId,
          projectId,
          startFromStepIds: [joinStepId],
          hasBranchFailure: anyBranchFailed,
          failureStrategy,
        });
      });
    }
    // Whether last or not, this branch leg is done.
    return;
  }

  // ── Phase 5: hasBranchFailure propagation to end step ─────────────────
  // If this is the join step leg triggered after a wait_all / ignore_errors
  // parallel where some branches failed, the workflow was already either
  // failed above or continues (ignore_errors). Nothing special needed here —
  // the join step just runs normally and hasBranchFailure is informational.

  // ── End step: all regular steps done — resolve output mappings ────────
  // The 'end' node is not in WorkflowStep union (it's a boundary node).
  // We reach this after the step queue empties, identical to how the legacy
  // runWorkflow path runs the end step after the DAG executor finishes.
  legLog.info('executeWorkflow: step queue exhausted — running end step', { executionId });

  const { resolveOutputMappings: resolveOutputMappingsFn } =
    await import('../validation/output-mapping-validator.js');

  // GAP-9 fix: use outputMappingsByEndNodeId when multiple end nodes exist,
  // mirroring runWorkflow lines 3947-3952. reachedEndStepIds is accumulated below.
  const endMappings =
    reachedEndStepIds.size > 0 && workflowInput.outputMappingsByEndNodeId
      ? [...reachedEndStepIds].flatMap(
          (endNodeId) => workflowInput.outputMappingsByEndNodeId?.[endNodeId] ?? [],
        )
      : (workflowInput.outputMappings ?? []);

  const { output: mappedEndOutput, mappingErrors: endMappingErrors } = resolveOutputMappingsFn(
    endMappings,
    wfCtx,
  );

  // GAP-9 fix: fail the workflow if output mapping errors exist (mirrors runWorkflow)
  if (endMappingErrors && endMappingErrors.length > 0) {
    const mappingErrMsg = `${endMappingErrors.length} output mapping error(s): ${endMappingErrors.map((e) => e.name).join(', ')}`;
    legLog.error('executeWorkflow: end step output mapping failed', {
      executionId,
      endMappingErrors,
    });
    await deps.persistence.updateExecutionStatus(executionId, tenantId, projectId, 'failed', {
      error: { code: 'OUTPUT_MAPPING_FAILED', message: mappingErrMsg },
      completedAt: new Date(),
    });
    await seqPublish(
      `workflow:${tenantId}:execution:${executionId}:status`,
      JSON.stringify({
        type: 'workflow.failed',
        executionId,
        error: mappingErrMsg,
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  // GAP-9 fix: add _status: 0 sentinel so SDK / runtime consumers can detect success.
  const endOutput = { _status: 0, ...(mappedEndOutput ?? {}) };

  // Mark end step completed. Update wfCtx.steps.end FIRST so updateExecutionStatus
  // (which writes context.steps from wfCtx) does not overwrite with stale 'pending'.
  const endCompletedData = buildCleanStepContext(
    'end',
    { nodeType: 'end', stepId: 'end', status: 'completed', completedAt: new Date().toISOString() },
    { input: endMappings, output: endOutput },
  );
  wfCtx.steps['end'] = endCompletedData as WorkflowStepData;
  await deps.persistence.updateStepStatus(executionId, tenantId, projectId, 'end', 'completed', {
    stepKey: 'end',
    stepData: endCompletedData as WorkflowStepData,
  });
  await seqPublish(
    `workflow:${tenantId}:execution:${executionId}:status`,
    JSON.stringify({
      type: 'step.completed',
      executionId,
      stepId: 'end',
      stepName: 'End',
      stepType: 'end',
      status: 'completed',
      timestamp: new Date().toISOString(),
    }),
  );

  const legCompletedAt = new Date();

  // Finalise execution — GAP-12 fix: include completedAt for duration computation
  await deps.persistence.updateExecutionStatus(executionId, tenantId, projectId, 'completed', {
    context: wfCtx,
    output: endOutput,
    completedAt: legCompletedAt,
  });

  await seqPublish(
    `workflow:${tenantId}:execution:${executionId}:status`,
    JSON.stringify({
      type: 'workflow.completed',
      executionId,
      timestamp: legCompletedAt.toISOString(),
      completedAt: legCompletedAt.toISOString(),
      output: endOutput,
    }),
  );

  // GAP-10 fix: enqueue callback delivery so agent runtime / external callers
  // receive the workflow result. Mirrors runWorkflow lines 4127-4157.
  const callbackUrl =
    typeof workflowInput.triggerMetadata?.callbackUrl === 'string'
      ? workflowInput.triggerMetadata.callbackUrl
      : undefined;
  if (deps.callbackQueue && callbackUrl) {
    const encryptedAccessToken = workflowInput.triggerMetadata?.encryptedAccessToken;
    const encryptedCallbackSecret = workflowInput.triggerMetadata?.encryptedCallbackSecret;
    await deps.callbackQueue.add('callback', {
      executionId,
      tenantId,
      callbackUrl,
      ...(typeof encryptedAccessToken === 'string' && encryptedAccessToken.length > 0
        ? { encryptedAccessToken }
        : {}),
      ...(typeof encryptedCallbackSecret === 'string' && encryptedCallbackSecret.length > 0
        ? { encryptedCallbackSecret }
        : {}),
      source: workflowInput.triggerMetadata?.source as string | undefined,
      payload: {
        traceId: executionId,
        status: 'completed',
        output: endOutput,
        executionId,
        tenantId,
        projectId,
        sessionId: workflowInput.triggerMetadata?.sessionId as string | undefined,
        workflowId: workflowInput.workflowId,
        workflowName: workflowInput.workflowName,
        source: workflowInput.triggerMetadata?.source as string | undefined,
      },
    });
  }

  legLog.info('executeWorkflow: workflow completed', { executionId });
}
