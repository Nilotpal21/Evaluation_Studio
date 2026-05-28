/**
 * Tool Call Middleware Chain
 *
 * Composable middleware for ToolBindingExecutor that enables
 * cross-cutting concerns (logging, PII scrubbing, audit, validation)
 * as plug-and-play layers without modifying executor code.
 *
 * Middleware executes in array order (first registered = outermost),
 * following the same onion model as Express/Koa middleware.
 */

import type { ToolDefinition } from '../../ir/schema.js';

export interface ToolExecutionOptions {
  executionMode?: 'sync' | 'async_continue' | 'async_wait';
  callback?: { url: string; secret: string };
  callbackConfig?: {
    enabled: boolean;
    location: 'body' | 'query' | 'header';
    callbackUrlKey: string;
    callbackSecretKey: string;
  };
  asyncHttpSuccess?: {
    acceptedStatusCodes?: number[];
    acceptedBodyPath?: string;
    acceptedBodyEquals?: string;
  };
}

export interface ToolCallContext {
  toolName: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  tool?: ToolDefinition;
  metadata?: Record<string, unknown>;
  executionOptions?: ToolExecutionOptions;
}

export interface ToolCallResult {
  result: unknown;
  metadata?: Record<string, unknown>;
}

export type ToolMiddlewareNext = (ctx: ToolCallContext) => Promise<ToolCallResult>;
export type ToolMiddleware = (
  ctx: ToolCallContext,
  next: ToolMiddlewareNext,
) => Promise<ToolCallResult>;

/**
 * Compose an array of middleware into a single handler chain.
 * Middleware executes in array order (first registered = outermost).
 */
export function composeMiddleware(
  middlewares: ToolMiddleware[],
  final: ToolMiddlewareNext,
): ToolMiddlewareNext {
  return middlewares.reduceRight<ToolMiddlewareNext>(
    (next, middleware) => (ctx) => middleware(ctx, next),
    final,
  );
}
