/**
 * Reasoning Executor (Compiler Layer)
 *
 * Pure-logic executor for the reasoning-mode agentic loop.
 * Handles the core iteration control, tool dispatch classification,
 * and termination detection without runtime dependencies.
 *
 * This is the compiler-side loop oracle for reasoning-mode iteration
 * semantics. It mirrors the runtime's loop-break contract for routing
 * system tools:
 * - __complete__, __escalate__, and __return_to_parent__ break immediately
 * - __delegate__ and __fan_out__ continue so the LLM can synthesize
 * - __handoff__ only breaks when the executed handoff returns a visible
 *   response
 *
 * Responsibilities:
 * - LLM <-> tool iteration loop with configurable max iterations
 * - System tool detection (__complete__, __escalate__, __handoff__, etc.)
 * - Tool selection and execution dispatch
 * - Consecutive empty response detection
 * - Iteration count enforcement
 */

import type {
  LLMClient,
  LLMToolDefinition,
  LLMToolCall,
  LLMToolResult,
  LLMToolUseResult,
  ToolExecutor,
} from '../types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default max tool iterations when not specified */
const DEFAULT_MAX_ITERATIONS = 10;

/** Break the loop after this many consecutive empty LLM responses */
const MAX_CONSECUTIVE_EMPTY_RESPONSES = 2;

/** System tool prefixes */
const SYSTEM_TOOL_COMPLETE = '__complete__';
const SYSTEM_TOOL_ESCALATE = '__escalate__';
const SYSTEM_TOOL_HANDOFF = '__handoff__';
const SYSTEM_TOOL_DELEGATE = '__delegate__';
const SYSTEM_TOOL_FAN_OUT = '__fan_out__';
const SYSTEM_TOOL_SET_CONTEXT = '__set_context__';
const SYSTEM_TOOL_RETURN_TO_PARENT = '__return_to_parent__';

// =============================================================================
// TYPES
// =============================================================================

/** Configuration for the reasoning executor */
export interface ReasoningConfig {
  maxIterations?: number;
  systemPrompt: string;
  tools: LLMToolDefinition[];
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
  }>;
}

/** Result of a single iteration */
export interface IterationResult {
  /** Tool calls made in this iteration */
  toolCalls: LLMToolCall[];
  /** Text response from LLM (if any) */
  text?: string;
  /** Stop reason from LLM */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

/** Classification of a tool call */
export type ToolCallClassification = { kind: 'system'; systemAction: string } | { kind: 'regular' };

/** Result of the full reasoning execution */
export interface ReasoningResult {
  /** Final text response */
  response: string;
  /** Action type that ended the loop */
  action: ReasoningAction;
  /** Total iterations executed */
  iterations: number;
  /** Tool calls made across all iterations (name only for comparison) */
  toolSelections: string[];
  /** Whether max iterations was hit */
  maxIterationsReached: boolean;
}

/** Action that ends the reasoning loop */
export type ReasoningAction =
  | { type: 'continue' }
  | { type: 'complete'; message?: string }
  | { type: 'escalate'; reason?: string; priority?: string }
  | { type: 'handoff'; target?: string }
  | { type: 'delegate'; target?: string }
  | { type: 'fan_out' }
  | { type: 'return_to_parent' }
  | { type: 'error'; message: string };

/** Callback for tool execution */
export type ToolExecutionCallback = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

/** Trace callback for observability */
export type ReasoningTraceCallback = (event: {
  type: string;
  data: Record<string, unknown>;
}) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasVisibleSystemResponse(result: unknown): result is { response: string } {
  return isRecord(result) && typeof result.response === 'string' && result.response.length > 0;
}

function buildAssistantContentFromResult(
  result: LLMToolUseResult,
): Array<{ type: string; [key: string]: unknown }> {
  if (Array.isArray(result.rawContent) && result.rawContent.length > 0) {
    const content = [...result.rawContent];
    const hasReplayedText = content.some((block) => block.type === 'text');
    const hasProviderReasoning = content.some((block) => block.type === 'reasoning');
    if (result.text && !hasReplayedText && !hasProviderReasoning) {
      content.unshift({ type: 'text', text: result.text });
    }

    const replayedToolCallIds = content
      .filter((block) => block.type === 'tool_use' && typeof block.id === 'string')
      .map((block) => block.id as string);

    for (const toolCall of result.toolCalls) {
      if (!replayedToolCallIds.includes(toolCall.id)) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
      }
    }

    return content;
  }

