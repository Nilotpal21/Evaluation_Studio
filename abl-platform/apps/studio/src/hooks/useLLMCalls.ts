/**
 * useLLMCalls Hook
 *
 * Filters and transforms LLM call events from the trace store
 * with aggregate metrics.
 */

import { useMemo } from 'react';
import { useObservatoryStore } from '../store/observatory-store';
import { estimateLLMCost } from '../utils/llm-cost';

/** A content block within a message (text, tool_use, or tool_result) */
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: string }; // fallback for unknown block types

/** A message in the LLM conversation — content may be a plain string or structured blocks */
export interface LLMMessage {
  role: string;
  content: string | MessageContentBlock[];
}

export interface LLMCall {
  id: string;
  timestamp: Date;
  model: string;
  agentName: string; // Which agent made this call
  purpose?: string; // What the call was for: extraction, response_gen, field_validation, routing
  provider?: string; // LLM provider: anthropic, openai, etc.
  messages: LLMMessage[];
  response: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cost: number;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: unknown;
    result?: unknown;
  }>;
  // Raw API payloads
  rawRequest?: unknown;
  rawResponse?: unknown;
  // System prompt and tool definitions from trace event
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  // LLM call options — provider-level settings sent with the request
  llmOptions?: {
    disableParallelToolUse?: boolean;
    toolChoice?: unknown;
  };
}

export interface LLMCallMetrics {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  avgLatencyMs: number;
}

export function useLLMCalls() {
  const events = useObservatoryStore((state) => state.events);

  const { calls, metrics } = useMemo(() => {
    const llmCalls: LLMCall[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let totalLatency = 0;

    for (const event of events) {
      if (event.type !== 'llm_call') continue;

      const data = event.data as any;
      const inputTokens = data.usage?.inputTokens || data.inputTokens || data.tokensIn || 0;
      const outputTokens = data.usage?.outputTokens || data.outputTokens || data.tokensOut || 0;
      const latencyMs =
        data.durationMs || data.latencyMs || data.latency_ms || event.durationMs || 0;
      const cost = data.cost || estimateLLMCost(data.model || '', inputTokens, outputTokens);

      // Extract messages - handle different formats
      let messages = data.messages || [];

      // If no messages, try to construct from prompt
      if (messages.length === 0 && data.prompt) {
        messages = [{ role: 'user', content: data.prompt }];
      }

      // Extract response - check multiple fields
      const response = data.response || data.text || data.content || '';

      // Extract LLM options (disableParallelToolUse, toolChoice) from trace event
      const llmOptions: LLMCall['llmOptions'] =
        data.disableParallelToolUse || data.toolChoice
          ? {
              ...(data.disableParallelToolUse && { disableParallelToolUse: true }),
              ...(data.toolChoice && { toolChoice: data.toolChoice }),
            }
          : undefined;

      const call: LLMCall = {
        id: event.id,
        timestamp: event.timestamp,
        model: data.model || 'unknown',
        agentName: event.agentName || 'unknown',
        purpose: data.purpose || data.operationType,
        provider: data.provider,
        messages,
        response,
        inputTokens,
        outputTokens,
        latencyMs,
        cost,
        toolCalls: data.toolCalls,
        rawRequest: data.rawRequest,
        rawResponse: data.rawResponse,
        systemPrompt: data.systemPrompt,
        tools: data.tools,
        llmOptions,
      };

      llmCalls.push(call);

      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      totalCost += cost;
      totalLatency += latencyMs;
    }

    // Sort by timestamp (newest first)
    llmCalls.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Limit to last 100 calls to prevent memory issues
    const limitedCalls = llmCalls.slice(0, 100);

    const metrics: LLMCallMetrics = {
      totalCalls: llmCalls.length,
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      avgLatencyMs: llmCalls.length > 0 ? totalLatency / llmCalls.length : 0,
    };

    return { calls: limitedCalls, metrics };
  }, [events]);

  return { calls, metrics };
}
