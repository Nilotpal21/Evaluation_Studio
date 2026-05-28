import { randomUUID } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import {
  BillingMaterializationBatch,
  BillingMaterializationSessionResult,
  Subscription,
  type BillingMaterializationBasis,
  type IBillingMaterializationBatch,
  type IBillingMaterializationSessionResult,
  type IBillingMaterializationScope,
  type IBillingMaterializationSummary,
  type IBillingUnitPolicy,
} from '@agent-platform/database/models';
import { getRuntimeEventBus } from '../event-bus/runtime-bus-accessor.js';
import type { EventBus } from '../event-bus/types.js';
import {
  BillingUsagePreviewService,
  type BillingPreviewScope,
  type BillingPreviewSession,
  type BillingPreviewSummary,
  type BillingUsagePreviewRequest,
} from './billing-usage-preview-service.js';

const log = createLogger('billing-usage-materialization-service');

const DEFAULT_BATCH_LIST_LIMIT = 20;
const MAX_BATCH_LIST_LIMIT = 100;
const DEFAULT_RESULT_LIST_LIMIT = 50;
const MAX_RESULT_LIST_LIMIT = 200;
const BILLING_EVENT_AGENT_NAME = 'billing-materializer';
const BILLING_EVENT_CHANNEL = 'billing';
const BILLING_TENANT_SCOPE_PROJECT_ID = '__tenant_billing__';

interface BillingUsageMaterializationServiceOptions {
  previewService?: BillingUsagePreviewService;
  eventBus?: EventBus | null;
  getEventBus?: () => EventBus | null;
  now?: () => Date;
  eventIdFactory?: () => string;
}

export interface CreateBillingUsageMaterializationInput extends BillingUsagePreviewRequest {
  triggeredBy: string;
  triggerSource?: 'manual' | 'scheduled';
}

