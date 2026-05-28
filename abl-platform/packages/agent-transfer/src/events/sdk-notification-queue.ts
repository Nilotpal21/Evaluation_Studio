import { createLogger } from '@abl/compiler/platform';
import type { SdkNotificationJob } from './types.js';

const log = createLogger('sdk-notification-queue');

export interface SdkQueueHandle {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id?: string }>;
  close(): Promise<void>;
}

export class SdkNotificationQueue {
  private readonly queue: SdkQueueHandle;

  constructor(queue: SdkQueueHandle) {
    this.queue = queue;
  }

  async enqueue(job: SdkNotificationJob): Promise<string | undefined> {
    const result = await this.queue.add('sdk_notification', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    });
    log.debug('SDK notification enqueued', {
      callbackUrl: job.callbackUrl,
      jobId: result.id,
    });
    return result.id ?? undefined;
  }

  async close(): Promise<void> {
    await this.queue.close();
    log.info('SDK notification queue closed');
  }
}
