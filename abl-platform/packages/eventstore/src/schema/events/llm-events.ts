/**
 * LLM event schemas.
 *
 * Events related to LLM calls: completed, failed, model resolution.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── llm.call.completed ────────────────────────────────────────────────────

export const LLMCallCompletedDataSchema = z
  .object({
    model: z.string().optional(),
    provider: z.string().optional(),
    input_tokens: z.number().optional(),
    tokensIn: z.number().optional(),
    output_tokens: z.number().optional(),
    tokensOut: z.number().optional(),
    total_tokens: z.number().optional(),
    totalTokens: z.number().optional(),
    estimated_cost: z.number().optional(),
    estimatedCost: z.number().optional(),
    latency_ms: z.number().optional(),
    durationMs: z.number().optional(),
    streaming_used: z.boolean().optional(),
    streamingUsed: z.boolean().optional(),
    tool_call_count: z.number().optional(),
    toolCallCount: z.number().optional(),
    // Industry-standard fields (Helicone, OpenLLMetry, Portkey)
    time_to_first_token_ms: z.number().optional(),
    timeToFirstTokenMs: z.number().optional(),
    cache_creation_tokens: z.number().optional(),
    cacheCreationTokens: z.number().optional(),
    cache_read_tokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'error']).optional(),
    finishReason: z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'error']).optional(),
  })
  .passthrough();

export type LLMCallCompletedData = z.infer<typeof LLMCallCompletedDataSchema>;

eventRegistry.register('llm.call.completed', LLMCallCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.LLM,
  containsPII: true,
  description: 'LLM call succeeded',
});

// ─── llm.call.failed ───────────────────────────────────────────────────────

export const LLMCallFailedDataSchema = z
  .object({
    model: z.string().optional(),
    provider: z.string().optional(),
    error_type: z.string().optional(),
    errorType: z.string().optional(),
    error_message: z.string().optional(),
    errorMessage: z.string().optional(),
    latency_ms: z.number().optional(),
    durationMs: z.number().optional(),
    retry_attempt: z.number().optional(),
    retryAttempt: z.number().optional(),
  })
  .passthrough();

export type LLMCallFailedData = z.infer<typeof LLMCallFailedDataSchema>;

eventRegistry.register('llm.call.failed', LLMCallFailedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.LLM,
  containsPII: true,
  description: 'LLM call failed',
});

// ─── llm.model.resolved ────────────────────────────────────────────────────

export const LLMModelResolvedDataSchema = z
  .object({
    requested_model: z.string().optional(),
    requestedModel: z.string().optional(),
    resolved_model: z.string().optional(),
    resolvedModel: z.string().optional(),
    resolution_source: z.enum(['agent', 'project', 'tenant', 'env']).optional(),
    resolutionSource: z.enum(['agent', 'project', 'tenant', 'env']).optional(),
  })
  .passthrough();

export type LLMModelResolvedData = z.infer<typeof LLMModelResolvedDataSchema>;

eventRegistry.register('llm.model.resolved', LLMModelResolvedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.LLM,
  containsPII: false,
  description: 'LLM model resolved from config hierarchy',
});
