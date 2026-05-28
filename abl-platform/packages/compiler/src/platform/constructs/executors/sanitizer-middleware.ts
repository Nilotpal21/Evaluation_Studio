/**
 * Secret Safety Middleware
 *
 * Two composable middlewares for the ToolBindingExecutor chain:
 *
 * 1. SecretScrubber — post-execution: scrubs leaked secrets/tokens from tool
 *    results before they reach the LLM or user.
 *
 * 2. SecretValidation — pre-execution: validates that auth-critical secrets
 *    actually resolved (not empty after placeholder substitution). Prevents
 *    sending unauthenticated requests when a required secret is missing.
 *
 * Scrub patterns and recursive scrub logic are shared via `scrub-patterns.ts`
 * so that Studio response-sanitizer and trace-scrubber use the same rules.
 */

import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from './tool-middleware.js';
import { DEFAULT_SECRET_PATTERNS, REDACTED, scrubSecrets } from './scrub-patterns.js';
import { createLogger } from '../../logger.js';

const log = createLogger('sanitizer-middleware');

// ─── Secret Scrubber Middleware ─────────────────────────────────────────────

/**
 * Scrub secrets/tokens from tool execution results before LLM/user exposure.
 *
 * Runs after the tool call completes and sanitizes the result using configurable
 * regex patterns. Default patterns cover Bearer tokens, API keys, platform keys,
 * PEM private keys, and AWS access key IDs.
 *
 * Scrubbing failures never block execution — the original result is returned.
 */
export function createSecretScrubberMiddleware(customPatterns?: readonly RegExp[]): ToolMiddleware {
  const patterns = customPatterns ?? DEFAULT_SECRET_PATTERNS;

  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const toolResult = await next(ctx);

    try {
      const scrubbedResult = scrubSecrets(toolResult.result, patterns);
      return { ...toolResult, result: scrubbedResult };
    } catch (err) {
      // Scrubbing failure must NEVER block tool execution
      log.error('Secret scrubbing failed, returning raw result', {
        toolName: ctx.toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      return toolResult;
    }
  };
}

// ─── Secret Validation Middleware ───────────────────────────────────────────

/** HTTP auth types recognized by the IR schema. */
export const HttpAuthType = {
  BEARER: 'bearer',
  CUSTOM_HEADER: 'custom_header',
  API_KEY: 'api_key',
} as const;

export type HttpAuthType = (typeof HttpAuthType)[keyof typeof HttpAuthType];

/** Auth types that use an Authorization header (not API-key-in-custom-header). */
const AUTH_HEADER_TYPES: ReadonlySet<string> = new Set([
  HttpAuthType.BEARER,
  HttpAuthType.CUSTOM_HEADER,
]);

/**
 * Error thrown when a required secret placeholder resolved to empty.
 */
export class SecretNotFoundError extends Error {
  readonly code = 'SECRET_NOT_FOUND';

  constructor(toolName: string, details: string) {
    super(
      `Tool "${toolName}": required secret not resolved. ${details}. ` +
        'Configure the secret via the project secrets store.',
    );
    this.name = 'SecretNotFoundError';
  }
}

/**
 * Detect empty secret placeholders in HTTP auth headers.
 *
 * After secrets resolution, if an Authorization or API-key header is present
 * but resolved to an empty string (the placeholder was replaced with nothing
 * because the secret was missing), this middleware throws a descriptive error
 * instead of letting the tool send an unauthenticated request.
 *
 * Only applies to HTTP tools with auth configuration.
 */
export function createSecretValidationMiddleware(): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const tool = ctx.tool;
    if (!tool?.http_binding?.auth) {
      return next(ctx);
    }

    const auth = tool.http_binding.auth;
    const headers = tool.http_binding.headers ?? {};

    // Check for empty Authorization header from {{secrets.X}} resolution
    if (AUTH_HEADER_TYPES.has(auth.type)) {
      const authHeader = headers['Authorization'] ?? headers['authorization'];
      if (authHeader !== undefined && authHeader.trim() === '') {
        throw new SecretNotFoundError(
          ctx.toolName,
          `Empty Authorization header — the secret placeholder for ${auth.type} auth resolved to empty`,
        );
      }
    }

    // Check for empty API key header
    if (auth.type === HttpAuthType.API_KEY && auth.config?.headerName) {
      const headerName = auth.config.headerName;
      const headerValue = headers[headerName] ?? headers[headerName.toLowerCase()];
      if (headerValue !== undefined && headerValue.trim() === '') {
        throw new SecretNotFoundError(
          ctx.toolName,
          `Empty ${headerName} header — the API key secret resolved to empty`,
        );
      }
    }

    return next(ctx);
  };
}
