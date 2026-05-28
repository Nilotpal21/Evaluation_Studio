import { createLogger } from '@abl/compiler/platform';
import {
  BillingMaterializationApplication,
  BillingMaterializationBatch,
  BillingUsagePublishedSession,
  Tenant,
  type BillingMaterializationApplicationStatus,
  type IBillingMaterializationApplication,
  type IBillingMaterializationBatch,
  type ITenant,
} from '@agent-platform/database/models';

const log = createLogger('billing-usage-materialization-visibility-service');

const DEFAULT_RECENT_BATCH_LIMIT = 8;
const MAX_RECENT_BATCH_LIMIT = 25;
const PUBLICATION_PENDING_REASON = 'billing_usage_report_publication_pending';
const MATERIALIZATION_FAILED_REASON = 'billing_materialization_failed';
const MATERIALIZATION_IN_PROGRESS_REASON = 'billing_materialization_in_progress';
const APPLICATION_MISSING_REASON = 'billing_usage_report_application_missing';
const PUBLICATION_SUPERSEDED_REASON = 'billing_usage_report_superseded_by_newer_batch';

export interface BillingUsageMaterializationVisibilityBatchView {
  batchId: string;
  projectId: string | null;
  triggerSource: 'manual' | 'scheduled';
  materializationStatus: 'running' | 'completed' | 'failed';
  applicationStatus: BillingMaterializationApplicationStatus | 'missing';
  publicationStatus: 'not_ready' | 'pending' | 'published' | 'superseded';
  publicationReason: string | null;
  resultCount: number;
  totalUnits: number;
  eventDispatchAttempted: boolean;
  startedAt: string;
  completedAt: string | null;
  publishedAt: string | null;
  applicationId: string | null;
}

export interface BillingUsageMaterializationVisibilitySummary {
  completedBatchCount: number;
  runningBatchCount: number;
  failedBatchCount: number;
  pendingPublicationCount: number;
  publishedBatchCount: number;
  supersededBatchCount: number;
  lastMaterializedAt: string | null;
  lastPublishedAt: string | null;
}

export interface BillingUsageMaterializationVisibilityView {
  tenantId: string;
  projectId: string | null;
  summary: BillingUsageMaterializationVisibilitySummary;
  batches: BillingUsageMaterializationVisibilityBatchView[];
}

export interface BillingUsageMaterializationPlatformTenantView extends BillingUsageMaterializationVisibilitySummary {
  tenantId: string;
  tenantName: string | null;
}

export interface BillingUsageMaterializationPlatformVisibilityView {
  summary: BillingUsageMaterializationVisibilitySummary;
  tenants: BillingUsageMaterializationPlatformTenantView[];
}

export interface GetBillingUsageMaterializationVisibilityInput {
  tenantId: string;
  projectId?: string;
  limit?: number;
}

export interface GetPlatformBillingUsageMaterializationVisibilityInput {
  limit?: number;
}

interface BillingUsageMaterializationVisibilityServiceOptions {
  now?: () => Date;
}

interface CurrentPublishedBatchRow {
  _id: string;
  currentPublishedSessionCount: number;
  lastPublishedAt: Date | null;
}

interface CurrentPublishedTenantRow {
  _id: string;
  publishedBatchCount: number;
  lastPublishedAt: Date | null;
}

interface EmptyAppliedPublicationRow {
  _id: string | null;
  emptyAppliedBatchCount: number;
  lastEmptyAppliedAt: Date | null;
}

interface AppliedPublicationRow {
  _id: string | null;
  appliedBatchCount: number;
  lastAppliedAt: Date | null;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) {
    return DEFAULT_RECENT_BATCH_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_RECENT_BATCH_LIMIT);
}

