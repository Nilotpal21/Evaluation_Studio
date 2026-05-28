import { DEFAULT_MESSAGES } from '@abl/compiler';
import type { AgentIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { ToolCall } from '../../llm/session-llm-client.js';
import { createIntentQueue, enqueueIntents } from '../intent-queue.js';
import type { RuntimeSession } from '../types.js';
import { resolveStrategy } from '../multi-intent-strategy.js';
import { interpolateTemplate } from '../value-resolution.js';
import { bridgeSupervisorToolCallToDetectedIntent } from '../../pipeline/intent-bridge.js';
import { canDeriveRouteFromIntentText } from '../../pipeline/runtime-contract.js';
import type {
  DetectedIntent,
  DetectedMultiIntentResult,
  MultiIntentDispatchResult,
  MultiIntentSource,
  PendingIntentSeed,
  ResolvedMultiIntentPlan,
} from './multi-intent-types.js';
import {
  resolveAgentExecutionType,
  resolveExecutableTarget,
  resolveIntentDisplayLabel,
  resolveMultiIntentConfig,
} from './multi-intent-types.js';

const log = createLogger('multi-intent-router');
const SUPPORTED_MULTI_INTENT_STRATEGIES = new Set([
  'primary_queue',
  'sequential',
  'parallel',
  'disambiguate',
]);

type OnTraceEvent = (event: { type: string; data: Record<string, unknown> }) => void;

interface ResolveMultiIntentPlanInput {
  sessionId?: string;
  agentName: string;
  agentIR: AgentIR;
  detected: DetectedMultiIntentResult;
  userMessage: string;
  sourceStep?: string;
  onTraceEvent?: OnTraceEvent;
  resolveMessage?: (messageKey: string, fallbackMessage?: string) => string;
}

interface ApplyMultiIntentPlanInput {
  session: RuntimeSession;
  plan: ResolvedMultiIntentPlan;
  onTraceEvent?: OnTraceEvent;
}

interface BuildSupervisorRoutingPlanInput {
  sessionId?: string;
  agentName: string;
  toolCalls: ToolCall[];
  userMessage: string;
  onTraceEvent?: OnTraceEvent;
}

function emitTrace(
  onTraceEvent: OnTraceEvent | undefined,
  type: string,
  data: Record<string, unknown>,
): void {
  if (!onTraceEvent) return;
  onTraceEvent({ type, data });
}

function emitDecision(onTraceEvent: OnTraceEvent | undefined, data: Record<string, unknown>): void {
  emitTrace(onTraceEvent, 'decision', data);
}

function toQueueEntry(
  intent: DetectedIntent,
  userMessage: string,
  sourceStep?: string,
): PendingIntentSeed {
  return {
    intent: resolveExecutableTarget(intent),
    confidence: intent.confidence,
    original_message: userMessage,
    label: resolveIntentDisplayLabel(intent),
    category: intent.category,
    summary: intent.summary,
    source: intent.source,
    target: intent.target,
    ...(sourceStep ? { sourceStep } : {}),
  };
}

function hasExecutableIntent(intent: DetectedIntent): boolean {
  return resolveExecutableTarget(intent).trim().length > 0;
}

function resolveFanOutTaskIntent(intent: DetectedIntent, userMessage: string): string {
  if (!canDeriveRouteFromIntentText(intent)) {
    return userMessage;
  }

  return intent.summary || userMessage;
}

function emitPlanTrace(
  input: ResolveMultiIntentPlanInput | BuildSupervisorRoutingPlanInput,
  plan: ResolvedMultiIntentPlan,
  targets: Array<{ label: string; executionTarget: string; kind: string | null }>,
): void {
  emitDecision(input.onTraceEvent, {
    type: 'multi_intent_target_resolved',
    sessionId: input.sessionId,
    agentName: input.agentName,
    source: plan.source,
    relationship: plan.relationship.type,
    targets,
  });

  emitDecision(input.onTraceEvent, {
    type: 'multi_intent_plan_built',
    sessionId: input.sessionId,
    agentName: input.agentName,
    strategy: plan.strategy,
    source: plan.source,
    relationship: plan.relationship.type,
    targetCount: targets.length,
    targets,
  });
}

export function filterDetectedMultiIntentAlternatives(
  detected: DetectedMultiIntentResult,
  confidenceThreshold: number,
): DetectedMultiIntentResult | null {
  const qualifiedAlternatives = detected.alternatives.filter(
    (intent) => intent.confidence >= confidenceThreshold,
  );

  if (qualifiedAlternatives.length === 0) {
    return null;
  }

  return {
    primary: detected.primary,
    alternatives: qualifiedAlternatives,
    relationships: detected.relationships,
  };
}

export function resolveDetectedMultiIntentPlan(
  input: ResolveMultiIntentPlanInput,
): ResolvedMultiIntentPlan {
  const config = resolveMultiIntentConfig(input.agentIR);
  const agentType = resolveAgentExecutionType(input.agentIR);
  const supervisorToolCallPlan = input.detected.primary.source === 'tool_call';
  const validAlternatives = input.detected.alternatives.filter(
    (intent) =>
      hasExecutableIntent(intent) && (!supervisorToolCallPlan || intent.source === 'tool_call'),
  );
  const allIntents = [input.detected.primary, ...validAlternatives];
  const executableIntents = allIntents.filter(hasExecutableIntent);

  let strategy = supervisorToolCallPlan
    ? 'parallel'
    : resolveStrategy(config.strategy, agentType, input.detected.relationships.type);
  if (strategy === 'auto' || !SUPPORTED_MULTI_INTENT_STRATEGIES.has(strategy)) {
    strategy = 'primary_queue';
  }

  if (
    strategy === 'parallel' &&
    executableIntents.some((intent) => intent.target?.kind !== 'agent')
  ) {
    strategy = 'sequential';
  }

  const fanOutTasks =
    strategy === 'parallel'
      ? executableIntents.map((intent) => ({
          target: resolveExecutableTarget(intent),
          intent: resolveFanOutTaskIntent(intent, input.userMessage),
          ...(intent.context ? { context: intent.context } : {}),
        }))
      : undefined;

  const queueEntries =
    strategy === 'primary_queue' || strategy === 'sequential'
      ? validAlternatives.map((intent) => toQueueEntry(intent, input.userMessage, input.sourceStep))
      : strategy === 'disambiguate'
        ? executableIntents
            .slice(0, config.max_intents)
            .map((intent) => toQueueEntry(intent, input.userMessage, input.sourceStep))
        : undefined;

  const disambiguationChoices =
    strategy === 'disambiguate'
      ? executableIntents.slice(0, config.max_intents).map((intent) => ({
          label: resolveIntentDisplayLabel(intent),
          intent: resolveExecutableTarget(intent),
          target: intent.target,
          category: intent.category,
          summary: intent.summary,
          confidence: intent.confidence,
          source: intent.source,
          ...(input.sourceStep ? { sourceStep: input.sourceStep } : {}),
        }))
      : undefined;

  const disambiguationMessage =
    strategy === 'disambiguate' && disambiguationChoices?.length
      ? (() => {
          const header =
            input.resolveMessage?.(
              'multi_intent_disambiguate_header',
              input.agentIR.messages?.multi_intent_disambiguate_header ||
                DEFAULT_MESSAGES.multi_intent_disambiguate_header,
            ) ||
            input.agentIR.messages?.multi_intent_disambiguate_header ||
            DEFAULT_MESSAGES.multi_intent_disambiguate_header;
          const optionTemplate =
            input.resolveMessage?.(
              'multi_intent_disambiguate_option',
              input.agentIR.messages?.multi_intent_disambiguate_option ||
                DEFAULT_MESSAGES.multi_intent_disambiguate_option,
            ) ||
            input.agentIR.messages?.multi_intent_disambiguate_option ||
            DEFAULT_MESSAGES.multi_intent_disambiguate_option;
          const options = disambiguationChoices.map((choice, idx) =>
            interpolateTemplate(optionTemplate, {
              index: String(idx + 1),
              intent: choice.label,
              confidence: String(Math.round(choice.confidence * 100)),
            }),
          );
          return [header, '', ...options].join('\n');
        })()
      : undefined;

  const executionPlan =
    strategy === 'sequential'
      ? validAlternatives.map((intent) => ({
          intent: resolveIntentDisplayLabel(intent),
          confidence: intent.confidence,
        }))
      : undefined;

  const plan: ResolvedMultiIntentPlan = {
    strategy,
    primary: input.detected.primary,
    alternatives: validAlternatives,
    relationship: input.detected.relationships,
    source: input.detected.primary.source,
    maxIntents: config.max_intents,
    ...(fanOutTasks ? { fanOutTasks } : {}),
    ...(queueEntries ? { queueEntries } : {}),
    ...(disambiguationChoices ? { disambiguationChoices } : {}),
    ...(disambiguationMessage ? { disambiguationMessage } : {}),
    ...(executionPlan ? { executionPlan } : {}),
  };

  const targets = executableIntents.map((intent) => ({
    label: resolveIntentDisplayLabel(intent),
    executionTarget: resolveExecutableTarget(intent),
    kind: intent.target?.kind ?? null,
  }));

  log.debug('Resolved multi-intent plan', {
    sessionId: input.sessionId,
    agentName: input.agentName,
    strategy,
    relationship: input.detected.relationships.type,
    source: plan.source,
    targets,
  });

  emitPlanTrace(input, plan, targets);

  return plan;
}

export function applyResolvedMultiIntentPlan(
  input: ApplyMultiIntentPlanInput,
): MultiIntentDispatchResult {
  const { session, plan, onTraceEvent } = input;

  if (!session.intentQueue) {
    session.intentQueue = createIntentQueue();
  }

  delete session.data.values._disambiguation_choices;
  delete session.data.values._disambiguation_intents;
  delete session.data.values._disambiguation_original_message;

  if (
    (plan.strategy === 'primary_queue' ||
      plan.strategy === 'sequential' ||
      plan.strategy === 'disambiguate') &&
    plan.queueEntries?.length
  ) {
    enqueueIntents(session.intentQueue, plan.queueEntries, plan.maxIntents);
  }

  switch (plan.strategy) {
    case 'primary_queue': {
      emitDecision(onTraceEvent, {
        type: 'multi_intent_queued',
        agentName: session.agentName,
        primaryIntent: plan.primary.intent,
        queuedIntents: (plan.queueEntries ?? []).map((entry) => entry.intent),
        queueSize: session.intentQueue.pending.length,
      });
      emitDecision(onTraceEvent, {
        type: 'multi_intent_queue_seeded',
        sessionId: session.id,
        agentName: session.agentName,
        strategy: plan.strategy,
        source: plan.source,
        relationship: plan.relationship.type,
        queueEntries: (plan.queueEntries ?? []).map((entry) => ({
          intent: entry.intent,
          label: entry.label,
          target: entry.target?.ref ?? null,
        })),
      });
      break;
    }

    case 'sequential': {
      emitDecision(onTraceEvent, {
        type: 'multi_intent_sequential',
        agentName: session.agentName,
        primaryIntent: plan.primary.intent,
        executionPlan: plan.executionPlan ?? [],
        queueSize: session.intentQueue.pending.length,
      });
      emitDecision(onTraceEvent, {
        type: 'multi_intent_queue_seeded',
        sessionId: session.id,
        agentName: session.agentName,
        strategy: plan.strategy,
        source: plan.source,
        relationship: plan.relationship.type,
        queueEntries: (plan.queueEntries ?? []).map((entry) => ({
          intent: entry.intent,
          label: entry.label,
          target: entry.target?.ref ?? null,
        })),
      });
      break;
    }

    case 'parallel': {
      emitDecision(onTraceEvent, {
        type: 'multi_intent_parallel',
        agentName: session.agentName,
        fanOutTasks: plan.fanOutTasks ?? [],
        taskCount: plan.fanOutTasks?.length ?? 0,
      });
      break;
    }

    case 'disambiguate': {
      session.waitingForInput = ['_disambiguation_choice'];
      session.data.values._disambiguation_choices = plan.disambiguationChoices ?? [];
      session.data.values._disambiguation_intents = (plan.disambiguationChoices ?? []).map(
        (choice) => choice.label,
      );
      const originalMessage = plan.queueEntries?.[0]?.original_message;
      if (originalMessage) {
        session.data.values._disambiguation_original_message = originalMessage;
      }

      emitDecision(onTraceEvent, {
        type: 'multi_intent_disambiguate',
        agentName: session.agentName,
        intents: (plan.disambiguationChoices ?? []).map((choice) => ({
          intent: choice.label,
          confidence: choice.confidence,
          target: choice.target?.ref ?? null,
        })),
        message: plan.disambiguationMessage,
      });
      emitDecision(onTraceEvent, {
        type: 'multi_intent_disambiguation_requested',
        sessionId: session.id,
        agentName: session.agentName,
        strategy: plan.strategy,
        source: plan.source,
        relationship: plan.relationship.type,
        choices: (plan.disambiguationChoices ?? []).map((choice) => ({
          label: choice.label,
          intent: choice.intent,
          target: choice.target?.ref ?? null,
        })),
      });
      break;
    }
  }

  return {
    strategy: plan.strategy,
    primaryIntent: plan.primary.intent,
    queued:
      (plan.strategy === 'primary_queue' || plan.strategy === 'sequential') &&
      (plan.queueEntries?.length ?? 0) > 0,
    ...(plan.disambiguationMessage ? { disambiguationMessage: plan.disambiguationMessage } : {}),
    ...(plan.fanOutTasks
      ? {
          fanOutTasks: plan.fanOutTasks.map((task) => ({
            target: task.target,
            intent: task.intent,
            ...(task.context ? { context: task.context } : {}),
          })),
        }
      : {}),
    ...(plan.executionPlan ? { executionPlan: plan.executionPlan } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toToolCallIntent(toolCall: ToolCall, userMessage: string): DetectedIntent | null {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const targetFromInput = typeof input.target === 'string' ? input.target : undefined;
  const target =
    toolCall.name.startsWith('handoff_to_') || toolCall.name.startsWith('delegate_to_')
      ? toolCall.name.replace(/^(handoff_to_|delegate_to_)/, '')
      : targetFromInput;

  if (!target) {
    return null;
  }

  const message =
    typeof input.message === 'string' && input.message.trim() ? input.message : userMessage;
  const context = isRecord(input.context) ? input.context : undefined;

  return bridgeSupervisorToolCallToDetectedIntent({
    target,
    message,
    userMessage,
    ...(context ? { context } : {}),
  });
}

export function buildSupervisorRoutingToolFanOutPlan(
  input: BuildSupervisorRoutingPlanInput,
): ResolvedMultiIntentPlan | null {
  const detected = input.toolCalls.map((toolCall) => toToolCallIntent(toolCall, input.userMessage));
  const intents = detected.filter((intent): intent is DetectedIntent => intent !== null);

  if (intents.length < 2) {
    return null;
  }

  const plan: ResolvedMultiIntentPlan = {
    strategy: 'parallel',
    primary: intents[0],
    alternatives: intents.slice(1),
    relationship: {
      type: 'independent',
      reasoning: 'Multiple routing tool calls emitted in the same LLM turn',
    },
    source: 'tool_call',
    maxIntents: intents.length,
    fanOutTasks: intents.map((intent) => ({
      target: resolveExecutableTarget(intent),
      intent: resolveFanOutTaskIntent(intent, input.userMessage),
      ...(intent.context ? { context: intent.context } : {}),
    })),
  };

  const targets = intents.map((intent) => ({
    label: resolveIntentDisplayLabel(intent),
    executionTarget: resolveExecutableTarget(intent),
    kind: intent.target?.kind ?? null,
  }));

  log.debug('Built supervisor routing fan-out plan from tool calls', {
    sessionId: input.sessionId,
    agentName: input.agentName,
    targetCount: targets.length,
    targets,
  });

  emitPlanTrace(input, plan, targets);

  return plan;
}
