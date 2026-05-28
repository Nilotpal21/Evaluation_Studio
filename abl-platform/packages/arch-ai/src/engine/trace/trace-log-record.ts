/**
 * TraceLogRecord — wire format for arch-ai turn engine trace emission.
 *
 * Inlined from arch-observability-contracts. The engine emits these records
 * through an injected TraceEmitter; observability providers consume them.
 */

import type { SpanError, SpanStatus, TraceStatus } from './errors.js';

export interface TraceLogEnvelope {
  recordId: string;
  seq: number;
  traceId: string;
  sessionId: string;
  projectId?: string;
  tenantId: string;
  userId: string;
  emittedAt: number;
  schemaVersion: 1;
}

export interface TraceStartedRecord extends TraceLogEnvelope {
  kind: 'trace_started';
  startedAt: number;
  attributes: Record<string, unknown>;
}

export interface SpanStartedRecord extends TraceLogEnvelope {
  kind: 'span_started';
  spanId: string;
  parentSpanId?: string;
  spanKind: string;
  name: string;
  startedAt: number;
  attributes: Record<string, unknown>;
}

export interface SpanEventRecord extends TraceLogEnvelope {
  kind: 'span_event';
  spanId: string;
  ts: number;
  name: string;
  attributes: Record<string, unknown>;
}

export interface SpanEndedRecord extends TraceLogEnvelope {
  kind: 'span_ended';
  spanId: string;
  endedAt: number;
  status: SpanStatus;
  error?: SpanError;
  attributes: Record<string, unknown>;
}

export interface TraceEndedRecord extends TraceLogEnvelope {
  kind: 'trace_ended';
  endedAt: number;
  status: TraceStatus;
  attributes: Record<string, unknown>;
}

export type TraceLogRecord =
  | TraceStartedRecord
  | SpanStartedRecord
  | SpanEventRecord
  | SpanEndedRecord
  | TraceEndedRecord;

export type TraceLogRecordKind = TraceLogRecord['kind'];
