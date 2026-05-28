/**
 * Trace Store
 *
 * Captures execution traces for debugging, observability, and analytics.
 * TraceContextManager is the active execution-layer tracing class.
 * TraceEventSink is the minimal interface for event persistence.
 */

import { randomUUID } from 'crypto';
import type {
  TraceContext,
  TraceEvent,
  Environment,
  LLMCallEvent,
  ToolCallEvent,
  DecisionEvent,
} from '../core/types.js';
import { HybridLogicalClock } from '../distributed/hlc.js';
import { createLogger } from '../logger.js';

const log = createLogger('trace-store');

// =============================================================================
// INTERFACES
// =============================================================================

export interface TraceStoreConfig {
  type: 'langfuse' | 'langsmith' | 'postgres' | 'clickhouse' | 'memory';
  connectionString?: string;
  apiKey?: string;
  publicKey?: string;
  samplingRate?: number;
  environment?: Environment;
}

export interface StartTraceParams {
  sessionId: string;
  agentName: string;
  agentVersion: string;
  environment: Environment;
  parentSpanId?: string;
  /** Pod/node identifier for distributed tracing */
  nodeId?: string;
}

export interface LogLLMCallParams {
  traceId: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  response: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  cost?: number;
}

export interface LogToolCallParams {
  traceId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  latencyMs: number;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface LogDecisionParams {
  traceId: string;
  decisionKind: 'routing' | 'escalation' | 'handoff' | 'constraint';
  decision: string;
  reasoning: string;
  contextSnapshot: Record<string, unknown>;
}

export interface QueryTracesParams {
  sessionId?: string;
  agentName?: string;
  environment?: Environment;
  startTime?: Date;
  endTime?: Date;
  eventTypes?: import('../core/types.js').TraceEventType[];
  limit?: number;
}

// =============================================================================
// TRACE EVENT SINK — minimal interface for event persistence
// =============================================================================

/** Minimal interface for trace event persistence — replaces tight coupling to abstract TraceStore */
export interface TraceEventSink {
  appendEvent(traceId: string, event: TraceEvent): void | Promise<void>;
  endTrace(context: TraceContext): void | Promise<void>;
}

/**
 * Full trace provider interface — combines event persistence with the ability
 * to start new traces. Used by runtimes that need both capabilities.
 */
export interface TraceProvider extends TraceEventSink {
  startTrace(params: StartTraceParams): TraceContextManager;
}

// =============================================================================
// TRACE CONTEXT MANAGER
// =============================================================================

export class TraceContextManager {
  private context: TraceContext;
  private sink: TraceEventSink;
  private shouldSample: boolean;
  private hlc?: HybridLogicalClock;

  constructor(
    context: TraceContext,
    sink: TraceEventSink,
    shouldSample: boolean,
    hlc?: HybridLogicalClock,
  ) {
    this.context = context;
    this.sink = sink;
    this.shouldSample = shouldSample;
    this.hlc = hlc;
  }

  get traceId(): string {
    return this.context.traceId;
  }

  get spanId(): string {
    return this.context.spanId;
  }

  private stampSequence(event: TraceEvent): void {
    if (this.hlc) {
      event.sequence = HybridLogicalClock.toString(this.hlc.now());
    }
  }

  async logLLMCall(params: Omit<LogLLMCallParams, 'traceId'>): Promise<void> {
    if (!this.shouldSample) return;

    const event: LLMCallEvent = {
      type: 'llm_call',
      timestamp: new Date(),
      durationMs: params.latencyMs,
      data: {
        model: params.model,
        messagesIn: params.messages.length,
        tokensIn: params.tokensIn,
        tokensOut: params.tokensOut,
        latencyMs: params.latencyMs,
        cost: params.cost,
      },
    };

    this.stampSequence(event);
    this.context.events.push(event);
    await this.sink.appendEvent(this.context.traceId, event);
  }

  async logToolCall(params: Omit<LogToolCallParams, 'traceId'>): Promise<void> {
    if (!this.shouldSample) return;

    const event: ToolCallEvent = {
      type: 'tool_call',
      timestamp: new Date(),
      durationMs: params.latencyMs,
      data: {
        toolName: params.toolName,
        input: params.input,
        output: params.output,
        success: params.success,
        latencyMs: params.latencyMs,
        error: params.error,
        metadata: params.metadata,
      },
    };

    this.stampSequence(event);
    this.context.events.push(event);
    await this.sink.appendEvent(this.context.traceId, event);
  }

