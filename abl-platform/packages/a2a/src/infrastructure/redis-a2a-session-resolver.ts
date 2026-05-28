/**
 * RedisA2ASessionResolver — Redis-backed A2A session resolver.
 *
 * Maps A2A contextId to a platform RuntimeSession using Redis.
 *
 * Key structure:
 *   a2a:session:{tenantId}:{contextId} → sessionId   TTL: configurable (default 24h)
 */

import type { RedisClient } from '@agent-platform/redis';
import type { A2ASessionResolverPort, ResolvedA2ASession } from '../domain/ports.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('a2a:redis-session-resolver');

export interface RedisSessionResolverOptions {
  redis: RedisClient;
  /** TTL in minutes (default: 1440 = 24 hours) */
  ttlMinutes?: number;
}

export class RedisA2ASessionResolver implements A2ASessionResolverPort {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number;

  constructor(options: RedisSessionResolverOptions) {
    this.redis = options.redis;
    this.ttlSeconds = (options.ttlMinutes ?? 1440) * 60;
  }

  private key(tenantId: string, contextId: string): string {
    // Validate no key separator injection
    const safeTenantId = tenantId.replace(/:/g, '_');
    const safeContextId = contextId.replace(/:/g, '_');
    return `a2a:session:${safeTenantId}:${safeContextId}`;
  }

  async resolveSession(contextId: string, tenantId: string): Promise<ResolvedA2ASession> {
    try {
      const sessionId = await this.redis.get(this.key(tenantId, contextId));
      if (sessionId) {
        return { sessionId, isNew: false };
      }
      return { sessionId: '', isNew: true };
    } catch (err) {
      log.warn('Failed to resolve session from Redis — falling back to new session', {
        tenantId,
        contextId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { sessionId: '', isNew: true };
    }
  }

  async registerSession(contextId: string, tenantId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.set(this.key(tenantId, contextId), sessionId, 'EX', this.ttlSeconds);
      log.debug('Registered session mapping', { tenantId, contextId, sessionId });
    } catch (err) {
      log.error('Failed to register session in Redis', {
        tenantId,
        contextId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async touchSession(contextId: string, tenantId: string): Promise<void> {
    try {
      await this.redis.expire(this.key(tenantId, contextId), this.ttlSeconds);
    } catch (err) {
      log.warn('Failed to refresh session TTL in Redis', {
        tenantId,
        contextId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async closeSession(contextId: string, tenantId: string): Promise<void> {
    try {
      await this.redis.del(this.key(tenantId, contextId));
      log.debug('Closed session mapping', { tenantId, contextId });
    } catch (err) {
      log.warn('Failed to delete session from Redis', {
        tenantId,
        contextId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Atomic register-if-absent using Redis SET NX.
   * If the key already exists, returns the existing sessionId.
   * If the key does not exist, sets it and returns the provided sessionId.
   */
  async registerSessionIfAbsent(
    contextId: string,
    tenantId: string,
    sessionId: string,
  ): Promise<{ sessionId: string; alreadyExisted: boolean }> {
    const k = this.key(tenantId, contextId);
    try {
      // SET NX EX — only sets if not exists, with TTL
      const result = await this.redis.set(k, sessionId, 'EX', this.ttlSeconds, 'NX');
      if (result === 'OK') {
        log.debug('Atomically registered session mapping', { tenantId, contextId, sessionId });
        return { sessionId, alreadyExisted: false };
      }

      // Another request won the race — read the winner's sessionId
      const existingSessionId = await this.redis.get(k);
      if (existingSessionId) {
        log.debug('Session already registered by concurrent request', {
          tenantId,
          contextId,
          requestedSessionId: sessionId,
          existingSessionId,
        });
        return { sessionId: existingSessionId, alreadyExisted: true };
      }

      // Edge case: key expired between SET NX and GET — fall back to unconditional set
      await this.redis.set(k, sessionId, 'EX', this.ttlSeconds);
      return { sessionId, alreadyExisted: false };
    } catch (err) {
      log.error('Failed atomic session registration in Redis', {
        tenantId,
        contextId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
