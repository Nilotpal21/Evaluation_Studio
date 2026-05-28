import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  verifyToken,
  createAuthMiddleware,
  createOptionalAuthMiddleware,
  extractUserIdFromToken,
} from '../middleware/jwt-verify.js';
import {
  AuthError,
  FEEDBACK_TOKEN_AUDIENCE,
  GUPSHUP_WEBHOOK_TOKEN_AUDIENCE,
  PLATFORM_ACCESS_TOKEN_AUDIENCE,
  PLATFORM_JWT_ISSUER,
  SDK_SESSION_TOKEN_AUDIENCE,
  signFeedbackToken,
  signGupshupWebhookToken,
  signSDKSessionToken,
  verifyFeedbackToken,
  verifyGupshupWebhookToken,
  verifySDKSessionToken,
} from '../purpose-jwt.js';
import type { AuthMiddlewareConfig } from '../middleware/jwt-verify.js';
import type { AuthUser, JWTPayload } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'test-secret';

function makeJwt(payload: Partial<JWTPayload>, secret = SECRET): string {
  return jwt.sign(payload, secret, {
    issuer: PLATFORM_JWT_ISSUER,
    audience: PLATFORM_ACCESS_TOKEN_AUDIENCE,
  });
}

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function mockNext(): NextFunction {
  return vi.fn();
}

const testUser: AuthUser = { id: 'user-1', email: 'test@example.com', name: 'Test' };

