/**
 * Dead Letter Store
 *
 * Persists failed event jobs that have exhausted retries.
 * Uses a generic StoreHandle interface so it can be backed
 * by MongoDB, in-memory maps, or any other persistence layer.
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('dead-letter-store');

export interface DeadLetterEntry {
  id: string;
  queue: string;
  jobId: string;
  eventType: string;
  payload: Record<string, unknown>;
  error: string;
  failedAt: Date;
  tenantId: string;
  retryCount: number;
  resolved: boolean;
}

export interface DeadLetterStoreHandle {
  insert(entry: DeadLetterEntry): Promise<void>;
  find(filter: Record<string, unknown>, limit: number): Promise<DeadLetterEntry[]>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<void>;
  deleteMany(filter: Record<string, unknown>): Promise<number>;
}

export class DeadLetterStore {
  private readonly store: DeadLetterStoreHandle;

  constructor(store: DeadLetterStoreHandle) {
    this.store = store;
  }

  async save(entry: DeadLetterEntry): Promise<void> {
    await this.store.insert(entry);
    log.info('Dead letter entry saved', {
      id: entry.id,
      eventType: entry.eventType,
      tenantId: entry.tenantId,
      queue: entry.queue,
    });
  }

  async findByTenant(tenantId: string, limit = 50): Promise<DeadLetterEntry[]> {
    return this.store.find({ tenantId, resolved: false }, limit);
  }

  async markResolved(id: string): Promise<void> {
    await this.store.updateOne({ id }, { resolved: true });
    log.info('Dead letter entry resolved', { id });
  }

  async deleteOlderThan(date: Date): Promise<number> {
    const count = await this.store.deleteMany({ failedAt: { $lt: date } });
    if (count > 0) {
      log.info('Dead letter entries purged', { count, olderThan: date.toISOString() });
    }
    return count;
  }
}
