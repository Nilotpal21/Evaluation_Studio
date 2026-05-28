/**
 * Tool JSONL Trace Middleware
 *
 * Appends complete tool request/response payloads to day-wise JSONL files
 * in the `http-traces/` directory under `TRACE_DIR` (defaults to `process.cwd()`).
 *
 * Enabled via LLM_TRACE=true environment variable.
 * Each line is a full JSON object with: timestamp, phase (tool_request/tool_response),
 * sessionId, toolName, toolType, params, result, latencyMs, endpoint, etc.
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from '@abl/compiler/platform/constructs/executors/tool-middleware.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('tool-jsonl-trace');
const TRACE_BASE = process.env.TRACE_DIR || process.cwd();
const TRACE_DIR = join(TRACE_BASE, 'http-traces');

function appendTrace(data: Record<string, unknown>): void {
  try {
    if (!existsSync(TRACE_DIR)) mkdirSync(TRACE_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const filename = `${day}.jsonl`;
    appendFileSync(join(TRACE_DIR, filename), JSON.stringify(data) + '\n');
  } catch (err) {
    log.warn('Failed to write tool trace', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Creates a middleware that logs complete tool request/response to JSONL files.
 * Only active when LLM_TRACE=true.
 */
export function createToolJsonlTraceMiddleware(): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    if (process.env.LLM_TRACE !== 'true') {
      return next(ctx);
    }

    const now = new Date();
    const sessionId = ctx.metadata?.sessionId ?? 'unknown';
    const toolType = ctx.metadata?.tool_type ?? 'unknown';
    const endpoint = ctx.metadata?.endpoint ?? ctx.metadata?.mcp_server ?? '';
    const workflowId = ctx.metadata?.workflow_id;
    const workflowVersionId = ctx.metadata?.workflow_version_id;
    const workflowVersion = ctx.metadata?.workflow_version;

    // Log request
    appendTrace({
      timestamp: now.toISOString(),
      phase: 'tool_request',
      sessionId,
      toolName: ctx.toolName,
      toolType,
      endpoint,
      workflowId,
      workflowVersionId,
      workflowVersion,
      params: ctx.params,
      timeoutMs: ctx.timeoutMs,
    });

    const start = Date.now();
    try {
      const result = await next(ctx);
      const latencyMs = Date.now() - start;

      // Log response
      appendTrace({
        timestamp: new Date().toISOString(),
        phase: 'tool_response',
        sessionId,
        toolName: ctx.toolName,
        toolType,
        endpoint,
        workflowId,
        workflowVersionId,
        workflowVersion,
        latencyMs,
        success: true,
        result: result.result,
      });

      return result;
    } catch (error) {
      const latencyMs = Date.now() - start;

      // Log error response
      appendTrace({
        timestamp: new Date().toISOString(),
        phase: 'tool_response',
        sessionId,
        toolName: ctx.toolName,
        toolType,
        endpoint,
        workflowId,
        workflowVersionId,
        workflowVersion,
        latencyMs,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  };
}
