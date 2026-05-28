/**
 * Reask Executor — output guardrail reask retry logic.
 *
 * When an output guardrail resolves to action='reask', the runtime retries
 * the LLM generation up to maxReasks times. On each retry, a sanitized
 * regeneration prompt is appended to the conversation history.
 *
 * WHY raw violation messages are excluded from the prompt:
 * Embedding specific violation details (matched text, rule names, category
 * labels) in the regeneration prompt would give the LLM information it could
 * use to craft responses that narrowly evade the guardrail while still
 * conveying disallowed content. The prompt uses only abstract policy language.
 *
 * @module reask-executor
 */

import { createLogger } from '@abl/compiler/platform';
import type { OutputGuardrailResult } from './output-guardrails.js';
import { traceGuardrailReask } from '../guardrails/trace-events.js';

const log = createLogger('reask');

// ---------------------------------------------------------------------------
// Hard cap — belt-and-suspenders defense even if schema validation is bypassed
// ---------------------------------------------------------------------------
const MAX_REASKS_HARD_CAP = 5;

// ---------------------------------------------------------------------------
// Safe fallback message when all reask retries are exhausted
// ---------------------------------------------------------------------------
const REASK_EXHAUSTED_FALLBACK =
  'I was unable to generate a response that meets content guidelines. Please try rephrasing your request.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal violation info needed to build a reask prompt.
 * Deliberately excludes raw message text and specific category names.
 */
export interface ReaskViolationInfo {
  guardrailName: string;
  kind: string;
  action: string;
  message?: string;
  category?: string;
}

/**
 * Input for the shouldExecuteReask decision function.
 * Determines whether reask should fire based on pipeline precedence and
 * session mode (streaming vs non-streaming).
 */
export interface ReaskDecisionInput {
  primaryAction: string;
  primaryMessage: string;
  hasReaskViolation: boolean;
  isStreaming?: boolean;
}

/**
 * Result of the shouldExecuteReask decision.
 */
export interface ReaskDecisionResult {
  shouldReask: boolean;
  fallbackAction?: string;
  skipReason?: 'streaming';
}

/**
 * Dependencies injected into the reask retry loop.
 * Allows testing without mocking platform components.
 */
export interface ReaskLoopDeps {
  /** Generate a new LLM response (called on each retry) */
  generateResponse: (reaskPrompt: string) => Promise<string>;
  /** Check output guardrails on the generated text */
  checkGuardrails: (text: string) => Promise<OutputGuardrailResult>;
  /** Emit trace events */
  onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void;
  /** Agent name for trace context */
  agentName: string;
}

/**
 * Result of the reask retry loop.
 */
