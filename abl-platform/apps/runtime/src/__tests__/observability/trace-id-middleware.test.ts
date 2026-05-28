/**
 * Trace ID Middleware Tests
 *
 * Verifies that the observability middleware:
 * - Sets X-Trace-Id response header (32 hex chars)
 * - Honors incoming W3C traceparent header
 * - Coexists with X-Request-Id from requestIdMiddleware
 */

import { describe, test, expect } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  requestIdMiddleware,
  createObservabilityMiddleware,
} from '@agent-platform/shared-observability';
import { runWithObservabilityContext } from '@abl/compiler/platform/observability';

function createTestApp() {
  const app = express();
  app.use(requestIdMiddleware());
  app.use(
    createObservabilityMiddleware({
      runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
    }),
  );
  app.get('/test', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('Observability Middleware — Trace ID', () => {
  let server: http.Server;
  let baseUrl: string;

  const startServer = (app: express.Express): Promise<void> =>
    new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

  const stopServer = (): Promise<void> =>
    new Promise((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });

  test('sets X-Trace-Id header with 32 hex chars', async () => {
    const app = createTestApp();
    await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/test`);
      expect(res.status).toBe(200);

      const traceId = res.headers.get('x-trace-id');
      expect(traceId).toBeTruthy();
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await stopServer();
    }
  });

  test('honors incoming W3C traceparent header', async () => {
    const app = createTestApp();
    await startServer(app);
    try {
      const incomingTraceId = 'abcdef0123456789abcdef0123456789';
      const traceparent = `00-${incomingTraceId}-0123456789abcdef-01`;

      const res = await fetch(`${baseUrl}/test`, {
        headers: { traceparent },
      });
      expect(res.status).toBe(200);

      const traceId = res.headers.get('x-trace-id');
      expect(traceId).toBe(incomingTraceId);
    } finally {
      await stopServer();
    }
  });

  test('coexists with X-Request-Id header', async () => {
    const app = createTestApp();
    await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/test`);
      expect(res.status).toBe(200);

      const requestId = res.headers.get('x-request-id');
      const traceId = res.headers.get('x-trace-id');

      expect(requestId).toBeTruthy();
      expect(traceId).toBeTruthy();
      // They should be different values (different middleware)
      expect(requestId).not.toBe(traceId);
    } finally {
      await stopServer();
    }
  });
});
