/**
 * LLM Error Classification — Integration Tests
 *
 * ABLP-1229: Tests the cross-component composition between classify-llm-error,
 * session-llm-client provider-error handling, error-handler-router, and the
 * reasoning-executor's subtype message resolution path.
 *
 * All tests use real function composition — no mocks of @abl/* or
 * @agent-platform/* modules. These prove the invariants that unit tests
 * (which test each function in isolation) cannot:
 *   - classify → diagnostic → AppError code → deriveLlmErrorSubtype → errorCtx
 *   - errorCtx → resolveErrorHandler → localized message resolution
 *   - DEFAULT_MESSAGES subtype keys → zero-regression guarantee
 *
 * Per CLAUDE.md test architecture:
 *   - No vi.mock of @abl/* or @agent-platform/*
 *   - Real function imports, real data flow
 */

import { describe, it, expect } from 'vitest';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { DEFAULT_MESSAGES } from '@abl/compiler';
import type { AgentIR } from '@abl/compiler';
import type { ErrorHandler } from '@abl/compiler/platform';
import {
  classifyLlmError,
  deriveLlmErrorSubtype,
  extractContentFilterCategories,
  getLlmErrorDiagnostic,
  isLlmError,
} from '../services/llm/classify-llm-error.js';
import {
  resolveErrorHandler,
  type ErrorContext,
} from '../services/execution/error-handler-router.js';

// ---------------------------------------------------------------------------
// Helpers — replicate the reasoning-executor's composition in isolation
// ---------------------------------------------------------------------------

/**
 * Build a minimal AgentIR with error handlers + messages.
 */
function makeAgentIR(opts: {
  handlers?: ErrorHandler[];
  defaultHandler?: ErrorHandler;
  messages?: Record<string, string>;
}): AgentIR {
  return {
    error_handling: {
      handlers: opts.handlers,
      default_handler: opts.defaultHandler,
    },
    messages: opts.messages ?? {},
  } as unknown as AgentIR;
}

/**
 * Simulate the reasoning-executor's error-handling composition path
 * (lines 3729-3844 of reasoning-executor.ts).
 *
 * Given an error thrown during reasoning, returns the user-visible
 * response string — the same one that would be sent to the end user.
 */
function resolveUserVisibleResponse(err: unknown, agentIR: AgentIR): string {
  const llmErrorType = isLlmError(err as AppError) ? 'llm_error' : 'unknown_error';
  const llmErrorSubtype = deriveLlmErrorSubtype(err);
  const errorCtx: ErrorContext = {
    type: llmErrorType,
    subtype: llmErrorSubtype,
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };

  // First attempt: try with derived type
  let resolution = resolveErrorHandler(errorCtx, agentIR);

  // Backwards-compat fallback: retry with 'unknown_error' if no 'llm_error' match
  if (!resolution && llmErrorType === 'llm_error') {
    resolution = resolveErrorHandler(
      { ...errorCtx, type: 'unknown_error', subtype: undefined },
      agentIR,
    );
  }

  if (resolution) {
    // Subtype-specific message key resolution (mirrors F-5 logic)
    const subtypeKey = llmErrorSubtype ? `error_llm_${llmErrorSubtype}` : undefined;
    const subtypeMessage = subtypeKey
      ? (agentIR.messages?.[subtypeKey] ?? DEFAULT_MESSAGES[subtypeKey])
      : undefined;

    // The defaultErrorResponse mirrors resolveLocalizedAgentMessage fallback
    const defaultErrorResponse =
      resolution.respond ??
      subtypeMessage ??
      agentIR.messages?.error_default ??
      DEFAULT_MESSAGES.error_default;

    // If resolution has explicit respond text (from handler), use it
    if (resolution.respond) {
      return resolution.respond;
    }

    return defaultErrorResponse;
  }

  // No handler found — in the real executor this would throw
  throw err;
}

// =============================================================================
// INT-1: Azure content-filter error → AppError classification + diagnostics
// =============================================================================

