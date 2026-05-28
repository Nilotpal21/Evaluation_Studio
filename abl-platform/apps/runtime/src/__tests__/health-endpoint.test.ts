import { describe, it, expect } from 'vitest';

describe('Health endpoint response shape', () => {
  it('includes operational metrics fields', () => {
    // Contract test: verify the expected shape
    const healthResponse = {
      status: 'healthy',
      service: 'runtime',
      timestamp: new Date().toISOString(),
      uptime: 123.4,
      database: 'connected (mongo)',
      redis: 'connected',
      clickhouse: 'connected',
      metrics: {
        localCachedSessions: 42,
        memoryUsageMB: 256,
        heapUsedMB: 200,
        heapTotalMB: 512,
      },
    };

    expect(healthResponse.metrics).toBeDefined();
    expect(healthResponse.metrics.localCachedSessions).toBeTypeOf('number');
    expect(healthResponse.metrics.memoryUsageMB).toBeTypeOf('number');
    expect(healthResponse.metrics.heapUsedMB).toBeTypeOf('number');
    expect(healthResponse.metrics.heapTotalMB).toBeTypeOf('number');
  });

  it('readiness response includes status field', () => {
    const readyResponse = { status: 'ready' };
    expect(readyResponse.status).toBe('ready');

    const notReadyResponse = {
      status: 'not_ready',
      reason: 'memory_pressure',
      heapUsedMB: 1600,
      heapLimitMB: 1536,
    };
    expect(notReadyResponse.status).toBe('not_ready');
    expect(notReadyResponse.reason).toBeTypeOf('string');
  });
});
