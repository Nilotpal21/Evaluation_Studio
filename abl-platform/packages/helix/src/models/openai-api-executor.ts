/**
 * OpenAI API executor for HELIX model routing.
 *
 * Implements the ModelExecutor interface using the OpenAI SDK for
 * streaming chat completions with structured output support.
 * Follows the same patterns as ClaudeSdkExecutor (dynamic import,
 * stall detection, abort propagation, cost extraction).
 *
 * Error contract: execute() NEVER throws to the caller. All errors
 * are returned via ExecutorResult.error (error-as-data contract).
 * The only internal throw is BudgetExceededError, which is caught
 * inside execute() and converted to an error string.
 */

import {
  getStageOutputSchemaDocument,
  buildStageOutputInstructions,
} from '../pipeline/stage-output-schema.js';
import type {
  ExecutorResult,
  ModelExecutor,
  ModelEngine,
  ModelSpec,
  StageOutputSchemaConfig,
  StreamEvent,
  WorkspaceExecutionContext,
} from '../types.js';
import { BudgetExceededError } from './executor-errors.js';

// ─── Pricing Table ─────────────────────────────────────────────
// Plain Record — NEVER use a hash-map constructor in helix source.

interface ModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  reasoningUsdPer1M?: number;
}

export const MODEL_PRICING_USD: Record<string, ModelPricing> = {
  'gpt-5': {
    inputUsdPer1M: 10.0,
    outputUsdPer1M: 30.0,
    reasoningUsdPer1M: 30.0,
  },
  'gpt-5.5': {
    inputUsdPer1M: 2.0,
    outputUsdPer1M: 8.0,
    reasoningUsdPer1M: 8.0,
  },
  'gpt-4o': {
    inputUsdPer1M: 2.5,
    outputUsdPer1M: 10.0,
  },
  'gpt-4o-mini': {
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.6,
  },
};

// ─── OpenAI Client Abstraction ─────────────────────────────────

/**
 * Minimal subset of the OpenAI SDK surface used by this executor.
 * Enables test-time injection of a fake client without mocking
 * the SDK module.
 */
export interface OpenAiClientLike {
  chat: {
    completions: {
      create(
        params: Record<string, unknown>,
      ): Promise<OpenAiChatCompletionLike | AsyncIterable<OpenAiStreamChunkLike>>;
    };
  };
}

export interface OpenAiStreamChunkLike {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

export interface OpenAiChatCompletionLike {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      refusal?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

export type OpenAiClientFactory = () => Promise<OpenAiClientLike>;

/**
 * Default factory: dynamic-imports the OpenAI SDK and creates
 * a client using OPENAI_API_KEY from the environment.
 */
async function defaultOpenAiClientFactory(): Promise<OpenAiClientLike> {
  const { default: OpenAI } = await import('openai');
  return new OpenAI() as unknown as OpenAiClientLike;
}

// ─── Constants ─────────────────────────────────────────────────

/** Default stall threshold: if no streaming activity for this long, abort. */
const DEFAULT_STALL_THRESHOLD_MS = 10 * 60_000; // 10 minutes
const STALL_CHECK_INTERVAL_MS = 15_000; // check every 15s

/**
 * Regex patterns for secrets that should never appear in stream events.
 * Matches common API key / token prefixes.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /xoxb-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9_]{36,}/g,
  /gho_[A-Za-z0-9_]{36,}/g,
  /Bearer\s+[A-Za-z0-9_.+/=-]{20,}/gi,
];

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Redact potential secrets from a message string.
 */
function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Compute cost from token usage and the pricing table.
 * Returns undefined for unknown models (with a stderr warning).
 */
function computeCostUsd(
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      }
    | null
    | undefined,
  model: string,
): number | undefined {
  if (!usage) return undefined;

  const pricing = MODEL_PRICING_USD[model];
  if (!pricing) {
    process.stderr.write(
      `[helix:openai-api] Unknown model "${model}" — cost tracking unavailable for this call\n`,
    );
    return undefined;
  }

  const inputTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const nonReasoningOutputTokens = completionTokens - reasoningTokens;

  let cost = (inputTokens / 1_000_000) * pricing.inputUsdPer1M;
  cost += (nonReasoningOutputTokens / 1_000_000) * pricing.outputUsdPer1M;
  if (pricing.reasoningUsdPer1M != null && reasoningTokens > 0) {
    cost += (reasoningTokens / 1_000_000) * pricing.reasoningUsdPer1M;
  }

  return cost;
}

/**
 * Map an OpenAI SSE streaming chunk to a HELIX StreamEvent.
 * Returns null if the chunk has no meaningful content to emit.
 */
export function mapSseDeltaToStreamEvent(
  chunk: OpenAiStreamChunkLike,
  turnsUsed: number,
): StreamEvent | null {
  const choice = chunk.choices?.[0];
  if (!choice) {
    // Usage-only chunk at end of stream — no event to emit
    return null;
  }

  const delta = choice.delta;
  if (!delta) return null;

  const reasoning = delta.reasoning;
  if (reasoning) {
    return {
      type: 'progress',
      timestamp: new Date().toISOString(),
      message: redactSecrets(`[turn ${turnsUsed}] thinking...`),
    };
  }

  const content = delta.content;
  if (content) {
    const preview = content.slice(0, 200).replace(/\n/g, ' ');
    return {
      type: 'output',
      timestamp: new Date().toISOString(),
      message: redactSecrets(`[turn ${turnsUsed}] ${preview}${content.length > 200 ? '...' : ''}`),
    };
  }

  if (choice.finish_reason) {
    return {
      type: 'complete',
      timestamp: new Date().toISOString(),
      message: `Completed (finish_reason: ${choice.finish_reason})`,
    };
  }

  return null;
}

// ─── Executor ──────────────────────────────────────────────────

export class OpenAiApiExecutor implements ModelExecutor {
  readonly engine: ModelEngine = 'openai-api';
  private accumulatedCostUsd = 0;

