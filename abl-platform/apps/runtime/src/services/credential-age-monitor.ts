import { createLogger } from '@abl/compiler/platform';

const log = createLogger('credential-age-monitor');

const MS_PER_DAY = 86_400_000;
const DEFAULT_WARNING_AGE_DAYS = 60;
const DEFAULT_CRITICAL_AGE_DAYS = 90;
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_ROTATION_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface CredentialAgeMonitorOptions {
  eventStore: { write(event: unknown): void };
  warningAgeDays?: number;
  criticalAgeDays?: number;
  checkIntervalMs?: number;
}

interface CredentialRecord {
  _id: string;
  tenantId: string;
  createdAt: Date;
  rotatedAt?: Date | null;
  [key: string]: unknown;
}

export class CredentialAgeMonitor {
  private readonly eventStore: { write(event: unknown): void };
  private readonly warningAgeDays: number;
  private readonly criticalAgeDays: number;
  private readonly checkIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CredentialAgeMonitorOptions) {
    this.eventStore = options.eventStore;
    this.warningAgeDays = options.warningAgeDays ?? DEFAULT_WARNING_AGE_DAYS;
    this.criticalAgeDays = options.criticalAgeDays ?? DEFAULT_CRITICAL_AGE_DAYS;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  }

  async checkAll(): Promise<void> {
    try {
      const { ToolSecret, LLMCredential, ApiKey, AuthProfile } =
        await import('@agent-platform/database/models');

      const warningThreshold = new Date(Date.now() - this.warningAgeDays * MS_PER_DAY);
      const criticalThreshold = new Date(Date.now() - this.criticalAgeDays * MS_PER_DAY);

      const [toolSecrets, llmCredentials, apiKeys, authProfileCandidates] = await Promise.all([
        ToolSecret.find({ createdAt: { $lt: warningThreshold } }).lean() as Promise<
          CredentialRecord[]
        >,
        LLMCredential.find({ createdAt: { $lt: warningThreshold } }).lean() as Promise<
          CredentialRecord[]
        >,
        ApiKey.find({ createdAt: { $lt: warningThreshold } }).lean() as Promise<CredentialRecord[]>,
        this.findAuthProfileCandidates(AuthProfile, warningThreshold),
      ]);

      const allCandidates = [
        ...toolSecrets.map((s) => ({ ...s, source: 'ToolSecret' })),
        ...llmCredentials.map((s) => ({ ...s, source: 'LLMCredential' })),
        ...apiKeys.map((s) => ({ ...s, source: 'ApiKey' })),
        ...authProfileCandidates.map((s) => ({ ...s, source: 'AuthProfile' })),
      ];

      let alertCount = 0;
      for (const cred of allCandidates) {
        const effectiveDate = cred.rotatedAt ?? cred.createdAt;
        const ageDays = Math.floor((Date.now() - new Date(effectiveDate).getTime()) / MS_PER_DAY);

        // Skip if effective date (rotatedAt or createdAt) is within warning threshold
        if (new Date(effectiveDate) >= warningThreshold) continue;

        alertCount++;
        if (new Date(effectiveDate) < criticalThreshold) {
          this.eventStore.write({
            type: 'credential.age.critical',
            tenantId: cred.tenantId,
            credentialId: String(cred._id),
            credentialType: cred.source,
            ageDays,
            threshold: this.criticalAgeDays,
            timestamp: new Date().toISOString(),
          });
        } else {
          this.eventStore.write({
            type: 'credential.age.warning',
            tenantId: cred.tenantId,
            credentialId: String(cred._id),
            credentialType: cred.source,
            ageDays,
            threshold: this.warningAgeDays,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Auth Profile expiration alerts: profiles approaching their expiresAt date
      const expirationAlertCount = await this.checkAuthProfileExpiration(AuthProfile);
      alertCount += expirationAlertCount;

      if (alertCount > 0) {
        log.info('Credential age check complete', { alertCount });
      }
    } catch (err) {
      log.error('Credential age check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Find AuthProfile records that are candidates for age-based alerts.
   * Checks profiles where:
   * - createdAt is old AND no rotationPolicy is set, OR
   * - lastValidatedAt is older than the warning threshold
   */
  private async findAuthProfileCandidates(
    AuthProfile: { find(query: Record<string, unknown>): { lean(): Promise<unknown[]> } },
    warningThreshold: Date,
  ): Promise<CredentialRecord[]> {
    try {
      // AUTH-PROFILE-QUERY-SHAPE-OK: cross-tenant admin scan — emits per-tenant alerts on the result.
      return (await AuthProfile.find({
        status: 'active',
        $or: [
          { createdAt: { $lt: warningThreshold }, rotationPolicy: { $exists: false } },
          { lastValidatedAt: { $lt: warningThreshold } },
        ],
      }).lean()) as CredentialRecord[];
    } catch (err) {
      log.warn('Failed to query AuthProfile for age check', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Check AuthProfile records approaching their expiresAt date.
   * Emits alerts for profiles expiring within the rotation grace period.
   */
  private async checkAuthProfileExpiration(AuthProfile: {
    find(query: Record<string, unknown>): { lean(): Promise<unknown[]> };
  }): Promise<number> {
    try {
      const now = new Date();
      const graceDeadline = new Date(now.getTime() + DEFAULT_ROTATION_GRACE_PERIOD_MS);

      // Find active profiles expiring within the grace period
      // AUTH-PROFILE-QUERY-SHAPE-OK: cross-tenant admin scan — emits per-tenant expiration alerts.
      const expiringProfiles = (await AuthProfile.find({
        status: 'active',
        expiresAt: { $ne: null, $lte: graceDeadline, $gt: now },
      }).lean()) as Array<CredentialRecord & { expiresAt?: Date; rotationPolicy?: unknown }>;

      let alertCount = 0;
      for (const profile of expiringProfiles) {
        if (!profile.expiresAt) continue;
        const daysUntilExpiry = Math.floor(
          (new Date(profile.expiresAt).getTime() - now.getTime()) / MS_PER_DAY,
        );

        alertCount++;
        this.eventStore.write({
          type: 'credential.expiration.approaching',
          tenantId: profile.tenantId,
          credentialId: String(profile._id),
          credentialType: 'AuthProfile',
          daysUntilExpiry,
          expiresAt: new Date(profile.expiresAt).toISOString(),
          hasRotationPolicy: !!profile.rotationPolicy,
          timestamp: now.toISOString(),
        });
      }

      return alertCount;
    } catch (err) {
      log.warn('Failed to check AuthProfile expiration', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  start(): void {
    this.checkAll();
    this.timer = setInterval(() => this.checkAll(), this.checkIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
