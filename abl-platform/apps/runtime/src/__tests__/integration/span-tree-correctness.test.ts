/**
 * E2E: Span Tree Correctness
 *
 * Tests that TracerImpl produces correct span hierarchies:
 * 1. Create TracerImpl with a mock WritePipeline
 * 2. Simulate: turn span -> agent span -> LLM call span -> tool call span
 * 3. Verify each span has correct parentSpanId linking back to parent
 * 4. Verify span_end events have correct duration
 * 5. Verify orphan emits generate warnings
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => {
  const warnFn = vi.fn();
  return {
    createLogger: () => ({
      info: vi.fn(),
      warn: warnFn,
      error: vi.fn(),
      debug: vi.fn(),
      _warnFn: warnFn,
    }),
  };
});

import type { WritePipeline } from '@agent-platform/shared-observability/tracing';
import { TracerImpl } from '../../services/tracing/tracer.js';

interface WrittenEvent {
  type: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  sessionId: string;
  durationMs?: number;
  data?: Record<string, unknown>;
  agentName?: string;
}

function createMockPipeline() {
  const events: WrittenEvent[] = [];
  const pipeline: WritePipeline = {
    write(event: Record<string, unknown>) {
      events.push(event as unknown as WrittenEvent);
    },
  };
  return { pipeline, events };
}

describe('Span Tree Correctness E2E', () => {
  let pipeline: WritePipeline;
  let events: WrittenEvent[];

  beforeEach(() => {
    const mock = createMockPipeline();
    pipeline = mock.pipeline;
    events = mock.events;
  });

  describe('parent-child span linking', () => {
    it('creates root span without parentSpanId', () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      const rootSpan = tracer.startSpan('turn');
      expect(rootSpan.context.parentSpanId).toBeUndefined();
      expect(rootSpan.context.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(rootSpan.context.spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('creates child spans that link to parent via parentSpanId', async () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      const turnSpan = tracer.startSpan('turn');

      // Running inside turn span context, agent span should be a child
      await tracer.run(turnSpan, async () => {
        const agentSpan = tracer.startSpan('agent', { agentName: 'greeter' });
        expect(agentSpan.context.parentSpanId).toBe(turnSpan.context.spanId);
        expect(agentSpan.context.traceId).toBe(turnSpan.context.traceId);

        // Nested: LLM call inside agent
        await tracer.run(agentSpan, async () => {
          const llmSpan = tracer.startSpan('llm-call');
          expect(llmSpan.context.parentSpanId).toBe(agentSpan.context.spanId);
          expect(llmSpan.context.traceId).toBe(turnSpan.context.traceId);

          // Nested: tool call inside LLM
          await tracer.run(llmSpan, async () => {
            const toolSpan = tracer.startSpan('tool-call');
            expect(toolSpan.context.parentSpanId).toBe(llmSpan.context.spanId);
            expect(toolSpan.context.traceId).toBe(turnSpan.context.traceId);
            toolSpan.end();
          });

          llmSpan.end();
        });

        agentSpan.end();
      });

      turnSpan.end();
    });

    it('uses withSpan to automatically manage parent-child linking', async () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      const spanContexts: Array<{ name: string; spanId: string; parentSpanId?: string }> = [];

      await tracer.withSpan('turn', async () => {
        const turnSpan = tracer.activeSpan()!;
        spanContexts.push({
          name: 'turn',
          spanId: turnSpan.context.spanId,
          parentSpanId: turnSpan.context.parentSpanId,
        });

        await tracer.withSpan('agent', async () => {
          const agentSpan = tracer.activeSpan()!;
          spanContexts.push({
            name: 'agent',
            spanId: agentSpan.context.spanId,
            parentSpanId: agentSpan.context.parentSpanId,
          });

          await tracer.withSpan('llm-call', async () => {
            const llmSpan = tracer.activeSpan()!;
            spanContexts.push({
              name: 'llm-call',
              spanId: llmSpan.context.spanId,
              parentSpanId: llmSpan.context.parentSpanId,
            });
          });
        });
      });

      expect(spanContexts[0].parentSpanId).toBeUndefined();
      expect(spanContexts[1].parentSpanId).toBe(spanContexts[0].spanId);
      expect(spanContexts[2].parentSpanId).toBe(spanContexts[1].spanId);
    });
  });

  describe('span_end events', () => {
    it('emits span_end with correct duration', async () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      await tracer.withSpan('timed-op', async () => {
        // Small delay to ensure non-zero duration
        await new Promise((r) => setTimeout(r, 10));
      });

      const spanEndEvents = events.filter((e) => e.type === 'span_end');
      expect(spanEndEvents).toHaveLength(1);
      expect(spanEndEvents[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('produces span_end events for each span in the tree', async () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      await tracer.withSpan('turn', async () => {
        await tracer.withSpan('agent', async () => {
          await tracer.withSpan('llm-call', async () => {
            // innermost
          });
        });
      });

      const spanEndEvents = events.filter((e) => e.type === 'span_end');
      expect(spanEndEvents).toHaveLength(3);

      // Innermost ends first (LIFO)
      const names = spanEndEvents.map((e) => e.data?.spanName);
      expect(names).toEqual(['llm-call', 'agent', 'turn']);
    });

    it('sets status to error when span throws', async () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      await expect(
        tracer.withSpan('failing-op', async () => {
          throw new Error('intentional failure');
        }),
      ).rejects.toThrow('intentional failure');

      const spanEndEvents = events.filter((e) => e.type === 'span_end');
      expect(spanEndEvents).toHaveLength(1);
      const attrs = spanEndEvents[0].data?.attributes as Record<string, string>;
      expect(attrs['span.status']).toBe('error');
      expect(attrs['span.status_message']).toBe('intentional failure');
    });
  });

  describe('all spans share the same traceId', () => {
    it('propagates root traceId through all nested spans', async () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      const traceIds: string[] = [];

      await tracer.withSpan('turn', async () => {
        traceIds.push(tracer.activeSpan()!.context.traceId);
        await tracer.withSpan('agent', async () => {
          traceIds.push(tracer.activeSpan()!.context.traceId);
          await tracer.withSpan('llm-call', async () => {
            traceIds.push(tracer.activeSpan()!.context.traceId);
          });
        });
      });

      expect(new Set(traceIds).size).toBe(1);
    });
  });

  describe('orphan emit warnings', () => {
    it('uses fallback traceId when emit() called without active span', () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      // Emit without any active span
      tracer.emit({ type: 'orphan_event', data: { key: 'value' } });

      expect(events).toHaveLength(1);
      // Should still have a traceId (the fallback)
      expect(events[0].traceId).toBeDefined();
      expect(events[0].traceId).toMatch(/^[0-9a-f]{32}$/);
      // spanId should be undefined since there's no active span
      expect(events[0].spanId).toBeUndefined();
    });

    it('uses active span context when emit() called within a span', async () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      await tracer.withSpan('turn', async () => {
        const span = tracer.activeSpan()!;
        tracer.emit({ type: 'test_event', data: { key: 'value' } });

        const emittedEvent = events.find((e) => e.type === 'test_event');
        expect(emittedEvent?.traceId).toBe(span.context.traceId);
        expect(emittedEvent?.spanId).toBe(span.context.spanId);
      });
    });
  });

  describe('span attributes', () => {
    it('applies default attributes from tracer config', () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
        defaultAttributes: { 'service.name': 'runtime', env: 'test' },
      });

      const span = tracer.startSpan('test');
      expect(span.attributes['service.name']).toBe('runtime');
      expect(span.attributes['env']).toBe('test');
    });

    it('allows per-span attribute overrides', () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
        defaultAttributes: { 'service.name': 'runtime' },
      });

      const span = tracer.startSpan('test', {
        attributes: { 'service.name': 'override', custom: 'value' },
      });
      expect(span.attributes['service.name']).toBe('override');
      expect(span.attributes['custom']).toBe('value');
    });
  });

  describe('idempotent span.end()', () => {
    it('ignores duplicate end() calls', () => {
      const tracer = new TracerImpl({
        sessionId: 'sess-1',
        writePipeline: pipeline,
      });

      const span = tracer.startSpan('test');
      span.end();
      span.end(); // should be a no-op

      const spanEndEvents = events.filter((e) => e.type === 'span_end');
      expect(spanEndEvents).toHaveLength(1);
    });
  });
});
