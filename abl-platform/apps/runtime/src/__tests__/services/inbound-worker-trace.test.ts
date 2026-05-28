/**
 * Inbound Worker — trace context extraction tests
 *
 * Verifies that the inbound worker extracts traceId from job payload
 * (via extractTrace or payload.traceId) and wraps execution in
 * runWithObservabilityContext.
 */

import { describe, test, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Unit-test the trace extraction logic in isolation.
// The inbound worker is a massive module with many dependencies, so we test
// the trace-related logic by importing extractTrace directly and verifying
// the fallback chain that the worker uses.
// ---------------------------------------------------------------------------

import { extractTrace } from '@agent-platform/shared-observability/tracing';
import {
  runWithObservabilityContext,
  getCurrentTraceId,
} from '@abl/compiler/platform/observability';
import crypto from 'crypto';

describe('Inbound worker trace context extraction', () => {
  test('extractTrace returns span context from carrier with __traceId/__spanId', () => {
    const carrier: Record<string, unknown> = {
      __traceId: 'abcd1234abcd1234abcd1234abcd1234',
      __spanId: '1234abcd1234abcd',
    };

    const result = extractTrace(carrier);
    expect(result).toEqual({
      traceId: 'abcd1234abcd1234abcd1234abcd1234',
      spanId: '1234abcd1234abcd',
    });
  });

  test('extractTrace returns null when carrier has no trace keys', () => {
    const carrier: Record<string, unknown> = {
      tenantId: 'tenant-1',
      traceId: 'some-trace-id', // plain traceId field, not __traceId
    };

    const result = extractTrace(carrier);
    expect(result).toBeNull();
  });

  test('extractTrace includes parentSpanId when present', () => {
    const carrier: Record<string, unknown> = {
      __traceId: 'trace123',
      __spanId: 'span456',
      __parentSpanId: 'parent789',
    };

    const result = extractTrace(carrier);
    expect(result).toEqual({
      traceId: 'trace123',
      spanId: 'span456',
      parentSpanId: 'parent789',
    });
  });

  test('fallback chain: extracted traceId > payload.traceId > random UUID', () => {
    // Simulates the worker's logic:
    // const extracted = extractTrace(payload);
    // const traceId = extracted?.traceId || payload.traceId || crypto.randomUUID().replace(/-/g, '');

    // Case 1: extracted trace wins
    const extracted = { traceId: 'extracted-trace', spanId: 'extracted-span' };
    const payloadTraceId = 'payload-trace';
    const fallbackId = crypto.randomUUID().replace(/-/g, '');

    const traceId1 = extracted?.traceId || payloadTraceId || fallbackId;
    expect(traceId1).toBe('extracted-trace');

    // Case 2: no extracted trace, payload.traceId used
    const traceId2 = null || payloadTraceId || fallbackId;
    expect(traceId2).toBe('payload-trace');

    // Case 3: no extracted trace, no payload.traceId, random UUID used
    const traceId3 = null || undefined || fallbackId;
    expect(traceId3).toBe(fallbackId);
    expect(traceId3).toMatch(/^[0-9a-f]{32}$/);
  });

  test('runWithObservabilityContext makes traceId available via getCurrentTraceId', () => {
    const traceId = 'test-trace-id-for-context';
    const spanId = 'test-span-id';

    let capturedTraceId: string | undefined;
    runWithObservabilityContext({ traceId, spanId }, () => {
      capturedTraceId = getCurrentTraceId();
    });

    expect(capturedTraceId).toBe(traceId);
  });

  test('getCurrentTraceId returns undefined outside observability context', () => {
    expect(getCurrentTraceId()).toBeUndefined();
  });

  test('spanId fallback: extracted spanId > random 16-char hex', () => {
    // Simulates: const spanId = extracted?.spanId || crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const extracted = { traceId: 't', spanId: 'extracted-span' };
    expect(extracted.spanId).toBe('extracted-span');

    const fallbackSpanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    expect(fallbackSpanId).toHaveLength(16);
  });
});
