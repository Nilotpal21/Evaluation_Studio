import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireTenantMatch } from '../../middleware/tenant-match.js';

function createMockReq(
  paramTenantId?: string,
  contextTenantId?: string,
  isSuperAdmin?: boolean,
): Partial<Request> {
  const req: any = {
    params: {} as Record<string, string>,
  };
  if (paramTenantId !== undefined) {
    req.params.tenantId = paramTenantId;
  }
  if (contextTenantId !== undefined) {
    req.tenantContext = { tenantId: contextTenantId, isSuperAdmin: isSuperAdmin ?? false };
  }
  return req;
}

function createMockRes(): Partial<Response> {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('requireTenantMatch', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('calls next when tenantId matches', () => {
    const req = createMockReq('tenant-1', 'tenant-1');
    const res = createMockRes();

    requireTenantMatch(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 404 when tenantId mismatches', () => {
    const req = createMockReq('tenant-a', 'tenant-b');
    const res = createMockRes();

    requireTenantMatch(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });

  it('returns 404 when tenantContext is missing', () => {
    const req = createMockReq('tenant-1');
    const res = createMockRes();

    requireTenantMatch(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });

  it('allows super-admin to access any tenant', () => {
    const req = createMockReq('tenant-a', 'tenant-b', true);
    const res = createMockRes();

    requireTenantMatch(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 404 when param tenantId is missing', () => {
    const req = createMockReq(undefined, 'tenant-1');
    const res = createMockRes();

    requireTenantMatch(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });
});
