/**
 * Workspace Billing Routes
 *
 * Tenant-scoped billing endpoints for viewing active deals,
 * credit balances, and placeholder upgrade/top-up flows.
 *
 * Key rules:
 * - Routes require auth + tenant context
 * - `tenantId` comes from URL params (tenant-scoped)
 * - Only returns data for the authenticated tenant's organization
 *
 * Mount: /api/tenants/:tenantId/billing
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { BILLING_READ_PERMISSION, requirePermission } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { PLAN_FEATURES } from '../middleware/feature-gate.js';
import { requireConcealedProjectPermission } from '../middleware/rbac.js';
import {
  BILLING_USAGE_REPORT_GRANULARITY_VALUES,
  BillingUsageReportError,
  BillingUsageReportService,
} from '../services/billing/billing-usage-report-service.js';

const log = createLogger('workspace-billing');
const router: RouterType = Router({ mergeParams: true });
const billingUsageReportService = new BillingUsageReportService();

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// ─── Validation ───────────────────────────────────────────────────────────

const upgradeSchema = z.object({
  targetPlan: z.string().min(1),
});

const topupSchema = z.object({
  amount: z.number().positive().optional(),
  feature: z.string().optional(),
});
const usageReportQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  granularity: z.enum(BILLING_USAGE_REPORT_GRANULARITY_VALUES).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Verify the authenticated user has access to the requested tenant. */
function verifyTenantAccess(req: any, res: any): string | null {
  const contextTenantId = req.tenantContext?.tenantId;
  if (!contextTenantId) {
    res.status(403).json({
      success: false,
      error: { code: 'NO_TENANT_CONTEXT', message: 'Tenant access denied' },
    });
    return null;
  }

  const paramTenantId = req.params.tenantId;
  if (paramTenantId && paramTenantId !== contextTenantId) {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
    return null;
  }

  return contextTenantId;
}

function getBillingUsageReportErrorStatus(error: BillingUsageReportError): number {
  switch (error.code) {
    case 'INVALID_WINDOW_RANGE':
    case 'WINDOW_TOO_LARGE':
      return 400;
    default:
      return 500;
  }
}

// ─── GET /deals — List active deals for tenant's organization ─────────────

router.get('/deals', requirePermission(BILLING_READ_PERMISSION), async (req, res) => {
  try {
    const tenantId = verifyTenantAccess(req, res);
    if (!tenantId) return;

    const { Tenant, Deal } = await import('@agent-platform/database/models');

    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    if (!tenant) {
      res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'Tenant not found' },
      });
      return;
    }

    const organizationId = (tenant as any).organizationId || tenantId;
    const deals = await Deal.find({ organizationId, status: 'active' })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    res.json({ success: true, deals });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to list billing deals', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list billing deals' },
    });
  }
});

// ─── GET /credits — Current credit balance summary ────────────────────────

router.get('/credits', requirePermission(BILLING_READ_PERMISSION), async (req, res) => {
  try {
    const tenantId = verifyTenantAccess(req, res);
    if (!tenantId) return;

    const { Tenant, Deal, CreditLedger } = await import('@agent-platform/database/models');

    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    if (!tenant) {
      res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'Tenant not found' },
      });
      return;
    }

    const organizationId = (tenant as any).organizationId || tenantId;

    // Find active deals for the org
    const deals = await Deal.find({ organizationId, status: 'active' }).lean().exec();

    if (deals.length === 0) {
      res.json({
        success: true,
        credits: {
          allocated: 0,
          consumed: 0,
          remaining: 0,
          featureBreakdown: {},
        },
      });
      return;
    }

    const dealIds = deals.map((d: any) => String(d._id));

    // Aggregate credit ledgers for current period
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const ledgers = await CreditLedger.find({
      dealId: { $in: dealIds },
      periodStart: { $gte: periodStart },
    })
      .lean()
      .exec();

    // Compute totals
    let totalAllocated = 0;
    let totalConsumed = 0;
    const featureBreakdown: Record<string, { allocated: number; consumed: number }> = {};

    // Sum allocated from deal credit allotments
    for (const deal of deals) {
      const allotment = (deal as any).creditAllotment;
      if (allotment) {
        totalAllocated += allotment.totalCredits || 0;
        if (allotment.featureCredits) {
          for (const [feature, credits] of Object.entries(allotment.featureCredits)) {
            if (!featureBreakdown[feature]) {
              featureBreakdown[feature] = { allocated: 0, consumed: 0 };
            }
            featureBreakdown[feature].allocated += credits as number;
          }
        }
      }
    }

    // Sum consumed from ledgers
    for (const ledger of ledgers) {
      const doc = ledger as any;
      totalConsumed += doc.totalConsumed || 0;
      if (doc.featureUsage) {
        for (const [feature, consumed] of Object.entries(doc.featureUsage)) {
          if (!featureBreakdown[feature]) {
            featureBreakdown[feature] = { allocated: 0, consumed: 0 };
          }
          featureBreakdown[feature].consumed += consumed as number;
        }
      }
    }

    res.json({
      success: true,
      credits: {
        allocated: totalAllocated,
        consumed: totalConsumed,
        remaining: Math.max(0, totalAllocated - totalConsumed),
        featureBreakdown,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get credit balance', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get credit balance' },
    });
  }
});

