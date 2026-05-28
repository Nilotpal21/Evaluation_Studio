/**
 * Built-in Tool Middleware
 *
 * Ready-to-use middleware implementations for common cross-cutting concerns.
 * These can be composed into the ToolBindingExecutor middleware chain.
 */

import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from './tool-middleware.js';
import type { TraceContextManager } from '../../stores/trace-store.js';
import { createLogger } from '../../logger.js';

const log = createLogger('tool-middleware');

/**
 * Logging middleware — logs tool calls to trace context.
 * Replaces inline trace logging in ToolBindingExecutor.
 */
export function loggingMiddleware(trace?: TraceContextManager): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const start = Date.now();
    try {
      const result = await next(ctx);
      if (trace) {
        await trace.logToolCall({
          toolName: ctx.toolName,
          input: ctx.params,
          output: result.result,
          latencyMs: Date.now() - start,
          success: true,
          metadata: ctx.metadata as any,
        });
      }
      return result;
    } catch (error) {
      if (trace) {
        await trace.logToolCall({
          toolName: ctx.toolName,
          input: ctx.params,
          output: null,
          latencyMs: Date.now() - start,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          metadata: ctx.metadata as any,
        });
      }
      throw error;
    }
  };
}

/**
 * Timing middleware — logs execution time.
 */
export function timingMiddleware(): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const start = Date.now();
    const result = await next(ctx);
    const latencyMs = Date.now() - start;
    return {
      ...result,
      metadata: { ...result.metadata, latencyMs },
    };
  };
}
