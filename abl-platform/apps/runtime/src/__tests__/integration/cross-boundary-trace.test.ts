/**
 * E2E: Cross-Boundary Trace Propagation
 *
 * Tests that trace context survives serialization boundaries:
 * 1. Create trace context in "producer"
 * 2. injectTrace into a payload (simulating BullMQ enqueue)
 * 3. Serialize/deserialize the payload (JSON round-trip)
 * 4. extractTrace in "consumer"
 * 5. Verify traceId, spanId, parentSpanId survive the round-trip
 * 6. Create child span with continueFrom()
 * 7. Verify the child span's parent links back correctly
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  generateTraceId,
  generateSpanId,
  injectTrace,
  extractTrace,
} from '@agent-platform/shared-observability/tracing';
import type { SpanContext, WritePipeline } from '@agent-platform/shared-observability/tracing';
import { TracerImpl } from '../../services/tracing/tracer.js';

function createMockPipeline() {
  const events: Record<string, unknown>[] = [];
  const pipeline: WritePipeline = {
    write(event: Record<string, unknown>) {
      events.push(event);
    },
  };
  return { pipeline, events };
}

describe('Cross-Boundary Trace Propagation E2E', () => {
  describe('inject → serialize → deserialize → extract round-trip', () => {
    it('preserves traceId and spanId through JSON serialization', () => {
      const traceId = generateTraceId();
      const spanId = generateSpanId();

      const producerContext: SpanContext = { traceId, spanId };

      // Producer injects into carrier (simulates BullMQ job.data)
      const carrier: Record<string, unknown> = {
        jobType: 'process-message',
        payload: { text: 'hello' },
      };
      injectTrace(carrier, producerContext);

      // Simulate network boundary: JSON serialize then deserialize
      const serialized = JSON.stringify(carrier);
      const deserialized = JSON.parse(serialized) as Record<string, unknown>;

      // Consumer extracts
      const extractedContext = extractTrace(deserialized);

      expect(extractedContext).not.toBeNull();
      expect(extractedContext!.traceId).toBe(traceId);
      expect(extractedContext!.spanId).toBe(spanId);
    });

    it('preserves parentSpanId through JSON serialization', () => {
      const traceId = generateTraceId();
      const spanId = generateSpanId();
      const parentSpanId = generateSpanId();

      const context: SpanContext = { traceId, spanId, parentSpanId };
      const carrier: Record<string, unknown> = {};
      injectTrace(carrier, context);

      const roundTripped = JSON.parse(JSON.stringify(carrier)) as Record<string, unknown>;
      const extracted = extractTrace(roundTripped);

      expect(extracted!.parentSpanId).toBe(parentSpanId);
    });

    it('does not clobber existing payload fields', () => {
      const context: SpanContext = {
        traceId: generateTraceId(),
        spanId: generateSpanId(),
      };

      const carrier: Record<string, unknown> = {
        jobType: 'process-message',
        userId: 'user-123',
        data: { nested: true },
      };
      injectTrace(carrier, context);

      expect(carrier.jobType).toBe('process-message');
      expect(carrier.userId).toBe('user-123');
      expect(carrier.data).toEqual({ nested: true });
    });
  });

  describe('extractTrace with missing/invalid data', () => {
    it('returns null when carrier has no trace fields', () => {
      const result = extractTrace({ jobType: 'test' });
      expect(result).toBeNull();
    });

    it('returns null when traceId is not a string', () => {
      const result = extractTrace({ __traceId: 123, __spanId: 'valid' });
      expect(result).toBeNull();
    });

    it('returns null when spanId is not a string', () => {
      const result = extractTrace({ __traceId: 'valid', __spanId: null });
      expect(result).toBeNull();
    });

    it('omits parentSpanId when not present in carrier', () => {
      const carrier: Record<string, unknown> = {};
      injectTrace(carrier, {
        traceId: generateTraceId(),
        spanId: generateSpanId(),
      });

      const extracted = extractTrace(carrier);
      expect(extracted).not.toBeNull();
      expect(extracted!.parentSpanId).toBeUndefined();
    });
  });

  describe('continueFrom — child span in consumer process', () => {
    it('creates child span that links to producer span via parentSpanId', () => {
      const { pipeline } = createMockPipeline();

      // Producer side
      const producerTraceId = generateTraceId();
      const producerSpanId = generateSpanId();
      const producerContext: SpanContext = {
        traceId: producerTraceId,
        spanId: producerSpanId,
      };

      // Inject into carrier
      const carrier: Record<string, unknown> = { jobType: 'process' };
      injectTrace(carrier, producerContext);

      // Simulate JSON round-trip
      const deserialized = JSON.parse(JSON.stringify(carrier)) as Record<string, unknown>;

      // Consumer side
      const extractedContext = extractTrace(deserialized)!;
      const consumerTracer = new TracerImpl({
        sessionId: 'consumer-sess',
        writePipeline: pipeline,
      });

      const childSpan = consumerTracer.continueFrom(extractedContext, 'consumer-process');

      // Verify the child span links back to producer
      expect(childSpan.context.traceId).toBe(producerTraceId);
      expect(childSpan.context.parentSpanId).toBe(producerSpanId);
      // Child should have its own unique spanId
      expect(childSpan.context.spanId).not.toBe(producerSpanId);
      expect(childSpan.context.spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('allows nested spans within the consumer using the continued trace', async () => {
      const { pipeline, events } = createMockPipeline();

      // Producer context
      const producerContext: SpanContext = {
        traceId: generateTraceId(),
        spanId: generateSpanId(),
      };

      const carrier: Record<string, unknown> = {};
      injectTrace(carrier, producerContext);
      const extracted = extractTrace(
        JSON.parse(JSON.stringify(carrier)) as Record<string, unknown>,
      )!;

      // Consumer creates tracer and continues from extracted context
      const tracer = new TracerImpl({
        sessionId: 'consumer-sess',
        writePipeline: pipeline,
      });

      const rootSpan = tracer.continueFrom(extracted, 'consumer-root');

      await tracer.run(rootSpan, async () => {
        const childSpan = tracer.startSpan('consumer-child');
        expect(childSpan.context.traceId).toBe(producerContext.traceId);
        expect(childSpan.context.parentSpanId).toBe(rootSpan.context.spanId);
        childSpan.end();
      });

      rootSpan.end();

      // Both span_end events should reference the same traceId
      const spanEnds = events.filter((e) => e.type === 'span_end');
      expect(spanEnds).toHaveLength(2);
      for (const evt of spanEnds) {
        expect(evt.traceId).toBe(producerContext.traceId);
      }
    });
  });

  describe('full producer-consumer simulation', () => {
    it('end-to-end: producer enqueues job → consumer processes with linked trace', async () => {
      const { pipeline: producerPipeline, events: producerEvents } = createMockPipeline();
      const { pipeline: consumerPipeline, events: consumerEvents } = createMockPipeline();

      // --- Producer ---
      const producerTracer = new TracerImpl({
        sessionId: 'producer-sess',
        writePipeline: producerPipeline,
      });

      let jobPayload: Record<string, unknown> = {};

      await producerTracer.withSpan('handle-request', async () => {
        const activeSpan = producerTracer.activeSpan()!;

        // Simulate creating a BullMQ job
        jobPayload = { task: 'index-document', docId: 'doc-42' };
        injectTrace(jobPayload, activeSpan.context);
      });

      // --- Network boundary ---
      const serializedJob = JSON.stringify(jobPayload);
      const deserializedJob = JSON.parse(serializedJob) as Record<string, unknown>;

      // --- Consumer ---
      const extractedCtx = extractTrace(deserializedJob)!;
      expect(extractedCtx).not.toBeNull();

      const consumerTracer = new TracerImpl({
        sessionId: 'consumer-sess',
        writePipeline: consumerPipeline,
      });

      const consumerRoot = consumerTracer.continueFrom(extractedCtx, 'process-job');
      await consumerTracer.run(consumerRoot, async () => {
        await consumerTracer.withSpan('index-step', async () => {
          // Simulate work
        });
      });
      consumerRoot.end();

      // Verify trace continuity
      const producerTraceId = producerEvents.find((e) => e.type === 'span_end')?.traceId;
      const consumerTraceId = consumerEvents.find((e) => e.type === 'span_end')?.traceId;
      expect(producerTraceId).toBe(consumerTraceId);

      // Verify parent linking
      const consumerRootEnd = consumerEvents.find(
        (e) =>
          e.type === 'span_end' && (e.data as Record<string, unknown>)?.spanName === 'process-job',
      );
      expect(consumerRootEnd?.parentSpanId).toBe(extractedCtx.spanId);
    });
  });
});
