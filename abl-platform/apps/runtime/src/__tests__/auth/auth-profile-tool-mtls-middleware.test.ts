import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext, ToolCallResult } from '@abl/compiler';

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

const mockResolveToolAuth = vi.fn();

vi.mock('../../services/auth-profile/resolve-tool-auth.js', () => ({
  AuthProfileNotFoundError: class AuthProfileNotFoundError extends Error {},
  AuthProfileTokenRequiredError: class AuthProfileTokenRequiredError extends Error {},
  resolveToolAuth: (...args: unknown[]) => mockResolveToolAuth(...args),
}));

import { createAuthProfileToolMiddleware } from '../../services/auth-profile/auth-profile-tool-middleware.js';

describe('AuthProfileToolMiddleware mTLS propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('threads tls_options into the patched HTTP tool binding', async () => {
    mockResolveToolAuth.mockResolvedValueOnce({
      headers: { Authorization: 'Bearer access-token' },
      queryParams: { region: 'us-east-1' },
      source: 'auth_profile',
      authType: 'mtls',
      tlsOptions: {
        cert: 'CLIENT_CERT',
        key: 'CLIENT_KEY',
        ca: 'ROOT_CA',
        rejectUnauthorized: true,
      },
    });

    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-1',
    });

    const next = vi.fn(
      async (ctx: ToolCallContext): Promise<ToolCallResult> => ({
        result: ctx.tool,
      }),
    );

    const result = await middleware(
      {
        toolName: 'mtls-tool',
        params: {},
        timeoutMs: 30_000,
        tool: {
          name: 'mtls-tool',
          auth_profile_ref: 'mtls-profile',
          http_binding: {
            endpoint: 'https://mtls.example.com',
            method: 'GET',
            auth: { type: 'none' },
            headers: {},
          },
        } as any,
      },
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect((result.result as any).http_binding.tls_options).toEqual({
      cert: 'CLIENT_CERT',
      key: 'CLIENT_KEY',
      ca: 'ROOT_CA',
      rejectUnauthorized: true,
    });
    expect((result.result as any).http_binding.headers.Authorization).toBe('Bearer access-token');
    expect((result.result as any).http_binding.query_params).toEqual({ region: 'us-east-1' });
  });

  it('fails closed when an mTLS profile is used on a non-HTTP tool path', async () => {
    mockResolveToolAuth.mockResolvedValueOnce({
      headers: {},
      source: 'auth_profile',
      authType: 'mtls',
      tlsOptions: {
        cert: 'CLIENT_CERT',
        key: 'CLIENT_KEY',
        rejectUnauthorized: true,
      },
    });

    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-1',
    });

    const next = vi.fn();

    await expect(
      middleware(
        {
          toolName: 'mtls-tool',
          params: {},
          timeoutMs: 30_000,
          tool: {
            name: 'mtls-tool',
            tool_type: 'mcp',
            auth_profile_ref: 'mtls-profile',
            mcp_binding: {
              server: 'server-1',
              tool: 'tool-1',
            },
          } as any,
        },
        next,
      ),
    ).rejects.toMatchObject({
      code: 'TOOL_AUTH_FAILED',
    });

    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when an mTLS profile is attached to an http:// endpoint', async () => {
    mockResolveToolAuth.mockResolvedValueOnce({
      headers: {},
      source: 'auth_profile',
      authType: 'mtls',
      tlsOptions: {
        cert: 'CLIENT_CERT',
        key: 'CLIENT_KEY',
        rejectUnauthorized: true,
      },
    });

    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-1',
    });

    const next = vi.fn();

    await expect(
      middleware(
        {
          toolName: 'mtls-tool',
          params: {},
          timeoutMs: 30_000,
          tool: {
            name: 'mtls-tool',
            tool_type: 'http',
            auth_profile_ref: 'mtls-profile',
            http_binding: {
              endpoint: 'http://mtls.example.com',
              method: 'GET',
              auth: { type: 'none' },
            },
          } as any,
        },
        next,
      ),
    ).rejects.toMatchObject({
      code: 'TOOL_AUTH_FAILED',
      message: expect.stringContaining('mTLS auth requires an https:// endpoint'),
    });

    expect(next).not.toHaveBeenCalled();
  });
});
