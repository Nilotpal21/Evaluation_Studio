/**
 * route-helpers — unit tests
 *
 * `requireTenantProject` is the 400-boundary for every workflow-engine route
 * handler that needs `tenantId` + `projectId`. Before it existed, individual
 * routes returned bare `error: 'Missing...'` strings — so these tests pin
 * the canonical `{ success: false, error: { code, message } }` shape.
 *
 * `asyncHandler` forwards rejected promises to Express `next()` so async
 * handlers don't become unhandled rejections under Express 4.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler, getTenantId, requireTenantProject } from '../lib/route-helpers.js';

// ─── Fake Request / Response ────────────────────────────────────────────────

function makeRequest(overrides: {
  tenantId?: unknown;
  params?: Record<string, string | undefined>;
}): Request {
  return {
    params: overrides.params ?? {},
    ...(overrides.tenantId !== undefined
      ? { tenantContext: { tenantId: overrides.tenantId } }
      : {}),
  } as unknown as Request;
}

function makeResponse(): Response & { _status?: number; _body?: unknown } {
  const res: Response & { _status?: number; _body?: unknown } = {
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  } as unknown as Response & { _status?: number; _body?: unknown };
  return res;
}

// ─── getTenantId ────────────────────────────────────────────────────────────

describe('getTenantId', () => {
  it('returns the tenantId string when tenantContext is populated', () => {
    expect(getTenantId(makeRequest({ tenantId: 't-1', params: {} }))).toBe('t-1');
  });

  it('returns undefined when tenantContext is missing entirely', () => {
    expect(getTenantId(makeRequest({ params: {} }))).toBeUndefined();
  });

  it('returns undefined when tenantContext.tenantId is a non-string value', () => {
    expect(getTenantId(makeRequest({ tenantId: 42, params: {} }))).toBeUndefined();
    expect(getTenantId(makeRequest({ tenantId: null, params: {} }))).toBeUndefined();
  });

  it('returns undefined when tenantContext.tenantId is an empty string', () => {
    expect(getTenantId(makeRequest({ tenantId: '', params: {} }))).toBeUndefined();
  });
});

// ─── requireTenantProject ──────────────────────────────────────────────────

describe('requireTenantProject — happy path', () => {
  it('returns { tenantId, projectId } when both are present', () => {
    const res = makeResponse();
    const result = requireTenantProject(
      makeRequest({ tenantId: 't-1', params: { projectId: 'p-1' } }),
      res,
    );

    expect(result).toEqual({ tenantId: 't-1', projectId: 'p-1' });
    // Did not 400 the caller.
    expect(res._status).toBeUndefined();
    expect(res._body).toBeUndefined();
  });

  it('also returns additional required params when requested', () => {
    const res = makeResponse();
    const result = requireTenantProject(
      makeRequest({
        tenantId: 't-1',
        params: { projectId: 'p-1', workflowId: 'wf-42', registrationId: 'reg-9' },
      }),
      res,
      { requireParams: ['workflowId', 'registrationId'] },
    );

    expect(result).toEqual({
      tenantId: 't-1',
      projectId: 'p-1',
      workflowId: 'wf-42',
      registrationId: 'reg-9',
    });
    expect(res._status).toBeUndefined();
  });
});

describe('requireTenantProject — 400 error shape', () => {
  it('returns null and sends 400 { success:false, error:{code,message} } when tenantId is missing', () => {
    const res = makeResponse();
    const result = requireTenantProject(makeRequest({ params: { projectId: 'p-1' } }), res);

    expect(result).toBeNull();
    expect(res._status).toBe(400);
    expect(res._body).toEqual({
      success: false,
      error: {
        code: 'MISSING_PARAMETERS',
        message: 'Missing required parameters: tenantId',
      },
    });
  });

  it('returns null and sends 400 when projectId is missing', () => {
    const res = makeResponse();
    const result = requireTenantProject(makeRequest({ tenantId: 't-1', params: {} }), res);

    expect(result).toBeNull();
    expect(res._status).toBe(400);
    expect((res._body as { error: { message: string } }).error.message).toContain('projectId');
  });

  it('names every missing key (tenantId + projectId + required extras) in the message', () => {
    // Guard: the error message is the user-visible hint for debugging a
    // misconfigured route call. All missing keys should appear.
    const res = makeResponse();
    requireTenantProject(makeRequest({ params: {} }), res, {
      requireParams: ['workflowId', 'executionId'],
    });

    expect(res._status).toBe(400);
    const msg = (res._body as { error: { message: string } }).error.message;
    expect(msg).toContain('tenantId');
    expect(msg).toContain('projectId');
    expect(msg).toContain('workflowId');
    expect(msg).toContain('executionId');
  });

  it('treats empty-string extra params as missing', () => {
    const res = makeResponse();
    requireTenantProject(
      makeRequest({
        tenantId: 't-1',
        params: { projectId: 'p-1', workflowId: '' },
      }),
      res,
      { requireParams: ['workflowId'] },
    );

    expect(res._status).toBe(400);
    expect((res._body as { error: { message: string } }).error.message).toContain('workflowId');
  });
});

// ─── asyncHandler ──────────────────────────────────────────────────────────

describe('asyncHandler', () => {
  it('invokes the wrapped async function with (req, res, next)', async () => {
    const inner = vi.fn(async () => undefined);
    const wrapped = asyncHandler(inner);
    const req = makeRequest({});
    const res = makeResponse();
    const next = vi.fn() as unknown as NextFunction;

    wrapped(req, res, next);
    // Inner is called synchronously — the wrapper returns before awaiting.
    expect(inner).toHaveBeenCalledWith(req, res, next);
  });

  it('forwards rejected promises to next() (Express-4 safety)', async () => {
    const err = new Error('boom');
    const inner = vi.fn(async () => {
      throw err;
    });
    const wrapped = asyncHandler(inner);
    const nextCalls: unknown[] = [];
    const next = ((e: unknown) => {
      nextCalls.push(e);
    }) as NextFunction;

    wrapped(makeRequest({}), makeResponse(), next);
    // Wait one microtask tick for the .catch to fire.
    await Promise.resolve();
    await Promise.resolve();

    expect(nextCalls).toEqual([err]);
  });

  it('does NOT call next() when the wrapped handler resolves normally', async () => {
    const inner = vi.fn(async () => undefined);
    const wrapped = asyncHandler(inner);
    const next = vi.fn() as unknown as NextFunction;

    wrapped(makeRequest({}), makeResponse(), next);
    await Promise.resolve();
    await Promise.resolve();

    expect(next).not.toHaveBeenCalled();
  });
});
