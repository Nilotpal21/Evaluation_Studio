/**
 * TurnEngine — the v2 orchestration loop.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §5.3
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 4.5
 *
 * One round-trip per LLM stream. Ends when:
 *   - LLM emits an interactive tool → commit, yield interactive_tool, return
 *   - LLM stops emitting tool calls → commit, yield turn_ended (natural)
 *   - User aborts via AbortSignal → commit partial, yield turn_ended (interrupted)
 *   - Hard-limit breach → commit partial, yield turn_ended with specific reason
 *   - ModelProviderError beyond retry → commit partial, yield turn_ended + error
 *
 * Explicitly NOT handled here (delegated elsewhere):
 *   - LLM provider wrapping — consumers pass an LLMStreamClient (DI)
 *   - Session persistence / lock — TurnBuffer handles commit; engine only
 *     dispatches
 *   - Per-agent BUILD fan-out — BuildRunner (separate module, future commit)
 *
 * The engine emits TurnEvents as an AsyncIterable so callers (the Next.js
 * route handler in Phase 5) can forward them directly to an SSE stream AND
 * publish each to the Redis fan-out channel.
 */

import { uuidv7 } from '@agent-platform/database/mongo';

import type { RedisClient } from '@agent-platform/redis';
import { createLogger } from '@agent-platform/shared-observability';
import type { SpanError, SpanStatus, TraceEmitter, TraceStatus } from './trace/index.js';
import {
  ARCH_GATE_NAME,
  ARCH_PHASE_FROM,
  ARCH_PHASE_REASON,
  ARCH_PHASE_TO,
  ARCH_TOOL_INTERACTIVE,
  ARCH_TURN_END_REASON,
  COST_USD,
  ERROR_TYPE,
  EVENT_BUDGET_EXHAUSTED,
  EVENT_CANCEL_REQUESTED,
  EVENT_PAUSE,
  EVENT_RETRY,
  EVENT_ROUTING_DECISION,
  EVENT_TIMEOUT,
  EVENT_WARNING,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_TYPE,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  SPAN_KIND_GATE_CHECK,
  SPAN_KIND_LLM_CALL,
  SPAN_KIND_PHASE_TRANSITION,
  SPAN_KIND_TOOL_CALL,
  SPAN_KIND_TURN,
} from './trace/index.js';

import { ARCH_AI_TURN } from './hard-limits.js';
import { classifyModelError } from './error-classifier.js';
import type { ModelProviderError, ToolExecutionError } from './error-classifier.js';
import { LoopDetector } from '../coordinator/loop-detection.js';
import type { RoutingDecision } from '../coordinator/content-router.js';
import type { LLMStreamClient, LLMMessage, LLMStreamChunk } from './llm-client.js';
import { TurnTraceRecorder } from './trace-recorder.js';
import { TurnBuffer } from './turn-buffer.js';
import { ToolInvoker } from './tool-invoker.js';
import { createOutbox } from './outbox.js';
import type { OutboxHandle } from './outbox.js';
import type { TurnContext, ProjectWrite } from './turn-context.js';
import type { ToolRegistry } from '../tools/v2/registry.js';
import type { ArtifactUpdate, TurnEndReason, TurnEvent } from '../types/turn-events.js';
import type { StoredToolCall } from '../types/session.js';
import { isClientSideTool } from '../types/tools.js';

const log = createLogger('arch-ai:engine');

function planLifecycleEventType(
  update: ArtifactUpdate,
):
  | 'plan_proposed'
  | 'plan_approved'
  | 'plan_refining'
  | 'plan_cancelled'
  | 'plan_invalidated'
  | null {
  if (update.artifact !== 'plan') {
    return null;
  }
  switch (update.status) {
    case 'proposed':
      return 'plan_proposed';
    case 'approved':
      return 'plan_approved';
    case 'refining':
      return 'plan_refining';
    case 'cancelled':
      return 'plan_cancelled';
    case 'invalidated':
      return 'plan_invalidated';
    default:
      return null;
  }
}

function serializeToolRoundTripContent(value: unknown): string {
  if (typeof value === 'undefined') {
    return 'null';
  }

  const serialized = JSON.stringify(value);
  return typeof serialized === 'string' ? serialized : 'null';
}

