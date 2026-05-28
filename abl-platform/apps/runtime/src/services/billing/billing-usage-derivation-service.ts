import type {
  BillingAddonMode,
  BillingMaterializationBasis,
  IBillingUnitPolicy,
} from '@agent-platform/database/models';

export type BillingInteractionType = 'proactive' | 'reactive' | 'unknown';

export interface BillingUsageTelemetrySnapshot {
  llmCallCount?: number;
  toolCallCount?: number;
}

export interface BillingDerivationSessionSnapshot {
  sessionId: string;
  channel: string;
  startedAt: Date;
  endedAt: Date | null;
  isTest?: boolean;
  sessionType?: string | null;
  /** Session purpose tag — 'eval' and 'synthetic' are excluded from billing by default */
  knownSource?: 'production' | 'eval' | 'synthetic' | null;
  interactionType?: BillingInteractionType;
  userMessageCount?: number;
  interactiveTurnCount?: number;
  engagedSeconds?: number;
  metadata?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  usage?: BillingUsageTelemetrySnapshot | null;
}

export interface BillingUsageDerivationInput {
  policy: IBillingUnitPolicy;
  sessions: BillingDerivationSessionSnapshot[];
  materializationBasis?: BillingMaterializationBasis;
  periodLabel?: string;
  windowStart?: Date;
  windowEnd?: Date;
}

