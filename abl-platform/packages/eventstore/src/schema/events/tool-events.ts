/**
 * Tool event schemas.
 *
 * Events related to tool calls: completed, failed, retried, error handling.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── tool.call.completed ───────────────────────────────────────────────────

export const ToolCallCompletedDataSchema = z
  .object({
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    tool_type: z.enum(['http', 'lambda', 'mcp', 'sandbox']).optional(),
    toolType: z.enum(['http', 'lambda', 'mcp', 'sandbox']).optional(),
    success: z.boolean().optional(),
    latency_ms: z.number().optional(),
    durationMs: z.number().optional(),
    result_size_bytes: z.number().optional(),
    resultSize: z.number().optional(),
  })
  .passthrough();

export type ToolCallCompletedData = z.infer<typeof ToolCallCompletedDataSchema>;

eventRegistry.register('tool.call.completed', ToolCallCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.TOOL,
  containsPII: true,
  description: 'Tool call executed (success or soft failure)',
});

// ─── tool.call.failed ──────────────────────────────────────────────────────

export const ToolCallFailedDataSchema = z
  .object({
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    tool_type: z.enum(['http', 'lambda', 'mcp', 'sandbox']).optional(),
    toolType: z.enum(['http', 'lambda', 'mcp', 'sandbox']).optional(),
    error_type: z.string().optional(),
    errorType: z.string().optional(),
    error_message: z.string().optional(),
    errorMessage: z.string().optional(),
    latency_ms: z.number().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();

export type ToolCallFailedData = z.infer<typeof ToolCallFailedDataSchema>;

eventRegistry.register('tool.call.failed', ToolCallFailedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.TOOL,
  containsPII: true,
  description: 'Tool call failed with hard error',
});

// ─── tool.call.retried ─────────────────────────────────────────────────────

export const ToolCallRetriedDataSchema = z
  .object({
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    attempt: z.number().optional(),
    max_retries: z.number().optional(),
    maxRetries: z.number().optional(),
    delay_ms: z.number().optional(),
    delayMs: z.number().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export type ToolCallRetriedData = z.infer<typeof ToolCallRetriedDataSchema>;

eventRegistry.register('tool.call.retried', ToolCallRetriedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.TOOL,
  containsPII: true,
  description: 'Tool call retry triggered',
});

// ─── tool.error.handled ────────────────────────────────────────────────────

export const ToolErrorHandledDataSchema = z
  .object({
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    error_type: z.string().optional(),
    errorType: z.string().optional(),
    handler_action: z.enum(['retry', 'respond', 'handoff', 'backtrack']).optional(),
    handlerAction: z.enum(['retry', 'respond', 'handoff', 'backtrack']).optional(),
  })
  .passthrough();

export type ToolErrorHandledData = z.infer<typeof ToolErrorHandledDataSchema>;

eventRegistry.register('tool.error.handled', ToolErrorHandledDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.TOOL,
  containsPII: true,
  description: 'Tool error handled by error handler',
});
