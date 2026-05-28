/**
 * BullMQ Trace Propagation Round-Trip Integration Tests
 *
 * Tests inject → extract round-trip for trace context propagation:
 * - Full span context (traceId + spanId + parentSpanId) survives round-trip
 * - traceId + spanId only (no parentSpanId) — backward compat
 * - Missing context returns null
 * - Carrier with extra fields is not corrupted
 * - Non-string values in carrier are handled gracefully
 */

import { describe, it, expect } from 'vitest';
import { injectTrace, extractTrace, generateTraceId, generateSpanId } from '../../tracing/index.js';
import type { SpanContext } from '../../tracing/index.js';

describe('BullMQ trace propagation round-trip', () => {
  it('round-trips full span context (traceId + spanId + parentSpanId)', () => {
    const carrier: Record<string, unknown> = {};
    const context: SpanContext = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: generateSpanId(),
    };

    injectTrace(carrier, context);
    const extracted = extractTrace(carrier);

    expect(extracted).toEqual(context);
    expect(extracted!.traceId).toBe(context.traceId);
    expect(extracted!.spanId).toBe(context.spanId);
    expect(extracted!.parentSpanId).toBe(context.parentSpanId);
  });

  it('round-trips traceId + spanId without parentSpanId (backward compat)', () => {
    const carrier: Record<string, unknown> = {};
    const context: SpanContext = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
    };

    injectTrace(carrier, context);
    const extracted = extractTrace(carrier);

    expect(extracted).toBeDefined();
    expect(extracted!.traceId).toBe(context.traceId);
    expect(extracted!.spanId).toBe(context.spanId);
    expect(extracted!.parentSpanId).toBeUndefined();
  });

  it('returns null when carrier has no trace context', () => {
    const carrier: Record<string, unknown> = {
      jobType: 'ingest',
      priority: 1,
    };

    const extracted = extractTrace(carrier);
    expect(extracted).toBeNull();
  });

  it('returns null for non-string traceId/spanId values', () => {
    expect(extractTrace({ __traceId: 123, __spanId: 456 })).toBeNull();
    expect(extractTrace({ __traceId: null, __spanId: null })).toBeNull();
    expect(extractTrace({ __traceId: undefined, __spanId: undefined })).toBeNull();
    expect(extractTrace({ __traceId: true, __spanId: false })).toBeNull();
  });

  it('returns null when only traceId is present (missing spanId)', () => {
    const carrier: Record<string, unknown> = {
      __traceId: generateTraceId(),
    };

    expect(extractTrace(carrier)).toBeNull();
  });

  it('returns null when only spanId is present (missing traceId)', () => {
    const carrier: Record<string, unknown> = {
      __spanId: generateSpanId(),
    };

    expect(extractTrace(carrier)).toBeNull();
  });

  it('preserves existing carrier properties after injection', () => {
    const carrier: Record<string, unknown> = {
      jobType: 'connector-sync',
      priority: 5,
      payload: { docId: 'doc-123' },
    };

    const context: SpanContext = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
    };

    injectTrace(carrier, context);

    // Original fields untouched
    expect(carrier.jobType).toBe('connector-sync');
    expect(carrier.priority).toBe(5);
    expect(carrier.payload).toEqual({ docId: 'doc-123' });

    // Trace context added
    const extracted = extractTrace(carrier);
    expect(extracted!.traceId).toBe(context.traceId);
  });

  it('handles re-injection (overwrite) correctly', () => {
    const carrier: Record<string, unknown> = {};

    const context1: SpanContext = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
    };
    injectTrace(carrier, context1);

    const context2: SpanContext = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: generateSpanId(),
    };
    injectTrace(carrier, context2);

    const extracted = extractTrace(carrier);
    expect(extracted).toEqual(context2);
    expect(extracted!.traceId).toBe(context2.traceId);
    expect(extracted!.traceId).not.toBe(context1.traceId);
  });

  it('simulates BullMQ job payload round-trip', () => {
    // Simulate a typical BullMQ job payload
    const jobPayload: Record<string, unknown> = {
      connectorId: 'conn-sharepoint-1',
      tenantId: 'tenant-abc',
      projectId: 'proj-xyz',
      syncType: 'delta',
      pageToken: 'next-page-token',
    };

    // Producer side: inject trace context before adding job
    const producerContext: SpanContext = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: generateSpanId(),
    };
    injectTrace(jobPayload, producerContext);

    // Simulate serialization/deserialization (BullMQ stores as JSON)
    const serialized = JSON.stringify(jobPayload);
    const deserialized = JSON.parse(serialized) as Record<string, unknown>;

    // Consumer side: extract trace context from job payload
    const consumerContext = extractTrace(deserialized);

    expect(consumerContext).toBeDefined();
    expect(consumerContext!.traceId).toBe(producerContext.traceId);
    expect(consumerContext!.spanId).toBe(producerContext.spanId);
    expect(consumerContext!.parentSpanId).toBe(producerContext.parentSpanId);

    // Original payload fields survive
    expect(deserialized.connectorId).toBe('conn-sharepoint-1');
    expect(deserialized.tenantId).toBe('tenant-abc');
  });

  it('works with empty parentSpanId in round-trip through JSON', () => {
    const carrier: Record<string, unknown> = {};
    const context: SpanContext = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      // No parentSpanId
    };

    injectTrace(carrier, context);

    // Serialize/deserialize
    const roundTripped = JSON.parse(JSON.stringify(carrier)) as Record<string, unknown>;
    const extracted = extractTrace(roundTripped);

    expect(extracted).toBeDefined();
    expect(extracted!.traceId).toBe(context.traceId);
    expect(extracted!.spanId).toBe(context.spanId);
    expect(extracted!.parentSpanId).toBeUndefined();
  });
});
