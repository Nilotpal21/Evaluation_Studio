import { createLogger } from '@abl/compiler/platform';
import { getRedisClient } from '../redis/redis-client.js';

const log = createLogger('pii-config-epoch');

const PII_CONFIG_EPOCH_CACHE_TTL_MS = 1000;
const PII_CONFIG_EPOCH_KEY_TTL_SECONDS = 35 * 24 * 60 * 60;

const localEpochs = new Map<string, number>();
const readCache = new Map<string, { value: number; expiresAt: number }>();

function buildPIIConfigEpochKey(tenantId: string, projectId: string): string {
  return `pii:config-epoch:${tenantId}:${projectId}`;
}

function parseEpoch(raw: unknown): number | null {
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

export async function getPIIConfigEpoch(tenantId: string, projectId: string): Promise<number> {
  const key = buildPIIConfigEpochKey(tenantId, projectId);
  const now = Date.now();
  const cached = readCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let epoch = localEpochs.get(key) ?? 0;
  const redis = getRedisClient();

  if (redis && typeof redis.get === 'function') {
    try {
      const redisValue = await redis.get(key);
      const parsed = redisValue !== null ? parseEpoch(redisValue) : null;
      if (parsed !== null) {
        epoch = Math.max(epoch, parsed);
      }
    } catch (err) {
      log.warn('Failed to read PII config epoch from Redis', {
        tenantId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  localEpochs.set(key, epoch);
  readCache.set(key, { value: epoch, expiresAt: now + PII_CONFIG_EPOCH_CACHE_TTL_MS });
  return epoch;
}

export async function bumpPIIConfigEpoch(tenantId: string, projectId: string): Promise<number> {
  const key = buildPIIConfigEpochKey(tenantId, projectId);
  const now = Date.now();
  let epoch = (localEpochs.get(key) ?? 0) + 1;
  const redis = getRedisClient();

  if (redis && typeof redis.incr === 'function') {
    try {
      const incremented = await redis.incr(key);
      const parsed = parseEpoch(incremented);
      if (parsed !== null) {
        epoch = parsed;
      }

      if (typeof redis.expire === 'function') {
        await redis.expire(key, PII_CONFIG_EPOCH_KEY_TTL_SECONDS);
      }
    } catch (err) {
      log.warn('Failed to bump PII config epoch in Redis', {
        tenantId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  localEpochs.set(key, epoch);
  readCache.set(key, { value: epoch, expiresAt: now + PII_CONFIG_EPOCH_CACHE_TTL_MS });
  return epoch;
}

export function resetPIIConfigEpochCache(): void {
  localEpochs.clear();
  readCache.clear();
}
