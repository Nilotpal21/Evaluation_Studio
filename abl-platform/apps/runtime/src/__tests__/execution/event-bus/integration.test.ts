/**
 * EventBus Integration Tests
 *
 * Verifies the full end-to-end flow: emit -> registry gate -> subscriber ->
 * batch -> flush. Uses mock Kafka producer and dead-letter writer to test
 * the wiring without real infrastructure.
 *
 * Covers:
 *  - Subscribed tenant events reach Kafka via the full pipeline
 *  - Unsubscribed tenant events are silently dropped
 *  - Tenant isolation with independent subscription sets
 *  - Dead-letter routing on persistent Kafka failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeEventBus } from '../../../services/event-bus/event-bus.js';
import { EventSubscriptionRegistry } from '../../../services/event-bus/subscription-registry.js';
import { KafkaSubscriber } from '../../../services/event-bus/kafka-subscriber.js';
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

function makeEvent(type: string, tenantId: string): AnyPlatformEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    tenantId,
    projectId: 'project-1',
    sessionId: 'session-1',
    agentName: 'TestAgent',
    channel: 'web_debug',
    timestamp: new Date().toISOString(),
    payload: { content: 'test' },
  };
}

describe('EventBus integration', () => {
  let registry: EventSubscriptionRegistry;
  let bus: RuntimeEventBus;
  let kafkaSubscriber: KafkaSubscriber;
  let mockProducer: any;
  let mockDeadLetterWriter: any;

  beforeEach(() => {
    mockProducer = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    };
    mockDeadLetterWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    registry = new EventSubscriptionRegistry();
    kafkaSubscriber = new KafkaSubscriber(mockProducer, mockDeadLetterWriter, {
      batchSize: 100,
      lingerMs: 50,
      maxRetries: 1,
      retryInitialMs: 10,
    });
    bus = new RuntimeEventBus(registry);
    bus.subscribe(kafkaSubscriber.handle);
  });

  afterEach(async () => {
    await bus.shutdown();
    registry.stop();
    await kafkaSubscriber.close();
  });

  it('end-to-end: subscribed tenant events reach Kafka', async () => {
    registry.updateSubscriptions(new Map([['tenant-1', new Set(['message.user'])]]));

    bus.emit(makeEvent('message.user', 'tenant-1'));

    // Wait for linger flush
    await new Promise((r) => setTimeout(r, 80));

    expect(mockProducer.sendBatch).toHaveBeenCalledTimes(1);
    const batch = mockProducer.sendBatch.mock.calls[0][0];
    expect(batch.topicMessages[0].topic).toBe('abl.message.user');
    expect(batch.topicMessages[0].messages).toHaveLength(1);
  });

  it('end-to-end: unsubscribed tenant events are dropped', async () => {
    registry.updateSubscriptions(new Map([['tenant-1', new Set(['message.user'])]]));

    bus.emit(makeEvent('message.user', 'tenant-2'));

    await new Promise((r) => setTimeout(r, 80));

    expect(mockProducer.sendBatch).not.toHaveBeenCalled();
  });

  it('end-to-end: tenant isolation — two tenants, independent pipelines', async () => {
    registry.updateSubscriptions(
      new Map([
        ['tenant-A', new Set(['message.user'])],
        ['tenant-B', new Set(['session.ended'])],
      ]),
    );

    bus.emit(makeEvent('message.user', 'tenant-A'));
    bus.emit(makeEvent('session.ended', 'tenant-B'));
    bus.emit(makeEvent('message.user', 'tenant-B')); // not subscribed

    await new Promise((r) => setTimeout(r, 80));

    expect(mockProducer.sendBatch).toHaveBeenCalledTimes(1);
    const batch = mockProducer.sendBatch.mock.calls[0][0];
    const totalMessages = batch.topicMessages.reduce(
      (sum: number, tm: any) => sum + tm.messages.length,
      0,
    );
    expect(totalMessages).toBe(2);
  });

  it('end-to-end: Kafka failure routes to dead letter', async () => {
    mockProducer.sendBatch.mockRejectedValue(new Error('Kafka unreachable'));
    registry.updateSubscriptions(new Map([['tenant-1', new Set(['message.user'])]]));

    bus.emit(makeEvent('message.user', 'tenant-1'));

    // Wait for linger flush + retries + dead letter
    await new Promise((r) => setTimeout(r, 200));

    expect(mockDeadLetterWriter.write).toHaveBeenCalled();
  });
});
