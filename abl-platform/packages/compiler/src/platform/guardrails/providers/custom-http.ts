/**
 * Custom HTTP Guardrail Provider
 *
 * Configurable adapter for arbitrary HTTP safety evaluation APIs.
 * Uses Handlebars-style template string interpolation for request body
 * and JSONPath-like dot-notation for response mapping.
 *
 * Security controls:
 * - Template size limit (4KB) to prevent resource exhaustion
 * - SSRF protection via shared platform validator (blocks private IPs,
 *   octal/decimal encoding, userinfo bypass, DNS rebinding, cloud metadata)
 * - Response size limit (1MB)
 * - Manual redirect following with per-hop SSRF validation
 * - Timeout enforcement via AbortSignal
 *
 * Fails open on errors (returns safe) to avoid blocking user interactions
 * when the external safety API is unavailable.
 */

import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
  RuntimeProviderOverride,
} from '../provider.js';
import { scoreToSeverity } from '../provider.js';
import { assertUrlSafeForSSRF, getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { createLogger } from '../../logger.js';
import { escapeJsonString } from '../../constructs/executors/json-template-utils.js';

const log = createLogger('custom-http-provider');

/** Maximum allowed body template size in bytes */
const MAX_TEMPLATE_SIZE = 4096;

/** Default HTTP request timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Health check timeout in milliseconds */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Maximum redirect hops to follow manually */
const MAX_REDIRECT_HOPS = 5;

/** Maximum response body size in bytes (1 MB) */
const MAX_RESPONSE_SIZE = 1_048_576;

/**
 * Configuration for a custom HTTP guardrail provider.
 *
 * Defines the HTTP endpoint, request template, and response mapping
 * for an arbitrary safety evaluation API.
 */
export interface CustomHTTPProviderConfig {
  /** Provider identifier (e.g., 'custom-safety', 'internal-moderation') */
  name: string;

  /** Full URL of the safety evaluation endpoint */
  url: string;

  /** HTTP method (default: 'POST') */
  method?: string;

  /** Static headers to include in every request */
  headers?: Record<string, string>;

  /**
   * JSON template string with {{placeholder}} variables.
   * Available placeholders: {{content}}, {{category}}.
   * Example: '{"text": "{{content}}", "check": "{{category}}"}'
   */
  bodyTemplate: string;

  /** Dot-notation path to extract the numeric score from the response (e.g., 'result.score') */
  scorePath: string;

  /** Optional dot-notation path to extract a label from the response (e.g., 'result.label') */
  labelPath?: string;

  /** Optional dot-notation path to extract an explanation from the response */
  explanationPath?: string;

  /** Estimated cost per evaluation in USD (default: 0) */
  costPerEvalUsd?: number;

  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;

  /**
   * Behavior when the provider fails (network error, timeout, etc.).
   * - 'open': return safe result (default, backward compatible)
   * - 'closed': return critical severity — blocks the interaction
   */
  failMode?: 'open' | 'closed';
}

/**
 * Extract a value from a nested object using dot-notation path.
 *
 * Example: getByPath({ result: { score: 0.5 } }, 'result.score') → 0.5
 */
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Interpolate a template string by replacing {{key}} placeholders with values.
 *
 * Values are escaped for JSON safety (backslashes, quotes, newlines).
 */
function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) return '';
    return escapeJsonString(value);
  });
}

/**
 * Check if a URL targets a private/internal network (SSRF risk).
 * Returns true if the URL is unsafe (private IP, localhost, cloud metadata, etc.).
 * Always uses strict validation (no dev-mode bypass) since this is a security check.
 */
export function isPrivateUrl(url: string): boolean {
  try {
    assertUrlSafeForSSRF(url);
    return false;
  } catch {
    return true;
  }
}

/**
 * Check if a URL is safe for SSRF. Returns true if safe, false if blocked.
 * Uses dev-mode options to allow localhost/private ranges in non-production.
 */
function isUrlSafe(url: string): boolean {
  try {
    assertUrlSafeForSSRF(url, getDevSSRFOptions());
    return true;
  } catch {
    return false;
  }
}

/**
 * Custom HTTP guardrail provider adapter.
 *
 * Sends templated HTTP requests to an arbitrary safety evaluation endpoint
 * and extracts results using configurable dot-notation response paths.
 *
 * Includes SSRF protection via the shared platform validator to prevent
 * requests to private/internal networks, including octal/decimal IP encoding,
 * userinfo bypass, and DNS rebinding attacks.
 *
 * Follows redirects manually with per-hop SSRF validation.
 * Fails open on errors (returns safe) to avoid blocking user interactions
 * when the safety API is unavailable.
 */
export class CustomHTTPProvider implements GuardrailModelProvider {
  readonly name: string;
  readonly costPerEvalUsd: number;
  private readonly config: CustomHTTPProviderConfig;

  constructor(config: CustomHTTPProviderConfig) {
    if (config.bodyTemplate.length > MAX_TEMPLATE_SIZE) {
      throw new Error(`Template exceeds max size of ${MAX_TEMPLATE_SIZE} bytes`);
    }
    this.name = config.name;
    this.costPerEvalUsd = config.costPerEvalUsd ?? 0;
    this.config = config;
  }

