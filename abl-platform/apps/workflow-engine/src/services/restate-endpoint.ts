/**
 * Restate Service Endpoint
 *
 * Registers the workflow-runner Restate service that Restate invokes
 * for durable workflow execution. The endpoint is served as HTTP/2.
 *
 * Uses Restate's `workflow()` primitive (not `service()`) so that:
 * - The `run` handler gets exclusive-per-key execution (one run per workflow key)
 * - Shared handlers (`resolveCallback`, `resolveApproval`) can resolve
 *   durable promises created during the `run` handler's execution
 * - `ctx.key` provides a deterministic execution ID that survives retries
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import type {
  ConnectorDepsFactory,
  ExecutionPersistence,
  StatusPublisher,
  WorkflowExecutionInput,
} from '../handlers/workflow-handler.js';
import {
  runWorkflow,
  executeWorkflow,
  WORKFLOW_EXECUTOR_SERVICE_NAME,
} from '../handlers/workflow-handler.js';
import type { WorkflowRunInput, WorkflowHandlerDeps } from '../handlers/workflow-handler.js';
import type { StepDispatcherDeps } from '../handlers/step-dispatcher.js';

export type { ConnectorDepsFactory };

const log = createLogger('workflow-engine:restate-endpoint');

/** Service name used for Restate registration and client invocations */
export const WORKFLOW_SERVICE_NAME = 'workflow-runner';

export interface RestateEndpointDeps {
  persistence: ExecutionPersistence;
  publisher: StatusPublisher;
  dispatcherDeps: StepDispatcherDeps;
  connectorDepsFactory?: ConnectorDepsFactory;
  humanTaskStore?: import('../handlers/workflow-handler.js').HumanTaskStore;
  callbackQueue?: import('../handlers/workflow-handler.js').WorkflowHandlerDeps['callbackQueue'];
  encryptSecret?: import('../handlers/workflow-handler.js').WorkflowHandlerDeps['encryptSecret'];
  decryptSecret?: import('../handlers/workflow-handler.js').WorkflowHandlerDeps['decryptSecret'];
  /**
   * Optional. When supplied, the workflow run loads its memory projection
   * via this client at start (`workflow-handler.ts → loadMemoryProjection`).
   * The same client is the one threaded into `StepDispatcherDeps.memoryClient`
   * via `dispatcherDeps`; we accept it here so the composition root can pass
   * a single `RuntimeMemoryClient` instance and the endpoint plumbs it to
   * both call sites (handler-side projection load + dispatcher-side function
   * memory globals).
   */
  memoryClient?: import('../handlers/workflow-handler.js').MemoryProjectionLoader;
  /**
   * Optional. Receives extraction audit events from the connector_action
   * suspension block (Phase 4 task 4.7b). Defaults at the composition root
   * to a structured-log sink; tests inject an array-collector sink.
   */
  extractionAuditEmitter?: import('../handlers/workflow-handler.js').WorkflowHandlerDeps['extractionAuditEmitter'];
  /** Relay-race: injected so run handlers can fan-out parallel branches via startWorkflow(). */
  startWorkflow?: import('../handlers/workflow-handler.js').WorkflowHandlerDeps['startWorkflow'];
}

/** Payload for resolveCallback shared handler */
export interface ResolveCallbackInput {
  executionId: string;
  stepId: string;
  payload: unknown;
}

/** Payload for resolveApproval shared handler */
export interface ResolveApprovalInput {
  executionId: string;
  stepId: string;
  decision: unknown;
}

/** Payload for resolveHumanTask shared handler */
export interface ResolveHumanTaskInput {
  executionId: string;
  stepId: string;
  response: unknown;
}

/** Minimal shape of the Restate shared context used by the resolve/cancel handlers. */
export interface SharedCtxLike {
  key: string;
  promise<T>(name: string): { resolve(value: T): Promise<void> };
}

// ─── Shared-handler bodies (exported for unit tests) ────────────────────────

export async function handleCancel(
  ctx: SharedCtxLike,
): Promise<{ cancelled: true; executionId: string }> {
  const executionId = ctx.key;
  log.info('Restate workflow-runner.cancel invoked', { executionId });
  await ctx.promise<boolean>('sys:cancel').resolve(true);
  return { cancelled: true, executionId };
}

