/**
 * TurnTraceRecorder — contract-compliant trace emission helper for TurnEngine.
 *
 * Keeps the engine instrumentation readable while centralizing:
 * - envelope construction
 * - seq assignment
 * - shared Arch attributes
 * - payload-capture gating
 * - attribute truncation / scrubbing
 */

import type {
  SpanError,
  SpanStatus,
  TraceEmitter,
  TraceLogRecord,
  TraceStatus,
} from './trace/index.js';
import {
  ARCH_PHASE,
  ARCH_SESSION_MODE,
  ARCH_SPECIALIST,
  ARCH_SPECIALIST_CHAIN,
  GEN_AI_CONVERSATION_ID,
  truncateAttributes,
} from './trace/index.js';

const PAYLOAD_CAPTURE_ENV = 'ARCH_OBSERVABILITY_CAPTURE_PAYLOADS' as const;

export interface TurnTraceRecorderOptions {
  traceEmitter?: TraceEmitter;
  traceId: string;
  sessionId: string;
  projectId?: string;
  tenantId: string;
  userId: string;
  phase: string;
  mode: 'onboarding' | 'in-project';
  specialist?: string;
  now: () => number;
  newId: () => string;
}

export interface StartSpanOptions {
  spanId?: string;
  parentSpanId?: string;
  spanKind: string;
  name: string;
  phase?: string;
  projectId?: string;
  attributes?: Record<string, unknown>;
}

export interface EmitSpanEventOptions {
  spanId: string;
  name: string;
  phase?: string;
  projectId?: string;
  attributes?: Record<string, unknown>;
}

export interface EndSpanOptions {
  spanId: string;
  status: SpanStatus;
  error?: SpanError;
  phase?: string;
  projectId?: string;
  attributes?: Record<string, unknown>;
}

export interface EndTraceOptions {
  status: TraceStatus;
  phase?: string;
  projectId?: string;
  attributes?: Record<string, unknown>;
}

export class TurnTraceRecorder {
  private seq = 0;
  private readonly capturePayloads = shouldCapturePayloads();

  constructor(private readonly opts: TurnTraceRecorderOptions) {}

  createSpanId(prefix: string): string {
    return `${prefix}_${this.opts.newId()}`;
  }

  startTrace(attributes: Record<string, unknown> = {}): void {
    this.emitRecord({
      ...this.baseEnvelope(),
      kind: 'trace_started',
      startedAt: this.opts.now(),
      attributes: this.mergeTraceAttributes(attributes, this.opts.phase),
    });
  }

  startSpan(options: StartSpanOptions): string {
    const spanId = options.spanId ?? this.createSpanId(options.spanKind);
    this.emitRecord({
      ...this.baseEnvelope(options.projectId),
      kind: 'span_started',
      spanId,
      parentSpanId: options.parentSpanId,
      spanKind: options.spanKind,
      name: options.name,
      startedAt: this.opts.now(),
      projectId: options.projectId,
      attributes: this.mergeSpanAttributes(options.attributes ?? {}, options.phase),
    });
    return spanId;
  }

  event(options: EmitSpanEventOptions): void {
    this.emitRecord({
      ...this.baseEnvelope(options.projectId),
      kind: 'span_event',
      spanId: options.spanId,
      ts: this.opts.now(),
      name: options.name,
      attributes: this.mergeSpanAttributes(options.attributes ?? {}, options.phase),
    });
  }

  endSpan(options: EndSpanOptions): void {
    this.emitRecord({
      ...this.baseEnvelope(options.projectId),
      kind: 'span_ended',
      spanId: options.spanId,
      endedAt: this.opts.now(),
      status: options.status,
      error: options.error,
      attributes: this.mergeSpanAttributes(options.attributes ?? {}, options.phase),
    });
  }

  endTrace(options: EndTraceOptions): void {
    this.emitRecord({
      ...this.baseEnvelope(options.projectId),
      kind: 'trace_ended',
      endedAt: this.opts.now(),
      status: options.status,
      attributes: this.mergeTraceAttributes(options.attributes ?? {}, options.phase),
    });
  }

  payloadAttributes(key: string, value: unknown): Record<string, unknown> {
    if (!this.capturePayloads || value === undefined) {
      return {};
    }
    return { [key]: value };
  }

  private mergeTraceAttributes(
    attributes: Record<string, unknown>,
    phase = this.opts.phase,
  ): Record<string, unknown> {
    return truncateAttributes({
      [ARCH_SESSION_MODE]: this.opts.mode,
      [ARCH_PHASE]: phase,
      [GEN_AI_CONVERSATION_ID]: this.opts.sessionId,
      ...(this.opts.specialist
        ? {
            [ARCH_SPECIALIST]: this.opts.specialist,
            [ARCH_SPECIALIST_CHAIN]: [this.opts.specialist],
          }
        : {}),
      ...attributes,
    });
  }

  private mergeSpanAttributes(
    attributes: Record<string, unknown>,
    phase = this.opts.phase,
  ): Record<string, unknown> {
    return truncateAttributes({
      [ARCH_PHASE]: phase,
      ...(this.opts.specialist ? { [ARCH_SPECIALIST]: this.opts.specialist } : {}),
      ...attributes,
    });
  }

  private baseEnvelope(projectId?: string) {
    return {
      recordId: this.opts.newId(),
      seq: this.seq++,
      traceId: this.opts.traceId,
      sessionId: this.opts.sessionId,
      projectId: projectId ?? this.opts.projectId,
      tenantId: this.opts.tenantId,
      userId: this.opts.userId,
      emittedAt: this.opts.now(),
      schemaVersion: 1 as const,
    };
  }

  private emitRecord(record: TraceLogRecord): void {
    const emitter = this.opts.traceEmitter;
    if (!emitter) {
      return;
    }

    try {
      emitter.emit(record);
    } catch {
      // Trace emission must never break the turn path.
    }
  }
}

function shouldCapturePayloads(): boolean {
  return process.env[PAYLOAD_CAPTURE_ENV] === 'true';
}
