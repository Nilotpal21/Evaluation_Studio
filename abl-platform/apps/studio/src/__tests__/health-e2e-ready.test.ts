import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { GET } = await import('../app/api/health/e2e-ready/route');

const nativeFetch = global.fetch;
const originalEnableDevLogin = process.env.ENABLE_DEV_LOGIN;

function makeRequest(url = 'http://localhost:5173/api/health/e2e-ready'): NextRequest {
  return new NextRequest(new URL(url));
}

afterEach(() => {
  global.fetch = nativeFetch;

  if (originalEnableDevLogin === undefined) {
    delete process.env.ENABLE_DEV_LOGIN;
  } else {
    process.env.ENABLE_DEV_LOGIN = originalEnableDevLogin;
  }

  vi.restoreAllMocks();
});

describe('Studio E2E readiness route', () => {
  it('returns 404 when dev-login is disabled', async () => {
    process.env.ENABLE_DEV_LOGIN = 'false';

    const response = await GET(makeRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      status: 'disabled',
      service: 'studio',
    });
  });

  it('returns 503 when the dev-login probe is not ready', async () => {
    process.env.ENABLE_DEV_LOGIN = 'true';
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    );
    global.fetch = fetchMock as typeof fetch;

    const response = await GET(makeRequest('http://127.0.0.1:45173/api/health/e2e-ready'));
    const [probeUrl, probeInit] = fetchMock.mock.calls[0] ?? [];

    expect(String(probeUrl)).toBe('http://localhost:45173/api/auth/dev-login');
    expect(probeInit).toEqual(
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'not_ready',
      service: 'studio',
    });
  });

  it('returns ready only after the dev-login probe succeeds', async () => {
    process.env.ENABLE_DEV_LOGIN = 'true';
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: 'token' }), { status: 200 }),
    );
    global.fetch = fetchMock as typeof fetch;

    const response = await GET(makeRequest('http://127.0.0.1:45173/api/health/e2e-ready'));
    const [probeUrl, probeInit] = fetchMock.mock.calls[0] ?? [];

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        status: 'ready',
        service: 'studio',
      }),
    );
    expect(String(probeUrl)).toBe('http://localhost:45173/api/auth/dev-login');
    expect(probeInit).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'sdk-browser-stack@e2e-smoke.test',
          name: 'SDK Browser Stack Probe',
        }),
      }),
    );
  });
});
