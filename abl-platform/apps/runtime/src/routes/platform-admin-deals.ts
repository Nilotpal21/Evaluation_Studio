/**
 * Platform Admin — Deal Management Routes
 *
 * System admins manage commercial deals, credit ledgers, and billing
 * line items. Deals track negotiated resource limits, credit allotments,
 * and overage policies for organizations.
 *
 * Key rules:
 * - All routes require `requirePlatformAdmin()` — only super-admins
 * - Every mutation writes an audit log with `platform-admin:` prefix
 *
 * Mount: /api/platform/admin/deals
 */

import { Router } from 'express';
import { z } from 'zod';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';

const log = createLogger('platform-admin-deals');
const router: ReturnType<typeof Router> = Router();

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Validation ───────────────────────────────────────────────────────────

const VALID_STATUSES = ['active', 'paused', 'expired', 'canceled'] as const;
const VALID_SCOPES = ['organization', 'project'] as const;
const VALID_AGGREGATION_MODES = ['additive', 'max_wins', 'dedicated'] as const;
const VALID_OVERAGE_POLICIES = ['hard_stop', 'soft_cap', 'auto_upgrade'] as const;
const VALID_ROLLOVER_POLICIES = ['none', 'partial', 'full'] as const;
const VALID_LINE_ITEM_CATEGORIES = ['base', 'overage', 'addon', 'credit_topup'] as const;

const limitSetSchema = z.object({
  maxConcurrentSessions: z.number().nonnegative(),
  maxTokensPerMinute: z.number().nonnegative(),
  maxRequestsPerMinute: z.number().nonnegative(),
  maxStorageGB: z.number().nonnegative(),
});

const dealPhaseSchema = z.object({
  name: z.string().min(1),
  startDate: z.string().or(z.date()),
  endDate: z.string().or(z.date()),
  environments: z.object({
    dev: limitSetSchema,
    staging: limitSetSchema,
    production: limitSetSchema,
  }),
});

const creditAllotmentSchema = z.object({
  totalCredits: z.number().nonnegative(),
  sharedPoolCredits: z.number().nonnegative(),
  featureCredits: z.record(z.number().nonnegative()).default({}),
  rolloverPolicy: z.enum(VALID_ROLLOVER_POLICIES),
  rolloverPercentage: z.number().min(0).max(100).optional(),
});

const createDealSchema = z.object({
  organizationId: z.string().min(1),
  hubspotDealId: z.string().optional(),
  name: z.string().min(1),
  status: z.enum(VALID_STATUSES),
  scope: z.enum(VALID_SCOPES),
  projectId: z.string().optional(),
  aggregationMode: z.enum(VALID_AGGREGATION_MODES),
  phases: z.array(dealPhaseSchema).max(50).default([]),
  overagePolicy: z.enum(VALID_OVERAGE_POLICIES),
  overageAlertThresholds: z.array(z.number()).max(20).default([]),
  creditAllotment: creditAllotmentSchema.default({
    totalCredits: 0,
    sharedPoolCredits: 0,
    featureCredits: {},
    rolloverPolicy: 'none',
  }),
  features: z.array(z.string()).max(100).default([]),
  renewalDate: z.string().optional(),
  contractEndDate: z.string().optional(),
});

const updateDealSchema = z.object({
  name: z.string().min(1).optional(),
  hubspotDealId: z.string().nullable().optional(),
  status: z.enum(VALID_STATUSES).optional(),
  scope: z.enum(VALID_SCOPES).optional(),
  projectId: z.string().nullable().optional(),
  aggregationMode: z.enum(VALID_AGGREGATION_MODES).optional(),
  phases: z.array(dealPhaseSchema).max(50).optional(),
  overagePolicy: z.enum(VALID_OVERAGE_POLICIES).optional(),
  overageAlertThresholds: z.array(z.number()).max(20).optional(),
  creditAllotment: creditAllotmentSchema.optional(),
  features: z.array(z.string()).max(100).optional(),
  renewalDate: z.string().nullable().optional(),
  contractEndDate: z.string().nullable().optional(),
});

const assignDealSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().optional(),
});

const creditTopupSchema = z.object({
  feature: z.string().min(1).default('general'),
  credits: z.number().positive().max(10_000_000),
  description: z.string().optional(),
});

