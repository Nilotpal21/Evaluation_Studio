/**
 * Tests for classifyLlmError — maps raw LLM provider errors to
 * contextual AppError instances with user-friendly messages.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyLlmError,
  extractContentFilterCategories,
  getLlmErrorDiagnostic,
  getLlmOperatorDiagnostic,
  isLlmError,
} from '../services/llm/classify-llm-error.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

describe('classifyLlmError', () => {
  it('classifies 429 status as MODEL_RATE_LIMITED', () => {
    const raw = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    const classified = classifyLlmError(raw);

    expect(classified).toBeInstanceOf(AppError);
    expect(classified.code).toBe(ErrorCodes.MODEL_RATE_LIMITED.code);
    expect(classified.message).toMatch(/^AI Model Error:/);
    expect(classified.message).toContain('Rate limit exceeded');
  });

  it('classifies Anthropic billing limit message as MODEL_RATE_LIMITED', () => {
    const raw = new Error(
      'You have reached your specified API usage limits. You will regain access on 2026-04-01 at 00:00 UTC.',
    );
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_RATE_LIMITED.code);
    expect(classified.message).toContain('You have reached your specified API usage limits');
    expect(classified.message).toContain('2026-04-01');
  });

  it('classifies 401 status as CREDENTIAL_NOT_FOUND', () => {
    const raw = Object.assign(new Error('Invalid API key'), { status: 401 });
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.CREDENTIAL_NOT_FOUND.code);
    expect(classified.message).toMatch(/^AI Model Error:/);
    expect(classified.message).toContain('credentials are invalid or expired');
  });

  it('classifies 403 status as CREDENTIAL_NOT_FOUND', () => {
    const raw = Object.assign(new Error('Permission denied'), { status: 403 });
    const classified = classifyLlmError(raw);
    expect(classified.code).toBe(ErrorCodes.CREDENTIAL_NOT_FOUND.code);
  });

  it('sanitizes missing model configuration errors before they reach users', () => {
    const raw = new AppError(
      "No model configured for tenant 'tenant-dev'. Configure a TenantModel with an active connection for this tenant. (resolution errors: Agent model: failed to resolve model 'gpt-4.1-internal-preview')",
      { ...ErrorCodes.SERVICE_UNAVAILABLE },
    );
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_NOT_CONFIGURED.code);
    expect(classified.message).toBe(
      'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
    );
    expect(classified.message).not.toContain('tenant-dev');
    expect(classified.message).not.toContain('gpt-4.1-internal-preview');
  });

  it('sanitizes invalid provider resolution errors before they reach users', () => {
    const raw = new AppError(
      "Cannot determine provider for model 'gpt-4.1-internal-preview'. Use 'provider/model' format (e.g. 'qwen/qwen35-a3b-35b') or configure a TenantModel for tenant 'tenant-dev'.",
      { ...ErrorCodes.SERVICE_UNAVAILABLE },
    );
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_NOT_CONFIGURED.code);
    expect(classified.message).toBe(
      'AI model configuration is invalid for this workspace. Ask your workspace administrator to review the configured model provider.',
    );
    expect(classified.message).not.toContain('tenant-dev');
    expect(classified.message).not.toContain('gpt-4.1-internal-preview');
  });

  it('classifies context length exceeded by message pattern', () => {
    const raw = new Error('This request would exceed the model context length of 200000 tokens');
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_CONTEXT_EXCEEDED.code);
    expect(classified.message).toContain('context window');
  });

  it('classifies content filter errors', () => {
    const raw = Object.assign(new Error('Output blocked by content filter'), { status: 422 });
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_CONTENT_FILTERED.code);
    expect(classified.message).toContain('content safety filter');
  });

  it('classifies timeout / abort errors', () => {
    const raw = Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' });
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_TIMEOUT.code);
    expect(classified.message).toContain('timed out');
  });

  it('classifies 500+ provider errors as MODEL_API_ERROR', () => {
    const raw = Object.assign(new Error('Internal server error'), { status: 500 });
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_API_ERROR.code);
    expect(classified.message).toContain('server error');
  });

  it('classifies 502 as MODEL_API_ERROR', () => {
    const raw = Object.assign(new Error('Bad gateway'), { status: 502 });
    const classified = classifyLlmError(raw);
    expect(classified.code).toBe(ErrorCodes.MODEL_API_ERROR.code);
  });

  it('sanitizes OpenAI Responses missing reasoning-item errors and attaches operator diagnostics', () => {
    const raw = new Error(
      "Item 'fc_123' of type 'function_call' was provided without its required 'reasoning' item: 'rs_456'.",
    );
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_API_ERROR.code);
    expect(classified.message).toBe(
      'AI Model Error: The model provider rejected the conversation history. Please try again.',
    );
    expect(classified.message).not.toContain('fc_123');
    expect(classified.message).not.toContain('rs_456');
    expect(getLlmErrorDiagnostic(classified)).toEqual({
      code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
      provider: 'openai',
      customerMessage:
        'AI Model Error: The model provider rejected the conversation history. Please try again.',
      operatorHint:
        'OpenAI Responses rejected a function_call item because its required reasoning item was missing from replayed history.',
      recommendedAction:
        'Verify Responses history uses previous_response_id or preserves reasoning items adjacent to function_call items.',
    });
    expect(getLlmOperatorDiagnostic(classified)).toEqual({
      category: 'llm',
      severity: 'error',
      code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
      provider: 'openai',
      message:
        'OpenAI Responses rejected a function_call item because its required reasoning item was missing from replayed history.',
      customerMessage:
        'AI Model Error: The model provider rejected the conversation history. Please try again.',
      operatorHint:
        'OpenAI Responses rejected a function_call item because its required reasoning item was missing from replayed history.',
      recommendedAction:
        'Verify Responses history uses previous_response_id or preserves reasoning items adjacent to function_call items.',
      bannerEligible: true,
    });
  });

  it('falls back to MODEL_API_ERROR for unknown errors', () => {
    const raw = new Error('Something unexpected happened');
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_API_ERROR.code);
    expect(classified.message).toContain('Something unexpected happened');
  });

  it('preserves original error as cause', () => {
    const raw = Object.assign(new Error('Rate limit'), { status: 429 });
    const classified = classifyLlmError(raw);
    expect(Object.getOwnPropertyDescriptor(classified, 'cause')?.value).toBe(raw);
  });

  it('handles non-Error inputs gracefully', () => {
    const classified = classifyLlmError('string error');
    expect(classified).toBeInstanceOf(AppError);
    expect(classified.message).toContain('string error');
  });
});

// =============================================================================
// Bedrock-specific error classification
// =============================================================================

describe('classifyLlmError — Bedrock-specific errors', () => {
  it('classifies ThrottlingException as MODEL_RATE_LIMITED with static message (no model ARN leaked)', () => {
    const raw = new Error(
      'ThrottlingException: Too many requests, please wait before trying again. Model: arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6-v1:0',
    );
    const classified = classifyLlmError(raw);

    expect(classified).toBeInstanceOf(AppError);
    expect(classified.code).toBe(ErrorCodes.MODEL_RATE_LIMITED.code);
    expect(classified.message).toBe(
      'AI Model Error: AWS Bedrock rate limit exceeded — retry after a moment.',
    );
    // Must NOT leak model ARN or region
    expect(classified.message).not.toContain('arn:aws');
    expect(classified.message).not.toContain('123456789012');
    expect(classified.message).not.toContain('us-east-1');
  });

  it('classifies ValidationException as MODEL_API_ERROR with static message (no model ID leaked)', () => {
    const raw = new Error(
      'ValidationException: Malformed input request: expected minLength: 1, actual: 0, at [messages]',
    );
    const classified = classifyLlmError(raw);

    expect(classified).toBeInstanceOf(AppError);
    expect(classified.code).toBe(ErrorCodes.MODEL_API_ERROR.code);
    expect(classified.message).toBe(
      'AI Model Error: The Bedrock request was rejected. Verify the model ID and region configuration.',
    );
    // Must NOT leak raw validation details
    expect(classified.message).not.toContain('minLength');
    expect(classified.message).not.toContain('[messages]');
  });

  it('classifies ResourceNotFoundException as MODEL_API_ERROR with model-not-in-region message', () => {
    const raw = new Error(
      'ResourceNotFoundException: Could not resolve the foundation model from the provided model identifier.',
    );
    const classified = classifyLlmError(raw);

    expect(classified).toBeInstanceOf(AppError);
    expect(classified.code).toBe(ErrorCodes.MODEL_API_ERROR.code);
    expect(classified.message).toContain('not available in the configured region');
    expect(classified.message).toContain('Verify that the model ID is supported');
  });

  it('classifies ServiceUnavailableException as MODEL_API_ERROR with static unavailable message', () => {
    const raw = new Error('ServiceUnavailableException: The service is currently unavailable.');
    const classified = classifyLlmError(raw);

    expect(classified).toBeInstanceOf(AppError);
    expect(classified.code).toBe(ErrorCodes.MODEL_API_ERROR.code);
    expect(classified.message).toBe('AI Model Error: AWS Bedrock service temporarily unavailable.');
    // Must NOT leak internal exception details
    expect(classified.message).not.toContain('ServiceUnavailableException');
  });

  it('non-Bedrock 404 does NOT get Bedrock model-not-in-region message (regression guard)', () => {
    // OpenAI / Anthropic can also return 404 for missing resources.
    // The classifier must not mislabel these as "Bedrock model not available".
    const raw = Object.assign(new Error('Not Found'), { status: 404 });
    const classified = classifyLlmError(raw);
    expect(classified.message).not.toContain('Bedrock model is not available');
    expect(classified.message).not.toContain('Bedrock');
  });

  it('generic "model not found" message does NOT get Bedrock label (regression guard)', () => {
    // "model not found" is a common phrase from non-AWS providers too.
    const raw = new Error('Error: model not found for provider openai');
    const classified = classifyLlmError(raw);
    expect(classified.message).not.toContain('Bedrock');
  });

  it('classifies IRSA "could not load credentials" as CREDENTIAL_NOT_FOUND with static message', () => {
    // fromNodeProviderChain() throws this when running outside AWS or IRSA is misconfigured.
    const raw = new Error('Could not load credentials from any providers');
    const classified = classifyLlmError(raw);
    expect(classified.message).toBe(
      'AI Model Error: AWS Bedrock credential resolution failed. ' +
        'Ensure the platform is running in AWS with an IAM role attached ' +
        'and IRSA is configured correctly.',
    );
    expect(classified.code).toBe('CREDENTIAL_NOT_FOUND');
  });

  it('classifies missing @aws-sdk/credential-providers package error as CREDENTIAL_NOT_FOUND (no package name leaked)', () => {
    // provider-factory.ts throws this when the optional dep is absent.
    const raw = new Error(
      'Bedrock ambient credentials require @aws-sdk/credential-providers. ' +
        'Ensure the package is installed in packages/llm.',
    );
    const classified = classifyLlmError(raw);
    expect(classified.message).toBe(
      'AI Model Error: AWS Bedrock credential resolution failed. ' +
        'Ensure the platform is running in AWS with an IAM role attached ' +
        'and IRSA is configured correctly.',
    );
    expect(classified.code).toBe('CREDENTIAL_NOT_FOUND');
    // The package name must not appear in the user-visible message.
    expect(classified.message).not.toContain('@aws-sdk/credential-providers');
    expect(classified.message).not.toContain('packages/llm');
  });

  it('non-IRSA CREDENTIAL_NOT_FOUND error does NOT get IRSA Bedrock message (regression guard)', () => {
    // A plain auth error must still go through the generic 401/403 branch, not IRSA.
    const raw = Object.assign(new Error('Unauthorized'), { status: 401 });
    const classified = classifyLlmError(raw);
    expect(classified.message).not.toContain('IRSA');
    expect(classified.message).not.toContain('credential resolution failed');
  });
});

describe('isLlmError', () => {
  it('returns true for classified LLM errors', () => {
    const raw = Object.assign(new Error('Rate limit'), { status: 429 });
    const classified = classifyLlmError(raw);
    expect(isLlmError(classified)).toBe(true);
  });

  it('returns false for non-AppError instances', () => {
    expect(isLlmError(new Error('random'))).toBe(false);
  });

  it('returns false for AppError with non-LLM codes', () => {
    const nonLlm = new AppError('Not found', ErrorCodes.NOT_FOUND);
    expect(isLlmError(nonLlm)).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isLlmError('string')).toBe(false);
    expect(isLlmError(null)).toBe(false);
    expect(isLlmError(undefined)).toBe(false);
  });
});

// =============================================================================
// F-1: Strengthened content-filter classification
// =============================================================================

describe('classifyLlmError — F-1: content-filter pattern and code-based classification', () => {
  it('classifies Azure "content management policy" message as MODEL_CONTENT_FILTERED', () => {
    const raw = Object.assign(
      new Error(
        "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
      ),
      { status: 400 },
    );
    const classified = classifyLlmError(raw);

    expect(classified).toBeInstanceOf(AppError);
    expect(classified.code).toBe(ErrorCodes.MODEL_CONTENT_FILTERED.code);
    expect(classified.message).toContain('content safety filter');
  });

  it('classifies Azure "azure openai\'s content" variant phrasing as MODEL_CONTENT_FILTERED', () => {
    const raw = new Error("The prompt was blocked by Azure OpenAI's content filtering system.");
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_CONTENT_FILTERED.code);
  });

  it('classifies Azure ResponsibleAIPolicyViolation (lowercased in message) as MODEL_CONTENT_FILTERED', () => {
    const raw = new Error('ResponsibleAIPolicyViolation: The response was blocked due to policy.');
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_CONTENT_FILTERED.code);
  });

  it('classifies err.code === "content_filter" via direct code check (no message dependency)', () => {
    // Simulates a future SDK version that only exposes the error via `code` field
    const raw = Object.assign(new Error('400 Bad Request'), {
      status: 400,
      code: 'content_filter',
    });
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_CONTENT_FILTERED.code);
    expect(classified.message).toContain('content safety filter');
    // Should attach a diagnostic via the code-based path
    const diag = getLlmErrorDiagnostic(classified);
    expect(diag).toBeDefined();
    expect(diag!.code).toBe('CONTENT_FILTER_CODE_MATCH');
  });

  it('classifies err.code === "content_filter_response" via direct code check', () => {
    const raw = Object.assign(new Error('Output was filtered'), {
      code: 'content_filter_response',
    });
    const classified = classifyLlmError(raw);

    expect(classified.code).toBe(ErrorCodes.MODEL_CONTENT_FILTERED.code);
    const diag = getLlmErrorDiagnostic(classified);
    expect(diag).toBeDefined();
    expect(diag!.operatorHint).toContain('content_filter_response');
  });

  it('code-based check takes priority over rate-limit pattern for status 400 content-filter', () => {
    // Edge case: status 400 with code 'content_filter' — must NOT fall into
    // the generic rate-limit or auth branch.
    const raw = Object.assign(new Error('Request blocked'), {
      status: 400,
      code: 'content_filter',
    });
    const classified = classifyLlmError(raw);
    expect(classified.code).toBe(ErrorCodes.MODEL_CONTENT_FILTERED.code);
  });
});

// =============================================================================
// F-2: Structured content-filter category extraction
// =============================================================================

describe('extractContentFilterCategories', () => {
  it('extracts categories from Azure responseBody (JSON string)', () => {
    const azureResponseBody = JSON.stringify({
      error: {
        innererror: {
          content_filter_result: {
            hate: { severity: 'safe', filtered: false, detected: false },
            jailbreak: { filtered: true, detected: true },
            self_harm: { severity: 'medium', filtered: true, detected: true },
          },
        },
      },
    });
    const err = Object.assign(new Error('Content filter'), {
      responseBody: azureResponseBody,
    });

    const categories = extractContentFilterCategories(err);

    expect(categories).toBeDefined();
    expect(categories).toHaveLength(3);
    expect(categories).toEqual(
      expect.arrayContaining([
        { category: 'hate', severity: 'safe', filtered: false, detected: false },
        { category: 'jailbreak', filtered: true, detected: true },
        {
          category: 'self_harm',
          severity: 'medium',
          filtered: true,
          detected: true,
        },
      ]),
    );
  });

  it('extracts categories from err.data (parsed object)', () => {
    const err = Object.assign(new Error('Content filter'), {
      data: {
        error: {
          innererror: {
            content_filter_result: {
              violence: { severity: 'high', filtered: true, detected: true },
            },
          },
        },
      },
    });

    const categories = extractContentFilterCategories(err);

    expect(categories).toBeDefined();
    expect(categories).toHaveLength(1);
    expect(categories![0]).toEqual({
      category: 'violence',
      severity: 'high',
      filtered: true,
      detected: true,
    });
  });

  it('extracts from error.content_filter_result (flat path)', () => {
    const err = Object.assign(new Error('Content filter'), {
      data: {
        error: {
          content_filter_result: {
            sexual: { severity: 'low', filtered: false, detected: true },
          },
        },
      },
    });

    const categories = extractContentFilterCategories(err);
    expect(categories).toBeDefined();
    expect(categories![0].category).toBe('sexual');
  });

  it('returns undefined for malformed responseBody JSON', () => {
    const err = Object.assign(new Error('Content filter'), {
      responseBody: 'not-valid-json{',
    });
    expect(extractContentFilterCategories(err)).toBeUndefined();
  });

  it('returns undefined for errors without responseBody or data', () => {
    const err = new Error('Content filter');
    expect(extractContentFilterCategories(err)).toBeUndefined();
  });

  it('returns undefined for non-Azure providers (no content_filter_result)', () => {
    const err = Object.assign(new Error('Content filter'), {
      data: { error: { message: 'Generic error without filter data' } },
    });
    expect(extractContentFilterCategories(err)).toBeUndefined();
  });

  it('returns undefined for empty content_filter_result object', () => {
    const err = Object.assign(new Error('Content filter'), {
      data: { error: { innererror: { content_filter_result: {} } } },
    });
    expect(extractContentFilterCategories(err)).toBeUndefined();
  });

  it('skips non-object category values in content_filter_result', () => {
    const err = Object.assign(new Error('Content filter'), {
      data: {
        error: {
          innererror: {
            content_filter_result: {
              hate: { severity: 'safe', filtered: false },
              code: 'ResponsibleAIPolicyViolation', // non-object — should skip
            },
          },
        },
      },
    });

    const categories = extractContentFilterCategories(err);
    expect(categories).toBeDefined();
    expect(categories).toHaveLength(1);
    expect(categories![0].category).toBe('hate');
  });
});

describe('classifyLlmError — F-2: categories attached to classified content-filter error', () => {
  it('attaches categories via diagnostic when code-based content-filter + Azure body present', () => {
    const azureBody = JSON.stringify({
      error: {
        innererror: {
          content_filter_result: {
            jailbreak: { filtered: true, detected: true },
          },
        },
      },
    });
    const err = Object.assign(new Error('Content filter'), {
      code: 'content_filter',
      responseBody: azureBody,
    });

    const classified = classifyLlmError(err);
    const diag = getLlmErrorDiagnostic(classified);

    expect(diag).toBeDefined();
    expect(diag!.contentFilterCategories).toEqual([
      { category: 'jailbreak', filtered: true, detected: true },
    ]);
  });

  it('attaches categories via diagnostic when pattern-based content-filter + Azure body present', () => {
    const azureBody = JSON.stringify({
      error: {
        innererror: {
          content_filter_result: {
            hate: { severity: 'medium', filtered: true, detected: true },
          },
        },
      },
    });
    const err = Object.assign(new Error('Output blocked by content filter'), {
      status: 422,
      responseBody: azureBody,
    });

    const classified = classifyLlmError(err);
    const diag = getLlmErrorDiagnostic(classified);

    expect(diag).toBeDefined();
    expect(diag!.contentFilterCategories).toEqual([
      { category: 'hate', severity: 'medium', filtered: true, detected: true },
    ]);
  });

  it('categories propagate to operator diagnostic', () => {
    const azureBody = JSON.stringify({
      error: {
        innererror: {
          content_filter_result: {
            violence: { severity: 'high', filtered: true, detected: true },
          },
        },
      },
    });
    const err = Object.assign(new Error('Content filter'), {
      code: 'content_filter',
      responseBody: azureBody,
    });

    const classified = classifyLlmError(err);
    const operatorDiag = getLlmOperatorDiagnostic(classified);

    expect(operatorDiag).toBeDefined();
    expect(operatorDiag!.contentFilterCategories).toEqual([
      { category: 'violence', severity: 'high', filtered: true, detected: true },
    ]);
  });

  it('no diagnostic attached when content-filter has no structured body data', () => {
    // Pattern-based match without responseBody — should still classify correctly
    // but no diagnostic with categories
    const err = Object.assign(new Error('Output blocked by content filter'), {
      status: 422,
    });

    const classified = classifyLlmError(err);
    expect(classified.code).toBe(ErrorCodes.MODEL_CONTENT_FILTERED.code);

    // No diagnostic since there are no structured categories
    const diag = getLlmErrorDiagnostic(classified);
    expect(diag).toBeUndefined();
  });
});
