/**
 * Anthropic API executor for HELIX model routing.
 *
 * This is the lightweight Claude path for synthesis/review work that does not
 * need a full Claude Code agent runtime. HELIX still owns the stage prompt,
 * retries, and retained evidence; this executor only performs the API call.
 *
 * Error contract: execute() never throws to the caller. All failures are
 * returned via ExecutorResult.error.
 */

import { buildStageOutputInstructions } from '../pipeline/stage-output-schema.js';
import type {
  ExecutorResult,
  ModelEngine,
  ModelExecutor,
  ModelSpec,
  StageOutputSchemaConfig,
  StreamEvent,
  WorkspaceExecutionContext,
} from '../types.js';
import { BudgetExceededError } from './executor-errors.js';
import { HarnessToolRunner } from './harness-tool-runner.js';

interface ModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

export const ANTHROPIC_MODEL_PRICING_USD: Record<string, ModelPricing> = {
  'claude-opus-4-7': {
    inputUsdPer1M: 5.0,
    outputUsdPer1M: 25.0,
  },
  'claude-opus-4-7-20260416': {
    inputUsdPer1M: 5.0,
    outputUsdPer1M: 25.0,
  },
  'claude-sonnet-4-6': {
    inputUsdPer1M: 3.0,
    outputUsdPer1M: 15.0,
  },
  'claude-sonnet-4-6-20260217': {
    inputUsdPer1M: 3.0,
    outputUsdPer1M: 15.0,
  },
};

export interface AnthropicMessageContentBlockLike {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicMessageLike {
  id?: string;
  model?: string;
  content?: AnthropicMessageContentBlockLike[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
}

export interface AnthropicClientLike {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AnthropicMessageLike>;
    stream?: (
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => {
      finalMessage(): Promise<AnthropicMessageLike>;
      abort(): void;
    };
  };
}

export type AnthropicClientFactory = () => Promise<AnthropicClientLike>;

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

async function defaultAnthropicClientFactory(): Promise<AnthropicClientLike> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // SDK default per-request timeout is ~10 minutes already, but earlier observed runs
  // hit "Anthropic request timed out after 113s" on big slice edits — set explicitly to
  // DEFAULT_TIMEOUT_MS so a single long turn never wipes the in-flight retry context.
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: DEFAULT_TIMEOUT_MS,
  }) as unknown as AnthropicClientLike;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9_.+/=-]{20,}/gi,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function resolveAnthropicModelAlias(model?: string): string {
  if (!model || model === 'opus' || model === 'claude-opus-4-7') {
    return 'claude-opus-4-7';
  }

  if (model === 'sonnet' || model === 'claude-sonnet-4-6') {
    return 'claude-sonnet-4-6';
  }

  return model;
}

function computeCostUsd(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
      }
    | null
    | undefined,
  model: string,
): number | undefined {
  if (!usage) return undefined;

  const pricing =
    ANTHROPIC_MODEL_PRICING_USD[model] ??
    Object.entries(ANTHROPIC_MODEL_PRICING_USD).find(
      ([key]) => model.includes(key) || key.includes(model),
    )?.[1];
  if (!pricing) {
    process.stderr.write(
      `[helix:claude-api] Unknown model "${model}" — cost tracking unavailable for this call\n`,
    );
    return undefined;
  }

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return (
    (inputTokens / 1_000_000) * pricing.inputUsdPer1M +
    (outputTokens / 1_000_000) * pricing.outputUsdPer1M
  );
}

function extractTextContent(content: AnthropicMessageLike['content']): string {
  if (!content?.length) return '';
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n\n')
    .trim();
}

function buildAnthropicRequest(
  prompt: string,
  spec: ModelSpec,
  outputSchema?: StageOutputSchemaConfig,
): { model: string; params: Record<string, unknown>; userContent: string } {
  const model = resolveAnthropicModelAlias(spec.model);
  let userContent = prompt;
  if (outputSchema) {
    userContent = `${prompt}\n\n${buildStageOutputInstructions(outputSchema)}`;
  }

  const params: Record<string, unknown> = {
    model,
    max_tokens: spec.maxTurns != null ? Math.min(spec.maxTurns * 4096, 32_000) : 8_192,
  };

  if (spec.systemPrompt) {
    params['system'] = spec.systemPrompt;
  }

  return { model, params, userContent };
}

