/**
 * OpenTelemetry Trace Bridge
 *
 * Bridges the TraceEventSink/TraceProvider abstraction to OpenTelemetry spans.
 * Each trace event (llm_call, tool_call, decision, etc.) becomes
 * an OTEL span with proper parent context and attributes.
 */

import { trace, context, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import type { TraceContext, TraceEvent } from '@abl/compiler/platform/core/types';
import {
  TraceContextManager,
  type TraceProvider,
  type TraceStoreConfig,
  type StartTraceParams,
  createTraceContext,
} from '@abl/compiler/platform/stores';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('otel-trace-bridge');

// ---------------------------------------------------------------------------
// OtelTraceStore — implements TraceProvider (no longer extends abstract class)
// ---------------------------------------------------------------------------

export class OtelTraceStore implements TraceProvider {
  private tracer: Tracer;
  private activeSpans: Map<string, Span> = new Map();
  private samplingRate: number;

  constructor(config: TraceStoreConfig) {
    this.samplingRate = config.samplingRate ?? 1.0;
    this.tracer = trace.getTracer('agent-platform', '1.0.0');
  }

  /**
   * Start a new trace — creates an OTEL root span and a TraceContextManager.
   */
  startTrace(params: StartTraceParams): TraceContextManager {
    const manager = createTraceContext({
      sink: this,
      params,
      samplingRate: this.samplingRate,
      onCreate: (ctx) => {
        log.debug('OTEL trace created', { traceId: ctx.traceId, agent: ctx.agentName });
      },
    });

    // Create a corresponding OTEL span
    const span = this.tracer.startSpan(`agent:${params.agentName}`, {
      attributes: {
        'agent.name': params.agentName,
        'agent.version': params.agentVersion,
        environment: params.environment,
      },
    });

    this.activeSpans.set(manager.traceId, span);
    return manager;
  }

  async appendEvent(traceId: string, event: TraceEvent): Promise<void> {
    const parentSpan = this.activeSpans.get(traceId);
    if (!parentSpan) return;

    // Create a child span for each event
    const parentCtx = trace.setSpan(context.active(), parentSpan);
    const childSpan = this.tracer.startSpan(
      `${event.type}`,
      {
        attributes: this.eventToAttributes(event),
      },
      parentCtx,
    );

    // Set duration if available
    if (event.durationMs) {
      childSpan.setAttribute('duration_ms', event.durationMs);
    }

    // Mark errors
    if (event.type === 'error') {
      childSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: ((event.data as Record<string, unknown>)?.message as string) ?? 'Unknown error',
      });
    }

    childSpan.end();
  }

  async endTrace(ctx: TraceContext): Promise<void> {
    const span = this.activeSpans.get(ctx.traceId);
    if (span) {
      span.end();
      this.activeSpans.delete(ctx.traceId);
    }
  }

  /**
   * End and remove orphaned spans that are no longer associated with
   * active sessions. Call this during session cleanup to prevent
   * the activeSpans map from growing unbounded.
   *
   * @param activeTraceIds Set of trace IDs that are still active.
   *   Any span not in this set will be ended and removed.
   */
  cleanupOrphanedSpans(activeTraceIds?: Set<string>): void {
    for (const [traceId, span] of this.activeSpans) {
      if (activeTraceIds && activeTraceIds.has(traceId)) continue;
      try {
        span.end();
      } catch {
        // Span may already be ended — safe to ignore
      }
      this.activeSpans.delete(traceId);
    }
  }

  /** Number of currently active spans. Useful for monitoring and testing. */
  get activeSpanCount(): number {
    return this.activeSpans.size;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private eventToAttributes(event: TraceEvent): Record<string, string | number | boolean> {
    const attrs: Record<string, string | number | boolean> = {
      'event.type': event.type,
    };

    const data = event.data as Record<string, unknown> | undefined;
    if (!data) return attrs;

    // Map known event data fields to OTEL attributes
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        attrs[`event.${key}`] = value;
      }
    }

    return attrs;
  }
}