function toIsoString(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function maxDate(left: Date | null | undefined, right: Date | null | undefined): Date | null {
  if (left instanceof Date && !Number.isNaN(left.getTime())) {
    if (right instanceof Date && !Number.isNaN(right.getTime())) {
      return left.getTime() >= right.getTime() ? left : right;
    }
    return left;
  }

  if (right instanceof Date && !Number.isNaN(right.getTime())) {
    return right;
  }

  return null;
}

function buildVisibilitySummary(input: {
  completedBatchCount: number;
  runningBatchCount: number;
  failedBatchCount: number;
  publishedBatchCount: number;
  supersededBatchCount: number;
  lastMaterializedAt: Date | null | undefined;
  lastPublishedAt: Date | null | undefined;
}): BillingUsageMaterializationVisibilitySummary {
  return {
    completedBatchCount: input.completedBatchCount,
    runningBatchCount: input.runningBatchCount,
    failedBatchCount: input.failedBatchCount,
    pendingPublicationCount: Math.max(
      input.completedBatchCount - input.publishedBatchCount - input.supersededBatchCount,
      0,
    ),
    publishedBatchCount: input.publishedBatchCount,
    supersededBatchCount: input.supersededBatchCount,
    lastMaterializedAt: toIsoString(input.lastMaterializedAt),
    lastPublishedAt: toIsoString(input.lastPublishedAt),
  };
}

function compareIsoDateDesc(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }

  return left > right ? -1 : 1;
}

async function loadCurrentPublishedBatches(params: {
  tenantId?: string;
  projectId?: string;
  batchIds?: string[];
}): Promise<CurrentPublishedBatchRow[]> {
  const match: Record<string, unknown> = {};
  if (params.tenantId) {
    match.tenantId = params.tenantId;
  }
  if (params.projectId) {
    match.projectId = params.projectId;
  }
  if (params.batchIds) {
    if (params.batchIds.length === 0) {
      return [];
    }
    match.batchId = { $in: params.batchIds };
  }

  return BillingUsagePublishedSession.aggregate<CurrentPublishedBatchRow>([
    { $match: match },
    {
      $group: {
        _id: '$batchId',
        currentPublishedSessionCount: { $sum: 1 },
        lastPublishedAt: { $max: '$publishedAt' },
      },
    },
  ]).exec();
}

async function loadAppliedPublicationStats(params: {
  tenantId?: string;
  projectId?: string;
}): Promise<AppliedPublicationRow | null> {
  const match: Record<string, unknown> = {
    'projection.usageReports.status': 'applied',
  };
  if (params.tenantId) {
    match.tenantId = params.tenantId;
  }
  if (params.projectId) {
    match.projectId = params.projectId;
  }

  const [stats] = await BillingMaterializationApplication.aggregate<AppliedPublicationRow>([
    { $match: match },
    {
      $group: {
        _id: null,
        appliedBatchCount: { $sum: 1 },
        lastAppliedAt: {
          $max: {
            $ifNull: ['$projection.usageReports.appliedAt', '$updatedAt'],
          },
        },
      },
    },
  ]).exec();

  return stats ?? null;
}

async function loadEmptyAppliedPublicationStats(params: {
  tenantId?: string;
  projectId?: string;
}): Promise<EmptyAppliedPublicationRow | null> {
  const match: Record<string, unknown> = {
    'projection.usageReports.status': 'applied',
  };
  if (params.tenantId) {
    match.tenantId = params.tenantId;
  }
  if (params.projectId) {
    match.projectId = params.projectId;
  }

  const batchCollection = BillingMaterializationBatch.collection.name;
  const [stats] = await BillingMaterializationApplication.aggregate<EmptyAppliedPublicationRow>([
    { $match: match },
    {
      $lookup: {
        from: batchCollection,
        let: { tenantId: '$tenantId', batchId: '$batchId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$_id', '$$batchId'] }, { $eq: ['$tenantId', '$$tenantId'] }],
              },
            },
          },
          { $project: { _id: 1, resultCount: 1 } },
        ],
        as: 'batch',
      },
    },
    { $addFields: { batch: { $arrayElemAt: ['$batch', 0] } } },
    { $match: { 'batch.resultCount': 0 } },
    {
      $group: {
        _id: null,
        emptyAppliedBatchCount: { $sum: 1 },
        lastEmptyAppliedAt: {
          $max: {
            $ifNull: ['$projection.usageReports.appliedAt', '$updatedAt'],
          },
        },
      },
    },
  ]).exec();

  return stats ?? null;
}

