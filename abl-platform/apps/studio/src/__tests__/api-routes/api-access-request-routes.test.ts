import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCheckRateLimit = vi.fn();
const mockIsEmailAllowedForAuth = vi.fn();
const mockSendAccessRequestEmail = vi.fn();

vi.mock('server-only', () => ({}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/lib/platform-auth-policy', () => ({
  isEmailAllowedForAuth: (...args: unknown[]) => mockIsEmailAllowedForAuth(...args),
  sendAccessRequestEmail: (...args: unknown[]) => mockSendAccessRequestEmail(...args),
}));

function makeRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost:5173/api/auth/access-request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
      'user-agent': 'vitest',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/access-request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockIsEmailAllowedForAuth.mockResolvedValue(false);
    mockSendAccessRequestEmail.mockResolvedValue(undefined);
  });

  it('records and notifies admins for a blocked-domain request', async () => {
    const { handler } = await import('@/app/api/auth/access-request/access-request-handler');

    const response = await handler(
      makeRequest({
        email: 'Blocked@Example.com',
        name: 'Blocked User',
        message: 'Please approve access.',
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mockIsEmailAllowedForAuth).toHaveBeenCalledWith('blocked@example.com');
    expect(mockSendAccessRequestEmail).toHaveBeenCalledWith({
      email: 'blocked@example.com',
      name: 'Blocked User',
      message: 'Please approve access.',
      ip: '203.0.113.10',
      userAgent: 'vitest',
    });
  });

  it('does not persist a request when the email domain is already allowlisted', async () => {
    mockIsEmailAllowedForAuth.mockResolvedValue(true);
    const { handler } = await import('@/app/api/auth/access-request/access-request-handler');

    const response = await handler(makeRequest({ email: 'user@kore.ai' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'This email domain is already approved. Please try signing in again.',
    });
    expect(mockSendAccessRequestEmail).not.toHaveBeenCalled();
  });

  it('returns 429 when the rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfter: 3600 });
    const { handler } = await import('@/app/api/auth/access-request/access-request-handler');

    const response = await handler(makeRequest({ email: 'user@example.com' }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3600');
    expect(mockSendAccessRequestEmail).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid email address', async () => {
    const { handler } = await import('@/app/api/auth/access-request/access-request-handler');

    const response = await handler(makeRequest({ email: 'not-an-email' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
    expect(mockSendAccessRequestEmail).not.toHaveBeenCalled();
  });

  it('returns 502 when sendAccessRequestEmail throws', async () => {
    mockSendAccessRequestEmail.mockRejectedValue(new Error('SMTP timeout'));
    const { handler } = await import('@/app/api/auth/access-request/access-request-handler');

    const response = await handler(makeRequest({ email: 'user@example.com' }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});
