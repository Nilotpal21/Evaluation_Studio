import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('GET /health/ready', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('defers the db import until the route handler runs', async () => {
    let dbModuleLoadCount = 0;

    vi.doMock('@/db', () => {
      dbModuleLoadCount += 1;
      return {
        dbReady: Promise.resolve(),
        isDatabaseAvailable: vi.fn(() => true),
      };
    });

    const route = await import('@/app/health/ready/route');

    expect(dbModuleLoadCount).toBe(0);

    const response = await route.GET();

    expect(dbModuleLoadCount).toBe(1);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ready' });
  });

  it('returns 503 when the database is unavailable', async () => {
    const mockIsDatabaseAvailable = vi.fn(() => false);

    vi.doMock('@/db', () => ({
      dbReady: Promise.resolve(),
      isDatabaseAvailable: mockIsDatabaseAvailable,
    }));

    const { GET } = await import('@/app/health/ready/route');
    const response = await GET();

    expect(mockIsDatabaseAvailable).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'not_ready',
      reason: 'database',
    });
  });
});
