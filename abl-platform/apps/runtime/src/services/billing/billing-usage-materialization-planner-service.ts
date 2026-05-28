import type {
  BillingMaterializationBasis,
  IBillingMaterializationCheckpoint,
  IBillingUnitPolicy,
} from '@agent-platform/database/models';
import { BillingMaterializationCheckpoint } from '@agent-platform/database/models';
import { BillingPolicyService, type ResolvedBillingPolicy } from './billing-policy-service.js';

type PlannerReason =
  | 'due'
  | 'misconfigured_policy'
  | 'no_ended_sessions'
  | 'waiting_for_window_close'
  | 'insufficient_completed_sessions';

interface BillingPlannerSessionRow {
  _id: string;
  endedAt: Date;
}

interface BillingUsageMaterializationPlannerServiceOptions {
  billingPolicyService?: BillingPolicyService;
  now?: () => Date;
}

export interface PlanNextBillingMaterializationInput {
  tenantId: string;
  projectId?: string;
}

export interface BillingUsageMaterializationCheckpointView {
  basis: BillingMaterializationBasis;
  projectId: string | null;
  lastWindowEnd: string | null;
  lastEndedAt: string | null;
  lastSessionId: string | null;
  lastBatchId: string | null;
  lastMaterializedAt: string | null;
}

export interface BillingUsageMaterializationPlannedScope {
  basis: BillingMaterializationBasis;
  windowStart: string | null;
  windowEnd: string | null;
  endedBefore: string | null;
  completedSessionsCount: number | null;
  periodLabel: string | null;
  cursorStartAfterEndedAt: string | null;
  cursorStartAfterSessionId: string | null;
  cursorEndEndedAt: string | null;
  cursorEndSessionId: string | null;
}

export interface BillingUsageMaterializationPlanView {
  tenantId: string;
  projectId: string | null;
  planTier: string;
  policy: IBillingUnitPolicy;
  basis: BillingMaterializationBasis;
  due: boolean;
  reason: PlannerReason;
  checkpoint: BillingUsageMaterializationCheckpointView | null;
  scope: BillingUsageMaterializationPlannedScope | null;
  stats: {
    candidateSessionCount: number;
    requiredCompletedSessionsCount: number | null;
    remainingCompletedSessionsCount: number | null;
  };
}

