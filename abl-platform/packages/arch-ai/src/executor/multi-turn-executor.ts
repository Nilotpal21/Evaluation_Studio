/**
 * MultiTurnExecutor — wraps executeSpecialistTurn in a tool-loop.
 *
 * Contract 13 (execution-model): After a server-side tool executes,
 * the LLM must be re-invoked with the tool result so it can decide
 * what to do next (call another tool, respond to the user, etc.).
 *
 * Flow:
 * 1. Start turn guards
 * 2. Call executeSpecialistTurn with current messages
 * 3. If result.status === 'completed' → return completed
 * 4. If result.status === 'awaiting_tool_result' → return (client-side tool, wait for resume)
 * 5. If result.status === 'tool_executed':
 *    a. Check guards (loop, max turns, timeout)
 *    b. Append tool result message
 *    c. Re-invoke LLM (go back to step 2)
 * 6. If result.status === 'error' → return error
 */

import type { ExecutorParams } from './specialist-executor.js';
import { executeSpecialistTurn } from './specialist-executor.js';
import { ExecutorGuards } from './executor-guards.js';
import type { ExecutorGuardConfig } from './executor-guards.js';
import type { ProviderContentBlock } from '../types/content-blocks.js';
import { classifyToolError } from '../types/errors.js';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('arch-ai:multi-turn-executor');

export interface MultiTurnMessage {
  role: string;
  content: string | ProviderContentBlock[]; // B03: multimodal support
  toolCallId?: string;
  toolName?: string;
}

export interface MultiTurnParams extends Omit<ExecutorParams, 'messages'> {
  messages: MultiTurnMessage[];
  guardConfig?: Partial<ExecutorGuardConfig>;
}

export interface MultiTurnResult {
  status: 'completed' | 'awaiting_tool_result' | 'error' | 'guard_tripped';
  messages: MultiTurnMessage[];
  turnCount: number;
  guardReason?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
}

// ─── Retry constants (Phase 2.1) ───────────────────────────────────────────────
const MAX_RETRIABLE_RETRIES = 2;
const RETRIABLE_BACKOFF_BASE_MS = 500;
const RATE_LIMIT_WAIT_MS = 5_000;

/**
 * Check whether a tool result represents an error (has an `error` field).
 * Returns the error message string if it is an error, undefined otherwise.
 */
function extractToolErrorMessage(toolResult: unknown): string | undefined {
  if (
    typeof toolResult === 'object' &&
    toolResult !== null &&
    'error' in toolResult &&
    typeof (toolResult as Record<string, unknown>).error === 'string'
  ) {
    return (toolResult as Record<string, unknown>).error as string;
  }
  return undefined;
}

/**
 * Execute a multi-turn specialist loop.
 *
 * Calls executeSpecialistTurn repeatedly: when the specialist executes
 * a server-side tool, the result is appended to messages and the LLM
 * is re-invoked. The loop continues until the LLM completes without
 * tool calls, requests a client-side tool, errors, or a guard trips.
 */
