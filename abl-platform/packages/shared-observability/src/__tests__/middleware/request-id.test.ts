/**
 * Request ID Middleware Tests
 *
 * Covers:
 * - Generates a UUID when no X-Request-ID header provided
 * - Accepts valid client-provided X-Request-ID
 * - Rejects invalid X-Request-ID (too long, special chars)
 * - Sets X-Request-ID response header
 * - getCurrentRequestId returns ID within middleware context
 * - getCurrentRequestId returns undefined outside context
 */

import { describe, it, expect, vi } from 'vitest';
import { requestIdMiddleware, getCurrentRequestId } from '../../middleware/request-id.js';
import type { Request, Response, NextFunction } from 'express';

function createMockReqRes(headers: Record<string, string> = {}) {
  const req = {
    headers: { ...headers },
  } as unknown as Request;

  const setHeaderCalls: Array<[string, string | number]> = [];
  const res = {
    setHeader(name: string, value: string | number) {
      setHeaderCalls.push([name, value]);
    },
  } as unknown as Response;

  return { req, res, setHeaderCalls };
}

describe('requestIdMiddleware', () => {
  it('generates a UUID when no X-Request-ID header is provided', () => {
    const middleware = requestIdMiddleware();
    const { req, res, setHeaderCalls } = createMockReqRes();

    let capturedId: string | undefined;
    const next: NextFunction = () => {
      capturedId = getCurrentRequestId();
    };

    middleware(req, res, next);

    expect(setHeaderCalls).toHaveLength(1);
    expect(setHeaderCalls[0][0]).toBe('X-Request-ID');
    // Should be a valid UUID format
    expect(setHeaderCalls[0][1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(capturedId).toBe(setHeaderCalls[0][1]);
  });

  it('accepts a valid client-provided X-Request-ID', () => {
    const middleware = requestIdMiddleware();
    const { req, res, setHeaderCalls } = createMockReqRes({
      'x-request-id': 'my-custom-id-123',
    });

    let capturedId: string | undefined;
    const next: NextFunction = () => {
      capturedId = getCurrentRequestId();
    };

    middleware(req, res, next);

    expect(setHeaderCalls[0][1]).toBe('my-custom-id-123');
    expect(capturedId).toBe('my-custom-id-123');
  });

  it('rejects an invalid X-Request-ID with special characters', () => {
    const middleware = requestIdMiddleware();
    const { req, res, setHeaderCalls } = createMockReqRes({
      'x-request-id': 'bad<script>id',
    });

    const next: NextFunction = vi.fn();
    middleware(req, res, next);

    // Should generate a new UUID instead of using the invalid one
    expect(setHeaderCalls[0][1]).not.toBe('bad<script>id');
    expect(setHeaderCalls[0][1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('rejects an X-Request-ID that exceeds 64 characters', () => {
    const middleware = requestIdMiddleware();
    const longId = 'a'.repeat(65);
    const { req, res, setHeaderCalls } = createMockReqRes({
      'x-request-id': longId,
    });

    const next: NextFunction = vi.fn();
    middleware(req, res, next);

    expect(setHeaderCalls[0][1]).not.toBe(longId);
  });

  it('calls next within the AsyncLocalStorage context', () => {
    const middleware = requestIdMiddleware();
    const { req, res } = createMockReqRes();

    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
      expect(getCurrentRequestId()).toBeDefined();
    };

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });
});

describe('getCurrentRequestId', () => {
  it('returns undefined outside of middleware context', () => {
    expect(getCurrentRequestId()).toBeUndefined();
  });
});