async function loadPlatformCurrentPublishedTenantStats(): Promise<CurrentPublishedTenantRow[]> {
  return BillingUsagePublishedSession.aggregate<CurrentPublishedTenantRow>([
    {
      $group: {
        _id: {
          tenantId: '$tenantId',
          batchId: '$batchId',
        },
        lastPublishedAt: { $max: '$publishedAt' },
      },
    },
    {
      $group: {
        _id: '$_id.tenantId',
        publishedBatchCount: { $sum: 1 },
        lastPublishedAt: { $max: '$lastPublishedAt' },
      },
    },
  ]).exec();
}

async function loadPlatformAppliedPublicationStats(): Promise<AppliedPublicationRow[]> {
  return BillingMaterializationApplication.aggregate<AppliedPublicationRow>([
    { $match: { 'projection.usageReports.status': 'applied' } },
    {
      $group: {
        _id: '$tenantId',
        appliedBatchCount: { $sum: 1 },
        lastAppliedAt: {
          $max: {
            $ifNull: ['$projection.usageReports.appliedAt', '$updatedAt'],
          },
        },
      },
    },
  ]).exec();
}

async function loadPlatformEmptyAppliedPublicationStats(): Promise<EmptyAppliedPublicationRow[]> {
  const batchCollection = BillingMaterializationBatch.collection.name;

  return BillingMaterializationApplication.aggregate<EmptyAppliedPublicationRow>([
    { $match: { 'projection.usageReports.status': 'applied' } },
    {
      $lookup: {
        from: batchCollection,
        let: { tenantId: '$tenantId', batchId: '$batchId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$_id', '$$batchId'] }, { $eq: ['$tenantId', '$$tenantId'] }],
              },
            },
          },
          { $project: { _id: 1, resultCount: 1 } },
        ],
        as: 'batch',
      },
    },
    { $addFields: { batch: { $arrayElemAt: ['$batch', 0] } } },
    { $match: { 'batch.resultCount': 0 } },
    {
      $group: {
        _id: '$tenantId',
        emptyAppliedBatchCount: { $sum: 1 },
        lastEmptyAppliedAt: {
          $max: {
            $ifNull: ['$projection.usageReports.appliedAt', '$updatedAt'],
          },
        },
      },
    },
  ]).exec();
}

function resolvePublicationState(
  batch: IBillingMaterializationBatch,
  application: IBillingMaterializationApplication | undefined,
  currentPublishedSessionCount: number,
): {
  publicationStatus: 'not_ready' | 'pending' | 'published' | 'superseded';
  publicationReason: string | null;
  applicationStatus: BillingMaterializationApplicationStatus | 'missing';
  publishedAt: string | null;
  applicationId: string | null;
} {
  if (batch.status === 'running') {
    return {
      publicationStatus: 'not_ready',
      publicationReason: MATERIALIZATION_IN_PROGRESS_REASON,
      applicationStatus: application?.status ?? 'missing',
      publishedAt: null,
      applicationId: application?._id ?? null,
    };
  }

  if (batch.status === 'failed') {
    return {
      publicationStatus: 'not_ready',
      publicationReason: batch.failureReason ?? MATERIALIZATION_FAILED_REASON,
      applicationStatus: application?.status ?? 'missing',
      publishedAt: null,
      applicationId: application?._id ?? null,
    };
  }

  if (!application) {
    return {
      publicationStatus: 'pending',
      publicationReason: APPLICATION_MISSING_REASON,
      applicationStatus: 'missing',
      publishedAt: null,
      applicationId: null,
    };
  }

  const appliedAt =
    application.projection?.usageReports?.appliedAt ??
    application.updatedAt ??
    application.createdAt;

  if (application.projection?.usageReports?.status === 'applied' && batch.resultCount === 0) {
    return {
      publicationStatus: 'published',
      publicationReason: null,
      applicationStatus: application.status,
      publishedAt: toIsoString(appliedAt),
      applicationId: application._id,
    };
  }

  if (
    application.projection?.usageReports?.status === 'applied' &&
    currentPublishedSessionCount > 0
  ) {
    return {
      publicationStatus: 'published',
      publicationReason: null,
      applicationStatus: application.status,
      publishedAt: toIsoString(appliedAt),
      applicationId: application._id,
    };
  }

  if (application.projection?.usageReports?.status === 'applied') {
    return {
      publicationStatus: 'superseded',
      publicationReason: PUBLICATION_SUPERSEDED_REASON,
      applicationStatus: application.status,
      publishedAt: toIsoString(appliedAt),
      applicationId: application._id,
    };
  }

  return {
    publicationStatus: 'pending',
    publicationReason: application.projection?.usageReports?.reason ?? PUBLICATION_PENDING_REASON,
    applicationStatus: application.status,
    publishedAt: null,
    applicationId: application._id,
  };
}

