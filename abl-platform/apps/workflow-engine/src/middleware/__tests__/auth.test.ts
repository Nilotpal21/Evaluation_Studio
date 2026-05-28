import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Request, Response } from 'express';
import { signPlatformAccessToken } from '@agent-platform/shared-auth';

const TEST_JWT_SECRET = '1'.repeat(64);

describe('workflow-engine unifiedAuth — service:* bypass', () => {
  let unifiedAuth: (req: Request, res: Response, next: () => void) => void | Promise<void>;
  let prevSecret: string | undefined;

  beforeAll(async () => {
    prevSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    const mod = await import('../auth.js');
    unifiedAuth = mod.unifiedAuth as unknown as typeof unifiedAuth;
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  function buildReq(token: string): Request {
    return {
      headers: { authorization: `Bearer ${token}` },
      method: 'GET',
      originalUrl: '/api/v1/projects/p1/workflows/w1/executions/execute',
      url: '/api/v1/projects/p1/workflows/w1/executions/execute',
    } as unknown as Request;
  }

  function buildRes(): {
    res: Response;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  } {
    const status = vi.fn();
    const json = vi.fn();
    const res = { status, json } as unknown as Response;
    status.mockReturnValue(res);
    json.mockReturnValue(res);
    return { res, status, json };
  }

  test('accepts sub="service:runtime" without DB lookup and yields OWNER tenantContext', async () => {
    const token = signPlatformAccessToken(
      {
        sub: 'service:runtime',
        email: 'runtime-internal@service.local',
        type: 'access',
        tokenClass: 'user',
        tenantId: 'tenant-abc',
        projectId: 'proj-xyz',
        role: 'OWNER',
        internal: true,
      },
      TEST_JWT_SECRET,
      { expiresIn: 3600 },
    );

    const req = buildReq(token);
    const { res, status } = buildRes();
    const next = vi.fn();

    await unifiedAuth(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const ctx = (req as unknown as { tenantContext: Record<string, unknown> }).tenantContext;
    expect(ctx).toBeDefined();
    expect(ctx.userId).toBe('service:runtime');
    expect(ctx.tenantId).toBe('tenant-abc');
    expect(ctx.role).toBe('OWNER');
    expect(ctx.authType).toBe('user');
    expect(ctx.projectId).toBe('proj-xyz');
  });

  test('bypass is prefix-based — any service:* sub is accepted', async () => {
    const token = signPlatformAccessToken(
      {
        sub: 'service:any-future-caller',
        email: 'svc@internal.service',
        type: 'access',
        tokenClass: 'user',
        tenantId: 'tenant-abc',
        role: 'OWNER',
        internal: true,
      },
      TEST_JWT_SECRET,
      { expiresIn: 3600 },
    );

    const req = buildReq(token);
    const { res, status } = buildRes();
    const next = vi.fn();

    await unifiedAuth(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const ctx = (req as unknown as { tenantContext: Record<string, unknown> }).tenantContext;
    expect(ctx.userId).toBe('service:any-future-caller');
    expect(ctx.role).toBe('OWNER');
  });

  test('rejects token signed with wrong secret regardless of service: sub', async () => {
    const token = signPlatformAccessToken(
      {
        sub: 'service:runtime',
        email: 'runtime-internal@service.local',
        type: 'access',
        tokenClass: 'user',
        tenantId: 'tenant-abc',
        role: 'OWNER',
        internal: true,
      },
      'wrong-secret-' + '0'.repeat(50),
      { expiresIn: 3600 },
    );

    const req = buildReq(token);
    const { res, status, json } = buildRes();
    const next = vi.fn();

    await unifiedAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    const body = json.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(body?.error).toMatch(/invalid|expired/i);
  });
});
