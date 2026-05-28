import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { WritePipelineImpl } from '../../../services/tracing/write-pipeline.js';

function createMockConfig() {
  const traceStoreCalls: unknown[] = [];
  const broadcastCalls: unknown[] = [];
  const eventStoreCalls: unknown[] = [];

  const traceStore = {
    addEvent: vi.fn((sessionId: string, event: unknown) => {
      traceStoreCalls.push({ sessionId, event });
    }),
  };

  const eventStoreEmitter = {
    emit: vi.fn((event: unknown) => {
      eventStoreCalls.push(event);
    }),
  };

  const eventStore = { emitter: eventStoreEmitter };

  return {
    config: {
      getTraceStore: vi.fn(() => traceStore),
      getEventStore: vi.fn(() => eventStore),
      getPIIRecognizerRegistry: vi.fn(() => undefined),
      broadcastToSession: vi.fn((sessionId: string, message: unknown) => {
        broadcastCalls.push({ sessionId, message });
      }),
    },
    traceStore,
    eventStoreEmitter,
    traceStoreCalls,
    broadcastCalls,
    eventStoreCalls,
  };
}

function createContractIdRegistry(): PIIRecognizerRegistry {
  const registry = new PIIRecognizerRegistry();
  registry.register(
    new RegexPIIRecognizer(
      'custom-contract-id',
      ['ContractID'],
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      'ContractID',
      undefined,
      'custom',
    ),
  );
  return registry;
}