  constructor(
    private readonly workDir: string,
    private readonly clientFactory: OpenAiClientFactory = defaultOpenAiClientFactory,
  ) {}

  setWorkspaceContext?(_ctx?: WorkspaceExecutionContext): void {
    // OpenAI API executor does not use workspace context today.
    // Placeholder for future workspace-aware prompt injection.
  }

  async isAvailable(): Promise<boolean> {
    const key = process.env.OPENAI_API_KEY;
    return typeof key === 'string' && key.length > 0;
  }

  async execute(
    prompt: string,
    spec: ModelSpec,
    tools?: string[],
    onStream?: (event: StreamEvent) => void,
    outputSchema?: StageOutputSchemaConfig,
    timeoutMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<ExecutorResult> {
    const startTime = Date.now();
    const model = spec.model ?? 'gpt-5';

    // ── Budget pre-check ─────────────────────────────────────
    if (spec.maxBudgetUsd != null && this.accumulatedCostUsd >= spec.maxBudgetUsd) {
      const err = new BudgetExceededError(spec.maxBudgetUsd, this.accumulatedCostUsd);
      return {
        output: '',
        model,
        engine: 'openai-api',
        turnsUsed: 0,
        durationMs: Date.now() - startTime,
        costUsd: 0,
        error: `BudgetExceededError: ${err.message}`,
      };
    }

    // ── Dynamic SDK import (per-call, matching claude-sdk-executor:124) ──
    let client: OpenAiClientLike;
    try {
      client = await this.clientFactory();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        output: '',
        model,
        engine: 'openai-api',
        turnsUsed: 0,
        durationMs: Date.now() - startTime,
        error: `Failed to initialize OpenAI client: ${errorMsg}`,
      };
    }

    // ── Build messages ───────────────────────────────────────
    const messages: Array<Record<string, unknown>> = [];

    if (spec.systemPrompt) {
      messages.push({ role: 'system', content: spec.systemPrompt });
    }

    let userContent = prompt;
    if (outputSchema) {
      const instructions = buildStageOutputInstructions(outputSchema);
      userContent = `${prompt}\n\n${instructions}`;
    }
    messages.push({ role: 'user', content: userContent });

    // ── Request parameters ───────────────────────────────────
    const params: Record<string, unknown> = {
      model,
      messages,
    };

    if (spec.maxTurns != null) {
      params['max_completion_tokens'] = spec.maxTurns * 4096;
    }

    // Native structured output (D-4)
    if (outputSchema?.id) {
      const schemaDoc = getStageOutputSchemaDocument(outputSchema);
      if (schemaDoc) {
        params['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: outputSchema.id.replace(/-/g, '_'),
            schema: schemaDoc,
            strict: outputSchema.strict ?? false,
          },
        };
      }
    }

    if (spec.effort) {
      params['reasoning'] = { effort: spec.effort };
    }

    // ── Execute ──────────────────────────────────────────────
    try {
      const useStreaming = onStream != null;

      if (useStreaming) {
        return await this.executeStreaming(
          client,
          params,
          model,
          spec,
          startTime,
          onStream,
          timeoutMs,
          abortSignal,
        );
      } else {
        return await this.executeNonStreaming(client, params, model, spec, startTime, abortSignal);
      }
    } catch (err) {
      // Catch-all: convert any unexpected error to error-as-data
      if (err instanceof BudgetExceededError) {
        return {
          output: '',
          model,
          engine: 'openai-api',
          turnsUsed: 1,
          durationMs: Date.now() - startTime,
          costUsd: this.accumulatedCostUsd,
          error: `BudgetExceededError: ${err.message}`,
        };
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      onStream?.({
        type: 'error',
        timestamp: new Date().toISOString(),
        message: redactSecrets(`OpenAI API error: ${errorMsg}`),
      });

      return {
        output: '',
        model,
        engine: 'openai-api',
        turnsUsed: 0,
        durationMs: Date.now() - startTime,
        error: redactSecrets(`OpenAI API error: ${errorMsg}`),
      };
    }
  }