export class AnthropicApiExecutor implements ModelExecutor {
  readonly engine: ModelEngine = 'claude-api';
  private accumulatedCostUsd = 0;
  private readonly toolRunner: HarnessToolRunner;

  constructor(
    private readonly workDir: string,
    private readonly clientFactory: AnthropicClientFactory = defaultAnthropicClientFactory,
  ) {
    this.toolRunner = new HarnessToolRunner(workDir);
  }

  setWorkspaceContext?(ctx?: WorkspaceExecutionContext): void {
    this.toolRunner.setWorkspaceContext(ctx);
  }

  async isAvailable(): Promise<boolean> {
    const key = process.env.ANTHROPIC_API_KEY;
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
    const { model, params, userContent } = buildAnthropicRequest(prompt, spec, outputSchema);
    const anthropicTools = this.toolRunner.buildAnthropicTools(tools);

    if (spec.maxBudgetUsd != null && this.accumulatedCostUsd >= spec.maxBudgetUsd) {
      const err = new BudgetExceededError(spec.maxBudgetUsd, this.accumulatedCostUsd);
      return {
        output: '',
        model,
        engine: 'claude-api',
        turnsUsed: 0,
        durationMs: Date.now() - startTime,
        costUsd: 0,
        error: `BudgetExceededError: ${err.message}`,
      };
    }

    if (abortSignal?.aborted) {
      return {
        output: '',
        model,
        engine: 'claude-api',
        turnsUsed: 0,
        durationMs: Date.now() - startTime,
        error: 'Anthropic request aborted by caller before execution',
      };
    }

    let client: AnthropicClientLike;
    try {
      client = await this.clientFactory();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        output: '',
        model,
        engine: 'claude-api',
        turnsUsed: 0,
        durationMs: Date.now() - startTime,
        error: `Failed to initialize Anthropic client: ${redactSecrets(errorMsg)}`,
      };
    }

    const timeoutLimit = timeoutMs ?? spec.stallThresholdMs ?? DEFAULT_TIMEOUT_MS;
    const messages: Array<Record<string, unknown>> = [{ role: 'user', content: userContent }];
    const maxTurns = Math.max(1, spec.maxTurns ?? 100);
    let turnsUsed = 0;
    let totalCostUsd = 0;
    try {
      while (turnsUsed < maxTurns) {
        onStream?.({
          type: 'progress',
          timestamp: new Date().toISOString(),
          message: `[turn ${turnsUsed + 1}] thinking...`,
        });

        const remainingTimeoutMs = Math.max(1, timeoutLimit - (Date.now() - startTime));
        const response = await executeAnthropicRequest(
          client,
          {
            ...params,
            messages,
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
          },
          remainingTimeoutMs,
          abortSignal,
        );
        turnsUsed += 1;

        const costUsd = computeCostUsd(response.usage, model);
        if (costUsd != null) {
          totalCostUsd += costUsd;
          this.accumulatedCostUsd += costUsd;
        }

        const output = extractTextContent(response.content);
        const preview = output.slice(0, 200).replace(/\n/g, ' ');
        if (preview) {
          onStream?.({
            type: 'output',
            timestamp: new Date().toISOString(),
            message: `[turn ${turnsUsed}] ${redactSecrets(preview)}${output.length > 200 ? '...' : ''}`,
          });
        }

        if (spec.maxBudgetUsd != null && this.accumulatedCostUsd > spec.maxBudgetUsd) {
          const budgetErr = new BudgetExceededError(spec.maxBudgetUsd, this.accumulatedCostUsd);
          return {
            output,
            model,
            engine: 'claude-api',
            turnsUsed,
            durationMs: Date.now() - startTime,
            costUsd: totalCostUsd || undefined,
            error: `BudgetExceededError: ${budgetErr.message}`,
          };
        }

        const toolUseBlocks = (response.content ?? []).filter(
          (block): block is AnthropicMessageContentBlockLike =>
            block.type === 'tool_use' &&
            typeof block.name === 'string' &&
            typeof block.id === 'string',
        );

        if (
          response.stop_reason === 'tool_use' &&
          toolUseBlocks.length > 0 &&
          anthropicTools.length > 0
        ) {
          messages.push({
            role: 'assistant',
            content: response.content as Record<string, unknown>[],
          });
          const toolResults: Array<Record<string, unknown>> = [];
          for (const block of toolUseBlocks) {
            onStream?.({
              type: 'tool-use',
              timestamp: new Date().toISOString(),
              message: formatToolDetail(block.name ?? 'unknown', block.input),
              details: { tool: block.name, input: block.input },
            });
            const toolResult = await this.toolRunner.executeTool(
              block.name ?? 'unknown',
              block.input,
              onStream,
            );
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: toolResult.content,
              ...(toolResult.isError ? { is_error: true } : {}),
            });
          }
          messages.push({ role: 'user', content: toolResults });
          continue;
        }

