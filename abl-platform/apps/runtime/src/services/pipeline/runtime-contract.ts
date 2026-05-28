/**
 * Pipeline runtime contract helpers.
 *
 * These helpers keep two behavioral contracts explicit and testable:
 *   1. When running the classifier is actionable for the current agent.
 *   2. Which bounded conversation turns are passed into classifier prompts.
 */

import type { IntentCategory } from '@abl/compiler/platform/ir/schema.js';
import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';

export const MAX_CLASSIFIER_CONTEXT_MESSAGES = 4;

export interface PipelineConversationMessage {
  role: string;
  content: string | ContentBlock[];
}

export interface ClassifierConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ClassifierRuntimeContext {
  currentMessage: string;
  recentConversation: ClassifierConversationTurn[];
}

export type PipelineClassifierDecisionReason =
  | 'actionable'
  | 'no_categories'
  | 'no_control_flow_consumers'
  | 'supervisor_tool_call';

export interface PipelineClassifierDecision {
  shouldRun: boolean;
  reason: PipelineClassifierDecisionReason;
}

export interface SourceAwareRouteIntent {
  source?: string | null;
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  return content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

function normalizeConversation(
  conversationHistory: PipelineConversationMessage[],
): ClassifierConversationTurn[] {
  return conversationHistory.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }

    const text = contentToText(message.content);
    if (!text) {
      return [];
    }

    const role: ClassifierConversationTurn['role'] = message.role === 'user' ? 'user' : 'assistant';
    return [{ role, text }];
  });
}

function getLatestUserText(conversationHistory: PipelineConversationMessage[]): string {
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const message = conversationHistory[i];
    if (message.role !== 'user') {
      continue;
    }

    const text = contentToText(message.content);
    if (text) {
      return text;
    }
  }

  return '';
}

/**
 * source=tool_call intents represent a completed supervisor routing decision;
 * downstream code MUST NOT keyword-scan their summary/text to derive a different
 * agent target.
 */
export function isSupervisorToolCallRouteIntent(
  intent: SourceAwareRouteIntent | null | undefined,
): boolean {
  return intent?.source === 'tool_call';
}

/**
 * Source-aware guard for classifier and keyword routing paths. Consumers may
 * inspect natural-language text for pipeline/reasoning/flow intents, but a
 * source=tool_call intent is already classified by the supervisor.
 */
export function canDeriveRouteFromIntentText(
  intent: SourceAwareRouteIntent | null | undefined,
): boolean {
  return !isSupervisorToolCallRouteIntent(intent);
}

/**
 * Resolve the current classifier input and a bounded prior conversation window.
 *
 * For handoff-target agents, `_raw_input` is the real user message and the last
 * user history entry is usually the synthesized handoff summary. We keep the raw
 * input as the current message and exclude the latest user entry from the
 * bounded history window so the classifier does not see the summary as context.
 */
export function resolveClassifierRuntimeContext(input: {
  conversationHistory: PipelineConversationMessage[];
  currentInput?: string;
  rawInput?: string;
  handoffFrom?: string;
  maxMessages?: number;
}): ClassifierRuntimeContext {
  const normalizedConversation = normalizeConversation(input.conversationHistory);
  const currentMessage =
    typeof input.currentInput === 'string' && input.currentInput.trim() !== ''
      ? input.currentInput
      : input.handoffFrom && input.rawInput
        ? input.rawInput
        : getLatestUserText(input.conversationHistory);

  let latestUserIndex = -1;
  for (let i = normalizedConversation.length - 1; i >= 0; i--) {
    if (normalizedConversation[i].role === 'user') {
      latestUserIndex = i;
      break;
    }
  }

  const priorConversation =
    latestUserIndex >= 0
      ? normalizedConversation.filter((_, index) => index !== latestUserIndex)
      : normalizedConversation;

  return {
    currentMessage,
    recentConversation: priorConversation.slice(
      -(input.maxMessages ?? MAX_CLASSIFIER_CONTEXT_MESSAGES),
    ),
  };
}

/**
 * The classifier is actionable when the agent has declared classifier
 * categories and the pipeline has at least one consumer that can change
 * control flow or seed intent-aware behavior.
 *
 * Today those consumers are:
 *   - routing rules that can be resolved programmatically
 *   - the intent bridge, which can drive out-of-scope decline, guided mode,
 *     and session intent state used by later conditional handling
 *
 * Agents that fail this check still rely on the reasoning loop for
 * out-of-scope handling such as `__return_to_parent__`.
 */
export function shouldRunPipelineClassifier(input: {
  categories: IntentCategory[];
  routingRules: Array<{ to: string; when?: string }>;
  intentBridgeEnabled: boolean;
  currentIntent?: SourceAwareRouteIntent | null;
}): PipelineClassifierDecision {
  if (isSupervisorToolCallRouteIntent(input.currentIntent)) {
    return { shouldRun: false, reason: 'supervisor_tool_call' };
  }

  if (input.categories.length === 0) {
    return { shouldRun: false, reason: 'no_categories' };
  }

  if (input.routingRules.length === 0 && !input.intentBridgeEnabled) {
    return { shouldRun: false, reason: 'no_control_flow_consumers' };
  }

  return { shouldRun: true, reason: 'actionable' };
}