export async function executeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
  const { guardConfig, ...executorFields } = params;
  const guards = new ExecutorGuards(guardConfig);
  guards.startTurn();

  // Mutable copy — we append tool result messages as the loop progresses
  const messages: MultiTurnMessage[] = [...params.messages];
  let turnCount = 0;

  for (;;) {
    // Guard checks BEFORE each re-invocation
    const reinvocationReason = guards.checkReInvocation();
    if (reinvocationReason) {
      log.warn('arch_ai.guard_tripped', {
        sessionId: executorFields.session.id,
        specialist: executorFields.specialist,
        guardType: 'reinvocation',
        turnCount,
        reason: reinvocationReason,
      });
      return {
        status: 'guard_tripped',
        messages,
        turnCount,
        guardReason: reinvocationReason,
      };
    }
    const stallReason = guards.checkStall();
    if (stallReason) {
      log.warn('arch_ai.guard_tripped', {
        sessionId: executorFields.session.id,
        specialist: executorFields.specialist,
        guardType: 'stall',
        turnCount,
        reason: stallReason,
      });
      return {
        status: 'guard_tripped',
        messages,
        turnCount,
        guardReason: stallReason,
      };
    }

    turnCount++;

    // Build ExecutorParams with current messages
    const executorParams: ExecutorParams = {
      ...executorFields,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        toolCallId: m.toolCallId,
        toolName: m.toolName,
      })),
      toolTimeoutMs: guardConfig?.toolTimeoutMs,
    };

    let result = await executeSpecialistTurn(executorParams);
    guards.onActivity();

    switch (result.status) {
      case 'completed':
        return {
          status: 'completed',
          messages,
          turnCount,
        };

      case 'awaiting_tool_result':
        // Client-side tool — break the loop, return control to coordinator
        return {
          status: 'awaiting_tool_result',
          messages,
          turnCount,
          toolCallId: result.toolCallId,
          toolInput: result.toolInput,
        };

      case 'tool_executed': {
        // Server-side tool completed — reset stall timer and check guards before re-invoking
        guards.onActivity();
        if (result.toolName && result.toolCallId) {
          const loopReason = guards.checkToolCall(
            executorFields.specialist,
            result.toolName,
            typeof result.toolResult === 'object' && result.toolResult !== null
              ? (result.toolResult as Record<string, unknown>)
              : {},
          );
          if (loopReason) {
            log.warn('arch_ai.guard_tripped', {
              sessionId: executorFields.session.id,
              specialist: executorFields.specialist,
              guardType: 'loop',
              toolName: result.toolName,
              turnCount,
              reason: loopReason,
            });
            return {
              status: 'guard_tripped',
              messages,
              turnCount,
              guardReason: loopReason,
            };
          }
        }

        // ─── Phase 2.1: Error classification & retry ───────────────────────
        // If the tool result contains an error, classify it and potentially
        // retry the specialist turn instead of immediately passing to the LLM.
        const errorMsg = extractToolErrorMessage(result.toolResult);
        if (errorMsg) {
          const category = classifyToolError(new Error(errorMsg));

          if (category === 'retriable') {
            // Retry with exponential backoff: 500ms, 1500ms
            let retried = false;
            for (let attempt = 0; attempt < MAX_RETRIABLE_RETRIES; attempt++) {
              const delay = RETRIABLE_BACKOFF_BASE_MS * Math.pow(3, attempt);
              log.info('arch_ai.tool_retry', {
                sessionId: executorFields.session.id,
                toolName: result.toolName,
                category: 'retriable',
                attempt: attempt + 1,
                maxAttempts: MAX_RETRIABLE_RETRIES,
                delayMs: delay,
                error: errorMsg,
              });
              await new Promise((r) => setTimeout(r, delay));

              const retryResult = await executeSpecialistTurn(executorParams);
              guards.onActivity();

              if (retryResult.status !== 'tool_executed') {
                // Retry produced a non-tool_executed status — handle inline
                if (retryResult.status === 'completed') {
                  return { status: 'completed', messages, turnCount };
                }
                if (retryResult.status === 'awaiting_tool_result') {
                  return {
                    status: 'awaiting_tool_result',
                    messages,
                    turnCount,
                    toolCallId: retryResult.toolCallId,
                    toolInput: retryResult.toolInput,
                  };
                }
                if (retryResult.status === 'error') {
                  return { status: 'error', messages, turnCount };
                }
              }

              // tool_executed again — check if it succeeded this time
              const retryErrorMsg = extractToolErrorMessage(retryResult.toolResult);
              if (!retryErrorMsg) {
                // Success on retry — use this result instead
                result = retryResult;
                retried = true;
                break;
              }
              // Still an error — continue retry loop
            }
            if (!retried) {
              log.warn('arch_ai.tool_retry_exhausted', {
                sessionId: executorFields.session.id,
                toolName: result.toolName,
                category: 'retriable',
                attempts: MAX_RETRIABLE_RETRIES,
              });
            }
          } else if (category === 'rate_limited') {
            // Rate limited — wait 5s and retry once
            log.info('arch_ai.tool_retry', {
              sessionId: executorFields.session.id,
              toolName: result.toolName,
              category: 'rate_limited',
              attempt: 1,
              maxAttempts: 1,
              delayMs: RATE_LIMIT_WAIT_MS,
              error: errorMsg,
            });
            await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));

            const retryResult = await executeSpecialistTurn(executorParams);
            guards.onActivity();

            if (retryResult.status !== 'tool_executed') {
              if (retryResult.status === 'completed') {
                return { status: 'completed', messages, turnCount };
              }
              if (retryResult.status === 'awaiting_tool_result') {
                return {
                  status: 'awaiting_tool_result',
                  messages,
                  turnCount,
                  toolCallId: retryResult.toolCallId,
                  toolInput: retryResult.toolInput,
                };
              }
              if (retryResult.status === 'error') {
                return { status: 'error', messages, turnCount };
              }
            }

            const retryErrorMsg = extractToolErrorMessage(retryResult.toolResult);
            if (!retryErrorMsg) {
              result = retryResult;
            } else {
              log.warn('arch_ai.tool_retry_exhausted', {
                sessionId: executorFields.session.id,
                toolName: result.toolName,
                category: 'rate_limited',
                attempts: 1,
              });
            }
          }
          // category === 'permanent' falls through — pass error to LLM as-is
        }

        // Append assistant tool_use message (the LLM's tool call)
        messages.push({
          role: 'assistant',
          content: '',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
        });

        // Append tool result message for the LLM
        const toolResultContent =
          typeof result.toolResult === 'string'
            ? result.toolResult
            : JSON.stringify(result.toolResult ?? null);

        messages.push({
          role: 'tool',
          content: toolResultContent,
          toolCallId: result.toolCallId,
          toolName: result.toolName,
        });

        // Continue loop — re-invoke LLM with tool result
        break;
      }

      case 'error':
        return {
          status: 'error',
          messages,
          turnCount,
        };

      default: {
        // Exhaustive check — treat unknown status as error
        const _exhaustive: never = result.status;
        return {
          status: 'error',
          messages,
          turnCount,
        };
      }
    }
  }
}
