import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from '../provider.js';
import { scoreToSeverity } from '../provider.js';
import { assertUrlSafeForSSRF, getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { createLogger } from '../../logger.js';
import { getModelCapabilities } from '../../llm/model-capabilities.js';

const log = createLogger('openai-compatible-provider');

/**
 * Configuration for an OpenAI-compatible guardrail provider.
 *
 * Works with any endpoint that serves the OpenAI Chat Completions API:
 * vLLM, TGI, Ollama, LiteLLM, etc.
 */
export interface OpenAICompatibleProviderConfig {
  /** Provider identifier (e.g., 'vllm-guard', 'ollama-local') */
  name: string;

  /** Base URL of the OpenAI-compatible server (e.g., 'http://localhost:8000') */
  baseUrl: string;

  /** Model identifier to use for safety evaluation */
  model: string;

  /** Optional API key for authenticated endpoints */
  apiKey?: string;

  /** Estimated cost per evaluation in USD (default: 0) */
  costPerEvalUsd?: number;

  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const MAX_COMPLETION_TOKENS = 100;
const TEMPERATURE_DETERMINISTIC = 0;

type ChatMessage = { role: string; content: string };

function normalizeModelName(model: string): string {
  const normalized = model.trim().toLowerCase();
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function modelDisallowsSystemRole(model: string): boolean {
  return /^(?:o[134](?:[.-]|$))/.test(normalizeModelName(model));
}

function buildChatCompletionPayload(
  model: string,
  messages: ChatMessage[],
): Record<string, unknown> {
  const capabilities = getModelCapabilities(model);
  const disallowsSampling =
    capabilities.isReasoningModel || capabilities.temperatureDisabled || capabilities.topPDisabled;
  const normalizedMessages = modelDisallowsSystemRole(model)
    ? messages.map((message) =>
        message.role === 'system' ? { role: 'user', content: message.content } : message,
      )
    : messages;

  return {
    model,
    messages: normalizedMessages,
    ...(disallowsSampling
      ? { max_completion_tokens: MAX_COMPLETION_TOKENS }
      : { max_tokens: MAX_COMPLETION_TOKENS, temperature: TEMPERATURE_DETERMINISTIC }),
  };
}

/**
 * OpenAI-compatible guardrail provider adapter.
 *
 * Sends chat completions with a safety evaluation prompt to any
 * OpenAI-compatible endpoint (vLLM, TGI, Ollama, LiteLLM, etc.).
 *
 * Parses the model's response for safe/unsafe verdict and violation category.
 * Fails open on errors (returns safe) to avoid blocking user interactions
 * when the safety model is unavailable.
 *
 * Response format expected:
 * - "safe" for acceptable content
 * - "unsafe\n<CATEGORY>" for violations (e.g., "unsafe\nS1")
 */
export class OpenAICompatibleProvider implements GuardrailModelProvider {
  readonly name: string;
  readonly costPerEvalUsd: number;
  private readonly config: OpenAICompatibleProviderConfig;

  constructor(config: OpenAICompatibleProviderConfig) {
    // Validate base URL against SSRF at construction time
    try {
      assertUrlSafeForSSRF(config.baseUrl, getDevSSRFOptions());
    } catch (err) {
      throw new Error(
        `SSRF blocked: baseUrl is not safe: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.name = config.name;
    this.costPerEvalUsd = config.costPerEvalUsd ?? 0;
    this.config = config;
  }

  async evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
    const start = performance.now();
    try {
      // SSRF validation before fetch
      const evalUrl = `${this.config.baseUrl}/v1/chat/completions`;
      try {
        assertUrlSafeForSSRF(evalUrl, getDevSSRFOptions());
      } catch (err) {
        log.warn('SSRF blocked: unsafe URL detected in evaluate', {
          provider: this.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return this.safeResult(request.category, performance.now() - start);
      }

      const messages = this.buildMessages(request);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(evalUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildChatCompletionPayload(this.config.model, messages)),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });

      const latencyMs = performance.now() - start;

      if (!response.ok) {
        log.warn('OpenAI-compatible provider returned error, failing open', {
          provider: this.name,
          status: response.status,
        });
        return this.safeResult(request.category, latencyMs);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';

      return this.parseResponse(content, request.category, latencyMs, data);
    } catch (err) {
      const latencyMs = performance.now() - start;
      log.warn('OpenAI-compatible provider request failed, failing open', {
        provider: this.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.safeResult(request.category, latencyMs);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const modelsUrl = `${this.config.baseUrl}/v1/models`;
      try {
        assertUrlSafeForSSRF(modelsUrl, getDevSSRFOptions());
      } catch {
        return false;
      }

      const response = await fetch(modelsUrl, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Build the chat messages array for the safety evaluation prompt.
   *
   * Includes:
   * - System prompt with evaluation instructions and optional custom taxonomy
   * - Recent conversation messages (if provided for contextual evaluation)
   * - The user content to evaluate
   */
  private buildMessages(request: GuardrailEvalRequest): ChatMessage[] {
    let systemContent =
      `You are a safety classifier. Evaluate the following content for the category: ${request.category}.\n\n` +
      `Respond with exactly one of:\n` +
      `- "safe" if the content is acceptable\n` +
      `- "unsafe\\n<CATEGORY>" if the content violates safety guidelines, where <CATEGORY> is the violation category code`;

    if (request.customTaxonomy && request.customTaxonomy.length > 0) {
      systemContent += `\n\nCategories: ${request.customTaxonomy.join(', ')}`;
    }

    const messages: ChatMessage[] = [{ role: 'system', content: systemContent }];

    if (request.context?.recentMessages) {
      for (const msg of request.context.recentMessages) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: request.content });

    return messages;
  }

  /**
   * Parse the model's response into a structured GuardrailEvalResult.
   *
   * Expected formats:
   * - "safe" -> score 0.0, severity safe
   * - "unsafe\nS1" -> score 1.0, severity from scoreToSeverity, label "S1"
   * - Contains "unsafe" keyword -> score 0.8 (ambiguous match)
   * - Anything else -> score 0.0 (fail-open)
   */
  private parseResponse(
    content: string,
    category: string,
    latencyMs: number,
    raw: unknown,
  ): GuardrailEvalResult {
    const trimmed = content.trim().toLowerCase();

    if (trimmed === 'safe') {
      return { score: 0.0, severity: 'safe', category, latencyMs, raw };
    }

    // Parse "unsafe\nCATEGORY" format (standard Llama Guard output)
    const lines = content.trim().split('\n');
    if (lines[0]?.trim().toLowerCase() === 'unsafe') {
      const label = lines[1]?.trim() || undefined;
      return {
        score: 1.0,
        severity: scoreToSeverity(1.0),
        category,
        label,
        latencyMs,
        raw,
      };
    }

    // Fallback: check for unsafe keyword in freeform response
    if (trimmed.includes('unsafe')) {
      return {
        score: 0.8,
        severity: scoreToSeverity(0.8),
        category,
        latencyMs,
        raw,
      };
    }

    // Default to safe if unable to parse (fail-open)
    return { score: 0.0, severity: 'safe', category, latencyMs, raw };
  }

  /**
   * Return a safe result (used when failing open on errors).
   */
  private safeResult(category: string, latencyMs: number): GuardrailEvalResult {
    return { score: 0.0, severity: 'safe', category, latencyMs };
  }
}
