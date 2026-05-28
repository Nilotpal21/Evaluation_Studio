#!/usr/bin/env tsx
/**
 * Agentic Compat Callback DLQ Inspector
 *
 * Lists dead-letter entries from the `agent-assist-callback-dlq` queue.
 *
 * Usage:
 *   npx tsx apps/runtime/scripts/agent-assist-dlq-inspect.ts [--limit N] [--redis-url URL]
 *
 * Options:
 *   --limit N          Max entries to list (default: 50)
 *   --redis-url URL    Redis URL (default: from REDIS_URL env var)
 */

import { createLogger } from '@abl/compiler/platform';
import {
  createBullMQPair,
  createRedisConnection,
  type RedisConnectionOptions,
} from '@agent-platform/redis';

const log = createLogger('dlq-inspect');

const DLQ_QUEUE_NAME = 'agent-assist-callback-dlq';
const BULLMQ_PREFIX = '{bull}';

function parseArgs(argv: string[]): { limit: number; redisUrl: string } {
  let limit = 50;
  let redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit' && argv[i + 1]) {
      limit = parseInt(argv[i + 1], 10) || 50;
      i++;
    } else if (argv[i] === '--redis-url' && argv[i + 1]) {
      redisUrl = argv[i + 1];
      i++;
    }
  }

  return { limit, redisUrl };
}

function resolveRedisOptions(redisUrl: string): RedisConnectionOptions {
  const opts: RedisConnectionOptions = { url: redisUrl };
  if (process.env.REDIS_PASSWORD) opts.password = process.env.REDIS_PASSWORD;

  const clusterEnabled = process.env.REDIS_CLUSTER === 'true' || redisUrl.includes(',');
  if (clusterEnabled) opts.cluster = true;

  if (process.env.REDIS_TLS_ENABLED === 'true' || process.env.REDIS_TLS === 'true') {
    opts.tls = { enabled: true };
  } else if (process.env.REDIS_TLS_ENABLED === 'false' || process.env.REDIS_TLS === 'false') {
    opts.tls = { enabled: false };
  }

  return opts;
}

async function main(): Promise<void> {
  const { limit, redisUrl } = parseArgs(process.argv);
  const bullmq = await import('bullmq');

  const handle = createRedisConnection(resolveRedisOptions(redisUrl));
  const pair = createBullMQPair(handle, { watchdog: false });
  const queue = new bullmq.Queue(DLQ_QUEUE_NAME, {
    connection: pair.queueConnection,
    prefix: BULLMQ_PREFIX,
  });

  try {
    const waiting = await queue.getWaiting(0, limit - 1);
    const completed = await queue.getCompleted(0, limit - 1);
    const all = [...waiting, ...completed].slice(0, limit);

    if (all.length === 0) {
      log.info('DLQ is empty');
      return;
    }

    log.info(`DLQ entries: ${all.length}`);

    for (const job of all) {
      const data = job.data as {
        runId?: string;
        lastError?: { code?: string; message?: string; statusCode?: number };
        attempts?: number;
        firstAttemptAt?: string;
        lastAttemptAt?: string;
      };
      log.info('DLQ entry', {
        jobId: job.id,
        runId: data.runId,
        errorCode: data.lastError?.code,
        errorMessage: data.lastError?.message,
        statusCode: data.lastError?.statusCode,
        attempts: data.attempts,
        firstAttemptAt: data.firstAttemptAt,
        lastAttemptAt: data.lastAttemptAt,
        addedAt: job.timestamp ? new Date(job.timestamp).toISOString() : undefined,
      });
    }
  } finally {
    await queue.close();
    pair.disconnect();
    await handle.disconnect();
  }
}

main().catch((err) => {
  log.error('DLQ inspect failed', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
