/**
 * ExecutionCoordinator — single entry point for all message processing.
 *
 * All callers (WebSocket handlers, HTTP chat, tests) go through submit().
 * Handles serial, preemptive, and parallel concurrency strategies per-session
 * based on the agent IR's execution.concurrency field.
 */

import { createLogger } from '@abl/compiler/platform';
import { AppError } from '@agent-platform/shared-kernel';
import { createExecution } from '@agent-platform/execution';
import type { Execution, ExecutionQueue, SuspensionReason } from '@agent-platform/execution';
import type { ExecutionDedup } from './execution-dedup.js';
import type { ExecutionResult, ExecuteMessageOptions } from './types.js';

const log = createLogger('execution-coordinator');

/** Default max queue depth per session (overridable via IR execution.max_queue_depth) */
const DEFAULT_MAX_QUEUE_DEPTH = 10;
/** Default max concurrent parallel executions per session */
const DEFAULT_MAX_CONCURRENT_MESSAGES = 5;
/** TTL for recently completed execution results (aligned with dedup window) */
const RECENT_RESULTS_TTL_MS = 10_000;
/** Max samples for rolling average execution duration */
const MAX_DURATION_SAMPLES = 10;

// =============================================================================
// PUBLIC TYPES
// =============================================================================

export interface SubmitOptions {
  /** Optional per-turn/request key used to distinguish otherwise identical inputs. */
  dedupKey?: string;
  /** Caller-visible execution id used to correlate streaming lifecycle frames. */
  executionId?: string;
  attachmentIds?: string[];
  messageMetadata?: ExecuteMessageOptions['messageMetadata'];
  interactionContext?: ExecuteMessageOptions['interactionContext'];
  sessionMetadata?: ExecuteMessageOptions['sessionMetadata'];
  sessionLocator?: ExecuteMessageOptions['sessionLocator'];
  onChunk?: (chunk: string) => void;
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
  callerContext?: unknown;
  tenantId: string;
  signal?: AbortSignal;
  /** Channel-specific metadata forwarded to centralized agent lifecycle events */
  channelMetadata?: ExecuteMessageOptions['channelMetadata'];
}

export interface ExecutionCoordinatorDeps {
  queue: ExecutionQueue;
  dedup: ExecutionDedup;
  executor: {
    executeMessage: (
      sessionId: string,
      userMessage: string,
      onChunk?: (chunk: string) => void,
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      options?: ExecuteMessageOptions,
    ) => Promise<ExecutionResult>;
  };
  sessionLoader: (sessionId: string) => Promise<{
    agentName: string;
    agentIR: {
      execution: {
        concurrency?: string;
        max_queue_depth?: number;
        max_concurrent_messages?: number;
      };
    };
  } | null>;
}

type ConcurrencyStrategy = 'serial' | 'preemptive' | 'parallel';

/** Deferred promise — exposes resolve/reject for external settlement */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Box wrapper to prevent async auto-unwrapping of inner promises.
 * When an async function returns a Promise, the runtime unwraps it.
 * Wrapping in { value } prevents that.
 */
interface Boxed<T> {
  value: T;
}

// =============================================================================
// COORDINATOR
// =============================================================================

/** Per-submit metadata stored alongside the deferred */
interface InflightEntry {
  execution: Execution;
  deferred: Deferred<Execution>;
  options: SubmitOptions;
  abortController: AbortController;
  detachAbortListener?: () => void;
  /** Set before abort() to distinguish preemptive abort from explicit cancel */
  abortReason?: 'cancel' | 'preempt';
}

export class ExecutionCoordinator {
  private readonly queue: ExecutionQueue;
  private readonly dedup: ExecutionDedup;
  private readonly executor: ExecutionCoordinatorDeps['executor'];
  private readonly sessionLoader: ExecutionCoordinatorDeps['sessionLoader'];

  /** In-flight executions keyed by executionId */
  private readonly inflight = new Map<string, InflightEntry>();

  /**
   * Recently completed execution promises keyed by executionId.
   * Used by dedup to return the result of an execution that completed
   * before the duplicate submit's critical section ran.
   * Entries are cleaned up on a TTL basis (aligned with dedup TTL).
   */
  private readonly recentResults = new Map<string, Promise<Execution>>();

  /** Tracks whether a serial drain loop is already running per session */
  private readonly draining = new Set<string>();

  /** Per-session active parallel execution count */
  private readonly parallelCounts = new Map<string, number>();

  /** Per-session rolling execution duration samples for estimatedWaitMs */
  private readonly durationSamples = new Map<string, number[]>();

