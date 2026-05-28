import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('session update TOCTOU fix', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('LUA_UPDATE_SESSION script exists and checks existence atomically', async () => {
    const { LUA_UPDATE_SESSION } = await import('../../session/lua-scripts.js');
    expect(LUA_UPDATE_SESSION).toBeDefined();
    expect(LUA_UPDATE_SESSION).toContain('EXISTS');
    expect(LUA_UPDATE_SESSION).toContain('HSET');
  });

  it('update() uses redis eval instead of separate exists+hmset', async () => {
    const mockRedis = {
      exists: vi.fn(),
      hmset: vi.fn(),
      // Redis eval for Lua scripts — standard atomic operation pattern
      eval: vi.fn().mockResolvedValue(1),
      defineCommand: vi.fn(),
    };
    const { TransferSessionStore } = await import('../../session/transfer-session-store.js');
    const store = new TransferSessionStore(mockRedis as any);

    await store.update('at:t:c:chat', { state: 'active' });

    // Should NOT call exists + hmset separately
    expect(mockRedis.exists).not.toHaveBeenCalled();
    expect(mockRedis.hmset).not.toHaveBeenCalled();
  });

  it('update() returns false when session was already deleted', async () => {
    const mockRedis = {
      // Redis eval returning 0 = session not found (Lua script result)
      eval: vi.fn().mockResolvedValue(0),
      defineCommand: vi.fn(),
    };
    const { TransferSessionStore } = await import('../../session/transfer-session-store.js');
    const store = new TransferSessionStore(mockRedis as any);

    const result = await store.update('at:t:c:chat', { state: 'active' });
    expect(result).toBe(false);
  });
});
