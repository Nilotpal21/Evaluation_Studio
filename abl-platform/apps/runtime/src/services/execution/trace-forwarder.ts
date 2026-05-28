/**
 * Trace Forwarder
 *
 * Creates a forwarding wrapper that satisfies the TraceContextManager interface
 * from the compiler package, but forwards all events to the runtime's TraceStore.
 * This bridges the gap between construct-layer tracing and the Observatory UI.
 *
 * Each forwarded event includes `source: 'construct-layer'` so consumers can
 * distinguish construct-level decisions from runtime-level events.
 *
 * When a Tracer is provided, all events are emitted via `tracer.emit()` and
 * spans are managed via `tracer.startSpan()` / `tracer.activeSpan()`, providing
 * proper parent-child span linking through AsyncLocalStorage.
 *
 * When a TraceEmitter is provided (without Tracer), events flow through the
 * unified pipeline (memory TraceStore + WS broadcast + ClickHouse persistence).
 *
 * When neither is available, events are written directly to the TraceStore
 * as a fallback.
 */

import { randomUUID } from 'crypto';
import type { TraceStoreInterface, TraceEvent } from '../trace-store.js';
import type { TraceEmitter } from '../trace-emitter.js';
import type { Tracer, Span } from '@agent-platform/shared-observability/tracing';
import { tracePath } from '@agent-platform/shared-observability/sti';

/**
 * Minimal span interface returned by startSpan.
 */
interface ForwarderSpan {
  spanId: string;
  end: () => void;
}

/**
 * Options for createTraceForwarder.
 */
export interface TraceForwarderOptions {
  sessionId: string;
  traceStore: TraceStoreInterface;
  /** When provided, events flow through the unified pipeline (TraceStore + WS + ClickHouse) */
  traceEmitter?: TraceEmitter;
  /** When provided, all events use tracer.emit() and spans use tracer.startSpan() */
  tracer?: Tracer;
  tenantId?: string;
  projectId?: string;
}

/**
 * The shape of the object returned by createTraceForwarder.
 * This is duck-type-compatible with TraceContextManager from the compiler.
 */
