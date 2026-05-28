/**
 * Durable Event Queue Factory
 *
 * Creates a BullMQ queue and worker for durable agent transfer event processing.
 * Events like agent messages, agent connected/disconnected are persisted in the
 * queue for reliable delivery with retries and dead letter handling.
 */
import { Queue, Worker, type Job } from 'bullmq';
import type { RedisClient, RedisConnectionHandle } from '@agent-platform/redis';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { createBullMQPair, type BullMQConnectionPair } from '@agent-platform/redis/bullmq';
import { createLogger } from '@abl/compiler/platform';
import { randomUUID } from 'crypto';
import {
  DurableEventQueue,
  EventWorker,
  DeadLetterStore,
  type DeadLetterStoreHandle,
  type DeadLetterEntry,
  type AgentDesktopEventJob,
  type EventProcessor,
} from '@agent-platform/agent-transfer';

const log = createLogger('event-queue-factory');

const QUEUE_NAME = 'agent-transfer-events';

/**
 * Dead letter entries are global (not per-tenant). Tenant filtering is done at
 * query time via the `tenantId` field stored in each entry.
 */
const DEAD_LETTER_REDIS_KEY = 'agent-transfer:dead-letters';

/**
 * Maximum number of dead letter entries to retain. The Redis hash has no
 * built-in TTL per-field, so this size cap acts as the eviction mechanism.
 * When the cap is exceeded, the oldest entries (by `failedAt`) are trimmed.
 */
const MAX_DEAD_LETTER_ENTRIES = 1000;

/**
 * Redis-backed DeadLetterStoreHandle.
 *
 * Stores dead letter entries as a Redis hash keyed by entry id,
 * providing the persistence interface DeadLetterStore requires.
 *
 * Uses HSCAN-based cursor iteration to avoid loading the entire hash
 * into memory, and batch HDEL for atomic multi-key deletion.
 */
