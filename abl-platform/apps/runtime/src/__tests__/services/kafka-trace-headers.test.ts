/**
 * Kafka trace header injection tests
 *
 * Verifies that KafkaSubscriber captures and injects W3C traceparent/tracestate
 * headers into Kafka messages for distributed tracing.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks for OTEL
// ---------------------------------------------------------------------------

const { mockGetSpan, mockInject } = vi.hoisted(() => ({
  mockGetSpan: vi.fn(),
  mockInject: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getSpan: mockGetSpan,
  },
  context: {
    active: () => 'mock-active-context',
  },
  propagation: {
    inject: mockInject,
  },
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: vi.fn() }),
    }),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@agent-platform/config', () => ({
  EVENT_KAFKA_BATCH_SIZE: 10,
  EVENT_KAFKA_LINGER_MS: 100,
  EVENT_KAFKA_RETRIES: 3,
  EVENT_KAFKA_RETRY_INITIAL_MS: 100,
}));

vi.mock('../../services/event-bus/types.js', () => ({
  eventTypeToTopic: (type: string) => `topic-${type}`,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { KafkaSubscriber, type KafkaProducer } from '../../services/event-bus/kafka-subscriber.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProducer(): KafkaProducer {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDeadLetterWriter() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
  };
}

function createEvent(overrides: Partial<any> = {}): any {
  return {
    type: 'message',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    eventId: 'event-1',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Kafka trace header injection', () => {
  let producer: KafkaProducer;
  let dlWriter: ReturnType<typeof createMockDeadLetterWriter>;
  let subscriber: KafkaSubscriber;

  beforeEach(() => {
    vi.clearAllMocks();
    producer = createMockProducer();
    dlWriter = createMockDeadLetterWriter();
    subscriber = new KafkaSubscriber(producer, dlWriter as any, {
      batchSize: 1, // Flush immediately
      lingerMs: 60000, // Don't auto-flush on timer
    });
  });

  test('injects traceparent into Kafka message headers when OTEL span is active', async () => {
    // OTEL mock: active span exists
    mockGetSpan.mockReturnValue({ spanId: 'mock-span' });
    mockInject.mockImplementation((_ctx: unknown, carrier: Record<string, string>) => {
      carrier['traceparent'] = '00-abcd1234abcd1234abcd1234abcd1234-1234abcd1234abcd-01';
      carrier['tracestate'] = 'vendor=value';
    });

    const event = createEvent();
    subscriber.handle(event);

    // Wait for drain
    await vi.waitFor(() => {
      expect(producer.sendBatch).toHaveBeenCalled();
    });

    const batch = (producer.sendBatch as any).mock.calls[0][0];
    const msg = batch.topicMessages[0].messages[0];

    expect(msg.headers['traceparent']).toBe(
      '00-abcd1234abcd1234abcd1234abcd1234-1234abcd1234abcd-01',
    );
    expect(msg.headers['tracestate']).toBe('vendor=value');
  });

  test('omits trace headers when no OTEL span is active', async () => {
    mockGetSpan.mockReturnValue(undefined);

    const event = createEvent();
    subscriber.handle(event);

    await vi.waitFor(() => {
      expect(producer.sendBatch).toHaveBeenCalled();
    });

    const batch = (producer.sendBatch as any).mock.calls[0][0];
    const msg = batch.topicMessages[0].messages[0];

    expect(msg.headers['traceparent']).toBeUndefined();
    expect(msg.headers['tracestate']).toBeUndefined();
  });

  test('omits tracestate header when it is empty', async () => {
    mockGetSpan.mockReturnValue({ spanId: 'mock-span' });
    mockInject.mockImplementation((_ctx: unknown, carrier: Record<string, string>) => {
      carrier['traceparent'] = '00-abcd1234abcd1234abcd1234abcd1234-1234abcd1234abcd-01';
      // tracestate deliberately omitted
    });

    const event = createEvent();
    subscriber.handle(event);

    await vi.waitFor(() => {
      expect(producer.sendBatch).toHaveBeenCalled();
    });

    const batch = (producer.sendBatch as any).mock.calls[0][0];
    const msg = batch.topicMessages[0].messages[0];

    expect(msg.headers['traceparent']).toBe(
      '00-abcd1234abcd1234abcd1234abcd1234-1234abcd1234abcd-01',
    );
    // Empty tracestate should not be set as a header
    expect(msg.headers['tracestate']).toBeUndefined();
  });

  test('always includes standard event headers', async () => {
    mockGetSpan.mockReturnValue(undefined);

    const event = createEvent({
      type: 'message',
      tenantId: 'tenant-42',
      eventId: 'event-42',
      sessionId: 'session-42',
    });
    subscriber.handle(event);

    await vi.waitFor(() => {
      expect(producer.sendBatch).toHaveBeenCalled();
    });

    const batch = (producer.sendBatch as any).mock.calls[0][0];
    const msg = batch.topicMessages[0].messages[0];

    expect(msg.headers['event-type']).toBe('message');
    expect(msg.headers['tenant-id']).toBe('tenant-42');
    expect(msg.headers['event-id']).toBe('event-42');
    expect(msg.headers['session-id']).toBe('session-42');
  });

  test('captures trace context at handle() time, not flush time', async () => {
    // First event: OTEL span active
    mockGetSpan.mockReturnValue({ spanId: 'span-1' });
    mockInject.mockImplementation((_ctx: unknown, carrier: Record<string, string>) => {
      carrier['traceparent'] = '00-trace1-span1-01';
    });

    // Use batchSize 2 to buffer
    subscriber = new KafkaSubscriber(producer, dlWriter as any, {
      batchSize: 2,
      lingerMs: 60000,
    });

    const event1 = createEvent({ eventId: 'e1' });
    subscriber.handle(event1);

    // Second event: no OTEL span
    mockGetSpan.mockReturnValue(undefined);
    mockInject.mockClear();

    const event2 = createEvent({ eventId: 'e2' });
    subscriber.handle(event2);

    await vi.waitFor(() => {
      expect(producer.sendBatch).toHaveBeenCalled();
    });

    const batch = (producer.sendBatch as any).mock.calls[0][0];
    const messages = batch.topicMessages[0].messages;

    // First event should have trace headers from handle() time
    expect(messages[0].headers['traceparent']).toBe('00-trace1-span1-01');
    // Second event should not have trace headers
    expect(messages[1].headers['traceparent']).toBeUndefined();
  });
});
