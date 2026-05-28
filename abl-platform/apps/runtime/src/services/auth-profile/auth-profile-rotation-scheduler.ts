/**
 * Auth Profile Rotation Scheduler
 *
 * Start/stop wrapper for AuthProfileRotationJob, following the same pattern
 * as kms-rotation-job.ts: setInterval-based with immediate first run,
 * unref() to avoid blocking process exit, and graceful stop.
 *
 * Configurable via AUTH_ROTATION_INTERVAL_MS env var (default: 300000 = 5min).
 */

import { createLogger } from '@abl/compiler/platform';
import { isDatabaseAvailable } from '../../db/index.js';
import { AuthProfileRotationJob } from './auth-profile-rotation-job.js';
import { getCurrentAuthProfileKeyVersion } from './auth-profile-key-version.js';

const log = createLogger('auth-profile-rotation');

const DEFAULT_INTERVAL_MS = 300_000; // 5 minutes

let rotationTimer: NodeJS.Timeout | null = null;
let rotationInFlight = false;

export interface EncryptionServiceAdapter {
  decrypt(cipher: string): Promise<string>;
  encrypt(plaintext: string): Promise<string>;
  getCurrentKeyVersion(): number;
}

/**
 * Start the periodic auth profile rotation job.
 * No-ops if already running or database unavailable.
 *
 * @param encryptionService Optional encryption service adapter. When omitted,
 *   defaults to a passthrough (no-op) adapter for non-KMS setups where
 *   encryptedSecrets is stored as plaintext JSON.
 */
export function startAuthProfileRotationJob(
  encryptionService?: EncryptionServiceAdapter | null,
): void {
  if (rotationTimer) return;

  if (!isDatabaseAvailable()) {
    log.info('Auth profile rotation job skipped — database not available');
    return;
  }

  const parsed = parseInt(process.env.AUTH_ROTATION_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
  const intervalMs = isNaN(parsed) || parsed <= 0 ? DEFAULT_INTERVAL_MS : parsed;

  log.info('Starting auth profile rotation job', { intervalMs });

  // Use provided encryption service, or default to passthrough for non-KMS setups
  const resolvedEncryptionService: EncryptionServiceAdapter = encryptionService ?? {
    decrypt: async (cipher: string) => cipher,
    encrypt: async (plaintext: string) => plaintext,
    getCurrentKeyVersion: getCurrentAuthProfileKeyVersion,
  };

  // Build dependencies
  const runOnce = async () => {
    if (rotationInFlight) {
      log.warn('Auth profile rotation pass skipped — previous pass still running');
      return;
    }

    rotationInFlight = true;
    try {
      const { getRedisClient } = await import('../redis/redis-client.js');
      const redis = getRedisClient();

      if (!redis) {
        log.warn('Auth profile rotation skipped — Redis not available');
        return;
      }

      const job = new AuthProfileRotationJob({
        redis,
        currentKeyVersion: resolvedEncryptionService.getCurrentKeyVersion(),
      });

      const result = await job.run();
      if (result.processed > 0 || result.failed > 0) {
        log.info('Auth profile rotation pass completed', { ...result });
      }
    } catch (err) {
      log.error('Auth profile rotation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      rotationInFlight = false;
    }
  };

  // Run once immediately
  runOnce();

  rotationTimer = setInterval(runOnce, intervalMs);
  if (rotationTimer.unref) rotationTimer.unref();
}

/**
 * Stop the auth profile rotation job (for graceful shutdown).
 */
export function stopAuthProfileRotationJob(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
    rotationInFlight = false;
    log.info('Auth profile rotation job stopped');
  }
}
