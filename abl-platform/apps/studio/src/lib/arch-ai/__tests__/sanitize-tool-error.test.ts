import { describe, it, expect } from 'vitest';
import { sanitizeToolError } from '../sanitize-tool-error';

describe('sanitizeToolError', () => {
  it('strips full URLs with embedded credentials', () => {
    const result = sanitizeToolError(
      new Error('fetch failed: https://user:hunter2@api.example.com/v1/users?token=abc'),
    );
    expect(result.message).not.toContain('hunter2');
    expect(result.message).not.toContain('token=abc');
    expect(result.message).toContain('api.example.com');
  });

  it('strips internal hostnames', () => {
    const result = sanitizeToolError(
      new Error('connect ECONNREFUSED studio.svc.cluster.local:3000'),
    );
    expect(result.message).not.toContain('svc.cluster.local');
  });

  it('strips full stack traces (from err.stack)', () => {
    const err = new Error('Boom');
    err.stack = 'Error: Boom\n  at internal/process/task_queues.js:95:5\n  at /app/src/foo.ts:42';
    const result = sanitizeToolError(err);
    expect(result.message).not.toContain('task_queues');
    expect(result.message).not.toContain('/app/src');
    // STACK_TRACE_LINE specifically removes `\n  at ...` frame lines —
    // FILE_PATH alone cannot scrub the `at ` keyword, so this assertion
    // only holds when STACK_TRACE_LINE is actively running.
    expect(result.message).not.toMatch(/\n\s+at\s+/);
    // The original error message should still survive.
    expect(result.message).toContain('Boom');
  });

  it('strips file paths embedded in err.message (no err.stack)', () => {
    const err = new Error('Failed at /app/src/foo.ts:42 during init');
    // Force no stack so we exercise the err.message-only redaction path.
    err.stack = undefined;
    const result = sanitizeToolError(err);
    expect(result.message).not.toContain('/app/src');
    expect(result.message).not.toContain('foo.ts');
    expect(result.message).toContain('<file>');
  });

  it('redacts full pod-qualified internal FQDNs', () => {
    const result = sanitizeToolError(
      new Error('connect ECONNREFUSED pod-7.studio.svc.cluster.local:3000'),
    );
    expect(result.message).not.toContain('pod-7');
    expect(result.message).not.toContain('svc.cluster.local');
    expect(result.message).toContain('<internal>');
  });

  it('returns a hint for HTTP 404 status', () => {
    const result = sanitizeToolError({ status: 404, message: 'not found' });
    expect(result.code).toContain('404');
    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/not found/i);
  });

  it('preserves HTTP status codes and provider response messages', () => {
    const result = sanitizeToolError({
      status: 401,
      message: 'invalid_token: token expired or revoked',
    });
    expect(result.code).toContain('401');
    expect(result.message).toContain('invalid_token');
    expect(result.message).toContain('token expired or revoked');
  });

  it('caps provider response body at 500 chars', () => {
    const long = 'x'.repeat(1000);
    const result = sanitizeToolError({ status: 500, message: long });
    expect(result.message.length).toBeLessThanOrEqual(540);
  });

  it('strips uuid-shaped ids', () => {
    const result = sanitizeToolError(
      new Error('tenantId=550e8400-e29b-41d4-a716-446655440000 not authorized'),
    );
    expect(result.message).not.toContain('550e8400');
  });

  it('returns a stable shape on unknown input', () => {
    const result = sanitizeToolError({});
    expect(result).toEqual(
      expect.objectContaining({
        code: expect.any(String),
        message: expect.any(String),
      }),
    );
  });
});
