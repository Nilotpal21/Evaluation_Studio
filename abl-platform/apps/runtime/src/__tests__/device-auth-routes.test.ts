/**
 * Tests for Device Auth Routes
 *
 * Tests the 4 device auth endpoints with mocked service layer.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the service module before importing the router
vi.mock('../services/device-auth-service.js', () => ({
  createDeviceAuthRequest: vi.fn(),
  getDeviceAuthByUserCode: vi.fn(),
  authorizeDeviceRequest: vi.fn(),
  pollDeviceToken: vi.fn(),
  createDeviceTokenPair: vi.fn(),
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    server: { frontendUrl: 'http://localhost:5173' },
  }),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com' };
    next();
  },
}));

import {
  createDeviceAuthRequest,
  getDeviceAuthByUserCode,
  authorizeDeviceRequest,
  pollDeviceToken,
  createDeviceTokenPair,
} from '../services/device-auth-service.js';

// =============================================================================
// Shared helpers
// =============================================================================

function createMockReq(overrides?: Record<string, unknown>) {
  return {
    body: {},
    query: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res;
}

/** Factory for DeviceAuthRequest mock records */
function mockAuthRequest(overrides?: Record<string, unknown>) {
  return {
    id: 'req-1',
    userCode: 'ABCD-1234',
    deviceCode: 'hashed',
    scopes: ['read_traces'],
    expiresAt: new Date(Date.now() + 600_000),
    authorizedAt: null,
    consumedAt: null,
    userId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// Router & handler extraction

let router: any;

beforeEach(async () => {
  vi.clearAllMocks();
  const module = await import('../routes/device-auth.js');
  router = module.default;
});

function findHandler(method: string, path: string) {
  for (const layer of router.stack || []) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      return layer.route.stack.map((s: any) => s.handle);
    }
  }
  return null;
}

async function callHandler(handlers: any[], req: any, res: any) {
  for (const handler of handlers) {
    await new Promise<void>((resolve, reject) => {
      const next = (err?: any) => (err ? reject(err) : resolve());
      const result = handler(req, res, next);
      if (result?.then) result.then(resolve).catch(reject);
    });
    if (res.body !== null) break;
  }
}

/** Shortcut: find handlers, create req/res, call, return res */
async function call(method: string, path: string, reqOverrides?: Record<string, unknown>) {
  const handlers = findHandler(method, path)!;
  const req = createMockReq(reqOverrides);
  const res = createMockRes();
  await callHandler(handlers, req, res);
  return res;
}

// =============================================================================
// Tests
// =============================================================================

