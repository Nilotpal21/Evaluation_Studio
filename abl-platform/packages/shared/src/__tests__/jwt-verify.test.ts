/**
 * JWT Verify Middleware Tests
 *
 * Tests verifyToken, createAuthMiddleware, createOptionalAuthMiddleware,
 * and extractUserIdFromToken.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PLATFORM_ACCESS_TOKEN_AUDIENCE, PLATFORM_JWT_ISSUER } from '@agent-platform/shared-auth';
import {
  verifyToken,
  createAuthMiddleware,
  createOptionalAuthMiddleware,
  extractUserIdFromToken,
} from '../middleware/jwt-verify.js';
import type { AuthMiddlewareConfig } from '../middleware/jwt-verify.js';

const SECRET = 'test-jwt-secret';

function signAccess(
  payload: Record<string, unknown>,
  secret: string = SECRET,
  options: jwt.SignOptions = {},
): string {
  return jwt.sign(payload, secret, {
    issuer: PLATFORM_JWT_ISSUER,
    audience: PLATFORM_ACCESS_TOKEN_AUDIENCE,
    ...options,
  });
}

function createReq(headers: Record<string, string> = {}): Request {
  return { headers, user: undefined } as unknown as Request;
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

function createConfig(overrides: Partial<AuthMiddlewareConfig> = {}): AuthMiddlewareConfig {
  return {
    getJwtSecret: () => SECRET,
    getUserById: vi.fn().mockResolvedValue({ id: 'user1', email: 'u@test.com', name: 'Test' }),
    ...overrides,
  };
}

async function withExpectedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    consoleErrorSpy.mockRestore();
  }
}

// =============================================================================
// verifyToken
// =============================================================================

describe('verifyToken', () => {
  it('should return payload for valid access token', () => {
    const token = signAccess({ sub: 'user1', type: 'access' });
    const result = verifyToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe('user1');
    expect(result!.type).toBe('access');
  });

  it('should return payload for mfa_pending token', () => {
    const token = signAccess({ sub: 'user1', type: 'mfa_pending' });
    const result = verifyToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('mfa_pending');
  });

  it('should return null for refresh token type', () => {
    const token = signAccess({ sub: 'user1', type: 'refresh' });
    const result = verifyToken(token, SECRET);
    expect(result).toBeNull();
  });

  it('should return null for invalid token', () => {
    const result = verifyToken('not-a-jwt', SECRET);
    expect(result).toBeNull();
  });

  it('should return null for wrong secret', () => {
    const token = signAccess({ sub: 'user1', type: 'access' }, 'other-secret');
    const result = verifyToken(token, SECRET);
    expect(result).toBeNull();
  });

  it('should return null for expired token', () => {
    const token = signAccess({
      sub: 'user1',
      type: 'access',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const result = verifyToken(token, SECRET);
    expect(result).toBeNull();
  });

  it('should return null when audience and issuer are missing', () => {
    const token = jwt.sign({ sub: 'user1', type: 'access' }, SECRET);
    const result = verifyToken(token, SECRET);
    expect(result).toBeNull();
  });
});

// =============================================================================
// createAuthMiddleware
// =============================================================================

describe('createAuthMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('should reject missing authorization header', async () => {
    const config = createConfig();
    const middleware = createAuthMiddleware(config);
    const req = createReq();
    const res = createRes();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect((res._json as any).error).toBe('Missing authorization header');
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject non-Bearer authorization header', async () => {
    const config = createConfig();
    const middleware = createAuthMiddleware(config);
    const req = createReq({ authorization: 'Basic abc123' });
    const res = createRes();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject invalid token', async () => {
    const config = createConfig();
    const middleware = createAuthMiddleware(config);
    const req = createReq({ authorization: 'Bearer bad-token' });
    const res = createRes();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect((res._json as any).error).toBe('Invalid or expired token');
    expect(next).not.toHaveBeenCalled();
  });

  it('should authenticate valid access token and set req.user', async () => {
    const mockUser = { id: 'user1', email: 'u@test.com', name: 'Test' };
    const config = createConfig({
      getUserById: vi.fn().mockResolvedValue(mockUser),
    });
    const middleware = createAuthMiddleware(config);
    const token = signAccess({ sub: 'user1', type: 'access' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(mockUser);
  });

  it('should reject when user not found for access token', async () => {
    const config = createConfig({
      getUserById: vi.fn().mockResolvedValue(null),
    });
    const middleware = createAuthMiddleware(config);
    const token = signAccess({ sub: 'nonexistent', type: 'access' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect((res._json as any).error).toBe('User not found');
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle mfa_pending token and set mfaPending flag', async () => {
    const mockUser = { id: 'user1', email: 'u@test.com', name: 'Test' };
    const config = createConfig({
      getUserById: vi.fn().mockResolvedValue(mockUser),
    });
    const middleware = createAuthMiddleware(config);
    const token = signAccess({ sub: 'user1', type: 'mfa_pending' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(mockUser);
    expect((req as any).mfaPending).toBe(true);
  });

  it('should reject mfa_pending token when user not found', async () => {
    const config = createConfig({
      getUserById: vi.fn().mockResolvedValue(null),
    });
    const middleware = createAuthMiddleware(config);
    const token = signAccess({ sub: 'nonexistent', type: 'mfa_pending' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect((res._json as any).error).toBe('User not found');
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 500 when getUserById throws for access token', async () => {
    const config = createConfig({
      getUserById: vi.fn().mockRejectedValue(new Error('DB error')),
    });
    const middleware = createAuthMiddleware(config);
    const token = signAccess({ sub: 'user1', type: 'access' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await withExpectedConsoleError(() => middleware(req, res, next));

    expect(res._status).toBe(500);
    expect((res._json as any).error).toBe('Internal server error');
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 500 when getUserById throws for mfa_pending token', async () => {
    const config = createConfig({
      getUserById: vi.fn().mockRejectedValue(new Error('DB error')),
    });
    const middleware = createAuthMiddleware(config);
    const token = signAccess({ sub: 'user1', type: 'mfa_pending' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await withExpectedConsoleError(() => middleware(req, res, next));

    expect(res._status).toBe(500);
    expect((res._json as any).error).toBe('Internal server error');
    expect(next).not.toHaveBeenCalled();
  });
});

// =============================================================================
// createOptionalAuthMiddleware
// =============================================================================

describe('createOptionalAuthMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('should pass through with no auth header', async () => {
    const config = createConfig();
    const middleware = createOptionalAuthMiddleware(config);
    const req = createReq();
    const res = createRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });

  it('should set user for valid access token', async () => {
    const mockUser = { id: 'user1', email: 'u@test.com', name: 'Test' };
    const config = createConfig({
      getUserById: vi.fn().mockResolvedValue(mockUser),
    });
    const middleware = createOptionalAuthMiddleware(config);
    const token = signAccess({ sub: 'user1', type: 'access' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(mockUser);
  });

  it('should not set user for invalid token but still call next', async () => {
    const config = createConfig();
    const middleware = createOptionalAuthMiddleware(config);
    const req = createReq({ authorization: 'Bearer bad-token' });
    const res = createRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });

  it('should not set user for mfa_pending token (only access tokens)', async () => {
    const config = createConfig();
    const middleware = createOptionalAuthMiddleware(config);
    const token = signAccess({ sub: 'user1', type: 'mfa_pending' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });

  it('should not set user when getUserById returns null', async () => {
    const config = createConfig({
      getUserById: vi.fn().mockResolvedValue(null),
    });
    const middleware = createOptionalAuthMiddleware(config);
    const token = signAccess({ sub: 'user1', type: 'access' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });

  it('should not set user when getUserById throws but still call next', async () => {
    const config = createConfig({
      getUserById: vi.fn().mockRejectedValue(new Error('DB error')),
    });
    const middleware = createOptionalAuthMiddleware(config);
    const token = signAccess({ sub: 'user1', type: 'access' });
    const req = createReq({ authorization: `Bearer ${token}` });
    const res = createRes();

    await withExpectedConsoleError(() => middleware(req, res, next));

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });

  it('should pass through when auth header is not Bearer', async () => {
    const config = createConfig();
    const middleware = createOptionalAuthMiddleware(config);
    const req = createReq({ authorization: 'Basic abc123' });
    const res = createRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });
});

// =============================================================================
// extractUserIdFromToken
// =============================================================================

describe('extractUserIdFromToken', () => {
  it('should return user ID from valid access token', () => {
    const token = signAccess({ sub: 'user1', type: 'access' });
    const result = extractUserIdFromToken(token, SECRET);
    expect(result).toBe('user1');
  });

  it('should return user ID from mfa_pending token', () => {
    const token = signAccess({ sub: 'user1', type: 'mfa_pending' });
    const result = extractUserIdFromToken(token, SECRET);
    expect(result).toBe('user1');
  });

  it('should return null for invalid token', () => {
    const result = extractUserIdFromToken('bad-token', SECRET);
    expect(result).toBeNull();
  });

  it('should return null for wrong secret', () => {
    const token = signAccess({ sub: 'user1', type: 'access' }, 'wrong-secret');
    const result = extractUserIdFromToken(token, SECRET);
    expect(result).toBeNull();
  });
});
