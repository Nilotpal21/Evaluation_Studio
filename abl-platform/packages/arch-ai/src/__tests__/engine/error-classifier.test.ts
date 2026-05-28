import { describe, expect, it } from 'vitest';
import {
  classifyToolError,
  classifyModelError,
  backoffDelayMs,
  TimeoutError,
  AbortError,
  ZodValidationError,
  ToolErrorCode,
  ModelErrorCode,
  type ToolExecutionError,
  type ModelProviderError,
} from '../../engine/error-classifier.js';

describe('error-classifier', () => {
  describe('classifyToolError', () => {
    it('classifies AbortError as TOOL_EXECUTION_FAILED', () => {
      const err = new AbortError('Operation aborted');
      const result = classifyToolError(err);

      expect(result).toEqual<ToolExecutionError>({
        category: 'tool',
        code: ToolErrorCode.TOOL_EXECUTION_FAILED,
        message: 'Operation was aborted.',
      });
    });

    it('classifies TimeoutError as TOOL_TIMEOUT without context', () => {
      const err = new TimeoutError('Timed out');
      const result = classifyToolError(err);

      expect(result).toEqual<ToolExecutionError>({
        category: 'tool',
        code: ToolErrorCode.TOOL_TIMEOUT,
        message: 'Operation timed out.',
      });
    });

    it('classifies TimeoutError as TOOL_TIMEOUT with context', () => {
      const err = new TimeoutError('Timed out');
      const result = classifyToolError(err, 'read_file operation');

      expect(result).toEqual<ToolExecutionError>({
        category: 'tool',
        code: ToolErrorCode.TOOL_TIMEOUT,
        message: 'Operation timed out: read_file operation',
      });
    });

    it('classifies ZodValidationError as ARGS_INVALID with details', () => {
      const issues = [{ path: ['field'], message: 'Required' }];
      const err = new ZodValidationError(issues);
      const result = classifyToolError(err);

      expect(result).toEqual<ToolExecutionError>({
        category: 'tool',
        code: ToolErrorCode.ARGS_INVALID,
        message: 'Operation arguments failed validation.',
        details: issues,
      });
    });

    it('classifies generic Error as TOOL_EXECUTION_FAILED', () => {
      const err = new Error('Something went wrong');
      const result = classifyToolError(err);

      expect(result).toEqual<ToolExecutionError>({
        category: 'tool',
        code: ToolErrorCode.TOOL_EXECUTION_FAILED,
        message: 'Something went wrong',
      });
    });

    it('classifies string error as TOOL_EXECUTION_FAILED', () => {
      const result = classifyToolError('error string');

      expect(result).toEqual<ToolExecutionError>({
        category: 'tool',
        code: ToolErrorCode.TOOL_EXECUTION_FAILED,
        message: 'error string',
      });
    });

    it('classifies number error as TOOL_EXECUTION_FAILED', () => {
      const result = classifyToolError(42);

      expect(result).toEqual<ToolExecutionError>({
        category: 'tool',
        code: ToolErrorCode.TOOL_EXECUTION_FAILED,
        message: '42',
      });
    });

    it('classifies object error as TOOL_EXECUTION_FAILED', () => {
      const result = classifyToolError({ foo: 'bar' });

      expect(result).toEqual<ToolExecutionError>({
        category: 'tool',
        code: ToolErrorCode.TOOL_EXECUTION_FAILED,
        message: '[object Object]',
      });
    });
  });

  describe('classifyModelError', () => {
    it('classifies 429 status as MODEL_RATE_LIMITED', () => {
      const err = Object.assign(new Error('Rate limited'), { status: 429 });
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_RATE_LIMITED,
        retry: true,
        maxAttempts: 4,
        backoffMs: 1000,
        reason: 'model_provider_error',
        message:
          'Model provider rate limit reached for Arch. Retry after the provider window resets.',
      });
    });

    it('classifies 401 status as MODEL_AUTH', () => {
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_AUTH,
        retry: false,
        maxAttempts: 0,
        backoffMs: 0,
        reason: 'model_auth_error',
        message: 'Model provider authentication failed for Arch. Check the provider connection.',
      });
    });

    it('classifies 403 status as MODEL_AUTH', () => {
      const err = Object.assign(new Error('Forbidden'), { status: 403 });
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_AUTH,
        retry: false,
        maxAttempts: 0,
        backoffMs: 0,
        reason: 'model_auth_error',
        message: 'Model provider authentication failed for Arch. Check the provider connection.',
      });
    });

    it('classifies 500 status as MODEL_PROVIDER_5XX', () => {
      const err = Object.assign(new Error('Server error'), { status: 500 });
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_PROVIDER_5XX,
        retry: true,
        maxAttempts: 2,
        backoffMs: 1000,
        reason: 'model_provider_error',
        message: 'Model provider returned a temporary server error. Retry the Arch request.',
      });
    });

    it('classifies 503 status as MODEL_PROVIDER_5XX', () => {
      const err = Object.assign(new Error('Service unavailable'), { status: 503 });
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_PROVIDER_5XX,
        retry: true,
        maxAttempts: 2,
        backoffMs: 1000,
        reason: 'model_provider_error',
        message: 'Model provider returned a temporary server error. Retry the Arch request.',
      });
    });

    it('classifies statusCode field as well as status', () => {
      const err = Object.assign(new Error('Rate limited'), { statusCode: 429 });
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_RATE_LIMITED);
    });

    it('classifies "context length" message as MODEL_CONTEXT_LENGTH', () => {
      const err = new Error('Request exceeds context length limit');
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_CONTEXT_LENGTH,
        retry: true,
        maxAttempts: 1,
        backoffMs: 0,
        reason: 'model_context_length',
        message: 'The conversation history is too long. Please start a new session.',
      });
    });

    it('classifies "context window" message as MODEL_CONTEXT_LENGTH', () => {
      const err = new Error('Context window exceeded');
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_CONTEXT_LENGTH,
        retry: true,
        maxAttempts: 1,
        backoffMs: 0,
        reason: 'model_context_length',
        message: 'The conversation history is too long. Please start a new session.',
      });
    });

    it('classifies context_length_exceeded code as MODEL_CONTEXT_LENGTH', () => {
      const err = Object.assign(new Error('Error'), { code: 'context_length_exceeded' });
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_CONTEXT_LENGTH);
    });

    it('classifies TimeoutError by name as MODEL_TIMEOUT', () => {
      const err = new Error('Timed out');
      err.name = 'TimeoutError';
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_TIMEOUT,
        retry: false,
        maxAttempts: 0,
        backoffMs: 0,
        reason: 'model_timeout',
        message: 'Model provider request timed out while Arch was generating a response.',
      });
    });

    it('classifies AbortError by name as MODEL_TIMEOUT', () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_TIMEOUT);
    });

    it('classifies "timeout" in message as MODEL_TIMEOUT', () => {
      const err = new Error('Request timeout occurred');
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_TIMEOUT);
    });

    it('classifies ETIMEDOUT code as MODEL_TIMEOUT', () => {
      const err = Object.assign(new Error('Error'), { code: 'ETIMEDOUT' });
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_TIMEOUT);
    });

    it('classifies Anthropic credit balance error as MODEL_BILLING', () => {
      const err = Object.assign(
        new Error(
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
        ),
        { status: 400 },
      );
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_BILLING,
        retry: false,
        maxAttempts: 0,
        backoffMs: 0,
        reason: 'model_auth_error',
        message:
          'Model provider billing or quota check failed. Review the connected account and billing settings.',
      });
    });

    it('classifies HTTP 402 as MODEL_BILLING', () => {
      const err = Object.assign(new Error('Payment required'), { status: 402 });
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_BILLING);
      expect(result.retry).toBe(false);
    });

    it('classifies "quota exceeded" message as MODEL_BILLING', () => {
      const err = new Error('You have exceeded your quota for this month');
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_BILLING);
      expect(result.retry).toBe(false);
    });

    it('classifies "insufficient credits" message as MODEL_BILLING', () => {
      const err = new Error('Insufficient credits to process this request');
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_BILLING);
      expect(result.retry).toBe(false);
    });

    it('classifies "spending limit" message as MODEL_BILLING', () => {
      const err = new Error('You have reached your spending limit');
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_BILLING);
      expect(result.retry).toBe(false);
    });

    it('classifies Azure content management policy errors as MODEL_CONTENT_FILTER', () => {
      const err = Object.assign(
        new Error(
          "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
        ),
        { status: 400, code: 'content_filter' },
      );
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_CONTENT_FILTER,
        retry: false,
        maxAttempts: 0,
        backoffMs: 0,
        reason: 'model_provider_error',
        message:
          'Model provider content filtering blocked the response. Adjust the request and retry.',
      });
    });

    it('classifies configuration errors without echoing internal setup details', () => {
      const err = Object.assign(new Error("No AI model is configured for tenant 'tenant-dev'"), {
        code: 'MODEL_CONFIG_ERROR',
      });
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_CONFIG_ERROR,
        retry: false,
        maxAttempts: 0,
        backoffMs: 0,
        reason: 'model_auth_error',
        message: 'Arch model configuration is incomplete or invalid. Check Arch model settings.',
      });
    });

    it('classifies unknown error as MODEL_PROVIDER_UNKNOWN', () => {
      const err = new Error('Something weird happened');
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_PROVIDER_UNKNOWN,
        retry: true,
        maxAttempts: 2,
        backoffMs: 1000,
        reason: 'model_provider_error',
        message:
          'Model provider error while running Arch: Something weird happened. Check Arch model settings.',
      });
    });

    it('classifies plain object with status field', () => {
      const err = { status: 429, message: 'Rate limited' };
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_RATE_LIMITED);
    });

    it('classifies plain object with statusCode field', () => {
      const err = { statusCode: 500, message: 'Internal error' };
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_PROVIDER_5XX);
    });

    it('classifies plain object with code field', () => {
      const err = { code: 'context_length_exceeded', message: 'Too long' };
      const result = classifyModelError(err);

      expect(result.code).toBe(ModelErrorCode.MODEL_CONTEXT_LENGTH);
    });

    it('classifies plain object with numeric code field', () => {
      const err = { code: 429, message: 'Rate limited' };
      const result = classifyModelError(err);

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_PROVIDER_UNKNOWN,
        retry: true,
        maxAttempts: 2,
        backoffMs: 1000,
        reason: 'model_provider_error',
        message:
          'Model provider error while running Arch: Rate limited. Check Arch model settings.',
      });
    });

    it('classifies string error as MODEL_PROVIDER_UNKNOWN', () => {
      const result = classifyModelError('error string');

      expect(result).toEqual<ModelProviderError>({
        category: 'model',
        code: ModelErrorCode.MODEL_PROVIDER_UNKNOWN,
        retry: true,
        maxAttempts: 2,
        backoffMs: 1000,
        reason: 'model_provider_error',
        message:
          'Model provider error while running Arch: error string. Check Arch model settings.',
      });
    });

    it('classifies number error as MODEL_PROVIDER_UNKNOWN', () => {
      const result = classifyModelError(42);

      expect(result.code).toBe(ModelErrorCode.MODEL_PROVIDER_UNKNOWN);
    });

    it('classifies null as MODEL_PROVIDER_UNKNOWN', () => {
      const result = classifyModelError(null);

      expect(result.code).toBe(ModelErrorCode.MODEL_PROVIDER_UNKNOWN);
    });

    it('classifies undefined as MODEL_PROVIDER_UNKNOWN', () => {
      const result = classifyModelError(undefined);

      expect(result.code).toBe(ModelErrorCode.MODEL_PROVIDER_UNKNOWN);
    });
  });

  describe('backoffDelayMs', () => {
    it('returns base delay for attempt 1', () => {
      expect(backoffDelayMs(1000, 1)).toBe(1000);
    });

    it('doubles for attempt 2', () => {
      expect(backoffDelayMs(1000, 2)).toBe(2000);
    });

    it('quadruples for attempt 3', () => {
      expect(backoffDelayMs(1000, 3)).toBe(4000);
    });

    it('caps at 30 seconds', () => {
      expect(backoffDelayMs(1000, 10)).toBe(30_000);
      expect(backoffDelayMs(5000, 10)).toBe(30_000);
    });

    it('handles base delay of zero', () => {
      expect(backoffDelayMs(0, 5)).toBe(0);
    });

    it('handles attempt 0 (returns base)', () => {
      expect(backoffDelayMs(1000, 0)).toBe(1000);
    });

    it('handles negative attempt (returns base)', () => {
      expect(backoffDelayMs(1000, -1)).toBe(1000);
    });
  });

  describe('sentinel error classes', () => {
    it('TimeoutError has correct name and message', () => {
      const err = new TimeoutError();
      expect(err.name).toBe('TimeoutError');
      expect(err.message).toBe('Operation timed out');
      expect(err).toBeInstanceOf(Error);
    });

    it('TimeoutError accepts custom message', () => {
      const err = new TimeoutError('Custom timeout');
      expect(err.message).toBe('Custom timeout');
    });

    it('AbortError has correct name and message', () => {
      const err = new AbortError();
      expect(err.name).toBe('AbortError');
      expect(err.message).toBe('Operation aborted');
      expect(err).toBeInstanceOf(Error);
    });

    it('AbortError accepts custom message', () => {
      const err = new AbortError('Custom abort');
      expect(err.message).toBe('Custom abort');
    });

    it('ZodValidationError has correct name, message, and issues', () => {
      const issues = [{ path: ['field'], message: 'Required' }];
      const err = new ZodValidationError(issues);
      expect(err.name).toBe('ZodValidationError');
      expect(err.message).toBe('Validation failed');
      expect(err.issues).toEqual(issues);
      expect(err).toBeInstanceOf(Error);
    });

    it('ZodValidationError accepts custom message', () => {
      const issues = [{ path: ['field'], message: 'Required' }];
      const err = new ZodValidationError(issues, 'Custom validation error');
      expect(err.message).toBe('Custom validation error');
      expect(err.issues).toEqual(issues);
    });
  });
});
