import { createLogger } from '@abl/compiler/platform';
import type {
  BillingMaterializationBasis,
  IBillingUnitPolicy,
} from '@agent-platform/database/models';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';
import { BillingPolicyService, DEFAULT_BILLING_UNIT_POLICY } from './billing-policy-service.js';
import {
  BillingUsageDerivationService,
  type BillingDerivationSessionSnapshot,
} from './billing-usage-derivation-service.js';

const log = createLogger('billing-usage-preview-service');

const INTERACTIVE_MESSAGE_ROLES = ['user', 'assistant', 'tool'] as const;

export type BillingPreviewMetricsSource = 'clickhouse' | 'message_fallback';
export type BillingPreviewExclusionReason = string;

export interface BillingUsagePreviewRequest {
  tenantId: string;
  projectId?: string;
  windowStart?: Date;
  windowEnd?: Date;
  endedBefore?: Date;
}

export interface BillingPreviewScope {
  basis: BillingMaterializationBasis;
  windowStart: string | null;
  windowEnd: string | null;
  endedBefore: string | null;
  completedSessionsCount: number | null;
  periodLabel: string | null;
}

export interface BillingPreviewSession {
  sessionId: string;
  projectId: string;
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
  metricsSource: BillingPreviewMetricsSource;
  included: boolean;
  exclusionReasons: BillingPreviewExclusionReason[];
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface BillingPreviewProjectBreakdown {
  projectId: string;
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface BillingPreviewChannelBreakdown {
  channel: string;
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface BillingPreviewSummary {
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  exclusionCounts: Record<string, number>;
  metricsSourceCounts: Record<BillingPreviewMetricsSource, number>;
  projectBreakdown: BillingPreviewProjectBreakdown[];
  channelBreakdown: BillingPreviewChannelBreakdown[];
}

export interface BillingUsagePreviewResult {
  tenantId: string;
  projectId: string | null;
  planTier: string;
  policy: IBillingUnitPolicy;
  scope: BillingPreviewScope;
  summary: BillingPreviewSummary;
  sessions: BillingPreviewSession[];
  warnings: string[];
}

interface BillingUsageMetricsRequest {
  tenantId: string;
  projectId?: string;
  sessionIds: string[];
}

interface BillingUsageMetrics {
  llmCallCount: number;
  toolCallCount: number;
}

interface BillingUsageMetricsResult {
  source: 'clickhouse' | 'unavailable';
  usageBySessionId: Map<string, BillingUsageMetrics>;
  warnings: string[];
}

interface BillingUsageMetricsReader {
  getSessionAddonUsage(params: BillingUsageMetricsRequest): Promise<BillingUsageMetricsResult>;
}

interface BillingUsagePreviewServiceOptions {
  billingPolicyService?: BillingPolicyService;
  metricsReader?: BillingUsageMetricsReader;
  derivationService?: BillingUsageDerivationService;
  now?: () => Date;
}

interface StoredSessionRow {
  _id: string;
  tenantId: string;
  projectId: string;
  channel: string;
  status: string;
  disposition: string | null;
  startedAt: Date;
  endedAt: Date;
  isTest: boolean;
  context: unknown;
  metadata: unknown;
}

interface MessageStatsRow {
  _id: string;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  firstInteractiveAt: Date | null;
  lastInteractiveAt: Date | null;
}

interface SessionMessageStats {
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  firstInteractiveAt: Date | null;
  lastInteractiveAt: Date | null;
}

interface ResolvedTimeWindowScope {
  basis: 'time_window';
  windowStart: Date;
  windowEnd: Date;
  completedSessionsCount: null;
  periodLabel: string;
  warnings: string[];
}

interface ResolvedCompletedSessionsScope {
  basis: 'completed_sessions';
  windowStart: null;
  windowEnd: null;
  endedBefore: Date;
  completedSessionsCount: number;
  periodLabel: string;
  warnings: string[];
}

type ResolvedBillingScope = ResolvedTimeWindowScope | ResolvedCompletedSessionsScope;

interface BillingBreakdownAccumulator {
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
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

function computeEngagedSeconds(stats: SessionMessageStats): number {
  if (!(stats.firstInteractiveAt instanceof Date) || !(stats.lastInteractiveAt instanceof Date)) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor((stats.lastInteractiveAt.getTime() - stats.firstInteractiveAt.getTime()) / 1000),
  );
}

function createBreakdownAccumulator(): BillingBreakdownAccumulator {
  return {
    examinedSessionCount: 0,
    includedSessionCount: 0,
    excludedSessionCount: 0,
    baseUnits: 0,
    llmAddonUnits: 0,
    toolAddonUnits: 0,
    totalUnits: 0,
  };
}

function getOrCreateBreakdownAccumulator(
  map: Map<string, BillingBreakdownAccumulator>,
  key: string,
): BillingBreakdownAccumulator {
  let accumulator = map.get(key);
  if (!accumulator) {
    accumulator = createBreakdownAccumulator();
    map.set(key, accumulator);
  }

  return accumulator;
}

function updateBreakdownAccumulator(params: {
  accumulator: BillingBreakdownAccumulator;
  included: boolean;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}): void {
  params.accumulator.examinedSessionCount += 1;

  if (params.included) {
    params.accumulator.includedSessionCount += 1;
    params.accumulator.baseUnits += params.baseUnits;
    params.accumulator.llmAddonUnits += params.llmAddonUnits;
    params.accumulator.toolAddonUnits += params.toolAddonUnits;
    params.accumulator.totalUnits += params.totalUnits;
    return;
  }

  params.accumulator.excludedSessionCount += 1;
}

function toProjectBreakdown(
  map: Map<string, BillingBreakdownAccumulator>,
): BillingPreviewProjectBreakdown[] {
  return [...map.entries()]
    .sort(([leftProjectId], [rightProjectId]) => leftProjectId.localeCompare(rightProjectId))
    .map(([projectId, accumulator]) => ({
      projectId,
      ...accumulator,
    }));
}

function toChannelBreakdown(
  map: Map<string, BillingBreakdownAccumulator>,
): BillingPreviewChannelBreakdown[] {
  return [...map.entries()]
    .sort(([leftChannel], [rightChannel]) => leftChannel.localeCompare(rightChannel))
    .map(([channel, accumulator]) => ({
      channel,
      ...accumulator,
    }));
}

class ClickHouseBillingUsageMetricsReader implements BillingUsageMetricsReader {
  private readonly clientFactory: () => ClickHouseClient;

  constructor(clientFactory: () => ClickHouseClient = () => getClickHouseClient()) {
    this.clientFactory = clientFactory;
  }

  async getSessionAddonUsage(
    params: BillingUsageMetricsRequest,
  ): Promise<BillingUsageMetricsResult> {
    if (params.sessionIds.length === 0) {
      return {
        source: 'clickhouse',
        usageBySessionId: new Map(),
        warnings: [],
      };
    }

    try {
      const client = this.clientFactory();
      const conditions = [
        'tenant_id = {tenantId:String}',
        'session_id IN ({sessionIds:Array(String)})',
      ];
      const queryParams: Record<string, string | string[]> = {
        tenantId: params.tenantId,
        sessionIds: params.sessionIds,
      };

      if (params.projectId) {
        conditions.push('project_id = {projectId:String}');
        queryParams.projectId = params.projectId;
      }

      const result = await client.query({
        query: `
          SELECT
            session_id AS sessionId,
            count() AS llmCallCount,
            sum(tool_call_count) AS toolCallCount
          FROM abl_platform.llm_metrics
          WHERE ${conditions.join(' AND ')}
          GROUP BY session_id
          SETTINGS max_execution_time = 15
        `,
        query_params: queryParams,
        format: 'JSONEachRow',
      });

      const rows = await result.json<{
        sessionId: string;
        llmCallCount: string;
        toolCallCount: string;
      }>();

      const usageBySessionId = new Map<string, BillingUsageMetrics>();
      for (const row of rows) {
        usageBySessionId.set(row.sessionId, {
          llmCallCount: parseInt(row.llmCallCount || '0', 10),
          toolCallCount: parseInt(row.toolCallCount || '0', 10),
        });
      }

      return {
        source: 'clickhouse',
        usageBySessionId,
        warnings: [],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('ClickHouse billing usage preview query failed; using message fallback', {
        tenantId: params.tenantId,
        projectId: params.projectId,
        error: message,
      });

      return {
        source: 'unavailable',
        usageBySessionId: new Map(),
        warnings: [
          'ClickHouse usage telemetry unavailable; addon counts fell back to message history.',
        ],
      };
    }
  }
}

function resolveScope(
  policy: IBillingUnitPolicy,
  request: BillingUsagePreviewRequest,
  now: Date,
): ResolvedBillingScope | null {
  const warnings: string[] = [];

  if (policy.materialization.basis === 'time_window') {
    const configuredMinutes = policy.materialization.timeWindowMinutes;
    const windowEnd = request.windowEnd ?? now;
    let windowStart = request.windowStart;

    if (!windowStart) {
      if (typeof configuredMinutes === 'number' && configuredMinutes > 0) {
        windowStart = new Date(windowEnd.getTime() - configuredMinutes * 60 * 1000);
      } else {
        warnings.push(
          'Time-window materialization requires a configured timeWindowMinutes or explicit windowStart.',
        );
        return null;
      }
    }

    if (windowStart.getTime() > windowEnd.getTime()) {
      warnings.push('windowStart must be earlier than or equal to windowEnd.');
      return null;
    }

    return {
      basis: 'time_window',
      windowStart,
      windowEnd,
      completedSessionsCount: null,
      periodLabel: buildPeriodLabel(windowStart, windowEnd, null) ?? 'time_window',
      warnings,
    };
  }

  const completedSessionsCount = policy.materialization.completedSessionsCount;
  if (typeof completedSessionsCount !== 'number' || completedSessionsCount <= 0) {
    warnings.push(
      'Completed-session materialization requires a configured completedSessionsCount before preview is available.',
    );
    return null;
  }

  const endedBefore = request.endedBefore ?? request.windowEnd ?? now;
  return {
    basis: 'completed_sessions',
    windowStart: null,
    windowEnd: null,
    endedBefore,
    completedSessionsCount,
    periodLabel:
      buildPeriodLabel(null, endedBefore, completedSessionsCount) ?? 'completed_sessions',
    warnings,
  };
}

export class BillingUsagePreviewService {
  private readonly billingPolicyService: BillingPolicyService;
  private readonly metricsReader: BillingUsageMetricsReader;
  private readonly derivationService: BillingUsageDerivationService;
  private readonly now: () => Date;

  constructor(options: BillingUsagePreviewServiceOptions = {}) {
    this.billingPolicyService = options.billingPolicyService ?? new BillingPolicyService();
    this.metricsReader = options.metricsReader ?? new ClickHouseBillingUsageMetricsReader();
    this.derivationService = options.derivationService ?? new BillingUsageDerivationService();
    this.now = options.now ?? (() => new Date());
  }

  async previewTenantUsage(
    request: BillingUsagePreviewRequest,
  ): Promise<BillingUsagePreviewResult | null> {
    const resolved = await this.billingPolicyService.getResolvedPolicy(request.tenantId);
    if (!resolved) {
      return null;
    }

    const effectivePolicy = resolved.policy;
    const scope = resolveScope(effectivePolicy, request, this.now());
    const scopeWarnings = scope?.warnings ?? [];

    if (!scope) {
      return {
        tenantId: request.tenantId,
        projectId: request.projectId ?? null,
        planTier: resolved.planTier,
        policy: effectivePolicy,
        scope: {
          basis: effectivePolicy.materialization.basis,
          windowStart: null,
          windowEnd: null,
          endedBefore: toIsoString(request.endedBefore ?? null),
          completedSessionsCount: effectivePolicy.materialization.completedSessionsCount ?? null,
          periodLabel: null,
        },
        summary: {
          examinedSessionCount: 0,
          includedSessionCount: 0,
          excludedSessionCount: 0,
          baseUnits: 0,
          llmAddonUnits: 0,
          toolAddonUnits: 0,
          totalUnits: 0,
          exclusionCounts: {},
          metricsSourceCounts: {
            clickhouse: 0,
            message_fallback: 0,
          },
          projectBreakdown: [],
          channelBreakdown: [],
        },
        sessions: [],
        warnings: scopeWarnings,
      };
    }

    const sessions = await this.loadSessions({
      tenantId: request.tenantId,
      projectId: request.projectId,
      scope,
    });

    const sessionIds = sessions.map((session) => session._id);
    const messageStats = await this.loadMessageStats({
      tenantId: request.tenantId,
      projectId: request.projectId,
      sessionIds,
    });
    const addonUsage = await this.metricsReader.getSessionAddonUsage({
      tenantId: request.tenantId,
      projectId: request.projectId,
      sessionIds,
    });

    const previewSessions: BillingPreviewSession[] = [];
    const exclusionCounts: Record<string, number> = {};
    const metricsSourceCounts: Record<BillingPreviewMetricsSource, number> = {
      clickhouse: 0,
      message_fallback: 0,
    };
    const projectBreakdownAccumulators = new Map<string, BillingBreakdownAccumulator>();
    const channelBreakdownAccumulators = new Map<string, BillingBreakdownAccumulator>();

    let baseUnits = 0;
    let llmAddonUnits = 0;
    let toolAddonUnits = 0;
    let includedSessionCount = 0;

    const sessionContext = new Map<
      string,
      {
        session: StoredSessionRow;
        stats: SessionMessageStats;
        llmCallCount: number;
        toolCallCount: number;
        metricsSource: BillingPreviewMetricsSource;
      }
    >();
    const derivationSessions: BillingDerivationSessionSnapshot[] = [];

    for (const session of sessions) {
      const stats = messageStats.get(session._id) ?? {
        userMessageCount: 0,
        assistantMessageCount: 0,
        toolMessageCount: 0,
        firstInteractiveAt: null,
        lastInteractiveAt: null,
      };
      const clickHouseUsage = addonUsage.usageBySessionId.get(session._id);
      const metricsSource: BillingPreviewMetricsSource = clickHouseUsage
        ? 'clickhouse'
        : 'message_fallback';
      metricsSourceCounts[metricsSource]++;

      const llmCallCount = clickHouseUsage?.llmCallCount ?? stats.assistantMessageCount;
      const toolCallCount = clickHouseUsage?.toolCallCount ?? stats.toolMessageCount;
      const interactiveTurnCount = Math.min(stats.userMessageCount, stats.assistantMessageCount);
      const engagedSeconds = computeEngagedSeconds(stats);
      sessionContext.set(session._id, {
        session,
        stats,
        llmCallCount,
        toolCallCount,
        metricsSource,
      });
      derivationSessions.push({
        sessionId: session._id,
        channel: session.channel,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        isTest: session.isTest,
        metadata: asRecord(session.metadata),
        context: asRecord(session.context),
        userMessageCount: stats.userMessageCount,
        interactiveTurnCount,
        engagedSeconds,
        usage: {
          llmCallCount,
          toolCallCount,
        },
      });
    }

    const derivation = this.derivationService.derive({
      policy: effectivePolicy,
      materializationBasis: scope.basis,
      periodLabel: scope.periodLabel,
      ...(scope.basis === 'time_window'
        ? {
            windowStart: scope.windowStart,
            windowEnd: scope.windowEnd,
          }
        : {}),
      sessions: derivationSessions,
    });

    baseUnits = derivation.baseUnits;
    llmAddonUnits = derivation.llmAddonUnits;
    toolAddonUnits = derivation.toolAddonUnits;
    includedSessionCount = derivation.includedSessionCount;

    for (const decision of derivation.decisions) {
      const context = sessionContext.get(decision.sessionId);
      if (!context) {
        continue;
      }

      const { session, stats, llmCallCount, toolCallCount, metricsSource } = context;
      const sessionTotalUnits =
        decision.baseUnits + decision.llmAddonUnits + decision.toolAddonUnits;

      if (!decision.included) {
        for (const reason of decision.exclusionReasons) {
          exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1;
        }
      }

      updateBreakdownAccumulator({
        accumulator: getOrCreateBreakdownAccumulator(
          projectBreakdownAccumulators,
          session.projectId,
        ),
        included: decision.included,
        baseUnits: decision.baseUnits,
        llmAddonUnits: decision.llmAddonUnits,
        toolAddonUnits: decision.toolAddonUnits,
        totalUnits: sessionTotalUnits,
      });
      updateBreakdownAccumulator({
        accumulator: getOrCreateBreakdownAccumulator(channelBreakdownAccumulators, session.channel),
        included: decision.included,
        baseUnits: decision.baseUnits,
        llmAddonUnits: decision.llmAddonUnits,
        toolAddonUnits: decision.toolAddonUnits,
        totalUnits: sessionTotalUnits,
      });

      previewSessions.push({
        sessionId: session._id,
        projectId: session.projectId,
        channel: session.channel,
        status: session.status,
        disposition: session.disposition,
        sessionType: decision.sessionType ?? null,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt.toISOString(),
        durationSeconds: decision.durationSeconds,
        userMessageCount: stats.userMessageCount,
        assistantMessageCount: stats.assistantMessageCount,
        toolMessageCount: stats.toolMessageCount,
        interactiveTurnCount: decision.interaction.interactiveTurnCount,
        engagedSeconds: decision.interaction.engagedSeconds,
        llmCallCount,
        toolCallCount,
        metricsSource,
        included: decision.included,
        exclusionReasons: [...decision.exclusionReasons],
        baseUnits: decision.baseUnits,
        llmAddonUnits: decision.llmAddonUnits,
        toolAddonUnits: decision.toolAddonUnits,
        totalUnits: sessionTotalUnits,
      });
    }

    if (scope.basis === 'completed_sessions') {
      previewSessions.sort((left, right) => left.endedAt.localeCompare(right.endedAt));
    }

    return {
      tenantId: request.tenantId,
      projectId: request.projectId ?? null,
      planTier: resolved.planTier,
      policy: effectivePolicy,
      scope: {
        basis: scope.basis,
        windowStart: scope.basis === 'time_window' ? scope.windowStart.toISOString() : null,
        windowEnd: scope.basis === 'time_window' ? scope.windowEnd.toISOString() : null,
        endedBefore: scope.basis === 'completed_sessions' ? scope.endedBefore.toISOString() : null,
        completedSessionsCount:
          scope.basis === 'completed_sessions' ? scope.completedSessionsCount : null,
        periodLabel: scope.periodLabel,
      },
      summary: {
        examinedSessionCount: previewSessions.length,
        includedSessionCount,
        excludedSessionCount: previewSessions.length - includedSessionCount,
        baseUnits,
        llmAddonUnits,
        toolAddonUnits,
        totalUnits: baseUnits + llmAddonUnits + toolAddonUnits,
        exclusionCounts,
        metricsSourceCounts,
        projectBreakdown: toProjectBreakdown(projectBreakdownAccumulators),
        channelBreakdown: toChannelBreakdown(channelBreakdownAccumulators),
      },
      sessions: previewSessions,
      warnings: [...scopeWarnings, ...addonUsage.warnings],
    };
  }

  private async loadSessions(params: {
    tenantId: string;
    projectId?: string;
    scope: ResolvedBillingScope;
  }): Promise<StoredSessionRow[]> {
    const { Session } = await import('@agent-platform/database/models');
    const where: Record<string, unknown> = {
      tenantId: params.tenantId,
      endedAt: { $ne: null },
    };

    if (params.projectId) {
      where.projectId = params.projectId;
    }

    if (params.scope.basis === 'time_window') {
      where.endedAt = {
        $gte: params.scope.windowStart,
        $lte: params.scope.windowEnd,
      };

      return (await Session.find(where, {
        _id: 1,
        tenantId: 1,
        projectId: 1,
        channel: 1,
        status: 1,
        disposition: 1,
        startedAt: 1,
        endedAt: 1,
        isTest: 1,
        context: 1,
        metadata: 1,
      })
        .sort({ endedAt: 1 })
        .lean()
        .exec()) as StoredSessionRow[];
    }

    where.endedAt = { $ne: null, $lte: params.scope.endedBefore };
    return (await Session.find(where, {
      _id: 1,
      tenantId: 1,
      projectId: 1,
      channel: 1,
      status: 1,
      disposition: 1,
      startedAt: 1,
      endedAt: 1,
      isTest: 1,
      context: 1,
      metadata: 1,
    })
      .sort({ endedAt: -1 })
      .limit(params.scope.completedSessionsCount)
      .lean()
      .exec()) as StoredSessionRow[];
  }

  private async loadMessageStats(params: {
    tenantId: string;
    projectId?: string;
    sessionIds: string[];
  }): Promise<Map<string, SessionMessageStats>> {
    if (params.sessionIds.length === 0) {
      return new Map();
    }

    const { Message } = await import('@agent-platform/database/models');
    const match: Record<string, unknown> = {
      tenantId: params.tenantId,
      sessionId: { $in: params.sessionIds },
      role: { $in: INTERACTIVE_MESSAGE_ROLES },
    };

    if (params.projectId) {
      match.projectId = params.projectId;
    }

    const rows = (await Message.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$sessionId',
          userMessageCount: {
            $sum: { $cond: [{ $eq: ['$role', 'user'] }, 1, 0] },
          },
          assistantMessageCount: {
            $sum: { $cond: [{ $eq: ['$role', 'assistant'] }, 1, 0] },
          },
          toolMessageCount: {
            $sum: { $cond: [{ $eq: ['$role', 'tool'] }, 1, 0] },
          },
          firstInteractiveAt: { $min: '$timestamp' },
          lastInteractiveAt: { $max: '$timestamp' },
        },
      },
    ]).exec()) as MessageStatsRow[];

    const messageStats = new Map<string, SessionMessageStats>();
    for (const row of rows) {
      messageStats.set(row._id, {
        userMessageCount: row.userMessageCount,
        assistantMessageCount: row.assistantMessageCount,
        toolMessageCount: row.toolMessageCount,
        firstInteractiveAt: row.firstInteractiveAt,
        lastInteractiveAt: row.lastInteractiveAt,
      });
    }

    return messageStats;
  }
}

export const billingUsagePreviewDefaults = {
  intervalMinutes: DEFAULT_BILLING_UNIT_POLICY.intervalMinutes,
  materialization: DEFAULT_BILLING_UNIT_POLICY.materialization,
  addons: DEFAULT_BILLING_UNIT_POLICY.addons,
};
