import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractErrorMessage, sanitizeError, sanitizeServerError } from '../lib/sanitize-error';

describe('sanitizeError', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Technical patterns should be blocked
  // -------------------------------------------------------------------------

  it('blocks stack trace patterns', () => {
    const error = new Error('at Object.<anonymous> (/src/index.ts:42:10)');
    expect(sanitizeError(error, 'Something went wrong')).toBe('Something went wrong');
  });

  it('blocks file path patterns (.ts:line)', () => {
    const error = new Error('Error in module.ts:42');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks node_modules paths', () => {
    const error = new Error('Cannot find module node_modules/foo/bar');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks ECONNREFUSED', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    expect(sanitizeError(error, 'Connection failed')).toBe('Connection failed');
  });

  it('blocks ECONNRESET', () => {
    const error = new Error('read ECONNRESET');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks ETIMEDOUT', () => {
    const error = new Error('connect ETIMEDOUT 10.0.0.1:443');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks Prisma error codes (P2002)', () => {
    const error = new Error('Unique constraint failed on the fields: (`email`) P2002');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks SQLITE_ errors', () => {
    const error = new Error('SQLITE_BUSY: database is locked');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks MongoServerError', () => {
    const error = new Error('MongoServerError: E11000 duplicate key error');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks TypeError', () => {
    const error = new Error("TypeError: Cannot read property 'foo' of undefined");
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks ReferenceError', () => {
    const error = new Error('ReferenceError: x is not defined');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks "Cannot read propert" pattern', () => {
    const error = new Error("Cannot read properties of null (reading 'map')");
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks "is not a function" pattern', () => {
    const error = new Error('foo.bar is not a function');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks "Internal Server Error"', () => {
    const error = new Error('Internal Server Error');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks "fetch failed"', () => {
    const error = new Error('fetch failed');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks "unique constraint" messages', () => {
    const error = new Error('unique constraint violation on users.email');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  it('blocks "socket hang up"', () => {
    const error = new Error('socket hang up');
    expect(sanitizeError(error, 'fallback')).toBe('fallback');
  });

  // -------------------------------------------------------------------------
  // Safe messages should pass through
  // -------------------------------------------------------------------------

  it('passes through "Agent not found"', () => {
    const error = new Error('Agent not found');
    expect(sanitizeError(error, 'fallback')).toBe('Agent not found');
  });

  it('passes through "Version already exists"', () => {
    const error = new Error('Version already exists');
    expect(sanitizeError(error, 'fallback')).toBe('Version already exists');
  });

  it('passes through "Rate limit exceeded"', () => {
    const error = new Error('Rate limit exceeded');
    expect(sanitizeError(error, 'fallback')).toBe('Rate limit exceeded');
  });

  it('passes through "Access denied"', () => {
    const error = new Error('Access denied');
    expect(sanitizeError(error, 'fallback')).toBe('Access denied');
  });

  it('passes through "Invalid credentials"', () => {
    const error = new Error('Invalid credentials');
    expect(sanitizeError(error, 'fallback')).toBe('Invalid credentials');
  });

  // -------------------------------------------------------------------------
  // Length cap
  // -------------------------------------------------------------------------

  it('blocks messages exceeding 200 characters', () => {
    const longMessage = 'A'.repeat(201);
    const error = new Error(longMessage);
    expect(sanitizeError(error, 'Too long')).toBe('Too long');
  });

  it('passes through messages at exactly 200 characters', () => {
    const message = 'A'.repeat(200);
    const error = new Error(message);
    expect(sanitizeError(error, 'fallback')).toBe(message);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('returns fallback for non-Error objects', () => {
    expect(sanitizeError(42, 'fallback')).toBe('fallback');
    expect(sanitizeError(null, 'fallback')).toBe('fallback');
    expect(sanitizeError(undefined, 'fallback')).toBe('fallback');
    expect(sanitizeError({}, 'fallback')).toBe('fallback');
  });

  it('handles string errors', () => {
    expect(sanitizeError('Something broke', 'fallback')).toBe('Something broke');
    expect(sanitizeError('TypeError: bad stuff', 'fallback')).toBe('fallback');
  });

  it('returns fallback for empty string error', () => {
    expect(sanitizeError('', 'fallback')).toBe('fallback');
    expect(sanitizeError(new Error(''), 'fallback')).toBe('fallback');
  });
});

describe('sanitizeServerError', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it('returns fallback for undefined', () => {
    expect(sanitizeServerError(undefined, 'fallback')).toBe('fallback');
  });

  it('returns fallback for empty string', () => {
    expect(sanitizeServerError('', 'fallback')).toBe('fallback');
  });

  it('passes through safe server messages', () => {
    expect(sanitizeServerError('Agent not found', 'fallback')).toBe('Agent not found');
    expect(sanitizeServerError('Version already exists', 'fallback')).toBe(
      'Version already exists',
    );
    expect(sanitizeServerError('No active deployment', 'fallback')).toBe('No active deployment');
  });

  it('blocks technical server messages', () => {
    expect(sanitizeServerError('ECONNREFUSED 127.0.0.1:5432', 'fallback')).toBe('fallback');
    expect(sanitizeServerError('P2002 unique constraint failed', 'fallback')).toBe('fallback');
    expect(sanitizeServerError('TypeError: Cannot read properties of null', 'fallback')).toBe(
      'fallback',
    );
  });

  it('blocks overly long messages', () => {
    const long = 'x'.repeat(201);
    expect(sanitizeServerError(long, 'fallback')).toBe('fallback');
  });
});

describe('extractErrorMessage', () => {
  it('unwraps structured server error envelopes', () => {
    expect(
      extractErrorMessage(
        {
          error: {
            code: 'DUPLICATE_MODEL',
            message: 'A model with this display name already exists for this tenant',
          },
        },
        'fallback',
      ),
    ).toBe('A model with this display name already exists for this tenant');
  });

  it('falls back instead of stringifying object-only server errors', () => {
    expect(extractErrorMessage({ error: { code: 'DUPLICATE_MODEL' } }, 'fallback')).toBe(
      'fallback',
    );
  });

  it('supports string and validation-array server envelopes', () => {
    expect(extractErrorMessage({ error: 'Invalid credentials' }, 'fallback')).toBe(
      'Invalid credentials',
    );
    expect(extractErrorMessage({ errors: [{ msg: 'Display name is required' }] }, 'fallback')).toBe(
      'Display name is required',
    );
    expect(
      extractErrorMessage(
        { errors: ["Step 'Examples' must declare REASONING: true or REASONING: false."] },
        'fallback',
      ),
    ).toBe("Step 'Examples' must declare REASONING: true or REASONING: false.");
  });
});
