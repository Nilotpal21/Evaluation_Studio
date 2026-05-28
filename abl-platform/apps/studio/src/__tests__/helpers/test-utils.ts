/**
 * Integration Test Helpers
 *
 * Helper utilities for integration tests that test service boundaries
 * (fixtures → event-processor → assertions on output).
 */

import type { ExtendedTraceEvent } from '../../types';
import type {
  Interaction,
  ProcessedInteractions,
  SessionSummary,
} from '../../components/observatory/interactions/types';

/**
 * Assert that the processed interactions match expected count
 */
export function assertInteractionCount(processed: ProcessedInteractions, expected: number): void {
  if (processed.interactions.length !== expected) {
    throw new Error(`Expected ${expected} interactions, got ${processed.interactions.length}`);
  }
}

/**
 * Assert that session summary has expected token totals
 */
export function assertTokenTotals(
  summary: SessionSummary,
  expectedIn: number,
  expectedOut: number,
): void {
  if (summary.totalTokensIn !== expectedIn) {
    throw new Error(`Expected ${expectedIn} input tokens, got ${summary.totalTokensIn}`);
  }
  if (summary.totalTokensOut !== expectedOut) {
    throw new Error(`Expected ${expectedOut} output tokens, got ${summary.totalTokensOut}`);
  }
}

/**
 * Assert that agent path has expected length and sequence
 */
export function assertAgentPath(
  agentPath: Array<{ agentName: string; mode: string }>,
  expectedAgents: string[],
): void {
  if (agentPath.length !== expectedAgents.length) {
    throw new Error(`Expected agent path length ${expectedAgents.length}, got ${agentPath.length}`);
  }

  agentPath.forEach((node, i) => {
    if (node.agentName !== expectedAgents[i]) {
      throw new Error(
        `Expected agent at index ${i} to be "${expectedAgents[i]}", got "${node.agentName}"`,
      );
    }
  });
}

/**
 * Assert that an interaction has specific step types
 */
export function assertInteractionSteps(
  interaction: Interaction,
  expectedStepTypes: string[],
): void {
  if (interaction.steps.length !== expectedStepTypes.length) {
    throw new Error(`Expected ${expectedStepTypes.length} steps, got ${interaction.steps.length}`);
  }

  interaction.steps.forEach((step, i) => {
    if (step.type !== expectedStepTypes[i]) {
      throw new Error(`Expected step ${i} to be "${expectedStepTypes[i]}", got "${step.type}"`);
    }
  });
}

/**
 * Wait for event processing to complete (useful if testing async processing)
 * For synchronous processing, this is a no-op.
 */
export async function waitForProcessing(
  processFn: () => ProcessedInteractions,
  timeoutMs: number = 1000,
): Promise<ProcessedInteractions> {
  // For now, processEventsToInteractions is synchronous
  // This helper is a placeholder for future async processing
  return Promise.resolve(processFn());
}

/**
 * Find interaction by index
 */
export function findInteraction(
  processed: ProcessedInteractions,
  index: number,
): Interaction | undefined {
  return processed.interactions.find((i) => i.index === index);
}

/**
 * Count interactions with specific status
 */
export function countInteractionsByStatus(
  processed: ProcessedInteractions,
  status: 'ok' | 'warning' | 'error',
): number {
  return processed.interactions.filter((i) => i.status === status).length;
}

/**
 * Assert that LLM call count matches expected
 */
export function assertLLMCallCount(summary: SessionSummary, expected: number): void {
  if (summary.llmCallCount !== expected) {
    throw new Error(`Expected ${expected} LLM calls, got ${summary.llmCallCount}`);
  }
}

/**
 * Assert that tool call count matches expected
 */
export function assertToolCallCount(summary: SessionSummary, expected: number): void {
  if (summary.toolCallCount !== expected) {
    throw new Error(`Expected ${expected} tool calls, got ${summary.toolCallCount}`);
  }
}

/**
 * Extract token data from a single interaction
 */
export function extractInteractionTokens(interaction: Interaction): {
  inputTokens: number;
  outputTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;

  interaction.steps.forEach((step) => {
    if (step.type === 'llm_call' && step.data) {
      inputTokens += (step.data.tokensIn as number) ?? 0;
      outputTokens += (step.data.tokensOut as number) ?? 0;
    }
  });

  return { inputTokens, outputTokens };
}

/**
 * Sort events by timestamp (for test setup)
 */
export function sortEventsByTimestamp(events: ExtendedTraceEvent[]): ExtendedTraceEvent[] {
  return [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/**
 * Group events by session ID (for multi-session test setups)
 */
export function groupEventsBySession(
  events: ExtendedTraceEvent[],
): Map<string, ExtendedTraceEvent[]> {
  const grouped = new Map<string, ExtendedTraceEvent[]>();

  events.forEach((event) => {
    const sessionEvents = grouped.get(event.sessionId) ?? [];
    sessionEvents.push(event);
    grouped.set(event.sessionId, sessionEvents);
  });

  return grouped;
}
