/**
 * SpanImpl — Represents a unit of work within a trace.
 *
 * Idempotent end() — double-end is a no-op with a warning log.
 */

import type {
  Span,
  SpanContext,
  WritePipeline,
} from '@agent-platform/shared-observability/tracing';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('span-impl');

export interface SpanImplConfig {
  name: string;
  context: SpanContext;
  writePipeline: WritePipeline;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  agentName?: string;
}

export class SpanImpl implements Span {
  readonly name: string;
  readonly context: SpanContext;
  agentName?: string;
  attributes: Record<string, string> = {};

  private readonly writePipeline: WritePipeline;
  private readonly sessionId: string;
  private readonly tenantId?: string;
  private readonly projectId?: string;
  private readonly startTime: number;
  private ended = false;

  constructor(config: SpanImplConfig) {
    this.name = config.name;
    this.context = config.context;
    this.writePipeline = config.writePipeline;
    this.sessionId = config.sessionId;
    this.tenantId = config.tenantId;
    this.projectId = config.projectId;
    this.agentName = config.agentName;
    this.startTime = Date.now();
  }

  setAttribute(key: string, value: string): void {
    this.attributes[key] = value;
  }

  addEvent(name: string, data?: Record<string, unknown>): void {
    this.writePipeline.write({
      type: name,
      timestamp: new Date(),
      sessionId: this.sessionId,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      tenantId: this.tenantId,
      projectId: this.projectId,
      agentName: this.agentName,
      data: data ?? {},
    });
  }

  setStatus(status: 'ok' | 'error', message?: string): void {
    this.attributes['span.status'] = status;
    if (message) {
      this.attributes['span.status_message'] = message;
    }
  }

  end(): void {
    if (this.ended) {
      log.warn('Span already ended, ignoring duplicate end()', {
        spanName: this.name,
        spanId: this.context.spanId,
      });
      return;
    }
    this.ended = true;

    const durationMs = Date.now() - this.startTime;
    this.writePipeline.write({
      type: 'span_end',
      timestamp: new Date(),
      durationMs,
      sessionId: this.sessionId,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      tenantId: this.tenantId,
      projectId: this.projectId,
      agentName: this.agentName,
      data: {
        spanName: this.name,
        attributes: this.attributes,
      },
    });
  }
}
