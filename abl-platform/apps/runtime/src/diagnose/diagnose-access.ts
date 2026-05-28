/**
 * Defense-in-depth access controls for `/diagnose`. Stacks on top of
 * `requireInternalNetworkAccess`:
 *
 *   1. `requireDiagnoseKey` — optional shared-secret gate. When the
 *      `DIAGNOSE_API_KEY` env var is set, the endpoint additionally
 *      requires `X-Diagnose-Key: <secret>` on the request. Unset env
 *      keeps the internal-network-only posture (backwards compatible).
 *
 *   2. `diagnoseRateLimit` — simple in-memory fixed-window limiter
 *      keyed by remote IP. Bounded memory (capped at 1_000 distinct
 *      source IPs; least-recently-seen gets evicted on overflow).
 *      Limits at 60 requests / 60s by default — plenty for operator
 *      debugging, stops a compromised in-cluster pod from hammering
 *      the endpoint.
 */

import type { RequestHandler } from 'express';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('runtime:diagnose:access');

export const DIAGNOSE_RATE_LIMIT_WINDOW_MS = 60_000;
export const DIAGNOSE_RATE_LIMIT_MAX = 60;
const DIAGNOSE_RATE_LIMIT_MAX_IPS = 1_000;

interface RateBucket {
  count: number;
  windowStart: number;
  lastSeen: number;
}

const buckets = new Map<string, RateBucket>();

function sourceIp(req: Parameters<RequestHandler>[0]): string {
  return (
    req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.header('x-real-ip') ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function evictOldestIfAtCapacity(): void {
  if (buckets.size < DIAGNOSE_RATE_LIMIT_MAX_IPS) return;
  let oldestKey: string | undefined;
  let oldestSeen = Infinity;
  for (const [key, bucket] of buckets) {
    if (bucket.lastSeen < oldestSeen) {
      oldestSeen = bucket.lastSeen;
      oldestKey = key;
    }
  }
  if (oldestKey) buckets.delete(oldestKey);
}

/**
 * Fixed-window rate limiter. Exposed as a factory so tests can override
 * the window / limit without reaching into module state. Default args
 * reflect the constants above.
 */
export function createDiagnoseRateLimit(
  options: { windowMs?: number; max?: number } = {},
): RequestHandler {
  const windowMs = options.windowMs ?? DIAGNOSE_RATE_LIMIT_WINDOW_MS;
  const max = options.max ?? DIAGNOSE_RATE_LIMIT_MAX;
  return (req, res, next) => {
    const ip = sourceIp(req);
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      evictOldestIfAtCapacity();
      bucket = { count: 0, windowStart: now, lastSeen: now };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;
    bucket.lastSeen = now;
    if (bucket.count > max) {
      log.warn('diagnose.rate_limit_exceeded', {
        ip,
        count: bucket.count,
        max,
        windowMs,
      });
      res.status(429).json({ error: 'rate_limit_exceeded' });
      return;
    }
    next();
  };
}

/**
 * Header-based shared-secret gate. Only enforced when `DIAGNOSE_API_KEY`
 * env is non-empty — services that haven't rotated to the key-gated
 * posture keep behaving exactly as before.
 *
 * Uses timing-safe compare to avoid key-leak side channels.
 */
export function createRequireDiagnoseKey(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (req, res, next) => {
    const expected = env.DIAGNOSE_API_KEY;
    if (!expected) {
      next();
      return;
    }
    const actual = req.header('x-diagnose-key') ?? '';
    if (!timingSafeEqual(actual, expected)) {
      log.warn('diagnose.unauthorized', {
        ip: sourceIp(req),
        hasHeader: actual.length > 0,
      });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Exported for tests so buckets can be reset between cases. */
export function _resetDiagnoseRateLimitForTests(): void {
  buckets.clear();
}
