/**
 * End-User Rate Limit Middleware
 *
 * Two-layer rate limiting for end-user paths:
 * 1. Per-user: eu:{tenantId}:{email} → perUserPerMinute (default: 60)
 * 2. Per-project: eu:{tenantId}:{projectId} → perProjectPerMinute (default: 1000)
 *
 * Applied AFTER identity resolution (needs email from auth middleware).
 * Uses Redis fixed-window (same pattern as existing rate-limit.ts).
 * Falls back to in-memory when Redis unavailable.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { getGlobalRedisClient } from '../services/cache/redis-client.js';

const logger = createLogger('end-user-rate-limit');

/** Default limits */
const DEFAULT_PER_USER_PER_MINUTE = 60;
const DEFAULT_PER_PROJECT_PER_MINUTE = 1000;

/** Window duration: 60 seconds */
const WINDOW_MS = 60_000;

/** In-memory fallback max entries */
const MAX_MEMORY_ENTRIES = 10_000;

/** Redis key prefix */
const KEY_PREFIX = 'eu:rl:';

// ─── In-Memory Fallback ──────────────────────────────────────────────────

interface WindowEntry {
  count: number;
  resetAt: number;
}

const memoryWindows = new Map<string, WindowEntry>();

function memoryCheck(
  key: string,
  limit: number,
): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  let entry = memoryWindows.get(key);

  if (!entry || now >= entry.resetAt) {
    if (!memoryWindows.has(key) && memoryWindows.size >= MAX_MEMORY_ENTRIES) {
      const oldestKey = memoryWindows.keys().next().value;
      if (oldestKey !== undefined) {
        memoryWindows.delete(oldestKey);
      }
    }
    entry = { count: 0, resetAt: now + WINDOW_MS };
    memoryWindows.set(key, entry);
  }

  entry.count++;
  const remaining = Math.max(0, limit - entry.count);
  return {
    allowed: entry.count <= limit,
    remaining,
    resetMs: entry.resetAt,
  };
}

// ─── Redis Check ─────────────────────────────────────────────────────────

async function redisCheck(
  key: string,
  limit: number,
): Promise<{ allowed: boolean; remaining: number; resetMs: number } | null> {
  const redis = getGlobalRedisClient();
  if (!redis.isAvailable()) {
    return null; // Fall back to memory
  }

  try {
    const fullKey = KEY_PREFIX + key;
    const countStr = await redis.get(fullKey);
    const count = countStr ? parseInt(countStr, 10) : 0;

    if (count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: Date.now() + WINDOW_MS,
      };
    }

    // Increment (set with TTL if new)
    const newCount = count + 1;
    await redis.set(fullKey, String(newCount), Math.ceil(WINDOW_MS / 1000));

    return {
      allowed: true,
      remaining: Math.max(0, limit - newCount),
      resetMs: Date.now() + WINDOW_MS,
    };
  } catch (error) {
    logger.error('Redis rate limit check failed, falling back to memory', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────

/**
 * Create end-user rate limit middleware.
 *
 * Must run AFTER end-user auth middleware (needs tenantContext + userIdentity).
 * Only applies to requests with authMode: 'user' (end-user paths).
 */
export function createEndUserRateLimitMiddleware(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Only rate-limit end-user paths
    const authMode = (req as any).authMode;
    if (authMode !== 'user') {
      return next();
    }

    const tenantId = req.tenantContext?.tenantId;
    const email = (req as any).userIdentity?.email;
    const projectId = req.tenantContext?.projectId;

    if (!tenantId || !email) {
      return next();
    }

    // Read configured rate limits from request context.
    // endUserRateLimits is set by endUserAuthMiddleware from ProjectSettings.
    const rateLimits = (req as any).endUserRateLimits as
      | { perUserPerMinute?: number; perProjectPerMinute?: number }
      | undefined;
    const perUserLimit = rateLimits?.perUserPerMinute || DEFAULT_PER_USER_PER_MINUTE;
    const perProjectLimit = rateLimits?.perProjectPerMinute || DEFAULT_PER_PROJECT_PER_MINUTE;

    // Check per-user limit
    const userKey = `${tenantId}:${email}`;
    let userResult = await redisCheck(userKey, perUserLimit);
    if (!userResult) {
      userResult = memoryCheck(userKey, perUserLimit);
    }

    if (!userResult.allowed) {
      setRateLimitHeaders(res, perUserLimit, 0, userResult.resetMs);
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Per-user rate limit exceeded (${perUserLimit} requests/minute)`,
        },
      });
      return;
    }

    // Check per-project limit
    if (projectId) {
      const projectKey = `${tenantId}:${projectId}`;
      let projectResult = await redisCheck(projectKey, perProjectLimit);
      if (!projectResult) {
        projectResult = memoryCheck(projectKey, perProjectLimit);
      }

      if (!projectResult.allowed) {
        setRateLimitHeaders(res, perProjectLimit, 0, projectResult.resetMs);
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Per-project rate limit exceeded (${perProjectLimit} requests/minute)`,
          },
        });
        return;
      }
    }

    // Set rate limit headers (user-level)
    setRateLimitHeaders(res, perUserLimit, userResult.remaining, userResult.resetMs);
    next();
  };
}

function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetMs: number,
): void {
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)));
}