        if (response.stop_reason) {
          onStream?.({
            type: 'complete',
            timestamp: new Date().toISOString(),
            message: `Completed (stop_reason: ${response.stop_reason})`,
          });
        }

        return {
          output,
          model,
          engine: 'claude-api',
          turnsUsed,
          durationMs: Date.now() - startTime,
          costUsd: totalCostUsd || undefined,
        };
      }

      return {
        output: '',
        model,
        engine: 'claude-api',
        turnsUsed,
        durationMs: Date.now() - startTime,
        costUsd: totalCostUsd || undefined,
        error: `Anthropic API exceeded maxTurns (${maxTurns}) before returning a final response`,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const timedOut = /timed out|inactivity/i.test(errorMsg);

      onStream?.({
        type: 'error',
        timestamp: new Date().toISOString(),
        message: redactSecrets(`Anthropic API error: ${errorMsg}`),
      });

      return {
        output: '',
        model,
        engine: 'claude-api',
        turnsUsed,
        durationMs,
        error: redactSecrets(`Anthropic API error: ${errorMsg}`),
        ...(timedOut ? { timedOut: true } : {}),
      };
    }
  }
}

async function raceAnthropicRequest(
  request: Promise<AnthropicMessageLike>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  onCancel?: () => void,
): Promise<AnthropicMessageLike> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let cancelled = false;

  const cancel = (): void => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    onCancel?.();
  };

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        cancel();
        reject(new Error(`Anthropic request timed out after ${Math.ceil(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (!abortSignal) {
        return;
      }

      abortListener = () => {
        cancel();
        reject(new Error('Anthropic request aborted by caller'));
      };
      if (abortSignal.aborted) {
        abortListener();
      } else {
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }
    });

    return await Promise.race([request, timeoutPromise, abortPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (abortSignal && abortListener) {
      abortSignal.removeEventListener('abort', abortListener);
    }
  }
}

async function executeAnthropicRequest(
  client: AnthropicClientLike,
  params: Record<string, unknown>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<AnthropicMessageLike> {
  const requestController = new AbortController();
  const cancelRequest = (): void => {
    requestController.abort();
  };

  if (typeof client.messages.stream === 'function') {
    const stream = client.messages.stream(params, { signal: requestController.signal });
    return raceAnthropicRequest(stream.finalMessage(), timeoutMs, abortSignal, () => {
      stream.abort();
      cancelRequest();
    });
  }

  return raceAnthropicRequest(
    client.messages.create(params, { signal: requestController.signal }),
    timeoutMs,
    abortSignal,
    cancelRequest,
  );
}

function formatToolDetail(toolName: string, input?: Record<string, unknown>): string {
  const preview = input ? JSON.stringify(input) : '';
  return preview ? `${toolName}: ${preview}` : toolName;
}
