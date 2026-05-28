/**
 * Tenant Circuit Breaker Config
 *
 * Maps TenantConfigService plan config → circuit breaker thresholds.
 * Enterprise: 50 failures, Free: 15
 */

import type { CircuitBreakerConfig } from './circuit-breaker.js';
import type { Plan } from '../tenant-config.js';

// Plan-based circuit breaker thresholds
const PLAN_CB_CONFIG: Record<Plan, Partial<CircuitBreakerConfig>> = {
  FREE: {
    failureThreshold: 15,
    successThreshold: 3,
    resetTimeoutMs: 60_000,
    windowMs: 120_000,
  },
  TEAM: {
    failureThreshold: 25,
    successThreshold: 3,
    resetTimeoutMs: 45_000,
    windowMs: 90_000,
  },
  BUSINESS: {
    failureThreshold: 35,
    successThreshold: 3,
    resetTimeoutMs: 30_000,
    windowMs: 60_000,
  },
  ENTERPRISE: {
    failureThreshold: 50,
    successThreshold: 5,
    resetTimeoutMs: 30_000,
    windowMs: 60_000,
  },
};

// In-memory cache of tenant → plan mapping
// In production, this would be loaded from TenantConfigService
const tenantPlanCache = new Map<string, Plan>();

/**
 * Get circuit breaker config overrides for a tenant.
 * Returns null if no tenant-specific config exists (uses defaults).
 */
export function getTenantCBConfig(tenantId: string): Partial<CircuitBreakerConfig> | null {
  const plan = tenantPlanCache.get(tenantId);
  if (!plan) {
    return null; // Use default config
  }
  return PLAN_CB_CONFIG[plan] ?? null;
}

/**
 * Register a tenant's plan for CB config lookup.
 * Called when tenant context is resolved.
 */
export function registerTenantPlan(tenantId: string, plan: Plan): void {
  tenantPlanCache.set(tenantId, plan);
}

/**
 * Get default CB config for a plan.
 */
export function getPlanCBConfig(plan: Plan): Partial<CircuitBreakerConfig> {
  return { ...PLAN_CB_CONFIG[plan] };
}
