// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'https://runtime.example.test',
}));

import { proxy } from '@/proxy';

function makeRequest(path: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(path, 'https://agents-dev.kore.ai'), init);
}

describe('studio proxy csrf handling for browser sdk routes', () => {
  it('allows one-time sso exchange posts without browser origin headers', async () => {
    const response = proxy(
      makeRequest('/api/sso/exchange', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ code: 'auth-code-123' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('allows external-origin sdk init requests to reach runtime', async () => {
    const response = proxy(
      makeRequest('/api/v1/sdk/init', {
        method: 'POST',
        headers: {
          origin: 'https://s3.us-east-1.amazonaws.com',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://runtime.example.test/api/v1/sdk/init',
    );
  });

  it('allows external-origin attachment uploads to reach the route handler', async () => {
    const response = proxy(
      makeRequest('/api/projects/project-1/sessions/session-1/attachments', {
        method: 'POST',
        headers: {
          origin: 'https://customer.example.com',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('rewrites sdk session message history requests to runtime', async () => {
    const response = proxy(
      makeRequest('/api/projects/project-1/sessions/session-1/messages?direction=asc&limit=200', {
        method: 'GET',
        headers: {
          origin: 'https://customer.example.com',
          'x-sdk-token': 'sdk-token',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://runtime.example.test/api/projects/project-1/sessions/session-1/messages?direction=asc&limit=200',
    );
  });

  it('still blocks unrelated cross-origin mutating api requests', async () => {
    const response = proxy(
      makeRequest('/api/platform/admin/tenants', {
        method: 'POST',
        headers: {
          origin: 'https://evil.example.com',
        },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'CSRF origin mismatch' });
  });

  it('rewrites inbound a2a rpc requests to runtime without requiring a studio cookie', async () => {
    const response = proxy(
      makeRequest('/a2a/conn-123', {
        method: 'POST',
        headers: {
          authorization: 'Bearer inbound-a2a-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'message/send',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://runtime.example.test/a2a/conn-123',
    );
  });

  it('rewrites a2a agent card discovery without redirecting to login', async () => {
    const response = proxy(makeRequest('/a2a/conn-123/.well-known/agent-card.json'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://runtime.example.test/a2a/conn-123/.well-known/agent-card.json',
    );
  });
});
