import { describe, it, expect, vi } from 'vitest';
import {
  createTraceStoreAdapter,
  type TraceStoreHandle,
} from '../../observability/trace-store-adapter.js';

function makeMockTraceStore(): TraceStoreHandle {
  return {
    addEvent: vi.fn(),
  };
}

describe('createTraceStoreAdapter', () => {
  it('returns a TraceEventEmitter with an emit method', () => {
    const store = makeMockTraceStore();
    const emitter = createTraceStoreAdapter(store, 'session-1');
    expect(typeof emitter.emit).toBe('function');
  });

  it('forwards events to TraceStore.addEvent with correct format', () => {
    const store = makeMockTraceStore();
    const emitter = createTraceStoreAdapter(store, 'session-1');

    emitter.emit({
      type: 'agent_transfer.transfer_initiated',
      timestamp: 1709000000000,
      data: { tenantId: 'tenant-1', provider: 'kore' },
    });

    expect(store.addEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        sessionId: 'session-1',
        type: 'agent_transfer.transfer_initiated',
        timestamp: new Date(1709000000000),
        data: { tenantId: 'tenant-1', provider: 'kore' },
      }),
    );
  });

  it('generates a unique id for each event', () => {
    const store = makeMockTraceStore();
    const emitter = createTraceStoreAdapter(store, 'session-1');

    emitter.emit({ type: 'a', timestamp: 1, data: {} });
    emitter.emit({ type: 'b', timestamp: 2, data: {} });

    const calls = vi.mocked(store.addEvent).mock.calls;
    const id1 = calls[0][1].id;
    const id2 = calls[1][1].id;
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^at-/);
  });

  it('handles async TraceStore.addEvent', async () => {
    const store: TraceStoreHandle = {
      addEvent: vi.fn().mockResolvedValue(undefined),
    };
    const emitter = createTraceStoreAdapter(store, 'session-1');

    const result = emitter.emit({ type: 'test', timestamp: 1, data: {} });
    if (result) {
      await result;
    }
    expect(store.addEvent).toHaveBeenCalled();
  });

  it('converts numeric timestamp to Date', () => {
    const store = makeMockTraceStore();
    const emitter = createTraceStoreAdapter(store, 'session-1');
    const ts = 1700000000000;

    emitter.emit({ type: 'test', timestamp: ts, data: {} });

    const call = vi.mocked(store.addEvent).mock.calls[0];
    expect(call[1].timestamp).toEqual(new Date(ts));
  });
});