export interface BillingUsageMaterializationBatchView {
  batchId: string;
  tenantId: string;
  projectId: string | null;
  subscriptionId: string;
  status: 'running' | 'completed' | 'failed';
  triggerSource: 'manual' | 'scheduled';
  triggeredBy: string;
  request: {
    projectId: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    endedBefore: string | null;
  };
  planTier: string;
  policy: IBillingUnitPolicy;
  scope: BillingPreviewScope;
  summary: BillingPreviewSummary | null;
  warnings: string[];
  resultCount: number;
  eventId: string | null;
  eventDispatchAttempted: boolean;
  failureReason: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillingUsageMaterializationBatchListResult {
  batches: BillingUsageMaterializationBatchView[];
}

export interface ListBillingUsageMaterializationBatchesInput {
  tenantId: string;
  projectId?: string;
  limit?: number;
}

export interface GetBillingUsageMaterializationBatchInput {
  tenantId: string;
  batchId: string;
}

export interface BillingUsageMaterializationSessionView {
  sessionId: string;
  projectId: string;
  subscriptionId: string;
  batchId: string;
  sequence: number;
  triggerSource: 'manual' | 'scheduled';
  materializationBasis: BillingMaterializationBasis;
  channel: string;
  status: string;
  disposition: string | null;
  sessionType: string | null;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  interactiveTurnCount: number;
  engagedSeconds: number;
  llmCallCount: number;
  toolCallCount: number;
  metricsSource: 'clickhouse' | 'message_fallback';
  included: boolean;
  exclusionReasons: string[];
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  createdAt: string;
  updatedAt: string;
}

export interface BillingUsageMaterializationResultPage {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface GetBillingUsageMaterializationResultsInput {
  tenantId: string;
  batchId: string;
  page?: number;
  limit?: number;
}

export interface BillingUsageMaterializationResultsView {
  batchId: string;
  page: BillingUsageMaterializationResultPage;
  sessions: BillingUsageMaterializationSessionView[];
}

interface BillingUsageMaterializationEventResult {
  eventId: string | null;
  eventDispatchAttempted: boolean;
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

function toMaterializationScope(value: BillingPreviewScope): IBillingMaterializationScope {
  return {
    basis: value.basis,
    windowStart: value.windowStart ? new Date(value.windowStart) : null,
    windowEnd: value.windowEnd ? new Date(value.windowEnd) : null,
    endedBefore: value.endedBefore ? new Date(value.endedBefore) : null,
    completedSessionsCount: value.completedSessionsCount,
    periodLabel: value.periodLabel,
  };
}

function toPreviewScope(value: IBillingMaterializationScope): BillingPreviewScope {
  return {
    basis: value.basis as BillingMaterializationBasis,
    windowStart: toIsoString(value.windowStart),
    windowEnd: toIsoString(value.windowEnd),
    endedBefore: toIsoString(value.endedBefore),
    completedSessionsCount: value.completedSessionsCount,
    periodLabel: value.periodLabel,
  };
}

function toMaterializationSummary(
  value: BillingPreviewSummary | null,
): IBillingMaterializationSummary | null {
  if (!value) {
    return null;
  }

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

function toBatchView(value: IBillingMaterializationBatch): BillingUsageMaterializationBatchView {
  return {
    batchId: value._id,
    tenantId: value.tenantId,
    projectId: value.projectId,
    subscriptionId: value.subscriptionId,
    status: value.status,
    triggerSource: value.triggerSource,
    triggeredBy: value.triggeredBy,
    request: {
      projectId: value.request.projectId ?? null,
      windowStart: toIsoString(value.request.windowStart),
      windowEnd: toIsoString(value.request.windowEnd),
      endedBefore: toIsoString(value.request.endedBefore),
    },
    planTier: value.planTier,
    policy: value.policySnapshot,
    scope: toPreviewScope(value.scope),
    summary: value.summary,
    warnings: [...value.warnings],
    resultCount: value.resultCount,
    eventId: value.eventId,
    eventDispatchAttempted: value.eventDispatchAttempted,
    failureReason: value.failureReason,
    startedAt: value.startedAt.toISOString(),
    completedAt: toIsoString(value.completedAt),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

function toSessionView(
  value: IBillingMaterializationSessionResult,
): BillingUsageMaterializationSessionView {
  return {
    sessionId: value.sessionId,
    projectId: value.projectId,
    subscriptionId: value.subscriptionId,
    batchId: value.batchId,
    sequence: value.sequence,
    triggerSource: value.triggerSource,
    materializationBasis: value.materializationBasis,
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
    exclusionReasons: [...value.exclusionReasons],
    baseUnits: value.baseUnits,
    llmAddonUnits: value.llmAddonUnits,
    toolAddonUnits: value.toolAddonUnits,
    totalUnits: value.totalUnits,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

export class BillingUsageMaterializationService {
  private readonly previewService: BillingUsagePreviewService;
  private readonly getEventBus: () => EventBus | null;
  private readonly now: () => Date;
  private readonly eventIdFactory: () => string;

  constructor(options: BillingUsageMaterializationServiceOptions = {}) {
    this.previewService = options.previewService ?? new BillingUsagePreviewService();
    this.getEventBus = options.getEventBus ?? (() => options.eventBus ?? getRuntimeEventBus());
    this.now = options.now ?? (() => new Date());
    this.eventIdFactory = options.eventIdFactory ?? (() => randomUUID());
  }

  async createMaterialization(
    input: CreateBillingUsageMaterializationInput,
  ): Promise<BillingUsageMaterializationBatchView | null> {
    const startedAt = this.now();
    const triggerSource = input.triggerSource ?? 'manual';
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

    const subscription = (await Subscription.findOne(
      {
        tenantId: input.tenantId,
        status: 'active',
      },
      { _id: 1 },
    )
      .lean()
      .exec()) as { _id: string } | null;

    if (!subscription?._id) {
      log.warn('Skipping billing materialization — active subscription not found after preview', {
        tenantId: input.tenantId,
        projectId: preview.projectId,
      });
      return null;
    }

    const batch = await BillingMaterializationBatch.create({
      tenantId: input.tenantId,
      projectId: preview.projectId,
      subscriptionId: subscription._id,
      status: 'running',
      triggerSource,
      triggeredBy: input.triggeredBy,
      request: {
        projectId: input.projectId ?? null,
        windowStart: input.windowStart ?? null,
        windowEnd: input.windowEnd ?? null,
        endedBefore: input.endedBefore ?? null,
      },
      planTier: preview.planTier,
      policySnapshot: preview.policy,
      scope: toMaterializationScope(preview.scope),
      summary: null,
      warnings: preview.warnings,
      resultCount: preview.summary.examinedSessionCount,
      eventId: null,
      eventDispatchAttempted: false,
      failureReason: null,
      startedAt,
      completedAt: null,
    });

    try {
      await this.persistMaterializationResults({
        tenantId: input.tenantId,
        subscriptionId: subscription._id,
        batchId: batch._id,
        triggerSource,
        basis: preview.scope.basis,
        sessions: preview.sessions,
      });

      const eventResult = this.dispatchMaterializationEvent({
        batchId: batch._id,
        tenantId: input.tenantId,
        projectId: preview.projectId,
        triggerSource,
        scope: preview.scope,
        summary: preview.summary,
      });

      batch.status = 'completed';
      batch.summary = toMaterializationSummary(preview.summary);
      batch.warnings = preview.warnings;
      batch.resultCount = preview.summary.examinedSessionCount;
      batch.eventId = eventResult.eventId;
      batch.eventDispatchAttempted = eventResult.eventDispatchAttempted;
      batch.completedAt = this.now();
      await batch.save();
    } catch (error) {
      batch.status = 'failed';
      batch.failureReason = error instanceof Error ? error.message : String(error);
      batch.completedAt = this.now();
      await batch.save();

      log.error('Failed to materialize billing usage batch', {
        tenantId: input.tenantId,
        projectId: preview.projectId,
        batchId: batch._id,
        error: batch.failureReason,
      });

      throw error;
    }

    return this.getMaterialization({
      tenantId: input.tenantId,
      batchId: batch._id,
    });
  }

  async listMaterializations(
    input: ListBillingUsageMaterializationBatchesInput,
  ): Promise<BillingUsageMaterializationBatchListResult> {
    const limit = clampLimit(input.limit, DEFAULT_BATCH_LIST_LIMIT, MAX_BATCH_LIST_LIMIT);
    const where: Record<string, unknown> = {
      tenantId: input.tenantId,
    };

    if (input.projectId) {
      where.projectId = input.projectId;
    }

    const batches = (await BillingMaterializationBatch.find(where)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec()) as IBillingMaterializationBatch[];

    return {
      batches: batches.map(toBatchView),
    };
  }

  async getMaterialization(
    input: GetBillingUsageMaterializationBatchInput,
  ): Promise<BillingUsageMaterializationBatchView | null> {
    const batch = (await BillingMaterializationBatch.findOne({
      _id: input.batchId,
      tenantId: input.tenantId,
    })
      .lean()
      .exec()) as IBillingMaterializationBatch | null;

    if (!batch) {
      return null;
    }

    return toBatchView(batch);
  }

  async getMaterializationResults(
    input: GetBillingUsageMaterializationResultsInput,
  ): Promise<BillingUsageMaterializationResultsView | null> {
    const page = clampLimit(input.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = clampLimit(input.limit, DEFAULT_RESULT_LIST_LIMIT, MAX_RESULT_LIST_LIMIT);

    const batch = await this.getMaterialization({
      tenantId: input.tenantId,
      batchId: input.batchId,
    });
    if (!batch) {
      return null;
    }

    const skip = (page - 1) * limit;
    const [sessions, total] = await Promise.all([
      BillingMaterializationSessionResult.find({
        tenantId: input.tenantId,
        batchId: input.batchId,
      })
        .sort({ sequence: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec() as Promise<IBillingMaterializationSessionResult[]>,
      BillingMaterializationSessionResult.countDocuments({
        tenantId: input.tenantId,
        batchId: input.batchId,
      }).exec(),
    ]);

    return {
      batchId: input.batchId,
      page: {
        page,
        limit,
        total,
        hasMore: skip + sessions.length < total,
      },
      sessions: sessions.map(toSessionView),
    };
  }

  private dispatchMaterializationEvent(params: {
    batchId: string;
    tenantId: string;
    projectId: string | null;
    triggerSource: 'manual' | 'scheduled';
    scope: BillingPreviewScope;
    summary: BillingPreviewSummary;
  }): BillingUsageMaterializationEventResult {
    const eventBus = this.getEventBus();
    if (!eventBus) {
      log.warn('Billing materialization completed without an event bus', {
        tenantId: params.tenantId,
        projectId: params.projectId,
        batchId: params.batchId,
      });
      return {
        eventId: null,
        eventDispatchAttempted: false,
      };
    }

    const eventId = this.eventIdFactory();
    eventBus.emit({
      eventId,
      type: 'billing.usage.updated',
      tenantId: params.tenantId,
      projectId: params.projectId ?? BILLING_TENANT_SCOPE_PROJECT_ID,
      sessionId: params.batchId,
      agentName: BILLING_EVENT_AGENT_NAME,
      channel: BILLING_EVENT_CHANNEL,
      timestamp: this.now().toISOString(),
      payload: {
        batchId: params.batchId,
        triggerSource: params.triggerSource,
        projectId: params.projectId ?? undefined,
        projectScope: params.projectId ? 'project' : 'tenant',
        materializationBasis: params.scope.basis,
        periodLabel: params.scope.periodLabel ?? undefined,
        windowStart: params.scope.windowStart ?? undefined,
        windowEnd: params.scope.windowEnd ?? undefined,
        completedSessionCount: params.scope.completedSessionsCount ?? undefined,
        examinedSessionCount: params.summary.examinedSessionCount,
        includedSessionCount: params.summary.includedSessionCount,
        excludedSessionCount: params.summary.excludedSessionCount,
        baseUnits: params.summary.baseUnits,
        llmAddonUnits: params.summary.llmAddonUnits,
        toolAddonUnits: params.summary.toolAddonUnits,
        totalUnits: params.summary.totalUnits,
        projectBreakdown: params.summary.projectBreakdown,
        channelBreakdown: params.summary.channelBreakdown,
      },
    });

    return {
      eventId,
      eventDispatchAttempted: true,
    };
  }

  private async persistMaterializationResults(params: {
    tenantId: string;
    subscriptionId: string;
    batchId: string;
    triggerSource: 'manual' | 'scheduled';
    basis: BillingMaterializationBasis;
    sessions: BillingPreviewSession[];
  }): Promise<void> {
    if (params.sessions.length === 0) {
      return;
    }

    await BillingMaterializationSessionResult.insertMany(
      params.sessions.map((session, index) => ({
        tenantId: params.tenantId,
        subscriptionId: params.subscriptionId,
        projectId: session.projectId,
        batchId: params.batchId,
        sequence: index,
        sessionId: session.sessionId,
        triggerSource: params.triggerSource,
        materializationBasis: params.basis,
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
        exclusionReasons: [...session.exclusionReasons],
        baseUnits: session.baseUnits,
        llmAddonUnits: session.llmAddonUnits,
        toolAddonUnits: session.toolAddonUnits,
        totalUnits: session.totalUnits,
      })),
      { ordered: true },
    );
  }
}
