/**
 * Attachment cleanup — periodic sweep that deletes attachments older than
 * ATTACHMENT_FILE_MAX_AGE_MS from the storage base path.
 *
 * Paired with the HMAC token TTL on attachment URLs (see lib/attachment-token.ts):
 *   - token TTL  : how long the URL is openable
 *   - file MAX_AGE: how long the file survives on disk
 * Keep MAX_AGE strictly greater than TTL so a request that arrives at the
 * token-expiry boundary can never race a delete (would otherwise serve a
 * half-streamed corrupt file).
 *
 * Multi-replica safety: each sweep tries to acquire a Redis lock via SET NX PX
 * before scanning. Only one replica wins per interval. If Redis is unavailable
 * the sweep is skipped (we'd rather over-retain than risk concurrent deletes).
 */

import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';

const log = createLogger('workflow-engine:attachment-cleanup');

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_FILE_MAX_AGE_MS = 25 * 60 * 60 * 1000; // 25h — token TTL (24h) + 1h grace
const LOCK_KEY = 'workflow-engine:attachment-sweep:lock';

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function readDirOrLog(dir: string, context: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    // ENOENT is expected before the first attachment is written; debug-level
    // so we don't spam logs in a fresh deployment. Anything else is real.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.debug('sweep-dir-missing', { dir, context });
    } else {
      log.warn('sweep-dir-read-failed', {
        dir,
        context,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return [];
  }
}

async function tryAcquireLock(redis: RedisClient | null, ttlMs: number): Promise<boolean> {
  if (!redis) return false;
  try {
    const result = await redis.set(LOCK_KEY, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (err) {
    log.warn('lock-acquire-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function sweepOnce(basePath: string, maxAgeMs: number): Promise<void> {
  const root = path.join(basePath, 'attachments');
  let scanned = 0;
  let deleted = 0;
  let errors = 0;
  const startedAt = Date.now();

  const tenants = await readDirOrLog(root, 'attachments-root');
  for (const tenant of tenants) {
    const dir = path.join(root, tenant);
    const files = await readDirOrLog(dir, `tenant:${tenant}`);
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const stat = await fs.stat(full);
        if (!stat.isFile()) continue;
        scanned++;
        if (Date.now() - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(full);
          deleted++;
        }
      } catch (err) {
        errors++;
        log.warn('sweep-file-error', {
          path: full,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  log.info('attachment-sweep-completed', {
    basePath: root,
    scanned,
    deleted,
    errors,
    durationMs: Date.now() - startedAt,
  });
}

export interface AttachmentCleanupHandle {
  stop(): void;
}

/**
 * Start the periodic sweep. Returns a handle whose `stop()` clears the timer
 * (useful for tests / graceful shutdown). Safe to call when basePath does not
 * yet exist — the sweep will no-op until the first file is written.
 */
export function startAttachmentCleanup(
  basePath: string,
  redis: RedisClient | null,
): AttachmentCleanupHandle {
  const intervalMs = parseIntEnv('ATTACHMENT_SWEEP_INTERVAL_MS', DEFAULT_SWEEP_INTERVAL_MS);
  const maxAgeMs = parseIntEnv('ATTACHMENT_FILE_MAX_AGE_MS', DEFAULT_FILE_MAX_AGE_MS);

  const runSweep = async (): Promise<void> => {
    // Lock TTL slightly shorter than the interval so a crashed sweep doesn't
    // wedge the cluster for an extra cycle.
    const lockTtl = Math.max(intervalMs - 5_000, 30_000);
    const haveLock = await tryAcquireLock(redis, lockTtl);
    if (!haveLock) {
      log.debug('attachment-sweep-skipped-no-lock');
      return;
    }
    try {
      await sweepOnce(basePath, maxAgeMs);
    } catch (err) {
      log.error('attachment-sweep-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const runOrLog = (): void => {
    runSweep().catch((err) => {
      log.error('attachment-sweep-unhandled', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // Kick off one sweep on boot after a small delay (avoid startup-log noise),
  // then on the interval. Unref so the timers don't keep the process alive.
  const bootTimer = setTimeout(runOrLog, 30_000);
  bootTimer.unref?.();

  const periodic = setInterval(runOrLog, intervalMs);
  periodic.unref?.();

  log.info('attachment-cleanup-started', {
    basePath,
    intervalMs,
    maxAgeMs,
    locking: Boolean(redis),
  });

  return {
    stop() {
      clearTimeout(bootTimer);
      clearInterval(periodic);
    },
  };
}
