/**
 * ResumptionService — central orchestrator for resuming suspended executions.
 *
 * When a callback arrives (from external tool, remote agent, or human),
 * the BullMQ worker calls resume() which:
 * 1. Loads the SuspendedExecution from MongoDB
 * 2. Claims it atomically (prevents duplicate processing)
 * 3. Acquires a distributed session lock
 * 4. Loads and hydrates the RuntimeSession
 * 5. Dispatches to the appropriate handler by continuation type
 * 6. Delivers the result via ChannelDispatcher
 * 7. Persists session state and marks suspension complete
 */

import { randomUUID } from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import type {
  SuspensionStore,
  SuspendedExecution,
  SuspendedContinuation,
  CallbackRegistry,
  FanOutBarrierStore,
  BranchResult,
  ResumeData,
} from '@agent-platform/execution';
import type { ChannelDispatcher, DispatchableResult } from './channel-dispatcher.js';
import type { ExecutionResult, RuntimeSession } from './types.js';
import { getActiveThread, syncThreadToSession } from './types.js';
import {
  buildFanOutResultFromBranchResults,
  formatAsyncFanOutCompletionMessage,
  storeFanOutResultOnThread,
} from './fanout/fanout-results.js';
import {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  createResponseProvenanceAccumulator,
  type ResponseMessageMetadata,
} from '../channel/response-provenance.js';
import { getTraceStore } from '../trace-store.js';
import { buildProductionSessionLocator, type SessionLocator } from '../session/execution-scope.js';

const log = createLogger('resumption-service');

const MAX_RESUME_RETRIES = 3;

/**
 * Executor interface — what the resumption service needs from the runtime.
 * Avoids importing the full RuntimeExecutor type.
 */
export interface ResumableExecutor {
  executeMessage(
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: import('./types.js').ExecuteMessageOptions,
  ): Promise<
    {
      response: string;
      action: { type: string; [key: string]: unknown };
    } & Pick<
      ExecutionResult,
      'richContent' | 'actions' | 'voiceConfig' | 'localization' | 'responseMetadata'
    >
  >;
  rehydrateSession(
    sessionId: string,
    options?: { locator?: SessionLocator },
  ): Promise<RuntimeSession | null>;
  saveSessionSnapshot(session: RuntimeSession): Promise<void>;
}

/**
 * Distributed lock interface.
 */
export interface LockPort {
  acquire(
    key: string,
    options: { keyPrefix: string; ttlMs: number; retryAttempts: number; retryDelayMs: number },
  ): Promise<{ key: string; owner: string } | null>;
  release(lock: { key: string; owner: string }): Promise<void>;
  extend(lock: { key: string; owner: string }, ttlMs: number): Promise<boolean>;
}

export interface ResumptionServiceDeps {
  suspensionStore: SuspensionStore;
  callbackRegistry: CallbackRegistry;
  barrierStore: FanOutBarrierStore;
  channelDispatcher: ChannelDispatcher;
  executor: ResumableExecutor;
  lockManager: LockPort;
  resumeDispatcher?: ResumeDispatcher;
}

export interface ResumeDispatcher {
  enqueueResume(suspensionId: string, data: ResumeData): Promise<void>;
}

interface DeferredResumeRequest {
  suspensionId: string;
  data: ResumeData;
}

interface FanOutBranchResumeOutcome {
  parentResumeRequest?: DeferredResumeRequest | null;
}

interface FanOutParentResumeOutcome {
  result: DispatchableResult;
  cleanupBarrierId: string;
}

function buildDispatchableResumeResult(
  result: Awaited<ReturnType<ResumableExecutor['executeMessage']>>,
  responseMetadata: ResponseMessageMetadata,
  extras: Partial<Pick<DispatchableResult, 'handoffProgress'>> = {},
): DispatchableResult {
  return {
    response: result.response,
    ...(result.action ? { action: result.action } : {}),
    ...(result.richContent !== undefined ? { richContent: result.richContent } : {}),
    ...(result.actions !== undefined ? { actions: result.actions } : {}),
    ...(result.voiceConfig !== undefined ? { voiceConfig: result.voiceConfig } : {}),
    ...(result.localization !== undefined ? { localization: result.localization } : {}),
    responseMetadata,
    ...extras,
  };
}

export class ResumptionService {
  private readonly suspensionStore: SuspensionStore;
  private readonly callbackRegistry: CallbackRegistry;
  private readonly barrierStore: FanOutBarrierStore;
  private readonly channelDispatcher: ChannelDispatcher;
  private readonly executor: ResumableExecutor;
  private readonly lockManager: LockPort;
  private readonly resumeDispatcher?: ResumeDispatcher;