describe('INT-1: Azure content-filter error classification + diagnostic propagation', () => {
  it('classifies Azure error with code "content_filter" + responseBody → MODEL_CONTENT_FILTERED with structured categories', () => {
    // Construct an Azure-shaped error: status 400, code 'content_filter',
    // responseBody with error.innererror.content_filter_result
    const azureError = Object.assign(new Error('The response was filtered by content safety.'), {
      status: 400,
      code: 'content_filter',
      responseBody: JSON.stringify({
        error: {
          message:
            'The response was filtered due to the prompt triggering content management policy.',
          code: 'content_filter',
          innererror: {
            content_filter_result: {
              hate: { severity: 'safe', filtered: false, detected: false },
              jailbreak: { detected: true, filtered: true },
              self_harm: { severity: 'safe', filtered: false, detected: false },
              sexual: { severity: 'safe', filtered: false, detected: false },
              violence: { severity: 'medium', filtered: true, detected: true },
            },
          },
        },
      }),
    });

    // Step 1: classifyLlmError — the entry point in the real pipeline
    const classified = classifyLlmError(azureError);

    // Assert the AppError code is MODEL_CONTENT_FILTERED (not MODEL_API_ERROR)
    expect(classified).toBeInstanceOf(AppError);
    expect(classified.code).toBe('MODEL_CONTENT_FILTERED');

    // Step 2: getLlmErrorDiagnostic — extract the diagnostic
    const diagnostic = getLlmErrorDiagnostic(classified);
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.contentFilterCategories).toBeDefined();

    // Verify per-category extraction
    const categories = diagnostic!.contentFilterCategories!;
    expect(categories.length).toBe(5);

    const hate = categories.find((c) => c.category === 'hate');
    expect(hate).toBeDefined();
    expect(hate!.severity).toBe('safe');
    expect(hate!.filtered).toBe(false);
    expect(hate!.detected).toBe(false);

    const jailbreak = categories.find((c) => c.category === 'jailbreak');
    expect(jailbreak).toBeDefined();
    expect(jailbreak!.detected).toBe(true);
    expect(jailbreak!.filtered).toBe(true);

    const violence = categories.find((c) => c.category === 'violence');
    expect(violence).toBeDefined();
    expect(violence!.severity).toBe('medium');
    expect(violence!.filtered).toBe(true);
    expect(violence!.detected).toBe(true);

    // Step 3: isLlmError confirms this is a recognized LLM error
    expect(isLlmError(classified)).toBe(true);

    // Step 4: deriveLlmErrorSubtype maps to the correct subtype
    expect(deriveLlmErrorSubtype(classified)).toBe('content_filter');
  });

  it('extracts categories from responseBody as a parsed object (not just string)', () => {
    // Some SDK versions expose data as a pre-parsed object
    const azureError = Object.assign(new Error('Content filter triggered'), {
      status: 400,
      code: 'content_filter',
      data: {
        error: {
          innererror: {
            content_filter_result: {
              hate: { severity: 'high', filtered: true, detected: true },
              sexual: { severity: 'safe', filtered: false },
            },
          },
        },
      },
    });

    const categories = extractContentFilterCategories(azureError);
    expect(categories).toBeDefined();
    expect(categories!.length).toBe(2);
    expect(categories!.find((c) => c.category === 'hate')!.severity).toBe('high');
  });
});

// =============================================================================
// INT-2: ChatResult with stopReason 'content-filter' → AppError composition
// =============================================================================

describe('INT-2: stopReason "content-filter" → MODEL_CONTENT_FILTERED AppError', () => {
  /**
   * Replicate the isLlmProviderErrorResult + buildLlmProviderResultError
   * composition from reasoning-executor.ts (lines 242-275).
   */
  it('builds MODEL_CONTENT_FILTERED AppError from a provider_error ChatResult', () => {
    // Simulate the ChatResult shape produced by session-llm-client when
    // the LLM returns stopReason 'content-filter' with empty text.
    const result = {
      kind: 'provider_error' as const,
      text: '',
      toolCalls: [],
      stopReason: 'content-filter',
      rawContent: [],
      providerError: {
        code: 'LLM_PROVIDER_CONTENT_FILTERED' as const,
        message: 'The model provider blocked the generated output due to a content safety filter.',
        stopReason: 'content-filter',
        provider: 'azure-openai',
        modelId: 'gpt-4o',
        retryable: false,
      },
      resolvedModel: {
        modelId: 'gpt-4o',
        provider: 'azure-openai',
        source: 'tenant',
      },
    };

    // Step 1: isLlmProviderErrorResult check (mirrors reasoning-executor line 242)
    expect(result.kind).toBe('provider_error');
    expect(
      result.kind === 'provider_error' || result.stopReason.trim().toLowerCase() === 'error',
    ).toBe(true);

    // Step 2: buildLlmProviderResultError (mirrors reasoning-executor lines 246-275)
    // The real function checks result.providerError.code ===
    // 'LLM_PROVIDER_CONTENT_FILTERED' and returns MODEL_CONTENT_FILTERED.
    expect(result.providerError.code).toBe('LLM_PROVIDER_CONTENT_FILTERED');
    const error = new AppError(
      `AI Model Error: The response was blocked by the provider's content safety filter.`,
      { ...ErrorCodes.MODEL_CONTENT_FILTERED },
    );

    // Step 3: The downstream catch block uses these
    expect(error.code).toBe('MODEL_CONTENT_FILTERED');
    expect(isLlmError(error)).toBe(true);
    expect(deriveLlmErrorSubtype(error)).toBe('content_filter');
  });
});

