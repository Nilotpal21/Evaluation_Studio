/**
 * Session Ownership Middleware Tests
 *
 * Tests createRequireSessionOwnership() Express middleware factory.
 * SDK sessions verify identity match; non-admin platform members verify
 * owner match; API keys pass through.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createRequireSessionOwnership } from '../middleware/session-ownership.js';
import type { TenantContextData } from '../types/index.js';

function createReq(
  tenantContext?: Partial<TenantContextData>,
  params?: Record<string, string>,
): Request {
  return {
    tenantContext: tenantContext
      ? ({
          tenantId: 'tenant1',
          userId: 'user1',
          role: 'ADMIN',
          permissions: ['project:read'],
          authType: 'user',
          isSuperAdmin: false,
          ...tenantContext,
        } as TenantContextData)
      : undefined,
    params: params ?? {},
    query: {},
    body: {},
    headers: {},
  } as unknown as Request;
}

function createRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
  } as unknown as Response & { _status: number; _json: unknown };
  return res;
}

describe('createRequireSessionOwnership', () => {
  const findSession = vi.fn();
  const middleware = createRequireSessionOwnership({ findSession });

  beforeEach(() => {
    findSession.mockReset();
  });

  test('returns 401 when no auth context', async () => {
    const req = createReq(undefined, { sessionId: 'sess-1' });
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('passes through for elevated User JWT auth', async () => {
    const req = createReq(
      { authType: 'user', userId: 'user-123', role: 'ADMIN' },
      { sessionId: 'sess-1' },
    );
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    // Elevated platform roles short-circuit without loading the session
    expect(findSession).not.toHaveBeenCalled();
  });

  test('passes through for non-admin user accessing own session', async () => {
    findSession.mockResolvedValue({ ownerUserId: 'user-123' });
    const req = createReq(
      { authType: 'user', userId: 'user-123', role: 'MEMBER' },
      { sessionId: 'sess-1' },
    );
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(findSession).toHaveBeenCalledWith('sess-1', 'tenant1');
  });

  test('returns 404 for non-admin user accessing another users session', async () => {
    findSession.mockResolvedValue({ ownerUserId: 'user-999' });
    const req = createReq(
      { authType: 'user', userId: 'user-123', role: 'MEMBER' },
      { sessionId: 'sess-1' },
    );
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res._status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  test('passes through for API key auth', async () => {
    const req = createReq(
      { authType: 'api_key', userId: 'key-creator', apiKeyId: 'key-1', clientId: 'ci' },
      { sessionId: 'sess-1' },
    );
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(findSession).not.toHaveBeenCalled();
  });

  test('passes through when no sessionId param (list routes)', async () => {
    const req = createReq({ authType: 'sdk_session', channelId: 'webchat', userId: 'sdk:webchat' });
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('SDK user accessing own session (customerId match) calls next()', async () => {
    findSession.mockResolvedValue({
      callerContext: {
        tenantId: 'tenant1',
        channel: 'webchat',
        channelId: 'webchat',
        customerId: 'cust-abc',
        identityTier: 2,
        verificationMethod: 'hmac',
      },
    });
    const req = createReq(
      {
        authType: 'sdk_session',
        channelId: 'webchat',
        userId: 'cust-abc',
        sessionPrincipal: 'sp-1',
        verifiedUserId: 'cust-abc',
        identityTier: 2,
        verificationMethod: 'hmac',
        userContext: { userId: 'cust-abc' },
      },
      { sessionId: 'sess-1' },
    );
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(findSession).toHaveBeenCalledWith('sess-1', 'tenant1');
  });

  test('SDK user accessing another users session returns 404', async () => {
    findSession.mockResolvedValue({
      callerContext: {
        tenantId: 'tenant1',
        channel: 'webchat',
        customerId: 'cust-other',
        identityTier: 2,
        verificationMethod: 'hmac',
      },
    });
    const req = createReq(
      {
        authType: 'sdk_session',
        channelId: 'webchat',
        userId: 'sdk:webchat',
        identityTier: 2,
        verificationMethod: 'hmac',
        userContext: { userId: 'cust-abc' },
      },
      { sessionId: 'sess-1' },
    );
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res._status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 404 when session not found', async () => {
    findSession.mockResolvedValue(null);
    const req = createReq(
      {
        authType: 'sdk_session',
        channelId: 'webchat',
        userId: 'sdk:webchat',
        identityTier: 2,
        verificationMethod: 'hmac',
        userContext: { userId: 'cust-abc' },
      },
      { sessionId: 'sess-999' },
    );
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res._status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 404 when session has no callerContext', async () => {
    findSession.mockResolvedValue({ callerContext: undefined });
    const req = createReq(
      {
        authType: 'sdk_session',
        channelId: 'webchat',
        userId: 'sdk:webchat',
        identityTier: 0,
        verificationMethod: 'none',
      },
      { sessionId: 'sess-1' },
    );
    const res = createRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res._status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
});