  async emitDecision(params: Omit<LogDecisionParams, 'traceId'>): Promise<void> {
    if (!this.shouldSample) return;

    const event: DecisionEvent = {
      type: 'decision',
      timestamp: new Date(),
      data: {
        decisionKind: params.decisionKind,
        // Backward-compat alias for stored events consumers
        kind: params.decisionKind,
        decision: params.decision,
        reasoning: params.reasoning,
        contextSnapshot: params.contextSnapshot,
      },
    };

    this.stampSequence(event);
    this.context.events.push(event);
    await this.sink.appendEvent(this.context.traceId, event);
  }

  /** @deprecated Use emitDecision() instead. */
  async logDecision(params: Omit<LogDecisionParams, 'traceId'>): Promise<void> {
    return this.emitDecision(params);
  }

  async logConstraintCheck(
    constraint: string,
    passed: boolean,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.shouldSample) return;

    const event: TraceEvent = {
      type: 'constraint_check',
      timestamp: new Date(),
      data: {
        constraint,
        passed,
        context,
      },
    };

    this.stampSequence(event);
    this.context.events.push(event);
    await this.sink.appendEvent(this.context.traceId, event);
  }

  async logHandoff(
    toAgent: string,
    reason: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.shouldSample) return;

    const event: TraceEvent = {
      type: 'handoff',
      timestamp: new Date(),
      data: {
        toAgent,
        reason,
        context,
      },
    };

    this.stampSequence(event);
    this.context.events.push(event);
    await this.sink.appendEvent(this.context.traceId, event);
  }

  async logEscalation(
    reason: string,
    priority: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.shouldSample) return;

    const event: TraceEvent = {
      type: 'escalation',
      timestamp: new Date(),
      data: {
        reason,
        priority,
        context,
      },
    };

    this.stampSequence(event);
    this.context.events.push(event);
    await this.sink.appendEvent(this.context.traceId, event);
  }

  async logError(errorType: string, message: string, stack?: string): Promise<void> {
    const event: TraceEvent = {
      type: 'error',
      timestamp: new Date(),
      data: {
        errorType,
        message,
        stack,
      },
    };

    this.stampSequence(event);
    this.context.events.push(event);
    // Always log errors regardless of sampling
    await this.sink.appendEvent(this.context.traceId, event);
  }

  async end(): Promise<void> {
    this.context.endTime = new Date();
    await this.sink.endTrace(this.context);
  }

  /**
   * Create a child span for nested operations
   */
  createChildSpan(name: string): TraceContextManager {
    const childContext: TraceContext = {
      traceId: this.context.traceId,
      spanId: randomUUID(),
      parentSpanId: this.context.spanId,
      sessionId: this.context.sessionId,
      agentName: name,
      agentVersion: this.context.agentVersion,
      environment: this.context.environment,
      startTime: new Date(),
      events: [],
      nodeId: this.context.nodeId,
    };

    return new TraceContextManager(childContext, this.sink, this.shouldSample, this.hlc);
  }
}

// =============================================================================
// STANDALONE FACTORY — replaces TraceStore.startTrace()
// =============================================================================

export interface CreateTraceContextOptions {
  sink: TraceEventSink;
  params: StartTraceParams;
  samplingRate?: number;
  /** Called with the initial TraceContext before the manager is returned (for persistence). */
  onCreate?: (context: TraceContext) => void | Promise<void>;
}

/**
 * Standalone factory that creates a TraceContextManager without requiring the
 * abstract TraceStore class hierarchy. This replaces the old
 * `TraceStore.startTrace()` pattern.
 */
export function createTraceContext(options: CreateTraceContextOptions): TraceContextManager {
  const { sink, params, samplingRate = 1.0, onCreate } = options;
  const shouldSample = Math.random() < samplingRate;

  const context: TraceContext = {
    traceId: randomUUID(),
    spanId: randomUUID(),
    parentSpanId: params.parentSpanId,
    sessionId: params.sessionId,
    agentName: params.agentName,
    agentVersion: params.agentVersion,
    environment: params.environment,
    startTime: new Date(),
    events: [],
    nodeId: params.nodeId,
  };

  if (shouldSample && onCreate) {
    const result = onCreate(context);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((err) => {
        log.error('Failed to create trace:', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  const hlc = params.nodeId ? new HybridLogicalClock(params.nodeId) : undefined;
  return new TraceContextManager(context, sink, shouldSample, hlc);
}
