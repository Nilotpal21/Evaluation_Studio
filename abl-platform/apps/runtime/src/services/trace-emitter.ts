/**
 * Trace Emitter Service
 *
 * Wraps trace events and emits them over WebSocket for real-time viewing.
 */

import crypto from 'crypto';
import type { WebSocket } from 'ws';
import type {
  TraceEvent,
  TraceEventType,
  TraceEventWithId,
  ServerMessage,
} from '../types/index.js';
import { getTraceStore } from './trace-store.js';
import { scrubToolCallData, scrubTraceEvent, redactPII } from '@abl/compiler';
import { createLogger, type PIIRecognizerRegistry } from '@abl/compiler/platform';
import {
  shouldEmitDecision,
  type DecisionKind,
  type TraceVerbosity,
} from './execution/trace-helpers.js';
import { getEventStore } from './eventstore-singleton.js';
import { emitToEventStore } from './trace/emit-to-eventstore.js';
import type { Tracer } from '@agent-platform/shared-observability/tracing';
const log = createLogger('trace-emitter');

// =============================================================================
// TYPES
// =============================================================================

export interface TraceEmitterConfig {
  sessionId: string;
  ws: WebSocket;
  // Tenant/project context — required for analytics dual-write
  tenantId?: string;
  projectId?: string;
  // Deployment context — enriches every trace event for version-aware observability
  deploymentId?: string;
  environment?: string;
  agentVersions?: Record<string, number>;
  /** Session purpose/source tag for analytics filtering */
  knownSource?: 'production' | 'eval' | 'synthetic';
  // When true, scrub PII and secrets from tool call inputs/outputs and LLM messages
  scrubPII?: boolean;
  piiRecognizerRegistry?: PIIRecognizerRegistry;
  /** Trace verbosity level — controls which decision kinds are emitted */
  verbosity?: TraceVerbosity;
  /** Custom dimensions for analytics — attached to every event emitted to EventStore */
  customDimensions?: Map<string, string>;
  /** Session reference for lazy dimension reads and turn count — when provided, dimensions
   *  and conversationHistory are read from the session at emit time so mutations are reflected. */
  sessionRef?: {
    customDimensions?: Map<string, string>;
    conversationHistory?: unknown[];
    knownSource?: 'production' | 'eval' | 'synthetic';
  };
  /** Optional Tracer for span-aware event emission. When provided, agent enter/exit
   *  and observatory events use tracer-managed spans instead of closure-based spanStack. */
  tracer?: Tracer;
  /** Module provenance map — when present, events for module-sourced agents are enriched
   *  with moduleAlias, moduleProjectId, moduleReleaseId, and sourceAgentName. */
  moduleProvenanceMap?: Record<
    string,
    {
      alias: string;
      moduleProjectId: string;
      moduleReleaseId: string;
      sourceAgentName: string;
    }
  >;
}

// =============================================================================
// TRACE EMITTER
// =============================================================================

/**
 * Creates a trace emitter that sends events over WebSocket
 */
