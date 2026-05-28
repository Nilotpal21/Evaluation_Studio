import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must use vi.hoisted so the variable is accessible inside vi.mock factory
const { mockGetCurrentTraceId } = vi.hoisted(() => ({
  mockGetCurrentTraceId: vi.fn<() => string | undefined>(),
}));
vi.mock('@abl/compiler/platform/observability', () => ({
  getCurrentTraceId: mockGetCurrentTraceId,
}));

import { sendWithTrace } from '../../../middleware/trace-response.js';
import type { Response } from 'express';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes(): Response & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: undefined as unknown,
    status: vi.fn(function (this: typeof res, code: number) {
      this._status = code;
      return this;
    }),
    json: vi.fn(function (this: typeof res, body: unknown) {
      this._body = body;
      return this;
    }),
  };
  return res as unknown as Response & { _status: number; _body: unknown };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendWithTrace', () => {
  beforeEach(() => {
    mockGetCurrentTraceId.mockReset();
  });

  it('injects traceId into response body when available', () => {
    mockGetCurrentTraceId.mockReturnValue('abc123def456');
    const res = makeRes();

    sendWithTrace(res, 200, { success: true });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, traceId: 'abc123def456' });
  });

  it('does not inject traceId when getCurrentTraceId returns undefined', () => {
    mockGetCurrentTraceId.mockReturnValue(undefined);
    const res = makeRes();

    sendWithTrace(res, 200, { data: 'hello' });

    expect(res.json).toHaveBeenCalledWith({ data: 'hello' });
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('traceId');
  });

  it('sets the correct status code', () => {
    mockGetCurrentTraceId.mockReturnValue(undefined);
    const res = makeRes();

    sendWithTrace(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('handles empty body object', () => {
    mockGetCurrentTraceId.mockReturnValue('trace-id-1');
    const res = makeRes();

    sendWithTrace(res, 200, {});

    expect(res.json).toHaveBeenCalledWith({ traceId: 'trace-id-1' });
  });

  it('mutates the passed body object (traceId added in-place)', () => {
    mockGetCurrentTraceId.mockReturnValue('trace-xyz');
    const res = makeRes();
    const body: Record<string, unknown> = { ok: true };

    sendWithTrace(res, 200, body);

    expect(body.traceId).toBe('trace-xyz');
  });
});
