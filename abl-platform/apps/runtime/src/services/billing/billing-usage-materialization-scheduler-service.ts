import { createLogger } from '@abl/compiler/platform';
import {
  BillingMaterializationCheckpoint,
  Subscription,
  type BillingMaterializationBasis,
  type IBillingMaterializationCheckpointCursor,
} from '@agent-platform/database/models';
import {
  BillingUsageMaterializationPlannerService,
  type BillingUsageMaterializationPlanView,
  type BillingUsageMaterializationPlannedScope,
} from './billing-usage-materialization-planner-service.js';
import {
  BillingUsageMaterializationService,
  type BillingUsageMaterializationBatchView,
  type CreateBillingUsageMaterializationInput,
} from './billing-usage-materialization-service.js';

const log = createLogger('billing-usage-materialization-scheduler-service');

const DEFAULT_TENANT_BATCH_SIZE = 100;
const SCHEDULED_TRIGGERED_BY = 'billing-materializer-scheduler';

interface BillingUsageMaterializationPlanner {
  planNextMaterialization(input: {
    tenantId: string;
    projectId?: string;
  }): Promise<BillingUsageMaterializationPlanView | null>;
}

interface BillingUsageMaterializationExecutor {
  createMaterialization(
    input: CreateBillingUsageMaterializationInput,
  ): Promise<BillingUsageMaterializationBatchView | null>;
}

interface BillingUsageMaterializationSchedulerServiceOptions {
  plannerService?: BillingUsageMaterializationPlanner;
  materializationService?: BillingUsageMaterializationExecutor;
  now?: () => Date;
  tenantBatchSize?: number;
}

export interface ScheduledBillingMaterializationBatchResult {
  tenantId: string;
  projectId: string | null;
  batchId: string;
  basis: BillingMaterializationBasis;
}

export interface RunScheduledBillingMaterializationPassResult {
  scannedTenantCount: number;
  skippedTenantCount: number;
  dueTenantCount: number;
  materializedBatchCount: number;
  failedTenantCount: number;
  batches: ScheduledBillingMaterializationBatchResult[];
  failures: Array<{
    tenantId: string;
    projectId: string | null;
    error: string;
  }>;
}

interface ActiveSubscriptionTenantRow {
  tenantId?: string;
}

function toDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function buildScheduledMaterializationRequest(params: {
  tenantId: string;
  projectId: string | null;
  scope: BillingUsageMaterializationPlannedScope;
}): CreateBillingUsageMaterializationInput {
  return {
    tenantId: params.tenantId,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.scope.windowStart ? { windowStart: new Date(params.scope.windowStart) } : {}),
    ...(params.scope.windowEnd ? { windowEnd: new Date(params.scope.windowEnd) } : {}),
    ...(params.scope.endedBefore ? { endedBefore: new Date(params.scope.endedBefore) } : {}),
    triggeredBy: SCHEDULED_TRIGGERED_BY,
    triggerSource: 'scheduled',
  };
}

function buildCheckpointCursor(
  scope: BillingUsageMaterializationPlannedScope,
): IBillingMaterializationCheckpointCursor {
  if (scope.basis === 'time_window') {
    const windowEnd = toDate(scope.windowEnd);
    if (!windowEnd) {
      throw new Error('Scheduled time-window materialization is missing windowEnd');
    }

    return {
      lastWindowEnd: windowEnd,
      lastEndedAt: null,
      lastSessionId: null,
    };
  }

  const lastEndedAt = toDate(scope.cursorEndEndedAt);
  if (!lastEndedAt || !scope.cursorEndSessionId) {
    throw new Error(
      'Scheduled completed-session materialization is missing cursorEndEndedAt or cursorEndSessionId',
    );
  }

  return {
    lastWindowEnd: null,
    lastEndedAt,
    lastSessionId: scope.cursorEndSessionId,
  };
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

export class BillingUsageMaterializationSchedulerService {
  private readonly plannerService: BillingUsageMaterializationPlanner;
  private readonly materializationService: BillingUsageMaterializationExecutor;
  private readonly now: () => Date;
  private readonly tenantBatchSize: number;

  constructor(options: BillingUsageMaterializationSchedulerServiceOptions = {}) {
    this.plannerService = options.plannerService ?? new BillingUsageMaterializationPlannerService();
    this.materializationService =
      options.materializationService ?? new BillingUsageMaterializationService();
    this.now = options.now ?? (() => new Date());
    this.tenantBatchSize = options.tenantBatchSize ?? DEFAULT_TENANT_BATCH_SIZE;
  }

  async runDueMaterializations(): Promise<RunScheduledBillingMaterializationPassResult> {
    const result: RunScheduledBillingMaterializationPassResult = {
      scannedTenantCount: 0,
      skippedTenantCount: 0,
      dueTenantCount: 0,
      materializedBatchCount: 0,
      failedTenantCount: 0,
      batches: [],
      failures: [],
    };

    for await (const tenantId of iterateActiveTenantIds(this.tenantBatchSize)) {
      result.scannedTenantCount += 1;

      const plan = await this.plannerService.planNextMaterialization({ tenantId });
      if (!plan || !plan.due || !plan.scope) {
        result.skippedTenantCount += 1;
        continue;
      }

      result.dueTenantCount += 1;

      try {
        const batch = await this.materializationService.createMaterialization(
          buildScheduledMaterializationRequest({
            tenantId,
            projectId: plan.projectId,
            scope: plan.scope,
          }),
        );

        if (!batch) {
          result.skippedTenantCount += 1;
          log.warn('Scheduled billing materialization skipped — no batch returned', {
            tenantId,
            projectId: plan.projectId,
            basis: plan.basis,
          });
          continue;
        }

        await BillingMaterializationCheckpoint.findOneAndUpdate(
          {
            tenantId,
            projectId: plan.projectId,
            basis: plan.basis,
          },
          {
            $set: {
              cursor: buildCheckpointCursor(plan.scope),
              lastBatchId: batch.batchId,
              lastMaterializedAt: this.now(),
            },
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
          },
        ).exec();

        result.materializedBatchCount += 1;
        result.batches.push({
          tenantId,
          projectId: plan.projectId,
          batchId: batch.batchId,
          basis: plan.basis,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failedTenantCount += 1;
        result.failures.push({
          tenantId,
          projectId: plan.projectId,
          error: message,
        });
        log.error('Scheduled billing materialization failed', {
          tenantId,
          projectId: plan.projectId,
          basis: plan.basis,
          error: message,
        });
      }
    }

    return result;
  }
}