export function createTraceEmitter(config: TraceEmitterConfig) {
  const {
    sessionId,
    ws,
    tenantId,
    projectId,
    deploymentId,
    environment,
    agentVersions,
    scrubPII: enableScrub,
    piiRecognizerRegistry,
  } = config;

  const sessionRef = config.sessionRef;
  let customDimensions = config.customDimensions;
  /** Cached Record form of dimensions — invalidated when dimensions change */
  let _cachedDimRecord: Record<string, string> | undefined;
  let _cachedDimRef: Map<string, string> | undefined;

  /**
   * Update custom dimensions mid-session (called when DSL SET _meta.* or REST injection changes dimensions).
   */
  function updateCustomDimensions(dims: Map<string, string>) {
    customDimensions = dims;
    _cachedDimRecord = undefined; // invalidate cache
  }

  /** Get current dimensions as a Record, cached to avoid Object.fromEntries on every emit */
  function getDimensionRecord(): Record<string, string> | undefined {
    const dims = sessionRef?.customDimensions ?? customDimensions;
    if (!dims || dims.size === 0) return undefined;
    // Cache hit: same Map reference → reuse cached Record
    if (dims === _cachedDimRef && _cachedDimRecord) return _cachedDimRecord;
    _cachedDimRef = dims;
    _cachedDimRecord = Object.fromEntries(dims);
    return _cachedDimRecord;
  }

  const moduleProvenanceMap = config.moduleProvenanceMap;

  /**
   * Emit a trace event, enriched with deployment context when available
   */
  function emit(event: TraceEvent): TraceEventWithId | undefined {
    // Enrich with module provenance when the event's agent is sourced from a module
    const provenance =
      event.agentName && moduleProvenanceMap ? moduleProvenanceMap[event.agentName] : undefined;

    const storedEvent: TraceEventWithId = {
      ...event,
      id: crypto.randomUUID(),
      sessionId,
      // Deployment context — enables filtering traces by deployment/version
      ...(deploymentId && { deploymentId }),
      ...(environment && { environment }),
      ...(agentVersions && { agentVersions }),
      // Module provenance — traces imported agents back to their originating module
      ...(provenance && {
        moduleAlias: provenance.alias,
        moduleProjectId: provenance.moduleProjectId,
        moduleReleaseId: provenance.moduleReleaseId,
        sourceAgentName: provenance.sourceAgentName,
      }),
    };

    // Universal scrubbing — mask PII and secrets in ALL event types before storage/transmission
    if (enableScrub && storedEvent.data) {
      try {
        storedEvent.data = scrubTraceEvent(storedEvent.data as Record<string, unknown>, {
          piiRecognizerRegistry,
        });
      } catch (err) {
        log.warn('Trace event scrubbing failed — emitting original event', {
          sessionId,
          eventType: storedEvent.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Store in TraceStore (single trace authority)
    try {
      getTraceStore().addEvent(sessionId, storedEvent);
    } catch (err) {
      log.warn('TraceStore unavailable — trace event not persisted', {
        sessionId,
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Send over WebSocket
    const message: ServerMessage = {
      type: 'trace_event',
      sessionId,
      event: storedEvent,
    };

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }

    // Persist to EventStore → ClickHouse platform_events (fire-and-forget, non-fatal)
    if (tenantId) {
      const eventStore = getEventStore();
      if (eventStore) {
        emitToEventStore({
          eventStore,
          event: {
            id: storedEvent.id,
            type: storedEvent.type,
            sessionId,
            tenantId,
            projectId: projectId ?? undefined,
            deploymentId,
            agentName: storedEvent.agentName,
            timestamp: storedEvent.timestamp,
            durationMs: storedEvent.durationMs,
            spanId: storedEvent.spanId,
            parentSpanId: storedEvent.parentSpanId,
            data: (storedEvent.data as Record<string, unknown>) || {},
          },
          scrubPII: enableScrub,
          redactPIIFn: enableScrub
            ? (value: string) => redactPII(value, piiRecognizerRegistry)
            : undefined,
          knownSource: sessionRef?.knownSource ?? config.knownSource,
          dimensionRecord: getDimensionRecord(),
        });
      }
    }

    return storedEvent;
  }

  /**
   * Log an LLM call event
   */
  function logLLMCall(params: {
    model: string;
    messagesIn: number;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    cost?: number;
    messages?: Array<{ role: string; content: string }>;
    response?: string;
  }): TraceEventWithId | undefined {
    const scrubbedParams = enableScrub
      ? {
          ...params,
          messages: params.messages?.map((m) => ({
            ...m,
            content: redactPII(m.content, piiRecognizerRegistry),
          })),
          response: params.response
            ? redactPII(params.response, piiRecognizerRegistry)
            : params.response,
        }
      : params;
    return emit({
      type: 'llm_call',
      timestamp: new Date(),
      durationMs: params.latencyMs,
      data: scrubbedParams,
    });
  }

  /**
   * Log a tool call event
   */
  function logToolCall(params: {
    toolName: string;
    input: Record<string, unknown>;
    output: unknown;
    success: boolean;
    latencyMs: number;
    error?: string;
    metadata?: Record<string, unknown>;
  }): TraceEventWithId | undefined {
    const scrubbedParams = enableScrub
      ? {
          ...params,
          input: scrubToolCallData(params.input, { piiRecognizerRegistry }),
          output:
            typeof params.output === 'object' && params.output !== null
              ? scrubToolCallData(params.output as Record<string, unknown>, {
                  piiRecognizerRegistry,
                })
              : params.output,
        }
      : params;
    return emit({
      type: 'tool_call',
      timestamp: new Date(),
      durationMs: params.latencyMs,
      data: scrubbedParams,
    });
  }

  /**
   * Build context metadata from a snapshot. When scrubPII is enabled, key names
   * are replaced with generic placeholders to prevent leaking field names that
   * may themselves be PII-indicative (e.g. "customer_ssn").
   */
  function buildContextMeta(snapshot: Record<string, unknown>): {
    keysEvaluated: string[];
    keyCount: number;
    sessionId: string;
    turnCount: number;
  } {
    const keys = Object.keys(snapshot);
    return {
      keysEvaluated: enableScrub ? keys.map((_, i) => `field_${i}`) : keys,
      keyCount: keys.length,
      sessionId,
      turnCount: sessionRef?.conversationHistory?.length ?? 0,
    };
  }

  /**
   * Log a constraint check event
   */
  function logConstraintCheck(params: {
    constraint: string;
    passed: boolean;
    context: Record<string, unknown>;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'constraint_check',
      timestamp: new Date(),
      data: params,
    });
  }

  /**
   * Log a handoff event.
   * Context is trimmed to key names only (no PII in trace data).
   */
  function logHandoff(params: {
    toAgent: string;
    reason: string;
    context: Record<string, unknown>;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'handoff',
      timestamp: new Date(),
      data: {
        toAgent: params.toAgent,
        reason: params.reason,
        contextMeta: buildContextMeta(params.context),
      },
    });
  }

  /**
   * Log an escalation event.
   * Context is trimmed to key names only (no PII in trace data).
   */
  function logEscalation(params: {
    reason: string;
    priority: string;
    context: Record<string, unknown>;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'escalation',
      timestamp: new Date(),
      data: {
        reason: params.reason,
        priority: params.priority,
        contextMeta: buildContextMeta(params.context),
      },
    });
  }

  /**
   * Log an error event
   */
  function logError(params: {
    errorType: string;
    message: string;
    stack?: string;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'error',
      timestamp: new Date(),
      data: params,
    });
  }

  /**
   * Log a custom event
   */
  function logCustom(
    type: TraceEventType,
    data: Record<string, unknown>,
  ): TraceEventWithId | undefined {
    return emit({
      type,
      timestamp: new Date(),
      data,
    });
  }

  // ==========================================================================
  // MESSAGE & SESSION LIFECYCLE EVENTS
  // ==========================================================================

  /**
   * Log a user message received event
   */
  function logUserMessage(params: {
    contentLength: number;
    channel?: string;
    hasAttachments?: boolean;
    attachmentCount?: number;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'user_message',
      timestamp: new Date(),
      data: params,
    });
  }

  /**
   * Log an agent response sent event
   */
  function logAgentResponse(params: {
    contentLength: number;
    channel?: string;
    hasRichContent?: boolean;
    durationMs: number;
    agentName?: string;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'agent_response',
      timestamp: new Date(),
      durationMs: params.durationMs,
      data: params,
    });
  }

  /**
   * Log a session state/context update event
   */
  function logSessionUpdated(params: {
    updateSource: string;
    keysUpdated: string[];
    updateCount: number;
    agentName?: string;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'session_updated',
      timestamp: new Date(),
      data: params,
    });
  }

  // ==========================================================================
  // EXTENDED EVENTS FOR OBSERVATORY
  // ==========================================================================

  // Span tracking: when a Tracer is available, span context is read from the
  // tracer's active span (via AsyncLocalStorage). When no tracer is configured,
  // fall back to the closure-based spanId/spanStack for backward compatibility.
  const tracer = config.tracer;
  let currentSpanId: string | undefined;
  let spanStack: string[] = [];
  // Maps spanId → Span so logAgentExit can end the correct span (not tracer.activeSpan()
  // which may return the turn span rather than the agent span).
  const tracerSpanMap = new Map<
    string,
    import('@agent-platform/shared-observability/tracing').Span
  >();

  /** Get the current span ID — from tracer if available, else from closure */
  function getActiveSpanId(): string | undefined {
    if (tracer) {
      const span = tracer.activeSpan();
      return span ? span.context.spanId : currentSpanId;
    }
    return currentSpanId;
  }

  /** Get the parent span ID — from tracer if available, else from closure stack */
  function getActiveParentSpanId(): string | undefined {
    if (tracer) {
      const span = tracer.activeSpan();
      return span ? span.context.parentSpanId : spanStack[spanStack.length - 1];
    }
    return spanStack[spanStack.length - 1];
  }

  /**
   * Log agent enter event - called when an agent starts processing.
   * When tracer is available, starts a tracer-managed span. Otherwise falls
   * back to the closure-based span stack.
   */
  function logAgentEnter(params: {
    agentName: string;
    mode: 'scripted' | 'reasoning';
    trigger?: string;
    parentSpanId?: string;
  }): TraceEventWithId | undefined {
    let spanId: string;
    let parentSpanId: string | undefined;

    if (tracer) {
      // Start a tracer-managed span — the caller (RuntimeExecutor) is responsible
      // for running code within tracer.withSpan() / tracer.run() so that
      // activeSpan() returns the correct parent.
      const span = tracer.startSpan(`agent:${params.agentName}`, {
        agentName: params.agentName,
      });
      spanId = span.context.spanId;
      parentSpanId = params.parentSpanId || span.context.parentSpanId;
      // Store span so logAgentExit can end it by spanId (not via activeSpan())
      tracerSpanMap.set(spanId, span);
      // Also update closure fallback so non-tracer-aware callers still get a spanId
      if (currentSpanId) {
        spanStack.push(currentSpanId);
      }
      currentSpanId = spanId;
    } else {
      spanId = `span-${params.agentName}-${Date.now()}`;
      if (currentSpanId) {
        spanStack.push(currentSpanId);
      }
      currentSpanId = spanId;
      parentSpanId = params.parentSpanId || spanStack[spanStack.length - 1];
    }

    return emit({
      type: 'agent_enter',
      timestamp: new Date(),
      data: {
        agentName: params.agentName,
        mode: params.mode,
        trigger: params.trigger || 'user_message',
      },
      agentName: params.agentName,
      spanId,
      parentSpanId,
    });
  }

  /**
   * Log agent exit event - called when an agent finishes processing.
   * When tracer is available, ends the tracer-managed span.
   */
  function logAgentExit(params: {
    agentName: string;
    result:
      | 'completed'
      | 'continue'
      | 'constraint_blocked'
      | 'escalate'
      | 'handoff'
      | 'delegate'
      | 'error';
    durationMs?: number;
  }): TraceEventWithId | undefined {
    const spanId = currentSpanId;

    if (tracer && spanId) {
      // End the specific agent span (looked up by spanId, not tracer.activeSpan()
      // which may return the turn span instead of the agent span).
      const agentSpan = tracerSpanMap.get(spanId);
      if (agentSpan) {
        agentSpan.setStatus(params.result === 'error' ? 'error' : 'ok');
        agentSpan.end();
        tracerSpanMap.delete(spanId);
      }
    }

    currentSpanId = spanStack.pop();

    return emit({
      type: 'agent_exit',
      timestamp: new Date(),
      durationMs: params.durationMs,
      data: {
        agentName: params.agentName,
        result: params.result,
      },
      agentName: params.agentName,
      spanId,
    });
  }

  /**
   * Log flow step enter event - called when entering a flow step
   */
  function logFlowStepEnter(params: {
    agentName: string;
    stepName: string;
    stepType?: string;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'flow_step_enter',
      timestamp: new Date(),
      data: {
        agentName: params.agentName,
        stepName: params.stepName,
        stepType: params.stepType,
      },
      agentName: params.agentName,
      spanId: getActiveSpanId(),
    });
  }

  /**
   * Log flow step exit event - called when exiting a flow step
   */
  function logFlowStepExit(params: {
    agentName: string;
    stepName: string;
    durationMs?: number;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'flow_step_exit',
      timestamp: new Date(),
      durationMs: params.durationMs,
      data: {
        agentName: params.agentName,
        stepName: params.stepName,
      },
      agentName: params.agentName,
      spanId: getActiveSpanId(),
    });
  }

  /**
   * Log flow transition event
   */
  function logFlowTransition(params: {
    agentName: string;
    fromStep: string;
    toStep: string;
    condition?: string;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'flow_transition',
      timestamp: new Date(),
      data: {
        agentName: params.agentName,
        fromStep: params.fromStep,
        toStep: params.toStep,
        condition: params.condition,
      },
      agentName: params.agentName,
      spanId: getActiveSpanId(),
    });
  }

  /**
   * Log delegate start event
   */
  function logDelegateStart(params: {
    fromAgent: string;
    targetAgent: string;
    task?: string;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'delegate_start',
      timestamp: new Date(),
      data: {
        sourceAgent: params.fromAgent,
        fromAgent: params.fromAgent,
        toAgent: params.targetAgent,
        targetAgent: params.targetAgent,
        from: params.fromAgent,
        to: params.targetAgent,
        invocationType: 'delegate',
        task: params.task,
      },
      agentName: params.fromAgent,
      spanId: getActiveSpanId(),
    });
  }

  /**
   * Log delegate complete event
   */
  function logDelegateComplete(params: {
    fromAgent: string;
    targetAgent: string;
    success: boolean;
    durationMs?: number;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'delegate_complete',
      timestamp: new Date(),
      durationMs: params.durationMs,
      data: {
        sourceAgent: params.fromAgent,
        fromAgent: params.fromAgent,
        toAgent: params.targetAgent,
        targetAgent: params.targetAgent,
        from: params.fromAgent,
        to: params.targetAgent,
        invocationType: 'delegate',
        success: params.success,
      },
      agentName: params.fromAgent,
      spanId: getActiveSpanId(),
    });
  }

  /**
   * Emit a decision trace event, gated by verbosity and decision kind.
   * Replaces the old appendDecision/shouldLogDecisions pattern with unified
   * trace-event emission.
   */
  function emitDecision(
    kind: DecisionKind,
    metadata: Record<string, unknown>,
  ): TraceEventWithId | undefined {
    const verbosity = config.verbosity ?? 'standard';
    if (!shouldEmitDecision(kind, verbosity)) return undefined;

    return emit({
      type: 'decision',
      timestamp: new Date(),
      data: {
        decisionKind: kind,
        ...metadata,
      },
      spanId: getActiveSpanId(),
      parentSpanId: getActiveParentSpanId(),
    });
  }

  /**
   * Log a tool_auth_resolved event — emitted when auth credentials are resolved
   * for an imported tool, tracking which profile and scope were used.
   */
  function logToolAuthResolved(params: {
    agentName: string;
    toolName: string;
    profileName: string;
    scope: 'project' | 'tenant';
    moduleAlias?: string;
  }): TraceEventWithId | undefined {
    return emit({
      type: 'tool_auth_resolved',
      timestamp: new Date(),
      data: {
        agentName: params.agentName,
        toolName: params.toolName,
        profileName: params.profileName,
        scope: params.scope,
        ...(params.moduleAlias ? { moduleAlias: params.moduleAlias } : {}),
      },
      agentName: params.agentName,
      spanId: getActiveSpanId(),
    });
  }

  /**
   * Get current span ID
   */
  function getCurrentSpanId(): string | undefined {
    return getActiveSpanId();
  }

  return {
    emit,
    logLLMCall,
    logToolCall,
    emitDecision,
    logConstraintCheck,
    logHandoff,
    logEscalation,
    logError,
    logCustom,
    // Message & session lifecycle events
    logUserMessage,
    logAgentResponse,
    logSessionUpdated,
    // Extended events
    logAgentEnter,
    logAgentExit,
    logFlowStepEnter,
    logFlowStepExit,
    logFlowTransition,
    logDelegateStart,
    logDelegateComplete,
    logToolAuthResolved,
    getCurrentSpanId,
    // Custom dimensions
    updateCustomDimensions,
  };
}

export type TraceEmitter = ReturnType<typeof createTraceEmitter>;