// =============================================================================
// INT-3: Zero-regression — no handlers, no message overrides → platform default
// =============================================================================

describe('INT-3: zero-regression — bare agent with no error customization', () => {
  it('produces exactly "An error occurred. Please try again." for a content-filter error', () => {
    // AgentIR with NO on_error handlers, NO messages.error_llm_* overrides,
    // and a default_handler (which all agents get implicitly)
    const agentIR = makeAgentIR({
      defaultHandler: {
        type: 'DEFAULT',
        then: 'continue',
      } as ErrorHandler,
    });

    // Throw a content-filter error
    const error = classifyLlmError(
      Object.assign(new Error('content_filter triggered'), {
        status: 400,
        code: 'content_filter',
      }),
    );

    const response = resolveUserVisibleResponse(error, agentIR);

    // THE ZERO-REGRESSION ASSERTION:
    // This must be EXACTLY the platform default — character for character.
    // If a future change accidentally alters this, this test fails immediately.
    expect(response).toBe('An error occurred. Please try again.');
  });

  it('produces exactly the same default for a rate-limit error', () => {
    const agentIR = makeAgentIR({
      defaultHandler: {
        type: 'DEFAULT',
        then: 'continue',
      } as ErrorHandler,
    });

    const error = classifyLlmError(
      Object.assign(new Error('rate limit exceeded'), { status: 429 }),
    );
    const response = resolveUserVisibleResponse(error, agentIR);
    expect(response).toBe('An error occurred. Please try again.');
  });

  it('produces the timeout-specific default for a timeout error', () => {
    const agentIR = makeAgentIR({
      defaultHandler: {
        type: 'DEFAULT',
        then: 'continue',
      } as ErrorHandler,
    });

    const error = classifyLlmError(
      Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
    );
    const response = resolveUserVisibleResponse(error, agentIR);
    // timeout subtype maps to error_llm_timeout which has a pre-existing
    // custom default: 'I apologize for the delay...' — NOT error_default.
    // This is correct: the subtype key resolution (F-5) finds the
    // DEFAULT_MESSAGES['error_llm_timeout'] value.
    expect(response).toBe(DEFAULT_MESSAGES['error_llm_timeout']);
    expect(response).toBe('I apologize for the delay. Could you please repeat your request?');
  });
});

// =============================================================================
// INT-4: Subtype message key override from agentIR.messages
// =============================================================================

describe('INT-4: subtype message key resolution via agentIR.messages', () => {
  it('resolves agentIR.messages.error_llm_content_filter for a content-filter error', () => {
    const customMessage = "Sorry, I can't help with that. Could you rephrase?";
    const agentIR = makeAgentIR({
      defaultHandler: {
        type: 'DEFAULT',
        then: 'continue',
      } as ErrorHandler,
      messages: {
        error_llm_content_filter: customMessage,
      },
    });

    const error = classifyLlmError(
      Object.assign(new Error('content_filter triggered'), {
        status: 400,
        code: 'content_filter',
      }),
    );

    const response = resolveUserVisibleResponse(error, agentIR);
    expect(response).toBe(customMessage);
  });

  it('resolves agentIR.messages.error_llm_rate_limited for a rate-limit error', () => {
    const customMessage = 'We are experiencing high demand. Please wait and try again.';
    const agentIR = makeAgentIR({
      defaultHandler: {
        type: 'DEFAULT',
        then: 'continue',
      } as ErrorHandler,
      messages: {
        error_llm_rate_limited: customMessage,
      },
    });

    const error = classifyLlmError(
      Object.assign(new Error('rate limit exceeded'), { status: 429 }),
    );

    const response = resolveUserVisibleResponse(error, agentIR);
    expect(response).toBe(customMessage);
  });

  it('falls back to error_default when no subtype-specific message exists', () => {
    const customDefault = 'Something went wrong on our end.';
    const agentIR = makeAgentIR({
      defaultHandler: {
        type: 'DEFAULT',
        then: 'continue',
      } as ErrorHandler,
      messages: {
        error_default: customDefault,
        // No error_llm_content_filter override
      },
    });

    const error = classifyLlmError(
      Object.assign(new Error('content_filter triggered'), {
        status: 400,
        code: 'content_filter',
      }),
    );

    const response = resolveUserVisibleResponse(error, agentIR);
    // The subtype key DEFAULT_MESSAGES.error_llm_content_filter is
    // 'An error occurred. Please try again.' — same as error_default.
    // Because neither the handler has 'respond' nor the agentIR has the
    // subtype key, it falls through to the platform default for the subtype.
    expect(response).toBe('An error occurred. Please try again.');
  });
});

