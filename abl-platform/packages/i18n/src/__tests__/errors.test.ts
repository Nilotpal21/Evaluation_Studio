import { describe, it, expect } from 'vitest';
import { ErrorCatalog, formatErrorSync } from '../errors.js';

describe('ErrorCatalog', () => {
  it('has AUTH_MISSING_HEADER', () => {
    expect(ErrorCatalog.AUTH_MISSING_HEADER).toBeDefined();
  });

  it('has all required error codes', () => {
    const required = [
      'AUTH_MISSING_HEADER',
      'AUTH_INVALID_KEY',
      'AUTH_INVALID_TOKEN',
      'TENANT_REQUIRED',
      'PROJECT_NOT_FOUND',
      'VALIDATION_FAILED',
      'INTERNAL_SERVER_ERROR',
    ];
    for (const code of required) {
      expect(ErrorCatalog).toHaveProperty(code);
    }
  });
});

describe('formatErrorSync', () => {
  it('returns code and message', () => {
    const result = formatErrorSync('AUTH_MISSING_HEADER');
    expect(result).toEqual({
      code: 'AUTH_MISSING_HEADER',
      message: 'Authentication header is required',
    });
  });

  it('substitutes ICU parameters', () => {
    const result = formatErrorSync('PROJECT_NOT_FOUND', { projectId: 'abc-123' });
    expect(result.code).toBe('PROJECT_NOT_FOUND');
    expect(result.message).toContain('abc-123');
  });

  it('returns code as message for unknown codes', () => {
    const result = formatErrorSync('UNKNOWN_CODE');
    expect(result).toEqual({
      code: 'UNKNOWN_CODE',
      message: 'UNKNOWN_CODE',
    });
  });
});
