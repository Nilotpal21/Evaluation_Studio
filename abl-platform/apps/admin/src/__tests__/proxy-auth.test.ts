import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { proxy } from '../proxy.js';

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

function makeRequest(path: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(`http://localhost:3003${path}`);
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

async function signAdminToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode('test-secret'));
}

describe('admin proxy auth guard', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T17:30:00.000Z'));
  });

  afterEach(() => {
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
    vi.useRealTimers();
  });

  test('redirects dashboard pages without an admin session', async () => {
    const response = await proxy(makeRequest('/config-overrides'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3003/login?redirect=%2Fconfig-overrides',
    );
  });

  test('redirects non-super-admin sessions to login', async () => {
    const token = await signAdminToken({
      sub: 'user-1',
      email: 'user@example.com',
      type: 'access',
      isSuperAdmin: false,
    });

    const response = await proxy(makeRequest('/health', { 'admin-session': token }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login?redirect=%2Fhealth');
    expect(response.headers.get('location')).toContain('Platform+super-admin+access+required.');
  });

  test('allows valid super-admin sessions through and refreshes idle timeout', async () => {
    const token = await signAdminToken({
      sub: 'admin-1',
      email: 'admin@example.com',
      type: 'access',
      isSuperAdmin: true,
    });

    const response = await proxy(
      makeRequest('/health', {
        'admin-session': token,
        'admin-last-activity': String(Date.now()),
      }),
    );

    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.cookies.get('admin-last-activity')?.value).toBe(String(Date.now()));
    expect(response.cookies.get('admin-last-activity')?.sameSite).toBe('lax');
  });
});
