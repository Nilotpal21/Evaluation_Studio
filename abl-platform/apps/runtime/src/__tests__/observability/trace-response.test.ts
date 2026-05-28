/**
 * Trace Response Middleware Tests
 *
 * Covers sendWithTrace:
 * - Injects traceId from ALS context into response body
 * - Sends response without traceId when ALS context is empty
 * - Sets correct status code
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock getCurrentTraceId
const mockGetCurrentTraceId = vi.fn();
vi.mock('@abl/compiler/platform/observability', () => ({
  getCurrentTraceId: () => mockGetCurrentTraceId(),
}));

import { sendWithTrace } from '../../middleware/trace-response.js';
import type { Response } from 'express';

function createMockRes(): { res: Response; sentStatus: number | null; sentBody: unknown } {
  const state = { sentStatus: null as number | null, sentBody: null as unknown };
  const res = {
    status(code: number) {
      state.sentStatus = code;
      return this;
    },
    json(body: unknown) {
      state.sentBody = body;
    },
  } as unknown as Response;
  return { res, ...state };
}

describe('sendWithTrace', () => {
  afterEach(() => {
    mockGetCurrentTraceId.mockReset();
  });

  it('injects traceId into response body when available', () => {
    mockGetCurrentTraceId.mockReturnValue('trace-abc-123');
    const mock = createMockRes();
    const body = { success: true, data: { id: 1 } };

    sendWithTrace(mock.res, 200, body);

    expect(body).toHaveProperty('traceId', 'trace-abc-123');
  });

  it('does not inject traceId when ALS context is empty', () => {
    mockGetCurrentTraceId.mockReturnValue(undefined);
    const mock = createMockRes();
    const body = { success: true };

    sendWithTrace(mock.res, 200, body);

    expect(body).not.toHaveProperty('traceId');
  });

  it('sets the correct status code', () => {
    mockGetCurrentTraceId.mockReturnValue(undefined);
    let capturedStatus: number | undefined;
    const res = {
      status(code: number) {
        capturedStatus = code;
        return this;
      },
      json: vi.fn(),
    } as unknown as Response;

    sendWithTrace(res, 404, { error: 'not found' });

    expect(capturedStatus).toBe(404);
  });
});
