import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures variables are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockEmit,
  mockGetEventStore,
  mockGetCurrentTraceId,
  mockFlush,
  mockGetSharedSTRBuffer,
  mockAddTraceEvent,
  mockGetTraceStore,
  mockWarn,
} = vi.hoisted(() => {
  const mockEmit = vi.fn();
  const mockFlush = vi.fn();
  const mockAddTraceEvent = vi.fn();
  return {
    mockEmit,
    mockGetEventStore: vi.fn(() => ({ emitter: { emit: mockEmit } })),
    mockGetCurrentTraceId: vi.fn(() => undefined as string | undefined),
    mockFlush,
    mockGetSharedSTRBuffer: vi.fn(() => ({ flush: mockFlush })),
    mockAddTraceEvent,
    mockGetTraceStore: vi.fn(() => ({ addEvent: mockAddTraceEvent })),
    mockWarn: vi.fn(),
  };
});

vi.mock('../../services/eventstore-singleton.js', () => ({
  getEventStore: mockGetEventStore,
}));

vi.mock('@abl/compiler/platform/observability', () => ({
  getCurrentTraceId: mockGetCurrentTraceId,
}));

vi.mock('@agent-platform/shared-observability/sti', () => ({
  getSharedSTRBuffer: mockGetSharedSTRBuffer,
}));

vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: mockGetTraceStore,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  emitChannelResponseSent,
  recordSyntheticTraceEvent,
} from '../../services/channel-trace-utils.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitChannelResponseSent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEventStore.mockReturnValue({ emitter: { emit: mockEmit } });
    mockGetCurrentTraceId.mockReturnValue(undefined);
  });

  it('emits channel_response_sent event with correct data', () => {
    emitChannelResponseSent('sess-1', 'web', 150, {
      tenantId: 't1',
      projectId: 'p1',
      traceId: 'trace-abc',
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    const event = mockEmit.mock.calls[0][0];
    expect(event.event_type).toBe('channel.response.sent');
    expect(event.category).toBe('channel');
    expect(event.session_id).toBe('sess-1');
    expect(event.tenant_id).toBe('t1');
    expect(event.project_id).toBe('p1');
    expect(event.duration_ms).toBe(150);
    expect(event.has_error).toBe(false);
    expect(event.data).toEqual(
      expect.objectContaining({
        channel: 'web',
        channel_type: 'web',
        channelType: 'web',
        latency_ms: 150,
        latencyMs: 150,
        status: 'sent',
      }),
    );
    expect(event.trace_id).toBe('trace-abc');
    expect(event.event_id).toBeDefined();
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('falls back to getCurrentTraceId when opts.traceId is not provided', () => {
    mockGetCurrentTraceId.mockReturnValue('als-trace-id');

    emitChannelResponseSent('sess-2', 'whatsapp', 200);

    const event = mockEmit.mock.calls[0][0];
    expect(event.trace_id).toBe('als-trace-id');
  });

  it('omits trace_id when neither opts.traceId nor ALS traceId is available', () => {
    mockGetCurrentTraceId.mockReturnValue(undefined);

    emitChannelResponseSent('sess-3', 'slack', 100);

    const event = mockEmit.mock.calls[0][0];
    expect(event).not.toHaveProperty('trace_id');
  });

  it('returns early when eventStore is null', () => {
    mockGetEventStore.mockReturnValue(null);

    emitChannelResponseSent('sess-4', 'web', 50);

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('defaults tenantId and projectId to empty string when not provided', () => {
    emitChannelResponseSent('sess-5', 'web', 75);

    const event = mockEmit.mock.calls[0][0];
    expect(event.tenant_id).toBe('');
    expect(event.project_id).toBe('');
  });

  it('flushes STR buffer when traceId is available', () => {
    emitChannelResponseSent('sess-6', 'web', 100, { traceId: 'trace-flush' });

    expect(mockFlush).toHaveBeenCalledWith('trace-flush');
  });

  it('does not flush STR buffer when no traceId', () => {
    mockGetCurrentTraceId.mockReturnValue(undefined);

    emitChannelResponseSent('sess-7', 'web', 100);

    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('does not throw when STR flush fails', () => {
    mockFlush.mockImplementation(() => {
      throw new Error('flush failed');
    });

    expect(() =>
      emitChannelResponseSent('sess-8', 'web', 100, { traceId: 'trace-err' }),
    ).not.toThrow();
  });

  it('catches and logs warning when emit throws', () => {
    mockEmit.mockImplementation(() => {
      throw new Error('emit failed');
    });

    expect(() => emitChannelResponseSent('sess-9', 'web', 100)).not.toThrow();

    expect(mockWarn).toHaveBeenCalledWith(
      'Failed to emit channel_response_sent',
      expect.objectContaining({
        sessionId: 'sess-9',
        channel: 'web',
        error: 'emit failed',
      }),
    );
  });

  it('logs non-Error thrown values as strings', () => {
    mockEmit.mockImplementation(() => {
      throw 'string error'; // eslint-disable-line no-throw-literal
    });

    emitChannelResponseSent('sess-10', 'web', 100);

    expect(mockWarn).toHaveBeenCalledWith(
      'Failed to emit channel_response_sent',
      expect.objectContaining({ error: 'string error' }),
    );
  });

  it('records synthetic trace events in TraceStore when no tracer is present', () => {
    recordSyntheticTraceEvent({
      sessionId: 'sess-trace',
      event: {
        type: 'error',
        data: {
          code: 'AUTH_PREFLIGHT_REQUIRED',
          message: 'Authorization is required before the agent can continue.',
          category: 'auth',
          source: 'channel_outcome',
        },
      },
    });

    expect(mockAddTraceEvent).toHaveBeenCalledWith(
      'sess-trace',
      expect.objectContaining({
        sessionId: 'sess-trace',
        type: 'error',
        data: expect.objectContaining({
          code: 'AUTH_PREFLIGHT_REQUIRED',
        }),
      }),
    );
  });

  it('emits mapped synthetic trace events to EventStore when tenant context is present', () => {
    recordSyntheticTraceEvent({
      sessionId: 'sess-attachment',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      traceId: 'trace-attachment',
      event: {
        type: 'attachment_preprocess',
        data: {
          channel: 'slack',
          attachmentCount: 1,
          durationMs: 42,
        },
      },
    });

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'attachment.preprocessed',
        category: 'attachment',
        tenant_id: 'tenant-1',
        project_id: 'proj-1',
        session_id: 'sess-attachment',
        trace_id: 'trace-attachment',
      }),
    );
  });

  it('prefers the runtime session tracer when present', () => {
    const emit = vi.fn();

    recordSyntheticTraceEvent({
      sessionId: 'sess-trace',
      session: {
        tracer: { emit } as unknown as { emit: typeof emit },
      },
      event: {
        type: 'error',
        data: {
          code: 'EXECUTION_TIMEOUT',
          message: 'The request timed out before the agent could respond. Please try again.',
          category: 'timeout',
          source: 'channel_outcome',
        },
      },
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({
          code: 'EXECUTION_TIMEOUT',
        }),
      }),
    );
    expect(mockAddTraceEvent).not.toHaveBeenCalled();
  });
});
