/**
 * KafkaSubscriber Tests
 *
 * Verifies batch flushing, linger timeout, topic grouping, partition keys,
 * headers, retry with exponential backoff, dead-letter on persistent failure,
 * and flush/close behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KafkaSubscriber } from '../../../services/event-bus/kafka-subscriber.js';
import type { KafkaProducer } from '../../../services/event-bus/kafka-subscriber.js';
import type { DeadLetterWriter } from '../../../services/event-bus/dead-letter-writer.js';
import type { AnyPlatformEvent } from '../../../services/event-bus/types.js';

// Suppress logger output in tests
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AnyPlatformEvent> = {}): AnyPlatformEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: 'session.created',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    agentName: 'test-agent',
    channel: 'web',
    timestamp: '2026-03-01T00:00:00.000Z',
    payload: {},
    ...overrides,
  };
}

function createMockProducer(): KafkaProducer & {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sendBatch: ReturnType<typeof vi.fn>;
} {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDeadLetterWriter(): DeadLetterWriter & {
  write: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KafkaSubscriber', () => {
  let producer: ReturnType<typeof createMockProducer>;
  let deadLetter: ReturnType<typeof createMockDeadLetterWriter>;

  beforeEach(() => {
    vi.useFakeTimers();
    producer = createMockProducer();
    deadLetter = createMockDeadLetterWriter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Batch-size flush
  // -----------------------------------------------------------------------

  it('flushes when batch size is reached', async () => {
    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 3,
      lingerMs: 60_000,
      maxRetries: 0,
      retryInitialMs: 10,
    });

    subscriber.handle(makeEvent({ eventId: 'e1' }));
    subscriber.handle(makeEvent({ eventId: 'e2' }));
    expect(producer.sendBatch).not.toHaveBeenCalled();

    subscriber.handle(makeEvent({ eventId: 'e3' }));

    // sendBatch is called async — advance microtasks
    await vi.advanceTimersByTimeAsync(0);

    expect(producer.sendBatch).toHaveBeenCalledTimes(1);
    const call = producer.sendBatch.mock.calls[0][0];
    // All 3 events in one topic
    expect(call.topicMessages).toHaveLength(1);
    expect(call.topicMessages[0].messages).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // Linger timeout flush
  // -----------------------------------------------------------------------

  it('flushes on linger timeout even if batch not full', async () => {
    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 100,
      lingerMs: 500,
      maxRetries: 0,
      retryInitialMs: 10,
    });

    subscriber.handle(makeEvent({ eventId: 'e1' }));
    subscriber.handle(makeEvent({ eventId: 'e2' }));
    expect(producer.sendBatch).not.toHaveBeenCalled();

    // Advance past linger timeout
    await vi.advanceTimersByTimeAsync(500);

    expect(producer.sendBatch).toHaveBeenCalledTimes(1);
    const call = producer.sendBatch.mock.calls[0][0];
    expect(call.topicMessages[0].messages).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Topic grouping
  // -----------------------------------------------------------------------

  it('groups events by topic in a single sendBatch call', async () => {
    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 4,
      lingerMs: 60_000,
      maxRetries: 0,
      retryInitialMs: 10,
    });

    subscriber.handle(makeEvent({ eventId: 'e1', type: 'session.created' }));
    subscriber.handle(makeEvent({ eventId: 'e2', type: 'message.user' }));
    subscriber.handle(makeEvent({ eventId: 'e3', type: 'session.created' }));
    subscriber.handle(makeEvent({ eventId: 'e4', type: 'tool.called' }));

    await vi.advanceTimersByTimeAsync(0);

    expect(producer.sendBatch).toHaveBeenCalledTimes(1);
    const call = producer.sendBatch.mock.calls[0][0];
    // 3 distinct topics
    expect(call.topicMessages).toHaveLength(3);

    const topics = call.topicMessages.map((tm: { topic: string }) => tm.topic);
    expect(topics).toContain('abl.session.created');
    expect(topics).toContain('abl.message.user');
    expect(topics).toContain('abl.tool.called');

    // session.created has 2 messages
    const sessionTopic = call.topicMessages.find(
      (tm: { topic: string }) => tm.topic === 'abl.session.created',
    );
    expect(sessionTopic.messages).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Partition key
  // -----------------------------------------------------------------------

  it('sets correct partition key as tenantId:sessionId', async () => {
    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 1,
      lingerMs: 60_000,
      maxRetries: 0,
      retryInitialMs: 10,
    });

    subscriber.handle(makeEvent({ tenantId: 'tenant-abc', sessionId: 'sess-xyz' }));

    await vi.advanceTimersByTimeAsync(0);

    const call = producer.sendBatch.mock.calls[0][0];
    expect(call.topicMessages[0].messages[0].key).toBe('tenant-abc:sess-xyz');
  });

  // -----------------------------------------------------------------------
  // Headers
  // -----------------------------------------------------------------------

  it('sets event headers on each message', async () => {
    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 1,
      lingerMs: 60_000,
      maxRetries: 0,
      retryInitialMs: 10,
    });

    subscriber.handle(
      makeEvent({
        eventId: 'evt-h1',
        type: 'message.agent',
        tenantId: 'tenant-h',
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    const call = producer.sendBatch.mock.calls[0][0];
    const headers = call.topicMessages[0].messages[0].headers;
    expect(headers['event-type']).toBe('message.agent');
    expect(headers['tenant-id']).toBe('tenant-h');
    expect(headers['event-id']).toBe('evt-h1');
  });

  // -----------------------------------------------------------------------
  // Dead letter on persistent failure
  // -----------------------------------------------------------------------

  it('writes to dead letter on persistent failure after retries', async () => {
    producer.sendBatch.mockRejectedValue(new Error('Kafka unreachable'));

    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 1,
      lingerMs: 60_000,
      maxRetries: 2,
      retryInitialMs: 10,
    });

    const event = makeEvent({ eventId: 'evt-fail' });
    subscriber.handle(event);

    // Drain with retries (each retry has a sleep)
    // Initial attempt + 2 retries with delays of 10ms and 20ms
    await vi.advanceTimersByTimeAsync(0); // trigger drainBuffer
    await vi.advanceTimersByTimeAsync(10); // retry 1 delay
    await vi.advanceTimersByTimeAsync(20); // retry 2 delay
    await vi.advanceTimersByTimeAsync(0); // settle

    // 1 initial + 2 retries = 3 attempts
    expect(producer.sendBatch).toHaveBeenCalledTimes(3);
    expect(deadLetter.write).toHaveBeenCalledTimes(1);
    expect(deadLetter.write).toHaveBeenCalledWith(
      event,
      'Kafka unreachable',
      2, // maxRetries count
    );
  });

  // -----------------------------------------------------------------------
  // flush() drains buffer immediately
  // -----------------------------------------------------------------------

  it('flush() drains buffer immediately', async () => {
    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 100,
      lingerMs: 60_000,
      maxRetries: 0,
      retryInitialMs: 10,
    });

    subscriber.handle(makeEvent({ eventId: 'e1' }));
    subscriber.handle(makeEvent({ eventId: 'e2' }));

    await subscriber.flush();

    expect(producer.sendBatch).toHaveBeenCalledTimes(1);
    const call = producer.sendBatch.mock.calls[0][0];
    expect(call.topicMessages[0].messages).toHaveLength(2);
  });

  it('flush() is a no-op when buffer is empty', async () => {
    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 100,
      lingerMs: 60_000,
      maxRetries: 0,
      retryInitialMs: 10,
    });

    await subscriber.flush();
    expect(producer.sendBatch).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // close() flushes and disconnects
  // -----------------------------------------------------------------------

  it('close() flushes and disconnects producer', async () => {
    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 100,
      lingerMs: 60_000,
      maxRetries: 0,
      retryInitialMs: 10,
    });

    subscriber.handle(makeEvent());
    await subscriber.close();

    expect(producer.sendBatch).toHaveBeenCalledTimes(1);
    expect(producer.disconnect).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Value serialization
  // -----------------------------------------------------------------------

  it('serializes event to JSON in message value', async () => {
    const subscriber = new KafkaSubscriber(producer, deadLetter, {
      batchSize: 1,
      lingerMs: 60_000,
      maxRetries: 0,
      retryInitialMs: 10,
    });

    const event = makeEvent({ eventId: 'evt-json', payload: { key: 'val' } });
    subscriber.handle(event);

    await vi.advanceTimersByTimeAsync(0);

    const call = producer.sendBatch.mock.calls[0][0];
    const value = call.topicMessages[0].messages[0].value;
    const parsed = JSON.parse(value);
    expect(parsed.eventId).toBe('evt-json');
    expect(parsed.payload).toEqual({ key: 'val' });
  });
});
