/**
 * Hook Executor
 *
 * Executes HOOKS lifecycle actions (CALL/SET/RESPOND) at four points:
 * before_agent, after_agent, before_turn, after_turn.
 *
 * Follows the output-guardrails.ts pure function pattern:
 * - Standalone async function with explicit parameters
 * - IR-gated: no-op when hooks are not defined
 * - Fail-open for non-critical hooks (log warning, continue)
 * - Fail-closed for critical hooks (throws, aborts turn)
 * - Trace event emission
 */

import type { HooksConfig } from '@abl/compiler/platform/ir/schema.js';
import { createLogger } from '@abl/compiler/platform';
import type { ExecutionResult, RuntimeSession } from './types.js';
import { normalizeToolCallName, resolveCallWithValue } from './flow-step-executor.js';
import {
  emitProtectedAssistantMessage,
  protectStructuredOutputForUser,
} from './session-output-protection.js';
import { getToolPIIAccess, restorePIITokensForToolExecution } from './pii-tool-execution.js';
import {
  applyResponseMetadataToLatestAssistantMessage,
  buildExecutionResultContentEnvelope,
} from './types.js';

const log = createLogger('hook-executor');

export type HookType = 'before_agent' | 'after_agent' | 'before_turn' | 'after_turn';

export interface HookExecutionResult {
  executed: boolean;
  hookType: HookType;
  actionsExecuted: string[];
  durationMs: number;
  error?: string;
  emittedMessage?: Pick<ExecutionResult, 'response' | 'richContent' | 'voiceConfig' | 'actions'>;
}

const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

function hasHookStructuredPayload(hookAction: NonNullable<HooksConfig[HookType]>): boolean {
  return (
    hookAction.rich_content !== undefined ||
    hookAction.voice_config !== undefined ||
    hookAction.actions !== undefined
  );
}

/**
 * Execute a lifecycle hook action.
 *
 * IR-gated: returns immediately if `hooks?.[hookType]` is undefined.
 * Executes actions sequentially: CALL → SET → RESPOND.
 * On error: critical=true throws; critical=false logs and returns.
 */