  /**
   * Per-session submit serialization chain. Each submit awaits the previous
   * submit's enqueue phase to complete, making the dedup check+record atomic.
   */
  private readonly submitChains = new Map<string, Promise<void>>();

  /**
   * Suspended execution tracking. When an execution suspends, its deferred
   * and entry are stored here until ResumptionService calls resolveSuspended().
   */
  private readonly suspendedDeferreds = new Map<
    string,
    { deferred: Deferred<Execution>; execution: Execution; entry: InflightEntry }
  >();

  /** TTL timers for suspended executions — auto-evict stale entries */
  private readonly suspensionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Default TTL for suspended executions (10 minutes) */
  private static readonly SUSPENSION_TTL_MS = 10 * 60 * 1000;

  constructor(deps: ExecutionCoordinatorDeps) {
    this.queue = deps.queue;
    this.dedup = deps.dedup;
    this.executor = deps.executor;
    this.sessionLoader = deps.sessionLoader;
  }

  /**
   * Submit a message for execution. Returns a promise that resolves when the
   * execution completes (not just when queued).
   */
  async submit(sessionId: string, message: string, options: SubmitOptions): Promise<Execution> {
    // Chain submits per session so the dedup critical section is serialized
    const prevChain = this.submitChains.get(sessionId) ?? Promise.resolve();
    let resolveChain!: () => void;
    const chainLink = new Promise<void>((r) => {
      resolveChain = r;
    });
    this.submitChains.set(sessionId, chainLink);

    await prevChain;

    // Run critical section: dedup check, create, enqueue.
    // Returns a Boxed promise so async doesn't auto-unwrap it.
    let boxed: Boxed<Promise<Execution>>;
    try {
      boxed = await this.enqueueOrDedup(sessionId, message, options);
    } finally {
      // Release the chain BEFORE waiting for execution to complete
      resolveChain();

      // Clean up submitChains entry if no further submits have chained onto it.
      // If another submit already chained (set a new entry), the === check fails
      // and we preserve the new chain. The next submit for this session will get
      // Promise.resolve() from the ?? fallback, so deletion is safe.
      if (this.submitChains.get(sessionId) === chainLink) {
        this.submitChains.delete(sessionId);
      }
    }

    // Wait for execution outside the lock
    return boxed.value;
  }

