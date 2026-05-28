/**
 * Session Timeout Scheduler
 *
 * Creates BullMQ delayed jobs that fire after a session TTL expires.
 * Uses QueueHandle to avoid a direct BullMQ dependency, keeping the
 * module testable with in-memory fakes.
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('session-timeout-scheduler');

export interface TimeoutQueueHandle {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id?: string }>;
  remove(jobId: string): Promise<void>;
  close(): Promise<void>;
}

export interface TimeoutJob {
  sessionKey: string;
  scheduledAt: number;
}

export type TimeoutHandler = (sessionKey: string) => void | Promise<void>;

const MAX_ACTIVE_JOBS = 10_000;

export class SessionTimeoutScheduler {
  private readonly queue: TimeoutQueueHandle;
  private readonly activeJobs = new Map<string, string>();
  private onTimeoutHandler?: TimeoutHandler;

  constructor(queue: TimeoutQueueHandle) {
    this.queue = queue;
  }

  /**
   * Register a handler that is called when a timeout fires.
   * In production the BullMQ worker calls processTimeout() which
   * invokes this handler.
   */
  onTimeout(handler: TimeoutHandler): void {
    this.onTimeoutHandler = handler;
  }

  async scheduleTimeout(sessionKey: string, ttlMs: number): Promise<string | undefined> {
    // Cancel any existing timeout for this session first
    await this.cancelTimeout(sessionKey);

    const job: TimeoutJob = {
      sessionKey,
      scheduledAt: Date.now(),
    };

    const result = await this.queue.add('session_timeout', job, {
      delay: ttlMs,
      removeOnComplete: true,
      removeOnFail: 50,
      jobId: `timeout:${sessionKey}`,
    });

    const jobId = result.id ?? undefined;
    if (jobId) {
      // Evict oldest entry if at capacity — cancel the BullMQ job first
      if (this.activeJobs.size >= MAX_ACTIVE_JOBS) {
        const oldest = this.activeJobs.keys().next().value as string | undefined;
        if (oldest) {
          const oldJobId = this.activeJobs.get(oldest);
          if (oldJobId) {
            await this.queue.remove(oldJobId).catch(() => {});
          }
          this.activeJobs.delete(oldest);
        }
      }
      this.activeJobs.set(sessionKey, jobId);
    }

    log.debug('Timeout scheduled', { sessionKey, ttlMs, jobId });
    return jobId;
  }

  async cancelTimeout(sessionKey: string): Promise<void> {
    const jobId = this.activeJobs.get(sessionKey);
    if (!jobId) return;

    try {
      await this.queue.remove(jobId);
      log.debug('Timeout cancelled', { sessionKey, jobId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Failed to cancel timeout job', { sessionKey, jobId, error: message });
    } finally {
      this.activeJobs.delete(sessionKey);
    }
  }

  /**
   * Called by the BullMQ worker when a delayed timeout job fires.
   */
  async processTimeout(data: TimeoutJob): Promise<void> {
    log.info('Session timeout fired', { sessionKey: data.sessionKey });
    this.activeJobs.delete(data.sessionKey);

    if (this.onTimeoutHandler) {
      await this.onTimeoutHandler(data.sessionKey);
    }
  }

  get pendingCount(): number {
    return this.activeJobs.size;
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.activeJobs.clear();
    log.info('Session timeout scheduler closed');
  }
}
