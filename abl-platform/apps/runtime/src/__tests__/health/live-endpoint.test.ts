import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import {
  createRuntimeLivenessHandler,
  type RuntimeLivenessDependencies,
} from '../../change-management/liveness.js';

function createApp(overrides: Partial<RuntimeLivenessDependencies> = {}) {
  const app = express();

  app.get(
    '/health/live',
    createRuntimeLivenessHandler({
      isShuttingDown: () => false,
      getHeapUsedMb: () => 128,
      getHeapLimitMb: () => 1536,
      ...overrides,
    }),
  );

  return app;
}

describe('GET /health/live — liveness probe', () => {
  test('returns 200 {status: "live"} when everything is fine', async () => {
    const app = createApp();

    const response = await request(app).get('/health/live').expect(200);

    expect(response.body).toEqual({ status: 'live' });
  });

  test('returns 503 {status: "not_live", reason: "shutting_down"} when shutdown flag is set', async () => {
    const app = createApp({ isShuttingDown: () => true });

    const response = await request(app).get('/health/live').expect(503);

    expect(response.body).toEqual({ status: 'not_live', reason: 'shutting_down' });
  });

  test('returns 503 with memory_pressure when heap exceeds limit', async () => {
    const app = createApp({
      getHeapUsedMb: () => 1600,
      getHeapLimitMb: () => 1536,
    });

    const response = await request(app).get('/health/live').expect(503);

    expect(response.body).toMatchObject({
      status: 'not_live',
      reason: 'memory_pressure',
      heapUsedMB: 1600,
      heapLimitMB: 1536,
    });
  });

  test('does not call Mongo, Redis, or ClickHouse — handler is pure in-process', async () => {
    // The liveness handler only accepts isShuttingDown, getHeapUsedMb, and
    // getHeapLimitMb in its dependency interface. There are no I/O dependencies
    // (no isMongoReady, no pingRedis, no loadCompatibility). This test proves
    // the handler works with ONLY those three dependencies and no external
    // services — if any I/O dependency were required, the TypeScript compiler
    // would reject the app construction above and this test would not compile.
    const callLog: string[] = [];

    const app = createApp({
      isShuttingDown: () => {
        callLog.push('isShuttingDown');
        return false;
      },
      getHeapUsedMb: () => {
        callLog.push('getHeapUsedMb');
        return 128;
      },
      getHeapLimitMb: () => {
        callLog.push('getHeapLimitMb');
        return 1536;
      },
    });

    await request(app).get('/health/live').expect(200);

    // Only in-process checks were called — no external I/O
    expect(callLog).toEqual(['isShuttingDown', 'getHeapUsedMb', 'getHeapLimitMb']);
  });

  test('shutdown check takes priority over memory pressure', async () => {
    const app = createApp({
      isShuttingDown: () => true,
      getHeapUsedMb: () => 9999,
      getHeapLimitMb: () => 1536,
    });

    const response = await request(app).get('/health/live').expect(503);

    // Even with heap over limit, shutdown reason takes priority
    expect(response.body).toEqual({ status: 'not_live', reason: 'shutting_down' });
  });
});
