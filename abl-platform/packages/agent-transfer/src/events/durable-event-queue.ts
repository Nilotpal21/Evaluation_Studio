import { createLogger } from '@abl/compiler/platform';
import type { AgentDesktopEventJob, DurableEventConfig } from './types.js';
import { DEFAULT_EVENT_CONFIG } from './types.js';

const log = createLogger('durable-event-queue');

export interface QueueHandle {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id?: string }>;
  close(): Promise<void>;
  getWaitingCount(): Promise<number>;
  getActiveCount(): Promise<number>;
}

export class DurableEventQueue {
  private readonly queue: QueueHandle;
  private readonly config: DurableEventConfig;

  constructor(queue: QueueHandle, config?: Partial<DurableEventConfig>) {
    this.config = { ...DEFAULT_EVENT_CONFIG, ...config };
    this.queue = queue;
  }

  async enqueue(job: AgentDesktopEventJob): Promise<string | undefined> {
    const result = await this.queue.add(job.eventType, job, {
      attempts: this.config.maxRetries,
      backoff: {
        type: this.config.backoffType,
        delay: this.config.initialDelayMs,
      },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    log.debug('Event enqueued', {
      eventType: job.eventType,
      sessionKey: job.sessionKey,
      jobId: result.id,
    });
    return result.id ?? undefined;
  }

  async getQueueDepth(): Promise<{ waiting: number; active: number }> {
    const [waiting, active] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
    ]);
    return { waiting, active };
  }

  async close(): Promise<void> {
    await this.queue.close();
    log.info('Durable event queue closed');
  }
}