  const content: Array<{ type: string; [key: string]: unknown }> = [];
  if (result.text) {
    content.push({ type: 'text', text: result.text });
  }
  content.push(
    ...result.toolCalls.map((tc) => ({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.input,
    })),
  );

  return content;
}

// =============================================================================
// REASONING EXECUTOR
// =============================================================================

export class ReasoningExecutor {
  /**
   * Classify a tool call as system or regular.
   */
  classifyToolCall(toolCall: LLMToolCall): ToolCallClassification {
    const name = toolCall.name;
    if (
      name === SYSTEM_TOOL_COMPLETE ||
      name === SYSTEM_TOOL_ESCALATE ||
      name === SYSTEM_TOOL_HANDOFF ||
      name === SYSTEM_TOOL_DELEGATE ||
      name === SYSTEM_TOOL_FAN_OUT ||
      name === SYSTEM_TOOL_SET_CONTEXT ||
      name === SYSTEM_TOOL_RETURN_TO_PARENT ||
      name.startsWith('__') ||
      name.startsWith('handoff_to_') ||
      name.startsWith('delegate_to_')
    ) {
      return { kind: 'system', systemAction: name };
    }
    return { kind: 'regular' };
  }

  /**
   * Determine the action from a system tool call.
   */
  resolveSystemAction(toolCall: LLMToolCall): ReasoningAction {
    const name = toolCall.name;
    if (name === SYSTEM_TOOL_COMPLETE) {
      return { type: 'complete', message: toolCall.input.message as string | undefined };
    }
    if (name === SYSTEM_TOOL_ESCALATE) {
      return {
        type: 'escalate',
        reason: toolCall.input.reason as string | undefined,
        priority: toolCall.input.priority as string | undefined,
      };
    }
    if (name === SYSTEM_TOOL_HANDOFF || name.startsWith('handoff_to_')) {
      const target = name.startsWith('handoff_to_')
        ? name.slice('handoff_to_'.length)
        : (toolCall.input.target as string | undefined);
      return { type: 'handoff', target };
    }
    if (name === SYSTEM_TOOL_DELEGATE || name.startsWith('delegate_to_')) {
      const target = name.startsWith('delegate_to_')
        ? name.slice('delegate_to_'.length)
        : (toolCall.input.target as string | undefined);
      return { type: 'delegate', target };
    }
    if (name === SYSTEM_TOOL_FAN_OUT) {
      return { type: 'fan_out' };
    }
    if (name === SYSTEM_TOOL_RETURN_TO_PARENT) {
      return { type: 'return_to_parent' };
    }
    // Unknown system tool — treat as continue
    return { type: 'continue' };
  }