export async function handleResolveCallback(
  ctx: SharedCtxLike,
  data: ResolveCallbackInput,
): Promise<{ resolved: true; executionId: string; stepId: string }> {
  log.info('Restate workflow-runner.resolveCallback invoked', {
    executionId: data.executionId,
    stepId: data.stepId,
  });
  await ctx.promise<unknown>(`sys:callback:${data.stepId}`).resolve(data.payload);
  return { resolved: true, executionId: data.executionId, stepId: data.stepId };
}

export async function handleResolveApproval(
  ctx: SharedCtxLike,
  data: ResolveApprovalInput,
): Promise<{ resolved: true; executionId: string; stepId: string }> {
  log.info('Restate workflow-runner.resolveApproval invoked', {
    executionId: data.executionId,
    stepId: data.stepId,
  });
  await ctx.promise<unknown>(`sys:approval:${data.stepId}`).resolve(data.decision);
  return { resolved: true, executionId: data.executionId, stepId: data.stepId };
}

export async function handleResolveHumanTask(
  ctx: SharedCtxLike,
  data: ResolveHumanTaskInput,
): Promise<{ resolved: true; executionId: string; stepId: string }> {
  log.info('Restate workflow-runner.resolveHumanTask invoked', {
    executionId: data.executionId,
    stepId: data.stepId,
  });
  await ctx.promise<unknown>(`sys:human_task:${data.stepId}`).resolve(data.response);
  return { resolved: true, executionId: data.executionId, stepId: data.stepId };
}

/**
 * Build the Restate endpoint with the workflow-runner workflow service.
 * Returns the endpoint to be served via HTTP/2.
 *
 * The workflow uses `ctx.key` as the execution ID — callers must provide
 * a unique key per workflow invocation (e.g., a generated UUID).
 */
export function buildRestateEndpoint(deps: RestateEndpointDeps) {
  const workflowService = restate.workflow({
    name: WORKFLOW_SERVICE_NAME,
    handlers: {
      /**
       * Main workflow execution handler. Restate guarantees exactly-once
       * execution per key and durable retries on failure.
       *
       * The Restate `ctx` is passed through to `runWorkflow` so delay,
       * approval, and webhook steps use durable primitives (ctx.sleep,
       * ctx.promise) for real suspension rather than just recording metadata.
       */
      run: async (ctx: restate.WorkflowContext, input: WorkflowExecutionInput) => {
        const executionId = ctx.key;
        log.info('Restate workflow-runner.run invoked', {
          workflowId: input.workflowId,
          tenantId: input.tenantId,
          executionId,
        });

        return runWorkflow(
          input,
          executionId,
          {
            persistence: deps.persistence,
            publisher: deps.publisher,
            dispatcherDeps: deps.dispatcherDeps,
            connectorDepsFactory: deps.connectorDepsFactory,
            humanTaskStore: deps.humanTaskStore,
            callbackQueue: deps.callbackQueue,
            encryptSecret: deps.encryptSecret,
            decryptSecret: deps.decryptSecret,
            ...(deps.memoryClient ? { memoryClient: deps.memoryClient } : {}),
            ...(deps.extractionAuditEmitter
              ? { extractionAuditEmitter: deps.extractionAuditEmitter }
              : {}),
          },
          ctx,
        );
      },

      /**
       * Cancel a running workflow. Resolves the 'cancel' durable promise
       * so the `run` handler can detect cancellation between steps.
       * Shared handler — can execute concurrently with the `run` handler.
       */
      cancel: restate.handlers.workflow.shared(handleCancel),

      /**
       * Resolve an async webhook callback. Called externally when the
       * third-party system POSTs back to our callback URL.
       */
      resolveCallback: restate.handlers.workflow.shared(handleResolveCallback),

      /**
       * Resolve an approval step. Called when a human approves or rejects
       * a pending approval request.
       */
      resolveApproval: restate.handlers.workflow.shared(handleResolveApproval),

      /**
       * Resolve a human task step. Called when a human submits a response
       * to a pending human task (data entry, review, decision).
       */
      resolveHumanTask: restate.handlers.workflow.shared(handleResolveHumanTask),
    },
  });

  return restate.endpoint().bind(workflowService).bind(buildWorkflowExecutorObject(deps));
}

