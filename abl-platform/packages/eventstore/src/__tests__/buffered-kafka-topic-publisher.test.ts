import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockProducer, mockKafkaCtor } = vi.hoisted(() => {
  const producer = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    sendBatch: vi.fn(async () => {}),
  };

  return {
    mockProducer: producer,
    mockKafkaCtor: vi.fn(),
  };
});

vi.mock('kafkajs', () => ({
  Kafka: class MockKafka {
    constructor(config: unknown) {
      mockKafkaCtor(config);
    }

    producer(): typeof mockProducer {
      return mockProducer;
    }
  },
  logLevel: {
    WARN: 4,
  },
}));

import { BufferedKafkaTopicPublisher } from '../queues/buffered-kafka-topic-publisher.js';

describe('BufferedKafkaTopicPublisher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('flushes buffered messages in a single Kafka batch', async () => {
    const publisher = new BufferedKafkaTopicPublisher({
      brokers: ['localhost:19092'],
      clientId: 'audit-producer-test',
      topic: 'abl.audit.shared.v1',
      batchSize: 10,
      lingerMs: 1000,
      maxRetries: 1,
      retryInitialMs: 1,
    });

    publisher.publish({
      key: 'tenant-a',
      value: {
        auditId: 'audit-1',
        tenantId: 'tenant-a',
      },
    });

    await publisher.flush();

    expect(mockProducer.connect).toHaveBeenCalledTimes(1);
    expect(mockProducer.sendBatch).toHaveBeenCalledTimes(1);
    expect(mockProducer.sendBatch).toHaveBeenCalledWith({
      topicMessages: [
        {
          topic: 'abl.audit.shared.v1',
          messages: [
            {
              key: 'tenant-a',
              value: JSON.stringify({
                auditId: 'audit-1',
                tenantId: 'tenant-a',
              }),
            },
          ],
        },
      ],
    });
  });

  test('marks itself unhealthy and requeues messages when Kafka send fails', async () => {
    mockProducer.sendBatch.mockRejectedValueOnce(new Error('kafka unavailable'));

    const publisher = new BufferedKafkaTopicPublisher({
      brokers: ['localhost:19092'],
      clientId: 'audit-producer-test',
      topic: 'abl.audit.shared.v1',
      batchSize: 10,
      lingerMs: 1000,
      maxRetries: 1,
      retryInitialMs: 1,
    });

    publisher.publish({
      key: 'tenant-a',
      value: {
        auditId: 'audit-2',
      },
    });

    await expect(publisher.flush()).rejects.toThrow('kafka unavailable');
    expect(publisher.isHealthy()).toBe(false);

    mockProducer.sendBatch.mockResolvedValueOnce(undefined);
    await expect(publisher.flush()).resolves.toBeUndefined();
    expect(publisher.isHealthy()).toBe(true);
  });
});
