/**
 * TracerImpl — Creates and manages spans using AsyncLocalStorage.
 *
 * Provides automatic parent-child span linking via ALS-based span storage.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type {
  Tracer,
  Span,
  SpanContext,
  WritePipeline,
} from '@agent-platform/shared-observability/tracing';
import { generateTraceId, generateSpanId } from '@agent-platform/shared-observability/tracing';
import { createLogger } from '@abl/compiler/platform';
import { SpanImpl } from './span.js';

const log = createLogger('tracer-impl');

export interface TracerImplConfig {
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  writePipeline: WritePipeline;
  defaultAttributes?: Record<string, string>;
}

export class TracerImpl implements Tracer {
  readonly sessionId: string;
  private readonly tenantId?: string;
  private readonly projectId?: string;
  private readonly writePipeline: WritePipeline;
  private readonly defaultAttributes: Record<string, string>;
  private readonly spanStorage = new AsyncLocalStorage<Span>();
  private readonly fallbackTraceId: string;
  private orphanWarned = false;

  constructor(config: TracerImplConfig) {
    this.sessionId = config.sessionId;
    this.tenantId = config.tenantId;
    this.projectId = config.projectId;
    this.writePipeline = config.writePipeline;
    this.defaultAttributes = config.defaultAttributes ?? {};
    this.fallbackTraceId = generateTraceId();
  }

  startSpan(
    name: string,
    options?: { agentName?: string; attributes?: Record<string, string> },
  ): Span {
    const parent = this.activeSpan();
    const traceId = parent ? parent.context.traceId : generateTraceId();
    const spanId = generateSpanId();
    const parentSpanId = parent ? parent.context.spanId : undefined;

    const context: SpanContext = { traceId, spanId, parentSpanId };

    const span = new SpanImpl({
      name,
      context,
      writePipeline: this.writePipeline,
      sessionId: this.sessionId,
      tenantId: this.tenantId,
      projectId: this.projectId,
      agentName: options?.agentName,
    });

    // Apply default attributes then overrides
    for (const [k, v] of Object.entries(this.defaultAttributes)) {
      span.setAttribute(k, v);
    }
    if (options?.attributes) {
      for (const [k, v] of Object.entries(options.attributes)) {
        span.setAttribute(k, v);
      }
    }

    return span;
  }

  async withSpan<T>(
    name: string,
    fn: () => T | Promise<T>,
    options?: { agentName?: string; attributes?: Record<string, string> },
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await this.spanStorage.run(span, fn);
      span.setStatus('ok');
      return result;
    } catch (err) {
      span.setStatus('error', err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      span.end();
    }
  }

  runSync<T>(span: Span, fn: () => T): T {
    return this.spanStorage.run(span, fn);
  }

  run<T>(span: Span, fn: () => T | Promise<T>): T | Promise<T> {
    return this.spanStorage.run(span, fn);
  }

  activeSpan(): Span | null {
    return this.spanStorage.getStore() ?? null;
  }

  emit(event: { type: string; data: Record<string, unknown>; durationMs?: number }): void {
    const span = this.activeSpan();

    let traceId: string;
    let spanId: string | undefined;
    let parentSpanId: string | undefined;

    if (span) {
      traceId = span.context.traceId;
      spanId = span.context.spanId;
      parentSpanId = span.context.parentSpanId;
    } else {
      if (!this.orphanWarned) {
        log.warn('emit() called without active span — using fallback traceId', {
          sessionId: this.sessionId,
          eventType: event.type,
        });
        this.orphanWarned = true;
      }
      traceId = this.fallbackTraceId;
    }

    this.writePipeline.write({
      ...event,
      timestamp: new Date(),
      sessionId: this.sessionId,
      traceId,
      spanId,
      parentSpanId,
      tenantId: this.tenantId,
      projectId: this.projectId,
    });
  }

  continueFrom(context: SpanContext, name: string): Span {
    const spanId = generateSpanId();
    const childContext: SpanContext = {
      traceId: context.traceId,
      spanId,
      parentSpanId: context.spanId,
    };

    return new SpanImpl({
      name,
      context: childContext,
      writePipeline: this.writePipeline,
      sessionId: this.sessionId,
      tenantId: this.tenantId,
      projectId: this.projectId,
    });
  }
}
