import { createLogger } from '@abl/compiler/platform';
import {
  BillingMaterializationApplication,
  BillingMaterializationBatch,
  Deal,
  Subscription,
  Tenant,
  type BillingMaterializationBasis,
  type BillingMaterializationApplicationDealMatchType,
  type BillingMaterializationApplicationStatus,
  type BillingMaterializationApplicationTriggerSource,
  type IBillingMaterializationApplication,
  type IBillingMaterializationBatch,
  type IBillingMaterializationScope,
  type IBillingMaterializationSummary,
  type IDeal,
  type ISubscription,
  type ITenant,
} from '@agent-platform/database/models';
import { BillingUsagePublicationService } from './billing-usage-publication-service.js';

const log = createLogger('billing-materialization-application-service');

const USAGE_REPORTS_PROJECTION_PENDING_REASON = 'billing_usage_report_publication_pending';
const CREDIT_LEDGER_PROJECTION_DEFERRED_REASON = 'billing_unit_credit_mapping_not_configured';
const BILLING_LINE_ITEMS_PROJECTION_DEFERRED_REASON = 'billing_unit_price_mapping_not_configured';

type BillingCycleInterval = { unit: 'months'; count: 1 | 3 | 12 } | { unit: 'days'; count: 7 };

export type BillingMaterializationApplicationErrorCode =
  | 'BATCH_NOT_READY'
  | 'BATCH_SUMMARY_MISSING'
  | 'TENANT_NOT_FOUND'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'NO_ACTIVE_DEAL'
  | 'AMBIGUOUS_ACTIVE_DEAL'
  | 'UNSUPPORTED_BILLING_CYCLE';

