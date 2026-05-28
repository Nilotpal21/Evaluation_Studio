/**
 * GET /api/features — Resolve feature flags for the authenticated tenant
 *
 * Checks the tenant's active deals and subscription plan to determine
 * which features are available. Uses PLAN_FEATURES from shared-kernel
 * (single source of truth shared with Runtime feature gate).
 *
 * Results are cached in-memory for 60s per tenant.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { PLAN_FEATURES } from '@agent-platform/shared-kernel';

const log = createLogger('api:features');

// ---------------------------------------------------------------------------
// In-memory cache: tenantId -> { data, expiresAt }
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: Record<string, boolean>;
  expiresAt: number;
}

const featureCache = new Map<string, CacheEntry>();

/** Cache TTL in ms (10s — short to reflect admin toggles quickly) */
const CACHE_TTL_MS = 10_000;

/** Max cache entries to prevent memory leaks */
const MAX_CACHE_ENTRIES = 1_000;

// ---------------------------------------------------------------------------
// Features we resolve for the client
// ---------------------------------------------------------------------------

const FEATURE_KEYS = ['reusable_modules', 'code_tools', 'governance'] as const;

function buildDefaults(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const key of FEATURE_KEYS) {
    result[key] = false;
  }
  return result;
}

function hasResolvedFeature(
  dealFeatures: Set<string>,
  planFeatures: string[],
  entitlements: string[] | undefined,
  featureName: string,
): boolean {
  const grantKey = `feature:${featureName}`;
  const denyKey = `feature:deny:${featureName}`;
  const values = entitlements ?? [];

  if (values.includes(denyKey)) {
    return false;
  }
  if (values.includes(grantKey)) {
    return true;
  }

  return dealFeatures.has(featureName) || planFeatures.includes(featureName);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = user.tenantId;

  // Check cache
  const cached = featureCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ success: true, data: cached.data });
  }

  try {
    await ensureDb();

    const { Deal, Subscription, Tenant } = await import('@agent-platform/database/models');

    let organizationId = tenantId;
    let codeToolsEnabled = false;
    try {
      const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
      const tenantRecord = tenant as Record<string, unknown> | null;
      if (typeof tenantRecord?.organizationId === 'string' && tenantRecord.organizationId) {
        organizationId = tenantRecord.organizationId;
      }
      const settings = tenantRecord?.settings as Record<string, unknown> | undefined;
      codeToolsEnabled = settings?.codeToolsEnabled === true;
    } catch {
      // Fall back to tenantId for deal lookup and keep code_tools disabled.
    }

    // Collect features from active deals
    const deals = await Deal.find({
      organizationId,
      status: 'active',
    })
      .lean()
      .exec();

    const dealFeatures = new Set<string>(
      deals.flatMap((d: Record<string, unknown>) =>
        Array.isArray(d.features) ? (d.features as string[]) : [],
      ),
    );

    // Get subscription plan tier
    const subscription = await Subscription.findOne({
      tenantId,
      status: 'active',
    })
      .lean()
      .exec();

    const planTier =
      ((subscription as Record<string, unknown> | null)?.planTier as string) || 'FREE';
    const planFeatures = PLAN_FEATURES[planTier] || [];

    // Resolve each feature
    const features = buildDefaults();
    for (const key of FEATURE_KEYS) {
      features[key] = hasResolvedFeature(
        dealFeatures,
        planFeatures,
        (subscription as Record<string, unknown> | null)?.entitlements as string[] | undefined,
        key,
      );
    }

    // Resolve code_tools from tenant settings (DB-driven, not plan-based)
    features['code_tools'] = codeToolsEnabled;

    // Cache result (evict oldest if at capacity)
    if (featureCache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = featureCache.keys().next().value;
      if (firstKey) featureCache.delete(firstKey);
    }
    featureCache.set(tenantId, {
      data: features,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return NextResponse.json({ success: true, data: features });
  } catch (error) {
    log.error('Feature resolution failed', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail closed — all features disabled on error
    return NextResponse.json({ success: true, data: buildDefaults() });
  }
}