  withRuntimeOverride(override: RuntimeProviderOverride): GuardrailModelProvider {
    return new CustomHTTPProvider({
      ...this.config,
      url: override.endpoint ?? this.config.url,
      costPerEvalUsd: override.costPerEvalUsd ?? this.config.costPerEvalUsd,
    });
  }

  async evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
    const start = performance.now();

    // SSRF check — always strict (no dev bypass) for user-configured URLs
    if (isPrivateUrl(this.config.url)) {
      log.warn('SSRF blocked: unsafe URL detected', { url: this.config.url, provider: this.name });
      return this.failureResult(request.category, performance.now() - start, 'Unsafe provider URL');
    }

    try {
      const body = interpolateTemplate(this.config.bodyTemplate, {
        content: request.content,
        category: request.category,
      });

      // Follow redirects manually to validate each hop for SSRF
      let currentUrl = this.config.url;
      let response: Response | undefined;
      const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
        response = await fetch(currentUrl, {
          method: this.config.method ?? 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.config.headers,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
        });

        const status = response.status;
        if (status >= 300 && status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            log.warn('Redirect with no Location header', { provider: this.name, status });
            return this.failureResult(
              request.category,
              performance.now() - start,
              'Redirect missing location',
            );
          }

          const redirectUrl = new URL(location, currentUrl).toString();
          if (!isUrlSafe(redirectUrl)) {
            log.warn('SSRF blocked: redirect to unsafe URL', {
              provider: this.name,
              redirectUrl,
            });
            return this.failureResult(
              request.category,
              performance.now() - start,
              'Unsafe redirect URL',
            );
          }

          if (hop === MAX_REDIRECT_HOPS) {
            log.warn('Too many redirects', { provider: this.name, hops: hop });
            return this.failureResult(
              request.category,
              performance.now() - start,
              'Too many redirects',
            );
          }

          currentUrl = redirectUrl;
          continue;
        }

        break;
      }

      const latencyMs = performance.now() - start;

      if (!response || !response.ok) {
        const failMode = this.config.failMode ?? 'open';
        log.warn(`Custom HTTP provider returned error, failing ${failMode}`, {
          provider: this.name,
          status: response?.status,
          failMode,
        });
        return this.failureResult(request.category, latencyMs, 'Provider returned an error');
      }

      // Fast-path: reject if Content-Length header already exceeds limit
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > MAX_RESPONSE_SIZE) {
        log.warn('Response Content-Length exceeds max size, failing open', {
          provider: this.name,
          contentLength: Number(contentLength),
          maxSize: MAX_RESPONSE_SIZE,
        });
        return this.failureResult(request.category, latencyMs, 'Provider response too large');
      }

      // Stream response body incrementally to enforce size limit without OOM
      const reader = response.body?.getReader();
      if (!reader) {
        log.warn('No response body reader available, failing open', { provider: this.name });
        return this.failureResult(
          request.category,
          latencyMs,
          'Provider response body unavailable',
        );
      }
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.length;
        if (totalSize > MAX_RESPONSE_SIZE) {
          await reader.cancel().catch(() => {});
          log.warn('Response body exceeds max size during streaming, failing open', {
            provider: this.name,
            size: totalSize,
            maxSize: MAX_RESPONSE_SIZE,
          });
          return this.failureResult(request.category, latencyMs, 'Provider response too large');
        }
        chunks.push(value);
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks));

      const data = JSON.parse(text);
      const score = Number(getByPath(data, this.config.scorePath)) || 0;
      const label = this.config.labelPath
        ? String(getByPath(data, this.config.labelPath) ?? '')
        : undefined;
      const explanation = this.config.explanationPath
        ? String(getByPath(data, this.config.explanationPath) ?? '')
        : undefined;

      return {
        score,
        severity: scoreToSeverity(score),
        category: request.category,
        label: label || undefined,
        explanation: explanation || undefined,
        latencyMs,
        raw: data,
      };
    } catch (err) {
      const latencyMs = performance.now() - start;
      const failMode = this.config.failMode ?? 'open';
      log.warn(`Custom HTTP provider request failed, failing ${failMode}`, {
        provider: this.name,
        failMode,
        error: err instanceof Error ? err.message : String(err),
      });

      return this.failureResult(request.category, latencyMs, 'Provider unavailable');
    }
  }

  async isAvailable(): Promise<boolean> {
    if (isPrivateUrl(this.config.url)) return false;
    try {
      const response = await fetch(this.config.url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Return a failure result according to the configured fail mode. */
  private failureResult(category: string, latencyMs: number, error: string): GuardrailEvalResult {
    if (this.config.failMode === 'closed') {
      return {
        score: 1.0,
        severity: 'critical' as const,
        category,
        latencyMs,
        raw: { failedClosed: true, error },
      };
    }

    return {
      score: 0.0,
      severity: 'safe',
      category,
      latencyMs,
      raw: { failedOpen: true, error },
    };
  }
}
