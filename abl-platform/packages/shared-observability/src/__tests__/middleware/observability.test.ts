import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createObservabilityMiddleware } from '../../middleware/observability.js';
import type {
  ObservabilityMiddlewareConfig,
  ObservabilityContext,
} from '../../middleware/observability.js';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/api/health',
    headers: {},
    route: undefined,
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response & { _headers: Record<string, string>; _finishCbs: (() => void)[] } {
  const _headers: Record<string, string> = {};
  const _finishCbs: (() => void)[] = [];
  return {
    _headers,
    _finishCbs,
    statusCode: 200,
    setHeader: vi.fn((name: string, value: string) => {
      _headers[name] = value;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'finish') _finishCbs.push(cb);
    }),
  } as unknown as Response & { _headers: Record<string, string>; _finishCbs: (() => void)[] };
}

function makeConfig(overrides: Partial<ObservabilityMiddlewareConfig> = {}) {
  const cfg = {
    runWithContext: vi.fn((_ctx: ObservabilityContext, fn: () => void) => fn()),
    getTenantContext: vi.fn((): { tenantId?: string; userId?: string } | undefined => undefined),
    logRequestStart: vi.fn((_method: string, _path: string, _ua?: string) => {}),
    logRequestEnd: vi.fn((_method: string, _path: string, _status: number, _dur: number) => {}),
    recordMetrics: vi.fn(
      (_info: { method: string; route: string; statusCode: number; durationMs: number }) => {},
    ),
    incrementActive: vi.fn(() => {}),
    decrementActive: vi.fn(() => {}),
    ...overrides,
  };
  return cfg;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createObservabilityMiddleware', () => {
  let config: ReturnType<typeof makeConfig>;
  let next: NextFunction;

  beforeEach(() => {
    config = makeConfig();
    next = vi.fn();
  });

  it('generates a traceId when no traceparent header is present', () => {
    const mw = createObservabilityMiddleware(config);
    const req = makeReq();
    const res = makeRes();

    mw(req, res, next);

    const ctx = config.runWithContext.mock.calls[0][0] as ObservabilityContext;
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('parses a valid traceparent and extracts traceId/spanId', () => {
    const mw = createObservabilityMiddleware(config);
    const req = makeReq({
      headers: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
    } as Partial<Request>);
    const res = makeRes();

    mw(req, res, next);

    const ctx = config.runWithContext.mock.calls[0][0] as ObservabilityContext;
    expect(ctx.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(ctx.spanId).toBe('b7ad6b7169203331');
  });

  it('sets X-Trace-Id response header', () => {
    const mw = createObservabilityMiddleware(config);
    const req = makeReq();
    const res = makeRes();

    mw(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Trace-Id',
      expect.stringMatching(/^[0-9a-f]{32}$/),
    );
  });

  it('calls runWithContext with correct ObservabilityContext', () => {
    config.getTenantContext.mockReturnValue({ tenantId: 't1', userId: 'u1' });
    const mw = createObservabilityMiddleware(config);
    const req = makeReq({
      headers: {
        'x-session-id': 'sess-123',
        'x-correlation-id': 'corr-456',
      },
    } as Partial<Request>);
    const res = makeRes();

    mw(req, res, next);

    const ctx = config.runWithContext.mock.calls[0][0] as ObservabilityContext;
    expect(ctx.tenantId).toBe('t1');
    expect(ctx.userId).toBe('u1');
    expect(ctx.sessionId).toBe('sess-123');
    expect(ctx.correlationId).toBe('corr-456');
  });

  it('handles malformed traceparent gracefully (falls back to generated IDs)', () => {
    const mw = createObservabilityMiddleware(config);
    const req = makeReq({
      headers: { traceparent: 'not-a-valid-traceparent' },
    } as Partial<Request>);
    const res = makeRes();

    mw(req, res, next);

    const ctx = config.runWithContext.mock.calls[0][0] as ObservabilityContext;
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('calls incrementActive and logRequestStart inside runWithContext', () => {
    const mw = createObservabilityMiddleware(config);
    const req = makeReq({
      headers: { 'user-agent': 'test-agent' },
    } as Partial<Request>);
    const res = makeRes();

    mw(req, res, next);

    expect(config.incrementActive).toHaveBeenCalledOnce();
    expect(config.logRequestStart).toHaveBeenCalledWith('GET', '/api/health', 'test-agent');
  });

  it('calls next() inside runWithContext', () => {
    const mw = createObservabilityMiddleware(config);
    mw(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('measures request duration and emits metrics on res finish', () => {
    const mw = createObservabilityMiddleware(config);
    const res = makeRes();
    res.statusCode = 201;

    mw(makeReq(), res, next);

    // Trigger finish callback
    expect(res._finishCbs.length).toBe(1);
    res._finishCbs[0]();

    expect(config.decrementActive).toHaveBeenCalledOnce();
    expect(config.recordMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: '/api/health',
        statusCode: 201,
        durationMs: expect.any(Number),
      }),
    );
    expect(config.logRequestEnd).toHaveBeenCalledWith(
      'GET',
      '/api/health',
      201,
      expect.any(Number),
    );
  });

  it('uses req.route.path when available for metrics route', () => {
    const mw = createObservabilityMiddleware(config);
    const req = makeReq({ route: { path: '/api/users/:id' } } as Partial<Request>);
    const res = makeRes();

    mw(req, res, next);
    res._finishCbs[0]();

    expect(config.recordMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/api/users/:id' }),
    );
  });

  it('works when optional callbacks are not provided', () => {
    const minimalConfig: ObservabilityMiddlewareConfig = {
      runWithContext: vi.fn((_ctx: ObservabilityContext, fn: () => void) => fn()),
    };
    const mw = createObservabilityMiddleware(minimalConfig);
    const res = makeRes();

    mw(makeReq(), res, next);
    res._finishCbs[0]();

    expect(next).toHaveBeenCalledOnce();
  });

  it('handles getTenantContext returning undefined', () => {
    config.getTenantContext.mockReturnValue(undefined);
    const mw = createObservabilityMiddleware(config);

    mw(makeReq(), makeRes(), next);

    const ctx = config.runWithContext.mock.calls[0][0] as ObservabilityContext;
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.userId).toBeUndefined();
  });
});
