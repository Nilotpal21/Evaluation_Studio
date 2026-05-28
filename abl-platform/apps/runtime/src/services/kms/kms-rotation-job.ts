/**
 * KMS Rotation Job
 *
 * Periodic job (setInterval, 60min) that handles:
 *   1. Epoch transitions: active DEKs past expiry → decrypt_only
 *   2. DEK destruction: decrypt_only DEKs past retention → destroyed (wrappedDek zeroed)
 *   3. Re-encryption eligibility: if a tenant's KEK exceeds rotation period OR
 *      platform-default DEKs drift from the current platform provider → enqueue job
 *
 * Safe to run on all pods — all operations are idempotent (MongoDB findOneAndUpdate
 * with status predicates).
 *
 * Follows the session-cleanup-job.ts pattern: setInterval with unref(), immediate
 * first run, graceful stop.
 */

import { createLogger } from '@abl/compiler/platform';
import { isDatabaseAvailable } from '../../db/index.js';
import { logKMSAuditEvent } from './kms-audit-logger.js';

const log = createLogger('kms-rotation-job');

// =============================================================================
// TYPES
// =============================================================================

export interface KMSRotationConfig {
  /** Interval between rotation checks in minutes (default: 60) */
  intervalMinutes: number;
  /** Days to retain decrypt_only DEKs before destruction. Null disables destruction. */
  dekRetentionDays: number | null;
  /** KEK rotation period in days — trigger re-encryption when exceeded (default: 365) */
  kekRotationPeriodDays: number;
  /** Whether to enqueue re-encryption jobs (requires BullMQ) (default: true) */
  enableReencryption: boolean;
}

const DEFAULT_CONFIG: KMSRotationConfig = {
  intervalMinutes: 60,
  dekRetentionDays: null,
  kekRotationPeriodDays: 365,
  enableReencryption: true,
};

// =============================================================================
// STATE
// =============================================================================

let rotationTimer: NodeJS.Timeout | null = null;

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Start the periodic KMS rotation job.
 * No-ops if already running or database unavailable.
 */
export function startKMSRotationJob(config?: Partial<KMSRotationConfig>): void {
  if (rotationTimer) return;

  if (!isDatabaseAvailable()) {
    log.info('KMS rotation job skipped — database not available');
    return;
  }

  const cfg: KMSRotationConfig = { ...DEFAULT_CONFIG, ...config };
  const intervalMs = cfg.intervalMinutes * 60 * 1000;

  log.info('Starting KMS rotation job', {
    intervalMinutes: cfg.intervalMinutes,
    dekRetentionDays: cfg.dekRetentionDays,
    kekRotationPeriodDays: cfg.kekRotationPeriodDays,
  });

  // Run once immediately
  runRotation(cfg).catch((err) => log.error('Initial KMS rotation failed', { error: String(err) }));

  rotationTimer = setInterval(() => {
    runRotation(cfg).catch((err) =>
      log.error('Periodic KMS rotation failed', { error: String(err) }),
    );
  }, intervalMs);

  if (rotationTimer.unref) rotationTimer.unref();
}

/**
 * Stop the KMS rotation job (for graceful shutdown).
 */
export function stopKMSRotationJob(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
    log.info('KMS rotation job stopped');
  }
}

// =============================================================================
// ROTATION LOGIC
// =============================================================================