const MAX_PERSISTED_TOOL_INPUT_CHARS = 1_500;
const MAX_PERSISTED_TOOL_RESULT_CHARS = 700;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function summarizeUnknownValue(value: unknown, maxChars: number): string {
  if (value == null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return truncateText(value, maxChars);
  }

  try {
    return truncateText(JSON.stringify(value), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function toPersistedToolInput(toolName: string, args: unknown): Record<string, unknown> {
  if (
    isClientSideTool(toolName) &&
    typeof args === 'object' &&
    args !== null &&
    !Array.isArray(args)
  ) {
    return args as Record<string, unknown>;
  }

  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    const serialized = summarizeUnknownValue(args, MAX_PERSISTED_TOOL_INPUT_CHARS);
    return serialized.length < MAX_PERSISTED_TOOL_INPUT_CHARS
      ? (args as Record<string, unknown>)
      : { summary: serialized, truncated: true };
  }

  return { value: summarizeUnknownValue(args, MAX_PERSISTED_TOOL_INPUT_CHARS) };
}

function toPersistedToolResult(toolName: string, value: unknown): unknown {
  if (isClientSideTool(toolName)) {
    return value;
  }

  const summary = summarizeUnknownValue(value, MAX_PERSISTED_TOOL_RESULT_CHARS);
  const expandedSummary = summarizeUnknownValue(value, MAX_PERSISTED_TOOL_RESULT_CHARS + 1);

  return {
    summary,
    truncated: summary !== expandedSummary,
  };
}

// ─── Public types ────────────────────────────────────────────────────────

export interface TurnEngineDeps {
  llmClient: LLMStreamClient;
  toolRegistry: ToolRegistry;
  traceEmitter?: TraceEmitter;
  /**
   * Durable publish — event enters the post-commit ring buffer AND is
   * broadcast to SSE subscribers. Called only AFTER TurnBuffer.commit()
   * succeeds (via the per-turn outbox).
   */
  publishDurable?: (event: TurnEvent) => Promise<void>;
  /**
   * Live publish — event is broadcast to current SSE subscribers only;
   * NOT stored in the ring buffer, NOT replayed on reconnect. Used for
   * turn_started, text_delta, status, error, and turn_failed.
   */
  publishLive?: (event: TurnEvent) => Promise<void>;
  /**
   * @deprecated Legacy single publisher. During coexistence, if this is
   * set and publishDurable/publishLive are not, all events go through
   * this. New callers MUST provide the split pair. Remove in Phase 9.
   */
  publish?: (event: TurnEvent) => Promise<void>;
  /** Redis client for lock-fencing + abort-intent reads. Optional for unit tests. */
  redis?: RedisClient;
  /**
   * Out-of-band cancel check. Called between tool-call iterations.
   * Returns true if the user requested cancellation via the REST endpoint.
   * Optional — if not provided, cancel checks are skipped (backward compat).
   */
  cancelRequestedRead?: (sessionId: string) => Promise<boolean>;
  /**
   * Clears the cancel flag after the engine has acted on it.
   * Called after emitting turn_canceled so the next turn starts clean.
   */
  cancelRequestedClear?: (sessionId: string) => Promise<void>;
  /**
   * M4: Generate follow-up suggestions after a natural turn end.
   * Production wiring injects the Studio-side suggestion generator.
   * If omitted, buffer.suggestions stays empty.
   */
  generateSuggestions?: (session: {
    phase: string;
    mode: string;
    projectId?: string;
  }) => Promise<string[]>;
  /** Deterministic clock / ULID override for tests. */
  now?: () => number;
  newId?: () => string;
}

export interface RunTurnInput {
  sessionId: string;
  tenantId: string;
  userId: string;
  turnId?: string;
  phase: string;
  mode: 'onboarding' | 'in-project';
  projectId?: string;
  /** ULID chosen by the client for optimistic append reconciliation. */
  clientMessageId?: string;
  /** Full current message history (engine appends the new user turn). */
  history: LLMMessage[];
  /** System prompt composed by the caller. */
  systemPrompt: string;
  /** User-entered text for this turn. */
  userInput: string;
  /**
   * Optional LLM-ready content for the current user turn. When provided, the
   * engine uses this for the appended user message in the live LLM request
   * while keeping `userInput` as the plain-text fallback/routing string.
   */
  userInputContent?: LLMMessage['content'];
  /**
   * I2: Rich content blocks for user message persistence (text + file refs).
   * When provided, the buffer stores this instead of plain `userInput`.
   */
  userContent?: import('../types/content-blocks.js').ArchContentBlock[];
  /** Phase-scoped registry subset for this turn (filter of the global registry). */
  allowedTools: ToolRegistry;
  /** Buffer for this turn's writes. */
  buffer: TurnBuffer;
  /** Worker-level abort (SIGTERM drain, interrupt, etc.). */
  signal: AbortSignal;
  /** Optional provider/tool-routing hints for dedicated substage turns. */
  llmOptions?: Record<string, unknown>;
  /** Specialist label to emit on turn_started / text_delta (onboarding phase / 'Arch AI' in-project). */
  specialist?: string;
  /**
   * Routing decision carried over from `resolveTurnPlan`. Optional — when
   * present, the engine emits a `routing_decision` span event on the turn
   * span so traces capture which regex (or pageContext bias) chose the
   * specialist. Tests and lightweight callers may omit this; the engine
   * silently skips emission when undefined.
   */
  routing?: RoutingDecision;
  /** Session-level budgets (accumulated from prior turns) — engine enforces. */
  priorSessionUsd?: number;
  priorTurnCount?: number;
  /**
   * Opaque service bag injected by the route handler into the TurnContext.
   * Contains Mongoose models, service singletons, and other dependencies
   * that internal tools need. The engine passes this through to ctx.services.
   */
  services?: Record<string, unknown>;
  /**
   * When true, skip persisting the user message via buffer.appendMessage.
   * Used for tool_answer turns where the user's answer is already recorded
   * as toolCall.result on the prior assistant message. The user turn is
   * still added to runningMessages for the live LLM call — only the
   * durable StoredMessage append is suppressed.
   */
  suppressUserMessage?: boolean;
  onToolCall?(info: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    result: unknown;
    ok: boolean;
    durationMs: number;
  }): void;
}

// ─── Implementation ──────────────────────────────────────────────────────

export class TurnEngine {
  constructor(private readonly deps: TurnEngineDeps) {}

  async *runTurn(input: RunTurnInput): AsyncIterable<TurnEvent> {
    const engineDeps = this.deps;
    const { llmClient, now, newId } = engineDeps;
    const clock = now ?? (() => Date.now());
    const idGen = newId ?? (() => uuidv7());

    const turnId = input.turnId ?? `turn_${idGen()}`;
    const startedAt = clock();
    let seq = 0;

    // ─── Helper: envelope builder ──────────────────────────────────────
    const emit = (body: Record<string, unknown>): TurnEvent => {
      return {
        eventId: idGen(),
        schemaVersion: 2,
        sessionId: input.sessionId,
        turnId,
        seq: seq++,
        timestamp: clock(),
        ...body,
      } as unknown as TurnEvent;
    };

    const getCommittedPhase = (): string => {
      const patchedPhase = input.buffer.sessionPatchSnapshot['metadata.phase'];
      return typeof patchedPhase === 'string' ? patchedPhase : input.phase;
    };

    const getCommittedProjectId = (): string | undefined => {
      const patchedProjectId = input.buffer.sessionPatchSnapshot['metadata.projectId'];
      return typeof patchedProjectId === 'string' ? patchedProjectId : input.projectId;
    };

    const trace = new TurnTraceRecorder({
      traceEmitter: engineDeps.traceEmitter,
      traceId: turnId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      tenantId: input.tenantId,
      userId: input.userId,
      phase: input.phase,
      mode: input.mode,
      specialist: input.specialist,
      now: clock,
      newId: idGen,
    });
    trace.startTrace();
    const turnSpanId = trace.startSpan({
      spanId: trace.createSpanId('turn'),
      spanKind: SPAN_KIND_TURN,
      name: `Turn (${input.phase})`,
    });

    // ─── routing_decision span event (Spec 1 Phase 4.2(d)) ─────────────
    // Emitted as a point-in-time span event on the turn span so traces
    // record WHICH regex (and any pageContext bias) selected the specialist.
    // `userInputSnippet` is intentionally omitted — emitting raw user text on
    // the trace surface would create cross-tenant PII risk.
    if (input.routing) {
      trace.event({
        spanId: turnSpanId,
        name: EVENT_ROUTING_DECISION,
        attributes: {
          specialist: input.routing.specialist,
          matchedPattern: input.routing.matchedPattern,
          pageContextBias: input.routing.pageContextBias ?? null,
        },
      });
    }

    // ─── Publish routing ───────────────────────────────────────────────
    // Prefer the new split pair; fall back to legacy `publish` for
    // backward compatibility.
    const hasSplitPublish =
      typeof this.deps.publishDurable === 'function' || typeof this.deps.publishLive === 'function';
    const legacyPublish = this.deps.publish;

    // Guard against asymmetric wiring: setting only one of the split pair
    // silently drops the opposite class of events (e.g., only publishLive set
    // → durable events resolve to undefined and are dropped inside publishDurable).
    // This is a configuration bug in the caller. Warn loudly — production
    // wiring must always pair them via engine-factory.
    if (hasSplitPublish) {
      const missingDurable = typeof this.deps.publishDurable !== 'function';
      const missingLive = typeof this.deps.publishLive !== 'function';
      if (missingDurable || missingLive) {
        log.warn('asymmetric split-publish config — pair publishDurable and publishLive together', {
          sessionId: input.sessionId,
          turnId,
          missingDurable,
          missingLive,
        });
      }
    }

    const publishLive = async (event: TurnEvent): Promise<void> => {
      const fn = hasSplitPublish ? this.deps.publishLive : legacyPublish;
      if (!fn) return;
      try {
        await fn(event);
      } catch (err) {
        log.warn('live publish failed (non-fatal)', {
          sessionId: input.sessionId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const publishDurable = async (event: TurnEvent): Promise<void> => {
      const fn = hasSplitPublish ? this.deps.publishDurable : legacyPublish;
      if (!fn) return;
      try {
        await fn(event);
      } catch (err) {
        log.warn('durable publish failed (non-fatal)', {
          sessionId: input.sessionId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // ─── Per-turn outbox ───────────────────────────────────────────────
    // The outbox holds pre-built TurnEvent envelopes. On flush, each is
    // published via publishDurable. The engine assigns seq via emit()
    // BEFORE enqueueing — the outbox's own seq is unused (we pass -1).
    // We also track all enqueued events so they can be yielded to callers.
    const outboxEvents: TurnEvent[] = [];
    const outbox: OutboxHandle = createOutbox({
      sessionId: input.sessionId,
      turnId,
      publisher: async (envelope) => {
        // Extract the pre-built TurnEvent from the outbox envelope's payload.
        await publishDurable(envelope.payload as TurnEvent);
      },
    });

    /** Enqueue a pre-built TurnEvent into the outbox and track it for yielding. */
    const outboxEnqueue = (event: TurnEvent): void => {
      outboxEvents.push(event);
      outbox.enqueue({ kind: event.type, payload: event });
    };

    /**
     * commitAndFlushOrFail — replaces safeCommit.
     *
     * 1. Commits the TurnBuffer (atomically persists state).
     * 2. On success: enqueues final events (turn_committed, etc.) and flushes
     *    the outbox — all durable events published in order via publishDurable.
     * 3. On failure: discards outbox + rolls back buffer, publishes an error
     *    event via publishLive, and RETHROWS so callers see the failure.
     *
     * Returns all events that were flushed (artifacts + post-commit) so the
     * caller can yield them from the AsyncIterable.
     */
    const commitAndFlushOrFail = async (postCommitEvents: TurnEvent[]): Promise<TurnEvent[]> => {
      try {
        await input.buffer.commit();
      } catch (err) {
        outbox.discard();
        if (!input.buffer.rolledBack && !input.buffer.committed) {
          input.buffer.rollback();
        }
        if (err instanceof Error) {
          (err as Error & { __archCommitFailure?: boolean }).__archCommitFailure = true;
        }
        const errEvent = emit({
          type: 'error',
          error: {
            code: 'COMMIT_FAILED',
            message: 'Turn commit failed — changes were not persisted.',
            retryable: false,
          },
        });
        await publishLive(errEvent);
        log.error('turn commit failed — outbox discarded', {
          sessionId: input.sessionId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // Commit succeeded — enqueue post-commit events and flush everything.
      for (const ev of postCommitEvents) {
        outboxEnqueue(ev);
      }

      // Snapshot the full set of events (artifacts + post-commit) before flush.
      const allFlushed = [...outboxEvents];
      outboxEvents.length = 0;

      await outbox.flush();
      return allFlushed;
    };

    let toolCallsThisTurn = 0;
    let accumulatedUsd = 0;
    let accumulatedTokens = 0;
    let accumulatedInputTokens = 0;
    let accumulatedOutputTokens = 0;
    let lastUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    let lastModel = 'unknown';
    let lastProvider = 'unknown';
    let lastRequestedModel = 'unknown';
    let lastResponseId: string | undefined;
    let finishReason = '';
    let traceClosed = false;
    let activeLlmSpanId: string | undefined;
    let llmCallCount = 0;
    let emptyAssistantResponseRetries = 0;

    const buildTraceSummaryAttributes = (reason?: string): Record<string, unknown> => {
      const attributes: Record<string, unknown> = {};
      if (reason) {
        attributes[ARCH_TURN_END_REASON] = reason;
      }
      if (accumulatedInputTokens > 0) {
        attributes[GEN_AI_USAGE_INPUT_TOKENS] = accumulatedInputTokens;
      }
      if (accumulatedOutputTokens > 0) {
        attributes[GEN_AI_USAGE_OUTPUT_TOKENS] = accumulatedOutputTokens;
      }
      if (accumulatedUsd > 0) {
        attributes[COST_USD] = accumulatedUsd;
      }
      if (lastProvider !== 'unknown') {
        attributes[GEN_AI_PROVIDER_NAME] = lastProvider;
      }
      if (lastRequestedModel !== 'unknown') {
        attributes[GEN_AI_REQUEST_MODEL] = lastRequestedModel;
      }
      if (lastModel !== 'unknown') {
        attributes[GEN_AI_RESPONSE_MODEL] = lastModel;
      }
      if (finishReason) {
        attributes[GEN_AI_RESPONSE_FINISH_REASONS] = [finishReason];
      }
      if (lastResponseId) {
        attributes[GEN_AI_RESPONSE_ID] = lastResponseId;
      }
      return attributes;
    };

    const emitPhaseTransitionTrace = (
      fromPhase: string,
      toPhase: string,
      reason = 'llm_driven',
    ): void => {
      if (fromPhase === toPhase) {
        return;
      }

      const phaseSpanId = trace.startSpan({
        spanKind: SPAN_KIND_PHASE_TRANSITION,
        parentSpanId: turnSpanId,
        name: `${fromPhase} -> ${toPhase}`,
        phase: toPhase,
        projectId: getCommittedProjectId(),
        attributes: {
          [ARCH_PHASE_FROM]: fromPhase,
          [ARCH_PHASE_TO]: toPhase,
          [ARCH_PHASE_REASON]: reason,
        },
      });
      trace.endSpan({
        spanId: phaseSpanId,
        status: 'ok',
        phase: toPhase,
        projectId: getCommittedProjectId(),
      });
    };

    const emitGateCheckTrace = (toolName: string): void => {
      if (!toolName.startsWith('gate_')) {
        return;
      }

      const gateSpanId = trace.startSpan({
        spanKind: SPAN_KIND_GATE_CHECK,
        parentSpanId: turnSpanId,
        name: toolName,
        projectId: getCommittedProjectId(),
        attributes: {
          [ARCH_GATE_NAME]: toolName,
        },
      });
      trace.endSpan({
        spanId: gateSpanId,
        status: 'ok',
        projectId: getCommittedProjectId(),
      });
    };

    const endActiveLlmSpan = (params: {
      status: SpanStatus;
      error?: SpanError;
      attributes?: Record<string, unknown>;
    }): void => {
      if (!activeLlmSpanId) {
        return;
      }

      trace.endSpan({
        spanId: activeLlmSpanId,
        status: params.status,
        error: params.error,
        projectId: getCommittedProjectId(),
        attributes: params.attributes ?? {},
      });
      activeLlmSpanId = undefined;
    };

    const flushTraceEmitter = async (): Promise<void> => {
      if (!engineDeps.traceEmitter) {
        return;
      }

      try {
        await engineDeps.traceEmitter.flush();
      } catch (err) {
        log.warn('trace emitter flush failed (non-fatal)', {
          sessionId: input.sessionId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const closeTrace = async (params: {
      turnStatus: SpanStatus;
      traceStatus: TraceStatus;
      reason?: string;
      error?: SpanError;
      phase?: string;
      phaseTransitionReason?: string;
      extraTurnAttributes?: Record<string, unknown>;
      extraTraceAttributes?: Record<string, unknown>;
    }): Promise<void> => {
      if (traceClosed) {
        return;
      }

      const phase = params.phase ?? getCommittedPhase();
      const projectId = getCommittedProjectId();
      emitPhaseTransitionTrace(input.phase, phase, params.phaseTransitionReason);

      const summaryAttributes = buildTraceSummaryAttributes(params.reason);
      trace.endSpan({
        spanId: turnSpanId,
        status: params.turnStatus,
        error: params.error,
        phase,
        projectId,
        attributes: {
          ...summaryAttributes,
          ...(params.extraTurnAttributes ?? {}),
        },
      });
      trace.endTrace({
        status: params.traceStatus,
        phase,
        projectId,
        attributes: {
          ...summaryAttributes,
          ...(params.extraTraceAttributes ?? {}),
        },
      });

      traceClosed = true;
      await flushTraceEmitter();
    };

    // ─── Session-level hard limits (before touching LLM) ───────────────
    if ((input.priorTurnCount ?? 0) >= ARCH_AI_TURN.MAX_TURNS_PER_SESSION) {
      trace.event({
        spanId: turnSpanId,
        name: EVENT_BUDGET_EXHAUSTED,
        attributes: {
          'budget.kind': 'session_turns',
          [ARCH_TURN_END_REASON]: 'session_cost_exhausted',
        },
      });
      await closeTrace({
        turnStatus: 'error',
        traceStatus: 'error',
        reason: 'session_cost_exhausted',
      });
      const event = emit({ type: 'turn_ended', reason: 'session_cost_exhausted' as TurnEndReason });
      await publishLive(event);
      yield event;
      return;
    }
    if ((input.priorSessionUsd ?? 0) >= ARCH_AI_TURN.MAX_USD_PER_SESSION) {
      trace.event({
        spanId: turnSpanId,
        name: EVENT_BUDGET_EXHAUSTED,
        attributes: {
          'budget.kind': 'session_cost',
          [ARCH_TURN_END_REASON]: 'session_cost_exhausted',
        },
      });
      await closeTrace({
        turnStatus: 'error',
        traceStatus: 'error',
        reason: 'session_cost_exhausted',
      });
      const event = emit({ type: 'turn_ended', reason: 'session_cost_exhausted' });
      await publishLive(event);
      yield event;
      return;
    }

    // ─── turn_started ──────────────────────────────────────────────────
    const userMessageId = input.clientMessageId ?? idGen();
    const startedEvent = emit({
      type: 'turn_started',
      userMessageId,
      specialist: input.specialist,
    });
    await publishLive(startedEvent);
    yield startedEvent;

    // ── C1 + I2: persist the user message (with content blocks if attachments present)
    // suppressUserMessage: tool_answer turns record the answer on toolCall.result
    // instead of a standalone user message — skip the durable append to avoid
    // phantom bubbles while keeping the user turn in runningMessages for the LLM.
    if (!input.suppressUserMessage) {
      input.buffer.appendMessage('user', input.userContent ?? input.userInput, {
        phase: getCommittedPhase(),
        timestamp: new Date(clock()).toISOString(),
      });
    }

    // ── I10 + C4: bump lastActiveAt + transition to ACTIVE at turn start ──
    input.buffer.patchSession({
      state: 'ACTIVE',
      lastActiveAt: new Date(clock()),
      'metadata.pendingInteraction': null,
    });

    // Build turn context (stable reference for the whole turn).
    // Artifact updates are collected into the outbox as pre-built TurnEvent
    // envelopes — they will be published via publishDurable on flush.
    const turnArtifacts: ArtifactUpdate[] = [];
    const ctx: TurnContext = {
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      userId: input.userId,
      turnId,
      phase: input.phase,
      mode: input.mode,
      projectId: input.projectId,
      signal: input.signal,
      buffer: input.buffer,
      emit: (event: unknown) => {
        // Only ArtifactUpdate values are expected here; other callers are
        // using the generic MinimalTurnContext.emit. We collect into the
        // turnArtifacts array — they are enqueued into the outbox before
        // commit+flush at each commit site.
        turnArtifacts.push(event as ArtifactUpdate);
      },
      emitArtifact: (update) => {
        turnArtifacts.push(update);
      },
      emitStatus: (body) => {
        // Ephemeral — live SSE only, not stored in the ring buffer.
        const ev = emit({ type: 'status', ...body });
        // Fire-and-forget publishLive (non-blocking from the tool's perspective).
        publishLive(ev).catch((err) => {
          log.warn('emitStatus publishLive failed (non-fatal)', {
            sessionId: input.sessionId,
            turnId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      consumeFlowSecrets: () => undefined, // Wired up in Phase 5 edge route.
      services: input.services,
    };

    const invoker = new ToolInvoker({ ctx });

    // Append the user message to history for the LLM call.
    const runningMessages: LLMMessage[] = [
      ...input.history,
      { role: 'user', content: input.userInputContent ?? input.userInput },
    ];

    // ── I5: Loop detection ──────────────────────────────────────────────
    const loopDetector = new LoopDetector();

    // Assistant text accumulator for this turn's final stored message.
    let assistantText = '';
    let roundAssistantText = '';
    const persistedToolCalls: StoredToolCall[] = [];

    // Tool descriptors the LLM sees this turn.
    const toolDescriptors = input.allowedTools.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    // ─── Helper: enqueue pending artifacts into the outbox ─────────────
    const drainArtifactsToOutbox = (spanId = turnSpanId): void => {
      for (const a of turnArtifacts.splice(0)) {
        trace.event({
          spanId,
          name: 'artifact',
          projectId: getCommittedProjectId(),
          attributes: {
            update: a,
          },
        });
        const ev = emit({ type: 'artifact_updated', update: a });
        outboxEnqueue(ev);
        if (a.artifact === 'plan') {
          const planEventType = planLifecycleEventType(a);
          if (!planEventType) {
            continue;
          }
          outboxEnqueue(
            emit({
              type: planEventType,
              planId: a.planId,
              status: a.status,
              payload: a.payload,
            }),
          );
        }
      }
    };

    const appendAssistantMessageIfPresent = (additionalToolCalls: StoredToolCall[] = []): void => {
      const toolCalls = [...persistedToolCalls, ...additionalToolCalls];
      if (assistantText.length === 0 && toolCalls.length === 0) {
        return;
      }
      input.buffer.appendMessage('assistant', assistantText, {
        specialist: input.specialist,
        phase: getCommittedPhase(),
        timestamp: new Date(clock()).toISOString(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      assistantText = '';
    };

    const getAbortEndReason = (): TurnEndReason => {
      const reason = input.signal.reason;
      const message =
        reason instanceof Error ? reason.message : reason == null ? '' : String(reason);
      return message.includes('worker_lost') ? 'worker_lost' : 'interrupted';
    };

    const isToolCallFinishReason = (reason: string): boolean => {
      const normalized = reason
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
      return (
        normalized === 'tool_calls' ||
        normalized === 'tool_call' ||
        normalized === 'toolcalls' ||
        normalized === 'tool_use' ||
        normalized === 'tool_uses'
      );
    };

    const finalizeTurnEnd = async (params: {
      reason: TurnEndReason;
      completion?: Record<string, unknown>;
      suggestions?: Array<{ text: string }>;
      error?: { code: string; message: string; retryable?: boolean };
      extraSessionPatch?: Record<string, unknown>;
    }): Promise<TurnEvent[]> => {
      drainArtifactsToOutbox();
      appendAssistantMessageIfPresent();
      input.buffer.patchSession({
        state: 'IDLE',
        lastActiveAt: new Date(clock()),
        'metadata.pendingInteraction': null,
        ...(typeof input.specialist === 'string' && input.mode === 'in-project'
          ? { 'metadata.activeSpecialist': input.specialist }
          : {}),
        ...(params.extraSessionPatch ?? {}),
      });

      const committed = emit({ type: 'turn_committed', phase: getCommittedPhase() });
      const endedBody: Record<string, unknown> = {
        type: 'turn_ended',
        reason: params.reason,
      };
      if (params.completion) {
        endedBody.completion = params.completion;
      }
      if (params.suggestions) {
        endedBody.suggestions = params.suggestions;
      }
      if (params.error) {
        endedBody.error = params.error;
      }
      const ended = emit(endedBody);
      const terminalState = getTerminalTraceState(params.reason);

      try {
        const flushed = await commitAndFlushOrFail([committed, ended]);
        await closeTrace({
          turnStatus: terminalState.turnStatus,
          traceStatus: terminalState.traceStatus,
          reason: params.reason,
        });
        return flushed;
      } catch (err) {
        await closeTrace({
          turnStatus: 'error',
          traceStatus: 'error',
          reason: 'error',
          error: {
            code: 'COMMIT_FAILED',
            message: 'Turn commit failed — changes were not persisted.',
          },
        });
        throw err;
      }
    };

    // ─── Cancel check helper ──────────────────────────────────────────
    // Checks the out-of-band cancel flag (set by POST /sessions/:id/cancel).
    // On cancel: durably commit the partial turn, clear the cancel flag, and return.
    const checkCanceled = async function* (): AsyncGenerator<TurnEvent, boolean> {
      if (!engineDeps.cancelRequestedRead) return false;
      let isCanceled = false;
      try {
        isCanceled = await engineDeps.cancelRequestedRead(input.sessionId);
      } catch (err) {
        log.warn('cancelRequestedRead failed (non-fatal, continuing turn)', {
          sessionId: input.sessionId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      if (!isCanceled) return false;

      trace.event({
        spanId: turnSpanId,
        name: EVENT_CANCEL_REQUESTED,
        attributes: {
          [ARCH_TURN_END_REASON]: 'canceled',
        },
      });
      endActiveLlmSpan({
        status: 'canceled',
        attributes: {
          [ARCH_TURN_END_REASON]: 'canceled',
        },
      });

      const flushed = await finalizeTurnEnd({
        reason: 'canceled',
        extraSessionPatch: { cancelRequested: false },
      });
      for (const ev of flushed) {
        yield ev;
      }
      return true;
    };

    // ─── The loop ──────────────────────────────────────────────────────
    while (true) {
      if (input.signal.aborted) {
        const abortReason = getAbortEndReason();
        endActiveLlmSpan({
          status: getTerminalTraceState(abortReason).turnStatus,
          attributes: {
            [ARCH_TURN_END_REASON]: abortReason,
          },
        });
        const flushed = await finalizeTurnEnd({ reason: abortReason });
        for (const ev of flushed) yield ev;
        return;
      }

      // ─── Out-of-band cancel check (between LLM rounds) ─────────────
      {
        const cancelGen = checkCanceled();
        let next = await cancelGen.next();
        while (!next.done) {
          yield next.value;
          next = await cancelGen.next();
        }
        if (next.value === true) return;
      }

      if (clock() - startedAt >= ARCH_AI_TURN.TURN_SOFT_TIMEOUT_MS) {
        trace.event({
          spanId: turnSpanId,
          name: EVENT_TIMEOUT,
          attributes: {
            'timeout.limit_ms': ARCH_AI_TURN.TURN_SOFT_TIMEOUT_MS,
            [ARCH_TURN_END_REASON]: 'turn_soft_timeout',
          },
        });
        const flushed = await finalizeTurnEnd({ reason: 'turn_soft_timeout' });
        for (const ev of flushed) yield ev;
        return;
      }

      activeLlmSpanId = trace.startSpan({
        spanId: trace.createSpanId('llm'),
        spanKind: SPAN_KIND_LLM_CALL,
        parentSpanId: turnSpanId,
        name: `chat #${llmCallCount + 1}`,
        projectId: getCommittedProjectId(),
        attributes: {
          [GEN_AI_OPERATION_NAME]: 'chat',
        },
      });
      llmCallCount += 1;

      let stream: AsyncIterable<LLMStreamChunk>;
      try {
        stream = llmClient.stream({
          system: input.systemPrompt,
          messages: runningMessages,
          tools: toolDescriptors,
          signal: input.signal,
          options: input.llmOptions,
        });
      } catch (err) {
        log.error('LLM stream creation failed', {
          error: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
          status: (err as { status?: unknown })?.status,
          code: (err as { code?: unknown })?.code,
        });
        const classified = classifyModelError(err);
        endActiveLlmSpan({
          status: getTerminalTraceState(classified.reason).turnStatus,
          error: buildModelSpanError(classified),
          attributes: {
            [ERROR_TYPE]: classified.code,
          },
        });
        const errPayload = {
          code: classified.code,
          message: classified.message,
          retryable: classified.retry,
        };
        const errEv = emit({
          type: 'error',
          error: errPayload,
        });
        // Error events are live (not durable) — but commit + turn_ended are durable.
        // Include error info in turn_ended so clients that miss the live event still see it.
        const flushed = await finalizeTurnEnd({ reason: classified.reason, error: errPayload });
        await publishLive(errEv);
        yield errEv;
        for (const ev of flushed) yield ev;
        return;
      }

      let sawToolCall = false;
      let sawInteractiveToolCall = false;
      let streamInterrupted = false;
      const roundToolCalls: Array<{ id: string; name: string; args: unknown }> = [];
      const roundToolResults: Array<{ toolCallId: string; content: string }> = [];

      try {
        for await (const chunk of stream) {
          if (input.signal.aborted) {
            streamInterrupted = true;
            break;
          }

          if (chunk.type === 'text_delta') {
            assistantText += chunk.text;
            roundAssistantText += chunk.text;
            const ev = emit({
              type: 'text_delta',
              delta: chunk.text,
              specialist: input.specialist,
            });
            await publishLive(ev);
            yield ev;
            continue;
          }

          if (chunk.type === 'finish') {
            finishReason = chunk.finishReason;
            lastUsage = chunk.usage;
            lastModel = chunk.model;
            lastProvider = chunk.provider ?? lastProvider;
            lastRequestedModel = chunk.requestedModel ?? chunk.model ?? lastRequestedModel;
            lastResponseId = chunk.responseId ?? lastResponseId;
            accumulatedInputTokens += chunk.usage.inputTokens;
            accumulatedOutputTokens += chunk.usage.outputTokens;
            accumulatedTokens += chunk.usage.totalTokens;
            accumulatedUsd += chunk.estimatedUsd ?? 0;
            endActiveLlmSpan({
              status: 'ok',
              attributes: {
                ...(chunk.provider ? { [GEN_AI_PROVIDER_NAME]: chunk.provider } : {}),
                ...(chunk.requestedModel ? { [GEN_AI_REQUEST_MODEL]: chunk.requestedModel } : {}),
                [GEN_AI_RESPONSE_MODEL]: chunk.model,
                [GEN_AI_RESPONSE_FINISH_REASONS]: [chunk.finishReason],
                ...(chunk.responseId ? { [GEN_AI_RESPONSE_ID]: chunk.responseId } : {}),
                [GEN_AI_USAGE_INPUT_TOKENS]: chunk.usage.inputTokens,
                [GEN_AI_USAGE_OUTPUT_TOKENS]: chunk.usage.outputTokens,
                ...(typeof chunk.estimatedUsd === 'number'
                  ? { [COST_USD]: chunk.estimatedUsd }
                  : {}),
                ...(typeof chunk.latencyMs === 'number'
                  ? { 'llm.latency_ms': chunk.latencyMs }
                  : {}),
              },
            });
            continue;
          }

          // chunk.type === 'tool_call'
          sawToolCall = true;
          toolCallsThisTurn += 1;

          if (toolCallsThisTurn > ARCH_AI_TURN.MAX_TOOL_CALLS_PER_TURN) {
            trace.event({
              spanId: turnSpanId,
              name: EVENT_BUDGET_EXHAUSTED,
              attributes: {
                'budget.kind': 'tool_calls',
                [ARCH_TURN_END_REASON]: 'tool_limit_exceeded',
              },
            });
            endActiveLlmSpan({
              status: 'error',
              error: {
                code: 'TOOL_LIMIT_EXCEEDED',
                message: 'Turn exceeded the maximum number of tool calls.',
              },
              attributes: {
                [ARCH_TURN_END_REASON]: 'tool_limit_exceeded',
              },
            });
            const flushed = await finalizeTurnEnd({ reason: 'tool_limit_exceeded' });
            for (const ev of flushed) yield ev;
            return;
          }

          const tool = input.allowedTools.get(chunk.toolName);
          const toolSpanId = trace.startSpan({
            spanId: trace.createSpanId('tool'),
            spanKind: SPAN_KIND_TOOL_CALL,
            parentSpanId: activeLlmSpanId ?? turnSpanId,
            name: chunk.toolName,
            projectId: getCommittedProjectId(),
            attributes: {
              [GEN_AI_TOOL_NAME]: chunk.toolName,
              [GEN_AI_TOOL_CALL_ID]: chunk.toolCallId,
              [GEN_AI_TOOL_TYPE]: 'function',
              [ARCH_TOOL_INTERACTIVE]: Boolean(tool?.kind === 'interactive'),
              ...trace.payloadAttributes(GEN_AI_TOOL_CALL_ARGUMENTS, chunk.args),
            },
          });
          if (tool && tool.kind === 'interactive') {
            sawInteractiveToolCall = true;
            const interactiveToolCall: StoredToolCall = {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: toPersistedToolInput(chunk.toolName, chunk.args),
            };
            emitGateCheckTrace(chunk.toolName);
            // Drain pending artifacts into the outbox, then commit + pause.
            drainArtifactsToOutbox(toolSpanId);
            trace.endSpan({
              spanId: toolSpanId,
              status: 'ok',
              projectId: getCommittedProjectId(),
            });
            trace.event({
              spanId: turnSpanId,
              name: EVENT_PAUSE,
              projectId: getCommittedProjectId(),
              attributes: {
                'pause.reason': 'interactive_tool',
                tool: chunk.toolName,
                toolCallId: chunk.toolCallId,
                kind: chunk.toolName.startsWith('gate_') ? 'gate' : 'tool',
              },
            });
            endActiveLlmSpan({
              status: 'ok',
              attributes: {
                [GEN_AI_RESPONSE_FINISH_REASONS]: ['tool_calls'],
              },
            });
            appendAssistantMessageIfPresent([interactiveToolCall]);
            // Gate-free contract: interactive prompts keep the session ACTIVE and
            // persist the pending interaction for resume/discard recovery.
            input.buffer.patchSession({
              state: 'ACTIVE',
              lastActiveAt: new Date(clock()),
              ...(typeof input.specialist === 'string' && input.mode === 'in-project'
                ? { 'metadata.activeSpecialist': input.specialist }
                : {}),
              'metadata.pendingInteraction': {
                kind: chunk.toolName.startsWith('gate_') ? 'gate' : 'widget',
                id: chunk.toolCallId,
                payload: chunk.args,
                createdAt: new Date(clock()).toISOString(),
              },
            });
            const c = emit({ type: 'turn_committed', phase: getCommittedPhase() });
            const it = emit({
              type: 'interactive_tool',
              tool: chunk.toolName,
              toolCallId: chunk.toolCallId,
              kind: chunk.toolName.startsWith('gate_') ? 'gate' : 'tool',
              payload: chunk.args,
            });
            let flushed: TurnEvent[];
            try {
              flushed = await commitAndFlushOrFail([c, it]);
              await closeTrace({
                turnStatus: 'ok',
                traceStatus: 'paused',
                reason: 'interactive_pause',
                extraTurnAttributes: {
                  'pause.reason': 'interactive_tool',
                  tool: chunk.toolName,
                  toolCallId: chunk.toolCallId,
                },
                extraTraceAttributes: {
                  'pause.reason': 'interactive_tool',
                  tool: chunk.toolName,
                  toolCallId: chunk.toolCallId,
                },
              });
            } catch (err) {
              await closeTrace({
                turnStatus: 'error',
                traceStatus: 'error',
                reason: 'error',
                error: {
                  code: 'COMMIT_FAILED',
                  message: 'Turn commit failed — changes were not persisted.',
                },
              });
              throw err;
            }
            for (const ev of flushed) yield ev;
            return;
          }

          // Internal (or unknown) tool → invoke + feed back to the LLM
          // as a tool-result synthetic message for self-correction.
          const toolSpanStartMs = clock();
          const invokeResult = await invoker.invoke(tool, {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            rawArgs: chunk.args,
          });

          // Collect any pending artifact emits from the tool's execute()
          // into the outbox — they will be published on commit+flush.
          drainArtifactsToOutbox(toolSpanId);

          if (invokeResult.ok) {
            trace.endSpan({
              spanId: toolSpanId,
              status: 'ok',
              projectId: getCommittedProjectId(),
              attributes: {
                ...trace.payloadAttributes(GEN_AI_TOOL_CALL_RESULT, invokeResult.value),
              },
            });
          } else {
            const attempt = invoker.getSignatureCount(chunk.toolName, chunk.args);
            trace.event({
              spanId: toolSpanId,
              name: EVENT_RETRY,
              projectId: getCommittedProjectId(),
              attributes: {
                'retry.attempt': attempt,
                'retry.reason': invokeResult.error.code,
              },
            });
            trace.endSpan({
              spanId: toolSpanId,
              status: getToolSpanStatus(invokeResult.error.code),
              error: buildToolSpanError(invokeResult.error),
              projectId: getCommittedProjectId(),
              attributes: {
                [ERROR_TYPE]: invokeResult.error.code,
                ...trace.payloadAttributes(GEN_AI_TOOL_CALL_RESULT, invokeResult.error),
              },
            });
          }

          if (input.onToolCall) {
            input.onToolCall({
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.args,
              result: invokeResult.ok ? invokeResult.value : invokeResult.error,
              ok: invokeResult.ok,
              durationMs: clock() - toolSpanStartMs,
            });
          }

          if (tool?.statusLabel) {
            const ev = emit({ type: 'status', label: tool.statusLabel });
            await publishLive(ev);
            yield ev;
          }

          roundToolCalls.push({
            id: chunk.toolCallId,
            name: chunk.toolName,
            args: chunk.args,
          });
          persistedToolCalls.push({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: toPersistedToolInput(chunk.toolName, chunk.args),
            result: toPersistedToolResult(
              chunk.toolName,
              invokeResult.ok ? invokeResult.value : invokeResult.error,
            ),
          });
          roundToolResults.push({
            toolCallId: chunk.toolCallId,
            content: serializeToolRoundTripContent(
              invokeResult.ok ? invokeResult.value : invokeResult.error,
            ),
          });

          // ─── I5: Semantic loop detection (between tool calls) ──────
          {
            const toolArgs = (chunk.args ?? {}) as Record<string, unknown>;
            if (loopDetector.check(input.specialist ?? 'default', chunk.toolName, toolArgs)) {
              log.warn('loop detected — breaking turn', {
                sessionId: input.sessionId,
                turnId,
                toolName: chunk.toolName,
                toolCallsThisTurn,
              });
              trace.event({
                spanId: turnSpanId,
                name: EVENT_WARNING,
                projectId: getCommittedProjectId(),
                attributes: {
                  code: 'LOOP_DETECTED',
                  tool: chunk.toolName,
                },
              });
              endActiveLlmSpan({
                status: 'error',
                error: {
                  code: 'LOOP_DETECTED',
                  message: 'Semantic tool loop detected.',
                },
                attributes: {
                  [ERROR_TYPE]: 'LOOP_DETECTED',
                },
              });
              const flushed = await finalizeTurnEnd({ reason: 'loop_detected' });
              for (const ev of flushed) yield ev;
              return;
            }
          }

          // ─── Out-of-band cancel check (between tool calls) ─────────
          {
            const cancelGen = checkCanceled();
            let next = await cancelGen.next();
            while (!next.done) {
              yield next.value;
              next = await cancelGen.next();
            }
            if (next.value === true) return;
          }
        }
      } catch (err) {
        if ((err as { __archCommitFailure?: boolean } | null)?.__archCommitFailure === true) {
          throw err;
        }
        if (input.signal.aborted) {
          const abortReason = getAbortEndReason();
          endActiveLlmSpan({
            status: getTerminalTraceState(abortReason).turnStatus,
            attributes: {
              [ARCH_TURN_END_REASON]: abortReason,
            },
          });
          const flushed = await finalizeTurnEnd({ reason: abortReason });
          for (const ev of flushed) yield ev;
          return;
        }
        log.error('LLM stream iteration failed', {
          error: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
          status: (err as { status?: unknown })?.status,
          code: (err as { code?: unknown })?.code,
        });
        const classified = classifyModelError(err);
        endActiveLlmSpan({
          status: getTerminalTraceState(classified.reason).turnStatus,
          error: buildModelSpanError(classified),
          attributes: {
            [ERROR_TYPE]: classified.code,
          },
        });
        const errPayload2 = {
          code: classified.code,
          message: classified.message,
          retryable: classified.retry,
        };
        const errEv = emit({
          type: 'error',
          error: errPayload2,
        });
        const flushed = await finalizeTurnEnd({ reason: classified.reason, error: errPayload2 });
        await publishLive(errEv);
        yield errEv;
        for (const ev of flushed) yield ev;
        return;
      }

      if (streamInterrupted || input.signal.aborted) {
        const abortReason = getAbortEndReason();
        endActiveLlmSpan({
          status: getTerminalTraceState(abortReason).turnStatus,
          attributes: {
            [ARCH_TURN_END_REASON]: abortReason,
          },
        });
        const flushed = await finalizeTurnEnd({ reason: abortReason });
        for (const ev of flushed) yield ev;
        return;
      }

      if (sawInteractiveToolCall) return;

      if (
        toolCallsThisTurn === 0 &&
        !sawToolCall &&
        isToolCallFinishReason(finishReason) &&
        roundAssistantText.trim().length === 0
      ) {
        const errEv = emit({
          type: 'error',
          error: {
            code: 'MODEL_TOOL_PROTOCOL_ERROR',
            message:
              'Model ended the turn as a tool-call step, but no executable tool call was emitted.',
            retryable: true,
          },
        });
        trace.event({
          spanId: turnSpanId,
          name: EVENT_WARNING,
          projectId: getCommittedProjectId(),
          attributes: {
            code: 'MODEL_TOOL_PROTOCOL_ERROR',
          },
        });
        const flushed = await finalizeTurnEnd({ reason: 'model_provider_error' });
        await publishLive(errEv);
        yield errEv;
        for (const ev of flushed) yield ev;
        return;
      }

      if (!sawToolCall) {
        const hasVisibleArtifact = outboxEvents.some((event) => event.type === 'artifact_updated');
        if (assistantText.trim().length === 0 && !hasVisibleArtifact && toolCallsThisTurn === 0) {
          const errPayload = {
            code: 'EMPTY_ASSISTANT_RESPONSE',
            message:
              'The model ended without a user-visible answer. Please retry the Arch request.',
            retryable: true,
          };
          const errEv = emit({
            type: 'error',
            error: errPayload,
          });
          trace.event({
            spanId: turnSpanId,
            name: EVENT_WARNING,
            projectId: getCommittedProjectId(),
            attributes: {
              code: errPayload.code,
            },
          });
          const flushed = await finalizeTurnEnd({
            reason: 'model_provider_error',
            error: errPayload,
          });
          await publishLive(errEv);
          yield errEv;
          for (const ev of flushed) yield ev;
          return;
        }
        if (
          assistantText.trim().length === 0 &&
          !hasVisibleArtifact &&
          toolCallsThisTurn > 0 &&
          emptyAssistantResponseRetries < 1
        ) {
          emptyAssistantResponseRetries += 1;
          trace.event({
            spanId: turnSpanId,
            name: EVENT_RETRY,
            projectId: getCommittedProjectId(),
            attributes: {
              'retry.reason': 'empty_assistant_response_after_tools',
              'retry.attempt': emptyAssistantResponseRetries,
            },
          });
          runningMessages.push({
            role: 'user',
            content:
              'The previous assistant response gathered tool results but did not include a user-visible answer. Use the gathered project context to answer the user now. If a change is needed, present a proposal or exact next step.',
          });
          roundAssistantText = '';
          continue;
        }

        if (assistantText.trim().length === 0 && !hasVisibleArtifact && toolCallsThisTurn > 0) {
          const errPayload = {
            code: 'EMPTY_ASSISTANT_RESPONSE',
            message:
              'The model gathered project context but ended without a user-visible answer. Please retry.',
            retryable: true,
          };
          const errEv = emit({
            type: 'error',
            error: errPayload,
          });
          trace.event({
            spanId: turnSpanId,
            name: EVENT_WARNING,
            projectId: getCommittedProjectId(),
            attributes: {
              code: errPayload.code,
            },
          });
          const flushed = await finalizeTurnEnd({
            reason: 'model_provider_error',
            error: errPayload,
          });
          await publishLive(errEv);
          yield errEv;
          for (const ev of flushed) yield ev;
          return;
        }

        // LLM stopped — natural turn end.
        // M4: Generate follow-up suggestions if a callback is provided.
        if (engineDeps.generateSuggestions && input.buffer.suggestions.length === 0) {
          try {
            const suggestionsResult = await engineDeps.generateSuggestions({
              phase: input.phase,
              mode: input.mode,
              projectId: input.projectId,
            });
            input.buffer.suggestions = suggestionsResult;
          } catch (sugErr) {
            log.warn('generateSuggestions failed (non-fatal)', {
              sessionId: input.sessionId,
              turnId,
              error: sugErr instanceof Error ? sugErr.message : String(sugErr),
            });
          }
        }

        const completion =
          accumulatedTokens > 0
            ? {
                usage: {
                  inputTokens: accumulatedInputTokens,
                  outputTokens: accumulatedOutputTokens,
                  totalTokens: accumulatedTokens,
                },
                finishReason,
                stepCount: toolCallsThisTurn,
                latencyMs: clock() - startedAt,
                model: lastModel,
                ...(accumulatedUsd > 0 ? { estimatedUsd: accumulatedUsd } : {}),
              }
            : undefined;
        const flushed = await finalizeTurnEnd({
          reason: 'natural',
          completion,
          suggestions: input.buffer.suggestions.map((s) => ({ text: s })),
        });
        for (const ev of flushed) yield ev;
        return;
      }

      runningMessages.push({
        role: 'assistant',
        content: roundAssistantText,
        toolCalls: roundToolCalls,
      });
      for (const toolResult of roundToolResults) {
        runningMessages.push({
          role: 'tool',
          content: toolResult.content,
          toolCallId: toolResult.toolCallId,
        });
      }
      roundAssistantText = '';

      // Saw internal tool calls — loop back for the next LLM round.
      if (accumulatedTokens >= ARCH_AI_TURN.MAX_TOKENS_PER_TURN) {
        trace.event({
          spanId: turnSpanId,
          name: EVENT_BUDGET_EXHAUSTED,
          attributes: {
            'budget.kind': 'tokens',
            [ARCH_TURN_END_REASON]: 'token_budget_exhausted',
          },
        });
        const flushed = await finalizeTurnEnd({ reason: 'token_budget_exhausted' });
        for (const ev of flushed) yield ev;
        return;
      }
      if (accumulatedUsd >= ARCH_AI_TURN.MAX_USD_PER_TURN) {
        trace.event({
          spanId: turnSpanId,
          name: EVENT_BUDGET_EXHAUSTED,
          attributes: {
            'budget.kind': 'cost',
            [ARCH_TURN_END_REASON]: 'cost_budget_exhausted',
          },
        });
        const flushed = await finalizeTurnEnd({ reason: 'cost_budget_exhausted' });
        for (const ev of flushed) yield ev;
        return;
      }
    }
  }
}

function getTerminalTraceState(reason: TurnEndReason): {
  turnStatus: SpanStatus;
  traceStatus: TraceStatus;
} {
  switch (reason) {
    case 'natural':
      return { turnStatus: 'ok', traceStatus: 'ok' };
    case 'canceled':
    case 'interrupted':
      return { turnStatus: 'canceled', traceStatus: 'canceled' };
    case 'turn_soft_timeout':
    case 'model_timeout':
      return { turnStatus: 'timeout', traceStatus: 'error' };
    default:
      return { turnStatus: 'error', traceStatus: 'error' };
  }
}

function buildModelSpanError(error: ModelProviderError): SpanError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retry,
  };
}

function buildToolSpanError(error: ToolExecutionError): SpanError {
  return {
    code: error.code,
    message: error.message,
  };
}

function getToolSpanStatus(code: ToolExecutionError['code']): SpanStatus {
  return code === 'TOOL_TIMEOUT' ? 'timeout' : 'error';
}

// Re-export ProjectWrite from turn-context so engine consumers don't import it twice.
export type { ProjectWrite };