export class BillingUsageMaterializationVisibilityService {
  private readonly now: () => Date;

  constructor(options: BillingUsageMaterializationVisibilityServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async getTenantVisibility(
    input: GetBillingUsageMaterializationVisibilityInput,
  ): Promise<BillingUsageMaterializationVisibilityView> {
    const limit = clampLimit(input.limit);
    const batchFilter: Record<string, unknown> = { tenantId: input.tenantId };

    if (input.projectId) {
      batchFilter.projectId = input.projectId;
    }

    const [
      recentBatchesRaw,
      runningBatchCount,
      failedBatchCount,
      completedBatchCount,
      appliedPublicationStats,
      emptyAppliedPublicationStats,
      latestCompletedBatch,
      currentPublishedBatchRows,
    ] = await Promise.all([
      BillingMaterializationBatch.find(batchFilter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean()
        .exec() as Promise<IBillingMaterializationBatch[]>,
      BillingMaterializationBatch.countDocuments({
        ...batchFilter,
        status: 'running',
      }).exec(),
      BillingMaterializationBatch.countDocuments({
        ...batchFilter,
        status: 'failed',
      }).exec(),
      BillingMaterializationBatch.countDocuments({
        ...batchFilter,
        status: 'completed',
      }).exec(),
      loadAppliedPublicationStats({
        tenantId: input.tenantId,
        projectId: input.projectId,
      }),
      loadEmptyAppliedPublicationStats({
        tenantId: input.tenantId,
        projectId: input.projectId,
      }),
      BillingMaterializationBatch.findOne({
        ...batchFilter,
        status: 'completed',
      })
        .sort({ createdAt: -1 })
        .lean()
        .exec() as Promise<IBillingMaterializationBatch | null>,
      loadCurrentPublishedBatches({
        tenantId: input.tenantId,
        projectId: input.projectId,
      }),
    ]);

    const batchIds = recentBatchesRaw.map((batch) => batch._id);
    const recentApplicationsRaw =
      batchIds.length > 0
        ? ((await BillingMaterializationApplication.find({
            tenantId: input.tenantId,
            batchId: { $in: batchIds },
          })
            .lean()
            .exec()) as IBillingMaterializationApplication[])
        : [];
    const applicationByBatchId = new Map(
      recentApplicationsRaw.map((application) => [application.batchId, application]),
    );
    const currentPublishedByBatchId = new Map(
      currentPublishedBatchRows.map((row) => [row._id, row]),
    );

    const batches = recentBatchesRaw.map((batch) => {
      const publicationState = resolvePublicationState(
        batch,
        applicationByBatchId.get(batch._id),
        currentPublishedByBatchId.get(batch._id)?.currentPublishedSessionCount ?? 0,
      );

      return {
        batchId: batch._id,
        projectId: batch.projectId,
        triggerSource: batch.triggerSource,
        materializationStatus: batch.status,
        applicationStatus: publicationState.applicationStatus,
        publicationStatus: publicationState.publicationStatus,
        publicationReason: publicationState.publicationReason,
        resultCount: batch.resultCount,
        totalUnits: batch.summary?.totalUnits ?? 0,
        eventDispatchAttempted: batch.eventDispatchAttempted,
        startedAt: batch.startedAt.toISOString(),
        completedAt: toIsoString(batch.completedAt),
        publishedAt: publicationState.publishedAt,
        applicationId: publicationState.applicationId,
      } satisfies BillingUsageMaterializationVisibilityBatchView;
    });

    const currentPublishedBatchCount = currentPublishedBatchRows.length;
    const emptyAppliedBatchCount = emptyAppliedPublicationStats?.emptyAppliedBatchCount ?? 0;
    const appliedBatchCount = appliedPublicationStats?.appliedBatchCount ?? 0;
    const publishedBatchCount = currentPublishedBatchCount + emptyAppliedBatchCount;
    const supersededBatchCount = Math.max(appliedBatchCount - publishedBatchCount, 0);
    const lastPublishedAt = maxDate(
      currentPublishedBatchRows.reduce<Date | null>(
        (latest, row) => maxDate(latest, row.lastPublishedAt),
        null,
      ),
      emptyAppliedPublicationStats?.lastEmptyAppliedAt ?? null,
    );

    const summary = buildVisibilitySummary({
      completedBatchCount,
      runningBatchCount,
      failedBatchCount,
      publishedBatchCount,
      supersededBatchCount,
      lastMaterializedAt: latestCompletedBatch?.completedAt ?? latestCompletedBatch?.createdAt,
      lastPublishedAt,
    });

    log.info('Generated billing materialization visibility summary', {
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      recentBatchCount: batches.length,
      completedBatchCount,
      pendingPublicationCount: summary.pendingPublicationCount,
      publishedBatchCount,
      generatedAt: this.now().toISOString(),
    });

    return {
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      summary,
      batches,
    };
  }

  async getPlatformVisibility(
    input: GetPlatformBillingUsageMaterializationVisibilityInput = {},
  ): Promise<BillingUsageMaterializationPlatformVisibilityView> {
    const limit = clampLimit(input.limit);

    type BatchTenantAggregate = {
      _id: string;
      completedBatchCount: number;
      runningBatchCount: number;
      failedBatchCount: number;
      lastMaterializedAt: Date | null;
    };

    const [
      runningBatchCount,
      failedBatchCount,
      completedBatchCount,
      latestCompletedBatch,
      batchTenantStatsRaw,
      currentPublishedTenantStatsRaw,
      appliedTenantStatsRaw,
      emptyAppliedTenantStatsRaw,
    ] = await Promise.all([
      BillingMaterializationBatch.countDocuments({ status: 'running' }).exec(),
      BillingMaterializationBatch.countDocuments({ status: 'failed' }).exec(),
      BillingMaterializationBatch.countDocuments({ status: 'completed' }).exec(),
      BillingMaterializationBatch.findOne({ status: 'completed' })
        .sort({ createdAt: -1 })
        .lean()
        .exec() as Promise<IBillingMaterializationBatch | null>,
      BillingMaterializationBatch.aggregate<BatchTenantAggregate>([
        {
          $group: {
            _id: '$tenantId',
            completedBatchCount: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
            },
            runningBatchCount: {
              $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] },
            },
            failedBatchCount: {
              $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
            },
            lastMaterializedAt: {
              $max: {
                $cond: [
                  { $eq: ['$status', 'completed'] },
                  { $ifNull: ['$completedAt', '$createdAt'] },
                  null,
                ],
              },
            },
          },
        },
      ]).exec(),
      loadPlatformCurrentPublishedTenantStats(),
      loadPlatformAppliedPublicationStats(),
      loadPlatformEmptyAppliedPublicationStats(),
    ]);

