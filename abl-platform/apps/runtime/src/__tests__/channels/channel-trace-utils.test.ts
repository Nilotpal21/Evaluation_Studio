/**
 * Channel Trace Utils Tests
 *
 * Covers emitChannelResponseSent:
 * - Emits channel.response.sent event to EventStore
 * - Includes traceId from ALS context
 * - Uses provided traceId from opts
 * - Handles missing EventStore gracefully
 * - Handles EventStore error gracefully
 * - Flushes STR buffer when traceId is available
 * - Handles STR flush error gracefully
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock dependencies
const mockEmit = vi.fn();
const mockGetEventStore = vi.fn();
const mockGetTraceStore = vi.fn(() => ({ addEvent: vi.fn() }));
vi.mock('../../services/eventstore-singleton.js', () => ({
  getEventStore: () => mockGetEventStore(),
}));
vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: () => mockGetTraceStore(),
}));

const mockGetCurrentTraceId = vi.fn();
vi.mock('@abl/compiler/platform/observability', () => ({
  getCurrentTraceId: () => mockGetCurrentTraceId(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFlush = vi.fn();
vi.mock('@agent-platform/shared-observability/sti', () => ({
  getSharedSTRBuffer: () => ({
    flush: mockFlush,
  }),
}));

import { emitChannelResponseSent } from '../../services/channel-trace-utils.js';

describe('emitChannelResponseSent', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits channel.response.sent event to EventStore', () => {
    mockGetEventStore.mockReturnValue({ emitter: { emit: mockEmit } });
    mockGetCurrentTraceId.mockReturnValue('trace-xyz');

    emitChannelResponseSent('sess-1', 'websocket', 150, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'channel.response.sent',
        category: 'channel',
        tenant_id: 'tenant-1',
        project_id: 'project-1',
        session_id: 'sess-1',
        duration_ms: 150,
        has_error: false,
        data: expect.objectContaining({
          channel: 'websocket',
          channel_type: 'websocket',
          channelType: 'websocket',
          latency_ms: 150,
          latencyMs: 150,
          status: 'sent',
        }),
      }),
    );
  });

  it('uses traceId from opts when provided', () => {
    mockGetEventStore.mockReturnValue({ emitter: { emit: mockEmit } });

    emitChannelResponseSent('sess-1', 'http', 100, {
      traceId: 'custom-trace-id',
    });

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: 'custom-trace-id',
      }),
    );
  });

  it('uses ALS traceId when opts.traceId not provided', () => {
    mockGetEventStore.mockReturnValue({ emitter: { emit: mockEmit } });
    mockGetCurrentTraceId.mockReturnValue('als-trace-id');

    emitChannelResponseSent('sess-1', 'http', 100);

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: 'als-trace-id',
      }),
    );
  });

  it('does nothing when EventStore is not available', () => {
    mockGetEventStore.mockReturnValue(null);

    emitChannelResponseSent('sess-1', 'http', 100);

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('handles EventStore emit error gracefully', () => {
    mockGetEventStore.mockReturnValue({
      emitter: {
        emit: () => {
          throw new Error('EventStore down');
        },
      },
    });

    // Should not throw
    emitChannelResponseSent('sess-1', 'http', 100, { tenantId: 'tenant-1' });
  });

  it('flushes STR buffer when traceId is available', () => {
    mockGetEventStore.mockReturnValue({ emitter: { emit: mockEmit } });
    mockGetCurrentTraceId.mockReturnValue('trace-flush');

    emitChannelResponseSent('sess-1', 'http', 100);

    expect(mockFlush).toHaveBeenCalledWith('trace-flush');
  });

  it('handles STR flush error gracefully', () => {
    mockGetEventStore.mockReturnValue({ emitter: { emit: mockEmit } });
    mockGetCurrentTraceId.mockReturnValue('trace-fail');
    mockFlush.mockImplementation(() => {
      throw new Error('flush failed');
    });

    // Should not throw
    emitChannelResponseSent('sess-1', 'http', 100);
  });

  it('defaults tenantId and projectId to empty string', () => {
    mockGetEventStore.mockReturnValue({ emitter: { emit: mockEmit } });
    mockGetCurrentTraceId.mockReturnValue(undefined);

    emitChannelResponseSent('sess-1', 'http', 100);

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: '',
        project_id: '',
      }),
    );
  });
});
