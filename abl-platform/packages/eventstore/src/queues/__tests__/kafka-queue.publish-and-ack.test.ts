/**
 * Unit test: KafkaEventQueue.publishAndAck
 *
 * Uses DI to replace the internal `kafkajs` Producer with a recording test
 * double (the Producer reference is set on the KafkaEventQueue instance
 * before calling `publishAndAck`). No `vi.mock()` of platform modules.
 *
 * LLD §1.4 — Phase 1, task 1.4.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kafka } from 'kafkajs';
import { KafkaEventQueue } from '../kafka-queue.js';

type SendCall = {
  topic: string;
  messages: Array<{ key?: string; value: string }>;
  acks?: number;
};

function makeInstanceWithStubProducer(producerSend: (r: SendCall) => Promise<unknown>): {
  queue: KafkaEventQueue;
  sendMock: ReturnType<typeof vi.fn>;
} {
  const sendMock = vi.fn(producerSend);
  const producer = {
    events: {
      CONNECT: 'producer.connect',
      DISCONNECT: 'producer.disconnect',
      REQUEST_TIMEOUT: 'producer.network.request_timeout',
    },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: sendMock,
    on: vi.fn(),
  };
  const originalProducer = Kafka.prototype.producer;
  Kafka.prototype.producer = vi.fn(() => producer as never);

  // Construct the queue with a stub producer so the constructor never
  // attempts a real network connection during unit tests.
  const queue = new KafkaEventQueue({
    kafka: { brokers: ['broker-unused:9092'] },
  });
  Kafka.prototype.producer = originalProducer;
  return { queue, sendMock };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KafkaEventQueue.publishAndAck', () => {
  it('sends the event to the specified topic with acks: -1 (success path)', async () => {
    const { queue, sendMock } = makeInstanceWithStubProducer(async () => ({}));

    await queue.publishAndAck('abl.workflow.execution', {
      event_type: 'workflow.execution.started',
      tenant_id: 't1',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0] as SendCall;
    expect(call.topic).toBe('abl.workflow.execution');
    expect(call.acks).toBe(-1);
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].key).toBe('t1'); // tenant_id-derived key
    expect(JSON.parse(call.messages[0].value)).toEqual({
      event_type: 'workflow.execution.started',
      tenant_id: 't1',
    });
  });

  it('propagates broker failure as a rejected promise', async () => {
    const bookedError = new Error('NOT_ENOUGH_REPLICAS');
    const { queue } = makeInstanceWithStubProducer(async () => {
      throw bookedError;
    });

    await expect(queue.publishAndAck('abl.workflow.execution', { tenant_id: 't1' })).rejects.toBe(
      bookedError,
    );
  });

  it('decrements pendingMessages back to zero after both success and failure', async () => {
    const { queue } = makeInstanceWithStubProducer(async () => ({}));

    await queue.publishAndAck('t', { tenant_id: 't1' });
    expect(queue.pendingCount).toBe(0);

    const { queue: queue2 } = makeInstanceWithStubProducer(async () => {
      throw new Error('boom');
    });
    await expect(queue2.publishAndAck('t', { tenant_id: 't1' })).rejects.toBeInstanceOf(Error);
    expect(queue2.pendingCount).toBe(0);
  });

  it('uses the explicitly-provided key when present (overrides tenant_id derivation)', async () => {
    const { queue, sendMock } = makeInstanceWithStubProducer(async () => ({}));

    await queue.publishAndAck(
      'abl.workflow.execution',
      { tenant_id: 't1', execution_id: 'exec-1' },
      'custom-partition-key',
    );

    const call = sendMock.mock.calls[0][0] as SendCall;
    expect(call.messages[0].key).toBe('custom-partition-key');
  });

  it('leaves key undefined when event lacks tenant_id and no explicit key is provided', async () => {
    const { queue, sendMock } = makeInstanceWithStubProducer(async () => ({}));

    await queue.publishAndAck('abl.workflow.execution', { no_tenant_here: true });

    const call = sendMock.mock.calls[0][0] as SendCall;
    expect(call.messages[0].key).toBeUndefined();
  });
});