describe('Device Auth Routes', () => {
  // ===========================================================================
  // POST / — Create device auth request
  // ===========================================================================

  describe('POST / (create)', () => {
    test('returns RFC 8628 response with device_code and user_code', async () => {
      vi.mocked(createDeviceAuthRequest).mockResolvedValue({
        deviceCode: 'raw-device-code',
        userCode: 'ABCD-1234',
        expiresAt: new Date(Date.now() + 900_000),
      });

      const res = await call('post', '/', { body: { scopes: ['read_traces'] } });

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        device_code: 'raw-device-code',
        user_code: 'ABCD-1234',
        interval: 5,
      });
      expect(res.body.verification_uri).toContain('/auth/device');
      expect(res.body.verification_uri_complete).toContain('?code=ABCD-1234');
      expect(res.body.expires_in).toBeGreaterThan(0);
    });

    test('uses default scopes when none provided', async () => {
      vi.mocked(createDeviceAuthRequest).mockResolvedValue({
        deviceCode: 'dc',
        userCode: 'XXXX-XXXX',
        expiresAt: new Date(Date.now() + 900_000),
      });

      await call('post', '/', { body: {} });
      expect(createDeviceAuthRequest).toHaveBeenCalledWith([
        'read_traces',
        'read_state',
        'subscribe',
      ]);
    });
  });

  // ===========================================================================
  // GET /lookup
  // ===========================================================================

  describe('GET /lookup', () => {
    test('returns request details for valid code', async () => {
      vi.mocked(getDeviceAuthByUserCode).mockResolvedValue(mockAuthRequest());

      const res = await call('get', '/lookup', { query: { code: 'ABCD-1234' } });

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ userCode: 'ABCD-1234', scopes: ['read_traces'] });
    });

    test('returns 400 when code param missing', async () => {
      expect((await call('get', '/lookup', { query: {} })).statusCode).toBe(400);
    });

    test('returns 404 for unknown code', async () => {
      vi.mocked(getDeviceAuthByUserCode).mockResolvedValue(null);
      expect((await call('get', '/lookup', { query: { code: 'XXXX-XXXX' } })).statusCode).toBe(404);
    });

    test('returns 410 for expired code', async () => {
      vi.mocked(getDeviceAuthByUserCode).mockResolvedValue(
        mockAuthRequest({ expiresAt: new Date(Date.now() - 60_000) }),
      );
      expect((await call('get', '/lookup', { query: { code: 'ABCD-1234' } })).statusCode).toBe(410);
    });

    test('returns 409 for already authorized code', async () => {
      vi.mocked(getDeviceAuthByUserCode).mockResolvedValue(
        mockAuthRequest({ authorizedAt: new Date(), userId: 'user-1' }),
      );
      expect((await call('get', '/lookup', { query: { code: 'ABCD-1234' } })).statusCode).toBe(409);
    });
  });

  // ===========================================================================
  // POST /authorize
  // ===========================================================================

  describe('POST /authorize', () => {
    test('authorizes request when allow=true', async () => {
      vi.mocked(authorizeDeviceRequest).mockResolvedValue(true);

      const res = await call('post', '/authorize', {
        body: { user_code: 'ABCD-1234', allow: true },
        user: { sub: 'user-1' },
      });

      expect(res.body.success).toBe(true);
      expect(authorizeDeviceRequest).toHaveBeenCalledWith('ABCD-1234', 'user-1');
    });

    test('denies when allow=false', async () => {
      const res = await call('post', '/authorize', {
        body: { user_code: 'ABCD-1234', allow: false },
        user: { sub: 'user-1' },
      });
      expect(res.body.success).toBe(false);
      expect(authorizeDeviceRequest).not.toHaveBeenCalled();
    });

    test('returns 400 when user_code missing', async () => {
      expect(
        (await call('post', '/authorize', { body: { allow: true }, user: { sub: 'user-1' } }))
          .statusCode,
      ).toBe(400);
    });
  });

  // ===========================================================================
  // POST /token
  // ===========================================================================

  describe('POST /token', () => {
    const tokenReq = (ip = '127.0.0.1') => ({ body: { device_code: 'dc-123' }, ip });

    test('returns authorization_pending (428)', async () => {
      vi.mocked(pollDeviceToken).mockResolvedValue({ status: 'pending' });
      const res = await call('post', '/token', tokenReq());
      expect(res.statusCode).toBe(428);
      expect(res.body.error).toBe('authorization_pending');
    });

    test('returns expired_token (410)', async () => {
      vi.mocked(pollDeviceToken).mockResolvedValue({ status: 'expired' });
      expect((await call('post', '/token', tokenReq())).body.error).toBe('expired_token');
    });

    test('returns token_already_used (409)', async () => {
      vi.mocked(pollDeviceToken).mockResolvedValue({ status: 'consumed' });
      expect((await call('post', '/token', tokenReq())).body.error).toBe('token_already_used');
    });

    test('returns access_token on successful authorization', async () => {
      vi.mocked(pollDeviceToken).mockResolvedValue({
        status: 'authorized',
        userId: 'user-1',
        scopes: ['read_traces'],
      });
      vi.mocked(createDeviceTokenPair).mockResolvedValue({
        accessToken: 'jwt-abc',
        refreshToken: 'refresh-abc',
        expiresIn: 86400,
      });

      const res = await call('post', '/token', tokenReq());

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        access_token: 'jwt-abc',
        refresh_token: 'refresh-abc',
        token_type: 'Bearer',
        expires_in: 86400,
        scope: 'read_traces',
      });
    });

    test('returns 400 when device_code missing', async () => {
      const res = await call('post', '/token', { body: {} });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    test('rate limits after 12 requests per IP', async () => {
      vi.mocked(pollDeviceToken).mockResolvedValue({ status: 'pending' });

      const handlers = findHandler('post', '/token')!;

      // Exhaust the limit
      for (let i = 0; i < 12; i++) {
        const res = createMockRes();
        await callHandler(handlers, createMockReq(tokenReq('10.0.0.99')), res);
        expect(res.statusCode).toBe(428);
      }

      // 13th → 429
      const res = createMockRes();
      await callHandler(handlers, createMockReq(tokenReq('10.0.0.99')), res);
      expect(res.statusCode).toBe(429);
      expect(res.body.error).toBe('slow_down');
    });

    test('different IPs have separate rate limits', async () => {
      vi.mocked(pollDeviceToken).mockResolvedValue({ status: 'pending' });

      const handlers = findHandler('post', '/token')!;

      // Exhaust IP-A
      for (let i = 0; i < 12; i++) {
        const res = createMockRes();
        await callHandler(handlers, createMockReq(tokenReq('10.0.0.1')), res);
      }

      // IP-B still works
      const res = createMockRes();
      await callHandler(handlers, createMockReq(tokenReq('10.0.0.2')), res);
      expect(res.statusCode).toBe(428); // Not 429
    });
  });
});
