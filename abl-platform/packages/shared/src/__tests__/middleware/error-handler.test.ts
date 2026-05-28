import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError, ErrorCodes } from '../../errors.js';
import {
  createExpressErrorHandler,
  normalizeExpressError,
} from '../../middleware/error-handler.js';

function createMockReq(): Partial<Request> {
  return {
    method: 'GET',
    path: '/test',
  };
}

function createMockRes(): Partial<Response> {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('normalizeExpressError', () => {
  it('maps ZodError to VALIDATION_ERROR with path-aware messages', () => {
    const schema = z.object({ tenantId: z.string().min(1) });
    const parsed = schema.safeParse({ tenantId: '' });

    expect(parsed.success).toBe(false);

    const normalized = normalizeExpressError(parsed.error);
    expect(normalized.statusCode).toBe(400);
    expect(normalized.code).toBe('VALIDATION_ERROR');
    expect(normalized.message).toContain('tenantId');
  });
});

describe('createExpressErrorHandler', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('serializes AppError with the default shared-kernel envelope', () => {
    const req = createMockReq();
    const res = createMockRes();
    const handler = createExpressErrorHandler();
    const error = new AppError('Project not found', { ...ErrorCodes.NOT_FOUND });

    handler(error, req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('serializes plain Error as INTERNAL_ERROR by default', () => {
    const req = createMockReq();
    const res = createMockRes();
    const handler = createExpressErrorHandler();

    handler(new Error('boom'), req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });
  });

  it('supports custom response serialization', () => {
    const req = createMockReq();
    const res = createMockRes();
    const handler = createExpressErrorHandler({
      serialize: (normalized) => ({
        ok: false,
        code: normalized.code,
        message: normalized.message,
      }),
    });

    handler(
      new AppError('Denied', { ...ErrorCodes.FORBIDDEN }),
      req as Request,
      res as Response,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      code: 'FORBIDDEN',
      message: 'Denied',
    });
  });

  it('calls logError with normalized details', () => {
    const req = createMockReq();
    const res = createMockRes();
    const logError = vi.fn();
    const handler = createExpressErrorHandler({ logError });
    const error = new AppError('Conflict', { ...ErrorCodes.CONFLICT });

    handler(error, req as Request, res as Response, next);

    expect(logError).toHaveBeenCalledWith(
      error,
      req,
      expect.objectContaining({
        statusCode: 409,
        code: 'CONFLICT',
        message: 'Conflict',
      }),
    );
  });
});
