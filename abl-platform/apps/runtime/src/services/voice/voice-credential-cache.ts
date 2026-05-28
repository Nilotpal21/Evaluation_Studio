/**
 * Voice Credential Cache — Redis-backed credential cache scoped to voice call duration.
 *
 * Caches decrypted credentials for active voice calls to avoid repeated decryption
 * during real-time audio processing. Each cache entry is keyed by callId and has
 * a maximum TTL of 4 hours (maximum expected call duration).
 *
 * Cache entries are invalidated on:
 * - Call end (explicit invalidation)
 * - Auth profile rotation (tenant-wide scan + delete)
 */
import type { RedisClient } from '@agent-platform/redis';
import { scanKeys } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('voice-credential-cache');

const VOICE_CACHE_PREFIX = 'auth-profile:voice';
const MAX_CALL_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface VoiceCredentialSetParams {
  tenantId: string;
  callId: string;
  credentials: Record<string, unknown>;
  ttlMs?: number;
}

export interface VoiceCredentialGetParams {
  tenantId: string;
  callId: string;
}

export class VoiceCredentialCache {
  constructor(private readonly redis: RedisClient) {}

  private key(tenantId: string, callId: string): string {
    return `${VOICE_CACHE_PREFIX}:${tenantId}:${callId}`;
  }

  /**
   * Cache credentials for a voice call.
   * TTL defaults to MAX_CALL_TTL_MS (4 hours).
   */
  async set(params: VoiceCredentialSetParams): Promise<void> {
    const ttl = Math.min(params.ttlMs ?? MAX_CALL_TTL_MS, MAX_CALL_TTL_MS);
    const k = this.key(params.tenantId, params.callId);
    await this.redis.set(k, JSON.stringify(params.credentials), 'PX', ttl);
    log.info('Cached voice credentials', {
      tenantId: params.tenantId,
      callId: params.callId,
      ttlMs: ttl,
    });
  }

  /**
   * Retrieve cached credentials for a voice call.
   * Returns null on cache miss.
   */
  async get(params: VoiceCredentialGetParams): Promise<Record<string, unknown> | null> {
    const k = this.key(params.tenantId, params.callId);
    const data = await this.redis.get(k);
    return data ? (JSON.parse(data) as Record<string, unknown>) : null;
  }

  /**
   * Invalidate cached credentials for a specific call (call-end event).
   */
  async invalidate(params: VoiceCredentialGetParams): Promise<void> {
    const k = this.key(params.tenantId, params.callId);
    await this.redis.del(k);
    log.info('Invalidated voice credentials', {
      tenantId: params.tenantId,
      callId: params.callId,
    });
  }

  /**
   * Invalidate all cached voice credentials for a tenant (rotation event).
   * Uses SCAN to avoid blocking Redis on large key sets.
   */
  async invalidateByTenant(tenantId: string): Promise<number> {
    const pattern = `${VOICE_CACHE_PREFIX}:${tenantId}:*`;
    const keys: string[] = [];
    for await (const key of scanKeys(this.redis, pattern, 100)) {
      keys.push(key);
    }

    if (keys.length > 0) {
      // Keys may span different cluster slots — delete individually.
      const results = await Promise.all(keys.map((k) => this.redis.del(k)));
      const totalDeleted = results.reduce((sum, n) => sum + n, 0);
      log.info('Invalidated voice credentials for tenant rotation', {
        tenantId,
        deletedCount: totalDeleted,
      });
      return totalDeleted;
    }

    return 0;
  }
}
