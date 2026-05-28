import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TraceStoreHandle } from '@agent-platform/agent-transfer';
import type { EventStoreServices } from '@abl/eventstore';
import type { EventStoreEmitOptions } from '../../trace/emit-to-eventstore.js';
import { createEventStoreTraceAdapter } from '../eventstore-trace-adapter.js';

type EmitFn = (options: EventStoreEmitOptions) => void;

const makeTraceStore = (): TraceStoreHandle & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    addEvent(_sessionId: string, event: unknown) {
      calls.push(event);
    },
  } as unknown as TraceStoreHandle & { calls: unknown[] };
};

const makeEventStore = (): EventStoreServices =>
  ({
    emitter: { emit: vi.fn() },
  }) as unknown as EventStoreServices;

describe('createEventStoreTraceAdapter', () => {
  let mockEmitFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockEmitFn = vi.fn();
  });

  it('always calls traceStore.addEvent with the correct event shape', () => {
    const traceStore = makeTraceStore();
    const adapter = createEventStoreTraceAdapter(traceStore, () => null, mockEmitFn as EmitFn);

    adapter.emit({
      type: 'agent_transfer.transfer_initiated',
      timestamp: 1700000000000,
      data: { tenantId: 'tenant-1', projectId: 'project-1', provider: 'smartassist' },
    });

    expect(traceStore.calls).toHaveLength(1);
    const stored = traceStore.calls[0] as Record<string, unknown>;
    expect(stored.type).toBe('agent_transfer.transfer_initiated');
    expect(stored.timestamp).toBeInstanceOf(Date);
    expect(stored.data).toMatchObject({ tenantId: 'tenant-1', provider: 'smartassist' });
  });

  it('calls emitFn when EventStore is available and tenantId is present', () => {
    const traceStore = makeTraceStore();
    const eventStore = makeEventStore();
    const adapter = createEventStoreTraceAdapter(
      traceStore,
      () => eventStore,
      mockEmitFn as EmitFn,
    );

    adapter.emit({
      type: 'agent_transfer.agent_connected',
      timestamp: 1700000000000,
      data: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        runtimeSessionId: 'sess-abc',
        provider: 'smartassist',
        channel: 'chat',
      },
    });

    expect(mockEmitFn).toHaveBeenCalledOnce();
    const opts = mockEmitFn.mock.calls[0][0] as Record<string, unknown>;
    const event = opts.event as Record<string, unknown>;
    expect(event.type).toBe('agent_transfer.agent_connected');
    expect(event.tenantId).toBe('tenant-1');
    expect(event.projectId).toBe('project-1');
    expect(event.sessionId).toBe('sess-abc');
  });

  it('enables PII scrubbing for EventStore writes', () => {
    const traceStore = makeTraceStore();
    const eventStore = makeEventStore();
    const adapter = createEventStoreTraceAdapter(
      traceStore,
      () => eventStore,
      mockEmitFn as EmitFn,
    );

    adapter.emit({
      type: 'agent_transfer.acw_completed',
      timestamp: 1700000000000,
      data: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        contactId: 'contact-1',
        reason: 'Customer email is jane@example.com',
      },
    });

    expect(mockEmitFn).toHaveBeenCalledOnce();
    const opts = mockEmitFn.mock.calls[0][0] as EventStoreEmitOptions;
    expect(opts.scrubPII).toBe(true);
    expect(opts.redactPIIFn?.('Customer email is jane@example.com')).not.toContain(
      'jane@example.com',
    );
  });

  it('falls back to contactId as sessionId when runtimeSessionId is absent', () => {
    const traceStore = makeTraceStore();
    const eventStore = makeEventStore();
    const adapter = createEventStoreTraceAdapter(
      traceStore,
      () => eventStore,
      mockEmitFn as EmitFn,
    );

    adapter.emit({
      type: 'agent_transfer.transfer_failed',
      timestamp: 1700000000000,
      data: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        contactId: 'contact-1',
        provider: 'smartassist',
        channel: 'chat',
      },
    });

    expect(mockEmitFn).toHaveBeenCalledOnce();
    const opts = mockEmitFn.mock.calls[0][0] as Record<string, unknown>;
    const event = opts.event as Record<string, unknown>;
    expect(event.sessionId).toBe('contact-1');
  });

  it('skips emitFn when tenantId is missing', () => {
    const traceStore = makeTraceStore();
    const eventStore = makeEventStore();
    const adapter = createEventStoreTraceAdapter(
      traceStore,
      () => eventStore,
      mockEmitFn as EmitFn,
    );

    adapter.emit({
      type: 'agent_transfer.transfer_initiated',
      timestamp: 1700000000000,
      data: { provider: 'smartassist' },
    });

    expect(traceStore.calls).toHaveLength(1);
    expect(mockEmitFn).not.toHaveBeenCalled();
  });

  it('skips emitFn when getEventStoreFn returns null', () => {
    const traceStore = makeTraceStore();
    const adapter = createEventStoreTraceAdapter(traceStore, () => null, mockEmitFn as EmitFn);

    adapter.emit({
      type: 'agent_transfer.transfer_initiated',
      timestamp: 1700000000000,
      data: { tenantId: 'tenant-1', projectId: 'project-1' },
    });

    expect(traceStore.calls).toHaveLength(1);
    expect(mockEmitFn).not.toHaveBeenCalled();
  });
});
