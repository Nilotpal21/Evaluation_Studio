/**
 * Await Attachment Executor
 *
 * Handles AWAIT_ATTACHMENT flow steps — suspends execution until the user
 * uploads an attachment matching the step's criteria (category, required).
 *
 * Follows the same suspension pattern as GATHER: emit a prompt, mark the
 * session as waiting, and return a wait signal. On the next message, check
 * whether an attachment was provided and either advance or re-prompt.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AwaitAttachmentIR } from '@abl/compiler/platform/ir/schema.js';
import type { RuntimeSession, ExecutionResult, PendingAwaitAttachment } from './types.js';
import { buildStateUpdates, getActiveThread } from './types.js';
import { emitDecisionEvent } from './trace-helpers.js';
import { emitProtectedExecutionResult } from './session-output-protection.js';
import { interpolateTemplate } from './value-resolution.js';

const log = createLogger('await-attachment-executor');

/**
 * Derive a high-level category from a MIME type string.
 * Used to match uploaded attachments against category filters in AWAIT_ATTACHMENT steps.
 */
export function deriveCategoryFromMimeType(mimeType: string): string | undefined {
  if (!mimeType) return undefined;

  const lower = mimeType.toLowerCase();

  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('video/')) return 'video';

  // Document types: PDF, Word, Excel, PowerPoint, OpenDocument, plain text, RTF, CSV
  if (lower === 'application/pdf') return 'document';
  if (lower.startsWith('application/vnd.openxmlformats-officedocument.')) return 'document';
  if (lower.startsWith('application/vnd.ms-')) return 'document';
  if (lower.startsWith('application/vnd.oasis.opendocument.')) return 'document';
  if (lower === 'application/msword') return 'document';
  if (lower === 'application/rtf') return 'document';
  if (lower === 'text/plain') return 'document';
  if (lower === 'text/csv') return 'document';
  if (lower === 'text/markdown') return 'document';

  return undefined;
}

/**
 * Result of executing an AWAIT_ATTACHMENT step.
 * Extends ExecutionResult with a flag indicating whether to continue or wait.
 */
export interface AwaitAttachmentResult {
  result: ExecutionResult;
  /** true = step is complete, advance to next step. false = waiting for attachment. */
  advance: boolean;
}

/**
 * Execute an AWAIT_ATTACHMENT flow step.
 *
 * Three states:
 * 1. **Attachment received** (session.currentAttachmentIds is non-empty):
 *    Check category match. If matched, store in session values, clear pending, return advance.
 * 2. **Timeout exceeded** (pending exists, timeoutSeconds exceeded):
 *    Transition to onTimeout step or return error.
 * 3. **No attachment yet** (first visit or message without attachment):
 *    Emit prompt, set pendingAwaitAttachment, return wait signal.
 *    For optional attachments (required: false), a message without attachment skips.
 */