  /**
   * Execute the reasoning loop.
   *
   * Runs LLM <-> tool iterations until:
   * - The LLM produces a final text response (no tool calls)
   * - A system tool (__complete__, __escalate__, __handoff__) breaks the loop
   * - The configurable max iteration limit is reached
   * - Consecutive empty responses trigger the safety guard
   */
  async execute(
    config: ReasoningConfig,
    llmClient: LLMClient,
    executeTool: ToolExecutionCallback,
    onTrace?: ReasoningTraceCallback,
  ): Promise<ReasoningResult> {
    const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    let iterations = 0;
    let consecutiveEmptyResponses = 0;
    let finalResponse = '';
    let finalAction: ReasoningAction = { type: 'continue' };
    const toolSelections: string[] = [];

    const messages = [...config.messages];

    while (iterations < maxIterations) {
      iterations++;

      const result = await llmClient.chatWithTools(config.systemPrompt, messages, config.tools, {
        model: 'default',
        timeoutMs: 30000,
      });

      onTrace?.({
        type: 'reasoning_iteration',
        data: {
          iteration: iterations,
          hasToolCalls: result.toolCalls.length > 0,
          toolCallCount: result.toolCalls.length,
          stopReason: result.stopReason,
        },
      });

      // Track consecutive empty responses
      if (!result.text && result.toolCalls.length === 0) {
        consecutiveEmptyResponses++;
        if (consecutiveEmptyResponses >= MAX_CONSECUTIVE_EMPTY_RESPONSES) {
          onTrace?.({
            type: 'warning',
            data: {
              message: 'Consecutive empty LLM responses — breaking loop',
              iterations,
              consecutiveEmpty: consecutiveEmptyResponses,
            },
          });
          break;
        }
        continue;
      } else {
        consecutiveEmptyResponses = 0;
      }

      // No tool calls — final text response
      if (result.toolCalls.length === 0) {
        finalResponse = result.text ?? '';
        break;
      }

      // Process tool calls
      const toolResults: LLMToolResult[] = [];
      let shouldBreak = false;

      for (const toolCall of result.toolCalls) {
        toolSelections.push(toolCall.name);
        const classification = this.classifyToolCall(toolCall);

        if (classification.kind === 'system') {
          const action = this.resolveSystemAction(toolCall);
          let resolvedAction: ReasoningAction = action;
          let toolResultContent = JSON.stringify({ success: true, action: action.type });

          if (
            action.type === 'handoff' ||
            action.type === 'delegate' ||
            action.type === 'fan_out'
          ) {
            try {
              const systemToolResult = await executeTool(toolCall.name, toolCall.input);
              toolResultContent = JSON.stringify(systemToolResult);

              if (action.type === 'handoff') {
                shouldBreak = hasVisibleSystemResponse(systemToolResult);
                if (!shouldBreak) {
                  resolvedAction = { type: 'continue' };
                } else if (hasVisibleSystemResponse(systemToolResult)) {
                  finalResponse = systemToolResult.response as string;
                }
              }
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              toolResultContent = JSON.stringify({ error: errorMessage });
              onTrace?.({
                type: 'tool_error',
                data: {
                  toolName: toolCall.name,
                  error: errorMessage,
                  iteration: iterations,
                },
              });
              if (action.type === 'handoff') {
                resolvedAction = { type: 'continue' };
              }
            }
          } else if (
            action.type === 'complete' ||
            action.type === 'escalate' ||
            action.type === 'return_to_parent'
          ) {
            shouldBreak = true;
            if (action.type === 'complete' && 'message' in action && action.message) {
              finalResponse = action.message;
            }
          }

          finalAction = resolvedAction;
          toolResults.push({
            tool_use_id: toolCall.id,
            content: toolResultContent,
          });
        } else {
          // Regular tool — execute via callback
          try {
            const toolResult = await executeTool(toolCall.name, toolCall.input);
            toolResults.push({
              tool_use_id: toolCall.id,
              content: JSON.stringify(toolResult),
            });
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            toolResults.push({
              tool_use_id: toolCall.id,
              content: JSON.stringify({ error: errorMessage }),
            });
            onTrace?.({
              type: 'tool_error',
              data: {
                toolName: toolCall.name,
                error: errorMessage,
                iteration: iterations,
              },
            });
          }
        }
      }

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: buildAssistantContentFromResult(result),
      });

      // Add tool results as user message
      messages.push({
        role: 'user',
        content: toolResults.map((tr) => ({
          type: 'tool_result',
          tool_use_id: tr.tool_use_id,
          content: tr.content,
        })),
      });

      if (shouldBreak) {
        break;
      }
    }

    const maxIterationsReached = iterations >= maxIterations && !finalResponse;

    // Safety fallback when max iterations exhausted
    if (maxIterationsReached) {
      finalResponse = 'I was unable to complete the response. Please try again.';
      onTrace?.({
        type: 'warning',
        data: {
          message: 'Max iterations reached without final response',
          iterations,
          maxIterations,
        },
      });
    }

    return {
      response: finalResponse,
      action: finalAction,
      iterations,
      toolSelections,
      maxIterationsReached,
    };
  }
}
