/**
 * Connector Presence Service
 *
 * Lightweight presence tracking using Redis hashes with short TTLs.
 * Tracks which users are actively editing a connector and on which tab.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  type RedisClient,
  type RedisConnectionHandle,
} from '@agent-platform/redis';

const logger = createLogger('connector-presence');

const PRESENCE_TTL_SECONDS = 30;

let redisHandle: RedisConnectionHandle | null = null;

function getRedis(): RedisClient {
  if (!redisHandle) {
    const opts = resolveRedisOptionsFromEnv() ?? {};
    redisHandle = createRedisConnection(opts);
  }
  return redisHandle.client;
}

function presenceKey(tenantId: string, connectorId: string): string {
  return `presence:${tenantId}:${connectorId}`;
}

export async function sendHeartbeat(
  connectorId: string,
  tenantId: string,
  userId: string,
  userName: string,
  activeTab: string,
): Promise<void> {
  try {
    const redis = getRedis();
    const key = presenceKey(tenantId, connectorId);
    const value = JSON.stringify({
      userId,
      userName,
      activeTab,
      lastSeen: new Date().toISOString(),
    });

    await redis.hset(key, userId, value);
    await redis.expire(key, PRESENCE_TTL_SECONDS);
  } catch (err) {
    logger.error('Failed to send heartbeat', {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getActiveEditors(
  connectorId: string,
  tenantId: string,
): Promise<Array<{ userId: string; userName: string; activeTab: string; lastSeen: string }>> {
  try {
    const redis = getRedis();
    const key = presenceKey(tenantId, connectorId);
    const entries = await redis.hgetall(key);

    if (!entries || Object.keys(entries).length === 0) {
      return [];
    }

    const editors: Array<{
      userId: string;
      userName: string;
      activeTab: string;
      lastSeen: string;
    }> = [];

    for (const value of Object.values(entries)) {
      try {
        const parsed = JSON.parse(value) as {
          userId: string;
          userName: string;
          activeTab: string;
          lastSeen: string;
        };
        editors.push(parsed);
      } catch {
        // Skip malformed entries
      }
    }

    return editors;
  } catch (err) {
    logger.error('Failed to get active editors', {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
