/**
 * Feature Resolver
 *
 * Server-side feature flag resolution for Studio API routes.
 * Checks active deals and subscription plan tier against PLAN_FEATURES.
 *
 * Reuses the same resolution logic as /api/features route and
 * Runtime's feature-gate middleware — single source of truth via
 * shared-kernel PLAN_FEATURES.
 *
 * Results are cached per tenant+feature for 60 seconds to avoid
 * redundant DB queries on every gated request.
 *
 * Fails CLOSED: returns false on any error.
 */

import { PLAN_FEATURES } from '@agent-platform/shared-kernel';
import { ensureDb } from './ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('feature-resolver');

// ─── In-memory TTL cache ────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1_000;

interface CacheEntry {
  result: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, featureName: string): string {
  return `${tenantId}:${featureName}`;
}

function getCached(key: string): boolean | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.result;
}

function setCache(key: string, result: boolean): void {
  // Evict oldest entries if at capacity
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Organization ID resolution ─────────────────────────────────────────────

/**
 * Resolve the organizationId for a tenant.
 * Matches Runtime's resolveOrganizationId() logic:
 * if the Tenant doc has an organizationId field, use it; else fall back to tenantId.
 */
async function resolveOrganizationId(tenantId: string): Promise<string> {
  try {
    const { Tenant } = await import('@agent-platform/database/models');
    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    if (tenant && (tenant as Record<string, unknown>).organizationId) {
      return (tenant as Record<string, unknown>).organizationId as string;
    }
  } catch {
    // DB lookup failed — fall back to tenantId
  }
  return tenantId;
}

// ─── Feature resolution ─────────────────────────────────────────────────────

/**
 * Check whether a feature is enabled for the given tenant.
 *
 * Resolution order:
 *   1. In-memory cache (60s TTL)
 *   2. Active deals for the tenant → deal.features[]
 *   3. Active subscription plan defaults → PLAN_FEATURES[planTier]
 *   4. Neither grants → false
 *
 * Fails closed on any error (returns false).
 */
export async function isFeatureEnabled(tenantId: string, featureName: string): Promise<boolean> {
  const key = cacheKey(tenantId, featureName);
  const cached = getCached(key);
  if (cached !== undefined) return cached;

  try {
    await ensureDb();

    const { Deal, Subscription } = await import('@agent-platform/database/models');

    // Resolve the organizationId (matches Runtime's logic)
    const organizationId = await resolveOrganizationId(tenantId);

    // 1. Check active deals
    const deals = await Deal.find({
      organizationId,
      status: 'active',
    })
      .lean()
      .exec();

    const dealFeatures = new Set(
      deals.flatMap((d: Record<string, unknown>) =>
        Array.isArray(d.features) ? (d.features as string[]) : [],
      ),
    );

    if (dealFeatures.has(featureName)) {
      setCache(key, true);
      return true;
    }

    // 2. Fall back to subscription plan tier (most recent active subscription)
    const subscription = await Subscription.findOne({
      tenantId,
      status: 'active',
    })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const planTier =
      ((subscription as Record<string, unknown> | null)?.planTier as string) || 'FREE';
    const planFeatures = PLAN_FEATURES[planTier] || [];

    const result = planFeatures.includes(featureName);
    setCache(key, result);
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Feature resolution failed — failing closed', {
      tenantId,
      featureName,
      error: message,
    });
    // Do NOT cache failures — retry on next request
    return false;
  }
}