// ─── GET /usage — Time-windowed billing usage report ──────────────────────

router.get('/usage', requirePermission('credential:read'), async (req, res) => {
  try {
    const tenantId = verifyTenantAccess(req, res);
    if (!tenantId) return;

    const parsed = usageReportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid usage report query' },
        details: parsed.error.issues,
      });
      return;
    }

    if (
      parsed.data.projectId &&
      !(await requireConcealedProjectPermission(req, res, 'session:read', parsed.data.projectId))
    ) {
      return;
    }

    const report = await billingUsageReportService.getUsageReport({
      tenantId,
      projectId: parsed.data.projectId,
      windowStart: parsed.data.windowStart ? new Date(parsed.data.windowStart) : undefined,
      windowEnd: parsed.data.windowEnd ? new Date(parsed.data.windowEnd) : undefined,
      granularity: parsed.data.granularity,
    });

    res.json({
      success: true,
      ...report,
    });
  } catch (error: unknown) {
    if (error instanceof BillingUsageReportError) {
      res.status(getBillingUsageReportErrorStatus(error)).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
        details: error.details,
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get workspace billing usage report', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get workspace billing usage report' },
    });
  }
});

// ─── POST /upgrade — Placeholder for plan upgrade ─────────────────────────

router.post('/upgrade', requirePermission(BILLING_READ_PERMISSION), async (req, res) => {
  try {
    const tenantId = verifyTenantAccess(req, res);
    if (!tenantId) return;

    const parsed = upgradeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid upgrade request' },
        details: parsed.error.issues,
      });
      return;
    }

    log.info('Upgrade request received', { tenantId, targetPlan: parsed.data.targetPlan });

    res.json({
      success: true,
      message: 'Upgrade request received',
      redirectUrl: null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to process upgrade request', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to process upgrade request' },
    });
  }
});

// ─── POST /credits/topup — Placeholder for credit purchase ────────────────

router.post('/credits/topup', requirePermission(BILLING_READ_PERMISSION), async (req, res) => {
  try {
    const tenantId = verifyTenantAccess(req, res);
    if (!tenantId) return;

    const parsed = topupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid top-up request' },
        details: parsed.error.issues,
      });
      return;
    }

    log.info('Credit top-up request received', {
      tenantId,
      amount: parsed.data.amount,
      feature: parsed.data.feature,
    });

    res.json({
      success: true,
      message: 'Top-up request received',
      checkoutSessionId: null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to process top-up request', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to process top-up request' },
    });
  }
});

// ─── GET /features — Resolved features for the authenticated tenant ───────

router.get('/features', requirePermission(BILLING_READ_PERMISSION), async (req, res) => {
  try {
    const tenantId = verifyTenantAccess(req, res);
    if (!tenantId) return;

    const { Tenant, Deal, Subscription } = await import('@agent-platform/database/models');

    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    if (!tenant) {
      res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'Tenant not found' },
      });
      return;
    }

    const organizationId = (tenant as any).organizationId || tenantId;

    // PLAN_FEATURES imported from ../middleware/feature-gate.js (single source of truth)

    const ALL_FEATURE_NAMES = [
      'kms_byok',
      'custom_models',
      'audit_export',
      'voice_channels',
      'advanced_analytics',
      'sso',
      'guardrails',
      'connectors',
    ];

    // Get features from active deals
    const deals = await Deal.find({ organizationId, status: 'active' }).lean().exec();
    const dealFeatures = new Set(deals.flatMap((d: any) => d.features || []));

    // Get features from subscription plan defaults
    const subscription = await Subscription.findOne({ tenantId, status: 'active' }).lean().exec();
    const planTier = (subscription as any)?.planTier || 'FREE';
    const planFeatures = PLAN_FEATURES[planTier] || [];

    // Union all features
    const features: Record<string, boolean> = {};
    for (const name of ALL_FEATURE_NAMES) {
      features[name] = dealFeatures.has(name) || planFeatures.includes(name);
    }

    res.json({
      success: true,
      tenantId,
      planTier,
      features,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to resolve tenant features', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve tenant features' },
    });
  }
});

export default router;
