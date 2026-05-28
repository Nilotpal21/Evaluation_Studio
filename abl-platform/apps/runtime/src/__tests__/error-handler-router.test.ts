/**
 * Tests for ErrorHandlerRouter — routing errors through IR error handlers.
 *
 * Covers:
 * - Resolution order: step-level → agent-level handlers → default handler
 * - Subtype matching priority: subtype+type > type-only > DEFAULT
 * - F-4 backwards-compatibility: 'unknown_error' fallback when no 'llm_error' handler
 * - Retry delay calculations (fixed, linear, exponential)
 */

import { describe, it, expect } from 'vitest';
import {
  resolveErrorHandler,
  calculateRetryDelays,
} from '../services/execution/error-handler-router.js';
import type { ErrorContext } from '../services/execution/error-handler-router.js';
import type { AgentIR } from '@abl/compiler';
import type { ErrorHandler } from '@abl/compiler/platform';

// =============================================================================
// Helper to build minimal AgentIR with error handlers
// =============================================================================

function makeAgentIR(opts: { handlers?: ErrorHandler[]; defaultHandler?: ErrorHandler }): AgentIR {
  return {
    error_handling: {
      handlers: opts.handlers,
      default_handler: opts.defaultHandler,
    },
  } as unknown as AgentIR;
}

// =============================================================================
// Resolution order and subtype matching
// =============================================================================

describe('resolveErrorHandler — resolution order', () => {
  it('matches subtype-specific handler over type-only handler', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'llm_error',
        then: 'continue',
        respond: 'Generic LLM error response',
      } as ErrorHandler,
      {
        type: 'llm_error',
        subtypes: ['content_filter'],
        then: 'continue',
        respond: 'Content filter specific response',
      } as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      subtype: 'content_filter',
      message: 'Content was filtered',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.respond).toBe('Content filter specific response');
  });

  it('falls back to type-only handler when no subtype match', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'llm_error',
        subtypes: ['rate_limited'],
        then: 'continue',
        respond: 'Rate limited response',
      } as ErrorHandler,
      {
        type: 'llm_error',
        then: 'continue',
        respond: 'Generic LLM error response',
      } as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      subtype: 'content_filter',
      message: 'Content was filtered',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.respond).toBe('Generic LLM error response');
  });

  it('falls back to DEFAULT handler when no type match', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'tool_error',
        then: 'continue',
        respond: 'Tool error response',
      } as ErrorHandler,
      {
        type: 'DEFAULT',
        then: 'continue',
        respond: 'Default catch-all response',
      } as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      subtype: 'content_filter',
      message: 'Content was filtered',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.respond).toBe('Default catch-all response');
  });

  it('uses agent-level default_handler when no handlers match', () => {
    const agentIR = makeAgentIR({
      handlers: [
        {
          type: 'tool_error',
          then: 'escalate',
          respond: 'Tool error',
        } as ErrorHandler,
      ],
      defaultHandler: {
        type: 'DEFAULT',
        then: 'continue',
        respond: 'Agent default handler response',
      } as ErrorHandler,
    });

    const error: ErrorContext = {
      type: 'llm_error',
      message: 'Some LLM error',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.respond).toBe('Agent default handler response');
  });

  it('returns null when no handlers and no default_handler configured', () => {
    const agentIR = makeAgentIR({});

    const error: ErrorContext = {
      type: 'llm_error',
      message: 'Some error',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).toBeNull();
  });

  it('type-only handler (no subtypes array) matches llm_error without subtype', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'llm_error',
        then: 'continue',
        respond: 'LLM error catch-all',
      } as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      message: 'Some LLM error',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.respond).toBe('LLM error catch-all');
  });
});

// =============================================================================
// F-4: Backwards-compatibility — unknown_error fallback for LLM errors
// =============================================================================

