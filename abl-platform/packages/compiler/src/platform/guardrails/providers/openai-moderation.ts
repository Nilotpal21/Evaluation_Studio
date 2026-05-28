import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
  RuntimeProviderOverride,
} from '../provider.js';
import { scoreToSeverity } from '../provider.js';
import { createLogger } from '../../logger.js';

const log = createLogger('openai-moderation-provider');

const OPENAI_MODERATION_URL = 'https://api.openai.com/v1/moderations';
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Configuration for the OpenAI Moderation API provider.
 */
export interface OpenAIModerationProviderConfig {
  /** Provider identifier. Defaults to the built-in provider name. */
  name?: string;

  /** OpenAI API key (required for authentication) */
  apiKey: string;

  /** Full moderation endpoint override. Prefer this for runtime-stored provider records. */
  endpoint?: string;

  /** Optional base URL override (e.g., for proxies or Azure endpoints) */
  baseUrl?: string;

  /** Optional moderation model to send to OpenAI. */
  model?: string;

  /**
   * Behavior when the provider fails.
   * - 'open': return safe result (default)
   * - 'closed': return critical severity
   */
  failMode?: 'open' | 'closed';

  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

/**
 * Shape of a single result from the OpenAI Moderation API response.
 */
interface OpenAIModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  category_scores: Record<string, number>;
}

/**
 * OpenAI Moderation API provider adapter.
 *
 * Calls POST /v1/moderations with text content and maps OpenAI's
 * per-category boolean flags and scores to our 0.0-1.0 scale.
 *
 * Key behaviors:
 * - For a specific category: returns the score for that category
 * - For category "all": returns the highest score across all categories
 * - Fails open on errors (returns safe) to avoid blocking user interactions
 * - Zero cost: OpenAI's moderation endpoint is free to use
 */
export class OpenAIModerationProvider implements GuardrailModelProvider {
  readonly name: string;
  readonly costPerEvalUsd = 0;

  private readonly config: OpenAIModerationProviderConfig;

  constructor(config: OpenAIModerationProviderConfig) {
    this.name = config.name ?? 'openai-moderation';
    this.config = config;
  }

  withRuntimeOverride(override: RuntimeProviderOverride): GuardrailModelProvider {
    return new OpenAIModerationProvider({
      ...this.config,
      endpoint: override.endpoint ?? this.config.endpoint,
    });
  }

  async evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
    const start = performance.now();
    try {
      const url = this.getModerationUrl();
      const body: { input: string; model?: string } = { input: request.content };
      if (this.config.model) {
        body.model = this.config.model;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });

      const latencyMs = performance.now() - start;

      if (!response.ok) {
        log.warn(
          `OpenAI moderation API returned error, failing ${this.config.failMode ?? 'open'}`,
          {
            status: response.status,
          },
        );
        return this.failureResult(request.category, latencyMs);
      }

      const data = (await response.json()) as {
        results?: OpenAIModerationResult[];
      };
      const result = data.results?.[0];
      if (!result) {
        return this.failureResult(request.category, latencyMs);
      }

      const scores: Record<string, number> = result.category_scores ?? {};
      const categories: Record<string, boolean> = result.categories ?? {};

      if (request.category === 'all') {
        return this.evaluateAllCategories(scores, request.category, latencyMs, result);
      }

      return this.evaluateSpecificCategory(request.category, scores, categories, latencyMs, result);
    } catch (err) {
      const latencyMs = performance.now() - start;
      log.warn(`OpenAI moderation request failed, failing ${this.config.failMode ?? 'open'}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.failureResult(request.category, latencyMs);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const body: { input: string; model?: string } = { input: 'test' };
      if (this.config.model) {
        body.model = this.config.model;
      }
      const response = await fetch(this.getModerationUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private getModerationUrl(): string {
    if (this.config.endpoint) {
      return this.config.endpoint;
    }
    if (this.config.baseUrl) {
      return `${this.config.baseUrl.replace(/\/+$/, '')}/v1/moderations`;
    }
    return OPENAI_MODERATION_URL;
  }

  /**
   * Return the highest scoring category across all categories.
   */
  private evaluateAllCategories(
    scores: Record<string, number>,
    category: string,
    latencyMs: number,
    raw: OpenAIModerationResult,
  ): GuardrailEvalResult {
    let maxScore = 0;
    let maxLabel = '';
    for (const [cat, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        maxLabel = cat;
      }
    }
    return {
      score: maxScore,
      severity: scoreToSeverity(maxScore),
      category,
      label: maxLabel || undefined,
      latencyMs,
      raw,
    };
  }

  /**
   * Return the score for a specific requested category.
   * Sets label only when the category is flagged by the API.
   */
  private evaluateSpecificCategory(
    category: string,
    scores: Record<string, number>,
    categories: Record<string, boolean>,
    latencyMs: number,
    raw: OpenAIModerationResult,
  ): GuardrailEvalResult {
    const score = scores[category] ?? 0;
    const flagged = categories[category] ?? false;

    return {
      score,
      severity: scoreToSeverity(score),
      category,
      label: flagged ? category : undefined,
      latencyMs,
      raw,
    };
  }

  /**
   * Return a safe result (used when failing open on errors).
   */
  private safeResult(category: string, latencyMs: number): GuardrailEvalResult {
    return {
      score: 0.0,
      severity: 'safe',
      category,
      latencyMs,
      raw: { failedOpen: true, error: 'Provider unavailable' },
    };
  }

  private failureResult(category: string, latencyMs: number): GuardrailEvalResult {
    if (this.config.failMode === 'closed') {
      return {
        score: 1.0,
        severity: 'critical',
        category,
        latencyMs,
        raw: { failedClosed: true, error: 'Provider unavailable' },
      };
    }
    return this.safeResult(category, latencyMs);
  }
}