    const currentPublishedStatsByTenant = Object.fromEntries(
      currentPublishedTenantStatsRaw.map((entry) => [entry._id, entry]),
    ) as Record<string, CurrentPublishedTenantRow | undefined>;
    const appliedStatsByTenant = Object.fromEntries(
      appliedTenantStatsRaw.map((entry) => [String(entry._id), entry]),
    ) as Record<string, AppliedPublicationRow | undefined>;
    const emptyAppliedStatsByTenant = Object.fromEntries(
      emptyAppliedTenantStatsRaw.map((entry) => [String(entry._id), entry]),
    ) as Record<string, EmptyAppliedPublicationRow | undefined>;

    const tenantIds = batchTenantStatsRaw.map((entry) => entry._id);
    const tenantsRaw =
      tenantIds.length > 0
        ? ((await Tenant.find({ _id: { $in: tenantIds } })
            .select({ _id: 1, name: 1 })
            .lean()
            .exec()) as Array<Pick<ITenant, '_id' | 'name'>>)
        : [];
    const tenantNameById = Object.fromEntries(
      tenantsRaw.map((tenant) => [tenant._id, tenant.name]),
    ) as Record<string, string | undefined>;

    const tenants = batchTenantStatsRaw
      .map((batchStats) => {
        const currentPublishedStats = currentPublishedStatsByTenant[batchStats._id];
        const appliedStats = appliedStatsByTenant[batchStats._id];
        const emptyAppliedStats = emptyAppliedStatsByTenant[batchStats._id];
        const publishedBatchCount =
          (currentPublishedStats?.publishedBatchCount ?? 0) +
          (emptyAppliedStats?.emptyAppliedBatchCount ?? 0);
        const supersededBatchCount = Math.max(
          (appliedStats?.appliedBatchCount ?? 0) - publishedBatchCount,
          0,
        );
        const summary = buildVisibilitySummary({
          completedBatchCount: batchStats.completedBatchCount,
          runningBatchCount: batchStats.runningBatchCount,
          failedBatchCount: batchStats.failedBatchCount,
          publishedBatchCount,
          supersededBatchCount,
          lastMaterializedAt: batchStats.lastMaterializedAt,
          lastPublishedAt: maxDate(
            currentPublishedStats?.lastPublishedAt ?? null,
            emptyAppliedStats?.lastEmptyAppliedAt ?? null,
          ),
        });

        return {
          tenantId: batchStats._id,
          tenantName: tenantNameById[batchStats._id] ?? null,
          ...summary,
        } satisfies BillingUsageMaterializationPlatformTenantView;
      })
      .sort((left, right) => {
        if (right.pendingPublicationCount !== left.pendingPublicationCount) {
          return right.pendingPublicationCount - left.pendingPublicationCount;
        }
        if (right.supersededBatchCount !== left.supersededBatchCount) {
          return right.supersededBatchCount - left.supersededBatchCount;
        }
        if (right.runningBatchCount !== left.runningBatchCount) {
          return right.runningBatchCount - left.runningBatchCount;
        }
        return (
          compareIsoDateDesc(left.lastMaterializedAt, right.lastMaterializedAt) ||
          left.tenantId.localeCompare(right.tenantId)
        );
      })
      .slice(0, limit);

