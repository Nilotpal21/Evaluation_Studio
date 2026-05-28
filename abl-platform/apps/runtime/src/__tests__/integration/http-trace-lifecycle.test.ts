/**
 * E2E: HTTP Request Trace Lifecycle
 *
 * Tests the full trace flow for an HTTP request:
 * 1. Request enters with/without traceparent header
 * 2. Observability middleware creates/extracts traceId, sets ALS
 * 3. getCurrentTraceId() returns correct value downstream
 * 4. Response includes X-Trace-Id header
 * 5. Response body includes traceId (via sendWithTrace)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock createLogger to avoid pino initialization
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  runWithObservabilityContext,
  getCurrentTraceId,
  getObservabilityContext,
} from '@abl/compiler/platform/observability';
import { createObservabilityMiddleware } from '@agent-platform/shared-observability/middleware';
import { sendWithTrace } from '../../middleware/trace-response.js';

function createTestApp() {
  const app = express();

  const observabilityMiddleware = createObservabilityMiddleware({
    runWithContext: (ctx, fn) => {
      runWithObservabilityContext(ctx, fn);
    },
  });

  app.use(observabilityMiddleware);

  // Endpoint that uses sendWithTrace
  app.get('/api/test', (_req, res) => {
    sendWithTrace(res, 200, { message: 'hello' });
  });

  // Endpoint that reads ALS context downstream
  app.get('/api/context', (_req, res) => {
    const traceId = getCurrentTraceId();
    const ctx = getObservabilityContext();
    res.json({
      traceId,
      spanId: ctx?.spanId,
      hasContext: !!ctx,
    });
  });

  return app;
}

describe('HTTP Request Trace Lifecycle E2E', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createTestApp();
  });

  describe('without traceparent header', () => {
    it('generates a new traceId and sets X-Trace-Id header', async () => {
      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
      expect(res.headers['x-trace-id']).toBeDefined();
      // Generated traceId is a 32-char hex string (UUID without dashes)
      expect(res.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    });

    it('injects traceId into response body via sendWithTrace', async () => {
      const res = await request(app).get('/api/test');

      expect(res.body.message).toBe('hello');
      expect(res.body.traceId).toBeDefined();
      expect(res.body.traceId).toBe(res.headers['x-trace-id']);
    });

    it('makes traceId available via getCurrentTraceId() downstream', async () => {
      const res = await request(app).get('/api/context');

      expect(res.body.hasContext).toBe(true);
      expect(res.body.traceId).toBeDefined();
      expect(res.body.traceId).toMatch(/^[0-9a-f]{32}$/);
      // Header and ALS context should match
      expect(res.body.traceId).toBe(res.headers['x-trace-id']);
    });

    it('generates a spanId for the request', async () => {
      const res = await request(app).get('/api/context');

      expect(res.body.spanId).toBeDefined();
      expect(res.body.spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generates unique traceIds across requests', async () => {
      const res1 = await request(app).get('/api/test');
      const res2 = await request(app).get('/api/test');

      expect(res1.headers['x-trace-id']).not.toBe(res2.headers['x-trace-id']);
    });
  });

  describe('with traceparent header', () => {
    const parentTraceId = 'abcdef1234567890abcdef1234567890';
    const parentSpanId = 'abcdef1234567890';
    const traceparent = `00-${parentTraceId}-${parentSpanId}-01`;

    it('extracts traceId from traceparent header', async () => {
      const res = await request(app).get('/api/test').set('traceparent', traceparent);

      expect(res.headers['x-trace-id']).toBe(parentTraceId);
    });

    it('propagates extracted traceId to response body', async () => {
      const res = await request(app).get('/api/test').set('traceparent', traceparent);

      expect(res.body.traceId).toBe(parentTraceId);
    });

    it('makes extracted traceId available via ALS downstream', async () => {
      const res = await request(app).get('/api/context').set('traceparent', traceparent);

      expect(res.body.traceId).toBe(parentTraceId);
    });

    it('extracts spanId from traceparent header', async () => {
      const res = await request(app).get('/api/context').set('traceparent', traceparent);

      expect(res.body.spanId).toBe(parentSpanId);
    });
  });

  describe('with invalid traceparent header', () => {
    it('generates new traceId for malformed traceparent', async () => {
      const res = await request(app).get('/api/test').set('traceparent', 'invalid-header');

      expect(res.headers['x-trace-id']).toBeDefined();
      expect(res.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates new traceId for all-zero traceId', async () => {
      const zeroTrace = `00-${'0'.repeat(32)}-abcdef1234567890-01`;
      const res = await request(app).get('/api/test').set('traceparent', zeroTrace);

      expect(res.headers['x-trace-id']).not.toBe('0'.repeat(32));
    });
  });

  describe('optional middleware callbacks', () => {
    it('invokes logRequestStart and logRequestEnd', async () => {
      const logStart = vi.fn();
      const logEnd = vi.fn();
      const recordMetrics = vi.fn();
      const incrementActive = vi.fn();
      const decrementActive = vi.fn();

      const callbackApp = express();
      callbackApp.use(
        createObservabilityMiddleware({
          runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
          logRequestStart: logStart,
          logRequestEnd: logEnd,
          recordMetrics,
          incrementActive,
          decrementActive,
        }),
      );
      callbackApp.get('/api/test', (_req, res) => res.json({ ok: true }));

      await request(callbackApp).get('/api/test');

      expect(logStart).toHaveBeenCalledOnce();
      expect(logStart.mock.calls[0][0]).toBe('GET');
      expect(logStart.mock.calls[0][1]).toBe('/api/test');
      expect(logEnd).toHaveBeenCalledOnce();
      expect(logEnd.mock.calls[0]).toEqual(expect.arrayContaining(['GET', '/api/test', 200]));
      expect(recordMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          statusCode: 200,
          durationMs: expect.any(Number),
        }),
      );
      expect(incrementActive).toHaveBeenCalled();
      expect(decrementActive).toHaveBeenCalled();
    });
  });

  describe('session and correlation headers', () => {
    it('captures x-session-id and x-correlation-id into context', async () => {
      const capturedCtx: Record<string, unknown> = {};
      const captureApp = express();
      captureApp.use(
        createObservabilityMiddleware({
          runWithContext: (ctx, fn) => {
            Object.assign(capturedCtx, ctx);
            runWithObservabilityContext(ctx, fn);
          },
        }),
      );
      captureApp.get('/api/test', (_req, res) => res.json({ ok: true }));

      await request(captureApp)
        .get('/api/test')
        .set('x-session-id', 'sess-123')
        .set('x-correlation-id', 'corr-456');

      expect(capturedCtx.sessionId).toBe('sess-123');
      expect(capturedCtx.correlationId).toBe('corr-456');
    });
  });
});