// ─── Relay-race Restate Object ───────────────────────────────────────────────

/**
 * Build the `workflow-executor` Restate virtual object.
 *
 * Uses `restate.object()` instead of `restate.workflow()` so:
 *   - `runWorkflow` is an EXCLUSIVE handler — Restate guarantees at most one
 *     run at a time per executionId key. Concurrent startWorkflow() calls for
 *     the same execution are serialised automatically.
 *   - `cancelWorkflow` is a SHARED handler — can run concurrently with any run
 *     to write the cancelled status to MongoDB. The next run entry reads MongoDB
 *     and exits immediately if cancelled.
 *   - No `ctx.promise()`, `ctx.sleep()`, or `ctx.awakeable()` — the object
 *     context provides only `ctx.run()` for exactly-once durable step execution.
 *     All external waits are handled by parking in MongoDB and returning.
 *
 * This object is registered ALONGSIDE the existing `workflow-runner` workflow
 * service. Legacy in-flight executions (with awakeableId on step records)
 * continue using the old path; new executions use runWorkflow.
 */
function buildWorkflowExecutorObject(deps: RestateEndpointDeps) {
  // Compose WorkflowHandlerDeps from the endpoint deps — same shape as runWorkflow uses.
  function makeWorkflowExecutorDeps(): WorkflowHandlerDeps {
    return {
      persistence: deps.persistence,
      publisher: deps.publisher,
      dispatcherDeps: deps.dispatcherDeps,
      ...(deps.connectorDepsFactory ? { connectorDepsFactory: deps.connectorDepsFactory } : {}),
      ...(deps.humanTaskStore ? { humanTaskStore: deps.humanTaskStore } : {}),
      ...(deps.callbackQueue ? { callbackQueue: deps.callbackQueue } : {}),
      ...(deps.encryptSecret ? { encryptSecret: deps.encryptSecret } : {}),
      ...(deps.decryptSecret ? { decryptSecret: deps.decryptSecret } : {}),
      ...(deps.memoryClient ? { memoryClient: deps.memoryClient } : {}),
      ...(deps.extractionAuditEmitter
        ? { extractionAuditEmitter: deps.extractionAuditEmitter }
        : {}),
      // Relay-race: pass through startWorkflow so executeWorkflow() can fan-out parallel branches.
      ...(deps.startWorkflow ? { startWorkflow: deps.startWorkflow } : {}),
    };
  }

  return restate.object({
    name: WORKFLOW_EXECUTOR_SERVICE_NAME,
    handlers: {
      /**
       * Execute one relay-race workflow run.
       *
       * Exclusive — Restate guarantees serial execution per executionId.
       * Reads DAG + state from MongoDB, executes sequential steps using
       * ctx.run() for durability, parks on suspension signals, returns cleanly.
       */
      runWorkflow: async (ctx: restate.ObjectContext, input: WorkflowRunInput): Promise<void> => {
        log.info('Restate workflow-executor.runWorkflow invoked', {
          executionId: ctx.key,
          startFromStepIds: input.startFromStepIds,
          branchId: input.branchId,
          resumeStepId: input.resumeStepId,
        });
        return executeWorkflow(ctx, input, makeWorkflowExecutorDeps());
      },

      /**
       * Cancel a relay-race workflow execution.
       *
       * Shared — runs concurrently with any active run. Writes cancelled
       * status to MongoDB; the next run boundary check detects it and exits.
       * Unlike the legacy cancel handler (which resolves a Restate durable
       * promise), this handler only needs MongoDB — no Restate primitives.
       */
      cancelWorkflow: restate.handlers.object.shared(
        async (
          ctx: restate.ObjectSharedContext,
          input: { tenantId: string; projectId: string },
        ): Promise<{ cancelled: true; executionId: string }> => {
          const executionId = ctx.key;
          log.info('Restate workflow-executor.cancelWorkflow invoked', {
            executionId,
            tenantId: input.tenantId,
          });
          await deps.persistence.updateExecutionStatus(
            executionId,
            input.tenantId,
            input.projectId,
            'cancelled',
            { completedAt: new Date() },
          );
          return { cancelled: true, executionId };
        },
      ),
    },
  });
}
