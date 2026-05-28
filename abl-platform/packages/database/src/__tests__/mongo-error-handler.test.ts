/**
 * MongoDB Error Handler Tests
 *
 * Tests for: error classification, MongoAppError, wrapError, isRetryableError
 */

import { describe, test, expect } from 'vitest';

import {
  classifyError,
  wrapError,
  isRetryableError,
  MongoAppError,
  MongoErrorCode,
} from '../mongo/middleware/error-handler.js';

// =============================================================================
// ERROR CLASSIFICATION
// =============================================================================

describe('classifyError', () => {
  describe('duplicate key errors', () => {
    test('classifies E11000 by error code', () => {
      const error: any = new Error('some message');
      error.code = 11000;

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.DUPLICATE_KEY);
      expect(result.retryable).toBe(false);
    });

    test('classifies E11000 by message content', () => {
      const error = new Error('E11000 duplicate key error collection: db.users index: email_1');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.DUPLICATE_KEY);
      expect(result.retryable).toBe(false);
    });
  });

  describe('validation errors', () => {
    test('classifies ValidationError by name', () => {
      const error = new Error('Path `name` is required');
      error.name = 'ValidationError';

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.VALIDATION);
      expect(result.retryable).toBe(false);
    });
  });

  describe('timeout errors', () => {
    test('classifies MongoServerSelectionError', () => {
      const error = new Error('timeout');
      error.name = 'MongoServerSelectionError';

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.TIMEOUT);
      expect(result.retryable).toBe(true);
    });

    test('classifies serverSelectionTimeout message', () => {
      const error = new Error('serverSelectionTimeout exceeded');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.TIMEOUT);
      expect(result.retryable).toBe(true);
    });

    test('classifies socketTimeout message', () => {
      const error = new Error('socketTimeout after 30000ms');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.TIMEOUT);
      expect(result.retryable).toBe(true);
    });

    test('classifies timed out message', () => {
      const error = new Error('Operation timed out');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.TIMEOUT);
      expect(result.retryable).toBe(true);
    });

    test('classifies ETIMEDOUT message', () => {
      const error = new Error('connect ETIMEDOUT');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.TIMEOUT);
      expect(result.retryable).toBe(true);
    });
  });

  describe('network errors', () => {
    test('classifies MongoNetworkError', () => {
      const error = new Error('connection refused');
      error.name = 'MongoNetworkError';

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.NETWORK);
      expect(result.retryable).toBe(true);
    });

    test('classifies MongoNetworkTimeoutError', () => {
      const error = new Error('timeout');
      error.name = 'MongoNetworkTimeoutError';

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.NETWORK);
      expect(result.retryable).toBe(true);
    });

    test('classifies ECONNREFUSED', () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:27017');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.NETWORK);
      expect(result.retryable).toBe(true);
    });

    test('classifies ECONNRESET', () => {
      const error = new Error('read ECONNRESET');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.NETWORK);
      expect(result.retryable).toBe(true);
    });

    test('classifies EPIPE', () => {
      const error = new Error('write EPIPE');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.NETWORK);
      expect(result.retryable).toBe(true);
    });

    test('classifies connection closed', () => {
      const error = new Error('connection closed before reply');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.NETWORK);
      expect(result.retryable).toBe(true);
    });

    test('classifies topology was destroyed', () => {
      const error = new Error('topology was destroyed');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.NETWORK);
      expect(result.retryable).toBe(true);
    });
  });

  describe('write conflict errors', () => {
    test('classifies write conflict by code 112', () => {
      const error: any = new Error('write conflict');
      error.code = 112;

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.WRITE_CONFLICT);
      expect(result.retryable).toBe(true);
    });

    test('classifies WriteConflict by message', () => {
      const error = new Error('WriteConflict error occurred');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.WRITE_CONFLICT);
      expect(result.retryable).toBe(true);
    });
  });

  describe('authorization errors', () => {
    test('classifies auth error by code 13', () => {
      const error: any = new Error('not authorized');
      error.code = 13;

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.UNAUTHORIZED);
      expect(result.retryable).toBe(false);
    });

    test('classifies auth error by code 18', () => {
      const error: any = new Error('auth failed');
      error.code = 18;

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.UNAUTHORIZED);
      expect(result.retryable).toBe(false);
    });

    test('classifies "not authorized" message', () => {
      const error = new Error('not authorized on admin to execute command');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.UNAUTHORIZED);
      expect(result.retryable).toBe(false);
    });

    test('classifies "Authentication failed" message', () => {
      const error = new Error('Authentication failed');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.UNAUTHORIZED);
      expect(result.retryable).toBe(false);
    });
  });

  describe('shard key errors', () => {
    test('classifies shard key violation by message', () => {
      const error = new Error('shard key value is missing');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.SHARD_KEY_VIOLATION);
      expect(result.retryable).toBe(false);
    });

    test('classifies ShardKeyNotFound', () => {
      const error = new Error('ShardKeyNotFound for insert');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.SHARD_KEY_VIOLATION);
      expect(result.retryable).toBe(false);
    });
  });

  describe('document too large errors', () => {
    test('classifies by code 10334', () => {
      const error: any = new Error('object too large');
      error.code = 10334;

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.DOCUMENT_TOO_LARGE);
      expect(result.retryable).toBe(false);
    });

    test('classifies BSONObj size message', () => {
      const error = new Error('BSONObj size: 20000000 (0x1312D00) is invalid');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.DOCUMENT_TOO_LARGE);
      expect(result.retryable).toBe(false);
    });

    test('classifies exceeds maximum message', () => {
      const error = new Error('document exceeds maximum allowed size');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.DOCUMENT_TOO_LARGE);
      expect(result.retryable).toBe(false);
    });
  });

  describe('unknown errors', () => {
    test('classifies unrecognized errors as UNKNOWN', () => {
      const error = new Error('something unexpected happened');

      const result = classifyError(error);

      expect(result.code).toBe(MongoErrorCode.UNKNOWN);
      expect(result.retryable).toBe(false);
    });

    test('classifies non-Error values as UNKNOWN', () => {
      const result = classifyError('string error');

      expect(result.code).toBe(MongoErrorCode.UNKNOWN);
      expect(result.retryable).toBe(false);
    });

    test('classifies null as UNKNOWN', () => {
      const result = classifyError(null);

      expect(result.code).toBe(MongoErrorCode.UNKNOWN);
      expect(result.retryable).toBe(false);
    });
  });
});

