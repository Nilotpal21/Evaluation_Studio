/**
 * Platform Admin — Billing Unit Policy Routes
 *
 * Platform admins manage tenant-level billing-unit policy overrides here.
 * Defaults remain plan-scoped, but all plans currently share the same values.
 *
 * Mount: /api/platform/admin/billing-policy
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import type { IBillingUnitPolicyOverrides } from '@agent-platform/database/models';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { getConfig } from '../config/index.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import {
  BillingPolicyService,
  hasBillingUnitPolicyOverrideValues,
} from '../services/billing/billing-policy-service.js';
import {
  BillingMaterializationApplicationError,
  BillingMaterializationApplicationService,
} from '../services/billing/billing-materialization-application-service.js';
import { BillingUsageMaterializationPlannerService } from '../services/billing/billing-usage-materialization-planner-service.js';
import { BillingUsageMaterializationService } from '../services/billing/billing-usage-materialization-service.js';
import { BillingUsageMaterializationVisibilityService } from '../services/billing/billing-usage-materialization-visibility-service.js';
import { BillingUsagePreviewService } from '../services/billing/billing-usage-preview-service.js';
import {
  BILLING_USAGE_REPORT_GRANULARITY_VALUES,
  BillingUsageReportError,
  BillingUsageReportService,
} from '../services/billing/billing-usage-report-service.js';
import { BillingUsageReplayService } from '../services/billing/billing-usage-replay-service.js';

const log = createLogger('platform-admin-billing-policy');
const router: RouterType = Router();
const billingPolicyService = new BillingPolicyService();
const billingUsageMaterializationPlannerService = new BillingUsageMaterializationPlannerService();
const billingUsageMaterializationService = new BillingUsageMaterializationService();
const billingUsageMaterializationVisibilityService =
  new BillingUsageMaterializationVisibilityService();
const billingMaterializationApplicationService = new BillingMaterializationApplicationService();
const billingUsagePreviewService = new BillingUsagePreviewService();
const billingUsageReportService = new BillingUsageReportService();
const billingUsageReplayService = new BillingUsageReplayService();

const BILLING_ADDON_MODE_VALUES = ['off', 'per_call', 'bucketed'] as const;
const BILLING_MATERIALIZATION_BASIS_VALUES = ['time_window', 'completed_sessions'] as const;
const MAX_REPLAY_RUN_LIST_LIMIT = 100;
const MAX_REPLAY_RESULT_LIMIT = 200;
const MAX_MATERIALIZATION_BATCH_LIST_LIMIT = 100;

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

const billingAddonPolicySchema = z.object({
  mode: z.enum(BILLING_ADDON_MODE_VALUES),
  bucketSize: z.number().int().positive().nullable(),
});

const billingInteractionThresholdSchema = z.object({
  minUserMessages: z.number().int().min(0),
  minInteractiveTurns: z.number().int().min(0),
  minEngagedSeconds: z.number().int().min(0),
});

const billingMaterializationSchema = z.object({
  basis: z.enum(BILLING_MATERIALIZATION_BASIS_VALUES),
  timeWindowMinutes: z.number().int().positive().nullable(),
  completedSessionsCount: z.number().int().positive().nullable(),
});

const billingUnitPolicySchema = z.object({
  intervalMinutes: z.number().int().positive(),
  excludedChannels: z.array(z.string().min(1)),
  excludedSessionTypes: z.array(z.string().min(1)),
  excludeProactiveWithoutUserInteraction: z.boolean(),
  interactionThreshold: billingInteractionThresholdSchema,
  addons: z.object({
    llm: billingAddonPolicySchema,
    tool: billingAddonPolicySchema,
  }),
  materialization: billingMaterializationSchema,
});

const billingUnitPolicyOverrideSchema = billingUnitPolicySchema.deepPartial();
const billingUsagePreviewQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  endedBefore: z.string().datetime().optional(),
});
const billingUsageReportQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  granularity: z.enum(BILLING_USAGE_REPORT_GRANULARITY_VALUES).optional(),
});
const billingPlatformUsageReportQuerySchema = z.object({
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  granularity: z.enum(BILLING_USAGE_REPORT_GRANULARITY_VALUES).optional(),
});
const billingUsageReplayBodySchema = billingUsagePreviewQuerySchema;
const billingUsageReplayListQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_REPLAY_RUN_LIST_LIMIT).optional(),
});
const billingUsageReplayDetailQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(MAX_REPLAY_RESULT_LIMIT).optional(),
});
const billingUsageMaterializationBodySchema = billingUsagePreviewQuerySchema;
const billingUsageMaterializationListQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_MATERIALIZATION_BATCH_LIST_LIMIT).optional(),
});
const billingUsageMaterializationResultsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(MAX_REPLAY_RESULT_LIMIT).optional(),
});
const billingUsageMaterializationDueQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
});
const billingPlatformMaterializationVisibilityQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(25).optional(),
});
const billingUsageMaterializationVisibilityQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(25).optional(),
});

function getMaterializationApplicationErrorStatus(
  error: BillingMaterializationApplicationError,
): number {
  switch (error.code) {
    case 'BATCH_NOT_READY':
    case 'BATCH_SUMMARY_MISSING':
      return 409;
    case 'TENANT_NOT_FOUND':
      return 404;
    case 'SUBSCRIPTION_NOT_FOUND':
    case 'NO_ACTIVE_DEAL':
    case 'AMBIGUOUS_ACTIVE_DEAL':
    case 'UNSUPPORTED_BILLING_CYCLE':
      return 422;
    default:
      return 500;
  }
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

router.get('/plans', async (_req, res) => {
  const requestId = getCurrentRequestId();

  try {
    res.json({
      success: true,
      plans: billingPolicyService.getAllPlanDefaults(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get billing unit policy plan defaults', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to get billing unit policy plan defaults',
    });
  }
});

router.get('/reports/usage', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const parsedQuery = billingPlatformUsageReportQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const report = await billingUsageReportService.getPlatformUsageReport({
      windowStart: parsedQuery.data.windowStart
        ? new Date(parsedQuery.data.windowStart)
        : undefined,
      windowEnd: parsedQuery.data.windowEnd ? new Date(parsedQuery.data.windowEnd) : undefined,
      granularity: parsedQuery.data.granularity,
    });

    res.json({
      success: true,
      ...report,
    });
  } catch (error: unknown) {
    if (error instanceof BillingUsageReportError) {
      res.status(getBillingUsageReportErrorStatus(error)).json({
        success: false,
        error: error.message,
        details: error.details,
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get platform billing usage report', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to get platform billing usage report',
    });
  }
});

router.get('/:tenantId/preview', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const parsedQuery = billingUsagePreviewQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const preview = await billingUsagePreviewService.previewTenantUsage({
      tenantId,
      projectId: parsedQuery.data.projectId,
      windowStart: parsedQuery.data.windowStart
        ? new Date(parsedQuery.data.windowStart)
        : undefined,
      windowEnd: parsedQuery.data.windowEnd ? new Date(parsedQuery.data.windowEnd) : undefined,
      endedBefore: parsedQuery.data.endedBefore
        ? new Date(parsedQuery.data.endedBefore)
        : undefined,
    });

    if (!preview) {
      res.status(404).json({
        success: false,
        error: 'No active subscription found for tenant',
      });
      return;
    }

    res.json({
      success: true,
      tenantId,
      projectId: preview.projectId,
      planTier: preview.planTier,
      policy: preview.policy,
      scope: preview.scope,
      summary: preview.summary,
      sessions: preview.sessions,
      warnings: preview.warnings,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to preview billing unit usage', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to preview billing unit usage',
    });
  }
});

router.get('/:tenantId/reports/usage', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const parsedQuery = billingUsageReportQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const report = await billingUsageReportService.getUsageReport({
      tenantId,
      projectId: parsedQuery.data.projectId,
      windowStart: parsedQuery.data.windowStart
        ? new Date(parsedQuery.data.windowStart)
        : undefined,
      windowEnd: parsedQuery.data.windowEnd ? new Date(parsedQuery.data.windowEnd) : undefined,
      granularity: parsedQuery.data.granularity,
    });

    res.json({
      success: true,
      ...report,
    });
  } catch (error: unknown) {
    if (error instanceof BillingUsageReportError) {
      res.status(getBillingUsageReportErrorStatus(error)).json({
        success: false,
        error: error.message,
        details: error.details,
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get billing usage report', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to get billing usage report',
    });
  }
});

router.post('/:tenantId/replays', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const parsedBody = billingUsageReplayBodySchema.safeParse(req.body);

    if (!parsedBody.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: parsedBody.error.issues,
      });
      return;
    }

    const adminUserId = req.tenantContext?.userId ?? 'unknown-platform-admin';
    const replay = await billingUsageReplayService.createReplayRun({
      tenantId,
      projectId: parsedBody.data.projectId,
      windowStart: parsedBody.data.windowStart ? new Date(parsedBody.data.windowStart) : undefined,
      windowEnd: parsedBody.data.windowEnd ? new Date(parsedBody.data.windowEnd) : undefined,
      endedBefore: parsedBody.data.endedBefore ? new Date(parsedBody.data.endedBefore) : undefined,
      triggeredBy: adminUserId,
    });

    if (!replay) {
      res.status(404).json({
        success: false,
        error: 'No active subscription found for tenant',
      });
      return;
    }

    log.info('Created compare-only billing replay run', {
      tenantId,
      adminUserId,
      requestId,
      runId: replay.runId,
      resultCount: replay.resultCount,
      basis: replay.scope.basis,
    });
    writeAuditLog({
      action: 'platform-admin:create-billing-usage-replay',
      userId: adminUserId,
      tenantId,
      metadata: {
        requestId,
        runId: replay.runId,
        projectId: replay.projectId,
        resultCount: replay.resultCount,
        basis: replay.scope.basis,
      },
    });

    res.status(201).json({
      success: true,
      replay,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to create billing usage replay run', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to create billing usage replay run',
    });
  }
});

router.get('/:tenantId/replays', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const parsedQuery = billingUsageReplayListQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const replayRuns = await billingUsageReplayService.listReplayRuns({
      tenantId,
      projectId: parsedQuery.data.projectId,
      limit: parsedQuery.data.limit,
    });

    res.json({
      success: true,
      runs: replayRuns.runs,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to list billing usage replay runs', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to list billing usage replay runs',
    });
  }
});

router.get('/:tenantId/replays/:runId', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId, runId } = req.params;
    const parsedQuery = billingUsageReplayDetailQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const replay = await billingUsageReplayService.getReplayRun({
      tenantId,
      runId,
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
    });

    if (!replay) {
      res.status(404).json({
        success: false,
        error: 'Billing replay run not found',
      });
      return;
    }

    res.json({
      success: true,
      replay,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get billing usage replay run', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to get billing usage replay run',
    });
  }
});

router.post('/:tenantId/materializations', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const parsedBody = billingUsageMaterializationBodySchema.safeParse(req.body);

    if (!parsedBody.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: parsedBody.error.issues,
      });
      return;
    }

    const adminUserId = req.tenantContext?.userId ?? 'unknown-platform-admin';
    const materialization = await billingUsageMaterializationService.createMaterialization({
      tenantId,
      projectId: parsedBody.data.projectId,
      windowStart: parsedBody.data.windowStart ? new Date(parsedBody.data.windowStart) : undefined,
      windowEnd: parsedBody.data.windowEnd ? new Date(parsedBody.data.windowEnd) : undefined,
      endedBefore: parsedBody.data.endedBefore ? new Date(parsedBody.data.endedBefore) : undefined,
      triggeredBy: adminUserId,
    });

    if (!materialization) {
      res.status(404).json({
        success: false,
        error: 'No active subscription found for tenant',
      });
      return;
    }

    log.info('Created billing usage materialization batch', {
      tenantId,
      adminUserId,
      requestId,
      batchId: materialization.batchId,
      resultCount: materialization.resultCount,
      basis: materialization.scope.basis,
      eventDispatchAttempted: materialization.eventDispatchAttempted,
    });
    writeAuditLog({
      action: 'platform-admin:create-billing-usage-materialization',
      userId: adminUserId,
      tenantId,
      metadata: {
        requestId,
        batchId: materialization.batchId,
        projectId: materialization.projectId,
        resultCount: materialization.resultCount,
        basis: materialization.scope.basis,
        eventId: materialization.eventId,
        eventDispatchAttempted: materialization.eventDispatchAttempted,
      },
    });

    res.status(201).json({
      success: true,
      materialization,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to create billing usage materialization batch', {
      error: message,
      requestId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to create billing usage materialization batch',
    });
  }
});

router.get('/:tenantId/materializations', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const parsedQuery = billingUsageMaterializationListQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const materializations = await billingUsageMaterializationService.listMaterializations({
      tenantId,
      projectId: parsedQuery.data.projectId,
      limit: parsedQuery.data.limit,
    });

    res.json({
      success: true,
      materializations: materializations.batches,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to list billing usage materialization batches', {
      error: message,
      requestId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list billing usage materialization batches',
    });
  }
});

router.get('/:tenantId/materializations/due', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const parsedQuery = billingUsageMaterializationDueQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const plan = await billingUsageMaterializationPlannerService.planNextMaterialization({
      tenantId,
      projectId: parsedQuery.data.projectId,
    });

    if (!plan) {
      res.status(404).json({
        success: false,
        error: 'No active subscription found for tenant',
      });
      return;
    }

    res.json({
      success: true,
      plan,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to plan billing usage materialization batch', {
      error: message,
      requestId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to plan billing usage materialization batch',
    });
  }
});

router.get('/:tenantId/materializations/publication-status', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const parsedQuery = billingUsageMaterializationVisibilityQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const visibility = await billingUsageMaterializationVisibilityService.getTenantVisibility({
      tenantId,
      projectId: parsedQuery.data.projectId,
      limit: parsedQuery.data.limit,
    });

    res.json({
      success: true,
      visibility,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get billing materialization publication status', {
      error: message,
      requestId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get billing materialization publication status',
    });
  }
});

router.get('/:tenantId/materializations/:batchId', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId, batchId } = req.params;
    const materialization = await billingUsageMaterializationService.getMaterialization({
      tenantId,
      batchId,
    });

    if (!materialization) {
      res.status(404).json({
        success: false,
        error: 'Billing materialization batch not found',
      });
      return;
    }

    res.json({
      success: true,
      materialization,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get billing usage materialization batch', {
      error: message,
      requestId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get billing usage materialization batch',
    });
  }
});

router.get('/:tenantId/materializations/:batchId/results', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId, batchId } = req.params;
    const parsedQuery = billingUsageMaterializationResultsQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const results = await billingUsageMaterializationService.getMaterializationResults({
      tenantId,
      batchId,
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
    });

    if (!results) {
      res.status(404).json({
        success: false,
        error: 'Billing materialization batch not found',
      });
      return;
    }

    res.json({
      success: true,
      results,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get billing materialization batch results', {
      error: message,
      requestId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get billing materialization batch results',
    });
  }
});

router.post('/:tenantId/materializations/:batchId/apply', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId, batchId } = req.params;
    const adminUserId = req.tenantContext?.userId ?? 'unknown-platform-admin';
    const application = await billingMaterializationApplicationService.applyMaterialization({
      tenantId,
      batchId,
      appliedBy: adminUserId,
    });

    if (!application) {
      res.status(404).json({
        success: false,
        error: 'Billing materialization batch not found',
      });
      return;
    }

    log.info('Applied billing materialization batch to the billing control plane', {
      tenantId,
      batchId,
      requestId,
      adminUserId,
      applicationId: application.application.applicationId,
      created: application.created,
      dealId: application.application.dealResolution.dealId,
      periodLabel: application.application.accountingPeriod.periodLabel,
    });
    writeAuditLog({
      action: 'platform-admin:apply-billing-usage-materialization',
      userId: adminUserId,
      tenantId,
      metadata: {
        requestId,
        batchId,
        applicationId: application.application.applicationId,
        created: application.created,
        dealId: application.application.dealResolution.dealId,
        periodLabel: application.application.accountingPeriod.periodLabel,
      },
    });

    res.status(application.created ? 201 : 200).json({
      success: true,
      application: application.application,
    });
  } catch (error: unknown) {
    if (error instanceof BillingMaterializationApplicationError) {
      res.status(getMaterializationApplicationErrorStatus(error)).json({
        success: false,
        error: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to apply billing materialization batch', {
      error: message,
      requestId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to apply billing materialization batch',
    });
  }
});

router.get('/:tenantId/materializations/:batchId/application', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId, batchId } = req.params;
    const application =
      await billingMaterializationApplicationService.getMaterializationApplication({
        tenantId,
        batchId,
      });

    if (!application) {
      res.status(404).json({
        success: false,
        error: 'Billing materialization application not found',
      });
      return;
    }

    res.json({
      success: true,
      application,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get billing materialization application', {
      error: message,
      requestId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get billing materialization application',
    });
  }
});

router.get('/materializations/publication-status', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const parsedQuery = billingPlatformMaterializationVisibilityQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: parsedQuery.error.issues,
      });
      return;
    }

    const visibility = await billingUsageMaterializationVisibilityService.getPlatformVisibility({
      limit: parsedQuery.data.limit,
    });

    res.json({
      success: true,
      visibility,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get platform billing materialization publication status', {
      error: message,
      requestId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get platform billing materialization publication status',
    });
  }
});

router.get('/:tenantId', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const resolved = await billingPolicyService.getResolvedPolicy(tenantId);

    if (!resolved) {
      res.status(404).json({
        success: false,
        error: 'No active subscription found for tenant',
      });
      return;
    }

    res.json({
      success: true,
      tenantId,
      planTier: resolved.planTier,
      planDefaults: resolved.planDefaults,
      overrides: resolved.overrides,
      policy: resolved.policy,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get billing unit policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to get billing unit policy',
    });
  }
});

router.put('/:tenantId', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const parsed = billingUnitPolicyOverrideSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: parsed.error.issues,
      });
      return;
    }

    const overrides: IBillingUnitPolicyOverrides = parsed.data;

    if (!hasBillingUnitPolicyOverrideValues(overrides)) {
      res.status(400).json({
        success: false,
        error: 'No overrides provided',
      });
      return;
    }

    const resolved = await billingPolicyService.updateTenantOverrides(tenantId, overrides);
    if (!resolved) {
      res.status(404).json({
        success: false,
        error: 'No active subscription found for tenant',
      });
      return;
    }

    const adminUserId = req.tenantContext?.userId;
    log.info('Billing unit policy overrides updated', {
      tenantId,
      adminUserId,
      requestId,
      overrideKeys: Object.keys(overrides),
    });
    writeAuditLog({
      action: 'platform-admin:update-billing-unit-policy',
      userId: adminUserId,
      tenantId,
      metadata: {
        requestId,
        overrideKeys: Object.keys(overrides),
      },
    });

    res.json({
      success: true,
      tenantId,
      planTier: resolved.planTier,
      overrides: resolved.overrides,
      policy: resolved.policy,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to update billing unit policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to update billing unit policy',
    });
  }
});

router.delete('/:tenantId', async (req, res) => {
  const requestId = getCurrentRequestId();

  try {
    const { tenantId } = req.params;
    const resolved = await billingPolicyService.clearTenantOverrides(tenantId);

    if (!resolved) {
      res.status(404).json({
        success: false,
        error: 'No active subscription found for tenant',
      });
      return;
    }

    const adminUserId = req.tenantContext?.userId;
    log.info('Billing unit policy overrides cleared', {
      tenantId,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:clear-billing-unit-policy',
      userId: adminUserId,
      tenantId,
      metadata: { requestId },
    });

    res.json({
      success: true,
      tenantId,
      planTier: resolved.planTier,
      overrides: resolved.overrides,
      policy: resolved.policy,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to clear billing unit policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: 'Failed to clear billing unit policy',
    });
  }
});

export default router;