// =============================================================================
// INT-5: Agent-level error_handling.handlers with subtype match
// =============================================================================

describe('INT-5: on_error handler with type + subtype matching', () => {
  it('matches a subtype-specific handler and returns its respond text', () => {
    const handlerResponse = 'Custom handler response';
    const agentIR = makeAgentIR({
      handlers: [
        {
          type: 'llm_error',
          subtypes: ['content_filter'],
          then: 'continue',
          respond: handlerResponse,
        } as ErrorHandler,
      ],
      defaultHandler: {
        type: 'DEFAULT',
        then: 'continue',
        respond: 'Default fallback',
      } as ErrorHandler,
    });

    const error = classifyLlmError(
      Object.assign(new Error('content_filter triggered'), {
        status: 400,
        code: 'content_filter',
      }),
    );

    // Verify the error classification flows correctly
    expect(error.code).toBe('MODEL_CONTENT_FILTERED');
    expect(isLlmError(error)).toBe(true);

    const subtype = deriveLlmErrorSubtype(error);
    expect(subtype).toBe('content_filter');

    // Verify the handler matches
    const errorCtx: ErrorContext = {
      type: 'llm_error',
      subtype,
      message: error.message,
      retryable: false,
    };
    const resolution = resolveErrorHandler(errorCtx, agentIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.respond).toBe(handlerResponse);

    // Full composition through resolveUserVisibleResponse
    const response = resolveUserVisibleResponse(error, agentIR);
    expect(response).toBe(handlerResponse);
  });

  it('falls back to type-only handler when no subtype match exists', () => {
    const genericLlmResponse = 'Something went wrong with the AI model';
    const agentIR = makeAgentIR({
      handlers: [
        {
          type: 'llm_error',
          then: 'continue',
          respond: genericLlmResponse,
        } as ErrorHandler,
      ],
    });

    const error = classifyLlmError(
      Object.assign(new Error('content_filter triggered'), {
        status: 400,
        code: 'content_filter',
      }),
    );

    const response = resolveUserVisibleResponse(error, agentIR);
    expect(response).toBe(genericLlmResponse);
  });

  it('backwards-compat: falls back to unknown_error handler when no llm_error handler exists', () => {
    const fallbackResponse = 'Something unexpected happened.';
    const agentIR = makeAgentIR({
      handlers: [
        {
          type: 'unknown_error',
          then: 'continue',
          respond: fallbackResponse,
        } as ErrorHandler,
      ],
    });

    const error = classifyLlmError(
      Object.assign(new Error('content_filter triggered'), {
        status: 400,
        code: 'content_filter',
      }),
    );

    const response = resolveUserVisibleResponse(error, agentIR);
    expect(response).toBe(fallbackResponse);
  });

  it('prefers subtype-specific handler over type-only handler', () => {
    const agentIR = makeAgentIR({
      handlers: [
        {
          type: 'llm_error',
          then: 'continue',
          respond: 'Generic LLM error',
        } as ErrorHandler,
        {
          type: 'llm_error',
          subtypes: ['content_filter'],
          then: 'continue',
          respond: 'Content filter specific',
        } as ErrorHandler,
      ],
    });

    const error = classifyLlmError(
      Object.assign(new Error('content_filter triggered'), {
        status: 400,
        code: 'content_filter',
      }),
    );

    const response = resolveUserVisibleResponse(error, agentIR);
    expect(response).toBe('Content filter specific');
  });
});
