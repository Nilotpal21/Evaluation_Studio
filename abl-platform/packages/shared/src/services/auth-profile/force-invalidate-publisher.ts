/**
 * Force-Invalidate Publisher
 *
 * Publishes auth profile invalidation messages to Redis pub/sub channel
 * `auth-profile:invalidate`. Used by Studio routes (Phase 4) to notify
 * runtime pods to evict cached credentials.
 *
 * Lives in `packages/shared` so both Studio and runtime can import it
 * (Studio cannot reach into `apps/runtime/`).
 */

import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('auth-profile-force-invalidate-publisher');

const CHANNEL = 'auth-profile:invalidate';

export interface ForceInvalidatePayload {
  profileId: string;
  tenantId: string;
  projectId: string | null;
}

export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * Publish a force-invalidate message to the Redis pub/sub channel.
 *
 * @param payload  The invalidation payload identifying the profile
 * @param redis    A Redis client with `publish` capability (injected via DI)
 * @returns        The number of subscribers that received the message
 */
export async function publishAuthProfileInvalidate(
  payload: ForceInvalidatePayload,
  redis: RedisPublisher,
): Promise<number> {
  try {
    const message = JSON.stringify({
      profileId: payload.profileId,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      timestamp: new Date().toISOString(),
    });

    const subscriberCount = await redis.publish(CHANNEL, message);

    log.info('auth_profile_invalidation_published', {
      profileId: payload.profileId,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      channel: CHANNEL,
      subscriberCount,
    });

    return subscriberCount;
  } catch (err) {
    log.error('auth_profile_invalidation_publish_failed', {
      profileId: payload.profileId,
      tenantId: payload.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** The Redis pub/sub channel name, exported for subscribers. */
export const AUTH_PROFILE_INVALIDATE_CHANNEL = CHANNEL;