export async function executeHook(
  hookType: HookType,
  hooks: HooksConfig | undefined,
  session: RuntimeSession,
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): Promise<HookExecutionResult> {
  const hookAction = hooks?.[hookType];
  if (!hookAction) {
    return { executed: false, hookType, actionsExecuted: [], durationMs: 0 };
  }

  const startTime = Date.now();
  const actionsExecuted: string[] = [];

  try {
    // CALL: Execute tool via session's toolExecutor
    if ((hookAction.call || hookAction.call_spec?.tool) && session.toolExecutor) {
      const toolName =
        hookAction.call_spec?.tool ??
        normalizeToolCallName(hookAction.call ?? hookAction.call_spec!.tool);
      const rawParams = hookAction.call_spec?.with;
      const params: Record<string, unknown> = {};
      if (rawParams) {
        for (const [key, value] of Object.entries(rawParams)) {
          params[key] = resolveCallWithValue(value, session.data.values);
        }
      }

      actionsExecuted.push(`call:${hookAction.call ?? toolName}`);
      // F-1: pass auditContext so audit emission happens inside the function
      const { value: executionParams } = restorePIITokensForToolExecution(session, params, {
        piiAccess: getToolPIIAccess(session, toolName),
        auditContext: {
          onTraceEvent,
          toolName,
          agentId: session.agentName,
          sessionId: session.id,
          tenantId: session.tenantId,
          projectId: session.projectId,
        },
      });
      const toolResult = await session.toolExecutor.execute(
        toolName,
        executionParams as Record<string, unknown>,
        DEFAULT_HOOK_TIMEOUT_MS,
      );

      const resultKey = hookAction.call_spec?.as;
      if (resultKey) {
        session.data.values[resultKey] = toolResult;
      }
    }

    // SET: Assign values to session data store
    if (hookAction.set) {
      for (const [key, value] of Object.entries(hookAction.set)) {
        session.data.values[key] = value;
      }
      actionsExecuted.push(`set:${Object.keys(hookAction.set).join(',')}`);
    }

    // RESPOND: Push message to conversation history and emit via onChunk
    let emittedMessage: HookExecutionResult['emittedMessage'];
    if (hookAction.respond !== undefined || hasHookStructuredPayload(hookAction)) {
      const hasStructuredPayload = hasHookStructuredPayload(hookAction);
      const protectedText =
        hookAction.respond !== undefined
          ? emitProtectedAssistantMessage(session, hookAction.respond, {
              onChunk,
              historyTarget: session.conversationHistory as Array<{
                role: string;
                content: string;
                metadata?: Record<string, unknown>;
              }>,
            })
          : (() => {
              session.conversationHistory.push({ role: 'assistant', content: '' });
              return { deliveryText: '', historyText: '' };
            })();
      const protectedStructuredPayload = hasStructuredPayload
        ? protectStructuredOutputForUser(session, {
            richContent: hookAction.rich_content,
            voiceConfig: hookAction.voice_config,
            actions: hookAction.actions,
          })
        : undefined;

      if (protectedStructuredPayload) {
        applyResponseMetadataToLatestAssistantMessage(
          session.conversationHistory,
          protectedText.historyText,
          undefined,
          buildExecutionResultContentEnvelope({
            response: protectedText.historyText,
            ...(protectedStructuredPayload.history.richContent !== undefined
              ? { richContent: protectedStructuredPayload.history.richContent }
              : {}),
            ...(protectedStructuredPayload.history.voiceConfig !== undefined
              ? { voiceConfig: protectedStructuredPayload.history.voiceConfig }
              : {}),
            ...(protectedStructuredPayload.history.actions !== undefined
              ? { actions: protectedStructuredPayload.history.actions }
              : {}),
          }),
        );
      }

      emittedMessage = {
        response: protectedText.deliveryText,
        ...(protectedStructuredPayload?.delivery.richContent !== undefined
          ? { richContent: protectedStructuredPayload.delivery.richContent }
          : {}),
        ...(protectedStructuredPayload?.delivery.voiceConfig !== undefined
          ? { voiceConfig: protectedStructuredPayload.delivery.voiceConfig }
          : {}),
        ...(protectedStructuredPayload?.delivery.actions !== undefined
          ? { actions: protectedStructuredPayload.delivery.actions }
          : {}),
      };
      actionsExecuted.push('respond');
    }

    const durationMs = Date.now() - startTime;
    emitHookTraceEvent(onTraceEvent, hookType, actionsExecuted, durationMs, true);

    return { executed: true, hookType, actionsExecuted, durationMs, emittedMessage };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;

    if (hookAction.critical) {
      emitHookTraceEvent(onTraceEvent, hookType, actionsExecuted, durationMs, false, errorMsg);
      log.error('Critical hook failed — aborting', {
        hookType,
        error: errorMsg,
        sessionId: session.id,
      });
      throw err;
    }

    // Non-critical: log warning and continue
    emitHookTraceEvent(onTraceEvent, hookType, actionsExecuted, durationMs, false, errorMsg);
    log.warn('Hook execution failed (non-critical, continuing)', {
      hookType,
      error: errorMsg,
      sessionId: session.id,
    });

    return { executed: true, hookType, actionsExecuted, durationMs, error: errorMsg };
  }
}

function emitHookTraceEvent(
  onTraceEvent: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined,
  hookType: HookType,
  actionsExecuted: string[],
  durationMs: number,
  success: boolean,
  error?: string,
): void {
  onTraceEvent?.({
    type: 'hook_executed',
    data: {
      hookType,
      actionsExecuted,
      durationMs,
      success,
      ...(error ? { error } : {}),
    },
  });
}