const createLineItemSchema = z.object({
  periodLabel: z.string().min(1),
  description: z.string().min(1),
  quantity: z.number(),
  unitPrice: z.number(),
  totalAmount: z.number(),
  category: z.enum(VALID_LINE_ITEM_CATEGORIES),
  invoiced: z.boolean().default(false),
  invoiceId: z.string().optional(),
});

const updateLineItemSchema = z.object({
  description: z.string().min(1).optional(),
  quantity: z.number().optional(),
  unitPrice: z.number().optional(),
  totalAmount: z.number().optional(),
  category: z.enum(VALID_LINE_ITEM_CATEGORIES).optional(),
  invoiced: z.boolean().optional(),
  invoiceId: z.string().nullable().optional(),
});

// ─── Constants ────────────────────────────────────────────────────────────

/** Default page size for list endpoints */
const PAGINATION_DEFAULT_LIMIT = 25;

/** Maximum page size for list endpoints */
const PAGINATION_MAX_LIMIT = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Parse pagination params with sensible defaults and caps. */
function parsePagination(query: Record<string, unknown>): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(
    PAGINATION_MAX_LIMIT,
    Math.max(
      1,
      parseInt(String(query.limit ?? String(PAGINATION_DEFAULT_LIMIT)), 10) ||
        PAGINATION_DEFAULT_LIMIT,
    ),
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// ─── GET / — List deals ───────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { Deal } = await import('@agent-platform/database/models');
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

    // Build filter from query params
    const filter: Record<string, unknown> = {};

    const organizationIdParam = req.query.organizationId;
    if (organizationIdParam && typeof organizationIdParam === 'string') {
      filter.organizationId = organizationIdParam;
    }

    const statusParam = req.query.status;
    if (
      statusParam &&
      typeof statusParam === 'string' &&
      (VALID_STATUSES as readonly string[]).includes(statusParam)
    ) {
      filter.status = statusParam;
    }

    const scopeParam = req.query.scope;
    if (
      scopeParam &&
      typeof scopeParam === 'string' &&
      (VALID_SCOPES as readonly string[]).includes(scopeParam)
    ) {
      filter.scope = scopeParam;
    }

    const [deals, total] = await Promise.all([
      Deal.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      Deal.countDocuments(filter).exec(),
    ]);

    res.json({
      success: true,
      deals,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to list deals', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to list deals' });
  }
});

// ─── POST / — Create deal ─────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const parsed = createDealSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid deal data',
        details: parsed.error.issues,
      });
      return;
    }

    const { Deal } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const deal = await Deal.create(parsed.data);

    log.info('Deal created', { dealId: deal._id, adminUserId, requestId });
    writeAuditLog({
      action: 'platform-admin:create-deal',
      userId: adminUserId,
      tenantId: 'platform',
      metadata: { dealId: deal._id, name: parsed.data.name, requestId },
    });

    res.status(201).json({ success: true, deal });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to create deal', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to create deal' });
  }
});

// ─── GET /:id — Deal detail ───────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id } = req.params;
    const { Deal } = await import('@agent-platform/database/models');

    const deal = await Deal.findOne({ _id: id }).lean().exec();

    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    res.json({ success: true, deal });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get deal detail', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to get deal detail' });
  }
});

// ─── PATCH /:id — Update deal ─────────────────────────────────────────────

router.patch('/:id', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id } = req.params;
    const parsed = updateDealSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid update data',
        details: parsed.error.issues,
      });
      return;
    }

    const { Deal } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const deal = await Deal.findOneAndUpdate({ _id: id }, { $set: parsed.data }, { new: true })
      .lean()
      .exec();

    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    log.info('Deal updated', { dealId: id, adminUserId, requestId });
    writeAuditLog({
      action: 'platform-admin:update-deal',
      userId: adminUserId,
      tenantId: 'platform',
      metadata: { dealId: id, updates: Object.keys(parsed.data), requestId },
    });

    res.json({ success: true, deal });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to update deal', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to update deal' });
  }
});

// ─── POST /:id/assign — Assign deal to org ────────────────────────────────