export class BillingMaterializationApplicationError extends Error {
  readonly code: BillingMaterializationApplicationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BillingMaterializationApplicationErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface BillingMaterializationApplicationScopeView {
  basis: BillingMaterializationBasis;
  windowStart: string | null;
  windowEnd: string | null;
  endedBefore: string | null;
  completedSessionsCount: number | null;
  periodLabel: string | null;
}

export interface BillingMaterializationApplicationSummaryView {
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  exclusionCounts: Record<string, number>;
  metricsSourceCounts: Record<string, number>;
  projectBreakdown: Array<{
    projectId: string;
    examinedSessionCount: number;
    includedSessionCount: number;
    excludedSessionCount: number;
    baseUnits: number;
    llmAddonUnits: number;
    toolAddonUnits: number;
    totalUnits: number;
  }>;
  channelBreakdown: Array<{
    channel: string;
    examinedSessionCount: number;
    includedSessionCount: number;
    excludedSessionCount: number;
    baseUnits: number;
    llmAddonUnits: number;
    toolAddonUnits: number;
    totalUnits: number;
  }>;
}

export interface BillingMaterializationApplicationView {
  applicationId: string;
  tenantId: string;
  batchId: string;
  projectId: string | null;
  subscriptionId: string;
  status: BillingMaterializationApplicationStatus;
  triggerSource: BillingMaterializationApplicationTriggerSource;
  triggeredBy: string;
  appliedBy: string;
  materializationBasis: BillingMaterializationBasis;
  materializationScope: BillingMaterializationApplicationScopeView;
  summarySnapshot: BillingMaterializationApplicationSummaryView;
  warnings: string[];
  dealResolution: {
    organizationId: string;
    dealId: string;
    dealScope: 'organization' | 'project';
    matchType: BillingMaterializationApplicationDealMatchType;
  };
  accountingPeriod: {
    billingCycle: string;
    billingStartDate: string;
    referenceAt: string;
    periodStart: string;
    periodEnd: string;
    periodLabel: string;
  };
  projection: {
    usageReports: {
      status: 'deferred' | 'applied';
      reason: string | null;
      targetId: string | null;
      targetIds: string[];
      appliedAt: string | null;
    };
    creditLedger: {
      status: 'deferred' | 'applied';
      reason: string | null;
      targetId: string | null;
      targetIds: string[];
      appliedAt: string | null;
    };
    billingLineItems: {
      status: 'deferred' | 'applied';
      reason: string | null;
      targetId: string | null;
      targetIds: string[];
      appliedAt: string | null;
    };
  };
  appliedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplyBillingMaterializationInput {
  tenantId: string;
  batchId: string;
  appliedBy: string;
}

export interface ApplyBillingMaterializationResult {
  created: boolean;
  application: BillingMaterializationApplicationView;
}

export interface GetBillingMaterializationApplicationInput {
  tenantId: string;
  batchId: string;
}

interface BillingMaterializationApplicationServiceOptions {
  usagePublicationService?: BillingUsagePublicationService;
  now?: () => Date;
}

function toIsoString(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function toScopeView(
  value: IBillingMaterializationScope,
): BillingMaterializationApplicationScopeView {
  return {
    basis: value.basis,
    windowStart: toIsoString(value.windowStart),
    windowEnd: toIsoString(value.windowEnd),
    endedBefore: toIsoString(value.endedBefore),
    completedSessionsCount: value.completedSessionsCount,
    periodLabel: value.periodLabel,
  };
}

function normalizeProjectionTarget(
  value:
    | {
        status: 'deferred' | 'applied';
        reason: string | null;
        targetId: string | null;
        targetIds: string[];
        appliedAt: Date | null;
      }
    | null
    | undefined,
  fallbackReason: string | null,
) {
  return {
    status: value?.status ?? 'deferred',
    reason: value ? value.reason : fallbackReason,
    targetId: value ? value.targetId : null,
    targetIds: [...(value?.targetIds ?? [])],
    appliedAt: value ? value.appliedAt : null,
  };
}

function cloneSummary(
  value: IBillingMaterializationSummary,
): BillingMaterializationApplicationSummaryView {
  return {
    examinedSessionCount: value.examinedSessionCount,
    includedSessionCount: value.includedSessionCount,
    excludedSessionCount: value.excludedSessionCount,
    baseUnits: value.baseUnits,
    llmAddonUnits: value.llmAddonUnits,
    toolAddonUnits: value.toolAddonUnits,
    totalUnits: value.totalUnits,
    exclusionCounts: { ...value.exclusionCounts },
    metricsSourceCounts: { ...value.metricsSourceCounts },
    projectBreakdown: value.projectBreakdown.map((entry) => ({ ...entry })),
    channelBreakdown: value.channelBreakdown.map((entry) => ({ ...entry })),
  };
}

function toApplicationView(
  value: IBillingMaterializationApplication,
): BillingMaterializationApplicationView {
  return {
    applicationId: value._id,
    tenantId: value.tenantId,
    batchId: value.batchId,
    projectId: value.projectId,
    subscriptionId: value.subscriptionId,
    status: value.status,
    triggerSource: value.triggerSource,
    triggeredBy: value.triggeredBy,
    appliedBy: value.appliedBy,
    materializationBasis: value.materializationBasis,
    materializationScope: toScopeView(value.materializationScope),
    summarySnapshot: cloneSummary(value.summarySnapshot),
    warnings: [...value.warnings],
    dealResolution: {
      organizationId: value.dealResolution.organizationId,
      dealId: value.dealResolution.dealId,
      dealScope: value.dealResolution.dealScope,
      matchType: value.dealResolution.matchType,
    },
    accountingPeriod: {
      billingCycle: value.accountingPeriod.billingCycle,
      billingStartDate: value.accountingPeriod.billingStartDate.toISOString(),
      referenceAt: value.accountingPeriod.referenceAt.toISOString(),
      periodStart: value.accountingPeriod.periodStart.toISOString(),
      periodEnd: value.accountingPeriod.periodEnd.toISOString(),
      periodLabel: value.accountingPeriod.periodLabel,
    },
    projection: {
      usageReports: {
        ...normalizeProjectionTarget(
          value.projection?.usageReports,
          USAGE_REPORTS_PROJECTION_PENDING_REASON,
        ),
        appliedAt: toIsoString(value.projection?.usageReports?.appliedAt),
      },
      creditLedger: {
        ...normalizeProjectionTarget(
          value.projection?.creditLedger,
          CREDIT_LEDGER_PROJECTION_DEFERRED_REASON,
        ),
        appliedAt: toIsoString(value.projection?.creditLedger?.appliedAt),
      },
      billingLineItems: {
        ...normalizeProjectionTarget(
          value.projection?.billingLineItems,
          BILLING_LINE_ITEMS_PROJECTION_DEFERRED_REASON,
        ),
        appliedAt: toIsoString(value.projection?.billingLineItems?.appliedAt),
      },
    },
    appliedAt: value.appliedAt.toISOString(),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

function normalizeBillingCycle(value: string): BillingCycleInterval | null {
  switch (value.trim().toLowerCase()) {
    case 'monthly':
      return { unit: 'months', count: 1 };
    case 'quarterly':
      return { unit: 'months', count: 3 };
    case 'yearly':
    case 'annual':
      return { unit: 'months', count: 12 };
    case 'weekly':
      return { unit: 'days', count: 7 };
    default:
      return null;
  }
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addUtcMonthsClamped(value: Date, monthCount: number): Date {
  const year = value.getUTCFullYear();
  const monthIndex = value.getUTCMonth();
  const day = value.getUTCDate();
  const hour = value.getUTCHours();
  const minute = value.getUTCMinutes();
  const second = value.getUTCSeconds();
  const millisecond = value.getUTCMilliseconds();

  const targetMonthIndex = monthIndex + monthCount;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedTargetMonthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const targetDay = Math.min(day, daysInUtcMonth(targetYear, normalizedTargetMonthIndex));

  return new Date(
    Date.UTC(targetYear, normalizedTargetMonthIndex, targetDay, hour, minute, second, millisecond),
  );
}

function addUtcDays(value: Date, dayCount: number): Date {
  return new Date(value.getTime() + dayCount * 24 * 60 * 60 * 1000);
}

function computeMonthIntervalPeriod(
  anchor: Date,
  reference: Date,
  intervalCount: 1 | 3 | 12,
): {
  periodStart: Date;
  nextPeriodStart: Date;
} {
  let intervalIndex =
    Math.floor(
      ((reference.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
        (reference.getUTCMonth() - anchor.getUTCMonth())) /
        intervalCount,
    ) || 0;
  let periodStart = addUtcMonthsClamped(anchor, intervalIndex * intervalCount);

  if (periodStart.getTime() > reference.getTime()) {
    intervalIndex -= 1;
    periodStart = addUtcMonthsClamped(anchor, intervalIndex * intervalCount);
  }

  let nextPeriodStart = addUtcMonthsClamped(periodStart, intervalCount);
  while (nextPeriodStart.getTime() <= reference.getTime()) {
    periodStart = nextPeriodStart;
    nextPeriodStart = addUtcMonthsClamped(periodStart, intervalCount);
  }

  return { periodStart, nextPeriodStart };
}

function computeDayIntervalPeriod(
  anchor: Date,
  reference: Date,
  intervalCount: 7,
): {
  periodStart: Date;
  nextPeriodStart: Date;
} {
  let intervalIndex =
    Math.floor((reference.getTime() - anchor.getTime()) / (intervalCount * 24 * 60 * 60 * 1000)) ||
    0;
  let periodStart = addUtcDays(anchor, intervalIndex * intervalCount);

  if (periodStart.getTime() > reference.getTime()) {
    intervalIndex -= 1;
    periodStart = addUtcDays(anchor, intervalIndex * intervalCount);
  }

  let nextPeriodStart = addUtcDays(periodStart, intervalCount);
  while (nextPeriodStart.getTime() <= reference.getTime()) {
    periodStart = nextPeriodStart;
    nextPeriodStart = addUtcDays(periodStart, intervalCount);
  }

  return { periodStart, nextPeriodStart };
}

function formatAccountingPeriodLabel(periodStart: Date, billingCycle: string): string {
  const normalized = billingCycle.trim().toLowerCase();
  const year = periodStart.getUTCFullYear();
  const month = String(periodStart.getUTCMonth() + 1).padStart(2, '0');
  const day = String(periodStart.getUTCDate()).padStart(2, '0');

  switch (normalized) {
    case 'monthly':
      return `${year}-${month}`;
    case 'quarterly':
      return `${year}-Q${Math.floor(periodStart.getUTCMonth() / 3) + 1}`;
    case 'yearly':
    case 'annual':
      return `${year}`;
    case 'weekly':
      return `${year}-${month}-${day}`;
    default:
      return `${periodStart.toISOString()}`;
  }
}

function resolveAccountingPeriod(params: {
  billingCycle: string;
  billingStartDate: Date;
  referenceAt: Date;
}): {
  billingCycle: string;
  billingStartDate: Date;
  referenceAt: Date;
  periodStart: Date;
  periodEnd: Date;
  periodLabel: string;
} {
  const interval = normalizeBillingCycle(params.billingCycle);
  if (!interval) {
    throw new BillingMaterializationApplicationError(
      'UNSUPPORTED_BILLING_CYCLE',
      'Unsupported billing cycle for billing materialization application',
      {
        billingCycle: params.billingCycle,
      },
    );
  }

  const { periodStart, nextPeriodStart } =
    interval.unit === 'months'
      ? computeMonthIntervalPeriod(params.billingStartDate, params.referenceAt, interval.count)
      : computeDayIntervalPeriod(params.billingStartDate, params.referenceAt, interval.count);

  return {
    billingCycle: params.billingCycle,
    billingStartDate: params.billingStartDate,
    referenceAt: params.referenceAt,
    periodStart,
    periodEnd: new Date(nextPeriodStart.getTime() - 1),
    periodLabel: formatAccountingPeriodLabel(periodStart, params.billingCycle),
  };
}

function resolveBatchReferenceAt(batch: IBillingMaterializationBatch): Date {
  return batch.scope.windowEnd ?? batch.scope.endedBefore ?? batch.completedAt ?? batch.startedAt;
}

function isDuplicateKeyError(error: unknown): error is { code: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'number' &&
    (error as { code: number }).code === 11000
  );
}

async function resolveApplicableDeal(params: {
  organizationId: string;
  projectId: string | null;
}): Promise<{
  deal: IDeal;
  matchType: BillingMaterializationApplicationDealMatchType;
}> {
  if (params.projectId) {
    const projectDeals = (await Deal.find({
      organizationId: params.organizationId,
      status: 'active',
      scope: 'project',
      projectId: params.projectId,
    })
      .lean()
      .exec()) as IDeal[];

    if (projectDeals.length === 1) {
      return {
        deal: projectDeals[0],
        matchType: 'project_exact',
      };
    }

    if (projectDeals.length > 1) {
      throw new BillingMaterializationApplicationError(
        'AMBIGUOUS_ACTIVE_DEAL',
        'Multiple active project-scoped deals match this billing materialization batch',
        {
          organizationId: params.organizationId,
          projectId: params.projectId,
          candidateDealIds: projectDeals.map((deal) => deal._id),
        },
      );
    }
  }

  const organizationDeals = (await Deal.find({
    organizationId: params.organizationId,
    status: 'active',
    scope: 'organization',
  })
    .lean()
    .exec()) as IDeal[];

  if (organizationDeals.length === 1) {
    return {
      deal: organizationDeals[0],
      matchType: params.projectId ? 'organization_fallback' : 'organization_scope',
    };
  }

  if (organizationDeals.length > 1) {
    throw new BillingMaterializationApplicationError(
      'AMBIGUOUS_ACTIVE_DEAL',
      'Multiple active organization-scoped deals match this billing materialization batch',
      {
        organizationId: params.organizationId,
        projectId: params.projectId,
        candidateDealIds: organizationDeals.map((deal) => deal._id),
      },
    );
  }

  throw new BillingMaterializationApplicationError(
    'NO_ACTIVE_DEAL',
    'No active deal matches this billing materialization batch',
    {
      organizationId: params.organizationId,
      projectId: params.projectId,
    },
  );
}

export class BillingMaterializationApplicationService {
  private readonly usagePublicationService: BillingUsagePublicationService;
  private readonly now: () => Date;

  constructor(options: BillingMaterializationApplicationServiceOptions = {}) {
    this.usagePublicationService =
      options.usagePublicationService ?? new BillingUsagePublicationService();
    this.now = options.now ?? (() => new Date());
  }

  async applyMaterialization(
    input: ApplyBillingMaterializationInput,
  ): Promise<ApplyBillingMaterializationResult | null> {
    const existing = await BillingMaterializationApplication.findOne({
      tenantId: input.tenantId,
      batchId: input.batchId,
    })
      .lean()
      .exec();

    if (existing) {
      const existingApplication = existing as IBillingMaterializationApplication;
      if (
        normalizeProjectionTarget(
          existingApplication.projection?.usageReports,
          USAGE_REPORTS_PROJECTION_PENDING_REASON,
        ).status !== 'applied'
      ) {
        const batch = (await BillingMaterializationBatch.findOne({
          _id: input.batchId,
          tenantId: input.tenantId,
        })
          .lean()
          .exec()) as Pick<IBillingMaterializationBatch, '_id' | 'createdAt'> | null;

        if (!batch) {
          return null;
        }

        const finalized = await this.finalizeUsageReportProjection(existingApplication, batch);
        return {
          created: false,
          application: toApplicationView(finalized),
        };
      }

      return {
        created: false,
        application: toApplicationView(existingApplication),
      };
    }

    const batch = (await BillingMaterializationBatch.findOne({
      _id: input.batchId,
      tenantId: input.tenantId,
    })
      .lean()
      .exec()) as IBillingMaterializationBatch | null;

    if (!batch) {
      return null;
    }

    if (batch.status !== 'completed') {
      throw new BillingMaterializationApplicationError(
        'BATCH_NOT_READY',
        'Billing materialization batch must be completed before it can be applied',
        {
          batchId: batch._id,
          status: batch.status,
        },
      );
    }

    if (!batch.summary) {
      throw new BillingMaterializationApplicationError(
        'BATCH_SUMMARY_MISSING',
        'Billing materialization batch is missing a completed summary snapshot',
        { batchId: batch._id },
      );
    }

    const [tenant, subscription] = await Promise.all([
      Tenant.findOne({ _id: input.tenantId }).lean().exec() as Promise<ITenant | null>,
      Subscription.findOne({ _id: batch.subscriptionId })
        .lean()
        .exec() as Promise<ISubscription | null>,
    ]);

    if (!tenant) {
      throw new BillingMaterializationApplicationError(
        'TENANT_NOT_FOUND',
        'Tenant not found for billing materialization batch',
        {
          tenantId: input.tenantId,
          batchId: batch._id,
        },
      );
    }

    if (!subscription) {
      throw new BillingMaterializationApplicationError(
        'SUBSCRIPTION_NOT_FOUND',
        'Billing materialization batch subscription could not be resolved',
        {
          tenantId: input.tenantId,
          batchId: batch._id,
          subscriptionId: batch.subscriptionId,
        },
      );
    }

    const organizationId = subscription.organizationId ?? tenant.organizationId ?? input.tenantId;
    const { deal, matchType } = await resolveApplicableDeal({
      organizationId,
      projectId: batch.projectId,
    });
    const referenceAt = resolveBatchReferenceAt(batch);
    const accountingPeriod = resolveAccountingPeriod({
      billingCycle: subscription.billingCycle,
      billingStartDate: subscription.billingStartDate,
      referenceAt,
    });

    try {
      const application = await BillingMaterializationApplication.create({
        tenantId: input.tenantId,
        batchId: batch._id,
        projectId: batch.projectId,
        subscriptionId: batch.subscriptionId,
        status: 'recorded',
        triggerSource: batch.triggerSource,
        triggeredBy: batch.triggeredBy,
        appliedBy: input.appliedBy,
        materializationBasis: batch.scope.basis,
        materializationScope: batch.scope,
        summarySnapshot: batch.summary,
        warnings: [...batch.warnings],
        dealResolution: {
          organizationId,
          dealId: deal._id,
          dealScope: deal.scope,
          matchType,
        },
        accountingPeriod,
        projection: {
          usageReports: {
            status: 'deferred',
            reason: USAGE_REPORTS_PROJECTION_PENDING_REASON,
            targetId: null,
            targetIds: [],
            appliedAt: null,
          },
          creditLedger: {
            status: 'deferred',
            reason: CREDIT_LEDGER_PROJECTION_DEFERRED_REASON,
            targetId: null,
            targetIds: [],
            appliedAt: null,
          },
          billingLineItems: {
            status: 'deferred',
            reason: BILLING_LINE_ITEMS_PROJECTION_DEFERRED_REASON,
            targetId: null,
            targetIds: [],
            appliedAt: null,
          },
        },
        appliedAt: new Date(),
      });

      const finalized = await this.finalizeUsageReportProjection(
        application.toObject() as IBillingMaterializationApplication,
        batch,
      );

      log.info('Recorded billing materialization application', {
        tenantId: input.tenantId,
        batchId: batch._id,
        applicationId: application._id,
        dealId: deal._id,
        projectId: batch.projectId,
      });

      return {
        created: true,
        application: toApplicationView(finalized),
      };
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const concurrent = await BillingMaterializationApplication.findOne({
        tenantId: input.tenantId,
        batchId: input.batchId,
      })
        .lean()
        .exec();

      if (!concurrent) {
        throw error;
      }

      const concurrentApplication = concurrent as IBillingMaterializationApplication;
      if (
        normalizeProjectionTarget(
          concurrentApplication.projection?.usageReports,
          USAGE_REPORTS_PROJECTION_PENDING_REASON,
        ).status !== 'applied'
      ) {
        const finalized = await this.finalizeUsageReportProjection(concurrentApplication, batch);
        return {
          created: false,
          application: toApplicationView(finalized),
        };
      }

      return {
        created: false,
        application: toApplicationView(concurrentApplication),
      };
    }
  }

  async getMaterializationApplication(
    input: GetBillingMaterializationApplicationInput,
  ): Promise<BillingMaterializationApplicationView | null> {
    const application = await BillingMaterializationApplication.findOne({
      tenantId: input.tenantId,
      batchId: input.batchId,
    })
      .lean()
      .exec();

    if (!application) {
      return null;
    }

    return toApplicationView(application as IBillingMaterializationApplication);
  }

  private async finalizeUsageReportProjection(
    application: IBillingMaterializationApplication,
    batch: Pick<IBillingMaterializationBatch, '_id' | 'createdAt'>,
  ): Promise<IBillingMaterializationApplication> {
    const publishedAt = this.now();
    await this.usagePublicationService.publishAppliedMaterialization({
      tenantId: application.tenantId,
      batchId: application.batchId,
      applicationId: application._id,
      batchCreatedAt: batch.createdAt,
      publishedAt,
    });

    const updated = (await BillingMaterializationApplication.findOneAndUpdate(
      {
        _id: application._id,
        tenantId: application.tenantId,
      },
      {
        $set: {
          status: 'projected',
          projection: {
            ...application.projection,
            usageReports: {
              status: 'applied',
              reason: null,
              targetId: application.batchId,
              targetIds: [],
              appliedAt: publishedAt,
            },
          },
        },
      },
      { new: true },
    )
      .lean()
      .exec()) as IBillingMaterializationApplication | null;

    if (!updated) {
      throw new Error(
        `Billing materialization application ${application._id} disappeared during usage report projection`,
      );
    }

    return updated;
  }
}
