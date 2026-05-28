import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SignJWT } from 'jose';
import { NextRequest, NextResponse } from 'next/server';
import type { AdminRouteContext } from '../lib/with-admin-route.js';

const TEST_JWT_SECRET = 'admin-route-test-secret';
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_SUPER_ADMIN_USER_IDS = process.env.SUPER_ADMIN_USER_IDS;
const mockLogError = vi.fn();

vi.mock('server-only', () => ({}));

vi.mock('../lib/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLogError(...args),
    child: vi.fn(),
    setCorrelationId: vi.fn(),
  }),
}));

async function createAccessToken(
  overrides: {
    email?: string;
    role?: string;
    isSuperAdmin?: boolean;
  } = {},
): Promise<string> {
  return new SignJWT({
    email: overrides.email ?? 'admin@example.com',
    role: overrides.role,
    isSuperAdmin: overrides.isSuperAdmin ?? false,
    type: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('admin-user-001')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.SUPER_ADMIN_USER_IDS = 'admin-user-001';
});

afterEach(() => {
  if (ORIGINAL_JWT_SECRET === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  }

  if (ORIGINAL_SUPER_ADMIN_USER_IDS === undefined) {
    delete process.env.SUPER_ADMIN_USER_IDS;
  } else {
    process.env.SUPER_ADMIN_USER_IDS = ORIGINAL_SUPER_ADMIN_USER_IDS;
  }
});

describe('withAdminRoute', () => {
  test('rejects non-super-admin tokens even if they carry an admin role', async () => {
    const { withAdminRoute } = await import('../lib/with-admin-route.js');
    const accessToken = await createAccessToken({ role: 'ADMIN' });

    const handler = withAdminRoute({ role: 'VIEWER' }, async () => {
      return NextResponse.json({ success: true });
    });

    const response = await handler(
      new NextRequest('http://localhost:3003/api/test', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Platform super-admin access required.',
      },
    });
  });

  test('accepts super-admin tokens', async () => {
    const { withAdminRoute } = await import('../lib/with-admin-route.js');
    const accessToken = await createAccessToken({ isSuperAdmin: true });

    const handler = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
      return NextResponse.json({
        success: true,
        user: {
          role: ctx.user.role,
          isSuperAdmin: ctx.user.isSuperAdmin,
        },
      });
    });

    const response = await handler(
      new NextRequest('http://localhost:3003/api/test', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      user: {
        role: 'SUPER_ADMIN',
        isSuperAdmin: true,
      },
    });
    expect(response.cookies.get('admin-last-activity')?.sameSite).toBe('lax');
  });

  test('logs unhandled handler errors and returns a 500 response', async () => {
    const { withAdminRoute } = await import('../lib/with-admin-route.js');
    const accessToken = await createAccessToken({ isSuperAdmin: true });

    const handler = withAdminRoute({ role: 'VIEWER' }, async () => {
      throw new Error('boom');
    });

    const response = await handler(
      new NextRequest('http://localhost:3003/api/test', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
    expect(mockLogError).toHaveBeenCalledWith(
      'Unhandled admin route error',
      expect.objectContaining({
        error: 'boom',
        pathname: '/api/test',
      }),
    );
  });
});
