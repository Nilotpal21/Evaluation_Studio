/**
 * Migration: Seed ENTERPRISE subscription for the dev-login tenant
 *
 * The dev-login UI button logs in as dev@kore.ai and assigns them
 * to a tenant. The feature gate middleware (requireFeature) checks tenant
 * subscriptions to determine plan-tier features. Without a subscription,
 * the tenant defaults to FREE, blocking features like voice_channels, etc.
 *
 * Resolution order (matches dev-login route logic):
 *   1. Look up dev@kore.ai user → find their tenant membership
 *   2. Fallback: first tenant by createdAt
 *
 * Idempotent — skips if the tenant already has an active subscription.
 *
 * Date: 2026-03-11
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const DEV_LOGIN_EMAIL = 'dev@kore.ai';
const USERS_COLLECTION = 'users';
const TENANT_MEMBERS_COLLECTION = 'tenant_members';
const TENANTS_COLLECTION = 'tenants';
const SUBSCRIPTIONS_COLLECTION = 'subscriptions';

async function resolveDevTenantId(db: Db): Promise<string | null> {
  // 1. Find the dev-login user's tenant membership
  const user = await db
    .collection(USERS_COLLECTION)
    .findOne({ email: DEV_LOGIN_EMAIL }, { projection: { _id: 1 } });

  if (user) {
    const membership = await db
      .collection(TENANT_MEMBERS_COLLECTION)
      .findOne({ userId: user._id }, { projection: { tenantId: 1 } });

    if (membership) {
      return String(membership.tenantId);
    }
  }

  // 2. Fallback: first tenant by createdAt (same as dev-login route)
  const tenant = await db
    .collection(TENANTS_COLLECTION)
    .findOne({}, { sort: { createdAt: 1 }, projection: { _id: 1 } });

  return tenant ? String(tenant._id) : null;
}

export const migration: Migration = {
  version: '20260311_013',
  description: 'Seed ENTERPRISE subscription for dev-login tenant',

  async up(db: Db) {
    const subscriptions = db.collection(SUBSCRIPTIONS_COLLECTION);

    const tenantId = await resolveDevTenantId(db);
    if (!tenantId) {
      console.log('[migration] No dev-login tenant found — skipping');
      return;
    }

    console.log(`[migration] Dev-login tenant: ${tenantId}`);

    const existing = await subscriptions.findOne({ tenantId, status: 'active' });
    if (existing) {
      console.log(
        `[migration] Tenant already has active subscription (planTier: ${(existing as any).planTier}) — skipping`,
      );
      return;
    }

    await subscriptions.insertOne({
      _id: crypto.randomUUID() as any,
      tenantId,
      organizationId: null,
      planTier: 'ENTERPRISE',
      billingCycle: 'monthly',
      billingStartDate: new Date(),
      billingEndDate: null,
      status: 'active',
      trialEndsAt: null,
      canceledAt: null,
      externalBillingId: null,
      externalCustomerId: null,
      orgLimits: null,
      entitlements: [],
      tenantQuotas: [],
      _v: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log('[migration] Created ENTERPRISE subscription for dev-login tenant');
  },

  async down(db: Db) {
    const subscriptions = db.collection(SUBSCRIPTIONS_COLLECTION);

    const tenantId = await resolveDevTenantId(db);
    if (!tenantId) return;

    const result = await subscriptions.deleteMany({
      tenantId,
      planTier: 'ENTERPRISE',
      externalBillingId: null,
    });

    console.log(`[migration] Removed ${result.deletedCount} seeded ENTERPRISE subscription(s)`);
  },

  async validate(db: Db) {
    const subscriptions = db.collection(SUBSCRIPTIONS_COLLECTION);
    const tenantId = await resolveDevTenantId(db);

    if (!tenantId) {
      return validationPassed(
        'No dev-login tenant found; nothing to validate for the seeded subscription',
        {
          tenantId: null,
        },
      );
    }

    const enterpriseSubscriptions = await subscriptions.countDocuments({
      tenantId,
      status: 'active',
      planTier: 'ENTERPRISE',
    });

    if (enterpriseSubscriptions === 0) {
      return validationFailed('Dev-login tenant does not have an active ENTERPRISE subscription', {
        tenantId,
        enterpriseSubscriptions,
      });
    }

    return validationPassed('Dev-login tenant has an active ENTERPRISE subscription', {
      tenantId,
      enterpriseSubscriptions,
    });
  },
};

export default migration;