async function runRotation(config: KMSRotationConfig): Promise<void> {
  if (!isDatabaseAvailable()) return;

  const now = new Date();

  // Phase 1a: Epoch transitions (global — uses DEK expiresAt field)
  const transitioned = await transitionExpiredDEKs(now);

  // Phase 1b: Usage-based transitions (Decision 6 — maxUsageCount safety ceiling)
  const overused = await transitionOverusedDEKs();

  // Phase 2: DEK destruction — per-tenant retention
  let totalDestroyed = 0;
  try {
    const { TenantKMSConfig } = await import('@agent-platform/database/models');
    const tenantConfigs = await TenantKMSConfig.find({}).select('tenantId dekRetentionDays').lean();

    const tenantIds: string[] = [];
    for (const tc of tenantConfigs) {
      const retention =
        (tc as any).dekRetentionDays !== undefined
          ? ((tc as any).dekRetentionDays as number | null)
          : config.dekRetentionDays;
      totalDestroyed += await destroyRetiredDEKs(now, retention, (tc as any).tenantId);
      tenantIds.push((tc as any).tenantId);
    }
    // Also destroy for tenants without config (use global default)
    totalDestroyed += await destroyRetiredDEKs(now, config.dekRetentionDays, undefined, tenantIds);
  } catch (err) {
    log.warn('Falling back to global DEK destruction policy after tenant retention lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    totalDestroyed = await destroyRetiredDEKs(now, config.dekRetentionDays);
  }

  // Phase 3: KEK age check
  let reencryptionQueued = 0;
  if (config.enableReencryption) {
    reencryptionQueued = await checkKEKRotation(config.kekRotationPeriodDays);
  }

  if (transitioned > 0 || overused > 0 || totalDestroyed > 0 || reencryptionQueued > 0) {
    log.info('KMS rotation pass completed', {
      transitioned,
      overused,
      destroyed: totalDestroyed,
      reencryptionQueued,
    });
  }
}

/**
 * Phase 1: Transition expired active DEKs to decrypt_only.
 * Idempotent — only updates DEKs where status='active' AND expiresAt < now.
 */
async function transitionExpiredDEKs(now: Date): Promise<number> {
  try {
    const { DEKEntry } = await import('@agent-platform/database/models');

    const result = await DEKEntry.updateMany(
      {
        status: 'active',
        expiresAt: { $lt: now },
      },
      {
        $set: { status: 'decrypt_only', retiredAt: now },
      },
    );

    const count = result.modifiedCount;
    if (count > 0) {
      log.info('Transitioned expired DEKs to decrypt_only', { count });
      logKMSAuditEvent({
        tenantId: 'system',
        operation: 'dek_expiry_transition',
        keyId: 'batch',
        providerType: 'system',
        success: true,
        latencyMs: 0,
        metadata: { count },
      });
    }
    return count;
  } catch (err) {
    logKMSAuditEvent({
      tenantId: 'system',
      operation: 'dek_expiry_transition',
      keyId: 'batch',
      providerType: 'system',
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
    });
    log.error('Failed to transition expired DEKs', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Phase 1b: Transition overused active DEKs to decrypt_only.
 * Decision 6: maxUsageCount is a safety ceiling (~2^30). This is the batch
 * catch-all — acquireDEK also checks inline for real-time rotation.
 */
async function transitionOverusedDEKs(): Promise<number> {
  try {
    const { DEKEntry } = await import('@agent-platform/database/models');
    const now = new Date();

    const result = await DEKEntry.updateMany(
      {
        status: 'active',
        maxUsageCount: { $gt: 0 },
        $expr: { $gte: ['$usageCount', '$maxUsageCount'] },
      },
      {
        $set: { status: 'decrypt_only', retiredAt: now },
      },
    );

    const count = result.modifiedCount;
    if (count > 0) {
      log.info('Transitioned overused DEKs to decrypt_only', { count });
      logKMSAuditEvent({
        tenantId: 'system',
        operation: 'dek_usage_transition',
        keyId: 'batch',
        providerType: 'system',
        success: true,
        latencyMs: 0,
        metadata: { count },
      });
    }
    return count;
  } catch (err) {
    logKMSAuditEvent({
      tenantId: 'system',
      operation: 'dek_usage_transition',
      keyId: 'batch',
      providerType: 'system',
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
    });
    log.error('Failed to transition overused DEKs', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Phase 2: Destroy DEKs that have been in decrypt_only for longer than retention period.
 * Sets status='destroyed' and zeros out wrappedDek.
 */
async function destroyRetiredDEKs(
  now: Date,
  retentionDays: number | null,
  tenantId?: string,
  excludeTenantIds?: string[],
): Promise<number> {
  try {
    const { DEKEntry } = await import('@agent-platform/database/models');

    if (retentionDays == null) {
      return 0;
    }

    const retentionCutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    // Only destroy keys that have been explicitly retired and have exceeded
    // the configured decrypt-only retention window.
    const query: Record<string, any> = {
      status: 'decrypt_only',
      retiredAt: { $ne: null, $lt: retentionCutoff },
    };
    if (tenantId && excludeTenantIds && excludeTenantIds.length > 0) {
      throw new Error('destroyRetiredDEKs: tenantId and excludeTenantIds are mutually exclusive');
    }
    if (tenantId) query.tenantId = tenantId;
    if (excludeTenantIds && excludeTenantIds.length > 0) {
      query.tenantId = { $nin: excludeTenantIds };
    }

    const result = await DEKEntry.updateMany(query, {
      $set: {
        status: 'destroyed',
        wrappedDek: '',
        destroyedAt: now,
      },
    });

    const count = result.modifiedCount;
    if (count > 0) {
      log.info('Destroyed retired DEKs', { count, retentionDays, tenantId: tenantId ?? 'global' });
      logKMSAuditEvent({
        tenantId: tenantId ?? 'system',
        operation: 'dek_destruction',
        keyId: 'batch',
        providerType: 'system',
        success: true,
        latencyMs: 0,
        metadata: { count, retentionDays },
      });
    }
    return count;
  } catch (err) {
    logKMSAuditEvent({
      tenantId: tenantId ?? 'system',
      operation: 'dek_destruction',
      keyId: 'batch',
      providerType: 'system',
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
      metadata: { retentionDays },
    });
    log.error('Failed to destroy retired DEKs', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Phase 3: Check if any tenant should be re-encrypted because its KEK exceeded
 * the configured rotation period or because platform-default-backed DEKs drifted
 * from the current platform provider configuration.
 */
async function checkKEKRotation(defaultRotationPeriodDays: number): Promise<number> {
  const candidateJobs = new Map<
    string,
    { reason: 'kek-age-exceeded' | 'provider-drift'; dedupeKey?: string }
  >();
  const reencryptionDisabledTenants = new Set<string>();

  try {
    const { TenantKMSConfig } = await import('@agent-platform/database/models');

    const tenantConfigs = await TenantKMSConfig.find({})
      .select(
        'tenantId defaultProvider lastKekRotatedAt createdAt kekRotationPeriodDays reencryption.enabled',
      )
      .lean();

    for (const config of tenantConfigs) {
      if ((config as any)?.reencryption?.enabled === false && (config as any)?.tenantId) {
        reencryptionDisabledTenants.add((config as any).tenantId);
      }
    }

    const staleConfigs = tenantConfigs.filter((config: any) => {
      if (
        config?.defaultProvider?.providerType == null ||
        config.defaultProvider.providerType === 'local'
      ) {
        return false;
      }
      if (config?.reencryption?.enabled === false) {
        return false;
      }
      const rotationPeriodDays =
        typeof config?.kekRotationPeriodDays === 'number'
          ? config.kekRotationPeriodDays
          : defaultRotationPeriodDays;
      const cutoff = new Date(Date.now() - rotationPeriodDays * 24 * 60 * 60 * 1000);
      const effectiveRotatedAt = config.lastKekRotatedAt ?? config.createdAt;
      return effectiveRotatedAt instanceof Date
        ? effectiveRotatedAt < cutoff
        : new Date(effectiveRotatedAt) < cutoff;
    });

    for (const config of staleConfigs) {
      candidateJobs.set((config as any).tenantId, { reason: 'kek-age-exceeded' });
    }
  } catch (err) {
    log.error('Failed to check KEK rotation age', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { DEKEntry } = await import('@agent-platform/database/models');
    const { KMSResolver, computeFingerprint } = await import('@agent-platform/database/kms');
    const platformDefault = KMSResolver.getPlatformDefault();

    if (platformDefault.provider.providerType !== 'local') {
      const platformFingerprint = computeFingerprint(platformDefault.provider);
      const candidateEntries = await DEKEntry.find({
        status: { $in: ['active', 'decrypt_only'] },
        $or: [{ wrappingProvider: null }, { wrappingSourceConfigVersion: { $in: [0, null] } }],
      })
        .select('tenantId wrappingProvider wrappingSourceConfigVersion')
        .lean();

      for (const entry of candidateEntries as Array<{
        tenantId?: string;
        wrappingProvider?: Record<string, unknown> | null;
      }>) {
        if (
          !entry.tenantId ||
          candidateJobs.has(entry.tenantId) ||
          reencryptionDisabledTenants.has(entry.tenantId)
        ) {
          continue;
        }
        if (!entry.wrappingProvider) {
          candidateJobs.set(entry.tenantId, {
            reason: 'provider-drift',
            dedupeKey: `target-provider:${platformFingerprint}`,
          });
          continue;
        }
        const entryFingerprint = computeFingerprint(entry.wrappingProvider as any);
        if (entryFingerprint !== platformFingerprint) {
          candidateJobs.set(entry.tenantId, {
            reason: 'provider-drift',
            dedupeKey: `target-provider:${platformFingerprint}`,
          });
        }
      }
    }
  } catch (err) {
    log.error('Failed to detect platform-default provider drift', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (candidateJobs.size === 0) return 0;

  try {
    let queued = 0;
    for (const [tenantId, candidate] of candidateJobs) {
      try {
        const { enqueueReencryption } = await import('./reencryption-queue.js');
        await enqueueReencryption({
          tenantId,
          reason: candidate.reason,
          ...(candidate.dedupeKey ? { dedupeKey: candidate.dedupeKey } : {}),
        });
        queued++;
      } catch (err) {
        log.warn('Failed to enqueue re-encryption job', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (queued > 0) {
      log.info('Enqueued KEK rotation re-encryption jobs', {
        queued,
        reasons: Object.fromEntries(
          [...candidateJobs.entries()].reduce(
            (acc, [, candidate]) => acc.set(candidate.reason, (acc.get(candidate.reason) ?? 0) + 1),
            new Map<string, number>(),
          ),
        ),
      });
    }

    return queued;
  } catch (err) {
    log.error('Failed to check KEK rotation', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
