import { describe, expect, it, vi } from 'vitest';
import type { AuditLogEntry } from '@agent-platform/arch-ai';

const { debugMock } = vi.hoisted(() => ({
  debugMock: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: debugMock,
  }),
}));

import { createObservedArchStream } from '@/lib/arch-ai/stream-observer';

describe('createObservedArchStream (arch-ai)', () => {
  it('handles nested turn-engine error envelopes without throwing', async () => {
    const emittedEvents: unknown[] = [];
    const auditEntries: AuditLogEntry[] = [];
    const closeMock = vi.fn();
    const flushMock = vi.fn().mockResolvedValue(undefined);
    const destroyMock = vi.fn();

    const stream = createObservedArchStream({
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      phase: 'INTERVIEW',
      requestId: 'client-request-1',
      startedAtMs: Date.now() - 10,
      emit: (event) => {
        emittedEvents.push(event);
      },
      close: closeMock,
      auditSink: {
        emit: (entry) => {
          auditEntries.push(entry);
        },
        flush: flushMock,
        destroy: destroyMock,
      },
    });

    expect(() =>
      stream.emit({
        type: 'error',
        error: {
          code: 'LLM_TIMEOUT',
          message: 'Timed out while waiting for the model.',
          retryable: true,
        },
      } as never),
    ).not.toThrow();

    await stream.flush();

    expect(closeMock).not.toHaveBeenCalled();
    expect(emittedEvents).toHaveLength(1);
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]?.detail).toEqual(
      expect.objectContaining({
        errorCode: 'llm_timeout',
        source: 'llm',
        message: 'Timed out while waiting for the model.',
      }),
    );
    expect(debugMock).toHaveBeenCalled();
    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('emits partial, final, and error SSE payloads in order with audit context', async () => {
    const emittedEvents: unknown[] = [];
    const auditEntries: AuditLogEntry[] = [];
    const closeMock = vi.fn();
    const flushMock = vi.fn().mockResolvedValue(undefined);
    const destroyMock = vi.fn();

    const stream = createObservedArchStream({
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      phase: 'BUILD',
      requestId: 'client-request-2',
      startedAtMs: Date.now() - 10,
      emit: (event) => {
        emittedEvents.push(event);
      },
      close: closeMock,
      auditSink: {
        emit: (entry) => {
          auditEntries.push(entry);
        },
        flush: flushMock,
        destroy: destroyMock,
      },
    });

    stream.emit({ type: 'text_delta', delta: 'partial ' } as never);
    stream.emit({ type: 'text_delta', delta: 'payload' } as never);
    stream.emit({
      type: 'done',
      completion: 'final payload',
      suggestions: ['open diff'],
    } as never);
    stream.emit({
      type: 'error',
      error: {
        code: 'TOOL_ERROR',
        message: 'Tool failed',
        retryable: false,
      },
    } as never);

    await stream.flush();

    expect(emittedEvents).toEqual([
      { type: 'text_delta', delta: 'partial ' },
      { type: 'text_delta', delta: 'payload' },
      { type: 'done', completion: 'final payload', suggestions: ['open diff'] },
      {
        type: 'error',
        error: {
          code: 'TOOL_ERROR',
          message: 'Tool failed',
          retryable: false,
        },
      },
    ]);
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        category: 'error',
        severity: 'critical',
        projectId: 'project-1',
        phase: 'BUILD',
        detail: expect.objectContaining({
          errorCode: 'tool_error',
          source: 'tool',
          message: 'Tool failed',
        }),
      }),
    );
    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