function createRedisDeadLetterStore(redis: RedisClient): DeadLetterStoreHandle {
  /**
   * Trim the dead letter hash to MAX_DEAD_LETTER_ENTRIES by removing
   * the oldest entries (by `failedAt`). Uses HSCAN to avoid loading
   * the entire hash at once.
   */
  async function trimOldestEntries(): Promise<void> {
    const currentSize = await redis.hlen(DEAD_LETTER_REDIS_KEY);
    if (currentSize <= MAX_DEAD_LETTER_ENTRIES) return;

    const entriesToRemove = currentSize - MAX_DEAD_LETTER_ENTRIES;
    const allEntries: { id: string; failedAt: string }[] = [];

    let cursor = '0';
    do {
      const [nextCursor, fields] = await redis.hscan(DEAD_LETTER_REDIS_KEY, cursor, 'COUNT', 200);
      cursor = nextCursor;
      for (let i = 0; i < fields.length; i += 2) {
        const id = fields[i];
        const raw = fields[i + 1];
        try {
          const entry = JSON.parse(raw) as Record<string, unknown>;
          allEntries.push({ id, failedAt: String(entry.failedAt ?? '') });
        } catch {
          // Malformed entries are prime candidates for eviction
          allEntries.push({ id, failedAt: '' });
        }
      }
    } while (cursor !== '0');

    // Sort oldest first; entries with empty/unparseable failedAt are evicted first
    allEntries.sort((a, b) => a.failedAt.localeCompare(b.failedAt));

    const idsToDelete = allEntries.slice(0, entriesToRemove).map((e) => e.id);
    if (idsToDelete.length > 0) {
      await redis.hdel(DEAD_LETTER_REDIS_KEY, ...idsToDelete);
      log.info('Trimmed dead letter entries', {
        removed: idsToDelete.length,
        remaining: currentSize - idsToDelete.length,
      });
    }
  }

  return {
    async insert(entry: DeadLetterEntry): Promise<void> {
      await redis.hset(DEAD_LETTER_REDIS_KEY, entry.id, JSON.stringify(entry));

      // Enforce size cap — trim oldest entries when over the limit
      try {
        await trimOldestEntries();
      } catch (err) {
        log.error('Failed to trim dead letter entries after insert', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    async find(filter: Record<string, unknown>, limit: number): Promise<DeadLetterEntry[]> {
      // Use HSCAN with cursor-based iteration instead of hvals() to avoid
      // loading the entire hash into memory at once.
      const entries: DeadLetterEntry[] = [];
      let cursor = '0';

      do {
        const [nextCursor, fields] = await redis.hscan(DEAD_LETTER_REDIS_KEY, cursor, 'COUNT', 200);
        cursor = nextCursor;

        // HSCAN returns [field, value, field, value, ...]
        for (let i = 0; i < fields.length; i += 2) {
          const raw = fields[i + 1];
          try {
            const entry = JSON.parse(raw) as DeadLetterEntry;
            const matches = Object.entries(filter).every(([key, value]) => {
              const entryValue = (entry as unknown as Record<string, unknown>)[key];
              return entryValue === value;
            });
            if (matches) {
              entries.push(entry);
              if (entries.length >= limit) return entries;
            }
          } catch {
            // Skip malformed entries
          }
        }
      } while (cursor !== '0');

      return entries;
    },

    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<void> {
      const id = filter.id as string | undefined;
      if (!id) return;
      const raw = await redis.hget(DEAD_LETTER_REDIS_KEY, id);
      if (!raw) return;
      try {
        const entry = JSON.parse(raw) as Record<string, unknown>;
        Object.assign(entry, update);
        await redis.hset(DEAD_LETTER_REDIS_KEY, id, JSON.stringify(entry));
      } catch {
        // Skip malformed entries
      }
    },

    async deleteMany(filter: Record<string, unknown>): Promise<number> {
      // Use HSCAN with cursor-based iteration instead of hgetall() to avoid
      // loading the entire hash into memory. Collect matching IDs, then
      // batch delete with a single HDEL call for atomicity.
      //
      // Supports MongoDB-style operators: { $lt: Date } for date comparisons.
      const idsToDelete: string[] = [];
      let cursor = '0';

      do {
        const [nextCursor, fields] = await redis.hscan(DEAD_LETTER_REDIS_KEY, cursor, 'COUNT', 200);
        cursor = nextCursor;

        for (let i = 0; i < fields.length; i += 2) {
          const id = fields[i];
          const raw = fields[i + 1];
          try {
            const entry = JSON.parse(raw) as Record<string, unknown>;
            const matches = Object.entries(filter).every(([key, filterValue]) => {
              const entryValue = entry[key];
              // Support { $lt: value } operator for date/number comparisons
              if (
                filterValue &&
                typeof filterValue === 'object' &&
                '$lt' in (filterValue as Record<string, unknown>)
              ) {
                const threshold = (filterValue as Record<string, unknown>).$lt;
                // Compare as dates if both are Date-like
                const entryTime =
                  entryValue instanceof Date
                    ? entryValue.getTime()
                    : typeof entryValue === 'string'
                      ? new Date(entryValue).getTime()
                      : Number(entryValue);
                const thresholdTime =
                  threshold instanceof Date
                    ? threshold.getTime()
                    : typeof threshold === 'string'
                      ? new Date(threshold).getTime()
                      : Number(threshold);
                return !isNaN(entryTime) && !isNaN(thresholdTime) && entryTime < thresholdTime;
              }
              return entryValue === filterValue;
            });
            if (matches) {
              idsToDelete.push(id);
            }
          } catch {
            // Skip malformed entries
          }
        }
      } while (cursor !== '0');

      if (idsToDelete.length > 0) {
        await redis.hdel(DEAD_LETTER_REDIS_KEY, ...idsToDelete);
      }
      return idsToDelete.length;
    },
  };
}

export interface EventQueueComponents {
  queue: Queue;
  worker: Worker;
  durableQueue: DurableEventQueue;
  eventWorker: EventWorker;
  /** Disconnect the BullMQ connection pair (must be called after worker/queue close). */
  disconnect(): void;
}

/**
 * Create BullMQ queue, worker, DurableEventQueue, and EventWorker.
 */
export function createEventQueue(
  handle: RedisConnectionHandle,
  processor: EventProcessor,
): EventQueueComponents {
  const pair: BullMQConnectionPair = createBullMQPair(handle);

  const queue = new Queue(QUEUE_NAME, {
    connection: pair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: { count: 100, age: 86400 },
      removeOnFail: { count: 500, age: 604800 },
    },
  });

  const durableQueue = new DurableEventQueue(queue);

  const deadLetterStoreHandle = createRedisDeadLetterStore(handle.client);
  const deadLetterStore = new DeadLetterStore(deadLetterStoreHandle);

  const eventWorker = new EventWorker({
    processor,
    deadLetterHandler: async (job: AgentDesktopEventJob, error: Error) => {
      log.error('Event moved to dead letter queue', {
        eventType: job.eventType,
        sessionKey: job.sessionKey,
        error: error.message,
      });
      try {
        await deadLetterStore.save({
          id: randomUUID(),
          queue: QUEUE_NAME,
          jobId: job.sessionKey,
          eventType: job.eventType,
          payload: job.payload,
          error: error.message,
          failedAt: new Date(),
          tenantId: job.tenantId,
          retryCount: 3,
          resolved: false,
        });
      } catch (dlErr) {
        log.error('Failed to store dead letter entry', {
          error: dlErr instanceof Error ? dlErr.message : String(dlErr),
        });
      }
    },
    concurrency: 10,
  });

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job<AgentDesktopEventJob>) => {
      await eventWorker.processJob({ data: job.data, attemptsMade: job.attemptsMade });
    },
    {
      connection: pair.workerConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency: 10,
    },
  );

  // Wire dead letter handler for final failures
  worker.on('failed', async (job, error) => {
    try {
      if (job && job.attemptsMade >= (job.opts?.attempts ?? 3)) {
        await eventWorker.handleDeadLetter(
          { data: job.data as AgentDesktopEventJob },
          error ?? new Error('Unknown failure'),
        );
      }
    } catch (err) {
      log.error('Dead letter handler threw in failed callback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  worker.on('error', (err) => {
    log.error('Event worker error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  eventWorker.setWorker(worker);

  log.info('Durable event queue and worker created', { queueName: QUEUE_NAME });

  return {
    queue,
    worker,
    durableQueue,
    eventWorker,
    disconnect: () => pair.disconnect(),
  };
}

/**
 * Gracefully close event queue components.
 */
export async function closeEventQueue(components: EventQueueComponents): Promise<void> {
  try {
    // Close EventWorker first — this closes the BullMQ Worker internally
    // and sets its reference to null. Do NOT call components.worker.close()
    // again as that would double-close the same BullMQ Worker.
    await components.eventWorker.close();
    await components.durableQueue.close();
    await components.queue.close();
    // Disconnect BullMQ connection pair — BullMQ's .close() does NOT disconnect Redis.
    components.disconnect();
    log.info('Durable event queue closed');
  } catch (err) {
    log.error('Failed to close event queue', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