export interface TraceForwarder {
  logLLMCall(params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    cost?: number;
  }): Promise<void>;

  logToolCall(params: {
    toolName: string;
    input: Record<string, unknown>;
    output: unknown;
    latencyMs: number;
    success: boolean;
    error?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  logConstraintCheck(
    constraint: string,
    passed: boolean,
    context: Record<string, unknown>,
  ): Promise<void>;

  logHandoff(toAgent: string, reason: string, context: Record<string, unknown>): Promise<void>;

  logAgentEnter(params: {
    agentName: string;
    mode: string;
    trigger: string;
    parentSpanId?: string;
  }): Promise<void>;

  logAgentExit(params: { agentName: string; result: string; durationMs?: number }): Promise<void>;

  logFlowStepExit(params: {
    agentName: string;
    stepName: string;
    durationMs?: number;
    result?: string;
  }): Promise<void>;

  logFlowTransition(params: {
    agentName: string;
    fromStep: string;
    toStep: string;
    condition?: string;
  }): Promise<void>;

  emitDecision(params: { decisionKind: string; [key: string]: unknown }): Promise<void>;

  logDelegate(params: {
    from: string;
    to: string;
    type: 'start' | 'complete';
    success?: boolean;
    durationMs?: number;
  }): Promise<void>;

  startSpan(name: string): ForwarderSpan;

  getCurrentSpan(): ForwarderSpan | undefined;

  addEvent(type: string, data: Record<string, unknown>): void;
}

function buildTraceEvent(
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
): TraceEvent {
  return {
    id: randomUUID(),
    sessionId,
    type,
    timestamp: new Date(),
    data: {
      ...data,
      source: 'construct-layer',
    },
  };
}

/**
 * Create a forwarding TraceContextManager-compatible object.
 *
 * When a Tracer is provided, all events flow through tracer.emit() and spans
 * are managed via tracer.startSpan() / tracer.activeSpan(). This provides
 * proper parent-child span linking through AsyncLocalStorage.
 *
 * When only a traceEmitter is provided, events flow through the unified
 * pipeline (TraceStore + WS broadcast + ClickHouse).
 *
 * Otherwise, events are written directly to the memory TraceStore as a fallback.
 *
 * Overload signatures preserve backward compatibility with existing callers
 * that pass positional arguments.
 */
export function createTraceForwarder(options: TraceForwarderOptions): TraceForwarder;
export function createTraceForwarder(
  sessionId: string,
  traceStore: TraceStoreInterface,
  tenantId?: string,
  projectId?: string,
): TraceForwarder;
export function createTraceForwarder(
  sessionIdOrOptions: string | TraceForwarderOptions,
  traceStoreArg?: TraceStoreInterface,
  tenantIdArg?: string,
  projectIdArg?: string,
): TraceForwarder {
  // Normalize positional args → options object
  const opts: TraceForwarderOptions =
    typeof sessionIdOrOptions === 'string'
      ? {
          sessionId: sessionIdOrOptions,
          traceStore: traceStoreArg!,
          tenantId: tenantIdArg,
          projectId: projectIdArg,
        }
      : sessionIdOrOptions;

  const { sessionId, traceStore, traceEmitter, tracer } = opts;

  // ── Tracer-backed span tracking ──────────────────────────────────────────
  // When a Tracer is available, spans are managed via tracer.startSpan() and
  // the active span is read from tracer.activeSpan() (AsyncLocalStorage).
  // The spanMap keeps ForwarderSpan → Span associations so end() can close
  // the real tracer span.
  const spanMap = new Map<string, Span>();

  // ── Legacy span tracking (no tracer) ─────────────────────────────────────
  let currentSpanLegacy: ForwarderSpan | undefined;

  /**
   * Emit a construct-layer event. Routing priority:
   * 1. Tracer.emit() — when tracer is provided
   * 2. TraceEmitter.emit() — when traceEmitter is provided
   * 3. Direct TraceStore write — fallback
   */
  function forwardEvent(type: string, data: Record<string, unknown>): void {
    const enrichedData = { ...data, source: 'construct-layer' as const };

    if (tracer) {
      tracer.emit({ type, data: enrichedData });
    } else if (traceEmitter) {
      traceEmitter.emit({
        type: type as import('../../types/index.js').TraceEventType,
        timestamp: new Date(),
        data: enrichedData,
      });
    } else {
      const event = buildTraceEvent(sessionId, type, data);
      void traceStore.addEvent(sessionId, event);
    }
  }

  return {
    logLLMCall: tracePath('runtime/executor/llm-call', async (params) => {
      const data = {
        model: params.model,
        messagesIn: params.messages.length,
        tokensIn: params.tokensIn,
        tokensOut: params.tokensOut,
        latencyMs: params.latencyMs,
        cost: params.cost,
      };
      forwardEvent('llm_call', data);
    }),

    logToolCall: tracePath('runtime/executor/tool-call', async (params) => {
      const data: Record<string, unknown> = {
        toolName: params.toolName,
        input: params.input,
        output: params.output,
        success: params.success,
        latencyMs: params.latencyMs,
        error: params.error,
        metadata: params.metadata,
      };
      forwardEvent('tool_call', data);
    }),

    logConstraintCheck: tracePath(
      'runtime/executor/constraint-check',
      async (constraint: string, passed: boolean, context: Record<string, unknown>) => {
        const data = { constraint, passed, context };
        forwardEvent('constraint_check', data);
      },
    ),

    logHandoff: tracePath('runtime/executor/handoff', async (toAgent, reason, context) => {
      const data = { toAgent, reason, context };
      forwardEvent('handoff', data);
    }),

    logAgentEnter: tracePath('runtime/executor/agent-enter', async (params) => {
      forwardEvent('agent_enter', {
        agentName: params.agentName,
        mode: params.mode,
        trigger: params.trigger,
        parentSpanId: params.parentSpanId,
      });
    }),

    logAgentExit: tracePath('runtime/executor/agent-exit', async (params) => {
      forwardEvent('agent_exit', {
        agentName: params.agentName,
        result: params.result,
        durationMs: params.durationMs,
      });
    }),

    logFlowStepExit: tracePath('runtime/executor/flow/step-exit', async (params) => {
      forwardEvent('flow_step_exit', {
        agentName: params.agentName,
        stepName: params.stepName,
        durationMs: params.durationMs,
        result: params.result,
      });
    }),

    logFlowTransition: tracePath('runtime/executor/flow/transition', async (params) => {
      forwardEvent('flow_transition', {
        agentName: params.agentName,
        fromStep: params.fromStep,
        toStep: params.toStep,
        condition: params.condition,
      });
    }),

    emitDecision: tracePath('runtime/executor/decision', async (params) => {
      forwardEvent('decision', params);
    }),

    logDelegate: tracePath('runtime/executor/delegate', async (params) => {
      const eventType = params.type === 'start' ? 'delegate_start' : 'delegate_complete';
      forwardEvent(eventType, {
        from: params.from,
        to: params.to,
        success: params.success,
        durationMs: params.durationMs,
      });
    }),

    startSpan(name: string): ForwarderSpan {
      if (tracer) {
        const span = tracer.startSpan(name, {
          attributes: { source: 'construct-layer' },
        });
        const forwarderSpan: ForwarderSpan = {
          spanId: span.context.spanId,
          end: () => {
            span.end();
            spanMap.delete(forwarderSpan.spanId);
          },
        };
        spanMap.set(forwarderSpan.spanId, span);
        return forwarderSpan;
      }

      // Legacy path: closure-based span tracking
      const spanId = randomUUID();
      const startTime = Date.now();

      const span: ForwarderSpan = {
        spanId,
        end: () => {
          const durationMs = Date.now() - startTime;
          const data = { spanId, spanName: name, durationMs };
          forwardEvent('span_end', data);
        },
      };

      currentSpanLegacy = span;
      return span;
    },

    getCurrentSpan(): ForwarderSpan | undefined {
      if (tracer) {
        const active = tracer.activeSpan();
        if (!active) return undefined;
        const spanId = active.context.spanId;
        // Return existing ForwarderSpan wrapper or create an ephemeral one
        if (spanMap.has(spanId)) {
          return { spanId, end: () => spanMap.get(spanId)?.end() };
        }
        return { spanId, end: () => active.end() };
      }
      return currentSpanLegacy;
    },

    addEvent(type: string, data: Record<string, unknown>): void {
      forwardEvent(type, data);
    },
  };
}
