import { beforeEach, describe, expect, it, vi } from 'vitest';

const { workerConstructs } = vi.hoisted(() => ({
  workerConstructs: [] as Array<{ name: string; options: Record<string, unknown> }>,
}));

vi.mock('bullmq', () => ({
  Worker: class MockWorker {
    constructor(name: string, _handler: unknown, options: Record<string, unknown>) {
      workerConstructs.push({ name, options });
    }

    on() {
      return this;
    }

    async close() {
      return undefined;
    }
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('resumption worker BullMQ prefix', () => {
  beforeEach(() => {
    vi.resetModules();
    workerConstructs.length = 0;
  });

  it('uses hash-tagged BullMQ prefix when worker connection is Redis Cluster', async () => {
    const { createRedisConnection, BULLMQ_CLUSTER_SAFE_PREFIX } =
      await import('@agent-platform/redis');
    const { startResumptionWorker, stopResumptionWorker } =
      await import('../services/queues/resumption-worker.js');

    const handle = createRedisConnection({
      cluster: true,
      url: 'redis://redis-0:6379,redis://redis-1:6379,redis://redis-2:6379',
      lazyConnect: true,
    });

    await startResumptionWorker({
      resumptionService: { resume: vi.fn() } as any,
      workerConnection: handle.client,
    });

    expect(workerConstructs).toHaveLength(1);
    expect(workerConstructs[0]?.name).toBe('execution-resume');
    expect(workerConstructs[0]?.options.prefix).toBe(BULLMQ_CLUSTER_SAFE_PREFIX);

    await stopResumptionWorker();
    await handle.disconnect();
  });

  it('preserves the existing resumption prefix when worker connection is standalone Redis', async () => {
    const { createRedisConnection, BULLMQ_CLUSTER_SAFE_PREFIX } =
      await import('@agent-platform/redis');
    const { startResumptionWorker, stopResumptionWorker } =
      await import('../services/queues/resumption-worker.js');

    const handle = createRedisConnection({
      host: 'localhost',
      port: 6380,
      lazyConnect: true,
    });

    await startResumptionWorker({
      resumptionService: { resume: vi.fn() } as any,
      workerConnection: handle.client,
    });

    expect(workerConstructs).toHaveLength(1);
    expect(workerConstructs[0]?.name).toBe('execution-resume');
    expect(workerConstructs[0]?.options.prefix).toBe(BULLMQ_CLUSTER_SAFE_PREFIX);

    await stopResumptionWorker();
    await handle.disconnect();
  });
});
