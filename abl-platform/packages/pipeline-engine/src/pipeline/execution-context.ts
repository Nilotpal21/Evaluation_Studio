/**
 * Execution context utilities for graph pipelines.
 *
 * Each node type writes its output to a well-known key (contextKey) in the
 * execution context. Downstream nodes read from context by key name,
 * decoupling data flow from node IDs.
 */

import type { PipelineStepContext, StepOutput } from './types.js';

/**
 * Derive a context key from a node type name by stripping the verb prefix
 * and converting kebab-case to camelCase.
 *
 * Returns null for non-producer types (store-*, node-group, etc.).
 */
export function deriveContextKey(nodeType: string): string | null {
  const producerPrefixes = ['read-', 'compute-', 'evaluate-', 'call-'];

  for (const prefix of producerPrefixes) {
    if (nodeType.startsWith(prefix)) {
      const suffix = nodeType.slice(prefix.length);
      return suffix.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    }
  }

  return null;
}

/**
 * Resolve input data for a service by context key.
 *
 * 1. Checks executionContext[key] (graph pipelines)
 * 2. Falls back to previousSteps[sourceStep].data (linear pipelines)
 * 3. When 'conversation' is requested but absent, checks 'messageWindow'
 *    and normalizes its shape so compute nodes work with either reader.
 *
 * Returns the data record or undefined if not available.
 */
export function resolveContextInput(
  input: PipelineStepContext,
  contextKey: string,
): Record<string, any> | undefined {
  // Graph mode: read from execution context
  if (input.executionContext && contextKey in input.executionContext) {
    return input.executionContext[contextKey];
  }

  // Linear mode: fall back to previousSteps with sourceStep config
  const sourceStep = (input.config.sourceStep as string) ?? 'read-conversation';
  const step = input.previousSteps[sourceStep];
  if (step?.status === 'success') {
    return step.data;
  }

  // Fallback: when 'conversation' is requested, check 'messageWindow' and normalize
  if (contextKey === 'conversation') {
    return normalizeMessageWindowToConversation(input);
  }

  return undefined;
}

/**
 * Normalize a messageWindow context into the conversation shape that compute
 * nodes expect ({ messages, transcript, toolCalls, escalations, metadata }).
 *
 * The triggeringMessage becomes the single entry in messages[]. Window messages
 * are prepended for context but the triggering message is always included.
 */
function normalizeMessageWindowToConversation(
  input: PipelineStepContext,
): Record<string, any> | undefined {
  const mw =
    (input.executionContext && input.executionContext['messageWindow']) ??
    (input.previousSteps['read-message-window']?.status === 'success'
      ? input.previousSteps['read-message-window'].data
      : undefined);

  if (!mw) return undefined;

  const triggeringMessage = mw.triggeringMessage as
    | { role: string; content: string; messageId: string; messageIndex: number }
    | undefined;

  if (!triggeringMessage) return undefined;

  const windowMessages = (mw.windowMessages ?? []) as Array<{
    messageId: string;
    role: string;
    content: string;
    timestamp: string;
    channel?: string;
  }>;

  const metadata = mw.metadata as
    | { agentName?: string; channel?: string; totalSessionMessages?: number }
    | undefined;

  // Combine window messages + triggering message in chronological order
  const messages = [
    ...windowMessages,
    {
      messageId: triggeringMessage.messageId,
      role: triggeringMessage.role,
      content: triggeringMessage.content,
      timestamp: (input.pipelineInput.timestamp as string) ?? new Date().toISOString(),
      channel: metadata?.channel,
    },
  ];

  return {
    messages,
    toolCalls: mw.toolCalls ?? [],
    escalations: [],
    metadata: {
      agentName: metadata?.agentName,
      channel: metadata?.channel,
      messageCount: messages.length,
    },
  };
}

/**
 * Write a node's output into the execution context under its contextKey.
 * For node-groups, extracts each child's output using derived context keys.
 *
 * @param context    The mutable execution context map
 * @param nodeType   The node's type (e.g., 'compute-sentiment')
 * @param result     The node's StepOutput
 * @param contextKey Explicit contextKey (from registry), or null/undefined to derive
 * @param children   For node-groups: child definitions to extract outputs from
 */
export function buildExecutionContext(
  context: Record<string, Record<string, any>>,
  nodeType: string,
  result: StepOutput,
  contextKey: string | null | undefined,
  children?: Array<{ id: string; type: string; config: Record<string, any> }>,
): void {
  // Node-group: extract each child's output into context
  if (nodeType === 'node-group' && children && result.status === 'success') {
    const childOutputs = result.data?.children as Record<string, StepOutput> | undefined;
    if (childOutputs) {
      for (const child of children) {
        const childKey = deriveContextKey(child.type);
        const childResult = childOutputs[child.id];
        if (childKey && childResult?.status === 'success') {
          context[childKey] = childResult.data;
        }
      }
    }
    return;
  }

  // Regular node: write under contextKey
  const key = contextKey ?? deriveContextKey(nodeType);
  if (key && result.status === 'success') {
    context[key] = result.data;
  }
}
