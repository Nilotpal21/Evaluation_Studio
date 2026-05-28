/**
 * requireTenantContext Middleware Tests (Sprint 1 — Task 1.4)
 *
 * Tests for the new requireTenantContext() middleware that guarantees
 * req.tenantContext is populated with a valid tenantId.
 *
 * This middleware replaces ad-hoc `req.tenantContext!.tenantId` assertions
 * and inline null checks scattered across route handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { TenantContextData } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTenantContext(overrides: Partial<TenantContextData> = {}): TenantContextData {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'ADMIN',
    permissions: ['agent:read'],
    authType: 'user',
    isSuperAdmin: false,
    ...overrides,
  };
}

function createMocks(tenantContext?: TenantContextData | null) {
  const req = {
    tenantContext: tenantContext ?? undefined,
    user: tenantContext ? { id: tenantContext.userId } : undefined,
    reportAccessDenied: vi.fn(),
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

// ---------------------------------------------------------------------------
// Import under test — will fail until implementation exists.
// Using dynamic import so the test file can be committed before the code.
// ---------------------------------------------------------------------------

async function getRequireTenantContext() {
  const mod = await import('../middleware/unified-auth.js');
  if (!('requireTenantContext' in mod)) {
    throw new Error(
      'requireTenantContext is not exported from unified-auth.ts. ' +
        'Implement Task 1.4 to make these tests pass.',
    );
  }
  return (mod as any).requireTenantContext as () => (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('requireTenantContext', () => {
  let requireTenantContext: Awaited<ReturnType<typeof getRequireTenantContext>>;

  beforeEach(async () => {
    requireTenantContext = await getRequireTenantContext();
  });

  it('calls next() when tenantContext is present with valid tenantId', async () => {
    const middleware = requireTenantContext();
    const { req, res, next } = createMocks(makeTenantContext());

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when tenantContext is undefined', async () => {
    const middleware = requireTenantContext();
    const { req, res, next } = createMocks(undefined);

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'TENANT_CONTEXT_REQUIRED',
        }),
      }),
    );
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'require_tenant_context',
        scope: 'tenant',
        reasonCode: 'TENANT_CONTEXT_REQUIRED',
        statusCode: 403,
      }),
    );
  });

  it('returns 403 when tenantContext exists but tenantId is empty string', async () => {
    const middleware = requireTenantContext();
    const { req, res, next } = createMocks(makeTenantContext({ tenantId: '' }));

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 when tenantContext is null', async () => {
    const middleware = requireTenantContext();
    const { req, res, next } = createMocks(null);

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('passes through for SDK session auth with valid tenantId', async () => {
    const middleware = requireTenantContext();
    const { req, res, next } = createMocks(
      makeTenantContext({ authType: 'sdk_session', tenantId: 'sdk-tenant-1' }),
    );

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for API key auth with valid tenantId', async () => {
    const middleware = requireTenantContext();
    const { req, res, next } = createMocks(
      makeTenantContext({ authType: 'api_key', tenantId: 'api-tenant-1' }),
    );

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for super admin with valid tenantId', async () => {
    const middleware = requireTenantContext();
    const { req, res, next } = createMocks(makeTenantContext({ isSuperAdmin: true }));

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects the synthetic platform-admin tenant sentinel', async () => {
    const middleware = requireTenantContext();
    const { req, res, next } = createMocks(
      makeTenantContext({
        tenantId: '__platform_admin__',
        role: 'platform_admin',
        isSuperAdmin: true,
      }),
    );

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'require_tenant_context',
        scope: 'tenant',
        reasonCode: 'TENANT_CONTEXT_REQUIRED',
      }),
    );
  });

  it('error response uses standard envelope format', async () => {
    const middleware = requireTenantContext();
    const { req, res, next } = createMocks(undefined);

    middleware(req, res, next);

    const jsonCall = (res.json as any).mock.calls[0][0];
    expect(jsonCall).toEqual({
      success: false,
      error: {
        code: 'TENANT_CONTEXT_REQUIRED',
        message: expect.any(String),
      },
    });
  });
});
