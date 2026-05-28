import { describe, it, expect, vi } from 'vitest';
import {
  LockService,
  type LockRecord,
  type LockStore,
  type LockConflictError,
} from '../ownership/lock-service.js';
import type { LockType } from '../types.js';

function createMockLockStore(): LockStore & { data: Map<string, LockRecord> } {
  const data = new Map<string, LockRecord>();
  let idCounter = 0;

  return {
    data,
    async getLock(projectId, agentId, lockType) {
      return data.get(`${projectId}:${agentId}:${lockType}`) ?? null;
    },
    async createLock(record) {
      const id = `lock-${++idCounter}`;
      const full: LockRecord = { ...record, id };
      data.set(`${record.projectId}:${record.agentId}:${record.lockType}`, full);
      return full;
    },
    async updateLock(id, updates) {
      for (const [key, record] of data) {
        if (record.id === id) {
          const updated = { ...record, ...updates };
          data.set(key, updated);
          return updated;
        }
      }
      throw new Error(`Lock ${id} not found`);
    },
    async deleteLock(projectId, agentId, lockType) {
      data.delete(`${projectId}:${agentId}:${lockType}`);
    },
    async listLocks(projectId) {
      return [...data.values()].filter((r) => r.projectId === projectId);
    },
  };
}

describe('LockService', () => {
  it('should acquire a lock', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    const result = await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1');
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.lockedBy).toBe('user-1');
      expect(result.lockType).toBe('edit');
    }
  });

  it('should return conflict when locked by another user', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1');
    const result = await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-2');

    expect('code' in result).toBe(true);
    if ('code' in result) {
      expect(result.code).toBe('LOCK_CONFLICT');
      expect(result.lockedBy).toBe('user-1');
    }
  });

  it('should refresh lock for same user', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1');
    const result = await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1');

    // Same user should get the lock back (refreshed)
    expect('id' in result).toBe(true);
  });

  it('should release a lock', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1');
    await service.releaseLock('proj-1', 'agent-1', 'user-1');

    const lock = await service.getLock('proj-1', 'agent-1');
    expect(lock).toBeNull();
  });

  it('should prevent releasing lock held by another user', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1');

    await expect(service.releaseLock('proj-1', 'agent-1', 'user-2')).rejects.toThrow(
      'Cannot release a lock held by another user',
    );
  });

  it('should handle expired locks', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    // Create a lock that's already expired
    await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1', 'edit', -1000);

    // Another user should be able to acquire it
    const result = await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-2');
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.lockedBy).toBe('user-2');
    }
  });

  it('should force break a lock', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1');
    await service.forceBreakLock('proj-1', 'agent-1', 'admin-1');

    const lock = await service.getLock('proj-1', 'agent-1');
    expect(lock).toBeNull();
  });

  it('should refresh lock TTL', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    const original = await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1');
    expect('id' in original).toBe(true);

    const refreshed = await service.refreshLock('proj-1', 'agent-1', 'user-1');
    expect(refreshed.expiresAt.getTime()).toBeGreaterThanOrEqual(
      ('expiresAt' in original ? (original as LockRecord).expiresAt : new Date()).getTime(),
    );
  });

  it('should list active locks', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    await service.acquireLock('proj-1', 'agent-1', 'AgentA', 'user-1');
    await service.acquireLock('proj-1', 'agent-2', 'AgentB', 'user-2');

    const locks = await service.listLocks('proj-1');
    expect(locks).toHaveLength(2);
  });
});

// ─── Extended Lock Service Tests ────────────────────────────────────────────