router.post('/:id/assign', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id } = req.params;
    const parsed = assignDealSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid assignment data',
        details: parsed.error.issues,
      });
      return;
    }

    const { Deal } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const updateFields: Record<string, unknown> = {
      organizationId: parsed.data.organizationId,
    };
    if (parsed.data.projectId) {
      updateFields.projectId = parsed.data.projectId;
    }

    const deal = await Deal.findOneAndUpdate({ _id: id }, { $set: updateFields }, { new: true })
      .lean()
      .exec();

    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    log.info('Deal assigned', {
      dealId: id,
      organizationId: parsed.data.organizationId,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:assign-deal',
      userId: adminUserId,
      tenantId: 'platform',
      metadata: {
        dealId: id,
        organizationId: parsed.data.organizationId,
        projectId: parsed.data.projectId,
        requestId,
      },
    });

    res.json({ success: true, deal });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to assign deal', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to assign deal' });
  }
});

// ─── GET /:id/credits — Get credit ledger ─────────────────────────────────

router.get('/:id/credits', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id } = req.params;
    const { Deal, CreditLedger } = await import('@agent-platform/database/models');

    const deal = await Deal.findOne({ _id: id }).lean().exec();
    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    // Find or create ledger for the current period
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    let ledger = await CreditLedger.findOne({ dealId: id, periodStart }).lean().exec();

    if (!ledger) {
      const dealDoc = deal as any;
      const created = await CreditLedger.create({
        dealId: id,
        organizationId: dealDoc.organizationId,
        periodStart,
        periodEnd,
        totalAllocated: dealDoc.creditAllotment?.totalCredits ?? 0,
        totalConsumed: 0,
        featureUsage: {},
        sharedPoolConsumed: 0,
        entries: [],
      });
      ledger = created.toObject ? created.toObject() : created;
    }

    res.json({ success: true, ledger });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get credit ledger', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to get credit ledger' });
  }
});

// ─── POST /:id/credits/topup — Credit top-up ──────────────────────────────

router.post('/:id/credits/topup', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id } = req.params;
    const parsed = creditTopupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid top-up data',
        details: parsed.error.issues,
      });
      return;
    }

    const { Deal, CreditLedger, BillingLineItem } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const deal = await Deal.findOne({ _id: id }).lean().exec();
    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const periodLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dealDoc = deal as any;

    // Upsert ledger for current period
    const ledger = await CreditLedger.findOneAndUpdate(
      { dealId: id, periodStart },
      {
        $setOnInsert: {
          organizationId: dealDoc.organizationId,
          periodStart,
          periodEnd,
          totalAllocated: dealDoc.creditAllotment?.totalCredits ?? 0,
          featureUsage: {},
          sharedPoolConsumed: 0,
        },
        $push: {
          entries: {
            $each: [
              {
                timestamp: now,
                feature: parsed.data.feature,
                units: 1,
                credits: parsed.data.credits,
                source: 'topup',
                description: parsed.data.description ?? 'Admin credit top-up',
              },
            ],
            $slice: -10000,
          },
        },
        $inc: { totalAllocated: parsed.data.credits },
      },
      { new: true, upsert: true },
    )
      .lean()
      .exec();

    // Create billing line item for the top-up
    await BillingLineItem.create({
      dealId: id,
      periodLabel,
      description: parsed.data.description ?? `Credit top-up: ${parsed.data.feature}`,
      quantity: 1,
      unitPrice: parsed.data.credits,
      totalAmount: parsed.data.credits,
      category: 'credit_topup',
      invoiced: false,
    });

    log.info('Credit top-up applied', {
      dealId: id,
      credits: parsed.data.credits,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:credit-topup',
      userId: adminUserId,
      tenantId: 'platform',
      metadata: {
        dealId: id,
        credits: parsed.data.credits,
        feature: parsed.data.feature,
        requestId,
      },
    });

    res.json({ success: true, ledger });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to apply credit top-up', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to apply credit top-up' });
  }
});

// ─── GET /:id/line-items — List billing line items ─────────────────────────

router.get('/:id/line-items', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id } = req.params;
    const { Deal, BillingLineItem } = await import('@agent-platform/database/models');
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

    const deal = await Deal.findOne({ _id: id }).lean().exec();
    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    // Build filter
    const filter: Record<string, unknown> = { dealId: id };

    const periodParam = req.query.periodLabel;
    if (periodParam && typeof periodParam === 'string') {
      filter.periodLabel = periodParam;
    }

    const categoryParam = req.query.category;
    if (
      categoryParam &&
      typeof categoryParam === 'string' &&
      (VALID_LINE_ITEM_CATEGORIES as readonly string[]).includes(categoryParam)
    ) {
      filter.category = categoryParam;
    }

    const [lineItems, total] = await Promise.all([
      BillingLineItem.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      BillingLineItem.countDocuments(filter).exec(),
    ]);

    res.json({
      success: true,
      lineItems,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to list billing line items', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to list billing line items' });
  }
});

