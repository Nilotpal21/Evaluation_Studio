import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  createAccessDeniedReporter,
  getRequestAccessDeniedReporter,
} from '../middleware/access-denial.js';

describe('access-denial reporter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still emits the denial event to onAccessDenied when logger.warn throws', () => {
    const logger = {
      warn: vi.fn(() => {
        throw new Error('logger failed');
      }),
    };
    const onAccessDenied = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = createAccessDeniedReporter({
      transport: 'http',
      logger,
      onAccessDenied,
      requestId: 'req-logger-failure',
      method: 'GET',
      path: '/protected',
    });

    expect(() =>
      reporter({
        layer: 'require_auth',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        statusCode: 401,
      }),
    ).not.toThrow();

    expect(onAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'AUTHENTICATION_REQUIRED',
        requestId: 'req-logger-failure',
      }),
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it('returns the denial event even when onAccessDenied throws', () => {
    const onAccessDenied = vi.fn(() => {
      throw new Error('sink failed');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = createAccessDeniedReporter({
      transport: 'http',
      onAccessDenied,
      requestId: 'req-sink-failure',
      method: 'GET',
      path: '/protected',
    });

    const event = reporter({
      layer: 'require_auth',
      scope: 'auth',
      reasonCode: 'AUTHENTICATION_REQUIRED',
      reason: 'Authentication required',
      concealAsNotFound: false,
      statusCode: 401,
    });

    expect(event).toEqual(
      expect.objectContaining({
        kind: 'access_denied',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        requestId: 'req-sink-failure',
      }),
    );
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('builds a fallback request reporter when no request reporter was attached upstream', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      headers: { 'x-request-id': 'req-fallback' },
      method: 'POST',
      url: '/fallback',
      originalUrl: '/fallback',
    } as unknown as Request;

    const event = getRequestAccessDeniedReporter(req)({
      layer: 'require_auth',
      scope: 'auth',
      reasonCode: 'AUTHENTICATION_REQUIRED',
      reason: 'Authentication required',
      concealAsNotFound: false,
      statusCode: 401,
    });

    expect(event).toEqual(
      expect.objectContaining({
        requestId: 'req-fallback',
        path: '/fallback',
        method: 'POST',
      }),
    );
    expect(warnSpy).toHaveBeenCalled();
  });
});
