/**
 * Job Waiter - Helper to wait for BullMQ jobs to complete
 */

import { Queue } from 'bullmq';

const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  db: parseInt(process.env.REDIS_DB || '0', 10),
};

export class JobWaiter {
  /**
   * Wait for a specific job to complete or fail
   */
  async waitForJob(
    queueName: string,
    jobId: string,
    timeoutMs = 60000,
  ): Promise<{ status: 'completed' | 'failed'; result?: any; error?: any }> {
    const queue = new Queue(queueName, { connection: REDIS_CONNECTION });

    try {
      const job = await queue.getJob(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found in queue ${queueName}`);
      }

      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error(`Job ${jobId} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const checkInterval = setInterval(async () => {
          try {
            const state = await job.getState();

            if (state === 'completed') {
              clearInterval(checkInterval);
              clearTimeout(timeout);
              const result = job.returnvalue;
              resolve({ status: 'completed', result });
            } else if (state === 'failed') {
              clearInterval(checkInterval);
              clearTimeout(timeout);
              const error = job.failedReason;
              resolve({ status: 'failed', error });
            }
          } catch (err) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            reject(err);
          }
        }, 200);
      });
    } finally {
      await queue.close();
    }
  }

  /**
   * Wait for all jobs in a queue to complete (queue becomes idle)
   */
  async waitForQueueIdle(queueName: string, timeoutMs = 120000): Promise<void> {
    const queue = new Queue(queueName, { connection: REDIS_CONNECTION });
    const start = Date.now();

    try {
      while (Date.now() - start < timeoutMs) {
        const counts = await queue.getJobCounts('active', 'waiting', 'delayed');

        if (counts.active === 0 && counts.waiting === 0 && counts.delayed === 0) {
          console.log(`[JobWaiter] Queue ${queueName} is idle`);
          return;
        }

        console.log(
          `[JobWaiter] Queue ${queueName}: active=${counts.active}, waiting=${counts.waiting}, delayed=${counts.delayed}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      throw new Error(`Queue ${queueName} did not become idle within ${timeoutMs}ms`);
    } finally {
      await queue.close();
    }
  }

  /**
   * Wait for multiple queues to become idle (useful for pipeline stages)
   */
  async waitForQueuesIdle(queueNames: string[], timeoutMs = 120000): Promise<void> {
    console.log(`[JobWaiter] Waiting for queues to become idle: ${queueNames.join(', ')}`);

    for (const queueName of queueNames) {
      await this.waitForQueueIdle(queueName, timeoutMs);
    }

    console.log('[JobWaiter] All queues are idle');
  }
}