export interface ReaskLoopResult {
  /** The final text to use (clean content or fallback message) */
  finalText: string;
  /** How many reask retries were attempted */
  reaskCount: number;
  /** Whether the loop produced clean content (true) or exhausted retries (false) */
  succeeded: boolean;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Build a sanitized regeneration prompt for an LLM reask attempt.
 *
 * The prompt uses only abstract policy language — it NEVER includes:
 * - The specific guardrail name
 * - The matched violation text or category
 * - Any detail that could help the LLM craft a bypass
 *
 * Different attempt numbers produce subtly different prompts with
 * escalating urgency to encourage the model to try harder.
 */
export function buildReaskPrompt(violation: ReaskViolationInfo, attemptNumber: number): string {
  // Escalating urgency tiers
  if (attemptNumber <= 1) {
    return (
      'Your previous response was flagged for a content policy violation. ' +
      'Please regenerate your response while strictly adhering to all content guidelines. ' +
      'Ensure your response does not contain any disallowed content.'
    );
  }

  if (attemptNumber === 2) {
    return (
      'Your response was again flagged for violating content policies. ' +
      'This is a repeated violation. Please carefully review the content guidelines and ' +
      'provide a response that fully complies with all policies. Avoid any content that ' +
      'could be considered disallowed or inappropriate.'
    );
  }

  // attemptNumber >= 3 — strongest urgency
  return (
    'IMPORTANT: Your response has been flagged multiple times for content policy violations. ' +
    'You must provide a response that strictly complies with all content and safety guidelines. ' +
    'If you cannot answer the question within policy guidelines, state that you are unable to ' +
    'help with that specific request and offer an alternative.'
  );
}

/**
 * Decide whether the reask branch should fire based on pipeline precedence
 * and session mode.
 *
 * Reask only fires when:
 * 1. The primary violation action IS 'reask' (pipeline precedence already resolved)
 * 2. There is at least one reask violation in the pipeline
 * 3. The session is NOT in streaming mode (streaming reask is deferred)
 */
export function shouldExecuteReask(input: ReaskDecisionInput): ReaskDecisionResult {
  // If the primary action is not 'reask', a higher-precedence terminal action won
  if (input.primaryAction !== 'reask') {
    return {
      shouldReask: false,
      fallbackAction: input.primaryAction,
    };
  }

  // Streaming mode: reask is deferred — fall back to block
  if (input.isStreaming) {
    return {
      shouldReask: false,
      fallbackAction: 'block',
      skipReason: 'streaming',
    };
  }

  // Primary action is reask and we're not streaming — fire reask
  if (input.hasReaskViolation) {
    return { shouldReask: true };
  }

  // Edge case: primaryAction is 'reask' but no reask violation found
  return {
    shouldReask: false,
    fallbackAction: 'block',
  };
}

/**
 * Execute the reask retry loop.
 *
 * Called after the initial guardrail check returned a reask violation.
 * Retries the LLM up to maxReasks times, emitting guardrail_reask trace
 * events on each attempt. If all retries are exhausted, returns a safe
 * fallback message.
 *
 * @param deps - Injected dependencies (LLM generator, guardrail checker, tracer)
 * @param initialViolation - The first guardrail result that triggered reask
 * @param maxReasks - Maximum retry attempts (hard-capped at 5)
 */
export async function executeReaskLoop(
  deps: ReaskLoopDeps,
  initialViolation: OutputGuardrailResult,
  maxReasks: number,
): Promise<ReaskLoopResult> {
  const effectiveMax = Math.min(maxReasks, MAX_REASKS_HARD_CAP);
  let reaskCount = 0;

  const violationInfo: ReaskViolationInfo = {
    guardrailName: initialViolation.violation?.guardrailName ?? 'unknown',
    kind: 'output',
    action: 'reask',
  };

  for (let attempt = 1; attempt <= effectiveMax; attempt++) {
    reaskCount = attempt;

    // Emit trace event for this reask attempt
    const traceEvent = traceGuardrailReask({
      guardrailName: violationInfo.guardrailName,
      kind: 'output',
      reaskCount: attempt,
      maxReasks: effectiveMax,
      agent: deps.agentName,
    });
    deps.onTraceEvent(traceEvent);

    log.info('Reask attempt', {
      attempt,
      maxReasks: effectiveMax,
      agent: deps.agentName,
    });

    // Build a sanitized prompt and generate a new response
    const reaskPrompt = buildReaskPrompt(violationInfo, attempt);
    let newResponse: string;
    try {
      newResponse = await deps.generateResponse(reaskPrompt);
    } catch (err) {
      log.warn('Reask LLM generation failed', {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    // Re-check guardrails on the new response
    let guardrailResult: OutputGuardrailResult;
    try {
      guardrailResult = await deps.checkGuardrails(newResponse);
    } catch (err) {
      log.warn('Reask guardrail check failed (fail-open)', {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fail-open: accept the response if guardrails themselves fail
      return { finalText: newResponse, reaskCount, succeeded: true };
    }

    // If guardrails pass, return the clean response
    if (guardrailResult.passed) {
      return {
        finalText: guardrailResult.modifiedContent ?? newResponse,
        reaskCount,
        succeeded: true,
      };
    }

    // If the new violation is NOT reask (e.g., escalated to block), stop retrying
    if (guardrailResult.violation && guardrailResult.violation.action !== 'reask') {
      log.info('Reask escalated to different action', {
        action: guardrailResult.violation.action,
        attempt,
      });
      return {
        finalText: guardrailResult.violation.message || REASK_EXHAUSTED_FALLBACK,
        reaskCount,
        succeeded: false,
      };
    }
  }

  // All retries exhausted — return safe fallback
  log.warn('Reask retries exhausted, falling back to block message', {
    reaskCount,
    maxReasks: effectiveMax,
    agent: deps.agentName,
  });

  return {
    finalText: REASK_EXHAUSTED_FALLBACK,
    reaskCount,
    succeeded: false,
  };
}
