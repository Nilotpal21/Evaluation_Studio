import { createLogger } from '@abl/compiler/platform';
import {
  BillingMaterializationApplication,
  BillingMaterializationBatch,
  Subscription,
} from '@agent-platform/database/models';
import type { ApplyBillingMaterializationResult } from './billing-materialization-application-service.js';
import { BillingMaterializationApplicationService } from './billing-materialization-application-service.js';

const log = createLogger('billing-usage-publication-scheduler-service');

const DEFAULT_TENANT_BATCH_SIZE = 100;
const DEFAULT_BATCH_LIMIT = 10;
const SCHEDULED_APPLIED_BY = 'billing-publication-scheduler';

interface BillingUsagePublicationExecutor {
  applyMaterialization(input: {
    tenantId: string;
    batchId: string;
    appliedBy: string;
  }): Promise<ApplyBillingMaterializationResult | null>;
}

interface BillingUsagePublicationSchedulerServiceOptions {
  applicationService?: BillingUsagePublicationExecutor;
  tenantBatchSize?: number;
  batchLimit?: number;
}

interface ActiveSubscriptionTenantRow {
  tenantId?: string;
}

interface PendingCompletedBatchRow {
  _id: string;
  projectId?: string | null;
}

export interface ScheduledBillingPublicationBatchResult {
  tenantId: string;
  projectId: string | null;
  batchId: string;
  created: boolean;
}

export interface RunScheduledBillingPublicationPassResult {
  scannedTenantCount: number;
  skippedTenantCount: number;
  pendingTenantCount: number;
  attemptedBatchCount: number;
  appliedBatchCount: number;
  failedBatchCount: number;
  batches: ScheduledBillingPublicationBatchResult[];
  failures: Array<{
    tenantId: string;
    projectId: string | null;
    batchId: string;
    error: string;
  }>;
}

async function* iterateActiveTenantIds(batchSize: number): AsyncGenerator<string, void, undefined> {
  const cursor = Subscription.find(
    { status: 'active' },
    {
      tenantId: 1,
      _id: 0,
    },
  )
    .sort({ tenantId: 1, _id: 1 })
    .lean()
    .cursor({ batchSize });

  let previousTenantId: string | null = null;

  try {
    for await (const row of cursor as AsyncIterable<ActiveSubscriptionTenantRow>) {
      if (typeof row.tenantId !== 'string' || row.tenantId.length === 0) {
        continue;
      }

      if (row.tenantId === previousTenantId) {
        continue;
      }

      previousTenantId = row.tenantId;
      yield row.tenantId;
    }
  } finally {
    await cursor.close().catch(() => undefined);
  }
}

async function findPendingCompletedBatches(
  tenantId: string,
  limit: number,
): Promise<PendingCompletedBatchRow[]> {
  if (limit <= 0) {
    return [];
  }

  const applicationCollection = BillingMaterializationApplication.collection.name;

  return BillingMaterializationBatch.aggregate<PendingCompletedBatchRow>([
    {
      $match: {
        tenantId,
        status: 'completed',
      },
    },
    {
      $sort: {
        createdAt: 1,
        _id: 1,
      },
    },
    {
      $lookup: {
        from: applicationCollection,
        let: {
          tenantId: '$tenantId',
          batchId: '$_id',
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$tenantId', '$$tenantId'] }, { $eq: ['$batchId', '$$batchId'] }],
              },
            },
          },
          {
            $project: {
              _id: 1,
              'projection.usageReports.status': 1,
            },
          },
        ],
        as: 'application',
      },
    },
    {
      $addFields: {
        application: { $arrayElemAt: ['$application', 0] },
      },
    },
    {
      $match: {
        $or: [
          { application: null },
          { 'application.projection.usageReports.status': { $ne: 'applied' } },
        ],
      },
    },
    {
      $limit: limit,
    },
    {
      $project: {
        _id: 1,
        projectId: 1,
      },
    },
  ]).exec();
}

export class BillingUsagePublicationSchedulerService {
  private readonly applicationService: BillingUsagePublicationExecutor;
  private readonly tenantBatchSize: number;
  private readonly batchLimit: number;

  constructor(options: BillingUsagePublicationSchedulerServiceOptions = {}) {
    this.applicationService =
      options.applicationService ?? new BillingMaterializationApplicationService();
    this.tenantBatchSize = options.tenantBatchSize ?? DEFAULT_TENANT_BATCH_SIZE;
    this.batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  }

  async runDuePublications(): Promise<RunScheduledBillingPublicationPassResult> {
    const result: RunScheduledBillingPublicationPassResult = {
      scannedTenantCount: 0,
      skippedTenantCount: 0,
      pendingTenantCount: 0,
      attemptedBatchCount: 0,
      appliedBatchCount: 0,
      failedBatchCount: 0,
      batches: [],
      failures: [],
    };

    for await (const tenantId of iterateActiveTenantIds(this.tenantBatchSize)) {
      if (result.attemptedBatchCount >= this.batchLimit) {
        break;
      }

      result.scannedTenantCount += 1;
      const remaining = this.batchLimit - result.attemptedBatchCount;
      const pendingBatches = await findPendingCompletedBatches(tenantId, remaining);

      if (pendingBatches.length === 0) {
        result.skippedTenantCount += 1;
        continue;
      }

      result.pendingTenantCount += 1;

      for (const batch of pendingBatches) {
        if (result.attemptedBatchCount >= this.batchLimit) {
          break;
        }

        result.attemptedBatchCount += 1;

        try {
          const application = await this.applicationService.applyMaterialization({
            tenantId,
            batchId: batch._id,
            appliedBy: SCHEDULED_APPLIED_BY,
          });

          if (!application) {
            log.warn('Scheduled billing publication skipped — batch disappeared before apply', {
              tenantId,
              projectId: batch.projectId ?? null,
              batchId: batch._id,
            });
            continue;
          }

          result.appliedBatchCount += 1;
          result.batches.push({
            tenantId,
            projectId: batch.projectId ?? null,
            batchId: batch._id,
            created: application.created,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          result.failedBatchCount += 1;
          result.failures.push({
            tenantId,
            projectId: batch.projectId ?? null,
            batchId: batch._id,
            error: message,
          });
          log.error('Scheduled billing publication failed', {
            tenantId,
            projectId: batch.projectId ?? null,
            batchId: batch._id,
            error: message,
          });
        }
      }
    }

    return result;
  }
}