    const overallPublishedBatchCount =
      currentPublishedTenantStatsRaw.reduce(
        (total, entry) => total + entry.publishedBatchCount,
        0,
      ) +
      emptyAppliedTenantStatsRaw.reduce((total, entry) => total + entry.emptyAppliedBatchCount, 0);
    const overallAppliedBatchCount = appliedTenantStatsRaw.reduce(
      (total, entry) => total + entry.appliedBatchCount,
      0,
    );
    const overallSupersededBatchCount = Math.max(
      overallAppliedBatchCount - overallPublishedBatchCount,
      0,
    );
    const lastPublishedAt = maxDate(
      currentPublishedTenantStatsRaw.reduce<Date | null>(
        (latest, entry) => maxDate(latest, entry.lastPublishedAt),
        null,
      ),
      emptyAppliedTenantStatsRaw.reduce<Date | null>(
        (latest, entry) => maxDate(latest, entry.lastEmptyAppliedAt),
        null,
      ),
    );

    const summary = buildVisibilitySummary({
      completedBatchCount,
      runningBatchCount,
      failedBatchCount,
      publishedBatchCount: overallPublishedBatchCount,
      supersededBatchCount: overallSupersededBatchCount,
      lastMaterializedAt: latestCompletedBatch?.completedAt ?? latestCompletedBatch?.createdAt,
      lastPublishedAt,
    });

    log.info('Generated platform billing materialization visibility summary', {
      tenantCount: tenants.length,
      completedBatchCount,
      pendingPublicationCount: summary.pendingPublicationCount,
      publishedBatchCount: overallPublishedBatchCount,
      generatedAt: this.now().toISOString(),
    });

    return {
      summary,
      tenants,
    };
  }
}