function makeConfig(overrides: Partial<AuthMiddlewareConfig> = {}): AuthMiddlewareConfig {
  return {
    getJwtSecret: () => SECRET,
    getUserById: vi.fn<(id: string) => Promise<AuthUser | null>>().mockResolvedValue(testUser),
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

// ---------------------------------------------------------------------------
// verifyToken
// ---------------------------------------------------------------------------

describe('verifyToken', () => {
  it('returns payload for valid access token', () => {
    const token = makeJwt({ sub: 'u1', email: 'a@b.c', type: 'access' });
    const result = verifyToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe('u1');
    expect(result!.type).toBe('access');
  });

  it('returns payload for mfa_pending token', () => {
    const token = makeJwt({ sub: 'u1', email: 'a@b.c', type: 'mfa_pending' });
    const result = verifyToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('mfa_pending');
  });

  it('returns null for invalid JWT', () => {
    expect(verifyToken('not-a-jwt', SECRET)).toBeNull();
  });

  it('returns null for expired token', () => {
    const token = jwt.sign({ sub: 'u1', email: 'a@b.c', type: 'access', exp: 1 }, SECRET, {
      issuer: PLATFORM_JWT_ISSUER,
      audience: PLATFORM_ACCESS_TOKEN_AUDIENCE,
    });
    expect(verifyToken(token, SECRET)).toBeNull();
  });

  it('returns null for wrong secret', () => {
    const token = makeJwt({ sub: 'u1', email: 'a@b.c', type: 'access' });
    expect(verifyToken(token, 'wrong-secret')).toBeNull();
  });

  it('returns null when type is not access or mfa_pending', () => {
    const token = jwt.sign({ sub: 'u1', email: 'a@b.c', type: 'refresh' }, SECRET, {
      issuer: PLATFORM_JWT_ISSUER,
      audience: PLATFORM_ACCESS_TOKEN_AUDIENCE,
    });
    expect(verifyToken(token, SECRET)).toBeNull();
  });

  it('returns null when platform access token is missing audience and issuer', () => {
    const token = jwt.sign({ sub: 'u1', email: 'a@b.c', type: 'access' }, SECRET);
    expect(verifyToken(token, SECRET)).toBeNull();
  });

  it('returns null for malformed token', () => {
    expect(verifyToken('', SECRET)).toBeNull();
    expect(verifyToken('a.b.c', SECRET)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createAuthMiddleware
// ---------------------------------------------------------------------------

describe('createAuthMiddleware', () => {
  let config: AuthMiddlewareConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  it('returns 401 when no authorization header', async () => {
    const middleware = createAuthMiddleware(config);
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing authorization header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when authorization header is not Bearer', async () => {
    const middleware = createAuthMiddleware(config);
    const req = mockReq({ authorization: 'Basic abc' });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 for invalid token', async () => {
    const middleware = createAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer bad-token' });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
  });

  it('returns 401 when user is not found', async () => {
    config = makeConfig({
      getUserById: vi.fn<(id: string) => Promise<AuthUser | null>>().mockResolvedValue(null),
    });
    const middleware = createAuthMiddleware(config);
    const token = makeJwt({ sub: 'u1', email: 'a@b.c', type: 'access' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
  });

  it('sets req.user and calls next for valid token', async () => {
    const middleware = createAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'access' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect((req as any).user).toEqual(testUser);
    expect(next).toHaveBeenCalled();
  });

  it('sets mfaPending flag for mfa_pending token', async () => {
    const middleware = createAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'mfa_pending' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect((req as any).user).toEqual(testUser);
    expect((req as any).mfaPending).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when mfa_pending user not found', async () => {
    config = makeConfig({
      getUserById: vi.fn<(id: string) => Promise<AuthUser | null>>().mockResolvedValue(null),
    });
    const middleware = createAuthMiddleware(config);
    const token = makeJwt({ sub: 'u-missing', email: 'a@b.c', type: 'mfa_pending' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 500 when getUserById throws', async () => {
    config = makeConfig({
      getUserById: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const middleware = createAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'access' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await withExpectedConsoleError(() => middleware(req, res, next));
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns 500 when getUserById throws during mfa_pending token handling', async () => {
    config = makeConfig({
      getUserById: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const middleware = createAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'mfa_pending' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await withExpectedConsoleError(() => middleware(req, res, next));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createOptionalAuthMiddleware
// ---------------------------------------------------------------------------

describe('createOptionalAuthMiddleware', () => {
  let config: AuthMiddlewareConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  it('calls next without setting user when no auth header', async () => {
    const middleware = createOptionalAuthMiddleware(config);
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('calls next without setting user for invalid token', async () => {
    const middleware = createOptionalAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer bad-token' });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('sets user for valid access token', async () => {
    const middleware = createOptionalAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'access' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect((req as any).user).toEqual(testUser);
    expect(next).toHaveBeenCalled();
  });

  it('does not set user for mfa_pending token (optional only accepts access)', async () => {
    const middleware = createOptionalAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'mfa_pending' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('calls next even when getUserById throws', async () => {
    config = makeConfig({
      getUserById: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const middleware = createOptionalAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'access' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await withExpectedConsoleError(() => middleware(req, res, next));
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('does not set user when getUserById returns null', async () => {
    config = makeConfig({
      getUserById: vi.fn<(id: string) => Promise<AuthUser | null>>().mockResolvedValue(null),
    });
    const middleware = createOptionalAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'access' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();
    await middleware(req, res, next);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// extractUserIdFromToken
// ---------------------------------------------------------------------------

describe('extractUserIdFromToken', () => {
  it('returns userId for valid token', () => {
    const token = makeJwt({ sub: 'user-42', email: 'a@b.c', type: 'access' });
    expect(extractUserIdFromToken(token, SECRET)).toBe('user-42');
  });

  it('returns null for invalid token', () => {
    expect(extractUserIdFromToken('garbage', SECRET)).toBeNull();
  });

  it('returns null for wrong secret', () => {
    const token = makeJwt({ sub: 'user-42', email: 'a@b.c', type: 'access' });
    expect(extractUserIdFromToken(token, 'wrong')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Purpose-scoped JWT helpers
// ---------------------------------------------------------------------------

describe('purpose-scoped JWT helpers', () => {
  it('rejects feedback tokens on the SDK session verification path', () => {
    const feedbackToken = signFeedbackToken(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        connectionId: 'connection-1',
      },
      SECRET,
      { expiresIn: '1h' },
    );

    expect(() => verifySDKSessionToken(feedbackToken, SECRET)).toThrow(AuthError);
  });

  it('rejects SDK session tokens bearing a studio source', () => {
    const token = jwt.sign(
      {
        type: 'sdk_session',
        source: 'studio',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        sessionId: 'session-1',
        permissions: ['session:read'],
      },
      SECRET,
      {
        issuer: PLATFORM_JWT_ISSUER,
        audience: SDK_SESSION_TOKEN_AUDIENCE,
        expiresIn: '1h',
      },
    );

    expect(() => verifySDKSessionToken(token, SECRET)).toThrow(AuthError);
  });

  it('verifies SDK session tokens minted by the SDK helper', () => {
    const token = signSDKSessionToken(
      {
        type: 'sdk_session',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        sessionId: 'session-1',
        permissions: ['session:read'],
      },
      SECRET,
      { expiresIn: '1h' },
    );

    const decoded = verifySDKSessionToken(token, SECRET);
    expect(decoded.type).toBe('sdk_session');
    expect(decoded.source).toBe('sdk');
  });

  it('rejects feedback tokens missing the feedback audience and platform issuer', () => {
    const token = jwt.sign(
      {
        purpose: 'email_csat',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        connectionId: 'connection-1',
      },
      SECRET,
      { expiresIn: '1h' },
    );

    expect(() => verifyFeedbackToken(token, SECRET)).toThrow(AuthError);
  });

  it('rejects Gupshup webhook tokens with another purpose audience', () => {
    const token = jwt.sign({ purpose: 'gupshup_webhook', sub: 'gupshup' }, SECRET, {
      issuer: PLATFORM_JWT_ISSUER,
      audience: FEEDBACK_TOKEN_AUDIENCE,
      expiresIn: '1h',
    });

    expect(() => verifyGupshupWebhookToken(token, SECRET)).toThrow(AuthError);
  });

  it('verifies Gupshup webhook tokens minted by the Gupshup helper', () => {
    const token = signGupshupWebhookToken({ sub: 'gupshup' }, SECRET, { expiresIn: '1h' });
    const decoded = verifyGupshupWebhookToken(token, SECRET);

    expect(decoded.purpose).toBe('gupshup_webhook');
    expect(decoded.aud).toBe(GUPSHUP_WEBHOOK_TOKEN_AUDIENCE);
  });
});
