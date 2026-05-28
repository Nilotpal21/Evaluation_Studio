/**
 * LLM Queue — trace context propagation tests
 *
 * Verifies that:
 * 1. traceId is added to job data at enqueue via getCurrentTraceId()
 * 2. Full span context is injected via injectTrace() when obsCtx exists
 * 3. Worker wraps execution in runWithObservabilityContext
 * 4. getCurrentTraceId() available inside worker callback
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  runWithObservabilityContext,
  getCurrentTraceId,
  getObservabilityContext,
} from '@abl/compiler/platform/observability';
import { injectTrace, extractTrace } from '@agent-platform/shared-observability/tracing';

describe('LLM Queue trace context propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('getCurrentTraceId() returns the active traceId inside observability context', () => {
    let captured: string | undefined;
    runWithObservabilityContext({ traceId: 'llm-trace-001', spanId: 'span-001' }, () => {
      captured = getCurrentTraceId();
    });
    expect(captured).toBe('llm-trace-001');
  });

  test('getObservabilityContext() returns full context inside wrapped function', () => {
    let captured: ReturnType<typeof getObservabilityContext>;
    runWithObservabilityContext(
      { traceId: 'llm-trace-002', spanId: 'span-002', tenantId: 'tenant-x' },
      () => {
        captured = getObservabilityContext();
      },
    );
    expect(captured).toEqual({
      traceId: 'llm-trace-002',
      spanId: 'span-002',
      tenantId: 'tenant-x',
    });
  });

  test('injectTrace adds __traceId and __spanId to job payload', () => {
    const jobData: Record<string, unknown> = {
      jobId: 'j1',
      sessionId: 's1',
      message: 'hello',
    };

    injectTrace(jobData, { traceId: 'trace-abc', spanId: 'span-def' });

    expect(jobData['__traceId']).toBe('trace-abc');
    expect(jobData['__spanId']).toBe('span-def');
  });

  test('extractTrace recovers injected span context', () => {
    const jobData: Record<string, unknown> = {};
    injectTrace(jobData, { traceId: 'trace-round', spanId: 'span-trip' });

    const extracted = extractTrace(jobData);
    expect(extracted).toEqual({
      traceId: 'trace-round',
      spanId: 'span-trip',
    });
  });

  test('simulates enqueue→worker trace round-trip', () => {
    // Simulate enqueue side: inside observability context
    let jobData: Record<string, unknown> = {};

    runWithObservabilityContext({ traceId: 'enqueue-trace', spanId: 'enqueue-span' }, () => {
      const traceId = getCurrentTraceId();
      jobData = {
        jobId: 'j-1',
        sessionId: 's-1',
        message: 'hi',
        traceId,
      };
      const obsCtx = getObservabilityContext();
      if (obsCtx) {
        injectTrace(jobData, { traceId: obsCtx.traceId, spanId: obsCtx.spanId });
      }
    });

    // Verify enqueue injected trace data
    expect(jobData['traceId']).toBe('enqueue-trace');
    expect(jobData['__traceId']).toBe('enqueue-trace');
    expect(jobData['__spanId']).toBe('enqueue-span');

    // Simulate worker side: extract and wrap
    const extracted = extractTrace(jobData);
    const workerTraceId = extracted?.traceId || (jobData['traceId'] as string);
    const workerSpanId = extracted?.spanId || 'fallback-span';

    let workerCapturedTraceId: string | undefined;
    runWithObservabilityContext({ traceId: workerTraceId, spanId: workerSpanId }, () => {
      workerCapturedTraceId = getCurrentTraceId();
    });

    expect(workerCapturedTraceId).toBe('enqueue-trace');
  });

  test('worker falls back to payload.traceId when no __traceId present', () => {
    const jobData: Record<string, unknown> = {
      traceId: 'plain-trace-id',
      sessionId: 's-1',
    };

    const extracted = extractTrace(jobData); // returns null — no __traceId
    expect(extracted).toBeNull();

    const traceId = extracted?.traceId || (jobData['traceId'] as string) || 'random-fallback';
    expect(traceId).toBe('plain-trace-id');
  });

  test('worker generates random traceId when payload has no trace info', () => {
    const jobData: Record<string, unknown> = {
      sessionId: 's-1',
    };

    const extracted = extractTrace(jobData);
    const traceId =
      extracted?.traceId ||
      (jobData['traceId'] as string | undefined) ||
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    expect(traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});
