/**
 * Per-Tenant Configuration Service
 *
 * Provides plan-based defaults and per-tenant overrides for:
 * - Rate limits and resource quotas
 * - Feature flags
 * - Security settings
 *
 * Plans: FREE → TEAM → BUSINESS → ENTERPRISE
 *
 * Data resolution chain:
 *   1. Plan defaults (PLAN_LIMITS / PLAN_FEATURES / DEFAULT_SECURITY)
 *   2. Subscription-level tenant quota overrides (from DB)
 *   3. Tenant model settings overrides (from DB)
 *   4. In-memory overrides (setOverrides — ephemeral)
 *   5. Project-level overrides via resolveEffectiveLimits()
 *
 * Redis caching: key `cfg:{tenantId}`, TTL 300s (5 min).
 */

import { getRedisClient } from './redis/redis-client.js';
import { createLogger } from '@abl/compiler/platform';
import type {
  Plan,
  TenantLimits,
  TenantFeatures,
  TenantSecurityConfig,
  TenantConfig,
} from '@agent-platform/config';
import { isDatabaseReady } from '../db/index.js';

export type { Plan, TenantLimits, TenantFeatures, TenantSecurityConfig, TenantConfig };

const log = createLogger('tenant-config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis cache key prefix for tenant config */
const CACHE_PREFIX = 'cfg:';

/** Redis cache TTL in seconds (5 minutes) */
const CACHE_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------
// Plan defaults
// ---------------------------------------------------------------------------

export const PLAN_LIMITS: Record<Plan, TenantLimits> = {
  FREE: {
    maxConcurrentSessions: 10,
    maxServiceTimeoutMs: 10_000,
    maxResponseBodyBytes: 524_288, // 512KB
    maxConcurrentServiceCalls: 3,
    maxPendingTimers: 100,
    maxAgentsPerProject: 3,
    maxEventTypesPerApp: 10,
    maxProjectsPerOrg: 3,
    requestsPerMinute: 60,
    tokensPerMinute: 50_000,
    toolCallsPerMinute: 50,
    messagesPerMonth: 1_000,
    traceRetentionDays: 7,
    sessionRetentionDays: 7,
    auditLogRetentionDays: 30,

    messageRetentionDays: 30,
  },
  TEAM: {
    maxConcurrentSessions: 50,
    maxServiceTimeoutMs: 30_000,
    maxResponseBodyBytes: 2_097_152, // 2MB
    maxConcurrentServiceCalls: 10,
    maxPendingTimers: 1_000,
    maxAgentsPerProject: 20,
    maxEventTypesPerApp: 50,
    maxProjectsPerOrg: 20,
    requestsPerMinute: 300,
    tokensPerMinute: 200_000,
    toolCallsPerMinute: 200,
    messagesPerMonth: 50_000,
    traceRetentionDays: 30,
    sessionRetentionDays: 30,
    auditLogRetentionDays: 90,

    messageRetentionDays: 90,
  },
  BUSINESS: {
    maxConcurrentSessions: 500,
    maxServiceTimeoutMs: 45_000,
    maxResponseBodyBytes: 5_242_880, // 5MB
    maxConcurrentServiceCalls: 25,
    maxPendingTimers: 10_000,
    maxAgentsPerProject: 100,
    maxEventTypesPerApp: 100,
    maxProjectsPerOrg: 100,
    requestsPerMinute: 1_000,
    tokensPerMinute: 500_000,
    toolCallsPerMinute: 500,
    messagesPerMonth: 500_000,
    traceRetentionDays: 90,
    sessionRetentionDays: 90,
    auditLogRetentionDays: 365,

    messageRetentionDays: 365,
  },
  ENTERPRISE: {
    maxConcurrentSessions: -1,
    maxServiceTimeoutMs: 60_000,
    maxResponseBodyBytes: 10_485_760, // 10MB
    maxConcurrentServiceCalls: 50,
    maxPendingTimers: 100_000,
    maxAgentsPerProject: -1,
    maxEventTypesPerApp: 200,
    maxProjectsPerOrg: -1,
    requestsPerMinute: -1, // Unlimited — use per-tenant overrides to cap individual tenants
    tokensPerMinute: -1,
    toolCallsPerMinute: -1,
    messagesPerMonth: -1,
    traceRetentionDays: 365,
    sessionRetentionDays: 365,
    auditLogRetentionDays: 2_555, // 7 years

    messageRetentionDays: 730,
  },
};

export const PLAN_FEATURES: Record<Plan, TenantFeatures> = {
  FREE: {
    customModels: false,
    ssoEnabled: false,
    mfaEnabled: false,
    auditLogExport: false,
    dataResidency: false,
    customDomains: false,
    prioritySupport: false,
    advancedAnalytics: false,
    advancedNlu: false,
    archiveEnabled: false,
    codeToolsEnabled: false,
  },
  TEAM: {
    customModels: true,
    ssoEnabled: false,
    mfaEnabled: true,
    auditLogExport: false,
    dataResidency: false,
    customDomains: false,
    prioritySupport: false,
    advancedAnalytics: false,
    advancedNlu: false,
    archiveEnabled: false,
    codeToolsEnabled: false,
  },
  BUSINESS: {
    customModels: true,
    ssoEnabled: true,
    mfaEnabled: true,
    auditLogExport: true,
    dataResidency: false,
    customDomains: true,
    prioritySupport: true,
    advancedAnalytics: true,
    advancedNlu: false,
    archiveEnabled: true,
    codeToolsEnabled: false,
  },
  ENTERPRISE: {
    customModels: true,
    ssoEnabled: true,
    mfaEnabled: true,
    auditLogExport: true,
    dataResidency: true,
    customDomains: true,
    prioritySupport: true,
    advancedAnalytics: true,
    advancedNlu: true,
    archiveEnabled: true,
    codeToolsEnabled: false,
  },
};

/** Whether strict PII mode is enabled via environment variable */
const STRICT_PII_MODE = process.env.ENABLE_STRICT_PII_MODE === 'true';

export const DEFAULT_SECURITY: Record<Plan, TenantSecurityConfig> = {
  FREE: {
    allowedServiceDomains: ['*'],
    requireMtls: false,
    ipAllowlist: [],
    requireMfa: false,
    sessionMaxAgeSeconds: 3_600, // 1 hour
    sessionIdleSeconds: 600, // 10 minutes
    apiKeyMaxAgeDays: 90,
    scrubPII: STRICT_PII_MODE,
  },
  TEAM: {
    allowedServiceDomains: ['*'],
    requireMtls: false,
    ipAllowlist: [],
    requireMfa: false,
    sessionMaxAgeSeconds: 28_800, // 8 hours
    sessionIdleSeconds: 1_800, // 30 minutes
    apiKeyMaxAgeDays: 180,
    scrubPII: STRICT_PII_MODE,
  },
  BUSINESS: {
    allowedServiceDomains: ['*'],
    requireMtls: false,
    ipAllowlist: [],
    requireMfa: true,
    sessionMaxAgeSeconds: 28_800,
    sessionIdleSeconds: 3_600, // 1 hour
    apiKeyMaxAgeDays: 365,
    scrubPII: true, // Always on for BUSINESS+
  },
  ENTERPRISE: {
    allowedServiceDomains: [], // Must be explicitly configured
    requireMtls: false,
    ipAllowlist: [],
    requireMfa: true,
    sessionMaxAgeSeconds: 86_400, // 24 hours
    sessionIdleSeconds: 7_200, // 2 hours
    apiKeyMaxAgeDays: 365,
    scrubPII: true, // Always on for ENTERPRISE
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_PLANS: ReadonlySet<string> = new Set(['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE']);

/** Cast a string to Plan, defaulting to 'TEAM' for unknown/missing values.
 *  TEAM is a safer fail-open default than FREE — FREE's 10-min idle timeout
 *  and 7-day retention are too aggressive and risk data loss in production
 *  when a subscription record is missing or lookup fails. */
function toPlan(value: string | undefined | null): Plan {
  if (value && VALID_PLANS.has(value)) return value as Plan;
  return 'TEAM';
}

// ---------------------------------------------------------------------------
// Tenant Config Service
// ---------------------------------------------------------------------------

/** Max number of in-memory tenant overrides (safety cap) */
const MAX_OVERRIDE_ENTRIES = 1000;

export class TenantConfigService {
  private overrides = new Map<string, Partial<TenantConfig>>();

  /** Get config for a tenant by plan, with any overrides applied (synchronous) */
  getConfig(tenantId: string, plan: Plan): TenantConfig {
    const base: TenantConfig = {
      tenantId,
      plan,
      limits: { ...PLAN_LIMITS[plan] },
      features: { ...PLAN_FEATURES[plan] },
      security: { ...DEFAULT_SECURITY[plan] },
      evalRetention: undefined,
    };

    const override = this.overrides.get(tenantId);
    if (override) {
      if (override.limits) {
        base.limits = { ...base.limits, ...override.limits };
      }
      if (override.features) {
        base.features = { ...base.features, ...override.features };
      }
      if (override.security) {
        base.security = { ...base.security, ...override.security };
      }
      if (override.evalRetention) {
        base.evalRetention = { ...override.evalRetention };
      }
    }

    return base;
  }

  /**
   * Async config resolution -- reads from Redis cache, then DB, then plan defaults.
   *
   * Resolution order:
   *   1. Redis cache hit -> return parsed config
   *   2. Cache miss -> loadFromDB() -> write to cache -> return
   *   3. DB unavailable -> return TEAM plan defaults (fail-open)
   */
  async getConfigAsync(tenantId: string): Promise<TenantConfig> {
    // 1. Try Redis cache
    const redis = getRedisClient();
    const cacheKey = `${CACHE_PREFIX}${tenantId}`;

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as TenantConfig;
          // Validate structural integrity -- stale/corrupt entries fall through to DB
          if (parsed?.tenantId === tenantId && parsed?.plan && parsed?.limits) {
            return parsed;
          }
        }
      } catch (err) {
        log.warn('Redis cache read failed', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Load from DB
    const config = await this.loadFromDB(tenantId);

    // 3. Write to Redis cache (fire-and-forget -- don't block the response)
    if (redis) {
      redis.set(cacheKey, JSON.stringify(config), 'EX', CACHE_TTL_SECONDS).catch((err: unknown) => {
        log.warn('Redis cache write failed', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return config;
  }

  /**
   * Merge project-level overrides on top of tenant limits.
   *
   * If `projectOverrides` is undefined/null, returns `tenantLimits` unchanged.
   * Only fields present in the overrides object are applied.
   */
  resolveEffectiveLimits(
    tenantLimits: TenantLimits,
    projectOverrides?: Partial<TenantLimits> | null,
  ): TenantLimits {
    if (!projectOverrides) return tenantLimits;
    return { ...tenantLimits, ...projectOverrides };
  }

  /**
   * Invalidate the Redis cache for a tenant.
   * Safe to call even if Redis is unavailable.
   */
  async invalidateCache(tenantId: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const cacheKey = `${CACHE_PREFIX}${tenantId}`;
    try {
      await redis.del(cacheKey);
    } catch (err) {
      log.warn('Redis cache invalidation failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Set tenant-specific overrides (bounded to MAX_OVERRIDE_ENTRIES) */
  setOverrides(tenantId: string, overrides: Partial<TenantConfig>): void {
    if (!this.overrides.has(tenantId) && this.overrides.size >= MAX_OVERRIDE_ENTRIES) {
      // Evict oldest entry (first inserted)
      const oldest = this.overrides.keys().next().value;
      if (oldest !== undefined) this.overrides.delete(oldest);
    }
    this.overrides.set(tenantId, overrides);
  }

  /** Remove overrides for a tenant */
  clearOverrides(tenantId: string): void {
    this.overrides.delete(tenantId);
  }

  /**
   * Get config for a specific project within a tenant.
   *
   * Resolution: tenant config → project-level overrides from subscription.
   * Falls back to tenant config if no project-specific overrides exist.
   */
  async getProjectConfig(tenantId: string, projectId: string): Promise<TenantConfig> {
    const tenantConfig = await this.getConfigAsync(tenantId);

    // Look up project-specific overrides from the subscription
    const projectOverrides = await this.loadProjectOverrides(tenantId, projectId);

    if (!projectOverrides) return tenantConfig;

    // Clone to avoid mutating the cached Redis reference
    return {
      ...tenantConfig,
      limits: this.resolveEffectiveLimits(tenantConfig.limits, projectOverrides),
    };
  }

  /**
   * Resolve effective messageRetentionDays for a project.
   *
   * Resolution:
   *   1. Load project's messageRetentionDays from the Project model
   *   2. If set, cap at the plan's messageRetentionDays via Math.min
   *      (unless the plan limit is -1 / unlimited, in which case use the project value as-is)
   *   3. If not set, fall through to the plan default from tenantConfig.limits
   */
  async resolveProjectMessageRetention(
    tenantId: string,
    projectId: string,
  ): Promise<number | null> {
    try {
      const { Project } = await import('@agent-platform/database/models');

      const project = await Project.findOne(
        { _id: projectId, tenantId },
        { messageRetentionDays: 1 },
      )
        .lean()
        .exec();

      const projectRetention = (project as any)?.messageRetentionDays;
      if (typeof projectRetention !== 'number' || !isFinite(projectRetention)) {
        return null; // No project override — caller should use plan default
      }

      // Cap at the plan maximum
      const tenantConfig = await this.getConfigAsync(tenantId);
      const planMax = tenantConfig.limits.messageRetentionDays;

      // -1 means unlimited — no cap needed
      if (planMax === -1) return projectRetention;

      return Math.min(projectRetention, planMax);
    } catch (err) {
      log.warn('Failed to resolve project message retention', {
        tenantId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Check if a specific limit is within bounds (-1 means unlimited) */
  checkLimit(value: number, limit: number): boolean {
    if (limit === -1) return true;
    return value <= limit;
  }

  /** Get plan defaults (useful for plan comparison pages) */
  getPlanDefaults(plan: Plan): { limits: TenantLimits; features: TenantFeatures } {
    return {
      limits: { ...PLAN_LIMITS[plan] },
      features: { ...PLAN_FEATURES[plan] },
    };
  }

  /** Get all plan comparisons */
  getAllPlanDefaults(): Record<Plan, { limits: TenantLimits; features: TenantFeatures }> {
    return {
      FREE: this.getPlanDefaults('FREE'),
      TEAM: this.getPlanDefaults('TEAM'),
      BUSINESS: this.getPlanDefaults('BUSINESS'),
      ENTERPRISE: this.getPlanDefaults('ENTERPRISE'),
    };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Load tenant config from MongoDB.
   *
   * Queries the Subscription and Tenant models, merges DB-stored overrides
   * on top of plan defaults. Never throws -- returns TEAM plan defaults on
   * any failure so callers always get a usable config (fail-open with warning).
   */
  private async loadFromDB(tenantId: string): Promise<TenantConfig> {
    if (!isDatabaseReady()) {
      log.debug('Database not ready, falling back to TEAM defaults', { tenantId });
      return {
        tenantId,
        plan: 'TEAM',
        limits: { ...PLAN_LIMITS.TEAM },
        features: { ...PLAN_FEATURES.TEAM },
        security: { ...DEFAULT_SECURITY.TEAM },
        evalRetention: undefined,
      };
    }

    try {
      const { Subscription, Tenant } = await import('@agent-platform/database/models');

      // Query both documents concurrently -- never use findById (tenant isolation)
      const [subscription, tenant] = await Promise.all([
        Subscription.findOne({ tenantId, status: 'active' }).lean().exec(),
        Tenant.findOne({ _id: tenantId }).lean().exec(),
      ]);

      // Determine plan from subscription, default to TEAM
      const plan = toPlan(subscription?.planTier);

      // Start with plan defaults
      const config: TenantConfig = {
        tenantId,
        plan,
        limits: { ...PLAN_LIMITS[plan] },
        features: { ...PLAN_FEATURES[plan] },
        security: { ...DEFAULT_SECURITY[plan] },
        evalRetention:
          tenant?.settings?.evalRetention && typeof tenant.settings.evalRetention === 'object'
            ? { ...tenant.settings.evalRetention }
            : undefined,
      };

      // Overlay subscription-level tenant quota overrides
      // Find the quota entry matching THIS tenant (not blindly [0] -- multi-tenant orgs)
      const tenantQuota = subscription?.tenantQuotas?.find(
        (q: { tenantId?: string }) => q.tenantId === tenantId,
      );
      const quotaLimits = tenantQuota?.allocatedLimits;
      if (quotaLimits && typeof quotaLimits === 'object') {
        for (const key of Object.keys(quotaLimits)) {
          const val = quotaLimits[key];
          // Only overlay numeric values -- DB uses Schema.Types.Mixed (untyped)
          if (key in config.limits && typeof val === 'number' && isFinite(val)) {
            (config.limits as unknown as Record<string, number>)[key] = val;
          }
        }
      }

      // Overlay tenant model settings (validate numeric -- ITenantSettings uses [key: string]: unknown)
      const maxSessions = tenant?.settings?.maxConcurrentSessions;
      if (typeof maxSessions === 'number' && isFinite(maxSessions)) {
        config.limits.maxConcurrentSessions = maxSessions;
      }

      // Overlay tenant code tools feature flag (admin toggle — fail-closed: absent = false)
      const codeToolsEnabled = tenant?.settings?.codeToolsEnabled;
      if (typeof codeToolsEnabled === 'boolean') {
        config.features.codeToolsEnabled = codeToolsEnabled;
      }

      // Overlay tenant retention days as sessionRetentionDays
      if (typeof tenant?.retentionDays === 'number' && isFinite(tenant.retentionDays)) {
        config.limits.sessionRetentionDays = tenant.retentionDays;
      }

      return config;
    } catch (err) {
      // Fail-open: return TEAM plan defaults so the system keeps running.
      // TEAM is safer than FREE — FREE's 10-min idle and 7-day retention
      // risk data loss when subscription lookup fails transiently.
      log.warn('DB load failed, falling back to TEAM defaults', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });

      return {
        tenantId,
        plan: 'TEAM',
        limits: { ...PLAN_LIMITS.TEAM },
        features: { ...PLAN_FEATURES.TEAM },
        security: { ...DEFAULT_SECURITY.TEAM },
        evalRetention: undefined,
      };
    }
  }

  /**
   * Load project-specific limit overrides from the subscription model.
   * Returns null if no project-specific overrides exist.
   */
  private async loadProjectOverrides(
    tenantId: string,
    projectId: string,
  ): Promise<Partial<TenantLimits> | null> {
    if (!isDatabaseReady()) {
      log.debug('Database not ready, skipping project overrides lookup', {
        tenantId,
        projectId,
      });
      return null;
    }

    try {
      const { Subscription } = await import('@agent-platform/database/models');

      const subscription = await Subscription.findOne(
        { tenantId, status: 'active' },
        { tenantQuotas: 1 },
      )
        .lean()
        .exec();

      if (!subscription?.tenantQuotas) return null;

      // Find the quota entry matching THIS tenant
      const tenantQuota = subscription.tenantQuotas.find(
        (q: { tenantId?: string }) => q.tenantId === tenantId,
      );
      if (!tenantQuota?.projectQuotas) return null;

      // Find the quota entry matching THIS project
      const projectQuota = tenantQuota.projectQuotas.find(
        (q: { projectId?: string }) => q.projectId === projectId,
      );
      if (!projectQuota?.allocatedLimits) return null;

      // Validate and extract numeric limits only
      const overrides: Partial<TenantLimits> = {};
      const allocatedLimits = projectQuota.allocatedLimits;
      if (typeof allocatedLimits !== 'object') return null;

      // Only overlay numeric values — DB uses Schema.Types.Mixed (untyped)
      for (const key of Object.keys(allocatedLimits)) {
        const val = allocatedLimits[key];
        if (key in PLAN_LIMITS.FREE && typeof val === 'number' && isFinite(val)) {
          (overrides as unknown as Record<string, number>)[key] = val;
        }
      }

      return Object.keys(overrides).length > 0 ? overrides : null;
    } catch (err) {
      log.warn('Failed to load project overrides', {
        tenantId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: TenantConfigService | null = null;

export function getTenantConfigService(): TenantConfigService {
  if (!instance) {
    instance = new TenantConfigService();
  }
  return instance;
}