describe('WritePipelineImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes to TraceStore, broadcasts via WS, and emits to EventStore', () => {
    const { config, traceStore, eventStoreEmitter } = createMockConfig();
    const pipeline = new WritePipelineImpl(config);

    pipeline.write({
      type: 'agent_enter',
      sessionId: 'sess-1',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      tenantId: 'tenant-1',
      projectId: 'project-1',
      timestamp: new Date('2024-01-01'),
      data: { spanName: 'test' },
    });

    expect(traceStore.addEvent).toHaveBeenCalledOnce();
    expect(config.broadcastToSession).toHaveBeenCalledOnce();
    expect(config.broadcastToSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ type: 'trace_event' }),
    );
    expect(eventStoreEmitter.emit).toHaveBeenCalledOnce();
    // Verify EventStore receives the mapped platform type
    expect(eventStoreEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'agent.entered',
        category: 'agent',
      }),
    );
  });

  it('skips TraceStore when getTraceStore returns null', () => {
    const { config, traceStore } = createMockConfig();
    config.getTraceStore.mockReturnValue(null);
    const pipeline = new WritePipelineImpl(config);

    pipeline.write({ type: 'test', sessionId: 'sess-1', data: {} });

    expect(traceStore.addEvent).not.toHaveBeenCalled();
  });

  it('skips EventStore when getEventStore returns null', () => {
    const { config, eventStoreEmitter } = createMockConfig();
    config.getEventStore.mockReturnValue(null);
    const pipeline = new WritePipelineImpl(config);

    pipeline.write({ type: 'test', sessionId: 'sess-1', tenantId: 't1', data: {} });

    expect(eventStoreEmitter.emit).not.toHaveBeenCalled();
  });

  it('skips EventStore when tenantId is missing', () => {
    const { config, eventStoreEmitter } = createMockConfig();
    const pipeline = new WritePipelineImpl(config);

    pipeline.write({ type: 'test', sessionId: 'sess-1', data: {} });

    expect(eventStoreEmitter.emit).not.toHaveBeenCalled();
  });

  it('skips WS broadcast when sessionId is missing', () => {
    const { config } = createMockConfig();
    const pipeline = new WritePipelineImpl(config);

    pipeline.write({ type: 'test', data: {} });

    expect(config.broadcastToSession).not.toHaveBeenCalled();
  });

  it('continues writing to other sinks when TraceStore throws', () => {
    const { config, eventStoreEmitter } = createMockConfig();
    config.getTraceStore.mockImplementation(() => {
      throw new Error('store down');
    });
    const pipeline = new WritePipelineImpl(config);

    // Should not throw — use a mapped type so EventStore receives it
    pipeline.write({ type: 'agent_enter', sessionId: 'sess-1', tenantId: 't1', data: {} });

    expect(config.broadcastToSession).toHaveBeenCalled();
    expect(eventStoreEmitter.emit).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TraceStore write failed',
      expect.objectContaining({ error: 'store down' }),
    );
  });

  it('continues writing to other sinks when WS broadcast throws', () => {
    const { config, eventStoreEmitter } = createMockConfig();
    config.broadcastToSession.mockImplementation(() => {
      throw new Error('ws down');
    });
    const pipeline = new WritePipelineImpl(config);

    // Use a mapped type so EventStore receives the event
    pipeline.write({ type: 'agent_enter', sessionId: 'sess-1', tenantId: 't1', data: {} });

    expect(eventStoreEmitter.emit).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'WS broadcast failed',
      expect.objectContaining({ error: 'ws down' }),
    );
  });

  it('does not throw when EventStore throws', () => {
    const { config, eventStoreEmitter } = createMockConfig();
    eventStoreEmitter.emit.mockImplementation(() => {
      throw new Error('eventstore down');
    });
    const pipeline = new WritePipelineImpl(config);

    expect(() => {
      pipeline.write({ type: 'agent_enter', sessionId: 'sess-1', tenantId: 't1', data: {} });
    }).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'EventStore write failed',
      expect.objectContaining({
        sessionId: 'sess-1',
        eventType: 'agent_enter',
        error: 'eventstore down',
      }),
    );
  });

  // ─── Event enrichment tests ─────────────────────────────────────────────

  it('passes event fields through to EventStore emit correctly', () => {
    const { config, eventStoreCalls } = createMockConfig();
    const pipeline = new WritePipelineImpl(config);

    const ts = new Date('2025-06-01T12:00:00Z');
    pipeline.write({
      type: 'agent_enter',
      sessionId: 'sess-enrich',
      tenantId: 'tenant-x',
      projectId: 'project-y',
      agentName: 'booking',
      timestamp: ts,
      durationMs: 150,
      spanId: 'span-123',
      parentSpanId: 'span-parent',
      data: { mode: 'reasoning' },
    });

    expect(eventStoreCalls.length).toBe(1);
    const emitted = eventStoreCalls[0] as Record<string, unknown>;
    expect(emitted).toMatchObject({
      event_type: 'agent.entered',
      category: 'agent',
      tenant_id: 'tenant-x',
      project_id: 'project-y',
      session_id: 'sess-enrich',
      agent_name: 'booking',
      timestamp: ts,
      duration_ms: 150,
      span_id: 'span-123',
      parent_span_id: 'span-parent',
      data: { mode: 'reasoning' },
    });
  });

  it('defaults projectId to empty string when missing', () => {
    const { config, eventStoreCalls } = createMockConfig();
    const pipeline = new WritePipelineImpl(config);

    pipeline.write({
      type: 'agent_enter',
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
      data: { key: 'val' },
    });

    const emitted = eventStoreCalls[0] as Record<string, unknown>;
    expect(emitted.project_id).toBe('');
  });

  it('preserves event data when enriching a missing event id', () => {
    const { config, traceStoreCalls } = createMockConfig();
    const pipeline = new WritePipelineImpl(config);

    const event = {
      type: 'llm_call',
      sessionId: 'sess-data',
      data: { model: 'gpt-4', tokensIn: 100 },
    };
    pipeline.write(event);

    expect(traceStoreCalls.length).toBe(1);
    const storedEvent = (traceStoreCalls[0] as Record<string, unknown>).event as Record<
      string,
      unknown
    >;
    expect(storedEvent.data).toEqual(event.data);
    expect(storedEvent.id).toEqual(expect.any(String));
    expect(event).not.toHaveProperty('id');
  });

  it('broadcasts trace_event message shape over WS', () => {
    const { config, broadcastCalls } = createMockConfig();
    const pipeline = new WritePipelineImpl(config);

    pipeline.write({ type: 'span_end', sessionId: 'sess-ws', data: {} });

    expect(broadcastCalls.length).toBe(1);
    const msg = (broadcastCalls[0] as Record<string, unknown>).message as Record<string, unknown>;
    expect(msg.type).toBe('trace_event');
    expect(msg.sessionId).toBe('sess-ws');
    expect(msg.event).toBeDefined();
  });

  it('uses the same generated event id across TraceStore, WS, and EventStore', () => {
    const { config, traceStoreCalls, broadcastCalls, eventStoreCalls } = createMockConfig();
    const pipeline = new WritePipelineImpl(config);

    pipeline.write({
      type: 'agent_enter',
      sessionId: 'sess-consistent',
      tenantId: 'tenant-1',
      data: { spanName: 'consistency-check' },
    });

    const traceStoreEvent = (traceStoreCalls[0] as Record<string, unknown>).event as Record<
      string,
      unknown
    >;
    const wsEvent = (
      (broadcastCalls[0] as Record<string, unknown>).message as Record<string, unknown>
    ).event as Record<string, unknown>;
    const emittedEvent = eventStoreCalls[0] as Record<string, unknown>;

    expect(traceStoreEvent.id).toEqual(expect.any(String));
    expect(wsEvent.id).toBe(traceStoreEvent.id);
    expect(emittedEvent.event_id).toBe(traceStoreEvent.id);
  });

  // ─── All three sinks fail — no unhandled error ────────────────────────

  it('survives all three sinks throwing simultaneously', () => {
    const { config } = createMockConfig();
    config.getTraceStore.mockImplementation(() => {
      throw new Error('store down');
    });
    config.broadcastToSession.mockImplementation(() => {
      throw new Error('ws down');
    });
    config.getEventStore.mockImplementation(() => {
      throw new Error('eventstore down');
    });
    const pipeline = new WritePipelineImpl(config);

    expect(() => {
      pipeline.write({ type: 'test', sessionId: 'sess-1', tenantId: 't1', data: {} });
    }).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TraceStore write failed',
      expect.objectContaining({ error: 'store down' }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'WS broadcast failed',
      expect.objectContaining({ error: 'ws down' }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'EventStore emit failed',
      expect.objectContaining({ error: 'eventstore down' }),
    );
  });

  it('scrubs custom project patterns with a live recognizer registry getter', () => {
    const { config, traceStoreCalls, broadcastCalls, eventStoreCalls } = createMockConfig();
    const pipeline = new WritePipelineImpl({
      ...config,
      scrubPII: true,
      getPIIRecognizerRegistry: () => createContractIdRegistry(),
    });

    pipeline.write({
      type: 'tool_call',
      sessionId: 'sess-contract',
      tenantId: 'tenant-1',
      data: {
        input: { contractId: '780b4d1c-1166-487e-ae7a-27eedd12905b' },
        output: { contractId: '780b4d1c-1166-487e-ae7a-27eedd12905b' },
        success: true,
      },
    });

    const storedEvent = (traceStoreCalls[0] as { event: { data: unknown } }).event;
    const broadcastEvent = (broadcastCalls[0] as { message: { event: { data: unknown } } }).message
      .event;
    const emittedEvent = eventStoreCalls[0] as { data: unknown };

    expect(JSON.stringify(storedEvent.data)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(storedEvent.data)).not.toContain('780b4d1c-1166-487e-ae7a-27eedd12905b');
    expect(JSON.stringify(broadcastEvent.data)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(emittedEvent.data)).toContain('[REDACTED_CONTRACT_ID]');
  });

  it('re-reads the recognizer registry for each write so refreshed project patterns take effect', () => {
    const { config, traceStoreCalls } = createMockConfig();
    let registry: PIIRecognizerRegistry | undefined;
    const pipeline = new WritePipelineImpl({
      ...config,
      scrubPII: true,
      getPIIRecognizerRegistry: () => registry,
    });

    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    pipeline.write({
      type: 'tool_call',
      sessionId: 'sess-live-registry',
      tenantId: 'tenant-1',
      data: { input: { contractId: rawContractId }, success: true },
    });

    registry = createContractIdRegistry();

    pipeline.write({
      type: 'tool_call',
      sessionId: 'sess-live-registry',
      tenantId: 'tenant-1',
      data: { input: { contractId: rawContractId }, success: true },
    });

    const firstEvent = (traceStoreCalls[0] as { event: { data: unknown } }).event;
    const secondEvent = (traceStoreCalls[1] as { event: { data: unknown } }).event;

    expect(JSON.stringify(firstEvent.data)).toContain(rawContractId);
    expect(JSON.stringify(secondEvent.data)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(secondEvent.data)).not.toContain(rawContractId);
  });
});
