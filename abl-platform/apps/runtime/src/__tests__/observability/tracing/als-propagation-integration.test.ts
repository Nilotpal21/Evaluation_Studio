/**
 * ALS Propagation Integration Tests
 *
 * Tests that AsyncLocalStorage correctly propagates across async boundaries:
 * - TracerImpl's span storage works across await/async
 * - Two ALS systems (requestIdStorage + spanStorage) don't interfere
 * - Nested async contexts maintain correct span hierarchy
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { TracerImpl } from '../../../services/tracing/tracer.js';
import type { WritePipeline } from '@agent-platform/shared-observability/tracing';
import { requestIdMiddleware, getCurrentRequestId } from '@agent-platform/shared-observability';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNoopPipeline(): WritePipeline {
  return { write: vi.fn() };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ALS propagation for tracer span storage', () => {
  let tracer: TracerImpl;

  beforeEach(() => {
    tracer = new TracerImpl({
      sessionId: 'sess-als-1',
      writePipeline: createNoopPipeline(),
    });
  });

  it('activeSpan() works inside withSpan across await boundaries', async () => {
    let spanInAsync: string | undefined;

    await tracer.withSpan('parent', async () => {
      await delay(1);
      const span = tracer.activeSpan();
      spanInAsync = span?.name;
    });

    expect(spanInAsync).toBe('parent');
  });

  it('activeSpan() returns null outside of withSpan context', () => {
    expect(tracer.activeSpan()).toBeNull();
  });

  it('nested withSpan() maintains correct hierarchy across async', async () => {
    const captured: { name: string; parentSpanId?: string }[] = [];

    await tracer.withSpan('outer', async () => {
      const outerSpan = tracer.activeSpan()!;
      captured.push({
        name: outerSpan.name,
        parentSpanId: outerSpan.context.parentSpanId,
      });

      await delay(1);

      await tracer.withSpan('inner', async () => {
        await delay(1);
        const innerSpan = tracer.activeSpan()!;
        captured.push({
          name: innerSpan.name,
          parentSpanId: innerSpan.context.parentSpanId,
        });
      });

      // After inner completes, outer should be active again
      const afterInner = tracer.activeSpan()!;
      expect(afterInner.name).toBe('outer');
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].name).toBe('outer');
    expect(captured[0].parentSpanId).toBeUndefined();
    expect(captured[1].name).toBe('inner');
    // inner's parent should be outer's spanId
    expect(captured[1].parentSpanId).toBeDefined();
  });

  it('concurrent withSpan() calls maintain isolation', async () => {
    const results: { name: string; spanId: string }[] = [];

    await Promise.all([
      tracer.withSpan('span-a', async () => {
        await delay(5);
        const span = tracer.activeSpan()!;
        results.push({ name: span.name, spanId: span.context.spanId });
      }),
      tracer.withSpan('span-b', async () => {
        await delay(1);
        const span = tracer.activeSpan()!;
        results.push({ name: span.name, spanId: span.context.spanId });
      }),
    ]);

    expect(results).toHaveLength(2);
    const spanA = results.find((r) => r.name === 'span-a');
    const spanB = results.find((r) => r.name === 'span-b');
    expect(spanA).toBeDefined();
    expect(spanB).toBeDefined();
    expect(spanA!.spanId).not.toBe(spanB!.spanId);
  });

  it('run() sets span as active for sync code', () => {
    const span = tracer.startSpan('sync-span');
    let activeInside: string | undefined;

    tracer.runSync(span, () => {
      activeInside = tracer.activeSpan()?.name;
    });

    expect(activeInside).toBe('sync-span');
    expect(tracer.activeSpan()).toBeNull();
  });

  it('run() sets span as active for async code', async () => {
    const span = tracer.startSpan('async-span');
    let activeInside: string | undefined;

    await tracer.run(span, async () => {
      await delay(1);
      activeInside = tracer.activeSpan()?.name;
    });

    expect(activeInside).toBe('async-span');
  });
});

describe('Two ALS systems do not interfere', () => {
  it('requestIdStorage and tracer spanStorage are independent', async () => {
    const tracer = new TracerImpl({
      sessionId: 'sess-dual-als',
      writePipeline: createNoopPipeline(),
    });

    // Simulate request ID middleware
    const middleware = requestIdMiddleware();
    const mockReq = {
      headers: { 'x-request-id': 'req-12345' },
    } as unknown as import('express').Request;
    const mockRes = {
      setHeader: vi.fn(),
    } as unknown as import('express').Response;

    await new Promise<void>((resolve) => {
      middleware(mockReq, mockRes, () => {
        // Inside request context — requestId should be available
        const requestId = getCurrentRequestId();
        expect(requestId).toBe('req-12345');

        // Now run tracer.withSpan — it should NOT interfere with requestId
        tracer
          .withSpan('inside-request', async () => {
            // Span should be active
            const span = tracer.activeSpan();
            expect(span).not.toBeNull();
            expect(span!.name).toBe('inside-request');

            // Request ID should still be available (different ALS instance)
            const reqIdInSpan = getCurrentRequestId();
            expect(reqIdInSpan).toBe('req-12345');
          })
          .then(() => {
            // After span ends, request ID should still be available
            const reqIdAfterSpan = getCurrentRequestId();
            expect(reqIdAfterSpan).toBe('req-12345');

            // Span should be null outside withSpan
            expect(tracer.activeSpan()).toBeNull();

            resolve();
          });
      });
    });
  });

  it('span context survives across multiple awaits inside request context', async () => {
    const tracer = new TracerImpl({
      sessionId: 'sess-multi-await',
      writePipeline: createNoopPipeline(),
    });

    const middleware = requestIdMiddleware();
    const mockReq = {
      headers: { 'x-request-id': 'req-multi' },
    } as unknown as import('express').Request;
    const mockRes = {
      setHeader: vi.fn(),
    } as unknown as import('express').Response;

    await new Promise<void>((resolve) => {
      middleware(mockReq, mockRes, () => {
        tracer
          .withSpan('multi-await-span', async () => {
            await delay(1);
            expect(tracer.activeSpan()?.name).toBe('multi-await-span');
            expect(getCurrentRequestId()).toBe('req-multi');

            await delay(1);
            expect(tracer.activeSpan()?.name).toBe('multi-await-span');
            expect(getCurrentRequestId()).toBe('req-multi');

            await delay(1);
            expect(tracer.activeSpan()?.name).toBe('multi-await-span');
            expect(getCurrentRequestId()).toBe('req-multi');
          })
          .then(resolve);
      });
    });
  });
});