describe('LockService extended', () => {
  it('should auto-clean expired locks on getLock', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    // Create a lock that's already expired
    await service.acquireLock('proj-1', 'agent-1', 'Agent', 'user-1', 'edit', -1000);
    expect(store.data.size).toBe(1);

    // getLock should return null and remove the expired lock
    const lock = await service.getLock('proj-1', 'agent-1');
    expect(lock).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it('should remove the lock when forceBreakLock is called', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    await service.acquireLock('proj-1', 'agent-1', 'TestAgent', 'user-1');
    expect(await service.getLock('proj-1', 'agent-1')).not.toBeNull();

    await service.forceBreakLock('proj-1', 'agent-1', 'admin-1');
    expect(await service.getLock('proj-1', 'agent-1')).toBeNull();
  });

  it('should not throw on forceBreakLock of nonexistent lock', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    await expect(
      service.forceBreakLock('proj-1', 'nonexistent', 'admin-1'),
    ).resolves.toBeUndefined();
  });

  it('should return LOCK_CONFLICT on duplicate key error (code 11000)', async () => {
    // Use a store that always throws duplicate key on create
    const store: LockStore = {
      async getLock() {
        return null;
      },
      async createLock() {
        const err = new Error('duplicate key') as Error & { code: number };
        err.code = 11000;
        throw err;
      },
      async updateLock() {
        throw new Error('not implemented');
      },
      async deleteLock() {},
      async listLocks() {
        return [];
      },
    };
    const service = new LockService(store);

    // getLock returns null → try to create → duplicate key → getLock again returns null
    // In this case, the error is re-thrown because conflicting lock is null
    // Let's test with a store where getLock returns a lock after create fails
    const store2: LockStore = {
      async getLock() {
        return {
          id: 'lock-1',
          projectId: 'p',
          agentId: 'a',
          agentName: 'A',
          lockedBy: 'other-user',
          lockedAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
          lockType: 'edit',
        };
      },
      async createLock() {
        const err = new Error('duplicate key') as Error & { code: number };
        err.code = 11000;
        throw err;
      },
      async updateLock() {
        throw new Error('not implemented');
      },
      async deleteLock() {},
      async listLocks() {
        return [];
      },
    };
    const service2 = new LockService(store2);
    const result = await service2.acquireLock('p', 'a', 'A', 'me');

    expect('code' in result).toBe(true);
    expect((result as LockConflictError).code).toBe('LOCK_CONFLICT');
  });

  it('should re-throw non-11000 error codes', async () => {
    const store: LockStore = {
      async getLock() {
        return null;
      },
      async createLock() {
        const err = new Error('connection error') as Error & { code: number };
        err.code = 12345;
        throw err;
      },
      async updateLock() {
        throw new Error('not implemented');
      },
      async deleteLock() {},
      async listLocks() {
        return [];
      },
    };
    const service = new LockService(store);

    await expect(service.acquireLock('p', 'a', 'A', 'user-1')).rejects.toThrow('connection error');
  });

  it('should propagate plain Error without code property', async () => {
    const store: LockStore = {
      async getLock() {
        return null;
      },
      async createLock() {
        throw new Error('unexpected failure');
      },
      async updateLock() {
        throw new Error('not implemented');
      },
      async deleteLock() {},
      async listLocks() {
        return [];
      },
    };
    const service = new LockService(store);

    await expect(service.acquireLock('p', 'a', 'A', 'user-1')).rejects.toThrow(
      'unexpected failure',
    );
  });

  it('should allow acquisition after negative TTL lock', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    // Create with negative TTL (already expired)
    await service.acquireLock('proj-1', 'agent-1', 'Agent', 'user-1', 'edit', -5000);

    // Next user should acquire
    const result = await service.acquireLock('proj-1', 'agent-1', 'Agent', 'user-2');
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.lockedBy).toBe('user-2');
    }
  });

  it('should retry create when duplicate key error followed by null getLock (expired between attempts)', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);
    let createCallCount = 0;
    const dupError = Object.assign(new Error('dup'), { code: 11000 });
    store.createLock = vi.fn(async (record) => {
      createCallCount++;
      if (createCallCount === 1) throw dupError;
      return { id: 'lock-retry', ...record };
    });
    store.getLock = vi.fn(async () => null); // lock vanished

    const result = await service.acquireLock('proj1', 'agent1', 'Agent One', 'user-a');
    expect('code' in result).toBe(false); // not a conflict
    expect((result as LockRecord).id).toBe('lock-retry');
    expect(createCallCount).toBe(2);
  });

  it('should return existing lock when same user wins the race after duplicate key', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);
    const dupError = Object.assign(new Error('dup'), { code: 11000 });
    store.createLock = vi.fn(async () => {
      throw dupError;
    });
    const existingLock = {
      id: 'existing-lock',
      projectId: 'proj1',
      agentId: 'agent1',
      agentName: 'Agent One',
      lockedBy: 'user-a',
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      lockType: 'edit' as const,
    };
    let getLockCallCount = 0;
    store.getLock = vi.fn(async () => {
      getLockCallCount++;
      // First call is the pre-check (should return null to proceed to create)
      // Second call is after duplicate key error (should return the conflicting lock)
      if (getLockCallCount === 1) return null;
      return existingLock;
    });

    const result = await service.acquireLock('proj1', 'agent1', 'Agent One', 'user-a');
    expect((result as LockRecord).id).toBe('existing-lock');
  });

  it('should filter out expired locks in listLocks', async () => {
    const store = createMockLockStore();
    const service = new LockService(store);

    // One active, one expired
    await service.acquireLock('proj-1', 'agent-1', 'AgentA', 'user-1');
    await service.acquireLock('proj-1', 'agent-2', 'AgentB', 'user-2', 'edit', -1000);

    const locks = await service.listLocks('proj-1');
    expect(locks).toHaveLength(1);
    expect(locks[0].agentId).toBe('agent-1');
  });
});