describe('resolveErrorHandler — F-4 backwards-compatibility scenarios', () => {
  it('llm_error with subtype matches subtype-specific handler (new behavior)', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'llm_error',
        subtypes: ['content_filter'],
        then: 'continue',
        respond: "I can't help with that specific request.",
      } as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      subtype: 'content_filter',
      message: 'Blocked',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.respond).toBe("I can't help with that specific request.");
  });

  it('llm_error type-only handler matches (new behavior)', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'llm_error',
        then: 'escalate',
        respond: 'Escalating due to LLM error.',
      } as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      subtype: 'content_filter',
      message: 'Blocked',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.action).toBe('escalate');
  });

  it('unknown_error handler still matches unknown_error type (unchanged behavior)', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'unknown_error',
        then: 'continue',
        respond: 'Something went wrong.',
      } as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'unknown_error',
      message: 'Random error',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.respond).toBe('Something went wrong.');
  });

  it('existing agent with only unknown_error handler does NOT match llm_error directly', () => {
    // This verifies the need for the backwards-compat fallback in reasoning-executor:
    // resolveErrorHandler itself does NOT cross type boundaries — it's the
    // reasoning-executor that retries with 'unknown_error' as a fallback.
    const handlers: ErrorHandler[] = [
      {
        type: 'unknown_error',
        then: 'continue',
        respond: 'Something went wrong.',
      } as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      subtype: 'content_filter',
      message: 'Blocked',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    // Direct match fails — llm_error !== unknown_error
    expect(resolution).toBeNull();
  });
});

// =============================================================================
// Retry delay calculations
// =============================================================================

describe('calculateRetryDelays', () => {
  it('fixed backoff produces constant delays', () => {
    const delays = calculateRetryDelays(3, 1000, 'fixed', 60000);
    expect(delays).toEqual([1000, 1000, 1000]);
  });

  it('linear backoff produces linearly increasing delays', () => {
    const delays = calculateRetryDelays(3, 1000, 'linear', 60000);
    expect(delays).toEqual([1000, 2000, 3000]);
  });

  it('exponential backoff produces exponentially increasing delays', () => {
    const delays = calculateRetryDelays(3, 1000, 'exponential', 60000);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('respects maxDelay cap', () => {
    const delays = calculateRetryDelays(5, 10000, 'exponential', 50000);
    expect(delays).toEqual([10000, 20000, 40000, 50000, 50000]);
  });

  it('empty count produces empty delays array', () => {
    const delays = calculateRetryDelays(0, 1000, 'fixed', 60000);
    expect(delays).toEqual([]);
  });
});

// =============================================================================
// Resolution with retry configuration
// =============================================================================

describe('resolveErrorHandler — retry configuration', () => {
  it('includes retry count and delays when handler has retry configured', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'llm_error',
        subtypes: ['rate_limited'],
        then: 'continue',
        respond: 'Rate limited, retrying...',
        retry: 3,
        retry_delay_ms: 1000,
        retry_backoff: 'exponential',
      } as unknown as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      subtype: 'rate_limited',
      message: 'Rate limited',
      retryable: true,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.retryCount).toBe(3);
    expect(resolution!.retryDelays).toEqual([1000, 2000, 4000]);
  });

  it('caps retry count at MAX_RETRY_COUNT (10)', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'llm_error',
        then: 'continue',
        retry: 100,
        retry_delay_ms: 100,
        retry_backoff: 'fixed',
      } as unknown as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      message: 'Error',
      retryable: true,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.retryCount).toBe(10);
  });

  it('handoff action includes handoff_target', () => {
    const handlers: ErrorHandler[] = [
      {
        type: 'llm_error',
        subtypes: ['content_filter'],
        then: 'handoff',
        handoff_target: 'FallbackAgent',
        respond: 'Transferring you...',
      } as unknown as ErrorHandler,
    ];
    const agentIR = makeAgentIR({ handlers });

    const error: ErrorContext = {
      type: 'llm_error',
      subtype: 'content_filter',
      message: 'Blocked',
      retryable: false,
    };

    const resolution = resolveErrorHandler(error, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.action).toBe('handoff');
    expect(resolution!.handoffTarget).toBe('FallbackAgent');
  });
});