// ─── POST /:id/line-items — Create billing line item ───────────────────────

router.post('/:id/line-items', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id } = req.params;
    const parsed = createLineItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid line item data',
        details: parsed.error.issues,
      });
      return;
    }

    const { Deal, BillingLineItem } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const deal = await Deal.findOne({ _id: id }).lean().exec();
    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    const lineItem = await BillingLineItem.create({
      ...parsed.data,
      dealId: id,
    });

    log.info('Billing line item created', {
      dealId: id,
      lineItemId: lineItem._id,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:create-line-item',
      userId: adminUserId,
      tenantId: 'platform',
      metadata: {
        dealId: id,
        lineItemId: lineItem._id,
        category: parsed.data.category,
        requestId,
      },
    });

    res.status(201).json({ success: true, lineItem });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to create billing line item', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to create billing line item' });
  }
});

// ─── PATCH /:id/line-items/:lineItemId — Update billing line item ───────

router.patch('/:id/line-items/:lineItemId', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id, lineItemId } = req.params;
    const parsed = updateLineItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid line item update data',
        details: parsed.error.issues,
      });
      return;
    }

    const { Deal, BillingLineItem } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const deal = await Deal.findOne({ _id: id }).lean().exec();
    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    const lineItem = await BillingLineItem.findOneAndUpdate(
      { _id: lineItemId, dealId: id },
      { $set: parsed.data },
      { new: true },
    )
      .lean()
      .exec();

    if (!lineItem) {
      res.status(404).json({ success: false, error: 'Line item not found' });
      return;
    }

    log.info('Billing line item updated', {
      dealId: id,
      lineItemId,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:update-line-item',
      userId: adminUserId,
      tenantId: 'platform',
      metadata: {
        dealId: id,
        lineItemId,
        updates: Object.keys(parsed.data),
        requestId,
      },
    });

    res.json({ success: true, lineItem });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to update billing line item', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to update billing line item' });
  }
});

// ─── DELETE /:id — Delete deal ────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id } = req.params;
    const { Deal, CreditLedger, BillingLineItem } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const deal = await Deal.findOne({ _id: id }).lean().exec();
    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    // Cascade: delete children first, then the deal (so a retry finds the deal if children fail)
    await Promise.all([
      CreditLedger.deleteMany({ dealId: id }).exec(),
      BillingLineItem.deleteMany({ dealId: id }).exec(),
    ]);
    await Deal.deleteOne({ _id: id }).exec();

    log.info('Deal deleted', { dealId: id, adminUserId, requestId });
    writeAuditLog({
      action: 'platform-admin:delete-deal',
      userId: adminUserId,
      tenantId: 'platform',
      metadata: { dealId: id, dealName: (deal as any).name, requestId },
    });

    res.json({ success: true, deleted: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to delete deal', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to delete deal' });
  }
});

// ─── DELETE /:id/line-items/:lineItemId — Delete billing line item ──────

router.delete('/:id/line-items/:lineItemId', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { id, lineItemId } = req.params;
    const { Deal, BillingLineItem } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const deal = await Deal.findOne({ _id: id }).lean().exec();
    if (!deal) {
      res.status(404).json({ success: false, error: 'Deal not found' });
      return;
    }

    const lineItem = await BillingLineItem.findOneAndDelete({ _id: lineItemId, dealId: id })
      .lean()
      .exec();

    if (!lineItem) {
      res.status(404).json({ success: false, error: 'Line item not found' });
      return;
    }

    log.info('Billing line item deleted', {
      dealId: id,
      lineItemId,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:delete-line-item',
      userId: adminUserId,
      tenantId: 'platform',
      metadata: {
        dealId: id,
        lineItemId,
        requestId,
      },
    });

    res.json({ success: true, deleted: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to delete billing line item', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to delete billing line item' });
  }
});

export default router;
