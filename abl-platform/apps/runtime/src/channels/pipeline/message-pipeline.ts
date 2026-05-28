/**
 * Message Pipeline
 *
 * Centralizes trace accumulation, message execution, and persistence logic
 * duplicated across all 5 realtime channel handlers.
 */

import { createLogger } from '@abl/compiler/platform';
import { getRuntimeExecutor } from '../../services/runtime-executor.js';
import type { ExecutionResult } from '../../services/runtime-executor.js';
import { persistMessage, persistTurnMetrics } from '../../services/message-persistence-queue.js';
import { enqueueLLMRequest } from '../../services/llm/llm-queue.js';
import { buildPersistedMessageStructuredContent } from '../../services/session/persisted-message-content.js';
import type {
  TraceAccumulator,
  ExecuteAndPersistOptions,
  ExecuteAndPersistResult,
} from './types.js';

const log = createLogger('message-pipeline');

// =============================================================================
// TRACE ACCUMULATION
// =============================================================================

/** Create a fresh zero-initialized trace accumulator. */
export function createTraceAccumulator(): TraceAccumulator {
  return { tokensIn: 0, tokensOut: 0, cost: 0, traceCount: 0, errorCount: 0, handoffCount: 0 };
}

/**
 * Accumulate a single trace event into the accumulator.
 * Sums token/cost on `llm_call`, counts errors/handoffs.
 */
export function accumulateTraceEvent(
  acc: TraceAccumulator,
  event: { type: string; data: Record<string, unknown> },
): void {
  if (event.type === 'llm_call' && event.data) {
    acc.tokensIn += (event.data.tokensIn as number) || 0;
    acc.tokensOut += (event.data.tokensOut as number) || 0;
    acc.cost += (event.data.cost as number) || 0;
  }
  acc.traceCount++;
  if (event.type === 'error') acc.errorCount++;
  if (event.type === 'handoff') acc.handoffCount++;
}

// =============================================================================
// EXECUTE + PERSIST
// =============================================================================

/**
 * Execute a user message through the runtime and optionally persist the
 * user + assistant messages and turn metrics to the DB.
 *
 * The trace callback combines pipeline accumulation with an optional
 * handler-specific `onTraceEventExtra` for transport-level concerns
 * (WS trace emission, ClickHouse writes, etc.).
 */
export async function executeAndPersist(
  opts: ExecuteAndPersistOptions,
): Promise<ExecuteAndPersistResult> {
  const executor = getRuntimeExecutor();
  const acc = createTraceAccumulator();

  // Compose trace callback: pipeline accumulation + handler-specific processing
  const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
    accumulateTraceEvent(acc, event);
    opts.onTraceEventExtra?.(event);
  };

  // Execute: use LLM queue unless explicitly disabled
  let result: ExecutionResult;
  if (opts.useLLMQueue !== false) {
    result = await enqueueLLMRequest(
      opts.sessionId,
      opts.userText,
      opts.onChunk,
      onTraceEvent,
      opts.tenantId,
      opts.execOptions,
    );
  } else {
    result = await executor.executeMessage(
      opts.sessionId,
      opts.userText,
      opts.onChunk,
      onTraceEvent,
      opts.execOptions,
    );
  }

  // Fire-and-forget persistence (skip if no persistence context)
  if (opts.persistence) {
    const { dbSessionId, channel, tenantId, contactId, projectId } = opts.persistence;

    persistMessage(
      dbSessionId,
      'user',
      opts.userText,
      channel,
      tenantId,
      undefined,
      contactId,
      projectId,
    ).catch((err: unknown) =>
      log.warn('User message persist failed', {
        err: err instanceof Error ? err.message : String(err),
      }),
    );

    const assistantStructuredContent = buildPersistedMessageStructuredContent(result);
    if (result.response || assistantStructuredContent) {
      persistMessage(
        dbSessionId,
        'assistant',
        result.response,
        channel,
        tenantId,
        undefined,
        contactId,
        projectId,
        undefined,
        assistantStructuredContent,
        result.responseMetadata,
      ).catch((err: unknown) =>
        log.warn('Assistant message persist failed', {
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    persistTurnMetrics({
      dbSessionId,
      tenantId,
      tokensIn: acc.tokensIn,
      tokensOut: acc.tokensOut,
      cost: acc.cost,
      traceEventCount: acc.traceCount,
      errorCount: acc.errorCount,
      handoffCount: acc.handoffCount,
    }).catch((err: unknown) =>
      log.warn('Turn metrics persist failed', {
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return { result, accumulator: acc };
}
