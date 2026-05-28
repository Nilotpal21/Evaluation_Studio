import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kafka } from 'kafkajs';
import { KafkaEventQueue } from '../kafka-queue.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type EventListener = (event: { payload: unknown }) => void;

class StubProducer {
  readonly events = {
    CONNECT: 'producer.connect',
    DISCONNECT: 'producer.disconnect',
    REQUEST_TIMEOUT: 'producer.network.request_timeout',
  } as const;

  private readonly listeners = new Map<string, EventListener[]>();

  constructor(
    private readonly deps: {
      connect?: () => Promise<void>;
      disconnect?: () => Promise<void>;
      send?: (record: unknown) => Promise<unknown>;
    } = {},
  ) {}

  connect = vi.fn(async () => {
    await this.deps.connect?.();
  });

  disconnect = vi.fn(async () => {
    await this.deps.disconnect?.();
    this.emit(this.events.DISCONNECT);
  });

  send = vi.fn(async (record: unknown) => {
    await this.deps.send?.(record);
    return [];
  });

  on = vi.fn((eventName: string, listener: EventListener) => {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
    return () => {
      const next = (this.listeners.get(eventName) ?? []).filter((entry) => entry !== listener);
      this.listeners.set(eventName, next);
    };
  });

  emit(eventName: string, payload: unknown = {}): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener({ payload });
    }
  }
}

class StubConsumer {
  readonly events = {
    CONNECT: 'consumer.connect',
    GROUP_JOIN: 'consumer.group_join',
    DISCONNECT: 'consumer.disconnect',
    REQUEST_TIMEOUT: 'consumer.network.request_timeout',
    CRASH: 'consumer.crash',
  } as const;

  private readonly listeners = new Map<string, EventListener[]>();

  constructor(
    private readonly deps: {
      connect?: () => Promise<void>;
      disconnect?: () => Promise<void>;
      subscribe?: () => Promise<void>;
      run?: () => Promise<void>;
    } = {},
  ) {}

  connect = vi.fn(async () => {
    await this.deps.connect?.();
  });

  disconnect = vi.fn(async () => {
    await this.deps.disconnect?.();
    this.emit(this.events.DISCONNECT);
  });

  subscribe = vi.fn(async () => {
    await this.deps.subscribe?.();
  });

  run = vi.fn(async () => {
    await this.deps.run?.();
  });

  on = vi.fn((eventName: string, listener: EventListener) => {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
    return () => {
      const next = (this.listeners.get(eventName) ?? []).filter((entry) => entry !== listener);
      this.listeners.set(eventName, next);
    };
  });

  emit(eventName: string, payload: unknown = {}): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener({ payload });
    }
  }
}

describe('KafkaEventQueue health tracking', () => {
  const originalProducer = Kafka.prototype.producer;
  const originalConsumer = Kafka.prototype.consumer;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Kafka.prototype.producer = originalProducer;
    Kafka.prototype.consumer = originalConsumer;
  });

  it('is unhealthy until the producer finishes connecting, then recovers after a timeout on the next successful send', async () => {
    const producerConnect = createDeferred<void>();
    const producer = new StubProducer({
      connect: () => producerConnect.promise,
    });

    Kafka.prototype.producer = vi.fn(() => producer as never);

    const queue = new KafkaEventQueue({
      kafka: { brokers: ['broker-unused:9092'] },
    });

    expect(queue.isHealthy()).toBe(false);

    producerConnect.resolve();
    await flushMicrotasks();
    expect(queue.isHealthy()).toBe(true);

    producer.emit(producer.events.REQUEST_TIMEOUT);
    expect(queue.isHealthy()).toBe(false);

    queue.enqueue({ tenant_id: 't1', event_type: 'workflow.execution.started' });
    await flushMicrotasks();
    expect(queue.isHealthy()).toBe(true);

    await queue.close();
  });

  it('consumer queues stay unhealthy until group join and recover after disconnects', async () => {
    const producer = new StubProducer({
      connect: async () => {
        producer.emit(producer.events.CONNECT);
      },
    });
    const consumer = new StubConsumer({
      connect: async () => {
        consumer.emit(consumer.events.CONNECT);
      },
      run: async () => {
        await new Promise(() => {});
      },
    });

    Kafka.prototype.producer = vi.fn(() => producer as never);
    Kafka.prototype.consumer = vi.fn(() => consumer as never);

    const queue = new KafkaEventQueue({
      kafka: { brokers: ['broker-unused:9092'], topic: 'abl.workflow.execution' },
    });

    queue.onProcess(() => {});

    await flushMicrotasks();
    expect(producer.connect).toHaveBeenCalled();
    expect(consumer.connect).toHaveBeenCalled();
    expect(queue.isHealthy()).toBe(false);

    consumer.emit(consumer.events.GROUP_JOIN);
    expect(queue.isHealthy()).toBe(true);

    consumer.emit(consumer.events.DISCONNECT);
    expect(queue.isHealthy()).toBe(false);

    consumer.emit(consumer.events.GROUP_JOIN);
    expect(queue.isHealthy()).toBe(true);

    await queue.close();
  });
});
