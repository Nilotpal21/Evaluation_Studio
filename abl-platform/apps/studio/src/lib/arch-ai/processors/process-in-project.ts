/**
 * processInProjectMessage — IN_PROJECT mode message processor for v4.
 *
 * Wires the v4 TurnEngine for IN_PROJECT sessions. Follows the same pattern
 * as process-message.ts (ONBOARDING) but:
 *   - Uses mode='in-project' so coordinator-bridge selects IN_PROJECT specialist/tools
 *   - Pre-turn: detects LARGE mutations during BUILD → backtracks to BLUEPRINT
 *   - Tool registry includes IN_PROJECT tools (propose_modification, apply_modification, etc.)
 *
 * Source of truth: docs/superpowers/specs/2026-04-18-arch-v4-design.md
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ArchSSEEvent, MessageRequest, PageContext } from '@agent-platform/arch-ai';
import type { ArchSession, PendingPlan } from '@agent-platform/arch-ai';
import { TurnBuffer, resolveTurnPlan } from '@agent-platform/arch-ai/engine';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';
import type { TurnEvent } from '@agent-platform/arch-ai';
import { classifyMutationScope } from '@agent-platform/arch-ai';
import { uuidv7 } from '@agent-platform/database/mongo';
import { createProductionTurnEngine } from '@/lib/arch-ai/engine-factory';
import {
  journalService as realJournalService,
  sessionService as realSessionService,
  fileStoreService,
} from '@/lib/arch-ai/message-services';
import { journalAppendAndEmit } from '@/lib/arch-ai/helpers/stream-helpers';
import {
  buildInProjectTools,
  computePlanStateFingerprints,
} from '@/lib/arch-ai/tools/in-project-tools';
import { buildUserContentFromFileRefs } from './attachment-context';
import { buildSuggestionGenerator, buildTurnPlanLoaders } from './runtime-support';
import {
  computeIntegrationSuggestions,
  type IntegrationSuggestion,
} from './integration-suggestions';
import {
  collectBlobIdsFromContent,
  prepareTurnHistory,
  resolveUserContentForArchLlm,
} from '@/lib/arch-ai/helpers/build-llm-messages';
import {
  buildPageContextClarificationAppendix,
  shouldClarifyPageContextIntent,
} from '@/lib/arch-ai/page-context-ambiguity';
import { appendDeterministicToolAnswerMessage } from '@/lib/arch-ai/helpers/persist-tool-answer-history';

const log = createLogger('lib:arch-ai:processors:process-in-project');

type SequencedTurnEvent = TurnEvent & {
  eventId: string;
  sessionId: string;
  turnId: string;
  seq: number;
  timestamp: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeConfirmationAnswer(answer: unknown): boolean {
  if (typeof answer === 'boolean') {
    return answer;
  }
  if (typeof answer === 'string') {
    const normalized = answer.trim().toLowerCase();
    return (
      normalized === 'true' ||
      normalized === 'yes' ||
      normalized === 'confirm' ||
      normalized === 'accept' ||
      normalized === 'apply'
    );
  }
  if (isRecord(answer) && typeof answer.confirmed === 'boolean') {
    return answer.confirmed;
  }
  return false;
}

function normalizeConfirmationMessageAction(text: string): 'accept' | 'reject' | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const compact = normalized.replace(/[.!?\s]+$/g, '');
  if (
    [
      'true',
      'yes',
      'y',
      'confirm',
      'confirmed',
      'accept',
      'accepted',
      'approve',
      'approved',
      'apply',
      'apply it',
      'apply changes',
      'create agent',
      'do it',
      'go ahead',
      'proceed',
    ].includes(compact)
  ) {
    return 'accept';
  }

  if (
    [
      'false',
      'no',
      'n',
      'deny',
      'decline',
      'reject',
      'rejected',
      'discard',
      'discard it',
      'discard changes',
      'cancel',
      'stop',
    ].includes(compact)
  ) {
    return 'reject';
  }

  return null;
}

function normalizePlanConfirmationMessageAction(
  text: string,
): 'accept' | 'reject' | 'modify' | null {
  const normalized = text.trim().toLowerCase();
  const action = normalizeConfirmationMessageAction(normalized.replace(/\bplan\b/g, '').trim());
  if (
    normalized.includes('plan') &&
    /\b(refine|revise|edit|modify|change|adjust)\b/.test(normalized)
  ) {
    return 'modify';
  }
  if (!normalized.includes('plan') && !action) {
    return null;
  }
  return action;
}

function isConfirmationPayload(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.widgetType === 'Confirmation';
}

function isPlanConfirmationPayload(value: Record<string, unknown> | null): boolean {
  if (!value) {
    return false;
  }
  const text = [value.question, value.confirmLabel, value.denyLabel, value.message]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .toLowerCase();

  return /\b(plan|design|proposal|proposed|draft|changes?)\b/.test(text);
}

function normalizePlanConfirmationAnswer(
  answer: unknown,
  payload: Record<string, unknown> | null,
): 'accept' | 'reject' | 'modify' {
  if (normalizeConfirmationAnswer(answer)) {
    return 'accept';
  }

  const denyLabel = typeof payload?.denyLabel === 'string' ? payload.denyLabel.toLowerCase() : '';
  if (/\b(refine|revise|edit|modify|change|adjust)\b/.test(denyLabel)) {
    return 'modify';
  }

  return 'reject';
}

function findStoredConfirmationPayloadForToolCall(
  session: ArchSession,
  toolCallId: string,
): Record<string, unknown> | null {
  const messages = Array.isArray(session.metadata.messages) ? session.metadata.messages : [];
  for (const message of messages) {
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    for (const toolCall of toolCalls) {
      if (
        toolCall.toolCallId === toolCallId &&
        toolCall.toolName === 'ask_user' &&
        isConfirmationPayload(toolCall.input)
      ) {
        return toolCall.input;
      }
    }
  }

  return null;
}

function extractToolError(result: unknown): { code: string; message: string; retryable?: boolean } {
  if (isRecord(result) && result.success === false && isRecord(result.error)) {
    return {
      code: typeof result.error.code === 'string' ? result.error.code : 'INTERNAL',
      message:
        typeof result.error.message === 'string'
          ? result.error.message
          : 'The mutation could not be completed.',
      retryable: typeof result.error.retryable === 'boolean' ? result.error.retryable : undefined,
    };
  }

  return {
    code: 'INTERNAL',
    message: 'The mutation could not be completed.',
  };
}

function isMutationResolutionSuccess(result: unknown, action: 'accept' | 'reject'): boolean {
  if (!isRecord(result)) {
    return false;
  }

  if (result.success === true) {
    return true;
  }

  return action === 'reject' && result.dismissed === true;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveServerBoundPageContext(
  session: ArchSession,
  clientPageContext?: PageContext,
): PageContext | undefined {
  const surface = session.metadata.surface ?? 'project';
  if (surface !== 'agent-editor') {
    return clientPageContext ? { ...clientPageContext, surface: 'project' } : undefined;
  }

  const agentName = asNonEmptyString(session.metadata.agentName);
  if (!agentName) {
    return clientPageContext ? { ...clientPageContext, surface: 'project' } : undefined;
  }

  return {
    ...(clientPageContext ?? { area: 'agents', page: 'editor' }),
    surface: 'agent-editor',
    area: clientPageContext?.area ?? 'agents',
    page: clientPageContext?.page ?? 'editor',
    entity: {
      type: 'agent',
      id: agentName,
      name: agentName,
      metadata:
        clientPageContext?.entity?.type === 'agent' ? clientPageContext.entity.metadata : undefined,
    },
  };
}

function getNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function getArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function getImpactSummary(
  pendingMutation: ArchSession['metadata']['pendingMutation'],
): string | null {
  const impact = isRecord(pendingMutation?.impact) ? pendingMutation.impact : null;
  return asNonEmptyString(impact?.summary);
}

function getImpactNextAction(
  pendingMutation: ArchSession['metadata']['pendingMutation'],
): string | null {
  const impact = isRecord(pendingMutation?.impact) ? pendingMutation.impact : null;
  const nextActions = Array.isArray(impact?.nextActions) ? impact.nextActions : [];
  return asNonEmptyString(nextActions[0]);
}

function hasTopologyImpact(pendingMutation: ArchSession['metadata']['pendingMutation']): boolean {
  if (!pendingMutation) {
    return false;
  }

  if (pendingMutation.isNew === true || pendingMutation.scope === 'LARGE') {
    return true;
  }

  const topologyImpact = getNestedRecord(pendingMutation.impact, 'topology');
  return (
    getArrayLength(topologyImpact?.addedEdges) > 0 ||
    getArrayLength(topologyImpact?.removedEdges) > 0
  );
}

function buildProposalArtifactPayload(
  pendingMutation: NonNullable<ArchSession['metadata']['pendingMutation']>,
  action: 'accept' | 'reject',
): Record<string, unknown> {
  const before = typeof pendingMutation.before === 'string' ? pendingMutation.before : null;
  const after = typeof pendingMutation.after === 'string' ? pendingMutation.after : null;
  const changeSummary =
    asNonEmptyString(pendingMutation.changeSummary) ??
    (action === 'accept' ? 'Applied approved changes' : 'Discarded proposed changes');

  return {
    agentName: pendingMutation.target,
    change: changeSummary,
    currentCode: before ?? undefined,
    proposedCode: after ?? undefined,
    linesChanged:
      typeof before === 'string' && typeof after === 'string'
        ? Math.abs(after.split('\n').length - before.split('\n').length)
        : undefined,
    reviewStatus: action === 'accept' ? 'applied' : 'rejected',
    changes: [
      {
        construct: 'FULL',
        before,
        after,
        rationale: changeSummary,
      },
    ],
    validation: pendingMutation.validation,
    impact: pendingMutation.impact,
  };
}

function buildMutationResolutionMessage(params: {
  action: 'accept' | 'reject';
  pendingMutation: NonNullable<ArchSession['metadata']['pendingMutation']>;
  result: unknown;
  topologyRefreshed: boolean;
  topologyRefreshAttempted: boolean;
}): string {
  const { action, pendingMutation, result, topologyRefreshed, topologyRefreshAttempted } = params;
  const resultAgentName = isRecord(result) ? asNonEmptyString(result.agentName) : null;
  const targetAgent = pendingMutation.target;
  const effectiveAgent =
    resultAgentName && resultAgentName !== targetAgent
      ? `${targetAgent} (now ${resultAgentName})`
      : targetAgent;

  if (action === 'reject') {
    return `Discarded the proposed changes for ${targetAgent}. No project files were changed.`;
  }

  const opening =
    pendingMutation.isNew === true
      ? `Created agent ${effectiveAgent}.`
      : `Applied the approved changes to ${effectiveAgent}.`;
  const lines = [opening];
  const impactSummary = getImpactSummary(pendingMutation);
  if (impactSummary) {
    lines.push(`Impact: ${impactSummary}`);
  }
  if (topologyRefreshAttempted) {
    lines.push(
      topologyRefreshed
        ? 'Topology: refreshed the project topology artifact.'
        : 'Topology: the change applied, but the topology artifact could not be refreshed automatically.',
    );
  }
  const nextAction = getImpactNextAction(pendingMutation);
  if (nextAction) {
    lines.push(`Next: ${nextAction}`);
  }
  lines.push('Review complete: closed the approved plan and changes artifacts.');

  return lines.join('\n\n');
}

function buildEnvelope(
  sessionId: string,
  turnId: string,
  seq: number,
): {
  eventId: string;
  schemaVersion: 2;
  sessionId: string;
  turnId: string;
  seq: number;
  timestamp: number;
} {
  return {
    eventId: uuidv7(),
    schemaVersion: 2,
    sessionId,
    turnId,
    seq,
    timestamp: Date.now(),
  };
}

async function persistHistorySummary(
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  historySummary: ArchSession['metadata']['historySummary'],
): Promise<void> {
  await ArchSessionModel.updateOne(
    {
      _id: sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      state: { $ne: 'ARCHIVED' },
    },
    {
      $set: {
        'metadata.historySummary': historySummary ?? null,
      },
    },
  );
}

/**
 * Emit a list of integration suggestions as artifact_updated widget events
 * (variant 'integration_suggestion_card'). Pure: takes the suggestion list
 * and emits one event per suggestion under a single synthetic turnId.
 *
 * No I/O, no error paths beyond what `emitTurnEvent` itself does.
 */
