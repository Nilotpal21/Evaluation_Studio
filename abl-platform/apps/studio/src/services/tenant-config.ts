/**
 * Per-Tenant Configuration Service
 *
 * Provides plan-based defaults and per-tenant overrides for:
 * - Rate limits and resource quotas
 * - Feature flags
 * - Security settings
 *
 * Plans: FREE → TEAM → BUSINESS → ENTERPRISE
 */

import type {
  Plan,
  TenantLimits,
  TenantFeatures,
  TenantSecurityConfig,
  TenantConfig,
} from '@agent-platform/config';

export type { Plan, TenantLimits, TenantFeatures, TenantSecurityConfig, TenantConfig };

// ---------------------------------------------------------------------------
// Plan defaults
// ---------------------------------------------------------------------------

const PLAN_LIMITS: Record<Plan, TenantLimits> = {
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

const PLAN_FEATURES: Record<Plan, TenantFeatures> = {
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

const DEFAULT_SECURITY: Record<Plan, TenantSecurityConfig> = {
  FREE: {
    allowedServiceDomains: ['*'],
    requireMtls: false,
    ipAllowlist: [],
    requireMfa: false,
    sessionMaxAgeSeconds: 3_600, // 1 hour
    sessionIdleSeconds: 600, // 10 minutes
    apiKeyMaxAgeDays: 90,
    scrubPII: false,
  },
  TEAM: {
    allowedServiceDomains: ['*'],
    requireMtls: false,
    ipAllowlist: [],
    requireMfa: false,
    sessionMaxAgeSeconds: 28_800, // 8 hours
    sessionIdleSeconds: 1_800, // 30 minutes
    apiKeyMaxAgeDays: 180,
    scrubPII: false,
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
// Tenant Config Service
// ---------------------------------------------------------------------------

export class TenantConfigService {
  private overrides = new Map<string, Partial<TenantConfig>>();

  /** Get config for a tenant by plan, with any overrides applied */
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

  /** Set tenant-specific overrides */
  setOverrides(tenantId: string, overrides: Partial<TenantConfig>): void {
    this.overrides.set(tenantId, overrides);
  }

  /** Remove overrides for a tenant */
  clearOverrides(tenantId: string): void {
    this.overrides.delete(tenantId);
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
