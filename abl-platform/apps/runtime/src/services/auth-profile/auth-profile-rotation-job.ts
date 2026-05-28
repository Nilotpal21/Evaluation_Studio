/**
 * Auth Profile Rotation Batch Job
 *
 * Re-encrypts all Auth Profile secrets when the encryption master key rotates.
 * Delegates ALL crypto to the Mongoose encryption plugin — the job simply reads
 * each profile (plugin decrypts with fallback to previous keys) and saves it
 * back (plugin re-encrypts with the current key).
 *
 * Uses per-profile distributed locks via Redis SET NX PX to prevent concurrent
 * rotation + token refresh on the same profile.
 *
 * Pattern: single-pass batch job (caller invokes `.run()` on a schedule).
 */
import type { RedisClient } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import { DistributedLockManager } from '@agent-platform/shared';

const log = createLogger('auth-profile-rotation');
const LOCK_TTL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

export interface RotationJobConfig {
  /** Redis client for distributed locks. Accepts either standalone Redis or
   * Cluster — DistributedLockManager only uses single-key SET NX PX. */
  redis: RedisClient;
  /** Number of profiles to process per batch. Defaults to 100. */
  batchSize?: number;
  /** The current encryption key version. Profiles with lower versions get re-encrypted. */
  currentKeyVersion: number;
  /** Grace period during which previousEncryptedSecrets remains valid. Defaults to 5 minutes. */
  gracePeriodMs?: number;
}

export interface RotationResult {
  processed: number;
  skipped: number;
  failed: number;
}

export class AuthProfileRotationJob {
  private readonly batchSize: number;
  private readonly gracePeriodMs: number;

  constructor(private readonly config: RotationJobConfig) {
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.gracePeriodMs = config.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  }

  /**
   * Run one full rotation pass.
   *
   * For each profile with encryptionKeyVersion < currentKeyVersion:
   *   1. Read through Mongoose (plugin decrypts with fallback to previous keys)
   *   2. Store current encryptedSecrets as previousEncryptedSecrets (grace period)
   *   3. markModified('encryptedSecrets') to force plugin re-encryption
   *   4. Save through Mongoose (plugin re-encrypts with current key)
   */
  async run(): Promise<RotationResult> {
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { getAuthProfileCache } = await import('../auth-profile-resolver.js');
    const currentVersion = this.config.currentKeyVersion;
    const result: RotationResult = { processed: 0, skipped: 0, failed: 0 };
    const lockManager = new DistributedLockManager(this.config.redis);

    log.info('Starting rotation job', {
      currentKeyVersion: currentVersion,
      batchSize: this.batchSize,
    });

    let hasMore = true;
    let lastSeenId: string | null = null;
    while (hasMore) {
      // Tenant-scoped batch: the plugin's post-find hook will auto-decrypt
      // using decryptForTenantWithFallback (tries current key, then previous keys)
      const batchFilter: Record<string, unknown> = {
        encryptionKeyVersion: { $lt: currentVersion },
      };
      if (lastSeenId) {
        batchFilter._id = { $gt: lastSeenId };
      }

      const batch = await (AuthProfile as any)
        .find(batchFilter)
        .sort({ _id: 1 })
        .limit(this.batchSize);

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      lastSeenId = String(batch[batch.length - 1]?._id ?? lastSeenId);

      for (const profile of batch) {
        try {
          const tenantId = profile.tenantId;
          const profileId = String(profile._id);

          if (!tenantId) {
            log.warn('Profile missing tenantId — skipping', { profileId });
            result.skipped++;
            continue;
          }

          // Acquire distributed lock (same namespace as token refresh)
          const lock = await lockManager.acquire(`${tenantId}:${profileId}`, {
            keyPrefix: 'auth-profile:op-lock',
            ttlMs: LOCK_TTL_MS,
          });

          if (!lock) {
            result.skipped++;
            log.info('Skipped profile (lock held)', { profileId });
            continue;
          }

          try {
            // At this point, profile.encryptedSecrets is already decrypted by the plugin.
            // Save the current (decrypted) value as previousEncryptedSecrets for grace period.
            // The plugin will encrypt both fields on save.
            profile.previousEncryptedSecrets = profile.encryptedSecrets;
            profile.rotationGracePeriodMs = this.gracePeriodMs;
            profile.encryptionKeyVersion = currentVersion;

            // Force the plugin to re-encrypt encryptedSecrets with the current key
            profile.markModified('encryptedSecrets');

            await profile.save();
            getAuthProfileCache().invalidate(tenantId, profileId);

            result.processed++;
            log.info('Rotated auth profile', { profileId, tenantId });
          } finally {
            await lockManager.release(lock).catch((releaseErr: unknown) => {
              log.warn('Failed to release auth profile rotation lock', {
                profileId,
                tenantId,
                error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
              });
            });
          }
        } catch (err) {
          result.failed++;
          log.error('Failed to rotate auth profile', {
            profileId: String(profile._id),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (batch.length < this.batchSize) {
        hasMore = false;
      }
    }

    log.info('Rotation job complete', { ...result });
    return result;
  }
}
