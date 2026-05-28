/**
 * LLM Cost Estimation Utility
 *
 * Thin wrapper around the shared MODEL_PRICING table.
 * The canonical pricing data lives in @agent-platform/shared/model-pricing.
 */

import { estimateCost, MODEL_PRICING } from '@agent-platform/shared/model-pricing';

/**
 * Estimate the cost of an LLM call
 * @param model - Model ID or name
 * @param tokensIn - Input tokens
 * @param tokensOut - Output tokens
 * @returns Cost in dollars
 */
export function estimateLLMCost(model: string, tokensIn: number, tokensOut: number): number {
  return estimateCost(model, tokensIn, tokensOut);
}

// Re-export for consumers that need the pricing table directly
export { MODEL_PRICING };

/**
 * Format cost as a readable string
 * @param cost - Cost in dollars
 * @returns Formatted cost string (e.g., "$0.0024" or "$1.23")
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Get model display name from model ID
 * @param modelId - Full model ID
 * @returns Short display name
 */
export function getModelDisplayName(modelId: string): string {
  if (modelId.includes('opus-4')) return 'Opus 4';
  if (modelId.includes('sonnet-4')) return 'Sonnet 4';
  if (modelId.includes('3-5-sonnet') || modelId.includes('3.5-sonnet')) return 'Sonnet 3.5';
  if (
    modelId.includes('haiku-4-5') ||
    modelId.includes('3-5-haiku') ||
    modelId.includes('3.5-haiku')
  )
    return 'Haiku 4.5';
  if (modelId.includes('haiku')) return 'Haiku';
  if (modelId.includes('sonnet')) return 'Sonnet';
  if (modelId.includes('opus')) return 'Opus';
  return modelId;
}

/**
 * Serialize an LLM call for clipboard copy.
 * Groups fields into request/response mirroring the UI layout.
 */
export function serializeLLMCallForCopy(call: {
  id: string;
  timestamp: Date;
  model: string;
  agentName: string;
  messages: Array<{ role: string; content: unknown }>;
  response: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cost: number;
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  toolCalls?: Array<{ id: string; name: string; input: unknown; result?: unknown }>;
  rawRequest?: unknown;
  rawResponse?: unknown;
}): Record<string, unknown> {
  return {
    id: call.id,
    timestamp: call.timestamp.toISOString(),
    model: call.model,
    agentName: call.agentName,
    request: call.rawRequest || {
      model: call.model,
      ...(call.systemPrompt ? { system: call.systemPrompt } : {}),
      messages: call.messages,
      ...(call.tools?.length ? { tools: call.tools } : {}),
    },
    response: call.rawResponse || {
      content: call.response,
      ...(call.toolCalls?.length ? { tool_calls: call.toolCalls } : {}),
      latencyMs: call.latencyMs,
      usage: {
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cost: call.cost,
      },
    },
  };
}
