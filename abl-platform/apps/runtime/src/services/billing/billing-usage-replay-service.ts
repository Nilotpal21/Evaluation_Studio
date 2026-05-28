import { createLogger } from '@abl/compiler/platform';
import {
  BillingReplayRun,
  BillingReplaySessionResult,
  type BillingMaterializationBasis,
  type IBillingReplayRun,
  type IBillingReplaySessionResult,
  type IBillingUnitPolicy,
} from '@agent-platform/database/models';
import {
  type BillingPreviewExclusionReason,
  BillingUsagePreviewService,
  type BillingPreviewScope,
  type BillingPreviewSession,
  type BillingPreviewSummary,
  type BillingUsagePreviewRequest,
} from './billing-usage-preview-service.js';

const log = createLogger('billing-usage-replay-service');

const DEFAULT_RUN_LIST_LIMIT = 20;
const MAX_RUN_LIST_LIMIT = 100;
const DEFAULT_RUN_RESULT_LIMIT = 50;
const MAX_RUN_RESULT_LIMIT = 200;

interface BillingUsageReplayServiceOptions {
  previewService?: BillingUsagePreviewService;
  now?: () => Date;
}

export interface CreateBillingUsageReplayInput extends BillingUsagePreviewRequest {
  triggeredBy: string;
}

