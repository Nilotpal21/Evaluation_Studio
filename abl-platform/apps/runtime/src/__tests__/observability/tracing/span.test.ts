import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpanImpl } from '../../../services/tracing/span.js';
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

function createSpan(
  overrides: Partial<ConstructorParameters<typeof SpanImpl>[0]> = {},
  pipeline?: ReturnType<typeof createMockPipeline>,
) {
  const wp = pipeline ?? createMockPipeline();
  return {
    span: new SpanImpl({
      name: 'test-span',
      context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
      writePipeline: wp,
      sessionId: 'sess-1',
      ...overrides,
    }),
    pipeline: wp,
  };
}

describe('SpanImpl', () => {
  describe('setAttribute', () => {
    it('stores key-value attributes', () => {
      const { span } = createSpan();
      span.setAttribute('key1', 'value1');
      span.setAttribute('key2', 'value2');
      expect(span.attributes).toEqual({ key1: 'value1', key2: 'value2' });
    });

    it('overwrites existing attributes', () => {
      const { span } = createSpan();
      span.setAttribute('key', 'old');
      span.setAttribute('key', 'new');
      expect(span.attributes.key).toBe('new');
    });
  });

  describe('addEvent', () => {
    it('writes event to pipeline with span context', () => {
      const { span, pipeline } = createSpan({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentName: 'agent-1',
      });

      span.addEvent('tool_call', { toolName: 'search' });

      expect(pipeline.calls).toHaveLength(1);
      const event = pipeline.calls[0];
      expect(event.type).toBe('tool_call');
      expect(event.sessionId).toBe('sess-1');
      expect(event.traceId).toBe('a'.repeat(32));
      expect(event.spanId).toBe('b'.repeat(16));
      expect(event.tenantId).toBe('tenant-1');
      expect(event.projectId).toBe('project-1');
      expect(event.agentName).toBe('agent-1');
      expect(event.data).toEqual({ toolName: 'search' });
    });

    it('defaults data to empty object when omitted', () => {
      const { span, pipeline } = createSpan();
      span.addEvent('checkpoint');
      expect(pipeline.calls[0].data).toEqual({});
    });
  });

  describe('setStatus', () => {
    it('sets ok status in attributes', () => {
      const { span } = createSpan();
      span.setStatus('ok');
      expect(span.attributes['span.status']).toBe('ok');
      expect(span.attributes['span.status_message']).toBeUndefined();
    });

    it('sets error status with message', () => {
      const { span } = createSpan();
      span.setStatus('error', 'something failed');
      expect(span.attributes['span.status']).toBe('error');
      expect(span.attributes['span.status_message']).toBe('something failed');
    });
  });

  describe('end', () => {
    it('writes span_end event with duration and attributes', () => {
      const { span, pipeline } = createSpan();
      span.setAttribute('foo', 'bar');
      span.end();

      expect(pipeline.calls).toHaveLength(1);
      const event = pipeline.calls[0];
      expect(event.type).toBe('span_end');
      expect(typeof event.durationMs).toBe('number');
      expect(event.durationMs as number).toBeGreaterThanOrEqual(0);
      expect(event.data).toEqual({
        spanName: 'test-span',
        attributes: { foo: 'bar' },
      });
    });

    it('is idempotent — second end() is a no-op', () => {
      const { span, pipeline } = createSpan();
      span.end();
      span.end();
      // Only one span_end event should be written
      expect(pipeline.calls).toHaveLength(1);
    });

    it('includes parentSpanId when present', () => {
      const { span, pipeline } = createSpan({
        context: {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          parentSpanId: 'c'.repeat(16),
        },
      });
      span.end();
      expect(pipeline.calls[0].parentSpanId).toBe('c'.repeat(16));
    });
  });
});