function toIsoString(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function buildPeriodLabel(
  start: Date | null,
  end: Date | null,
  count: number | null,
): string | null {
  if (start && end) {
    return `${start.toISOString()}/${end.toISOString()}`;
  }

  if (end && typeof count === 'number') {
    return `latest-${count}-sessions-until-${end.toISOString()}`;
  }

  return null;
}

function alignWindowStart(value: Date, intervalMs: number): Date {
  return new Date(Math.floor(value.getTime() / intervalMs) * intervalMs);
}

function toCheckpointView(
  checkpoint: IBillingMaterializationCheckpoint | null,
): BillingUsageMaterializationCheckpointView | null {
  if (!checkpoint) {
    return null;
  }

  return {
    basis: checkpoint.basis,
    projectId: checkpoint.projectId,
    lastWindowEnd: toIsoString(checkpoint.cursor.lastWindowEnd),
    lastEndedAt: toIsoString(checkpoint.cursor.lastEndedAt),
    lastSessionId: checkpoint.cursor.lastSessionId,
    lastBatchId: checkpoint.lastBatchId,
    lastMaterializedAt: toIsoString(checkpoint.lastMaterializedAt),
  };
}

async function loadCheckpoint(params: {
  tenantId: string;
  projectId: string | null;
  basis: BillingMaterializationBasis;
}): Promise<IBillingMaterializationCheckpoint | null> {
  return BillingMaterializationCheckpoint.findOne({
    tenantId: params.tenantId,
    projectId: params.projectId,
    basis: params.basis,
  })
    .lean()
    .exec();
}

async function loadEarliestEndedSession(params: {
  tenantId: string;
  projectId: string | null;
  endedAtGte?: Date;
  endedAtLt?: Date;
}): Promise<BillingPlannerSessionRow | null> {
  const { Session } = await import('@agent-platform/database/models');
  const where: Record<string, unknown> = {
    tenantId: params.tenantId,
    endedAt: { $ne: null },
  };

  if (params.projectId) {
    where.projectId = params.projectId;
  }

  if (params.endedAtGte || params.endedAtLt) {
    where.endedAt = {
      ...(params.endedAtGte ? { $gte: params.endedAtGte } : {}),
      ...(params.endedAtLt ? { $lt: params.endedAtLt } : {}),
    };
  }

  return (await Session.findOne(where, { _id: 1, endedAt: 1 })
    .sort({ endedAt: 1, _id: 1 })
    .lean()
    .exec()) as BillingPlannerSessionRow | null;
}

async function countSessionsInWindow(params: {
  tenantId: string;
  projectId: string | null;
  windowStart: Date;
  windowEnd: Date;
}): Promise<number> {
  const { Session } = await import('@agent-platform/database/models');
  const where: Record<string, unknown> = {
    tenantId: params.tenantId,
    endedAt: {
      $gte: params.windowStart,
      $lt: params.windowEnd,
    },
  };

  if (params.projectId) {
    where.projectId = params.projectId;
  }

  return Session.countDocuments(where).exec();
}

async function loadCompletedSessionCandidateRows(params: {
  tenantId: string;
  projectId: string | null;
  requiredCount: number;
  checkpoint: IBillingMaterializationCheckpoint | null;
}): Promise<BillingPlannerSessionRow[]> {
  const { Session } = await import('@agent-platform/database/models');
  const where: Record<string, unknown> = {
    tenantId: params.tenantId,
    endedAt: { $ne: null },
  };

  if (params.projectId) {
    where.projectId = params.projectId;
  }

  const lastEndedAt = params.checkpoint?.cursor.lastEndedAt;
  const lastSessionId = params.checkpoint?.cursor.lastSessionId;

  if (lastEndedAt && lastSessionId) {
    where.$or = [
      { endedAt: { $gt: lastEndedAt } },
      {
        endedAt: lastEndedAt,
        _id: { $gt: lastSessionId },
      },
    ];
  } else if (lastEndedAt) {
    where.endedAt = { $gt: lastEndedAt };
  }

  return (await Session.find(where, { _id: 1, endedAt: 1 })
    .sort({ endedAt: 1, _id: 1 })
    .limit(params.requiredCount)
    .lean()
    .exec()) as BillingPlannerSessionRow[];
}

function buildBasePlan(params: {
  resolved: ResolvedBillingPolicy;
  tenantId: string;
  projectId: string | null;
  checkpoint: IBillingMaterializationCheckpoint | null;
}): Omit<BillingUsageMaterializationPlanView, 'due' | 'reason' | 'scope' | 'stats'> {
  return {
    tenantId: params.tenantId,
    projectId: params.projectId,
    planTier: params.resolved.planTier,
    policy: params.resolved.policy,
    basis: params.resolved.policy.materialization.basis,
    checkpoint: toCheckpointView(params.checkpoint),
  };
}

export class BillingUsageMaterializationPlannerService {
  private readonly billingPolicyService: BillingPolicyService;
  private readonly now: () => Date;

  constructor(options: BillingUsageMaterializationPlannerServiceOptions = {}) {
    this.billingPolicyService = options.billingPolicyService ?? new BillingPolicyService();
    this.now = options.now ?? (() => new Date());
  }

  async planNextMaterialization(
    input: PlanNextBillingMaterializationInput,
  ): Promise<BillingUsageMaterializationPlanView | null> {
    const resolved = await this.billingPolicyService.getResolvedPolicy(input.tenantId);
    if (!resolved) {
      return null;
    }

    const projectId = input.projectId ?? null;
    const basis = resolved.policy.materialization.basis;
    const checkpoint = await loadCheckpoint({
      tenantId: input.tenantId,
      projectId,
      basis,
    });
    const basePlan = buildBasePlan({
      resolved,
      tenantId: input.tenantId,
      projectId,
      checkpoint,
    });

    if (basis === 'time_window') {
      return this.planNextTimeWindowMaterialization({
        basePlan,
        tenantId: input.tenantId,
        projectId,
        resolvedPolicy: resolved.policy,
        checkpoint,
      });
    }

    return this.planNextCompletedSessionsMaterialization({
      basePlan,
      tenantId: input.tenantId,
      projectId,
      resolvedPolicy: resolved.policy,
      checkpoint,
    });
  }

  private async planNextTimeWindowMaterialization(params: {
    basePlan: Omit<BillingUsageMaterializationPlanView, 'due' | 'reason' | 'scope' | 'stats'>;
    tenantId: string;
    projectId: string | null;
    resolvedPolicy: IBillingUnitPolicy;
    checkpoint: IBillingMaterializationCheckpoint | null;
  }): Promise<BillingUsageMaterializationPlanView> {
    const configuredMinutes = params.resolvedPolicy.materialization.timeWindowMinutes;
    if (typeof configuredMinutes !== 'number' || configuredMinutes <= 0) {
      return {
        ...params.basePlan,
        due: false,
        reason: 'misconfigured_policy',
        scope: null,
        stats: {
          candidateSessionCount: 0,
          requiredCompletedSessionsCount: null,
          remainingCompletedSessionsCount: null,
        },
      };
    }

    const intervalMs = configuredMinutes * 60 * 1000;
    const now = this.now();
    const closedWindowEnd = new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
    const earliestCandidate = await loadEarliestEndedSession({
      tenantId: params.tenantId,
      projectId: params.projectId,
      endedAtGte: params.checkpoint?.cursor.lastWindowEnd ?? undefined,
      endedAtLt: closedWindowEnd,
    });

    if (!earliestCandidate) {
      return {
        ...params.basePlan,
        due: false,
        reason: 'no_ended_sessions',
        scope: null,
        stats: {
          candidateSessionCount: 0,
          requiredCompletedSessionsCount: null,
          remainingCompletedSessionsCount: null,
        },
      };
    }

    const windowStart = alignWindowStart(earliestCandidate.endedAt, intervalMs);
    const windowEnd = new Date(windowStart.getTime() + intervalMs);

    if (windowEnd.getTime() > closedWindowEnd.getTime()) {
      return {
        ...params.basePlan,
        due: false,
        reason: 'waiting_for_window_close',
        scope: {
          basis: 'time_window',
          windowStart: toIsoString(windowStart),
          windowEnd: toIsoString(windowEnd),
          endedBefore: null,
          completedSessionsCount: null,
          periodLabel: buildPeriodLabel(windowStart, windowEnd, null),
          cursorStartAfterEndedAt: null,
          cursorStartAfterSessionId: null,
          cursorEndEndedAt: null,
          cursorEndSessionId: null,
        },
        stats: {
          candidateSessionCount: 0,
          requiredCompletedSessionsCount: null,
          remainingCompletedSessionsCount: null,
        },
      };
    }

    const candidateSessionCount = await countSessionsInWindow({
      tenantId: params.tenantId,
      projectId: params.projectId,
      windowStart,
      windowEnd,
    });

    return {
      ...params.basePlan,
      due: candidateSessionCount > 0,
      reason: candidateSessionCount > 0 ? 'due' : 'no_ended_sessions',
      scope: {
        basis: 'time_window',
        windowStart: toIsoString(windowStart),
        windowEnd: toIsoString(windowEnd),
        endedBefore: null,
        completedSessionsCount: null,
        periodLabel: buildPeriodLabel(windowStart, windowEnd, null),
        cursorStartAfterEndedAt: null,
        cursorStartAfterSessionId: null,
        cursorEndEndedAt: null,
        cursorEndSessionId: null,
      },
      stats: {
        candidateSessionCount,
        requiredCompletedSessionsCount: null,
        remainingCompletedSessionsCount: null,
      },
    };
  }

  private async planNextCompletedSessionsMaterialization(params: {
    basePlan: Omit<BillingUsageMaterializationPlanView, 'due' | 'reason' | 'scope' | 'stats'>;
    tenantId: string;
    projectId: string | null;
    resolvedPolicy: IBillingUnitPolicy;
    checkpoint: IBillingMaterializationCheckpoint | null;
  }): Promise<BillingUsageMaterializationPlanView> {
    const requiredCount = params.resolvedPolicy.materialization.completedSessionsCount;
    if (typeof requiredCount !== 'number' || requiredCount <= 0) {
      return {
        ...params.basePlan,
        due: false,
        reason: 'misconfigured_policy',
        scope: null,
        stats: {
          candidateSessionCount: 0,
          requiredCompletedSessionsCount: null,
          remainingCompletedSessionsCount: null,
        },
      };
    }

    const candidateSessions = await loadCompletedSessionCandidateRows({
      tenantId: params.tenantId,
      projectId: params.projectId,
      requiredCount,
      checkpoint: params.checkpoint,
    });

    if (candidateSessions.length === 0) {
      return {
        ...params.basePlan,
        due: false,
        reason: 'no_ended_sessions',
        scope: null,
        stats: {
          candidateSessionCount: 0,
          requiredCompletedSessionsCount: requiredCount,
          remainingCompletedSessionsCount: requiredCount,
        },
      };
    }

    const lastSession = candidateSessions[candidateSessions.length - 1];
    const due = candidateSessions.length >= requiredCount;
    const remainingCompletedSessionsCount = due ? 0 : requiredCount - candidateSessions.length;

    return {
      ...params.basePlan,
      due,
      reason: due ? 'due' : 'insufficient_completed_sessions',
      scope: {
        basis: 'completed_sessions',
        windowStart: null,
        windowEnd: null,
        endedBefore: toIsoString(lastSession.endedAt),
        completedSessionsCount: requiredCount,
        periodLabel: buildPeriodLabel(null, lastSession.endedAt, requiredCount),
        cursorStartAfterEndedAt: toIsoString(params.checkpoint?.cursor.lastEndedAt),
        cursorStartAfterSessionId: params.checkpoint?.cursor.lastSessionId ?? null,
        cursorEndEndedAt: toIsoString(lastSession.endedAt),
        cursorEndSessionId: lastSession._id,
      },
      stats: {
        candidateSessionCount: candidateSessions.length,
        requiredCompletedSessionsCount: requiredCount,
        remainingCompletedSessionsCount,
      },
    };
  }
}