export interface BillingSessionDerivationDecision {
  sessionId: string;
  included: boolean;
  exclusionReasons: string[];
  channel: string;
  sessionType?: string;
  interactionType: BillingInteractionType;
  durationSeconds: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
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

export interface BillingUsageDerivationResult {
  materializationBasis: BillingMaterializationBasis;
  periodLabel?: string;
  windowStart?: Date;
  windowEnd?: Date;
  completedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  decisions: BillingSessionDerivationDecision[];
}

const INTERACTION_TYPE_VALUES: ReadonlySet<BillingInteractionType> = new Set([
  'proactive',
  'reactive',
  'unknown',
]);

function getRecordString(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function getRecordNumber(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function resolveSessionType(snapshot: BillingDerivationSessionSnapshot): string | undefined {
  return (
    snapshot.sessionType ??
    getRecordString(snapshot.metadata, ['sessionType', 'session_type']) ??
    getRecordString(snapshot.context, ['sessionType', 'session_type']) ??
    undefined
  );
}

function resolveInteractionType(
  snapshot: BillingDerivationSessionSnapshot,
): BillingInteractionType {
  const rawValue =
    snapshot.interactionType ??
    getRecordString(snapshot.metadata, ['interactionType', 'interaction_type']) ??
    getRecordString(snapshot.context, ['interactionType', 'interaction_type']) ??
    'unknown';

  return INTERACTION_TYPE_VALUES.has(rawValue as BillingInteractionType)
    ? (rawValue as BillingInteractionType)
    : 'unknown';
}

function resolveUserMessageCount(snapshot: BillingDerivationSessionSnapshot): number {
  return (
    snapshot.userMessageCount ??
    getRecordNumber(snapshot.metadata, ['userMessageCount', 'user_message_count']) ??
    getRecordNumber(snapshot.context, ['userMessageCount', 'user_message_count']) ??
    0
  );
}

function resolveInteractiveTurnCount(snapshot: BillingDerivationSessionSnapshot): number {
  return (
    snapshot.interactiveTurnCount ??
    getRecordNumber(snapshot.metadata, [
      'interactiveTurnCount',
      'interactive_turn_count',
      'interactiveTurns',
    ]) ??
    getRecordNumber(snapshot.context, [
      'interactiveTurnCount',
      'interactive_turn_count',
      'interactiveTurns',
    ]) ??
    0
  );
}

function resolveEngagedSeconds(snapshot: BillingDerivationSessionSnapshot): number {
  return (
    snapshot.engagedSeconds ??
    getRecordNumber(snapshot.metadata, ['engagedSeconds', 'engaged_seconds']) ??
    getRecordNumber(snapshot.context, ['engagedSeconds', 'engaged_seconds']) ??
    0
  );
}

function resolveUsage(snapshot: BillingDerivationSessionSnapshot): BillingUsageTelemetrySnapshot {
  return {
    llmCallCount: Math.max(0, snapshot.usage?.llmCallCount ?? 0),
    toolCallCount: Math.max(0, snapshot.usage?.toolCallCount ?? 0),
  };
}

function computeDurationSeconds(startedAt: Date, endedAt: Date | null): number {
  if (!(endedAt instanceof Date)) {
    return 0;
  }

  const durationMs = endedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }

  return Math.ceil(durationMs / 1000);
}

function computeBaseUnits(durationSeconds: number, intervalMinutes: number): number {
  if (durationSeconds <= 0) {
    return 0;
  }

  const intervalSeconds = intervalMinutes * 60;
  return Math.ceil(durationSeconds / intervalSeconds);
}

function computeAddonUnits(
  mode: BillingAddonMode,
  count: number,
  bucketSize: number | null,
): number {
  if (count <= 0 || mode === 'off') {
    return 0;
  }

  if (mode === 'per_call') {
    return count;
  }

  const safeBucketSize = bucketSize && bucketSize > 0 ? bucketSize : 1;
  return Math.ceil(count / safeBucketSize);
}

function buildExclusionReasons(
  snapshot: BillingDerivationSessionSnapshot,
  policy: IBillingUnitPolicy,
  sessionType: string | undefined,
  interactionType: BillingInteractionType,
  userMessageCount: number,
  interactiveTurnCount: number,
  engagedSeconds: number,
): string[] {
  const reasons: string[] = [];

  if (snapshot.isTest) {
    reasons.push('test_session');
  }

  if (snapshot.knownSource === 'eval') {
    reasons.push('eval_session');
  }

  if (snapshot.knownSource === 'synthetic') {
    reasons.push('synthetic_session');
  }

  if (policy.excludedChannels.includes(snapshot.channel)) {
    reasons.push(`excluded_channel:${snapshot.channel}`);
  }

  if (sessionType && policy.excludedSessionTypes.includes(sessionType)) {
    reasons.push(`excluded_session_type:${sessionType}`);
  }

  const belowInteractionThreshold =
    userMessageCount < policy.interactionThreshold.minUserMessages ||
    interactiveTurnCount < policy.interactionThreshold.minInteractiveTurns ||
    engagedSeconds < policy.interactionThreshold.minEngagedSeconds;

  if (
    policy.excludeProactiveWithoutUserInteraction &&
    interactionType === 'proactive' &&
    belowInteractionThreshold
  ) {
    reasons.push('proactive_below_interaction_threshold');
  }

  return reasons;
}

export class BillingUsageDerivationService {
  derive(input: BillingUsageDerivationInput): BillingUsageDerivationResult {
    const materializationBasis = input.materializationBasis ?? input.policy.materialization.basis;

    const decisions = input.sessions.map((snapshot) => {
      const sessionType = resolveSessionType(snapshot);
      const interactionType = resolveInteractionType(snapshot);
      const userMessageCount = resolveUserMessageCount(snapshot);
      const interactiveTurnCount = resolveInteractiveTurnCount(snapshot);
      const engagedSeconds = resolveEngagedSeconds(snapshot);
      const usage = resolveUsage(snapshot);
      const exclusionReasons = buildExclusionReasons(
        snapshot,
        input.policy,
        sessionType,
        interactionType,
        userMessageCount,
        interactiveTurnCount,
        engagedSeconds,
      );
      const included = exclusionReasons.length === 0;
      const durationSeconds = computeDurationSeconds(snapshot.startedAt, snapshot.endedAt);
      const baseUnits = included
        ? computeBaseUnits(durationSeconds, input.policy.intervalMinutes)
        : 0;
      const llmAddonUnits = included
        ? computeAddonUnits(
            input.policy.addons.llm.mode,
            usage.llmCallCount ?? 0,
            input.policy.addons.llm.bucketSize,
          )
        : 0;
      const toolAddonUnits = included
        ? computeAddonUnits(
            input.policy.addons.tool.mode,
            usage.toolCallCount ?? 0,
            input.policy.addons.tool.bucketSize,
          )
        : 0;

      return {
        sessionId: snapshot.sessionId,
        included,
        exclusionReasons,
        channel: snapshot.channel,
        ...(sessionType ? { sessionType } : {}),
        interactionType,
        durationSeconds,
        baseUnits,
        llmAddonUnits,
        toolAddonUnits,
        usage: {
          llmCallCount: usage.llmCallCount ?? 0,
          toolCallCount: usage.toolCallCount ?? 0,
        },
        interaction: {
          userMessageCount,
          interactiveTurnCount,
          engagedSeconds,
        },
      };
    });

    const includedSessionCount = decisions.filter((decision) => decision.included).length;
    const excludedSessionCount = decisions.length - includedSessionCount;
    const baseUnits = decisions.reduce((sum, decision) => sum + decision.baseUnits, 0);
    const llmAddonUnits = decisions.reduce((sum, decision) => sum + decision.llmAddonUnits, 0);
    const toolAddonUnits = decisions.reduce((sum, decision) => sum + decision.toolAddonUnits, 0);

    return {
      materializationBasis,
      ...(input.periodLabel ? { periodLabel: input.periodLabel } : {}),
      ...(input.windowStart ? { windowStart: input.windowStart } : {}),
      ...(input.windowEnd ? { windowEnd: input.windowEnd } : {}),
      completedSessionCount: decisions.length,
      includedSessionCount,
      excludedSessionCount,
      baseUnits,
      llmAddonUnits,
      toolAddonUnits,
      totalUnits: baseUnits + llmAddonUnits + toolAddonUnits,
      decisions,
    };
  }
}
