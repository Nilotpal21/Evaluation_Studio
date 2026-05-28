import { createLogger } from '@abl/compiler/platform';
import type { AgentDesktopEventJob } from './types.js';

const log = createLogger('event-worker');

export type EventProcessor = (job: AgentDesktopEventJob) => Promise<void>;
export type DeadLetterHandler = (job: AgentDesktopEventJob, error: Error) => Promise<void>;

export interface WorkerHandle {
  close(): Promise<void>;
}

export interface EventWorkerConfig {
  processor: EventProcessor;
  deadLetterHandler?: DeadLetterHandler;
  concurrency?: number;
}

export class EventWorker {
  private readonly config: EventWorkerConfig;
  private worker: WorkerHandle | null = null;

  constructor(config: EventWorkerConfig) {
    this.config = config;
  }

  setWorker(worker: WorkerHandle): void {
    this.worker = worker;
  }

  async processJob(job: { data: AgentDesktopEventJob; attemptsMade: number }): Promise<void> {
    const { data } = job;
    try {
      await this.config.processor(data);
      log.debug('Event processed', {
        eventType: data.eventType,
        sessionKey: data.sessionKey,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Event processing failed', {
        eventType: data.eventType,
        sessionKey: data.sessionKey,
        attempt: job.attemptsMade,
        error: error.message,
      });
      throw error;
    }
  }

  async handleDeadLetter(job: { data: AgentDesktopEventJob }, error: Error): Promise<void> {
    if (this.config.deadLetterHandler) {
      await this.config.deadLetterHandler(job.data, error);
    }
    log.error('Event moved to dead letter', {
      eventType: job.data.eventType,
      sessionKey: job.data.sessionKey,
      error: error.message,
    });
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    log.info('Event worker closed');
  }
}
