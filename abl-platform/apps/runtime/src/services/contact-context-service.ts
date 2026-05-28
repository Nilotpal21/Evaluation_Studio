/**
 * ContactContextService
 *
 * Manages cross-session contact context with a Redis cache (5min TTL)
 * and MongoDB as the source of truth.
 *
 * Follows the fail-open pattern from GuardrailCache: Redis errors
 * result in a cache miss and DB fallback, never a blocked request.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ContactContext } from '../contexts/contact/domain/contact.js';

export type { ContactContext };

const log = createLogger('contact-context-service');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal Redis-like interface for dependency injection.
 * Compatible with ioredis and node-redis.
 */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, duration: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Port for loading/updating contact context in the database.
 * Injected to avoid direct Mongoose dependency in the service.
 */
export interface ContactContextRepo {
  getContactContext(tenantId: string, contactId: string): Promise<ContactContext | null>;
  updateContactContext(tenantId: string, contactId: string, context: ContactContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache TTL: 5 minutes */
const CACHE_TTL_SECONDS = 300;
/** Redis key prefix for contact context */
const CACHE_PREFIX = 'ctx';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ContactContextService {
  constructor(
    private readonly redis: RedisLike | null,
    private readonly repo: ContactContextRepo,
  ) {}

  private cacheKey(tenantId: string, contactId: string): string {
    return `${CACHE_PREFIX}:${tenantId}:${contactId}`;
  }

  /**
   * Load contact context with Redis cache.
   * Cache hit → return cached. Cache miss → load from DB and populate cache.
   * Redis failure → fall through to DB (fail-open).
   */
  async get(tenantId: string, contactId: string): Promise<ContactContext | null> {
    // Try cache first
    if (this.redis) {
      try {
        const cached = await this.redis.get(this.cacheKey(tenantId, contactId));
        if (cached) {
          return JSON.parse(cached) as ContactContext;
        }
      } catch (err) {
        log.warn('Contact context cache get failed, falling back to DB', {
          tenantId,
          contactId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Cache miss or Redis unavailable — load from DB
    const context = await this.repo.getContactContext(tenantId, contactId);

    // Populate cache on DB hit
    if (context && this.redis) {
      try {
        await this.redis.set(
          this.cacheKey(tenantId, contactId),
          JSON.stringify(context),
          'EX',
          CACHE_TTL_SECONDS,
        );
      } catch (err) {
        log.warn('Contact context cache set failed', {
          tenantId,
          contactId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return context;
  }

  /**
   * Update contact context in MongoDB and invalidate Redis cache.
   *
   * Note: if invalidate() fails, the cache will serve stale data until
   * TTL expiry (CACHE_TTL_SECONDS = 300s). This is acceptable under the
   * fail-open pattern — correctness is bounded by the 5-minute TTL window.
   */
  async update(tenantId: string, contactId: string, context: ContactContext): Promise<void> {
    await this.repo.updateContactContext(tenantId, contactId, context);
    await this.invalidate(tenantId, contactId);
  }

  /**
   * Invalidate the Redis cache for a contact's context.
   */
  async invalidate(tenantId: string, contactId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.cacheKey(tenantId, contactId));
    } catch (err) {
      log.warn('Contact context cache invalidate failed', {
        tenantId,
        contactId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

// Promise-based singleton prevents async double-init race: concurrent callers
// await the same Promise rather than each creating a separate instance.
let initPromise: Promise<ContactContextService> | null = null;

/**
 * Create the default ContactContextRepo backed by Mongoose.
 */
function createDefaultRepo(): ContactContextRepo {
  return {
    async getContactContext(tenantId: string, contactId: string): Promise<ContactContext | null> {
      const { Contact } = await import('@agent-platform/database/models');
      const doc = await Contact.findOne({ _id: contactId, tenantId }, { contactContext: 1 }).lean();
      return (doc as any)?.contactContext ?? null;
    },

    async updateContactContext(
      tenantId: string,
      contactId: string,
      context: ContactContext,
    ): Promise<void> {
      const { Contact } = await import('@agent-platform/database/models');
      await Contact.findOneAndUpdate(
        { _id: contactId, tenantId },
        { $set: { contactContext: context } },
      );
    },
  };
}

/**
 * Get or create the singleton ContactContextService.
 * Lazily resolves Redis from the runtime's redis-client module.
 */
export function getContactContextService(): Promise<ContactContextService> {
  if (!initPromise) {
    initPromise = (async () => {
      let redis: RedisLike | null = null;
      try {
        const { getRedisClient } = await import('./redis/redis-client.js');
        redis = getRedisClient() ?? null;
      } catch (err) {
        log.info('Redis not available for contact context cache', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return new ContactContextService(redis, createDefaultRepo());
    })();
  }
  return initPromise;
}

/** Reset singleton (for testing). */
export function resetContactContextService(): void {
  initPromise = null;
}