  // ── Streaming execution ──────────────────────────────────
  private async executeStreaming(
    client: OpenAiClientLike,
    params: Record<string, unknown>,
    model: string,
    spec: ModelSpec,
    startTime: number,
    onStream: (event: StreamEvent) => void,
    timeoutMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<ExecutorResult> {
    params['stream'] = true;
    params['stream_options'] = { include_usage: true };

    const response = await client.chat.completions.create(params);

    // The streaming response is an async iterable
    const stream = response as AsyncIterable<OpenAiStreamChunkLike>;

    const contentChunks: string[] = [];
    let turnsUsed = 1; // Single API call = 1 turn
    let lastUsage: OpenAiStreamChunkLike['usage'] = null;
    let stalled = false;
    let aborted = false;
    let lastActivityTime = Date.now();

    // ── Stall detection ────────────────────────────────────
    const stallThresholdMs = timeoutMs ?? spec.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;

    const stallCheck = setInterval(() => {
      if (stalled || aborted) return;
      const silenceMs = Date.now() - lastActivityTime;
      if (silenceMs >= stallThresholdMs) {
        stalled = true;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        onStream({
          type: 'error',
          timestamp: new Date().toISOString(),
          message: `OpenAI stream stalled after ${Math.ceil(silenceMs / 1000)}s of inactivity (${elapsed}s total elapsed)`,
        });
      }
    }, STALL_CHECK_INTERVAL_MS);

    // ── Abort handling ─────────────────────────────────────
    const abortListener = (): void => {
      if (stalled || aborted) return;
      aborted = true;
      onStream({
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'OpenAI request aborted by caller',
      });
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        abortListener();
      } else {
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }
    }

    try {
      for await (const chunk of stream) {
        if (stalled || aborted) break;

        lastActivityTime = Date.now();

        // Extract usage from the final chunk
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }

        const event = mapSseDeltaToStreamEvent(chunk, turnsUsed);
        if (event) {
          onStream(event);
        }

        // Accumulate content
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          contentChunks.push(content);
        }
      }
    } finally {
      clearInterval(stallCheck);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortListener);
      }
    }

    const output = contentChunks.join('');
    const durationMs = Date.now() - startTime;
    const costUsd = computeCostUsd(lastUsage, model);

    if (costUsd != null) {
      this.accumulatedCostUsd += costUsd;
    }

    // ── Post-call budget check ─────────────────────────────
    if (spec.maxBudgetUsd != null && this.accumulatedCostUsd > spec.maxBudgetUsd) {
      const budgetErr = new BudgetExceededError(spec.maxBudgetUsd, this.accumulatedCostUsd);
      return {
        output,
        model,
        engine: 'openai-api',
        turnsUsed,
        durationMs,
        costUsd,
        error: `BudgetExceededError: ${budgetErr.message}`,
      };
    }

    if (stalled) {
      return {
        output: output || '(no output captured)',
        model,
        engine: 'openai-api',
        turnsUsed,
        durationMs,
        costUsd,
        error: `OpenAI stream stalled after ${Math.ceil((Date.now() - lastActivityTime) / 1000)}s of inactivity`,
        timedOut: true,
      };
    }

    if (aborted) {
      return {
        output: output || '(no output captured)',
        model,
        engine: 'openai-api',
        turnsUsed,
        durationMs,
        costUsd,
        error: 'OpenAI request aborted by caller',
      };
    }

    return {
      output,
      model,
      engine: 'openai-api',
      turnsUsed,
      durationMs,
      costUsd,
    };
  }

  // ── Non-streaming execution ──────────────────────────────
  private async executeNonStreaming(
    client: OpenAiClientLike,
    params: Record<string, unknown>,
    model: string,
    spec: ModelSpec,
    startTime: number,
    abortSignal?: AbortSignal,
  ): Promise<ExecutorResult> {
    if (abortSignal?.aborted) {
      return {
        output: '',
        model,
        engine: 'openai-api',
        turnsUsed: 0,
        durationMs: Date.now() - startTime,
        error: 'OpenAI request aborted by caller before execution',
      };
    }

    const response = (await client.chat.completions.create(params)) as OpenAiChatCompletionLike;

    const durationMs = Date.now() - startTime;
    const choice = response.choices?.[0];
    const output = choice?.message?.content ?? '';
    const refusal = choice?.message?.refusal;
    const costUsd = computeCostUsd(response.usage, model);

    if (costUsd != null) {
      this.accumulatedCostUsd += costUsd;
    }

    // ── Post-call budget check ─────────────────────────────
    if (spec.maxBudgetUsd != null && this.accumulatedCostUsd > spec.maxBudgetUsd) {
      const budgetErr = new BudgetExceededError(spec.maxBudgetUsd, this.accumulatedCostUsd);
      return {
        output,
        model,
        engine: 'openai-api',
        turnsUsed: 1,
        durationMs,
        costUsd,
        error: `BudgetExceededError: ${budgetErr.message}`,
      };
    }

    if (refusal) {
      return {
        output: '',
        model,
        engine: 'openai-api',
        turnsUsed: 1,
        durationMs,
        costUsd,
        error: `Model refused the request: ${redactSecrets(refusal)}`,
      };
    }

    return {
      output,
      model,
      engine: 'openai-api',
      turnsUsed: 1,
      durationMs,
      costUsd,
    };
  }
}