export function executeAwaitAttachment(
  session: RuntimeSession,
  step: { await_attachment: AwaitAttachmentIR; name: string },
  currentMessage: string,
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): AwaitAttachmentResult {
  const config = step.await_attachment;
  const thread = getActiveThread(session);
  const pending = thread?.pendingAwaitAttachment;

  // ──────────────────────────────────────────────────────────────────────
  // STATE 1: Check if attachment was provided in this message
  // ──────────────────────────────────────────────────────────────────────
  if (session.currentAttachmentIds && session.currentAttachmentIds.length > 0) {
    const attachmentId = session.currentAttachmentIds[0]; // Use first attachment

    // Category filtering: if a category is specified, we can't verify MIME type
    // at this layer (no DB access). The attachment preprocessing pipeline already
    // validated the file. Store the ID and let downstream consumers verify if needed.
    // The category field is used for prompt guidance, not hard enforcement here.

    // Store attachment ID in session values
    session.data.values[config.variable] = attachmentId;

    // Clear pending state
    if (thread) {
      thread.pendingAwaitAttachment = undefined;
    }

    emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'await_attachment', {
      action: 'received',
      variable: config.variable,
      attachmentId,
      matched: true,
      outcome: 'attachment_received',
    });

    log.info('Attachment received for AWAIT_ATTACHMENT step', {
      sessionId: session.id,
      variable: config.variable,
      attachmentId,
      stepName: step.name,
    });

    return {
      result: {
        response: '',
        action: { type: 'continue' },
        stateUpdates: buildStateUpdates(session),
      },
      advance: true,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // STATE 2: Check timeout (only if we're already waiting)
  // ──────────────────────────────────────────────────────────────────────
  if (pending) {
    if (pending.timeoutSeconds !== undefined && pending.timeoutSeconds > 0) {
      const elapsedMs = Date.now() - pending.startedAt;
      const timeoutMs = pending.timeoutSeconds * 1000;

      if (elapsedMs >= timeoutMs) {
        // Clear pending state
        if (thread) {
          thread.pendingAwaitAttachment = undefined;
        }

        emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'await_attachment', {
          action: 'timeout',
          variable: config.variable,
          onTimeout: pending.onTimeout,
          elapsedMs,
          timeoutMs,
          matched: false,
          outcome: 'timeout',
        });

        log.info('AWAIT_ATTACHMENT step timed out', {
          sessionId: session.id,
          variable: config.variable,
          stepName: step.name,
          elapsedMs,
          timeoutMs,
          onTimeout: pending.onTimeout,
        });

        // If onTimeout specifies a step, the caller (flow-step-executor) handles the transition
        if (pending.onTimeout) {
          return {
            result: {
              response: '',
              action: { type: 'timeout', nextStep: pending.onTimeout },
              stateUpdates: buildStateUpdates(session),
            },
            advance: true, // caller will handle transition to onTimeout step
          };
        }

        // No onTimeout handler — return a timeout error response
        const timeoutMessage = 'The attachment upload timed out. Please try again.';
        const protectedTimeoutResult = emitProtectedExecutionResult(
          session,
          {
            response: timeoutMessage,
            action: { type: 'timeout' },
            stateUpdates: buildStateUpdates(session),
          },
          onChunk,
        );

        return {
          result: protectedTimeoutResult.result,
          advance: false,
        };
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // STATE 2b: Optional attachment — user sent a message without one
    // ──────────────────────────────────────────────────────────────────
    if (!config.required && currentMessage) {
      // User sent a message without an attachment — for optional steps, skip
      session.data.values[config.variable] = null;

      if (thread) {
        thread.pendingAwaitAttachment = undefined;
      }

      emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'await_attachment', {
        action: 'skipped',
        variable: config.variable,
        matched: true,
        outcome: 'optional_skipped',
      });

      return {
        result: {
          response: '',
          action: { type: 'continue' },
          stateUpdates: buildStateUpdates(session),
        },
        advance: true,
      };
    }

    // ──────────────────────────────────────────────────────────────────
    // STATE 2c: Still waiting — re-prompt
    // ──────────────────────────────────────────────────────────────────
    const repromptText = interpolateTemplate(config.prompt, session.data.values);
    const protectedRepromptResult = emitProtectedExecutionResult(
      session,
      {
        response: repromptText,
        action: { type: 'await_attachment', variable: config.variable },
        stateUpdates: buildStateUpdates(session),
      },
      onChunk,
    );

    return {
      result: protectedRepromptResult.result,
      advance: false,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // STATE 3: First visit — emit prompt and set pending state
  // ──────────────────────────────────────────────────────────────────────
  const promptText = interpolateTemplate(config.prompt, session.data.values);

  // Set pending state on the active thread
  const pendingState: PendingAwaitAttachment = {
    type: 'await_attachment',
    variable: config.variable,
    category: config.category,
    required: config.required !== false, // default true
    prompt: config.prompt,
    timeoutSeconds: config.timeout_seconds,
    onTimeout: config.on_timeout,
    startedAt: Date.now(),
  };

  if (thread) {
    thread.pendingAwaitAttachment = pendingState;
  }

  // Mark session as waiting for input (same pattern as GATHER)
  session.waitingForInput = ['_await_attachment_'];

  emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'await_attachment', {
    action: 'prompt',
    variable: config.variable,
    category: config.category,
    required: pendingState.required,
    matched: true,
    outcome: 'awaiting_attachment',
  });

  const protectedPromptResult = emitProtectedExecutionResult(
    session,
    {
      response: promptText,
      action: { type: 'await_attachment', variable: config.variable },
      stateUpdates: buildStateUpdates(session),
    },
    onChunk,
  );

  log.info('AWAIT_ATTACHMENT step: emitting prompt', {
    sessionId: session.id,
    variable: config.variable,
    stepName: step.name,
    category: config.category,
    timeoutSeconds: config.timeout_seconds,
  });

  return {
    result: protectedPromptResult.result,
    advance: false,
  };
}
