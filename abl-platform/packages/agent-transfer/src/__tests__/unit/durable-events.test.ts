import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DurableEventQueue, type QueueHandle } from '../../events/durable-event-queue.js';
import {
  EventWorker,
  type EventProcessor,
  type DeadLetterHandler,
} from '../../events/event-worker.js';
import { SdkNotificationQueue, type SdkQueueHandle } from '../../events/sdk-notification-queue.js';
import type { AgentDesktopEventJob, SdkNotificationJob } from '../../events/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeJob(overrides?: Partial<AgentDesktopEventJob>): AgentDesktopEventJob {
  return {
    sessionKey: 'agent_transfer:t1:c1:chat',
    tenantId: 't1',
    contactId: 'c1',
    channel: 'chat',
    eventType: 'agent_message',
    payload: { text: 'hello' },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('DurableEventQueue', () => {
  let mockQueue: QueueHandle;
  let queue: DurableEventQueue;

  beforeEach(() => {
    mockQueue = {
      add: vi.fn().mockResolvedValue({ id: 'job-1' }),
      close: vi.fn().mockResolvedValue(undefined),
      getWaitingCount: vi.fn().mockResolvedValue(5),
      getActiveCount: vi.fn().mockResolvedValue(2),
    };
    queue = new DurableEventQueue(mockQueue);
  });

  it('enqueues events with correct options', async () => {
    const job = makeJob();
    const id = await queue.enqueue(job);

    expect(id).toBe('job-1');
    expect(mockQueue.add).toHaveBeenCalledWith(
      'agent_message',
      job,
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }),
    );
  });

  it('returns job ID from enqueue', async () => {
    const id = await queue.enqueue(makeJob());
    expect(id).toBe('job-1');
  });

  it('returns undefined when job has no id', async () => {
    (mockQueue.add as any).mockResolvedValue({});
    const id = await queue.enqueue(makeJob());
    expect(id).toBeUndefined();
  });

  it('reports queue depth', async () => {
    const depth = await queue.getQueueDepth();
    expect(depth).toEqual({ waiting: 5, active: 2 });
  });

  it('closes queue gracefully', async () => {
    await queue.close();
    expect(mockQueue.close).toHaveBeenCalled();
  });
});

describe('EventWorker', () => {
  it('processes jobs via processor callback', async () => {
    const processor: EventProcessor = vi.fn().mockResolvedValue(undefined);
    const worker = new EventWorker({ processor });
    const job = makeJob();

    await worker.processJob({ data: job, attemptsMade: 0 });
    expect(processor).toHaveBeenCalledWith(job);
  });

  it('calls dead letter handler on failure', async () => {
    const dlHandler: DeadLetterHandler = vi.fn().mockResolvedValue(undefined);
    const worker = new EventWorker({
      processor: vi.fn(),
      deadLetterHandler: dlHandler,
    });
    const job = makeJob();
    const error = new Error('processing failed');

    await worker.handleDeadLetter({ data: job }, error);
    expect(dlHandler).toHaveBeenCalledWith(job, error);
  });

  it('re-throws errors from processor', async () => {
    const processor: EventProcessor = vi.fn().mockRejectedValue(new Error('boom'));
    const worker = new EventWorker({ processor });

    await expect(worker.processJob({ data: makeJob(), attemptsMade: 1 })).rejects.toThrow('boom');
  });

  it('closes worker', async () => {
    const mockHandle = { close: vi.fn().mockResolvedValue(undefined) };
    const worker = new EventWorker({ processor: vi.fn() });
    worker.setWorker(mockHandle);

    await worker.close();
    expect(mockHandle.close).toHaveBeenCalled();
  });

  it('close is safe when no worker is set', async () => {
    const worker = new EventWorker({ processor: vi.fn() });
    await expect(worker.close()).resolves.toBeUndefined();
  });
});

describe('SdkNotificationQueue', () => {
  let mockQueue: SdkQueueHandle;
  let sdkQueue: SdkNotificationQueue;

  beforeEach(() => {
    mockQueue = {
      add: vi.fn().mockResolvedValue({ id: 'sdk-1' }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    sdkQueue = new SdkNotificationQueue(mockQueue);
  });

  it('enqueues SDK notification jobs', async () => {
    const job: SdkNotificationJob = {
      callbackUrl: 'https://example.com/hook',
      payload: { event: 'transfer' },
      timestamp: Date.now(),
    };

    const id = await sdkQueue.enqueue(job);
    expect(id).toBe('sdk-1');
    expect(mockQueue.add).toHaveBeenCalledWith(
      'sdk_notification',
      job,
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('closes gracefully', async () => {
    await sdkQueue.close();
    expect(mockQueue.close).toHaveBeenCalled();
  });
});
