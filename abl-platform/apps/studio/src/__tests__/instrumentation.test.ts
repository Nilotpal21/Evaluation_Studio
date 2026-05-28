import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockLoadConfig = vi.fn().mockResolvedValue(undefined);
const mockInitializeRedis = vi.fn().mockResolvedValue(undefined);
let dbImported = false;

vi.mock('@/db', () => {
  dbImported = true;
  return {};
});

vi.mock('@/config', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock('@/lib/redis-client', () => ({
  initializeRedis: (...args: unknown[]) => mockInitializeRedis(...args),
}));

describe('studio instrumentation register', () => {
  const originalNextRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    vi.resetModules();
    mockLoadConfig.mockClear();
    mockInitializeRedis.mockClear();
    dbImported = false;
  });

  afterEach(() => {
    if (originalNextRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
      return;
    }
    process.env.NEXT_RUNTIME = originalNextRuntime;
  });

  test('initializes config and redis without eagerly importing the db module', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const { register } = await import('../instrumentation');
    await register();

    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
    expect(mockInitializeRedis).toHaveBeenCalledTimes(1);
    expect(dbImported).toBe(false);
  });

  test('skips startup work outside the node runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge';

    const { register } = await import('../instrumentation');
    await register();

    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockInitializeRedis).not.toHaveBeenCalled();
    expect(dbImported).toBe(false);
  });
});
