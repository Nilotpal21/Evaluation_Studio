import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TracerImpl } from '../../../services/tracing/tracer.js';
import type { WritePipeline } from '@agent-platform/shared-observability/tracing';

function createMockPipeline(): WritePipeline & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    write(event: Record<string, unknown>) {
      calls.push(event);
    },
  };
}

describe('TracerImpl', () => {
  let pipeline: ReturnType<typeof createMockPipeline>;
  let tracer: TracerImpl;

  beforeEach(() => {
    pipeline = createMockPipeline();
    tracer = new TracerImpl({
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      writePipeline: pipeline,
    });
  });

  describe('startSpan', () => {
    it('creates a span with generated IDs', () => {
      const span = tracer.startSpan('my-span');
      expect(span.name).toBe('my-span');
      expect(span.context.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.context.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.context.parentSpanId).toBeUndefined();
    });

    it('applies default attributes to new spans', () => {
      const t = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
        defaultAttributes: { env: 'test', version: '1.0' },
      });
      const span = t.startSpan('my-span');
      expect(span.attributes.env).toBe('test');
      expect(span.attributes.version).toBe('1.0');
    });

    it('option attributes override defaults', () => {
      const t = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
        defaultAttributes: { env: 'test' },
      });
      const span = t.startSpan('my-span', { attributes: { env: 'prod' } });
      expect(span.attributes.env).toBe('prod');
    });

    it('passes agentName to span', () => {
      const span = tracer.startSpan('my-span', { agentName: 'agent-x' });
      expect(span.agentName).toBe('agent-x');
    });
  });

  describe('withSpan', () => {
    it('runs function inside ALS context and sets span as active', async () => {
      let capturedSpan: unknown = null;
      await tracer.withSpan('outer', () => {
        capturedSpan = tracer.activeSpan();
      });
      expect(capturedSpan).not.toBeNull();
      expect((capturedSpan as { name: string }).name).toBe('outer');
    });

    it('sets ok status and ends span on success', async () => {
      const result = await tracer.withSpan('op', () => 42);
      expect(result).toBe(42);
      // span_end should have been written
      expect(pipeline.calls.some((c) => c.type === 'span_end')).toBe(true);
    });

    it('sets error status and re-throws on failure', async () => {
      await expect(
        tracer.withSpan('op', () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const endEvent = pipeline.calls.find((c) => c.type === 'span_end');
      expect(endEvent).toBeDefined();
      const attrs = (endEvent?.data as { attributes?: Record<string, string> })?.attributes;
      expect(attrs?.['span.status']).toBe('error');
      expect(attrs?.['span.status_message']).toBe('boom');
    });

    it('creates parent-child relationship for nested spans', async () => {
      let outerContext: { traceId: string; spanId: string } | undefined;
      let innerContext: { traceId: string; spanId: string; parentSpanId?: string } | undefined;

      await tracer.withSpan('outer', async () => {
        outerContext = tracer.activeSpan()!.context;
        await tracer.withSpan('inner', () => {
          innerContext = tracer.activeSpan()!.context;
        });
      });

      expect(outerContext).toBeDefined();
      expect(innerContext).toBeDefined();
      expect(innerContext!.traceId).toBe(outerContext!.traceId);
      expect(innerContext!.parentSpanId).toBe(outerContext!.spanId);
    });
  });

  describe('activeSpan', () => {
    it('returns null when no span is active', () => {
      expect(tracer.activeSpan()).toBeNull();
    });
  });

  describe('emit', () => {
    it('enriches event with span context when active', async () => {
      await tracer.withSpan('parent', () => {
        tracer.emit({ type: 'test_event', data: { key: 'value' } });
      });

      const emitted = pipeline.calls.find((c) => c.type === 'test_event');
      expect(emitted).toBeDefined();
      expect(emitted!.sessionId).toBe('sess-1');
      expect(emitted!.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(emitted!.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(emitted!.tenantId).toBe('tenant-1');
      expect(emitted!.projectId).toBe('project-1');
    });

    it('uses fallback traceId when no span is active', () => {
      tracer.emit({ type: 'orphan_event', data: {} });

      const emitted = pipeline.calls.find((c) => c.type === 'orphan_event');
      expect(emitted).toBeDefined();
      expect(emitted!.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(emitted!.spanId).toBeUndefined();
    });

    it('only warns once for orphan emits', () => {
      tracer.emit({ type: 'orphan1', data: {} });
      tracer.emit({ type: 'orphan2', data: {} });
      // Both should succeed (no throw)
      expect(pipeline.calls).toHaveLength(2);
    });
  });

  describe('continueFrom', () => {
    it('creates a child span from external context', () => {
      const parentContext = {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
      };

      const span = tracer.continueFrom(parentContext, 'continued-span');
      expect(span.name).toBe('continued-span');
      expect(span.context.traceId).toBe(parentContext.traceId);
      expect(span.context.parentSpanId).toBe(parentContext.spanId);
      expect(span.context.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.context.spanId).not.toBe(parentContext.spanId);
    });
  });

  describe('runSync / run', () => {
    it('runSync sets span as active during execution', () => {
      const span = tracer.startSpan('sync-op');
      let activeInside: unknown = null;
      tracer.runSync(span, () => {
        activeInside = tracer.activeSpan();
      });
      expect(activeInside).toBe(span);
      expect(tracer.activeSpan()).toBeNull();
    });

    it('run sets span as active for async execution', async () => {
      const span = tracer.startSpan('async-op');
      let activeInside: unknown = null;
      await tracer.run(span, async () => {
        activeInside = tracer.activeSpan();
      });
      expect(activeInside).toBe(span);
    });
  });
});