// =============================================================================
// WRAP ERROR
// =============================================================================

describe('wrapError', () => {
  test('wraps an Error into MongoAppError with context', () => {
    const error: any = new Error('duplicate key');
    error.code = 11000;

    const wrapped = wrapError(error, 'users', 'create', 50);

    expect(wrapped).toBeInstanceOf(MongoAppError);
    expect(wrapped.code).toBe(MongoErrorCode.DUPLICATE_KEY);
    expect(wrapped.collection).toBe('users');
    expect(wrapped.operation).toBe('create');
    expect(wrapped.duration).toBe(50);
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.originalError).toBe(error);
    expect(wrapped.name).toBe('MongoAppError');
  });

  test('wraps non-Error values', () => {
    const wrapped = wrapError('string error', 'sessions', 'find', 10);

    expect(wrapped).toBeInstanceOf(MongoAppError);
    expect(wrapped.code).toBe(MongoErrorCode.UNKNOWN);
    expect(wrapped.originalError.message).toBe('string error');
  });

  test('message includes code, collection, and operation', () => {
    const error = new Error('connection refused');
    error.name = 'MongoNetworkError';

    const wrapped = wrapError(error, 'messages', 'find', 100);

    expect(wrapped.message).toContain('NETWORK');
    expect(wrapped.message).toContain('messages');
    expect(wrapped.message).toContain('find');
  });

  test('preserves retryable flag for timeout errors', () => {
    const error = new Error('server selection timed out');
    error.name = 'MongoServerSelectionError';

    const wrapped = wrapError(error, 'agents', 'findOne', 5000);

    expect(wrapped.retryable).toBe(true);
  });
});