  constructor(deps: ResumptionServiceDeps) {
    this.suspensionStore = deps.suspensionStore;
    this.callbackRegistry = deps.callbackRegistry;
    this.barrierStore = deps.barrierStore;
    this.channelDispatcher = deps.channelDispatcher;
    this.executor = deps.executor;
    this.lockManager = deps.lockManager;
    this.resumeDispatcher = deps.resumeDispatcher;
  }

  private buildSuspensionSessionLocator(suspension: SuspendedExecution): SessionLocator | null {
    return buildProductionSessionLocator({
      tenantId: suspension.tenantId,
      projectId: suspension.projectId,
      sessionId: suspension.sessionId,
    });
  }

  async resume(suspensionId: string, data: ResumeData): Promise<void> {
    // 1. Load suspension
    const suspension = await this.suspensionStore.load(suspensionId);
    if (!suspension) {
      log.warn('Suspension not found for resume', { suspensionId });
      return;
    }

    // Verify tenant isolation
    if (data.tenantId && suspension.tenantId !== data.tenantId) {
      log.error('Tenant mismatch on resume — potential security violation', {
        suspensionId,
        expectedTenant: suspension.tenantId,
        providedTenant: data.tenantId,
      });
      return;
    }

    if (suspension.status !== 'suspended') {
      log.warn('Suspension not in suspended state', {
        suspensionId,
        status: suspension.status,
      });
      return;
    }

    // 2. Atomic claim (idempotency across pods)
    const claimed = await this.suspensionStore.claimForResume(suspensionId);
    if (!claimed) {
      log.info('Suspension already claimed by another pod', { suspensionId });
      return;
    }

    // 3. Acquire session lock
    const lock = await this.lockManager.acquire(suspension.sessionId, {
      keyPrefix: 'session-resume',
      ttlMs: 300_000,
      retryAttempts: 5,
      retryDelayMs: 2000,
    });
    if (!lock) {
      await this.suspensionStore.releaseClaim(suspensionId);
      throw new Error(`Could not acquire lock for session ${suspension.sessionId}`);
    }

    // Set up lock renewal inside try block so it only runs after lock is confirmed
    let lockRenewalInterval: ReturnType<typeof setInterval> | null = null;
    let deferredResumeRequest: DeferredResumeRequest | null = null;
    let deferCompletionUntilAfterLockRelease = false;
    let barrierCleanupId: string | null = null;
    try {
      lockRenewalInterval = setInterval(async () => {
        try {
          const extended = await this.lockManager.extend(lock, 300_000);
          if (!extended) {
            log.error('Lock renewal failed — lock lost', {
              suspensionId,
              sessionId: suspension.sessionId,
            });
          }
        } catch (err) {
          log.error('Lock renewal error', {
            suspensionId,
            sessionId: suspension.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }, 30_000);
      lockRenewalInterval.unref?.();
      // 4. Load session from store
      const locator = this.buildSuspensionSessionLocator(suspension);
      const session = await this.executor.rehydrateSession(
        suspension.sessionId,
        locator ? { locator } : undefined,
      );
      if (!session) {
        await this.suspensionStore.fail(suspensionId, {
          code: 'SESSION_NOT_FOUND',
          message: `Session ${suspension.sessionId} not found`,
        });
        return;
      }

      // 5. Dispatch to handler by continuation type
      let result: DispatchableResult | null = null;

      switch (suspension.continuation.type) {
        case 'tool_result':
          result = await this.resumeToolResult(suspension, data);
          break;

        case 'remote_handoff_result':
          result = await this.resumeRemoteHandoff(suspension, data);
          break;

        case 'fan_out_branch':
          deferredResumeRequest =
            (await this.resumeLegacyFanOutBranch(suspension, data)).parentResumeRequest ?? null;
          deferCompletionUntilAfterLockRelease = true;
          break;

        case 'fan_out_remote_branch':
          deferredResumeRequest =
            (await this.resumeFanOutRemoteBranch(suspension, data, session)).parentResumeRequest ??
            null;
          deferCompletionUntilAfterLockRelease = true;
          break;

        case 'fan_out_parent_resume': {
          const parentOutcome = await this.resumeFanOutParent(suspension, session);
          result = parentOutcome.result;
          barrierCleanupId = parentOutcome.cleanupBarrierId;
          break;
        }

        case 'human_input':
          result = await this.resumeHumanInput(suspension, data);
          break;

        default:
          throw new Error(
            `Unknown continuation type: ${(suspension.continuation as { type: string }).type}`,
          );
      }

      if (!deferCompletionUntilAfterLockRelease) {
        // 6. Check for nested async (suspend-during-resume)
        if (result && result.action?.type === 'suspend') {
          // The resumed execution itself suspended again — the new suspension
          // was already created by the executor. We just mark this one complete.
          log.info('Nested suspension detected during resume', {
            suspensionId,
            newSuspension: result.action?.suspensionId,
          });
          await this.suspensionStore.complete(suspensionId);
          return;
        }

        // 7. Deliver result
        if (result) {
          await this.channelDispatcher.deliver(
            suspension.channelBinding,
            suspension.sessionId,
            result,
          );
        }

        // 8. Mark suspension complete
        await this.suspensionStore.complete(suspensionId);

        if (barrierCleanupId) {
          await this.deleteBarrierSafely(barrierCleanupId, suspensionId);
        }

        log.info('Execution resumed successfully', {
          suspensionId,
          sessionId: suspension.sessionId,
          continuationType: suspension.continuation.type,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.handleResumeFailure(suspension, errorMsg);
      throw err;
    } finally {
      if (lockRenewalInterval) clearInterval(lockRenewalInterval);
      await this.lockManager.release(lock);
    }

    if (deferCompletionUntilAfterLockRelease) {
      try {
        if (deferredResumeRequest) {
          await this.dispatchDeferredResume(deferredResumeRequest);
        }

        await this.suspensionStore.complete(suspensionId);

        log.info('Execution resumed successfully', {
          suspensionId,
          sessionId: suspension.sessionId,
          continuationType: suspension.continuation.type,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await this.handleResumeFailure(suspension, errorMsg);
        throw err;
      }
    }
  }

  private async resumeToolResult(
    suspension: SuspendedExecution,
    data: ResumeData,
  ): Promise<DispatchableResult> {
    const cont = suspension.continuation as Extract<SuspendedContinuation, { type: 'tool_result' }>;

    log.info('Resuming tool result', {
      suspensionId: suspension.suspensionId,
      toolName: cont.toolName,
      toolCallId: cont.toolCallId,
    });

    // Continue the reasoning loop with the tool result injected.
    // The '__resume__' sentinel and tool result payload tell the executor
    // to inject the result and continue from where it left off.
    const { result, responseMetadata } = await this.executeMessageWithProvenance(
      suspension.sessionId,
      '__resume__',
    );

    return buildDispatchableResumeResult(result, responseMetadata);
  }

  private async resumeRemoteHandoff(
    suspension: SuspendedExecution,
    data: ResumeData,
  ): Promise<DispatchableResult> {
    const cont = suspension.continuation as Extract<
      SuspendedContinuation,
      { type: 'remote_handoff_result' }
    >;
    const payload = data.payload as {
      status?: string;
      response?: string;
      message?: unknown;
    };

    const responseText =
      typeof payload.response === 'string'
        ? payload.response
        : typeof payload.message === 'string'
          ? payload.message
          : payload.message
            ? JSON.stringify(payload.message)
            : payload.status === 'timeout'
              ? 'Remote handoff timed out.'
              : payload.status === 'failed'
                ? 'Remote handoff failed.'
                : 'Remote agent completed';

    log.info('Resuming remote handoff', {
      suspensionId: suspension.suspensionId,
      targetAgent: cont.targetAgent,
      remoteTaskId: cont.remoteTaskId,
      remoteThreadIndex: cont.remoteThreadIndex,
      parentThreadIndex: cont.parentThreadIndex,
      returnExpected: cont.returnExpected,
    });

    // The result from the remote agent needs to be fed back into the
    // parent execution context. Execute with the remote response.
    const { result, responseMetadata } = await this.executeMessageWithProvenance(
      suspension.sessionId,
      responseText,
      {
        remoteHandoffResume: {
          targetAgent: cont.targetAgent,
          responseText,
          taskId: cont.remoteTaskId,
          status: typeof payload.status === 'string' ? payload.status : undefined,
        },
      },
    );

    return buildDispatchableResumeResult(result, responseMetadata, {
      handoffProgress: {
        phase: 'resumed' as const,
        targetAgent: cont.targetAgent,
        taskId: cont.remoteTaskId,
      },
    });
  }

  private async resumeLegacyFanOutBranch(
    suspension: SuspendedExecution,
    data: ResumeData,
  ): Promise<FanOutBranchResumeOutcome> {
    const cont = suspension.continuation as Extract<
      SuspendedContinuation,
      { type: 'fan_out_branch' }
    >;
    const payload = this.normalizeFanOutBranchPayload(data.payload);

    const branchResult: BranchResult = {
      branchAgent: cont.branchAgent,
      status: payload.status,
      response: payload.response,
      error: payload.error,
      completedAt: Date.now(),
    };

    const outcome = await this.barrierStore.completeBranch(cont.barrierId, branchResult);

    log.info('Fan-out branch completed', {
      sessionId: suspension.sessionId,
      executionId: cont.parentExecutionId,
      barrierId: cont.barrierId,
      branchId: branchResult.branchId,
      targetAgent: cont.branchAgent,
      threadIndex: cont.threadIndex,
      continuationType: suspension.continuation.type,
      completedCount: outcome.completedCount,
      totalCount: outcome.totalCount,
      disposition: outcome.disposition,
      parentResumeReady: outcome.parentResumeReady,
    });

    this.emitDecisionTrace(suspension.sessionId, {
      type: 'fan_out_branch_resumed',
      continuationType: suspension.continuation.type,
      barrierId: cont.barrierId,
      branchAgent: cont.branchAgent,
      threadIndex: cont.threadIndex,
      disposition: outcome.disposition ?? 'recorded',
      completedCount: outcome.completedCount,
      totalCount: outcome.totalCount,
      parentResumeReady: outcome.parentResumeReady === true,
    });

    if (!outcome.parentResumeReady) {
      return {};
    }

    return {
      parentResumeRequest: await this.buildParentResumeRequest(cont.barrierId, suspension.tenantId),
    };
  }

  private async resumeFanOutRemoteBranch(
    suspension: SuspendedExecution,
    data: ResumeData,
    session: RuntimeSession,
  ): Promise<FanOutBranchResumeOutcome> {
    const cont = suspension.continuation as Extract<
      SuspendedContinuation,
      { type: 'fan_out_remote_branch' }
    >;
    const payload = this.normalizeFanOutBranchPayload(data.payload);

    const branchResult: BranchResult = {
      branchId: cont.branchId,
      branchAgent: cont.branchAgent,
      status: payload.status,
      response: payload.response,
      error: payload.error,
      completedAt: Date.now(),
    };

    const outcome = await this.barrierStore.completeBranch(cont.barrierId, branchResult);

    log.info('Fan-out branch completed', {
      sessionId: suspension.sessionId,
      executionId: cont.parentExecutionId,
      barrierId: cont.barrierId,
      branchId: cont.branchId,
      targetAgent: cont.branchAgent,
      threadIndex: cont.threadIndex,
      continuationType: suspension.continuation.type,
      completedCount: outcome.completedCount,
      totalCount: outcome.totalCount,
      disposition: outcome.disposition,
      parentResumeReady: outcome.parentResumeReady,
    });

    this.emitDecisionTrace(suspension.sessionId, {
      type: 'fan_out_branch_resumed',
      continuationType: suspension.continuation.type,
      barrierId: cont.barrierId,
      branchId: cont.branchId,
      branchAgent: cont.branchAgent,
      threadIndex: cont.threadIndex,
      disposition: outcome.disposition ?? 'recorded',
      completedCount: outcome.completedCount,
      totalCount: outcome.totalCount,
      parentResumeReady: outcome.parentResumeReady === true,
    });

    if (outcome.disposition === 'recorded') {
      this.applyFanOutBranchResultToSession(session, cont.threadIndex, branchResult);
      await this.executor.saveSessionSnapshot(session);
    }

    if (!outcome.parentResumeReady) {
      return {};
    }

    return {
      parentResumeRequest: await this.buildParentResumeRequest(cont.barrierId, suspension.tenantId),
    };
  }

  private async resumeFanOutParent(
    suspension: SuspendedExecution,
    session: RuntimeSession,
  ): Promise<FanOutParentResumeOutcome> {
    const cont = suspension.continuation as Extract<
      SuspendedContinuation,
      { type: 'fan_out_parent_resume' }
    >;
    const barrierResults = await this.barrierStore.getResults(cont.barrierId);
    const fanOutResult = buildFanOutResultFromBranchResults(barrierResults);
    const parentThread = session.threads[cont.parentThreadIndex] ?? getActiveThread(session);

    if (parentThread) {
      storeFanOutResultOnThread(parentThread, fanOutResult);
      if (session.activeThreadIndex === cont.parentThreadIndex) {
        syncThreadToSession(session);
      }
      await this.executor.saveSessionSnapshot(session);
    }

    log.info('Fan-out parent ready to resume', {
      sessionId: suspension.sessionId,
      executionId: cont.parentExecutionId,
      barrierId: cont.barrierId,
      continuationType: suspension.continuation.type,
      taskCount: fanOutResult.results.length,
      failedCount: fanOutResult.failedCount,
    });

    this.emitDecisionTrace(suspension.sessionId, {
      type: 'fan_out_parent_resumed',
      barrierId: cont.barrierId,
      parentThreadIndex: cont.parentThreadIndex,
      taskCount: fanOutResult.results.length,
      failedCount: fanOutResult.failedCount,
    });

    return {
      result: {
        response: formatAsyncFanOutCompletionMessage(fanOutResult),
        action: {
          type: 'fan_out',
          taskCount: fanOutResult.results.length,
          failedCount: fanOutResult.failedCount,
        },
        responseMetadata: buildResponseMessageMetadata(createResponseProvenanceAccumulator()),
      },
      cleanupBarrierId: cont.barrierId,
    };
  }

  private async resumeHumanInput(
    suspension: SuspendedExecution,
    data: ResumeData,
  ): Promise<DispatchableResult> {
    const cont = suspension.continuation as Extract<SuspendedContinuation, { type: 'human_input' }>;
    const humanInput = data.payload as Record<string, unknown> | string;

    const inputText =
      typeof humanInput === 'string'
        ? humanInput
        : Object.entries(humanInput)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');

    log.info('Resuming human input', {
      suspensionId: suspension.suspensionId,
      prompt: cont.prompt,
    });

    // Continue execution with the human's input as a user message
    const { result, responseMetadata } = await this.executeMessageWithProvenance(
      suspension.sessionId,
      inputText,
    );

    return buildDispatchableResumeResult(result, responseMetadata);
  }

  private async executeMessageWithProvenance(
    sessionId: string,
    userMessage: string,
    options?: import('./types.js').ExecuteMessageOptions,
  ): Promise<{
    result: Awaited<ReturnType<ResumableExecutor['executeMessage']>>;
    responseMetadata: ReturnType<typeof buildResponseMessageMetadata>;
  }> {
    const responseProvenance = createResponseProvenanceAccumulator();
    const result = await this.executor.executeMessage(
      sessionId,
      userMessage,
      undefined,
      (event) => accumulateResponseProvenance(responseProvenance, event),
      options,
    );

    return {
      result,
      responseMetadata: result.responseMetadata ?? buildResponseMessageMetadata(responseProvenance),
    };
  }

  private async buildParentResumeRequest(
    barrierId: string,
    tenantId: string,
  ): Promise<DeferredResumeRequest | null> {
    const parentSuspensionId = await this.barrierStore.getParentSuspension(barrierId);
    if (!parentSuspensionId) {
      log.error('No parent suspension found for completed barrier', { barrierId });
      return null;
    }

    return {
      suspensionId: parentSuspensionId,
      data: {
        type: 'fan_out_parent_resume',
        callbackId: barrierId,
        tenantId,
        payload: {},
        receivedAt: Date.now(),
      },
    };
  }

  private applyFanOutBranchResultToSession(
    session: RuntimeSession,
    threadIndex: number,
    branchResult: BranchResult,
  ): void {
    const thread = session.threads[threadIndex];
    if (!thread) {
      log.warn('Fan-out branch thread missing during resume', {
        sessionId: session.id,
        branchAgent: branchResult.branchAgent,
        branchId: branchResult.branchId,
        threadIndex,
      });
      return;
    }

    thread.status = 'completed';
    thread.endedAt = branchResult.completedAt;

    if (branchResult.response) {
      thread.pendingResponse = branchResult.response;
      thread.data.values._fan_out_response = branchResult.response;
    }

    if (branchResult.status !== 'completed') {
      thread.data.values._fan_out_error =
        branchResult.error || `Async fan-out branch ${branchResult.branchAgent} did not complete.`;
    } else {
      delete thread.data.values._fan_out_error;
    }

    if (threadIndex === session.activeThreadIndex) {
      syncThreadToSession(session);
    }
  }

  private normalizeFanOutBranchPayload(payload: unknown): {
    status: BranchResult['status'];
    response?: string;
    error?: string;
  } {
    if (typeof payload === 'string') {
      return { status: 'completed', response: payload };
    }

    if (!payload || typeof payload !== 'object') {
      return { status: 'completed' };
    }

    const record = payload as Record<string, unknown>;
    const state = this.readAsyncBranchState(record);
    const response =
      typeof record.response === 'string'
        ? record.response
        : this.extractTextFromAsyncPayload(record.message ?? record);
    const error =
      typeof record.error === 'string'
        ? record.error
        : state === 'timeout'
          ? this.extractTextFromAsyncPayload(record.message ?? record) ||
            'The async fan-out branch timed out.'
          : state === 'cancelled'
            ? this.extractTextFromAsyncPayload(record.message ?? record) ||
              'The async fan-out branch was cancelled.'
            : state === 'error'
              ? this.extractTextFromAsyncPayload(record.message ?? record) ||
                'The async fan-out branch failed.'
              : undefined;

    return {
      status: state,
      response,
      error,
    };
  }

  private readAsyncBranchState(
    payload: Record<string, unknown>,
  ): Extract<BranchResult['status'], 'completed' | 'error' | 'timeout' | 'cancelled'> {
    const statusValue = payload.status;
    const directStatus =
      typeof statusValue === 'string'
        ? statusValue.toLowerCase()
        : statusValue && typeof statusValue === 'object' && 'state' in statusValue
          ? String((statusValue as { state?: unknown }).state ?? '').toLowerCase()
          : '';

    switch (directStatus) {
      case 'failed':
      case 'error':
        return 'error';
      case 'cancelled':
      case 'canceled':
        return 'cancelled';
      case 'timeout':
        return 'timeout';
      default:
        return typeof payload.error === 'string' ? 'error' : 'completed';
    }
  }

  private extractTextFromAsyncPayload(payload: unknown): string | undefined {
    if (typeof payload === 'string') {
      return payload;
    }

    if (!payload || typeof payload !== 'object') {
      return undefined;
    }

    const messageLike = payload as {
      kind?: unknown;
      parts?: unknown;
      status?: { message?: unknown };
      artifacts?: Array<{ parts?: unknown }>;
      message?: unknown;
    };

    const directParts = this.extractTextParts(messageLike.parts);
    if (directParts) {
      return directParts;
    }

    const statusMessage = this.extractTextFromAsyncPayload(messageLike.status?.message);
    if (statusMessage) {
      return statusMessage;
    }

    for (const artifact of messageLike.artifacts ?? []) {
      const artifactText = this.extractTextParts(artifact.parts);
      if (artifactText) {
        return artifactText;
      }
    }

    if ('message' in messageLike) {
      return this.extractTextFromAsyncPayload(messageLike.message);
    }

    return undefined;
  }

  private extractTextParts(parts: unknown): string | undefined {
    if (!Array.isArray(parts)) {
      return undefined;
    }

    const text = parts
      .filter(
        (part): part is { kind?: unknown; type?: unknown; text?: unknown } =>
          part != null && typeof part === 'object',
      )
      .map((part) => {
        if ((part.kind === 'text' || part.type === 'text') && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');

    return text || undefined;
  }

  private emitDecisionTrace(sessionId: string, data: Record<string, unknown>): void {
    try {
      getTraceStore().addEvent(sessionId, {
        id: randomUUID(),
        sessionId,
        type: 'decision',
        timestamp: new Date(),
        data,
        decisionKind: 'completion',
      });
    } catch (err) {
      log.warn('Failed to append resumption decision trace', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatchDeferredResume(request: DeferredResumeRequest): Promise<void> {
    if (this.resumeDispatcher) {
      await this.resumeDispatcher.enqueueResume(request.suspensionId, request.data);
      return;
    }

    await this.resume(request.suspensionId, request.data);
  }

  private async deleteBarrierSafely(barrierId: string, suspensionId: string): Promise<void> {
    try {
      await this.barrierStore.delete(barrierId);
    } catch (err) {
      log.warn('Failed to delete fan-out barrier after parent resume', {
        suspensionId,
        barrierId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleResumeFailure(
    suspension: SuspendedExecution,
    errorMessage: string,
  ): Promise<void> {
    log.error('Resume failed', { suspensionId: suspension.suspensionId, error: errorMessage });

    if (suspension.resumeAttempts < MAX_RESUME_RETRIES) {
      await this.suspensionStore.releaseClaim(suspension.suspensionId);
      return;
    }

    await this.suspensionStore.fail(suspension.suspensionId, {
      code: 'RESUME_FAILED',
      message: errorMessage,
    });
  }
}
