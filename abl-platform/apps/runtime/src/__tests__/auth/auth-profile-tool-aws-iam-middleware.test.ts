import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext, ToolCallResult } from '@abl/compiler';

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  isRedisAvailable: () => false,
}));

const mockResolveToolAuth = vi.fn();

vi.mock('../../services/auth-profile/resolve-tool-auth.js', () => ({
  AuthProfileNotFoundError: class AuthProfileNotFoundError extends Error {},
  AuthProfileTokenRequiredError: class AuthProfileTokenRequiredError extends Error {},
  resolveToolAuth: (...args: unknown[]) => mockResolveToolAuth(...args),
}));

import { createAuthProfileToolMiddleware } from '../../services/auth-profile/auth-profile-tool-middleware.js';

describe('AuthProfileToolMiddleware AWS IAM propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('threads sigv4_auth into the patched HTTP tool binding', async () => {
    mockResolveToolAuth.mockResolvedValueOnce({
      headers: {
        'X-Existing-Header': 'present',
      },
      source: 'auth_profile',
      authType: 'aws_iam',
      awsSigV4: {
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret-key',
        sessionToken: 'session-token',
        region: 'us-east-1',
        service: 'execute-api',
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
        toolName: 'aws-tool',
        params: {},
        timeoutMs: 30_000,
        tool: {
          name: 'aws-tool',
          tool_type: 'http',
          auth_profile_ref: 'aws-profile',
          http_binding: {
            endpoint: 'https://api.example.com/resource',
            method: 'POST',
            auth: { type: 'none' },
            headers: {},
          },
        } as any,
      },
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect((result.result as any).http_binding.sigv4_auth).toEqual({
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret-key',
      sessionToken: 'session-token',
      region: 'us-east-1',
      service: 'execute-api',
    });
    expect((result.result as any).http_binding.headers['X-Existing-Header']).toBe('present');
  });

  it('fails closed when AWS IAM auth is missing the signing service', async () => {
    mockResolveToolAuth.mockResolvedValueOnce({
      headers: {},
      source: 'auth_profile',
      authType: 'aws_iam',
      awsSigV4: {
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret-key',
        region: 'us-east-1',
      },
    });

    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-1',
    });

    const next = vi.fn();

    await expect(
      middleware(
        {
          toolName: 'aws-tool',
          params: {},
          timeoutMs: 30_000,
          tool: {
            name: 'aws-tool',
            tool_type: 'http',
            auth_profile_ref: 'aws-profile',
            http_binding: {
              endpoint: 'https://api.example.com/resource',
              method: 'GET',
              auth: { type: 'none' },
            },
          } as any,
        },
        next,
      ),
    ).rejects.toMatchObject({
      code: 'TOOL_AUTH_FAILED',
      message: expect.stringContaining('AWS IAM auth requires both region and service'),
    });

    expect(next).not.toHaveBeenCalled();
  });
});