export function emitSuggestionsAsCards(params: {
  sessionId: string;
  suggestions: IntegrationSuggestion[];
  emitTurnEvent: (event: TurnEvent) => void;
}): void {
  const { sessionId, suggestions, emitTurnEvent } = params;
  if (suggestions.length === 0) return;

  const turnId = `turn_${uuidv7()}`;
  let seq = 0;
  for (const suggestion of suggestions) {
    emitTurnEvent({
      ...buildEnvelope(sessionId, turnId, seq++),
      type: 'artifact_updated',
      update: {
        artifact: 'widget',
        variant: 'integration_suggestion_card',
        payload: {
          title: suggestion.title,
          rationale: suggestion.rationale,
          providerOptions: suggestion.providerOptions,
          targetAgentNames: suggestion.targetAgentNames,
        },
      },
    });
  }
}

/**
 * Compute integration suggestions for a project and emit them as cards.
 * Best-effort: any error is logged and swallowed so the caller's turn
 * is never blocked.
 *
 * Used on fresh-session open and when the user explicitly requests a review.
 */
export async function emitIntegrationSuggestionCards(params: {
  ctx: { tenantId: string };
  projectId: string;
  sessionId: string;
  pageContext?: import('@agent-platform/arch-ai').PageContext;
  emitTurnEvent: (event: TurnEvent) => void;
}): Promise<IntegrationSuggestion[]> {
  const { ctx, projectId, sessionId, pageContext, emitTurnEvent } = params;
  try {
    const suggestions = await computeIntegrationSuggestions(
      { user: { tenantId: ctx.tenantId }, projectId },
      pageContext,
    );
    emitSuggestionsAsCards({ sessionId, suggestions, emitTurnEvent });
    return suggestions;
  } catch (err) {
    log.warn('Failed to emit integration suggestion cards', {
      sessionId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Process an IN_PROJECT message through the v4 TurnEngine.
 *
 * Supports all MessageRequest types routed here from the v4 message route.
 * For 'message' type: drives the full IN_PROJECT turn loop with content routing.
 * For other types (tool_answer, gate_response, proposal_response): synthesized
 * into user input for the LLM continuation.
 */
export async function processInProjectMessage(
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  session: ArchSession,
  msg: MessageRequest,
  emit: (event: ArchSSEEvent) => void,
  close: () => void,
  userAuthToken: string,
  abortSignal: AbortSignal,
  fencingToken?: number,
): Promise<void> {
  log.info('v4 processInProjectMessage entry', {
    sessionId: session.id,
    msgType: msg.type,
    phase: session.metadata.phase,
    mode: session.metadata.mode,
    tenantId: ctx.tenantId,
  });

  const lastEmittedSeqByTurn = new Map<string, number>();
  const normalizeTurnEventSequence = (event: TurnEvent): TurnEvent => {
    if (!isRecord(event) || typeof event.turnId !== 'string' || typeof event.seq !== 'number') {
      return event;
    }

    const sequenced = event as SequencedTurnEvent;
    const lastSeq = lastEmittedSeqByTurn.get(sequenced.turnId);
    if (lastSeq === undefined || sequenced.seq > lastSeq) {
      lastEmittedSeqByTurn.set(sequenced.turnId, sequenced.seq);
      return event;
    }

    const nextSeq = lastSeq + 1;
    lastEmittedSeqByTurn.set(sequenced.turnId, nextSeq);
    return {
      ...event,
      eventId: uuidv7(),
      seq: nextSeq,
      timestamp: Date.now(),
    } as TurnEvent;
  };

  // Bridge: emit a v4 TurnEvent down the SSE stream typed as ArchSSEEvent.
  // Some tool-originated artifacts are emitted with their own local seq values.
  // The UI dedupes by (turnId, seq), so normalize every outgoing turn event to
  // one monotonic sequence per turn before it leaves the processor.
  const emitTurnEvent = (event: TurnEvent): void => {
    try {
      emit(normalizeTurnEventSequence(event) as unknown as ArchSSEEvent);
    } catch (err) {
      log.warn('emit failed for v4 turn event', {
        error: err instanceof Error ? err.message : String(err),
        eventType: (event as { type?: string }).type,
      });
    }
  };

  const emitPlanLifecycleEvent = (
    plan: PendingPlan,
    envelope: ReturnType<typeof buildEnvelope>,
  ): void => {
    switch (plan.status) {
      case 'proposed':
        emitTurnEvent({
          ...envelope,
          type: 'plan_proposed',
          planId: plan.id,
          status: 'proposed',
          payload: plan,
        });
        return;
      case 'approved':
        emitTurnEvent({
          ...envelope,
          type: 'plan_approved',
          planId: plan.id,
          status: 'approved',
          payload: plan,
        });
        return;
      case 'refining':
        emitTurnEvent({
          ...envelope,
          type: 'plan_refining',
          planId: plan.id,
          status: 'refining',
          payload: plan,
        });
        return;
      case 'cancelled':
        emitTurnEvent({
          ...envelope,
          type: 'plan_cancelled',
          planId: plan.id,
          status: 'cancelled',
          payload: plan,
        });
        return;
      case 'invalidated':
        emitTurnEvent({
          ...envelope,
          type: 'plan_invalidated',
          planId: plan.id,
          status: 'invalidated',
          payload: plan,
        });
        return;
      default:
        return;
    }
  };

  const transitionDeterministicTurnToIdle = async (): Promise<void> => {
    try {
      await realSessionService.transitionState(ctx, session.id, 'ACTIVE', 'IDLE');
    } catch (err) {
      log.warn('Failed to transition deterministic IN_PROJECT turn to IDLE', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const resolvePendingPlanDeterministically = async (
    action: 'accept' | 'reject' | 'modify',
    pendingPlan: PendingPlan,
    feedback?: string,
    options: { continueAfterApproval?: boolean } = {},
  ): Promise<PendingPlan> => {
    const turnId = `turn_${uuidv7()}`;
    let seq = 0;
    const now = new Date().toISOString();
    const stateFingerprintsAtApproval =
      action === 'accept' && session.metadata.projectId
        ? await computePlanStateFingerprints(ctx, session.metadata.projectId, pendingPlan)
        : pendingPlan.stateFingerprintsAtApproval;
    const nextPlan: PendingPlan = {
      ...pendingPlan,
      status: action === 'accept' ? 'approved' : action === 'reject' ? 'cancelled' : 'refining',
      updatedAt: now,
      approvedAt: action === 'accept' ? now : pendingPlan.approvedAt,
      cancelledAt: action === 'reject' ? now : pendingPlan.cancelledAt,
      stateFingerprintsAtApproval,
      refinementHistory:
        action === 'modify' && feedback?.trim()
          ? [
              ...(pendingPlan.refinementHistory ?? []),
              { feedback: feedback.trim(), timestamp: now, previousPlanId: pendingPlan.id },
            ]
          : pendingPlan.refinementHistory,
    };

    await realSessionService.setPendingPlan(ctx, session.id, nextPlan);
    (session.metadata as { pendingPlan?: PendingPlan }).pendingPlan = nextPlan;

    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'turn_started',
      userMessageId: uuidv7(),
    });
    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'artifact_updated',
      update: {
        artifact: 'plan',
        planId: nextPlan.id,
        status: nextPlan.status,
        payload: nextPlan,
      },
    });
    emitPlanLifecycleEvent(nextPlan, buildEnvelope(session.id, turnId, seq++));

    const text =
      action === 'accept'
        ? options.continueAfterApproval
          ? `Plan approved: ${nextPlan.title}. Drafting the covered proposal now.`
          : `Plan approved: ${nextPlan.title}.`
        : action === 'reject'
          ? `Plan cancelled: ${nextPlan.title}.`
          : `Plan marked for refinement: ${nextPlan.title}.`;

    try {
      await realSessionService.appendMessage(ctx, session.id, {
        id: `msg_${uuidv7()}`,
        role: 'assistant',
        content: text,
        timestamp: new Date().toISOString(),
        specialist: 'in-project-architect',
        phase: session.metadata.phase,
      });
    } catch (err) {
      log.warn('Failed to persist deterministic IN_PROJECT plan response', {
        sessionId: session.id,
        planId: nextPlan.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'text_delta',
      delta: text,
      specialist: 'in-project-architect',
    });

    if (action === 'accept' && options.continueAfterApproval) {
      emitTurnEvent({
        ...buildEnvelope(session.id, turnId, seq++),
        type: 'status',
        label: 'Drafting the proposal covered by the approved plan…',
      });
      return nextPlan;
    }

    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'turn_committed',
      phase: 'IN_PROJECT',
    });
    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'turn_ended',
      reason: 'natural',
    });
    await transitionDeterministicTurnToIdle();
    return nextPlan;
  };

  const resolvePendingMutationDeterministically = async (
    action: 'accept' | 'reject',
    pendingMutation: NonNullable<ArchSession['metadata']['pendingMutation']>,
  ): Promise<void> => {
    const projectId = session.metadata.projectId;
    if (!projectId) {
      throw new Error('IN_PROJECT pending mutation is missing projectId');
    }

    const turnId = `turn_${uuidv7()}`;
    let seq = 0;
    const targetAgent = pendingMutation.target;
    const diffId =
      isRecord(pendingMutation) && typeof pendingMutation.proposalId === 'string'
        ? pendingMutation.proposalId
        : `proposal_${uuidv7()}`;
    const toolSet = buildInProjectTools(ctx, session.id, projectId, userAuthToken, undefined, {
      pageContext: resolveServerBoundPageContext(session),
    });
    const applyTool = toolSet.apply_modification;
    const dismissTool = toolSet.dismiss_proposal;
    const readTopologyTool = toolSet.read_topology;

    if (typeof applyTool.execute !== 'function' || typeof dismissTool.execute !== 'function') {
      throw new Error('IN_PROJECT mutation tools are not fully wired');
    }

    const invokeMutationTool = (tool: { execute: unknown }, input: Record<string, unknown>) =>
      (tool.execute as (input: Record<string, unknown>) => Promise<unknown>)(input);

    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'turn_started',
      userMessageId: uuidv7(),
    });
    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'status',
      label: action === 'accept' ? 'Applying changes…' : 'Discarding changes…',
    });

    const result =
      action === 'accept'
        ? await invokeMutationTool(applyTool, { agentName: targetAgent })
        : await invokeMutationTool(dismissTool, {});

    if (!isMutationResolutionSuccess(result, action)) {
      const error = extractToolError(result);
      log.warn('v4 IN_PROJECT pending mutation resolution failed', {
        sessionId: session.id,
        action,
        targetAgent,
        code: error.code,
        message: error.message,
      });
      emitTurnEvent({
        ...buildEnvelope(session.id, turnId, seq++),
        type: 'error',
        error,
      });
      emitTurnEvent({
        ...buildEnvelope(session.id, turnId, seq++),
        type: 'turn_ended',
        reason: 'error',
      });
      await transitionDeterministicTurnToIdle();
      return;
    }

    if (action === 'accept') {
      try {
        await realSessionService.setPendingPlan(ctx, session.id, null);
        (session.metadata as { pendingPlan?: PendingPlan }).pendingPlan = undefined;
      } catch (err) {
        log.warn('Failed to clear approved IN_PROJECT plan after successful mutation', {
          sessionId: session.id,
          targetAgent,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const journalEntry = await realJournalService.append(ctx, {
          sessionId: session.id,
          type: 'mutation',
          content: {
            type: 'mutation',
            what:
              pendingMutation.isNew === true
                ? `Created agent: ${targetAgent}`
                : `Updated agent: ${targetAgent}`,
            to:
              typeof pendingMutation.changeSummary === 'string' &&
              pendingMutation.changeSummary.trim().length > 0
                ? pendingMutation.changeSummary.trim()
                : pendingMutation.isNew === true
                  ? `Created ${targetAgent} from an approved proposal`
                  : `Applied approved changes to ${targetAgent}`,
            reason:
              pendingMutation.isNew === true
                ? 'User approved the proposed new agent during in-project editing'
                : 'User approved the proposed in-project agent update',
            specialist: 'abl-construct-expert',
            requestedBy: 'user',
          },
          specialist: 'abl-construct-expert',
          phase: 'IN_PROJECT',
        });

        await realJournalService.linkToProject(ctx, session.id, projectId, {
          unsafeProjectScope: true,
        });

        emitTurnEvent({
          ...buildEnvelope(session.id, turnId, seq++),
          type: 'artifact_updated',
          update: {
            artifact: 'journal',
            entry: journalEntry,
          },
        });
      } catch (err) {
        log.warn('Failed to append deterministic IN_PROJECT mutation journal entry', {
          sessionId: session.id,
          targetAgent,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let topologyRefreshed = false;
    const topologyRefreshAttempted = action === 'accept' && hasTopologyImpact(pendingMutation);
    if (topologyRefreshAttempted) {
      try {
        if (typeof readTopologyTool.execute !== 'function') {
          throw new Error('read_topology tool is not wired');
        }
        const topology = await invokeMutationTool(readTopologyTool, {});
        if (!isRecord(topology) || !topology.error) {
          emitTurnEvent({
            ...buildEnvelope(session.id, turnId, seq++),
            type: 'artifact_updated',
            update: {
              artifact: 'topology',
              payload: topology,
            },
          });
          topologyRefreshed = true;
        } else {
          log.warn('Topology refresh after deterministic mutation returned an error', {
            sessionId: session.id,
            targetAgent,
            error: topology.error,
          });
        }
      } catch (err) {
        log.warn('Failed to refresh topology after deterministic mutation', {
          sessionId: session.id,
          targetAgent,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'artifact_updated',
      update: {
        artifact: 'diff',
        diffId,
        status: action === 'accept' ? 'applied' : 'rejected',
        payload: buildProposalArtifactPayload(pendingMutation, action),
      },
    });

    const resolutionMessage = buildMutationResolutionMessage({
      action,
      pendingMutation,
      result,
      topologyRefreshed,
      topologyRefreshAttempted,
    });

    try {
      const changeSummary = asNonEmptyString(pendingMutation.changeSummary);
      await realSessionService.appendMessage(ctx, session.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: resolutionMessage,
        timestamp: new Date().toISOString(),
        specialist: 'abl-construct-expert',
        messageMetadata: {
          source: 'deterministic_mutation_resolution',
          action: action === 'accept' ? 'applied' : 'rejected',
          targetAgent,
          changeSummary: changeSummary ?? undefined,
          artifactsClosed: action === 'accept',
          planCleared: action === 'accept',
          topologyRefreshed,
        },
        phase: session.metadata.phase,
      });
    } catch (err) {
      log.warn('Failed to persist deterministic IN_PROJECT mutation followup', {
        sessionId: session.id,
        targetAgent,
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'text_delta',
      delta: resolutionMessage,
    });
    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'turn_committed',
      phase: session.metadata.phase,
    });
    emitTurnEvent({
      ...buildEnvelope(session.id, turnId, seq++),
      type: 'turn_ended',
      reason: 'natural',
    });
    await transitionDeterministicTurnToIdle();

    log.info('v4 IN_PROJECT pending mutation resolved deterministically', {
      sessionId: session.id,
      action,
      targetAgent,
    });
  };

  try {
    const serverBoundPageContext = resolveServerBoundPageContext(
      session,
      msg.type === 'message' ? msg.pageContext : undefined,
    );

    // Fresh-session integration suggestions (Task 5.3 of ABLP-162).
    // Best-effort: throttled per (tenant, project) for 30 minutes via Redis.
    // Only fires on the very first user 'message' for an in-project session
    // that has a projectId. Errors are swallowed; never blocks the turn.
    if (
      msg.type === 'message' &&
      session.metadata.projectId &&
      Array.isArray(session.metadata.messages) &&
      session.metadata.messages.length === 0
    ) {
      await emitIntegrationSuggestionCards({
        ctx: { tenantId: ctx.tenantId },
        projectId: session.metadata.projectId,
        sessionId: session.id,
        pageContext: serverBoundPageContext,
        emitTurnEvent,
      });
    }

    const fileRefs = msg.type === 'message' ? msg.fileRefs : undefined;
    const rawUserText = msg.type === 'message' ? (msg.text ?? '') : '';
    const structuredUserContent =
      msg.type === 'message'
        ? await buildUserContentFromFileRefs(ctx, session.id, rawUserText, fileRefs)
        : undefined;
    const previousPageContext =
      msg.type === 'message' ? session.metadata.lastUserPageContext : undefined;
    const currentPageContext = msg.type === 'message' ? serverBoundPageContext : undefined;
    const hasPendingPageContextAction =
      session.metadata.pendingInteraction != null ||
      session.metadata.pendingMutation != null ||
      session.metadata.pendingPlan?.status === 'proposed';
    let continuationUserInputOverride: string | null = null;

    if (msg.type === 'tool_answer') {
      try {
        await realSessionService.setPendingInteraction(ctx, session.id, null);
      } catch (err) {
        log.warn('Failed to clear pending interaction before IN_PROJECT widget handling', {
          sessionId: session.id,
          toolCallId: msg.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        let resultToStore = msg.answer;
        if (
          Array.isArray(msg.answer) &&
          msg.answer.length > 0 &&
          msg.answer[0]?.content &&
          typeof msg.answer[0].content === 'string' &&
          msg.answer[0].content.length > 1000
        ) {
          resultToStore = msg.answer.map((f: any) => ({
            name: f.name,
            size: f.size,
            type: f.type,
            contentStored: true,
          }));
          log.info('Storing collect_file content for KB upload', {
            sessionId: session.id,
            fileCount: msg.answer.length,
            firstName: msg.answer[0]?.name,
          });
          await realSessionService.setLastCollectFileContent(ctx, session.id, msg.answer);
        }
        await realSessionService.setToolResult(ctx, session.id, msg.toolCallId, resultToStore);
      } catch (err) {
        log.warn('Failed to persist IN_PROJECT widget answer result (non-fatal)', {
          sessionId: session.id,
          toolCallId: msg.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const pendingWidgetPayload =
        session.metadata.pendingInteraction?.kind === 'widget' &&
        isRecord(session.metadata.pendingInteraction.payload)
          ? session.metadata.pendingInteraction.payload
          : null;
      const pendingMutation = session.metadata.pendingMutation;

      const confirmationPayload = isConfirmationPayload(pendingWidgetPayload)
        ? pendingWidgetPayload
        : findStoredConfirmationPayloadForToolCall(session, msg.toolCallId);

      if (pendingMutation && confirmationPayload) {
        await appendDeterministicToolAnswerMessage({
          sessionService: realSessionService,
          ctx,
          session,
          toolCallId: msg.toolCallId,
          answer: msg.answer,
          pendingPayload: confirmationPayload,
        });
        await resolvePendingMutationDeterministically(
          normalizeConfirmationAnswer(msg.answer) ? 'accept' : 'reject',
          pendingMutation,
        );
        return;
      }

      if (
        session.metadata.pendingPlan?.status === 'proposed' &&
        confirmationPayload &&
        isPlanConfirmationPayload(confirmationPayload)
      ) {
        await appendDeterministicToolAnswerMessage({
          sessionService: realSessionService,
          ctx,
          session,
          toolCallId: msg.toolCallId,
          answer: msg.answer,
          pendingPayload: confirmationPayload,
        });
        const planAction = normalizePlanConfirmationAnswer(msg.answer, confirmationPayload);
        await resolvePendingPlanDeterministically(
          planAction,
          session.metadata.pendingPlan,
          undefined,
          { continueAfterApproval: planAction === 'accept' },
        );
        if (planAction !== 'accept') {
          return;
        }
        continuationUserInputOverride =
          'Plan approved. Draft the proposal covered by this approved plan now.';
      }
    }

    if (msg.type === 'message') {
      const pendingWidgetPayload =
        session.metadata.pendingInteraction?.kind === 'widget' &&
        isRecord(session.metadata.pendingInteraction.payload)
          ? session.metadata.pendingInteraction.payload
          : null;
      const pendingMutation = session.metadata.pendingMutation;
      const confirmationAction = normalizeConfirmationMessageAction(rawUserText);
      const planConfirmationAction = normalizePlanConfirmationMessageAction(rawUserText);

      if (pendingMutation && isConfirmationPayload(pendingWidgetPayload) && confirmationAction) {
        await appendDeterministicToolAnswerMessage({
          sessionService: realSessionService,
          ctx,
          session,
          toolCallId: session.metadata.pendingInteraction!.id,
          answer: confirmationAction === 'accept',
          pendingPayload: pendingWidgetPayload,
        });
        await resolvePendingMutationDeterministically(confirmationAction, pendingMutation);
        return;
      }

      if (
        session.metadata.pendingPlan &&
        session.metadata.pendingPlan.status === 'proposed' &&
        planConfirmationAction
      ) {
        await resolvePendingPlanDeterministically(
          planConfirmationAction,
          session.metadata.pendingPlan,
          undefined,
          { continueAfterApproval: planConfirmationAction === 'accept' },
        );
        if (planConfirmationAction !== 'accept') {
          return;
        }
        continuationUserInputOverride =
          'Plan approved. Draft the proposal covered by this approved plan now.';
      }
    }

    if (msg.type === 'proposal_response' && session.metadata.pendingMutation) {
      if (msg.action === 'modify') {
        await realSessionService.setPendingMutation(ctx, session.id, null);
      } else {
        await resolvePendingMutationDeterministically(msg.action, session.metadata.pendingMutation);
        return;
      }
    }

    if (msg.type === 'proposal_response' && session.metadata.pendingPlan?.status === 'proposed') {
      const planAction =
        msg.action === 'accept' ? 'accept' : msg.action === 'reject' ? 'reject' : 'modify';
      await resolvePendingPlanDeterministically(
        planAction,
        session.metadata.pendingPlan,
        msg.feedback,
        {
          continueAfterApproval: planAction === 'accept',
        },
      );
      if (planAction !== 'accept') {
        return;
      }
      continuationUserInputOverride =
        'Plan approved. Draft the proposal covered by this approved plan now.';
    }

    // ── Pre-turn: BUILD → BLUEPRINT backtrack for LARGE mutations ──────
    // Detect topology-altering user messages during BUILD phase and carry the
    // reset through the turn buffer so the live V4 path keeps one commit model.
    let effectivePhase = session.metadata.phase;
    let shouldBacktrackToBlueprint = false;
    let backtrackRationale: string | null = null;

    if (
      msg.type === 'message' &&
      session.metadata.phase === 'BUILD' &&
      session.metadata.topology != null
    ) {
      const scope = classifyMutationScope(msg.text);
      if (scope === 'LARGE') {
        log.info('BUILD → BLUEPRINT backtrack (LARGE mutation) in v4 IN_PROJECT', {
          sessionId: session.id,
          messagePreview: msg.text.slice(0, 80),
        });
        effectivePhase = 'BLUEPRINT';
        shouldBacktrackToBlueprint = true;
        backtrackRationale = `User requested a topology-altering change: "${msg.text.slice(0, 120)}". Approved agents preserved and will be reused where possible on BUILD re-entry.`;

        // Journal the backtrack decision
        await journalAppendAndEmit(
          realJournalService,
          ctx,
          {
            sessionId: session.id,
            type: 'decision',
            content: {
              type: 'decision',
              summary: 'Backtrack BUILD → BLUEPRINT for topology change',
              rationale: backtrackRationale,
              specialist: 'coordinator',
              source: 'user_input' as const,
            },
            specialist: 'coordinator',
            phase: 'BUILD',
          },
          undefined, // no direct SSE emit — artifacts go via engine outbox
        );

        // Emit phase_transition event for the client
        emit({
          type: 'phase_transition',
          from: 'BUILD',
          to: 'BLUEPRINT',
        } as unknown as ArchSSEEvent);

        emit({
          type: 'text_delta',
          delta:
            "That's a topology-level change — let me go back to the design step and update the architecture. I'll keep the agents you already approved.\n\n",
        } as unknown as ArchSSEEvent);
      }
    }

    // 1. Build the fully wired TurnEngine for this tenant.
    const { engine, toolRegistry } = await createProductionTurnEngine(ctx.tenantId, {
      generateSuggestions: buildSuggestionGenerator(session),
    });

    // 2. Map session mode to lowercase for coordinator bridge + RunTurnInput.
    const engineMode: 'onboarding' | 'in-project' = 'in-project';

    // 3. Resolve the turn plan with the effective phase (may have changed
    //    from BUILD to BLUEPRINT if backtrack was triggered).
    const plan = await resolveTurnPlan({
      session: {
        _id: session.id,
        metadata: {
          phase: effectivePhase,
          mode: engineMode,
          specification: session.metadata.specification as Record<string, unknown>,
          projectId: session.metadata.projectId,
        },
      },
      userInput:
        continuationUserInputOverride ??
        (msg.type === 'message'
          ? rawUserText
          : msg.type === 'tool_answer'
            ? typeof msg.answer === 'string'
              ? msg.answer
              : JSON.stringify(msg.answer ?? '')
            : msg.type === 'gate_response'
              ? msg.feedback
                ? `[Gate ${msg.action}] ${msg.feedback}`
                : `[Gate ${msg.action}]`
              : msg.type === 'proposal_response'
                ? msg.feedback
                  ? `[Proposal ${msg.action}] ${msg.feedback}`
                  : `[Proposal ${msg.action}]`
                : ''),
      pageContext: msg.type === 'message' ? serverBoundPageContext : undefined,
      specialistOverride:
        msg.type !== 'message' ||
        (msg.type === 'message' &&
          rawUserText.trim().length === 0 &&
          Array.isArray(fileRefs) &&
          fileRefs.length > 0)
          ? session.metadata.activeSpecialist
          : undefined,
      registry: toolRegistry,
      ...buildTurnPlanLoaders(ctx, session),
    });

    let systemPromptAppendix: string | undefined;

    // 4. Build a filtered ToolRegistry containing only the mode-allowed tools.
    let allowedToolNames = plan.allowedTools.map((t) => t.name);
    if (
      msg.type === 'message' &&
      shouldClarifyPageContextIntent({
        text: rawUserText,
        previousPageContext,
        currentPageContext,
        hasPendingAction: hasPendingPageContextAction,
      })
    ) {
      allowedToolNames = ['ask_user'];
      systemPromptAppendix = buildPageContextClarificationAppendix({
        previousPageContext,
        currentPageContext,
        hasPendingAction: hasPendingPageContextAction,
      });
    }
    const allowedRegistry = toolRegistry.subset(allowedToolNames);

    // 5. Build a per-turn TurnBuffer.
    const turnId = `turn_${uuidv7()}`;
    const buffer = new TurnBuffer({
      ArchSessions: ArchSessionModel as unknown as import('mongoose').Model<unknown>,
      sessionId: session.id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      fencingToken: fencingToken ?? Date.now(),
      turnId,
    });
    if (msg.type === 'message') {
      buffer.patchSession({
        'metadata.lastUserPageContext': serverBoundPageContext ?? null,
      });
    }
    if (shouldBacktrackToBlueprint) {
      buffer.patchSession({
        'metadata.phase': 'BLUEPRINT',
        'metadata.topologyApproved': false,
        'metadata.buildProgress': null,
      });
      log.info('BUILD → BLUEPRINT backtrack buffered for commit in v4 IN_PROJECT', {
        sessionId: session.id,
        turnId,
        rationale: backtrackRationale,
      });
    }

    // 6. Synthesize the user input string from the message.
    let userInput: string;
    if (continuationUserInputOverride) {
      userInput = continuationUserInputOverride;
    } else if (msg.type === 'message') {
      userInput = rawUserText;
    } else if (msg.type === 'tool_answer') {
      const ans = msg.answer;
      userInput = typeof ans === 'string' ? ans : JSON.stringify(ans ?? '');
    } else if (msg.type === 'gate_response') {
      userInput = msg.feedback ? `[Gate ${msg.action}] ${msg.feedback}` : `[Gate ${msg.action}]`;
    } else if (msg.type === 'proposal_response') {
      userInput = msg.feedback
        ? `[Proposal ${msg.action}] ${msg.feedback}`
        : `[Proposal ${msg.action}]`;
    } else {
      userInput = '';
    }

    const { history, filePreamble } = await prepareTurnHistory({
      session,
      fileStore: fileStoreService,
      ctx,
      sessionId: session.id,
      currentPhase: effectivePhase,
      excludedBlobIds: collectBlobIdsFromContent(structuredUserContent),
      persistHistorySummary: async (historySummary) =>
        persistHistorySummary(ctx, session.id, historySummary),
    });
    const userInputContent = await resolveUserContentForArchLlm({
      userContent: structuredUserContent,
      fileStore: fileStoreService,
      ctx,
      sessionId: session.id,
    });

    // 7. Build the service bag for this turn.
    const { buildServiceBagForTurn } = await import('@/lib/arch-ai/engine-factory');
    const services = buildServiceBagForTurn(buffer) as unknown as Record<string, unknown>;

    // Inject permissions into services so tools can check them.
    services.permissions = ctx.permissions;
    services.authToken = userAuthToken;
    services.pageContext = serverBoundPageContext;
    services.archMutationGuard = {
      requireApprovedPlanForMutation: true,
      approvedPlan:
        session.metadata.pendingPlan?.status === 'approved'
          ? {
              id: session.metadata.pendingPlan.id,
              projectId: session.metadata.pendingPlan.projectId,
              status: 'approved',
              plannedMutations: session.metadata.pendingPlan.plannedMutations,
            }
          : undefined,
    };

    const systemPrompt = [plan.systemPrompt, filePreamble, systemPromptAppendix]
      .filter((section): section is string => typeof section === 'string' && section.length > 0)
      .join('\n\n');

    // 8. Drive the turn via the TurnEngine.
    for await (const event of engine.runTurn({
      sessionId: session.id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      turnId,
      phase: effectivePhase,
      mode: engineMode,
      projectId: session.metadata.projectId,
      history,
      systemPrompt,
      userInput,
      userInputContent,
      userContent: structuredUserContent,
      allowedTools: allowedRegistry,
      buffer,
      signal: abortSignal,
      specialist: plan.specialist,
      routing: plan.routing,
      services,
      suppressUserMessage: msg.type === 'tool_answer',
      onToolCall: (info) => {
        emit({
          type: 'tool_call',
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          input: info.input ?? {},
        } as unknown as ArchSSEEvent);
        emit({
          type: 'tool_result',
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          result: info.result,
          isError: !info.ok,
        } as unknown as ArchSSEEvent);
      },
    })) {
      emitTurnEvent(event);
    }

    log.info('v4 processInProjectMessage complete', {
      sessionId: session.id,
      phase: effectivePhase,
      turnId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('v4 processInProjectMessage failed', {
      sessionId: session.id,
      phase: session.metadata.phase,
      msgType: msg.type,
      error: message,
    });
    const isModelConfigError = (err as { code?: string } | null)?.code === 'MODEL_CONFIG_ERROR';
    const userMessage = isModelConfigError
      ? message
      : 'An unexpected error occurred. Please try again.';
    emit({
      type: 'error',
      code: isModelConfigError ? 'MODEL_CONFIG_ERROR' : 'STREAM_ERROR',
      message: userMessage,
      retryable: !isModelConfigError,
    });
  } finally {
    close();
  }
}