// =============================================================================
// IS RETRYABLE ERROR
// =============================================================================

describe('isRetryableError', () => {
  test('returns true for MongoAppError with retryable flag', () => {
    const error = new MongoAppError({
      code: MongoErrorCode.NETWORK,
      message: 'network error',
      collection: 'test',
      operation: 'find',
      duration: 100,
      retryable: true,
      originalError: new Error('test'),
    });

    expect(isRetryableError(error)).toBe(true);
  });

  test('returns false for MongoAppError without retryable flag', () => {
    const error = new MongoAppError({
      code: MongoErrorCode.DUPLICATE_KEY,
      message: 'dup key',
      collection: 'test',
      operation: 'create',
      duration: 50,
      retryable: false,
      originalError: new Error('test'),
    });

    expect(isRetryableError(error)).toBe(false);
  });

  test('classifies raw network errors as retryable', () => {
    const error = new Error('connection refused');
    error.name = 'MongoNetworkError';

    expect(isRetryableError(error)).toBe(true);
  });

  test('classifies raw timeout errors as retryable', () => {
    const error = new Error('timed out');
    error.name = 'MongoServerSelectionError';

    expect(isRetryableError(error)).toBe(true);
  });

  test('classifies raw write conflict as retryable', () => {
    const error: any = new Error('WriteConflict');
    error.code = 112;

    expect(isRetryableError(error)).toBe(true);
  });

  test('classifies validation errors as not retryable', () => {
    const error = new Error('validation failed');
    error.name = 'ValidationError';

    expect(isRetryableError(error)).toBe(false);
  });

  test('classifies duplicate key errors as not retryable', () => {
    const error: any = new Error('E11000');
    error.code = 11000;

    expect(isRetryableError(error)).toBe(false);
  });

  test('classifies unknown errors as not retryable', () => {
    const error = new Error('something random');

    expect(isRetryableError(error)).toBe(false);
  });

  test('handles non-Error values', () => {
    expect(isRetryableError('string')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

// =============================================================================
// MONGO APP ERROR
// =============================================================================

describe('MongoAppError', () => {
  test('extends Error', () => {
    const error = new MongoAppError({
      code: MongoErrorCode.UNKNOWN,
      message: 'test',
      collection: 'test',
      operation: 'test',
      duration: 0,
      retryable: false,
      originalError: new Error('original'),
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MongoAppError);
  });

  test('has all required properties', () => {
    const original = new Error('original');
    const error = new MongoAppError({
      code: MongoErrorCode.TIMEOUT,
      message: 'timed out',
      collection: 'sessions',
      operation: 'find',
      duration: 5000,
      retryable: true,
      originalError: original,
    });

    expect(error.code).toBe(MongoErrorCode.TIMEOUT);
    expect(error.message).toBe('timed out');
    expect(error.collection).toBe('sessions');
    expect(error.operation).toBe('find');
    expect(error.duration).toBe(5000);
    expect(error.retryable).toBe(true);
    expect(error.originalError).toBe(original);
    expect(error.name).toBe('MongoAppError');
  });
});

// =============================================================================
// MONGO ERROR CODE ENUM
// =============================================================================

describe('MongoErrorCode', () => {
  test('has all expected codes', () => {
    expect(MongoErrorCode.DUPLICATE_KEY).toBe('DUPLICATE_KEY');
    expect(MongoErrorCode.VALIDATION).toBe('VALIDATION');
    expect(MongoErrorCode.TIMEOUT).toBe('TIMEOUT');
    expect(MongoErrorCode.NETWORK).toBe('NETWORK');
    expect(MongoErrorCode.WRITE_CONFLICT).toBe('WRITE_CONFLICT');
    expect(MongoErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(MongoErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(MongoErrorCode.SHARD_KEY_VIOLATION).toBe('SHARD_KEY_VIOLATION');
    expect(MongoErrorCode.DOCUMENT_TOO_LARGE).toBe('DOCUMENT_TOO_LARGE');
    expect(MongoErrorCode.UNKNOWN).toBe('UNKNOWN');
  });
});
