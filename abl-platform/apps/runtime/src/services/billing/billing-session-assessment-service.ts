import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { BillingMaterializationBasis } from '@agent-platform/database/models';
import type { ClickHouseClient } from '@clickhouse/client';
import { BillingPolicyService } from './billing-policy-service.js';
import {
  BillingUsageDerivationService,
  type BillingDerivationSessionSnapshot,
  type BillingInteractionType,
} from './billing-usage-derivation-service.js';

const log = createLogger('billing-session-assessment-service');
const INTERACTIVE_MESSAGE_ROLES = ['user', 'assistant', 'tool'] as const;

export type BillingAssessmentMetricsSource = 'clickhouse' | 'message_fallback';

interface StoredSessionRow {
  _id: string;
  tenantId: string;
  projectId: string;
  currentAgent: string;
  channel: string;
  startedAt: Date;
  endedAt: Date;
  isTest: boolean;
  knownSource: 'production' | 'eval' | 'synthetic' | null;
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

interface SessionAddonUsage {
  llmCallCount: number;
  toolCallCount: number;
}

interface BillingSessionAssessmentServiceDeps {
  billingPolicyService?: BillingPolicyService;
  derivationService?: BillingUsageDerivationService;
  clickHouseClientFactory?: () => ClickHouseClient;
}

export interface AssessEndedSessionInput {
  tenantId: string;
  projectId: string;
  sessionId: string;
}

export interface BillingSessionAssessment {
  tenantId: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  channel: string;
  startedAt: string;
  endedAt: string;
  policyMaterializationBasis: BillingMaterializationBasis;
  metricsSource: BillingAssessmentMetricsSource;
  included: boolean;
  exclusionReasons: string[];
  sessionType?: string;
  interactionType: BillingInteractionType;
  durationSeconds: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  usage: {
    llmCallCount: number;
    toolCallCount: number;
  };
  interaction: {
    userMessageCount: number;
    interactiveTurnCount: number;
    engagedSeconds: number;
  };
}

export interface AssessEndedSessionResult {
  assessment?: BillingSessionAssessment;
  skipped: boolean;
  reason?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function buildAssessment(params: {
  tenantId: string;
  projectId: string;
  session: StoredSessionRow;
  policyMaterializationBasis: BillingMaterializationBasis;
  metricsSource: BillingAssessmentMetricsSource;
  decision: ReturnType<BillingUsageDerivationService['derive']>['decisions'][number];
}): BillingSessionAssessment {
  return {
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.session._id,
    agentName: params.session.currentAgent,
    channel: params.session.channel,
    startedAt: params.session.startedAt.toISOString(),
    endedAt: params.session.endedAt.toISOString(),
    policyMaterializationBasis: params.policyMaterializationBasis,
    metricsSource: params.metricsSource,
    included: params.decision.included,
    exclusionReasons: [...params.decision.exclusionReasons],
    ...(params.decision.sessionType ? { sessionType: params.decision.sessionType } : {}),
    interactionType: params.decision.interactionType,
    durationSeconds: params.decision.durationSeconds,
    baseUnits: params.decision.baseUnits,
    llmAddonUnits: params.decision.llmAddonUnits,
    toolAddonUnits: params.decision.toolAddonUnits,
    totalUnits:
      params.decision.baseUnits + params.decision.llmAddonUnits + params.decision.toolAddonUnits,
    usage: {
      llmCallCount: params.decision.usage.llmCallCount,
      toolCallCount: params.decision.usage.toolCallCount,
    },
    interaction: {
      userMessageCount: params.decision.interaction.userMessageCount,
      interactiveTurnCount: params.decision.interaction.interactiveTurnCount,
      engagedSeconds: params.decision.interaction.engagedSeconds,
    },
  };
}

export class BillingSessionAssessmentService {
  private readonly billingPolicyService: BillingPolicyService;
  private readonly derivationService: BillingUsageDerivationService;
  private readonly clickHouseClientFactory: () => ClickHouseClient;

  constructor(deps: BillingSessionAssessmentServiceDeps = {}) {
    this.billingPolicyService = deps.billingPolicyService ?? new BillingPolicyService();
    this.derivationService = deps.derivationService ?? new BillingUsageDerivationService();
    this.clickHouseClientFactory = deps.clickHouseClientFactory ?? (() => getClickHouseClient());
  }

