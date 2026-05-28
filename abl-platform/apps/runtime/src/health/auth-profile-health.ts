/**
 * AuthProfile Health Probe
 *
 * Verifies MongoDB, decryption, Redis lock, audit event write-path,
 * and force-invalidate subscriber subsystems are operational for
 * auth profile operations.
 */
import { createLogger } from '@abl/compiler/platform';
import type { SubscriberState } from '../services/auth-profile/force-invalidate-subscriber.js';

const log = createLogger('auth-profile-health');

export interface AuthProfileHealthResult {
  healthy: boolean;
  mongo: boolean;
  decryption: boolean;
  redisLock: boolean;
  auditEventsWritePath: boolean;
  forceInvalidateSubscriber: boolean;
  latencyMs: number;
}

export async function checkAuthProfileHealth(deps: {
  mongoProbe: () => Promise<boolean>;
  decryptionProbe: () => Promise<boolean>;
  redisProbe: () => Promise<boolean>;
  auditEventsProbe?: () => Promise<boolean>;
  subscriberStateProbe?: () => SubscriberState;
}): Promise<AuthProfileHealthResult> {
  const start = Date.now();
  const [mongo, decryption, redisLock, auditEventsWritePath] = await Promise.all([
    deps.mongoProbe().catch(() => false),
    deps.decryptionProbe().catch(() => false),
    deps.redisProbe().catch(() => false),
    deps.auditEventsProbe ? deps.auditEventsProbe().catch(() => false) : Promise.resolve(true),
  ]);

  const subscriberState = deps.subscriberStateProbe ? deps.subscriberStateProbe() : 'subscribed';
  const forceInvalidateSubscriber = subscriberState === 'subscribed';

  const healthy =
    mongo && decryption && redisLock && auditEventsWritePath && forceInvalidateSubscriber;
  const latencyMs = Date.now() - start;

  if (!healthy) {
    log.warn('AuthProfile health check degraded', {
      mongo,
      decryption,
      redisLock,
      auditEventsWritePath,
      forceInvalidateSubscriber,
      subscriberState,
      latencyMs,
    });
  }

  return {
    healthy,
    mongo,
    decryption,
    redisLock,
    auditEventsWritePath,
    forceInvalidateSubscriber,
    latencyMs,
  };
}
