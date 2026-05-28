/**
 * ErrorHandlerRouter — Routes tool execution errors through IR error handlers.
 *
 * Resolution order:
 * 1. Step-level on_error handlers (most specific)
 * 2. Agent-level error_handling.handlers (type + subtype match)
 * 3. Agent-level error_handling.default_handler
 *
 * Retry implementation: wraps execution in a retry loop with configurable backoff.
 */

import type { AgentIR } from '@abl/compiler';
import type { ErrorHandler, FlowStep } from '@abl/compiler/platform';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('error-handler-router');

/** Maximum retry count allowed to prevent infinite loops */
const MAX_RETRY_COUNT = 10;

/** Maximum backoff delay in milliseconds */
const MAX_BACKOFF_DELAY_MS = 60_000;

export interface ErrorContext {
  type: string;
  subtype?: string;
  message: string;
  retryable: boolean;
  stepName?: string;
}

export interface ErrorResolution {
  handler: ErrorHandler;
  action: 'continue' | 'escalate' | 'handoff' | 'complete' | 'backtrack' | 'retry_step';
  respond?: string;
  voiceConfig?: ErrorHandler['voice_config'];
  richContent?: ErrorHandler['rich_content'];
  actions?: ErrorHandler['actions'];
  retryCount?: number;
  retryDelays?: number[];
  handoffTarget?: string;
  backtrackTo?: string;
}

/**
 * Find the best matching error handler for a given error context.
 */
export function resolveErrorHandler(
  error: ErrorContext,
  agentIR: AgentIR,
  currentStep?: FlowStep,
): ErrorResolution | null {
  // 1. Step-level on_error handlers (most specific)
  if (currentStep?.on_error) {
    const stepHandler = findMatchingHandler(error, currentStep.on_error);
    if (stepHandler) return buildResolution(stepHandler);
  }

  // 2. Agent-level error_handling.handlers
  if (agentIR.error_handling?.handlers) {
    const agentHandler = findMatchingHandler(error, agentIR.error_handling.handlers);
    if (agentHandler) return buildResolution(agentHandler);
  }

  // 3. Agent-level error_handling.default_handler
  if (agentIR.error_handling?.default_handler) {
    return buildResolution(agentIR.error_handling.default_handler);
  }

  // No matching handler found
  log.debug('No error handler found', { errorType: error.type, errorSubtype: error.subtype });
  return null;
}

/**
 * Find the best matching handler from a list.
 * Subtype-specific match takes priority over type-only match.
 */
function findMatchingHandler(error: ErrorContext, handlers: ErrorHandler[]): ErrorHandler | null {
  // First pass: look for exact type + subtype match
  if (error.subtype) {
    const subtypeMatch = handlers.find(
      (h) => h.type === error.type && h.subtypes?.includes(error.subtype!),
    );
    if (subtypeMatch) return subtypeMatch;
  }

  // Second pass: look for type-only match (no subtypes specified on handler)
  const typeMatch = handlers.find(
    (h) => h.type === error.type && (!h.subtypes || h.subtypes.length === 0),
  );
  if (typeMatch) return typeMatch;

  // Third pass: DEFAULT type handler
  const defaultMatch = handlers.find((h) => h.type === 'DEFAULT');
  return defaultMatch || null;
}

function buildResolution(handler: ErrorHandler): ErrorResolution {
  const resolution: ErrorResolution = {
    handler,
    action: handler.then,
    respond: handler.respond,
    voiceConfig: handler.voice_config,
    richContent: handler.rich_content,
    actions: handler.actions,
  };

  // Build retry schedule if configured
  if (handler.retry && handler.retry > 0) {
    const retryCount = Math.min(handler.retry, MAX_RETRY_COUNT);
    const delays = calculateRetryDelays(
      retryCount,
      handler.retry_delay_ms || 1000,
      handler.retry_backoff || 'fixed',
      handler.retry_max_delay_ms || MAX_BACKOFF_DELAY_MS,
    );
    resolution.retryCount = retryCount;
    resolution.retryDelays = delays;
  }

  if (handler.handoff_target) {
    resolution.handoffTarget = handler.handoff_target;
  }

  if (handler.backtrack_to) {
    resolution.backtrackTo = handler.backtrack_to;
  }

  return resolution;
}

/**
 * Calculate retry delays with the specified backoff strategy.
 */
export function calculateRetryDelays(
  count: number,
  baseDelay: number,
  backoff: 'fixed' | 'exponential' | 'linear',
  maxDelay: number,
): number[] {
  const delays: number[] = [];
  for (let i = 0; i < count; i++) {
    let delay: number;
    switch (backoff) {
      case 'exponential':
        delay = baseDelay * Math.pow(2, i);
        break;
      case 'linear':
        delay = baseDelay * (i + 1);
        break;
      case 'fixed':
      default:
        delay = baseDelay;
        break;
    }
    delays.push(Math.min(delay, maxDelay));
  }
  return delays;
}

/**
 * Execute a function with retry logic based on an ErrorResolution.
 *
 * Pass an AbortSignal to cancel pending retry delays when the session is
 * destroyed — prevents setTimeout leaks that would otherwise keep the event
 * loop alive after the caller has moved on.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  resolution: ErrorResolution,
  onRetry?: (attempt: number, delay: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  if (!resolution.retryCount || !resolution.retryDelays) {
    return fn();
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= resolution.retryCount; attempt++) {
    if (signal?.aborted) {
      throw new Error('Retry aborted');
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < resolution.retryCount) {
        const delay = resolution.retryDelays[attempt] || 0;
        if (onRetry) onRetry(attempt + 1, delay);
        if (delay > 0) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('Retry aborted'));
              },
              { once: true },
            );
          });
        }
      }
    }
  }

  throw lastError!;
}
