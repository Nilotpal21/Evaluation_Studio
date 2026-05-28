import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@agent-platform/shared-kernel';
import { HttpAsyncAdapter } from '../channels/adapters/http-async-adapter.js';

const mocks = vi.hoisted(() => ({
  workerProcessor: null as any,
  workerEvents: new Map<string, (...args: any[]) => any>(),
  deliveryQueue: null as any,
  queueAdd: vi.fn(),
  redisSet: vi.fn(),
  resolveConnectionById: vi.fn(),
  resolveSession: vi.fn(),
  executeMessage: vi.fn(),
  getSession: vi.fn(),
  findDelivery: vi.fn(),
  createDelivery: vi.fn(),
  findSubscription: vi.fn(),
  acquireSessionLock: vi.fn(),
  releaseSessionLock: vi.fn(),
  runWithTenantContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  evaluateAuthPreflightFromIR: vi.fn().mockResolvedValue(null),
  createTokenLookups: vi.fn(() => ({})),
  traceStoreAddEvent: vi.fn(),
  traceEmit: vi.fn(),
  channelAdapter: {
    transformOutput: vi.fn(),
    sendResponse: vi.fn(),
    sendTypingIndicator: undefined as unknown,
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared-auth/middleware', () => ({
  runWithTenantContext: mocks.runWithTenantContext,
}));

vi.mock('../config/loader.js', () => ({
  isConfigLoaded: vi.fn(() => true),
  getConfig: vi.fn(() => ({
    redis: { enabled: true, url: 'redis://localhost:6379' },
  })),
}));

vi.mock('../services/queues/channel-queues.js', () => ({
  getDeliveryQueue: vi.fn(() => mocks.deliveryQueue),
}));

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    set: mocks.redisSet,
  })),
  getRedisHandle: vi.fn(() => ({ duplicate: vi.fn(() => ({ maxRetriesPerRequest: null })) })),
}));

vi.mock('../channels/connection-resolver.js', () => ({
  resolveConnectionById: mocks.resolveConnectionById,
}));

vi.mock('../channels/session-resolver.js', () => ({
  resolveSession: mocks.resolveSession,
}));

vi.mock('../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    executeMessage: mocks.executeMessage,
    getSession: mocks.getSession,
  })),
}));

vi.mock('../channels/registry.js', () => ({
  getChannelRegistry: vi.fn(() => ({
    get: vi.fn(() => mocks.channelAdapter),
  })),
}));

vi.mock('../services/auth-profile/auth-preflight.js', () => ({
  evaluateAuthPreflightFromIR: (...args: any[]) => mocks.evaluateAuthPreflightFromIR(...args),
  createTokenLookups: (...args: any[]) => mocks.createTokenLookups(...args),
}));

vi.mock('../services/trace-store.js', () => ({
  getTraceStore: vi.fn(() => ({
    addEvent: mocks.traceStoreAddEvent,
  })),
}));

vi.mock('@agent-platform/database/models', () => ({
  WebhookDelivery: {
    findOne: vi.fn((...args: any[]) => mocks.findDelivery(...args)),
    create: vi.fn((...args: any[]) => mocks.createDelivery(...args)),
  },
  WebhookSubscription: {
    findOne: vi.fn((...args: any[]) => mocks.findSubscription(...args)),
  },
}));

vi.mock('../services/queues/session-lock.js', () => ({
  acquireSessionLock: mocks.acquireSessionLock,
  releaseSessionLock: mocks.releaseSessionLock,
}));

vi.mock('bullmq', () => {
  class MockWorker {
    constructor(_name: string, processor: any) {
      mocks.workerProcessor = processor;
    }

    on(event: string, handler: any) {
      mocks.workerEvents.set(event, handler);
    }

    close() {
      return Promise.resolve();
    }
  }

  return { Worker: MockWorker };
});