  /**
   * Critical section: check dedup, create execution, enqueue/dispatch.
   * Returns a Boxed<Promise<Execution>> — the boxed promise resolves when
   * the execution finishes. The Boxed wrapper prevents async auto-unwrapping.
   */
  private async enqueueOrDedup(
    sessionId: string,
    message: string,
    options: SubmitOptions,
  ): Promise<Boxed<Promise<Execution>>> {
    // 1. Load session
    const sessionInfo = await this.sessionLoader(sessionId);
    if (!sessionInfo) {
      const exec = createExecution({
        sessionId,
        tenantId: options.tenantId,
        message,
        agentName: 'unknown',
        executionId: options.executionId,
        attachmentIds: options.attachmentIds,
      });
      exec.status = 'failed';
      exec.completedAt = Date.now();
      exec.error = { code: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found` };
      return { value: Promise.resolve(exec) };
    }

    const strategy = this.resolveStrategy(sessionInfo.agentIR);
    const maxDepth = sessionInfo.agentIR.execution.max_queue_depth ?? DEFAULT_MAX_QUEUE_DEPTH;

    // Queue depth enforcement for serial mode
    if (strategy === 'serial') {
      const currentDepth = await this.queue.length(sessionId);
      if (currentDepth >= maxDepth) {
        const exec = createExecution({
          sessionId,
          tenantId: options.tenantId,
          message,
          agentName: sessionInfo.agentName,
          executionId: options.executionId,
          attachmentIds: options.attachmentIds,
        });
        exec.status = 'failed';
        exec.completedAt = Date.now();
        exec.error = {
          code: 'QUEUE_FULL',
          message: `Queue depth ${currentDepth} exceeds max ${maxDepth}`,
        };
        return { value: Promise.resolve(exec) };
      }
    }

    // Parallel concurrency limit enforcement — fall back to serial queueing when at capacity
    let effectiveStrategy = strategy;
    if (strategy === 'parallel') {
      const activeCount = this.parallelCounts.get(sessionId) ?? 0;
      const maxConcurrent =
        sessionInfo.agentIR.execution.max_concurrent_messages ?? DEFAULT_MAX_CONCURRENT_MESSAGES;
      if (activeCount >= maxConcurrent) {
        // At parallel limit — check queue depth before falling back to serial
        const currentDepth = await this.queue.length(sessionId);
        if (currentDepth >= maxDepth) {
          const exec = createExecution({
            sessionId,
            tenantId: options.tenantId,
            message,
            agentName: sessionInfo.agentName,
            executionId: options.executionId,
            attachmentIds: options.attachmentIds,
          });
          exec.status = 'failed';
          exec.completedAt = Date.now();
          exec.error = {
            code: 'QUEUE_FULL',
            message: `Queue depth ${currentDepth} exceeds max ${maxDepth}`,
          };
          return { value: Promise.resolve(exec) };
        }
        effectiveStrategy = 'serial';
      }
    }

    // 2. Create Execution (needed for executionId before atomic dedup)
    const execution = createExecution({
      sessionId,
      tenantId: options.tenantId,
      message,
      agentName: sessionInfo.agentName,
      executionId: options.executionId,
      attachmentIds: options.attachmentIds,
    });

    // 3. Atomic dedup check+record — returns existing executionId if duplicate,
    // or records our executionId and returns null. Thread-safe for distributed Redis.
    const existingId = await this.dedup.checkAndRecord(
      sessionId,
      message,
      options.attachmentIds,
      options.messageMetadata,
      execution.executionId,
      options.interactionContext,
      options.dedupKey,
    );
    if (existingId) {
      const inflight = this.inflight.get(existingId);
      if (inflight) {
        log.debug('Dedup hit — waiting for in-flight execution', { executionId: existingId });
        return { value: inflight.deferred.promise };
      }
      const recent = this.recentResults.get(existingId);
      if (recent) {
        log.debug('Dedup hit — returning recent result', { executionId: existingId });
        return { value: recent };
      }
    }

    // 4. Register inflight (dedup already recorded atomically above)
    const deferred = createDeferred<Execution>();
    const abortController = new AbortController();
    let detachAbortListener: (() => void) | undefined;
    if (options.signal) {
      const onAbort = () => {
        const entry = this.inflight.get(execution.executionId);
        if (!entry || entry.abortController.signal.aborted) {
          return;
        }
        entry.abortReason = 'cancel';
        entry.abortController.abort(options.signal?.reason);
      };

      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
        detachAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
      }
    }
    this.inflight.set(execution.executionId, {
      execution,
      deferred,
      options,
      abortController,
      detachAbortListener,
    });
    if (options.signal?.aborted) {
      const entry = this.inflight.get(execution.executionId);
      if (entry && !entry.abortController.signal.aborted) {
        entry.abortReason = 'cancel';
        entry.abortController.abort(options.signal.reason);
      }
    }

    // 5. Pre-increment parallel count when dispatching as parallel (within critical section
    // so subsequent submits see the updated count before dispatch fires)
    if (effectiveStrategy === 'parallel') {
      this.parallelCounts.set(sessionId, (this.parallelCounts.get(sessionId) ?? 0) + 1);
    }

    // 6. Emit execution.queued trace event
    const queuePosition = await this.queue.length(sessionId);
    options.onTraceEvent?.({
      type: 'execution.queued',
      data: {
        executionId: execution.executionId,
        sessionId,
        agentName: sessionInfo.agentName,
        queuePosition,
        estimatedWaitMs: this.getEstimatedWaitMs(sessionId, queuePosition),
      },
    });

    // 7. Dispatch (fire-and-forget — resolves the deferred when done)
    this.dispatch(effectiveStrategy, sessionId, execution);

    return { value: deferred.promise };
  }

  /** Cancel a specific execution */
  async cancel(executionId: string): Promise<boolean> {
    const entry = this.inflight.get(executionId);
    if (!entry) return false;
    entry.abortReason = 'cancel';
    entry.abortController.abort();
    return true;
  }

  /** Cancel all executions for a session (queued + active) */
  async cancelSession(sessionId: string): Promise<void> {
    // Cancel queued executions
    const cancelled = await this.queue.cancelAll(sessionId);
    for (const exec of cancelled) {
      const entry = this.inflight.get(exec.executionId);
      if (entry) {
        entry.detachAbortListener?.();
        exec.status = 'cancelled';
        exec.completedAt = Date.now();
        entry.deferred.resolve(exec);
        this.inflight.delete(exec.executionId);
      }
    }

    // Cancel active execution
    const active = await this.queue.getActive(sessionId);
    if (active) {
      const entry = this.inflight.get(active.executionId);
      if (entry) {
        entry.abortReason = 'cancel';
        entry.abortController.abort();
      }
    }

    // Cancel suspended executions for this session (same logic as cleanupSession)
    for (const [suspensionId, suspended] of this.suspendedDeferreds) {
      if (suspended.execution.sessionId === sessionId) {
        suspended.entry.detachAbortListener?.();
        suspended.execution.status = 'cancelled';
        suspended.execution.completedAt = Date.now();
        suspended.deferred.resolve(suspended.execution);
        this.suspendedDeferreds.delete(suspensionId);
        this.inflight.delete(suspended.execution.executionId);
        const timer = this.suspensionTimers.get(suspensionId);
        if (timer) {
          clearTimeout(timer);
          this.suspensionTimers.delete(suspensionId);
        }
      }
    }
  }

  /** Get execution status for in-flight or recently completed executions */
  async getStatus(executionId: string): Promise<Execution | null> {
    // Check inflight entries first — return a snapshot from the execution object
    // without awaiting the deferred (which would block until completion)
    const entry = this.inflight.get(executionId);
    if (entry) {
      return { ...entry.execution };
    }
    // Check recently completed — the promise is already resolved so .then() is non-blocking
    const recent = this.recentResults.get(executionId);
    if (recent) {
      return recent.then((e) => ({ ...e })).catch(() => null);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // DISPATCH
  // ---------------------------------------------------------------------------

  private dispatch(strategy: ConcurrencyStrategy, sessionId: string, execution: Execution): void {
    switch (strategy) {
      case 'preemptive':
        this.dispatchPreemptive(sessionId, execution);
        break;
      case 'parallel':
        this.dispatchImmediate(sessionId, execution);
        break;
      case 'serial':
      default:
        this.dispatchSerial(sessionId, execution);
        break;
    }
  }

  private dispatchSerial(sessionId: string, execution: Execution): void {
    this.queue
      .enqueue(sessionId, execution)
      .then(() => {
        if (!this.draining.has(sessionId)) {
          this.draining.add(sessionId);
          return this.drainLoop(sessionId);
        }
      })
      .catch((err) => {
        log.error('Serial dispatch failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** Drain loop — processes queued executions one at a time for a session */
  private async drainLoop(sessionId: string): Promise<void> {
    try {
      while (true) {
        const next = await this.queue.dequeue(sessionId);
        if (!next) break;

        const entry = this.inflight.get(next.executionId);
        if (!entry) continue;

        await this.runExecution(sessionId, next, entry);
      }
    } finally {
      this.draining.delete(sessionId);
    }
  }

  private dispatchPreemptive(sessionId: string, execution: Execution): void {
    // Abort any currently active execution
    this.abortActiveExecution(sessionId, 'preempt');

    this.dispatchImmediate(sessionId, execution);
  }

  /** Start execution immediately (used by preemptive and parallel) */
  private dispatchImmediate(sessionId: string, execution: Execution): void {
    const entry = this.inflight.get(execution.executionId);
    if (!entry) return;

    this.runExecution(sessionId, execution, entry).catch((err) => {
      log.error('Execution dispatch failed', {
        sessionId,
        executionId: execution.executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private abortActiveExecution(sessionId: string, reason: 'cancel' | 'preempt'): void {
    this.queue
      .getActive(sessionId)
      .then((active) => {
        if (!active) return;
        const entry = this.inflight.get(active.executionId);
        if (entry) {
          entry.abortReason = reason;
          entry.abortController.abort();
        }
      })
      .catch((err) => {
        log.error('Failed to abort active execution', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ---------------------------------------------------------------------------
  // EXECUTION RUNNER
  // ---------------------------------------------------------------------------

  private async runExecution(
    sessionId: string,
    execution: Execution,
    entry: InflightEntry,
  ): Promise<void> {
    const { deferred, options, abortController } = entry;

    execution.status = 'running';
    execution.startedAt = Date.now();
    await this.queue.setActive(sessionId, execution);

    // Emit execution.started trace event
    options.onTraceEvent?.({
      type: 'execution.started',
      data: {
        executionId: execution.executionId,
        sessionId: execution.sessionId,
        agentName: execution.agentName,
        tenantId: execution.tenantId,
      },
    });

    try {
      const result = await this.executor.executeMessage(
        sessionId,
        execution.message,
        options.onChunk,
        options.onTraceEvent,
        {
          attachmentIds: options.attachmentIds,
          messageMetadata: options.messageMetadata,
          interactionContext: options.interactionContext,
          sessionMetadata: options.sessionMetadata,
          sessionLocator: options.sessionLocator,
          signal: abortController.signal,
          channelMetadata: options.channelMetadata,
        },
      );

      // Check for suspension — execution paused waiting for async callback
      if (result.action?.type === 'suspend') {
        execution.status = 'suspended';
        execution.suspensionId = result.action.suspensionId as string;
        execution.suspensionReason = result.action.reason as SuspensionReason;
        // Do NOT set completedAt — execution is still alive
        // Do NOT resolve the deferred — it will be resolved on resume

        options.onTraceEvent?.({
          type: 'execution_suspended',
          data: {
            executionId: execution.executionId,
            sessionId,
            suspensionId: execution.suspensionId,
            reason: execution.suspensionReason,
          },
        });

        // Store deferred for later resolution by ResumptionService
        this.suspendedDeferreds.set(execution.suspensionId!, {
          deferred,
          execution,
          entry,
        });

        // Auto-evict after TTL (use suspension reason's timeout or default)
        const ttlMs =
          (result.action.reason as { timeout?: number } | undefined)?.timeout ||
          ExecutionCoordinator.SUSPENSION_TTL_MS;
        const suspId = execution.suspensionId!;
        const timer = setTimeout(() => {
          const suspended = this.suspendedDeferreds.get(suspId);
          if (suspended) {
            suspended.entry.detachAbortListener?.();
            suspended.execution.status = 'cancelled';
            suspended.execution.completedAt = Date.now();
            suspended.deferred.resolve(suspended.execution);
            this.suspendedDeferreds.delete(suspId);
            this.inflight.delete(suspended.execution.executionId);
          }
          this.suspensionTimers.delete(suspId);
        }, ttlMs);
        this.suspensionTimers.set(suspId, timer);

        // Send intermediate response to caller
        options.onChunk?.(result.response || 'Your request is being processed.');
        return; // Don't clean up inflight — stays until resume
      }

      this.finalizeExecution(execution, entry, result);
      this.emitTerminalTraceEvent(execution, options);
      deferred.resolve(execution);
    } catch (err) {
      execution.completedAt = Date.now();
      execution.durationMs = execution.completedAt - (execution.startedAt ?? execution.queuedAt);

      if (abortController.signal.aborted) {
        execution.status = entry.abortReason === 'preempt' ? 'preempted' : 'cancelled';
      } else {
        execution.status = 'failed';
        if (err instanceof AppError) {
          execution.error = { code: err.code, message: err.message };
        } else {
          execution.error = {
            code: 'EXECUTION_FAILED',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
      this.emitTerminalTraceEvent(execution, options);
      deferred.resolve(execution);
    } finally {
      // Skip cleanup if execution is suspended — it stays alive until resume
      if (execution.status === 'suspended') return;

      // Decrement parallel execution count
      const count = this.parallelCounts.get(sessionId) ?? 0;
      if (count > 1) {
        this.parallelCounts.set(sessionId, count - 1);
      } else {
        this.parallelCounts.delete(sessionId);
      }

      // Record duration sample for estimatedWaitMs (per-session)
      if (execution.durationMs) {
        const samples = this.durationSamples.get(sessionId) ?? [];
        samples.push(execution.durationMs);
        if (samples.length > MAX_DURATION_SAMPLES) {
          samples.shift();
        }
        this.durationSamples.set(sessionId, samples);
      }

      // Move to recent results for dedup lookups, then clean up inflight
      const completed = this.inflight.get(execution.executionId);
      if (completed) {
        completed.detachAbortListener?.();
        this.recentResults.set(execution.executionId, completed.deferred.promise);
        // Schedule cleanup after dedup window
        const execId = execution.executionId;
        setTimeout(() => this.recentResults.delete(execId), RECENT_RESULTS_TTL_MS);
      }
      this.inflight.delete(execution.executionId);
      await this.queue.clearActive(sessionId);
    }
  }

  private finalizeExecution(
    execution: Execution,
    entry: InflightEntry,
    result: ExecutionResult,
  ): void {
    execution.completedAt = Date.now();
    execution.durationMs = execution.completedAt - (execution.startedAt ?? execution.queuedAt);

    if (entry.abortController.signal.aborted) {
      execution.status = entry.abortReason === 'preempt' ? 'preempted' : 'cancelled';
    } else {
      execution.status = 'completed';
      execution.response = result.response;
      const anyResult = result as unknown as Record<string, unknown>;
      if (anyResult.tokenUsage && typeof anyResult.tokenUsage === 'object') {
        execution.tokenUsage = anyResult.tokenUsage as Execution['tokenUsage'];
      }

      // Stash the full ExecutionResult so callers can access voiceConfig,
      // richContent, actions, stateUpdates, action type, etc.
      execution.resultData = result as unknown as Record<string, unknown>;
    }
  }

  // ---------------------------------------------------------------------------
  // TRACE EVENT HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Emit the terminal trace event based on execution status.
   * Called after finalizeExecution (success path) or after status assignment (error path).
   */
  private emitTerminalTraceEvent(execution: Execution, options: SubmitOptions): void {
    if (!options.onTraceEvent) return;

    const baseData = {
      executionId: execution.executionId,
      sessionId: execution.sessionId,
      agentName: execution.agentName,
    };

    switch (execution.status) {
      case 'completed':
        options.onTraceEvent({
          type: 'execution.completed',
          data: {
            ...baseData,
            status: execution.status,
            durationMs: execution.durationMs,
            tokenUsage: execution.tokenUsage,
          },
        });
        break;

      case 'failed':
        options.onTraceEvent({
          type: 'execution.failed',
          data: {
            ...baseData,
            durationMs: execution.durationMs,
            error: execution.error,
          },
        });
        break;

      case 'cancelled':
      case 'preempted':
        options.onTraceEvent({
          type: 'execution.cancelled',
          data: {
            ...baseData,
            durationMs: execution.durationMs,
            reason: execution.status === 'preempted' ? 'preempted' : 'cancelled',
          },
        });
        break;

      case 'suspended':
        options.onTraceEvent({
          type: 'execution_suspended',
          data: {
            ...baseData,
            durationMs: execution.durationMs,
            suspensionId: execution.suspensionId,
          },
        });
        break;

      default:
        // No trace event for other statuses (e.g. 'queued', 'running' — handled separately)
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // SUSPENSION RESOLUTION
  // ---------------------------------------------------------------------------

  /**
   * Called by ResumptionService when a suspended execution completes.
   * Finalizes the execution and resolves the original deferred promise.
   */
  resolveSuspended(suspensionId: string, result: ExecutionResult): void {
    const suspended = this.suspendedDeferreds.get(suspensionId);
    if (!suspended) {
      log.warn('resolveSuspended called for unknown suspensionId', { suspensionId });
      return;
    }

    const { deferred, execution, entry } = suspended;
    this.finalizeExecution(execution, entry, result);
    this.emitTerminalTraceEvent(execution, entry.options);
    deferred.resolve(execution);

    // Clean up
    entry.detachAbortListener?.();
    this.suspendedDeferreds.delete(suspensionId);
    this.inflight.delete(execution.executionId);
    const timer = this.suspensionTimers.get(suspensionId);
    if (timer) {
      clearTimeout(timer);
      this.suspensionTimers.delete(suspensionId);
    }
    this.queue.clearActive(execution.sessionId).catch((err) => {
      log.error('Failed to clear active execution from queue', {
        sessionId: execution.sessionId,
        executionId: execution.executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  /** Estimate wait time based on rolling average of recent execution durations for a session */
  private getEstimatedWaitMs(sessionId: string, queueLength: number): number {
    const samples = this.durationSamples.get(sessionId);
    if (!samples || samples.length === 0) return 0;
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    return Math.round(avg * queueLength);
  }

  /** Clean up per-session state when a session is no longer active */
  cleanupSession(sessionId: string): void {
    this.durationSamples.delete(sessionId);
    this.parallelCounts.delete(sessionId);
    this.submitChains.delete(sessionId);

    // Cancel any suspended executions for this session
    for (const [suspensionId, suspended] of this.suspendedDeferreds) {
      if (suspended.execution.sessionId === sessionId) {
        suspended.entry.detachAbortListener?.();
        suspended.execution.status = 'cancelled';
        suspended.execution.completedAt = Date.now();
        suspended.deferred.resolve(suspended.execution);
        this.suspendedDeferreds.delete(suspensionId);
        this.inflight.delete(suspended.execution.executionId);
        const timer = this.suspensionTimers.get(suspensionId);
        if (timer) {
          clearTimeout(timer);
          this.suspensionTimers.delete(suspensionId);
        }
      }
    }
  }

  private resolveStrategy(agentIR: { execution: { concurrency?: string } }): ConcurrencyStrategy {
    const value = agentIR?.execution?.concurrency;
    if (value === 'preemptive' || value === 'parallel') return value;
    return 'serial';
  }
}
