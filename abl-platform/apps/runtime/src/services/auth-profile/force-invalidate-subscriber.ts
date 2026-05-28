/**
 * Force-Invalidate Subscriber
 *
 * Subscribes to the Redis pub/sub channel `auth-profile:invalidate` and
 * evicts cached credentials from the pod-local AuthProfileCache. This ensures
 * that when Studio publishes an invalidation event (e.g., after admin revocation
 * or profile update), all runtime pods drop stale cached credentials within
 * a single pub/sub round-trip, rather than waiting for TTL expiry.
 *
 * Lifecycle:
 *   - `start()`: subscribe to the channel via a dedicated Redis subscriber connection
 *   - `stop()`: unsubscribe and close the subscriber connection
 *
 * Idempotent: invalidating an already-evicted cache entry is a no-op (closes OQ-4).
 */

import { createLogger } from '@abl/compiler/platform';
import {
  AUTH_PROFILE_INVALIDATE_CHANNEL,
  type ForceInvalidatePayload,
} from '@agent-platform/shared/services/auth-profile';
import { emitAuthProfileTraceEvent } from '@agent-platform/shared/services/auth-profile';
import type { AuthProfileCache } from './auth-profile-cache.js';

const log = createLogger('auth-profile-force-invalidate-subscriber');

// ─── Redis Subscriber Port ────────────────────────────────────────────

/** Minimal Redis subscriber interface for DI. */
export interface RedisSubscriberPort {
  on(event: 'message', handler: (channel: string, message: string) => void): void;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

// ─── Subscriber ───────────────────────────────────────────────────────

export type SubscriberState = 'idle' | 'subscribing' | 'subscribed' | 'stopped';

export class ForceInvalidateSubscriber {
  private readonly cache: AuthProfileCache;
  private subscriber: RedisSubscriberPort | null = null;
  private readonly createSubscriber: () => RedisSubscriberPort | null;
  private _state: SubscriberState = 'idle';

  constructor(deps: {
    cache: AuthProfileCache;
    createSubscriber: () => RedisSubscriberPort | null;
  }) {
    this.cache = deps.cache;
    this.createSubscriber = deps.createSubscriber;
  }

  get state(): SubscriberState {
    return this._state;
  }

  async start(): Promise<void> {
    if (this._state === 'subscribed' || this._state === 'subscribing') {
      log.warn('ForceInvalidateSubscriber already started', { state: this._state });
      return;
    }

    this._state = 'subscribing';

    const sub = this.createSubscriber();
    if (!sub) {
      log.warn(
        'ForceInvalidateSubscriber: Redis subscriber unavailable — force-invalidate disabled',
      );
      this._state = 'idle';
      return;
    }

    this.subscriber = sub;

    sub.on('message', (channel: string, message: string) => {
      if (channel !== AUTH_PROFILE_INVALIDATE_CHANNEL) return;
      this.handleMessage(message);
    });

    try {
      await sub.subscribe(AUTH_PROFILE_INVALIDATE_CHANNEL);
      this._state = 'subscribed';
      log.info('ForceInvalidateSubscriber subscribed', {
        channel: AUTH_PROFILE_INVALIDATE_CHANNEL,
      });
    } catch (err) {
      this._state = 'idle';
      log.error('ForceInvalidateSubscriber: subscribe failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stop(): Promise<void> {
    if (this._state === 'stopped' || this._state === 'idle') {
      return;
    }

    this._state = 'stopped';

    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(AUTH_PROFILE_INVALIDATE_CHANNEL);
        await this.subscriber.quit();
      } catch (err) {
        log.warn('ForceInvalidateSubscriber: cleanup error (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.subscriber = null;
    }

    log.info('ForceInvalidateSubscriber stopped');
  }

  private handleMessage(raw: string): void {
    let payload: ForceInvalidatePayload & { timestamp?: string };
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      log.warn('ForceInvalidateSubscriber: malformed message', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!payload.tenantId) {
      log.warn('ForceInvalidateSubscriber: missing tenantId in payload');
      return;
    }

    // Invalidate cache — idempotent (no-op if entry already evicted)
    this.cache.invalidate(payload.tenantId, payload.profileId);

    emitAuthProfileTraceEvent({
      eventType: 'auth_profile.cache_invalidated',
      profileId: payload.profileId ?? '',
      tenantId: payload.tenantId,
      timestamp: payload.timestamp ?? new Date().toISOString(),
      metadata: { reason: 'force', projectId: payload.projectId },
    });

    log.info('auth_profile_cache_force_invalidated', {
      profileId: payload.profileId,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
    });
  }
}