describe('inbound-worker dedup + retry behavior', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply runWithTenantContext implementation after clearAllMocks wipes it
    mocks.runWithTenantContext.mockImplementation(async (_ctx: any, fn: any) => fn());
    mocks.workerProcessor = null;
    mocks.workerEvents.clear();
    const storedDeliveries = new Map<string, any>();
    mocks.deliveryQueue = { add: mocks.queueAdd };
    mocks.redisSet.mockResolvedValue('OK');
    mocks.queueAdd.mockResolvedValue(undefined);
    mocks.resolveConnectionById.mockResolvedValue({
      id: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'http_async',
      externalIdentifier: 'http_async:tenant-1:project-1',
      credentials: null,
      config: {},
      status: 'active',
    });
    mocks.resolveSession.mockResolvedValue({
      sessionId: 'runtime-1',
      isNew: false,
    });
    mocks.executeMessage.mockResolvedValue({
      response: 'hello',
      metadata: {},
    });
    mocks.getSession.mockReturnValue({
      sessionId: 'runtime-1',
      toolWarnings: [],
      sessionHealth: [],
    });
    mocks.findDelivery.mockImplementation((query: Record<string, unknown>) => ({
      lean: vi.fn().mockResolvedValue(storedDeliveries.get(String(query.idempotencyKey))),
    }));
    mocks.createDelivery.mockImplementation(async (doc: Record<string, unknown>) => {
      const delivery = { _id: `delivery-${storedDeliveries.size + 1}`, ...doc };
      storedDeliveries.set(String(doc.idempotencyKey), delivery);
      return delivery;
    });
    mocks.findSubscription.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ events: JSON.stringify(['agent.response']) }),
      }),
    });
    mocks.acquireSessionLock.mockResolvedValue(true);
    mocks.releaseSessionLock.mockResolvedValue(undefined);
    mocks.evaluateAuthPreflightFromIR.mockResolvedValue(null);
    mocks.createTokenLookups.mockReturnValue({});
    mocks.traceStoreAddEvent.mockReset();
    mocks.traceEmit.mockReset();
    mocks.channelAdapter.transformOutput.mockReset();
    const httpAsyncAdapter = new HttpAsyncAdapter();
    mocks.channelAdapter.transformOutput.mockImplementation(
      (
        text: Parameters<HttpAsyncAdapter['transformOutput']>[0],
        actions: Parameters<HttpAsyncAdapter['transformOutput']>[1],
        richContent: Parameters<HttpAsyncAdapter['transformOutput']>[2],
      ) => httpAsyncAdapter.transformOutput(text, actions, richContent),
    );
    mocks.channelAdapter.sendResponse.mockReset();
    mocks.channelAdapter.sendResponse.mockResolvedValue({ success: true });
    mocks.channelAdapter.sendTypingIndicator = undefined;
  });

  it('does not dedup-skip BullMQ retry attempts after an initial processing failure', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;
    expect(typeof processor).toBe('function');

    const payload = {
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'http_async',
      message: {
        externalMessageId: 'msg-1',
        externalSessionKey: 'http_async:tenant-1:sub-1:thread',
        text: 'hello',
        metadata: {},
        timestamp: new Date(),
      },
      subscriptionId: 'sub-1',
      idempotencyKey: 'idem-1',
    };

    // First attempt fails after dedup reservation (queue unavailable).
    mocks.deliveryQueue = null;
    await expect(
      processor({
        id: 'job-1',
        attemptsMade: 0,
        data: payload,
      }),
    ).rejects.toThrow(/Delivery queue not available/);
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);

    // Retry should bypass dedup check and process again.
    mocks.deliveryQueue = { add: mocks.queueAdd };
    await expect(
      processor({
        id: 'job-1',
        attemptsMade: 1,
        data: payload,
      }),
    ).resolves.toBeUndefined();

    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    expect(mocks.runWithTenantContext).toHaveBeenCalled();

    await stopInboundWorker();
  });

  it('includes explicit trace correlation context in async delivery payloads', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    const payload = {
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'http_async',
      message: {
        externalMessageId: 'msg-trace-1',
        externalSessionKey: 'http_async:tenant-1:sub-1:thread',
        text: 'hello',
        metadata: {},
        timestamp: new Date(),
      },
      subscriptionId: 'sub-1',
      idempotencyKey: 'idem-trace-1',
    };

    await processor({
      id: 'job-trace-1',
      attemptsMade: 0,
      data: payload,
    });

    expect(mocks.createDelivery).toHaveBeenCalledTimes(1);
    const deliveryDoc = mocks.createDelivery.mock.calls[0]?.[0] as { payload: string };
    const parsedPayload = JSON.parse(deliveryDoc.payload) as Record<string, unknown>;
    expect(parsedPayload.trace_context).toEqual({
      session_id: 'runtime-1',
      delivery: 'correlation_only',
    });
    expect(parsedPayload.session_id).toBe('runtime-1');
    expect(parsedPayload.outcome).toEqual({
      status: 'ok',
      usedFallback: false,
    });

    await stopInboundWorker();
  });

  it('queues an opt-in HTTP Async status delivery from the first streamed bridge chunk', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.findSubscription.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          events: JSON.stringify(['agent.response', 'agent.status']),
        }),
      }),
    });
    mocks.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _text: string,
        onChunk: (chunk: string) => void,
        onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      ) => {
        onChunk('Pulling that up now...');
        onTraceEvent?.({
          type: 'llm_call',
          data: {
            hasToolCalls: true,
            toolCallCount: 1,
          },
        });
        onTraceEvent?.({
          type: 'tool_call_start',
          data: {
            toolName: 'orders_lookup',
            toolCallId: 'call-1',
          },
        });
        return {
          response: 'Your order is arriving Tuesday.',
          action: { type: 'continue' },
        };
      },
    );

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    const payload = {
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'http_async',
      message: {
        externalMessageId: 'msg-status-1',
        externalSessionKey: 'http_async:tenant-1:sub-1:thread',
        text: 'hello',
        metadata: {},
        timestamp: new Date(),
      },
      subscriptionId: 'sub-1',
      idempotencyKey: 'idem-status-1',
    };

    await processor({
      id: 'job-status-1',
      attemptsMade: 0,
      data: payload,
    });

    expect(mocks.createDelivery).toHaveBeenCalledTimes(2);
    const [statusDelivery, finalDelivery] = mocks.createDelivery.mock.calls.map(
      ([doc]) => doc as { eventType: string; payload: string },
    );
    expect(statusDelivery?.eventType).toBe('agent.status');
    expect(finalDelivery?.eventType).toBe('agent.response');

    const statusPayload = JSON.parse(statusDelivery!.payload) as Record<string, unknown>;
    expect(statusPayload).toMatchObject({
      event: 'agent.status',
      status: 'in_progress',
      message: "I'm pulling that up now.",
      response: "I'm pulling that up now.",
      trace_context: {
        session_id: 'runtime-1',
        delivery: 'status_event',
      },
      metadata: {
        status_kind: 'continuity',
        continuity_kind: 'pre_action_bridge',
        visibility: 'customer_visible',
        source: 'agent_authored',
      },
    });
    expect(statusPayload.message).not.toMatch(/tool|internal/i);

    const finalPayload = JSON.parse(finalDelivery!.payload) as Record<string, unknown>;
    expect(finalPayload).toMatchObject({
      response: 'Your order is arriving Tuesday.',
      channel_output: {
        kind: 'text',
        text: 'Your order is arriving Tuesday.',
      },
    });

    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
    expect(mocks.queueAdd.mock.calls[0]?.[1]).toMatchObject({
      eventType: 'agent.status',
    });
    expect(mocks.queueAdd.mock.calls[1]?.[1]).toMatchObject({
      eventType: 'agent.response',
    });

    await stopInboundWorker();
  });

  it('queues a long-running HTTP Async status when a tool call remains open past the threshold', async () => {
    vi.useFakeTimers();
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.findSubscription.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          events: JSON.stringify(['agent.response', 'agent.status']),
        }),
      }),
    });

    let resolveExecution: (() => void) | undefined;
    mocks.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _text: string,
        _onChunk: (chunk: string) => void,
        onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      ) => {
        onTraceEvent?.({
          type: 'tool_call_start',
          data: {
            toolName: 'carrier_lookup',
            toolCallId: 'call-1',
          },
        });

        await new Promise<void>((resolve) => {
          resolveExecution = () => {
            onTraceEvent?.({
              type: 'tool_call',
              data: {
                phase: 'complete',
                toolName: 'carrier_lookup',
                toolCallId: 'call-1',
              },
            });
            resolve();
          };
        });

        return {
          response: 'Carrier replied. Your order is still moving.',
          action: { type: 'continue' },
        };
      },
    );

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;
    const processing = processor({
      id: 'job-status-long-running',
      attemptsMade: 0,
      data: {
        connectionId: 'conn-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: null,
        channelType: 'http_async',
        message: {
          externalMessageId: 'msg-status-long-running',
          externalSessionKey: 'http_async:tenant-1:sub-1:thread',
          text: 'hello',
          metadata: {},
          timestamp: new Date(),
        },
        subscriptionId: 'sub-1',
        idempotencyKey: 'idem-status-long-running',
      },
    });

    await vi.advanceTimersByTimeAsync(3999);
    expect(mocks.createDelivery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.createDelivery).toHaveBeenCalledTimes(1);
    const statusDelivery = mocks.createDelivery.mock.calls[0]?.[0] as {
      eventType: string;
      payload: string;
    };
    expect(statusDelivery.eventType).toBe('agent.status');
    expect(JSON.parse(statusDelivery.payload)).toMatchObject({
      event: 'agent.status',
      message: "I'm still checking that.",
      metadata: {
        status_kind: 'continuity',
        continuity_kind: 'long_running_status',
        visibility: 'customer_visible',
        source: 'runtime_topology',
      },
    });

    resolveExecution?.();
    await processing;

    expect(mocks.createDelivery).toHaveBeenCalledTimes(2);
    const finalDelivery = mocks.createDelivery.mock.calls[1]?.[0] as {
      eventType: string;
      payload: string;
    };
    expect(finalDelivery.eventType).toBe('agent.response');
    expect(JSON.parse(finalDelivery.payload)).toMatchObject({
      response: 'Carrier replied. Your order is still moving.',
    });
    expect(mocks.queueAdd.mock.calls.map((call) => call[1]?.eventType)).toEqual([
      'agent.status',
      'agent.response',
    ]);

    await stopInboundWorker();
  });

  it('sanitizes implementation wording before HTTP Async status delivery reaches customers', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.findSubscription.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          events: JSON.stringify(['agent.response', 'agent.status']),
        }),
      }),
    });
    mocks.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _text: string,
        onChunk: (chunk: string) => void,
        onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      ) => {
        onChunk('I will call the get_order tool now.');
        onTraceEvent?.({
          type: 'llm_call',
          data: {
            hasToolCalls: true,
            toolCallCount: 1,
          },
        });
        return {
          response: 'Your order is arriving Tuesday.',
          action: { type: 'continue' },
        };
      },
    );

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    await processor({
      id: 'job-status-sanitized',
      attemptsMade: 0,
      data: {
        connectionId: 'conn-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: null,
        channelType: 'http_async',
        message: {
          externalMessageId: 'msg-status-sanitized',
          externalSessionKey: 'http_async:tenant-1:sub-1:thread',
          text: 'hello',
          metadata: {},
          timestamp: new Date(),
        },
        subscriptionId: 'sub-1',
        idempotencyKey: 'idem-status-sanitized',
      },
    });

    const statusDelivery = mocks.createDelivery.mock.calls[0]?.[0] as {
      eventType: string;
      payload: string;
    };
    expect(statusDelivery.eventType).toBe('agent.status');
    const statusPayload = JSON.parse(statusDelivery.payload) as Record<string, unknown>;
    expect(statusPayload.message).toBe('Let me check that for you.');
    expect(statusPayload.message).not.toMatch(/tool|workflow|internal|handoff|delegate/i);

    await stopInboundWorker();
  });

  it('queues HTTP Async handoff-transition status only when topology marks it customer-visible', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.findSubscription.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          events: JSON.stringify(['agent.response', 'agent.status']),
        }),
      }),
    });
    mocks.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _text: string,
        _onChunk: (chunk: string) => void,
        onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      ) => {
        onTraceEvent?.({
          type: 'handoff',
          data: {
            from: 'Alex',
            to: 'Senior_Specialist',
            experienceMode: 'visible_handoff',
            visibility: 'customer_visible',
            continuity: {
              kind: 'handoff_transition',
              visibility: 'customer_visible',
              message: "I'm connecting you with the right specialist now.",
            },
          },
        });
        return {
          response: 'The specialist has the details.',
          action: { type: 'continue' },
        };
      },
    );

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    await processor({
      id: 'job-status-handoff',
      attemptsMade: 0,
      data: {
        connectionId: 'conn-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: null,
        channelType: 'http_async',
        message: {
          externalMessageId: 'msg-status-handoff',
          externalSessionKey: 'http_async:tenant-1:sub-1:thread',
          text: 'hello',
          metadata: {},
          timestamp: new Date(),
        },
        subscriptionId: 'sub-1',
        idempotencyKey: 'idem-status-handoff',
      },
    });

    expect(mocks.createDelivery).toHaveBeenCalledTimes(2);
    const statusDelivery = mocks.createDelivery.mock.calls[0]?.[0] as {
      eventType: string;
      payload: string;
    };
    expect(statusDelivery.eventType).toBe('agent.status');
    const statusPayload = JSON.parse(statusDelivery.payload) as Record<string, unknown>;
    expect(statusPayload).toMatchObject({
      message: "I'm connecting you with the right specialist now.",
      metadata: {
        status_kind: 'continuity',
        continuity_kind: 'handoff_transition',
        visibility: 'customer_visible',
        source: 'runtime_topology',
      },
    });

    await stopInboundWorker();
  });

  it('does not queue HTTP Async status delivery for streamed final text without a tool call', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.findSubscription.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          events: JSON.stringify(['agent.response', 'agent.status']),
        }),
      }),
    });
    mocks.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _text: string,
        onChunk: (chunk: string) => void,
        onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      ) => {
        onChunk('Here is the answer.');
        onTraceEvent?.({
          type: 'llm_call',
          data: {
            hasToolCalls: false,
            toolCallCount: 0,
          },
        });
        return {
          response: 'Here is the answer.',
          action: { type: 'continue' },
        };
      },
    );

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    const payload = {
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'http_async',
      message: {
        externalMessageId: 'msg-status-final-only',
        externalSessionKey: 'http_async:tenant-1:sub-1:thread',
        text: 'hello',
        metadata: {},
        timestamp: new Date(),
      },
      subscriptionId: 'sub-1',
      idempotencyKey: 'idem-status-final-only',
    };

    await processor({
      id: 'job-status-final-only',
      attemptsMade: 0,
      data: payload,
    });

    expect(mocks.createDelivery).toHaveBeenCalledTimes(1);
    const deliveryDoc = mocks.createDelivery.mock.calls[0]?.[0] as {
      eventType: string;
      payload: string;
    };
    expect(deliveryDoc.eventType).toBe('agent.response');
    expect(JSON.parse(deliveryDoc.payload)).toMatchObject({
      response: 'Here is the answer.',
      channel_output: {
        kind: 'text',
        text: 'Here is the answer.',
      },
    });
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd.mock.calls[0]?.[1]).toMatchObject({
      eventType: 'agent.response',
    });

    await stopInboundWorker();
  });

  it('includes response provenance metadata in async delivery payloads when execution uses a visible LLM response', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.executeMessage.mockImplementation(
      async (_sessionId: string, _text: string, _onChunk: unknown, onTraceEvent?: Function) => {
        onTraceEvent?.({
          type: 'llm_call',
          data: {
            tokensIn: 21,
            tokensOut: 34,
            responseContribution: 'customer_visible',
          },
        });
        return {
          response: 'hello',
          action: { type: 'continue' },
        };
      },
    );

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    const payload = {
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'http_async',
      message: {
        externalMessageId: 'msg-provenance-1',
        externalSessionKey: 'http_async:tenant-1:sub-1:thread',
        text: 'hello',
        metadata: {},
        timestamp: new Date(),
      },
      subscriptionId: 'sub-1',
      idempotencyKey: 'idem-provenance-1',
    };

    await processor({
      id: 'job-provenance-1',
      attemptsMade: 0,
      data: payload,
    });

    const deliveryDoc = mocks.createDelivery.mock.calls[0]?.[0] as { payload: string };
    const parsedPayload = JSON.parse(deliveryDoc.payload) as Record<string, unknown>;
    expect(parsedPayload.response_metadata).toEqual({
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'llm',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    });

    await stopInboundWorker();
  });

  it('forwards canonical response metadata in async delivery payloads', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.executeMessage.mockResolvedValue({
      response: 'hello',
      action: { type: 'continue' },
      responseMetadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'mixed',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
        responseChannelHint: 'canonical-http-async',
      },
    });

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    const payload = {
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'http_async',
      message: {
        externalMessageId: 'msg-provenance-canonical-1',
        externalSessionKey: 'http_async:tenant-1:sub-1:thread',
        text: 'hello',
        metadata: {},
        timestamp: new Date(),
      },
      subscriptionId: 'sub-1',
      idempotencyKey: 'idem-provenance-canonical-1',
    };

    await processor({
      id: 'job-provenance-canonical-1',
      attemptsMade: 0,
      data: payload,
    });

    const deliveryDoc = mocks.createDelivery.mock.calls[0]?.[0] as { payload: string };
    const parsedPayload = JSON.parse(deliveryDoc.payload) as Record<string, unknown>;
    expect(parsedPayload.response_metadata).toEqual({
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'mixed',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
      responseChannelHint: 'canonical-http-async',
    });

    await stopInboundWorker();
  });

  it('passes response provenance metadata to direct-send channel adapters', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.resolveConnectionById.mockResolvedValue({
      id: 'conn-whatsapp-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'whatsapp',
      externalIdentifier: 'whatsapp:tenant-1:project-1',
      credentials: null,
      config: {},
      status: 'active',
    });
    mocks.executeMessage.mockImplementation(
      async (_sessionId: string, _text: string, _onChunk: unknown, onTraceEvent?: Function) => {
        onTraceEvent?.({
          type: 'llm_call',
          data: {
            tokensIn: 11,
            tokensOut: 19,
            responseContribution: 'customer_visible',
          },
        });
        return {
          response: 'visible response',
          action: { type: 'continue' },
        };
      },
    );

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    const payload = {
      connectionId: 'conn-whatsapp-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'whatsapp',
      message: {
        externalMessageId: 'msg-direct-1',
        externalSessionKey: 'whatsapp:tenant-1:thread-1',
        text: 'hello',
        metadata: { original: true },
        timestamp: new Date(),
      },
      idempotencyKey: 'idem-direct-1',
    };

    await processor({
      id: 'job-direct-1',
      attemptsMade: 0,
      data: payload,
    });

    expect(mocks.channelAdapter.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'runtime-1',
        text: 'visible response',
        metadata: expect.objectContaining({
          original: true,
          responseMetadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        }),
      }),
      expect.objectContaining({
        channelType: 'whatsapp',
      }),
    );

    await stopInboundWorker();
  });

  it('forwards canonical response metadata to direct-send channel adapters', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.resolveConnectionById.mockResolvedValue({
      id: 'conn-whatsapp-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'whatsapp',
      externalIdentifier: 'whatsapp:tenant-1:project-1',
      credentials: null,
      config: {},
      status: 'active',
    });
    mocks.executeMessage.mockResolvedValue({
      response: 'visible response',
      action: { type: 'continue' },
      responseMetadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'mixed',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
        responseChannelHint: 'canonical-direct-send',
      },
    });

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    const payload = {
      connectionId: 'conn-whatsapp-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'whatsapp',
      message: {
        externalMessageId: 'msg-direct-canonical-1',
        externalSessionKey: 'whatsapp:tenant-1:thread-1',
        text: 'hello',
        metadata: { original: true },
        timestamp: new Date(),
      },
      idempotencyKey: 'idem-direct-canonical-1',
    };

    await processor({
      id: 'job-direct-canonical-1',
      attemptsMade: 0,
      data: payload,
    });

    expect(mocks.channelAdapter.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'runtime-1',
        text: 'visible response',
        metadata: expect.objectContaining({
          original: true,
          responseMetadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'mixed',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
            responseChannelHint: 'canonical-direct-send',
          },
        }),
      }),
      expect.objectContaining({
        channelType: 'whatsapp',
      }),
    );

    await stopInboundWorker();
  });

  it('does not retry deterministic sessionMetadata validation failures', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;
    expect(typeof processor).toBe('function');

    const payload = {
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'http_async',
      message: {
        externalMessageId: 'msg-metadata-1',
        externalSessionKey: 'http_async:tenant-1:sub-1:thread',
        text: 'hello',
        metadata: {},
        timestamp: new Date(),
      },
      subscriptionId: 'sub-1',
      idempotencyKey: 'idem-metadata-1',
    };

    mocks.resolveSession.mockRejectedValue(
      new AppError('sessionMetadata exceeds maximum size', {
        code: 'PAYLOAD_TOO_LARGE',
        statusCode: 413,
      }),
    );

    await expect(
      processor({
        id: 'job-metadata-1',
        attemptsMade: 0,
        data: payload,
      }),
    ).resolves.toBeUndefined();

    expect(mocks.resolveSession).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd).not.toHaveBeenCalled();

    await stopInboundWorker();
  });

  it('emits a causal trace for async auth preflight short-circuits', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    mocks.getSession.mockReturnValue({
      sessionId: 'runtime-1',
      toolWarnings: [],
      sessionHealth: [],
      compilationOutput: { agents: {} },
      tracer: {
        emit: mocks.traceEmit,
      },
    });
    mocks.evaluateAuthPreflightFromIR.mockResolvedValue({
      pending: [
        {
          connector: 'google_drive',
          authProfileRef: 'google_drive_auth',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    const payload = {
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'http_async',
      message: {
        externalMessageId: 'msg-auth-1',
        externalSessionKey: 'http_async:tenant-1:sub-1:thread',
        text: 'hello',
        metadata: {},
        timestamp: new Date(),
      },
      subscriptionId: 'sub-1',
      idempotencyKey: 'idem-auth-1',
    };

    await processor({
      id: 'job-auth-1',
      attemptsMade: 0,
      data: payload,
    });

    expect(mocks.traceEmit).toHaveBeenCalledWith({
      type: 'error',
      data: {
        code: 'AUTH_PREFLIGHT_REQUIRED',
        message: 'Authorization is required before the agent can continue: google_drive.',
        category: 'auth',
        source: 'channel_outcome',
      },
    });

    const deliveryDoc = mocks.createDelivery.mock.calls[0]?.[0] as { payload: string };
    const parsedPayload = JSON.parse(deliveryDoc.payload) as Record<string, unknown>;
    expect(parsedPayload.outcome).toEqual({
      status: 'auth_required',
      usedFallback: true,
      auth: {
        pending: [
          {
            connector: 'google_drive',
            authProfileRef: 'google_drive_auth',
            connectionMode: 'per_user',
          },
        ],
        satisfied: [],
      },
    });

    await stopInboundWorker();
  });

  it('skips execution for reaction messages (isReaction metadata)', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    await startInboundWorker();
    const processor = mocks.workerProcessor as (job: any) => Promise<void>;

    // WhatsApp channel with reaction metadata
    mocks.resolveConnectionById.mockResolvedValue({
      id: 'conn-wa',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'whatsapp',
      externalIdentifier: '15551234567',
      credentials: null,
      config: {},
      status: 'active',
    });

    const payload = {
      connectionId: 'conn-wa',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'whatsapp',
      message: {
        externalMessageId: 'wamid.reaction1',
        externalSessionKey: 'whatsapp:15551234567:15559876543',
        text: '👍',
        metadata: {
          isReaction: true,
          reactionMessageId: 'wamid.original',
          whatsappFrom: '15559876543',
          whatsappPhoneNumberId: '15551234567',
        },
        timestamp: new Date(),
      },
    };

    await processor({
      id: 'job-reaction',
      attemptsMade: 0,
      data: payload,
    });

    // executeMessage should NOT have been called — reaction must not trigger bot reply
    expect(mocks.executeMessage).not.toHaveBeenCalled();

    await stopInboundWorker();
  });
});