  async assessEndedSession(input: AssessEndedSessionInput): Promise<AssessEndedSessionResult> {
    const session = await this.loadTerminalSession(input);
    if (!session) {
      return {
        skipped: true,
        reason: 'session_not_found_or_not_terminal',
      };
    }

    const resolved = await this.billingPolicyService.getResolvedPolicy(input.tenantId);
    if (!resolved) {
      log.warn('Skipping billing session assessment — active subscription not found', {
        tenantId: input.tenantId,
        projectId: input.projectId,
        sessionId: input.sessionId,
      });
      return {
        skipped: true,
        reason: 'subscription_not_found',
      };
    }

    const messageStats = await this.loadMessageStats(input);
    const addonUsageResult = await this.loadAddonUsage(input);
    const addonUsage = addonUsageResult ?? {
      llmCallCount: messageStats.assistantMessageCount,
      toolCallCount: messageStats.toolMessageCount,
    };
    const metricsSource: BillingAssessmentMetricsSource = addonUsageResult
      ? 'clickhouse'
      : 'message_fallback';

    const derivation = this.derivationService.derive({
      policy: resolved.policy,
      materializationBasis: resolved.policy.materialization.basis,
      sessions: [
        this.buildSessionSnapshot({
          session,
          messageStats,
          addonUsage,
        }),
      ],
    });
    const decision = derivation.decisions[0];
    if (!decision) {
      return {
        skipped: true,
        reason: 'assessment_not_available',
      };
    }

    return {
      skipped: false,
      assessment: buildAssessment({
        tenantId: input.tenantId,
        projectId: input.projectId,
        session,
        policyMaterializationBasis: resolved.policy.materialization.basis,
        metricsSource,
        decision,
      }),
    };
  }

  private buildSessionSnapshot(params: {
    session: StoredSessionRow;
    messageStats: SessionMessageStats;
    addonUsage: SessionAddonUsage;
  }): BillingDerivationSessionSnapshot {
    return {
      sessionId: params.session._id,
      channel: params.session.channel,
      startedAt: params.session.startedAt,
      endedAt: params.session.endedAt,
      isTest: params.session.isTest,
      knownSource: params.session.knownSource,
      metadata: asRecord(params.session.metadata),
      context: asRecord(params.session.context),
      userMessageCount: params.messageStats.userMessageCount,
      interactiveTurnCount: Math.min(
        params.messageStats.userMessageCount,
        params.messageStats.assistantMessageCount,
      ),
      engagedSeconds: computeEngagedSeconds(params.messageStats),
      usage: params.addonUsage,
    };
  }

  private async loadTerminalSession(
    input: AssessEndedSessionInput,
  ): Promise<StoredSessionRow | null> {
    const { Session } = await import('@agent-platform/database/models');
    return (await Session.findOne(
      {
        _id: input.sessionId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        endedAt: { $ne: null },
      },
      {
        _id: 1,
        tenantId: 1,
        projectId: 1,
        currentAgent: 1,
        channel: 1,
        startedAt: 1,
        endedAt: 1,
        isTest: 1,
        knownSource: 1,
        context: 1,
        metadata: 1,
      },
    )
      .lean()
      .exec()) as StoredSessionRow | null;
  }

  private async loadMessageStats(input: AssessEndedSessionInput): Promise<SessionMessageStats> {
    const { Message } = await import('@agent-platform/database/models');
    const rows = (await Message.aggregate([
      {
        $match: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          role: { $in: INTERACTIVE_MESSAGE_ROLES },
        },
      },
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

    const row = rows[0];
    if (!row) {
      return {
        userMessageCount: 0,
        assistantMessageCount: 0,
        toolMessageCount: 0,
        firstInteractiveAt: null,
        lastInteractiveAt: null,
      };
    }

    return {
      userMessageCount: row.userMessageCount,
      assistantMessageCount: row.assistantMessageCount,
      toolMessageCount: row.toolMessageCount,
      firstInteractiveAt: row.firstInteractiveAt,
      lastInteractiveAt: row.lastInteractiveAt,
    };
  }

  private async loadAddonUsage(input: AssessEndedSessionInput): Promise<SessionAddonUsage | null> {
    try {
      const client = this.clickHouseClientFactory();
      const result = await client.query({
        query: `
          SELECT
            session_id AS sessionId,
            count() AS llmCallCount,
            sum(tool_call_count) AS toolCallCount
          FROM abl_platform.llm_metrics
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND session_id = {sessionId:String}
          GROUP BY session_id
          SETTINGS max_execution_time = 15
        `,
        query_params: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: input.sessionId,
        },
        format: 'JSONEachRow',
      });

      const rows = await result.json<{
        sessionId: string;
        llmCallCount: string;
        toolCallCount: string;
      }>();
      const row = rows[0];
      if (!row) {
        return {
          llmCallCount: 0,
          toolCallCount: 0,
        };
      }

      return {
        llmCallCount: parseInt(row.llmCallCount || '0', 10),
        toolCallCount: parseInt(row.toolCallCount || '0', 10),
      };
    } catch (error) {
      log.warn('Billing addon telemetry unavailable; falling back to message history', {
        tenantId: input.tenantId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