export interface BillingUsageReplayRunView {
  runId: string;
  tenantId: string;
  projectId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  mode: 'compare_only';
  triggerSource: 'manual';
  triggeredBy: string;
  planTier: string;
  request: {
    projectId: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    endedBefore: string | null;
  };
  policy: IBillingUnitPolicy;
  scope: BillingPreviewScope;
  summary: BillingPreviewSummary | null;
  warnings: string[];
  resultCount: number;
  failureReason: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillingUsageReplayRunListResult {
  runs: BillingUsageReplayRunView[];
}

export interface BillingUsageReplayRunDetail extends BillingUsageReplayRunView {
  page: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
  sessions: BillingPreviewSession[];
}

export interface ListBillingUsageReplayRunsInput {
  tenantId: string;
  projectId?: string;
  limit?: number;
}

export interface GetBillingUsageReplayRunInput {
  tenantId: string;
  runId: string;
  page?: number;
  limit?: number;
}

function toIsoString(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

function clampPage(page: number | undefined): number {
  if (typeof page !== 'number' || !Number.isFinite(page)) {
    return 1;
  }

  return Math.max(Math.trunc(page), 1);
}

function toReplayScope(value: BillingPreviewScope): IBillingReplayRun['scope'] {
  return {
    basis: value.basis,
    windowStart: value.windowStart ? new Date(value.windowStart) : null,
    windowEnd: value.windowEnd ? new Date(value.windowEnd) : null,
    endedBefore: value.endedBefore ? new Date(value.endedBefore) : null,
    completedSessionsCount: value.completedSessionsCount,
    periodLabel: value.periodLabel,
  };
}

function toPreviewScope(value: IBillingReplayRun['scope']): BillingPreviewScope {
  return {
    basis: value.basis as BillingMaterializationBasis,
    windowStart: toIsoString(value.windowStart),
    windowEnd: toIsoString(value.windowEnd),
    endedBefore: toIsoString(value.endedBefore),
    completedSessionsCount: value.completedSessionsCount,
    periodLabel: value.periodLabel,
  };
}

function toPreviewSession(value: IBillingReplaySessionResult): BillingPreviewSession {
  return {
    sessionId: value.sessionId,
    projectId: value.projectId,
    channel: value.channel,
    status: value.status,
    disposition: value.disposition,
    sessionType: value.sessionType,
    startedAt: value.startedAt.toISOString(),
    endedAt: value.endedAt.toISOString(),
    durationSeconds: value.durationSeconds,
    userMessageCount: value.userMessageCount,
    assistantMessageCount: value.assistantMessageCount,
    toolMessageCount: value.toolMessageCount,
    interactiveTurnCount: value.interactiveTurnCount,
    engagedSeconds: value.engagedSeconds,
    llmCallCount: value.llmCallCount,
    toolCallCount: value.toolCallCount,
    metricsSource: value.metricsSource,
    included: value.included,
    exclusionReasons: [...value.exclusionReasons] as BillingPreviewExclusionReason[],
    baseUnits: value.baseUnits,
    llmAddonUnits: value.llmAddonUnits,
    toolAddonUnits: value.toolAddonUnits,
    totalUnits: value.totalUnits,
  };
}

function toReplayRunView(value: IBillingReplayRun): BillingUsageReplayRunView {
  return {
    runId: value._id,
    tenantId: value.tenantId,
    projectId: value.projectId,
    status: value.status,
    mode: value.mode,
    triggerSource: value.triggerSource,
    triggeredBy: value.triggeredBy,
    planTier: value.planTier,
    request: {
      projectId: value.request.projectId ?? null,
      windowStart: toIsoString(value.request.windowStart),
      windowEnd: toIsoString(value.request.windowEnd),
      endedBefore: toIsoString(value.request.endedBefore),
    },
    policy: value.policySnapshot,
    scope: toPreviewScope(value.scope),
    summary: value.summary,
    warnings: [...value.warnings],
    resultCount: value.resultCount,
    failureReason: value.failureReason,
    startedAt: value.startedAt.toISOString(),
    completedAt: toIsoString(value.completedAt),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

export class BillingUsageReplayService {
  private readonly previewService: BillingUsagePreviewService;
  private readonly now: () => Date;

  constructor(options: BillingUsageReplayServiceOptions = {}) {
    this.previewService = options.previewService ?? new BillingUsagePreviewService();
    this.now = options.now ?? (() => new Date());
  }

  async createReplayRun(
    input: CreateBillingUsageReplayInput,
  ): Promise<BillingUsageReplayRunDetail | null> {
    const startedAt = this.now();
    const preview = await this.previewService.previewTenantUsage({
      tenantId: input.tenantId,
      projectId: input.projectId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      endedBefore: input.endedBefore,
    });

    if (!preview) {
      return null;
    }

    const run = await BillingReplayRun.create({
      tenantId: input.tenantId,
      projectId: preview.projectId,
      status: 'running',
      mode: 'compare_only',
      triggerSource: 'manual',
      triggeredBy: input.triggeredBy,
      request: {
        projectId: input.projectId ?? null,
        windowStart: input.windowStart ?? null,
        windowEnd: input.windowEnd ?? null,
        endedBefore: input.endedBefore ?? null,
      },
      planTier: preview.planTier,
      policySnapshot: preview.policy,
      scope: toReplayScope(preview.scope),
      summary: null,
      warnings: preview.warnings,
      resultCount: preview.sessions.length,
      failureReason: null,
      startedAt,
      completedAt: null,
    });

    try {
      if (preview.sessions.length > 0) {
        await BillingReplaySessionResult.insertMany(
          preview.sessions.map((session, index) => ({
            tenantId: input.tenantId,
            projectId: session.projectId,
            runId: run._id,
            sessionId: session.sessionId,
            sequence: index,
            channel: session.channel,
            status: session.status,
            disposition: session.disposition,
            sessionType: session.sessionType,
            startedAt: new Date(session.startedAt),
            endedAt: new Date(session.endedAt),
            durationSeconds: session.durationSeconds,
            userMessageCount: session.userMessageCount,
            assistantMessageCount: session.assistantMessageCount,
            toolMessageCount: session.toolMessageCount,
            interactiveTurnCount: session.interactiveTurnCount,
            engagedSeconds: session.engagedSeconds,
            llmCallCount: session.llmCallCount,
            toolCallCount: session.toolCallCount,
            metricsSource: session.metricsSource,
            included: session.included,
            exclusionReasons: session.exclusionReasons,
            baseUnits: session.baseUnits,
            llmAddonUnits: session.llmAddonUnits,
            toolAddonUnits: session.toolAddonUnits,
            totalUnits: session.totalUnits,
          })),
          { ordered: true },
        );
      }

      run.status = 'completed';
      run.summary = preview.summary;
      run.warnings = preview.warnings;
      run.resultCount = preview.sessions.length;
      run.completedAt = this.now();
      await run.save();
    } catch (error) {
      await BillingReplaySessionResult.deleteMany({
        tenantId: input.tenantId,
        runId: run._id,
      }).exec();

      run.status = 'failed';
      run.failureReason = error instanceof Error ? error.message : String(error);
      run.completedAt = this.now();
      await run.save();

      log.error('Failed to persist billing replay run', {
        tenantId: input.tenantId,
        projectId: preview.projectId,
        runId: run._id,
        error: run.failureReason,
      });

      throw error;
    }

    return this.getReplayRun({
      tenantId: input.tenantId,
      runId: run._id,
      page: 1,
      limit: DEFAULT_RUN_RESULT_LIMIT,
    });
  }

  async listReplayRuns(
    input: ListBillingUsageReplayRunsInput,
  ): Promise<BillingUsageReplayRunListResult> {
    const limit = clampLimit(input.limit, DEFAULT_RUN_LIST_LIMIT, MAX_RUN_LIST_LIMIT);
    const where: Record<string, unknown> = {
      tenantId: input.tenantId,
    };

    if (input.projectId) {
      where.projectId = input.projectId;
    }

    const runs = (await BillingReplayRun.find(where)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec()) as IBillingReplayRun[];

    return {
      runs: runs.map(toReplayRunView),
    };
  }

  async getReplayRun(
    input: GetBillingUsageReplayRunInput,
  ): Promise<BillingUsageReplayRunDetail | null> {
    const page = clampPage(input.page);
    const limit = clampLimit(input.limit, DEFAULT_RUN_RESULT_LIMIT, MAX_RUN_RESULT_LIMIT);

    const run = (await BillingReplayRun.findOne({
      _id: input.runId,
      tenantId: input.tenantId,
    })
      .lean()
      .exec()) as IBillingReplayRun | null;

    if (!run) {
      return null;
    }

    const total = run.resultCount;
    const skip = (page - 1) * limit;
    const sessionResults = (await BillingReplaySessionResult.find({
      tenantId: input.tenantId,
      runId: input.runId,
    })
      .sort({ sequence: 1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec()) as IBillingReplaySessionResult[];

    return {
      ...toReplayRunView(run),
      page: {
        page,
        limit,
        total,
        hasMore: skip + sessionResults.length < total,
      },
      sessions: sessionResults.map(toPreviewSession),
    };
  }
}
