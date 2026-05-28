import { describe, it, expect } from 'vitest';
import {
  ErrorCodes,
  AppError,
  toErrorResponse,
  errorToResponse,
  ValidationError,
} from '../errors.js';

// The 12 "new" error codes (LLM/Model + Execution categories)
const NEW_ERROR_CODES = [
  { key: 'CREDENTIAL_NOT_FOUND', expectedStatus: 503 },
  { key: 'CREDENTIAL_DECRYPTION', expectedStatus: 503 },
  { key: 'MODEL_NOT_CONFIGURED', expectedStatus: 503 },
  { key: 'MODEL_RATE_LIMITED', expectedStatus: 429 },
  { key: 'MODEL_CONTEXT_EXCEEDED', expectedStatus: 400 },
  { key: 'MODEL_TIMEOUT', expectedStatus: 504 },
  { key: 'MODEL_API_ERROR', expectedStatus: 502 },
  { key: 'MODEL_CONTENT_FILTERED', expectedStatus: 422 },
  { key: 'TOOL_BINDING_FAILED', expectedStatus: 503 },
  { key: 'FLOW_STEP_ERROR', expectedStatus: 500 },
  { key: 'HANDOFF_TARGET_MISSING', expectedStatus: 400 },
  { key: 'EXECUTION_TIMEOUT', expectedStatus: 504 },
] as const;

describe('ErrorCodes', () => {
  describe('new error codes exist and have correct statusCode', () => {
    it.each(NEW_ERROR_CODES)('$key has statusCode $expectedStatus', ({ key, expectedStatus }) => {
      const entry = ErrorCodes[key as keyof typeof ErrorCodes];
      expect(entry).toBeDefined();
      expect(entry.code).toBe(key);
      expect(entry.statusCode).toBe(expectedStatus);
    });
  });

  it('all 12 new error codes are present in ErrorCodes', () => {
    for (const { key } of NEW_ERROR_CODES) {
      expect(ErrorCodes).toHaveProperty(key);
    }
  });

  it('every ErrorCodes entry has a code string matching its key', () => {
    for (const [key, entry] of Object.entries(ErrorCodes)) {
      expect(entry.code).toBe(key);
      expect(typeof entry.statusCode).toBe('number');
    }
  });
});

describe('AppError', () => {
  it('can be created with basic code and message', () => {
    const err = new AppError('Something went wrong', { code: 'INTERNAL_ERROR' });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe('Something went wrong');
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.statusCode).toBe(500); // default
  });

  it('accepts a custom statusCode', () => {
    const err = new AppError('Not found', { code: 'NOT_FOUND', statusCode: 404 });

    expect(err.statusCode).toBe(404);
  });

  it('accepts a cause', () => {
    const cause = new Error('root cause');
    const err = new AppError('Wrapper', { code: 'INTERNAL_ERROR', cause });

    expect((err as any).cause).toBe(cause);
  });

  it('stores multiple validation messages when more than one is provided', () => {
    const err = new AppError('Validation failed', {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      messages: ['Field a is required', 'Field b must be a number'],
    });

    expect(err.messages).toEqual(['Field a is required', 'Field b must be a number']);
  });

  it('does not store messages array when only one message is provided', () => {
    const err = new AppError('Validation failed', {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      messages: ['Only one'],
    });

    expect(err.messages).toBeUndefined();
  });

  describe('can be created with each new error code', () => {
    it.each(NEW_ERROR_CODES)('AppError with $key code', ({ key, expectedStatus }) => {
      const entry = ErrorCodes[key as keyof typeof ErrorCodes];
      const err = new AppError(`Test error for ${key}`, {
        code: entry.code,
        statusCode: entry.statusCode,
      });

      expect(err.code).toBe(key);
      expect(err.statusCode).toBe(expectedStatus);
      expect(err.message).toBe(`Test error for ${key}`);
    });
  });
});

describe('ValidationError', () => {
  it('uses VALIDATION_ERROR code and 400 status', () => {
    const err = new ValidationError('Input invalid');

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
  });
});

describe('toErrorResponse', () => {
  it('builds a standard error response body', () => {
    const result = toErrorResponse('NOT_FOUND', 'Resource not found');

    expect(result).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
  });

  it.each(NEW_ERROR_CODES)('works with $key error code', ({ key }) => {
    const entry = ErrorCodes[key as keyof typeof ErrorCodes];
    const result = toErrorResponse(entry.code, `Error: ${key}`);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe(key);
    expect(result.error.message).toBe(`Error: ${key}`);
  });
});

describe('errorToResponse', () => {
  it('extracts statusCode and body from AppError', () => {
    const err = new AppError('Model timed out', {
      code: 'MODEL_TIMEOUT',
      statusCode: 504,
    });
    const { statusCode, body } = errorToResponse(err);

    expect(statusCode).toBe(504);
    expect(body).toEqual({
      success: false,
      error: { code: 'MODEL_TIMEOUT', message: 'Model timed out' },
    });
  });

  it('defaults to 500 / INTERNAL_ERROR for plain Error', () => {
    const err = new Error('Something broke');
    const { statusCode, body } = errorToResponse(err);

    expect(statusCode).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Something broke');
  });

  it('handles non-Error values (string)', () => {
    const { statusCode, body } = errorToResponse('unexpected string error');

    expect(statusCode).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('unexpected string error');
  });

  it('handles non-Error values (null)', () => {
    const { statusCode, body } = errorToResponse(null);

    expect(statusCode).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
